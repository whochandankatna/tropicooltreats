-- ============================================================================
-- PROPOSED MIGRATION — NOT EXECUTED. For review only.
-- 0002: Staff (hashed PINs, never selectable by the anon/authenticated
-- client), staff-store access, and a generic audit log.
-- ============================================================================

-- ---- Staff ------------------------------------------------------------------
create table if not exists staff (
  id            uuid primary key default gen_random_uuid(),
  home_store_id uuid not null references stores(id),
  name          text not null,
  role          text not null default 'staff' check (role in ('staff','manager')),
  active        boolean not null default true,
  pin_hash      text,          -- bcrypt/argon2 hash, set only via the verify-staff-pin
                                -- Edge Function using the service-role key. Never
                                -- written or read by the anon/authenticated client role.
  pin_set_at    timestamptz,
  failed_pin_attempts   integer not null default 0,
  locked_until           timestamptz,      -- set by the Edge Function after repeated failures
  created_at              timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);
alter table staff enable row level security;

comment on column staff.pin_hash is
  'Set/verified exclusively by Edge Functions using the service-role key. '
  'No RLS policy in Phase 3 will grant the anon or authenticated role SELECT '
  'on this column — the client only ever sees the columns exposed via the '
  'staff_public view below.';

-- A staff member's primary store is home_store_id; managers who need access
-- to more than one store get explicit rows here rather than a broad grant.
create table if not exists staff_store_access (
  staff_id   uuid not null references staff(id),
  store_id   uuid not null references stores(id),
  granted_at timestamptz not null default now(),
  primary key (staff_id, store_id)
);
alter table staff_store_access enable row level security;

-- ---- Public-safe view: what the frontend is actually allowed to select ------
-- The client (Daily Entry / Cash Count / Announcements sign-off pickers,
-- Items → Staff admin list) should query this view, never the `staff` table
-- directly. It exists so "never return PIN data to the browser" is enforced
-- structurally, not by remembering not to write `select('*')` on a query
-- that happens to include pin_hash.
create or replace view staff_public as
  select id, home_store_id, name, role, active,
         (pin_hash is not null) as has_pin_set
  from staff;

comment on view staff_public is
  'Safe projection of staff for frontend use — has_pin_set is a boolean, '
  'never the hash itself. Phase 3 RLS grants SELECT here to authenticated '
  'staff scoped to their store; the underlying staff table stays locked down.';

-- ---- Generic audit log --------------------------------------------------------
-- Covers "audit logging for important actions" (Priority 2) and the Reports
-- area's Audit Log (Priority 8). Written by triggers on the tables that need
-- it (stocktake session status changes, item archive/unarchive, staff role
-- changes, PIN resets, large variance approvals) rather than by the client,
-- so it can't be bypassed by calling the table API directly.
create table if not exists audit_log (
  id           bigint generated always as identity primary key,
  store_id     uuid references stores(id),
  actor_id     uuid references staff(id),
  action       text not null,          -- e.g. 'stocktake_approved', 'item_archived', 'pin_reset'
  entity_type  text not null,          -- e.g. 'stocktake_session', 'item_master', 'staff'
  entity_id    uuid,
  before_state jsonb,
  after_state  jsonb,
  occurred_at  timestamptz not null default now()
);
create index if not exists audit_log_store_idx on audit_log(store_id, occurred_at desc);
create index if not exists audit_log_entity_idx on audit_log(entity_type, entity_id);
alter table audit_log enable row level security;

comment on table audit_log is
  'Append-only. No UPDATE or DELETE policy will be granted to any client '
  'role in Phase 3 — rows are written by triggers/Edge Functions only.';
