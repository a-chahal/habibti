import { z } from "zod";
import { Agent } from "../base";
import { listPortsForCountry, getPrimaryPortForCountry } from "../../db/queries";
import { searchRecentGDELT } from "../../sources/gdelt";
import { cache } from "../../cache";

// ─── Output schema ─────────────────────────────────────────────────────────

const RankedPort = z.object({
  locode: z.string(),
  name: z.string(),
  lat: z.number(),
  lon: z.number(),
  score: z.number().min(0).max(1),
  rationale: z.string(),
  specialization: z.string(),
});

export const PortDiscovererOutput = z.object({
  country_code: z.string(),
  ports: z.array(RankedPort).min(1).max(3),
  citations: z.array(z.string()),
});

export type PortDiscovererOutput = z.infer<typeof PortDiscovererOutput>;

// ─── Major container port ranking (by 2024 TEU throughput) ─────────────────
// Higher rank = more capacity. Used to seed Mercury's candidate set.

// Canonical UN/LOCODE entries that exist in our `locations` table.
// Capacity ranking is loosely calibrated to 2024 TEU throughput / regional importance.
const MAJOR_PORTS: Record<string, number> = {
  // China
  CNSGH: 100, CNNBO: 95, CNNBG: 92, CNYTN: 90, CNSNZ: 88, CNSZP: 85, CNSHK: 80,
  CNQIN: 82, CNTNJ: 78, CNTNG: 75, CNTXG: 72, CNXMG: 70, CNDAL: 65,
  CNGZG: 80, CNGGZ: 75, HKHKG: 95,
  // Vietnam
  VNSGN: 90, VNHPH: 80, VNDAD: 65,
  // Singapore (regional transshipment hub)
  SGSIN: 100,
  // India
  INBOM: 90, INMAA: 75, INCOK: 60, INCCU: 55, INPAV: 50, INPPV: 50,
  // South Korea
  KRPUS: 95, KRBNP: 90, KRINC: 75,
  // Japan
  JPYOK: 80, JPTYO: 80, JPUKB: 75,
  // Thailand
  THBKK: 70, THLCH: 80, THBMT: 65,
  // Malaysia
  MYPKG: 85, MYTPP: 80,
  // Indonesia
  IDSUB: 65,
  // Bangladesh / Pakistan / Sri Lanka
  PKBQM: 70, PKKCT: 75, LKCMB: 80,
  // Middle East
  AEQWE: 90,
  // Turkey
  TRAMR: 70, TRIZM: 65,
  // Egypt
  EGPSE: 80, EGSUZ: 60, EGALY: 65, EGDAM: 60,
  // Morocco / Africa
  MACAS: 60, ZADUR: 75, ZACPT: 55,
  // Brazil / Latin America
  BRSSZ: 75, BRPNG: 60, BRRIO: 55, PECLL: 60,
  MXZLO: 75, MXLZC: 70, MXVER: 55,
  // Greece
  GRPIR: 85,
  // Northern Europe
  NLRTM: 100, DEHAM: 95, DEBRV: 80, BEANR: 90,
  // US
  USLAX: 95, USLGB: 90, USNYC: 85, USTSA: 75,
};

// HS chapter → port type fit hint for Mercury
function hsChapterContext(hs: string | null | undefined): string {
  const ch = parseInt((hs ?? "").slice(0, 2), 10);
  if (!ch) return "general cargo";
  if (ch >= 1 && ch <= 24) return "bulk agriculture/food, often handled at refrigerated or grain terminals";
  if (ch >= 25 && ch <= 27) return "bulk minerals/fuels — needs dry-bulk or tanker terminals";
  if (ch >= 28 && ch <= 38) return "chemicals — often specialised liquid-bulk terminals";
  if (ch >= 39 && ch <= 40) return "plastics/rubber — palletised containers";
  if (ch >= 41 && ch <= 49) return "leather, wood, paper — standard containers";
  if (ch >= 50 && ch <= 63) return "textiles/apparel — high-volume containers from apparel hubs";
  if (ch >= 64 && ch <= 67) return "footwear / headgear — standard containers";
  if (ch >= 68 && ch <= 71) return "ceramics, glass, stone, jewellery — containers, sometimes reefer";
  if (ch >= 72 && ch <= 83) return "metals — heavy containers or break-bulk";
  if (ch >= 84 && ch <= 85) return "machinery / electronics — high-value containers, electronics hubs preferred";
  if (ch >= 86 && ch <= 89) return "vehicles, aircraft, ships — ro-ro or specialty terminals";
  if (ch >= 90 && ch <= 92) return "precision instruments — high-value containers";
  return "general cargo";
}

// ─── System prompt ─────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a senior maritime logistics analyst. Given a country, a product (HS code), and a list of real container ports with their capacity rankings, pick the top 3 ports most likely to ship this product.

Selection rules:
1. Prefer ports with higher capacity_rank (real throughput data) UNLESS specialisation conflicts.
2. For electronics / high-tech (HS 84-85), prefer Shenzhen, Yantian, Ningbo, Kaohsiung.
3. For textiles / apparel (HS 50-63), prefer Shanghai, Ningbo, Chittagong, Karachi, Ho Chi Minh.
4. For machinery / autos (HS 84-87), prefer Shanghai, Yokohama, Busan, Hamburg.
5. For agriculture / bulk (HS 1-27), prefer ports with bulk terminals — Mumbai, Santos, Houston.
6. NEVER pick 3 ports that are essentially the same metro area (e.g. don't pick Shenzhen + Yantian + Shekou).
7. Each port's "rationale" must cite the HS chapter and capacity_rank — be concrete.

OUTPUT JSON schema (return exactly this, no markdown):
{
  "country_code": "CN",
  "ports": [
    {
      "locode": "CNSHA",
      "name": "Shanghai",
      "lat": 31.22,
      "lon": 121.50,
      "score": 0.95,
      "rationale": "Shanghai (rank 100) is China's largest container port and the world's #1 for HS 84-85 electronics — biggest dwell-time advantage for high-value cargo.",
      "specialization": "general containers, electronics, textiles"
    }
  ],
  "citations": ["UN/LOCODE", "GDELT (14d)"]
}`;

// ─── Agent ─────────────────────────────────────────────────────────────────

export class PortDiscovererAgent extends Agent {
  readonly name = "port-discoverer";
  readonly tier = "mercury" as const;

  async process(input: unknown): Promise<PortDiscovererOutput> {
    const { country_code, hs_code, shipmentId } = input as {
      country_code: string;
      hs_code?: string | null;
      shipmentId?: string;
    };

    const cc = country_code.toUpperCase();
    const cacheKey = `port-discoverer:v3:${cc}:${(hs_code ?? "").slice(0, 2)}`;
    const cached = await cache.get<PortDiscovererOutput>(cacheKey);
    if (cached) {
      await this.publishSignal({
        shipmentId,
        signalType: "ports_discovered",
        severity: "info",
        payload: cached as unknown as Record<string, unknown>,
        confidence: 0.85,
      });
      return cached;
    }

    // Pull every port from the UN/LOCODE table for this country (some countries
    // have 500+ entries — we need the full set so MAJOR_PORTS entries surface
    // ahead of obscure rank-0 ports).
    const all = await listPortsForCountry(cc, 2000);

    // Build the candidate list: prefer ports in MAJOR_PORTS, then fill from DB
    const candidates = all
      .filter((p) => p.latitude != null && p.longitude != null)
      .map((p) => ({
        locode: p.locode,
        name: p.name,
        lat: parseFloat(String(p.latitude)),
        lon: parseFloat(String(p.longitude)),
        capacity_rank: MAJOR_PORTS[p.locode] ?? 0,
      }))
      .sort((a, b) => b.capacity_rank - a.capacity_rank)
      .slice(0, 15);

    if (candidates.length === 0) {
      // Fallback: primary port for the country
      const fallback = await getPrimaryPortForCountry(cc);
      if (!fallback) {
        const empty: PortDiscovererOutput = {
          country_code: cc,
          ports: [
            {
              locode: cc,
              name: cc,
              lat: 0,
              lon: 0,
              score: 0,
              rationale: "No port data available for this country",
              specialization: "unknown",
            },
          ],
          citations: [],
        };
        await this.publishSignal({
          shipmentId,
          signalType: "ports_discovered",
          severity: "low",
          payload: empty as unknown as Record<string, unknown>,
          confidence: 0.2,
        });
        return empty;
      }
      const single: PortDiscovererOutput = {
        country_code: cc,
        ports: [
          {
            locode: fallback.locode,
            name: fallback.name,
            lat: parseFloat(String(fallback.latitude)),
            lon: parseFloat(String(fallback.longitude)),
            score: 0.6,
            rationale: `Fallback: primary port from UN/LOCODE for ${cc}`,
            specialization: "general",
          },
        ],
        citations: ["UN/LOCODE"],
      };
      await this.publishSignal({
        shipmentId,
        signalType: "ports_discovered",
        severity: "info",
        payload: single as unknown as Record<string, unknown>,
        confidence: 0.6,
      });
      return single;
    }

    // Enrich top 5 with recent GDELT news for the port name
    const top5 = candidates.slice(0, 5);
    const newsByPort = new Map<string, string>();
    await Promise.allSettled(
      top5.map(async (p) => {
        try {
          const res = await searchRecentGDELT(
            `"${p.name}" port (strike OR shutdown OR congestion OR disruption OR throughput OR upgrade)`,
            14,
            3
          );
          if (res.articles.length > 0) {
            newsByPort.set(
              p.locode,
              res.articles.slice(0, 2).map((a) => `- ${a.title}`).join("\n")
            );
          }
        } catch {
          // GDELT failures non-fatal — Mercury gets to decide without news
        }
      })
    );

    const candidateBlock = candidates
      .map(
        (p) =>
          `  ${p.locode} (${p.name}) lat=${p.lat.toFixed(2)} lon=${p.lon.toFixed(2)} capacity_rank=${p.capacity_rank}` +
          (newsByPort.has(p.locode) ? `\n    recent news:\n${newsByPort.get(p.locode)}` : "")
      )
      .join("\n");

    const hsContext = hsChapterContext(hs_code);

    const result = await this.callLLMValidated(
      [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content:
            `Country: ${cc}\n` +
            `HS code: ${hs_code ?? "unspecified"}\n` +
            `Cargo type fit: ${hsContext}\n\n` +
            `Candidate ports (UN/LOCODE registry, top 15 by capacity_rank):\n${candidateBlock}\n\n` +
            `Pick the top 3 distinct ports for shipping this product. Return JSON.`,
        },
      ],
      PortDiscovererOutput,
      { maxTokens: 1500 }
    );

    // Hard-validate: locodes must exist in our candidate set; coerce coords from DB
    const candidateMap = new Map(candidates.map((c) => [c.locode, c]));
    result.ports = result.ports
      .map((p) => {
        const real = candidateMap.get(p.locode);
        if (!real) return null;
        return { ...p, lat: real.lat, lon: real.lon, name: real.name };
      })
      .filter((p): p is NonNullable<typeof p> => p !== null);

    // If Mercury hallucinated unknown locodes and we ended up with < 1, fall back to top-3 by capacity
    if (result.ports.length === 0) {
      result.ports = candidates.slice(0, 3).map((c) => ({
        locode: c.locode,
        name: c.name,
        lat: c.lat,
        lon: c.lon,
        score: 0.5,
        rationale: `Fallback: top-capacity port (rank ${c.capacity_rank})`,
        specialization: "general",
      }));
    }

    await cache.set(cacheKey, result as unknown as object, 6 * 60 * 60);

    await this.publishSignal({
      shipmentId,
      signalType: "ports_discovered",
      severity: "info",
      payload: result as unknown as Record<string, unknown>,
      confidence: 0.85,
    });

    return result;
  }
}
