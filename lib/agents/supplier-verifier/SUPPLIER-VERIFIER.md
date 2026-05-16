# Supplier Verifier Agent

**Tier:** sonnet  
**Sources:** UK Companies House (GB/UK) · GLEIF LEI Registry (all others)

## Input
```json
{ "supplier_name": "Vietnam Textile Corp", "country": "VN", "shipmentId": "uuid" }
```

## Output
```json
{
  "supplier_name": "Vietnam Textile Corp",
  "country": "VN",
  "registry_source": "GLEIF LEI Registry",
  "match_candidates": [
    {
      "name": "VIETNAM TEXTILE CORPORATION JSC",
      "registry_id": "254900...",
      "country": "VN",
      "incorporation_date": "2005-03-14",
      "status": "ISSUED",
      "officers": [],
      "parent_company": null,
      "match_confidence": 0.87
    }
  ],
  "limited_data": false,
  "citations": ["GLEIF LEI Registry"]
}
```

## Process
1. If `country ∈ {GB, UK}`: query Companies House → retrieve officers + PSC
2. Otherwise: query GLEIF by name + country filter
3. Compute initial `match_confidence` via Jaccard word overlap on normalized names
4. Sonnet re-scores confidence accounting for country match, active status, and registry data richness
5. `limited_data: true` when API unavailable or zero results (common for Southeast Asian suppliers)

## Notes
- Officers array populated by Companies House only (GLEIF doesn't expose this)
- `match_confidence < 0.3` → candidate is a false positive, not returned
