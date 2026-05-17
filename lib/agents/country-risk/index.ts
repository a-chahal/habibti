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

const COUNTRY_NAMES: Record<string, string> = {
  CN: "China", VN: "Vietnam", IN: "India", ID: "Indonesia", BD: "Bangladesh",
  TR: "Turkey", PK: "Pakistan", MX: "Mexico", TH: "Thailand", KH: "Cambodia",
  MY: "Malaysia", LK: "Sri Lanka", ET: "Ethiopia", TW: "Taiwan", KR: "South Korea",
  JP: "Japan", DE: "Germany", BR: "Brazil", PE: "Peru", MG: "Madagascar",
  EG: "Egypt", MA: "Morocco", US: "United States", GB: "United Kingdom",
};

// HS chapter → industry-specific GDELT terms to append
function industryTerms(hsCode: string | null | undefined): string {
  const chapter = parseInt((hsCode ?? "").slice(0, 2), 10);
  if (chapter >= 50 && chapter <= 63) return "factory OR mill OR garment OR labor OR textile";
  if (chapter >= 84 && chapter <= 85) return "fab OR chip OR semiconductor OR electronics OR factory";
  if (chapter >= 1 && chapter <= 24) return "harvest OR drought OR crop OR agriculture OR food";
  if (chapter >= 72 && chapter <= 83) return "steel OR metal OR smelter OR mining";
  if (chapter >= 27 && chapter <= 40) return "chemical OR refinery OR plant OR manufacturing";
  return "manufacturing OR production OR export";
}

export class CountryRiskAgent extends Agent {
  readonly name = "country-risk";
  readonly tier = "mercury" as const;

  async process(input: unknown): Promise<CountryRiskOutput> {
    const { country_code, hs_code, deadline_date, lookback_days = 30, shipmentId } = input as {
      country_code: string;
      hs_code?: string | null;
      deadline_date?: string | null;
      lookback_days?: number;
      shipmentId?: string;
    };

    const cacheKey = `country-risk:${country_code}:${(hs_code ?? "").slice(0, 2)}:${lookback_days}`;
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
    const extraTerms = industryTerms(hs_code);

    let articles: Awaited<ReturnType<typeof searchRecentGDELT>>["articles"] = [];
    let gdeltSuccess = false;
    try {
      const gdelt = await searchRecentGDELT(
        `"${countryName}" (port OR shipping OR trade OR strike OR tariff OR sanctions OR protest OR unrest OR military OR ${extraTerms})`,
        lookback_days,
        30
      );
      articles = gdelt.articles;
      gdeltSuccess = true;
    } catch {
      // GDELT may be rate-limited; proceed with empty articles
    }

    const articleContext = articles
      .slice(0, 20)
      .map((a) => `- [${a.seendate}] (${a.sourcelang}) ${a.title} — ${a.url}`)
      .join("\n");

    const deadlineNote = deadline_date
      ? `\nDEADLINE NOTE: The buyer's shipment deadline is ${deadline_date}. Weight events by whether they are likely to impact shipping before this deadline.`
      : "";

    const systemPrompt = `You are a geopolitical risk analyst specializing in trade-route risk for US importers.

Analyze news articles about ${countryName} (${country_code}) over the past ${lookback_days} days and assess trade-route risk.

Focus ONLY on events that affect shipping, imports, manufacturing, or labor for US-bound goods:
- Port strikes, closures, congestion
- Military conflict or political instability affecting logistics
- Trade policy changes (tariffs, sanctions, bans)
- Major natural disasters affecting production/shipping
- Labor unrest at factories or ports
- Industry-specific issues: ${extraTerms}${deadlineNote}

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

    await cache.set(cacheKey, result as unknown as object, 3 * 60 * 60);

    // Lower confidence when GDELT failed — LLM is fabricating from training data
    const confidence = gdeltSuccess ? (articles.length > 0 ? 0.85 : 0.65) : 0.3;

    await this.publishSignal({
      shipmentId,
      signalType: "country_risk",
      severity: this.stabilityToSeverity(result.stability),
      payload: result as unknown as Record<string, unknown>,
      confidence,
    });

    return result;
  }

  private stabilityToSeverity(stability: string): "info" | "low" | "medium" | "high" | "critical" {
    switch (stability) {
      case "stable": return "info";
      case "watch": return "low";
      case "elevated": return "medium";
      case "unstable": return "high";
      default: return "info";
    }
  }
}
