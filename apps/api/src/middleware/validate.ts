import type { NextFunction, Request, Response } from "express";
import type { ZodType, ZodTypeDef } from "zod";
import { logger } from "../lib/logger.js";

type Source = "body" | "query" | "params";

// Validates the request using the given Zod schema. After parsing, the
// original payload is compared against the parsed result — if extra fields
// were silently stripped, we log a warning so it surfaces during dev. We
// don't reject the request because some clients (older front-end builds,
// curl scripts) may legitimately send extra fields that are safe to ignore.
//
// Schemas that want hard rejection should be defined with `.strict()` in
// the shared package; this middleware respects that and the ZodError will
// surface normally through the error handler.
//
// Generic note: we use `ZodType<TOut, ZodTypeDef, TIn>` (not the shorter
// `ZodSchema<T>`) so schemas with `.default(...)` or `.transform(...)`
// can have a different input vs. output type without TS rejecting the
// call site. Output type is what lives on `req[source]` after parsing.
export function validate<TOut, TIn = unknown>(
  schema: ZodType<TOut, ZodTypeDef, TIn>,
  source: Source = "body",
) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const raw = req[source];
    const parsed = schema.parse(raw);
    (req as unknown as Record<Source, TOut>)[source] = parsed;

    // Surface unexpected extra fields. Only meaningful for plain objects
    // on body; query/params are loose by nature. This is a cheap audit
    // signal — staff or attackers probing for hidden fields show up here.
    if (
      source === "body" &&
      raw &&
      typeof raw === "object" &&
      !Array.isArray(raw) &&
      parsed &&
      typeof parsed === "object" &&
      !Array.isArray(parsed)
    ) {
      const rawKeys = Object.keys(raw as Record<string, unknown>);
      const parsedKeys = new Set(Object.keys(parsed as Record<string, unknown>));
      const extras = rawKeys.filter((k) => !parsedKeys.has(k));
      if (extras.length > 0) {
        logger.warn(
          { path: req.path, method: req.method, extras },
          "request body had unknown fields (stripped)",
        );
      }
    }
    next();
  };
}
