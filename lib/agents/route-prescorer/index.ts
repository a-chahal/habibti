import { z } from "zod";
import { Agent } from "../base";
import { subscribeAIS, type BoundingBox } from "../../sources/aisstream";
import { getMarineForecast } from "../../sources/openmeteo";
import { searchRecentGDELT } from "../../sources/gdelt";
import { cache } from "../../cache";

// Lane lookup: origin_country:destination_port → route info
interface LaneDef {
  lane_name: string;
  typical_transit_days: number;
  chokepoints: string[];
  bbox: BoundingBox;
  waypoints: Array<{ lat: number; lon: number; name: string }>;
}

const LANES: Record<string, LaneDef> = {
  // China
  "CN:USLAX": {
    lane_name: "Trans-Pacific (China → Los Angeles)",
    typical_transit_days: 14,
    chokepoints: [],
    bbox: { minLat: 20, minLon: 140, maxLat: 40, maxLon: 170 },
    waypoints: [
      { lat: 35, lon: 160, name: "North Pacific" },
      { lat: 33, lon: -118, name: "Los Angeles Approaches" },
    ],
  },
  "CN:USLGB": {
    lane_name: "Trans-Pacific (China → Long Beach)",
    typical_transit_days: 14,
    chokepoints: [],
    bbox: { minLat: 20, minLon: 140, maxLat: 40, maxLon: 170 },
    waypoints: [
      { lat: 35, lon: 160, name: "North Pacific" },
      { lat: 33.7, lon: -118.2, name: "Long Beach Approaches" },
    ],
  },
  "CN:USNYC": {
    lane_name: "Trans-Pacific + Panama Canal (China → New York)",
    typical_transit_days: 20,
    chokepoints: ["Panama Canal"],
    bbox: { minLat: 8, minLon: -80.5, maxLat: 10, maxLon: -79.5 },
    waypoints: [
      { lat: 35, lon: 160, name: "North Pacific" },
      { lat: 9, lon: -79.9, name: "Panama Canal" },
      { lat: 40.7, lon: -74, name: "New York Harbor" },
    ],
  },
  "CN:USHOU": {
    lane_name: "Trans-Pacific + Panama Canal (China → Houston)",
    typical_transit_days: 19,
    chokepoints: ["Panama Canal"],
    bbox: { minLat: 8, minLon: -80.5, maxLat: 10, maxLon: -79.5 },
    waypoints: [
      { lat: 35, lon: 160, name: "North Pacific" },
      { lat: 9, lon: -79.9, name: "Panama Canal" },
      { lat: 29.7, lon: -94.9, name: "Houston Ship Channel" },
    ],
  },
  "CN:USSAV": {
    lane_name: "Trans-Pacific + Panama Canal (China → Savannah)",
    typical_transit_days: 21,
    chokepoints: ["Panama Canal"],
    bbox: { minLat: 8, minLon: -80.5, maxLat: 10, maxLon: -79.5 },
    waypoints: [
      { lat: 35, lon: 160, name: "North Pacific" },
      { lat: 9, lon: -79.9, name: "Panama Canal" },
      { lat: 32.1, lon: -81, name: "Savannah Approaches" },
    ],
  },

  // Vietnam
  "VN:USLAX": {
    lane_name: "Trans-Pacific (Vietnam → Los Angeles)",
    typical_transit_days: 16,
    chokepoints: ["Malacca Strait"],
    bbox: { minLat: 1, minLon: 103, maxLat: 6, maxLon: 110 },
    waypoints: [
      { lat: 1.5, lon: 104, name: "Malacca Strait" },
      { lat: 35, lon: 160, name: "North Pacific" },
    ],
  },
  "VN:USNYC": {
    lane_name: "Suez Route (Vietnam → New York)",
    typical_transit_days: 28,
    chokepoints: ["Malacca Strait", "Bab-el-Mandeb", "Suez Canal"],
    bbox: { minLat: 12, minLon: 43, maxLat: 15, maxLon: 46 },
    waypoints: [
      { lat: 1.5, lon: 104, name: "Malacca Strait" },
      { lat: 12.5, lon: 43.5, name: "Bab-el-Mandeb" },
      { lat: 30, lon: 32.5, name: "Suez Canal" },
      { lat: 40.7, lon: -74, name: "New York Harbor" },
    ],
  },
  "VN:USHOU": {
    lane_name: "Trans-Pacific + Panama Canal (Vietnam → Houston)",
    typical_transit_days: 25,
    chokepoints: ["Malacca Strait", "Panama Canal"],
    bbox: { minLat: 8, minLon: -80.5, maxLat: 10, maxLon: -79.5 },
    waypoints: [
      { lat: 1.5, lon: 104, name: "Malacca Strait" },
      { lat: 35, lon: 160, name: "North Pacific" },
      { lat: 9, lon: -79.9, name: "Panama Canal" },
      { lat: 29.7, lon: -94.9, name: "Houston Ship Channel" },
    ],
  },
  "VN:USSAV": {
    lane_name: "Trans-Pacific + Panama Canal (Vietnam → Savannah)",
    typical_transit_days: 26,
    chokepoints: ["Malacca Strait", "Panama Canal"],
    bbox: { minLat: 8, minLon: -80.5, maxLat: 10, maxLon: -79.5 },
    waypoints: [
      { lat: 1.5, lon: 104, name: "Malacca Strait" },
      { lat: 35, lon: 160, name: "North Pacific" },
      { lat: 9, lon: -79.9, name: "Panama Canal" },
      { lat: 32.1, lon: -81, name: "Savannah Approaches" },
    ],
  },

  // India
  "IN:USLAX": {
    lane_name: "Suez Route (India → Los Angeles)",
    typical_transit_days: 28,
    chokepoints: ["Suez Canal", "Bab-el-Mandeb"],
    bbox: { minLat: 12, minLon: 43, maxLat: 15, maxLon: 46 },
    waypoints: [
      { lat: 12.5, lon: 43.5, name: "Bab-el-Mandeb" },
      { lat: 30, lon: 32.5, name: "Suez Canal" },
    ],
  },
  "IN:USNYC": {
    lane_name: "Suez Route (India → New York)",
    typical_transit_days: 24,
    chokepoints: ["Bab-el-Mandeb", "Suez Canal"],
    bbox: { minLat: 12, minLon: 43, maxLat: 15, maxLon: 46 },
    waypoints: [
      { lat: 12.5, lon: 43.5, name: "Bab-el-Mandeb" },
      { lat: 30, lon: 32.5, name: "Suez Canal" },
      { lat: 40.7, lon: -74, name: "New York Harbor" },
    ],
  },
  "IN:USHOU": {
    lane_name: "Suez Route (India → Houston)",
    typical_transit_days: 26,
    chokepoints: ["Bab-el-Mandeb", "Suez Canal"],
    bbox: { minLat: 12, minLon: 43, maxLat: 15, maxLon: 46 },
    waypoints: [
      { lat: 12.5, lon: 43.5, name: "Bab-el-Mandeb" },
      { lat: 30, lon: 32.5, name: "Suez Canal" },
      { lat: 29.7, lon: -94.9, name: "Houston Ship Channel" },
    ],
  },

  // Indonesia
  "ID:USLAX": {
    lane_name: "Trans-Pacific (Indonesia → Los Angeles)",
    typical_transit_days: 18,
    chokepoints: ["Malacca Strait"],
    bbox: { minLat: 1, minLon: 103, maxLat: 6, maxLon: 110 },
    waypoints: [
      { lat: 1.5, lon: 104, name: "Malacca Strait" },
      { lat: 35, lon: 160, name: "North Pacific" },
    ],
  },
  "ID:USNYC": {
    lane_name: "Suez Route (Indonesia → New York)",
    typical_transit_days: 26,
    chokepoints: ["Malacca Strait", "Bab-el-Mandeb", "Suez Canal"],
    bbox: { minLat: 12, minLon: 43, maxLat: 15, maxLon: 46 },
    waypoints: [
      { lat: 1.5, lon: 104, name: "Malacca Strait" },
      { lat: 12.5, lon: 43.5, name: "Bab-el-Mandeb" },
      { lat: 30, lon: 32.5, name: "Suez Canal" },
      { lat: 40.7, lon: -74, name: "New York Harbor" },
    ],
  },

  // Bangladesh
  "BD:USLAX": {
    lane_name: "Suez Route (Bangladesh → Los Angeles)",
    typical_transit_days: 30,
    chokepoints: ["Malacca Strait", "Suez Canal", "Bab-el-Mandeb"],
    bbox: { minLat: 12, minLon: 43, maxLat: 15, maxLon: 46 },
    waypoints: [
      { lat: 1.5, lon: 104, name: "Malacca Strait" },
      { lat: 12.5, lon: 43.5, name: "Bab-el-Mandeb" },
    ],
  },
  "BD:USNYC": {
    lane_name: "Suez Route (Bangladesh → New York)",
    typical_transit_days: 28,
    chokepoints: ["Malacca Strait", "Bab-el-Mandeb", "Suez Canal"],
    bbox: { minLat: 12, minLon: 43, maxLat: 15, maxLon: 46 },
    waypoints: [
      { lat: 1.5, lon: 104, name: "Malacca Strait" },
      { lat: 12.5, lon: 43.5, name: "Bab-el-Mandeb" },
      { lat: 30, lon: 32.5, name: "Suez Canal" },
      { lat: 40.7, lon: -74, name: "New York Harbor" },
    ],
  },

  // Mexico
  "MX:USLAX": {
    lane_name: "Short Sea (Mexico → Los Angeles)",
    typical_transit_days: 3,
    chokepoints: [],
    bbox: { minLat: 20, minLon: -120, maxLat: 35, maxLon: -105 },
    waypoints: [{ lat: 23, lon: -109, name: "Baja California" }],
  },
  "MX:USHOU": {
    lane_name: "Gulf (Mexico → Houston)",
    typical_transit_days: 2,
    chokepoints: [],
    bbox: { minLat: 20, minLon: -98, maxLat: 30, maxLon: -87 },
    waypoints: [{ lat: 25, lon: -93, name: "Gulf of Mexico" }],
  },
  "MX:USNYC": {
    lane_name: "Atlantic Coast (Mexico → New York)",
    typical_transit_days: 8,
    chokepoints: [],
    bbox: { minLat: 20, minLon: -90, maxLat: 35, maxLon: -75 },
    waypoints: [
      { lat: 25, lon: -85, name: "Florida Straits" },
      { lat: 40.7, lon: -74, name: "New York Harbor" },
    ],
  },

  // Turkey
  "TR:USLAX": {
    lane_name: "Suez Route (Turkey → Los Angeles)",
    typical_transit_days: 22,
    chokepoints: ["Suez Canal", "Bab-el-Mandeb"],
    bbox: { minLat: 12, minLon: 43, maxLat: 15, maxLon: 46 },
    waypoints: [
      { lat: 30, lon: 32.5, name: "Suez Canal" },
      { lat: 12.5, lon: 43.5, name: "Bab-el-Mandeb" },
    ],
  },
  "TR:USNYC": {
    lane_name: "Mediterranean + Atlantic (Turkey → New York)",
    typical_transit_days: 14,
    chokepoints: [],
    bbox: { minLat: 36, minLon: -10, maxLat: 44, maxLon: 5 },
    waypoints: [
      { lat: 38, lon: -9, name: "Strait of Gibraltar" },
      { lat: 40.7, lon: -74, name: "New York Harbor" },
    ],
  },

  // Germany
  "DE:USNYC": {
    lane_name: "North Atlantic (Germany → New York)",
    typical_transit_days: 14,
    chokepoints: [],
    bbox: { minLat: 40, minLon: -50, maxLat: 55, maxLon: -10 },
    waypoints: [
      { lat: 52, lon: -20, name: "North Atlantic" },
      { lat: 40.7, lon: -74, name: "New York Harbor" },
    ],
  },
  "DE:USLAX": {
    lane_name: "North Atlantic + Panama Canal (Germany → Los Angeles)",
    typical_transit_days: 28,
    chokepoints: ["Panama Canal"],
    bbox: { minLat: 8, minLon: -80.5, maxLat: 10, maxLon: -79.5 },
    waypoints: [
      { lat: 52, lon: -20, name: "North Atlantic" },
      { lat: 9, lon: -79.9, name: "Panama Canal" },
    ],
  },

  // South Korea
  "KR:USLAX": {
    lane_name: "Trans-Pacific (South Korea → Los Angeles)",
    typical_transit_days: 14,
    chokepoints: [],
    bbox: { minLat: 25, minLon: 140, maxLat: 40, maxLon: 165 },
    waypoints: [
      { lat: 38, lon: 155, name: "North Pacific" },
      { lat: 33, lon: -118, name: "Los Angeles Approaches" },
    ],
  },
  "KR:USNYC": {
    lane_name: "Trans-Pacific + Panama Canal (South Korea → New York)",
    typical_transit_days: 22,
    chokepoints: ["Panama Canal"],
    bbox: { minLat: 8, minLon: -80.5, maxLat: 10, maxLon: -79.5 },
    waypoints: [
      { lat: 38, lon: 155, name: "North Pacific" },
      { lat: 9, lon: -79.9, name: "Panama Canal" },
      { lat: 40.7, lon: -74, name: "New York Harbor" },
    ],
  },

  // Japan
  "JP:USLAX": {
    lane_name: "Trans-Pacific (Japan → Los Angeles)",
    typical_transit_days: 13,
    chokepoints: [],
    bbox: { minLat: 25, minLon: 140, maxLat: 40, maxLon: 165 },
    waypoints: [
      { lat: 38, lon: 155, name: "North Pacific" },
      { lat: 33, lon: -118, name: "Los Angeles Approaches" },
    ],
  },

  // Sri Lanka
  "LK:USLAX": {
    lane_name: "Suez Route (Sri Lanka → Los Angeles)",
    typical_transit_days: 22,
    chokepoints: ["Suez Canal", "Bab-el-Mandeb"],
    bbox: { minLat: 12, minLon: 43, maxLat: 15, maxLon: 46 },
    waypoints: [
      { lat: 12.5, lon: 43.5, name: "Bab-el-Mandeb" },
      { lat: 30, lon: 32.5, name: "Suez Canal" },
    ],
  },
};

const CHOKEPOINT_QUERIES: Record<string, string> = {
  "Suez Canal": '"Suez Canal" (blockage OR attack OR closure OR disruption OR Houthi)',
  "Bab-el-Mandeb": '"Bab-el-Mandeb" OR "Red Sea" (Houthi OR attack OR missile OR disruption)',
  "Malacca Strait": '"Malacca Strait" (piracy OR congestion OR closure OR incident)',
  "Panama Canal": '"Panama Canal" (drought OR delay OR closure OR congestion)',
  "Hormuz": '"Strait of Hormuz" (closure OR tension OR Iran OR disruption)',
};

const ChokepointRisk = z.object({
  name: z.string(),
  current_events: z.string(),
  severity: z.enum(["none", "low", "medium", "high", "critical"]),
});

const RouteOption = z.object({
  lane_name: z.string(),
  chokepoints: z.array(z.string()),
  typical_transit_days: z.number(),
  current_traffic_density: z.enum(["low", "medium", "high", "unknown"]),
  weather_outlook: z.string(),
  chokepoint_risks: z.array(ChokepointRisk),
});

export const RoutePrescoreOutput = z.object({
  origin_country: z.string(),
  destination_port: z.string(),
  routes: z.array(RouteOption),
  transit_buffer_days: z.number().nullable().optional(),
  citations: z.array(z.string()),
});

export type RoutePrescoreOutput = z.infer<typeof RoutePrescoreOutput>;

async function countVesselsInBBox(bbox: BoundingBox, sampleMs = 30_000): Promise<number> {
  const mmsis = new Set<number>();
  return new Promise<number>((resolve) => {
    let closed = false;
    let close: (() => void) | null = null;

    const timer = setTimeout(() => {
      if (!closed) {
        closed = true;
        close?.();
        resolve(mmsis.size);
      }
    }, sampleMs);

    try {
      close = subscribeAIS(
        bbox,
        [],
        (report) => {
          mmsis.add(report.mmsi);
        },
        () => {
          if (!closed) {
            closed = true;
            clearTimeout(timer);
            resolve(mmsis.size);
          }
        }
      );
    } catch {
      clearTimeout(timer);
      resolve(0);
    }
  });
}

function vesselCountToDensity(count: number): "low" | "medium" | "high" | "unknown" {
  if (count === 0) return "unknown";
  if (count < 3) return "low";
  if (count < 10) return "medium";
  return "high";
}

export class RoutePrescorer extends Agent {
  readonly name = "route-prescorer";
  readonly tier = "mercury" as const;

  async process(input: unknown): Promise<RoutePrescoreOutput> {
    const { origin_country, destination_port, deadline_date, shipmentId } = input as {
      origin_country: string;
      destination_port: string;
      deadline_date?: string | null;
      shipmentId?: string;
    };

    const cacheKey = `route-prescore:${origin_country}:${destination_port}`;
    const cached = await cache.get<RoutePrescoreOutput>(cacheKey);
    if (cached) {
      const transitBuffer = this.computeBuffer(cached, deadline_date);
      await this.publishSignal({
        shipmentId,
        signalType: "route_prescore",
        severity: transitBuffer !== null && transitBuffer < 5 ? "high" : "info",
        payload: { ...cached, transit_buffer_days: transitBuffer } as unknown as Record<string, unknown>,
        confidence: 0.75,
      });
      return { ...cached, transit_buffer_days: transitBuffer };
    }

    const laneKey = `${origin_country.toUpperCase()}:${destination_port.toUpperCase()}`;
    const lane =
      LANES[laneKey] ??
      Object.entries(LANES).find(([k]) => k.startsWith(origin_country.toUpperCase()))?.[1] ??
      LANES["CN:USLAX"];

    // AIS vessel count in lane bbox (30s sample)
    let vesselCount = 0;
    try {
      vesselCount = await countVesselsInBBox(lane.bbox);
    } catch {
      // non-fatal
    }

    // Marine weather for ALL waypoints
    const weatherResults: Array<{ name: string; avgWave: number }> = [];
    for (const wp of lane.waypoints) {
      try {
        const forecast = await getMarineForecast(wp.lat, wp.lon, ["wave_height", "wind_wave_height"]);
        const waves = (forecast.hourly.wave_height ?? []).slice(0, 24);
        const avgWave = waves.length > 0 ? waves.reduce((s, v) => s + v, 0) / waves.length : 0;
        weatherResults.push({ name: wp.name, avgWave: +avgWave.toFixed(1) });
      } catch {
        // non-fatal
      }
    }

    const maxAvgWave = weatherResults.length > 0 ? Math.max(...weatherResults.map(r => r.avgWave)) : 0;
    const worstWaypoint = weatherResults.find(r => r.avgWave === maxAvgWave)?.name ?? "unknown";
    const weatherSummary = weatherResults.length === 0
      ? "Forecast unavailable"
      : maxAvgWave < 1.5
      ? `Calm conditions across ${weatherResults.length} waypoints (max avg wave ${maxAvgWave}m near ${worstWaypoint})`
      : maxAvgWave < 3
      ? `Moderate swell on ${weatherResults.length} waypoints (max avg ${maxAvgWave}m near ${worstWaypoint})`
      : `Rough seas on ${weatherResults.length} waypoints (max avg ${maxAvgWave}m near ${worstWaypoint})`;

    // GDELT chokepoint events
    const chokepointContext: string[] = [];
    for (const cp of lane.chokepoints) {
      const query = CHOKEPOINT_QUERIES[cp];
      if (!query) continue;
      try {
        const gdelt = await searchRecentGDELT(query, 14, 5);
        if (gdelt.articles.length > 0) {
          chokepointContext.push(
            `${cp}: ${gdelt.articles.slice(0, 3).map((a) => a.title).join(" | ")}`
          );
        } else {
          chokepointContext.push(`${cp}: no recent disruption events`);
        }
      } catch {
        chokepointContext.push(`${cp}: unable to fetch news`);
      }
    }

    const transitBuffer = this.computeBuffer({ routes: [{ typical_transit_days: lane.typical_transit_days } as any] } as any, deadline_date);
    const bufferNote = transitBuffer !== null
      ? `\nDeadline transit buffer: ${transitBuffer} days (deadline - typical transit). ${transitBuffer < 5 ? "⚠ BUFFER TIGHT — flag in assessment." : ""}`
      : "";

    const systemPrompt = `You are a maritime route analyst. Assess shipping route risk for cargo from ${origin_country} to ${destination_port}.

Return JSON:
{
  "origin_country": "${origin_country}",
  "destination_port": "${destination_port}",
  "routes": [{
    "lane_name": string,
    "chokepoints": string[],
    "typical_transit_days": number,
    "current_traffic_density": "low"|"medium"|"high"|"unknown",
    "weather_outlook": string,
    "chokepoint_risks": [{ "name": string, "current_events": string, "severity": "none"|"low"|"medium"|"high"|"critical" }]
  }],
  "transit_buffer_days": number|null,
  "citations": string[]
}${bufferNote}`;

    const userMsg = `Lane: ${lane.lane_name}
Transit: ${lane.typical_transit_days} days
Chokepoints: ${lane.chokepoints.join(", ") || "none"}
AIS vessels sampled in lane (30s window): ${vesselCount}
Weather across ${weatherResults.length} waypoints: ${weatherSummary}
Weather detail: ${weatherResults.map(r => `${r.name}=${r.avgWave}m avg`).join(", ") || "no data"}
Chokepoint news:
${chokepointContext.join("\n") || "No chokepoints on this route"}

Set transit_buffer_days to ${transitBuffer !== null ? String(transitBuffer) : "null"}.
Return route assessment. Current traffic density: 0=unknown, 1-2=low, 3-9=medium, 10+=high.`;

    const result = await this.callLLMValidated(
      [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMsg },
      ],
      RoutePrescoreOutput
    );

    const finalResult = { ...result, transit_buffer_days: transitBuffer };
    await cache.set(cacheKey, finalResult as unknown as object, 2 * 60 * 60);

    const severity = transitBuffer !== null && transitBuffer < 5 ? "high" : "info";
    await this.publishSignal({
      shipmentId,
      signalType: "route_prescore",
      severity: severity as "info" | "high",
      payload: finalResult as unknown as Record<string, unknown>,
      confidence: 0.78,
    });

    return finalResult;
  }

  private computeBuffer(output: RoutePrescoreOutput, deadlineDate?: string | null): number | null {
    if (!deadlineDate) return null;
    const transitDays = output.routes?.[0]?.typical_transit_days;
    if (transitDays == null) return null;
    const daysToDeadline = Math.round((new Date(deadlineDate).getTime() - Date.now()) / 86_400_000);
    return daysToDeadline - transitDays;
  }
}
