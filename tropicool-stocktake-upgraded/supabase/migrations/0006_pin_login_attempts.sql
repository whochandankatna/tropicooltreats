-- ============================================================================
-- PROPOSED MIGRATION — NOT EXECUTED. For review only.
-- 0006: PIN login attempt tracking, used by the verify-staff-pin Edge
-- Function for device-level and staff-level rate limiting/lockout.
-- Written to and read only by service_role (inside the Edge Function) —
-- never by the frontend directly.
-- ============================================================================

create table if not exists pin_login_attempts (
  id          bigint generated always as identity primary key,
  store_id    uuid not null references stores(id),
  client_ref  text not null,     -- random id the frontend generates once per device/install, not a security boundary by itself
  ip_hint     text,               -- best-effort, from the Edge Function's request headers
  staff_id    uuid references staff(id),   -- set only once a hash match identifies who was being attempted
  success     boolean not null,
  attempted_at timestamptz not null default now()
);
create index if not exists pin_login_attempts_client_idx
  on pin_login_attempts(store_id, client_ref, attempted_at desc);
create index if not exists pin_login_attempts_staff_idx
  on pin_login_attempts(staff_id, attempted_at desc);

alter table pin_login_attempts enable row level security;
revoke all on pin_login_attempts from anon, authenticated;
-- Deliberately no policies: only service_role (used inside the Edge
-- Function, which bypasses RLS) reads or writes this table.

comment on table pin_login_attempts is
  'Sliding-window rate limiting. verify-staff-pin checks: (a) failed '
  'attempts from this client_ref in the last 15 minutes at this store, '
  '(b) once a specific staff row is matched, that staff''s own '
  'failed_pin_attempts/locked_until columns (staff table). Either limit '
  'being hit returns a locked-out error without revealing which one. See '
  'AUTH_MODEL.md "Rate limiting" for the exact thresholds and rationale.';

-- Housekeeping: old attempt rows have no ongoing purpose once they age out
-- of the rate-limit window. A scheduled cleanup (pg_cron, or an Edge
-- Function on a schedule) deleting rows older than 24h is recommended
-- once this is live — not included here since it's an operational/cron
-- concern, not a schema concern, and would need your call on which
-- mechanism this Supabase project should use.
