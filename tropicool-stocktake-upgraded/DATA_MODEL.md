# Data model — Phase 2

Status: **proposed, not run**. Files live in `supabase/migrations/0001`–`0004`.
Nothing here has touched the production database. See `AUDIT.md` §13 for the
approval this needs before it runs, and §11 for open questions this design
still depends on answers to.

## Why a new schema instead of altering the existing tables

The existing `tt_items` / `tt_entries` model conflates several things that
need to be separate to satisfy the brief's correctness requirements:

- **Item identity vs. per-store stock.** `tt_items` has no `store_id` at all
  — there's one flat list, which is why the original app is single-store.
  Item master (`item_master`) now holds what an item *is*; `store_inventory`
  holds what each store stocks it at, with its own thresholds and supplier.
- **A count vs. everything else that changes stock.** `tt_entries.usage` is
  *derived* from `opening - closing` at save time, which is what causes the
  "delivery looks like negative usage and gets zeroed" bug (AUDIT.md §4).
  `count_lines` now holds only what was physically counted; `stock_movements`
  holds deliveries/waste/transfers/prep/adjustments as their own typed
  events, and expected stock is computed from both rather than the count
  input silently absorbing everything.
- **The last count vs. history.** `tt_entries` upserts on `(item_id,
  entry_date)`, so a second count of the same item on the same day replaces
  the first with no trace. `count_lines` is append-only — every save is an
  `INSERT`; a partial unique index enforces exactly one `is_current` row per
  session/item, and recounts explicitly reference what they're correcting
  via `recount_of_id` plus a required `recount_reason`.
- **A single expiry date vs. batches.** `tt_items.expiry_date` can only ever
  represent one batch. `item_batches` allows several open batches per item
  per store, each with its own received/use-by date and remaining quantity,
  which is what makes FEFO guidance and "quantity affected by this alert"
  meaningful.

## Table summary

| Table | Purpose |
|---|---|
| `stores` | Physical locations (Mooloolaba, Noosa, Sunnybank, future). |
| `item_categories` | Replaces the hard-coded `CATEGORIES`/`MAIN_CATEGORIES` JS objects. |
| `item_master` | Store-agnostic item identity: name, category, default unit, pack conversion, critical flag, archive state. |
| `store_inventory` | Per-store stock: current level, thresholds (reorder/low/target/max), storage location, supplier link, lead time, safety stock, order pack size, unit cost. One row per (store, item). |
| `item_batches` | Batch-level expiry: quantity, received date, use-by date, supplier reference, status. |
| `suppliers` | Supplier contact, minimum order, delivery days, order cutoff time. |
| `staff` | Staff identity, role, **hashed** PIN, lockout state. Never selected directly by the client. |
| `staff_public` | The view the frontend actually queries — no PIN material, just `has_pin_set`. |
| `staff_store_access` | Extra store grants for staff who work across locations. |
| `stocktake_sessions` | One per store per Brisbane business date. Status lifecycle: draft → in_progress → submitted → approved (or reopened). Optimistic-concurrency `version` column. |
| `stocktake_session_progress` | View: derives completion % from count lines vs. active store inventory — never stored, can't drift. |
| `count_lines` | Append-only physical counts. `variance` is a generated column (`counted_qty - system_qty`). Recounts chain via `recount_of_id`. |
| `idempotency_keys` | Lets a retried submission after a dropped connection replay the cached result instead of double-submitting. |
| `stock_movements` | Deliveries, waste, transfers, preparation, adjustments — each typed, with a required reason for waste/adjustment. |
| `audit_log` | Append-only log of approvals, archives, role/PIN changes, written by triggers/Edge Functions, not by the client. |

## Migration path from the existing tables

Deliberately **not attempted yet** — the new tables above are additive only
and coexist with `tt_items`/`tt_entries`/etc. Moving real data into the new
model is a separate, later step that needs your explicit sign-off (rule 5)
because it reshapes live data rather than just adding structure next to it.
The rough shape it would take, for review when we get there:

1. One `stores` row for Mooloolaba (the only store the current data belongs
   to, per the hard-coded "Mooloolaba store" subtitle in the original app —
   confirm this before backfilling, per AUDIT.md §11.6).
2. `tt_items` → one `item_master` row + one `store_inventory` row per item,
   scoped to that Mooloolaba store row.
3. `tt_items.expiry_date` → a single `item_batches` row per item that has one
   set, as a starting point (not a full batch history, which doesn't exist
   in the old data).
4. `tt_staff` → `staff`, with `pin` re-entered (not migrated) as a hash via
   the new PIN-set flow — plaintext PINs should not be hashed-in-place and
   kept as "the same secret", they should be rotated as part of this move.
5. `tt_entries` history → **not** backfilled into `count_lines`/session
   history 1:1, because the old rows don't carry the concept of a session,
   an authenticated staff_id, or a system_qty snapshot distinct from the
   count itself. Proposal: keep `tt_entries` readable (read-only, for the
   old Usage History chart) and start `count_lines` fresh from cutover day,
   rather than fabricating session data that never existed. Open for your
   input — an alternative is a best-effort backfill that creates one
   "submitted+approved" session per historical `entry_date` with a single
   synthetic count line per item; flag if you'd rather have that.

## Open questions this design still has

1. **Adjustment sign convention** (`0004_stock_movements.sql`, `expected_stock()`):
   manual adjustments need a documented direction (a separate
   `adjustment_direction` column reading `'increase'`/`'decrease'` is
   probably cleaner than relying on a signed quantity, which the `quantity >
   0` check constraint currently rules out). Flagging rather than guessing —
   will finalise before this migration is proposed as ready to run.
2. **Multi-store staff**: is cross-store access ("`staff_store_access`")
   actually needed for Tropicool Treats today, or is every staff member
   single-store in practice? Affects whether that table is worth the extra
   RLS complexity now vs. added later.
3. **Historical backfill approach** — see point 5 above; needs your call.
4. Everything in `AUDIT.md` §11 (RLS policies today, what `verify-staff-pin`
   actually does, what writes `tt_staff_working`/`tt_roster`) still applies
   and is unresolved.

## What's intentionally not in this migration set

RLS policies (Phase 3), the rewritten `verify-staff-pin` / session auth
(Phase 3), and any application code wiring these tables up (Phase 4+) — kept
separate so each phase is reviewable on its own, per your requested
checkpoint pacing.
