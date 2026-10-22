// The single definition of "can a buyer purchase this right now?".
//
// It is derived from data that already has to be correct, rather than copied into the
// artworks.status column. A physical piece is unavailable while any order for it is in a live
// state; a digital piece is unavailable once every edition is spoken for. When an unpaid order
// expires or a payment is refunded, the piece becomes available again with no extra bookkeeping,
// because nothing else was written that could be left out of sync.
//
// Use it inside any query that aliases the artworks table as "a".
//
// The shipping_address_id IS NOT NULL line looks redundant (physical orders are the ones with an
// address) but it mirrors the WHERE clause of the unique index uniq_active_order_per_physical_artwork
// from migration 003, which lets Postgres answer this lookup from that index.
//
// COALESCE makes a malformed row (a digital piece with no edition_size) read as unavailable
// instead of NULL, so it fails closed.
export const IS_AVAILABLE_SQL = `COALESCE(
  a.status = 'listed' AND (
    CASE
      WHEN a.fulfillment_type = 'digital' THEN a.editions_sold < a.edition_size
      ELSE NOT EXISTS (
        SELECT 1 FROM orders o
         WHERE o.artwork_id = a.id
           AND o.shipping_address_id IS NOT NULL
           AND o.state NOT IN ('cancelled', 'refunded')
      )
    END
  ),
  false
)`;