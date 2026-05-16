import EventEmitter from "eventemitter3";
import { z } from "zod";

export const CHANNELS = {
  SIGNAL_NEW: "SIGNAL_NEW",
  SHIPMENT_NEW: "SHIPMENT_NEW",
  SHIPMENT_CONFIRMED: "SHIPMENT_CONFIRMED",
  BELIEF_UPDATED: "BELIEF_UPDATED",
  ALERT_CREATED: "ALERT_CREATED",
  DISPATCH_REQUESTED: "DISPATCH_REQUESTED",
} as const;

export type Channel = (typeof CHANNELS)[keyof typeof CHANNELS];

// Payload schemas
const SignalNewPayload = z.object({
  signalId: z.string().uuid(),
  shipmentId: z.string().uuid().optional(),
  agentName: z.string(),
  signalType: z.string(),
  severity: z.enum(["info", "low", "medium", "high", "critical"]),
});

const ShipmentNewPayload = z.object({
  shipmentId: z.string().uuid(),
  hsCode: z.string().optional(),
  originCountry: z.string().optional(),
});

const ShipmentConfirmedPayload = z.object({
  shipmentId: z.string().uuid(),
  vesselMmsi: z.string().optional(),
});

const BeliefUpdatedPayload = z.object({
  beliefId: z.string().uuid(),
  shipmentId: z.string().uuid(),
  riskLevel: z.enum(["low", "medium", "high", "critical"]),
  version: z.number(),
});

const AlertCreatedPayload = z.object({
  alertId: z.string().uuid(),
  shipmentId: z.string().uuid(),
  alertType: z.string(),
  headline: z.string(),
});

const DispatchRequestedPayload = z.object({
  dispatchId: z.string().uuid(),
  shipmentId: z.string().uuid(),
  agentName: z.string(),
  payload: z.record(z.unknown()),
});

export type PayloadMap = {
  SIGNAL_NEW: z.infer<typeof SignalNewPayload>;
  SHIPMENT_NEW: z.infer<typeof ShipmentNewPayload>;
  SHIPMENT_CONFIRMED: z.infer<typeof ShipmentConfirmedPayload>;
  BELIEF_UPDATED: z.infer<typeof BeliefUpdatedPayload>;
  ALERT_CREATED: z.infer<typeof AlertCreatedPayload>;
  DISPATCH_REQUESTED: z.infer<typeof DispatchRequestedPayload>;
};

const payloadSchemas: { [K in Channel]: z.ZodTypeAny } = {
  SIGNAL_NEW: SignalNewPayload,
  SHIPMENT_NEW: ShipmentNewPayload,
  SHIPMENT_CONFIRMED: ShipmentConfirmedPayload,
  BELIEF_UPDATED: BeliefUpdatedPayload,
  ALERT_CREATED: AlertCreatedPayload,
  DISPATCH_REQUESTED: DispatchRequestedPayload,
};

const ee = new EventEmitter();

export function emit<C extends Channel>(channel: C, payload: PayloadMap[C]) {
  const schema = payloadSchemas[channel];
  const parsed = schema.parse(payload);
  ee.emit(channel, parsed);
}

export function subscribe<C extends Channel>(
  channel: C,
  handler: (payload: PayloadMap[C]) => void
) {
  ee.on(channel, handler);
  return () => ee.off(channel, handler);
}

export { ee as emitter };
