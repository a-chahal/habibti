# Compliance Screener Agent

**Tier:** mercury  
**Source:** Local `sanctions_entities` table (18,959 OFAC + 59 UFLPA entities)  
**Cache:** None — always fresh from DB

## Input
```json
{
  "supplier_name": "Xinjiang Cotton Trading Co",
  "country": "CN",
  "parent_companies": ["Guangdong Holdings Ltd"],
  "shipmentId": "uuid"
}
```

## Output
```json
{
  "supplier_name": "Xinjiang Cotton Trading Co",
  "country": "CN",
  "verdict": "flagged",
  "matches": [
    {
      "entity_name": "XINJIANG COTTON CORP",
      "list_source": "uflpa",
      "match_type": "partial",
      "confidence": 0.82
    }
  ],
  "uflpa_flag": true,
  "citations": ["DHS UFLPA Entity List (local copy)", "OFAC SDN List (local copy)"]
}
```

## Process
1. Query `sanctions_entities` with `LOWER(name) LIKE %supplier_name%` for supplier and each parent company
2. If zero DB hits → return `"clean"` immediately (no LLM call needed)
3. If hits exist → Mercury confirms: same country + (exact name / alias / parent match) = real match. Generic names / different countries = false positive
4. Any confirmed `list_source = "uflpa"` match → `uflpa_flag: true`

## Notes
- No external API calls; instant for clean companies
- Run once per candidate country using the country name as proxy supplier when no user-named supplier exists
