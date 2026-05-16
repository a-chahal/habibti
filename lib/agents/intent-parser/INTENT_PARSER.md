# Intent Parser Agent

**Tier:** Mercury 2 (fast, cheap — pure text extraction)  
**Input:** Raw user string describing a shipment intent  
**Output:** Structured `IntentOutput` (Zod-validated JSON)

## Purpose

Converts a free-text import request ("I need 5000 yards of organic cotton fabric delivered to LA by July") into a structured object the rest of the platform can act on. This is the first agent dispatched for every new shipment.

## Output Schema

| Field | Type | Description |
|-------|------|-------------|
| `hs_code` | string | 4-digit HS tariff code |
| `hs_candidates` | array (optional) | Up to 3 candidates with confidence if ambiguous |
| `product_description` | string | Cleaned product name |
| `quantity` | number \| null | Numeric quantity |
| `quantity_unit` | string \| null | "yards", "kg", "units", "MT", etc. |
| `origin_country` | string \| null | ISO 2-letter code if specified |
| `destination_port` | string \| null | UNLOCODE port code (e.g. "USLAX") |
| `destination_country` | string \| null | ISO 2-letter code |
| `deadline_date` | string \| null | ISO 8601 date (YYYY-MM-DD) |
| `budget_usd` | number \| null | Numeric USD value |
| `notes` | string | Other relevant info |
| `clarification_needed` | string \| null | Set if input too vague |

## HS Code Resolution

Two-stage resolution:

1. **Lookup table** — in-code map of common product keywords → HS codes. Covers ~50 product categories including cotton (5208), cinnamon (0906), lithium batteries (8507), coffee (0901), electronics (8542), auto parts (8708), etc. Hint is prepended to the LLM prompt.

2. **LLM judgment** — Mercury 2 resolves ambiguous or unmapped products using its training knowledge of HS nomenclature.

## Port Resolution

Lookup table maps city/state/region names → UNLOCODE codes:
- Los Angeles / LA / California → USLAX  
- New York / NY / NJ → USNYC  
- Oakland → USOAK  
- Long Beach → USLGB  
- Seattle → USSEA  
- Houston → USHOU  
- Savannah → USSAV  
- Miami → USMIA  
- (+ international ports)

Hint is prepended to LLM prompt when matched.

## Validation & Retry

- Output is Zod-validated against `IntentOutput` schema
- On schema validation failure: retries LLM call once
- On second failure: throws, orchestrator marks dispatch as failed

## Clarification Flow

If `clarification_needed` is non-null in the output, the orchestrator does NOT proceed with downstream agents. The field value is stored in the shipment's intent and surfaced to the user.

## Example

**Input:** `"I need 5000 yards of organic cotton fabric, delivered to Los Angeles by July 15, budget $30K landed"`

**Output:**
```json
{
  "hs_code": "5208",
  "product_description": "organic cotton fabric",
  "quantity": 5000,
  "quantity_unit": "yards",
  "origin_country": null,
  "destination_port": "USLAX",
  "destination_country": "US",
  "deadline_date": "2026-07-15",
  "budget_usd": 30000,
  "notes": "landed cost basis",
  "clarification_needed": null
}
```
