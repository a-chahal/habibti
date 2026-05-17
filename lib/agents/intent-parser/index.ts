import { z } from "zod";
import { Agent } from "../base";

// HS code lookup table — keys use word-boundary matching (see resolveHSCode)
const HS_LOOKUP: Record<string, { code: string; description: string }> = {
  cotton: { code: "5208", description: "Woven fabrics of cotton" },
  "cotton fabric": { code: "5208", description: "Woven fabrics of cotton" },
  "cotton yarn": { code: "5205", description: "Cotton yarn" },
  coffee: { code: "0901", description: "Coffee" },
  cinnamon: { code: "0906", description: "Cinnamon and cinnamon-tree flowers" },
  "lithium battery": { code: "8507", description: "Electric accumulators" },
  "lithium batteries": { code: "8507", description: "Electric accumulators" },
  battery: { code: "8507", description: "Electric accumulators" },
  batteries: { code: "8507", description: "Electric accumulators" },
  "ev battery": { code: "8507", description: "Electric accumulators for EVs" },
  solar: { code: "8541", description: "Photovoltaic cells" },
  "solar panel": { code: "8541", description: "Photovoltaic cells" },
  steel: { code: "7208", description: "Flat-rolled products of iron/steel" },
  aluminum: { code: "7606", description: "Aluminium plates, sheets, strip" },
  aluminium: { code: "7606", description: "Aluminium plates, sheets, strip" },
  rice: { code: "1006", description: "Rice" },
  wheat: { code: "1001", description: "Wheat and meslin" },
  soybeans: { code: "1201", description: "Soya beans" },
  "palm oil": { code: "1511", description: "Palm oil" },
  rubber: { code: "4001", description: "Natural rubber" },
  timber: { code: "4407", description: "Wood sawn or chipped" },
  wood: { code: "4407", description: "Wood sawn or chipped" },
  furniture: { code: "9403", description: "Other furniture" },
  garments: { code: "6110", description: "Jerseys, pullovers, etc." },
  apparel: { code: "6110", description: "Jerseys, pullovers, etc." },
  clothing: { code: "6110", description: "Jerseys, pullovers, etc." },
  shoes: { code: "6403", description: "Footwear with outer soles of rubber" },
  footwear: { code: "6403", description: "Footwear" },
  electronics: { code: "8542", description: "Electronic integrated circuits" },
  semiconductor: { code: "8542", description: "Electronic integrated circuits" },
  chips: { code: "8542", description: "Electronic integrated circuits" },
  smartphone: { code: "8517", description: "Telephone sets" },
  phone: { code: "8517", description: "Telephone sets" },
  laptop: { code: "8471", description: "Automatic data-processing machines" },
  computer: { code: "8471", description: "Automatic data-processing machines" },
  copper: { code: "7408", description: "Copper wire" },
  zinc: { code: "7901", description: "Unwrought zinc" },
  nickel: { code: "7502", description: "Unwrought nickel" },
  "plastic resin": { code: "3901", description: "Polymers of ethylene" },
  plastic: { code: "3926", description: "Other articles of plastics" },
  chemicals: { code: "2902", description: "Cyclic hydrocarbons" },
  fertilizer: { code: "3102", description: "Mineral or chemical fertilisers" },
  pharmaceutical: { code: "3004", description: "Medicaments" },
  medicine: { code: "3004", description: "Medicaments" },
  wine: { code: "2204", description: "Wine of fresh grapes" },
  beer: { code: "2203", description: "Beer made from malt" },
  spirits: { code: "2208", description: "Undenatured ethyl alcohol" },
  sugar: { code: "1701", description: "Cane or beet sugar" },
  cocoa: { code: "1801", description: "Cocoa beans" },
  chocolate: { code: "1806", description: "Chocolate and other food preparations" },
  seafood: { code: "0302", description: "Fish, fresh or chilled" },
  shrimp: { code: "0306", description: "Crustaceans" },
  beef: { code: "0201", description: "Meat of bovine animals, fresh" },
  pork: { code: "0203", description: "Meat of swine, fresh or chilled" },
  chicken: { code: "0207", description: "Meat of poultry" },
  ceramic: { code: "6907", description: "Ceramic flags and paving" },
  glass: { code: "7005", description: "Float glass" },
  cement: { code: "2523", description: "Portland cement" },
  "auto parts": { code: "8708", description: "Parts for motor vehicles" },
  tyres: { code: "4011", description: "New pneumatic tyres" },
  tires: { code: "4011", description: "New pneumatic tyres" },
};

// Port resolution — all keys use word-boundary matching (see resolvePort)
const PORT_LOOKUP: Record<string, { code: string; country: string; name: string }> = {
  "los angeles": { code: "USLAX", country: "US", name: "Port of Los Angeles" },
  "long beach": { code: "USLGB", country: "US", name: "Port of Long Beach" },
  "new york": { code: "USNYC", country: "US", name: "Port of New York/New Jersey" },
  "new jersey": { code: "USNYC", country: "US", name: "Port of New York/New Jersey" },
  nyc: { code: "USNYC", country: "US", name: "Port of New York/New Jersey" },
  "new york/new jersey": { code: "USNYC", country: "US", name: "Port of New York/New Jersey" },
  savannah: { code: "USSAV", country: "US", name: "Port of Savannah" },
  seattle: { code: "USSEA", country: "US", name: "Port of Seattle" },
  tacoma: { code: "USTAC", country: "US", name: "Port of Tacoma" },
  houston: { code: "USHOU", country: "US", name: "Port of Houston" },
  miami: { code: "USMIA", country: "US", name: "Port of Miami" },
  charleston: { code: "USCHS", country: "US", name: "Port of Charleston" },
  baltimore: { code: "USBAL", country: "US", name: "Port of Baltimore" },
  norfolk: { code: "USNFK", country: "US", name: "Port of Virginia (Norfolk)" },
  chicago: { code: "USCHI", country: "US", name: "Port of Chicago" },
  california: { code: "USLAX", country: "US", name: "Port of Los Angeles" },
  oakland: { code: "USOAK", country: "US", name: "Port of Oakland" },
  "san francisco": { code: "USSFO", country: "US", name: "Port of San Francisco" },
  boston: { code: "USBOS", country: "US", name: "Port of Boston" },
  philadelphia: { code: "USPHL", country: "US", name: "Port of Philadelphia" },
  cleveland: { code: "USCLE", country: "US", name: "Port of Cleveland" },
  // International
  shanghai: { code: "CNSHA", country: "CN", name: "Port of Shanghai" },
  shenzhen: { code: "CNSZX", country: "CN", name: "Port of Shenzhen" },
  guangzhou: { code: "CNGZU", country: "CN", name: "Port of Guangzhou" },
  ningbo: { code: "CNNGB", country: "CN", name: "Port of Ningbo" },
  singapore: { code: "SGSIN", country: "SG", name: "Port of Singapore" },
  rotterdam: { code: "NLRTM", country: "NL", name: "Port of Rotterdam" },
  hamburg: { code: "DEHAM", country: "DE", name: "Port of Hamburg" },
  antwerp: { code: "BEANR", country: "BE", name: "Port of Antwerp" },
  dubai: { code: "AEJEA", country: "AE", name: "Port of Jebel Ali" },
  tokyo: { code: "JPTYO", country: "JP", name: "Port of Tokyo" },
  yokohama: { code: "JPYOK", country: "JP", name: "Port of Yokohama" },
  busan: { code: "KRPUS", country: "KR", name: "Port of Busan" },
  jakarta: { code: "IDJKT", country: "ID", name: "Port of Jakarta (Tanjung Priok)" },
  "port klang": { code: "MYPKG", country: "MY", name: "Port Klang" },
  mumbai: { code: "INBOM", country: "IN", name: "Port of Mumbai" },
  colombo: { code: "LKCMB", country: "LK", name: "Port of Colombo" },
};

// Short single-word aliases that could be dangerous substrings — require word boundaries
const SHORT_PORT_ALIASES: Record<string, { code: string; country: string; name: string }> = {
  la: { code: "USLAX", country: "US", name: "Port of Los Angeles" },
  ny: { code: "USNYC", country: "US", name: "Port of New York/New Jersey" },
};

export function resolveHSCode(productText: string): { code: string; description: string } | null {
  const lower = productText.toLowerCase();
  // Longer keys first so "cotton fabric" beats "cotton"
  const sorted = Object.keys(HS_LOOKUP).sort((a, b) => b.length - a.length);
  for (const keyword of sorted) {
    const re = new RegExp(`\\b${keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
    if (re.test(lower)) return HS_LOOKUP[keyword];
  }
  return null;
}

export function resolvePort(locationText: string): { code: string; country: string; name: string } | null {
  const lower = locationText.toLowerCase();
  // Try multi-word keys first
  const sorted = Object.keys(PORT_LOOKUP).sort((a, b) => b.length - a.length);
  for (const keyword of sorted) {
    const re = new RegExp(`\\b${keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
    if (re.test(lower)) return PORT_LOOKUP[keyword];
  }
  // Short aliases with strict word boundaries
  for (const [alias, data] of Object.entries(SHORT_PORT_ALIASES)) {
    const re = new RegExp(`\\b${alias}\\b`, "i");
    if (re.test(lower)) return data;
  }
  return null;
}

export const IntentOutput = z.object({
  hs_code: z.string(),
  hs_candidates: z
    .array(z.object({ code: z.string(), description: z.string(), confidence: z.number() }))
    .optional(),
  product_description: z.string(),
  quantity: z
    .union([z.number(), z.string().transform((s) => (s === "" ? null : Number(s)))])
    .nullable(),
  quantity_unit: z.string().nullable(),
  origin_country: z.string().nullable(),
  supplier: z.string().nullable(),
  destination_port: z.string().nullable(),
  destination_country: z.string().nullable(),
  deadline_date: z.string().nullable(),
  budget_usd: z.number().nullable(),
  notes: z.string().nullable().default(""),
  clarification_needed: z.string().nullable(),
});

export type IntentOutput = z.infer<typeof IntentOutput>;

function buildSystemPrompt(): string {
  const today = new Date().toISOString().slice(0, 10);
  return `You are a trade intelligence assistant that parses import shipment intents into structured data.

Today's date: ${today}.

Given a user's natural-language shipment request, extract:
- hs_code: 4-digit HS code (e.g. "5208" for cotton fabrics, "0906" for cinnamon, "8507" for lithium batteries)
- hs_candidates: array of up to 3 candidates with confidence 0-1 if ambiguous (omit if certain)
- product_description: cleaned product name
- quantity: numeric quantity (null if not specified)
- quantity_unit: unit string like "yards", "kg", "units", "MT" (null if not specified)
- origin_country: ISO 2-letter country code if specified (null if not)
- supplier: specific supplier or factory name if the user names one (e.g. "Vinatex", "Acme Textiles Co."); null if no specific supplier is mentioned
- destination_port: UNLOCODE port code (e.g. "USLAX", "USNYC", "USOAK") — infer from city/state/region
- destination_country: ISO 2-letter country code for destination
- deadline_date: ISO 8601 date (YYYY-MM-DD) if deadline mentioned, null otherwise
- budget_usd: numeric USD budget (null if not specified). Parse "30K" as 30000, "1M" as 1000000.
- notes: any other relevant information (empty string if none)
- clarification_needed: string if the input is too vague to parse reliably, null otherwise

HS code hints:
- Cotton fabric/textile → 5208 (woven cotton)
- Cinnamon, spices → 0906
- Lithium batteries, EV batteries → 8507
- Coffee → 0901
- Electronics/chips → 8542
- Auto parts → 8708

Port inference:
- Los Angeles / LA / California → USLAX
- New York / NY / NJ / New Jersey → USNYC
- Oakland → USOAK
- Long Beach → USLGB
- Seattle / Pacific Northwest → USSEA
- Houston → USHOU
- Miami → USMIA
- Savannah → USSAV

Supplier extraction examples:
- "from Vinatex in Vietnam" → supplier: "Vinatex"
- "from Anhui Hengyi Textiles" → supplier: "Anhui Hengyi Textiles"
- "cotton from Vietnam" → supplier: null (no specific supplier named)
- "organic cotton, from Vietnam, into LA" → supplier: null

Respond ONLY with valid JSON matching the schema above.`;
}

export class IntentParserAgent extends Agent {
  readonly name = "intent-parser";
  readonly tier = "mercury" as const;

  async process(input: unknown): Promise<IntentOutput> {
    const rawIntent = typeof input === "string" ? input : (input as any).intent ?? String(input);

    // Pre-resolve HS code and port from lookup table as hints
    const hsHint = resolveHSCode(rawIntent);
    const portHint = resolvePort(rawIntent);

    const userPrompt = rawIntent +
      (hsHint ? `\n\n[Hint: product matches HS ${hsHint.code} — ${hsHint.description}]` : "") +
      (portHint ? `\n[Hint: destination matches port ${portHint.code} — ${portHint.name}]` : "");

    return this.callLLMValidated(
      [
        { role: "system", content: buildSystemPrompt() },
        { role: "user", content: userPrompt },
      ],
      IntentOutput
    );
  }
}
