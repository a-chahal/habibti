import { z } from "zod";
import { Agent } from "../base";
import { queryComtrade } from "../../sources/comtrade";
import { cache } from "../../cache";
import { searchSanctions } from "../../db/queries";

// ISO2 → { name, comtradeNumeric }
const COUNTRY_CATALOG: Array<{ iso2: string; name: string; numeric: string }> = [
  { iso2: "CN", name: "China", numeric: "156" },
  { iso2: "VN", name: "Vietnam", numeric: "704" },
  { iso2: "IN", name: "India", numeric: "356" },
  { iso2: "ID", name: "Indonesia", numeric: "360" },
  { iso2: "BD", name: "Bangladesh", numeric: "50" },
  { iso2: "TR", name: "Turkey", numeric: "792" },
  { iso2: "PK", name: "Pakistan", numeric: "586" },
  { iso2: "MX", name: "Mexico", numeric: "484" },
  { iso2: "TH", name: "Thailand", numeric: "764" },
  { iso2: "KH", name: "Cambodia", numeric: "116" },
  { iso2: "MY", name: "Malaysia", numeric: "458" },
  { iso2: "LK", name: "Sri Lanka", numeric: "144" },
  { iso2: "ET", name: "Ethiopia", numeric: "231" },
  { iso2: "TW", name: "Taiwan", numeric: "158" },
  { iso2: "KR", name: "South Korea", numeric: "410" },
  { iso2: "JP", name: "Japan", numeric: "392" },
  { iso2: "DE", name: "Germany", numeric: "276" },
  { iso2: "BR", name: "Brazil", numeric: "76" },
  { iso2: "MG", name: "Madagascar", numeric: "450" },
  { iso2: "PE", name: "Peru", numeric: "604" },
];

// Countries under comprehensive US sanctions — always filter out
const SANCTIONED = new Set(["IR", "KP", "CU", "SY"]);

// HS chapter prefix → most relevant candidate countries
function candidatesForHS(hsCode: string): typeof COUNTRY_CATALOG {
  const chapter = parseInt(hsCode.slice(0, 2), 10);
  if (chapter >= 50 && chapter <= 63) {
    return COUNTRY_CATALOG.filter((c) =>
      ["CN", "VN", "IN", "BD", "ID", "TR", "PK", "KH", "MY", "LK", "ET", "MX"].includes(c.iso2)
    );
  }
  if (chapter >= 84 && chapter <= 85) {
    return COUNTRY_CATALOG.filter((c) =>
      ["CN", "VN", "TW", "KR", "JP", "MX", "TH", "IN", "MY", "DE"].includes(c.iso2)
    );
  }
  if (chapter >= 1 && chapter <= 24) {
    return COUNTRY_CATALOG.filter((c) =>
      ["BR", "IN", "TH", "VN", "ID", "MX", "TR", "BD", "PE", "MG"].includes(c.iso2)
    );
  }
  if (chapter >= 72 && chapter <= 83) {
    return COUNTRY_CATALOG.filter((c) =>
      ["CN", "TR", "DE", "KR", "JP", "IN", "MX", "BR"].includes(c.iso2)
    );
  }
  return COUNTRY_CATALOG.filter((c) =>
    ["CN", "VN", "IN", "ID", "TR", "MX", "KR", "JP", "DE", "BR"].includes(c.iso2)
  );
}

export const CandidateCountry = z.object({
  country_code: z.string(),
  country_name: z.string(),
  annual_export_volume_usd: z.number(),
  us_import_volume_usd: z.number(),
  lane_established: z.boolean(),
  trend: z.enum(["rising", "stable", "falling"]),
  citations: z.array(z.string()),
});

export const CountryDiscovererOutput = z.object({
  hs_code: z.string(),
  candidates: z.array(CandidateCountry),
  data_year: z.string(),
  citations: z.array(z.string()),
});

export type CountryDiscovererOutput = z.infer<typeof CountryDiscovererOutput>;

export class CountryDiscovererAgent extends Agent {
  readonly name = "country-discoverer";
  readonly tier = "mercury" as const;

  async process(input: unknown): Promise<CountryDiscovererOutput> {
    const { hs_code, destination_country, shipmentId } = input as {
      hs_code: string;
      destination_country?: string;
      shipmentId?: string;
    };

    const cacheKey = `country-discoverer:${hs_code}`;
    const cached = await cache.get<CountryDiscovererOutput>(cacheKey);
    if (cached) {
      await this.publishSignal({
        shipmentId,
        signalType: "country_candidates",
        severity: "info",
        payload: cached as unknown as Record<string, unknown>,
        confidence: 0.85,
      });
      return cached;
    }

    const candidates = candidatesForHS(hs_code);
    const year = String(new Date().getFullYear() - 1);

    // Query Comtrade for each candidate
    const volumeData: Array<{ iso2: string; name: string; exportVolume: number; usVolume: number }> = [];

    for (const country of candidates) {
      if (SANCTIONED.has(country.iso2)) continue;
      let exportVolume = 0;
      let usVolume = 0;
      try {
        // Global exports from this country
        const global = await queryComtrade({
          reporterCode: country.numeric,
          cmdCode: hs_code,
          period: year,
          flowCode: "X",
          partnerCode: "0",
        });
        exportVolume = global.data.reduce((s, r) => s + r.primaryValue, 0);

        // Exports to US (partner=842)
        const toUS = await queryComtrade({
          reporterCode: country.numeric,
          cmdCode: hs_code,
          period: year,
          flowCode: "X",
          partnerCode: "842",
        });
        usVolume = toUS.data.reduce((s, r) => s + r.primaryValue, 0);
      } catch {
        // Comtrade may be unavailable; proceed with 0 — Sonnet fills in from training data
      }
      volumeData.push({ iso2: country.iso2, name: country.name, exportVolume, usVolume });
    }

    // Check sanctions for any country-level matches
    const sanctionsSummary: string[] = [];
    for (const c of volumeData) {
      try {
        const matches = await searchSanctions(c.name);
        if (matches.length > 0) {
          sanctionsSummary.push(`${c.name}: ${matches.length} sanctions entity matches`);
        }
      } catch {
        // non-fatal
      }
    }

    const dataJson = JSON.stringify(
      volumeData.map((v) => ({
        country_code: v.iso2,
        country_name: v.name,
        comtrade_export_usd: v.exportVolume,
        comtrade_us_export_usd: v.usVolume,
      })),
      null,
      2
    );

    const systemPrompt = `You are a trade sourcing analyst. Rank candidate exporting countries for a US importer.

Given Comtrade export data (some may be 0 if API was unavailable — use your knowledge to fill in reasonable estimates), produce a ranked list of the top 5-7 candidate source countries for HS code ${hs_code}.

For each candidate:
- country_code: ISO 2-letter
- country_name: full name
- annual_export_volume_usd: estimated annual global export volume in USD (use Comtrade data if nonzero, otherwise estimate from knowledge)
- us_import_volume_usd: estimated annual US import volume from this country for this HS code
- lane_established: true if regular container shipping lane to US exists
- trend: "rising" | "stable" | "falling" based on recent 3-year direction
- citations: array of source URLs or data references (use "UN Comtrade 2023" if from data, otherwise describe the source)

Sanctions summary (filter these out): ${sanctionsSummary.join("; ") || "none"}
Destination country preference: ${destination_country ?? "US"}

Respond ONLY with valid JSON: { "hs_code": "${hs_code}", "candidates": [...], "data_year": "${year}", "citations": [...] }`;

    const result = await this.callLLMValidated(
      [
        { role: "system", content: systemPrompt },
        { role: "user", content: `Comtrade data:\n${dataJson}\n\nRank and return the top 5-7 source countries for HS ${hs_code}.` },
      ],
      CountryDiscovererOutput
    );

    // Cache for 24h
    await cache.set(cacheKey, result as unknown as object, 24 * 60 * 60);

    await this.publishSignal({
      shipmentId,
      signalType: "country_candidates",
      severity: "info",
      payload: result as unknown as Record<string, unknown>,
      confidence: 0.85,
    });

    return result;
  }
}
