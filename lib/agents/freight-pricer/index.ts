import { z } from "zod";
import { Agent } from "../base";
import type { RoutePlan } from "../../routing/route-planner";
import { getBunkerPrice, estimateLegFuelCostUsd } from "../../sources/bunker";
import { warRiskZonesForBbox } from "../../routing/war-risk-zones";
import { getChokepoint } from "../../routing/chokepoints";

// ─── Schemas ───────────────────────────────────────────────────────────────

const LegCost = z.object({
  from: z.string(),
  to: z.string(),
  distance_nm: z.number(),
  fuel_usd: z.number(),
  toll_usd: z.number(),
  war_risk_premium_usd: z.number(),
});

export const FreightEstimateOutput = z.object({
  origin_port: z.string(),
  destination_port: z.string(),
  container_count: z.number(),
  base_freight_usd: z.number(),
  canal_tolls_usd: z.number(),
  war_risk_premium_usd: z.number(),
  bunker_adjustment_usd: z.number(),
  total_freight_usd: z.number(),
  legs: z.array(LegCost),
  bunker_price_usd_per_mt: z.number(),
  source: z.string(),
});

export type FreightEstimateOutput = z.infer<typeof FreightEstimateOutput>;

// ─── Input ─────────────────────────────────────────────────────────────────

export interface FreightPricerInput {
  shipmentId?: string;
  route: RoutePlan;
  container_count?: number;
  container_type?: "20ft" | "40ft" | "40HQ";
}

// ─── Calibration constants ────────────────────────────────────────────────
// Tuned so a typical trans-Pacific (Shanghai → LA, ~5,600nm) for 1 FEU lands
// near the 2026 Q2 mid-cycle spot rate of ~$3,500-4,500.
const BASE_RATE_USD_PER_NM_PER_TEU = 0.42;
const TEU_PER_CONTAINER: Record<string, number> = {
  "20ft": 1,
  "40ft": 2,
  "40HQ": 2,
};

// ─── Agent ─────────────────────────────────────────────────────────────────

export class FreightPricerAgent extends Agent {
  readonly name = "freight-pricer";
  readonly tier = "none" as const;

  async process(input: unknown): Promise<FreightEstimateOutput> {
    const { route, container_count = 1, container_type = "40ft", shipmentId } =
      input as FreightPricerInput;

    const teuFactor = TEU_PER_CONTAINER[container_type] ?? 2;
    const teuCount = container_count * teuFactor;

    const bunker = await getBunkerPrice();
    const fuelPrice = bunker.vlsfo_usd_per_mt;

    let baseFreight = 0;
    let canalTolls = 0;
    let warRiskPremium = 0;
    const legs: z.infer<typeof LegCost>[] = [];

    for (const leg of route.legs) {
      const fuel = estimateLegFuelCostUsd(leg.distance_nm, fuelPrice);
      const distanceCost = Math.round(
        leg.distance_nm * BASE_RATE_USD_PER_NM_PER_TEU * teuCount
      );
      const cp = leg.chokepoint_id ? getChokepoint(leg.chokepoint_id) : null;
      const tollUsd = cp && !cp.is_passage ? cp.toll_usd_per_teu * teuCount : 0;

      // War-risk premium: estimate hull value as ~$150K per TEU times zone's pct adder.
      const zones = warRiskZonesForBbox(leg.bbox);
      const hullValueEstimate = 150_000 * teuCount;
      const legWarPremium = zones.reduce(
        (sum, z) => sum + Math.round(hullValueEstimate * z.premium_adder_pct / 100),
        0
      );

      baseFreight += distanceCost;
      canalTolls += tollUsd;
      warRiskPremium += legWarPremium;

      legs.push({
        from: leg.from.name,
        to: leg.to.name,
        distance_nm: leg.distance_nm,
        fuel_usd: fuel,
        toll_usd: tollUsd,
        war_risk_premium_usd: legWarPremium,
      });
    }

    // Bunker Adjustment Factor — fuel volatility surcharge. ~12% of base freight
    // when bunker is near $600/MT; scales linearly.
    const baf = Math.round(baseFreight * 0.12 * (fuelPrice / 600));

    const total = baseFreight + canalTolls + warRiskPremium + baf;

    const result: FreightEstimateOutput = {
      origin_port: route.origin_port.locode,
      destination_port: route.destination_port.locode,
      container_count,
      base_freight_usd: baseFreight,
      canal_tolls_usd: canalTolls,
      war_risk_premium_usd: warRiskPremium,
      bunker_adjustment_usd: baf,
      total_freight_usd: total,
      legs,
      bunker_price_usd_per_mt: fuelPrice,
      source: `distance@${BASE_RATE_USD_PER_NM_PER_TEU}/nm/TEU + canal tolls + BAF(${(fuelPrice / 600 * 12).toFixed(1)}%) + JWLA premiums`,
    };

    await this.publishSignal({
      shipmentId,
      signalType: "freight_estimate",
      severity: "info",
      payload: result as unknown as Record<string, unknown>,
      confidence: 0.75,
    });

    return result;
  }
}
