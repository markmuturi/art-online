import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";

export class CheckoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CheckoutError";
  }
}

export interface CreateOrderArgs {
  buyerId: string;
  artworkId: string;
  shippingAddressId: string | null; // required for physical, must be null for digital
}

export interface CreatedOrder {
  orderId: string;
  reference: string; // Paystack transaction reference
  amountCents: number;
}

function platformFeeCents(amountCents: number): number {
  const bps = Number(process.env.PLATFORM_FEE_BPS);
  if (!Number.isInteger(bps) || bps < 0 || bps > 10_000) {
    throw new Error("PLATFORM_FEE_BPS must be an integer between 0 and 10000 (250 = 2.5%)");
  }
  return Math.round((amountCents * bps) / 10_000);
}

// Call inside withTransaction. Reserves the piece, then writes the order and its pending payment.
export async function createOrder(client: PoolClient, args: CreateOrderArgs): Promise<CreatedOrder> {
  const art = await client.query<{
    artist_id: string;
    price_cents: number;
    currency: string;
    status: string;
    fulfillment_type: "physical" | "digital";
  }>(
    `SELECT artist_id, price_cents, currency, status, fulfillment_type
       FROM artworks WHERE id = $1 FOR UPDATE`,
    [args.artworkId],
  );
  const artwork = art.rows[0];
  if (!artwork || artwork.status !== "listed") throw new CheckoutError("This artwork is not available.");
  if (artwork.artist_id === args.buyerId) throw new CheckoutError("You cannot buy your own artwork.");
  if (artwork.currency !== "KES") throw new CheckoutError("Only KES listings are supported at launch.");

  if (artwork.fulfillment_type === "physical") {
    if (!args.shippingAddressId) throw new CheckoutError("A shipping address is required.");
    // Ownership check. Without it, a buyer could attach someone else's address by guessing an id.
    const addr = await client.query(`SELECT 1 FROM addresses WHERE id = $1 AND user_id = $2`, [
      args.shippingAddressId,
      args.buyerId,
    ]);
    if (addr.rowCount === 0) throw new CheckoutError("Invalid shipping address.");
  } else {
    if (args.shippingAddressId) throw new CheckoutError("Digital orders do not take a shipping address.");
    // Reserve an edition atomically. A NULL edition_size fails closed (sold out), not open.
    const reserved = await client.query(
      `UPDATE artworks SET editions_sold = editions_sold + 1
        WHERE id = $1 AND editions_sold < edition_size`,
      [args.artworkId],
    );
    if (reserved.rowCount === 0) throw new CheckoutError("This edition is sold out.");
  }

  const orderId = randomUUID();
  const reference = `ord-${orderId}`;
  const fee = platformFeeCents(artwork.price_cents);

  try {
    await client.query(
      `INSERT INTO orders (id, buyer_id, artwork_id, artist_id, shipping_address_id,
                           amount_cents, platform_fee_cents, artist_payout_cents, currency)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'KES')`,
      [
        orderId,
        args.buyerId,
        args.artworkId,
        artwork.artist_id,
        args.shippingAddressId,
        artwork.price_cents,
        fee,
        artwork.price_cents - fee,
      ],
    );
  } catch (err) {
    // 23505 = unique_violation from uniq_active_order_per_physical_artwork (migration 003)
    if ((err as { code?: string }).code === "23505") {
      throw new CheckoutError("Someone else is already buying this piece.");
    }
    throw err;
  }

  await client.query(`INSERT INTO payments (order_id, paystack_reference, amount_cents) VALUES ($1, $2, $3)`, [
    orderId,
    reference,
    artwork.price_cents,
  ]);
  await client.query(
    `INSERT INTO order_events (order_id, from_state, to_state, actor_type, actor_id)
     VALUES ($1, NULL, 'pending_payment', 'buyer', $2)`,
    [orderId, args.buyerId],
  );

  return { orderId, reference, amountCents: artwork.price_cents };
}
