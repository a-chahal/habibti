export interface MonitoringContext {
  shipmentId: string;
  hsCode?: string | null;
  originCountry?: string | null;
  originPort?: string | null;
  destinationPort?: string | null;
  supplierName?: string | null;
  vesselMmsi?: string | null;
  scenarioId?: string;
  // Enriched from confirmed option:
  expectedEta?: Date | null;
  transitDays?: number | null;
  chokepoints?: string[];
  transshipmentPorts?: string[];
  productDescription?: string | null;
}

// Manages per-shipment polling timers for monitoring agents.
export class MonitoringScheduler {
  private timers = new Map<string, ReturnType<typeof setInterval>>();

  start(shipmentId: string, fn: () => Promise<void>, intervalMs: number): void {
    if (this.timers.has(shipmentId)) return;

    // Fire immediately, then on interval
    fn().catch((err) => console.error(`[monitoring] first tick error:`, err));
    const timer = setInterval(() => {
      fn().catch((err) => console.error(`[monitoring] tick error:`, err));
    }, intervalMs);

    this.timers.set(shipmentId, timer);
  }

  stop(shipmentId: string): void {
    const timer = this.timers.get(shipmentId);
    if (timer) {
      clearInterval(timer);
      this.timers.delete(shipmentId);
    }
  }

  isActive(shipmentId: string): boolean {
    return this.timers.has(shipmentId);
  }
}

const TERMINAL_STATUSES = new Set(["arrived", "cancelled"]);

export function isTerminal(status: string): boolean {
  return TERMINAL_STATUSES.has(status);
}
