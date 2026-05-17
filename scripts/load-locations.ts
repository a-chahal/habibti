/**
 * load-locations.ts
 *
 * Downloads the UN/LOCODE dataset from GitHub and ingests port-relevant
 * entries into the `locations` table. Idempotent — safe to re-run.
 *
 * Source: https://github.com/datasets/un-locode
 * CSV columns: Change,Country,Location,Name,NameWoDiacritics,Subdivision,Status,Function,Date,IATA,Coordinates,Remarks
 *
 * Function code position 0 = "1" → maritime port.
 * Coordinates format: "DDMMH DDDMMH" where H is N/S/E/W.
 */

import "dotenv/config";
import { db } from "../lib/db/client";
import { locations } from "../lib/db/schema";

const CSV_URL =
  "https://raw.githubusercontent.com/datasets/un-locode/main/data/code-list.csv";

// Parse a DMS coordinate string like "1055N 10645E" → [lat, lon]
function parseDMS(raw: string): [number, number] | null {
  const parts = raw.trim().split(/\s+/);
  if (parts.length !== 2) return null;

  const [latStr, lonStr] = parts;
  if (!latStr || !lonStr) return null;

  const latHem = latStr.slice(-1).toUpperCase();
  const latNum = latStr.slice(0, -1);
  if (latNum.length < 3) return null;
  const latDeg = parseInt(latNum.slice(0, -2), 10);
  const latMin = parseInt(latNum.slice(-2), 10);
  if (isNaN(latDeg) || isNaN(latMin)) return null;
  let lat = latDeg + latMin / 60;
  if (latHem === "S") lat = -lat;

  const lonHem = lonStr.slice(-1).toUpperCase();
  const lonNum = lonStr.slice(0, -1);
  if (lonNum.length < 3) return null;
  const lonDeg = parseInt(lonNum.slice(0, -2), 10);
  const lonMin = parseInt(lonNum.slice(-2), 10);
  if (isNaN(lonDeg) || isNaN(lonMin)) return null;
  let lon = lonDeg + lonMin / 60;
  if (lonHem === "W") lon = -lon;

  if (!isFinite(lat) || !isFinite(lon)) return null;
  return [lat, lon];
}

// Minimal CSV row parser — handles quoted fields
function parseCSVLine(line: string): string[] {
  const fields: string[] = [];
  let cur = "";
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      inQuote = !inQuote;
    } else if (c === "," && !inQuote) {
      fields.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  fields.push(cur);
  return fields;
}

async function main() {
  console.log("[load-locations] Downloading UN/LOCODE CSV…");
  const res = await fetch(CSV_URL);
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching UN/LOCODE`);
  const text = await res.text();

  const lines = text.split("\n");
  console.log(`[load-locations] ${lines.length} lines in CSV`);

  // Skip header row
  const rows = lines.slice(1);

  const batch: (typeof locations.$inferInsert)[] = [];
  let skippedNoCoords = 0;
  let skippedNotPort = 0;
  let parsed = 0;

  for (const line of rows) {
    if (!line.trim()) continue;
    const cols = parseCSVLine(line);
    if (cols.length < 11) continue;

    // cols: Change, Country, Location, Name, NameWoDiacritics, Subdivision, Status, Function, Date, IATA, Coordinates, Remarks
    const country = cols[1]?.trim();
    const location = cols[2]?.trim();
    const name = (cols[4]?.trim() || cols[3]?.trim()); // prefer NameWoDiacritics
    const subdivision = cols[5]?.trim() || null;
    const functionCode = cols[7]?.trim() || "";
    const coordsRaw = cols[10]?.trim();

    if (!country || !location || !name) continue;

    // Only ingest maritime ports (function position 0 === "1")
    const isPort = functionCode.charAt(0) === "1";
    if (!isPort) {
      skippedNotPort++;
      continue;
    }

    if (!coordsRaw) {
      skippedNoCoords++;
      continue;
    }

    const coords = parseDMS(coordsRaw);
    if (!coords) {
      skippedNoCoords++;
      continue;
    }

    const locode = `${country}${location}`;
    batch.push({
      locode,
      name,
      country_code: country,
      subdivision: subdivision || null,
      function_codes: functionCode,
      latitude: coords[0].toFixed(6),
      longitude: coords[1].toFixed(6),
      is_port: true,
    });
    parsed++;

    // Insert in batches of 500 — deduplicate within batch by locode
    if (batch.length >= 500) {
      const seen = new Set<string>();
      const deduped = batch.filter((r) => {
        if (seen.has(r.locode)) return false;
        seen.add(r.locode);
        return true;
      });
      await db
        .insert(locations)
        .values(deduped)
        .onConflictDoUpdate({
          target: locations.locode,
          set: {
            name: locations.name,
            latitude: locations.latitude,
            longitude: locations.longitude,
            function_codes: locations.function_codes,
          },
        });
      process.stdout.write(`\r[load-locations] Inserted ${parsed} ports…`);
      batch.length = 0;
    }
  }

  // Flush remaining — deduplicate final batch
  if (batch.length > 0) {
    const seen = new Set<string>();
    const deduped = batch.filter((r) => {
      if (seen.has(r.locode)) return false;
      seen.add(r.locode);
      return true;
    });
    await db
      .insert(locations)
      .values(deduped)
      .onConflictDoUpdate({
        target: locations.locode,
        set: {
          name: locations.name,
          latitude: locations.latitude,
          longitude: locations.longitude,
          function_codes: locations.function_codes,
        },
      });
  }

  console.log(
    `\n[load-locations] Done. Inserted/updated ${parsed} maritime port locations.`
  );
  console.log(
    `[load-locations] Skipped: ${skippedNotPort} non-ports, ${skippedNoCoords} missing coords`
  );

  // Spot-check USLAX
  const { db: dbConn } = await import("../lib/db/client");
  const result = await dbConn.query.locations.findFirst({
    where: (l, { eq }) => eq(l.locode, "USLAX"),
  });
  if (result) {
    console.log(`[load-locations] ✅ USLAX: ${result.name} @ ${result.latitude}, ${result.longitude}`);
  } else {
    console.log("[load-locations] ⚠ USLAX not found — check function code filtering");
  }

  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
