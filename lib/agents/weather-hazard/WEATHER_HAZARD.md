# Weather Hazard Agent

**Tier:** mercury  
**Source:** Open-Meteo Marine API (free, no key required)  
**Interval:** 6 hours (18s in TEST_MONITORING=1 mode)

## What it does

Samples 6 waypoints along the shipment's route. For each, fetches a 48-hour Open-Meteo Marine forecast and checks for wave heights > 4m or wind-wave heights > 3.5m. If any waypoints exceed thresholds, Mercury generates a structured hazard summary.

## Route waypoints (lat, lon)

| Route | Waypoints |
|-------|-----------|
| VN-USLAX | 14°N 112.5°E, 22°N 124°E, 30°N 140°E, 40°N 160°E, 42°N 175°W, 38°N 148°W |
| ID-USNYC | 4°N 95°E, 8°N 70°E, 14°N 51°E, 25°N 36°E, 35.5°N 14°E, 38°N 20°W |
| CN-USLGB | 33°N 130°E, 38°N 148°E, 43°N 165°E, 44°N 175°W, 40°N 155°W, 36°N 132°W |

## Thresholds

- Wave height (Hs) > 4.0m → significant for container vessels
- Wind-wave height > 3.5m → notable sea state for cargo ops

## Hazard classification schema (Mercury output)

```json
{
  "hazard_level": "none|caution|moderate|severe",
  "affected_waypoints": 2,
  "summary": "...",
  "eta_impact_days": 1|null
}
```

## Signal outputs

**No hazard:**
```json
{ "signal_type": "weather_status", "severity": "info", "payload": { "waypoints_checked": 6, "hazardous_waypoints": 0, "summary": "All 6 route waypoints within normal wave thresholds." } }
```

**Hazard found:**
```json
{ "signal_type": "weather_hazard", "severity": "medium", "payload": {
    "hazard_level": "moderate",
    "affected_waypoints": 2,
    "waypoints_checked": 6,
    "hazardous_points": [{"lat": 40.0, "lon": 160.0, "max_wave_m": 4.8, "max_wind_wave_m": 3.9}],
    "summary": "...",
    "eta_impact_days": 1
} }
```

## Open-Meteo Marine

- Free tier, no authentication
- Forecast resolution: hourly, up to 7 days
- Rate limit: generous for demo purposes
- Endpoint: `https://marine-api.open-meteo.com/v1/marine`
