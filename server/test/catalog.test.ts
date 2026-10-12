import { requireAdminUrl, resetDatabase } from "../scripts/db";

process.env.DATABASE_URL = await resetDatabase(requireAdminUrl(), "art_test_catalog");
process.env.BETTER_AUTH_URL = "http://localhost:3000";
process.env.BETTER_AUTH_SECRET = "test-secret-test-secret-test-secret-123456";

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
const genre = async (name: string, slug: string): Promise<number> =>
  (await one(`INSERT INTO genres (name, slug) VALUES ($1,$2) RETURNING id`, [name, slug])).id;
const gPainting = await genre("Painting", "painting");
const gSculpture = await genre("Sculpture", "sculpture");
const gPhoto = await genre("Photography", "photography");

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
check("genres come back alphabetically", genres.map((g: any) => g.name).join() === "Painting,Photography,Sculpture", genres);
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

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILED`);
await pool.end();
process.exit(failures === 0 ? 0 : 1);
