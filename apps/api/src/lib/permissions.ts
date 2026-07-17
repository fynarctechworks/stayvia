// Permission catalog — single source of truth.
// Adding a key here + running the migration script seeds it into the DB.
// Removing a key here does NOT auto-delete from DB; do that explicitly if needed.

export interface PermissionDef {
  key: string;
  area: string;
  label: string;
  description?: string;
}

export const PERMISSION_CATALOG: PermissionDef[] = [
  // Dashboard
  { key: "view_dashboard", area: "Dashboard", label: "View dashboard" },

  // Rooms
  { key: "view_rooms", area: "Rooms", label: "View rooms" },
  { key: "edit_rooms", area: "Rooms", label: "Edit rooms (create / update)" },
  { key: "delete_rooms", area: "Rooms", label: "Delete rooms" },

  // Reservations
  { key: "view_reservations", area: "Reservations", label: "View reservations" },
  { key: "create_reservations", area: "Reservations", label: "Create reservations" },
  { key: "edit_reservations", area: "Reservations", label: "Edit reservations (dates, rooms, charges)" },
  { key: "check_in", area: "Reservations", label: "Check guests in" },
  { key: "check_out", area: "Reservations", label: "Check guests out & generate invoice" },
  { key: "cancel_reservations", area: "Reservations", label: "Cancel reservations" },
  { key: "extend_stay", area: "Reservations", label: "Extend stay / late checkout" },
  { key: "add_charge", area: "Reservations", label: "Add additional charges" },
  { key: "delete_charge", area: "Reservations", label: "Delete additional charges" },

  // Guests
  { key: "view_guests", area: "Guests", label: "View guests" },
  { key: "edit_guests", area: "Guests", label: "Edit guest profiles" },
  { key: "delete_guests", area: "Guests", label: "Delete guests" },
  { key: "view_kyc", area: "Guests", label: "View KYC documents" },
  { key: "upload_kyc", area: "Guests", label: "Upload / replace KYC" },

  // Housekeeping
  { key: "view_housekeeping", area: "Housekeeping", label: "View housekeeping board" },
  { key: "update_housekeeping", area: "Housekeeping", label: "Mark room status (clean / inspected / etc.)" },
  { key: "flag_maintenance", area: "Housekeeping", label: "Flag rooms for maintenance" },
  { key: "resolve_maintenance", area: "Housekeeping", label: "Resolve maintenance flags" },

  // Messaging
  { key: "view_messages", area: "Messaging", label: "View message history" },
  { key: "send_messages", area: "Messaging", label: "Send WhatsApp messages" },

  // Collections / Payments
  { key: "view_collections", area: "Collections", label: "View collections page" },
  { key: "record_payments", area: "Collections", label: "Record payments" },
  { key: "void_payments", area: "Collections", label: "Void payments" },
  { key: "send_reminders", area: "Collections", label: "Send payment reminders" },

  // Invoices
  { key: "view_invoices", area: "Invoices", label: "View invoices" },
  { key: "preview_invoice", area: "Invoices", label: "Preview invoice before checkout" },
  { key: "void_invoices", area: "Invoices", label: "Void invoices" },
  { key: "reissue_invoices", area: "Invoices", label: "Reissue (correct) invoices" },

  // Reports
  { key: "view_reports", area: "Reports", label: "View reports" },
  { key: "export_reports", area: "Reports", label: "Export reports (CSV)" },

  // Revenue / financial visibility. Gates rupee totals across the app
  // (Dashboard "Revenue Today", Collections totals, etc.) — distinct
  // from `view_reports` because some properties want staff to see *their*
  // collections without seeing aggregate revenue.
  { key: "view_revenue", area: "Reports", label: "View revenue & financial totals" },

  // Daily cash-up visibility — a narrower slice of `view_revenue`. Lets
  // front-desk staff see TODAY's collections (the "Collections by Method"
  // cash-up panel + "Revenue Today" tile) so they can settle the drawer
  // at shift end, WITHOUT exposing month-to-date revenue or the
  // property-wide outstanding balance (those stay behind view_revenue).
  { key: "view_daily_collections", area: "Reports", label: "View today's cash-up (daily collections)" },

  // Activity & Notifications
  { key: "view_activity", area: "Activity", label: "View activity log" },
  { key: "view_notifications", area: "Notifications", label: "View notifications" },

  // Expenses (migration 0025) — property-side overheads ledger.
  // Senior-staff scope by default; receptionists / housekeeping
  // don't get either key out of the box.
  { key: "view_expenses", area: "Expenses", label: "View expenses" },
  {
    key: "manage_expenses",
    area: "Expenses",
    label: "Record / edit / delete expenses",
  },

  // Maintenance (migration 0032)
  {
    key: "view_maintenance",
    area: "Maintenance",
    label: "View maintenance issues",
  },
  {
    key: "manage_maintenance",
    area: "Maintenance",
    label: "Create / update / resolve maintenance issues",
  },

  // Admin
  { key: "manage_staff", area: "Admin", label: "Manage staff (add / edit / deactivate)" },
  { key: "manage_roles", area: "Admin", label: "Manage roles & permissions" },
  { key: "manage_settings", area: "Admin", label: "Manage hotel settings" },
  { key: "manage_templates", area: "Admin", label: "Manage message templates" },
];

export const PERMISSION_KEYS = PERMISSION_CATALOG.map((p) => p.key);
export type PermissionKey = (typeof PERMISSION_KEYS)[number];

// System role definitions. The admin role is hardcoded as god-mode (gets "*").
// Frontdesk and housekeeping are seeded with sensible defaults but can be edited.
// Admin role itself cannot be edited (locked at the DB / API layer).

export const SYSTEM_ROLES = {
  admin: {
    key: "admin",
    label: "Administrator",
    description: "Full access. Cannot be edited.",
    permissions: ["*"], // god mode
  },
  frontdesk: {
    key: "frontdesk",
    label: "Front Desk",
    description: "Bookings, check-in/out, payments, guests.",
    permissions: [
      "view_dashboard",
      "view_rooms",
      "view_reservations",
      "create_reservations",
      "edit_reservations",
      "check_in",
      "check_out",
      "cancel_reservations",
      "extend_stay",
      "add_charge",
      "view_guests",
      "edit_guests",
      "view_kyc",
      "upload_kyc",
      "view_housekeeping",
      "update_housekeeping",
      "flag_maintenance",
      "resolve_maintenance",
      "view_messages",
      "send_messages",
      "view_collections",
      "record_payments",
      "send_reminders",
      "view_invoices",
      "preview_invoice",
      // Daily cash-up: the desk settles the drawer at shift end, so it
      // sees today's collections + revenue, but not MTD revenue or the
      // property-wide outstanding balance (those need view_revenue).
      "view_daily_collections",
      // Frontdesk needs reissue_invoices for the convert-invoices
      // (Consolidate / Split) workflow added late June 2026. Without
      // it the desk hits a 403 the moment they try to fix the bill
      // shape on a mid-stay booking. Voiding still requires
      // void_invoices, which stays admin-only.
      "reissue_invoices",
      "view_maintenance",
      "manage_maintenance",
      "view_activity",
      "view_notifications",
    ],
  },
  housekeeping: {
    key: "housekeeping",
    label: "Housekeeping",
    description: "Room status updates and maintenance flags.",
    permissions: [
      "view_housekeeping",
      "update_housekeeping",
      "flag_maintenance",
      "resolve_maintenance",
      "view_maintenance",
      "manage_maintenance",
      "view_messages",
      "view_notifications",
    ],
  },
  // Owner / Manager / Accountant personas. In the cloud these are seeded by
  // migration 0011; offline that migration is stamped-not-run, so they must
  // live here (the code catalog is the single source of truth for the offline
  // seed path — seedRbacAndAssignAdmin loops Object.values(SYSTEM_ROLES)).
  // Grants copied verbatim from 0011_phase1_stabilization.sql.
  owner: {
    key: "owner",
    label: "Hotel Owner",
    description: "Read-only view of every operation. Receives owner WhatsApp alerts.",
    permissions: [
      "view_dashboard",
      "view_rooms",
      "view_reservations",
      "view_guests",
      "view_kyc",
      "view_housekeeping",
      "view_messages",
      "view_collections",
      "view_invoices",
      "view_reports",
      "view_revenue",
      "view_activity",
      "view_notifications",
    ],
  },
  manager: {
    key: "manager",
    label: "General Manager",
    description: "Full operational access except staff/role administration.",
    permissions: [
      "view_dashboard",
      "view_rooms",
      "edit_rooms",
      "delete_rooms",
      "view_reservations",
      "create_reservations",
      "edit_reservations",
      "check_in",
      "check_out",
      "cancel_reservations",
      "extend_stay",
      "add_charge",
      "delete_charge",
      "view_guests",
      "edit_guests",
      "delete_guests",
      "view_kyc",
      "upload_kyc",
      "view_housekeeping",
      "update_housekeeping",
      "flag_maintenance",
      "resolve_maintenance",
      "view_messages",
      "send_messages",
      "view_collections",
      "record_payments",
      "void_payments",
      "send_reminders",
      "view_invoices",
      "preview_invoice",
      "void_invoices",
      "reissue_invoices",
      "view_reports",
      "export_reports",
      "view_revenue",
      "view_activity",
      "view_notifications",
      "manage_settings",
      "manage_templates",
    ],
  },
  accountant: {
    key: "accountant",
    label: "Accountant",
    description: "Invoices, payments, collections, GST reports, exports. No room ops.",
    permissions: [
      "view_dashboard",
      "view_reservations",
      "view_guests",
      "view_kyc",
      "view_collections",
      "record_payments",
      "void_payments",
      "send_reminders",
      "view_invoices",
      "preview_invoice",
      "void_invoices",
      "reissue_invoices",
      "view_reports",
      "export_reports",
      "view_revenue",
      "view_activity",
      "view_notifications",
    ],
  },
} as const;

export type SystemRoleKey = keyof typeof SYSTEM_ROLES;
