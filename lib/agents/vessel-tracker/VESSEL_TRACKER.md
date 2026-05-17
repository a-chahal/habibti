# Vessel Tracker Agent

**Tier:** none (pure data, no LLM)  
**Source:** Pre-recorded track files in `/data/tracks/`  
**Interval:** 5 seconds (3s in TEST_MONITORING=1 mode)

## What it does

Replays pre-recorded AIS position tracks for demo shipments on a timer. Each tick advances one waypoint and writes a `vessel_position` signal. Since most position updates are routine, the Synthesizer correctly marks them non-material and generates no alerts.

## Track files

| Scenario | File | Route | Waypoints | Duration |
|----------|------|-------|-----------|----------|
| Cotton — Sarah's primary | `cotton-la.json` | HCMC → Los Angeles (Trans-Pacific) | 50 | ~16 days |
| Cinnamon | `cinnamon-ny.json` | Tanjung Priok → New York (via Suez) | 50 | ~22 days |
| Batteries | `batteries-lb.json` | Shanghai → Long Beach (Trans-Pacific) | 50 | ~14 days |

Track format per waypoint:
```json
{
  "timestamp_offset_seconds": 28000,
  "lat": 14.12,
  "lon": 108.75,
  "speed_knots": 16.5,
  "heading": 38
}
```

## Scenario mapping

Scenario is inferred from `originCountry + destinationPort`:
- `VN-USLAX` → cotton-la
- `ID-USNYC` → cinnamon-ny
- `CN-USLGB` → batteries-lb

Override by setting `ctx.scenarioId` explicitly.

## Signal output

```json
{
  "signal_type": "vessel_position",
  "severity": "info",
  "payload": {
    "track_index": 4,
    "lat": 12.14,
    "lon": 110.56,
    "speed_knots": 16.5,
    "heading": 36,
    "timestamp_offset_seconds": 112000,
    "vessel_mmsi": null,
    "on_schedule": true
  }
}
```

## Design notes

- Loops track infinitely if the shipment stays in_transit beyond the track duration
- Severity is always `info` so Synthesizer skips most without belief updates
- Stops when shipment reaches `arrived` or `cancelled` status
