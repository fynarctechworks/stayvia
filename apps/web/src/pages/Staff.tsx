import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, Eye, EyeOff, Pencil, Trash2, UserPlus } from "@/lib/micons";
import { useEffect, useState } from "react";
import { useAuth } from "@/auth/AuthContext";
import { useDialog } from "@/components/Dialog";
import { RolesManager } from "@/components/RolesManager";
import { useToast } from "@/components/Toast";
import { api } from "@/lib/api";
import { groupByArea, type PermissionDef, type RbacRole } from "@/lib/rbac";

// Staff management — promoted from a Settings tab to its own sidebar page.
// Roles & Permissions lives here too, as a second tab.

interface Staff {
  id: string;
  fullName: string;
  email: string;
  role: "admin" | "frontdesk" | "housekeeping";
  phone: string | null;
  isActive: boolean;
}

export default function StaffPage() {
  const qc = useQueryClient();
  const dialog = useDialog();
  const { toast } = useToast();
  const { can } = useAuth();
  const canStaff = can("manage_staff");
  const canRoles = can("manage_roles");
  const [view, setView] = useState<"staff" | "roles">(canStaff ? "staff" : "roles");
  const [showAdd, setShowAdd] = useState(false);
  const [editing, setEditing] = useState<Staff | null>(null);
  const { data = [] } = useQuery({
    queryKey: ["staff"],
    queryFn: () => api.get<Staff[]>("/staff"),
    enabled: canStaff,
  });

  const deactivate = useMutation({
    mutationFn: (id: string) => api.del(`/staff/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["staff"] }),
  });
  const reactivate = useMutation({
    mutationFn: (id: string) => api.put(`/staff/${id}`, { isActive: true }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["staff"] }),
  });
  const hardDelete = useMutation({
    mutationFn: (id: string) => api.del(`/staff/${id}/hard`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["staff"] }),
    onError: (e: Error) => toast(e.message, "error"),
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <h1 className="text-2xl font-bold text-navy">Staff</h1>
        {view === "staff" && canStaff && (
          <button className="btn-primary inline-flex items-center gap-2" onClick={() => setShowAdd(true)}>
            <UserPlus className="w-4 h-4" /> Add Staff
          </button>
        )}
      </div>

      {canStaff && canRoles && (
        <div className="flex gap-1 border-b border-borderc">
          {(
            [
              { id: "staff", label: "Staff" },
              { id: "roles", label: "Roles & Permissions" },
            ] as const
          ).map((t) => (
            <button
              key={t.id}
              onClick={() => setView(t.id)}
              className={`px-4 py-2 text-sm font-medium border-b-2 transition ${
                view === t.id
                  ? "border-gold text-navy"
                  : "border-transparent text-textSecondary hover:text-navy"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      )}

      {view === "roles" && canRoles ? (
        <RolesManager />
      ) : (
      <>
      <div className="card p-0">
        <table className="table-base">
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
              <th>Role</th>
              <th>Phone</th>
              <th>Status</th>
              <th className="!text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {data.map((s) => (
              <tr key={s.id} className={s.isActive ? "" : "opacity-60"}>
                <td>{s.fullName}</td>
                <td>{s.email}</td>
                <td className="capitalize">{s.role}</td>
                <td>{s.phone ?? "-"}</td>
                <td>{s.isActive ? "Active" : "Deactivated"}</td>
                <td className="!text-right">
                  <div className="inline-flex items-center gap-3">
                    <button
                      className="text-brand hover:underline text-xs inline-flex items-center gap-1"
                      onClick={() => setEditing(s)}
                    >
                      <Pencil className="w-3 h-3" /> Edit
                    </button>
                    {s.isActive && (
                      <button
                        className="text-warning hover:underline text-xs inline-flex items-center gap-1"
                        onClick={async () => {
                          const ok = await dialog.confirm({
                            title: `Deactivate ${s.fullName}?`,
                            message: "They will lose access but their history is kept.",
                            okLabel: "Deactivate",
                            tone: "warning",
                          });
                          if (ok) deactivate.mutate(s.id);
                        }}
                      >
                        Deactivate
                      </button>
                    )}
                    {!s.isActive && (
                      <button
                        className="text-success hover:underline text-xs"
                        onClick={() => reactivate.mutate(s.id)}
                      >
                        Reactivate
                      </button>
                    )}
                    <button
                      className="text-danger hover:underline text-xs inline-flex items-center gap-1"
                      onClick={async () => {
                        const ans = await dialog.prompt({
                          title: `Permanently delete ${s.fullName}?`,
                          message:
                            "This removes them from auth and the database. Only works if they have no reservations, invoices, payments, or activity. Type DELETE to confirm.",
                          placeholder: "Type DELETE",
                          okLabel: "Delete forever",
                          tone: "danger",
                          required: true,
                        });
                        if (ans === "DELETE") hardDelete.mutate(s.id);
                      }}
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
      {showAdd && <AddStaffModal onClose={() => setShowAdd(false)} />}
      {editing && <EditStaffModal staff={editing} onClose={() => setEditing(null)} />}
      </>
      )}
    </div>
  );
}

function EditStaffModal({ staff, onClose }: { staff: Staff; onClose: () => void }) {
  const qc = useQueryClient();
  const [form, setForm] = useState({
    fullName: staff.fullName,
    email: staff.email,
    phone: staff.phone ?? "",
  });
  const [newPassword, setNewPassword] = useState("");
  const [confirmNew, setConfirmNew] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  // Reveal-once: after a reset, show the new password one time so it can be
  // handed to the staff member. Never retrievable afterwards (hashed).
  const [resetShown, setResetShown] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const { data: rbacRoles } = useQuery({
    queryKey: ["rbac-roles"],
    queryFn: () => api.get<RbacRole[]>("/rbac/roles"),
  });
  const { data: catalog } = useQuery({
    queryKey: ["rbac-catalog"],
    queryFn: () => api.get<PermissionDef[]>("/rbac/permissions"),
  });
  const { data: effective } = useQuery({
    queryKey: ["rbac-effective", staff.id],
    queryFn: () =>
      api.get<{ roleKey: string | null; isGodMode: boolean; permissions: string[] }>(
        `/rbac/users/${staff.id}/effective`,
      ),
  });
  const { data: existingOverrides } = useQuery({
    queryKey: ["rbac-overrides", staff.id],
    queryFn: () =>
      api.get<{ permissionKey: string; effect: "grant" | "deny" }[]>(
        `/rbac/users/${staff.id}/overrides`,
      ),
  });

  const [selectedRoleId, setSelectedRoleId] = useState<string | null>(null);
  const [overrides, setOverrides] = useState<Record<string, "grant" | "deny">>({});
  const [showAdvanced, setShowAdvanced] = useState(false);

  // Initialise selectedRoleId once rbacRoles + effective have loaded
  useEffect(() => {
    if (selectedRoleId || !rbacRoles || !effective) return;
    const cur = rbacRoles.find((r) => r.key === effective.roleKey);
    setSelectedRoleId(cur?.id ?? null);
  }, [rbacRoles, effective, selectedRoleId]);

  // Initialise overrides from server once
  useEffect(() => {
    if (!existingOverrides) return;
    const map: Record<string, "grant" | "deny"> = {};
    for (const o of existingOverrides) map[o.permissionKey] = o.effect;
    setOverrides(map);
  }, [existingOverrides]);

  const save = useMutation({
    mutationFn: async () => {
      // 1. Profile patch (name/email/phone/password)
      const patch: Record<string, unknown> = {};
      if (form.fullName !== staff.fullName) patch.fullName = form.fullName;
      if (form.email !== staff.email) patch.email = form.email;
      const newPhone = form.phone || null;
      if (newPhone !== (staff.phone ?? null)) patch.phone = newPhone;
      if (newPassword) patch.password = newPassword;
      if (Object.keys(patch).length > 0) {
        await api.put(`/staff/${staff.id}`, patch);
      }

      // 2. RBAC role
      if (selectedRoleId && selectedRoleId !== rbacRoles?.find((r) => r.key === effective?.roleKey)?.id) {
        await api.put(`/rbac/users/${staff.id}/role`, { roleId: selectedRoleId });
      }

      // 3. Overrides
      const arr = Object.entries(overrides).map(([permissionKey, effect]) => ({
        permissionKey,
        effect,
      }));
      await api.put(`/rbac/users/${staff.id}/overrides`, { overrides: arr });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["staff"] });
      qc.invalidateQueries({ queryKey: ["rbac-effective", staff.id] });
      qc.invalidateQueries({ queryKey: ["rbac-overrides", staff.id] });
      // If the password was reset, surface it once instead of auto-closing.
      if (newPassword) {
        setResetShown(newPassword);
      } else {
        setMsg("Saved");
        setTimeout(onClose, 700);
      }
    },
    onError: (e: Error) => setErr(e.message),
  });

  function genStrong() {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
    let out = "";
    const arr = new Uint32Array(14);
    crypto.getRandomValues(arr);
    for (const n of arr) out += chars[n % chars.length];
    setNewPassword(out + "!");
    setConfirmNew(out + "!");
    setShowPw(true);
  }

  const selectedRole = rbacRoles?.find((r) => r.id === selectedRoleId) ?? null;
  const baseRolePerms = new Set(
    selectedRole?.permissions.includes("*")
      ? (catalog ?? []).map((c) => c.key)
      : selectedRole?.permissions ?? [],
  );
  const effectivePerms = (() => {
    const set = new Set(baseRolePerms);
    for (const [k, eff] of Object.entries(overrides)) {
      if (eff === "grant") set.add(k);
      else if (eff === "deny") set.delete(k);
    }
    return set;
  })();

  // Reveal-once screen after a password reset.
  if (resetShown) {
    return (
      <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={onClose}>
        <div
          className="bg-surface rounded-md w-full max-w-md p-6 space-y-4"
          onClick={(e) => e.stopPropagation()}
        >
          <h2 className="text-lg font-semibold text-brand-dark">Password reset</h2>
          <p className="text-sm text-textSecondary">
            New password for <strong className="text-brand-dark">{staff.fullName}</strong>. Copy it
            and share securely - it <strong>won&apos;t be shown again</strong> (stored encrypted, can
            only be reset).
          </p>
          <div className="relative">
            <input readOnly className="input pr-20 font-mono select-all" value={resetShown} />
            <button
              type="button"
              onClick={() => {
                navigator.clipboard?.writeText(resetShown).then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 2000);
                });
              }}
              className="absolute right-2 top-1/2 -translate-y-1/2 inline-flex items-center gap-1 text-xs text-brand hover:underline"
            >
              {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
          <div className="flex justify-end pt-2">
            <button className="btn-primary" onClick={onClose}>Done</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div
        className="bg-surface rounded-md w-full max-w-2xl max-h-[90vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-3 border-b border-borderc">
          <h2 className="text-lg font-semibold text-brand-dark">Edit Staff · {staff.fullName}</h2>
        </div>
        <div className="p-5 space-y-4 overflow-y-auto">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Full Name">
            <input
              className="input"
              value={form.fullName}
              onChange={(e) => setForm({ ...form, fullName: e.target.value })}
            />
          </Field>
          <Field label="Email">
            <input
              className="input"
              type="email"
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
            />
          </Field>
          <Field label="Phone (optional)">
            <input
              className="input"
              type="tel"
              inputMode="numeric"
              maxLength={10}
              placeholder="9876543210"
              value={form.phone}
              onChange={(e) =>
                setForm({ ...form, phone: e.target.value.replace(/\D/g, "").slice(0, 10) })
              }
            />
          </Field>
          <Field label="Role">
            <select
              className="input"
              value={selectedRoleId ?? ""}
              onChange={(e) => setSelectedRoleId(e.target.value || null)}
            >
              <option value="">- Pick a role -</option>
              {(rbacRoles ?? []).map((r) => (
                <option key={r.id} value={r.id}>
                  {r.label}
                  {r.isSystem ? " · system" : " · custom"}
                </option>
              ))}
            </select>
          </Field>
        </div>

        {selectedRole && (
          <div className="bg-bg/50 border border-borderc rounded-sm px-3 py-2 text-xs text-textSecondary">
            <span className="font-semibold text-brand-dark">{selectedRole.label}</span> grants{" "}
            {selectedRole.permissions.includes("*") ? (
              <span className="font-semibold text-success">all permissions (god mode)</span>
            ) : (
              <span>{selectedRole.permissions.length} permissions</span>
            )}
            . Effective for this user: <span className="font-mono">{effectivePerms.size}</span>
            {Object.keys(overrides).length > 0 && (
              <span> · {Object.keys(overrides).length} override(s)</span>
            )}
          </div>
        )}

        {selectedRole && !selectedRole.permissions.includes("*") && catalog && (
          <div>
            <button
              type="button"
              onClick={() => setShowAdvanced((s) => !s)}
              className="text-xs font-semibold text-brand hover:underline"
            >
              {showAdvanced ? "Hide" : "Show"} advanced permission overrides
            </button>
            {showAdvanced && (
              <div className="mt-3 border border-borderc rounded-sm p-3 space-y-3">
                <p className="text-xs text-textSecondary">
                  Three-state for each permission: <strong>Inherit</strong> (use role default),{" "}
                  <strong className="text-success">Grant</strong> (force allow), or{" "}
                  <strong className="text-danger">Deny</strong> (force block). Deny wins.
                </p>
                {Object.entries(groupByArea(catalog)).map(([area, defs]) => (
                  <div key={area}>
                    <div className="text-xs font-bold text-brand-dark mb-1.5">{area}</div>
                    <div className="space-y-1">
                      {defs.map((d) => {
                        const ovr = overrides[d.key];
                        const inRole = baseRolePerms.has(d.key);
                        return (
                          <div
                            key={d.key}
                            className="flex items-center justify-between gap-2 text-sm py-1"
                          >
                            <div className="flex-1 min-w-0">
                              <div className="text-textPrimary truncate">{d.label}</div>
                              <div className="text-[11px] text-textSecondary font-mono">
                                {d.key} · role:{" "}
                                {inRole ? (
                                  <span className="text-success">allowed</span>
                                ) : (
                                  <span className="text-textSecondary">not in role</span>
                                )}
                              </div>
                            </div>
                            <div className="flex gap-1 shrink-0">
                              {(["inherit", "grant", "deny"] as const).map((opt) => {
                                const active = (ovr ?? "inherit") === opt;
                                const cls =
                                  opt === "grant"
                                    ? active
                                      ? "bg-success text-white border-success"
                                      : "border-borderc text-success hover:border-success"
                                    : opt === "deny"
                                      ? active
                                        ? "bg-danger text-white border-danger"
                                        : "border-borderc text-danger hover:border-danger"
                                      : active
                                        ? "bg-brand-dark text-cream border-brand-dark"
                                        : "border-borderc text-textSecondary hover:border-brand-dark";
                                return (
                                  <button
                                    key={opt}
                                    type="button"
                                    onClick={() =>
                                      setOverrides((o) => {
                                        const next = { ...o };
                                        if (opt === "inherit") delete next[d.key];
                                        else next[d.key] = opt;
                                        return next;
                                      })
                                    }
                                    className={`px-2 h-6 text-[10px] font-semibold rounded-sm border transition-colors capitalize ${cls}`}
                                  >
                                    {opt}
                                  </button>
                                );
                              })}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        <div className="border-t border-borderc pt-3 mt-2">
          <div className="text-xs uppercase tracking-wide text-textSecondary mb-2">Reset password</div>
          <div className="relative">
            <input
              className="input pr-20 font-mono"
              type={showPw ? "text" : "password"}
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder="Leave blank to keep current"
              minLength={8}
              autoComplete="new-password"
            />
            <button
              type="button"
              onClick={() => setShowPw(!showPw)}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-textSecondary hover:text-brand"
            >
              {showPw ? "Hide" : "Show"}
            </button>
          </div>
          <div className="flex justify-between items-center mt-1">
            <button type="button" onClick={genStrong} className="text-xs text-brand hover:underline">
              Generate strong password
            </button>
            {newPassword && newPassword.length < 8 && (
              <span className="text-xs text-danger">Min 8 characters</span>
            )}
          </div>
          {newPassword && (
            <div className="mt-2">
              <input
                className="input font-mono"
                type={showPw ? "text" : "password"}
                value={confirmNew}
                onChange={(e) => setConfirmNew(e.target.value)}
                autoComplete="new-password"
                placeholder="Confirm new password"
              />
              {confirmNew !== "" && confirmNew !== newPassword && (
                <div className="text-xs text-danger mt-1">Passwords do not match</div>
              )}
            </div>
          )}
        </div>

        {err && <div className="text-danger text-sm">{err}</div>}
        {msg && <div className="text-success text-sm">{msg}</div>}
        </div>
        <div className="flex justify-end gap-2 px-5 py-3 border-t border-borderc bg-bg/50">
          <button className="btn-secondary" onClick={onClose}>Cancel</button>
          <button
            className="btn-primary"
            onClick={() => save.mutate()}
            disabled={
              save.isPending ||
              (newPassword.length > 0 &&
                (newPassword.length < 8 || confirmNew !== newPassword))
            }
          >
            {save.isPending ? "Saving…" : "Save changes"}
          </button>
        </div>
      </div>
    </div>
  );
}

function AddStaffModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [form, setForm] = useState({
    email: "",
    password: "",
    fullName: "",
    role: "frontdesk" as "admin" | "frontdesk" | "housekeeping",
    phone: "",
  });
  const [err, setErr] = useState<string | null>(null);
  const [showPw, setShowPw] = useState(false);
  // Client-side typo guard — never sent to the API.
  const [confirmPw, setConfirmPw] = useState("");
  // Reveal-once: after a successful create we show the plaintext password
  // one time so staff can hand it over. It's never retrievable afterwards
  // (stored only as an irreversible hash), so this is the single chance
  // to copy it.
  const [created, setCreated] = useState<{ name: string; password: string } | null>(null);
  const [copied, setCopied] = useState(false);

  function genStrong() {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
    let out = "";
    const arr = new Uint32Array(14);
    crypto.getRandomValues(arr);
    for (const n of arr) out += chars[n % chars.length];
    // Generated passwords fill both fields — nothing to mistype.
    setForm((f) => ({ ...f, password: out + "!" }));
    setConfirmPw(out + "!");
    setShowPw(true);
  }

  const pwMismatch = form.password.length >= 8 && confirmPw !== "" && confirmPw !== form.password;

  const save = useMutation({
    mutationFn: () => api.post("/staff", form),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["staff"] });
      // Don't close yet — surface the password once.
      setCreated({ name: form.fullName, password: form.password });
    },
    onError: (e: Error) => setErr(e.message),
  });

  // Post-create reveal-once screen.
  if (created) {
    return (
      <div
        className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
        onClick={onClose}
      >
        <div
          className="bg-surface rounded-md w-full max-w-md p-6 space-y-4"
          onClick={(e) => e.stopPropagation()}
        >
          <h2 className="text-lg font-semibold text-navy">Staff created</h2>
          <p className="text-sm text-textSecondary">
            <strong className="text-navy">{created.name}</strong> can now sign in. Copy the
            password below and share it securely - it{" "}
            <strong>won&apos;t be shown again</strong> (it&apos;s stored encrypted and can only be
            reset, never viewed).
          </p>
          <div>
            <label className="label block mb-1">Password</label>
            <div className="relative">
              <input
                readOnly
                className="input pr-20 font-mono select-all"
                value={created.password}
              />
              <button
                type="button"
                onClick={() => {
                  navigator.clipboard?.writeText(created.password).then(() => {
                    setCopied(true);
                    toast("Password copied", "success");
                    setTimeout(() => setCopied(false), 2000);
                  });
                }}
                className="absolute right-2 top-1/2 -translate-y-1/2 inline-flex items-center gap-1 text-xs text-brand hover:underline"
              >
                {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
          </div>
          <div className="flex justify-end pt-2">
            <button className="btn-primary" onClick={onClose}>Done</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
      onClick={onClose}
    >
      <div
        className="bg-surface rounded-md w-full max-w-md p-6 space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-semibold text-navy">Add Staff</h2>
        <Field label="Full Name">
          <input
            className="input"
            value={form.fullName}
            onChange={(e) => setForm({ ...form, fullName: e.target.value })}
          />
        </Field>
        <Field label="Email">
          <input
            className="input"
            type="email"
            value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })}
          />
        </Field>
        <Field label="Password">
          <div className="relative">
            <input
              className="input pr-20 font-mono"
              type={showPw ? "text" : "password"}
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
              minLength={8}
              autoComplete="new-password"
            />
            <button
              type="button"
              onClick={() => setShowPw((v) => !v)}
              className="absolute right-2 top-1/2 -translate-y-1/2 inline-flex items-center gap-1 text-xs text-textSecondary hover:text-brand"
              aria-label={showPw ? "Hide password" : "Show password"}
            >
              {showPw ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
              {showPw ? "Hide" : "Show"}
            </button>
          </div>
          <div className="flex justify-between items-center mt-1">
            <button type="button" onClick={genStrong} className="text-xs text-brand hover:underline">
              Generate strong password
            </button>
            {form.password && form.password.length < 8 && (
              <span className="text-xs text-danger">Min 8 characters</span>
            )}
          </div>
        </Field>
        <Field label="Confirm password">
          <input
            className="input font-mono"
            type={showPw ? "text" : "password"}
            value={confirmPw}
            onChange={(e) => setConfirmPw(e.target.value)}
            autoComplete="new-password"
            placeholder="Re-enter password"
          />
          {pwMismatch && (
            <div className="text-xs text-danger mt-1">Passwords do not match</div>
          )}
        </Field>
        <Field label="Role">
          <select
            className="input"
            value={form.role}
            onChange={(e) => setForm({ ...form, role: e.target.value as typeof form.role })}
          >
            <option value="frontdesk">Front Desk</option>
            <option value="housekeeping">Housekeeping</option>
            <option value="admin">Admin</option>
          </select>
        </Field>
        <Field label="Phone">
          <input
            className="input"
            type="tel"
            inputMode="numeric"
            maxLength={10}
            placeholder="9876543210"
            value={form.phone}
            onChange={(e) => setForm({ ...form, phone: e.target.value.replace(/\D/g, "").slice(0, 10) })}
          />
          {form.phone !== "" && !/^[6-9]\d{9}$/.test(form.phone) && (
            <div className="text-xs text-danger mt-1">10-digit Indian mobile (starts 6-9)</div>
          )}
        </Field>
        {err && <div className="text-danger text-sm">{err}</div>}
        <div className="flex justify-end gap-2 pt-2">
          <button className="btn-secondary" onClick={onClose}>Cancel</button>
          <button
            className="btn-primary"
            onClick={() => save.mutate()}
            disabled={
              save.isPending ||
              !form.email ||
              form.password.length < 8 ||
              confirmPw !== form.password ||
              !form.fullName ||
              !/^[6-9]\d{9}$/.test(form.phone)
            }
          >
            {save.isPending ? "Creating…" : "Create"}
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
