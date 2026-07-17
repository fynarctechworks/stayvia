// In-memory account lockout. Tracks consecutive failed logins per email.
// After N failures within a rolling window, the email is locked for a cool-
// down period regardless of which IP the attempts came from. A successful
// login clears the counter.
//
// This complements the express-rate-limit IP throttle (5/15min from the same
// IP) — that catches a single attacker scripting against the login endpoint;
// this catches an attacker rotating IPs but hammering one account.
//
// Single-process memory is fine here since the system runs one API instance.
// If we ever scale out, swap this for Redis.

import { logger } from "./logger.js";

interface FailRecord {
  count: number;
  // First fail timestamp in the current streak. Used to age out stale
  // counters so a user with one fail from yesterday doesn't get locked out
  // after two more today.
  firstFailAt: number;
  // When set, the account is locked until this timestamp. Cleared on success.
  lockedUntil: number | null;
}

const MAX_FAILS = 8;
// How long a streak counter survives without new fails before it resets.
const STREAK_WINDOW_MS = 30 * 60 * 1000; // 30 minutes
// How long the account stays locked once it trips the threshold.
const LOCK_DURATION_MS = 15 * 60 * 1000; // 15 minutes

const fails = new Map<string, FailRecord>();

// Periodic GC so the map doesn't grow forever. Runs every 10 minutes.
const GC_INTERVAL_MS = 10 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [email, rec] of fails.entries()) {
    if (rec.lockedUntil && rec.lockedUntil < now) {
      // Lock expired and no recent activity — drop entirely.
      fails.delete(email);
      continue;
    }
    if (!rec.lockedUntil && now - rec.firstFailAt > STREAK_WINDOW_MS) {
      fails.delete(email);
    }
  }
}, GC_INTERVAL_MS).unref();

function key(email: string): string {
  return email.trim().toLowerCase();
}

// Returns ms remaining if locked, or 0 if free to proceed.
export function checkLockout(email: string): number {
  const rec = fails.get(key(email));
  if (!rec || !rec.lockedUntil) return 0;
  const remaining = rec.lockedUntil - Date.now();
  if (remaining <= 0) {
    // Lock expired — clear it so the next failure starts fresh.
    fails.delete(key(email));
    return 0;
  }
  return remaining;
}

// Record a failed attempt. Returns true if this attempt tripped the lock.
export function recordFailure(email: string, ip: string): boolean {
  const k = key(email);
  const now = Date.now();
  const existing = fails.get(k);

  if (existing) {
    // If the streak is too old, reset it.
    if (!existing.lockedUntil && now - existing.firstFailAt > STREAK_WINDOW_MS) {
      fails.set(k, { count: 1, firstFailAt: now, lockedUntil: null });
      return false;
    }
    existing.count += 1;
    if (existing.count >= MAX_FAILS && !existing.lockedUntil) {
      existing.lockedUntil = now + LOCK_DURATION_MS;
      logger.warn(
        { email: k, ip, count: existing.count, lockMinutes: LOCK_DURATION_MS / 60000 },
        "account locked after repeated failed logins",
      );
      return true;
    }
    return false;
  }

  fails.set(k, { count: 1, firstFailAt: now, lockedUntil: null });
  return false;
}

// Successful login — wipe the streak.
export function recordSuccess(email: string): void {
  fails.delete(key(email));
}

// Test/admin helper. Not currently exposed to any route but useful for
// unlocking a guest manually from a script.
export function clearLockout(email: string): void {
  fails.delete(key(email));
}
