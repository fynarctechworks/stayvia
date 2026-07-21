import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2 } from "@/lib/micons";
import { useState } from "react";
import { useDialog } from "@/components/Dialog";
import { api } from "@/lib/api";
import { invalidateRoomData } from "@/lib/invalidate";
import { inr } from "@/lib/utils";

// Room-type management (list + add/edit modal + archive/restore/delete).
// Lived as a Settings tab originally; now rendered as the "Room Types" tab
// on the Rooms page, since that's where staff looks for it.

interface ShortStayBand {
  label: string;
  hours: number;
  rate: number;
}

interface RoomTypeRow {
  id: string;
  slug: string;
  label: string;
  defaultRate: string;
  maxOccupancy: string;
  // Per-night charge for each extra person (extra bed) over a room's base
  // occupancy. "0" means extra beds aren't offered for this type.
  extraPersonRate: string;
  description: string | null;
  isActive: boolean;
  // Day-use price bands shown on the reservation form when stay_type is
  // 'short_stay'. Empty array when the property hasn't configured any
  // (the booking form then pro-rates the overnight default rate).
  shortStayBands?: ShortStayBand[];
}

export function RoomTypesManager() {
  const qc = useQueryClient();
  const dialog = useDialog();
  const { data: types = [] } = useQuery({
    queryKey: ["room-types", true],
    queryFn: () => api.get<RoomTypeRow[]>("/settings/room-types", { all: "true" }),
  });

  const [editing, setEditing] = useState<RoomTypeRow | null>(null);
  const [showAdd, setShowAdd] = useState(false);

  // Delete a room type. The API hard-deletes if no rooms reference
  // the slug, and returns 409 IN_USE with a room count otherwise.
  // On IN_USE we prompt the user to force-delete (which nulls the
  // type on every dependent room) — only proceeding if they confirm.
  const del = useMutation({
    mutationFn: async (args: { id: string; force?: boolean }) => {
      const path = `/settings/room-types/${args.id}${args.force ? "?force=true" : ""}`;
      return api.del(path);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["room-types"] }),
  });

  // Restore (un-archive) a previously archived type. Same PUT endpoint
  // the edit form uses, just flipping is_active back to true.
  const restore = useMutation({
    mutationFn: (t: RoomTypeRow) =>
      api.put(`/settings/room-types/${t.id}`, {
        label: t.label,
        slug: t.slug,
        defaultRate: Number(t.defaultRate),
        maxOccupancy: t.maxOccupancy,
        extraPersonRate: Number(t.extraPersonRate),
        description: t.description ?? null,
        isActive: true,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["room-types"] });
      qc.invalidateQueries({ queryKey: ["room-types-active"] });
      invalidateRoomData(qc);
    },
  });

  async function handleDelete(t: RoomTypeRow) {
    const confirmed = await dialog.confirm({
      title: `Delete "${t.label}"?`,
      message:
        "This permanently removes the room type. Use Archive instead if you want existing rooms to keep the label.",
      okLabel: "Delete",
      tone: "danger",
    });
    if (!confirmed) return;
    try {
      await del.mutateAsync({ id: t.id });
    } catch (e) {
      // API returns 409 IN_USE when rooms still reference this slug.
      // ApiError carries .code + .details; the helper api client throws
      // an Error with .message containing the API's message string.
      const msg = e instanceof Error ? e.message : String(e);
      const looksInUse = /still use|in use|IN_USE/i.test(msg);
      if (!looksInUse) {
        await dialog.alert({ title: "Couldn't delete", message: msg });
        return;
      }
      const force = await dialog.confirm({
        title: `Force-delete "${t.label}"?`,
        message: `${msg}\n\nForce delete will detach those rooms (their type becomes empty until you edit them).`,
        okLabel: "Force delete",
        tone: "danger",
      });
      if (force) {
        try {
          await del.mutateAsync({ id: t.id, force: true });
        } catch (e2) {
          await dialog.alert({
            title: "Force delete failed",
            message: e2 instanceof Error ? e2.message : String(e2),
          });
        }
      }
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <div className="text-sm text-textSecondary">
          Room types drive every Type dropdown across the app. Archived types remain on existing rooms but are hidden from new-room forms.
        </div>
        <button className="btn-primary inline-flex items-center gap-2" onClick={() => setShowAdd(true)}>
          <Plus className="w-4 h-4" /> Add Room Type
        </button>
      </div>

      <div className="card p-0 overflow-x-auto">
        <table className="table-base table-fixed">
          <colgroup>
            <col className="w-[24%]" />
            <col className="w-[18%]" />
            <col className="w-[13%]" />
            <col className="w-[9%]" />
            <col className="w-[13%]" />
            <col className="w-[11%]" />
            <col className="w-[12%]" />
          </colgroup>
          <thead>
            <tr>
              <th>Label</th>
              <th>Slug</th>
              <th className="!text-right">Default Rate</th>
              <th className="!text-right">Max Occ.</th>
              <th className="!text-right">Extra Bed/Night</th>
              <th>Status</th>
              <th className="!text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {types.length === 0 && (
              <tr>
                <td colSpan={7} className="p-4 text-textSecondary text-center">
                  No room types yet. Add one to start creating rooms.
                </td>
              </tr>
            )}
            {types.map((t) => (
              <tr key={t.id} className={t.isActive ? "" : "opacity-60"}>
                <td className="font-medium text-navy">{t.label}</td>
                <td className="font-mono text-xs text-textSecondary">{t.slug}</td>
                <td className="text-right font-mono tabular-nums">{inr(t.defaultRate)}</td>
                <td className="text-right tabular-nums">{t.maxOccupancy}</td>
                <td className="text-right font-mono tabular-nums">
                  {Number(t.extraPersonRate) > 0 ? inr(t.extraPersonRate) : "-"}
                </td>
                <td>
                  <span
                    className={`inline-block px-2 py-0.5 rounded-sm text-xs font-medium ${
                      t.isActive
                        ? "bg-success/15 text-success"
                        : "bg-gray-200 text-textSecondary"
                    }`}
                  >
                    {t.isActive ? "Active" : "Archived"}
                  </span>
                </td>
                <td>
                  <div className="flex items-center justify-end gap-3">
                    <button
                      className="text-accentBlue text-xs hover:underline"
                      onClick={() => setEditing(t)}
                    >
                      Edit
                    </button>
                    {!t.isActive && (
                      <button
                        className="text-success text-xs hover:underline"
                        onClick={() => restore.mutate(t)}
                        disabled={restore.isPending}
                        title="Make this room type active again"
                      >
                        Restore
                      </button>
                    )}
                    <button
                      className="text-danger text-xs hover:underline inline-flex items-center gap-1"
                      onClick={() => handleDelete(t)}
                      disabled={del.isPending}
                    >
                      <Trash2 className="w-3 h-3" /> Delete
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {(showAdd || editing) && (
        <RoomTypeModal
          row={editing}
          onClose={() => {
            setShowAdd(false);
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}

function slugify(s: string) {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function RoomTypeModal({ row, onClose }: { row: RoomTypeRow | null; onClose: () => void }) {
  const qc = useQueryClient();
  const isEdit = !!row;
  const [form, setForm] = useState({
    slug: row?.slug ?? "",
    label: row?.label ?? "",
    defaultRate: row ? Number(row.defaultRate) : 1200,
    maxOccupancy: row ? Number(row.maxOccupancy) : 2,
    extraPersonRate: row ? Number(row.extraPersonRate) : 0,
    description: row?.description ?? "",
    isActive: row?.isActive ?? true,
    shortStayBands: (row?.shortStayBands ?? []) as ShortStayBand[],
  });
  const [slugDirty, setSlugDirty] = useState(isEdit);
  const [err, setErr] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: () => {
      const body = {
        slug: form.slug,
        label: form.label,
        defaultRate: form.defaultRate,
        maxOccupancy: form.maxOccupancy,
        extraPersonRate: form.extraPersonRate,
        description: form.description || null,
        isActive: form.isActive,
        // Filter out blank/zero rows so an empty trailing input doesn't
        // get persisted as a useless band. The server clamps hours and
        // rates again with Zod.
        shortStayBands: form.shortStayBands.filter(
          (b) => b.label.trim() && b.hours > 0 && b.rate >= 0,
        ),
      };
      return isEdit
        ? api.put(`/settings/room-types/${row!.id}`, body)
        : api.post("/settings/room-types", body);
    },
    onSuccess: () => {
      // A default-rate change cascades to rooms of this type on the server,
      // so refresh every reader of a room rate — not just the type list.
      qc.invalidateQueries({ queryKey: ["room-types"] });
      qc.invalidateQueries({ queryKey: ["room-types-active"] });
      invalidateRoomData(qc);
      onClose();
    },
    onError: (e: Error) => setErr(e.message),
  });

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
      onClick={onClose}
    >
      <div
        className="bg-surface rounded-md w-full max-w-md p-6 space-y-4 max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-semibold text-navy">
          {isEdit ? `Edit ${row!.label}` : "Add Room Type"}
        </h2>
        <Field label="Label (shown to staff)">
          <input
            className="input"
            value={form.label}
            onChange={(e) => {
              const label = e.target.value;
              setForm({
                ...form,
                label,
                slug: slugDirty ? form.slug : slugify(label),
              });
            }}
            placeholder="e.g. Penthouse Suite"
          />
        </Field>
        <Field label="Slug (internal ID, lowercase, _ allowed)">
          <input
            className="input font-mono"
            value={form.slug}
            onChange={(e) => {
              setSlugDirty(true);
              setForm({ ...form, slug: slugify(e.target.value) });
            }}
            placeholder="penthouse_suite"
          />
          {isEdit && form.slug !== row!.slug && (
            <div className="text-xs text-warning mt-1">
              Renaming the slug will update every room and reservation referencing "{row!.slug}".
            </div>
          )}
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Default Rate (₹)">
            <input
              className="input"
              type="number"
              value={form.defaultRate === 0 ? "" : form.defaultRate}
              onChange={(e) => {
                const v = e.target.value;
                setForm({ ...form, defaultRate: v === "" ? 0 : Number(v) });
              }}
            />
          </Field>
          <Field label="Max Occupancy">
            <input
              className="input"
              type="number"
              value={form.maxOccupancy === 0 ? "" : form.maxOccupancy}
              onChange={(e) => {
                const v = e.target.value;
                setForm({ ...form, maxOccupancy: v === "" ? 0 : Number(v) });
              }}
            />
          </Field>
        </div>
        <Field label="Extra Person Rate (₹ / person / night)">
          <input
            className="input"
            type="number"
            min={0}
            value={form.extraPersonRate === 0 ? "" : form.extraPersonRate}
            placeholder="0"
            onChange={(e) => {
              const v = e.target.value;
              setForm({ ...form, extraPersonRate: v === "" ? 0 : Math.max(0, Number(v)) });
            }}
          />
          <div className="text-xs text-textSecondary mt-1">
            Per-night charge for each extra bed beyond Max Occupancy. Leave 0 to
            disable extra beds for this room type.
          </div>
        </Field>
        <Field label="Description (optional)">
          <input
            className="input"
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
          />
        </Field>
        <label className="inline-flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={form.isActive}
            onChange={(e) => setForm({ ...form, isActive: e.target.checked })}
          />
          Active (available in new-room forms)
        </label>

        <div className="pt-3 border-t border-borderc/40">
          <div className="flex items-center justify-between mb-2">
            <div>
              <div className="text-sm font-semibold text-navy">Day-use price bands</div>
              <div className="text-[11px] text-textSecondary">
                Hourly tiers shown when staff picks "Day use" on a booking. Leave
                empty to pro-rate from the nightly default rate.
              </div>
            </div>
            <button
              type="button"
              className="text-xs text-accentBlue hover:underline"
              onClick={() =>
                setForm({
                  ...form,
                  shortStayBands: [
                    ...form.shortStayBands,
                    { label: "", hours: 0, rate: 0 },
                  ],
                })
              }
            >
              + Add band
            </button>
          </div>
          {form.shortStayBands.length > 0 && (
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-textSecondary">
                  <th className="py-1 font-medium">Label</th>
                  <th className="py-1 font-medium w-20">Hours</th>
                  <th className="py-1 font-medium w-24">Rate (₹)</th>
                  <th className="w-8"></th>
                </tr>
              </thead>
              <tbody>
                {form.shortStayBands.map((b, i) => (
                  <tr key={i}>
                    <td className="py-1 pr-1">
                      <input
                        className="input !h-8 text-xs"
                        value={b.label}
                        placeholder="e.g. 6 hrs"
                        onChange={(e) => {
                          const next = [...form.shortStayBands];
                          next[i] = { ...next[i]!, label: e.target.value };
                          setForm({ ...form, shortStayBands: next });
                        }}
                      />
                    </td>
                    <td className="py-1 pr-1">
                      <input
                        className="input !h-8 text-xs"
                        type="number"
                        min={1}
                        max={23.5}
                        step={0.5}
                        value={b.hours || ""}
                        onChange={(e) => {
                          const next = [...form.shortStayBands];
                          next[i] = { ...next[i]!, hours: Number(e.target.value) };
                          setForm({ ...form, shortStayBands: next });
                        }}
                      />
                    </td>
                    <td className="py-1 pr-1">
                      <input
                        className="input !h-8 text-xs"
                        type="number"
                        min={0}
                        value={b.rate || ""}
                        onChange={(e) => {
                          const next = [...form.shortStayBands];
                          next[i] = { ...next[i]!, rate: Number(e.target.value) };
                          setForm({ ...form, shortStayBands: next });
                        }}
                      />
                    </td>
                    <td className="py-1 text-right">
                      <button
                        type="button"
                        className="text-danger text-xs hover:underline"
                        onClick={() =>
                          setForm({
                            ...form,
                            shortStayBands: form.shortStayBands.filter((_, j) => j !== i),
                          })
                        }
                      >
                        ×
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {err && <div className="text-danger text-sm">{err}</div>}
        <div className="flex justify-end gap-2 pt-2">
          <button className="btn-secondary" onClick={onClose}>Cancel</button>
          <button
            className="btn-primary"
            onClick={() => save.mutate()}
            disabled={save.isPending || !form.label || !form.slug || form.defaultRate <= 0}
          >
            {save.isPending ? "Saving…" : isEdit ? "Save" : "Create"}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="label block mb-1">{label}</label>
      {children}
    </div>
  );
}
