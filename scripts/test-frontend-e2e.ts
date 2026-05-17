/**
 * test-frontend-e2e.ts
 *
 * Programmatic end-to-end test of the full REST API surface.
 * Requires the Next.js dev server to be running on localhost:3000.
 *
 * Flow:
 *   1. POST /api/shipments  — create shipment
 *   2. Poll GET /api/shipments/:id  — wait for sourcing_complete (up to 5 min)
 *   3. GET /api/shipments/:id/options  — confirm 3 options with port coordinates
 *   4. POST /api/shipments/:id/confirm  — pick option 1
 *   5. GET /api/shipments/:id/vessel-position  — confirm lat/lng + source: replay
 *   6. POST /api/demo/inject  — inject Suez backup
 *   7. Poll /api/shipments/:id/alerts  — assert alert appears within 15s
 *   8. GET /api/demo/scenarios  — confirm scenario list
 */

const BASE = "http://localhost:3000";
const TEST_INTENT = "2000 yards woven cotton fabric from Vietnam to Los Angeles by August 2026, budget $18000";

function hr(label: string) {
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  ${label}`);
  console.log("═".repeat(60));
}

function check(label: string, ok: boolean) {
  console.log(`  ${ok ? "✓" : "✗"} ${label}`);
  return ok;
}

async function api(method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data: any;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${JSON.stringify(data)}`);
  return data;
}

async function pollUntil<T>(
  fn: () => Promise<T>,
  predicate: (t: T) => boolean,
  timeoutMs: number,
  intervalMs = 2000
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await fn();
    if (predicate(result)) return result;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Timed out after ${timeoutMs}ms`);
}

async function main() {
  let allPass = true;
  const results: boolean[] = [];

  // ── 1. Create shipment ────────────────────────────────────────────────────
  hr("Step 1: POST /api/shipments");
  const created = await api("POST", "/api/shipments", { intent: TEST_INTENT });
  const shipmentId: string = created.id;
  results.push(check("Returns shipment id", typeof shipmentId === "string" && shipmentId.length > 0));
  results.push(check("Status is draft or pending", ["draft", "pending"].includes(created.status)));
  console.log(`  shipmentId: ${shipmentId}`);

  // ── 2. Wait for sourcing_complete ─────────────────────────────────────────
  hr("Step 2: Poll for sourcing_complete (up to 5 min)");
  console.log("  Waiting… this runs live agents (tariff, compliance, route, supplier)");
  let shipment: any;
  try {
    shipment = await pollUntil(
      () => api("GET", `/api/shipments/${shipmentId}`),
      (s) => s.status === "sourcing_complete" || s.status === "in_transit",
      5 * 60 * 1000,
      3000
    );
    results.push(check(`Sourcing complete (status: ${shipment.status})`, true));
  } catch (err: any) {
    console.log(`  TIMEOUT: ${err.message}`);
    console.log("  Fetching current state anyway…");
    shipment = await api("GET", `/api/shipments/${shipmentId}`);
    results.push(check(`Sourcing complete (status: ${shipment.status})`, shipment.status === "sourcing_complete"));
  }

  // ── 3. Options with port coordinates ─────────────────────────────────────
  hr("Step 3: GET /api/shipments/:id/options");
  const opts = await api("GET", `/api/shipments/${shipmentId}/options`);
  results.push(check("Returns array", Array.isArray(opts)));
  results.push(check("Has 3 options", opts.length === 3));
  if (opts.length > 0) {
    const opt0 = opts[0];
    const hasOrigin = opt0.route_data?.origin?.lat != null && opt0.route_data?.origin?.lng != null;
    const hasDest = opt0.route_data?.destination?.lat != null && opt0.route_data?.destination?.lng != null;
    results.push(check("Option 0 has origin coordinates", hasOrigin));
    results.push(check("Option 0 has destination coordinates", hasDest));
    if (hasOrigin) {
      console.log(`  Origin: ${opt0.route_data.origin.locode} @ (${opt0.route_data.origin.lat}, ${opt0.route_data.origin.lng})`);
    }
    if (hasDest) {
      console.log(`  Dest:   ${opt0.route_data.destination.locode} @ (${opt0.route_data.destination.lat}, ${opt0.route_data.destination.lng})`);
    }
  }

  // ── 4. Confirm option ─────────────────────────────────────────────────────
  hr("Step 4: POST /api/shipments/:id/confirm");
  let confirmed: any = null;
  if (opts.length > 0 && shipment.status === "sourcing_complete") {
    try {
      confirmed = await api("POST", `/api/shipments/${shipmentId}/confirm`, {
        option_id: opts[0].id,
      });
      results.push(check("Confirm returns status in_transit", confirmed.status === "in_transit"));
    } catch (err: any) {
      console.log(`  ERROR: ${err.message}`);
      results.push(check("Confirm succeeded", false));
    }
  } else {
    console.log("  Skipping (already in_transit or no options)");
    results.push(true); // not a failure
  }

  // Wait a moment for orchestrator to start monitoring agents
  await new Promise((r) => setTimeout(r, 2000));

  // ── 5. Vessel position ────────────────────────────────────────────────────
  hr("Step 5: GET /api/shipments/:id/vessel-position");
  // Poll for up to 10s to let vessel-tracker fire its first tick
  let posData: any = null;
  for (let i = 0; i < 5; i++) {
    posData = await api("GET", `/api/shipments/${shipmentId}/vessel-position`);
    if (posData.lat != null) break;
    await new Promise((r) => setTimeout(r, 2000));
  }
  results.push(check("Returns source: replay", posData?.source === "replay"));
  results.push(check("Has lat/lng", posData?.lat != null && posData?.lng != null));
  if (posData?.lat != null) {
    console.log(`  Position: (${posData.lat}, ${posData.lng}) speed=${posData.speed ?? "?"}kts progress=${posData.route_progress_pct ?? "?"}%`);
  }

  // ── 6. Inject Suez signal ─────────────────────────────────────────────────
  hr("Step 6: POST /api/demo/inject — Suez Canal backup");
  const injected = await api("POST", "/api/demo/inject", {
    shipment_id: shipmentId,
    signal_type: "gdelt_news",
    severity: "high",
    payload: {
      source: "GDELT",
      event_type: "canal_disruption",
      location: "Suez Canal",
      headline: "Suez Canal Authority announces 5-7 day vessel queuing delays due to congestion",
      delay_days_min: 5,
      delay_days_max: 7,
      affected_traffic: "all northbound and southbound vessels",
    },
    citations: [{ url: "https://gdelt.example.com/suez-2026", title: "Suez Canal queuing delays" }],
    agent_name: "corridor-news",
  });
  results.push(check("Inject returns signal id", typeof injected.id === "string"));
  console.log(`  Signal id: ${injected.id}`);

  // ── 7. Wait for alert ─────────────────────────────────────────────────────
  hr("Step 7: Poll for alert from Synthesizer (15s window)");
  let alert: any = null;
  try {
    const alertsResult = await pollUntil(
      () => api("GET", `/api/shipments/${shipmentId}/alerts`),
      (as: any[]) => as.length > 0,
      15000,
      1500
    );
    alert = alertsResult[0];
    results.push(check("Alert created by Synthesizer", true));
    results.push(check("Alert has headline", typeof alert?.headline === "string" && alert.headline.length > 0));
    results.push(check("Alert has draft email", alert?.draft_email != null));
    console.log(`  Headline: "${alert?.headline}"`);
    console.log(`  Type: ${alert?.alert_type}`);
  } catch {
    results.push(check("Alert created within 15s", false));
    results.push(true); // headline check skipped
    results.push(true); // email check skipped
    console.log("  NOTE: Synthesizer may still be processing — check again manually");
  }

  // ── 8. Demo scenarios ─────────────────────────────────────────────────────
  hr("Step 8: GET /api/demo/scenarios");
  const scenarios = await api("GET", "/api/demo/scenarios");
  results.push(check("Returns array", Array.isArray(scenarios)));
  results.push(check("Includes our shipment", scenarios.some((s: any) => s.id === shipmentId)));
  console.log(`  ${scenarios.length} scenario(s) available`);

  // ── Signals check ─────────────────────────────────────────────────────────
  hr("Bonus: GET /api/shipments/:id/signals");
  const sigs = await api("GET", `/api/shipments/${shipmentId}/signals`);
  results.push(check("Signals array returned", Array.isArray(sigs)));
  results.push(check("Has signals from monitoring agents", sigs.length > 0));

  const sinceTs = new Date(Date.now() - 5000).toISOString();
  const sigsIncremental = await api("GET", `/api/shipments/${shipmentId}/signals?since=${encodeURIComponent(sinceTs)}`);
  results.push(check("Incremental ?since= query works", Array.isArray(sigsIncremental)));
  console.log(`  Total signals: ${sigs.length}, last-5s incremental: ${sigsIncremental.length}`);

  // ── Summary ───────────────────────────────────────────────────────────────
  allPass = results.every(Boolean);
  const passed = results.filter(Boolean).length;

  console.log(`\n${"═".repeat(60)}`);
  console.log(`  SUMMARY: ${passed}/${results.length} passed${allPass ? " ✅" : " ❌"}`);
  console.log(`  Shipment: http://localhost:3000/shipment/${shipmentId}`);
  console.log("═".repeat(60) + "\n");

  process.exit(allPass ? 0 : 1);
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
