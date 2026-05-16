# Habibti — Agent-Native Trade Infrastructure Platform

A 48-hour hackathon project: agentic trade intelligence for small importers.

## Stack
- **Next.js 14** (App Router) + TypeScript
- **Postgres 16** in Docker (local only)
- **Drizzle ORM** with full schema
- **Tailwind CSS** + shadcn/ui (dark mode)
- **OpenRouter** — Mercury 2, Sonnet 4.6, Opus 4.7
- **EventEmitter3** — in-process pub/sub
- **LRU Cache** + Postgres cache table
- **MapLibre GL JS** + OpenFreeMap (no token)
- **Framer Motion**

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Start Postgres
npm run db:up

# 3. Apply schema
npm run db:push

# 4. Load sanctions data
npm run load-sanctions

# 5. Verify all data sources
npm run verify-sources

# 6. Test the agent framework
npm run test-echo "hello world"

# 7. Start the app
npm run dev
```

## Scripts

| Script | Description |
|--------|-------------|
| `npm run db:up` | Start Postgres container |
| `npm run db:down` | Stop Postgres container |
| `npm run db:reset` | Wipe and restart Postgres |
| `npm run db:push` | Apply Drizzle schema |
| `npm run load-sanctions` | Load OFAC SDN + UFLPA into DB |
| `npm run verify-sources` | Verify all 10 data sources |
| `npm run test-echo` | Run hello-world Mercury agent |

## Environment Variables

Copy `.env` and fill in your keys (`.env` is gitignored):

```
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/trade_platform
OPENROUTER_API_KEY=...
AISSTREAM_API_KEY=...
UK_COMPANIES_HOUSE_API_KEY=...
CURRENTS_API_KEY=...   # Rotate if expired (401)
```

No key required: GDELT, UN Comtrade (public v1), Federal Register, GLEIF, Open-Meteo, OFAC SDN, UFLPA.

## Data Sources

| Source | Status | Notes |
|--------|--------|-------|
| AISStream | ✅ | WebSocket, real-time vessel positions |
| GDELT | ✅ | 5-sec rate limit between requests |
| UN Comtrade | ✅ | Public v1, annual HS trade data |
| USITC HTS | ⚠️ Fallback | REST API deprecated (SPA); use Federal Register |
| Federal Register (USTR) | ✅ | Agency ID 491 |
| Companies House (UK) | ✅ | Requires API key |
| GLEIF | ✅ | LEI lookup, no key |
| Open-Meteo Marine | ✅ | No key, 72h marine forecasts |
| Local Sanctions | ✅ | ~19k OFAC + 59 UFLPA entities in Postgres |
| Currents News | ⚠️ Fallback | Rotate CURRENTS_API_KEY if 401 |

## Architecture

```
/lib
  /db          — Drizzle schema (11 tables), client, query helpers
  /llm         — OpenRouter client (Opus/Sonnet/Mercury tiers)
  /events      — EventEmitter3 pub/sub with typed channels
  /cache       — LRU + Postgres cache layer
  /agents      — Base Agent class + specialist agents
  /sources     — Thin clients for each external data source

/scripts
  load-sanctions.ts   — OFAC + UFLPA ingestion
  verify-sources.ts   — End-to-end source verification
  test-echo.ts        — Hello-world agent test

/data/sanctions
  uflpa.json   — Seeded UFLPA entity list (~59 entities)

/docs
  DATA_SOURCES.md   — Verified response shapes
```

## Database Schema (11 tables)

`shipments` · `suppliers` · `signals` · `beliefs` · `alerts` · `options` · `dispatches` · `supplier_history` · `route_history` · `cache` · `sanctions_entities`
