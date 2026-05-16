# Route Pre-Scorer Agent

**Tier:** mercury  
**Sources:** AISStream WebSocket · Open-Meteo Marine API · GDELT  
**Cache:** 2h by origin_country:destination_port

## Input
```json
{ "origin_country": "VN", "destination_port": "USLAX", "shipmentId": "uuid" }
```

## Output
```json
{
  "origin_country": "VN",
  "destination_port": "USLAX",
  "routes": [
    {
      "lane_name": "Trans-Pacific (Vietnam → Los Angeles)",
      "chokepoints": ["Malacca Strait"],
      "typical_transit_days": 16,
      "current_traffic_density": "medium",
      "weather_outlook": "Calm (avg wave 1.2m near Malacca Strait)",
      "chokepoint_risks": [
        {
          "name": "Malacca Strait",
          "current_events": "No significant disruption",
          "severity": "none"
        }
      ]
    }
  ],
  "citations": ["AISStream (8s vessel sample)", "Open-Meteo Marine API", "GDELT"]
}
```

## Lane Table
| Route key     | Transit days | Chokepoints                              |
|---------------|-------------|------------------------------------------|
| CN→USLAX      | 14          | none                                     |
| VN→USLAX      | 16          | Malacca Strait                           |
| IN→USLAX      | 28          | Bab-el-Mandeb, Suez Canal                |
| ID→USLAX      | 18          | Malacca Strait                           |
| BD→USLAX      | 30          | Malacca Strait, Bab-el-Mandeb, Suez      |
| MX→USLAX      | 3           | none                                     |

## Process
1. Look up lane from internal table; fall back to closest-matching lane
2. Sample AIS WebSocket for 8s → count distinct MMSIs in lane bounding box → density (0=unknown, 1–2=low, 3–9=medium, 10+=high)
3. Fetch Open-Meteo marine forecast for primary waypoint (24h avg wave height)
4. Query GDELT for active chokepoint events (14-day window)
5. Single Mercury call consolidates data into route assessment

## Notes
- AIS sample may return 0 in quiet windows → `current_traffic_density: "unknown"` (not a failure)
- Chokepoint queries are hardcoded Suez/Hormuz/Panama/Malacca/Bab-el-Mandeb
