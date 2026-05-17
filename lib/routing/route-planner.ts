import { basinForLatLon, getBasin, BASINS, basinsAdjacent } from "./basins";
import { CHOKEPOINTS, getChokepoint } from "./chokepoints";
import { haversineNm, greatCircleWaypoints, legBbox, nmToTransitDays } from "./geometry";

export interface PortCoord {
  locode: string;
  name: string;
  lat: number;
  lon: number;
}

export interface RouteLeg {
  from: { locode: string; name: string; lat: number; lon: number };
  to: { locode: string; name: string; lat: number; lon: number };
  distance_nm: number;
  estimated_days: number;
  chokepoint_id: string | null;
  waypoints: Array<{ lat: number; lon: number }>;
  bbox: [number, number, number, number];
}

export interface RoutePlan {
  origin_port: PortCoord;
  destination_port: PortCoord;
  legs: RouteLeg[];
  chokepoints: string[];
  transshipment_ports: string[];
  total_distance_nm: number;
  total_transit_days: number;
  canal_tolls_usd: number;
  score: number; // lower = better
}

// --------------------------------------------------------------------------
// Graph node: either origin/dest terminal or a chokepoint
// --------------------------------------------------------------------------

interface GraphNode {
  id: string;
  name: string;
  lat: number;
  lon: number;
  basin: string;
  is_chokepoint: boolean;
  chokepoint_data?: (typeof CHOKEPOINTS)[string];
}

function buildGraph(origin: PortCoord, dest: PortCoord): GraphNode[] {
  const nodes: GraphNode[] = [
    {
      id: "origin",
      name: origin.name,
      lat: origin.lat,
      lon: origin.lon,
      basin: basinForLatLon(origin.lat, origin.lon),
      is_chokepoint: false,
    },
    {
      id: "dest",
      name: dest.name,
      lat: dest.lat,
      lon: dest.lon,
      basin: basinForLatLon(dest.lat, dest.lon),
      is_chokepoint: false,
    },
  ];

  for (const [id, cp] of Object.entries(CHOKEPOINTS)) {
    const b1 = basinForLatLon(cp.lat, cp.lon);
    // A chokepoint sits on the boundary of two basins — use connects[] as canonical
    nodes.push({
      id,
      name: cp.name,
      lat: cp.lat,
      lon: cp.lon,
      basin: b1,
      is_chokepoint: true,
      chokepoint_data: cp,
    });
  }

  return nodes;
}

/**
 * Two nodes are connected if their basin sets overlap OR if their basins are
 * declared open-water adjacent. Chokepoints carry both endpoint basins via .connects[].
 * This enforces that enclosed seas (mediterranean, persian_gulf, etc.) can ONLY
 * be entered through their chokepoints.
 */
function basinSet(node: GraphNode): string[] {
  if (node.is_chokepoint && node.chokepoint_data) {
    return [node.basin, ...node.chokepoint_data.connects];
  }
  return [node.basin];
}

function nodesConnected(a: GraphNode, b: GraphNode): boolean {
  const aB = basinSet(a);
  const bB = basinSet(b);
  // Direct: share a basin
  for (const x of aB) if (bB.includes(x)) return true;
  // Open-water adjacency
  for (const x of aB) {
    for (const y of bB) {
      if (basinsAdjacent(x, y)) return true;
    }
  }
  return false;
}

// --------------------------------------------------------------------------
// Path enumeration (DFS with visited set, max depth 6 hops)
// --------------------------------------------------------------------------

function enumeratePaths(
  nodes: GraphNode[],
  startId: string,
  endId: string,
  maxDepth = 6
): string[][] {
  const paths: string[][] = [];
  const adj = new Map<string, string[]>();

  for (const a of nodes) {
    const connected: string[] = [];
    for (const b of nodes) {
      if (a.id !== b.id && nodesConnected(a, b)) {
        connected.push(b.id);
      }
    }
    adj.set(a.id, connected);
  }

  function dfs(current: string, visited: Set<string>, path: string[]) {
    if (current === endId) {
      paths.push([...path]);
      return;
    }
    if (path.length >= maxDepth) return;
    for (const next of adj.get(current) ?? []) {
      if (!visited.has(next)) {
        visited.add(next);
        path.push(next);
        dfs(next, visited, path);
        path.pop();
        visited.delete(next);
      }
    }
  }

  dfs(startId, new Set([startId]), [startId]);
  return paths;
}

// --------------------------------------------------------------------------
// Score a path
// --------------------------------------------------------------------------

function scorePath(
  path: string[],
  nodeMap: Map<string, GraphNode>
): { distance_nm: number; tolls: number; score: number } {
  let distance = 0;
  let tolls = 0;
  for (let i = 0; i < path.length - 1; i++) {
    const a = nodeMap.get(path[i])!;
    const b = nodeMap.get(path[i + 1])!;
    distance += haversineNm(a.lat, a.lon, b.lat, b.lon);
  }
  for (const nodeId of path) {
    const node = nodeMap.get(nodeId);
    if (node?.is_chokepoint && node.chokepoint_data && !node.chokepoint_data.is_passage) {
      tolls += node.chokepoint_data.toll_usd_per_teu;
      if (node.chokepoint_data.seasonal) tolls += 50; // seasonal surcharge
    }
  }
  // score: distance (nm) + toll penalty (1 toll dollar = ~5nm equivalent)
  const score = distance + tolls * 5;
  return { distance_nm: distance, tolls, score };
}

// --------------------------------------------------------------------------
// Build RoutePlan from a path
// --------------------------------------------------------------------------

function buildRoutePlan(
  path: string[],
  nodeMap: Map<string, GraphNode>,
  origin: PortCoord,
  dest: PortCoord
): RoutePlan {
  const legs: RouteLeg[] = [];
  const chokepointIds: string[] = [];
  let totalDistance = 0;
  let canalTolls = 0;

  for (let i = 0; i < path.length - 1; i++) {
    const a = nodeMap.get(path[i])!;
    const b = nodeMap.get(path[i + 1])!;
    const dist = haversineNm(a.lat, a.lon, b.lat, b.lon);
    totalDistance += dist;

    const cpId = b.is_chokepoint ? b.id : null;
    if (cpId) {
      chokepointIds.push(cpId);
      const cp = getChokepoint(cpId);
      if (cp && !cp.is_passage) canalTolls += cp.toll_usd_per_teu;
    }

    legs.push({
      from: { locode: a.id === "origin" ? origin.locode : a.id, name: a.name, lat: a.lat, lon: a.lon },
      to: { locode: b.id === "dest" ? dest.locode : b.id, name: b.name, lat: b.lat, lon: b.lon },
      distance_nm: Math.round(dist),
      estimated_days: nmToTransitDays(dist),
      chokepoint_id: cpId,
      waypoints: greatCircleWaypoints(a.lat, a.lon, b.lat, b.lon, 4),
      bbox: legBbox(a.lat, a.lon, b.lat, b.lon),
    });
  }

  const transitDays = nmToTransitDays(totalDistance);
  const { score } = scorePath(path, nodeMap);

  return {
    origin_port: origin,
    destination_port: dest,
    legs,
    chokepoints: chokepointIds,
    transshipment_ports: [],
    total_distance_nm: Math.round(totalDistance),
    total_transit_days: Math.ceil(transitDays),
    canal_tolls_usd: canalTolls,
    score,
  };
}

// --------------------------------------------------------------------------
// Public API
// --------------------------------------------------------------------------

export interface PlanRoutesOpts {
  maxRoutes?: number;
  maxDepth?: number;
}

export function planRoutes(
  origin: PortCoord,
  dest: PortCoord,
  opts: PlanRoutesOpts = {}
): RoutePlan[] {
  const { maxRoutes = 3, maxDepth = 6 } = opts;

  const nodes = buildGraph(origin, dest);
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));

  const paths = enumeratePaths(nodes, "origin", "dest", maxDepth);

  if (paths.length === 0) {
    // Fallback: direct leg even if basins don't connect (e.g. data gap)
    const directDist = haversineNm(origin.lat, origin.lon, dest.lat, dest.lon);
    return [
      {
        origin_port: origin,
        destination_port: dest,
        legs: [
          {
            from: { locode: origin.locode, name: origin.name, lat: origin.lat, lon: origin.lon },
            to: { locode: dest.locode, name: dest.name, lat: dest.lat, lon: dest.lon },
            distance_nm: Math.round(directDist),
            estimated_days: nmToTransitDays(directDist),
            chokepoint_id: null,
            waypoints: greatCircleWaypoints(origin.lat, origin.lon, dest.lat, dest.lon, 4),
            bbox: legBbox(origin.lat, origin.lon, dest.lat, dest.lon),
          },
        ],
        chokepoints: [],
        transshipment_ports: [],
        total_distance_nm: Math.round(directDist),
        total_transit_days: Math.ceil(nmToTransitDays(directDist)),
        canal_tolls_usd: 0,
        score: directDist,
      },
    ];
  }

  // Score and deduplicate (by chokepoint sequence)
  const scored = paths.map((p) => {
    const { score } = scorePath(p, nodeMap);
    return { path: p, score };
  });
  scored.sort((a, b) => a.score - b.score);

  const seen = new Set<string>();
  const unique: typeof scored = [];
  for (const s of scored) {
    const key = s.path.filter((id) => id !== "origin" && id !== "dest").join(",");
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(s);
    }
  }

  return unique.slice(0, maxRoutes).map((s) => buildRoutePlan(s.path, nodeMap, origin, dest));
}

// --------------------------------------------------------------------------
// Air route: single great-circle leg, no chokepoints, no graph search.
// Used when modality is air courier. Commercial jets ~450 kn cruise.
// --------------------------------------------------------------------------

const AIR_CRUISE_KNOTS = 450;

export function planAirRoute(origin: PortCoord, dest: PortCoord): RoutePlan {
  const directNm = haversineNm(origin.lat, origin.lon, dest.lat, dest.lon);
  // Air transit days: distance/speed + 1d handling on each end (customs, processing).
  // Cap at 7d for very long haul; floor at 2d.
  const flightHours = directNm / AIR_CRUISE_KNOTS;
  const transitDays = Math.min(7, Math.max(2, Math.ceil(flightHours / 24 + 2)));

  return {
    origin_port: origin,
    destination_port: dest,
    legs: [
      {
        from: { locode: origin.locode, name: origin.name, lat: origin.lat, lon: origin.lon },
        to: { locode: dest.locode, name: dest.name, lat: dest.lat, lon: dest.lon },
        distance_nm: Math.round(directNm),
        estimated_days: transitDays,
        chokepoint_id: null,
        waypoints: greatCircleWaypoints(origin.lat, origin.lon, dest.lat, dest.lon, 8),
        bbox: legBbox(origin.lat, origin.lon, dest.lat, dest.lon),
      },
    ],
    chokepoints: [],
    transshipment_ports: [],
    total_distance_nm: Math.round(directNm),
    total_transit_days: transitDays,
    canal_tolls_usd: 0,
    score: directNm,
  };
}
