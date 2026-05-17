import { emit, subscribe, type PayloadMap } from "../../events/emitter";
import {
  createDispatch,
  updateDispatch,
  updateShipment,
  getShipment,
  createSignal,
  getOptionsForShipment,
  getSupplier,
  getSignalsForShipment,
  listUnprocessedShipments,
  listConfirmedShipments,
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
import { PortDiscovererAgent } from "../port-discoverer";
import type { PortDiscovererOutput } from "../port-discoverer";
import { LegAnalyzerAgent } from "../leg-analyzer";
import { FreightPricerAgent } from "../freight-pricer";
import type { FreightEstimateOutput } from "../freight-pricer";
import { ProductPricerAgent } from "../product-pricer";
import type { ProductPriceOutput } from "../product-pricer";
import { OptionRankerAgent } from "../option-ranker";
import type { OptionCandidate } from "../option-ranker";
import { planRoutes } from "../../routing/route-planner";
import { resolvePortWithFallback } from "../../sources/locations";
import { FeedbackLoopAgent } from "../feedback-loop";
import { SynthesizerAgent } from "../synthesizer";
import { VesselTrackerAgent } from "../vessel-tracker";
import { PortCongestionAgent } from "../port-congestion";
import { CorridorNewsAgent } from "../corridor-news";
import { RegulatoryWatcherAgent } from "../regulatory-watcher";
import { WeatherHazardAgent } from "../weather-hazard";
import type { MonitoringContext } from "../monitoring-base";

// Approximate transit days per origin country — used in Phase 2a viability gate
const TYPICAL_TRANSIT: Record<string, number> = {
  MX: 4, CN: 14, VN: 16, TW: 14, KR: 14, JP: 13, TH: 18,
  KH: 18, MY: 16, ID: 18, LK: 22, IN: 28, BD: 30,
  PK: 30, TR: 20, EG: 22, MA: 20, DE: 14, BR: 30, ET: 35,
  MG: 30, PE: 20,
};

// Port lat/lon coordinates for mapping early country candidate routes
const COUNTRY_PORT: Record<string, { lat: number; lon: number }> = {
  CN: { lat: 31.23, lon: 121.47 },  // Shanghai
  VN: { lat: 10.82, lon: 106.63 }, // Ho Chi Minh
  IN: { lat: 18.93, lon: 72.84 },  // Mumbai
  BD: { lat: 22.35, lon: 91.82 },  // Chittagong
  TH: { lat: 13.09, lon: 100.60 }, // Bangkok
  ID: { lat: -6.09, lon: 106.88 }, // Jakarta
  MY: { lat: 3.10,  lon: 101.59 }, // Klang
  KR: { lat: 37.45, lon: 126.69 }, // Incheon
  JP: { lat: 35.45, lon: 139.64 }, // Yokohama
  TW: { lat: 25.15, lon: 121.77 }, // Keelung
  MX: { lat: 20.96, lon: -97.35 }, // Veracruz
  DE: { lat: 53.55, lon: 9.99 },   // Hamburg
  TR: { lat: 41.01, lon: 28.98 },  // Istanbul
  BR: { lat: -23.96, lon: -46.33 }, // Santos
  PK: { lat: 24.86, lon: 67.01 },  // Karachi
  KH: { lat: 10.62, lon: 103.50 }, // Sihanoukville
  LK: { lat: 6.93,  lon: 79.85 },  // Colombo
  PH: { lat: 14.54, lon: 120.98 }, // Manila
  HK: { lat: 22.29, lon: 114.16 }, // Hong Kong
  SG: { lat: 1.29,  lon: 103.82 }, // Singapore
};

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

  // Monitoring agents — singletons, each manages its own per-shipment timers
  private vesselTracker = new VesselTrackerAgent();
  private portCongestion = new PortCongestionAgent();
  private corridorNews = new CorridorNewsAgent();
  private regulatoryWatcher = new RegulatoryWatcherAgent();
  private weatherHazard = new WeatherHazardAgent();

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

    // Catch up: pick up any draft/pending shipments that were created before this boot
    // (handles dev hot-reload and server restarts that lose in-process events)
    setImmediate(() => this.catchUpOnBoot());
  }

  private async catchUpOnBoot() {
    try {
      // Do NOT auto-process old unprocessed shipments on server startup/hot-reload to save API costs.
      // Shipments should only start sourcing when the user explicitly triggers them from the onboarding flow.
      /*
      const unprocessed = await listUnprocessedShipments();
      if (unprocessed.length > 0) {
        console.log(`[Orchestrator] catch-up: ${unprocessed.length} unprocessed shipment(s) found`);
        for (const s of unprocessed) {
          this.onShipmentNew({ shipmentId: s.id }).catch((err) =>
            console.error(`[Orchestrator] catch-up error for ${s.id}:`, err)
          );
        }
      }
      */
      // Do NOT auto-start monitoring on server startup/hot-reload to save API costs.
      // Monitoring should only start when the shipment is explicitly confirmed.
      /*
      const confirmed = await listConfirmedShipments();
      if (confirmed.length > 0) {
        console.log(`[Orchestrator] catch-up: ${confirmed.length} in-transit shipment(s) found`);
        for (const s of confirmed) {
          this.startMonitoring(s.id, s.vessel_mmsi ?? undefined).catch((err) =>
            console.error(`[Orchestrator] catch-up monitoring error for ${s.id}:`, err)
          );
        }
      }
      */
    } catch (err) {
      console.error("[Orchestrator] catch-up query failed:", err);
    }
  }

  private async onShipmentNew(payload: PayloadMap["SHIPMENT_NEW"]) {
    const { shipmentId } = payload;

    // Claim immediately: move out of 'draft' so hot-reload catch-ups don't re-dispatch
    try {
      await updateShipment(shipmentId, { status: "pending" });
    } catch {
      // non-fatal — proceed regardless
    }

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
    console.log(`[Orchestrator] SHIPMENT_CONFIRMED ${payload.shipmentId} — starting monitoring agents`);
    this.startMonitoring(payload.shipmentId, payload.vesselMmsi).catch((err) =>
      console.error(`[Orchestrator] monitoring start error:`, err)
    );
  }

  async startMonitoring(shipmentId: string, vesselMmsi?: string): Promise<void> {
    const [shipment, allOptions] = await Promise.all([
      getShipment(shipmentId),
      getOptionsForShipment(shipmentId),
    ]);

    if (!shipment) {
      console.error(`[Orchestrator] startMonitoring: shipment ${shipmentId} not found`);
      return;
    }

    // Use rank-1 as the confirmed option (no selected_option_id column yet)
    const confirmedOption = allOptions.find((o) => o.rank === 1);
    const routeData = confirmedOption?.route_data as any;

    // Extract route metadata from option
    const chokepoints: string[] = routeData?.chokepoints ?? routeData?.routes?.[0]?.chokepoints ?? [];
    const transshipmentPorts: string[] = routeData?.transshipmentPorts ?? [];
    const transitDays: number | null = routeData?.routes?.[0]?.typical_transit_days ?? null;

    // Load supplier name if linked
    let supplierName: string | null = null;
    if (confirmedOption?.supplier_id) {
      try {
        const supplier = await getSupplier(confirmedOption.supplier_id);
        supplierName = supplier?.name ?? null;
      } catch {
        // non-fatal
      }
    }
    // Fall back to intent.supplier
    if (!supplierName) {
      supplierName = (shipment.intent as any)?.supplier ?? null;
    }

    const ctx: MonitoringContext = {
      shipmentId,
      hsCode: shipment.hs_code,
      originCountry: shipment.origin_country,
      originPort: shipment.origin_port,
      destinationPort: shipment.destination_port,
      supplierName,
      vesselMmsi: vesselMmsi ?? shipment.vessel_mmsi ?? null,
      expectedEta: confirmedOption?.eta ?? shipment.expected_eta ?? null,
      transitDays,
      chokepoints,
      transshipmentPorts,
      productDescription: (shipment.intent as any)?.product_description ?? null,
    };

    // Update shipment status to in_transit
    try {
      await updateShipment(shipmentId, { status: "in_transit" });
    } catch {
      // non-fatal — may already be in_transit
    }

    this.vesselTracker.startMonitoring(ctx);
    this.portCongestion.startMonitoring(ctx);
    this.corridorNews.startMonitoring(ctx);
    this.regulatoryWatcher.startMonitoring(ctx);
    this.weatherHazard.startMonitoring(ctx);

    console.log(`[Orchestrator] all 5 monitoring agents started for ${shipmentId}, eta=${ctx.expectedEta?.toISOString().slice(0, 10) ?? "unknown"}, chokepoints=${chokepoints.join(", ") || "none"}`);
  }

  private onSignalNew(payload: PayloadMap["SIGNAL_NEW"]) {
    // Forward vessel_position signals to weather-hazard and corridor-news for position-aware behavior
    const p = payload as any;
    if (p.signalType === "vessel_position" && p.shipmentId) {
      const lat = p.payload?.lat;
      const lon = p.payload?.lon;
      const trackIndex = p.payload?.track_index ?? 0;
      if (typeof lat === "number" && typeof lon === "number") {
        this.weatherHazard.updateVesselPosition(p.shipmentId, lat, lon, trackIndex);
        this.corridorNews.updateVesselPosition(p.shipmentId, lat, lon);
      }
    }
    // When vessel emits chokepoint_entered, mark it cleared in corridor-news
    if (p.signalType === "chokepoint_entered" && p.shipmentId && p.payload?.chokepoint) {
      // Mark as entered — corridor-news will clear once vessel leaves
      // For now: after entering a chokepoint, it gets cleared when vessel exits (handled in corridorNews)
    }
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

    const t0 = Date.now();
    console.log(`[Dispatch] → ${agentName} started`);

    try {
      const result = await handler(payload);
      const ms = Date.now() - t0;
      console.log(`[Dispatch] ✓ ${agentName} completed in ${ms}ms`);
      await updateDispatch(dispatch.id, { status: "completed", completed_at: new Date() });

      if (agentName === "intent-parser") {
        await this.applyIntentResult(shipmentId, result as IntentOutput);
      } else if (agentName === "option-ranker") {
        await this.applyOptionRankerResult(shipmentId);
      }

      return result;
    } catch (err: any) {
      const ms = Date.now() - t0;
      console.error(`[Dispatch] ✗ ${agentName} failed in ${ms}ms: ${err.message}`);
      await updateDispatch(dispatch.id, { status: "failed", completed_at: new Date() });
      throw err;
    }
  }

  private async dispatchCapped(
    agentName: string,
    shipmentId: string,
    payload: Record<string, unknown>,
    timeoutMs = 20_000
  ): Promise<unknown> {
    await this.semaphore.acquire();
    const start = Date.now();
    try {
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Agent ${agentName} timed out after ${timeoutMs}ms`)), timeoutMs)
      );
      return await Promise.race([this.dispatch(agentName, shipmentId, payload), timeout]);
    } catch (err: any) {
      console.warn(`[Orchestrator] dispatchCapped ${agentName} failed in ${Date.now() - start}ms: ${err.message}`);
      throw err;
    } finally {
      this.semaphore.release();
    }
  }

  private async applyIntentResult(shipmentId: string, intent: IntentOutput) {
    // Heuristic: product value = budget / 1.25 (budget includes duty + freight margin)
    const productValueUsd = intent.budget_usd ? Math.round(intent.budget_usd / 1.25) : 0;

    await updateShipment(shipmentId, {
      hs_code: intent.hs_code,
      origin_country: intent.origin_country ?? undefined,
      destination_country: intent.destination_country ?? undefined,
      destination_port: intent.destination_port ?? undefined,
      expected_eta: intent.deadline_date ? new Date(intent.deadline_date) : undefined,
      intent: { ...(intent as any), product_value_usd: productValueUsd },
    });

    console.log(
      `[Orchestrator] intent applied to shipment ${shipmentId}: hs=${intent.hs_code} port=${intent.destination_port} qty=${intent.quantity}${intent.quantity_unit ? " " + intent.quantity_unit : ""}${intent.supplier ? " supplier=" + intent.supplier : ""} productValue=$${productValueUsd}`
    );

    if (intent.clarification_needed) {
      console.warn(`[Orchestrator] clarification needed: ${intent.clarification_needed}`);
      return;
    }

    this.runSourcingPipeline(shipmentId, intent, productValueUsd).catch((err) =>
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

  async runSourcingPipeline(
    shipmentId: string,
    intent: IntentOutput,
    productValueUsd: number
  ) {
    const start = Date.now();
    const hsCode = intent.hs_code;
    const destinationPort = intent.destination_port ?? "USLAX";
    const destinationCountry = intent.destination_country ?? "US";
    const preferredOrigin = intent.origin_country?.toUpperCase();

    const daysToDeadline = intent.deadline_date
      ? Math.round((new Date(intent.deadline_date).getTime() - Date.now()) / 86_400_000)
      : null;

    console.log(`[Orchestrator] starting sourcing pipeline for shipment ${shipmentId}`);

    // Phase 1: Country Discoverer — must complete first
    let discovererOutput: CountryDiscovererOutput | null = null;
    try {
      discovererOutput = (await this.dispatchCapped("country-discoverer", shipmentId, {
        hs_code: hsCode,
        destination_country: destinationCountry,
        preferred_origin: preferredOrigin ?? null,
        quantity: intent.quantity,
        quantity_unit: intent.quantity_unit,
        deadline_date: intent.deadline_date,
        shipmentId,
      })) as CountryDiscovererOutput;
      console.log(
        `[Orchestrator] country-discoverer returned ${discovererOutput?.candidates?.length ?? 0} candidates`
      );
    } catch (err: any) {
      console.error(`[Orchestrator] country-discoverer failed:`, err.message);
    }

    let candidates = discovererOutput?.candidates ?? [];

    // Ensure user's preferred origin is always in the fan-out
    if (preferredOrigin && !candidates.some((c) => c.country_code.toUpperCase() === preferredOrigin)) {
      candidates = [
        {
          country_code: preferredOrigin,
          country_name: preferredOrigin,
          annual_export_volume_usd: 0,
          us_import_volume_usd: 0,
          lane_established: true,
          trend: "stable" as const,
          citations: [],
        },
        ...candidates,
      ];
    }

    // Resolve destination port early for candidate routing visualization
    const resolvedDest = await resolvePortWithFallback(destinationPort, destinationCountry);
    const destPort = resolvedDest || (await resolvePortWithFallback("USLAX", "US")) || { locode: "USLAX", name: "Port of Los Angeles", lat: 33.74, lng: -118.26 };

    // Publish candidate routes immediately on discovery
    if (destPort) {
      for (const cand of candidates) {
        const cc = cand.country_code.toUpperCase();
        const srcCoord = COUNTRY_PORT[cc];
        if (srcCoord) {
          try {
            const routes = planRoutes(
              { locode: `${cc}MAIN`, name: `${cand.country_name} Port`, lat: srcCoord.lat, lon: srcCoord.lon },
              { locode: destPort.locode, name: destPort.name, lat: destPort.lat, lon: destPort.lng },
              { maxRoutes: 1 }
            );
            if (routes[0]) {
              await createSignal({
                agent_name: "country-discoverer",
                signal_type: "route_discovered",
                severity: "info",
                shipment_id: shipmentId,
                payload: {
                  id: `cand-${cc}`,
                  country_code: cc,
                  country_name: cand.country_name,
                  port_locode: `${cc}MAIN`,
                  port_name: `${cand.country_name} Main Port`,
                  lat1: srcCoord.lat,
                  lon1: srcCoord.lon,
                  lat2: destPort.lat,
                  lon2: destPort.lng,
                  status: "candidate",
                  route: routes[0],
                },
                citations: [],
                occurred_at: new Date(),
              });
            }
          } catch (err: any) {
            console.error(`[Orchestrator] failed to plan candidate route signal for ${cc}:`, err.message);
          }
        }
      }
    }

    // Phase 2a: Cheap gate — tariff + country-risk per candidate
    type Phase2aResult = { cc: string; viable: boolean };
    const phase2aResults = new Map<string, Phase2aResult>();

    await Promise.allSettled(
      candidates.map(async (candidate) => {
        const cc = candidate.country_code;
        const [tariffResult, riskResult] = await Promise.allSettled([
          this.dispatchCapped("tariff-calculator", shipmentId, {
            hs_code: hsCode,
            origin_country: cc,
            product_value_usd: productValueUsd,
            quantity: intent.quantity,
            quantity_unit: intent.quantity_unit,
            destination_port: destinationPort,
            product_description: intent.product_description,
            shipmentId,
          }),
          this.dispatchCapped("country-risk", shipmentId, {
            country_code: cc,
            hs_code: hsCode,
            deadline_date: intent.deadline_date,
            lookback_days: 30,
            shipmentId,
          }),
        ]);

        const tariffPct =
          tariffResult.status === "fulfilled"
            ? ((tariffResult.value as any)?.total_duty_pct ?? 0)
            : 0;
        const stability =
          riskResult.status === "fulfilled"
            ? ((riskResult.value as any)?.stability ?? "stable")
            : "stable";

        const transit = TYPICAL_TRANSIT[cc.toUpperCase()] ?? 25;
        const isPreferred = preferredOrigin && cc.toUpperCase() === preferredOrigin;

        // Always keep preferred origin; gate others
        const viable =
          !!isPreferred ||
          (tariffPct < 80 &&
            stability !== "unstable" &&
            (daysToDeadline === null || transit + 5 <= daysToDeadline));

        phase2aResults.set(cc, { cc, viable });

        if (!viable) {
          await createSignal({
            agent_name: "country-risk",
            signal_type: "route_discovered",
            severity: "high",
            shipment_id: shipmentId,
            payload: {
              id: `cand-${cc}`,
              country_code: cc,
              status: "discarded",
              reason: stability === "unstable"
                ? "Ruled out: Critical political/stability events detected."
                : tariffPct >= 80
                ? `Ruled out: Exorbitant import duty (${tariffPct}%).`
                : "Ruled out: Estimated transit exceeds deadline limit.",
            },
            citations: [],
            occurred_at: new Date(),
          }).catch(() => {});
        }
      })
    );

    const viableCandidates = candidates.filter(
      (c) => phase2aResults.get(c.country_code)?.viable !== false
    );

    console.log(
      `[Orchestrator] Phase 2a complete: ${candidates.length} candidates → ${viableCandidates.length} viable`
    );

    // Phase 2b: Route + supplier-verifier → compliance-screener for each viable candidate
    await Promise.allSettled(
      viableCandidates.map(async (candidate) => {
        const cc = candidate.country_code;
        const isPreferred = preferredOrigin && cc.toUpperCase() === preferredOrigin;
        // Pass real supplier name only for the preferred-origin candidate
        const supplierName = isPreferred ? (intent.supplier ?? null) : null;

        // (route-prescorer removed — route-planner + leg-analyzer handle routing in Phase 2d/2e)
        // supplier-verifier first, then feed parent_companies to compliance-screener
        let parentCompanies: string[] = [];
        try {
          const verifierResult = await this.dispatchCapped("supplier-verifier", shipmentId, {
            supplier_name: supplierName,
            country: cc,
            shipmentId,
          });
          const topMatch = (verifierResult as any)?.match_candidates?.[0];
          if (topMatch?.parent_company) {
            parentCompanies = [topMatch.parent_company];
          }
        } catch (err: any) {
          console.error(`[Orchestrator] supplier-verifier failed for ${cc}:`, err.message);
        }

        await this.dispatchCapped("compliance-screener", shipmentId, {
          supplier_name: supplierName,
          country: cc,
          hs_code: hsCode,
          parent_companies: parentCompanies,
          shipmentId,
        }).catch((err: any) =>
          console.error(`[Orchestrator] compliance-screener failed for ${cc}:`, err.message)
        );
      })
    );

    // ── Phase 2c: Port discovery (per viable country) ──
    // For each viable country, ask port-discoverer for top 3 origin ports.
    const portsByCountry = new Map<string, PortDiscovererOutput["ports"]>();
    await Promise.allSettled(
      viableCandidates.map(async (cand) => {
        try {
          const result = (await this.dispatchCapped("port-discoverer", shipmentId, {
            country_code: cand.country_code,
            hs_code: hsCode,
            shipmentId,
          })) as PortDiscovererOutput;
          portsByCountry.set(cand.country_code, result.ports);

          if (!destPort) return;

          // Publish refined route signals for the discovered ports
          const ports = result.ports.slice(0, 3);
          for (const port of ports) {
            try {
              const routes = planRoutes(
                { locode: port.locode, name: port.name, lat: port.lat, lon: port.lon },
                { locode: destPort.locode, name: destPort.name, lat: destPort.lat, lon: destPort.lng },
                { maxRoutes: 1 }
              );
              if (routes[0]) {
                await createSignal({
                  agent_name: "port-discoverer",
                  signal_type: "route_discovered",
                  severity: "info",
                  shipment_id: shipmentId,
                  payload: {
                    id: `refined-${cand.country_code}-${port.locode}`,
                    country_code: cand.country_code,
                    country_name: cand.country_name,
                    port_locode: port.locode,
                    port_name: port.name,
                    lat1: port.lat,
                    lon1: port.lon,
                    lat2: destPort.lat,
                    lon2: destPort.lng,
                    status: "refined",
                    route: routes[0],
                  },
                  citations: [],
                  occurred_at: new Date(),
                });
              }
            } catch (err: any) {
              console.error(`[Orchestrator] failed to plan refined route for ${port.locode}:`, err.message);
            }
          }
        } catch (err: any) {
          console.error(`[Orchestrator] port-discoverer failed for ${cand.country_code}:`, err.message);
        }
      })
    );

    // ── Phase 2d: Route planning (pure code, no LLM) ──
    // For origin-specified case: 1 country × top 3 ports × top 1 route = 3 candidates
    // For no-origin case: top 3 countries × top 1 port × top 1 route = 3 candidates
    // Resolve destination port — try DB, fall back to the curated KNOWN_PORTS dict,
    // and finally fall back to USLAX so the pipeline never silently dies on an
    // unmapped destination (e.g. USMIA which UN/LOCODE inexplicably omits).


    type RouteCandidateRaw = {
      cc: string;
      countryName: string;
      port: PortDiscovererOutput["ports"][number];
      route: ReturnType<typeof planRoutes>[number];
    };

    const routeCandidates: RouteCandidateRaw[] = [];

    if (preferredOrigin && portsByCountry.has(preferredOrigin)) {
      // 3 routes from the same country, one per top port
      const ports = portsByCountry.get(preferredOrigin)!.slice(0, 3);
      for (const port of ports) {
        const routes = planRoutes(
          { locode: port.locode, name: port.name, lat: port.lat, lon: port.lon },
          { locode: destPort.locode, name: destPort.name, lat: destPort.lat, lon: destPort.lng },
          { maxRoutes: 1 }
        );
        if (routes[0]) {
          const cand = viableCandidates.find(
            (c) => c.country_code.toUpperCase() === preferredOrigin
          );
          routeCandidates.push({
            cc: preferredOrigin,
            countryName: cand?.country_name ?? preferredOrigin,
            port,
            route: routes[0],
          });
        }
      }
    } else {
      // Top 3 countries × best port × best route
      const top3 = viableCandidates.slice(0, 3);
      for (const cand of top3) {
        const ports = portsByCountry.get(cand.country_code);
        if (!ports?.length) continue;
        const port = ports[0]; // best port for this country
        const routes = planRoutes(
          { locode: port.locode, name: port.name, lat: port.lat, lon: port.lon },
          { locode: destPort.locode, name: destPort.name, lat: destPort.lat, lon: destPort.lng },
          { maxRoutes: 1 }
        );
        if (routes[0]) {
          routeCandidates.push({
            cc: cand.country_code,
            countryName: cand.country_name,
            port,
            route: routes[0],
          });
        }
      }
    }

    console.log(`[Orchestrator] Phase 2d: ${routeCandidates.length} route candidates planned`);

    // ── Phase 2e: Per-leg + per-route analysis fan-out ──
    // Dedupe legs by chokepoint sequence so we don't analyse the same Suez→Gibraltar leg twice.
    const uniqueLegs = new Map<string, RouteCandidateRaw["route"]["legs"][number]>();
    for (const rc of routeCandidates) {
      for (const leg of rc.route.legs) {
        const key = `${Math.round(leg.from.lat)}_${Math.round(leg.from.lon)}_${Math.round(leg.to.lat)}_${Math.round(leg.to.lon)}_${leg.chokepoint_id ?? "openwater"}`;
        if (!uniqueLegs.has(key)) uniqueLegs.set(key, leg);
      }
    }
    console.log(`[Orchestrator] Phase 2e: dispatching ${uniqueLegs.size} unique leg-analyzer + ${routeCandidates.length} freight-pricer + product-pricer per country`);

    const legAnalysisByKey = new Map<string, any>();

    await Promise.allSettled([
      // Leg analysis fan-out
      ...Array.from(uniqueLegs.entries()).map(async ([key, leg]) => {
        try {
          const result = await this.dispatchCapped("leg-analyzer", shipmentId, {
            shipmentId,
            leg: { ...leg, leg_id: key },
          });
          legAnalysisByKey.set(key, result);
        } catch (err: any) {
          console.error(`[Orchestrator] leg-analyzer failed for ${key}:`, err.message);
        }
      }),
      // Product pricer per unique country (cache covers duplicates)
      ...Array.from(new Set(routeCandidates.map((r) => r.cc))).map((cc) =>
        this.dispatchCapped("product-pricer", shipmentId, {
          hs_code: hsCode,
          origin_country: cc,
          quantity: intent.quantity,
          quantity_unit: intent.quantity_unit,
          fallback_budget_usd: intent.budget_usd ?? undefined,
          shipmentId,
        }).catch((err: any) => console.error(`[Orchestrator] product-pricer failed for ${cc}:`, err.message))
      ),
    ]);

    // ── Phase 2f: Freight pricing (after leg analysis so we have all routes priced together) ──
    const freightByCandidate = new Map<number, FreightEstimateOutput>();
    await Promise.allSettled(
      routeCandidates.map(async (rc, idx) => {
        try {
          const result = (await this.dispatchCapped("freight-pricer", shipmentId, {
            shipmentId,
            route: rc.route,
            container_count: 1,
            container_type: "40ft",
          })) as FreightEstimateOutput;
          freightByCandidate.set(idx, result);
        } catch (err: any) {
          console.error(`[Orchestrator] freight-pricer failed for ${rc.cc}/${rc.port.locode}:`, err.message);
        }
      })
    );

    // ── Phase 3: Build OptionCandidate list and dispatch option-ranker ──
    const candidatesForRanker: OptionCandidate[] = [];
    const today = new Date();
    const allSignalsForLookup = await getSignalsForShipment(shipmentId);
    const tariffSignals = allSignalsForLookup.filter((s: any) => s.agent_name === "tariff-calculator");
    const productPriceSignals = allSignalsForLookup.filter((s: any) => s.agent_name === "product-pricer");

    for (let i = 0; i < routeCandidates.length; i++) {
      const rc = routeCandidates[i];
      const tariff = (tariffSignals.find((s: any) =>
        (s.payload?.origin_country ?? "").toUpperCase() === rc.cc.toUpperCase()
      )?.payload ?? {}) as any;
      const productPrice = (productPriceSignals.find((s: any) =>
        (s.payload?.origin_country ?? "").toUpperCase() === rc.cc.toUpperCase()
      )?.payload as ProductPriceOutput | undefined);
      const freight = freightByCandidate.get(i);

      const productValue = productPrice?.total_value_usd ?? productValueUsd;
      const dutyPct = Number(tariff.total_duty_pct ?? 0);
      const dutyUsd = Math.round(productValue * dutyPct / 100);
      const freightUsd = freight?.base_freight_usd ?? 0;
      const tollsUsd = freight?.canal_tolls_usd ?? 0;
      const warRiskUsd = freight?.war_risk_premium_usd ?? 0;
      const bafUsd = freight?.bunker_adjustment_usd ?? 0;
      const insuranceUsd = Math.round(productValue * 0.005); // ~0.5% standard cargo insurance
      const brokerUsd = 250;
      const totalLanded =
        productValue + dutyUsd + freightUsd + tollsUsd + warRiskUsd + bafUsd + insuranceUsd + brokerUsd;

      const legSummaries = rc.route.legs.map((leg) => {
        const key = `${Math.round(leg.from.lat)}_${Math.round(leg.from.lon)}_${Math.round(leg.to.lat)}_${Math.round(leg.to.lon)}_${leg.chokepoint_id ?? "openwater"}`;
        const analysis = legAnalysisByKey.get(key);
        return {
          summary: analysis?.summary ?? `${leg.from.name} → ${leg.to.name} (${leg.distance_nm}nm, ${leg.estimated_days}d)`,
          severity: analysis?.risk_severity ?? "none",
        };
      });

      const eta = new Date(today.getTime() + rc.route.total_transit_days * 86_400_000);

      candidatesForRanker.push({
        country_code: rc.cc,
        country_name: rc.countryName,
        origin_port: rc.port,
        route_data: {
          origin_port: { ...rc.port, why_this_port: rc.port.rationale },
          destination_port: {
            locode: destPort.locode,
            name: destPort.name,
            lat: destPort.lat,
            lon: destPort.lng,
          },
          legs: rc.route.legs.map((leg) => {
            const key = `${Math.round(leg.from.lat)}_${Math.round(leg.from.lon)}_${Math.round(leg.to.lat)}_${Math.round(leg.to.lon)}_${leg.chokepoint_id ?? "openwater"}`;
            const analysis = legAnalysisByKey.get(key);
            return {
              ...leg,
              news_severity: analysis?.news_severity ?? "none",
              weather_severity: analysis?.weather_severity ?? "none",
              traffic_severity: analysis?.traffic_severity ?? "none",
              risk_severity: analysis?.risk_severity ?? "none",
              summary: analysis?.summary ?? null,
            };
          }),
          chokepoints: rc.route.chokepoints,
          transshipment_ports: rc.route.transshipment_ports,
          total_distance_nm: rc.route.total_distance_nm,
          total_transit_days: rc.route.total_transit_days,
        },
        cost_breakdown: {
          product_value_usd: productValue,
          base_duty_pct: tariff.base_duty_pct ?? null,
          section_301_pct: tariff.section_301_pct ?? null,
          section_232_pct: tariff.section_232_pct ?? null,
          total_duty_pct: dutyPct,
          freight_usd: freightUsd,
          canal_tolls_usd: tollsUsd,
          war_risk_premium_usd: warRiskUsd,
          insurance_usd: insuranceUsd,
          broker_fee_usd: brokerUsd,
          total_landed_cost_usd: totalLanded,
        },
        eta,
        leg_summaries: legSummaries,
        port_rationale: rc.port.rationale,
      });
    }

    const sourcing_ms = Date.now() - start;
    const agentNames = [
      "country-discoverer",
      "tariff-calculator",
      "country-risk",
      "supplier-verifier",
      "compliance-screener",
      "port-discoverer",
      "leg-analyzer",
      "freight-pricer",
      "product-pricer",
    ];

    try {
      await createSignal({
        agent_name: "orchestrator",
        signal_type: "sourcing_complete",
        severity: "info",
        shipment_id: shipmentId,
        payload: {
          agentNames,
          durationMs: sourcing_ms,
          candidateCount: candidates.length,
          viableCount: viableCandidates.length,
          routeCandidateCount: routeCandidates.length,
          legAnalysisCount: legAnalysisByKey.size,
        },
        citations: [],
        occurred_at: new Date(),
      });
    } catch (err: any) {
      console.error(`[Orchestrator] failed to write sourcing_complete signal:`, err.message);
    }

    emit("SOURCING_COMPLETE", { shipmentId, agentNames, durationMs: sourcing_ms });

    console.log(
      `[Orchestrator] SOURCING_COMPLETE for shipment ${shipmentId} in ${(sourcing_ms / 1000).toFixed(1)}s — dispatching option-ranker with ${candidatesForRanker.length} candidates`
    );

    if (candidatesForRanker.length === 0) {
      console.error(`[Orchestrator] no candidates to rank for ${shipmentId} — pipeline aborted`);
      return;
    }

    try {
      await this.dispatchCapped("option-ranker", shipmentId, {
        shipmentId,
        candidates: candidatesForRanker,
        intent_data: {
          ...(intent as unknown as Record<string, unknown>),
          product_value_usd: productValueUsd,
        },
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
  orchestrator.register("port-discoverer", (payload) =>
    new PortDiscovererAgent().run(payload) as Promise<unknown>
  );
  orchestrator.register("leg-analyzer", (payload) =>
    new LegAnalyzerAgent().run(payload) as Promise<unknown>
  );
  orchestrator.register("freight-pricer", (payload) =>
    new FreightPricerAgent().run(payload) as Promise<unknown>
  );
  orchestrator.register("product-pricer", (payload) =>
    new ProductPricerAgent().run(payload) as Promise<unknown>
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
}
