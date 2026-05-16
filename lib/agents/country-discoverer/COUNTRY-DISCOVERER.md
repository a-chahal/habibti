# Country Discoverer Agent

**Tier:** sonnet  
**Source:** UN Comtrade public v1 + sanctions_entities table  
**Cache:** 24h by HS code

## Input
```json
{ "hs_code": "5208", "destination_country": "US", "shipmentId": "uuid" }
```

## Output
```json
{
  "hs_code": "5208",
  "candidates": [
    {
      "country_code": "CN",
      "country_name": "China",
      "annual_export_volume_usd": 8500000000,
      "us_import_volume_usd": 1200000000,
      "lane_established": true,
      "trend": "stable",
      "citations": ["UN Comtrade 2023"]
    }
  ],
  "data_year": "2023",
  "citations": ["UN Comtrade public v1"]
}
```

## Process
1. Select candidate countries from chapter-specific list (textiles: CN/VN/IN/BD/ID/TR/PK/KH/MY/LK/ET/MX)
2. Query Comtrade for each candidate's global and US-bound exports of the HS code
3. Check sanctions_entities for country-level entries; filter comprehensively sanctioned countries (IR/KP/CU/SY)
4. Sonnet ranks candidates by US-import volume, incorporating training knowledge when Comtrade returns zeros
5. Returns top 5–7 candidates

## Notes
- Comtrade public v1 may be rate-limited or return sparse data for 4-digit HS codes; Sonnet fills gaps from training
- Sanctions filter uses `searchSanctions(countryName)` — high-volume matches flag the country for review
