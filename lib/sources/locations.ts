import { eq, and, sql } from "drizzle-orm";
import { db } from "../db/client";
import { locations } from "../db/schema";

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
  VNSGN: { locode: "VNSGN", name: "Ho Chi Minh City", country_code: "VN", lat: 10.8231, lng: 106.6297 },
  IDTPP: { locode: "IDTPP", name: "Tanjung Priok", country_code: "ID", lat: -6.1045, lng: 106.8808 },
  CNSGH: { locode: "CNSGH", name: "Shanghai", country_code: "CN", lat: 31.2222, lng: 121.4965 },
  SGSIN: { locode: "SGSIN", name: "Singapore", country_code: "SG", lat: 1.2655, lng: 103.8239 },
  EGPSD: { locode: "EGPSD", name: "Port Said", country_code: "EG", lat: 31.2580, lng: 32.2844 },
  GBFXT: { locode: "GBFXT", name: "Felixstowe", country_code: "GB", lat: 51.9552, lng: 1.3510 },
  NLRTM: { locode: "NLRTM", name: "Rotterdam", country_code: "NL", lat: 51.9225, lng: 4.4792 },
};

export async function resolvePortWithFallback(
  nameOrLocode: string,
  country?: string
): Promise<PortLocation | null> {
  const upper = nameOrLocode.toUpperCase();
  if (KNOWN_PORTS[upper]) return KNOWN_PORTS[upper];
  try {
    return await resolvePort(nameOrLocode, country);
  } catch {
    return KNOWN_PORTS[upper] ?? null;
  }
}
