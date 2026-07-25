import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function inr(value: number | string) {
  const n = typeof value === "string" ? Number(value) : value;
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 2,
  }).format(n);
}

// Per-ID-type input limits for guest KYC. Each entry drives the ID Number
// field: allowed characters, hard length cap, and a placeholder showing the
// expected shape. Aadhaar is digits-only; the rest are uppercase alphanumeric
// (DL kept generous — state formats vary).
export const ID_PROOF_SPECS: Record<
  string,
  { maxLength: number; digitsOnly?: boolean; placeholder: string }
> = {
  aadhaar: { maxLength: 12, digitsOnly: true, placeholder: "12 digits" },
  pan: { maxLength: 10, placeholder: "ABCDE1234F" },
  passport: { maxLength: 8, placeholder: "A1234567" },
  driving_license: { maxLength: 16, placeholder: "Up to 16 characters" },
  voter_id: { maxLength: 10, placeholder: "ABC1234567" },
};

// Clamp raw ID-number input to its type's rules: strip disallowed characters,
// uppercase, cap the length. Unknown types just get the schema's 50-char cap.
export function sanitizeIdProofNumber(idType: string, raw: string): string {
  const spec = ID_PROOF_SPECS[idType];
  if (!spec) return raw.slice(0, 50);
  const cleaned = spec.digitsOnly
    ? raw.replace(/\D/g, "")
    : raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return cleaned.slice(0, spec.maxLength);
}

export function formatTime(hhmm: string | null | undefined): string {
  if (!hhmm) return "";
  const [hStr, mStr] = hhmm.split(":");
  const h = Number(hStr);
  const m = mStr ?? "00";
  const period = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${m.padStart(2, "0")} ${period}`;
}
