# Data Sources

Verified 2026-05-16.

## Sources

| Source | Status | Detail |
|--------|--------|--------|
| AISStream | ✅ SUCCESS | MMSI=563074570 lat=1.2813450000000002 lon=103.77070666666667 |
| GDELT | ✅ SUCCESS | 5 articles — first: "  苏伊士时刻 ： 大国霸权衰落的转折点" |
| UN Comtrade | ✅ SUCCESS | 1 records — reporter= value=5846762385 |
| USITC HTS | ✅ SUCCESS | [FALLBACK] USITC REST API deprecated. Use Federal Register USTR notices. Keys: chapter, source, note, federalRegisterUrl |
| Federal Register (USTR) | ✅ SUCCESS | 5 docs — latest: "Request for Comments and Public Hearing About the Administra" |
| Companies House | ✅ SUCCESS | 3 results — first: ESQUEL TRADING LTD (13815206) |
| GLEIF | ✅ SUCCESS | name=HSBC BANK PLC status=ISSUED |
| Open-Meteo Marine | ✅ SUCCESS | 72h forecast, current wave_height=0.16m |
| Local Sanctions (OFAC Rosneft) | ✅ SUCCESS | 3 matches for 'Rosneft' |
| Currents News | ✅ SUCCESS | [FALLBACK] API key expired — replace CURRENTS_API_KEY. Code is correct. |

## Response Shapes

### AISStream (WebSocket)
```json
{
  "mmsi": 123456789,
  "lat": 1.28,
  "lon": 103.82,
  "sog": 12.4,
  "cog": 180.0,
  "heading": 179,
  "timestamp": "2024-01-15T10:30:00Z",
  "shipName": "EVER GIVEN"
}
```

### GDELT DOC 2.0
```json
{
  "articles": [
    {
      "url": "https://...",
      "title": "Suez Canal congestion ...",
      "seendate": "20240115T103000Z",
      "sourcecountry": "US",
      "sourcelang": "English",
      "domain": "reuters.com"
    }
  ],
  "totalResults": 25
}
```

### UN Comtrade (public v1)
```json
{
  "data": [
    {
      "reporterCode": "156",
      "reporterDesc": "China",
      "cmdCode": "5208",
      "cmdDesc": "Woven fabrics of cotton",
      "flowCode": "X",
      "period": "2022",
      "primaryValue": 4523000000
    }
  ],
  "count": 1
}
```

### USITC HTS Chapter
```json
{ "chapter": "52", "heading": [...], "notes": [...] }
```

### Federal Register (USTR)
```json
[{
  "document_number": "2024-01234",
  "title": "Section 301 Tariff Actions ...",
  "type": "Notice",
  "publication_date": "2024-01-15",
  "html_url": "https://federalregister.gov/...",
  "agencies": [{ "name": "Office of the United States Trade Representative" }]
}]
```

### UK Companies House
```json
[{
  "company_number": "12345678",
  "title": "Esquel Enterprises Ltd",
  "company_status": "active",
  "company_type": "ltd",
  "date_of_creation": "2005-03-12"
}]
```

### GLEIF (LEI)
```json
{
  "lei": "MP6I5ZYZBEU3UXPYFY54",
  "legalName": "HSBC Bank plc",
  "legalAddress": { "city": "London", "country": "GB" },
  "status": "ISSUED"
}
```

### Open-Meteo Marine
```json
{
  "latitude": 1.3,
  "longitude": 103.8,
  "hourly": {
    "time": ["2024-01-15T00:00:00Z", "..."],
    "wave_height": [0.5, 0.6, "..."],
    "wave_direction": [180, 185, "..."]
  },
  "current": { "wave_height": 0.5 }
}
```

### Currents API
```json
{
  "news": [{
    "id": "abc123",
    "title": "Shipping rates surge ...",
    "url": "https://...",
    "published": "2024-01-15 10:00:00 +0000",
    "category": ["business", "finance"]
  }]
}
```

### Local Sanctions DB
Sanctions entities queried directly from Postgres `sanctions_entities` table.
- OFAC SDN: ~7,000+ entities downloaded from treasury.gov
- UFLPA: ~60 Xinjiang-linked entities seeded from `data/sanctions/uflpa.json`
