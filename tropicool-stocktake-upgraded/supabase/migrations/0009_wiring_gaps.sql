-- ============================================================================
-- PROPOSED MIGRATION — NOT EXECUTED. For review only.
-- 0009: Closes three gaps found while wiring database.js to real Supabase
-- calls (Phase 13) that 0001-0008 didn't cover:
--
-- 1. Supplier identity (DATA_MODEL.md "Open questions" #5, deferred to the
--    business owner at the time): resolved as free text, matching what the
--    tested UI (items.js/orders.js, Phases 6-7) already does end to end,
--    rather than forcing a suppliers-table lookup the UI was never built
--    for. store_inventory gets its own supplier_name/supplier_pack_unit/
--    pack_conversion instead of relying on item_master's (shared-across-
--    stores) copies or the supplier_id FK, since the same item can be
--    sourced from a different supplier/pack size at each store.
-- 2. audit_log has no INSERT grant for any client role (0002/0005 — "written
--    by triggers/Edge Functions only"), but no triggers or Edge Functions
--    actually populate it for most actions (item archived, order sent,
--    batch wasted, etc. — only staff_signed_in and staff_pin_reset/
--    staff_role_changed/staff_locked/staff_unlocked are written by the two
--    existing Edge Functions). Rather than leave audit_log silently empty
--    for everything else, or write ~10 new Edge Functions/triggers for
--    every mutating action, this grants authenticated staff INSERT scoped
--    to their own actor_id and store, matching the same "client asserts,
--    RLS checks the caller can't lie about who they are" pattern already
--    used for count_lines.staff_id and stock_movements.staff_id inserts. A
--    trigger-based approach remains more tamper-resistant and is worth
--    revisiting later; this is the pragmatic v1 that matches what's tested.
-- 3. announcements and roster_shifts have no tables at all — the mock/UI
--    layer (announcements.js, roster.js) modelled them from the start
--    (AUDIT.md), but no migration ever added them.
-- ============================================================================

-- ---- 1. Supplier fields on store_inventory (free text) -----------------------
alter table store_inventory
  add column if not exists supplier_name text not null default '',
  add column if not exists supplier_pack_unit text,
  add column if not exists pack_conversion numeric;

-- ---- 1b. Per-store archive metadata ---------------------------------------------
-- item_master already has archived/archived_at/archived_by/archived_reason,
-- but those describe the shared item identity being retired chain-wide.
-- items.js/database.js archive a store's *stocking* of an item (active =
-- false on store_inventory) independently per store, with its own reason
-- shown on the archived-items list ("Archived · reason") — that needs a
-- home on store_inventory, not item_master.
alter table store_inventory
  add column if not exists archived_reason text,
  add column if not exists archived_at timestamptz;

comment on column store_inventory.supplier_name is
  'Free text, not normalised to suppliers.id — see DATA_MODEL.md "Open '
  'questions" #5. The already-scaffolded supplier_id FK and suppliers table '
  'stay in place for a future normalisation but are unused by the client.';
comment on column item_master.supplier_pack_unit is
  'Deprecated in favour of store_inventory.supplier_pack_unit — a store can '
  'source the same item from a different supplier/pack size than another '
  'store, which this shared-identity column can''t represent. Left in place '
  'rather than dropped to avoid a destructive change; not read by the client.';
comment on column item_master.pack_conversion is
  'Deprecated — see store_inventory.pack_conversion above.';

-- ---- 2. Client-attributed audit_log inserts -----------------------------------
grant insert on audit_log to authenticated;
create policy audit_log_insert on audit_log for insert to authenticated
  with check (actor_id = current_staff_id() and has_store_access(store_id));

-- ---- 3. Announcements ----------------------------------------------------------
-- store_id is nullable so a chain-wide announcement (not tied to one store)
-- stays possible, matching the mock's `!storeId` "shows everywhere" filter
-- in database.js's getAnnouncements.
create table if not exists announcements (
  id          uuid primary key default gen_random_uuid(),
  store_id    uuid references stores(id),
  message     text not null,
  staff_id    uuid not null references staff(id),
  staff_name  text,             -- snapshot for display, same convention as purchase_orders.supplier_name
  created_at  timestamptz not null default now()
);
create index if not exists announcements_store_idx on announcements(store_id, created_at desc);
alter table announcements enable row level security;

create policy announcements_select on announcements for select to authenticated
  using (store_id is null or has_store_access(store_id));
create policy announcements_insert on announcements for insert to authenticated
  with check (
    staff_id = current_staff_id()
    and (store_id is null or has_store_access(store_id))
  );
-- No update/delete policy — posts are permanent, matching the "no edit/
-- delete UI" the team-board feature actually ships with.

grant select, insert on announcements to authenticated;

-- ---- 4. Roster shifts (read-only placeholder) -----------------------------------
-- roster.js is explicitly read-only in this app — shift data is described
-- as coming from an external rostering source not yet integrated
-- (AUDIT.md §11.4) — so this table exists purely so getRoster() can query
-- something real (currently empty) instead of the client special-casing
-- "always returns []". Nothing in this app writes to it yet.
create table if not exists roster_shifts (
  id          uuid primary key default gen_random_uuid(),
  store_id    uuid not null references stores(id),
  name        text not null,     -- display line, e.g. "Alice Nguyen — Sat 9am-3pm"
  shift_date  date,
  created_at  timestamptz not null default now()
);
create index if not exists roster_shifts_store_idx on roster_shifts(store_id, shift_date);
alter table roster_shifts enable row level security;

create policy roster_shifts_select on roster_shifts for select to authenticated
  using (has_store_access(store_id));
-- No insert/update/delete policy for any client role yet — nothing in this
-- app writes rosters; a future integration would need its own reviewed
-- policy (service_role from an Edge Function, most likely).

grant select on roster_shifts to authenticated;
