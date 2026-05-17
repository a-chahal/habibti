import { planRoutes } from "../lib/routing/route-planner";

const PORTS: Record<string, { locode: string; name: string; lat: number; lon: number }> = {
  CNSHA: { locode: "CNSHA", name: "Shanghai", lat: 31.2222, lon: 121.4965 },
  CNNGB: { locode: "CNNGB", name: "Ningbo", lat: 29.8683, lon: 121.5440 },
  CNYTN: { locode: "CNYTN", name: "Yantian (Shenzhen)", lat: 22.5500, lon: 114.2600 },
  VNSGN: { locode: "VNSGN", name: "Ho Chi Minh City", lat: 10.8231, lon: 106.6297 },
  INNSA: { locode: "INNSA", name: "Nhava Sheva (Mumbai)", lat: 18.9500, lon: 72.9500 },
  USLAX: { locode: "USLAX", name: "Los Angeles", lat: 33.7295, lon: -118.2620 },
  USNYC: { locode: "USNYC", name: "New York", lat: 40.6840, lon: -74.0440 },
  NLRTM: { locode: "NLRTM", name: "Rotterdam", lat: 51.9225, lon: 4.4792 },
  SGSIN: { locode: "SGSIN", name: "Singapore", lat: 1.2655, lon: 103.8239 },
  DEHAM: { locode: "DEHAM", name: "Hamburg", lat: 53.5489, lon: 9.9680 },
  BRPEC: { locode: "BRPEC", name: "Santos", lat: -23.9680, lon: -46.3500 },
  AUBNE: { locode: "AUBNE", name: "Brisbane", lat: -27.4678, lon: 153.0281 },
};

interface TestCase {
  origin: string;
  dest: string;
  expectChokepointContains?: string[];
  description: string;
}

const TESTS: TestCase[] = [
  {
    origin: "CNSHA",
    dest: "USLAX",
    description: "Shanghai → Los Angeles (Trans-Pacific direct, no chokepoint needed)",
  },
  {
    origin: "INNSA",
    dest: "USLAX",
    expectChokepointContains: ["malacca"],
    description: "Mumbai → Los Angeles (via Malacca + trans-Pacific OR Suez+Panama)",
  },
  {
    origin: "VNSGN",
    dest: "SGSIN",
    description: "Ho Chi Minh → Singapore (same region, short hop)",
  },
  {
    origin: "CNSHA",
    dest: "NLRTM",
    expectChokepointContains: ["suez"],
    description: "Shanghai → Rotterdam (via Malacca + Suez or via Panama)",
  },
  {
    origin: "CNSHA",
    dest: "USNYC",
    description: "Shanghai → New York",
  },
  {
    origin: "DEHAM",
    dest: "USLAX",
    expectChokepointContains: ["panama"],
    description: "Hamburg → Los Angeles (via Panama Canal — only path)",
  },
  {
    origin: "BRPEC",
    dest: "USLAX",
    description: "Santos (Brazil) → Los Angeles",
  },
  {
    origin: "AUBNE",
    dest: "USLAX",
    description: "Brisbane → Los Angeles",
  },
];

function check(label: string, condition: boolean, detail?: string) {
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    console.error(`  ✗ ${label}${detail ? ": " + detail : ""}`);
    process.exitCode = 1;
  }
}

for (const t of TESTS) {
  const origin = PORTS[t.origin];
  const dest = PORTS[t.dest];
  console.log(`\n── ${t.description}`);

  const routes = planRoutes(origin, dest, { maxRoutes: 3 });
  check("returns 1-3 routes", routes.length >= 1 && routes.length <= 3, `got ${routes.length}`);

  const best = routes[0];
  check("best route has legs", best.legs.length >= 1);
  check("total_distance_nm > 0", best.total_distance_nm > 0);
  check("total_transit_days > 0", best.total_transit_days > 0);

  console.log(
    `  → ${best.legs.length} legs, ${best.total_distance_nm}nm, ${best.total_transit_days}d, ` +
    `chokepoints=[${best.chokepoints.join(",")}], tolls=$${best.canal_tolls_usd}`
  );

  for (const leg of best.legs) {
    check(`  leg ${leg.from.name}→${leg.to.name} has bbox`, leg.bbox.length === 4);
    check(`  leg waypoints`, leg.waypoints.length >= 2);
  }

  if (t.expectChokepointContains && t.expectChokepointContains.length > 0) {
    // At least one of the top 3 routes should contain all expected chokepoints
    const allRouteChokepoints = routes.flatMap((r) => r.chokepoints);
    for (const cp of t.expectChokepointContains) {
      check(`at least one route includes chokepoint '${cp}'`, allRouteChokepoints.includes(cp));
    }
  }

  if (routes.length > 1) {
    const r2 = routes[1];
    console.log(
      `  alt: ${r2.legs.length} legs, ${r2.total_distance_nm}nm, chokepoints=[${r2.chokepoints.join(",")}]`
    );
  }
}

console.log("\nDone.");
