# Port Congestion Agent

**Tier:** mercury  
**Source:** Simulated vessel counts (UNCTAD baselines + noise) + GDELT for cause classification  
**Interval:** 60 seconds (5s in TEST_MONITORING=1 mode)

## What it does

Checks vessel congestion at the origin and destination ports. Compares current (simulated) vessel counts against UNCTAD 30-day average baselines. If count > 1.5× baseline, classifies the cause using Mercury + GDELT news context and writes a `port_congestion` signal.

## UNCTAD baselines (vessels in anchorage)

| Port | Code | Baseline |
|------|------|----------|
| Los Angeles | USLAX | 42 |
| Long Beach | USLGB | 38 |
| New York | USNYC | 25 |
| Singapore | SGSIN | 65 |
| Ho Chi Minh City | VNSGN | 28 |
| Shanghai | CNSGH | 70 |
| Tanjung Priok | IDTPP | 22 |
| Port Said | EGPSD | 18 |
| Rotterdam | NLRTM | 52 |
| Hamburg | DEHAM | 35 |

## Congestion threshold

`ratio = current / baseline`. Signal written only when `ratio ≥ 1.5`.

## Cause classification schema (Mercury output)

```json
{
  "cause": "seasonal|weather|strike|vessel_incident|unexplained",
  "confidence": 0.0-1.0,
  "one_line_summary": "..."
}
```

## Signal outputs

**Routine (no congestion):**
```json
{ "signal_type": "port_status", "severity": "info", "payload": { "port": "USLAX", "vessel_count": 38, "baseline": 42, "ratio": 0.9, "congested": false } }
```

**Congested:**
```json
{ "signal_type": "port_congestion", "severity": "medium", "payload": { "port": "USLAX", "vessel_count": 89, "baseline": 42, "ratio": 2.1, "congested": true, "cause": "strike", "cause_confidence": 0.85, "summary": "..." } }
```

## Caching

Cause classification is cached per port per hour to avoid redundant LLM calls.
