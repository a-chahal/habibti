# Orchestrator

The orchestrator is the single coordination layer between events, agent dispatch, and DB writes. It is a singleton that boots with the app and never goes down during a process lifetime.

## Responsibilities

1. **Subscribe** to event channels: `SHIPMENT_NEW`, `SHIPMENT_CONFIRMED`, `SIGNAL_NEW`
2. **Dispatch** agents by name using an in-memory registry
3. **Write** a `dispatches` row for every invocation (status: running → completed | failed)
4. **Apply** agent results back to the DB (e.g. update shipment intent after parsing)
5. **Fire** downstream events after side effects are written

## Agent Registry

Agents register themselves with a name and a handler function:

```
orchestrator.register("intent-parser", handler)
```

The `boot.ts` module calls `registerAllAgents()` on startup to populate the registry.

## Dispatch Flow (Linear)

```
SHIPMENT_NEW
  └─► intent-parser
        └─► updateShipment(intent fields)
              └─► [stub] supplier-finder
              └─► [stub] tariff-analyzer
              └─► [stub] sanctions-screener

SHIPMENT_CONFIRMED
  └─► [stub] vessel-tracker
  └─► [stub] ais-monitor

SIGNAL_NEW (from any agent)
  └─► [stub] belief-updater
```

No hypothesis-driven re-dispatch. Flow is strictly linear. Future prompts replace stubs with real agents.

## Dispatch Record

Every invocation writes to `dispatches`:

| Field | Value |
|-------|-------|
| `shipment_id` | target shipment |
| `agent_name` | e.g. "intent-parser" |
| `payload` | input passed to agent |
| `status` | queued → running → completed \| failed |
| `created_at` / `completed_at` | timing |

## Error Handling

- If an agent throws, the dispatch is marked `failed` and the error is logged
- The orchestrator does NOT retry — callers may re-trigger via a new event
- Downstream stubs are only called if the primary agent succeeds and `clarification_needed` is null

## Sourcing Flow (full, for reference)

```
User intent
  → Intent Parser (Mercury)        — parse product, quantity, HS code, destination
  → Supplier Finder (Sonnet)       — search Companies House + GLEIF + history
  → Tariff Analyzer (Mercury)      — fetch HTS rates, USTR Section 301 duties
  → Sanctions Screener (Mercury)   — check local sanctions DB + GLEIF
  → Options Ranker (Sonnet)        — rank supplier+route combos
  → Belief Updater (Opus)          — synthesize risk narrative
  → Alert Drafter (Sonnet)         — generate alert + draft email if risk high
```
