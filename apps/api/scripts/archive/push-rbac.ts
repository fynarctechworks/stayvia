import "dotenv/config";
import postgres from "postgres";
import { PERMISSION_CATALOG, SYSTEM_ROLES } from "../src/lib/permissions.js";

const SCHEMA_SQL = `
create table if not exists permissions (
  key text primary key,
  area text not null,
  label text not null,
  description text,
  created_at timestamptz not null default now()
);

create table if not exists roles (
  id uuid primary key default gen_random_uuid(),
  key text not null unique,
  label text not null,
  description text,
  is_system boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists role_permissions (
  role_id uuid not null references roles(id) on delete cascade,
  permission_key text not null references permissions(key) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (role_id, permission_key)
);

create table if not exists user_roles (
  user_id uuid primary key references profiles(id) on delete cascade,
  role_id uuid not null references roles(id) on delete restrict,
  assigned_at timestamptz not null default now(),
  assigned_by uuid
);

create table if not exists user_permission_overrides (
  user_id uuid not null references profiles(id) on delete cascade,
  permission_key text not null references permissions(key) on delete cascade,
  effect text not null check (effect in ('grant','deny')),
  created_at timestamptz not null default now(),
  created_by uuid,
  primary key (user_id, permission_key)
);

-- The "*" sentinel must exist as a key for admin to reference it via FK.
insert into permissions (key, area, label, description)
values ('*', 'System', 'All permissions (god mode)', 'Wildcard granted only to the admin role.')
on conflict (key) do nothing;
`;

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL missing");
  const sql = postgres(url, { prepare: false });

  console.log("→ Creating RBAC tables…");
  await sql.unsafe(SCHEMA_SQL);

  console.log("→ Seeding permission catalog…");
  for (const p of PERMISSION_CATALOG) {
    await sql`
      insert into permissions (key, area, label, description)
      values (${p.key}, ${p.area}, ${p.label}, ${p.description ?? null})
      on conflict (key) do update
        set area = excluded.area,
            label = excluded.label,
            description = excluded.description
    `;
  }
  console.log(`  ✓ ${PERMISSION_CATALOG.length} permissions seeded`);

  console.log("→ Seeding system roles…");
  for (const role of Object.values(SYSTEM_ROLES)) {
    const [r] = await sql`
      insert into roles (key, label, description, is_system)
      values (${role.key}, ${role.label}, ${role.description}, true)
      on conflict (key) do update
        set label = excluded.label,
            description = excluded.description,
            is_system = true,
            updated_at = now()
      returning id
    `;
    const roleId = r!.id as string;

    // For non-admin system roles, sync the permission set every run so updates to
    // SYSTEM_ROLES propagate. Admin gets exactly one row: "*".
    if (role.key === "admin") {
      await sql`delete from role_permissions where role_id = ${roleId}`;
      await sql`
        insert into role_permissions (role_id, permission_key)
        values (${roleId}, '*')
      `;
    } else {
      // Replace strategy: simpler than diffing.
      await sql`delete from role_permissions where role_id = ${roleId}`;
      for (const key of role.permissions) {
        await sql`
          insert into role_permissions (role_id, permission_key)
          values (${roleId}, ${key})
          on conflict do nothing
        `;
      }
    }
    console.log(`  ✓ role "${role.key}" → ${role.permissions.length} permissions`);
  }

  console.log("→ Migrating existing profile.role values into user_roles…");
  const migrated = await sql`
    insert into user_roles (user_id, role_id)
    select p.id, r.id
    from profiles p
    join roles r on r.key = p.role
    on conflict (user_id) do nothing
    returning user_id
  `;
  console.log(`  ✓ ${migrated.length} users mapped to a role`);

  console.log("\n✓ RBAC migration complete.");
  await sql.end();
  process.exit(0);
}

main().catch((e) => {
  console.error("✗ RBAC migration failed:", e);
  process.exit(1);
});
