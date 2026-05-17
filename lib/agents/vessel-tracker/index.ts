import { readFileSync } from "fs";
import { join } from "path";
import { Agent } from "../base";
import { getShipment } from "../../db/queries";
import { MonitoringScheduler, isTerminal, type MonitoringContext } from "../monitoring-base";

interface TrackWaypoint {
  timestamp_offset_seconds: number;
  lat: number;
  lon: number;
  speed_knots: number;
  heading: number;
}

const INTERVAL_MS = process.env.TEST_MONITORING === "1" ? 3_000 : 5_000;

const SCENARIO_MAP: Record<string, string> = {
  "VN-USLAX": "cotton-la",
  "ID-USNYC": "cinnamon-ny",
  "CN-USLGB": "batteries-lb",
};

// Bounding boxes for named chokepoints — vessel_position triggers chokepoint_entered signal
const CHOKEPOINT_BBOXES: Record<string, { minLat: number; maxLat: number; minLon: number; maxLon: number }> = {
  "Suez Canal": { minLat: 29.9, maxLat: 31.5, minLon: 32.0, maxLon: 33.0 },
  "Bab-el-Mandeb": { minLat: 11.5, maxLat: 13.0, minLon: 42.5, maxLon: 44.0 },
  "Malacca Strait": { minLat: 1.0, maxLat: 6.5, minLon: 99.0, maxLon: 104.5 },
  "Panama Canal": { minLat: 8.0, maxLat: 10.0, minLon: -80.5, maxLon: -79.5 },
  "Hormuz": { minLat: 25.5, maxLat: 27.0, minLon: 56.0, maxLon: 58.5 },
};

function loadTrack(scenarioId: string): TrackWaypoint[] {
  const filePath = join(process.cwd(), "data", "tracks", `${scenarioId}.json`);
  try {
    return JSON.parse(readFileSync(filePath, "utf-8")) as TrackWaypoint[];
  } catch {
    return [];
  }
}

export class VesselTrackerAgent extends Agent {
  readonly name = "vessel-tracker";
  readonly tier = "none" as const;

  private scheduler = new MonitoringScheduler();
  private trackIndex = new Map<string, number>();
  private tracks = new Map<string, TrackWaypoint[]>();
  private startedAt = new Map<string, Date>();
  private lastPositions = new Map<string, { lat: number; lon: number }>();
  private enteredChokepoints = new Map<string, Set<string>>();

  startMonitoring(ctx: MonitoringContext): void {
    const key = `${ctx.originCountry ?? "XX"}-${ctx.destinationPort ?? "USLAX"}`;
    const scenarioId = ctx.scenarioId ?? SCENARIO_MAP[key] ?? "cotton-la";
    const track = loadTrack(scenarioId);
    this.tracks.set(ctx.shipmentId, track);
    this.trackIndex.set(ctx.shipmentId, 0);
    this.startedAt.set(ctx.shipmentId, new Date());
    this.enteredChokepoints.set(ctx.shipmentId, new Set());

    console.log(`[vessel-tracker] starting for ${ctx.shipmentId}, scenario=${scenarioId}, ${track.length} waypoints`);

    this.scheduler.start(
      ctx.shipmentId,
      () => this.tick(ctx),
      INTERVAL_MS
    );
  }

  stopMonitoring(shipmentId: string): void {
    this.scheduler.stop(shipmentId);
    this.tracks.delete(shipmentId);
    this.trackIndex.delete(shipmentId);
    this.startedAt.delete(shipmentId);
    this.lastPositions.delete(shipmentId);
    this.enteredChokepoints.delete(shipmentId);
    console.log(`[vessel-tracker] stopped for ${shipmentId}`);
  }

  private async tick(ctx: MonitoringContext): Promise<void> {
    const shipment = await getShipment(ctx.shipmentId);
    if (!shipment || isTerminal(shipment.status)) {
      this.stopMonitoring(ctx.shipmentId);
      return;
    }

    const track = this.tracks.get(ctx.shipmentId);
    if (!track || track.length === 0) return;

    const idx = this.trackIndex.get(ctx.shipmentId) ?? 0;
    const waypoint = track[idx % track.length];
    this.trackIndex.set(ctx.shipmentId, idx + 1);

    // Deduplicate near-static positions (vessel at anchor, etc.)
    const lastPos = this.lastPositions.get(ctx.shipmentId);
    if (lastPos &&
        Math.abs(waypoint.lat - lastPos.lat) < 0.01 &&
        Math.abs(waypoint.lon - lastPos.lon) < 0.01) {
      return; // skip near-duplicate
    }
    this.lastPositions.set(ctx.shipmentId, { lat: waypoint.lat, lon: waypoint.lon });

    // Compute on_schedule from expectedEta + transitDays
    let onSchedule = true;
    let scheduleDeviation = 0;
    const start = this.startedAt.get(ctx.shipmentId);
    if (ctx.expectedEta && ctx.transitDays && start) {
      const totalMs = ctx.transitDays * 24 * 60 * 60 * 1000;
      const elapsedMs = Date.now() - start.getTime();
      const expectedProgress = Math.min(1, elapsedMs / totalMs);
      const actualProgress = track.length > 0 ? (idx + 1) / track.length : 0;
      scheduleDeviation = actualProgress - expectedProgress;
      onSchedule = Math.abs(scheduleDeviation) < 0.05;
    }

    const deviationSeverity = Math.abs(scheduleDeviation) > 0.15 ? "medium"
      : Math.abs(scheduleDeviation) > 0.05 ? "low"
      : "info";

    await this.publishSignal({
      shipmentId: ctx.shipmentId,
      signalType: "vessel_position",
      severity: onSchedule ? "info" : deviationSeverity as "info" | "low" | "medium",
      payload: {
        track_index: idx,
        lat: waypoint.lat,
        lon: waypoint.lon,
        speed_knots: waypoint.speed_knots,
        heading: waypoint.heading,
        timestamp_offset_seconds: waypoint.timestamp_offset_seconds,
        vessel_mmsi: ctx.vesselMmsi ?? null,
        on_schedule: onSchedule,
        schedule_deviation: +scheduleDeviation.toFixed(3),
      },
      confidence: 0.99,
    });

    // Emit chokepoint_entered signal when vessel crosses into a named chokepoint
    const entered = this.enteredChokepoints.get(ctx.shipmentId) ?? new Set<string>();
    const chokepoints = ctx.chokepoints?.length ? ctx.chokepoints : Object.keys(CHOKEPOINT_BBOXES);
    for (const cpName of chokepoints) {
      const bbox = CHOKEPOINT_BBOXES[cpName];
      if (!bbox) continue;
      if (
        waypoint.lat >= bbox.minLat && waypoint.lat <= bbox.maxLat &&
        waypoint.lon >= bbox.minLon && waypoint.lon <= bbox.maxLon
      ) {
        if (!entered.has(cpName)) {
          entered.add(cpName);
          await this.publishSignal({
            shipmentId: ctx.shipmentId,
            signalType: "chokepoint_entered",
            severity: "medium",
            payload: {
              chokepoint: cpName,
              lat: waypoint.lat,
              lon: waypoint.lon,
              track_index: idx,
            },
            confidence: 0.95,
          });
          console.log(`[vessel-tracker] ${ctx.shipmentId} entered chokepoint: ${cpName}`);
        }
      } else {
        // Vessel has left the chokepoint bbox — mark as cleared
        entered.delete(cpName);
      }
    }
    this.enteredChokepoints.set(ctx.shipmentId, entered);
  }

  async process(input: unknown): Promise<unknown> {
    const ctx = input as MonitoringContext;
    this.startMonitoring(ctx);
    return { started: true };
  }
}
