import { z } from "zod";
import { Agent } from "../base";
import { getShipment } from "../../db/queries";
import { getMarineForecast } from "../../sources/openmeteo";
import { MonitoringScheduler, isTerminal, type MonitoringContext } from "../monitoring-base";

const INTERVAL_MS = process.env.TEST_MONITORING === "1" ? 18_000 : 21_600_000;

const WAVE_THRESHOLD_M = 4.0;
const WIND_WAVE_THRESHOLD_M = 3.5;

// 6 representative waypoints per route, evenly spaced (lat, lon)
const ROUTE_WAYPOINTS: Record<string, Array<[number, number]>> = {
  "VN-USLAX": [
    [14.0, 112.5],
    [22.0, 124.0],
    [30.0, 140.0],
    [40.0, 160.0],
    [42.0, -175.0],
    [38.0, -148.0],
  ],
  "ID-USNYC": [
    [4.0,  95.0],
    [8.0,  70.0],
    [14.0, 51.0],
    [25.0, 36.0],
    [35.5, 14.0],
    [38.0, -20.0],
  ],
  "CN-USLGB": [
    [33.0, 130.0],
    [38.0, 148.0],
    [43.0, 165.0],
    [44.0, -175.0],
    [40.0, -155.0],
    [36.0, -132.0],
  ],
  DEFAULT: [
    [20.0, 120.0],
    [30.0, 145.0],
    [40.0, 165.0],
    [42.0, -172.0],
    [38.0, -148.0],
    [35.0, -130.0],
  ],
};

const WeatherSummarySchema = z.object({
  hazard_level: z.enum(["none", "caution", "moderate", "severe"]),
  affected_waypoints: z.number().int().min(0),
  summary: z.string().max(300),
  eta_impact_days: z.number().nullable(),
});

export class WeatherHazardAgent extends Agent {
  readonly name = "weather-hazard";
  readonly tier = "mercury" as const;

  private scheduler = new MonitoringScheduler();
  // Current vessel position per shipment, updated from vessel_position signals
  private vesselPositions = new Map<string, { lat: number; lon: number; trackIndex: number }>();

  startMonitoring(ctx: MonitoringContext): void {
    console.log(`[weather-hazard] starting for ${ctx.shipmentId}`);
    this.scheduler.start(ctx.shipmentId, () => this.tick(ctx), INTERVAL_MS);
  }

  stopMonitoring(shipmentId: string): void {
    this.scheduler.stop(shipmentId);
    this.vesselPositions.delete(shipmentId);
    console.log(`[weather-hazard] stopped for ${shipmentId}`);
  }

  // Called to update current vessel position (from vessel_position signal payloads)
  updateVesselPosition(shipmentId: string, lat: number, lon: number, trackIndex: number): void {
    this.vesselPositions.set(shipmentId, { lat, lon, trackIndex });
  }

  private async tick(ctx: MonitoringContext): Promise<void> {
    const shipment = await getShipment(ctx.shipmentId);
    if (!shipment || isTerminal(shipment.status)) {
      this.stopMonitoring(ctx.shipmentId);
      return;
    }

    const routeKey = `${ctx.originCountry ?? "XX"}-${ctx.destinationPort ?? "USLAX"}`;
    const allWaypoints = ROUTE_WAYPOINTS[routeKey] ?? ROUTE_WAYPOINTS.DEFAULT;

    // Select only waypoints AHEAD of the current vessel position
    const vesselPos = this.vesselPositions.get(ctx.shipmentId);
    let waypoints = allWaypoints;
    if (vesselPos) {
      // Find closest waypoint to current position, take all after it
      let closestIdx = 0;
      let closestDist = Infinity;
      for (let i = 0; i < allWaypoints.length; i++) {
        const [wLat, wLon] = allWaypoints[i];
        const dist = Math.sqrt(Math.pow(wLat - vesselPos.lat, 2) + Math.pow(wLon - vesselPos.lon, 2));
        if (dist < closestDist) {
          closestDist = dist;
          closestIdx = i;
        }
      }
      // Take waypoints from the next position onward (vessel is past closestIdx)
      waypoints = allWaypoints.slice(Math.min(closestIdx + 1, allWaypoints.length - 1));
      if (waypoints.length === 0) waypoints = allWaypoints.slice(-2); // always check last 2
    }

    const hazardousPoints: Array<{ lat: number; lon: number; max_wave_m: number; max_wind_wave_m: number }> = [];

    for (const [lat, lon] of waypoints as [number, number][]) {
      try {
        const forecast = await getMarineForecast(lat, lon);
        const waves = forecast.hourly.wave_height ?? [];
        const windWaves = forecast.hourly.wind_wave_height ?? [];

        const maxWave = Math.max(...waves.slice(0, 48), 0);
        const maxWindWave = Math.max(...windWaves.slice(0, 48), 0);

        if (maxWave > WAVE_THRESHOLD_M || maxWindWave > WIND_WAVE_THRESHOLD_M) {
          hazardousPoints.push({ lat, lon, max_wave_m: +maxWave.toFixed(1), max_wind_wave_m: +maxWindWave.toFixed(1) });
        }
      } catch {
        // One waypoint failure is non-fatal
      }
    }

    if (hazardousPoints.length === 0) {
      await this.publishSignal({
        shipmentId: ctx.shipmentId,
        signalType: "weather_status",
        severity: "info",
        payload: {
          waypoints_checked: waypoints.length,
          hazardous_waypoints: 0,
          summary: `All ${waypoints.length} ahead-of-vessel waypoints within normal wave thresholds.`,
          route: routeKey,
          vessel_position_known: !!vesselPos,
        },
        confidence: 0.9,
      });
      return;
    }

    // Use Mercury to generate structured hazard summary
    const waypointText = hazardousPoints
      .map((p) => `  ${p.lat}°N ${p.lon}°: wave ${p.max_wave_m}m, wind-wave ${p.max_wind_wave_m}m`)
      .join("\n");

    let summary: z.infer<typeof WeatherSummarySchema>;
    try {
      summary = await this.callLLMValidated(
        [
          {
            role: "system",
            content:
              "You are a marine meteorologist. Summarize weather hazards for a cargo vessel. Return JSON only.",
          },
          {
            role: "user",
            content: `Hazardous waypoints on the ${routeKey} route (next 48h forecast):\n${waypointText}\n\nThresholds: wave >4m, wind-wave >3.5m are significant for container ships.\n\nJSON: {"hazard_level":"none|caution|moderate|severe","affected_waypoints":N,"summary":"...","eta_impact_days":number|null}`,
          },
        ],
        WeatherSummarySchema,
        { maxTokens: 300 }
      );
    } catch {
      summary = {
        hazard_level: "moderate" as const,
        affected_waypoints: hazardousPoints.length,
        summary: `${hazardousPoints.length} waypoint(s) showing wave heights above 4m in the next 48 hours.`,
        eta_impact_days: null,
      };
    }

    const severity = summary.hazard_level === "severe" ? "high"
      : summary.hazard_level === "moderate" ? "medium"
      : "low";

    await this.publishSignal({
      shipmentId: ctx.shipmentId,
      signalType: "weather_hazard",
      severity: severity as "low" | "medium" | "high",
      payload: {
        hazard_level: summary.hazard_level,
        affected_waypoints: summary.affected_waypoints,
        waypoints_checked: waypoints.length,
        hazardous_points: hazardousPoints,
        summary: summary.summary,
        eta_impact_days: summary.eta_impact_days,
        route: routeKey,
      },
      confidence: 0.85,
    });
  }

  async process(input: unknown): Promise<unknown> {
    const ctx = input as MonitoringContext;
    this.startMonitoring(ctx);
    return { started: true };
  }
}
