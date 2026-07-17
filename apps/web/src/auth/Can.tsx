import type { ReactNode } from "react";
import { useAuth } from "./AuthContext";

// <Can do="edit_reservations">…</Can>           - one permission
// <Can any={["edit_reservations","cancel_reservations"]}>…</Can>  - any of
// <Can all={["view_reports","export_reports"]}>…</Can>            - all of
// Optional `fallback` renders when the user lacks permission.
interface Props {
  do?: string;
  any?: string[];
  all?: string[];
  children: ReactNode;
  fallback?: ReactNode;
}

export function Can({ do: one, any, all, children, fallback = null }: Props) {
  const { can } = useAuth();
  let ok = true;
  if (one) ok = can(one);
  else if (any && any.length) ok = any.some((k) => can(k));
  else if (all && all.length) ok = all.every((k) => can(k));
  return <>{ok ? children : fallback}</>;
}
