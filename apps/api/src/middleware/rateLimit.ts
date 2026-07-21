import rateLimit from "express-rate-limit";

export const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { success: false, error: { code: "RATE_LIMITED", message: "Too many login attempts" } },
  standardHeaders: true,
  legacyHeaders: false,
});

// Public signup is the most abusable unauthenticated write in the app —
// each hit can mint a Supabase user + a tenant. Keep it very tight.
export const signupLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: { success: false, error: { code: "RATE_LIMITED", message: "Too many signup attempts" } },
  standardHeaders: true,
  legacyHeaders: false,
});

// Signup OTP sends — looser than signupLimiter (send + a couple of
// resends must fit) but still tight; the route adds per-target DB
// throttles (1/min, 10/day) on top.
export const signupOtpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { success: false, error: { code: "RATE_LIMITED", message: "Too many verification attempts" } },
  standardHeaders: true,
  legacyHeaders: false,
});

// Authenticated limiters key on the USER, not the IP.
//
// A hotel's staff sit behind one broadband connection, so an IP-keyed bucket
// is shared by the whole front desk — and the web client polls hard enough
// that idle tabs alone exhaust it: one open Dashboard is ~15 GET/min (AppShell
// 15s, three Sidebar queries, Dashboard, ArrivalAlerts and CheckoutAlerts all
// on 30s). Six or seven tabs across a few PCs crossed 100/min before anyone
// clicked anything, and because the bucket was shared, one busy tab starved
// the others — 429s on ordinary reads during the check-in rush.
//
// Falling back to the IP keeps unauthenticated traffic limited; requireAuth
// runs before these on every /api/v1 route that matters, so req.user is
// normally set.
const byUserThenIp = (req: { user?: { id: string }; ip?: string }): string =>
  req.user?.id ?? req.ip ?? "unknown";

export const readLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  keyGenerator: byUserThenIp as never,
  standardHeaders: true,
  legacyHeaders: false,
});

export const writeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  keyGenerator: byUserThenIp as never,
  standardHeaders: true,
  legacyHeaders: false,
});
