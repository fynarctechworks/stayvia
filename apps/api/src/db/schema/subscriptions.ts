import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { properties } from "./properties.js";

// One subscription row per hotel (Razorpay-backed, single "standard" plan).
// Created as `trialing` at provisioning; billing webhooks move it through
// the lifecycle. requireActiveSubscription (Phase 3) gates business routes
// on status + trial_ends_at.
export const SUBSCRIPTION_STATUSES = [
  "trialing",
  "active",
  "past_due",
  "cancelled",
  "expired",
] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

export const subscriptions = pgTable("subscriptions", {
  id: uuid("id").primaryKey().defaultRandom(),
  propertyId: uuid("property_id")
    .notNull()
    .unique()
    .references(() => properties.id),
  plan: text("plan").notNull().default("standard"),
  status: text("status", { enum: SUBSCRIPTION_STATUSES }).notNull().default("trialing"),
  trialEndsAt: timestamp("trial_ends_at", { withTimezone: true }),
  currentPeriodStart: timestamp("current_period_start", { withTimezone: true }),
  currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }),
  razorpayCustomerId: text("razorpay_customer_id"),
  razorpaySubscriptionId: text("razorpay_subscription_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type Subscription = typeof subscriptions.$inferSelect;
export type NewSubscription = typeof subscriptions.$inferInsert;
