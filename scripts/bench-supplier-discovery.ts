/**
 * Benchmark: can Mercury / Sonnet (with OpenRouter web plugin) reliably
 * discover real bulk-goods suppliers given (HS code, country, product)?
 *
 * Run: npx tsx --env-file=.env scripts/bench-supplier-discovery.ts
 */

const BASE_URL = "https://openrouter.ai/api/v1/chat/completions";
const apiKey = process.env.OPENROUTER_API_KEY!;
if (!apiKey) throw new Error("OPENROUTER_API_KEY missing");

const QUERIES = [
  { product: "cotton t-shirts", hs: "610910", country: "India", qty: "10,000 units" },
  { product: "hot-rolled steel rebar", hs: "721420", country: "Turkey", qty: "200 metric tons" },
  { product: "lithium-ion battery cells (18650)", hs: "850760", country: "China", qty: "50,000 units" },
  { product: "green coffee beans (arabica)", hs: "090111", country: "Ethiopia", qty: "20 metric tons" },
  { product: "extra virgin olive oil bulk", hs: "150910", country: "Spain", qty: "30,000 liters" },
  { product: "finished leather handbags", hs: "420221", country: "Italy", qty: "2,000 units" },
  { product: "long-grain white rice", hs: "100630", country: "Vietnam", qty: "500 metric tons" },
  { product: "monocrystalline solar panels 400W", hs: "854143", country: "Vietnam", qty: "1,000 units" },
];

const SYSTEM = `You are a sourcing analyst helping a small US importer find REAL bulk-goods suppliers.
Use web search to find actual exporters/manufacturers — do not invent names.
Return ONLY this JSON shape (no prose, no fences):

{
  "candidates": [
    {
      "name": "<company legal name>",
      "country": "<ISO-2>",
      "city": "<city or null>",
      "website": "<url or null>",
      "products": "<short blurb on what they ship>",
      "evidence_url": "<the source url that proves they exist & ship this product>",
      "min_order": "<MOQ if known, else null>",
      "confidence": 0.0
    }
  ],
  "citations": ["url1", "url2", ...]
}

Rules:
- Return 4-6 candidates.
- Each candidate MUST have an evidence_url that you actually found in search.
- Prefer manufacturers / direct exporters over trading agents, unless the user is small (<1 container).
- If you cannot find real verifiable candidates, return empty candidates with citations explaining.`;

function userPrompt(q: typeof QUERIES[number]) {
  return `Find suppliers for:
- Product: ${q.product}
- HS code: ${q.hs}
- Country: ${q.country}
- Quantity: ${q.qty}
- Destination: United States

Return 4-6 real, verifiable exporters with evidence URLs.`;
}

interface Result {
  approach: string;
  query: string;
  ms: number;
  cost: number;
  candidates: number;
  citationsCount: number;
  jsonOk: boolean;
  hasEvidenceUrls: number;
  sampleNames: string[];
  raw?: string;
  error?: string;
}

async function runOne(
  approach: string,
  model: string,
  webMode: "off" | "default" | "deep",
  q: typeof QUERIES[number]
): Promise<Result> {
  const t0 = Date.now();
  const body: Record<string, unknown> = {
    model,
    messages: [
      { role: "system", content: SYSTEM },
      { role: "user", content: userPrompt(q) },
    ],
    temperature: 0.2,
    max_tokens: 2500,
    response_format: { type: "json_object" },
  };
  if (webMode === "default") {
    body.plugins = [{ id: "web" }];
  } else if (webMode === "deep") {
    body.plugins = [{
      id: "web",
      max_results: 10,
      search_prompt: `Search the web for real exporters/manufacturers of "${q.product}" in ${q.country}. Look for company directories (Alibaba, ExportHub, IndiaMART, TradeIndia, GlobalSources), trade association rosters, and corporate websites. Return URLs that prove the company exists and exports this HS-code product.`,
    }];
  }

  try {
    const res = await fetch(BASE_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://habibti.trade",
        "X-Title": "Habibti benchmark",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(90_000),
    });

    const ms = Date.now() - t0;
    if (!res.ok) {
      return {
        approach, query: q.product, ms, cost: 0, candidates: 0, citationsCount: 0,
        jsonOk: false, hasEvidenceUrls: 0, sampleNames: [], error: `HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`,
      };
    }
    const data: any = await res.json();
    const raw = data.choices?.[0]?.message?.content ?? "";
    const usage = data.usage ?? {};
    const COST: Record<string, [number, number]> = {
      "anthropic/claude-sonnet-4-6": [3, 15],
      "inception/mercury-2": [0.25, 1.25],
    };
    const [inC, outC] = COST[model] ?? [0, 0];
    const cost = (usage.prompt_tokens ?? 0) / 1e6 * inC + (usage.completion_tokens ?? 0) / 1e6 * outC;

    let parsed: any = null;
    let jsonOk = false;
    try {
      const trimmed = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
      parsed = JSON.parse(trimmed);
      jsonOk = true;
    } catch {}

    const candidates = parsed?.candidates ?? [];
    const citations = parsed?.citations ?? [];
    const hasEvidenceUrls = candidates.filter((c: any) => c.evidence_url && /^https?:\/\//.test(c.evidence_url)).length;
    const sampleNames = candidates.slice(0, 3).map((c: any) => c.name);

    return {
      approach, query: q.product, ms, cost,
      candidates: candidates.length,
      citationsCount: citations.length,
      jsonOk,
      hasEvidenceUrls,
      sampleNames,
      raw: raw.slice(0, 1500),
    };
  } catch (err: any) {
    return {
      approach, query: q.product, ms: Date.now() - t0, cost: 0, candidates: 0,
      citationsCount: 0, jsonOk: false, hasEvidenceUrls: 0, sampleNames: [],
      error: err.message,
    };
  }
}

async function benchMain() {
  const approaches: Array<[string, string, "off" | "default" | "deep"]> = [
    ["mercury-bare",     "inception/mercury-2", "off"],
    ["mercury-web",      "inception/mercury-2", "default"],
    ["mercury-web-deep", "inception/mercury-2", "deep"],
  ];

  const all: Result[] = [];
  for (const [name, model, web] of approaches) {
    console.log(`\n=== ${name} ===`);
    for (const q of QUERIES) {
      process.stdout.write(`  ${q.country.padEnd(10)} ${q.product.slice(0, 40).padEnd(42)}`);
      const r = await runOne(name, model, web, q);
      all.push(r);
      if (r.error) {
        console.log(`ERR ${r.error.slice(0, 80)}`);
      } else {
        console.log(`${r.ms}ms  ${r.candidates} cands  ${r.hasEvidenceUrls} urls  $${r.cost.toFixed(4)}  ${r.sampleNames.slice(0,2).join(" / ")}`);
      }
    }
  }

  console.log("\n=== SUMMARY ===");
  for (const name of approaches.map(a => a[0])) {
    const rs = all.filter(r => r.approach === name);
    const ok = rs.filter(r => r.jsonOk);
    const avgCands = ok.reduce((s, r) => s + r.candidates, 0) / Math.max(ok.length, 1);
    const avgUrls = ok.reduce((s, r) => s + r.hasEvidenceUrls, 0) / Math.max(ok.length, 1);
    const avgMs = rs.reduce((s, r) => s + r.ms, 0) / rs.length;
    const totalCost = rs.reduce((s, r) => s + r.cost, 0);
    console.log(
      `${name.padEnd(15)} jsonOk=${ok.length}/${rs.length}  ` +
      `avgCands=${avgCands.toFixed(1)}  avgEvidenceUrls=${avgUrls.toFixed(1)}  ` +
      `avgMs=${avgMs.toFixed(0)}  totalCost=$${totalCost.toFixed(3)}`
    );
  }

  // Write detailed report
  const fs = await import("fs");
  fs.writeFileSync(
    "/tmp/bench-supplier-discovery.json",
    JSON.stringify(all, null, 2)
  );
  console.log("\nDetailed dump → /tmp/bench-supplier-discovery.json");
}

benchMain().catch((e) => { console.error(e); process.exit(1); });
