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

  ws.on("open", () => {
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
    onError?.(err);
  });

  return () => ws.close();
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
