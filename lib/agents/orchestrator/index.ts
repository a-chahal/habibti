import { emit, subscribe, type PayloadMap } from "../../events/emitter";
import {
  createDispatch,
  updateDispatch,
  updateShipment,
  getShipment,
  createSignal,
  getOptionsForShipment,
} from "../../db/queries";
import { IntentParserAgent } from "../intent-parser";
import type { IntentOutput } from "../intent-parser";
import { CountryDiscovererAgent } from "../country-discoverer";
import type { CountryDiscovererOutput } from "../country-discoverer";
import { TariffCalculatorAgent } from "../tariff-calculator";
import { ComplianceScreenerAgent } from "../compliance-screener";
import { SupplierVerifierAgent } from "../supplier-verifier";
import { CountryRiskAgent } from "../country-risk";
import { RoutePrescorer } from "../route-prescorer";
import { OptionRankerAgent } from "../option-ranker";
import { FeedbackLoopAgent } from "../feedback-loop";
import { SynthesizerAgent } from "../synthesizer";

type AgentHandler = (payload: Record<string, unknown>) => Promise<unknown>;

class Semaphore {
  private slots: number;
  private queue: Array<() => void> = [];

  constructor(max: number) {
    this.slots = max;
  }

  async acquire(): Promise<void> {
    if (this.slots > 0) {
      this.slots--;
      return;
    }
    await new Promise<void>((resolve) => this.queue.push(resolve));
  }

  release(): void {
    const next = this.queue.shift();
    if (next) {
      next();
    } else {
      this.slots++;
    }
  }
}

class Orchestrator {
  private registry = new Map<string, AgentHandler>();
  private started = false;
  private semaphore = new Semaphore(5);

  register(agentName: string, handler: AgentHandler) {
    this.registry.set(agentName, handler);
  }

  start() {
    if (this.started) return;
    this.started = true;

    subscribe("SHIPMENT_NEW", (payload) => {
      this.onShipmentNew(payload).catch((err) =>
        console.error("[Orchestrator] unhandled error in SHIPMENT_NEW handler:", err)
      );
    });
    subscribe("SHIPMENT_CONFIRMED", (payload) => this.onShipmentConfirmed(payload));
    subscribe("SIGNAL_NEW", (payload) => this.onSignalNew(payload));

    console.log("[Orchestrator] started, listening on SHIPMENT_NEW / SHIPMENT_CONFIRMED / SIGNAL_NEW");
  }

  private async onShipmentNew(payload: PayloadMap["SHIPMENT_NEW"]) {
    const { shipmentId } = payload;
    console.log(`[Orchestrator] SHIPMENT_NEW ${shipmentId} — dispatching intent-parser`);

    const shipment = await getShipment(shipmentId);
    if (!shipment) {
      console.error(`[Orchestrator] shipment ${shipmentId} not found`);
      return;
    }

    const rawIntent =
      typeof shipment.intent === "string"
        ? shipment.intent
        : (shipment.intent as any)?.raw ?? JSON.stringify(shipment.intent);

    await this.dispatch("intent-parser", shipmentId, { intent: rawIntent });
  }

  private onShipmentConfirmed(payload: PayloadMap["SHIPMENT_CONFIRMED"]) {
    console.log(`[Orchestrator] SHIPMENT_CONFIRMED ${payload.shipmentId}`);
  }

  private onSignalNew(_payload: PayloadMap["SIGNAL_NEW"]) {
    // Future: trigger belief-updater
  }

  private async dispatch(
    agentName: string,
    shipmentId: string,
    payload: Record<string, unknown>
  ): Promise<unknown> {
    const handler = this.registry.get(agentName);
    if (!handler) {
      console.warn(`[Orchestrator] no handler for agent: ${agentName}`);
      return;
    }

    const dispatch = await createDispatch({
      shipment_id: shipmentId,
      agent_name: agentName,
      payload,
      status: "running",
    });

    try {
      const result = await handler(payload);
      await updateDispatch(dispatch.id, { status: "completed", completed_at: new Date() });

      if (agentName === "intent-parser") {
        await this.applyIntentResult(shipmentId, result as IntentOutput);
      } else if (agentName === "option-ranker") {
        await this.applyOptionRankerResult(shipmentId);
      }

      return result;
    } catch (err: any) {
      await updateDispatch(dispatch.id, { status: "failed", completed_at: new Date() });
      console.error(`[Orchestrator] dispatch ${agentName} failed for shipment ${shipmentId}:`, err.message);
      throw err;
    }
  }

  private async dispatchCapped(
    agentName: string,
    shipmentId: string,
    payload: Record<string, unknown>
  ): Promise<unknown> {
    await this.semaphore.acquire();
    try {
      return await this.dispatch(agentName, shipmentId, payload);
    } finally {
      this.semaphore.release();
    }
  }

  private async applyIntentResult(shipmentId: string, intent: IntentOutput) {
    await updateShipment(shipmentId, {
      hs_code: intent.hs_code,
      origin_country: intent.origin_country ?? undefined,
      destination_country: intent.destination_country ?? undefined,
      destination_port: intent.destination_port ?? undefined,
      expected_eta: intent.deadline_date ? new Date(intent.deadline_date) : undefined,
      intent: intent as any,
    });

    console.log(
      `[Orchestrator] intent applied to shipment ${shipmentId}: hs=${intent.hs_code} port=${intent.destination_port} qty=${intent.quantity}${intent.quantity_unit ? " " + intent.quantity_unit : ""}`
    );

    if (intent.clarification_needed) {
      console.warn(`[Orchestrator] clarification needed: ${intent.clarification_needed}`);
      return;
    }

    this.runSourcingPipeline(shipmentId, intent).catch((err) =>
      console.error(`[Orchestrator] sourcing pipeline failed for ${shipmentId}:`, err)
    );
  }

  private async applyOptionRankerResult(shipmentId: string) {
    try {
      await updateShipment(shipmentId, { status: "sourcing_complete" });
      const options = await getOptionsForShipment(shipmentId);
      const topCountry = options[0]?.country ?? "unknown";

      emit("SOURCING_OPTIONS_READY", {
        shipmentId,
        optionCount: options.length,
        topCountry,
      });

      console.log(
        `[Orchestrator] SOURCING_OPTIONS_READY for ${shipmentId}: ${options.length} options, top=${topCountry}`
      );
    } catch (err: any) {
      console.error(`[Orchestrator] applyOptionRankerResult failed:`, err.message);
    }
  }

  private async runSourcingPipeline(shipmentId: string, intent: IntentOutput) {
    const start = Date.now();
    const hsCode = intent.hs_code;
    const destinationPort = intent.destination_port ?? "USLAX";
    const destinationCountry = intent.destination_country ?? "US";
    const productValue = intent.budget_usd ?? 0;

    console.log(`[Orchestrator] starting sourcing pipeline for shipment ${shipmentId}`);

    // Phase 1: Country Discoverer — must complete first (its result drives fan-out)
    let discovererOutput: CountryDiscovererOutput | null = null;
    try {
      discovererOutput = (await this.dispatchCapped("country-discoverer", shipmentId, {
        hs_code: hsCode,
        destination_country: destinationCountry,
        shipmentId,
      })) as CountryDiscovererOutput;
      console.log(
        `[Orchestrator] country-discoverer returned ${discovererOutput?.candidates?.length ?? 0} candidates`
      );
    } catch (err: any) {
      console.error(`[Orchestrator] country-discoverer failed:`, err.message);
    }

    const candidates = discovererOutput?.candidates ?? [];

    // Phase 2: Fan out 5 agents per candidate country (all capped at 5 concurrent)
    const phase2Tasks: Promise<unknown>[] = [];

    for (const candidate of candidates) {
      const cc = candidate.country_code;

      phase2Tasks.push(
        this.dispatchCapped("tariff-calculator", shipmentId, {
          hs_code: hsCode,
          origin_country: cc,
          product_value_usd: productValue,
          shipmentId,
        }).catch((err) =>
          console.error(`[Orchestrator] tariff-calculator failed for ${cc}:`, err.message)
        )
      );

      phase2Tasks.push(
        this.dispatchCapped("country-risk", shipmentId, {
          country_code: cc,
          lookback_days: 30,
          shipmentId,
        }).catch((err) =>
          console.error(`[Orchestrator] country-risk failed for ${cc}:`, err.message)
        )
      );

      phase2Tasks.push(
        this.dispatchCapped("route-prescorer", shipmentId, {
          origin_country: cc,
          destination_port: destinationPort,
          shipmentId,
        }).catch((err) =>
          console.error(`[Orchestrator] route-prescorer failed for ${cc}:`, err.message)
        )
      );

      phase2Tasks.push(
        this.dispatchCapped("supplier-verifier", shipmentId, {
          supplier_name: `${candidate.country_name} supplier`,
          country: cc,
          shipmentId,
        }).catch((err) =>
          console.error(`[Orchestrator] supplier-verifier failed for ${cc}:`, err.message)
        )
      );

      phase2Tasks.push(
        this.dispatchCapped("compliance-screener", shipmentId, {
          supplier_name: `${candidate.country_name} supplier`,
          country: cc,
          shipmentId,
        }).catch((err) =>
          console.error(`[Orchestrator] compliance-screener failed for ${cc}:`, err.message)
        )
      );
    }

    if (candidates.length === 0) {
      const fallbackCountry = intent.origin_country ?? "CN";
      phase2Tasks.push(
        this.dispatchCapped("compliance-screener", shipmentId, {
          supplier_name: `${fallbackCountry} supplier`,
          country: fallbackCountry,
          shipmentId,
        }).catch(() => {})
      );
    }

    await Promise.allSettled(phase2Tasks);

    const sourcing_ms = Date.now() - start;
    const agentNames = [
      "country-discoverer",
      "tariff-calculator",
      "country-risk",
      "route-prescorer",
      "supplier-verifier",
      "compliance-screener",
    ];

    // Write sourcing_complete signal so test scripts can observe it cross-process
    try {
      await createSignal({
        agent_name: "orchestrator",
        signal_type: "sourcing_complete",
        severity: "info",
        shipment_id: shipmentId,
        payload: { agentNames, durationMs: sourcing_ms, candidateCount: candidates.length },
        citations: [],
        occurred_at: new Date(),
      });
    } catch (err: any) {
      console.error(`[Orchestrator] failed to write sourcing_complete signal:`, err.message);
    }

    emit("SOURCING_COMPLETE", { shipmentId, agentNames, durationMs: sourcing_ms });

    console.log(
      `[Orchestrator] SOURCING_COMPLETE for shipment ${shipmentId} in ${(sourcing_ms / 1000).toFixed(1)}s — dispatching option-ranker`
    );

    // Phase 3: Option Ranker — synthesizes all sourcing signals into 3 ranked options
    try {
      await this.dispatchCapped("option-ranker", shipmentId, {
        shipmentId,
        intent_data: intent as unknown as Record<string, unknown>,
      });
    } catch (err: any) {
      console.error(`[Orchestrator] option-ranker failed for ${shipmentId}:`, err.message);
    }
  }
}

// Singleton
export const orchestrator = new Orchestrator();

export function registerAllAgents() {
  orchestrator.register("intent-parser", (payload) =>
    new IntentParserAgent().run(payload) as Promise<unknown>
  );
  orchestrator.register("country-discoverer", (payload) =>
    new CountryDiscovererAgent().run(payload) as Promise<unknown>
  );
  orchestrator.register("tariff-calculator", (payload) =>
    new TariffCalculatorAgent().run(payload) as Promise<unknown>
  );
  orchestrator.register("compliance-screener", (payload) =>
    new ComplianceScreenerAgent().run(payload) as Promise<unknown>
  );
  orchestrator.register("supplier-verifier", (payload) =>
    new SupplierVerifierAgent().run(payload) as Promise<unknown>
  );
  orchestrator.register("country-risk", (payload) =>
    new CountryRiskAgent().run(payload) as Promise<unknown>
  );
  orchestrator.register("route-prescorer", (payload) =>
    new RoutePrescorer().run(payload) as Promise<unknown>
  );
  orchestrator.register("option-ranker", (payload) =>
    new OptionRankerAgent().run(payload) as Promise<unknown>
  );
  orchestrator.register("feedback-loop", (payload) =>
    new FeedbackLoopAgent().run(payload) as Promise<unknown>
  );

  // Synthesizer: event-driven, not dispatched via registry
  const synthesizer = new SynthesizerAgent();
  synthesizer.startListening();

  // Stubs for future prompts
  for (const name of ["vessel-tracker", "ais-monitor", "belief-updater", "alert-drafter", "options-ranker"]) {
    orchestrator.register(name, async (payload) => {
      console.log(`[Stub:${name}] would process`, JSON.stringify(payload).slice(0, 80));
      return { stub: true, agent: name };
    });
  }
}
