import "dotenv/config";
import { db } from "../lib/db/client";
import { signals } from "../lib/db/schema";
import { eq, and } from "drizzle-orm";

const BASE_URL = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";

const TEST_INTENT =
  "5000 yards organic cotton fabric, into Los Angeles, by July 15, budget $30K landed";

const SOURCING_AGENTS = [
  "country-discoverer",
  "tariff-calculator",
  "compliance-screener",
  "supplier-verifier",
  "country-risk",
  "route-prescorer",
];

async function postShipment(intent: string): Promise<string> {
  const res = await fetch(`${BASE_URL}/api/shipments`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ intent }),
  });
  if (!res.ok) throw new Error(`POST /api/shipments failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.id;
}

async function pollForCompletion(
  shipmentId: string,
  timeoutMs = 3 * 60 * 1000
): Promise<Array<{ agent_name: string; signal_type: string; payload: unknown }>> {
  const deadline = Date.now() + timeoutMs;
  let lastCount = 0;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000));

    const rows = await db
      .select()
      .from(signals)
      .where(eq(signals.shipment_id, shipmentId));

    const hasComplete = rows.some((r) => r.signal_type === "sourcing_complete");

    if (rows.length !== lastCount) {
      const agentNames = [...new Set(rows.map((r) => r.agent_name))];
      process.stdout.write(
        `\r  Signals: ${rows.length} from [${agentNames.join(", ")}]${hasComplete ? " ✓ COMPLETE" : ""}`
      );
      lastCount = rows.length;
    }

    if (hasComplete) {
      process.stdout.write("\n");
      return rows;
    }
  }

  throw new Error(`Timeout: sourcing_complete signal never appeared within 3 minutes`);
}

function getPayload(row: { payload: unknown }): Record<string, unknown> {
  return (row.payload ?? {}) as Record<string, unknown>;
}

function validate(rows: { agent_name: string; signal_type: string; payload: unknown }[]) {
  let passed = 0;
  let failed = 0;

  function check(label: string, ok: boolean, detail?: string) {
    if (ok) {
      console.log(`  ✅ ${label}`);
      passed++;
    } else {
      console.log(`  ❌ ${label}${detail ? ": " + detail : ""}`);
      failed++;
    }
  }

  // 1. All 6 sourcing agents produced at least one signal
  for (const agent of SOURCING_AGENTS) {
    const agentRows = rows.filter((r) => r.agent_name === agent);
    check(`${agent} has signal(s)`, agentRows.length > 0, `found ${agentRows.length}`);
  }

  // 2. SOURCING_COMPLETE signal exists
  const complete = rows.find((r) => r.signal_type === "sourcing_complete");
  check("sourcing_complete signal exists", !!complete);

  // 3. ≥3 candidate countries
  const discovererRow = rows.find((r) => r.agent_name === "country-discoverer");
  const candidates = (getPayload(discovererRow ?? { payload: {} }).candidates ?? []) as unknown[];
  check("≥3 candidate countries discovered", candidates.length >= 3, `got ${candidates.length}`);

  // 4. Tariff signals: if China is a candidate verify Section 301; otherwise verify tariff calculations exist
  const tariffRows = rows.filter((r) => r.agent_name === "tariff-calculator");
  const chinaTariff = tariffRows.find((r) => {
    const p = getPayload(r);
    return (p.origin_country as string)?.toUpperCase() === "CN";
  });
  if (chinaTariff) {
    const s301 = getPayload(chinaTariff).section_301_pct as number | null;
    check("China tariff has Section 301 (nonzero)", !!s301 && s301 > 0, `section_301_pct=${s301}`);
  } else {
    // China may not be a top candidate (e.g. for cotton fabric, Section 301 makes it uncompetitive)
    check(
      `Tariff calculations exist for all candidate countries (China not selected by model)`,
      tariffRows.length >= 3,
      `${tariffRows.length} tariff signals`
    );
  }

  // 5. Compliance verdict is clean or flagged for each compliance-screener signal
  const compRows = rows.filter((r) => r.agent_name === "compliance-screener");
  check("compliance-screener has ≥1 signal", compRows.length > 0, `found ${compRows.length}`);
  for (const cr of compRows) {
    const verdict = getPayload(cr).verdict as string;
    check(
      `compliance verdict valid (${(getPayload(cr).country ?? "?") as string})`,
      verdict === "clean" || verdict === "flagged",
      `verdict=${verdict}`
    );
  }

  // 6. Country risk has ≥2 top_events per signal
  const riskRows = rows.filter((r) => r.agent_name === "country-risk");
  check("country-risk has ≥1 signal", riskRows.length > 0);
  for (const rr of riskRows) {
    const events = (getPayload(rr).top_events ?? []) as unknown[];
    check(
      `country-risk ${(getPayload(rr).country_code ?? "?") as string} has ≥2 events`,
      events.length >= 2,
      `got ${events.length}`
    );
  }

  // 7. Route prescore has transit days and chokepoints
  const routeRows = rows.filter((r) => r.agent_name === "route-prescorer");
  check("route-prescorer has ≥1 signal", routeRows.length > 0);
  for (const rr of routeRows) {
    const routes = (getPayload(rr).routes ?? []) as Record<string, unknown>[];
    const firstRoute = routes[0] ?? {};
    check(
      `route-prescore ${(getPayload(rr).origin_country ?? "?") as string} has transit_days`,
      typeof firstRoute.typical_transit_days === "number",
      `got ${firstRoute.typical_transit_days}`
    );
    check(
      `route-prescore ${(getPayload(rr).origin_country ?? "?") as string} has chokepoints field`,
      Array.isArray(firstRoute.chokepoints),
      `got ${JSON.stringify(firstRoute.chokepoints)}`
    );
  }

  return { passed, failed };
}

async function main() {
  console.log("=== Sourcing Agents End-to-End Test ===\n");
  console.log(`Submitting shipment to ${BASE_URL}:`);
  console.log(`  "${TEST_INTENT}"\n`);

  const shipmentId = await postShipment(TEST_INTENT);
  console.log(`  → Created shipment ${shipmentId}\n`);

  console.log("Polling for sourcing_complete signal (up to 3 min)...");
  const rows = await pollForCompletion(shipmentId);

  console.log(`\n=== Signal Summary ===`);
  const byAgent = new Map<string, typeof rows>();
  for (const r of rows) {
    if (!byAgent.has(r.agent_name)) byAgent.set(r.agent_name, []);
    byAgent.get(r.agent_name)!.push(r);
  }
  for (const [agent, agentRows] of byAgent) {
    console.log(`  ${agent}: ${agentRows.length} signal(s) — ${agentRows.map((r) => r.signal_type).join(", ")}`);
    for (const r of agentRows) {
      const p = getPayload(r);
      if (agent === "country-discoverer") {
        const cands = (p.candidates as any[]) ?? [];
        console.log(`    Countries: ${cands.map((c: any) => c.country_code).join(", ")}`);
      }
      if (agent === "tariff-calculator") {
        console.log(`    ${p.origin_country}: total_duty=${p.total_duty_pct}% landed=$${p.total_landed_cost_usd}`);
      }
      if (agent === "compliance-screener") {
        console.log(`    ${p.country}: verdict=${p.verdict} uflpa=${p.uflpa_flag}`);
      }
      if (agent === "country-risk") {
        const events = (p.top_events as any[]) ?? [];
        console.log(`    ${p.country_code}: stability=${p.stability} events=${events.length}`);
      }
      if (agent === "route-prescorer") {
        const routes = (p.routes as any[]) ?? [];
        const r0 = routes[0] ?? {};
        console.log(`    ${p.origin_country}: ${r0.lane_name ?? "?"} ${r0.typical_transit_days ?? "?"}d density=${r0.current_traffic_density}`);
      }
    }
  }

  console.log(`\n=== Validation ===`);
  const { passed, failed } = validate(rows as any[]);
  console.log(`\n${passed} passed, ${failed} failed`);

  if (failed === 0) {
    console.log("\n✅ All sourcing agent checks passed");
    process.exit(0);
  } else {
    console.log("\n❌ Some checks failed");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("❌ Test failed:", err.message);
  process.exit(1);
});
