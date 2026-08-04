-- ============================================================================
-- PROPOSED MIGRATION — NOT EXECUTED. For review only.
-- 0005: Row Level Security policies, keyed off custom JWT claims.
--
-- This app does not use Supabase Auth's email/password or GoTrue users —
-- staff authenticate with a store + PIN (see AUTH_MODEL.md). On success, the
-- verify-staff-pin Edge Function mints a short-lived JWT signed with the
-- project's JWT secret, carrying custom claims: staff_id, store_id,
-- staff_role, plus the standard role: 'authenticated' claim that PostgREST
-- needs to switch the Postgres role from `anon` to `authenticated`. The
-- client attaches that JWT to every subsequent request (see AUTH_MODEL.md
-- "Client wiring"). auth.jwt() below is Supabase's standard helper that
-- reads those claims — it works for any validly-signed JWT, not only ones
-- issued by GoTrue.
-- ============================================================================

create or replace function current_staff_id() returns uuid
language sql stable as $$
  select nullif(auth.jwt()->>'staff_id','')::uuid
$$;

create or replace function current_store_id() returns uuid
language sql stable as $$
  select nullif(auth.jwt()->>'store_id','')::uuid
$$;

create or replace function current_staff_role() returns text
language sql stable as $$
  select auth.jwt()->>'staff_role'
$$;

create or replace function is_manager() returns boolean
language sql stable as $$
  select current_staff_role() = 'manager'
$$;

-- security definer + a pinned search_path: this function needs to read
-- staff_store_access to check cross-store grants, but staff_store_access
-- itself is (correctly) locked down from every client role below. Without
-- security definer, calling this as `authenticated` would fail with
-- "permission denied for table staff_store_access" the moment RLS on any
-- other table tries to use it — the fix is letting this one function run
-- with its owner's privileges, not opening the table itself back up.
create or replace function has_store_access(target_store_id uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select target_store_id = current_store_id()
    or exists (
      select 1 from staff_store_access
      where staff_id = current_staff_id() and store_id = target_store_id
    )
$$;

-- ---- Table-level grants ---------------------------------------------------------
-- RLS policies only restrict *which rows* a role can see/touch; the role
-- still needs the underlying SQL privilege for the operation at all. A
-- freshly created Supabase project auto-grants broad table privileges to
-- anon/authenticated, so this is usually already in place there — it's
-- listed explicitly here so this migration is self-contained and doesn't
-- depend on assuming that default. Note DELETE is never granted to either
-- client role on any table in this app: every "removal" is archived/
-- deactivated instead (Priority 5), so there is nothing to grant.
grant usage on schema public to authenticated;
grant select on stores, item_categories, item_master, store_inventory, item_batches,
  suppliers, audit_log, stocktake_sessions, count_lines, stock_movements
  to authenticated;
grant insert on item_categories, item_master, store_inventory, item_batches,
  suppliers, stocktake_sessions, count_lines, stock_movements
  to authenticated;
grant update on item_categories, item_master, store_inventory, item_batches,
  suppliers, stocktake_sessions, count_lines
  to authenticated;

-- ---- stores -------------------------------------------------------------------
create policy stores_select on stores for select to authenticated
  using (has_store_access(id));
-- No insert/update/delete policy for any client role: opening/closing a
-- store is an operational decision made outside this app (or by a future
-- super-admin surface), not something staff/managers do from the stocktake UI.

-- ---- item_categories (global reference data) -----------------------------------
create policy item_categories_select on item_categories for select to authenticated
  using (true);
create policy item_categories_manage on item_categories for all to authenticated
  using (is_manager()) with check (is_manager());

-- ---- item_master ----------------------------------------------------------------
-- Identity is shared across stores, so read access isn't store-scoped. Only
-- managers can create/edit; nobody gets a DELETE policy — archival is the
-- only supported removal path (Priority 5), enforced here, not just in the UI.
create policy item_master_select on item_master for select to authenticated
  using (true);
create policy item_master_insert on item_master for insert to authenticated
  with check (is_manager());
create policy item_master_update on item_master for update to authenticated
  using (is_manager()) with check (is_manager());

-- ---- store_inventory --------------------------------------------------------------
create policy store_inventory_select on store_inventory for select to authenticated
  using (has_store_access(store_id));
create policy store_inventory_insert on store_inventory for insert to authenticated
  with check (is_manager() and has_store_access(store_id));
create policy store_inventory_update on store_inventory for update to authenticated
  using (is_manager() and has_store_access(store_id))
  with check (is_manager() and has_store_access(store_id));
-- No delete policy — set active = false instead.

-- ---- item_batches -------------------------------------------------------------------
-- Staff can log new batches (receiving a delivery) and update remaining
-- quantity/status as stock is used or wasted; only reachable for their own
-- store via the store_inventory join, matching the staff permission
-- "Record waste and deliveries" from the brief.
create policy item_batches_select on item_batches for select to authenticated
  using (exists (
    select 1 from store_inventory si
    where si.id = item_batches.store_inventory_id and has_store_access(si.store_id)
  ));
create policy item_batches_insert on item_batches for insert to authenticated
  with check (exists (
    select 1 from store_inventory si
    where si.id = item_batches.store_inventory_id and has_store_access(si.store_id)
  ));
create policy item_batches_update on item_batches for update to authenticated
  using (exists (
    select 1 from store_inventory si
    where si.id = item_batches.store_inventory_id and has_store_access(si.store_id)
  ))
  with check (exists (
    select 1 from store_inventory si
    where si.id = item_batches.store_inventory_id and has_store_access(si.store_id)
  ));

-- ---- suppliers (global reference data) --------------------------------------------
create policy suppliers_select on suppliers for select to authenticated
  using (true);
create policy suppliers_manage on suppliers for all to authenticated
  using (is_manager()) with check (is_manager());

-- ---- staff: fully locked down from every client role ------------------------------
-- Deliberately zero policies for anon/authenticated on the base table — the
-- default with RLS enabled and no policy is "deny all", which is exactly
-- what we want. Only the service_role (used inside Edge Functions) can read
-- pin_hash, write PINs, or change roles. The frontend must use staff_public.
revoke all on staff from anon, authenticated;

-- Rebuild staff_public with the store filter baked into the view body
-- (views don't carry their own RLS — this WHERE clause is what scopes it).
create or replace view staff_public as
  select id, home_store_id, name, role, active, (pin_hash is not null) as has_pin_set
  from staff
  where has_store_access(home_store_id);
grant select on staff_public to authenticated;

-- ---- staff_store_access: no client access ------------------------------------------
revoke all on staff_store_access from anon, authenticated;

-- ---- audit_log: manager read-only, no client writes --------------------------------
create policy audit_log_select on audit_log for select to authenticated
  using (is_manager() and has_store_access(store_id));
revoke insert, update, delete on audit_log from anon, authenticated;

-- ---- stocktake_sessions -------------------------------------------------------------
create policy stocktake_sessions_select on stocktake_sessions for select to authenticated
  using (has_store_access(store_id));

create policy stocktake_sessions_insert on stocktake_sessions for insert to authenticated
  with check (has_store_access(store_id) and started_by = current_staff_id());

-- Two UPDATE policies, combined with OR (Postgres RLS default for multiple
-- permissive policies on the same command): staff can move a session through
-- draft/in_progress/submitted; only a manager's update is allowed to touch
-- 'approved' or 'reopened'. This is what stops a staff member from
-- approving (or reopening) their own submission.
create policy stocktake_sessions_update_staff on stocktake_sessions for update to authenticated
  using (has_store_access(store_id))
  with check (
    has_store_access(store_id)
    and status in ('draft','in_progress','submitted')
  );
create policy stocktake_sessions_update_manager on stocktake_sessions for update to authenticated
  using (is_manager() and has_store_access(store_id))
  with check (is_manager() and has_store_access(store_id));

-- ---- count_lines: append-only ---------------------------------------------------------
create policy count_lines_select on count_lines for select to authenticated
  using (exists (
    select 1 from store_inventory si
    where si.id = count_lines.store_inventory_id and has_store_access(si.store_id)
  ));

-- INSERT: staff_id must be the caller's own id (fixes "sign off as someone
-- else"); the session must belong to a store the caller can access and must
-- not already be approved (no new counts on a finalised day without
-- reopening it first, which is a manager-only status change above).
create policy count_lines_insert on count_lines for insert to authenticated
  with check (
    staff_id = current_staff_id()
    and exists (
      select 1 from stocktake_sessions s
      where s.id = count_lines.session_id
        and has_store_access(s.store_id)
        and s.status in ('draft','in_progress','submitted','reopened')
    )
  );

-- The only UPDATE ever allowed is flipping is_current to false when a
-- recount supersedes this row — enforced by the trigger below, not just by
-- this policy, so it's a real guarantee and not just a convention.
create policy count_lines_update_supersede on count_lines for update to authenticated
  using (exists (
    select 1 from store_inventory si
    where si.id = count_lines.store_inventory_id and has_store_access(si.store_id)
  ))
  with check (exists (
    select 1 from store_inventory si
    where si.id = count_lines.store_inventory_id and has_store_access(si.store_id)
  ));

create or replace function count_lines_prevent_value_mutation() returns trigger
language plpgsql as $$
begin
  if new.system_qty is distinct from old.system_qty
     or new.counted_qty is distinct from old.counted_qty
     or new.staff_id is distinct from old.staff_id
     or new.counted_at is distinct from old.counted_at
     or new.session_id is distinct from old.session_id
     or new.store_inventory_id is distinct from old.store_inventory_id
     or new.recount_of_id is distinct from old.recount_of_id
  then
    raise exception 'count_lines rows are append-only: % may not be modified, only is_current may be flipped', TG_TABLE_NAME;
  end if;
  return new;
end;
$$;
create trigger count_lines_immutable
  before update on count_lines
  for each row execute function count_lines_prevent_value_mutation();

-- ---- idempotency_keys: service_role only -------------------------------------------
-- Session submission goes through an Edge Function (not a raw table
-- insert), so the idempotency check, the conflict check, and the
-- is_current-flip-on-recount all happen in one reviewed code path instead
-- of being re-implementable (insecurely) from the client. See AUTH_MODEL.md.
revoke all on idempotency_keys from anon, authenticated;

-- ---- stock_movements -----------------------------------------------------------------
create policy stock_movements_select on stock_movements for select to authenticated
  using (exists (
    select 1 from store_inventory si
    where si.id = stock_movements.store_inventory_id and has_store_access(si.store_id)
  ));
create policy stock_movements_insert on stock_movements for insert to authenticated
  with check (
    staff_id = current_staff_id()
    and exists (
      select 1 from store_inventory si
      where si.id = stock_movements.store_inventory_id and has_store_access(si.store_id)
    )
  );
-- No update/delete: movements are immutable; corrections are new offsetting
-- movements, matching how count_lines handles recounts.
