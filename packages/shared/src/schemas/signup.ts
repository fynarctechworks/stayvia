import { z } from "zod";

// Same 10-digit Indian mobile pattern used by guest.ts.
const phoneRegex = /^[6-9]\d{9}$/;

// Public hotel signup (POST /api/v1/public/signup). One form creates the
// Supabase auth user + the whole tenant (property, settings, admin profile,
// trialing subscription).
export const signupSchema = z.object({
  hotelName: z.string().min(2).max(80),
  ownerName: z.string().min(2).max(80),
  email: z.string().email(),
  password: z.string().min(8).max(128),
  phone: z
    .string()
    .regex(phoneRegex, "Phone must be 10-digit Indian mobile")
    .optional(),
});

export type SignupInput = z.infer<typeof signupSchema>;
