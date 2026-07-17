import { cn } from "@/lib/utils";
import type { RoomStatus } from "@hoteldesk/shared";

const STYLES: Record<RoomStatus, string> = {
  available: "bg-success/15 text-success",
  occupied: "bg-accentBlue/15 text-accentBlue",
  reserved: "bg-warning/15 text-warning",
  dirty: "bg-warning/20 text-[#B45309]",
  maintenance: "bg-danger/15 text-danger",
};

// Display labels — keeps the DB enum stable while letting the UI use
// staff-friendly wording. Anything not in this map falls back to the
// raw value with underscores spaced out.
const LABELS: Partial<Record<RoomStatus, string>> = {
  dirty: "Needs Cleaning",
};

export function StatusBadge({ status }: { status: RoomStatus | string }) {
  const cls = STYLES[status as RoomStatus] ?? "bg-gray-200 text-gray-700";
  const label =
    LABELS[status as RoomStatus] ?? String(status).replace("_", " ");
  return (
    <span
      className={cn(
        "inline-flex items-center px-2 py-0.5 text-xs font-medium uppercase tracking-wide rounded-sm",
        cls,
      )}
    >
      {label}
    </span>
  );
}
