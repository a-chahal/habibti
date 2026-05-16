# Feedback Loop Agent

**Tier:** sonnet  
**Trigger:** Shipment reaches 'arrived' or 'cancelled' status  
**Writes:** `supplier_history` row + `route_history` row + `delivery_feedback` signal

## Input
```json
{
  "shipmentId": "uuid",
  "actual_delivered_at": "2025-07-19",
  "notes": "Delayed at Malacca due to port congestion"
}
```

## Output
```json
{
  "shipment_id": "uuid",
  "predicted_eta": "2025-07-15",
  "actual_eta": "2025-07-19",
  "delay_days": 4.0,
  "reliability_score": 0.714,
  "predicted_transit_days": 16,
  "actual_transit_days": 20,
  "learning_note": "The shipment arrived 4 days late..."
}
```

## Process
1. Load shipment + all signals + options for the shipment
2. Find rank-1 option → extract supplier_id, predicted ETA, origin
3. Compute delay_days = actual_date − predicted_eta
4. Compute reliability_score = max(0, 1 − |delay_days| / 14) → 1.0 = on-time, 0 = ≥14 days late
5. If supplier_id exists: write `supplier_history` row
6. Write `route_history` row with origin_port, destination_port, transit day deltas, chokepoint disruptions
7. Sonnet generates one-paragraph learning note: what happened, likely cause, one recommendation

## Reliability Score Formula
```
reliability_score = max(0, min(1, 1 - |delay_days| / 14))
```
- On time: 1.0
- 7 days late: 0.5
- ≥14 days late: 0.0

## Learning Note Format (Sonnet writes this)
3–5 sentences:
1. State what happened with specific numbers (e.g., "arrived 4 days late, transit was 20 days vs. 16 predicted")
2. Identify most likely cause from signal data
3. One concrete recommendation for the next similar shipment
