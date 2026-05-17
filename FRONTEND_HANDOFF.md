# Frontend Handoff — habibti

This document is everything a fresh context needs to work on the frontend of this codebase without reading all the agent/backend code.

---

## What this app is

**habibti** — AI-powered import intelligence for small US importers. A user types a natural-language sourcing intent ("5000 yards organic cotton fabric, from Vietnam, into LA, by July 15, $30k budget"). The system runs 16 AI agents to find sourcing options and then monitors the shipment in real time.

The frontend has exactly **two pages**:
1. `/` — homepage with intent input
2. `/shipment/[id]` — shipment detail, three distinct phases

---

## Tech stack (non-negotiable constraints)

| Thing | What it is | Gotchas |
|---|---|---|
| **Next.js 14** | Not 15. `params` is synchronous. | NEVER use `use(params)` — it crashes. Use `params: { id: string }` and `const { id } = params` directly. |
| **Tailwind CSS** | Dark slate theme | No `shadcn/tailwind.css` installed. Do NOT `@import` it. No `@apply border-border` or `@apply bg-background text-foreground` — use raw CSS vars instead. |
| **shadcn/ui** | Components exist in `components/ui/` as copied source files | The npm package is NOT installed. Don't run `npx shadcn-ui`. You can use the files already there. |
| **No Geist font** | `next/font/google` is broken in this environment | `layout.tsx` has NO font imports. Don't add any. |
| **Zustand** | Client state management | Four stores: shipmentStore, signalsStore, beliefsStore, alertsStore |
| **PostgreSQL + Drizzle** | Backend only | Never import server-only DB code into client components. |

**`next.config.mjs`** must stay exactly as-is — `serverExternalPackages: ["ws", "bufferutil", "utf-8-validate"]` prevents webpack from bundling the `ws` native module (without this the server crashes).

---

## File map (frontend-relevant only)

```
app/
  page.tsx                    # Homepage
  layout.tsx                  # Root layout (no font imports!)
  globals.css                 # Tailwind base (no shadcn imports)
  shipment/
    [id]/
      page.tsx                # Shipment detail page

lib/
  hooks/
    usePolling.ts             # Polls 5 endpoints at 1500ms
  stores/
    shipmentStore.ts          # Zustand: shipment snapshot + options + vessel pos
    signalsStore.ts           # Zustand: signals array (deduped, newest-first)
    beliefsStore.ts           # Zustand: beliefs array + current (latest)
    alertsStore.ts            # Zustand: active alerts + localDismiss

components/
  ui/                         # shadcn source files (copied, not installed as package)
```

---

## API routes (consumed by frontend)

All routes are in `app/api/`. You don't need to touch them, just consume them.

| Method | Path | Returns |
|---|---|---|
| `POST` | `/api/shipments` | `{ id: string }` — creates shipment, start pipeline |
| `GET` | `/api/shipments/:id` | Full shipment snapshot (see shape below) |
| `GET` | `/api/shipments/:id/options` | Array of `ShipmentOption` (with `supplier` join) |
| `GET` | `/api/shipments/:id/signals?since=ISO` | Array of `Signal` (incremental via `?since=`) |
| `GET` | `/api/shipments/:id/beliefs` | Array of `Belief` newest-first |
| `GET` | `/api/shipments/:id/alerts` | Array of active (non-dismissed) `Alert` |
| `POST` | `/api/shipments/:id/confirm` | Body: `{ option_id: string }` — starts monitoring |
| `POST` | `/api/alerts/:id/dismiss` | Marks alert dismissed |
| `GET` | `/api/shipments/:id/vessel-position` | Latest vessel position payload or `{}` |
| `GET` | `/api/demo/scenarios` | Array of `DemoScenario` (recent shipments) |
| `POST` | `/api/demo/inject` | Injects a synthetic disruption for testing |

---

## Data shapes

### Shipment snapshot (`GET /api/shipments/:id`)
```typescript
{
  id: string;
  status: "draft" | "pending" | "sourcing_complete" | "in_transit" | "delayed" | "arrived" | "cancelled";
  intent: {
    raw: string;           // original user text
    product_description: string | null;
    quantity: number | null;
    quantity_unit: string | null;
    origin_country: string | null;  // e.g. "VN"
    destination_port: string | null; // e.g. "USLAX"
    deadline_date: string | null;   // ISO date
    budget_usd: number | null;
    supplier: string | null;        // parsed supplier name if mentioned
    hs_code: string | null;
  };
  origin_country: string | null;
  origin_port: string | null;
  destination_port: string | null;
  hs_code: string | null;
  expected_eta: string | null;   // ISO datetime
  current_eta: string | null;    // ISO datetime (updated by monitoring)
  current_belief: {
    id: string;
    version: number;
    risk_level: "low" | "medium" | "high" | "critical";
    narrative: string | null;
    current_eta: string | null;
  } | null;
}
```

### ShipmentOption (`GET /api/shipments/:id/options`)
```typescript
{
  id: string;
  rank: number;           // 1 = best (preferred origin always rank 1)
  country: string | null; // ISO 2-letter: "VN", "CN", "IN"
  supplier: {
    id: string;
    name: string;
    country: string | null;
    verification_status: string;
  } | null;
  route_data: {
    lane_name: string;           // e.g. "Trans-Pacific VN→USLAX"
    typical_transit_days: number;
    chokepoints: string[];       // e.g. ["Malacca Strait"]
    origin: { locode: string; lat: number; lng: number } | null;
    destination: { locode: string; lat: number; lng: number } | null;
  } | null;
  cost_breakdown: {
    product_value_usd: number;
    total_duty_pct: number;
    total_duty_usd: number;
    freight_usd: number;
    insurance_usd: number;
    total_landed_cost_usd: number;
  } | null;
  eta: string | null;          // ISO datetime
  risk_summary: {
    overall: "low" | "medium" | "high";
    tariff: string;
    compliance: string;
    supply_chain: string;
  } | null;
  reasoning: string | null;   // 3+ paragraph LLM reasoning from Opus
}
```

### Signal (`GET /api/shipments/:id/signals`)
```typescript
{
  id: string;
  shipment_id: string | null;
  agent_name: string;   // e.g. "tariff-calculator", "vessel-tracker", "corridor-news"
  signal_type: string;  // see Signal Types below
  severity: "info" | "low" | "medium" | "high" | "critical";
  payload: Record<string, unknown> | null;
  citations: unknown[] | null;
  confidence: string | null;  // "0.85" etc
  occurred_at: string;
  recorded_at: string;
}
```

**Signal types and their payload keys:**
- `vessel_position`: `{ lat, lon, speed_knots, heading, route_progress_pct, on_schedule }`
- `port_status` / `port_congestion`: `{ port, vessel_count, ratio, congested, cause }`
- `news_event`: `{ headline, impact_on_shipping, source_url, published_at, relevant_chokepoint, eta_impact_days }`
- `weather_status`: `{ summary, waypoints_checked, hazardous_waypoints }`
- `weather_hazard`: `{ hazard_level, summary, affected_waypoints, eta_impact_days }`
- `sanctions_addition`: `{ entity_name, country, dataset, supplier_name }`
- `regulatory_event` / `tariff_change`: `{ title, relevance_reason, source_url, publication_date }`
- `tariff_assessment`, `compliance_check`, `route_assessment`, `supplier_found`, `country_risk_assessment`: sourcing-phase signals

### Alert (`GET /api/shipments/:id/alerts`)
```typescript
{
  id: string;
  shipment_id: string;
  belief_id: string | null;
  alert_type: string;          // e.g. "eta_shift", "compliance_flag", "weather_disruption"
  headline: string;
  full_narrative: string | null;
  draft_email: string | null;  // JSON string: `{"subject_line":"...","body":"..."}` OR raw string
  status: "active" | "acknowledged" | "dismissed";
  created_at: string;
  acknowledged_at: string | null;
}
```

### VesselPosition (`GET /api/shipments/:id/vessel-position`)
```typescript
{
  lat: number | null;
  lng: number | null;    // NOTE: uses "lng" not "lon"
  heading: number | null;
  speed: number | null;
  source: "live_ais" | "replay";
  last_updated: string | null;
  route_progress_pct: number | null;
}
// Returns {} if no position available
```

---

## The three-phase UI

The shipment page renders one of three states based on `shipment.status`:

### Phase 1 — Sourcing in progress
**Statuses:** `draft`, `pending`, or null

Show a progress/loading state. Signals start streaming almost immediately. Display them as a live log — agent name + one-liner description. Agents that run during sourcing include: `intent-parser`, `country-discoverer`, `tariff-calculator`, `country-risk`, `route-prescorer`, `supplier-verifier`, `compliance-screener`, `option-ranker`.

### Phase 2 — Options ready
**Status:** `sourcing_complete`

Show option cards (always 3 options, ranked 1-3). Rank 1 is always the user's preferred origin (the country they mentioned). Each card has a "Select this option" button that calls `POST /api/shipments/:id/confirm` with `{ option_id }`. After confirm, polling will detect the status change to `in_transit`.

### Phase 3 — In transit
**Statuses:** `in_transit`, `delayed`

Show:
1. **Active alerts** (orange, dismissible) — each has a draft email
2. **Current belief** — synthesizer's latest assessment (risk level + ETA + narrative)
3. **Route summary** — origin → destination + current ETA
4. **Vessel position** — lat/lon/speed/progress (if available)
5. **Signal stream** — real-time scrollable log of all monitoring signals

---

## Current page code

### `app/page.tsx` (homepage)
```tsx
"use client";
// Dark slate centered layout
// textarea → POST /api/shipments → router.push(`/shipment/${data.id}`)
// Cmd+Enter keyboard shortcut
// "Or load demo scenario" button → GET /api/demo/scenarios → list of clickable past shipments
```
The homepage is complete and working. Style: `bg-slate-950`, centered, max-w-2xl.

### `app/shipment/[id]/page.tsx` (detail page)
```tsx
export default function ShipmentPage({ params }: { params: { id: string } }) {
  const { id } = params; // NOT use(params) — this is Next.js 14
```
Currently functional but minimal (dark monospace terminal style). All logic is in place.

---

## Zustand stores

### `useShipmentStore`
```typescript
// Key fields:
shipment.id, shipment.status, shipment.intent, shipment.origin_country,
shipment.destination_port, shipment.hs_code, shipment.expected_eta,
shipment.current_eta, shipment.current_belief, shipment.options, shipment.vesselPosition

// Methods:
setShipment(partial), setOptions(options[]), setVesselPosition(pos|null), reset()
```

### `useSignalsStore`
```typescript
signals: Signal[]       // sorted newest-first, deduplicated by id
lastFetchedAt: string | null

setSignals(signals[])   // full replace + sort
appendSignals(incoming[]) // incremental merge (deduplicates)
setLastFetchedAt(iso)
reset()
```

### `useBeliefsStore`
```typescript
beliefs: Belief[]
current: Belief | null  // latest belief (beliefs[0])

setBeliefs(beliefs[])
reset()
```

### `useAlertsStore`
```typescript
alerts: Alert[]         // only active, not dismissed
dismissedIds: Set<string>

setAlerts(alerts[])     // auto-filters dismissed
localDismiss(id)        // optimistic dismiss (also call API)
reset()
```

---

## `usePolling` hook

```typescript
const { isPolling, lastError, lastSuccessAt } = usePolling(shipmentId);
```

- Polls 6 endpoints sequentially every 1500ms
- Incremental signal loading: after first poll, uses `?since=ISO` to only fetch new signals
- Exponential backoff on errors: [1500, 3000, 6000, 12000]ms
- Respects tab visibility (pauses when tab hidden, resumes on focus)
- Auto-stops when status is `arrived` or `cancelled`
- All store updates happen inside this hook — the page just reads from stores

---

## globals.css gotchas

```css
/* DO NOT add these — packages are not installed: */
/* @import "tw-animate-css";         ← NOT installed */
/* @import "shadcn/tailwind.css";    ← NOT installed */

/* Use raw CSS vars instead of @apply: */
/* WRONG: @apply border-border */
/* RIGHT: border-color: var(--border); */
/* WRONG: @apply bg-background text-foreground */
/* RIGHT: background-color: var(--background); color: var(--foreground); */
```

---

## Design system (current palette)

```
Background:      bg-slate-950   (#020617)
Surface:         bg-slate-900   (#0f172a)
Border:          border-slate-800 / border-slate-700
Text primary:    text-slate-100
Text secondary:  text-slate-400 / text-slate-500
Text muted:      text-slate-600

Severity colors:
  info:     text-slate-500
  low:      text-blue-400
  medium:   text-yellow-400
  high:     text-orange-400
  critical: text-red-400

Risk level colors:
  low:      text-green-400
  medium:   text-yellow-400
  high:     text-orange-400
  critical: text-red-400

Status badges:
  in_transit:       bg-blue-900 text-blue-300
  sourcing_complete: bg-purple-900 text-purple-300
  arrived:          bg-green-900 text-green-300
  other:            bg-slate-800 text-slate-400

Alert card:  border-orange-700 bg-orange-950/30
Option card rank 1: border-slate-500 bg-slate-900
Option card rank 2+: border-slate-800 bg-slate-950

Primary button: bg-slate-100 text-slate-950 hover:bg-white
Secondary button: bg-slate-800 text-slate-300 hover:bg-slate-700
```

---

## Known working patterns

1. **Reset stores on page unmount** (to avoid stale data when navigating back):
   ```tsx
   useEffect(() => {
     return () => {
       useShipmentStore.getState().reset();
       useSignalsStore.getState().reset();
       useBeliefsStore.getState().reset();
       useAlertsStore.getState().reset();
     };
   }, [id]);
   ```

2. **draft_email is JSON-encoded** — always try `JSON.parse(draft_email)` first:
   ```typescript
   try {
     const parsed = JSON.parse(draft_email);
     text = `Subject: ${parsed.subject_line}\n\n${parsed.body}`;
   } catch {
     text = draft_email; // raw string fallback
   }
   ```

3. **intent is a jsonb object** — access `.raw` for the original text:
   ```typescript
   typeof shipment.intent === "object" ? String((shipment.intent as any).raw ?? "") : String(shipment.intent)
   ```

4. **Signal one-liner helper** — `signalOneLiner(agentName, signalType, payload)` exists in `app/shipment/[id]/page.tsx` and translates raw signal payloads into human-readable strings.

5. **Option route data** — `option.route_data` contains `origin` and `destination` with `{ locode, lat, lng }` for map pins if needed.

---

## What the frontend does NOT have yet

The current UI is purely functional but looks like a terminal/monospace debug view. There is no:
- Map visualization (route path, vessel dot, waypoints)
- ETA timeline / progress bar
- Cost breakdown table
- Risk breakdown (per-dimension: tariff, compliance, supply chain)
- Option comparison view (side-by-side)
- Signal filtering (by agent or severity)
- Notification/toast on new alert
- Onboarding / empty state polish
- Mobile responsiveness

All the data to power these exists — it just hasn't been built into the UI.

---

## Running locally

```bash
npm run dev    # starts on http://localhost:3000
```

The server also starts the agent orchestrator via `lib/boot.ts` (imported in `layout.tsx`). No separate process needed.

Test intent: `"5000 yards organic cotton fabric, from Vietnam, into LA, by July 15, $30k budget"`
