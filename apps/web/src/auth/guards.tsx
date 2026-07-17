import type { ReactNode } from "react";
import { Lock } from "lucide-react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";
import type { Role } from "@hoteldesk/shared";
import { Loader } from "@/components/Loader";
import { useAuth } from "./AuthContext";

export function ProtectedRoute({ children }: { children: ReactNode }) {
  const { session, loading, mfaPending } = useAuth();
  const location = useLocation();
  if (loading) return <Loader size="lg" fullscreen />;
  // A session that still owes a second factor is NOT authenticated —
  // bounce to /login where the MFA challenge step lives.
  if (!session || mfaPending)
    return <Navigate to="/login" state={{ from: location }} replace />;
  return <>{children}</>;
}

// Legacy role guard. Still used by some pages until Phase 5 cleanup.
// Prefer PermissionGuard for new code.
export function RoleGuard({ allow, children }: { allow: Role[]; children: ReactNode }) {
  const { profile } = useAuth();
  if (!profile) return null;
  if (!allow.includes(profile.role)) {
    return <Forbidden detail={`Your role (${profile.role}) doesn't have access to this page.`} />;
  }
  return <>{children}</>;
}

// Permission-driven guard. Pass one or more permission keys; the user must have any of them.
// Admin (god mode) always passes.
export function PermissionGuard({
  any,
  all,
  children,
}: {
  any?: string[];
  all?: string[];
  children: ReactNode;
}) {
  const { profile, can } = useAuth();
  if (!profile) return null;
  const ok =
    (any && any.some((k) => can(k))) ||
    (all && all.every((k) => can(k))) ||
    (!any && !all);
  if (!ok) {
    return (
      <Forbidden detail="You don't have permission to access this page." />
    );
  }
  return <>{children}</>;
}

function Forbidden({ detail }: { detail: string }) {
  const navigate = useNavigate();
  return (
    <div className="flex items-center justify-center py-20 px-4">
      <div className="card max-w-md w-full text-center !p-8">
        <div className="w-14 h-14 rounded-full bg-danger/10 grid place-items-center mx-auto">
          <Lock className="w-7 h-7 text-danger" />
        </div>
        <h1 className="text-xl font-bold text-brand-dark mt-4">Access restricted</h1>
        <p className="text-textSecondary mt-2 text-sm">{detail}</p>
        <p className="text-textSecondary mt-1 text-xs">
          If you think you should have access, ask an administrator to update your role.
        </p>
        <div className="flex justify-center gap-2 mt-5">
          <button className="btn-secondary" onClick={() => navigate(-1)}>
            Go back
          </button>
          <button className="btn-primary" onClick={() => navigate("/")}>
            Back to Dashboard
          </button>
        </div>
      </div>
    </div>
  );
}
