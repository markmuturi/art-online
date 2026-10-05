import { createHmac } from "node:crypto";
import { requireAdminUrl, resetDatabase } from "../scripts/db";

process.env.DATABASE_URL = await resetDatabase(requireAdminUrl(), "art_test_flow");
process.env.PAYSTACK_SECRET_KEY = "sk_test_local";
process.env.PLATFORM_FEE_BPS = "1000";

const transferCalls: Array<Record<string, unknown>> = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  if (String(input).includes("api.paystack.co/transfer")) {
    transferCalls.push(JSON.parse(String(init?.body)));
    return new Response(
      JSON.stringify({ status: true, message: "ok", data: { transfer_code: "TRF_test123", status: "pending" } }),
      { status: 200 },
    );
  }
  return realFetch(input, init);
}) as typeof fetch;

let failures = 0;
const check = (name: string, ok: boolean, extra?: unknown): void => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || extra === undefined ? "" : "  -> " + JSON.stringify(extra)}`);
};

const { pool, withTransaction } = await import("../lib/db");
const { createOrder, CheckoutError } = await import("../lib/orders/create");
const { transitionOrder, InvalidTransitionError } = await import("../lib/orders/transitions");
const { POST } = await import("../app/api/webhooks/paystack/route");

const one = async <T = Record<string, any>>(sql: string, p: unknown[] = []): Promise<T> => (await pool.query(sql, p)).rows[0] as T;

const webhook = async (payload: unknown, sign = true): Promise<number> => {
  const body = JSON.stringify(payload);
  const sig = sign ? createHmac("sha512", "sk_test_local").update(body).digest("hex") : "deadbeef";
  const res = await POST(new Request("http://x/api/webhooks/paystack", { method: "POST", body, headers: { "x-paystack-signature": sig } }));
  return res.status;
};
const stateOf = async (id: string): Promise<string> => (await one<{ state: string }>(`SELECT state FROM orders WHERE id=$1`, [id])).state;

// ---- seed
const buyer1 = (await one<{ id: string }>(`INSERT INTO users (email, full_name) VALUES ('b1@x.ke','Buyer One') RETURNING id`)).id;
const buyer2 = (await one<{ id: string }>(`INSERT INTO users (email, full_name) VALUES ('b2@x.ke','Buyer Two') RETURNING id`)).id;
const artist = (await one<{ id: string }>(`INSERT INTO users (email, full_name, role) VALUES ('a@x.ke','Artist','artist') RETURNING id`)).id;
await pool.query(`INSERT INTO artist_profiles (user_id, display_name, paystack_recipient_code, payout_channel) VALUES ($1,'The Artist','RCP_test','mpesa')`, [artist]);
const genre = (await one<{ id: number }>(`INSERT INTO genres (name, slug) VALUES ('Painting','painting') RETURNING id`)).id;
const addr1 = (await one<{ id: string }>(`INSERT INTO addresses (user_id, recipient_name, line1, city, phone) VALUES ($1,'B1','1 Rd','Nairobi','0700') RETURNING id`, [buyer1])).id;
const addr2 = (await one<{ id: string }>(`INSERT INTO addresses (user_id, recipient_name, line1, city, phone) VALUES ($1,'B2','2 Rd','Nairobi','0711') RETURNING id`, [buyer2])).id;
const mkPhys = async (t: string): Promise<string> =>
  (await one<{ id: string }>(`INSERT INTO artworks (artist_id,title,genre_id,price_cents,status,fulfillment_type) VALUES ($1,$2,$3,500000,'listed','physical') RETURNING id`, [artist, t, genre])).id;
const phys = await mkPhys("Sunset");
const phys2 = await mkPhys("Dusk");
const dig = (await one<{ id: string }>(`INSERT INTO artworks (artist_id,title,genre_id,price_cents,status,fulfillment_type,edition_type,edition_size) VALUES ($1,'Pixel Sunset',$2,200000,'listed','digital','original',1) RETURNING id`, [artist, genre])).id;
await pool.query(`INSERT INTO digital_assets (artwork_id, storage_key, file_type, file_size_bytes) VALUES ($1,'private/x.png','image/png',1234)`, [dig]);

// ---- checkout guards
const o1 = await withTransaction((c) => createOrder(c, { buyerId: buyer1, artworkId: phys, shippingAddressId: addr1 }));
const row1 = await one(`SELECT platform_fee_cents f, artist_payout_cents p FROM orders WHERE id=$1`, [o1.orderId]);
check("fee 10% and payout math", row1.f === 50000 && row1.p === 450000, row1);
check("second buyer cannot take a reserved physical piece",
  await withTransaction((c) => createOrder(c, { buyerId: buyer2, artworkId: phys, shippingAddressId: addr2 })).then(() => false, (e) => e instanceof CheckoutError));
check("cannot attach another user's address",
  await withTransaction((c) => createOrder(c, { buyerId: buyer2, artworkId: phys2, shippingAddressId: addr1 })).then(() => false, (e) => e instanceof CheckoutError));
check("artist cannot buy own work",
  await withTransaction((c) => createOrder(c, { buyerId: artist, artworkId: phys2, shippingAddressId: addr1 })).then(() => false, (e) => e instanceof CheckoutError));

// ---- webhooks
const chargeEvt = (ref: string, amount: number, id = 111) => ({ event: "charge.success", data: { id, reference: ref, amount, currency: "KES" } });
check("bad signature rejected with 401", (await webhook(chargeEvt(o1.reference, 500000), false)) === 401);
check("wrong amount returns 200 but does not advance", (await webhook(chargeEvt(o1.reference, 100, 110))) === 200 && (await stateOf(o1.orderId)) === "pending_payment");
check("correct charge.success -> paid_held", (await webhook(chargeEvt(o1.reference, 500000))) === 200 && (await stateOf(o1.orderId)) === "paid_held");
await webhook(chargeEvt(o1.reference, 500000));
const dupe = await one(`SELECT count(*)::int n FROM webhook_events WHERE event_id='charge.success:111'`);
const ev = await one(`SELECT count(*)::int n FROM order_events WHERE order_id=$1 AND to_state='paid_held'`, [o1.orderId]);
check("replayed webhook is deduped", dupe.n === 1 && ev.n === 1, { dupe, ev });

// ---- state machine
const bad = (fn: () => Promise<unknown>) => fn().then(() => false, (e) => e instanceof InvalidTransitionError);
check("buyer cannot mark shipped", await bad(() => withTransaction((c) => transitionOrder(c, { orderId: o1.orderId, to: "shipped", actorType: "buyer", trackingNumber: "T1" }))));
check("shipping requires a tracking number", await bad(() => withTransaction((c) => transitionOrder(c, { orderId: o1.orderId, to: "shipped", actorType: "artist" }))));
await withTransaction((c) => transitionOrder(c, { orderId: o1.orderId, to: "shipped", actorType: "artist", trackingNumber: "T1" }));
await withTransaction((c) => transitionOrder(c, { orderId: o1.orderId, to: "delivered_confirmed", actorType: "buyer" }));
const win = await one(`SELECT extract(epoch FROM (release_eligible_at - now()))/3600 h FROM orders WHERE id=$1`, [o1.orderId]);
check("physical release window is about 72h", Number(win.h) > 71 && Number(win.h) < 73, win);
check("released cannot be reached from paid_held-skipping paths", await bad(() => withTransaction((c) => transitionOrder(c, { orderId: o1.orderId, to: "shipped", actorType: "artist", trackingNumber: "T2" }))));
await pool.query(`UPDATE orders SET release_eligible_at = now() - interval '1 minute' WHERE id=$1`, [o1.orderId]);

// ---- digital
const d1 = await withTransaction((c) => createOrder(c, { buyerId: buyer1, artworkId: dig, shippingAddressId: null }));
check("digital edition reserved", (await one(`SELECT editions_sold s FROM artworks WHERE id=$1`, [dig])).s === 1);
check("digital sold out for second buyer",
  await withTransaction((c) => createOrder(c, { buyerId: buyer2, artworkId: dig, shippingAddressId: null })).then(() => false, (e) => e instanceof CheckoutError));
await webhook(chargeEvt(d1.reference, 200000, 222));
const grants = await one(`SELECT count(*)::int n FROM download_grants WHERE order_id=$1`, [d1.orderId]);
const dwin = await one(`SELECT state, extract(epoch FROM (release_eligible_at - now()))/3600 h FROM orders WHERE id=$1`, [d1.orderId]);
check("digital: instant delivery, grant created, 48h window", dwin.state === "delivered_confirmed" && grants.n === 1 && Number(dwin.h) > 47 && Number(dwin.h) < 49, { dwin, grants });

// ---- expiry setup: unpaid order older than 30 minutes
const stale = await withTransaction((c) => createOrder(c, { buyerId: buyer1, artworkId: phys2, shippingAddressId: addr1 }));
await pool.query(`UPDATE orders SET created_at = now() - interval '31 minutes' WHERE id=$1`, [stale.orderId]);

// ---- run the worker once
await import("../worker/index");
await new Promise((r) => setTimeout(r, 3000));

const payout = await one(`SELECT status, paystack_transfer_code c, amount_cents a FROM payouts WHERE order_id=$1`, [o1.orderId]);
check("release job created exactly one Paystack transfer with the right amount and reference",
  transferCalls.length === 1 && transferCalls[0].amount === 450000 && transferCalls[0].reference === `payout-${o1.orderId}` && transferCalls[0].recipient === "RCP_test", transferCalls);
check("payout row pending with transfer code; order NOT yet released", payout.status === "pending" && payout.c === "TRF_test123" && (await stateOf(o1.orderId)) === "delivered_confirmed", payout);
check("digital order not released early", (await stateOf(d1.orderId)) === "delivered_confirmed" && !(await one(`SELECT 1 x FROM payouts WHERE order_id=$1`, [d1.orderId])));
check("expiry job cancelled the unpaid order", (await stateOf(stale.orderId)) === "cancelled");
const again = await withTransaction((c) => createOrder(c, { buyerId: buyer2, artworkId: phys2, shippingAddressId: addr2 })).then(() => true, () => false);
check("cancelled order frees the piece for the next buyer", again);

// ---- payout confirmation
const tEvt = { event: "transfer.success", data: { id: 999, reference: `payout-${o1.orderId}`, transfer_code: "TRF_test123" } };
check("transfer.success webhook accepted", (await webhook(tEvt)) === 200);
await webhook(tEvt);
const p2 = await one(`SELECT status FROM payouts WHERE order_id=$1`, [o1.orderId]);
const evs = await one(`SELECT count(*)::int n FROM order_events WHERE order_id=$1`, [o1.orderId]);
check("order released, payout success, replay harmless, 5 audit events", (await stateOf(o1.orderId)) === "released" && p2.status === "success" && evs.n === 5, { p2, evs });

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
