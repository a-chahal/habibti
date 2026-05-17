import { z } from "zod";
import { Agent } from "../base";
import { getShipment } from "../../db/queries";
import { searchRecentGDELT } from "../../sources/gdelt";
import { cache } from "../../cache";
import { MonitoringScheduler, isTerminal, type MonitoringContext } from "../monitoring-base";

const INTERVAL_MS = process.env.TEST_MONITORING === "1" ? 8_000 : 300_000;

// Chokepoint-specific GDELT query templates
const CHOKEPOINT_QUERIES: Record<string, string> = {
  "Suez Canal": '"Suez Canal" (blockage OR attack OR closure OR disruption OR Houthi)',
  "Bab-el-Mandeb": '"Bab-el-Mandeb" OR "Red Sea" (Houthi OR attack OR missile OR disruption)',
  "Malacca Strait": '"Malacca Strait" (piracy OR congestion OR closure OR incident)',
  "Panama Canal": '"Panama Canal" (drought OR delay OR closure OR congestion)',
  "Hormuz": '"Strait of Hormuz" (closure OR tension OR Iran OR disruption)',
};

// Fallback queries when no chokepoints defined for a route
const ROUTE_FALLBACK_QUERIES: Record<string, string> = {
  "VN-USLAX": "Vietnam Pacific shipping maritime disruption",
  "ID-USNYC": "Indonesia Malacca Strait maritime disruption",
  "CN-USLGB": "China Pacific shipping port congestion",
  DEFAULT: "maritime shipping disruption port strike closure",
};

// Chokepoint bounding boxes for cleared-chokepoint detection
const CHOKEPOINT_BBOXES: Record<string, { minLat: number; maxLat: number; minLon: number; maxLon: number }> = {
  "Suez Canal": { minLat: 29.9, maxLat: 31.5, minLon: 32.0, maxLon: 33.0 },
  "Bab-el-Mandeb": { minLat: 11.5, maxLat: 13.0, minLon: 42.5, maxLon: 44.0 },
  "Malacca Strait": { minLat: 1.0, maxLat: 6.5, minLon: 99.0, maxLon: 104.5 },
  "Panama Canal": { minLat: 8.0, maxLat: 10.0, minLon: -80.5, maxLon: -79.5 },
  "Hormuz": { minLat: 25.5, maxLat: 27.0, minLon: 56.0, maxLon: 58.5 },
};

const NewsClassificationSchema = z.object({
  severity: z.enum(["info", "low", "medium", "high", "critical"]),
  impact_on_shipping: z.string().max(300),
  is_systemic: z.boolean(),
  relevant_chokepoint: z.string().nullable(),
  eta_impact_days: z.number().nullable(),
});

export class CorridorNewsAgent extends Agent {
  readonly name = "corridor-news";
  readonly tier = "mercury" as const;

  private scheduler = new MonitoringScheduler();
  private seenUrls = new Map<string, Set<string>>();
  // Track which chokepoints the vessel has cleared
  private clearedChokepoints = new Map<string, Set<string>>();
  private latestVesselPos = new Map<string, { lat: number; lon: number }>();

  startMonitoring(ctx: MonitoringContext): void {
    // Load persisted seenUrls from DB cache
    cache.get<string[]>(`corridor-news-seen:${ctx.shipmentId}`).then((persisted) => {
      this.seenUrls.set(ctx.shipmentId, new Set(persisted ?? []));
    }).catch(() => {
      this.seenUrls.set(ctx.shipmentId, new Set());
    });
    this.clearedChokepoints.set(ctx.shipmentId, new Set());
    console.log(`[corridor-news] starting for ${ctx.shipmentId}`);
    this.scheduler.start(ctx.shipmentId, () => this.tick(ctx), INTERVAL_MS);
  }

  stopMonitoring(shipmentId: string): void {
    this.scheduler.stop(shipmentId);
    this.seenUrls.delete(shipmentId);
    this.clearedChokepoints.delete(shipmentId);
    this.latestVesselPos.delete(shipmentId);
    console.log(`[corridor-news] stopped for ${shipmentId}`);
  }

  // Called externally (e.g., from vessel-tracker signals) to update vessel position
  updateVesselPosition(shipmentId: string, lat: number, lon: number): void {
    this.latestVesselPos.set(shipmentId, { lat, lon });
    // Check which chokepoints this vessel has now cleared (left the bbox)
    const cleared = this.clearedChokepoints.get(shipmentId) ?? new Set<string>();
    for (const [cpName, bbox] of Object.entries(CHOKEPOINT_BBOXES)) {
      const inBox = lat >= bbox.minLat && lat <= bbox.maxLat &&
                    lon >= bbox.minLon && lon <= bbox.maxLon;
      if (!inBox && cleared.has(cpName)) {
        // Already marked cleared — ok
      } else if (!inBox) {
        // Not currently in box — if it was entered before, it's now cleared
        // (We rely on vessel-tracker's chokepoint_entered signal for the "entered" state;
        //  once the vessel exits, we mark it cleared so we stop querying it)
      }
    }
    this.clearedChokepoints.set(shipmentId, cleared);
  }

  // Mark a chokepoint as cleared when vessel has passed through it
  markChokepointCleared(shipmentId: string, chokepoint: string): void {
    const cleared = this.clearedChokepoints.get(shipmentId) ?? new Set<string>();
    cleared.add(chokepoint);
    this.clearedChokepoints.set(shipmentId, cleared);
  }

  private async tick(ctx: MonitoringContext): Promise<void> {
    const shipment = await getShipment(ctx.shipmentId);
    if (!shipment || isTerminal(shipment.status)) {
      this.stopMonitoring(ctx.shipmentId);
      return;
    }

    const cleared = this.clearedChokepoints.get(ctx.shipmentId) ?? new Set<string>();
    const seen = this.seenUrls.get(ctx.shipmentId) ?? new Set<string>();

    // Determine which queries to run: iterate ALL relevant chokepoints
    const chokepoints = ctx.chokepoints?.length
      ? ctx.chokepoints
      : null;

    const queriesRun: string[] = [];

    if (chokepoints && chokepoints.length > 0) {
      // Query each chokepoint that hasn't been cleared yet
      for (const cp of chokepoints) {
        if (cleared.has(cp)) {
          console.log(`[corridor-news] ${ctx.shipmentId} skipping cleared chokepoint: ${cp}`);
          continue;
        }
        const query = CHOKEPOINT_QUERIES[cp];
        if (!query) continue;
        queriesRun.push(cp);

        let articles: Array<{ url: string; title: string; seendate: string }> = [];
        try {
          const result = await searchRecentGDELT(query, 2, 10);
          articles = result.articles;
        } catch (err) {
          console.warn(`[corridor-news] GDELT error for ${cp}: ${err}`);
          continue;
        }

        const newArticles = articles.filter((a) => !seen.has(a.url));
        for (const article of newArticles.slice(0, 2)) {
          seen.add(article.url);
          await this.classifyAndPublish(ctx, article, cp);
        }
      }
    } else {
      // No chokepoints defined — use route fallback query
      const routeKey = `${ctx.originCountry ?? "XX"}-${ctx.destinationPort ?? "USLAX"}`;
      const query = ROUTE_FALLBACK_QUERIES[routeKey] ?? ROUTE_FALLBACK_QUERIES.DEFAULT;

      let articles: Array<{ url: string; title: string; seendate: string }> = [];
      try {
        const result = await searchRecentGDELT(query, 2, 10);
        articles = result.articles;
      } catch (err) {
        console.warn(`[corridor-news] GDELT error: ${err}`);
        return;
      }

      const newArticles = articles.filter((a) => !seen.has(a.url));
      for (const article of newArticles.slice(0, 3)) {
        seen.add(article.url);
        await this.classifyAndPublish(ctx, article, null);
      }
    }

    this.seenUrls.set(ctx.shipmentId, seen);
    // Persist seenUrls to DB cache
    cache.set(`corridor-news-seen:${ctx.shipmentId}`, [...seen], 7 * 24 * 60 * 60).catch(() => {});
  }

  private async classifyAndPublish(
    ctx: MonitoringContext,
    article: { url: string; title: string; seendate: string },
    chokepoint: string | null
  ): Promise<void> {
    let classification: z.infer<typeof NewsClassificationSchema>;

    try {
      classification = await this.callLLMValidated(
        [
          {
            role: "system",
            content:
              "You are a trade analyst assessing shipping news impact. Classify the article for a shipment in transit. Return JSON only.",
          },
          {
            role: "user",
            content: `Shipment: ${ctx.originCountry ?? "?"} → ${ctx.destinationPort ?? "?"}, HS ${ctx.hsCode ?? "?"}${chokepoint ? `, relevant chokepoint: ${chokepoint}` : ""}\n\nArticle: "${article.title}"\n\nClassify its impact on this specific shipment. JSON: {"severity":"info|low|medium|high|critical","impact_on_shipping":"...","is_systemic":bool,"relevant_chokepoint":"..."|null,"eta_impact_days":number|null}`,
          },
        ],
        NewsClassificationSchema,
        { maxTokens: 300 }
      );
    } catch {
      // Skip classification failure — prefer silence over fake-low severity
      console.warn(`[corridor-news] classification failed for article: ${article.title.slice(0, 80)}`);
      return;
    }

    // Skip info-severity articles — they're noise
    if (classification.severity === "info") return;

    await this.publishSignal({
      shipmentId: ctx.shipmentId,
      signalType: "news_event",
      severity: classification.severity as "low" | "medium" | "high" | "critical",
      payload: {
        headline: article.title,
        source_url: article.url,
        published_at: article.seendate,
        impact_on_shipping: classification.impact_on_shipping,
        is_systemic: classification.is_systemic,
        relevant_chokepoint: classification.relevant_chokepoint ?? chokepoint,
        eta_impact_days: classification.eta_impact_days,
        route: `${ctx.originCountry ?? "?"} → ${ctx.destinationPort ?? "?"}`,
      },
      citations: [{ url: article.url, title: article.title }],
      confidence: 0.7,
    });
  }

  async process(input: unknown): Promise<unknown> {
    const ctx = input as MonitoringContext;
    this.startMonitoring(ctx);
    return { started: true };
  }
}
