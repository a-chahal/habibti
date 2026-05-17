// Seasonal hazard windows by region. Pure calendar logic — given a date and a
// leg's bounding box, what climatological hazards are in play?

export interface SeasonalHazard {
  id: string;
  name: string;
  bbox: [number, number, number, number];
  // Months when hazard is active, 1-12 inclusive. Wrap-around supported (e.g. [11,12,1,2]).
  active_months: number[];
  severity: "low" | "medium" | "high";
  description: string;
}

export const SEASONAL_HAZARDS: SeasonalHazard[] = [
  {
    id: "wpac_typhoon",
    name: "Western Pacific typhoon season",
    bbox: [5.0, 105.0, 35.0, 160.0],
    active_months: [6, 7, 8, 9, 10, 11],
    severity: "high",
    description: "Typhoons can disrupt East China Sea, South China Sea, Philippine waters; peak Aug-Oct.",
  },
  {
    id: "atlantic_hurricane",
    name: "Atlantic hurricane season",
    bbox: [8.0, -100.0, 35.0, -10.0],
    active_months: [6, 7, 8, 9, 10, 11],
    severity: "high",
    description: "Caribbean and US East Coast — hurricanes Jun-Nov, peak Aug-Sep.",
  },
  {
    id: "indian_monsoon_sw",
    name: "Indian Ocean SW monsoon",
    bbox: [-10.0, 40.0, 25.0, 90.0],
    active_months: [6, 7, 8, 9],
    severity: "medium",
    description: "SW monsoon brings heavy seas and reduced visibility across Arabian Sea / Bay of Bengal.",
  },
  {
    id: "north_atlantic_winter",
    name: "North Atlantic winter storms",
    bbox: [30.0, -80.0, 65.0, 20.0],
    active_months: [11, 12, 1, 2, 3],
    severity: "medium",
    description: "Heavy weather across the North Atlantic Nov-Mar — schedule slippage common.",
  },
  {
    id: "cape_horn_winter",
    name: "Cape Horn / Drake Passage — S. Hemisphere winter",
    bbox: [-60.0, -75.0, -40.0, -60.0],
    active_months: [6, 7, 8, 9],
    severity: "high",
    description: "Severe sea state south of South America Jun-Sep; few carriers route here.",
  },
  {
    id: "north_pacific_winter",
    name: "North Pacific winter storms",
    bbox: [30.0, 120.0, 60.0, -120.0],
    active_months: [12, 1, 2, 3],
    severity: "medium",
    description: "Aleutian lows generate large seas; trans-Pacific schedules slip 2-4 days.",
  },
];

import { bboxOverlap } from "./geometry";

export function seasonalHazardsForBbox(
  legBbox: [number, number, number, number],
  date = new Date()
): SeasonalHazard[] {
  const month = date.getUTCMonth() + 1; // 1-12
  return SEASONAL_HAZARDS.filter(
    (h) => bboxOverlap(legBbox, h.bbox) && h.active_months.includes(month)
  );
}

// Simple climatology lookup — typical wave height in metres by basin + month.
// Calibrated from World Meteorological Organization climate atlases.
const CLIMATOLOGY: Record<string, number[]> = {
  // Index 0 = January, index 11 = December
  north_pacific:   [3.5, 3.4, 3.0, 2.4, 1.9, 1.7, 1.6, 1.8, 2.3, 2.9, 3.3, 3.6],
  south_pacific:   [1.8, 1.9, 2.0, 2.3, 2.6, 2.9, 3.1, 3.0, 2.7, 2.4, 2.1, 1.9],
  north_atlantic:  [3.8, 3.6, 3.2, 2.6, 2.1, 1.8, 1.7, 1.9, 2.4, 3.0, 3.5, 3.8],
  south_atlantic:  [1.9, 2.0, 2.1, 2.4, 2.7, 3.0, 3.2, 3.1, 2.8, 2.5, 2.2, 2.0],
  indian_ocean:    [1.6, 1.5, 1.5, 1.6, 2.1, 2.8, 3.2, 3.1, 2.5, 1.9, 1.6, 1.5],
  arabian_sea:     [1.4, 1.3, 1.3, 1.5, 2.2, 3.0, 3.4, 3.3, 2.6, 1.8, 1.5, 1.4],
  mediterranean:   [2.0, 1.9, 1.7, 1.4, 1.1, 0.9, 0.9, 1.0, 1.3, 1.7, 1.9, 2.0],
  south_china_sea: [2.2, 2.0, 1.6, 1.3, 1.4, 1.8, 1.9, 2.1, 2.4, 2.5, 2.3, 2.2],
  east_china_sea:  [2.4, 2.2, 1.9, 1.6, 1.5, 1.6, 1.8, 2.1, 2.3, 2.5, 2.5, 2.4],
  caribbean:       [2.0, 1.9, 1.8, 1.6, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9, 2.0, 2.0],
  west_pacific:    [2.0, 1.9, 1.8, 1.7, 1.6, 1.7, 1.8, 2.0, 2.2, 2.3, 2.2, 2.1],
  black_sea:       [1.5, 1.4, 1.3, 1.0, 0.8, 0.7, 0.7, 0.8, 1.0, 1.2, 1.4, 1.5],
  persian_gulf:    [1.0, 0.9, 0.9, 0.8, 0.7, 0.7, 0.7, 0.8, 0.8, 0.9, 1.0, 1.0],
  baltic_sea:      [1.4, 1.3, 1.1, 0.9, 0.7, 0.7, 0.7, 0.9, 1.1, 1.3, 1.4, 1.4],
};

export function climatologicalWaveHeight(
  basin: string,
  date = new Date()
): number | null {
  const arr = CLIMATOLOGY[basin];
  if (!arr) return null;
  return arr[date.getUTCMonth()];
}
