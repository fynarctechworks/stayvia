import { Redis } from "@upstash/redis";
// ioredis v5 ships an odd default export shape under NodeNext + esModuleInterop.
// Both forms exist at runtime; cast the import to the constructor type explicitly.
import IORedisImport from "ioredis";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const IORedis = IORedisImport as unknown as new (url: string, opts?: Record<string, unknown>) => any;
import { env } from "../config/env.js";
import { logger } from "./logger.js";
// Static import — settings.ts only pulls db/schema, so there's no cycle. A
// dynamic import() here crashed the pkg-bundled sidecar on every settings
// save (ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING — pkg snapshots can't do
// runtime ESM import()).
import { invalidateSettings } from "./settings.js";

// Offline desktop mode runs single-instance with no Upstash. There's no second
// API process to coordinate with, so pub/sub is unnecessary and the REST cache
// is replaced by an in-process Map. When UPSTASH_* is absent we build null
// clients; every call site here already tolerates failure, so the app degrades
// to per-instance TTL caching — which is exactly right for a single desk.
const REDIS_ENABLED = !!(
  env.UPSTASH_REDIS_REST_URL &&
  env.UPSTASH_REDIS_REST_TOKEN &&
  env.UPSTASH_REDIS_URL
);

// In-process fallback for the REST cache (dashboard payload). One process, so a
// plain Map with manual TTL is sufficient and correct offline.
const localCache = new Map<string, { value: unknown; expiresAt: number }>();

type RestCache = Pick<Redis, "get" | "set" | "del" | "setex">;

const localRest: RestCache = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async get(key: string): Promise<any> {
    const hit = localCache.get(key);
    if (!hit) return null;
    if (hit.expiresAt < Date.now()) {
      localCache.delete(key);
      return null;
    }
    return hit.value;
  },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async set(key: string, value: any, opts?: { ex?: number }): Promise<any> {
    const ttl = opts?.ex ?? 60;
    localCache.set(key, { value, expiresAt: Date.now() + ttl * 1000 });
    return "OK";
  },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async setex(key: string, ttlSeconds: number, value: any): Promise<any> {
    localCache.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
    return "OK";
  },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async del(...keys: string[]): Promise<any> {
    let n = 0;
    for (const k of keys) if (localCache.delete(k)) n++;
    return n;
  },
};

export const redis: RestCache = REDIS_ENABLED
  ? new Redis({
      url: env.UPSTASH_REDIS_REST_URL as string,
      token: env.UPSTASH_REDIS_REST_TOKEN as string,
    })
  : localRest;

const DASHBOARD_CHANNEL = "dashboard:invalidate";
const DASHBOARD_KEY = "dashboard:data";
const SETTINGS_CHANNEL = "settings:invalidate";

export async function invalidateDashboard() {
  try {
    await redis.del(DASHBOARD_KEY);
    await pubClient?.publish(DASHBOARD_CHANNEL, "invalidate");
  } catch (err) {
    logger.debug({ err: err instanceof Error ? err.message : err }, "dashboard cache invalidation skipped");
  }
}

// Broadcasts a settings-cache bust to every API instance. The local cache is
// cleared via the subscriber on each instance (including this one). Offline
// (single instance) there are no other instances, and we clear directly.
export async function publishSettingsInvalidation() {
  if (!REDIS_ENABLED) {
    // No fan-out needed for a single process; clear our own settings cache now.
    invalidateSettings();
    return;
  }
  try {
    await pubClient?.publish(SETTINGS_CHANNEL, "invalidate");
  } catch (err) {
    logger.debug(
      { err: err instanceof Error ? err.message : err },
      "settings pub/sub invalidation skipped (other instances may serve stale settings for up to TTL)",
    );
  }
}

const ioOpts = {
  lazyConnect: true,
  maxRetriesPerRequest: 1,
  retryStrategy: () => null, // disable auto-reconnect; we handle failures via try/catch
  enableOfflineQueue: false,
} as const;

// Null when offline — there's no Redis to pub/sub against. Call sites use
// optional chaining (pubClient?.publish).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const pubClient: any = REDIS_ENABLED
  ? new IORedis(env.UPSTASH_REDIS_URL as string, ioOpts)
  : null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const subClient: any = REDIS_ENABLED
  ? new IORedis(env.UPSTASH_REDIS_URL as string, ioOpts)
  : null;

// Attach error handlers so unhandled-error spam stops; we already log via wrappers.
if (pubClient) {
  pubClient.on("error", (err: Error) => {
    logger.debug({ err: err.message }, "redis pub error (ignored)");
  });
}
if (subClient) {
  subClient.on("error", (err: Error) => {
    logger.debug({ err: err.message }, "redis sub error (ignored)");
  });
}

export async function startDashboardSubscriber() {
  if (!REDIS_ENABLED) {
    logger.info("Redis disabled (offline mode) — using in-process cache, no pub/sub");
    return;
  }
  try {
    await subClient.connect();
    await pubClient.connect();
    await subClient.subscribe(DASHBOARD_CHANNEL, SETTINGS_CHANNEL);
    subClient.on("message", async (channel: string) => {
      if (channel === DASHBOARD_CHANNEL) {
        await redis.del(DASHBOARD_KEY);
      } else if (channel === SETTINGS_CHANNEL) {
        invalidateSettings();
      }
    });
    logger.info("Dashboard + settings pub/sub subscriber started");
  } catch (err) {
    logger.warn(
      { err },
      "Could not start Redis pub/sub (dashboard and settings caches will still work via TTL)",
    );
  }
}

export const dashboardKey = DASHBOARD_KEY;
