-- ============================================================================
-- PROPOSED MIGRATION — NOT EXECUTED. For review only.
-- 0007: Purchase orders — turns the "needs ordering" list into a trackable
-- draft -> sent -> received workflow (AUDIT.md §12 Priority 7), instead of
-- the original app's read-only reorder panel with no record of what was
-- actually ordered or when it arrived.
--
-- Scope note: this app never contacts a supplier itself (no emailing,
-- no API calls out) — "sent" here means a human placed the order by phone/
-- website/app and is telling this system it's been done, matching working
-- rule 6 (no external actions without approval). "Received" records what
-- actually arrived, which is what closes the loop with stock levels.
-- ============================================================================

create table if not exists purchase_orders (
  id            uuid primary key default gen_random_uuid(),
  store_id      uuid not null references stores(id),
  -- supplier_id is nullable on purpose: store_inventory currently stores a
  -- free-text supplier_name/supplier_url per item rather than linking to
  -- this already-scaffolded suppliers table (see DATA_MODEL.md — flagged
  -- there as a normalisation worth doing once supplier records are a real
  -- decision, not assumed here). supplier_name is captured as a snapshot
  -- either way, so a later rename doesn't rewrite this order's history.
  supplier_id   uuid references suppliers(id),
  supplier_name text not null,
  status        text not null default 'draft'
                  check (status in ('draft','sent','received','cancelled')),
  notes         text,
  created_by    uuid not null references staff(id),
  created_at    timestamptz not null default now(),
  sent_by       uuid references staff(id),
  sent_at       timestamptz,
  received_by   uuid references staff(id),
  received_at   timestamptz,
  cancelled_by  uuid references staff(id),
  cancelled_at  timestamptz,
  cancel_reason text,
  check (status <> 'sent' or sent_at is not null),
  check (status <> 'received' or received_at is not null),
  check (status <> 'cancelled' or cancelled_at is not null)
);
create index if not exists purchase_orders_store_idx on purchase_orders(store_id, created_at desc);
alter table purchase_orders enable row level security;

comment on table purchase_orders is
  'One row per order placed with a supplier. Status is a one-way progression '
  'draft -> sent -> received, or draft/sent -> cancelled. Receiving updates '
  'stock via stock_movements (movement_type=''delivery''), the same path a '
  'manually logged delivery uses — a purchase order is not a second source '
  'of truth for stock, just the paper trail for why a delivery happened.';

create table if not exists purchase_order_lines (
  id                  uuid primary key default gen_random_uuid(),
  purchase_order_id   uuid not null references purchase_orders(id) on delete cascade,
  store_inventory_id  uuid not null references store_inventory(id),
  item_name           text not null,   -- snapshot at order time, same reasoning as supplier_name above
  unit                text not null,
  quantity_ordered    numeric not null check (quantity_ordered > 0),
  quantity_received   numeric check (quantity_received is null or quantity_received >= 0),
  unit_cost_at_order  numeric,
  created_at          timestamptz not null default now()
);
create index if not exists purchase_order_lines_order_idx on purchase_order_lines(purchase_order_id);
alter table purchase_order_lines enable row level security;

-- ---- RLS policies -----------------------------------------------------------------
-- Mirrors store_inventory's policy shape (0005_rls_policies.sql): ordering
-- has cost/commitment implications, same as editing stock thresholds, so
-- it's manager-gated the same way rather than open to any staff the way
-- item_batches (logging a delivery/waste on the day) is.
create policy purchase_orders_select on purchase_orders for select to authenticated
  using (has_store_access(store_id));
create policy purchase_orders_insert on purchase_orders for insert to authenticated
  with check (is_manager() and has_store_access(store_id) and created_by = current_staff_id());
create policy purchase_orders_update on purchase_orders for update to authenticated
  using (is_manager() and has_store_access(store_id))
  with check (is_manager() and has_store_access(store_id));
-- No delete policy — cancel instead, same convention as archiving items.

create policy purchase_order_lines_select on purchase_order_lines for select to authenticated
  using (exists (
    select 1 from purchase_orders po
    where po.id = purchase_order_lines.purchase_order_id and has_store_access(po.store_id)
  ));
create policy purchase_order_lines_insert on purchase_order_lines for insert to authenticated
  with check (is_manager() and exists (
    select 1 from purchase_orders po
    where po.id = purchase_order_lines.purchase_order_id and has_store_access(po.store_id)
  ));
create policy purchase_order_lines_update on purchase_order_lines for update to authenticated
  using (is_manager() and exists (
    select 1 from purchase_orders po
    where po.id = purchase_order_lines.purchase_order_id and has_store_access(po.store_id)
  ))
  with check (is_manager() and exists (
    select 1 from purchase_orders po
    where po.id = purchase_order_lines.purchase_order_id and has_store_access(po.store_id)
  ));
-- Lines can be removed from a still-draft order (adjusting before sending);
-- once sent/received/cancelled the order is a historical record.
create policy purchase_order_lines_delete on purchase_order_lines for delete to authenticated
  using (is_manager() and exists (
    select 1 from purchase_orders po
    where po.id = purchase_order_lines.purchase_order_id
      and has_store_access(po.store_id) and po.status = 'draft'
  ));

grant select, insert, update on purchase_orders, purchase_order_lines to authenticated;
grant delete on purchase_order_lines to authenticated;
