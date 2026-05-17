// Lloyd's JWLA-style listed war/insurance-risk areas.
// Premium adders are approximate JWLA market rates as of 2025-2026.
// Each entry has a polygon-as-bbox covering the affected waters.

export interface WarRiskZone {
  id: string;
  name: string;
  bbox: [number, number, number, number]; // [minLat, minLon, maxLat, maxLon]
  severity: "low" | "medium" | "high" | "critical";
  premium_adder_pct: number; // pct of hull value, applied on top of base insurance
  reason: string;
  as_of: string; // YYYY-MM-DD
}

export const WAR_RISK_ZONES: WarRiskZone[] = [
  {
    id: "red_sea_houthi",
    name: "Red Sea / Gulf of Aden — Houthi attacks",
    bbox: [11.0, 32.0, 30.5, 51.0],
    severity: "critical",
    premium_adder_pct: 1.0,
    reason: "Active Houthi missile/drone attacks on commercial shipping; many carriers re-routing via Cape of Good Hope.",
    as_of: "2026-04-01",
  },
  {
    id: "black_sea_war",
    name: "Black Sea — Russia/Ukraine war",
    bbox: [40.5, 27.5, 47.0, 42.0],
    severity: "critical",
    premium_adder_pct: 0.8,
    reason: "Active mine threat, drone strikes on port infrastructure (Odesa, Pivdennyi).",
    as_of: "2026-04-01",
  },
  {
    id: "persian_gulf_tensions",
    name: "Persian Gulf / Strait of Hormuz",
    bbox: [22.0, 47.5, 31.0, 60.0],
    severity: "medium",
    premium_adder_pct: 0.25,
    reason: "Tanker seizures by Iranian forces; elevated tensions around Hormuz.",
    as_of: "2026-04-01",
  },
  {
    id: "gulf_of_guinea_piracy",
    name: "Gulf of Guinea — armed piracy",
    bbox: [-2.0, -10.0, 8.0, 14.0],
    severity: "high",
    premium_adder_pct: 0.4,
    reason: "Persistent kidnap-for-ransom piracy off Nigeria/Benin.",
    as_of: "2026-04-01",
  },
  {
    id: "somalia_basin_piracy",
    name: "Somali Basin",
    bbox: [-5.0, 42.0, 12.0, 60.0],
    severity: "medium",
    premium_adder_pct: 0.2,
    reason: "Resurgent Somali piracy activity 2024-2026; lower than 2011 peak.",
    as_of: "2026-04-01",
  },
];

import { bboxOverlap } from "./geometry";

export function warRiskZonesForBbox(
  legBbox: [number, number, number, number]
): WarRiskZone[] {
  return WAR_RISK_ZONES.filter((z) => bboxOverlap(legBbox, z.bbox));
}
