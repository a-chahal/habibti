import { eq, and, sql } from "drizzle-orm";
import { db } from "../db/client";
import { locations } from "../db/schema";
import { callMercury } from "../llm/openrouter";
import { cache } from "../cache";
import { z } from "zod";

export interface PortLocation {
  locode: string;
  name: string;
  country_code: string;
  lat: number;
  lng: number;
}

export async function getByLocode(locode: string): Promise<PortLocation | null> {
  const row = await db.query.locations.findFirst({
    where: eq(locations.locode, locode.toUpperCase()),
  });
  if (!row || row.latitude == null || row.longitude == null) return null;
  return {
    locode: row.locode,
    name: row.name,
    country_code: row.country_code,
    lat: parseFloat(String(row.latitude)),
    lng: parseFloat(String(row.longitude)),
  };
}

export async function resolvePort(
  name: string,
  country?: string
): Promise<PortLocation | null> {
  // 1. Try exact locode lookup (name might already be a 5-char locode)
  if (/^[A-Z]{5}$/.test(name.toUpperCase())) {
    const byCode = await getByLocode(name);
    if (byCode) return byCode;
  }

  // 2. Exact name match within country
  if (country) {
    const exact = await db.query.locations.findFirst({
      where: and(
        eq(locations.is_port, true),
        eq(locations.country_code, country.toUpperCase()),
        sql`lower(${locations.name}) = lower(${name})`
      ),
    });
    if (exact?.latitude != null) {
      return {
        locode: exact.locode,
        name: exact.name,
        country_code: exact.country_code,
        lat: parseFloat(String(exact.latitude)),
        lng: parseFloat(String(exact.longitude)),
      };
    }
  }

  // 3. Fuzzy LIKE match (name contains)
  const fuzzy = await db.query.locations.findFirst({
    where: and(
      eq(locations.is_port, true),
      country ? eq(locations.country_code, country.toUpperCase()) : undefined,
      sql`lower(${locations.name}) like lower(${"%" + name + "%"})`
    ),
  });
  if (fuzzy?.latitude != null) {
    return {
      locode: fuzzy.locode,
      name: fuzzy.name,
      country_code: fuzzy.country_code,
      lat: parseFloat(String(fuzzy.latitude)),
      lng: parseFloat(String(fuzzy.longitude)),
    };
  }

  // 4. Reverse: search by locode prefix (country code + first chars)
  if (name.length >= 2) {
    const prefix = await db.query.locations.findFirst({
      where: and(
        eq(locations.is_port, true),
        sql`lower(${locations.locode}) like lower(${"%" + name.slice(0, 5) + "%"})`
      ),
    });
    if (prefix?.latitude != null) {
      return {
        locode: prefix.locode,
        name: prefix.name,
        country_code: prefix.country_code,
        lat: parseFloat(String(prefix.latitude)),
        lng: parseFloat(String(prefix.longitude)),
      };
    }
  }

  return null;
}

// Well-known fallbacks for the demo — avoids DB miss for hard-coded port codes
const KNOWN_PORTS: Record<string, PortLocation> = {
  USLAX: { locode: "USLAX", name: "Los Angeles", country_code: "US", lat: 33.7295, lng: -118.2620 },
  USLGB: { locode: "USLGB", name: "Long Beach", country_code: "US", lat: 33.7476, lng: -118.2169 },
  USNYC: { locode: "USNYC", name: "New York", country_code: "US", lat: 40.6840, lng: -74.0440 },
  USMIA: { locode: "USMIA", name: "Miami", country_code: "US", lat: 25.7780, lng: -80.1796 },
  USSEA: { locode: "USSEA", name: "Seattle", country_code: "US", lat: 47.6062, lng: -122.3321 },
  USHOU: { locode: "USHOU", name: "Houston", country_code: "US", lat: 29.7232, lng: -95.0143 },
  USSAV: { locode: "USSAV", name: "Savannah", country_code: "US", lat: 32.0809, lng: -81.0912 },
  USCHS: { locode: "USCHS", name: "Charleston", country_code: "US", lat: 32.7833, lng: -79.9333 },
  USOAK: { locode: "USOAK", name: "Oakland", country_code: "US", lat: 37.7956, lng: -122.2786 },
  USBAL: { locode: "USBAL", name: "Baltimore", country_code: "US", lat: 39.2647, lng: -76.5760 },
  USORF: { locode: "USORF", name: "Norfolk (Hampton Roads)", country_code: "US", lat: 36.8508, lng: -76.3289 },
  USTPA: { locode: "USTPA", name: "Tampa", country_code: "US", lat: 27.9447, lng: -82.4476 },
  VNSGN: { locode: "VNSGN", name: "Ho Chi Minh City", country_code: "VN", lat: 10.8231, lng: 106.6297 },
  IDTPP: { locode: "IDTPP", name: "Tanjung Priok", country_code: "ID", lat: -6.1045, lng: 106.8808 },
  CNSGH: { locode: "CNSGH", name: "Shanghai", country_code: "CN", lat: 31.2222, lng: 121.4965 },
  SGSIN: { locode: "SGSIN", name: "Singapore", country_code: "SG", lat: 1.2655, lng: 103.8239 },
  EGPSD: { locode: "EGPSD", name: "Port Said", country_code: "EG", lat: 31.2580, lng: 32.2844 },
  GBFXT: { locode: "GBFXT", name: "Felixstowe", country_code: "GB", lat: 51.9552, lng: 1.3510 },
  NLRTM: { locode: "NLRTM", name: "Rotterdam", country_code: "NL", lat: 51.9225, lng: 4.4792 },
};

// ─── LLM-based resolver — last-resort lookup for unknown locodes ───────────
// Caches forever (1 year) since ports don't move. Returns null on failure.

const LLMPortSchema = z.object({
  found: z.boolean(),
  name: z.string().nullable(),
  country_code: z.string().length(2).nullable(),
  lat: z.number().min(-90).max(90).nullable(),
  lon: z.number().min(-180).max(180).nullable(),
  is_seaport: z.boolean(),
});

async function resolvePortViaLLM(
  nameOrLocode: string,
  countryHint?: string
): Promise<PortLocation | null> {
  const cacheKey = `port-resolve:v1:${nameOrLocode.toUpperCase()}:${(countryHint ?? "").toUpperCase()}`;
  const cached = await cache.get<PortLocation | { _miss: true }>(cacheKey);
  if (cached) {
    if ((cached as any)._miss) return null;
    return cached as PortLocation;
  }

  const messages = [
    {
      role: "system" as const,
      content:
        'You resolve UN/LOCODE port references to coordinates. Given a place name or 5-character UN/LOCODE, return its details. ' +
        'Set is_seaport=true only if this is an ocean/sea cargo port (not inland river, not airport, not generic city). ' +
        'Return JSON ONLY, no markdown, no commentary. Schema: ' +
        '{"found": boolean, "name": string|null, "country_code": "XX"|null, "lat": number|null, "lon": number|null, "is_seaport": boolean}. ' +
        "If you don't know the place, return found=false.",
    },
    {
      role: "user" as const,
      content: `Resolve: "${nameOrLocode}"${countryHint ? ` (country hint: ${countryHint})` : ""}`,
    },
  ];

  const tryOnce = async (): Promise<string> =>
    callMercury(messages, { json: true, maxTokens: 350 });

  const sanitise = (s: string): string =>
    s.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();

  try {
    let raw = sanitise(await tryOnce());
    let parsed: z.infer<typeof LLMPortSchema>;
    try {
      parsed = LLMPortSchema.parse(JSON.parse(raw));
    } catch {
      raw = sanitise(await tryOnce());
      parsed = LLMPortSchema.parse(JSON.parse(raw));
    }
    if (!parsed.found || !parsed.is_seaport || parsed.lat == null || parsed.lon == null) {
      await cache.set(cacheKey, { _miss: true } as any, 7 * 24 * 60 * 60); // 7-day negative cache
      return null;
    }
    const upper = nameOrLocode.toUpperCase();
    // If input wasn't a 5-char locode, fabricate one only if Mercury didn't give us a country
    const locode = /^[A-Z]{5}$/.test(upper) ? upper : `${parsed.country_code ?? "XX"}${upper.slice(0, 3).padEnd(3, "X")}`;
    const result: PortLocation = {
      locode,
      name: parsed.name ?? nameOrLocode,
      country_code: parsed.country_code ?? countryHint?.toUpperCase() ?? "XX",
      lat: parsed.lat,
      lng: parsed.lon,
    };
    await cache.set(cacheKey, result, 365 * 24 * 60 * 60); // 1y positive cache
    return result;
  } catch (err: any) {
    console.warn(`[locations] LLM port resolve failed for ${nameOrLocode}: ${err.message}`);
    await cache.set(cacheKey, { _miss: true } as any, 60 * 60); // 1h negative cache on error
    return null;
  }
}

/**
 * Resolve a port name or LOCODE using a tiered chain:
 *   1. KNOWN_PORTS dict — instant, zero cost
 *   2. UN/LOCODE DB — fast, ~thousands of real ports
 *   3. Mercury LLM lookup — for anything else; cached for 1 year
 */
export async function resolvePortWithFallback(
  nameOrLocode: string,
  country?: string
): Promise<PortLocation | null> {
  const upper = nameOrLocode.toUpperCase();
  if (KNOWN_PORTS[upper]) return KNOWN_PORTS[upper];
  try {
    const fromDb = await resolvePort(nameOrLocode, country);
    if (fromDb) return fromDb;
  } catch {
    // fall through to LLM resolver
  }
  return resolvePortViaLLM(nameOrLocode, country);
}
