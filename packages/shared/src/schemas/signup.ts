import { z } from "zod";

// Same 10-digit Indian mobile pattern used by guest.ts.
const phoneRegex = /^[6-9]\d{9}$/;

// Channels the signup OTP can be delivered on. "sms" is WhatsApp (the
// messaging lib keeps the historical name).
export const SIGNUP_OTP_CHANNELS = ["email", "sms"] as const;
export type SignupOtpChannel = (typeof SIGNUP_OTP_CHANNELS)[number];

const signupBase = z.object({
  hotelName: z.string().min(2).max(80),
  ownerName: z.string().min(2).max(80),
  email: z.string().email(),
  password: z.string().min(8).max(128),
  phone: z
    .string()
    .regex(phoneRegex, "Phone must be 10-digit Indian mobile")
    .optional(),
});

// Step 1 of public signup — request a verification code on the chosen
// channel (POST /api/v1/public/signup/send-otp). WhatsApp verification
// needs the phone the code goes to.
export const signupSendOtpSchema = z
  .object({
    email: z.string().email(),
    phone: z.string().regex(phoneRegex, "Phone must be 10-digit Indian mobile").optional(),
    channel: z.enum(SIGNUP_OTP_CHANNELS),
  })
  .refine((v) => v.channel !== "sms" || !!v.phone, {
    message: "Phone number is required for WhatsApp verification",
    path: ["phone"],
  });

export type SignupSendOtpInput = z.infer<typeof signupSendOtpSchema>;

// Client-side step-1 validation of the form fields alone (before the OTP
// exists). The server only ever sees the full signupSchema.
export const signupFormSchema = signupBase;

// Step 2 — create the hotel (POST /api/v1/public/signup). Carries the OTP
// the user received plus the channel it was sent on; the server verifies
// it against the same target before provisioning anything.
export const signupSchema = signupBase
  .extend({
    otp: z.string().min(4).max(8),
    otpChannel: z.enum(SIGNUP_OTP_CHANNELS),
  })
  .refine((v) => v.otpChannel !== "sms" || !!v.phone, {
    message: "Phone number is required for WhatsApp verification",
    path: ["phone"],
  });

export type SignupInput = z.infer<typeof signupSchema>;
