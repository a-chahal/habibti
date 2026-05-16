import {
  pgTable,
  uuid,
  text,
  jsonb,
  timestamp,
  integer,
  numeric,
  pgEnum,
  index,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";

// Enums
export const shipmentStatusEnum = pgEnum("shipment_status", [
  "draft",
  "pending",
  "in_transit",
  "delayed",
  "arrived",
  "cancelled",
  "sourcing_complete",
]);

export const verificationStatusEnum = pgEnum("verification_status", [
  "unverified",
  "verified",
  "flagged",
  "sanctioned",
]);

export const severityEnum = pgEnum("severity", [
  "info",
  "low",
  "medium",
  "high",
  "critical",
]);

export const riskLevelEnum = pgEnum("risk_level", [
  "low",
  "medium",
  "high",
  "critical",
]);

export const alertStatusEnum = pgEnum("alert_status", [
  "pending",
  "sent",
  "acknowledged",
  "dismissed",
]);

export const dispatchStatusEnum = pgEnum("dispatch_status", [
  "queued",
  "running",
  "completed",
  "failed",
]);

export const listSourceEnum = pgEnum("list_source", ["ofac", "uflpa"]);

// Tables
export const shipments = pgTable("shipments", {
  id: uuid("id").primaryKey().defaultRandom(),
  status: shipmentStatusEnum("status").notNull().default("draft"),
  intent: jsonb("intent"),
  origin_country: text("origin_country"),
  origin_port: text("origin_port"),
  destination_country: text("destination_country"),
  destination_port: text("destination_port"),
  vessel_mmsi: text("vessel_mmsi"),
  hs_code: text("hs_code"),
  supplier_id: uuid("supplier_id"),
  expected_eta: timestamp("expected_eta"),
  current_eta: timestamp("current_eta"),
  created_at: timestamp("created_at").notNull().defaultNow(),
  updated_at: timestamp("updated_at").notNull().defaultNow(),
});

export const suppliers = pgTable("suppliers", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  country: text("country"),
  registry_id: text("registry_id"),
  registry_source: text("registry_source"),
  parent_id: uuid("parent_id"),
  verification_status: verificationStatusEnum("verification_status")
    .notNull()
    .default("unverified"),
  raw_data: jsonb("raw_data"),
  created_at: timestamp("created_at").notNull().defaultNow(),
  updated_at: timestamp("updated_at").notNull().defaultNow(),
});

export const signals = pgTable(
  "signals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    shipment_id: uuid("shipment_id"),
    agent_name: text("agent_name").notNull(),
    signal_type: text("signal_type").notNull(),
    severity: severityEnum("severity").notNull().default("info"),
    payload: jsonb("payload"),
    citations: jsonb("citations"),
    confidence: numeric("confidence", { precision: 4, scale: 3 }),
    occurred_at: timestamp("occurred_at").notNull(),
    recorded_at: timestamp("recorded_at").notNull().defaultNow(),
  },
  (t) => [
    index("signals_shipment_id_idx").on(t.shipment_id),
    index("signals_agent_name_idx").on(t.agent_name),
  ]
);

export const beliefs = pgTable("beliefs", {
  id: uuid("id").primaryKey().defaultRandom(),
  shipment_id: uuid("shipment_id").notNull(),
  version: integer("version").notNull().default(1),
  current_eta: timestamp("current_eta"),
  risk_level: riskLevelEnum("risk_level").notNull().default("low"),
  narrative: text("narrative"),
  supporting_signal_ids: jsonb("supporting_signal_ids"),
  created_at: timestamp("created_at").notNull().defaultNow(),
});

export const alerts = pgTable("alerts", {
  id: uuid("id").primaryKey().defaultRandom(),
  shipment_id: uuid("shipment_id").notNull(),
  belief_id: uuid("belief_id"),
  alert_type: text("alert_type").notNull(),
  headline: text("headline").notNull(),
  full_narrative: text("full_narrative"),
  draft_email: text("draft_email"),
  status: alertStatusEnum("status").notNull().default("pending"),
  created_at: timestamp("created_at").notNull().defaultNow(),
  acknowledged_at: timestamp("acknowledged_at"),
});

export const options = pgTable("options", {
  id: uuid("id").primaryKey().defaultRandom(),
  shipment_id: uuid("shipment_id").notNull(),
  rank: integer("rank").notNull(),
  country: text("country"),
  supplier_id: uuid("supplier_id"),
  route_data: jsonb("route_data"),
  cost_breakdown: jsonb("cost_breakdown"),
  eta: timestamp("eta"),
  risk_summary: jsonb("risk_summary"),
  reasoning: text("reasoning"),
  created_at: timestamp("created_at").notNull().defaultNow(),
});

export const dispatches = pgTable("dispatches", {
  id: uuid("id").primaryKey().defaultRandom(),
  shipment_id: uuid("shipment_id").notNull(),
  agent_name: text("agent_name").notNull(),
  payload: jsonb("payload"),
  status: dispatchStatusEnum("status").notNull().default("queued"),
  created_at: timestamp("created_at").notNull().defaultNow(),
  completed_at: timestamp("completed_at"),
});

export const supplier_history = pgTable("supplier_history", {
  id: uuid("id").primaryKey().defaultRandom(),
  supplier_id: uuid("supplier_id").notNull(),
  shipment_id: uuid("shipment_id"),
  predicted_eta: timestamp("predicted_eta"),
  actual_eta: timestamp("actual_eta"),
  delay_days: numeric("delay_days", { precision: 6, scale: 2 }),
  reliability_score: numeric("reliability_score", { precision: 4, scale: 3 }),
  notes: text("notes"),
});

export const route_history = pgTable("route_history", {
  id: uuid("id").primaryKey().defaultRandom(),
  origin_port: text("origin_port").notNull(),
  destination_port: text("destination_port").notNull(),
  shipment_id: uuid("shipment_id"),
  predicted_transit_days: integer("predicted_transit_days"),
  actual_transit_days: integer("actual_transit_days"),
  disruption_events: jsonb("disruption_events"),
});

export const cache = pgTable(
  "cache",
  {
    key: text("key").primaryKey(),
    value: jsonb("value").notNull(),
    expires_at: timestamp("expires_at").notNull(),
    created_at: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("cache_expires_at_idx").on(t.expires_at)]
);

export const sanctions_entities = pgTable(
  "sanctions_entities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    aliases: jsonb("aliases"),
    country: text("country"),
    list_source: listSourceEnum("list_source").notNull(),
    entity_type: text("entity_type"),
    listing_date: text("listing_date"),
    reason: text("reason"),
    raw_data: jsonb("raw_data"),
  },
  (t) => [index("sanctions_name_idx").on(t.name)]
);

// Relations
export const shipmentsRelations = relations(shipments, ({ one, many }) => ({
  supplier: one(suppliers, {
    fields: [shipments.supplier_id],
    references: [suppliers.id],
  }),
  signals: many(signals),
  beliefs: many(beliefs),
  alerts: many(alerts),
  options: many(options),
  dispatches: many(dispatches),
}));

export const suppliersRelations = relations(suppliers, ({ one, many }) => ({
  parent: one(suppliers, {
    fields: [suppliers.parent_id],
    references: [suppliers.id],
    relationName: "supplier_parent",
  }),
  children: many(suppliers, { relationName: "supplier_parent" }),
  shipments: many(shipments),
  history: many(supplier_history),
}));

export const signalsRelations = relations(signals, ({ one }) => ({
  shipment: one(shipments, {
    fields: [signals.shipment_id],
    references: [shipments.id],
  }),
}));

export const beliefsRelations = relations(beliefs, ({ one }) => ({
  shipment: one(shipments, {
    fields: [beliefs.shipment_id],
    references: [shipments.id],
  }),
}));

export const alertsRelations = relations(alerts, ({ one }) => ({
  shipment: one(shipments, {
    fields: [alerts.shipment_id],
    references: [shipments.id],
  }),
  belief: one(beliefs, {
    fields: [alerts.belief_id],
    references: [beliefs.id],
  }),
}));
