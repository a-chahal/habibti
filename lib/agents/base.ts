import { z } from "zod";
import { callOpus, callSonnet, callMercury, type Message, type CallOpts } from "../llm/openrouter";
import { emit, subscribe, type Channel, type PayloadMap } from "../events/emitter";
import { createSignal } from "../db/queries";

export type Tier = "opus" | "sonnet" | "mercury" | "none";

export abstract class Agent {
  abstract readonly name: string;
  abstract readonly tier: Tier;

  abstract process(input: unknown): Promise<unknown>;

  protected async callLLM(messages: Message[], opts?: CallOpts): Promise<string> {
    if (this.tier === "none") throw new Error(`Agent ${this.name} has tier 'none'`);
    switch (this.tier) {
      case "opus":   return callOpus(messages, opts);
      case "sonnet": return callSonnet(messages, opts);
      case "mercury":return callMercury(messages, opts);
    }
  }

  protected async callLLMValidated<T>(
    messages: Message[],
    schema: z.ZodSchema<T>,
    opts?: CallOpts
  ): Promise<T> {
    const t0 = Date.now();
    const raw = await this.callLLM(messages, { ...opts, json: true });
    try {
      return schema.parse(JSON.parse(raw));
    } catch (err) {
      // Skip the retry if we've already burned most of our 60s budget — prevents
      // a worst-case ~180s compound when both first call and retry stall.
      const elapsedMs = Date.now() - t0;
      if (elapsedMs > 50_000) {
        console.warn(`[Agent:${this.name}] skipping callLLMValidated retry (already ${elapsedMs}ms in)`);
        throw err;
      }
      const retry = await this.callLLM(messages, { ...opts, json: true });
      return schema.parse(JSON.parse(retry));
    }
  }

  protected async publishSignal(partial: {
    shipmentId?: string;
    signalType: string;
    severity: "info" | "low" | "medium" | "high" | "critical";
    payload?: Record<string, unknown>;
    citations?: unknown[];
    confidence?: number;
    occurredAt?: Date;
  }) {
    const signal = await createSignal({
      agent_name: this.name,
      signal_type: partial.signalType,
      severity: partial.severity,
      shipment_id: partial.shipmentId,
      payload: partial.payload ?? {},
      citations: partial.citations ?? [],
      confidence: partial.confidence?.toString(),
      occurred_at: partial.occurredAt ?? new Date(),
    });

    emit("SIGNAL_NEW", {
      signalId: signal.id,
      shipmentId: partial.shipmentId,
      agentName: this.name,
      signalType: partial.signalType,
      severity: partial.severity,
    });

    return signal;
  }

  protected subscribe<C extends Channel>(
    channels: C[],
    handler: (payload: PayloadMap[C]) => void
  ) {
    const unsubscribers = channels.map((ch) => subscribe(ch, handler as any));
    return () => unsubscribers.forEach((fn) => fn());
  }

  async run(input: unknown): Promise<unknown> {
    const start = Date.now();
    console.log(`[Agent:${this.name}] starting`);
    try {
      const result = await this.process(input);
      console.log(`[Agent:${this.name}] completed in ${Date.now() - start}ms`);
      return result;
    } catch (err) {
      console.error(`[Agent:${this.name}] failed in ${Date.now() - start}ms`, err);
      throw err;
    }
  }
}
