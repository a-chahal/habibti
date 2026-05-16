# Option Ranker Agent

**Tier:** opus (non-negotiable — synthesis requires maximum reasoning quality)  
**Source:** All sourcing signals from the shipment's signals table  
**Writes:** 3 rows to the `options` table + one `options_ranked` signal

## Input
```json
{ "shipmentId": "uuid", "intent_data": { "hs_code": "5208", "budget_usd": 30000, ... } }
```

## Output (written to `options` table)
Three ranked rows, each with:
- `rank`: 1, 2, or 3
- `country`: ISO2 origin country
- `supplier_id`: upserted supplier row (null if no verified match)
- `route_data`: lane, chokepoints, traffic density, weather
- `cost_breakdown`: all landed cost line items
- `eta`: today + transit_days
- `risk_summary`: country_risk, compliance, route_risk, overall
- `reasoning`: 120+ word analyst-voice paragraph citing specific signals

## Analyst Voice Rules (enforced in system prompt)
1. Every claim must cite a specific number ($ cost, % duty, transit days, confidence score, event count)
2. State the option's biggest weakness explicitly: "the critical risk is..."
3. No hedging without data ("may," "seems," "could" are banned without a qualifying number)
4. Minimum 120 words per reasoning paragraph
5. Each option must reference at least the tariff signal, risk signal, and route signal

## Process
1. Load all sourcing signals from `getSignalsForShipment(shipmentId)`
2. Build structured context string grouping signals by agent
3. Send to Opus with system prompt containing 2 positive examples + 1 negative "do not write like this" example
4. Validate output with Zod (3 options, 3 different country_codes)
5. For each option: upsert supplier record if named, write `options` row, compute ETA from transit_days
6. Publish `options_ranked` signal

## Filtering Rules
- Hard disqualification: compliance verdict = "flagged" AND UFLPA flag = true
- Soft preference: compliance verdict = "clean"
- Diversity constraint: 3 options must span 3 different country_codes

## Prompt Engineering
The system prompt includes:
- **GOOD EXAMPLE 1**: Vietnam rank #1 with specific numbers (landed cost, duty %, transit days, supplier confidence, chokepoint severity, schedule buffer)
- **GOOD EXAMPLE 2**: India rank #2 with GLEIF confidence, Section 301 savings, Suez risk, deadline buffer
- **DO NOT WRITE LIKE THIS**: generic, hedged, number-free paragraph labeled as rejected

If output quality is insufficient (reasoning < 80 words, no numbers, no tradeoffs acknowledged), update this file and re-run.
