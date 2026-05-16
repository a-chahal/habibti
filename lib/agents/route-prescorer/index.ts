import { z } from "zod";
import { Agent } from "../base";
import { subscribeAIS, type BoundingBox } from "../../sources/aisstream";
import { getMarineForecast } from "../../sources/openmeteo";
import { searchRecentGDELT } from "../../sources/gdelt";
import { cache } from "../../cache";

// Lane lookup: origin_country → destination_port prefix → route info
interface LaneDef {
  lane_name: string;
  typical_transit_days: number;
  chokepoints: string[];
  bbox: BoundingBox; // bounding box for AIS vessel sampling
  waypoints: Array<{ lat: number; lon: number; name: string }>;
}

const LANES: Record<string, LaneDef> = {
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
  "MX:USLAX": {
    lane_name: "Short Sea (Mexico → Los Angeles)",
    typical_transit_days: 3,
    chokepoints: [],
    bbox: { minLat: 20, minLon: -120, maxLat: 35, maxLon: -105 },
    waypoints: [{ lat: 23, lon: -109, name: "Baja California" }],
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
  citations: z.array(z.string()),
});

export type RoutePrescoreOutput = z.infer<typeof RoutePrescoreOutput>;

async function countVesselsInBBox(bbox: BoundingBox, sampleMs = 8_000): Promise<number> {
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
          // on error just resolve with what we have
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
    const { origin_country, destination_port, shipmentId } = input as {
      origin_country: string;
      destination_port: string;
      shipmentId?: string;
    };

    const cacheKey = `route-prescore:${origin_country}:${destination_port}`;
    const cached = await cache.get<RoutePrescoreOutput>(cacheKey);
    if (cached) {
      await this.publishSignal({
        shipmentId,
        signalType: "route_prescore",
        severity: "info",
        payload: cached as unknown as Record<string, unknown>,
        confidence: 0.75,
      });
      return cached;
    }

    const laneKey = `${origin_country.toUpperCase()}:${destination_port.toUpperCase()}`;
    // Find closest matching lane
    const lane =
      LANES[laneKey] ??
      Object.entries(LANES).find(([k]) => k.startsWith(origin_country.toUpperCase()))?.[1] ??
      LANES["CN:USLAX"]; // fallback to trans-Pacific

    // AIS vessel count in lane bbox
    let vesselCount = 0;
    try {
      vesselCount = await countVesselsInBBox(lane.bbox);
    } catch {
      // non-fatal
    }

    // Marine weather for primary waypoint
    let weatherSummary = "Data unavailable";
    if (lane.waypoints.length > 0) {
      try {
        const wp = lane.waypoints[0];
        const forecast = await getMarineForecast(wp.lat, wp.lon, ["wave_height", "wind_wave_height"]);
        const avgWave =
          (forecast.hourly.wave_height ?? [])
            .slice(0, 24)
            .reduce((s, v) => s + v, 0) /
            Math.max(1, (forecast.hourly.wave_height ?? []).slice(0, 24).length) || 0;
        weatherSummary = avgWave < 1.5
          ? `Calm (avg wave ${avgWave.toFixed(1)}m near ${wp.name})`
          : avgWave < 3
          ? `Moderate swell (avg ${avgWave.toFixed(1)}m near ${wp.name})`
          : `Rough seas (avg ${avgWave.toFixed(1)}m near ${wp.name})`;
      } catch {
        // non-fatal
      }
    }

    // GDELT chokepoint events
    const chokepointContext: string[] = [];
    for (const cp of lane.chokepoints) {
      const query = CHOKEPOINT_QUERIES[cp];
      if (!query) continue;
      try {
        const gdelt = await searchRecentGDELT(query, 14, 5);
        if (gdelt.articles.length > 0) {
          chokepointContext.push(
            `${cp}: ${gdelt.articles
              .slice(0, 3)
              .map((a) => a.title)
              .join(" | ")}`
          );
        } else {
          chokepointContext.push(`${cp}: no recent disruption events`);
        }
      } catch {
        chokepointContext.push(`${cp}: unable to fetch news`);
      }
    }

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
  "citations": string[]
}`;

    const userMsg = `Lane: ${lane.lane_name}
Transit: ${lane.typical_transit_days} days
Chokepoints: ${lane.chokepoints.join(", ") || "none"}
AIS vessels sampled in lane (8s window): ${vesselCount}
Weather: ${weatherSummary}
Chokepoint news:
${chokepointContext.join("\n") || "No chokepoints on this route"}

Return route assessment. Current traffic density should be based on vessel count (0=unknown, 1-2=low, 3-9=medium, 10+=high).`;

    const result = await this.callLLMValidated(
      [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMsg },
      ],
      RoutePrescoreOutput
    );

    await cache.set(cacheKey, result as unknown as object, 2 * 60 * 60); // 2h

    await this.publishSignal({
      shipmentId,
      signalType: "route_prescore",
      severity: "info",
      payload: result as unknown as Record<string, unknown>,
      confidence: 0.78,
    });

    return result;
  }
}
