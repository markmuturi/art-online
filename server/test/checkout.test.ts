import { requireAdminUrl, resetDatabase } from "../scripts/db";

process.env.DATABASE_URL = await resetDatabase(requireAdminUrl(), "art_test_checkout");
process.env.BETTER_AUTH_URL = "http://localhost:3000";
process.env.BETTER_AUTH_SECRET = "test-secret-test-secret-test-secret-123456";
process.env.APP_URL = "http://localhost:3000";
process.env.PAYSTACK_SECRET_KEY = "sk_test_local";
process.env.PLATFORM_FEE_BPS = "1000";
process.env.RESEND_API_KEY = "re_test";
process.env.EMAIL_FROM = "Art Online <noreply@example.com>";

const paystackCalls: Array<Record<string, unknown>> = [];
const emailsSent: Array<{ to: string; text: string }> = [];
let failNextPaystackCall = false;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  if (String(input).includes("api.resend.com")) {
    const body = JSON.parse(String(init?.body));
    emailsSent.push({ to: body.to[0], text: body.text });
    return new Response("{}", { status: 200 });
  }
  if (String(input).includes("api.paystack.co/transaction/initialize")) {
    const body = JSON.parse(String(init?.body));
    paystackCalls.push(body);
    if (failNextPaystackCall) {
      failNextPaystackCall = false;
      return new Response(JSON.stringify({ status: false, message: "simulated outage" }), { status: 500 });
    }
    return new Response(
      JSON.stringify({ status: true, message: "ok", data: { authorization_url: `https://paystack.test/pay/${body.reference}` } }),
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

const { pool } = await import("../lib/db");
const { POST: authPOST, GET: authGET } = await import("../app/api/auth/[...all]/route");
const { POST: checkoutPOST } = await import("../app/api/checkout/route");

const ORIGIN = "http://localhost:3000";
const authCall = (path: string, body: unknown, cookie?: string, ip = "10.1.0.1") => {
  const headers: Record<string, string> = { origin: ORIGIN, "content-type": "application/json", "x-forwarded-for": ip };
  if (cookie) headers.cookie = cookie;
  return authPOST(new Request(`${ORIGIN}/api/auth${path}`, { method: "POST", headers, body: JSON.stringify(body) }));
};
const cookieFrom = (res: Response): string => res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
const PW = "correct-horse-battery";

async function signUpVerifiedBuyer(email: string, ip: string): Promise<string> {
  await authCall("/sign-up/email", { name: "Test Buyer", email, password: PW }, undefined, ip);
  const mail = emailsSent.find((m) => m.to === email && /verify-email\?token=/.test(m.text))!;
  const link = mail.text.match(/https?:\/\/\S+verify-email\?\S+/)![0];
  await authGET(new Request(link.replace(/&callbackURL=.*/, ""), { headers: { "x-forwarded-for": ip } }));
  const si = await authCall("/sign-in/email", { email, password: PW }, undefined, ip);
  return cookieFrom(si);
}

const checkout = (body: unknown, cookie?: string): Promise<Response> => {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (cookie) headers.cookie = cookie;
  return checkoutPOST(new Request(`${ORIGIN}/api/checkout`, { method: "POST", headers, body: JSON.stringify(body) }));
};
const one = async <T = any>(sql: string, p: unknown[] = []): Promise<T> => (await pool.query(sql, p)).rows[0] as T;

// ---- seed catalogue
const artist = (await one<{ id: string }>(`INSERT INTO users (email, full_name, role) VALUES ('artist@x.ke','Artist','artist') RETURNING id`)).id;
await pool.query(`INSERT INTO artist_profiles (user_id, display_name, paystack_recipient_code, payout_channel) VALUES ($1,'The Artist','RCP_test','mpesa')`, [artist]);
const genre = (await one<{ id: number }>(`INSERT INTO genres (name, slug) VALUES ('Painting','painting') RETURNING id`)).id;
const physical = (await one<{ id: string }>(`INSERT INTO artworks (artist_id,title,genre_id,price_cents,status,fulfillment_type) VALUES ($1,'Sunset',$2,500000,'listed','physical') RETURNING id`, [artist, genre])).id;
const digital = (await one<{ id: string }>(`INSERT INTO artworks (artist_id,title,genre_id,price_cents,status,fulfillment_type,edition_type,edition_size) VALUES ($1,'Pixel Sunset',$2,200000,'listed','digital','original',1) RETURNING id`, [artist, genre])).id;
await pool.query(`INSERT INTO digital_assets (artwork_id, storage_key, file_type, file_size_bytes) VALUES ($1,'private/x.png','image/png',1234)`, [digital]);

// ---- buyers
const cookieA = await signUpVerifiedBuyer("buyer-a@x.ke", "10.1.0.2");
const cookieB = await signUpVerifiedBuyer("buyer-b@x.ke", "10.1.0.3");
const buyerA = (await one<{ id: string }>(`SELECT id FROM users WHERE email='buyer-a@x.ke'`)).id;
const addrA = (await one<{ id: string }>(`INSERT INTO addresses (user_id, recipient_name, line1, city, phone) VALUES ($1,'A','1 Rd','Nairobi','0700') RETURNING id`, [buyerA])).id;

// ---- auth and validation
check("no session -> 401", (await checkout({ artworkId: physical }, undefined)).status === 401);
check("missing artworkId -> 400", (await checkout({}, cookieA)).status === 400);
check("physical artwork with no shippingAddressId -> 400 from createOrder", (await checkout({ artworkId: physical }, cookieA)).status === 400);

// ---- happy path, physical
const r1 = await checkout({ artworkId: physical, shippingAddressId: addrA }, cookieA);
const j1 = await r1.json();
check("physical checkout succeeds with orderId and authorizationUrl", r1.status === 200 && j1.orderId && j1.authorizationUrl?.includes(j1.orderId) && j1.authorizationUrl?.startsWith("https://paystack.test/pay/"), { status: r1.status, j1 });
const order1 = await one(`SELECT amount_cents, platform_fee_cents, artist_payout_cents, state FROM orders WHERE id=$1`, [j1.orderId]);
check("order written with correct fee split, state pending_payment", order1.amount_cents === 500000 && order1.platform_fee_cents === 50000 && order1.artist_payout_cents === 450000 && order1.state === "pending_payment", order1);
const payment1 = await one(`SELECT paystack_reference FROM payments WHERE order_id=$1`, [j1.orderId]);
const call1 = paystackCalls.find((c) => c.reference === payment1.paystack_reference);
check("Paystack was called with the buyer's email, the right amount, and a callback URL containing the order id", call1?.email === "buyer-a@x.ke" && call1?.amount === 500000 && typeof call1?.callback_url === "string" && (call1!.callback_url as string).includes(j1.orderId), call1);

// ---- second buyer cannot take the same physical piece
const addrB = (await one<{ id: string }>(`INSERT INTO addresses (user_id, recipient_name, line1, city, phone) VALUES ((SELECT id FROM users WHERE email='buyer-b@x.ke'),'B','2 Rd','Nairobi','0711') RETURNING id`)).id;
const r2 = await checkout({ artworkId: physical, shippingAddressId: addrB }, cookieB);
check("second buyer blocked from an already-reserved physical piece (400)", r2.status === 400, { status: r2.status, body: await r2.text() });

// ---- digital, no address
const r3 = await checkout({ artworkId: digital }, cookieB);
const j3 = await r3.json();
check("digital checkout succeeds without a shippingAddressId", r3.status === 200 && !!j3.orderId, { status: r3.status, j3 });
check("digital edition marked reserved", (await one(`SELECT editions_sold s FROM artworks WHERE id=$1`, [digital])).s === 1);

// ---- digital sold out
const r4 = await checkout({ artworkId: digital }, cookieA);
check("sold-out digital edition rejected (400)", r4.status === 400, r4.status);

// ---- attaching someone else's address
const r5 = await checkout({ artworkId: digital, shippingAddressId: addrB }, cookieB);
check("digital order with a shippingAddressId attached is rejected", r5.status === 400, r5.status);

// ---- Paystack outage: order is created, but the route surfaces the failure and does not crash
const artwork2 = (await one<{ id: string }>(`INSERT INTO artworks (artist_id,title,genre_id,price_cents,status,fulfillment_type) VALUES ($1,'Dusk',$2,300000,'listed','physical') RETURNING id`, [artist, genre])).id;
failNextPaystackCall = true;
const r6 = await checkout({ artworkId: artwork2, shippingAddressId: addrA }, cookieA);
check("Paystack outage returns 502, not a 500 crash", r6.status === 502, r6.status);
const leftover = await one(`SELECT state FROM orders WHERE artwork_id=$1`, [artwork2]);
check("the order still exists in pending_payment, ready for the 30-minute expiry job to reclaim the piece (tested in flow.ts)", leftover?.state === "pending_payment", leftover);

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILED`);
await pool.end();
process.exit(failures === 0 ? 0 : 1);
