import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil, Plus, Trash2 } from "@/lib/micons";
import { useState } from "react";
import { useDialog } from "@/components/Dialog";
import { Loader } from "@/components/Loader";
import { useToast } from "@/components/Toast";
import { api } from "@/lib/api";
import { groupByArea, type PermissionDef, type RbacRole } from "@/lib/rbac";

// Roles & Permissions management — rendered as a tab on the Staff page.

export function RolesManager() {
  const qc = useQueryClient();
  const dialog = useDialog();
  const { toast } = useToast();
  const [editing, setEditing] = useState<RbacRole | null>(null);
  const [creating, setCreating] = useState(false);

  const { data: rolesData } = useQuery({
    queryKey: ["rbac-roles"],
    queryFn: () => api.get<RbacRole[]>("/rbac/roles"),
  });
  const { data: catalog } = useQuery({
    queryKey: ["rbac-catalog"],
    queryFn: () => api.get<PermissionDef[]>("/rbac/permissions"),
  });

  const del = useMutation({
    mutationFn: (id: string) => api.del(`/rbac/roles/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["rbac-roles"] });
      toast("Role deleted", "success");
    },
    onError: (e: Error) => toast(e.message, "error"),
  });

  if (!rolesData || !catalog) return <Loader />;

  const grouped = groupByArea(catalog);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <p className="text-sm text-textSecondary">
            Roles bundle permissions. Every role except <em>admin</em> can be
            edited - your changes apply only to this hotel. Custom roles can
            be deleted when no users hold them.
          </p>
        </div>
        <button
          className="btn-primary inline-flex items-center gap-2"
          onClick={() => setCreating(true)}
        >
          <Plus className="w-4 h-4" /> New Role
        </button>
      </div>

      <div className="card p-0">
        <table className="table-base">
          <thead>
            <tr>
              <th>Role</th>
              <th>Type</th>
              <th>Permissions</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rolesData.map((r) => {
              const isAdmin = r.key === "admin";
              const permCount = r.permissions.includes("*") ? "All (god mode)" : `${r.permissions.length}`;
              return (
                <tr key={r.id}>
                  <td>
                    <div className="font-semibold text-brand-dark">{r.label}</div>
                    <div className="text-xs text-textSecondary font-mono">{r.key}</div>
                    {r.description && (
                      <div className="text-xs text-textSecondary mt-0.5">{r.description}</div>
                    )}
                  </td>
                  <td className="text-xs">
                    {r.isSystem ? (
                      <span className="px-1.5 py-0.5 rounded-sm bg-brand-soft text-brand-dark font-semibold">
                        System
                      </span>
                    ) : (
                      <span className="px-1.5 py-0.5 rounded-sm bg-bg text-textSecondary border border-borderc">
                        Custom
                      </span>
                    )}
                  </td>
                  <td className="text-sm font-mono">{permCount}</td>
                  <td className="text-right">
                    <div className="inline-flex gap-2">
                      {/* Editing a shared system role copy-on-writes it into a
                          hotel-owned role server-side — same key, this hotel
                          only. Admin stays locked. */}
                      {!isAdmin && (
                        <button
                          className="text-brand text-xs hover:underline inline-flex items-center gap-1"
                          onClick={() => setEditing(r)}
                        >
                          <Pencil className="w-3 h-3" /> Edit
                        </button>
                      )}
                      {!r.isSystem && (
                        <button
                          className="text-danger text-xs hover:underline inline-flex items-center gap-1"
                          onClick={async () => {
                            const ok = await dialog.confirm({
                              title: `Delete role "${r.label}"?`,
                              message:
                                "This cannot be undone. Users currently in this role must be reassigned first.",
                              okLabel: "Delete role",
                              tone: "danger",
                            });
                            if (ok) del.mutate(r.id);
                          }}
                        >
                          <Trash2 className="w-3 h-3" /> Delete
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {creating && <RoleEditor catalog={grouped} onClose={() => setCreating(false)} />}
      {editing && (
        <RoleEditor catalog={grouped} role={editing} onClose={() => setEditing(null)} />
      )}
    </div>
  );
}

function RoleEditor({
  role,
  catalog,
  onClose,
}: {
  role?: RbacRole;
  catalog: Record<string, PermissionDef[]>;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [key, setKey] = useState(role?.key ?? "");
  const [label, setLabel] = useState(role?.label ?? "");
  const [description, setDescription] = useState(role?.description ?? "");
  const [perms, setPerms] = useState<Set<string>>(new Set(role?.permissions ?? []));
  const [err, setErr] = useState<string | null>(null);

  function toggle(k: string) {
    setPerms((s) => {
      const next = new Set(s);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  }

  function toggleArea(area: string, on: boolean) {
    const keys = (catalog[area] ?? []).map((p) => p.key);
    setPerms((s) => {
      const next = new Set(s);
      for (const k of keys) {
        if (on) next.add(k);
        else next.delete(k);
      }
      return next;
    });
  }

  const save = useMutation({
    mutationFn: () => {
      const body = {
        key,
        label,
        description: description || null,
        permissions: Array.from(perms),
      };
      if (role) {
        const { key: _k, ...rest } = body;
        return api.patch(`/rbac/roles/${role.id}`, rest);
      }
      return api.post(`/rbac/roles`, body);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["rbac-roles"] });
      toast(role ? "Role updated" : "Role created", "success");
      onClose();
    },
    onError: (e: Error) => setErr(e.message),
  });

  return (
    <div
      className="fixed inset-0 z-[150] grid place-items-center bg-brand-dark/40 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-3xl bg-surface rounded-md shadow-xl border border-borderc max-h-[90vh] overflow-hidden flex flex-col">
        <div className="flex items-center justify-between px-5 py-3 border-b border-borderc">
          <div className="font-semibold text-textPrimary">
            {role ? `Edit role · ${role.label}` : "Create role"}
          </div>
          <button onClick={onClose} className="text-textSecondary hover:text-textPrimary text-lg">
            ×
          </button>
        </div>

        <div className="p-5 space-y-4 overflow-y-auto">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="Role key (lowercase, _)">
              <input
                className="input font-mono disabled:bg-bg/50 disabled:text-textSecondary"
                value={key}
                disabled={!!role}
                placeholder="e.g. front_desk_lead"
                onChange={(e) => setKey(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ""))}
              />
            </Field>
            <Field label="Display label">
              <input
                className="input"
                value={label}
                placeholder="e.g. Front Desk Lead"
                onChange={(e) => setLabel(e.target.value)}
              />
            </Field>
          </div>
          <Field label="Description">
            <input
              className="input"
              value={description}
              placeholder="What this role is for"
              onChange={(e) => setDescription(e.target.value)}
            />
          </Field>

          <div>
            <div className="label mb-2">Permissions ({perms.size})</div>
            <div className="space-y-3">
              {Object.entries(catalog).map(([area, defs]) => {
                const all = defs.every((d) => perms.has(d.key));
                const some = defs.some((d) => perms.has(d.key));
                return (
                  <div key={area} className="border border-borderc rounded-sm p-3">
                    <div className="flex items-center justify-between mb-2">
                      <div className="text-sm font-bold text-brand-dark">{area}</div>
                      <button
                        type="button"
                        className="text-xs font-semibold text-brand hover:underline"
                        onClick={() => toggleArea(area, !all)}
                      >
                        {all ? "Clear all" : some ? "Select all" : "Select all"}
                      </button>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                      {defs.map((d) => {
                        const on = perms.has(d.key);
                        return (
                          <label
                            key={d.key}
                            className={`flex items-start gap-2 px-2 py-1.5 rounded-sm cursor-pointer text-sm transition-colors ${
                              on ? "bg-brand-soft" : "hover:bg-bg"
                            }`}
                          >
                            <input
                              type="checkbox"
                              className="mt-0.5"
                              checked={on}
                              onChange={() => toggle(d.key)}
                            />
                            <div className="flex-1 min-w-0">
                              <div className="font-medium text-textPrimary">{d.label}</div>
                              <div className="text-[11px] text-textSecondary font-mono truncate">
                                {d.key}
                              </div>
                            </div>
                          </label>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {err && <div className="text-danger text-sm">{err}</div>}
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-borderc bg-bg/50">
          <button
            onClick={onClose}
            className="px-4 h-9 text-sm font-semibold rounded-sm border-2 border-borderc text-textSecondary hover:border-textSecondary hover:text-textPrimary transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={() => save.mutate()}
            disabled={save.isPending || !key.trim() || !label.trim()}
            className="px-4 h-9 text-sm font-semibold rounded-sm bg-brand-dark text-cream border-2 border-brand-dark hover:opacity-90 transition-opacity disabled:opacity-40"
          >
            {save.isPending ? "Saving…" : role ? "Save changes" : "Create role"}
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
