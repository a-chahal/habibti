import { z } from "zod";
import { Agent } from "../base";
import { getShipment } from "../../db/queries";
import { searchRecentGDELT } from "../../sources/gdelt";
import { cache } from "../../cache";
import { MonitoringScheduler, isTerminal, type MonitoringContext } from "../monitoring-base";

// UNCTAD average anchorage vessel counts per major port
const UNCTAD_BASELINES: Record<string, number> = {
  USLAX: 42,
  USLGB: 38,
  USNYC: 25,
  USHOU: 30,
  SGSIN: 65,
  VNSGN: 28,
  VNCLT: 28,
  CNSGH: 70,
  CNNGB: 55,
  IDTPP: 22,
  EGPSD: 18,
  NLRTM: 52,
  DEHAM: 35,
  GBFXT: 28,
};

const INTERVAL_MS = process.env.TEST_MONITORING === "1" ? 5_000 : 60_000;
const CONGESTION_THRESHOLD = 1.5;

// Simulate vessel count with realistic noise around UNCTAD baseline
function simulateVesselCount(baseline: number): number {
  const noise = (Math.random() - 0.5) * 0.4 * baseline;
  const hourEffect = Math.sin((new Date().getHours() / 24) * Math.PI * 2) * 0.08 * baseline;
  return Math.max(0, Math.round(baseline + noise + hourEffect));
}

const CauseSchema = z.object({
  cause: z.enum(["seasonal", "weather", "strike", "vessel_incident", "unexplained"]),
  confidence: z.number().min(0).max(1),
  one_line_summary: z.string().max(200),
});

export class PortCongestionAgent extends Agent {
  readonly name = "port-congestion";
  readonly tier = "mercury" as const;

  private scheduler = new MonitoringScheduler();

  startMonitoring(ctx: MonitoringContext): void {
    console.log(`[port-congestion] starting for ${ctx.shipmentId}`);
    this.scheduler.start(ctx.shipmentId, () => this.tick(ctx), INTERVAL_MS);
  }

  stopMonitoring(shipmentId: string): void {
    this.scheduler.stop(shipmentId);
    console.log(`[port-congestion] stopped for ${shipmentId}`);
  }

  private async tick(ctx: MonitoringContext): Promise<void> {
    const shipment = await getShipment(ctx.shipmentId);
    if (!shipment || isTerminal(shipment.status)) {
      this.stopMonitoring(ctx.shipmentId);
      return;
    }

    const daysUntilArrival = ctx.expectedEta
      ? Math.max(0, Math.round((ctx.expectedEta.getTime() - Date.now()) / 86_400_000))
      : null;

    const ports = [
      ctx.originPort,
      ctx.destinationPort,
      ...(ctx.transshipmentPorts ?? []),
    ].filter(Boolean) as string[];

    for (const port of ports) {
      await this.checkPort(ctx.shipmentId, port, daysUntilArrival);
    }
  }

  private async checkPort(shipmentId: string, port: string, daysUntilArrival?: number | null): Promise<void> {
    const baseline = UNCTAD_BASELINES[port] ?? 30;
    const current = simulateVesselCount(baseline);
    const ratio = current / baseline;

    if (ratio < CONGESTION_THRESHOLD) {
      // Routine — write info signal, no LLM needed
      await this.publishSignal({
        shipmentId,
        signalType: "port_status",
        severity: "info",
        payload: {
          port,
          vessel_count: current,
          baseline,
          ratio: +ratio.toFixed(2),
          congested: false,
          days_until_arrival: daysUntilArrival ?? null,
        },
        confidence: 0.85,
      });
      return;
    }

    // Congestion detected — classify cause with Mercury + GDELT context
    const cacheKey = `port-congestion:${port}:${new Date().toISOString().slice(0, 13)}`;
    const cached = await cache.get<z.infer<typeof CauseSchema>>(cacheKey);

    let classification: z.infer<typeof CauseSchema>;

    if (cached) {
      classification = cached;
    } else {
      // Fetch GDELT context for this port region
      let gdeltContext = "No recent news found for this port.";
      try {
        const portCity = PORT_CITIES[port] ?? port;
        const result = await searchRecentGDELT(`"${portCity}" port shipping strike congestion`, 3, 5);
        if (result.articles.length > 0) {
          gdeltContext = result.articles
            .slice(0, 3)
            .map((a) => `- ${a.title}`)
            .join("\n");
        }
      } catch {
        // GDELT failure is non-fatal
      }

      classification = await this.callLLMValidated(
        [
          {
            role: "system",
            content:
              "You are a port analyst. Classify the cause of port congestion based on vessel counts and news context. Return JSON only.",
          },
          {
            role: "user",
            content: `Port ${port}: ${current} vessels (baseline ${baseline}, ratio ${ratio.toFixed(2)}x).\n\nRecent news:\n${gdeltContext}\n\nClassify the cause. Respond with JSON: {"cause":"seasonal|weather|strike|vessel_incident|unexplained","confidence":0.0-1.0,"one_line_summary":"..."}`,
          },
        ],
        CauseSchema,
        { maxTokens: 200 }
      );

      await cache.set(cacheKey, classification, 3600);
    }

    await this.publishSignal({
      shipmentId,
      signalType: "port_congestion",
      severity: "medium",
      payload: {
        port,
        vessel_count: current,
        baseline,
        ratio: +ratio.toFixed(2),
        congested: true,
        cause: classification.cause,
        cause_confidence: classification.confidence,
        summary: classification.one_line_summary,
        days_until_arrival: daysUntilArrival ?? null,
      },
      confidence: classification.confidence,
    });
  }

  async process(input: unknown): Promise<unknown> {
    const ctx = input as MonitoringContext;
    this.startMonitoring(ctx);
    return { started: true };
  }
}

const PORT_CITIES: Record<string, string> = {
  USLAX: "Los Angeles",
  USLGB: "Long Beach",
  USNYC: "New York",
  SGSIN: "Singapore",
  VNSGN: "Ho Chi Minh",
  CNSGH: "Shanghai",
  IDTPP: "Jakarta",
  EGPSD: "Port Said",
  NLRTM: "Rotterdam",
  DEHAM: "Hamburg",
};
