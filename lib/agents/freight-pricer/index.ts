import { z } from "zod";
import { Agent } from "../base";
import type { RoutePlan } from "../../routing/route-planner";
import { getBunkerPrice, estimateLegFuelCostUsd } from "../../sources/bunker";
import { warRiskZonesForBbox } from "../../routing/war-risk-zones";
import { getChokepoint } from "../../routing/chokepoints";

// ─── Schemas ───────────────────────────────────────────────────────────────

export const Modality = z.enum(["air", "lcl", "fcl"]);
export type Modality = z.infer<typeof Modality>;

const LegCost = z.object({
  from: z.string(),
  to: z.string(),
  distance_nm: z.number(),
  fuel_usd: z.number(),
  toll_usd: z.number(),
  war_risk_premium_usd: z.number(),
});

const ModalityOption = z.object({
  modality: Modality,
  cost_usd: z.number(),
  transit_days: z.number(),
  origin_code: z.string(),         // seaport LOCODE or airport IATA
  origin_name: z.string(),
  destination_code: z.string(),
  destination_name: z.string(),
  base_freight_usd: z.number(),
  canal_tolls_usd: z.number(),
  war_risk_premium_usd: z.number(),
  bunker_adjustment_usd: z.number(),
  meets_deadline: z.boolean().nullable(),
  reason_chosen_or_rejected: z.string(),
  notes: z.string().nullable(),
});

export type ModalityOption = z.infer<typeof ModalityOption>;

export const FreightEstimateOutput = z.object({
  origin_port: z.string(),
  destination_port: z.string(),
  container_count: z.number(),
  // Legacy fields — populated from the RECOMMENDED modality for backwards compat.
  base_freight_usd: z.number(),
  canal_tolls_usd: z.number(),
  war_risk_premium_usd: z.number(),
  bunker_adjustment_usd: z.number(),
  total_freight_usd: z.number(),
  legs: z.array(LegCost),
  bunker_price_usd_per_mt: z.number(),
  source: z.string(),
  // New: full modality matrix + recommendation
  modality: Modality,
  modalities: z.array(ModalityOption),
  recommended_modality: Modality,
  cargo_kg: z.number().nullable(),
});

export type FreightEstimateOutput = z.infer<typeof FreightEstimateOutput>;

// ─── Input ─────────────────────────────────────────────────────────────────

export interface FreightPricerInput {
  shipmentId?: string;
  // For SEA modalities: the actual planned sea route through chokepoints
  sea_route?: RoutePlan | null;
  // For AIR modality: the great-circle airport-to-airport route
  air_route?: RoutePlan | null;
  container_count?: number;
  container_type?: "20ft" | "40ft" | "40HQ";
  cargo_kg?: number | null;
  deadline_days?: number | null; // days from now; for marking modality.meets_deadline
}

// ─── Calibration constants ────────────────────────────────────────────────
const BASE_RATE_USD_PER_NM_PER_TEU = 0.42;
const TEU_PER_CONTAINER: Record<string, number> = { "20ft": 1, "40ft": 2, "40HQ": 2 };

// Cargo-weight thresholds for which modality makes sense
const FCL_MIN_KG = 5000;     // below this, FCL is wasteful
const LCL_MAX_KG = 18000;    // above this, LCL becomes more expensive than FCL
const AIR_MAX_KG = 1500;     // above this, air courier is impractically expensive

// ─── Helpers ──────────────────────────────────────────────────────────────

function estimateLCLFreightUsd(distanceNm: number, cargoKg: number): { cost: number; transit: number } {
  // Sea LCL: ~$130-220/CBM door-to-door. Garments ~200 kg/CBM. Distance-scaled.
  // Tuned so LCL is cheaper than FCL up to ~12-15 CBM (~3 tons), then FCL wins.
  const cbm = Math.max(cargoKg / 200, 0.1);
  const base = 95 + cbm * 175;
  const distanceMultiplier = 1 + (distanceNm / 5500) * 0.6; // ~1.65x trans-Pacific
  const cost = Math.round(base * distanceMultiplier);
  const transit = Math.ceil(distanceNm / (12 * 24)) + 7;
  return { cost, transit };
}

function estimateAirFreightUsd(distanceNm: number, cargoKg: number): { cost: number; transit: number } {
  const ratePerKg = distanceNm > 7000 ? 12 : distanceNm > 3500 ? 9 : 7;
  const cost = Math.max(80, Math.round(cargoKg * ratePerKg));
  // Air transit: ~2-5d door-to-door for courier (clearance + handling included)
  const transit = distanceNm > 7000 ? 5 : distanceNm > 3500 ? 4 : 3;
  return { cost, transit };
}

// ─── Agent ─────────────────────────────────────────────────────────────────

export class FreightPricerAgent extends Agent {
  readonly name = "freight-pricer";
  readonly tier = "none" as const;

  async process(input: unknown): Promise<FreightEstimateOutput> {
    const {
      sea_route,
      air_route,
      container_count = 1,
      container_type = "40ft",
      cargo_kg = null,
      deadline_days = null,
      shipmentId,
    } = input as FreightPricerInput;

    if (!sea_route && !air_route) {
      throw new Error("freight-pricer needs at least one of sea_route or air_route");
    }

    const modalities: ModalityOption[] = [];

    // ─ FCL evaluation (sea, full container) ─
    if (sea_route) {
      const teuFactor = TEU_PER_CONTAINER[container_type] ?? 2;
      const teuCount = container_count * teuFactor;
      const bunker = await getBunkerPrice();
      const fuelPrice = bunker.vlsfo_usd_per_mt;

      let baseFreight = 0;
      let canalTolls = 0;
      let warRiskPremium = 0;

      for (const leg of sea_route.legs) {
        const distanceCost = Math.round(leg.distance_nm * BASE_RATE_USD_PER_NM_PER_TEU * teuCount);
        const cp = leg.chokepoint_id ? getChokepoint(leg.chokepoint_id) : null;
        const tollUsd = cp && !cp.is_passage ? cp.toll_usd_per_teu * teuCount : 0;
        const zones = warRiskZonesForBbox(leg.bbox);
        const hullValue = 150_000 * teuCount;
        const legWar = zones.reduce((s, z) => s + Math.round(hullValue * z.premium_adder_pct / 100), 0);

        baseFreight += distanceCost;
        canalTolls += tollUsd;
        warRiskPremium += legWar;
        // ignore per-leg fuel breakdown in modality summary
        estimateLegFuelCostUsd(leg.distance_nm, fuelPrice);
      }
      const baf = Math.round(baseFreight * 0.12 * (fuelPrice / 600));
      const fclTotal = baseFreight + canalTolls + warRiskPremium + baf;
      const fclTransit = sea_route.total_transit_days;
      const fclMeetsDeadline = deadline_days == null ? null : fclTransit + 3 <= deadline_days;

      const fclMakesSense =
        cargo_kg == null || cargo_kg >= FCL_MIN_KG;
      modalities.push({
        modality: "fcl",
        cost_usd: fclTotal,
        transit_days: fclTransit,
        origin_code: sea_route.origin_port.locode,
        origin_name: sea_route.origin_port.name,
        destination_code: sea_route.destination_port.locode,
        destination_name: sea_route.destination_port.name,
        base_freight_usd: baseFreight,
        canal_tolls_usd: canalTolls,
        war_risk_premium_usd: warRiskPremium,
        bunker_adjustment_usd: baf,
        meets_deadline: fclMeetsDeadline,
        reason_chosen_or_rejected: fclMakesSense
          ? `full 40ft container (${cargo_kg ? cargo_kg.toFixed(0) + "kg cargo, " : ""}fits within capacity)`
          : `full container under-utilized — only ${cargo_kg?.toFixed(0)}kg cargo for a ~20,000kg container`,
        notes: null,
      });
    }

    // ─ LCL evaluation (sea, less-than-container) ─
    if (sea_route && cargo_kg != null && cargo_kg > 0 && cargo_kg <= LCL_MAX_KG) {
      const total = sea_route.total_distance_nm;
      const { cost, transit } = estimateLCLFreightUsd(total, cargo_kg);
      // tolls: rough 5% share of one TEU toll per chokepoint
      let tolls = 0;
      for (const leg of sea_route.legs) {
        const cp = leg.chokepoint_id ? getChokepoint(leg.chokepoint_id) : null;
        if (cp && !cp.is_passage) tolls += Math.round(cp.toll_usd_per_teu * 0.05);
      }
      const lclTransit = transit;
      const lclMeetsDeadline = deadline_days == null ? null : lclTransit + 3 <= deadline_days;

      modalities.push({
        modality: "lcl",
        cost_usd: cost + tolls,
        transit_days: lclTransit,
        origin_code: sea_route.origin_port.locode,
        origin_name: sea_route.origin_port.name,
        destination_code: sea_route.destination_port.locode,
        destination_name: sea_route.destination_port.name,
        base_freight_usd: cost,
        canal_tolls_usd: tolls,
        war_risk_premium_usd: 0,
        bunker_adjustment_usd: 0,
        meets_deadline: lclMeetsDeadline,
        reason_chosen_or_rejected: `sea LCL — ${cargo_kg.toFixed(0)}kg / ~${(cargo_kg / 200).toFixed(2)} CBM consolidated`,
        notes: null,
      });
    }

    // ─ Air courier evaluation ─
    if (air_route && cargo_kg != null && cargo_kg > 0 && cargo_kg <= AIR_MAX_KG) {
      const { cost, transit } = estimateAirFreightUsd(air_route.total_distance_nm, cargo_kg);
      const airMeetsDeadline = deadline_days == null ? null : transit + 1 <= deadline_days;
      modalities.push({
        modality: "air",
        cost_usd: cost,
        transit_days: transit,
        origin_code: air_route.origin_port.locode, // IATA
        origin_name: air_route.origin_port.name,
        destination_code: air_route.destination_port.locode,
        destination_name: air_route.destination_port.name,
        base_freight_usd: cost,
        canal_tolls_usd: 0,
        war_risk_premium_usd: 0,
        bunker_adjustment_usd: 0,
        meets_deadline: airMeetsDeadline,
        reason_chosen_or_rejected: `air courier — ${cargo_kg.toFixed(0)}kg @ $${(cost / cargo_kg).toFixed(2)}/kg, ${transit}d door-to-door`,
        notes: cost > 4000 ? "expensive for the weight; consider LCL if deadline allows" : null,
      });
    }

    if (modalities.length === 0) {
      throw new Error(`freight-pricer: no viable modalities (cargo_kg=${cargo_kg}, sea=${!!sea_route}, air=${!!air_route})`);
    }

    // ─ Recommendation: cheapest that meets deadline; if none meet, fastest ─
    const sortedByCost = [...modalities].sort((a, b) => a.cost_usd - b.cost_usd);
    let recommended =
      sortedByCost.find((m) => m.meets_deadline !== false) ??
      [...modalities].sort((a, b) => a.transit_days - b.transit_days)[0];

    // Annotate the recommendation
    recommended = { ...recommended, notes: `RECOMMENDED — cheapest modality that meets deadline (${recommended.transit_days}d transit)` };
    modalities[modalities.findIndex((m) => m.modality === recommended.modality)] = recommended;

    const recRoute = recommended.modality === "air" ? air_route! : sea_route!;
    const result: FreightEstimateOutput = {
      origin_port: recommended.origin_code,
      destination_port: recommended.destination_code,
      container_count: recommended.modality === "fcl" ? container_count : 0,
      base_freight_usd: recommended.base_freight_usd,
      canal_tolls_usd: recommended.canal_tolls_usd,
      war_risk_premium_usd: recommended.war_risk_premium_usd,
      bunker_adjustment_usd: recommended.bunker_adjustment_usd,
      total_freight_usd: recommended.cost_usd,
      legs: recRoute.legs.map((leg) => ({
        from: leg.from.name, to: leg.to.name, distance_nm: leg.distance_nm,
        fuel_usd: 0, toll_usd: 0, war_risk_premium_usd: 0,
      })),
      bunker_price_usd_per_mt: 0,
      source: `${recommended.modality.toUpperCase()} ${recommended.origin_code} → ${recommended.destination_code} (${recommended.transit_days}d, ${modalities.length} modalit${modalities.length === 1 ? "y" : "ies"} evaluated)`,
      modality: recommended.modality,
      modalities,
      recommended_modality: recommended.modality,
      cargo_kg,
    };

    await this.publishSignal({
      shipmentId, signalType: "freight_estimate", severity: "info",
      payload: result as unknown as Record<string, unknown>, confidence: 0.75,
    });

    return result;
  }
}
