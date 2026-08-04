-- ============================================================================
-- PROPOSED MIGRATION — NOT EXECUTED. For review only.
-- 0008: Cash counts, redesigned per AUDIT.md §8/§13 Priority 9 — register +
-- shift + denomination breakdown + expected-vs-counted variance + manager
-- approval, replacing the original tt_cash_counts' single `amount` field
-- (no register, no shift, no breakdown, no approval) and its "today so
-- far" total that combined every register/shift into one meaningless
-- figure (the exact anti-pattern flagged there).
--
-- Shape mirrors count_lines (0003_stocktake_sessions_and_counts.sql):
-- append-only, is_current flips on recount rather than overwriting a
-- value, and a partial unique index keeps exactly one current row per
-- register+shift+day. This also closes AUDIT.md §7.5 for cash the same
-- way count_lines closed it for counting: staff_id must be the caller's
-- own id, so a count can no longer be attributed to a different staff
-- member than whoever is actually signed in.
-- ============================================================================

create table if not exists cash_counts (
  id              uuid primary key default gen_random_uuid(),
  store_id        uuid not null references stores(id),
  register        text not null,
  shift           text not null check (shift in ('open', 'close')),
  count_date      date not null,     -- Brisbane business date, not a timestamp
  denominations   jsonb not null,     -- {"5c":n, "10c":n, ..., "$50":n, "$100":n} -- quantity per AUD denomination
  counted_cash    numeric not null check (counted_cash >= 0),  -- derived from denominations at save time; stored so history/reports don't need to recompute it from jsonb
  expected_cash   numeric check (expected_cash is null or expected_cash >= 0),
  notes           text,
  staff_id        uuid not null references staff(id),
  recount_of_id   uuid references cash_counts(id),
  recount_reason  text,
  is_current      boolean not null default true,
  approved_by     uuid references staff(id),
  approved_at     timestamptz,
  created_at      timestamptz not null default now(),
  check (recount_of_id is null or recount_reason is not null),
  check ((approved_by is null) = (approved_at is null))
);
create unique index if not exists cash_counts_one_current_per_slot
  on cash_counts(store_id, register, shift, count_date) where is_current;
create index if not exists cash_counts_store_idx on cash_counts(store_id, count_date desc);
alter table cash_counts enable row level security;

comment on table cash_counts is
  'Register+shift cash counts with a full denomination breakdown. Never '
  'summed across registers/shifts into one "today so far" figure in the UI '
  '-- that combining is what AUDIT.md flagged as the original app''s '
  'anti-pattern. A recount supersedes the previous current row (is_current '
  '= false) rather than overwriting its value, same append-only shape as '
  'count_lines.';

-- ---- RLS policies -----------------------------------------------------------------
-- SELECT: the general history (everyone's counts) is manager-only,
-- closing AUDIT.md §7.3/§8's canSeeCashHistory fail-open bug
-- (role === 'manager' || role === null) with a real DB guarantee instead
-- of a UI convention. A staff member can additionally see their *own*
-- counts (including past, superseded ones — that's just their own
-- submission history, not a leak) so they can supersede their own current
-- row with a recount below; they still can't see anyone else's.
-- Note this is a deliberate difference from count_lines: a stocktake
-- recount can supersede *anyone's* count line (staff regularly cover the
-- same session), but a cash recount can only supersede your *own* entry
-- unless a manager does it — cash is a financial record, so overriding a
-- colleague's count is a manager action, not a peer one. (A staff-owned
-- row must stay visible under this SELECT policy after an UPDATE flips
-- is_current, or Postgres rejects the UPDATE as an RLS violation on the
-- new row -- hence no is_current condition here, only on the app-level
-- "what's the currently-active count" query.)
create policy cash_counts_select on cash_counts for select to authenticated
  using (
    (is_manager() and has_store_access(store_id))
    or (staff_id = current_staff_id() and has_store_access(store_id))
  );
create policy cash_counts_insert on cash_counts for insert to authenticated
  with check (staff_id = current_staff_id() and has_store_access(store_id));
-- UPDATE's own USING/WITH CHECK stay broad (has_store_access only); actual
-- row-targeting is narrowed by the SELECT policy above (Postgres requires
-- a row to be SELECT-visible to be reachable by UPDATE/DELETE at all), and
-- *which columns* may change — plus that only a manager may set approval —
-- is enforced by the trigger below. Matches the documented split used for
-- count_lines_update_supersede.
create policy cash_counts_update on cash_counts for update to authenticated
  using (has_store_access(store_id))
  with check (has_store_access(store_id));
-- No delete policy — cash counts are a financial record; a mistaken count
-- gets superseded by a recount, never removed.

create or replace function cash_counts_prevent_mutation() returns trigger
language plpgsql as $$
begin
  if new.store_id is distinct from old.store_id
     or new.register is distinct from old.register
     or new.shift is distinct from old.shift
     or new.count_date is distinct from old.count_date
     or new.denominations is distinct from old.denominations
     or new.counted_cash is distinct from old.counted_cash
     or new.expected_cash is distinct from old.expected_cash
     or new.notes is distinct from old.notes
     or new.staff_id is distinct from old.staff_id
     or new.recount_of_id is distinct from old.recount_of_id
     or new.recount_reason is distinct from old.recount_reason
     or new.created_at is distinct from old.created_at
  then
    raise exception 'cash_counts rows are append-only: only is_current and approval fields may change, recount instead';
  end if;
  if (new.approved_by is distinct from old.approved_by or new.approved_at is distinct from old.approved_at)
     and not is_manager() then
    raise exception 'only a manager may approve a cash count';
  end if;
  return new;
end;
$$;
create trigger cash_counts_immutable
  before update on cash_counts
  for each row execute function cash_counts_prevent_mutation();

grant select, insert, update on cash_counts to authenticated;
