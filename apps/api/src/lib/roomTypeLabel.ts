// Renders the human-readable room-type label for receipts, invoices and any
// other customer-facing surface.
//
// Rule: show whichever label the staff chose to BILL the room as. If they
// used the "Sell as" picker at booking time, that's the sold-as slug;
// otherwise it's the physical room's native type. The physical type is
// never shown on customer-facing surfaces — that nuance lives in the
// reservation record and the per-room state, not on the guest's bill.
//
// `slugToLabel` is a Map of room_types.slug → room_types.label produced
// from a single SELECT against the room_types table.
//
// `prettify` is the fallback when a slug isn't in the map (e.g. archived
// type that was deleted). It strips underscores and title-cases the slug.

export type RoomTypeLabelMap = Map<string, string>;

function prettify(slug: string): string {
  return slug
    .replace(/_/g, " ")
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function lookup(slug: string, map: RoomTypeLabelMap): string {
  return map.get(slug) ?? prettify(slug);
}

export function combinedRoomTypeLabel(
  physicalSlug: string,
  soldAsSlug: string | null | undefined,
  map: RoomTypeLabelMap,
): string {
  return lookup(soldAsSlug ?? physicalSlug, map);
}
