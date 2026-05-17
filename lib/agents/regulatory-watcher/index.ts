import { z } from "zod";
import { Agent } from "../base";
import { getShipment } from "../../db/queries";
import { fetchFederalRegisterUSTR } from "../../sources/ustr";
import { cache } from "../../cache";
import { MonitoringScheduler, isTerminal, type MonitoringContext } from "../monitoring-base";

const INTERVAL_MS = process.env.TEST_MONITORING === "1" ? 12_000 : 900_000;

// In-memory seen-doc tracking, with DB persistence for cross-restart survival
const seenDocs = new Map<string, Set<string>>();

// Jaccard token-overlap match for supplier names (threshold 0.4)
function supplierNameMatch(supplierName: string, entityName: string): boolean {
  const tokenize = (s: string) =>
    new Set(s.toLowerCase().replace(/[^a-z0-9]/g, " ").split(/\s+/).filter((w) => w.length > 2));
  const a = tokenize(supplierName);
  const b = tokenize(entityName);
  if (a.size === 0 || b.size === 0) return false;
  const intersection = [...a].filter((w) => b.has(w)).length;
  const union = new Set([...a, ...b]).size;
  return union > 0 && intersection / union >= 0.4;
}

const DocRelevanceSchema = z.object({
  is_relevant: z.boolean(),
  relevance_reason: z.string().max(300),
  affected_hs_chapters: z.array(z.string()),
  affected_countries: z.array(z.string()),
  signal_type: z.enum(["regulatory_event", "tariff_change", "sanctions_update", "none"]),
});

// OpenSanctions delta check — queries entities added in the last 24 hours
// Falls back to simulation if API unavailable
async function fetchRecentSanctionAdditions(): Promise<Array<{ name: string; country: string; dataset: string }>> {
  try {
    const since = new Date(Date.now() - 86_400_000).toISOString();
    const res = await fetch(
      `https://api.opensanctions.org/entities/?schema=Organization&sort=first_seen:desc&limit=20&target=true&first_seen_since=${since}`,
      {
        headers: { Accept: "application/json" },
      }
    );
    if (!res.ok) return [];
    const data = await res.json();
    return (data.results ?? []).map((e: any) => ({
      name: e.caption ?? e.id,
      country: e.properties?.country?.[0] ?? "unknown",
      dataset: e.datasets?.[0] ?? "opensanctions",
    }));
  } catch {
    return [];
  }
}

export class RegulatoryWatcherAgent extends Agent {
  readonly name = "regulatory-watcher";
  readonly tier = "mercury" as const;

  private scheduler = new MonitoringScheduler();

  startMonitoring(ctx: MonitoringContext): void {
    // Load persisted seenDocs from cache if available
    cache.get<string[]>(`regulatory:seen-docs:${ctx.shipmentId}`).then((persisted) => {
      seenDocs.set(ctx.shipmentId, new Set(persisted ?? []));
    }).catch(() => {
      seenDocs.set(ctx.shipmentId, new Set());
    });
    console.log(`[regulatory-watcher] starting for ${ctx.shipmentId}`);
    this.scheduler.start(ctx.shipmentId, () => this.tick(ctx), INTERVAL_MS);
  }

  stopMonitoring(shipmentId: string): void {
    this.scheduler.stop(shipmentId);
    seenDocs.delete(shipmentId);
    console.log(`[regulatory-watcher] stopped for ${shipmentId}`);
  }

  private async tick(ctx: MonitoringContext): Promise<void> {
    const shipment = await getShipment(ctx.shipmentId);
    if (!shipment || isTerminal(shipment.status)) {
      this.stopMonitoring(ctx.shipmentId);
      return;
    }

    await Promise.all([
      this.checkFederalRegister(ctx),
      this.checkSanctions(ctx),
    ]);
  }

  private async checkFederalRegister(ctx: MonitoringContext): Promise<void> {
    const cacheKey = `reg-watcher:fed-register:${new Date().toISOString().slice(0, 13)}`;
    let docs: Array<{ document_number: string; title: string; html_url: string; publication_date: string }>;

    const cached = await cache.get<typeof docs>(cacheKey);
    if (cached) {
      docs = cached;
    } else {
      try {
        docs = await fetchFederalRegisterUSTR(5);
        await cache.set(cacheKey, docs, 3600);
      } catch {
        return;
      }
    }

    const seen = seenDocs.get(ctx.shipmentId) ?? new Set<string>();
    const newDocs = docs.filter((d) => !seen.has(d.document_number));

    for (const doc of newDocs.slice(0, 2)) {
      seen.add(doc.document_number);

      let relevance: z.infer<typeof DocRelevanceSchema>;
      try {
        relevance = await this.callLLMValidated(
          [
            {
              role: "system",
              content:
                "You are a trade compliance analyst. Assess whether a Federal Register document affects a specific shipment. Return JSON only.",
            },
            {
              role: "user",
              content: `Shipment: HS ${ctx.hsCode ?? "?"}, origin=${ctx.originCountry ?? "?"}\n\nDocument: "${doc.title}" (${doc.publication_date})\n\nDoes this affect this shipment? JSON: {"is_relevant":bool,"relevance_reason":"...","affected_hs_chapters":[],"affected_countries":[],"signal_type":"regulatory_event|tariff_change|sanctions_update|none"}`,
            },
          ],
          DocRelevanceSchema,
          { maxTokens: 400 }
        );
      } catch {
        continue;
      }

      if (!relevance.is_relevant || relevance.signal_type === "none") continue;

      await this.publishSignal({
        shipmentId: ctx.shipmentId,
        signalType: relevance.signal_type,
        severity: "medium",
        payload: {
          document_number: doc.document_number,
          title: doc.title,
          publication_date: doc.publication_date,
          source_url: doc.html_url,
          relevance_reason: relevance.relevance_reason,
          affected_hs_chapters: relevance.affected_hs_chapters,
          affected_countries: relevance.affected_countries,
        },
        citations: [{ url: doc.html_url, title: doc.title }],
        confidence: 0.75,
      });
    }

    seenDocs.set(ctx.shipmentId, seen);
    // Persist seen doc numbers to DB cache so restarts don't re-process old docs
    cache.set(`regulatory:seen-docs:${ctx.shipmentId}`, [...seen], 30 * 24 * 60 * 60).catch(() => {});
  }

  private async checkSanctions(ctx: MonitoringContext): Promise<void> {
    if (!ctx.supplierName) return;

    const additions = await fetchRecentSanctionAdditions();

    for (const entity of additions) {
      if (supplierNameMatch(ctx.supplierName!, entity.name)) {
        await this.publishSignal({
          shipmentId: ctx.shipmentId,
          signalType: "sanctions_addition",
          severity: "critical",
          payload: {
            entity_name: entity.name,
            country: entity.country,
            dataset: entity.dataset,
            supplier_name: ctx.supplierName,
            match_type: "name_similarity",
          },
          confidence: 0.9,
        });
      }
    }
  }

  async process(input: unknown): Promise<unknown> {
    const ctx = input as MonitoringContext;
    this.startMonitoring(ctx);
    return { started: true };
  }
}
