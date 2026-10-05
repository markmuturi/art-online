import type { PoolClient } from "pg";
import { alertAdmin, withTransaction } from "@/lib/db";
import { InvalidTransitionError, transitionOrder } from "@/lib/orders/transitions";
import { verifyPaystackSignature } from "@/lib/paystack";

export const runtime = "nodejs"; // needs node:crypto and pg, not the edge runtime

interface PaystackEvent {
  event: string;
  data: {
    id?: number;
    reference?: string;
    amount?: number;
    currency?: string;
    transfer_code?: string;
  };
}

const PAYOUT_PREFIX = "payout-";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export async function POST(req: Request): Promise<Response> {
  // The signature covers the exact bytes Paystack sent, so read the raw text before parsing.
  const raw = await req.text();
  if (!verifyPaystackSignature(raw, req.headers.get("x-paystack-signature"))) {
    return new Response("invalid signature", { status: 401 });
  }

  let evt: PaystackEvent;
  try {
    evt = JSON.parse(raw) as PaystackEvent;
  } catch {
    return new Response("bad json", { status: 400 });
  }

  const idPart = evt.data?.id ?? evt.data?.reference;
  if (!evt.event || idPart === undefined) {
    alertAdmin("Webhook without an event name or id, ignored", raw);
    return new Response("ok", { status: 200 });
  }
  const eventId = `${evt.event}:${idPart}`;

  try {
    // Dedup insert, handling and processed_at all live in ONE transaction. A crash rolls all of it back,
    // so Paystack's retry is processed fresh. A committed row therefore always means "fully handled".
    await withTransaction(async (client) => {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO webhook_events (provider, event_id, event_type, payload)
         VALUES ('paystack', $1, $2, $3)
         ON CONFLICT (provider, event_id) DO NOTHING
         RETURNING id`,
        [eventId, evt.event, raw],
      );
      const eventRow = inserted.rows[0];
      if (!eventRow) return; // duplicate delivery

      switch (evt.event) {
        case "charge.success":
          await handleChargeSuccess(client, evt);
          break;
        case "transfer.success":
        case "transfer.failed":
        case "transfer.reversed":
          await handleTransferEvent(client, evt);
          break;
        default:
          break; // events we don't act on are still recorded
      }

      await client.query(`UPDATE webhook_events SET processed_at = now() WHERE id = $1`, [eventRow.id]);
    });
  } catch (err) {
    console.error("Paystack webhook processing failed", eventId, err);
    return new Response("processing error", { status: 500 }); // non-200 makes Paystack retry
  }

  return new Response("ok", { status: 200 });
}

async function handleChargeSuccess(client: PoolClient, evt: PaystackEvent): Promise<void> {
  const reference = evt.data.reference;
  if (!reference) {
    alertAdmin("charge.success without a reference", evt);
    return;
  }

  const found = await client.query<{ order_id: string; amount_cents: number }>(
    `SELECT order_id, amount_cents FROM payments WHERE paystack_reference = $1 FOR UPDATE`,
    [reference],
  );
  const payment = found.rows[0];
  if (!payment) {
    alertAdmin("charge.success for an unknown reference", reference);
    return;
  }

  // Never trust that "success" means "paid in full". Check the amount and currency yourself.
  if (evt.data.amount !== payment.amount_cents || evt.data.currency !== "KES") {
    alertAdmin("charge.success amount or currency mismatch, order NOT advanced", { reference, data: evt.data });
    return;
  }

  await client.query(
    `UPDATE payments SET status = 'success', raw_webhook_payload = $2 WHERE paystack_reference = $1`,
    [reference, JSON.stringify(evt)],
  );

  try {
    const { fulfillmentType } = await transitionOrder(client, {
      orderId: payment.order_id,
      to: "paid_held",
      actorType: "system",
    });
    if (fulfillmentType === "digital") await deliverDigital(client, payment.order_id);
  } catch (err) {
    if (err instanceof InvalidTransitionError) {
      // Typical cause: the buyer paid after the 30 minute window cancelled the order. Money is real, so a human refunds it.
      alertAdmin("Payment received for an order that is no longer pending. Refund needed.", {
        orderId: payment.order_id,
        reason: err.message,
      });
      return;
    }
    throw err;
  }
}

async function deliverDigital(client: PoolClient, orderId: string): Promise<void> {
  const grant = await client.query(
    `INSERT INTO download_grants (order_id, digital_asset_id, expires_at)
     SELECT o.id, da.id, now() + interval '30 days'
       FROM orders o JOIN digital_assets da ON da.artwork_id = o.artwork_id
      WHERE o.id = $1`,
    [orderId],
  );
  if (grant.rowCount === 0) {
    alertAdmin("Digital order paid but the artwork has no digital asset. Left in paid_held.", { orderId });
    return;
  }
  await transitionOrder(client, {
    orderId,
    to: "delivered_confirmed",
    actorType: "system",
    note: "digital: instant delivery",
  });
}

async function handleTransferEvent(client: PoolClient, evt: PaystackEvent): Promise<void> {
  const reference = evt.data.reference ?? "";
  const orderId = reference.startsWith(PAYOUT_PREFIX) ? reference.slice(PAYOUT_PREFIX.length) : "";
  if (!UUID_RE.test(orderId)) {
    alertAdmin("Transfer event with an unrecognised reference", reference);
    return;
  }

  const outcome =
    evt.event === "transfer.success" ? "success" : evt.event === "transfer.failed" ? "failed" : "reversed";

  const updated = await client.query(
    `UPDATE payouts
        SET status = $2, paystack_transfer_code = COALESCE($3, paystack_transfer_code)
      WHERE order_id = $1`,
    [orderId, outcome, evt.data.transfer_code ?? null],
  );
  if (updated.rowCount === 0) {
    alertAdmin("Transfer event for an order with no payout row", { orderId, event: evt.event });
    return;
  }

  if (outcome !== "success") {
    // The order stays in delivered_confirmed and the release job skips it (a payout row exists). A human decides the retry.
    alertAdmin(`Payout ${outcome}. Do not retry blindly.`, { orderId });
    return;
  }

  try {
    await transitionOrder(client, {
      orderId,
      to: "released",
      actorType: "system",
      note: "Paystack transfer.success",
    });
  } catch (err) {
    if (err instanceof InvalidTransitionError) {
      alertAdmin("Payout succeeded but the order could not move to released. Check for a dispute.", {
        orderId,
        reason: err.message,
      });
      return;
    }
    throw err;
  }
}
