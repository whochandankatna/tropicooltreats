-- ============================================================================
-- PROPOSED MIGRATION — NOT EXECUTED. For review only.
-- 0004: Stock movements — separates physical counts (count_lines) from
-- everything that changes stock between counts, so a delivery is never
-- misread as "negative usage" and clamped to zero (AUDIT.md §4).
-- ============================================================================

create table if not exists stock_movements (
  id                 uuid primary key default gen_random_uuid(),
  store_inventory_id uuid not null references store_inventory(id),
  movement_type      text not null check (movement_type in
                        ('delivery','waste','transfer_in','transfer_out','preparation','adjustment')),
  quantity           numeric not null check (quantity > 0),   -- always positive; direction is movement_type
  unit               text not null,
  reason             text,                                     -- required for waste/adjustment, see check below
  reference          text,                                     -- delivery docket #, transfer doc #, etc.
  related_store_id   uuid references stores(id),                -- the other side of a transfer
  batch_id           uuid references item_batches(id),           -- for FEFO-aware waste/usage
  session_id         uuid references stocktake_sessions(id),      -- movements can be logged outside a session too
  staff_id           uuid not null references staff(id),
  occurred_at        timestamptz not null default now(),
  created_at         timestamptz not null default now(),
  check (movement_type not in ('waste','adjustment') or reason is not null)
);
create index if not exists stock_movements_inventory_idx on stock_movements(store_inventory_id, occurred_at desc);
create index if not exists stock_movements_session_idx on stock_movements(session_id);
alter table stock_movements enable row level security;

comment on table stock_movements is
  'Every non-count change to stock: deliveries, waste, transfers, prep/production, '
  'manual adjustments. A delivery is recorded here as movement_type=''delivery'', '
  'not inferred from a count going up — so counted stock going up between two '
  'counts is either explained by a movement or shows up as a real, positive '
  'variance to review, never silently zeroed.';

-- ---- Expected stock, derived (never stored/duplicated) -------------------------
-- expected = opening + received + transfers_in - transfers_out - waste - recorded_usage
-- "recorded_usage" here means production/preparation consumption logged as a
-- movement, not the old model's derived-from-count usage. `opening` is the
-- store_inventory.current_stock as it stood at the start of the window, i.e.
-- the counted_qty from the previous session's current count line for this
-- item (or store_inventory.current_stock if there is none yet).
create or replace function expected_stock(
  p_store_inventory_id uuid,
  p_since timestamptz,
  p_until timestamptz,
  p_opening numeric
) returns numeric as $$
  select p_opening
    + coalesce(sum(quantity) filter (where movement_type = 'delivery'), 0)
    + coalesce(sum(quantity) filter (where movement_type = 'transfer_in'), 0)
    - coalesce(sum(quantity) filter (where movement_type = 'transfer_out'), 0)
    - coalesce(sum(quantity) filter (where movement_type = 'waste'), 0)
    - coalesce(sum(quantity) filter (where movement_type = 'preparation'), 0)
    + coalesce(sum(case when movement_type = 'adjustment' then quantity else 0 end), 0)
      -- NOTE: adjustment direction (+/-) needs a signed convention — see
      -- DATA_MODEL.md "Open question: adjustment sign convention" before
      -- this migration is finalised. Sketched here as additive; likely
      -- needs an `adjustment_direction` column instead of relying on sign.
  from stock_movements
  where store_inventory_id = p_store_inventory_id
    and occurred_at >= p_since
    and occurred_at < p_until;
$$ language sql stable;

comment on function expected_stock is
  'variance = counted_qty - expected_stock(...). See count_lines.variance '
  '(counted - system_qty) for the count-time snapshot; this function is for '
  'reports that need to recompute expected stock for an arbitrary window.';
