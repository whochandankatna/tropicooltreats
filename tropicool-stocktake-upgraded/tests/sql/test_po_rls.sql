-- RLS verification for purchase_orders/purchase_order_lines: manager-only
-- creation, store isolation, no-delete-once-sent line protection. Run
-- against a scratch local Postgres 16 with _local_auth_stub.sql and the
-- real migrations applied first -- never against a real database. \set
-- ON_ERROR_STOP off is deliberate: several statements below are EXPECTED
-- to error (that's the assertion), so the script must keep going and each
-- result should be read by eye.
\set ON_ERROR_STOP off
begin;

insert into stores (id, slug, name) values
  ('00000000-0000-0000-0000-000000000001', 'mooloolaba', 'Mooloolaba'),
  ('00000000-0000-0000-0000-000000000002', 'noosa', 'Noosa');

insert into staff (id, home_store_id, name, role, pin_hash) values
  ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000000001', 'Manager Moo', 'manager', 'x'),
  ('00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-000000000001', 'Staff Moo', 'staff', 'x'),
  ('00000000-0000-0000-0000-0000000000a3', '00000000-0000-0000-0000-000000000002', 'Manager Noosa', 'manager', 'x');

insert into item_categories (key, label, main_category) values ('sauces', 'Sauces', 'shelf');
insert into item_master (id, name, category_key, default_unit) values
  ('00000000-0000-0000-0000-0000000000b1', 'Choc Sauce', 'sauces', 'bottles');
insert into store_inventory (id, store_id, item_id, unit, current_stock, reorder_point) values
  ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000b1', 'bottles', 1, 3);

commit;

-- 1. Manager at their own store CAN create a draft order
set role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated","staff_id":"00000000-0000-0000-0000-0000000000a1","store_id":"00000000-0000-0000-0000-000000000001","staff_role":"manager"}', false);
insert into purchase_orders (id, store_id, supplier_name, created_by)
  values ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-000000000001', 'Test Supplier', '00000000-0000-0000-0000-0000000000a1');
select count(*) as test1_should_be_one from purchase_orders where id = '00000000-0000-0000-0000-0000000000d1';
reset role;

-- 2. Non-manager staff at the SAME store CANNOT create an order (expect error)
set role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated","staff_id":"00000000-0000-0000-0000-0000000000a2","store_id":"00000000-0000-0000-0000-000000000001","staff_role":"staff"}', false);
insert into purchase_orders (id, store_id, supplier_name, created_by)
  values ('00000000-0000-0000-0000-0000000000d2', '00000000-0000-0000-0000-000000000001', 'Test Supplier', '00000000-0000-0000-0000-0000000000a2');
reset role;

-- 3. Manager at a DIFFERENT store CANNOT create an order for store 1 (expect error)
set role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated","staff_id":"00000000-0000-0000-0000-0000000000a3","store_id":"00000000-0000-0000-0000-000000000002","staff_role":"manager"}', false);
insert into purchase_orders (id, store_id, supplier_name, created_by)
  values ('00000000-0000-0000-0000-0000000000d3', '00000000-0000-0000-0000-000000000001', 'Test Supplier', '00000000-0000-0000-0000-0000000000a3');
reset role;

-- 4. Noosa manager CANNOT see Mooloolaba's order (expect 0 rows)
set role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated","staff_id":"00000000-0000-0000-0000-0000000000a3","store_id":"00000000-0000-0000-0000-000000000002","staff_role":"manager"}', false);
select count(*) as should_be_zero from purchase_orders;
reset role;

-- 5. Mooloolaba manager CAN see their own order, add a line, and it appears (expect 1 row, 1 line)
set role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated","staff_id":"00000000-0000-0000-0000-0000000000a1","store_id":"00000000-0000-0000-0000-000000000001","staff_role":"manager"}', false);
select count(*) as should_be_one from purchase_orders;
insert into purchase_order_lines (purchase_order_id, store_inventory_id, item_name, unit, quantity_ordered)
  values ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000c1', 'Choc Sauce', 'bottles', 6);
select count(*) as should_be_one_line from purchase_order_lines;
reset role;

-- 6. Sending the order (status check) then verifying it can't be deleted (no delete policy on purchase_orders)
set role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated","staff_id":"00000000-0000-0000-0000-0000000000a1","store_id":"00000000-0000-0000-0000-000000000001","staff_role":"manager"}', false);
update purchase_orders set status = 'sent', sent_by = '00000000-0000-0000-0000-0000000000a1', sent_at = now() where id = '00000000-0000-0000-0000-0000000000d1';
select status from purchase_orders where id = '00000000-0000-0000-0000-0000000000d1';
delete from purchase_orders where id = '00000000-0000-0000-0000-0000000000d1';
reset role;

-- 7. Once sent, the line can no longer be deleted (draft-only delete policy) — expect 0 rows deleted
set role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated","staff_id":"00000000-0000-0000-0000-0000000000a1","store_id":"00000000-0000-0000-0000-000000000001","staff_role":"manager"}', false);
delete from purchase_order_lines where purchase_order_id = '00000000-0000-0000-0000-0000000000d1';
select count(*) as should_still_be_one_line from purchase_order_lines;
reset role;
