import { z } from "zod";
import { ROOM_STATUSES } from "../enums.js";

export const roomCreateSchema = z.object({
  roomNumber: z.string().min(1).max(10),
  floor: z.coerce.number().int().min(0).max(50),
  roomType: z.string().min(1).max(50),
  baseRate: z.coerce.number().positive(),
  maxOccupancy: z.coerce.number().int().min(1).max(10).default(2),
  hasAc: z.boolean().default(true),
  hasTv: z.boolean().default(true),
  hasWifi: z.boolean().default(true),
  notes: z.string().max(500).optional().nullable(),
});

export const roomUpdateSchema = roomCreateSchema.partial();

export const roomStatusUpdateSchema = z.object({
  status: z.enum(ROOM_STATUSES),
  reason: z.string().max(500).optional(),
});

export const roomListQuerySchema = z.object({
  floor: z.coerce.number().int().optional(),
  status: z.enum(ROOM_STATUSES).optional(),
  type: z.string().optional(),
});

export type RoomCreateInput = z.infer<typeof roomCreateSchema>;
export type RoomUpdateInput = z.infer<typeof roomUpdateSchema>;
export type RoomStatusUpdateInput = z.infer<typeof roomStatusUpdateSchema>;
