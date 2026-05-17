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
  { iso2: "EG", name: "Egypt", numeric: "818" },
  { iso2: "MA", name: "Morocco", numeric: "504" },
];

const SANCTIONED = new Set(["IR", "KP", "CU", "SY"]);

// Approximate transit days for viability pre-filter
const TYPICAL_TRANSIT: Record<string, number> = {
  MX: 4, CN: 14, VN: 16, TW: 14, KR: 14, JP: 14, TH: 18,
  KH: 18, MY: 16, ID: 18, PH: 18, LK: 22, IN: 28, BD: 30,
  PK: 30, TR: 20, EG: 22, MA: 20, DE: 25, BR: 30, ET: 35,
  MG: 30, PE: 20,
};

function candidatesForHS(hsCode: string): typeof COUNTRY_CATALOG {
  const chapter = parseInt(hsCode.slice(0, 2), 10);
  if (chapter >= 50 && chapter <= 63) {
    // Textiles and apparel
    return COUNTRY_CATALOG.filter((c) =>
      ["CN", "VN", "IN", "BD", "ID", "TR", "PK", "KH", "MY", "LK", "ET", "MX", "EG", "MA"].includes(c.iso2)
    );
  }
  if (chapter >= 84 && chapter <= 85) {
    // Electronics / machinery
    return COUNTRY_CATALOG.filter((c) =>
      ["CN", "VN", "TW", "KR", "JP", "MX", "TH", "IN", "MY", "DE"].includes(c.iso2)
    );
  }
  if (chapter >= 1 && chapter <= 24) {
    // Food and agriculture
    return COUNTRY_CATALOG.filter((c) =>
      ["BR", "IN", "TH", "VN", "ID", "MX", "TR", "BD", "PE", "MG", "EG"].includes(c.iso2)
    );
  }
  if (chapter >= 72 && chapter <= 83) {
    // Metals
    return COUNTRY_CATALOG.filter((c) =>
      ["CN", "TR", "DE", "KR", "JP", "IN", "MX", "BR"].includes(c.iso2)
    );
  }
  if (chapter === 64) {
    // Footwear
    return COUNTRY_CATALOG.filter((c) =>
      ["CN", "VN", "IN", "ID", "BR", "MX", "KH", "BD"].includes(c.iso2)
    );
  }
  if (chapter === 94) {
    // Furniture
    return COUNTRY_CATALOG.filter((c) =>
      ["CN", "VN", "IN", "MX", "PL", "ID", "MY", "TH"].includes(c.iso2)
    );
  }
  if (chapter >= 39 && chapter <= 40) {
    // Plastics / rubber
    return COUNTRY_CATALOG.filter((c) =>
      ["CN", "IN", "TH", "MY", "ID", "DE", "KR", "JP", "MX"].includes(c.iso2)
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
    const { hs_code, destination_country, preferred_origin, quantity, quantity_unit, deadline_date, shipmentId } = input as {
      hs_code: string;
      destination_country?: string;
      preferred_origin?: string | null;
      quantity?: number | null;
      quantity_unit?: string | null;
      deadline_date?: string | null;
      shipmentId?: string;
    };

    const cacheKey = `country-discoverer:${hs_code}:${preferred_origin ?? "any"}:${deadline_date ?? "open"}`;
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

    let candidates = candidatesForHS(hs_code);

    // Ensure user-specified origin is always in the candidate pool
    if (preferred_origin) {
      const upper = preferred_origin.toUpperCase();
      if (!candidates.some((c) => c.iso2 === upper)) {
        const entry = COUNTRY_CATALOG.find((c) => c.iso2 === upper);
        if (entry) candidates = [entry, ...candidates];
      }
    }

    // Pre-filter: remove sanctioned + deadline-violating candidates
    const daysToDeadline = deadline_date
      ? Math.round((new Date(deadline_date).getTime() - Date.now()) / 86_400_000)
      : null;

    const viableCandidates = candidates.filter((c) => {
      if (SANCTIONED.has(c.iso2)) return false;
      // Keep preferred origin regardless of transit time (let option-ranker explain the constraint)
      if (preferred_origin && c.iso2 === preferred_origin.toUpperCase()) return true;
      if (daysToDeadline !== null) {
        const transit = TYPICAL_TRANSIT[c.iso2] ?? 25;
        if (transit + 5 > daysToDeadline) return false;
      }
      return true;
    });

    const year = String(new Date().getFullYear() - 1);
    let comtradeSuccess = false;

    const volumeData: Array<{ iso2: string; name: string; exportVolume: number; usVolume: number }> = [];

    for (const country of viableCandidates) {
      let exportVolume = 0;
      let usVolume = 0;
      try {
        const global = await queryComtrade({
          reporterCode: country.numeric,
          cmdCode: hs_code,
          period: year,
          flowCode: "X",
          partnerCode: "0",
        });
        exportVolume = global.data.reduce((s, r) => s + r.primaryValue, 0);

        const toUS = await queryComtrade({
          reporterCode: country.numeric,
          cmdCode: hs_code,
          period: year,
          flowCode: "X",
          partnerCode: "842",
        });
        usVolume = toUS.data.reduce((s, r) => s + r.primaryValue, 0);
        if (exportVolume > 0) comtradeSuccess = true;
      } catch {
        // Comtrade unavailable; LLM fills in from training data
      }
      volumeData.push({ iso2: country.iso2, name: country.name, exportVolume, usVolume });
    }

    // Check sanctions for country-level matches
    const sanctionsSummary: string[] = [];
    for (const c of volumeData) {
      try {
        const matches = await searchSanctions(c.name);
        if (matches.length > 0) {
          sanctionsSummary.push(`${c.name}: ${matches.length} sanctions entity matches`);
        }
      } catch { /* non-fatal */ }
    }

    const dataJson = JSON.stringify(
      volumeData.map((v) => ({
        country_code: v.iso2,
        country_name: v.name,
        comtrade_export_usd: v.exportVolume,
        comtrade_us_export_usd: v.usVolume,
        typical_transit_days: TYPICAL_TRANSIT[v.iso2] ?? 25,
      })),
      null,
      2
    );

    const preferredNote = preferred_origin
      ? `\nIMPORTANT: The buyer has specified "${preferred_origin}" as their preferred origin country. This country MUST appear as the FIRST candidate in your ranked list regardless of volume rank.`
      : "";

    const deadlineNote = daysToDeadline !== null
      ? `\nDEADLINE: Buyer needs delivery in ${daysToDeadline} days. Candidates with typical transit > ${daysToDeadline - 5} days have already been pre-filtered. Note transit feasibility in your ranking.`
      : "";

    const quantityNote = quantity
      ? `\nQUANTITY: ${quantity} ${quantity_unit ?? "units"}. Weight candidates by minimum order quantity feasibility.`
      : "";

    const dataNote = comtradeSuccess
      ? ""
      : "\nNOTE: Comtrade API was unavailable. Use your knowledge to estimate volumes. Confidence in volume data is low.";

    const systemPrompt = `You are a trade sourcing analyst. Rank candidate exporting countries for a US importer.

Given Comtrade export data (some may be 0 if API was unavailable — use your knowledge to fill in reasonable estimates), produce a ranked list of the top 5-7 candidate source countries for HS code ${hs_code}.

For each candidate:
- country_code: ISO 2-letter
- country_name: full name
- annual_export_volume_usd: estimated annual global export volume in USD
- us_import_volume_usd: estimated annual US import volume from this country for this HS code
- lane_established: true if regular container shipping lane to US exists
- trend: "rising" | "stable" | "falling" based on recent 3-year direction
- citations: array of source URLs (use "UN Comtrade ${year}" if from data, or "LLM estimate (Comtrade unavailable)" if synthesized)

Sanctions summary (filter these out): ${sanctionsSummary.join("; ") || "none"}
Destination country preference: ${destination_country ?? "US"}${preferredNote}${deadlineNote}${quantityNote}${dataNote}

Respond ONLY with valid JSON: { "hs_code": "${hs_code}", "candidates": [...], "data_year": "${year}", "citations": [...] }`;

    const result = await this.callLLMValidated(
      [
        { role: "system", content: systemPrompt },
        { role: "user", content: `Comtrade data:\n${dataJson}\n\nRank and return the top 5-7 source countries for HS ${hs_code}.` },
      ],
      CountryDiscovererOutput
    );

    await cache.set(cacheKey, result as unknown as object, 24 * 60 * 60);

    await this.publishSignal({
      shipmentId,
      signalType: "country_candidates",
      severity: "info",
      payload: result as unknown as Record<string, unknown>,
      confidence: comtradeSuccess ? 0.85 : 0.45,
    });

    return result;
  }
}
