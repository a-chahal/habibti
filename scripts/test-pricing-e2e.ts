/**
 * E2E test for the new pricing chain:
 *   supplier-extracted → intent-parser estimate (small order) → Comtrade × intent weight → budget
 *
 * Run: npx tsx --env-file=.env scripts/test-pricing-e2e.ts
 */
import "dotenv/config";
import { orchestrator, registerAllAgents } from "../lib/agents/orchestrator";
import { IntentParserAgent } from "../lib/agents/intent-parser";
import { createShipment, getOptionsForShipment, getSignalsForShipment } from "../lib/db/queries";

async function runPricingE2E() {
  registerAllAgents();

  // The user's failing case: 10 pairs of selvedge jeans from Japan.
  // Expected total landed cost: ~$1.5K-$3K, NOT tens of thousands.
  const rawIntent = "I need 10 pairs of selvedge denim jeans from Japan to Los Angeles by Sep 1, 2026, budget $2,500";

  console.log("=== E2E PRICING: 10 jeans from Japan ===\n");
  console.log(`Raw intent: ${rawIntent}\n`);

  // Run intent-parser directly so we can see the new fields
  const parsed = (await new IntentParserAgent().run({ intent: rawIntent })) as any;
  console.log("Intent parser output:");
  console.log(`  hs_code:                 ${parsed.hs_code}`);
  console.log(`  quantity:                ${parsed.quantity} ${parsed.quantity_unit}`);
  console.log(`  origin_country:          ${parsed.origin_country}`);
  console.log(`  destination_port:        ${parsed.destination_port}`);
  console.log(`  unit_weight_kg_estimate: ${parsed.unit_weight_kg_estimate}`);
  console.log(`  unit_price_usd_estimate: ${parsed.unit_price_usd_estimate}`);
  console.log(`  estimate_confidence:     ${parsed.estimate_confidence}\n`);

  const intent = {
    ...parsed,
    raw_text: rawIntent,
    citations: [],
  };
  const productValueUsd = Math.round((intent.budget_usd ?? 2500) / 1.25);

  const ship = await createShipment({
    intent: { ...(intent as any), product_value_usd: productValueUsd },
    hs_code: intent.hs_code,
    origin_country: intent.origin_country,
    destination_country: intent.destination_country ?? "US",
    destination_port: intent.destination_port,
    expected_eta: intent.deadline_date ? new Date(intent.deadline_date) : new Date(Date.now() + 90 * 86_400_000),
    status: "pending",
  });

  console.log(`shipment id: ${ship.id}\n`);
  const t0 = Date.now();
  await orchestrator.runSourcingPipeline(ship.id, intent as any, productValueUsd);
  console.log(`\n=== PIPELINE COMPLETE in ${((Date.now() - t0) / 1000).toFixed(1)}s ===\n`);

  const options = await getOptionsForShipment(ship.id);
  const signals = await getSignalsForShipment(ship.id);
  const priceSignals = signals.filter((s: any) => s.agent_name === "product-pricer");
  const extractorSignals = signals.filter((s: any) => s.agent_name === "supplier-price-extractor");

  console.log(`supplier-price-extractor signals: ${extractorSignals.length}`);
  for (const s of extractorSignals as any[]) {
    const p = s.payload;
    console.log(`  ${p.country}: ${p.quotes?.length ?? 0} quotes, median=$${p.median_price_usd_per_unit}/unit, range=$${p.low_price_usd_per_unit}-$${p.high_price_usd_per_unit}`);
    for (const q of (p.quotes ?? []).slice(0, 4)) {
      console.log(`    • ${q.supplier_name}: $${q.price_usd_per_unit ?? "?"}/unit MOQ=${q.moq ?? "?"} (${q.notes ?? ""})`);
    }
  }

  console.log(`\nproduct-pricer signals: ${priceSignals.length}`);
  for (const s of priceSignals as any[]) {
    const p = s.payload;
    console.log(`  ${p.origin_country}: $${p.unit_price_usd_per_unit}/unit × ${p.quantity} = $${p.total_value_usd} (conf=${p.confidence}, source=${p.source})`);
  }

  console.log(`\nFinal ranked options (${options.length}):`);
  for (const o of options) {
    const cb = o.cost_breakdown as any;
    const rd = o.route_data as any;
    console.log(`\n  RANK ${o.rank} — ${o.country} via ${rd?.origin_port?.locode}`);
    console.log(`    product:    $${cb?.product_value_usd?.toLocaleString()}`);
    console.log(`    duty:       ${cb?.total_duty_pct}%`);
    console.log(`    freight:    $${cb?.freight_usd?.toLocaleString()}`);
    console.log(`    tolls:      $${cb?.canal_tolls_usd?.toLocaleString()}`);
    console.log(`    insurance:  $${cb?.insurance_usd?.toLocaleString()}`);
    console.log(`    broker:     $${cb?.broker_fee_usd?.toLocaleString()}`);
    console.log(`    TOTAL:      $${cb?.total_landed_cost_usd?.toLocaleString()}`);
  }

  console.log("\n=== ACCEPTANCE ===");
  const topCost = (options[0]?.cost_breakdown as any)?.total_landed_cost_usd ?? 0;
  console.log(`  intent has weight estimate: ${parsed.unit_weight_kg_estimate != null ? "✓" : "✗"} (${parsed.unit_weight_kg_estimate}kg/pair)`);
  console.log(`  intent has price estimate:  ${parsed.unit_price_usd_estimate != null ? "✓" : "✗"} ($${parsed.unit_price_usd_estimate}/pair)`);
  console.log(`  total landed cost:          $${topCost.toLocaleString()} ${topCost > 500 && topCost < 8000 ? "✓ sane" : "✗ off"}`);
  console.log(`  (sanity: 10 × $80-200 retail + ~$300 freight ≈ $1.1K-$2.3K)`);

  process.exit(0);
}

runPricingE2E().catch((e) => { console.error("PRICING E2E FAILED:", e); process.exit(1); });
