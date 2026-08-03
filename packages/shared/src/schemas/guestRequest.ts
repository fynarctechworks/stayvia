import { z } from "zod";
import { MAINTENANCE_CATEGORIES, MAINTENANCE_SEVERITIES } from "./maintenance.js";

// In-room QR guest requests (`guest_requests`, migration 0015).
//
// A guest request is a guest *communication* with its own lifecycle, not a
// work order. It lands in its own table and staff promote it into the real
// modules; the conversion is recorded on the row.
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

//   cleaning — "Clean my room"        → converts to housekeeping
//   amenity  — "Towels, water"        → no target module; acknowledge / done
//   issue    — "Report a problem"     → converts to a maintenance issue
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
// said. Staff commentary belongs on the work item the request converts into.
export const guestRequestUpdateSchema = z.object({
  status: z.enum(GUEST_REQUEST_STAFF_STATUSES),
});

// ---------------------------------------------------------- convert

// Which module each kind promotes into. `amenity` has no target — "towels
// please" fits neither the housekeeping nor the maintenance model, so it is
// acknowledge / done only. The UI reads this to decide whether to render a
// convert button at all; the API must re-check it against the stored row
// rather than trusting the payload.
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

// POST /guest-requests/:id/convert. Discriminated on `target` because the two
// modules need genuinely different context.
//
// Neither branch carries room_id, reservation_id or property_id: all three
// come off the stored request row, scoped by the requester's hotel. A convert
// that took a room from the client would let hotel B file work against hotel
// A's room.
//
// Conversion must be idempotent — converting twice must not create two work
// items. That is enforced in the DB, not just the route: the link columns
// carry partial UNIQUE indexes, and the update is
// `... WHERE id = ? AND property_id = ? AND <link> IS NULL RETURNING *`.
// Zero rows back means it was already converted (a 409, not a second task).
export const guestRequestConvertSchema = z.discriminatedUnion("target", [
  // `issue` → maintenance_issues, the live maintenance module
  // (routes/maintenance.ts + the MaintenanceDetail page). Fields and limits
  // are maintenanceCreateSchema's, with two deliberate differences:
  //
  //   severity     — defaults to "normal", matching the column default, so a
  //                  one-tap convert doesn't demand a triage decision.
  //   costEstimate — optional. maintenanceCreateSchema requires it because an
  //                  issue filed BY staff should carry a budget estimate; a
  //                  guest reporting "AC not cooling" gives the front desk no
  //                  basis for one, and the column is nullable. Writing 0
  //                  would be worse data than null — 0 reads as "free to
  //                  fix". It can be filled in later from the issue page.
  z.object({
    target: z.literal("maintenance"),
    category: z.enum(MAINTENANCE_CATEGORIES),
    severity: z.enum(MAINTENANCE_SEVERITIES).default("normal"),
    // Prefilled in the UI from the guest's note, editable before sending.
    title: z.string().min(3).max(200),
    description: z.string().min(3).max(2000),
    costEstimate: z.coerce.number().nonnegative().optional(),
  }),

  // `cleaning` → housekeeping.
  //
  // BLOCKED — do not wire this branch until the sink is decided.
  // `housekeeping_tasks` exists in the DB but is dormant: zero code
  // references in the whole repo. The live housekeeping surface is the
  // rooms.status board (dirty/available) in routes/housekeeping.ts, which
  // reads nothing from that table. Inserting a housekeeping_tasks row here
  // produces a work item no screen in the product can display — the guest
  // gets told their request was actioned and nobody is ever shown it.
  //
  // The open options are (a) flip rooms.status so the live board reacts
  // (needs a rule for occupied rooms — a stayover asking for cleaning is not
  // a checkout), (b) build the housekeeping_tasks UI, or (c) drop the
  // housekeeping conversion and leave `cleaning` on acknowledge / done.
  // Carrying the target in the contract keeps (a) and (b) open without a
  // shared-package change; it is not permission to insert into a dead table.
  //
  // No required fields: the row already carries the room and the guest's own
  // wording. `notes` is optional staff context, capped at 500 to match the
  // existing housekeeping notes field.
  z.object({
    target: z.literal("housekeeping"),
    notes: z.string().max(500).optional(),
  }),
]);

export type GuestRequestCreateInput = z.infer<typeof guestRequestCreateSchema>;
export type GuestRequestListQuery = z.infer<typeof guestRequestListQuerySchema>;
export type GuestRequestUpdateInput = z.infer<typeof guestRequestUpdateSchema>;
export type GuestRequestConvertInput = z.infer<typeof guestRequestConvertSchema>;
