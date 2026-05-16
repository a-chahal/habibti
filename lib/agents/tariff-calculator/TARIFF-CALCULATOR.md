# Tariff Calculator Agent

**Tier:** mercury  
**Source:** Federal Register USTR API + internal lane/rate tables  
**Cache:** 6h by hs_code:origin_country

## Input
```json
{ "hs_code": "5208", "origin_country": "CN", "product_value_usd": 25000, "shipmentId": "uuid" }
```

## Output
```json
{
  "hs_code": "5208",
  "origin_country": "CN",
  "product_value_usd": 25000,
  "base_duty_pct": 8.4,
  "section_301_pct": 7.5,
  "section_232_pct": null,
  "section_122_pct": null,
  "total_duty_pct": 15.9,
  "freight_estimate_usd": 4200,
  "insurance_usd": 300,
  "broker_fee_usd": 250,
  "total_landed_cost_usd": 32725,
  "citations": ["USTR Section 301 List 4A", "HTS Chapter 52"]
}
```

## Process
1. Fetch 5 most recent USTR Federal Register documents for tariff overlay context
2. Single Mercury call: stack base MFN rate + Section 301 (China only) + Section 232 (metals) + Section 122 (if applicable)
3. Compute total_landed_cost = product_value + (product_value × total_duty%) + freight + insurance + broker_fee

## Lane Freight Table
| Origin | Freight/container |
|--------|------------------|
| CN     | $4,200           |
| VN     | $4,500           |
| ID     | $4,800           |
| IN     | $5,200           |
| MX     | $1,800           |
| BD     | $5,500           |
| Default| $5,000           |

## Fixed Costs
- Insurance: 1.2% of product value
- Broker fee: $250 flat
