-- ============================================================================
-- PROPOSED MIGRATION — NOT EXECUTED. For review only.
-- 0001: Stores, item master, store inventory, suppliers
--
-- This is additive-only: it creates new tables alongside the existing
-- tt_items / tt_entries / etc, which are left untouched so the current
-- production app keeps working unmodified until a deliberate, separately
-- reviewed cutover step. See ../../AUDIT.md §11-13 for the open questions
-- and required approvals before this (or any migration in this folder) runs.
-- ============================================================================

-- ---- Stores -----------------------------------------------------------------
-- One row per physical store. Every store-scoped table below carries store_id
-- so RLS policies (added in a later, separately reviewed migration) can
-- enforce "staff only see their own store's data" without relying on any
-- client-side check.
create table if not exists stores (
  id          uuid primary key default gen_random_uuid(),
  slug        text not null unique,          -- 'mooloolaba' | 'noosa' | 'sunnybank' | ...
  name        text not null,
  timezone    text not null default 'Australia/Brisbane',
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);
comment on table stores is 'Physical Tropicool Treats locations. All store-scoped tables reference this.';

alter table stores enable row level security;
-- No policies yet — RLS enabled with zero policies means "deny all" by
-- default until Phase 3 (auth/RLS) adds the real policies. This is
-- deliberate: a table should never sit unprotected between migrations.

-- ---- Suppliers ----------------------------------------------------------------
create table if not exists suppliers (
  id                 uuid primary key default gen_random_uuid(),
  name               text not null,
  url                text,
  contact_email      text,
  contact_phone      text,
  min_order_amount   numeric,
  delivery_days      text[],        -- e.g. {'mon','thu'}
  order_cutoff_time  time,          -- local (Brisbane) cutoff for same-day/next-day dispatch
  active             boolean not null default true,
  created_at         timestamptz not null default now()
);
alter table suppliers enable row level security;

-- ---- Item categories ----------------------------------------------------------
-- Replaces the hard-coded CATEGORIES/MAIN_CATEGORIES JS objects and the
-- tt_subcategories mapping table with real rows, so new categories don't
-- require a code change.
create table if not exists item_categories (
  key            text primary key,             -- e.g. 'sauces', 'frozenfruit'
  label          text not null,
  main_category  text not null check (main_category in ('fridge','freezer','shelf')),
  sort_order     integer not null default 0
);

-- ---- Item master (store-agnostic identity) -------------------------------------
-- What the item *is*. Store-specific stock levels, thresholds, and supplier
-- links live in store_inventory below, not here — the same "Waffle Cones"
-- item can be stocked differently (or not at all) at each store.
create table if not exists item_master (
  id                 uuid primary key default gen_random_uuid(),
  name               text not null,
  category_key       text references item_categories(key),
  default_unit       text not null default 'units',
  supplier_pack_unit text,                      -- e.g. 'box of 24'
  pack_conversion    numeric,                    -- units per supplier pack, for order rounding
  critical_item      boolean not null default false,
  archived           boolean not null default false,
  archived_at        timestamptz,
  archived_by        uuid,                        -- fk staff(id), added once staff table exists (0004)
  archived_reason    text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
alter table item_master enable row level security;

-- ---- Store inventory (per-store stock, thresholds, ordering config) -----------
create table if not exists store_inventory (
  id                    uuid primary key default gen_random_uuid(),
  store_id              uuid not null references stores(id),
  item_id               uuid not null references item_master(id),
  storage_area          text check (storage_area in ('fridge','freezer','shelf')),
  storage_location      text,                      -- e.g. 'walk-in, top shelf'
  unit                  text not null,             -- actual counting unit at this store
  current_stock         numeric not null default 0,
  reorder_point         numeric not null default 0,   -- "par"
  low_warning_at        numeric,                        -- explicit; no longer auto-derived as par*1.4 by a UI constant
  target_stock          numeric,
  max_stock             numeric,
  lead_time_days         integer,
  safety_stock_days      integer,
  order_pack_size        numeric,
  supplier_id             uuid references suppliers(id),
  supplier_item_code      text,
  supplier_url            text,
  unit_cost               numeric,
  important                boolean not null default false,
  active                   boolean not null default true,   -- store carries this item or not
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  unique (store_id, item_id),
  check (max_stock is null or reorder_point is null or max_stock > reorder_point)
);
create index if not exists store_inventory_store_idx on store_inventory(store_id);
alter table store_inventory enable row level security;

-- ---- Item batches (batch-level expiry, replaces single tt_items.expiry_date) ---
create table if not exists item_batches (
  id                    uuid primary key default gen_random_uuid(),
  store_inventory_id    uuid not null references store_inventory(id),
  quantity_received     numeric not null,
  quantity_remaining    numeric not null,
  received_date         date not null,
  use_by_date            date,
  supplier_reference      text,          -- delivery docket / invoice number
  storage_location         text,
  status                    text not null default 'active'
                              check (status in ('active','depleted','expired','wasted')),
  created_at                timestamptz not null default now()
);
create index if not exists item_batches_store_inventory_idx on item_batches(store_inventory_id);
create index if not exists item_batches_use_by_idx on item_batches(use_by_date) where status = 'active';
alter table item_batches enable row level security;

comment on table item_batches is
  'FEFO expiry tracking. A store_inventory row can have many open batches; '
  'alerts and "quantity affected" come from summing active batches by use_by_date, '
  'not from a single expiry_date on the item.';
