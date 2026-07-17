import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";

export interface RoomTypeRow {
  id: string;
  slug: string;
  label: string;
  defaultRate: string;
  maxOccupancy: string;
  description: string | null;
  isActive: boolean;
}

export function useRoomTypes(opts: { includeArchived?: boolean } = {}) {
  return useQuery({
    queryKey: ["room-types", opts.includeArchived ?? false],
    queryFn: () =>
      api.get<RoomTypeRow[]>("/settings/room-types", opts.includeArchived ? { all: "true" } : undefined),
    staleTime: 60_000,
  });
}

export function labelForRoomType(types: RoomTypeRow[] | undefined, slug: string): string {
  const found = types?.find((t) => t.slug === slug);
  return found?.label ?? slug.replace(/_/g, " ");
}
