import { z } from "zod";
import { Agent } from "../base";
import { searchRecentGDELT } from "../../sources/gdelt";
import { cache } from "../../cache";

const RiskEvent = z.object({
  headline: z.string(),
  source_url: z.string(),
  original_language: z.string().nullable(),
  date: z.string(),
  category: z.string(),
  relevance_score: z.number(),
  severity: z.enum(["low", "medium", "high", "critical"]),
});

export const CountryRiskOutput = z.object({
  country_code: z.string(),
  stability: z.enum(["stable", "watch", "elevated", "unstable"]),
  event_count_by_category: z.record(z.string(), z.number()),
  top_events: z.array(RiskEvent),
  citations: z.array(z.string()),
});

export type CountryRiskOutput = z.infer<typeof CountryRiskOutput>;

// Country code → full name for GDELT query
const COUNTRY_NAMES: Record<string, string> = {
  CN: "China", VN: "Vietnam", IN: "India", ID: "Indonesia", BD: "Bangladesh",
  TR: "Turkey", PK: "Pakistan", MX: "Mexico", TH: "Thailand", KH: "Cambodia",
  MY: "Malaysia", LK: "Sri Lanka", ET: "Ethiopia", TW: "Taiwan", KR: "South Korea",
  JP: "Japan", DE: "Germany", BR: "Brazil", PE: "Peru", MG: "Madagascar",
};

export class CountryRiskAgent extends Agent {
  readonly name = "country-risk";
  readonly tier = "mercury" as const;

  async process(input: unknown): Promise<CountryRiskOutput> {
    const { country_code, lookback_days = 30, shipmentId } = input as {
      country_code: string;
      lookback_days?: number;
      shipmentId?: string;
    };

    const cacheKey = `country-risk:${country_code}:${lookback_days}`;
    const cached = await cache.get<CountryRiskOutput>(cacheKey);
    if (cached) {
      await this.publishSignal({
        shipmentId,
        signalType: "country_risk",
        severity: this.stabilityToSeverity(cached.stability),
        payload: cached as unknown as Record<string, unknown>,
        confidence: 0.8,
      });
      return cached;
    }

    const countryName = COUNTRY_NAMES[country_code.toUpperCase()] ?? country_code;

    // Query GDELT for trade-relevant events
    let articles: Awaited<ReturnType<typeof searchRecentGDELT>>["articles"] = [];
    try {
      const gdelt = await searchRecentGDELT(
        `"${countryName}" (port OR shipping OR trade OR strike OR tariff OR sanctions OR protest OR unrest OR military)`,
        lookback_days,
        30
      );
      articles = gdelt.articles;
    } catch {
      // GDELT may be rate-limited; proceed with empty articles
    }

    const articleContext = articles
      .slice(0, 20)
      .map(
        (a) =>
          `- [${a.seendate}] (${a.sourcelang}) ${a.title} — ${a.url}`
      )
      .join("\n");

    const systemPrompt = `You are a geopolitical risk analyst specializing in trade-route risk for US importers.

Analyze news articles about ${countryName} (${country_code}) over the past ${lookback_days} days and assess trade-route risk.

Focus ONLY on events that affect shipping, imports, manufacturing, or labor for US-bound goods:
- Port strikes, closures, congestion
- Military conflict or political instability affecting logistics
- Trade policy changes (tariffs, sanctions, bans)
- Major natural disasters affecting production/shipping
- Labor unrest at factories or ports

IGNORE: celebrity news, domestic political debates not affecting trade, sports, routine elections in stable democracies.

Return JSON:
{
  "country_code": "${country_code}",
  "stability": "stable" | "watch" | "elevated" | "unstable",
  "event_count_by_category": { "port_disruption": n, "political": n, "trade_policy": n, "labor": n, "natural_disaster": n, "other": n },
  "top_events": [
    {
      "headline": string,
      "source_url": string,
      "original_language": string|null,
      "date": "YYYY-MM-DD",
      "category": string,
      "relevance_score": 0-1,
      "severity": "low"|"medium"|"high"|"critical"
    }
  ],
  "citations": string[]
}

Return at minimum 2 top_events. If no articles were provided or none are relevant, use your knowledge of recent conditions in ${countryName} to populate at least 2 events with relevance_score < 0.5 and severity "low". Always return a valid assessment.`;

    const result = await this.callLLMValidated(
      [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content:
            articles.length > 0
              ? `Recent news articles about ${countryName}:\n${articleContext}\n\nAssess trade-route risk.`
              : `No recent GDELT articles retrieved for ${countryName}. Use your knowledge of current conditions to provide a risk assessment.`,
        },
      ],
      CountryRiskOutput
    );

    await cache.set(cacheKey, result as unknown as object, 3 * 60 * 60); // 3h cache

    await this.publishSignal({
      shipmentId,
      signalType: "country_risk",
      severity: this.stabilityToSeverity(result.stability),
      payload: result as unknown as Record<string, unknown>,
      confidence: articles.length > 0 ? 0.85 : 0.65,
    });

    return result;
  }

  private stabilityToSeverity(
    stability: string
  ): "info" | "low" | "medium" | "high" | "critical" {
    switch (stability) {
      case "stable": return "info";
      case "watch": return "low";
      case "elevated": return "medium";
      case "unstable": return "high";
      default: return "info";
    }
  }
}
