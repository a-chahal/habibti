// Ocean basins as axis-aligned bounding polygons.
// A port is assigned to the basin whose bbox contains it (first match wins).
// Order matters: more specific basins must come before larger ones.

export interface Basin {
  id: string;
  name: string;
  // [minLat, minLon, maxLat, maxLon]
  bbox: [number, number, number, number];
  chokepoints: string[];
}

export const BASINS: Basin[] = [
  // Small / enclosed seas first — must beat larger basins on overlap
  {
    id: "black_sea",
    name: "Black Sea",
    bbox: [40.5, 27.5, 47.0, 42.0],
    chokepoints: ["bosphorus"],
  },
  {
    id: "mediterranean",
    name: "Mediterranean Sea",
    bbox: [30.0, -6.5, 47.0, 36.5],
    chokepoints: ["suez", "bab_el_mandeb", "gibraltar", "bosphorus"],
  },
  {
    id: "persian_gulf",
    name: "Persian Gulf",
    bbox: [22.0, 47.5, 31.0, 60.0],
    chokepoints: ["hormuz"],
  },
  {
    id: "arabian_sea",
    name: "Arabian Sea",
    bbox: [0.0, 45.0, 26.0, 78.0],
    chokepoints: ["hormuz", "bab_el_mandeb", "malacca"],
  },
  {
    id: "south_china_sea",
    name: "South China Sea",
    bbox: [-5.0, 99.0, 25.0, 122.0],
    chokepoints: ["malacca", "sunda_strait", "taiwan_strait"],
  },
  {
    id: "east_china_sea",
    name: "East China Sea",
    bbox: [24.0, 118.0, 40.0, 132.0],
    chokepoints: ["taiwan_strait"],
  },
  {
    id: "caribbean",
    name: "Caribbean Sea",
    bbox: [8.0, -90.0, 26.0, -58.0],
    chokepoints: ["panama"],
  },
  {
    id: "baltic_sea",
    name: "Baltic Sea",
    // Starts east of the Danish straits — keep Hamburg (lon~10) out of this basin.
    bbox: [54.0, 12.0, 66.0, 30.0],
    chokepoints: ["kiel_canal"],
  },
  // Larger basins
  {
    id: "indian_ocean",
    name: "Indian Ocean",
    bbox: [-40.0, 20.0, 30.0, 100.0],
    chokepoints: ["suez", "bab_el_mandeb", "malacca", "sunda_strait", "cape_good_hope", "hormuz", "torres_strait"],
  },
  {
    id: "north_pacific",
    name: "North Pacific",
    bbox: [0.0, -180.0, 66.0, -100.0],
    chokepoints: ["panama", "taiwan_strait"],
  },
  {
    id: "south_pacific",
    name: "South Pacific",
    bbox: [-60.0, -180.0, 0.0, -60.0],
    chokepoints: ["panama", "cape_horn", "torres_strait"],
  },
  {
    id: "north_atlantic",
    name: "North Atlantic",
    bbox: [0.0, -100.0, 66.0, 20.0],
    chokepoints: ["panama", "gibraltar", "kiel_canal"],
  },
  {
    id: "south_atlantic",
    name: "South Atlantic",
    bbox: [-60.0, -60.0, 0.0, 20.0],
    chokepoints: ["cape_good_hope", "cape_horn"],
  },
  // Fallback — catch-all for Pacific coords not matched above
  {
    id: "west_pacific",
    name: "West Pacific",
    bbox: [-60.0, 100.0, 66.0, 180.0],
    chokepoints: ["malacca", "sunda_strait", "taiwan_strait", "torres_strait"],
  },
];

/**
 * Open-water adjacency between ocean basins.
 * Two ocean basins listed here can be sailed between WITHOUT a chokepoint
 * (open ocean, no canal/strait toll). Enclosed seas (mediterranean, black_sea,
 * persian_gulf, baltic_sea) have NO adjacencies — they MUST be entered via a chokepoint.
 */
export const BASIN_ADJACENCY: Record<string, string[]> = {
  // Pacific system — all open ocean, freely interconnected
  north_pacific: ["south_pacific", "east_china_sea", "south_china_sea", "west_pacific"],
  south_pacific: ["north_pacific", "indian_ocean", "west_pacific"],
  east_china_sea: ["north_pacific", "south_china_sea"],
  south_china_sea: ["east_china_sea", "north_pacific", "west_pacific"],
  west_pacific: ["north_pacific", "south_pacific", "south_china_sea"],
  // Indian Ocean system
  indian_ocean: ["arabian_sea", "south_pacific"],
  arabian_sea: ["indian_ocean"],
  // Atlantic system — all three drain into each other via open ocean
  north_atlantic: ["south_atlantic", "caribbean"],
  south_atlantic: ["north_atlantic", "caribbean"],
  caribbean: ["north_atlantic", "south_atlantic"],
  // Enclosed: chokepoint-entry only
  mediterranean: [],
  black_sea: [],
  persian_gulf: [],
  baltic_sea: [],
};

export function basinsAdjacent(a: string, b: string): boolean {
  if (a === b) return true;
  return (BASIN_ADJACENCY[a] ?? []).includes(b);
}

export function basinForLatLon(lat: number, lon: number): string {
  // Normalise longitude to [-180, 180]
  const normLon = ((lon + 540) % 360) - 180;
  for (const basin of BASINS) {
    const [minLat, minLon, maxLat, maxLon] = basin.bbox;
    if (lat >= minLat && lat <= maxLat && normLon >= minLon && normLon <= maxLon) {
      return basin.id;
    }
  }
  // Default to nearest large ocean by longitude
  if (normLon < -20) return "north_atlantic";
  if (normLon > 60 && normLon < 120) return "indian_ocean";
  return "north_pacific";
}

export function getBasin(id: string): Basin | undefined {
  return BASINS.find((b) => b.id === id);
}

/** Returns the set of chokepoints that lie between two basins (direct adjacency). */
export function chokepointsBetween(basinA: string, basinB: string): string[] {
  const a = getBasin(basinA);
  const b = getBasin(basinB);
  if (!a || !b) return [];
  return a.chokepoints.filter((cp) => b.chokepoints.includes(cp));
}
