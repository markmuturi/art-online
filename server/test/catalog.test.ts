import { requireAdminUrl, resetDatabase } from "../scripts/db";

process.env.DATABASE_URL = await resetDatabase(requireAdminUrl(), "art_test_catalog");
process.env.BETTER_AUTH_URL = "http://localhost:3000";
process.env.BETTER_AUTH_SECRET = "test-secret-test-secret-test-secret-123456";
process.env.PLATFORM_FEE_BPS = "1000";

let failures = 0;
const check = (name: string, ok: boolean, extra?: unknown): void => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || extra === undefined ? "" : "  -> " + JSON.stringify(extra)}`);
};

const { pool } = await import("../lib/db");
const { GET: browseGET } = await import("../app/api/artworks/route");
const { GET: detailGET } = await import("../app/api/artworks/[artworkId]/route");
const { GET: genresGET } = await import("../app/api/genres/route");
const { GET: locationsGET } = await import("../app/api/locations/route");

const ORIGIN = "http://localhost:3000";
const browse = (qs = ""): Promise<Response> => browseGET(new Request(`${ORIGIN}/api/artworks${qs}`));
const detail = (id: string): Promise<Response> => detailGET(new Request(`${ORIGIN}/api/artworks/${id}`), { params: Promise.resolve({ artworkId: id }) });
const one = async <T = any>(sql: string, p: unknown[] = []): Promise<T> => (await pool.query(sql, p)).rows[0] as T;
const titles = (j: any): string[] => j.items.map((i: any) => i.title);
const sameSet = (a: string[], b: string[]): boolean => a.length === b.length && [...a].sort().join("|") === [...b].sort().join("|");

// ---- seed: three genres, three artists in three cities, a mix of statuses
// Genres come from migration 007, not from the test. If the seed is missing, these lookups fail.
const genre = async (slug: string): Promise<number> => (await one(`SELECT id FROM genres WHERE slug = $1`, [slug])).id;
const gPainting = await genre("painting");
const gSculpture = await genre("sculpture");
const gPhoto = await genre("photography");

const artist = async (email: string, display: string, city: string | null): Promise<string> => {
  const id = (await one(`INSERT INTO users (email, full_name, role) VALUES ($1,$2,'artist') RETURNING id`, [email, display])).id;
  await pool.query(
    `INSERT INTO artist_profiles (user_id, display_name, location_city, paystack_recipient_code, payout_channel, payout_account_last4, payout_bank_name, kyc_status, kyc_note)
     VALUES ($1,$2,$3,'RCP_SECRET_123','mpesa','4321','M-PESA','verified','internal reviewer note')`,
    [id, display, city],
  );
  return id;
};
const A = await artist("a@x.ke", "Wanjiru Art", "Nairobi");
const B = await artist("b@x.ke", "Otieno Studio", "Mombasa");
const C = await artist("c@x.ke", "Kisumu Maker", "Kisumu");

let tick = 0;
const art = async (artistId: string, title: string, genreId: number, price: number, status: string, fulfillment: "physical" | "digital"): Promise<string> => {
  tick += 1; // distinct, explicit created_at values so "newest" ordering is deterministic
  const created = new Date(Date.UTC(2026, 0, 1, 0, tick)).toISOString();
  const edition = fulfillment === "digital" ? [`original`, 1] : [null, null];
  return (await one(
    `INSERT INTO artworks (artist_id,title,genre_id,price_cents,status,fulfillment_type,edition_type,edition_size,created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [artistId, title, genreId, price, status, fulfillment, edition[0], edition[1], created],
  )).id;
};
const sunset = await art(A, "Sunset Over Nairobi", gPainting, 500000, "listed", "physical");
const pixel = await art(A, "Pixel Dawn", gPainting, 200000, "listed", "digital");
const cotton = await art(A, "100% Cotton Study", gPainting, 200000, "listed", "physical"); // same price as Pixel Dawn on purpose
const lion = await art(B, "Bronze Lion", gSculpture, 900000, "listed", "physical");
const coast = await art(B, "Coast Light", gPhoto, 150000, "listed", "digital");
const draft = await art(B, "Hidden Draft", gPainting, 100000, "draft", "physical");
const removed = await art(A, "Withdrawn Piece", gPainting, 300000, "removed", "physical");
const kisumuDraft = await art(C, "Kisumu Draft", gPainting, 120000, "draft", "physical");
await pool.query(`INSERT INTO artwork_images (artwork_id, url, position) VALUES ($1,'http://img/sunset-1.webp',0), ($1,'http://img/sunset-2.webp',1)`, [sunset]);

// ==== basic visibility
const all = await browse().then((r) => r.json());
check("anonymous browse works with no filters and counts only the 5 listed pieces", all.totalCount === 5 && all.items.length === 5, { total: all.totalCount, titles: titles(all) });
check("draft and removed artworks never appear", !titles(all).some((t) => ["Hidden Draft", "Withdrawn Piece", "Kisumu Draft"].includes(t)), titles(all));
check("each item carries genre and artist summary for a card grid", all.items.every((i: any) => i.genre?.name && i.artist?.displayName && i.artist?.id), all.items[0]);

const rawJson = JSON.stringify(all);
check("no payout / KYC / recipient data anywhere in the public list response", !/RCP_SECRET_123|kyc|paystack|recipient|payout|last4|internal reviewer note/i.test(rawJson));

// ==== filters
check("genre filter by slug", sameSet(titles(await browse("?genre=painting").then((r) => r.json())), ["Sunset Over Nairobi", "Pixel Dawn", "100% Cotton Study"]));
const noGenre = await browse("?genre=does-not-exist");
const noGenreJson = await noGenre.json();
check("an unknown genre slug is an empty result, not an error", noGenre.status === 200 && noGenreJson.items.length === 0 && noGenreJson.totalCount === 0);
check("location filter is case-insensitive and partial", sameSet(titles(await browse("?location=nAiRo").then((r) => r.json())), ["Sunset Over Nairobi", "Pixel Dawn", "100% Cotton Study"]));
check("location filter, other city", sameSet(titles(await browse("?location=Mombasa").then((r) => r.json())), ["Bronze Lion", "Coast Light"]));
check("artistId filter", sameSet(titles(await browse(`?artistId=${B}`).then((r) => r.json())), ["Bronze Lion", "Coast Light"]));
check("fulfillmentType=digital", sameSet(titles(await browse("?fulfillmentType=digital").then((r) => r.json())), ["Pixel Dawn", "Coast Light"]));
check("fulfillmentType=physical", sameSet(titles(await browse("?fulfillmentType=physical").then((r) => r.json())), ["Sunset Over Nairobi", "100% Cotton Study", "Bronze Lion"]));
check("search matches a title fragment, case-insensitively", sameSet(titles(await browse("?q=LION").then((r) => r.json())), ["Bronze Lion"]));
check("search also matches the artist's display name", sameSet(titles(await browse("?q=otieno").then((r) => r.json())), ["Bronze Lion", "Coast Light"]));
check("combined filters narrow together (genre + city + digital)", sameSet(titles(await browse("?genre=painting&location=Nairobi&fulfillmentType=digital").then((r) => r.json())), ["Pixel Dawn"]));

// ==== search input is treated as literal text, not as a pattern
const pct = await browse("?q=%25").then((r) => r.json());
check("searching for a literal % matches only the title containing one, not everything", sameSet(titles(pct), ["100% Cotton Study"]), titles(pct));
const underscore = await browse("?q=_").then((r) => r.json());
check("searching for a literal _ matches nothing, it is not a single-character wildcard", underscore.items.length === 0, titles(underscore));
const injection = await browse(`?q=${encodeURIComponent("'; DROP TABLE artworks; --")}&genre=${encodeURIComponent("x' OR '1'='1")}`);
check("SQL-injection-shaped input is just a search that finds nothing", injection.status === 200 && (await injection.json()).items.length === 0);
check("the artworks table is still intact afterwards", Number((await one(`SELECT count(*)::int n FROM artworks`)).n) === 8);

// ==== sorting
const priceAsc = (await browse("?sort=price_asc").then((r) => r.json())).items.map((i: any) => i.priceCents);
check("sort=price_asc is ascending", priceAsc.every((p: number, i: number) => i === 0 || priceAsc[i - 1] <= p), priceAsc);
const priceDesc = (await browse("?sort=price_desc").then((r) => r.json())).items.map((i: any) => i.priceCents);
check("sort=price_desc is descending", priceDesc.every((p: number, i: number) => i === 0 || priceDesc[i - 1] >= p), priceDesc);
const newest = (await browse().then((r) => r.json())).items.map((i: any) => i.title);
check("default sort is newest first", newest[0] === "Coast Light" && newest[newest.length - 1] === "Sunset Over Nairobi", newest);

// ==== pagination
const fullAsc = (await browse("?sort=price_asc&limit=50").then((r) => r.json())).items.map((i: any) => i.id);
const pagedIds: string[] = [];
let totals: number[] = [];
for (let offset = 0; offset < 5; offset++) {
  const page = await browse(`?sort=price_asc&limit=1&offset=${offset}`).then((r) => r.json());
  pagedIds.push(...page.items.map((i: any) => i.id));
  totals.push(page.totalCount);
}
check("paging one at a time through tied prices shows every item exactly once (stable tiebreaker)", new Set(pagedIds).size === 5 && pagedIds.join() === fullAsc.join(), { pagedIds, fullAsc });
check("totalCount stays at 5 on every page", totals.every((t) => t === 5), totals);
const past = await browse("?limit=2&offset=10").then((r) => r.json());
check("a page past the end returns no items but still reports the true total", past.items.length === 0 && past.totalCount === 5, past);
check("limit is echoed back", (await browse("?limit=3").then((r) => r.json())).limit === 3);

// ==== validation
check("bad sort -> 400", (await browse("?sort=cheapest")).status === 400);
check("limit=0 -> 400", (await browse("?limit=0")).status === 400);
check("limit=51 -> 400", (await browse("?limit=51")).status === 400);
check("limit=abc -> 400", (await browse("?limit=abc")).status === 400);
check("offset=-1 -> 400", (await browse("?offset=-1")).status === 400);
check("offset=10001 -> 400", (await browse("?offset=10001")).status === 400);
check("artistId that is not a UUID -> 400", (await browse("?artistId=not-a-uuid")).status === 400);
check("fulfillmentType=nft -> 400", (await browse("?fulfillmentType=nft")).status === 400);

// ==== genres and locations
const genres = await genresGET().then((r) => r.json());
const genreNames: string[] = genres.map((g: any) => g.name);
check("a brand-new database already offers genres (seed migration), so a listing can be created with nobody inserting one", genreNames.length >= 8 && ["Painting", "Sculpture", "Photography", "Digital Art"].every((n) => genreNames.includes(n)), genreNames);
check("genres come back alphabetically", genreNames.every((n, i) => i === 0 || genreNames[i - 1].slice(0, 2).toLowerCase() <= n.slice(0, 2).toLowerCase()), genreNames);
check("every genre carries an id, name and url-safe slug", genres.every((g: any) => Number.isInteger(g.id) && g.name && /^[a-z0-9-]+$/.test(g.slug)), genres);
const cities1 = await locationsGET().then((r) => r.json());
check("locations list only cities with a listed artwork (Kisumu has just a draft)", cities1.join() === "Mombasa,Nairobi", cities1);
await pool.query(`UPDATE artworks SET status='listed' WHERE id=$1`, [kisumuDraft]);
check("a city appears once its first piece is listed", (await locationsGET().then((r) => r.json())).join() === "Kisumu,Mombasa,Nairobi");
await pool.query(`UPDATE artworks SET status='removed' WHERE artist_id=$1`, [B]);
check("a city disappears once its last listed piece is removed", (await locationsGET().then((r) => r.json())).join() === "Kisumu,Nairobi");

// ==== detail view enrichment (existing endpoint, now richer)
const d = await detail(sunset);
const dj = await d.json();
check("detail view for a listed piece is public", d.status === 200);
check("detail view now carries genre name and artist summary, not just raw ids", dj.genre?.name === "Painting" && dj.artist?.displayName === "Wanjiru Art" && dj.artist?.locationCity === "Nairobi", dj);
check("detail view includes images in order", dj.images.length === 2 && dj.images[0].position === 0);
check("no payout / KYC data in the detail response either", !/RCP_SECRET_123|kyc|paystack|recipient|payout|last4|internal reviewer note/i.test(JSON.stringify(dj)));
check("a draft is still a 404 to an anonymous viewer", (await detail(draft)).status === 404);
check("a removed piece is still a 404 to an anonymous viewer", (await detail(removed)).status === 404);

// ==== paging through a large block of ties (this is what can expose an unstable sort)
const D = await artist("d@x.ke", "Tie Stress", "Nakuru");
await pool.query(
  `INSERT INTO artworks (artist_id,title,genre_id,price_cents,status,fulfillment_type,created_at)
   SELECT $1, 'Tie ' || g, $2, 100000, 'listed', 'physical', '2026-02-01T00:00:00Z' FROM generate_series(1,60) g`,
  [D, gPainting],
);
for (const sort of ["price_asc", "price_desc", "newest"]) {
  const seen: string[] = [];
  for (let offset = 0; offset < 60; offset += 7) {
    const page = await browse(`?artistId=${D}&sort=${sort}&limit=7&offset=${offset}`).then((r) => r.json());
    seen.push(...page.items.map((i: any) => i.id));
  }
  check(`60 items sharing one price AND one timestamp, paged 7 at a time with sort=${sort}: every item exactly once`, seen.length === 60 && new Set(seen).size === 60, { got: seen.length, unique: new Set(seen).size });
}

// ==== availability: a piece nobody can buy stops being offered, and returns when it frees up
const { withTransaction } = await import("../lib/db");
const { createOrder } = await import("../lib/orders/create");
const { transitionOrder } = await import("../lib/orders/transitions");

const E = await artist("e@x.ke", "Eldoret Studio", "Eldoret");
const buyer = (await one(`INSERT INTO users (email, full_name) VALUES ('buyer@x.ke','Buyer') RETURNING id`)).id;
const addr = (await one(`INSERT INTO addresses (user_id, recipient_name, line1, city, phone) VALUES ($1,'B','1 Rd','Eldoret','0700') RETURNING id`, [buyer])).id;
const landscape = await art(E, "Eldoret Landscape", gPainting, 400000, "listed", "physical");
const run = (await one(
  `INSERT INTO artworks (artist_id,title,genre_id,price_cents,status,fulfillment_type,edition_type,edition_size)
   VALUES ($1,'Eldoret Print Run',$2,100000,'listed','digital','limited',2) RETURNING id`, [E, gPainting])).id;
const eldoretPixel = await art(E, "Eldoret Pixel Original", gPainting, 150000, "listed", "digital"); // original, edition of 1

const shown = (qs = ""): Promise<any> => browse(`?artistId=${E}${qs}`).then((r) => r.json());
const buy = (artworkId: string, digital = false) =>
  withTransaction((c) => createOrder(c, { buyerId: buyer, artworkId, shippingAddressId: digital ? null : addr }));
const move = (orderId: string, to: any, actorType: any, extra: object = {}) =>
  withTransaction((c) => transitionOrder(c, { orderId, to, actorType, ...extra }));
const cities = (): Promise<string[]> => locationsGET().then((r) => r.json());
const flag = (j: any, title: string) => j.items.find((i: any) => i.title === title)?.available;

let v = await shown();
check("starting point: all three Eldoret pieces are offered and available", v.totalCount === 3 && v.items.every((i: any) => i.available === true), titles(v));
check("Eldoret is offered as a location", (await cities()).includes("Eldoret"));

// -- physical piece, abandoned checkout
const o1 = await buy(landscape);
v = await shown();
check("the moment a buyer starts checkout, the physical piece leaves the default catalog", !titles(v).includes("Eldoret Landscape") && v.totalCount === 2, titles(v));
v = await shown("&includeSold=true");
check("includeSold=true brings it back flagged available=false, the others still true", v.totalCount === 3 && flag(v, "Eldoret Landscape") === false && flag(v, "Eldoret Pixel Original") === true);
const dSold = await detail(landscape);
check("its detail page still loads (a shared link must not 404) and says available=false", dSold.status === 200 && (await dSold.json()).available === false);
await move(o1.orderId, "cancelled", "system");
check("an unpaid order that expires puts the piece straight back on sale", titles(await shown()).includes("Eldoret Landscape"));

// -- physical piece, paid then refunded
const o2 = await buy(landscape);
await move(o2.orderId, "paid_held", "system");
check("paid and held: still off the catalog", !titles(await shown()).includes("Eldoret Landscape"));
await move(o2.orderId, "refunded", "admin");
check("a refund puts the piece back on sale", titles(await shown()).includes("Eldoret Landscape"));

// -- physical piece, sale completes
const o3 = await buy(landscape);
await move(o3.orderId, "paid_held", "system");
await move(o3.orderId, "shipped", "artist", { trackingNumber: "TRK1" });
await move(o3.orderId, "delivered_confirmed", "buyer");
check("shipped and delivered: still off the catalog", !titles(await shown()).includes("Eldoret Landscape"));
await move(o3.orderId, "released", "system");
check("after payout (released) the piece stays off the catalog for good", !titles(await shown()).includes("Eldoret Landscape"));
check("a completed sale is still reachable with includeSold, marked unavailable", flag(await shown("&includeSold=true"), "Eldoret Landscape") === false);

// -- limited digital edition of 2
await buy(run, true);
check("edition of 2: after one sale one remains, still offered", titles(await shown()).includes("Eldoret Print Run"));
const l2 = await buy(run, true);
check("after the second sale the edition is sold out and leaves the catalog", !titles(await shown()).includes("Eldoret Print Run"));
check("sold-out edition: detail still loads, says available=false", (await detail(run).then((r) => r.json())).available === false);
await move(l2.orderId, "cancelled", "system");
check("an abandoned edition purchase gives the edition back", titles(await shown()).includes("Eldoret Print Run"));

// -- one-of-one digital original
await buy(eldoretPixel, true);
check("a one-of-one digital original leaves the catalog on its first order", !titles(await shown()).includes("Eldoret Pixel Original"));

// -- state now: landscape sold, one print-run edition left, pixel reserved
v = await shown();
check("totalCount only counts what can be bought (1), includeSold counts all (3)", v.totalCount === 1 && (await shown("&includeSold=true")).totalCount === 3, { total: v.totalCount });
check("Eldoret stays in the location filter while one edition remains", (await cities()).includes("Eldoret"));
const l3 = await buy(run, true);
check("a city drops out of the location filter once everything it has is sold or reserved", !(await cities()).includes("Eldoret"), await cities());
await move(l3.orderId, "cancelled", "system");
check("and returns when something frees up", (await cities()).includes("Eldoret"));

// -- parameter handling
check("includeSold=maybe is rejected (400)", (await browse("?includeSold=maybe")).status === 400);
check("includeSold=false behaves like the default", (await shown("&includeSold=false")).totalCount === 1);

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILED`);
await pool.end();
process.exit(failures === 0 ? 0 : 1);