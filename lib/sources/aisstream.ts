import WebSocket from "ws";

export interface BoundingBox {
  minLat: number;
  minLon: number;
  maxLat: number;
  maxLon: number;
}

export interface PositionReport {
  mmsi: number;
  lat: number;
  lon: number;
  sog: number;  // speed over ground
  cog: number;  // course over ground
  heading: number;
  timestamp: string;
  shipName?: string;
}

export function subscribeAIS(
  bbox: BoundingBox,
  mmsiFilter: number[],
  onMessage: (report: PositionReport) => void,
  onError?: (err: Error) => void
): () => void {
  const apiKey = process.env.AISSTREAM_API_KEY;
  if (!apiKey) throw new Error("AISSTREAM_API_KEY not set");

  const ws = new WebSocket("wss://stream.aisstream.io/v0/stream");

  // Inactivity watchdog: if the socket connects but stops emitting messages,
  // close it after 30s so callers (e.g. waitForOnePositionReport) can fail fast
  // and so we don't hold a dead connection indefinitely.
  const IDLE_TIMEOUT_MS = 30_000;
  let idleTimer: NodeJS.Timeout | null = null;
  const armIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      onError?.(new Error("AISStream idle timeout (no messages in 30s)"));
      try { ws.close(); } catch { /* noop */ }
    }, IDLE_TIMEOUT_MS);
  };
  armIdle();

  ws.on("open", () => {
    armIdle();
    ws.send(
      JSON.stringify({
        APIKey: apiKey,
        BoundingBoxes: [
          [
            [bbox.minLat, bbox.minLon],
            [bbox.maxLat, bbox.maxLon],
          ],
        ],
        FilterMessageTypes: ["PositionReport"],
        ...(mmsiFilter.length ? { MMSI: mmsiFilter } : {}),
      })
    );
  });

  ws.on("message", (raw: Buffer) => {
    armIdle();
    try {
      const msg = JSON.parse(raw.toString());
      const pr = msg.Message?.PositionReport;
      if (!pr) return;
      onMessage({
        mmsi: pr.UserID ?? 0,
        lat: pr.Latitude ?? 0,
        lon: pr.Longitude ?? 0,
        sog: pr.Sog ?? 0,
        cog: pr.Cog ?? 0,
        heading: pr.TrueHeading ?? 0,
        timestamp: msg.MetaData?.time_utc ?? new Date().toISOString(),
        shipName: msg.MetaData?.ShipName?.trim(),
      });
    } catch {
      // skip malformed
    }
  });

  ws.on("error", (err: Error) => {
    if (idleTimer) clearTimeout(idleTimer);
    onError?.(err);
  });

  ws.on("close", () => {
    if (idleTimer) clearTimeout(idleTimer);
  });

  return () => {
    if (idleTimer) clearTimeout(idleTimer);
    ws.close();
  };
}

/**
 * Sample AIS traffic in a bbox for `windowMs` and return summary stats.
 * Used by leg-analyzer to gauge real-time vessel density and dwell.
 */
export function sampleAISDensity(
  bbox: BoundingBox,
  windowMs = 8_000
): Promise<{
  unique_vessels: number;
  reports: number;
  avg_sog: number; // knots — low avg suggests congestion
  slow_vessels: number; // count with SOG < 4 knots (anchored/queueing)
}> {
  return new Promise((resolve) => {
    const seen = new Map<number, PositionReport[]>();
    let reports = 0;
    let close: (() => void) | null = null;
    let resolved = false;
    const finish = () => {
      if (resolved) return;
      resolved = true;
      close?.();
      let sumSog = 0;
      let slow = 0;
      for (const [, history] of seen) {
        const last = history[history.length - 1];
        sumSog += last.sog;
        if (last.sog < 4) slow++;
      }
      const n = seen.size || 1;
      resolve({
        unique_vessels: seen.size,
        reports,
        avg_sog: +(sumSog / n).toFixed(1),
        slow_vessels: slow,
      });
    };
    const timer = setTimeout(finish, windowMs);
    try {
      close = subscribeAIS(
        bbox,
        [],
        (r) => {
          reports++;
          const list = seen.get(r.mmsi) ?? [];
          list.push(r);
          seen.set(r.mmsi, list);
        },
        () => {
          clearTimeout(timer);
          finish();
        }
      );
    } catch {
      clearTimeout(timer);
      finish();
    }
  });
}

export function waitForOnePositionReport(
  bbox: BoundingBox,
  timeoutMs = 15_000
): Promise<PositionReport> {
  return new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      if (!done) { done = true; close(); reject(new Error("AISStream timeout")); }
    }, timeoutMs);

    const close = subscribeAIS(
      bbox,
      [],
      (report) => {
        if (!done) {
          done = true;
          clearTimeout(timer);
          close();
          resolve(report);
        }
      },
      (err) => {
        if (!done) { done = true; clearTimeout(timer); reject(err); }
      }
    );
  });
}
