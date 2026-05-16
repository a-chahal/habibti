import { z } from "zod";
import { Agent } from "../base";
import {
  getShipment,
  getSignalsForShipment,
  getOptionsForShipment,
  recordSupplierHistory,
  recordRouteHistory,
} from "../../db/queries";

export const FeedbackLoopOutput = z.object({
  shipment_id: z.string(),
  predicted_eta: z.string().nullable(),
  actual_eta: z.string(),
  delay_days: z.number(),
  reliability_score: z.number(),
  predicted_transit_days: z.number().nullable(),
  actual_transit_days: z.number().nullable(),
  learning_note: z.string(),
});

export type FeedbackLoopOutput = z.infer<typeof FeedbackLoopOutput>;

export class FeedbackLoopAgent extends Agent {
  readonly name = "feedback-loop";
  readonly tier = "mercury" as const;

  async process(input: unknown): Promise<FeedbackLoopOutput> {
    const { shipmentId, actual_delivered_at, notes } = input as {
      shipmentId: string;
      actual_delivered_at: string; // ISO date
      notes?: string;
    };

    const [shipment, allSignals, options] = await Promise.all([
      getShipment(shipmentId),
      getSignalsForShipment(shipmentId),
      getOptionsForShipment(shipmentId),
    ]);

    if (!shipment) throw new Error(`Shipment ${shipmentId} not found`);

    const rank1Option = options.find((o) => o.rank === 1);
    const actualDate = new Date(actual_delivered_at);

    // Predicted ETA from the rank-1 option
    const predictedETA = rank1Option?.eta ?? shipment.expected_eta;
    const predictedTransitDays = rank1Option
      ? Math.round(
          ((rank1Option.eta?.getTime() ?? Date.now()) - shipment.created_at.getTime()) /
            (24 * 60 * 60 * 1000)
        )
      : null;

    const actualTransitDays = Math.round(
      (actualDate.getTime() - shipment.created_at.getTime()) / (24 * 60 * 60 * 1000)
    );

    const delayDays = predictedETA
      ? (actualDate.getTime() - predictedETA.getTime()) / (24 * 60 * 60 * 1000)
      : 0;

    // Reliability score: 1.0 = on time, decays with delay
    const reliabilityScore = Math.max(0, Math.min(1, 1 - Math.abs(delayDays) / 14));

    // Build context for Sonnet learning note
    const routeSignal = allSignals.find((s) => s.agent_name === "route-prescorer");
    const riskSignal = allSignals.find((s) => s.agent_name === "country-risk");
    const tariffSignal = allSignals
      .filter((s) => s.agent_name === "tariff-calculator")
      .find((s) => {
        const p = s.payload as any;
        return p?.origin_country === rank1Option?.country;
      });

    const contextLines = [
      `Shipment: ${shipmentId}`,
      `Top-ranked option country: ${rank1Option?.country ?? "unknown"}`,
      `Predicted ETA: ${predictedETA?.toISOString().slice(0, 10) ?? "unknown"}`,
      `Actual delivery: ${actual_delivered_at}`,
      `Delay: ${delayDays > 0 ? "+" : ""}${delayDays.toFixed(1)} days`,
      `Predicted transit: ${predictedTransitDays ?? "unknown"} days`,
      `Actual transit: ${actualTransitDays} days`,
      `Route risk at dispatch: ${(riskSignal?.payload as any)?.stability ?? "unknown"}`,
      `Tariff total duty: ${(tariffSignal?.payload as any)?.total_duty_pct ?? "unknown"}%`,
      `Landed cost: $${(tariffSignal?.payload as any)?.total_landed_cost_usd ?? "unknown"}`,
      `Notes: ${notes ?? "none"}`,
    ];

    const context = contextLines.join("\n");

    const learningNote = await this.callLLM([
      {
        role: "system",
        content: `You are a trade analyst writing a post-delivery learning note for a small importer.
Write exactly one paragraph (3-5 sentences) that:
1. States what happened (delay, on-time, or early) with specific numbers
2. Identifies the most likely cause based on the signal data
3. Gives one concrete recommendation to improve the next similar shipment
Be specific and data-driven. Do not hedge.`,
      },
      {
        role: "user",
        content: `Completed shipment data:\n${context}\n\nWrite the post-delivery learning note.`,
      },
    ]);

    // Write supplier history if we have a supplier_id
    const supplierId = rank1Option?.supplier_id;
    if (supplierId) {
      await recordSupplierHistory({
        supplier_id: supplierId,
        shipment_id: shipmentId,
        predicted_eta: predictedETA ?? undefined,
        actual_eta: actualDate,
        delay_days: delayDays.toFixed(2) as any,
        reliability_score: reliabilityScore.toFixed(3) as any,
        notes: learningNote,
      });
    }

    // Write route history
    const routePayload = routeSignal?.payload as any;
    const routeData = routePayload?.routes?.[0];
    const originPort = routePayload?.origin_country ?? rank1Option?.country ?? "unknown";
    const destPort = routePayload?.destination_port ?? shipment.destination_port ?? "USLAX";

    await recordRouteHistory({
      origin_port: originPort,
      destination_port: destPort,
      shipment_id: shipmentId,
      predicted_transit_days: predictedTransitDays ?? undefined,
      actual_transit_days: actualTransitDays,
      disruption_events: routeData?.chokepoint_risks?.filter((cp: any) => cp.severity !== "none") ?? [],
    });

    const result: FeedbackLoopOutput = {
      shipment_id: shipmentId,
      predicted_eta: predictedETA?.toISOString().slice(0, 10) ?? null,
      actual_eta: actual_delivered_at,
      delay_days: +delayDays.toFixed(2),
      reliability_score: +reliabilityScore.toFixed(3),
      predicted_transit_days: predictedTransitDays,
      actual_transit_days: actualTransitDays,
      learning_note: learningNote,
    };

    await this.publishSignal({
      shipmentId,
      signalType: "delivery_feedback",
      severity: Math.abs(delayDays) > 7 ? "medium" : "info",
      payload: result as unknown as Record<string, unknown>,
      confidence: 0.95,
    });

    return result;
  }
}
