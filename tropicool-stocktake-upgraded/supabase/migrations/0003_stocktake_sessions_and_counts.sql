-- ============================================================================
-- PROPOSED MIGRATION — NOT EXECUTED. For review only.
-- 0003: Stocktake sessions + append-only count lines.
--
-- Replaces tt_entries' overwrite-on-upsert behaviour (upsert on
-- item_id, entry_date — see AUDIT.md §4) with an explicit session and a
-- count_lines table that is never UPDATEd for the counted value itself:
-- every save is a new row, and recounts point back at what they're
-- correcting via recount_of_id. Nothing here ever loses a prior count.
-- ============================================================================

create table if not exists stocktake_sessions (
  id                 uuid primary key default gen_random_uuid(),
  store_id           uuid not null references stores(id),
  business_date      date not null,     -- Australia/Brisbane business date (see js/date.js)
  status             text not null default 'draft'
                        check (status in ('draft','in_progress','submitted','approved','reopened')),
  started_by         uuid not null references staff(id),
  started_at         timestamptz not null default now(),
  submitted_by       uuid references staff(id),
  submitted_at       timestamptz,
  approved_by        uuid references staff(id),
  approved_at        timestamptz,
  notes              text,
  version            integer not null default 1,   -- optimistic concurrency (see below)
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (store_id, business_date)
);
comment on table stocktake_sessions is
  'One session per store per Brisbane business date. "Reopened" is a status '
  'transition on the same row (with an audit_log entry), not a new session — '
  'this keeps one continuous history per trading day instead of fragmenting it.';
comment on column stocktake_sessions.version is
  'Bumped by a trigger on every UPDATE. Clients must send the version they '
  'last read when submitting/approving; a mismatch means someone else changed '
  'the session first and the client must reload and show a conflict, not '
  'silently overwrite (Priority 1, "Multi-user conflicts").';

alter table stocktake_sessions enable row level security;

create or replace function bump_version() returns trigger as $$
begin
  new.version := old.version + 1;
  new.updated_at := now();
  return new;
end;
$$ language plpgsql;

create trigger stocktake_sessions_bump_version
  before update on stocktake_sessions
  for each row execute function bump_version();

-- ---- Count lines (append-only) ------------------------------------------------
create table if not exists count_lines (
  id                 uuid primary key default gen_random_uuid(),
  session_id         uuid not null references stocktake_sessions(id),
  store_inventory_id uuid not null references store_inventory(id),
  system_qty         numeric not null,     -- expected/system quantity at time of count
  counted_qty        numeric not null check (counted_qty >= 0),
  variance           numeric generated always as (counted_qty - system_qty) stored,
  unit               text not null,
  staff_id           uuid not null references staff(id),
  counted_at         timestamptz not null default now(),
  recount_of_id      uuid references count_lines(id),   -- self-reference: what this corrects
  recount_reason     text,
  original_value     numeric,             -- convenience copy of the first count in the chain
  revised_value      numeric,             -- convenience copy of this row's counted_qty when it's a recount
  is_current         boolean not null default true,
  created_at         timestamptz not null default now(),
  check (recount_of_id is null or recount_reason is not null)
);
create index if not exists count_lines_session_idx on count_lines(session_id);
create index if not exists count_lines_inventory_idx on count_lines(store_inventory_id);

-- Exactly one "current" count line per (session, item) — a recount flips the
-- old row's is_current to false in the same transaction that inserts the new
-- one (done in application/Edge Function code, not a trigger, so the
-- multi-user conflict check in Phase 3 can run first and abort the write
-- with a 409 instead of silently applying it).
create unique index if not exists count_lines_one_current_per_item
  on count_lines(session_id, store_inventory_id) where is_current;

alter table count_lines enable row level security;

comment on table count_lines is
  'Never UPDATEd for counted_qty — every save, correction, or recount is a '
  'new INSERT. staff_id must match the authenticated caller (enforced by '
  'RLS in Phase 3, not chosen from a picker) — this is what fixes '
  '"staff can select another employee''s name" from the original app.';

-- Completion percentage is derived, not stored, so it can never drift from
-- the actual count lines. Exposed as a view rather than a generated column
-- because it needs to join against store_inventory (how many active items
-- *should* be counted at this store). Defined after count_lines so the join
-- target actually exists.
create or replace view stocktake_session_progress as
  select
    s.id as session_id,
    count(distinct si.id) filter (where si.active) as total_items,
    count(distinct cl.store_inventory_id) as counted_items,
    case when count(distinct si.id) filter (where si.active) = 0 then 0
         else round(100.0 * count(distinct cl.store_inventory_id)
                    / count(distinct si.id) filter (where si.active))
    end as completion_pct
  from stocktake_sessions s
  join store_inventory si on si.store_id = s.store_id
  left join count_lines cl on cl.session_id = s.id and cl.is_current
  group by s.id;

-- ---- Idempotency for session submission ---------------------------------------
-- Submitting a session (and any "atomic save" of a full section) carries a
-- client-generated idempotency key so a retried request after a dropped
-- connection can't create a duplicate submission or double-count anything.
create table if not exists idempotency_keys (
  key         text primary key,
  session_id  uuid references stocktake_sessions(id),
  created_at  timestamptz not null default now(),
  response    jsonb    -- cached result, replayed verbatim if the same key is seen again
);
alter table idempotency_keys enable row level security;
