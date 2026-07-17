import type { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";
import { env } from "../config/env.js";
import { logger } from "../lib/logger.js";
import { fail, HttpError } from "../lib/response.js";

const isProd = env.NODE_ENV === "production";

// Turn a camelCase / snake_case field name into a Title Case label.
//   "idProofNumber"   → "ID Number"
//   "coGuestIds"      → "Co-Guest"
//   "checkInDate"     → "Check-In Date"
// Special-cased acronyms keep their casing instead of being lowercased.
function prettyField(field: string): string {
  const SPECIAL: Record<string, string> = {
    idProofNumber: "ID Number",
    idProofType: "ID Type",
    idProofPhotoFront: "ID Front",
    idProofPhotoBack: "ID Back",
    guestPhoto: "Customer Photo",
    guestId: "Guest",
    coGuestIds: "Second Guest",
    gstin: "GSTIN",
    gstRate: "GST Rate",
    gstMode: "GST Mode",
    otpCode: "OTP",
    checkInDate: "Check-in Date",
    checkOutDate: "Check-out Date",
    durationHours: "Duration (hours)",
    ratePerNight: "Rate / night",
    advancePaid: "Advance",
    advancePaymentMethod: "Payment method",
  };
  if (SPECIAL[field]) return SPECIAL[field];
  // camelCase / snake_case → Title Case Space Separated.
  const spaced = field
    .replace(/_/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

// Translate raw Zod error messages into human-friendly sentences. Keeps
// the original message when no pattern matches — better to surface
// something specific than to swallow it.
function humanizeZod(msg: string): string {
  const lower = msg.toLowerCase();
  if (lower === "required" || lower === "invalid input") return "is missing";
  // "String must contain at least 4 character(s)" → "is missing or too short"
  if (/^string must contain at least (\d+) character/.test(lower)) {
    const m = /at least (\d+) character/.exec(lower);
    const n = m ? Number(m[1]) : 0;
    return n <= 1 ? "is missing" : "is missing or too short";
  }
  if (/^string must contain at most (\d+) character/.test(lower)) {
    return "is too long";
  }
  if (lower === "required field") return "is missing";
  if (lower.includes("invalid email")) return "must be a valid email";
  if (lower.includes("invalid url")) return "must be a valid URL";
  if (lower.includes("invalid uuid")) return "must be a valid ID";
  if (lower.includes("invalid date")) return "must be a valid date";
  if (lower.includes("invalid enum value")) return "has an invalid value";
  if (lower.includes("expected number")) return "must be a number";
  if (lower.includes("expected string")) return "must be text";
  if (lower.includes("must be greater than 0")) return "must be greater than 0";
  // Already human-readable (we wrote it ourselves in shared schemas)?
  // Prepend a verb when it doesn't read like a sentence already.
  if (/^[A-Z]/.test(msg) || msg.startsWith("must") || msg.includes(" is ")) {
    return msg.charAt(0).toLowerCase() + msg.slice(1);
  }
  return msg;
}

export function notFound(_req: Request, res: Response) {
  return fail(res, 404, "NOT_FOUND", "Route not found");
}

export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
): Response {
  if (err instanceof ZodError) {
    // Log the full Zod detail server-side regardless of env so devs can
    // diagnose. Surface a human-readable message naming the failing
    // field(s) so staff knows what to fix. Schema shape is already
    // visible in the open-source web client — hiding it server-side
    // only hurts UX without adding security.
    const flat = err.flatten();
    logger.warn(
      { path: req.path, method: req.method, zod: flat },
      "validation failed",
    );
    // Build a short, user-facing summary: "Field Name: human message; …"
    // Fall back to the first form-level error if no field errors are present.
    const fieldMessages: string[] = [];
    for (const [field, msgs] of Object.entries(flat.fieldErrors)) {
      if (msgs && msgs.length > 0 && msgs[0]) {
        fieldMessages.push(`${prettyField(field)} ${humanizeZod(msgs[0])}`);
      }
    }
    const formError = flat.formErrors[0];
    const message =
      fieldMessages.length > 0
        ? fieldMessages.join("; ")
        : formError || "Invalid request payload";
    return fail(
      res,
      400,
      "VALIDATION_ERROR",
      message,
      // Include full breakdown in dev for the API debugger; omit in prod
      // to keep responses small.
      isProd ? undefined : flat,
    );
  }
  if (err instanceof HttpError) {
    return fail(res, err.status, err.code, err.message, err.details);
  }
  // Multer errors (file size, file count) surface as plain Errors with
  // helpful messages. Pass those through with 400 since they're caused
  // by the client, not the server.
  if (err instanceof Error && err.name === "MulterError") {
    logger.warn({ err: err.message, path: req.path }, "multer rejected upload");
    return fail(res, 400, "UPLOAD_REJECTED", err.message);
  }
  // express.json() emits a PayloadTooLargeError with status 413 when a
  // request body exceeds our limit. Surface a 413 with our standard
  // envelope rather than the default HTML error page.
  if (
    err &&
    typeof err === "object" &&
    "type" in err &&
    (err as { type?: string }).type === "entity.too.large"
  ) {
    logger.warn({ path: req.path }, "request body too large");
    return fail(res, 413, "PAYLOAD_TOO_LARGE", "Request body too large");
  }
  // Postgres-driver errors. We translate the small set we care about
  // into stable API codes; everything else falls through to 500.
  // 23P01 = exclusion_violation (the reservation_rooms no-overlap
  //         constraint added in migration 0011). Surfaces if two
  //         concurrent creates race past the advisory lock — which
  //         shouldn't happen, but the constraint is the truthful
  //         bottom-line answer.
  // 23505 = unique_violation (reservation_number, invoice_number,
  //         receipt_number — produced if the sequence ever desyncs).
  if (err && typeof err === "object" && "code" in err) {
    const pgCode = (err as { code?: string }).code;
    if (pgCode === "23P01") {
      logger.warn({ path: req.path }, "reservation overlap rejected by exclusion constraint");
      return fail(
        res,
        409,
        "ROOM_UNAVAILABLE",
        "Room was just booked by another session for overlapping dates",
      );
    }
    if (pgCode === "23505") {
      const constraint = (err as { constraint_name?: string }).constraint_name ?? "";
      logger.warn({ path: req.path, constraint }, "unique violation");
      return fail(
        res,
        409,
        "DUPLICATE",
        "Duplicate value — this record already exists",
      );
    }
  }
  logger.error({ err, path: req.path, method: req.method }, "Unhandled error");
  return fail(res, 500, "INTERNAL_ERROR", "Something went wrong");
}
