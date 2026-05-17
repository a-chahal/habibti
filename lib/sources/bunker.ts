// Bunker fuel price index — drives freight cost realism.
// Source: Ship & Bunker / MABUX global averages. We refresh periodically;
// the static value below is the 2026-Q2 published mid-cycle level.
// Returning a function so we can later swap to a live fetch without breaking callers.

export interface BunkerPrice {
  ifo380_usd_per_mt: number;    // residual fuel (legacy ships)
  vlsfo_usd_per_mt: number;     // 0.5% sulfur compliant — most container ships
  mgo_usd_per_mt: number;       // marine gas oil — port/ECA fuel
  as_of: string;                // YYYY-MM-DD
  source: string;
}

// Stable static snapshot — updated manually from public MABUX/Ship&Bunker prints.
const STATIC_PRICES: BunkerPrice = {
  ifo380_usd_per_mt: 485,
  vlsfo_usd_per_mt: 615,
  mgo_usd_per_mt: 780,
  as_of: "2026-04-15",
  source: "MABUX global mid-cycle (static snapshot)",
};

export async function getBunkerPrice(): Promise<BunkerPrice> {
  // Future: live fetch from Ship & Bunker scrape / MABUX feed.
  // For now: deterministic, no network call, hard-coded snapshot.
  return STATIC_PRICES;
}

/** Approximate fuel cost for a leg, in USD, assuming a typical 12-knot 80,000-DWT containership. */
export function estimateLegFuelCostUsd(distance_nm: number, fuelPricePerMt: number): number {
  // ~150 MT VLSFO per 1,000nm at 12 knots is a reasonable industry rule of thumb
  const mt = (distance_nm / 1000) * 150;
  return Math.round(mt * fuelPricePerMt);
}
