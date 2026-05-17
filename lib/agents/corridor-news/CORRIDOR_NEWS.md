# Corridor News Agent

**Tier:** mercury  
**Source:** GDELT Document API (free, no key required)  
**Interval:** 5 minutes (8s in TEST_MONITORING=1 mode)

## What it does

Monitors news relevant to the shipment's transit corridor via GDELT. Each tick queries GDELT with route-specific keywords, deduplicates against previously-seen URLs, and uses Mercury to classify each new article's severity and specific impact on shipping.

## Route query templates

| Route key | GDELT queries |
|-----------|--------------|
| VN-USLAX | "Vietnam Pacific shipping maritime", "South China Sea disruption", "Luzon Strait" |
| ID-USNYC | "Indonesia Malacca Strait maritime", "Suez Canal shipping delay", "Red Sea disruption" |
| CN-USLGB | "China Pacific shipping port", "Trans-Pacific container strike", "Long Beach congestion" |
| DEFAULT | "maritime shipping disruption", "port strike closure", "vessel incident chokepoint" |

## Article classification schema (Mercury output)

```json
{
  "severity": "info|low|medium|high|critical",
  "impact_on_shipping": "...",
  "is_systemic": true/false,
  "relevant_chokepoint": "Suez Canal"|null,
  "eta_impact_days": 5|null
}
```

## Deduplication

Each agent instance tracks a `Set<string>` of seen article URLs per shipmentId. URLs are never re-classified. The set is cleared when `stopMonitoring()` is called.

## Signal output

```json
{
  "signal_type": "news_event",
  "severity": "high",
  "payload": {
    "headline": "Suez Canal Authority announces 5-7 day queuing delays",
    "source_url": "https://...",
    "published_at": "20240628090000",
    "impact_on_shipping": "Direct delay of 5-7 days for vessels transiting Suez",
    "is_systemic": true,
    "relevant_chokepoint": "Suez Canal",
    "eta_impact_days": 6,
    "route": "ID-USNYC"
  },
  "citations": [{"url": "...", "title": "..."}]
}
```

## GDELT rate limiting

GDELT allows ~1 request/second. The agent queries once per tick (not per article). On 429 responses, GDELT source auto-retries after 6 seconds.
