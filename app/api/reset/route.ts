import { NextResponse } from "next/server";
import { db } from "@/lib/db/client";
import { sql } from "drizzle-orm";

// Truncate all shipment-related tables in dependency order.
// Preserves: cache, locations, sanctions_entities (reference data).
export async function POST() {
  try {
    await db.execute(sql`TRUNCATE TABLE alerts, beliefs, signals, dispatches, supplier_history, route_history, options, suppliers, shipments RESTART IDENTITY CASCADE`);
    return NextResponse.json({ ok: true });
  } catch (err: any) {
    console.error("Reset failed:", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
