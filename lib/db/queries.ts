import { eq, desc, and, lt, sql, gte } from "drizzle-orm";
import { db } from "./client";
import {
  shipments,
  suppliers,
  signals,
  beliefs,
  alerts,
  options,
  dispatches,
  supplier_history,
  route_history,
  cache,
  sanctions_entities,
  locations,
} from "./schema";

// Shipments
export async function getShipment(id: string) {
  return db.query.shipments.findFirst({ where: eq(shipments.id, id) });
}

export async function listShipments() {
  return db.query.shipments.findMany({ orderBy: desc(shipments.created_at) });
}

export async function createShipment(data: typeof shipments.$inferInsert) {
  const [row] = await db.insert(shipments).values(data).returning();
  return row;
}

export async function updateShipment(
  id: string,
  data: Partial<typeof shipments.$inferInsert>
) {
  const [row] = await db
    .update(shipments)
    .set({ ...data, updated_at: new Date() })
    .where(eq(shipments.id, id))
    .returning();
  return row;
}

// Suppliers
export async function getSupplier(id: string) {
  return db.query.suppliers.findFirst({ where: eq(suppliers.id, id) });
}

export async function upsertSupplier(
  data: typeof suppliers.$inferInsert & { name: string; registry_source: string }
) {
  const [row] = await db
    .insert(suppliers)
    .values(data)
    .onConflictDoUpdate({ target: suppliers.id, set: data })
    .returning();
  return row;
}

// Signals
export async function createSignal(data: typeof signals.$inferInsert) {
  const [row] = await db.insert(signals).values(data).returning();
  return row;
}

export async function getSignalsForShipment(shipmentId: string, since?: Date) {
  return db.query.signals.findMany({
    where: since
      ? and(eq(signals.shipment_id, shipmentId), gte(signals.recorded_at, since))
      : eq(signals.shipment_id, shipmentId),
    orderBy: desc(signals.recorded_at),
  });
}

// Beliefs
export async function createBelief(data: typeof beliefs.$inferInsert) {
  const [row] = await db.insert(beliefs).values(data).returning();
  return row;
}

export async function getLatestBelief(shipmentId: string) {
  return db.query.beliefs.findFirst({
    where: eq(beliefs.shipment_id, shipmentId),
    orderBy: desc(beliefs.version),
  });
}

// Alerts
export async function createAlert(data: typeof alerts.$inferInsert) {
  const [row] = await db.insert(alerts).values(data).returning();
  return row;
}

export async function listAlerts(shipmentId?: string, includeDismissed = false) {
  return db.query.alerts.findMany({
    where: and(
      shipmentId ? eq(alerts.shipment_id, shipmentId) : undefined,
      includeDismissed ? undefined : sql`${alerts.status} != 'dismissed'`
    ),
    orderBy: desc(alerts.created_at),
  });
}

export async function dismissAlert(id: string) {
  const [row] = await db
    .update(alerts)
    .set({ status: "dismissed" })
    .where(eq(alerts.id, id))
    .returning();
  return row;
}

export async function getBeliefHistory(shipmentId: string) {
  return db.query.beliefs.findMany({
    where: eq(beliefs.shipment_id, shipmentId),
    orderBy: desc(beliefs.version),
  });
}

export async function getSupplierForShipment(shipmentId: string) {
  const shipment = await getShipment(shipmentId);
  if (!shipment?.supplier_id) return null;
  return getSupplier(shipment.supplier_id);
}

// Locations
export async function getLocation(locode: string) {
  return db.query.locations.findFirst({
    where: eq(locations.locode, locode.toUpperCase()),
  });
}

export async function searchLocations(query: string, country?: string) {
  return db.query.locations.findMany({
    where: and(
      eq(locations.is_port, true),
      country ? eq(locations.country_code, country.toUpperCase()) : undefined,
      sql`lower(${locations.name}) like lower(${"%" + query + "%"})`
    ),
    limit: 10,
  });
}

export async function getPrimaryPortForCountry(countryCode: string) {
  return db.query.locations.findFirst({
    where: and(
      eq(locations.is_port, true),
      eq(locations.country_code, countryCode.toUpperCase()),
      sql`${locations.latitude} is not null`,
      sql`${locations.longitude} is not null`
    ),
    orderBy: sql`length(${locations.name}) asc`,
  });
}

// Options
export async function createOption(data: typeof options.$inferInsert) {
  const [row] = await db.insert(options).values(data).returning();
  return row;
}

export async function getOptionsForShipment(shipmentId: string) {
  return db.query.options.findMany({
    where: eq(options.shipment_id, shipmentId),
    orderBy: options.rank,
  });
}

// Dispatches
export async function createDispatch(data: typeof dispatches.$inferInsert) {
  const [row] = await db.insert(dispatches).values(data).returning();
  return row;
}

export async function updateDispatch(
  id: string,
  data: Partial<typeof dispatches.$inferInsert>
) {
  const [row] = await db
    .update(dispatches)
    .set(data)
    .where(eq(dispatches.id, id))
    .returning();
  return row;
}

// Supplier history
export async function recordSupplierHistory(
  data: typeof supplier_history.$inferInsert
) {
  const [row] = await db.insert(supplier_history).values(data).returning();
  return row;
}

// Route history
export async function recordRouteHistory(
  data: typeof route_history.$inferInsert
) {
  const [row] = await db.insert(route_history).values(data).returning();
  return row;
}

// Cache
export async function getCacheEntry(key: string) {
  return db.query.cache.findFirst({
    where: and(eq(cache.key, key), sql`${cache.expires_at} > NOW()`),
  });
}

export async function setCacheEntry(
  key: string,
  value: unknown,
  expiresAt: Date
) {
  await db
    .insert(cache)
    .values({ key, value: value as any, expires_at: expiresAt })
    .onConflictDoUpdate({
      target: cache.key,
      set: { value: value as any, expires_at: expiresAt },
    });
}

export async function deleteCacheEntry(key: string) {
  await db.delete(cache).where(eq(cache.key, key));
}

export async function deleteExpiredCacheEntries() {
  await db.delete(cache).where(lt(cache.expires_at, new Date()));
}

// Sanctions
export async function searchSanctions(name: string) {
  return db
    .select()
    .from(sanctions_entities)
    .where(sql`lower(${sanctions_entities.name}) like lower(${"%" + name + "%"})`);
}

export async function upsertSanctionsEntity(
  data: typeof sanctions_entities.$inferInsert
) {
  await db
    .insert(sanctions_entities)
    .values(data)
    .onConflictDoNothing();
}

export async function countSanctionsBySource(source: "ofac" | "uflpa") {
  const [row] = await db
    .select({ count: sql<number>`count(*)` })
    .from(sanctions_entities)
    .where(eq(sanctions_entities.list_source, source));
  return Number(row?.count ?? 0);
}
