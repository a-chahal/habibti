import "dotenv/config";
import { db } from "../lib/db/client";
import { sanctions_entities } from "../lib/db/schema";
import { sql } from "drizzle-orm";
import * as fs from "fs";
import * as path from "path";

const OFAC_SDN_URL = "https://www.treasury.gov/ofac/downloads/sdn.csv";

function parseOfacCSV(csv: string): Array<{
  name: string;
  entity_type: string;
  country: string;
  listing_date: string;
  reason: string;
  raw: string;
}> {
  const lines = csv.split("\n");
  const entities: ReturnType<typeof parseOfacCSV> = [];

  for (const line of lines) {
    if (!line.trim()) continue;
    // SDN CSV format: SDN_ID, SDN_NAME, SDN_TYPE, PROGRAM, TITLE, CALL_SIGN,
    //                 VES_TYPE, TONAGE, GRT, VESS_FLAG, VESS_OWNER, REMARKS
    const cols = line.split(",").map((c) => c.replace(/^"|"$/g, "").trim());
    if (cols.length < 4) continue;
    // col[0] = numeric ID, col[1] = name, col[2] = type, col[3] = program
    const name = cols[1];
    const type = cols[2]?.toLowerCase() ?? "unknown";
    if (!name || name === "-0-") continue;

    // Country from remarks col[11]
    const remarks = cols[11] ?? "";
    const countryMatch = remarks.match(/POB\s+([A-Z]{2})/);

    entities.push({
      name,
      entity_type: type === "individual" ? "individual" : "company",
      country: countryMatch?.[1] ?? "",
      listing_date: "",
      reason: cols[3] ?? "",
      raw: line,
    });
  }
  return entities;
}

async function loadOFAC(): Promise<number> {
  console.log("Downloading OFAC SDN list...");
  const res = await fetch(OFAC_SDN_URL);
  if (!res.ok) throw new Error(`Failed to fetch OFAC SDN: ${res.status}`);
  const csv = await res.text();

  const entities = parseOfacCSV(csv);
  console.log(`Parsed ${entities.length} OFAC entities`);

  let loaded = 0;
  const BATCH = 200;
  for (let i = 0; i < entities.length; i += BATCH) {
    const batch = entities.slice(i, i + BATCH);
    await db
      .insert(sanctions_entities)
      .values(
        batch.map((e) => ({
          name: e.name,
          aliases: [],
          country: e.country || null,
          list_source: "ofac" as const,
          entity_type: e.entity_type,
          listing_date: e.listing_date || null,
          reason: e.reason || null,
          raw_data: { raw: e.raw },
        }))
      )
      .onConflictDoNothing();
    loaded += batch.length;
  }
  return loaded;
}

async function loadUFLPA(): Promise<number> {
  const uflpaPath = path.join(process.cwd(), "data/sanctions/uflpa.json");
  const raw = fs.readFileSync(uflpaPath, "utf-8");
  const entities: Array<{
    name: string;
    country: string;
    entity_type: string;
    listing_date: string;
    reason: string;
  }> = JSON.parse(raw);

  await db
    .insert(sanctions_entities)
    .values(
      entities.map((e) => ({
        name: e.name,
        aliases: [],
        country: e.country,
        list_source: "uflpa" as const,
        entity_type: e.entity_type,
        listing_date: e.listing_date,
        reason: e.reason,
        raw_data: e,
      }))
    )
    .onConflictDoNothing();

  return entities.length;
}

async function main() {
  try {
    const [ofacCount, uflpaCount] = await Promise.all([loadOFAC(), loadUFLPA()]);

    // Count what's actually in DB
    const [ofacRow] = await db
      .select({ count: sql<number>`count(*)` })
      .from(sanctions_entities)
      .where(sql`list_source = 'ofac'`);
    const [uflpaRow] = await db
      .select({ count: sql<number>`count(*)` })
      .from(sanctions_entities)
      .where(sql`list_source = 'uflpa'`);

    console.log(
      `✅ Loaded ${Number(ofacRow.count)} OFAC entities, ${Number(uflpaRow.count)} UFLPA entities`
    );
    process.exit(0);
  } catch (err) {
    console.error("❌ load-sanctions failed:", err);
    process.exit(1);
  }
}

main();
