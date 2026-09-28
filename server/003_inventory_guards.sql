-- ============================================================
-- 003_inventory_guards.sql
-- Closes two gaps left by 001 and 002.
-- ============================================================

-- 1. Nothing stopped two buyers holding live orders on the same one-of-a-kind physical piece.
-- Physical orders are exactly the ones with a shipping address (the 002 trigger enforces that),
-- so this index covers physical only and leaves digital editions free to sell more than once.
-- A cancelled or refunded order frees the piece for the next buyer.
CREATE UNIQUE INDEX uniq_active_order_per_physical_artwork
  ON orders (artwork_id)
  WHERE shipping_address_id IS NOT NULL
    AND state NOT IN ('cancelled', 'refunded');

-- 2. 002 let a digital 'original' omit edition_size, which reads as unlimited. An original is an edition of one.
ALTER TABLE artworks
  ADD CONSTRAINT original_edition_is_one CHECK (
    edition_type IS DISTINCT FROM 'original' OR edition_size = 1
  );
