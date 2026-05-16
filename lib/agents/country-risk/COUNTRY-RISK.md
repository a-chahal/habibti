# Country Risk Agent

**Tier:** sonnet  
**Source:** GDELT Document API (last N days)  
**Cache:** 3h by country_code:lookback_days

## Input
```json
{ "country_code": "VN", "lookback_days": 30, "shipmentId": "uuid" }
```

## Output
```json
{
  "country_code": "VN",
  "stability": "watch",
  "event_count_by_category": {
    "port_disruption": 0,
    "political": 2,
    "trade_policy": 1,
    "labor": 1,
    "natural_disaster": 0,
    "other": 3
  },
  "top_events": [
    {
      "headline": "Vietnam port workers strike over wages",
      "source_url": "https://...",
      "original_language": "vi",
      "date": "2025-05-10",
      "category": "labor",
      "relevance_score": 0.82,
      "severity": "medium"
    }
  ],
  "citations": ["GDELT Document API"]
}
```

## Process
1. Query GDELT with `"<Country>" (port OR shipping OR trade OR strike OR tariff OR sanctions OR protest OR unrest OR military)` over lookback window
2. Sonnet filters articles to trade-relevant events only (coup matters; celebrity news does not)
3. Always returns ≥2 top_events — uses training knowledge if GDELT returns nothing
4. `stability` scale: stable → watch → elevated → unstable

## Stability Thresholds
- **stable**: no significant trade-disrupting events
- **watch**: 1–2 low/medium events, monitor
- **elevated**: active disruption (port strike, significant unrest)
- **unstable**: ongoing conflict, major port closure, sanctions threat
