import { z } from "zod";

// In-room QR guest requests (`guest_requests`, migration 0015).
//
// A guest request is a guest *communication* with its own lifecycle, not a
// work order.
//
// NOT the same thing as "Booking Requests" (/requests), which is QR
// self-booking holds on `reservations`.
//
// Single source of truth for both enums — apps/api/src/db/schema/enums.ts
// re-exports these rather than redeclaring them, the way RESERVATION_STATUSES
// already does. Two hand-written copies of an enum is exactly how
// RESERVATION_STATUSES silently diverged: the API rejected a status the DB
// stores, and nothing could typecheck the mismatch because each app imported
// its own copy.
//
// Both are backed by real Postgres enum types (guest_request_kind /
// guest_request_status), so adding a value needs a migration.

//   cleaning — "Clean my room"        → housekeeping-flavoured
//   amenity  — "Towels, water"        → no work module; acknowledge / done
//   issue    — "Report a problem"     → maintenance-flavoured
export const GUEST_REQUEST_KINDS = ["cleaning", "amenity", "issue"] as const;
export type GuestRequestKind = (typeof GUEST_REQUEST_KINDS)[number];

// open → acknowledged → done | cancelled. `cancelled` is the "guest changed
// their mind / duplicate" exit; both terminal states stamp completed_at and
// completed_by, and `status` is what distinguishes them.
export const GUEST_REQUEST_STATUSES = ["open", "acknowledged", "done", "cancelled"] as const;
export type GuestRequestStatus = (typeof GUEST_REQUEST_STATUSES)[number];

// Still needs someone to do something — the queue's default filter and the
// sidebar badge count.
export const GUEST_REQUEST_OPEN_STATUSES: readonly GuestRequestStatus[] = [
  "open",
  "acknowledged",
];

// Reaching either of these stamps completed_at / completed_by.
export const GUEST_REQUEST_TERMINAL_STATUSES: readonly GuestRequestStatus[] = ["done", "cancelled"];

// The statuses staff may move a request TO. `open` is deliberately absent:
// it is set once, by the guest-side insert (column default), and letting a
// PATCH write it back would resurrect a finished request and leave a stale
// completed_at/completed_by on the row. There is no "reopen" in the decided
// design — a guest who still needs something taps the tile again, which is a
// new request with its own timestamp.
export const GUEST_REQUEST_STAFF_STATUSES = ["acknowledged", "done", "cancelled"] as const;
export type GuestRequestStaffStatus = (typeof GUEST_REQUEST_STAFF_STATUSES)[number];

// Staff-facing labels for the queue. The guest-facing wording is different by
// design ("Clean my room", "Towels, water & amenities", "Report a problem")
// and lives on the guest page — it is marketing copy for a guest, not a
// column header for the front desk.
export const GUEST_REQUEST_KIND_LABELS: Record<GuestRequestKind, string> = {
  cleaning: "Cleaning",
  amenity: "Amenities",
  issue: "Issue",
};

export const GUEST_REQUEST_STATUS_LABELS: Record<GuestRequestStatus, string> = {
  open: "Open",
  acknowledged: "Acknowledged",
  done: "Done",
  cancelled: "Cancelled",
};

// ---------------------------------------------------------- public create

// The in-room QR request payload — POST /public/qr/room/:token/request.
//
// Unauthenticated: every field here is typed by a stranger on their own
// phone. `key` is the unlock token minted by /unlock; the handler re-verifies
// it and re-checks occupancy, so this schema only has to bound the input.
//
// Shape is unchanged from what the guest page has always posted. It moved
// here from schemas/qr.ts (which now aliases it) because the handler persists
// a guest_requests row: the wire enum and the table's enum must be the same
// list, not two lists that happen to agree today.
export const guestRequestCreateSchema = z.object({
  key: z.string().min(10).max(500),
  kind: z.enum(GUEST_REQUEST_KINDS),
  // The guest's own wording, verbatim. Optional — tapping the tile is itself
  // the message. Staff never overwrite this; see guestRequestUpdateSchema.
  note: z.string().max(300).optional(),
});

// ------------------------------------------------------------ staff queue

// GET /guest-requests. Mirrors maintenanceListQuerySchema's shape and
// param naming (snake_case, `page`/`per_page` with the same defaults and
// caps) so the queue page paginates like every other list in the app.
//
// Note there is no `property_id` here and there must never be one: the
// tenant comes from the authenticated request, never from the client.
export const guestRequestListQuerySchema = z.object({
  status: z.enum(GUEST_REQUEST_STATUSES).optional(),
  // Comma-separated multi-status filter — same wire format as
  // maintenance's `statuses`, e.g. `?statuses=open,acknowledged` for the
  // active queue or `?statuses=done,cancelled` for history.
  //
  // Decoded and validated here rather than in the route. maintenance.ts
  // splits the raw string in the handler against a hand-written copy of the
  // status list, which (a) is a fourth place the enum is written down and
  // (b) silently drops unknown values — so `?statuses=nonsense` applies NO
  // status filter and returns the whole table instead of erroring. An
  // invalid value here is a 400, exactly like an invalid `status`.
  //
  // Idempotent under a double parse: routes in this repo often call
  // `schema.parse(req.query)` again after validate() has already replaced
  // req.query with the parsed object, so an array input passes through
  // untouched.
  statuses: z.preprocess(
    (v) => {
      if (typeof v !== "string") return v;
      const parts = v
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      return parts.length > 0 ? parts : undefined;
    },
    z.array(z.enum(GUEST_REQUEST_STATUSES)).min(1).optional(),
  ),
  kind: z.enum(GUEST_REQUEST_KINDS).optional(),
  // Backed by idx_guest_requests_room / idx_guest_requests_reservation —
  // "what has room 204 asked for" and "requests during this stay" on the
  // room and reservation detail pages.
  room_id: z.string().uuid().optional(),
  reservation_id: z.string().uuid().optional(),
  page: z.coerce.number().int().min(1).default(1),
  per_page: z.coerce.number().int().min(1).max(100).default(25),
});

// PATCH /guest-requests/:id — the [Acknowledge] / [Mark done] / [Cancel]
// buttons. Status is the only thing staff can change.
//
// `note` is NOT accepted and must not be added: it holds the guest's own
// words, and the queue's value is that it shows what the guest actually
// said.
export const guestRequestUpdateSchema = z.object({
  status: z.enum(GUEST_REQUEST_STAFF_STATUSES),
});

// ---------------------------------------------------------- convert target

// There is no live "convert this request" action any more — the API route
// (POST /guest-requests/:id/convert) and this schema's payload were removed
// once the UI dropped the flow (commit ddea776). This mapping survives
// because guest_requests still carries the housekeeping_task_id /
// maintenance_issue_id link columns from when the flow existed (and requests
// converted before the removal still point at real rows), so the staff queue
// page uses it to decide, per kind, which link column to read and render as
// a "View work item" link. `amenity` has no target — it was never
// convertible, acknowledge / done only.
export const GUEST_REQUEST_CONVERT_TARGETS = ["housekeeping", "maintenance"] as const;
export type GuestRequestConvertTarget = (typeof GUEST_REQUEST_CONVERT_TARGETS)[number];

export const GUEST_REQUEST_KIND_CONVERT_TARGET: Record<
  GuestRequestKind,
  GuestRequestConvertTarget | null
> = {
  cleaning: "housekeeping",
  amenity: null,
  issue: "maintenance",
};

export type GuestRequestCreateInput = z.infer<typeof guestRequestCreateSchema>;
export type GuestRequestListQuery = z.infer<typeof guestRequestListQuerySchema>;
export type GuestRequestUpdateInput = z.infer<typeof guestRequestUpdateSchema>;
