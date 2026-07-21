// Shared RBAC shapes used by the Staff and Roles & Permissions pages.

export interface PermissionDef {
  key: string;
  area: string;
  label: string;
  description?: string;
}

export interface RbacRole {
  id: string;
  key: string;
  label: string;
  description: string | null;
  isSystem: boolean;
  permissions: string[];
}

export function groupByArea(catalog: PermissionDef[]): Record<string, PermissionDef[]> {
  const out: Record<string, PermissionDef[]> = {};
  for (const p of catalog) {
    if (!out[p.area]) out[p.area] = [];
    out[p.area]!.push(p);
  }
  return out;
}
