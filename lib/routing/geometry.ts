const R_NM = 3440.065; // Earth radius in nautical miles

export function haversineNm(
  lat1: number, lon1: number,
  lat2: number, lon2: number
): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R_NM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Sample ~N evenly-spaced waypoints along the great-circle between two points. */
export function greatCircleWaypoints(
  lat1: number, lon1: number,
  lat2: number, lon2: number,
  count = 5
): Array<{ lat: number; lon: number }> {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const toDeg = (r: number) => (r * 180) / Math.PI;

  const φ1 = toRad(lat1), λ1 = toRad(lon1);
  const φ2 = toRad(lat2), λ2 = toRad(lon2);

  const points: Array<{ lat: number; lon: number }> = [];
  for (let i = 0; i <= count + 1; i++) {
    const f = i / (count + 1);
    const A = Math.sin((1 - f) * Math.PI) / Math.sin(Math.PI); // degenerate, use linear interp
    const sinD = Math.sqrt(
      (Math.cos(φ2) * Math.sin(λ2 - λ1)) ** 2 +
      (Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(λ2 - λ1)) ** 2
    );
    const d = Math.atan2(sinD, Math.sin(φ1) * Math.sin(φ2) + Math.cos(φ1) * Math.cos(φ2) * Math.cos(λ2 - λ1));

    if (d === 0) {
      points.push({ lat: lat1, lon: lon1 });
      continue;
    }

    const sinA = Math.sin(f * d) / Math.sin(d);
    const sinB = Math.sin((1 - f) * d) / Math.sin(d);

    const x = sinB * Math.cos(φ1) * Math.cos(λ1) + sinA * Math.cos(φ2) * Math.cos(λ2);
    const y = sinB * Math.cos(φ1) * Math.sin(λ1) + sinA * Math.cos(φ2) * Math.sin(λ2);
    const z = sinB * Math.sin(φ1) + sinA * Math.sin(φ2);

    points.push({
      lat: toDeg(Math.atan2(z, Math.sqrt(x * x + y * y))),
      lon: toDeg(Math.atan2(y, x)),
    });
  }
  return points;
}

/**
 * Produce an AIS bounding box for a leg between two lat/lon points,
 * padded by `padDeg` degrees. Handles antimeridian crossing: if the shorter
 * great-circle arc crosses ±180°, the bbox is normalised so that minLon > maxLon
 * (caller must interpret as "spans the antimeridian"). Use bboxOverlap() to test.
 */
export function legBbox(
  lat1: number, lon1: number,
  lat2: number, lon2: number,
  padDeg = 2
): [number, number, number, number] {
  const dLon = Math.abs(lon2 - lon1);
  const crossesAntimeridian = dLon > 180;
  if (!crossesAntimeridian) {
    return [
      Math.min(lat1, lat2) - padDeg,
      Math.min(lon1, lon2) - padDeg,
      Math.max(lat1, lat2) + padDeg,
      Math.max(lon1, lon2) + padDeg,
    ];
  }
  // Antimeridian-spanning: the eastern bound is the smaller (negative) lon,
  // wrapped past +180°. Encode as minLon > maxLon — callers must split.
  const eastLon = Math.max(lon1, lon2);   // e.g. +121.5
  const westLon = Math.min(lon1, lon2);   // e.g. -118.26
  return [
    Math.min(lat1, lat2) - padDeg,
    eastLon - padDeg,
    Math.max(lat1, lat2) + padDeg,
    westLon + padDeg,
  ];
}

/**
 * Overlap test that respects the antimeridian convention above.
 * If `a` has minLon > maxLon, treat it as two halves: [minLon..180] ∪ [-180..maxLon].
 */
export function bboxOverlap(
  a: [number, number, number, number],
  b: [number, number, number, number]
): boolean {
  const [aMinLat, aMinLon, aMaxLat, aMaxLon] = a;
  const [bMinLat, bMinLon, bMaxLat, bMaxLon] = b;
  if (aMaxLat < bMinLat || aMinLat > bMaxLat) return false;

  const aWraps = aMinLon > aMaxLon;
  const bWraps = bMinLon > bMaxLon;

  if (!aWraps && !bWraps) {
    return !(aMaxLon < bMinLon || aMinLon > bMaxLon);
  }
  if (aWraps && !bWraps) {
    // a is split into [aMinLon..180] and [-180..aMaxLon]
    const half1 = !(180 < bMinLon || aMinLon > bMaxLon);
    const half2 = !(aMaxLon < bMinLon || -180 > bMaxLon);
    return half1 || half2;
  }
  if (!aWraps && bWraps) {
    const half1 = !(aMaxLon < bMinLon || aMinLon > 180);
    const half2 = !(aMaxLon < -180 || aMinLon > bMaxLon);
    return half1 || half2;
  }
  // Both wrap — they always overlap somewhere (both touch antimeridian)
  return true;
}

/** Convert nautical miles to approximate transit days at 12 knots average speed. */
export function nmToTransitDays(nm: number, speedKnots = 12): number {
  return Math.round(nm / (speedKnots * 24) * 10) / 10;
}
