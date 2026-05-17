/**
 * E2E test for the multi-modality freight pipeline.
 * Runs 5 diverse cases (different cargo sizes, products, countries) and verifies
 * that the modality matrix + ranked options behave sensibly.
 *
 * Run: npx tsx --env-file=.env scripts/test-modalities-e2e.ts
 */
import "dotenv/config";
import { orchestrator, registerAllAgents } from "../lib/agents/orchestrator";
import { IntentParserAgent } from "../lib/agents/intent-parser";
import { createShipment, getOptionsForShipment, getSignalsForShipment } from "../lib/db/queries";

interface Scenario {
  label: string;
  raw: string;
  expectModality: "fcl" | "lcl" | "air" | "mixed"; // expected dominant modality in top 3
  expectMinTotal: number;
  expectMaxTotal: number;
}

const SCENARIOS: Scenario[] = [
  // Tiny order: should ship air courier, total ~$1-3K
  {
    label: "tiny — 10 selvedge jeans from Japan",
    raw: "I need 10 pairs of selvedge denim jeans from Japan to Los Angeles by Sep 1, 2026, budget $2,500",
    expectModality: "air",
    expectMinTotal: 800,
    expectMaxTotal: 4000,
  },
  // Mid order: 500 t-shirts ~100kg — LCL vs Air should both surface
  {
    label: "mid — 500 cotton t-shirts from India",
    raw: "I need 500 cotton t-shirts from India to New York by Sep 30, 2026, budget $8,000",
    expectModality: "mixed",
    expectMinTotal: 2000,
    expectMaxTotal: 20000,
  },
  // Bulk furniture: should pick FCL, big total
  {
    label: "bulk — 1200 rattan chairs from Indonesia",
    raw: "I need 1,200 handwoven rattan chairs from Indonesia to Miami by Oct 15, 2026, budget $60,000",
    expectModality: "fcl",
    expectMinTotal: 40000,
    expectMaxTotal: 150000,
  },
  // Specialty: 200 leather handbags from Italy — mid-weight, mixed
  {
    label: "specialty — 200 leather handbags from Italy",
    raw: "I need 200 leather handbags from Italy to Chicago by Aug 15, 2026, budget $30,000",
    expectModality: "mixed",
    expectMinTotal: 8000,
    expectMaxTotal: 60000,
  },
  // Heavy bulk: 30k lithium cells China — FCL dominant
  {
    label: "heavy bulk — 30,000 lithium 18650 cells from China",
    raw: "I need 30,000 lithium-ion 18650 cells from China to Long Beach by Nov 1, 2026, budget $90,000",
    expectModality: "fcl",
    expectMinTotal: 30000,
    expectMaxTotal: 200000,
  },
];

async function runScenario(s: Scenario): Promise<void> {
  console.log(`\n${"━".repeat(72)}`);
  console.log(`▶ ${s.label}`);
  console.log(`  "${s.raw}"\n`);

  const parsed = (await new IntentParserAgent().run({ intent: s.raw })) as any;
  console.log(`  intent: HS=${parsed.hs_code} qty=${parsed.quantity}${parsed.quantity_unit} origin=${parsed.origin_country} dest=${parsed.destination_port}`);
  console.log(`  estimates: ${parsed.unit_weight_kg_estimate}kg/unit, $${parsed.unit_price_usd_estimate}/unit (${parsed.estimate_confidence})`);

  const cargoKg = (parsed.unit_weight_kg_estimate ?? 0) * (parsed.quantity ?? 0);
  console.log(`  → total cargo: ${cargoKg.toFixed(0)} kg`);

  const intent = { ...parsed, raw_text: s.raw, citations: [] };
  const productValueUsd = Math.round((intent.budget_usd ?? 0) / 1.25);

  const ship = await createShipment({
    intent: { ...(intent as any), product_value_usd: productValueUsd },
    hs_code: intent.hs_code,
    origin_country: intent.origin_country,
    destination_country: intent.destination_country ?? "US",
    destination_port: intent.destination_port,
    expected_eta: intent.deadline_date ? new Date(intent.deadline_date) : null,
    status: "pending",
  });

  const t0 = Date.now();
  await orchestrator.runSourcingPipeline(ship.id, intent as any, productValueUsd);
  const ms = Date.now() - t0;

  const options = await getOptionsForShipment(ship.id);
  const signals = await getSignalsForShipment(ship.id);
  const freightSignals = signals.filter((x: any) => x.agent_name === "freight-pricer");

  console.log(`\n  pipeline: ${(ms / 1000).toFixed(1)}s · ${options.length} ranked options · ${freightSignals.length} freight evaluations`);

  const modalitiesSeen = new Set<string>();
  for (const o of options) {
    const cb = o.cost_breakdown as any;
    const rd = o.route_data as any;
    const mod = rd?.modality ?? "?";
    modalitiesSeen.add(mod);
    console.log(`    #${o.rank} ${o.country} via ${rd?.origin_port?.locode ?? "?"} · ${mod.toUpperCase()} · $${cb?.total_landed_cost_usd?.toLocaleString()} · ${rd?.total_transit_days}d`);
    const alts = rd?.alternative_modalities ?? [];
    if (alts.length > 0) {
      const altStr = alts.map((a: any) => `${a.modality}=$${a.cost_usd}`).join(", ");
      console.log(`         alts: ${altStr}`);
    }
  }

  // Acceptance
  const topCost = (options[0]?.cost_breakdown as any)?.total_landed_cost_usd ?? 0;
  const topMod = (options[0]?.route_data as any)?.modality;
  const costOk = topCost >= s.expectMinTotal && topCost <= s.expectMaxTotal;
  const modOk =
    s.expectModality === "mixed"
      ? modalitiesSeen.size >= 2  // at least two different modalities across top 3
      : topMod === s.expectModality;
  console.log(`\n  ✓/✗ cost in [$${s.expectMinTotal.toLocaleString()}, $${s.expectMaxTotal.toLocaleString()}]: ${costOk ? "✓" : "✗"} ($${topCost.toLocaleString()})`);
  console.log(`  ✓/✗ modality '${s.expectModality}': ${modOk ? "✓" : "✗"} (top=${topMod}, seen=${[...modalitiesSeen].join(",")})`);
}

async function runAll() {
  registerAllAgents();
  for (const s of SCENARIOS) {
    try {
      await runScenario(s);
    } catch (e: any) {
      console.error(`\n✗ SCENARIO FAILED: ${s.label} — ${e.message}`);
    }
  }
  console.log("\n" + "━".repeat(72));
  console.log("DONE");
  process.exit(0);
}

runAll().catch((e) => { console.error(e); process.exit(1); });
