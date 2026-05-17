/**
 * E2E test for the supplier-discovery pipeline with a NON-CACHED, exotic prompt.
 * Run: npx tsx --env-file=.env scripts/test-supplier-discovery-e2e.ts
 */
import "dotenv/config";
import { orchestrator, registerAllAgents } from "../lib/agents/orchestrator";
import { createShipment, getOptionsForShipment, getSignalsForShipment } from "../lib/db/queries";

async function runE2E() {
  registerAllAgents();

  // Deliberately exotic AND replicating the user's failing case (Indonesia).
  const intent = {
    raw_text: "I need 1,200 rattan furniture pieces from Indonesia to NYC by Oct 1, 2026, budget $55,000",
    hs_code: "940150",
    product_description: "handwoven rattan furniture (chairs, tables)",
    quantity: 1200,
    quantity_unit: "unit",
    budget_usd: 55_000,
    deadline_date: "2026-10-01",
    destination_port: "USNYC",
    destination_country: "US",
    origin_country: "ID",
    supplier: null,
    clarification_needed: null,
    citations: [],
  };

  const productValueUsd = Math.round(intent.budget_usd / 1.25);

  console.log("=== E2E: Alpaca wool blankets from Peru → Miami ===\n");

  const ship = await createShipment({
    intent: { ...(intent as any), product_value_usd: productValueUsd },
    hs_code: intent.hs_code,
    origin_country: intent.origin_country,
    destination_country: intent.destination_country,
    destination_port: intent.destination_port,
    expected_eta: new Date(intent.deadline_date),
    status: "pending",
  });

  console.log(`shipment id: ${ship.id}\n`);

  const t0 = Date.now();
  await orchestrator.runSourcingPipeline(ship.id, intent as any, productValueUsd);
  const totalMs = Date.now() - t0;

  console.log(`\n=== PIPELINE COMPLETE in ${(totalMs / 1000).toFixed(1)}s ===\n`);

  const options = await getOptionsForShipment(ship.id);
  const signals = await getSignalsForShipment(ship.id);

  const discoverySignals = signals.filter((s: any) => s.agent_name === "supplier-discoverer");
  console.log(`supplier-discoverer signals: ${discoverySignals.length}`);
  for (const s of discoverySignals as any[]) {
    const p = s.payload;
    console.log(`  country=${p.country}  found=${p.suppliers?.length ?? 0}  citations=${p.citations?.length ?? 0}`);
    for (const sup of (p.suppliers ?? []).slice(0, 3)) {
      console.log(`    • ${sup.name} | ${sup.city ?? "?"} | site=${sup.website ?? "—"} | conf=${sup.confidence} | gleif=${sup.registry_verified ?? "?"}`);
      console.log(`      evidence: ${sup.evidence_url ?? "—"}`);
    }
  }

  console.log(`\nFinal ranked options (${options.length}):`);
  for (const o of options) {
    const rd = o.route_data as any;
    const suppliers = rd?.suppliers ?? [];
    console.log(`\n  RANK ${o.rank} — ${o.country} via ${rd?.origin_port?.locode}`);
    console.log(`    route: ${rd?.total_distance_nm}nm, ${rd?.total_transit_days}d`);
    console.log(`    suppliers on this option: ${suppliers.length}`);
    for (const s of suppliers.slice(0, 3)) {
      console.log(`      • ${s.name} — ${s.website ?? "no site"}`);
    }
    console.log(`    reasoning: ${o.reasoning?.slice(0, 240)}…`);
  }

  // Verify URLs are live for the top option's suppliers
  const topOpt = options.find((o) => o.rank === 1);
  const topSuppliers = (topOpt?.route_data as any)?.suppliers ?? [];
  if (topSuppliers.length > 0) {
    console.log(`\n=== URL VERIFICATION (rank-1 suppliers) ===`);
    for (const s of topSuppliers.slice(0, 4)) {
      const url = s.evidence_url ?? s.website;
      if (!url) { console.log(`  ${s.name.padEnd(40)} — NO URL`); continue; }
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(8000), redirect: "follow" });
        console.log(`  ${s.name.padEnd(40)} ${url.slice(0, 60).padEnd(62)} HTTP ${res.status}`);
      } catch (e: any) {
        console.log(`  ${s.name.padEnd(40)} ${url.slice(0, 60).padEnd(62)} FAIL ${e.message?.slice(0, 30)}`);
      }
    }
  }

  // Acceptance
  console.log("\n=== ACCEPTANCE ===");
  const totalSuppliers = options.reduce((n, o) => n + ((o.route_data as any)?.suppliers?.length ?? 0), 0);
  console.log(`  options:           ${options.length} ${options.length === 3 ? "✓" : "✗ expected 3"}`);
  console.log(`  total suppliers:   ${totalSuppliers} ${totalSuppliers >= 4 ? "✓" : "✗ expected ≥4"}`);
  console.log(`  discovery signals: ${discoverySignals.length} ${discoverySignals.length >= 1 ? "✓" : "✗ expected ≥1"}`);

  process.exit(0);
}

runE2E().catch((e) => { console.error("E2E FAILED:", e); process.exit(1); });
