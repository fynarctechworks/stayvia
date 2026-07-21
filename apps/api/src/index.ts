// Must be the first import: patches Express 4's Layer so rejected promises
// from async middleware/handlers reach errorHandler instead of becoming
// process-killing unhandled rejections (Node >=15 default). Drop this when
// the app moves to Express 5, which forwards async rejections natively.
import "express-async-errors";
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
import { errorHandler, notFound } from "./middleware/error.js";
import { loginLimiter, readLimiter, writeLimiter } from "./middleware/rateLimit.js";
import activityRoutes from "./routes/activity.js";
import amenitiesRoutes from "./routes/amenities.js";
import auditRoutes from "./routes/audit.js";
import authRoutes from "./routes/auth.js";
import billingRoutes, { razorpayWebhook } from "./routes/billing.js";
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
import publicRoutes from "./routes/public.js";
import rbacRoutes from "./routes/rbac.js";
import reportRoutes from "./routes/reports.js";
import reservationRoutes from "./routes/reservations.js";
import roomRoutes from "./routes/rooms.js";
import searchRoutes from "./routes/search.js";
import { settingsRouter, staffRouter } from "./routes/settings.js";
import { requireAuth } from "./middleware/auth.js";
import { requireActiveSubscription } from "./middleware/subscription.js";

const app = express();

// Trust the first proxy hop (behind nginx/Vercel) so req.ip reflects the
// real client for rate limiting and audit logs.
app.set("trust proxy", 1);
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

// Allowed browser origins: the web front end only. Requests with no Origin
// header (native fetch, health checks) are allowed through.
app.use(
  cors({
    origin(origin, callback) {
      if (!origin || origin === env.FRONTEND_URL) {
        callback(null, true);
      } else {
        callback(null, false);
      }
    },
    credentials: true,
  }),
);
// Razorpay webhook — mounted BEFORE express.json because signature
// verification needs the exact raw bytes; express.json would consume the
// stream and hand the route a parsed object. No auth: the HMAC over the
// body (RAZORPAY_WEBHOOK_SECRET) is the authentication.
app.post(
  "/api/v1/billing/webhook",
  express.raw({ type: "application/json", limit: "128kb" }),
  (req, res, next) => {
    razorpayWebhook(req, res).catch(next);
  },
);
// Global JSON body limit. No JSON route in this app realistically needs
// more than a handful of KB — see the schemas in packages/shared. Keeping
// this tight blunts memory-exhaustion attacks. Multipart uploads use
// multer and have their own per-route limits (see routes/guests.ts).
app.use(express.json({ limit: "64kb" }));
app.use(pinoHttp({ logger }));

// `version` is the commit the image was built from (stamped as a build ARG in
// apps/api/Dockerfile). deploy.sh compares it against `git rev-parse HEAD` to
// prove the running container is not a stale image.
app.get("/health", (_req, res) =>
  res.json({
    status: "ok",
    version: process.env.GIT_SHA ?? "unknown",
    time: new Date().toISOString(),
  }),
);

const v1 = express.Router();

v1.use("/auth/login", loginLimiter);
v1.use("/auth", authRoutes);
// Public signup — unauthenticated by design; carries its own strict
// limiter (signupLimiter, 5/hour/IP) inside the route file.
v1.use("/public", publicRoutes);

v1.use((req, _res, next) => {
  if (["GET", "HEAD"].includes(req.method)) return readLimiter(req, _res, next);
  return writeLimiter(req, _res, next);
});

// Billing is reachable with a lapsed subscription — it's how a hotel pays
// its way back in — so it mounts BEFORE the subscription gate. (The
// webhook is mounted separately at app level, before express.json.)
v1.use("/billing", billingRoutes);

// Subscription gate for every business router below. Exempt (mounted
// above): /auth, /public, /billing — plus GET /properties/me, which the
// shell needs to render hotel identity on the locked billing screen.
// requireAuth runs here once and stamps req.user/req.propertyId; the
// per-route requireAuth calls inside the routers become no-ops via their
// already-authenticated fast path.
v1.use((req, res, next) => {
  if (req.method === "GET" && req.path === "/properties/me") return next();
  requireAuth(req, res, (err?: unknown) => {
    if (err) return next(err);
    requireActiveSubscription(req, res, next).catch(next);
  }).catch(next);
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

app.use("/api/v1", v1);

app.use(notFound);
app.use(errorHandler);

startDashboardSubscriber().catch((err) =>
  logger.warn({ err }, "dashboard subscriber failed to start"),
);

const server = app.listen(env.PORT, () => {
  logger.info(`Stayvia API listening on http://localhost:${env.PORT}`);
});

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

// Last-resort safety nets. Request-path rejections are handled by
// express-async-errors above; anything landing here comes from background
// work (redis subscriber, PDF browser, fire-and-forget notifies). All
// durable state lives in Postgres, so logging and staying alive is safer
// than killing every in-flight request.
process.on("unhandledRejection", (err) => {
  logger.error({ err }, "unhandled promise rejection");
});
process.on("uncaughtException", (err) => {
  logger.fatal({ err }, "uncaught exception, shutting down");
  shutdown("uncaughtException");
});
