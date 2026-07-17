import {
  MAINTENANCE_CATEGORIES,
  MAINTENANCE_CATEGORY_LABELS,
  MAINTENANCE_SEVERITIES,
  MAINTENANCE_SEVERITY_LABELS,
  type MaintenanceCategory,
  type MaintenanceSeverity,
} from "@hoteldesk/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { X } from "lucide-react";
import { useState } from "react";
import { api } from "@/lib/api";

interface RoomLite {
  id: string;
  roomNumber: string;
  floor: number;
  roomType: string;
}

interface CreatedIssue {
  id: string;
}

// A small modal for creating a maintenance issue. Used by:
//   - the Maintenance list page's "New Issue" button (no preset)
//   - the per-room maintenance tab (presetRoomId)
//   - the Housekeeping Flag button (presetRoomId)
export function NewIssueModal({
  presetRoomId,
  onClose,
  onCreated,
}: {
  presetRoomId?: string;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const qc = useQueryClient();
  const [roomId, setRoomId] = useState(presetRoomId ?? "");
  const [category, setCategory] = useState<MaintenanceCategory>("ac_hvac");
  const [severity, setSeverity] = useState<MaintenanceSeverity>("normal");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [costEstimate, setCostEstimate] = useState("");
  const [err, setErr] = useState<string | null>(null);

  // Fetch the room list whenever we don't have a preset (so the
  // dropdown has options). When preset, we still fetch so the modal
  // can label the room properly (number + floor).
  const roomsQ = useQuery({
    queryKey: ["rooms-lite"],
    queryFn: () => api.get<RoomLite[]>("/rooms"),
  });

  const presetRoom = presetRoomId
    ? roomsQ.data?.find((r) => r.id === presetRoomId)
    : undefined;

  const create = useMutation({
    mutationFn: () => {
      // Every field is mandatory at the product layer (see the
      // shared zod schema). These guards exist to give a friendly
      // inline message instead of falling through to a 400.
      if (!roomId) throw new Error("Pick a room");
      if (title.trim().length < 3) {
        throw new Error("Title must be at least 3 characters");
      }
      if (description.trim().length < 3) {
        throw new Error("Description is required");
      }
      const cost = costEstimate.trim() === "" ? NaN : Number(costEstimate);
      if (!Number.isFinite(cost) || cost < 0) {
        throw new Error("Estimated cost is required (₹0 or more)");
      }
      return api.post<CreatedIssue>("/maintenance", {
        roomId,
        category,
        severity,
        title: title.trim(),
        description: description.trim(),
        costEstimate: cost,
      });
    },
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["maint-list"] });
      qc.invalidateQueries({ queryKey: ["maint-summary"] });
      qc.invalidateQueries({ queryKey: ["maint-room"] });
      onCreated(data.id);
    },
    onError: (e: Error) => setErr(e.message),
  });

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4"
      onClick={onClose}
    >
      <div
        className="bg-surface rounded-md w-full max-w-3xl p-6 space-y-4 max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-brand-dark">
            New Maintenance Issue
          </h2>
          <button
            onClick={onClose}
            className="text-textSecondary hover:text-brand-dark"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="col-span-2">
            <label className="label block mb-1">
              Room <span className="text-danger">*</span>
            </label>
            {presetRoomId ? (
              <input
                className="input"
                value={
                  presetRoom
                    ? `${presetRoom.roomNumber} · Floor ${presetRoom.floor}`
                    : "Selected room"
                }
                disabled
              />
            ) : (
              <select
                className="input"
                value={roomId}
                onChange={(e) => setRoomId(e.target.value)}
              >
                <option value="">Pick a room…</option>
                {(roomsQ.data ?? [])
                  .slice()
                  .sort(
                    (a, b) =>
                      a.floor - b.floor ||
                      a.roomNumber.localeCompare(b.roomNumber, undefined, {
                        numeric: true,
                      }),
                  )
                  .map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.roomNumber} · Floor {r.floor}
                    </option>
                  ))}
              </select>
            )}
          </div>

          <div>
            <label className="label block mb-1">
              Category <span className="text-danger">*</span>
            </label>
            <select
              className="input"
              value={category}
              onChange={(e) =>
                setCategory(e.target.value as MaintenanceCategory)
              }
            >
              {MAINTENANCE_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {MAINTENANCE_CATEGORY_LABELS[c]}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label block mb-1">
              Severity <span className="text-danger">*</span>
            </label>
            <select
              className="input"
              value={severity}
              onChange={(e) =>
                setSeverity(e.target.value as MaintenanceSeverity)
              }
            >
              {MAINTENANCE_SEVERITIES.map((s) => (
                <option key={s} value={s}>
                  {MAINTENANCE_SEVERITY_LABELS[s]}
                </option>
              ))}
            </select>
          </div>

          <div className="col-span-2">
            <label className="label block mb-1">
              Title <span className="text-danger">*</span>
            </label>
            <input
              className="input"
              placeholder="Short summary — e.g. AC not cooling"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={200}
            />
          </div>

          <div className="col-span-2">
            <label className="label block mb-1">
              Description <span className="text-danger">*</span>
            </label>
            <textarea
              className="input min-h-[88px]"
              placeholder="Details that help the technician — when noticed, what was tried, etc."
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={2000}
              required
            />
          </div>

          <div className="col-span-2">
            <label className="label block mb-1">
              Estimated cost (₹) <span className="text-danger">*</span>
            </label>
            <input
              className="input"
              type="number"
              min="0"
              step="0.01"
              placeholder="Owner needs a budget figure; enter 0 if no spend expected"
              value={costEstimate}
              onChange={(e) => setCostEstimate(e.target.value)}
              required
            />
          </div>
        </div>

        {err && <div className="text-danger text-xs">{err}</div>}

        <div className="flex justify-end gap-2 pt-2">
          <button className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn-primary"
            onClick={() => create.mutate()}
            // Every input is mandatory — keep the button disabled
            // until they all have a non-empty value so staff can't
            // submit a half-filled issue.
            disabled={
              create.isPending ||
              !roomId ||
              title.trim().length < 3 ||
              description.trim().length < 3 ||
              costEstimate.trim() === "" ||
              Number.isNaN(Number(costEstimate)) ||
              Number(costEstimate) < 0
            }
          >
            {create.isPending ? "Creating…" : "Create Issue"}
          </button>
        </div>
      </div>
    </div>
  );
}
