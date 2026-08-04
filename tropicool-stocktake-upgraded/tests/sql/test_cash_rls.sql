-- RLS verification for cash_counts: own-row visibility, impersonation
-- blocked, history hidden from other staff, manager-only approval,
-- append-only monetary fields, one-current-row-per-slot uniqueness, and
-- the recount flip. Run against a scratch local Postgres 16 with
-- _local_auth_stub.sql and the real migrations applied first -- never
-- against a real database. \set ON_ERROR_STOP off is deliberate: several
-- statements below are EXPECTED to error (that's the assertion), so the
-- script must keep going and each result should be read by eye.
\set ON_ERROR_STOP off
begin;

insert into stores (id, slug, name) values
  ('00000000-0000-0000-0000-000000000001', 'mooloolaba', 'Mooloolaba'),
  ('00000000-0000-0000-0000-000000000002', 'noosa', 'Noosa');

insert into staff (id, home_store_id, name, role, pin_hash) values
  ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000000001', 'Manager Moo', 'manager', 'x'),
  ('00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-000000000001', 'Staff Moo', 'staff', 'x'),
  ('00000000-0000-0000-0000-0000000000a3', '00000000-0000-0000-0000-000000000001', 'Staff Moo Two', 'staff', 'x'),
  ('00000000-0000-0000-0000-0000000000a4', '00000000-0000-0000-0000-000000000002', 'Manager Noosa', 'manager', 'x');

commit;

-- 1. Staff can insert their own cash count
set role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated","staff_id":"00000000-0000-0000-0000-0000000000a2","store_id":"00000000-0000-0000-0000-000000000001","staff_role":"staff"}', false);
insert into cash_counts (id, store_id, register, shift, count_date, denominations, counted_cash, staff_id)
  values ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-000000000001', 'Front counter', 'open', '2026-08-04', '{"$50": 2}', 100, '00000000-0000-0000-0000-0000000000a2');
select count(*) as test1_should_be_one_own_current_row_visible from cash_counts where id = '00000000-0000-0000-0000-0000000000e1';
reset role;

-- 2. Staff CANNOT insert a cash count attributed to someone else (impersonation fix, expect error)
set role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated","staff_id":"00000000-0000-0000-0000-0000000000a2","store_id":"00000000-0000-0000-0000-000000000001","staff_role":"staff"}', false);
insert into cash_counts (id, store_id, register, shift, count_date, denominations, counted_cash, staff_id)
  values ('00000000-0000-0000-0000-0000000000e2', '00000000-0000-0000-0000-000000000001', 'Front counter', 'close', '2026-08-04', '{"$50": 1}', 50, '00000000-0000-0000-0000-0000000000a3');
reset role;

-- 3. A DIFFERENT staff member (not the one who counted) sees none of it --
--    proves history/other-people's-counts stay hidden (fail-open bug fix),
--    even though a2 can see their own row (test1) and one row now exists.
set role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated","staff_id":"00000000-0000-0000-0000-0000000000a3","store_id":"00000000-0000-0000-0000-000000000001","staff_role":"staff"}', false);
select count(*) as test3_should_be_zero from cash_counts;
reset role;

-- 4. Manager CAN select cash history at their own store
set role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated","staff_id":"00000000-0000-0000-0000-0000000000a1","store_id":"00000000-0000-0000-0000-000000000001","staff_role":"manager"}', false);
select count(*) as test4_should_be_one from cash_counts;
reset role;

-- 5. Manager at a DIFFERENT store cannot see Mooloolaba's cash counts (expect 0)
set role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated","staff_id":"00000000-0000-0000-0000-0000000000a4","store_id":"00000000-0000-0000-0000-000000000002","staff_role":"manager"}', false);
select count(*) as test5_should_be_zero from cash_counts;
reset role;

-- 6. Staff CANNOT approve a cash count directly (trigger blocks non-manager approval, expect error)
set role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated","staff_id":"00000000-0000-0000-0000-0000000000a2","store_id":"00000000-0000-0000-0000-000000000001","staff_role":"staff"}', false);
update cash_counts set approved_by = '00000000-0000-0000-0000-0000000000a2', approved_at = now() where id = '00000000-0000-0000-0000-0000000000e1';
reset role;

-- 7. Manager CAN approve a cash count
set role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated","staff_id":"00000000-0000-0000-0000-0000000000a1","store_id":"00000000-0000-0000-0000-000000000001","staff_role":"manager"}', false);
update cash_counts set approved_by = '00000000-0000-0000-0000-0000000000a1', approved_at = now() where id = '00000000-0000-0000-0000-0000000000e1';
select approved_by is not null as test7_should_be_true from cash_counts where id = '00000000-0000-0000-0000-0000000000e1';
reset role;

-- 8. Attempting to mutate a monetary field directly is rejected (append-only, expect error)
set role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated","staff_id":"00000000-0000-0000-0000-0000000000a1","store_id":"00000000-0000-0000-0000-000000000001","staff_role":"manager"}', false);
update cash_counts set counted_cash = 9999 where id = '00000000-0000-0000-0000-0000000000e1';
reset role;

-- 9. A second current row for the same store+register+shift+date is rejected by the partial unique index (expect error)
set role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated","staff_id":"00000000-0000-0000-0000-0000000000a2","store_id":"00000000-0000-0000-0000-000000000001","staff_role":"staff"}', false);
insert into cash_counts (id, store_id, register, shift, count_date, denominations, counted_cash, staff_id)
  values ('00000000-0000-0000-0000-0000000000e3', '00000000-0000-0000-0000-000000000001', 'Front counter', 'open', '2026-08-04', '{"$50": 3}', 150, '00000000-0000-0000-0000-0000000000a2');
reset role;

-- 10. A recount (is_current flip on the old row + a new current row with recount_of_id) succeeds
set role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated","staff_id":"00000000-0000-0000-0000-0000000000a2","store_id":"00000000-0000-0000-0000-000000000001","staff_role":"staff"}', false);
update cash_counts set is_current = false where id = '00000000-0000-0000-0000-0000000000e1';
insert into cash_counts (id, store_id, register, shift, count_date, denominations, counted_cash, staff_id, recount_of_id, recount_reason)
  values ('00000000-0000-0000-0000-0000000000e4', '00000000-0000-0000-0000-000000000001', 'Front counter', 'open', '2026-08-04', '{"$50": 3}', 150, '00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000e1', 'Recounted, missed a note first time');
select count(*) as test10_should_be_one from cash_counts where is_current and store_id = '00000000-0000-0000-0000-000000000001' and register = 'Front counter' and shift = 'open' and count_date = '2026-08-04';
reset role;
