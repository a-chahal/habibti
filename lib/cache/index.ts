import { LRUCache } from "lru-cache";
import { getCacheEntry, setCacheEntry, deleteCacheEntry, deleteExpiredCacheEntries } from "../db/queries";

const DEFAULT_TTL_SECONDS = 300; // 5 minutes

const lru = new LRUCache<string, object>({
  max: 1000,
  ttl: DEFAULT_TTL_SECONDS * 1000,
});

async function get<T = object>(key: string): Promise<T | null> {
  const inMemory = lru.get(key);
  if (inMemory !== undefined) return inMemory as T;

  try {
    const row = await getCacheEntry(key);
    if (!row) return null;
    const value = row.value as T;
    const ttlMs = row.expires_at.getTime() - Date.now();
    if (ttlMs > 0 && value !== null && typeof value === "object") lru.set(key, value as object, { ttl: ttlMs });
    return value;
  } catch {
    return null;
  }
}

async function set(key: string, value: object, ttlSeconds = DEFAULT_TTL_SECONDS): Promise<void> {
  lru.set(key, value, { ttl: ttlSeconds * 1000 });
  try {
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
    await setCacheEntry(key, value, expiresAt);
  } catch {
    // Postgres write failure is non-fatal; in-memory still works
  }
}

async function del(key: string): Promise<void> {
  lru.delete(key);
  try {
    await deleteCacheEntry(key);
  } catch {
    // non-fatal
  }
}

// Background cleanup every 10 minutes
setInterval(async () => {
  try {
    await deleteExpiredCacheEntries();
  } catch {
    // non-fatal
  }
}, 10 * 60 * 1000);

export const cache = { get, set, delete: del };
