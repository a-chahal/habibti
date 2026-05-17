# Regulatory Watcher Agent

**Tier:** mercury  
**Sources:** Federal Register API (USTR) + OpenSanctions public API  
**Interval:** 15 minutes (12s in TEST_MONITORING=1 mode)

## What it does

Two parallel checks each tick:

1. **Federal Register**: Fetches latest USTR documents. Mercury classifies whether each affects the shipment's HS code chapter or origin country. Writes `regulatory_event` or `tariff_change` signals for relevant docs.

2. **OpenSanctions delta**: Queries OpenSanctions for entities added in the last 24 hours. Matches against the shipment's supplier name using substring similarity. Writes `sanctions_addition` (critical) if a match is found.

## Document relevance schema (Mercury output)

```json
{
  "is_relevant": true/false,
  "relevance_reason": "...",
  "affected_hs_chapters": ["52"],
  "affected_countries": ["CN", "VN"],
  "signal_type": "regulatory_event|tariff_change|sanctions_update|none"
}
```

## OpenSanctions

Endpoint: `https://api.opensanctions.org/entities/?schema=Organization&sort=first_seen:desc&target=true`  
Free tier, no authentication required for read access.  
Falls back gracefully (returns empty list) if API is unavailable.

## Caching

Federal Register results are cached per hour keyed by `reg-watcher:fed-register:{YYYY-MM-DDTHH}` to avoid duplicate LLM classification calls across multiple concurrent shipments.

## Signal outputs

```json
{ "signal_type": "regulatory_event", "severity": "medium", "payload": {
    "document_number": "2024-12345",
    "title": "...",
    "publication_date": "2024-06-28",
    "source_url": "https://federalregister.gov/...",
    "relevance_reason": "Document proposes new tariff actions on HS 5208 cotton fabric imports from Vietnam"
} }
```

```json
{ "signal_type": "sanctions_addition", "severity": "critical", "payload": {
    "entity_name": "Xinjiang Cotton Group",
    "country": "CN",
    "dataset": "us_ofac_sdn",
    "supplier_name": "Xinjiang Cotton Co.",
    "match_type": "name_similarity"
} }
```
