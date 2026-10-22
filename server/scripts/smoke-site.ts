// Checks a RUNNING site over HTTP, the way a visitor (or a deploy platform) would.
//   npm run dev            (in one terminal)
//   npm run smoke          (in another)       or: npm run smoke -- https://your-site.example
// It makes no changes and needs no login. Assertions avoid depending on any particular artwork.

export {};

const base = (process.argv[2] ?? process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
let failures = 0;
const check = (name: string, ok: boolean, extra?: unknown): void => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || extra === undefined ? "" : "  -> " + JSON.stringify(extra)}`);
};
const get = async (path: string) => {
  const res = await fetch(base + path, { redirect: "manual" });
  return { status: res.status, headers: res.headers, text: await res.text() };
};

console.log(`Smoke-checking ${base}\n`);

let health;
try {
  health = await get("/api/health");
} catch {
  console.error(`FAIL  Could not reach ${base}. Is the site running? Start it with: npm run dev`);
  process.exit(1);
}
check("health: the app is up and can reach Postgres", health.status === 200 && health.text.includes('"ok":true'), health.text);

const home = await get("/");
check("home page loads", home.status === 200, home.status);
check("home page has exactly one h1", (home.text.match(/<h1[ >]/g) ?? []).length === 1);
check("home page has the filter form and a skip link", home.text.includes('name="genre"') && home.text.includes("skip-link"));
check("no payout, KYC or credential words anywhere in the page", !/recipient|kyc|paystack|payout|last4|password/i.test(home.text));

const asJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};
const genres = asJson((await get("/api/genres")).text);
check("genres are available (the seed migration ran)", Array.isArray(genres) && genres.length >= 8, Array.isArray(genres) ? genres.length : "not a list");
check("locations endpoint answers with a list", Array.isArray(asJson((await get("/api/locations")).text)));
check("browse API answers", (await get("/api/artworks?limit=1")).status === 200);

check("a nonsense filter is ignored, not an error page", (await get("/?sort=bogus&kind=x&artist=nope&page=-4")).status === 200);
check("a page past the end explains itself instead of crashing", (await get("/?page=399")).status === 200);
check("a garbage artwork id is a clean 404 (page)", (await get("/artworks/xyz")).status === 404);
check("a garbage artwork id is a clean 404 (API)", (await get("/api/artworks/xyz")).status === 404);
check("an unknown but well-formed id is a clean 404", (await get("/artworks/00000000-0000-0000-0000-000000000000")).status === 404);
check("an unknown route is a 404 page, not a stack trace", (await get("/no-such-page")).status === 404);

const h = home.headers;
check("security headers are set", h.get("x-content-type-options") === "nosniff" && h.get("x-frame-options") === "DENY" && !!h.get("referrer-policy") && !!h.get("permissions-policy"));
check("the framework does not advertise itself", h.get("x-powered-by") === null);

const link = home.text.match(/href="\/artworks\/([0-9a-f-]{36})"/);
if (link) {
  const detail = await get(`/artworks/${link[1]}`);
  check("an artwork page loads", detail.status === 200, detail.status);
  check("it has a title tag, one h1 and an availability line", /<title>[^<]+<\/title>/.test(detail.text) && (detail.text.match(/<h1[ >]/g) ?? []).length === 1 && /class="status/.test(detail.text));
  check("it leaks no payout or credential words either", !/recipient|kyc|paystack|payout|last4|password/i.test(detail.text));
} else {
  console.log("note  no artworks are listed, so the artwork page was not checked. Run: npm run db:seed-demo");
}

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
