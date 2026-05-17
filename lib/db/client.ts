import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL environment variable is not set");

declare global {
  // eslint-disable-next-line no-var
  var _pgClient: ReturnType<typeof postgres> | undefined;
}

// Reuse pool across Next.js hot-reloads in dev — prevents "too many clients" on Postgres
// prepare: false disables prepared statements (required for PgBouncer / pgx poolers)
const client = globalThis._pgClient ?? postgres(connectionString, { prepare: false, max: 10 });
if (process.env.NODE_ENV !== "production") {
  globalThis._pgClient = client;
}

export const db = drizzle(client, { schema });

export type DB = typeof db;
