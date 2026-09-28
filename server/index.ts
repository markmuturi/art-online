import { alertAdmin, pool, withTransaction } from "../lib/db";
import { InvalidTransitionError, transitionOrder } from "../lib/orders/transitions";
import { initiateTransfer } from "../lib/paystack";

// Run as its own always-on Node process: npx tsx worker/index.ts
// It cannot live inside serverless route handlers, nothing there stays running to fire timers.

async function releaseJob(): Promise<void> {
  const { rows } = await pool.query<{ id: string }>(
    `SELECT o.id FROM orders o
      WHERE o.state = 'delivered_confirmed'
        AND o.release_eligible_at <= now()
        AND NOT EXISTS (SELECT 1 FROM payouts p WHERE p.order_id = o.id)
      ORDER BY o.release_eligible_at
      LIMIT 50`,
  );
  for (const { id } of rows) {
    try {
      await releaseOne(id);
    } catch (err) {
      alertAdmin(`Release failed for order ${id}`, err);
    }
  }
}

async function releaseOne(orderId: string): Promise<void> {
  // Step 1: claim the payout inside a short transaction. The payouts.order_id UNIQUE constraint
  // guarantees only one worker ever claims a given order.
  const claim = await withTransaction(async (client) => {
    const { rows } = await client.query<{
      artist_id: string;
      artist_payout_cents: number;
      recipient: string | null;
    }>(
      `SELECT o.artist_id, o.artist_payout_cents, ap.paystack_recipient_code AS recipient
         FROM orders o JOIN artist_profiles ap ON ap.user_id = o.artist_id
        WHERE o.id = $1 AND o.state = 'delivered_confirmed' AND o.release_eligible_at <= now()
          FOR UPDATE OF o`,
      [orderId],
    );
    const row = rows[0];
    if (!row) return null;
    if (!row.recipient) {
      alertAdmin("Order is due for payout but the artist has no Paystack recipient code", { orderId });
      return null;
    }
    const inserted = await client.query(
      `INSERT INTO payouts (order_id, artist_id, amount_cents) VALUES ($1, $2, $3)
       ON CONFLICT (order_id) DO NOTHING`,
      [orderId, row.artist_id, row.artist_payout_cents],
    );
    if (inserted.rowCount === 0) return null;
    return { recipient: row.recipient, amountCents: row.artist_payout_cents };
  });
  if (!claim) return;

  // Step 2: the network call happens outside any transaction, so no database lock is held while Paystack thinks.
  try {
    const transfer = await initiateTransfer({
      amountCents: claim.amountCents,
      recipientCode: claim.recipient,
      reference: `payout-${orderId}`, // 43 chars, deterministic: a retry cannot pay twice
      reason: "Artwork sale payout",
    });
    await pool.query(`UPDATE payouts SET paystack_transfer_code = $2 WHERE order_id = $1`, [
      orderId,
      transfer.transferCode,
    ]);
    // The order moves to released when the transfer.success webhook arrives, not here.
  } catch (err) {
    // Ambiguous outcome: Paystack may or may not have accepted it. The payout row stays 'pending' so this job never
    // retries. Check Paystack for reference payout-<orderId> before doing anything by hand.
    alertAdmin(`Transfer request for order ${orderId} errored or timed out. Verify with Paystack before retrying.`, err);
  }
}

async function expireUnpaidJob(): Promise<void> {
  const { rows } = await pool.query<{ id: string }>(
    `SELECT id FROM orders
      WHERE state = 'pending_payment' AND created_at < now() - interval '30 minutes'
      LIMIT 100`,
  );
  for (const { id } of rows) {
    try {
      await withTransaction((client) =>
        transitionOrder(client, { orderId: id, to: "cancelled", actorType: "system", note: "payment window expired" }),
      );
    } catch (err) {
      // InvalidTransitionError means the payment landed in the meantime. That is fine.
      if (!(err instanceof InvalidTransitionError)) alertAdmin(`Expiring order ${id} failed`, err);
    }
  }
}

async function autoConfirmJob(): Promise<void> {
  const { rows } = await pool.query<{ id: string }>(
    `SELECT id FROM orders
      WHERE state = 'shipped' AND shipped_at < now() - interval '10 days'
      LIMIT 100`,
  );
  for (const { id } of rows) {
    try {
      await withTransaction((client) =>
        transitionOrder(client, {
          orderId: id,
          to: "delivered_confirmed",
          actorType: "system",
          note: "auto-confirmed after 10 days with no dispute",
        }),
      );
    } catch (err) {
      if (!(err instanceof InvalidTransitionError)) alertAdmin(`Auto-confirm failed for order ${id}`, err);
    }
  }
}

async function slaJob(): Promise<void> {
  const { rows } = await pool.query<{ id: string }>(
    `SELECT id FROM orders WHERE state = 'paid_held' AND created_at < now() - interval '7 days'`,
  );
  for (const { id } of rows) {
    alertAdmin("Paid order has waited over 7 days without moving. Review for refund.", { orderId: id });
  }
}

function schedule(name: string, everyMs: number, job: () => Promise<void>): void {
  let running = false;
  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      await job();
    } catch (err) {
      alertAdmin(`Job ${name} crashed`, err);
    } finally {
      running = false;
    }
  };
  void tick();
  setInterval(() => void tick(), everyMs);
}

schedule("release", 5 * 60_000, releaseJob);
schedule("expire-unpaid", 5 * 60_000, expireUnpaidJob);
schedule("auto-confirm", 60 * 60_000, autoConfirmJob);
schedule("sla", 24 * 60 * 60_000, slaJob);
console.log("Worker started");
