import { z } from "zod";
import { Agent } from "../base";
import { searchRecentGDELT } from "../../sources/gdelt";
import { getMarineForecast } from "../../sources/openmeteo";
import { sampleAISDensity } from "../../sources/aisstream";
import { cache } from "../../cache";
import { getChokepoint } from "../../routing/chokepoints";
import { basinForLatLon } from "../../routing/basins";
import { warRiskZonesForBbox } from "../../routing/war-risk-zones";
import {
  seasonalHazardsForBbox,
  climatologicalWaveHeight,
} from "../../routing/seasonal-hazards";
import { getBunkerPrice, estimateLegFuelCostUsd } from "../../sources/bunker";

// ─── I/O schema ────────────────────────────────────────────────────────────

const Severity = z.enum(["none", "low", "medium", "high", "critical"]);

// LLM-facing schema — kept small so Mercury can produce reliable JSON.
const LegLLMOutput = z.object({
  news_severity: Severity,
  weather_severity: Severity,
  traffic_severity: Severity,
  risk_severity: Severity,
  summary: z.string().max(400),
});

// Public schema — LLM verdict + numeric metrics + ids attached in code.
export const LegAnalysisOutput = LegLLMOutput.extend({
  leg_id: z.string(),
  citations: z.array(z.string()),
  metrics: z.object({
    distance_nm: z.number(),
    estimated_days: z.number(),
    events_14d: z.number(),
    events_90d: z.number(),
    anomaly_ratio: z.number().nullable(),
    current_wave_height_m: z.number().nullable(),
    climatological_wave_height_m: z.number().nullable(),
    vessel_density: z.number().nullable(),
    slow_vessels: z.number().nullable(),
    war_risk_premium_pct: z.number(),
    fuel_cost_usd: z.number().nullable(),
  }),
});

export type LegAnalysisOutput = z.infer<typeof LegAnalysisOutput>;

// ─── Input ─────────────────────────────────────────────────────────────────

export interface LegAnalyzerInput {
  shipmentId?: string;
  leg: {
    leg_id: string;
    from: { locode: string; name: string; lat: number; lon: number };
    to: { locode: string; name: string; lat: number; lon: number };
    distance_nm: number;
    estimated_days: number;
    chokepoint_id: string | null;
    waypoints: Array<{ lat: number; lon: number }>;
    bbox: [number, number, number, number];
  };
}

// ─── System prompt ─────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a maritime route analyst. Given evidence about one leg of a sea route, classify four risk dimensions and write a one-sentence summary that an importer can act on.

DIMENSIONS:
- news_severity: from GDELT events on this leg/chokepoint (anomaly_ratio = events_14d / (events_90d/6.4); >2 is elevated)
- weather_severity: current wave height vs climatology; >2× climatological is high
- traffic_severity: vessel density + slow_vessels (anchored/queueing). High slow count = real congestion
- risk_severity: war/insurance zones, piracy, seasonal hazards (compound — pick the worst)

SEVERITY KEYS: none / low / medium / high / critical

Use only the data provided. Cite specific numbers in the summary. If a source returned nothing, set its severity to "none" — do not invent.

Return JSON only, no markdown, no trailing commentary. Keep summary on a single line, plain ASCII (no embedded quotes, newlines, or special chars). Schema:
{
  "news_severity": "none|low|medium|high|critical",
  "weather_severity": "none|low|medium|high|critical",
  "traffic_severity": "none|low|medium|high|critical",
  "risk_severity": "none|low|medium|high|critical",
  "summary": "single-line sentence under 300 chars citing real numbers"
}`;

// ─── Helpers ───────────────────────────────────────────────────────────────

function aggregateSeverity(
  zones: Array<{ severity: string }>,
  hazards: Array<{ severity: string }>
): "none" | "low" | "medium" | "high" | "critical" {
  const order = ["none", "low", "medium", "high", "critical"] as const;
  let worst: (typeof order)[number] = "none";
  for (const z of [...zones, ...hazards]) {
    const s = z.severity as (typeof order)[number];
    if (order.indexOf(s) > order.indexOf(worst)) worst = s;
  }
  return worst;
}

// ─── Agent ─────────────────────────────────────────────────────────────────

export class LegAnalyzerAgent extends Agent {
  readonly name = "leg-analyzer";
  readonly tier = "mercury" as const;

  async process(input: unknown): Promise<LegAnalysisOutput> {
    const { leg, shipmentId } = input as LegAnalyzerInput;

    const cacheKey = `leg-analyzer:v1:${leg.leg_id}`;
    const cached = await cache.get<LegAnalysisOutput>(cacheKey);
    if (cached) {
      await this.publishSignal({
        shipmentId,
        signalType: "leg_analysis",
        severity: this.mapSeverity(cached.risk_severity),
        payload: cached as unknown as Record<string, unknown>,
        confidence: 0.85,
      });
      return cached;
    }

    // ── Build GDELT query for the leg ──
    const chokepoint = leg.chokepoint_id ? getChokepoint(leg.chokepoint_id) : null;
    const gdeltQuery = chokepoint
      ? chokepoint.gdelt_query
      : `"${leg.from.name}" OR "${leg.to.name}" shipping (strike OR closure OR disruption OR delay)`;

    // ── Fire all parallel data fetches ──
    const midpoint =
      leg.waypoints[Math.floor(leg.waypoints.length / 2)] ??
      { lat: (leg.from.lat + leg.to.lat) / 2, lon: (leg.from.lon + leg.to.lon) / 2 };

    // Skip AIS sampling for antimeridian-spanning legs (encoded as minLon > maxLon
     // by legBbox; AISStream requires min < max).
    const wrapsAntimeridian = leg.bbox[1] > leg.bbox[3];
    const aisPromise = wrapsAntimeridian
      ? Promise.resolve({ unique_vessels: 0, reports: 0, avg_sog: 0, slow_vessels: 0 })
      : sampleAISDensity(
          {
            minLat: leg.bbox[0],
            minLon: leg.bbox[1],
            maxLat: leg.bbox[2],
            maxLon: leg.bbox[3],
          },
          6_000
        );

    const [g14, g90, weather, ais, bunker] = await Promise.allSettled([
      searchRecentGDELT(gdeltQuery, 14, 6),
      searchRecentGDELT(gdeltQuery, 90, 30),
      getMarineForecast(midpoint.lat, midpoint.lon),
      aisPromise,
      getBunkerPrice(),
    ]);

    // ── Extract numeric metrics ──
    const events_14d = g14.status === "fulfilled" ? g14.value.articles.length : 0;
    const events_90d = g90.status === "fulfilled" ? g90.value.articles.length : 0;
    // 90-day baseline normalised to a 14-day equivalent (90/14 ≈ 6.43)
    const baseline_14d = events_90d / (90 / 14);
    const anomaly_ratio =
      baseline_14d > 0 ? +(events_14d / baseline_14d).toFixed(2) : null;

    const currentWave =
      weather.status === "fulfilled"
        ? weather.value.current?.wave_height ??
          weather.value.hourly.wave_height?.[0] ??
          null
        : null;
    const basin = basinForLatLon(midpoint.lat, midpoint.lon);
    const climWave = climatologicalWaveHeight(basin);

    const density = ais.status === "fulfilled" ? ais.value.unique_vessels : null;
    const slow = ais.status === "fulfilled" ? ais.value.slow_vessels : null;

    const warZones = warRiskZonesForBbox(leg.bbox);
    const hazards = seasonalHazardsForBbox(leg.bbox);
    const warPremiumPct = warZones.reduce(
      (sum, z) => sum + z.premium_adder_pct,
      0
    );

    const fuelPrice =
      bunker.status === "fulfilled" ? bunker.value.vlsfo_usd_per_mt : 615;
    const fuelCost = estimateLegFuelCostUsd(leg.distance_nm, fuelPrice);

    // ── Compose evidence block for Mercury ──
    const topArticles =
      g14.status === "fulfilled"
        ? g14.value.articles
            .slice(0, 4)
            .map((a) => `  - [${a.seendate.slice(0, 8)}] ${a.title}`)
            .join("\n")
        : "  (none)";

    const evidence = [
      `LEG: ${leg.from.name} → ${leg.to.name}`,
      `  distance: ${leg.distance_nm}nm  estimated_days: ${leg.estimated_days}`,
      `  chokepoint: ${leg.chokepoint_id ?? "(open water)"}`,
      `  basin (midpoint): ${basin}`,
      ``,
      `GDELT 14d events: ${events_14d}`,
      `GDELT 90d events: ${events_90d}  →  14d baseline ${baseline_14d.toFixed(1)}  →  anomaly_ratio ${anomaly_ratio ?? "N/A"}`,
      `Top 14d headlines:`,
      topArticles,
      ``,
      `Open-Meteo current wave height: ${currentWave ?? "N/A"} m`,
      `Climatological wave height (${basin}, this month): ${climWave ?? "N/A"} m`,
      ``,
      `AIS sample (6s window, bbox): unique_vessels=${density ?? "N/A"}, slow_vessels=${slow ?? "N/A"}`,
      ``,
      `WAR-RISK ZONES intersecting this leg:`,
      warZones.length === 0
        ? "  (none)"
        : warZones.map((z) => `  - ${z.name} [${z.severity}] +${z.premium_adder_pct}% premium — ${z.reason}`).join("\n"),
      ``,
      `SEASONAL HAZARDS active right now on this leg:`,
      hazards.length === 0
        ? "  (none)"
        : hazards.map((h) => `  - ${h.name} [${h.severity}] — ${h.description}`).join("\n"),
      ``,
      `Bunker fuel (VLSFO): $${fuelPrice}/MT  →  est leg fuel cost ${fuelCost ? "$" + fuelCost.toLocaleString() : "N/A"}`,
    ].join("\n");

    // ── Pre-compute risk_severity from registries — Mercury can override ──
    const computedRiskSev = aggregateSeverity(warZones, hazards);

    let llmVerdict: z.infer<typeof LegLLMOutput>;
    try {
      llmVerdict = await this.callLLMValidated(
        [
          { role: "system", content: SYSTEM_PROMPT },
          {
            role: "user",
            content:
              `leg_id: ${leg.leg_id}\n\n${evidence}\n\n` +
              `Pre-computed risk severity from war/seasonal registries: ${computedRiskSev}\n\n` +
              `Return JSON with severity classifications and a one-sentence summary.`,
          },
        ],
        LegLLMOutput,
        { maxTokens: 400 }
      );
    } catch (err: any) {
      // Mercury returned malformed JSON — fall back to a deterministic verdict derived
      // from the static evidence we already have.
      console.warn(`[leg-analyzer] LLM JSON parse failed for ${leg.leg_id}, using fallback verdict: ${err.message}`);
      llmVerdict = {
        news_severity: anomaly_ratio !== null && anomaly_ratio > 2 ? "medium" : events_14d > 0 ? "low" : "none",
        weather_severity:
          currentWave != null && climWave != null && currentWave > climWave * 1.5
            ? "medium"
            : currentWave != null && currentWave > 3
              ? "low"
              : "none",
        traffic_severity:
          slow != null && slow >= 3 ? "medium" : density != null && density > 30 ? "low" : "none",
        risk_severity: computedRiskSev,
        summary:
          `${leg.from.name} → ${leg.to.name}: ${leg.distance_nm}nm, ${leg.estimated_days}d; ` +
          `news 14d=${events_14d}/90d=${events_90d}; wave ${currentWave ?? "n/a"}m vs ${climWave ?? "n/a"}m clim; ` +
          `traffic ${density ?? "n/a"} vessels (${slow ?? 0} slow); war-risk ${warPremiumPct}% premium.`,
      };
    }

    const result: LegAnalysisOutput = {
      ...llmVerdict,
      leg_id: leg.leg_id,
      citations: ["GDELT 14d/90d", "Open-Meteo Marine", "AISStream", "JWLA", "Climatology"],
      metrics: {
        distance_nm: leg.distance_nm,
        estimated_days: leg.estimated_days,
        events_14d,
        events_90d,
        anomaly_ratio,
        current_wave_height_m: currentWave,
        climatological_wave_height_m: climWave,
        vessel_density: density,
        slow_vessels: slow,
        war_risk_premium_pct: warPremiumPct,
        fuel_cost_usd: fuelCost,
      },
    };

    await cache.set(cacheKey, result as unknown as object, 60 * 60); // 1h

    await this.publishSignal({
      shipmentId,
      signalType: "leg_analysis",
      severity: this.mapSeverity(result.risk_severity),
      payload: result as unknown as Record<string, unknown>,
      confidence: 0.8,
    });

    return result;
  }

  private mapSeverity(
    s: string
  ): "info" | "low" | "medium" | "high" | "critical" {
    switch (s) {
      case "none": return "info";
      case "low": return "low";
      case "medium": return "medium";
      case "high": return "high";
      case "critical": return "critical";
      default: return "info";
    }
  }
}
