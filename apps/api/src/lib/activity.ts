import { db } from "../db/client.js";
import { activityLog } from "../db/schema/activity.js";

export async function logActivity(input: {
  action: string;
  entityType: string;
  entityId: string;
  description: string;
  performedBy: string;
  ipAddress?: string | null;
  metadata?: Record<string, unknown>;
}) {
  await db.insert(activityLog).values({
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId,
    description: input.description,
    performedBy: input.performedBy,
    ipAddress: input.ipAddress ?? null,
    metadata: input.metadata ?? null,
  });
}
