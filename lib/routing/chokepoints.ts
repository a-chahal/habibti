export interface Chokepoint {
  id: string;
  name: string;
  lat: number;
  lon: number;
  // bounding box for AIS/GDELT queries [minLat, minLon, maxLat, maxLon]
  bbox: [number, number, number, number];
  // which basins this gate connects
  connects: [string, string];
  toll_usd_per_teu: number;
  // passage = no toll, just rounding (Cape of Good Hope, Cape Horn)
  is_passage: boolean;
  seasonal: boolean;
  gdelt_query: string;
}

export const CHOKEPOINTS: Record<string, Chokepoint> = {
  suez: {
    id: "suez",
    name: "Suez Canal",
    lat: 30.5, lon: 32.35,
    bbox: [29.5, 31.5, 31.5, 33.5],
    connects: ["mediterranean", "indian_ocean"],
    toll_usd_per_teu: 450,
    is_passage: false,
    seasonal: false,
    gdelt_query: '"Suez Canal" OR "Suez" shipping transit',
  },
  bab_el_mandeb: {
    id: "bab_el_mandeb",
    name: "Bab-el-Mandeb",
    lat: 12.58, lon: 43.37,
    bbox: [11.5, 42.5, 13.5, 44.5],
    // Strait between Red Sea and Gulf of Aden — both feed Indian Ocean; you must
    // still pass through Suez to reach the Mediterranean.
    connects: ["indian_ocean", "indian_ocean"],
    toll_usd_per_teu: 0,
    is_passage: false,
    seasonal: false,
    gdelt_query: '"Bab-el-Mandeb" OR "Red Sea" shipping attack Houthi',
  },
  panama: {
    id: "panama",
    name: "Panama Canal",
    lat: 9.08, lon: -79.68,
    bbox: [7.5, -81.0, 11.0, -77.5],
    connects: ["north_pacific", "caribbean"],
    toll_usd_per_teu: 380,
    is_passage: false,
    seasonal: true,
    gdelt_query: '"Panama Canal" shipping transit drought',
  },
  malacca: {
    id: "malacca",
    name: "Strait of Malacca",
    lat: 2.5, lon: 101.5,
    bbox: [1.0, 99.0, 6.0, 104.5],
    connects: ["indian_ocean", "south_china_sea"],
    toll_usd_per_teu: 0,
    is_passage: false,
    seasonal: false,
    gdelt_query: '"Strait of Malacca" OR "Malacca Strait" piracy shipping',
  },
  hormuz: {
    id: "hormuz",
    name: "Strait of Hormuz",
    lat: 26.57, lon: 56.25,
    bbox: [25.0, 54.5, 28.5, 58.5],
    connects: ["arabian_sea", "persian_gulf"],
    toll_usd_per_teu: 0,
    is_passage: false,
    seasonal: false,
    gdelt_query: '"Strait of Hormuz" OR "Hormuz" Iran tanker shipping',
  },
  gibraltar: {
    id: "gibraltar",
    name: "Strait of Gibraltar",
    lat: 35.99, lon: -5.61,
    bbox: [35.5, -6.5, 36.5, -4.5],
    connects: ["mediterranean", "north_atlantic"],
    toll_usd_per_teu: 0,
    is_passage: false,
    seasonal: false,
    gdelt_query: '"Strait of Gibraltar" shipping traffic',
  },
  bosphorus: {
    id: "bosphorus",
    name: "Bosphorus Strait",
    lat: 41.12, lon: 29.07,
    bbox: [40.5, 28.5, 41.5, 29.5],
    connects: ["mediterranean", "black_sea"],
    toll_usd_per_teu: 35,
    is_passage: false,
    seasonal: false,
    gdelt_query: '"Bosphorus" OR "Turkish Straits" shipping transit',
  },
  cape_good_hope: {
    id: "cape_good_hope",
    name: "Cape of Good Hope",
    lat: -34.36, lon: 18.47,
    bbox: [-36.5, 16.0, -32.0, 21.0],
    connects: ["indian_ocean", "south_atlantic"],
    toll_usd_per_teu: 0,
    is_passage: true,
    seasonal: true,
    gdelt_query: '"Cape of Good Hope" shipping route',
  },
  cape_horn: {
    id: "cape_horn",
    name: "Cape Horn",
    lat: -55.98, lon: -67.27,
    bbox: [-58.0, -70.0, -54.0, -64.0],
    connects: ["south_pacific", "south_atlantic"],
    toll_usd_per_teu: 0,
    is_passage: true,
    seasonal: true,
    gdelt_query: '"Cape Horn" shipping weather storm',
  },
  kiel_canal: {
    id: "kiel_canal",
    name: "Kiel Canal",
    lat: 54.33, lon: 9.99,
    bbox: [53.8, 9.0, 54.7, 11.0],
    connects: ["north_atlantic", "baltic_sea"],
    toll_usd_per_teu: 90,
    is_passage: false,
    seasonal: false,
    gdelt_query: '"Kiel Canal" shipping transit',
  },
  sunda_strait: {
    id: "sunda_strait",
    name: "Sunda Strait",
    lat: -6.2, lon: 105.9,
    bbox: [-7.5, 104.5, -5.0, 107.5],
    connects: ["indian_ocean", "south_china_sea"],
    toll_usd_per_teu: 0,
    is_passage: false,
    seasonal: false,
    gdelt_query: '"Sunda Strait" shipping Indonesia',
  },
  torres_strait: {
    id: "torres_strait",
    name: "Torres Strait",
    lat: -10.35, lon: 142.2,
    bbox: [-11.5, 141.0, -9.0, 143.5],
    connects: ["indian_ocean", "south_pacific"],
    toll_usd_per_teu: 0,
    is_passage: false,
    seasonal: false,
    gdelt_query: '"Torres Strait" shipping navigation',
  },
  taiwan_strait: {
    id: "taiwan_strait",
    name: "Taiwan Strait",
    lat: 24.25, lon: 119.5,
    bbox: [22.0, 118.0, 26.5, 121.5],
    connects: ["south_china_sea", "east_china_sea"],
    toll_usd_per_teu: 0,
    is_passage: false,
    seasonal: false,
    gdelt_query: '"Taiwan Strait" shipping military tension China',
  },
};

export function getChokepoint(id: string): Chokepoint | undefined {
  return CHOKEPOINTS[id];
}

export function allChokepoints(): Chokepoint[] {
  return Object.values(CHOKEPOINTS);
}
