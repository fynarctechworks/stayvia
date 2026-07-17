import cors from "cors";
import express from "express";
import helmet from "helmet";
 
import pinoHttpImport from "pino-http";
// pino-http v10 ships odd typings; the runtime export is callable.
const pinoHttp = pinoHttpImport as unknown as (opts: { logger: typeof logger }) => import("express").RequestHandler;
import { env } from "./config/env.js";
import { closeBrowser } from "./lib/pdf.js";
import { logger } from "./lib/logger.js";
import { startDashboardSubscriber } from "./lib/redis.js";
import {
  failedMessageCount,
  pendingMessageCount,
  requeueFailedMessages,
  setOutboxDeliverer,
  startOutboxDrainer,
} from "./lib/outbox.js";
import { createDirectDeliverer, deliveryConfigured } from "./lib/outboxDeliverer.js";
import { pendingPushCount, startSyncPusher } from "./lib/sync/pusher.js";
import { requireAuth } from "./middleware/auth.js";
import { bootstrapSchemaIfNeeded } from "./db/bootstrap/index.js";
import { ensureOfflineAdmin } from "./db/bootstrap/seedAdmin.js";
import { errorHandler, notFound } from "./middleware/error.js";
import { loginLimiter, readLimiter, writeLimiter } from "./middleware/rateLimit.js";
import activityRoutes from "./routes/activity.js";
import amenitiesRoutes from "./routes/amenities.js";
import auditRoutes from "./routes/audit.js";
import authRoutes from "./routes/auth.js";
import authLocalRoutes from "./routes/authLocal.js";
import localFilesRoutes from "./routes/localFiles.js";
import syncRoutes from "./routes/sync.js";
import calendarRoutes from "./routes/calendar.js";
import creditsRoutes from "./routes/credits.js";
import dashboardRoutes from "./routes/dashboard.js";
import expenseRoutes from "./routes/expenses.js";
import guestRoutes from "./routes/guests.js";
import housekeepingRoutes from "./routes/housekeeping.js";
import invoiceRoutes from "./routes/invoices.js";
import ledgerRoutes from "./routes/ledger.js";
import maintenanceRoutes from "./routes/maintenance.js";
import messageRoutes from "./routes/messages.js";
import notificationRoutes from "./routes/notifications.js";
import otpRoutes from "./routes/otp.js";
import paymentRoutes from "./routes/payments.js";
import propertiesRoutes from "./routes/properties.js";
import rbacRoutes from "./routes/rbac.js";
import reportRoutes from "./routes/reports.js";
import reservationRoutes from "./routes/reservations.js";
import roomRoutes from "./routes/rooms.js";
import searchRoutes from "./routes/search.js";
import { settingsRouter, staffRouter } from "./routes/settings.js";

const app = express();

// Trust the first proxy hop ONLY online (behind nginx/Vercel). Offline the app
// is a loopback sidecar with no proxy, so trusting XFF would let a loopback
// caller spoof req.ip and dodge the IP rate-limiter. (The per-account lockout
// still holds either way, so this isn't a login bypass — defense in depth.)
app.set("trust proxy", env.OFFLINE_MODE ? false : 1);
app.set("etag", false);

// Explicit security headers. We extend Helmet's defaults rather than relying
// on whatever happens to ship with the version we pin to.
//
// CSP rationale: this API serves JSON, not HTML, but we still set a strict
// CSP in case an error page or future HTML endpoint lands here. Anything
// that needs to embed an iframe of an invoice PDF will be served by the
// front-end origin, not the API.
//
// HSTS: 1-year max-age + preload-ready. Only effective behind HTTPS in
// production; harmless in dev.
//
// Referrer/Permissions/Frame: strip noisy data and lock down embeds.
app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        defaultSrc: ["'none'"],
        connectSrc: ["'self'"],
        imgSrc: ["'self'", "data:"],
        objectSrc: ["'none'"],
        scriptSrc: ["'none'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        frameAncestors: ["'none'"],
        formAction: ["'self'"],
        baseUri: ["'none'"],
      },
    },
    strictTransportSecurity: {
      maxAge: 63072000, // 2 years
      includeSubDomains: true,
      preload: true,
    },
    referrerPolicy: { policy: "no-referrer" },
    frameguard: { action: "deny" },
    crossOriginOpenerPolicy: { policy: "same-origin" },
    crossOriginResourcePolicy: { policy: "same-origin" },
    // X-Permitted-Cross-Domain-Policies — only matters for Flash/Acrobat
    // but cheap to lock anyway.
    permittedCrossDomainPolicies: { permittedPolicies: "none" },
  }),
);
// Permissions-Policy: Helmet doesn't include this by default (browser API,
// not strict-security header). Disable the loud ones — camera/mic/geo —
// since we never use them.
app.use((_req, res, next) => {
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
  next();
});

// Allowed browser origins: the web front end, plus the Tauri desktop app.
// Tauri serves the bundled UI from a tauri.localhost origin (scheme differs
// by OS/webview), so we allow that family alongside FRONTEND_URL. Requests
// with no Origin header (native fetch, health checks) are allowed through.
const TAURI_ORIGINS = new Set([
  "tauri://localhost",
  "https://tauri.localhost",
  "http://tauri.localhost",
]);
app.use(
  cors({
    origin(origin, callback) {
      if (!origin || origin === env.FRONTEND_URL || TAURI_ORIGINS.has(origin)) {
        callback(null, true);
      } else {
        callback(null, false);
      }
    },
    credentials: true,
  }),
);
// Global JSON body limit. No JSON route in this app realistically needs
// more than a handful of KB — see the schemas in packages/shared. Keeping
// this tight blunts memory-exhaustion attacks. Multipart uploads use
// multer and have their own per-route limits (see routes/guests.ts).
app.use(express.json({ limit: "64kb" }));
app.use(pinoHttp({ logger }));

app.get("/health", (_req, res) => res.json({ status: "ok", time: new Date().toISOString() }));

const v1 = express.Router();

// Desk status for the frontend's offline banner: mode, queued/failed message
// counts, unsynced-change count, and whether delivery credentials exist. In
// online mode everything reports zero/true so the banner stays hidden.
v1.get("/system/status", requireAuth, async (_req, res) => {
  try {
    const offline = !!env.OFFLINE_MODE;
    const [pending, failed, unsynced] = offline
      ? await Promise.all([pendingMessageCount(), failedMessageCount(), pendingPushCount()])
      : [0, 0, 0];
    return res.json({
      success: true,
      data: {
        offline,
        messages: { pending, failed },
        sync: { pending: unsynced, configured: !!process.env.SYNC_INGEST_URL },
        delivery: offline ? deliveryConfigured() : { whatsapp: true, email: true },
      },
    });
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : err }, "system status failed");
    return res.status(500).json({ success: false, error: { code: "STATUS_FAILED", message: "Could not read system status" } });
  }
});

v1.use("/auth/login", loginLimiter);
if (env.OFFLINE_MODE) {
  // Offline desk: local credential login/refresh REPLACES the cloud login.
  // Mounted first so its /login and /refresh win over the cloud auth router.
  v1.use("/auth", authLocalRoutes);
  v1.use("/auth", authRoutes);
} else {
  // Online: cloud auth owns /login etc. authLocal is mounted AFTER so only its
  // /provision-local (which cloud auth doesn't define) is reachable — letting a
  // signed-in user set up their desk PIN before going offline.
  v1.use("/auth", authRoutes);
  v1.use("/auth", authLocalRoutes);
}

// Local file serving (offline mode only). Auth is by HMAC signature in the
// URL, not a bearer token — so mount it BEFORE the auth rate limiter block and
// leave it un-gated, exactly like a cloud signed URL.
if (env.OFFLINE_MODE) {
  v1.use("/local-files", localFilesRoutes);
}

v1.use((req, _res, next) => {
  if (["GET", "HEAD"].includes(req.method)) return readLimiter(req, _res, next);
  return writeLimiter(req, _res, next);
});

v1.use("/rooms", roomRoutes);
// amenities + room images are mounted at /api/v1 so the route paths
// stay readable: /amenities, /rooms/:id/amenities, /rooms/:id/images.
v1.use("/", amenitiesRoutes);
v1.use("/guests", guestRoutes);
v1.use("/reservations", reservationRoutes);
v1.use("/invoices", invoiceRoutes);
v1.use("/payments", paymentRoutes);
v1.use("/credits", creditsRoutes);
v1.use("/housekeeping", housekeepingRoutes);
v1.use("/properties", propertiesRoutes);
v1.use("/dashboard", dashboardRoutes);
v1.use("/expenses", expenseRoutes);
v1.use("/maintenance", maintenanceRoutes);
v1.use("/reports", reportRoutes);
v1.use("/settings", settingsRouter);
v1.use("/staff", staffRouter);
v1.use("/otp", otpRoutes);
v1.use("/notifications", notificationRoutes);
v1.use("/messages", messageRoutes);
v1.use("/rbac", rbacRoutes);
v1.use("/audit", auditRoutes);
v1.use("/activity", activityRoutes);
v1.use("/calendar", calendarRoutes);
v1.use("/search", searchRoutes);
v1.use("/", ledgerRoutes);

// Cloud replica ingest endpoint. Lives on the CLOUD/online API (the passive
// replica the desk pushes to), never on the offline desk itself.
if (!env.OFFLINE_MODE) {
  v1.use("/sync", syncRoutes);
}

app.use("/api/v1", v1);

app.use(notFound);
app.use(errorHandler);

startDashboardSubscriber().catch((err) =>
  logger.warn({ err }, "dashboard subscriber failed to start"),
);

// Offline desk: start the message-outbox drainer so queued WhatsApp/email
// messages deliver whenever connectivity returns, and the sync pusher so
// business changes replicate to the cloud backup when online. Static-imported
// (not dynamic import()) so the pkg-bundled sidecar can resolve them — they're
// inert online anyway.
if (env.OFFLINE_MODE) {
  // Direct Twilio/Resend delivery from the desk (credentials from
  // %LOCALAPPDATA%\SLDT\messaging.env). Messages parked as "failed" by the
  // pre-deliverer stub get re-armed first — they never actually sent.
  setOutboxDeliverer(createDirectDeliverer());
  requeueFailedMessages()
    .then(() => startOutboxDrainer())
    .catch((err) => logger.warn({ err }, "outbox drainer failed to start"));
  Promise.resolve()
    .then(() => startSyncPusher())
    .catch((err) => logger.warn({ err }, "sync pusher failed to start"));
}

// Offline first-run: build the schema on a fresh embedded cluster and ensure
// there's an admin to log in with, BEFORE we start serving. No-op online and
// on already-initialized offline clusters.
async function offlineFirstRun(): Promise<void> {
  if (!env.OFFLINE_MODE) return;
  await bootstrapSchemaIfNeeded();
  await ensureOfflineAdmin();
}

const server = app.listen(env.PORT, () => {
  logger.info(`Stayvia API listening on http://localhost:${env.PORT}`);
});
// Run the first-run bootstrap right after binding the port so /health responds
// immediately (the shell health-gates on it); the schema build completes in
// well under a second.
offlineFirstRun().catch((err) =>
  logger.error({ err }, "offline first-run bootstrap failed"),
);

async function shutdown(signal: string) {
  logger.info(`${signal} received, shutting down`);
  server.close(async () => {
    try {
      await closeBrowser();
    } catch (err) {
      logger.warn({ err }, "browser close failed");
    }
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// Offline desk resilience: Express does NOT forward async-handler rejections
// to the error middleware (no express-async-errors / asyncHandler in this
// codebase), so any uncaught throw in an async route becomes an unhandled
// rejection — and Node's default kills the process. In the cloud a supervisor
// restarts it; on the desk the sidecar just dies and every subsequent request
// shows "Failed to fetch" until the operator relaunches the whole app. Log
// loudly and keep serving instead. The failed request itself never gets a
// response (the client times out), but the app survives.
if (env.OFFLINE_MODE) {
  process.on("unhandledRejection", (reason) => {
    logger.error(
      { err: reason instanceof Error ? { message: reason.message, stack: reason.stack } : reason },
      "unhandled promise rejection — kept alive (offline desk mode)",
    );
  });
}
