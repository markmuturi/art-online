import { readFileSync } from "node:fs";
import { requireAdminUrl, resetDatabase } from "../scripts/db";
import { startTestStorage } from "../scripts/test-storage";

process.env.DATABASE_URL = await resetDatabase(requireAdminUrl(), "art_test_artworks");
const stopStorage = await startTestStorage(4589);
process.env.BETTER_AUTH_URL = "http://localhost:3000";
process.env.BETTER_AUTH_SECRET = "test-secret-test-secret-test-secret-123456";
process.env.RESEND_API_KEY = "re_test";
process.env.EMAIL_FROM = "Art Online <noreply@example.com>";

let failures = 0;
const check = (name: string, ok: boolean, extra?: unknown): void => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || extra === undefined ? "" : "  -> " + JSON.stringify(extra)}`);
};

const { pool } = await import("../lib/db");
const { POST: authPOST, GET: authGET } = await import("../app/api/auth/[...all]/route");
const { POST: createPOST } = await import("../app/api/artworks/route");
const { GET: mineGET } = await import("../app/api/artworks/mine/route");
const { GET: getOneGET, PATCH: patchOne } = await import("../app/api/artworks/[artworkId]/route");
const { POST: publishPOST } = await import("../app/api/artworks/[artworkId]/publish/route");
const { POST: archivePOST } = await import("../app/api/artworks/[artworkId]/archive/route");
const { POST: uploadImagePOST } = await import("../app/api/artworks/[artworkId]/images/route");

const ORIGIN = "http://localhost:3000";
const authCall = (path: string, body: unknown, cookie?: string, ip = "10.4.0.1") => {
  const headers: Record<string, string> = { origin: ORIGIN, "content-type": "application/json", "x-forwarded-for": ip };
  if (cookie) headers.cookie = cookie;
  return authPOST(new Request(`${ORIGIN}/api/auth${path}`, { method: "POST", headers, body: JSON.stringify(body) }));
};
const cookieFrom = (res: Response): string => res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
const PW = "correct-horse-battery";
const emailsSent: Array<{ to: string; text: string }> = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  if (String(input).includes("api.resend.com")) {
    const body = JSON.parse(String(init?.body));
    emailsSent.push({ to: body.to[0], text: body.text });
    return new Response("{}", { status: 200 });
  }
  return realFetch(input, init);
}) as typeof fetch;

async function signUpVerified(email: string, ip: string): Promise<string> {
  await authCall("/sign-up/email", { name: "Test User", email, password: PW }, undefined, ip);
  const mail = emailsSent.find((m) => m.to === email && /verify-email\?token=/.test(m.text))!;
  const link = mail.text.match(/https?:\/\/\S+verify-email\?\S+/)![0];
  await authGET(new Request(link.replace(/&callbackURL=.*/, ""), { headers: { "x-forwarded-for": ip } }));
  const si = await authCall("/sign-in/email", { email, password: PW }, undefined, ip);
  return cookieFrom(si);
}

const one = async <T = any>(sql: string, p: unknown[] = []): Promise<T> => (await pool.query(sql, p)).rows[0] as T;

const create = (body: unknown, cookie?: string): Promise<Response> => {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (cookie) headers.cookie = cookie;
  return createPOST(new Request(`${ORIGIN}/api/artworks`, { method: "POST", headers, body: JSON.stringify(body) }));
};
const mine = (cookie?: string): Promise<Response> => mineGET(new Request(`${ORIGIN}/api/artworks/mine`, { headers: cookie ? { cookie } : {} }));
const getOne = (id: string, cookie?: string): Promise<Response> => getOneGET(new Request(`${ORIGIN}/x`, { headers: cookie ? { cookie } : {} }), { params: Promise.resolve({ artworkId: id }) });
const patch = (id: string, body: unknown, cookie?: string): Promise<Response> =>
  patchOne(new Request(`${ORIGIN}/x`, { method: "PATCH", headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) }), { params: Promise.resolve({ artworkId: id }) });
const publish = (id: string, cookie?: string): Promise<Response> => publishPOST(new Request(`${ORIGIN}/x`, { method: "POST", headers: cookie ? { cookie } : {} }), { params: Promise.resolve({ artworkId: id }) });
const archive = (id: string, cookie?: string): Promise<Response> => archivePOST(new Request(`${ORIGIN}/x`, { method: "POST", headers: cookie ? { cookie } : {} }), { params: Promise.resolve({ artworkId: id }) });
const uploadImage = (id: string, cookie?: string): Promise<Response> => {
  const form = new FormData();
  form.append("file", new File([readFileSync("test/fixtures/sample-with-gps.jpg")], "p.jpg", { type: "image/jpeg" }));
  return uploadImagePOST(new Request(`${ORIGIN}/x`, { method: "POST", headers: cookie ? { cookie } : {}, body: form }), { params: Promise.resolve({ artworkId: id }) });
};

// ---- setup
const artistCookie = await signUpVerified("artist@x.ke", "10.4.1.1");
const artistId = (await one(`SELECT id FROM users WHERE email='artist@x.ke'`)).id;
await pool.query(`UPDATE users SET role='artist' WHERE id=$1`, [artistId]);
await pool.query(`INSERT INTO artist_profiles (user_id, display_name) VALUES ($1,'Test Artist')`, [artistId]);

const otherArtistCookie = await signUpVerified("other@x.ke", "10.4.1.2");
await pool.query(`UPDATE users SET role='artist' WHERE email='other@x.ke'`);

const buyerCookie = await signUpVerified("buyer@x.ke", "10.4.1.3");

const genre = (await one(`INSERT INTO genres (name, slug) VALUES ('Painting','painting') RETURNING id`)).id;
const basePhysical = { title: "Sunset Over Nairobi", description: "Oil on canvas", genreId: genre, priceCents: 500000, fulfillmentType: "physical" };

// ---- creation: auth and validation
check("unauthenticated cannot create (401)", (await create(basePhysical, undefined)).status === 401);
check("a buyer cannot create (403)", (await create(basePhysical, buyerCookie)).status === 403);
check("missing title rejected (400)", (await create({ ...basePhysical, title: "" }, artistCookie)).status === 400);
check("unknown genre rejected via the FK, not a crash (400)", (await create({ ...basePhysical, genreId: 999999 }, artistCookie)).status === 400);
check("price of 0 rejected (400)", (await create({ ...basePhysical, priceCents: 0 }, artistCookie)).status === 400);
check("price above the sanity ceiling rejected (400)", (await create({ ...basePhysical, priceCents: 999_999_999 }, artistCookie)).status === 400);
check("bad fulfillmentType rejected (400)", (await create({ ...basePhysical, fulfillmentType: "nft" }, artistCookie)).status === 400);
check("physical artwork cannot carry editionType (400)", (await create({ ...basePhysical, editionType: "original" }, artistCookie)).status === 400);
check("digital without editionType rejected (400)", (await create({ ...basePhysical, fulfillmentType: "digital" }, artistCookie)).status === 400);
check("digital 'limited' without editionSize rejected (400)", (await create({ ...basePhysical, fulfillmentType: "digital", editionType: "limited" }, artistCookie)).status === 400);

// ---- creation: happy path physical
const r1 = await create(basePhysical, artistCookie);
const j1 = await r1.json();
check("physical artwork created as draft", r1.status === 200 && j1.status === "draft" && !!j1.id, j1);
const row1 = await one(`SELECT status, edition_type, edition_size, currency FROM artworks WHERE id=$1`, [j1.id]);
check("status draft, no edition fields, currency forced to KES", row1.status === "draft" && row1.edition_type === null && row1.edition_size === null && row1.currency === "KES", row1);

// ---- creation: digital original forces edition_size=1 server-side regardless of client input
const rOrig = await create({ ...basePhysical, title: "Pixel Dawn", fulfillmentType: "digital", editionType: "original", editionSize: 999 }, artistCookie);
const jOrig = await rOrig.json();
check("digital original ignores a client-supplied editionSize and forces 1", (await one(`SELECT edition_size FROM artworks WHERE id=$1`, [jOrig.id])).edition_size === 1);

// ---- creation: digital limited
const rLim = await create({ ...basePhysical, title: "Pixel Dusk", fulfillmentType: "digital", editionType: "limited", editionSize: 25 }, artistCookie);
const jLim = await rLim.json();
check("digital limited edition stores the requested size", (await one(`SELECT edition_type, edition_size FROM artworks WHERE id=$1`, [jLim.id])).edition_size === 25);

// ---- visibility
check("a draft is invisible to an anonymous viewer (404)", (await getOne(j1.id, undefined)).status === 404);
check("a draft is invisible to a different artist (404)", (await getOne(j1.id, otherArtistCookie)).status === 404);
check("a draft IS visible to its owner, with an empty images array", (await getOne(j1.id, artistCookie).then((r) => r.json())).images.length === 0);
check("nonexistent artwork is 404", (await getOne("00000000-0000-0000-0000-000000000000", artistCookie)).status === 404);

// ---- listMine
const mineList = await mine(artistCookie).then((r) => r.json());
check("artist's own list includes all three drafts they created", mineList.length === 3 && mineList.every((a: any) => a.artistId === artistId), mineList.map((a: any) => a.title));
check("a buyer cannot call the artist-only mine endpoint (403)", (await mine(buyerCookie)).status === 403);

// ---- patch
check("a non-owner cannot patch (401 unauth, or ownership enforced as 400 not-found)", (await patch(j1.id, { priceCents: 600000 }, otherArtistCookie)).status === 400);
const patchRes = await patch(j1.id, { priceCents: 600000, description: null }, artistCookie);
check("owner can patch price and explicitly clear description", patchRes.status === 200, patchRes.status);
const afterPatch = await one(`SELECT price_cents, description FROM artworks WHERE id=$1`, [j1.id]);
check("price updated and description actually cleared to null (not left untouched)", afterPatch.price_cents === 600000 && afterPatch.description === null, afterPatch);
const noOpPatch = await patch(j1.id, { title: "Sunset Over Nairobi, Reframed" }, artistCookie);
check("partial patch (title only) leaves price untouched", noOpPatch.status === 200 && (await one(`SELECT price_cents FROM artworks WHERE id=$1`, [j1.id])).price_cents === 600000);

// ---- publish requires an image
const publishEmpty = await publish(j1.id, artistCookie);
check("publishing with zero images is rejected (400)", publishEmpty.status === 400 && (await publishEmpty.text()).toLowerCase().includes("photo"), publishEmpty.status);

const imgRes = await uploadImage(j1.id, artistCookie);
check("image upload for this artwork succeeds (reusing last session's route)", imgRes.status === 200, imgRes.status);

const publishOk = await publish(j1.id, artistCookie);
check("publish succeeds once a photo exists", publishOk.status === 200 && (await one(`SELECT status FROM artworks WHERE id=$1`, [j1.id])).status === "listed");
check("a listed artwork is now visible to an anonymous viewer", (await getOne(j1.id, undefined)).status === 200);
check("publishing an already-listed artwork is rejected (400)", (await publish(j1.id, artistCookie)).status === 400);
check("editing a listed artwork is still allowed (status is in EDITABLE_STATUSES)", (await patch(j1.id, { title: "Sunset Over Nairobi, Final" }, artistCookie)).status === 200);

// ---- archive
const toArchive = await create({ ...basePhysical, title: "Quiet Morning" }, artistCookie).then((r) => r.json());
const archiveBuyerId = (await one(`SELECT id FROM users WHERE email='buyer@x.ke'`)).id;
const archiveAddrId = (await one(
  `INSERT INTO addresses (user_id, recipient_name, line1, city, phone) VALUES ($1,'B','1 Rd','Nairobi','0700') RETURNING id`,
  [archiveBuyerId],
)).id;
const orderId = (await one(
  `INSERT INTO orders (buyer_id, artwork_id, artist_id, shipping_address_id, amount_cents, platform_fee_cents, artist_payout_cents, state)
   VALUES ($1,$2,$3,$4,500000,50000,450000,'paid_held') RETURNING id`,
  [archiveBuyerId, toArchive.id, artistId, archiveAddrId],
)).id;

const archiveBlocked = await archive(toArchive.id, artistCookie);
check("cannot archive while a live (non-terminal) order exists (400)", archiveBlocked.status === 400, archiveBlocked.status);

await pool.query(`UPDATE orders SET state='released' WHERE id=$1`, [orderId]);
const archiveOk = await archive(toArchive.id, artistCookie);
check("archive succeeds once the order has reached a terminal state", archiveOk.status === 200 && (await one(`SELECT status FROM artworks WHERE id=$1`, [toArchive.id])).status === "removed");

check("a removed artwork is invisible again, even to an anonymous viewer that could see it listed", (await getOne(toArchive.id, undefined)).status === 404);
check("a removed artwork cannot be edited (400)", (await patch(toArchive.id, { priceCents: 1 }, artistCookie)).status === 400);
check("a removed artwork cannot be archived again (400)", (await archive(toArchive.id, artistCookie)).status === 400);

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILED`);
await stopStorage();
await pool.end();
process.exit(failures === 0 ? 0 : 1);
