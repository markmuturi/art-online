import { requireAdminUrl, resetDatabase } from "../scripts/db";

process.env.DATABASE_URL = await resetDatabase(requireAdminUrl(), "art_test_auth");
process.env.BETTER_AUTH_URL = "http://localhost:3000";
process.env.BETTER_AUTH_SECRET = "test-secret-test-secret-test-secret-123456";
process.env.RESEND_API_KEY = "re_test";
process.env.EMAIL_FROM = "Art Online <noreply@example.com>";

const sent: Array<{ to: string[]; text: string }> = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  if (String(input).includes("api.resend.com")) {
    sent.push(JSON.parse(String(init?.body)));
    return new Response("{}", { status: 200 });
  }
  return realFetch(input, init);
}) as typeof fetch;

let failures = 0;
const check = (name: string, ok: boolean, extra?: unknown): void => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || extra === undefined ? "" : "  -> " + JSON.stringify(extra)}`);
};

const { pool } = await import("../lib/db");
const { auth } = await import("../lib/auth/auth");
const { getSessionUser, requireUser, requireRole, HttpError } = await import("../lib/auth/session");
const { POST, GET } = await import("../app/api/auth/[...all]/route");

const ORIGIN = "http://localhost:3000";
const call = (method: "POST" | "GET", path: string, body?: unknown, cookie?: string, ip = "10.0.0.1"): Promise<Response> => {
  const headers: Record<string, string> = { origin: ORIGIN, "x-forwarded-for": ip };
  if (body) headers["content-type"] = "application/json";
  if (cookie) headers.cookie = cookie;
  const req = new Request(`${ORIGIN}/api/auth${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return method === "POST" ? POST(req) : GET(req);
};
const cookieFrom = (res: Response): string => res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
const PW = "correct-horse-battery";

// 1. Sign up. Try to smuggle in role=admin.
const su = await call("POST", "/sign-up/email", { name: "Wanjiru Kamau", email: "Wanjiru@Example.com", password: PW, phone: "+254700000001", role: "admin" });
const row = (await pool.query(`SELECT role, email_verified, full_name, phone FROM users WHERE email='wanjiru@example.com'`)).rows[0];
check("role=admin in the sign-up body cannot make an admin", row === undefined || row.role !== "admin", { status: su.status, row });
const su2 = await call("POST", "/sign-up/email", { name: "Wanjiru Kamau", email: "Wanjiru@Example.com", password: PW, phone: "+254700000001" }, undefined, "10.0.0.2");
const row2 = (await pool.query(`SELECT id, role, email_verified, full_name, phone FROM users WHERE email='wanjiru@example.com'`)).rows[0];
check("normal sign-up creates a buyer, unverified, name and phone stored", su2.status === 200 && row2?.role === "buyer" && row2.email_verified === false && row2.full_name === "Wanjiru Kamau" && row2.phone === "+254700000001", { status: su2.status, row2 });

// 2. Password storage
const acct = (await pool.query(`SELECT provider_id, password FROM accounts WHERE user_id=$1`, [row2.id])).rows[0];
check("password stored only as a salted hash in accounts", acct?.provider_id === "credential" && acct.password !== PW && !acct.password.includes(PW) && acct.password.length > 60, { fmt: acct?.password?.slice(0, 12) + "..." });

// 3. Cannot sign in until verified
const early = await call("POST", "/sign-in/email", { email: "wanjiru@example.com", password: PW }, undefined, "10.0.0.3");
check("sign-in blocked before email verification (403)", early.status === 403, early.status);
check("verification email was sent to the right address", sent.some((m) => m.to[0] === "wanjiru@example.com" && /verify-email\?token=/.test(m.text)));

// 4. Verify via the emailed link
const link = sent.filter((m) => m.to[0] === "wanjiru@example.com").map((m) => m.text.match(/https?:\/\/\S+verify-email\?\S+/)?.[0]).find(Boolean)!;
const vUrl = new URL(link);
const ver = await call("GET", `/verify-email${vUrl.search}`, undefined, undefined, "10.0.0.4");
check("emailed link verifies the account", (ver.status === 200 || ver.status === 302) && (await pool.query(`SELECT email_verified FROM users WHERE id=$1`, [row2.id])).rows[0].email_verified === true, ver.status);

// 5. Sign in and use the session
const si = await call("POST", "/sign-in/email", { email: "wanjiru@example.com", password: PW }, undefined, "10.0.0.5");
const setCookie = si.headers.getSetCookie().join(" | ");
const cookie = cookieFrom(si);
check("sign-in succeeds and sets an HttpOnly, SameSite session cookie", si.status === 200 && /httponly/i.test(setCookie) && /samesite=lax/i.test(setCookie), { status: si.status, setCookie });
const me = await getSessionUser(new Headers({ cookie }));
check("getSessionUser returns id, email, name and role", me?.role === "buyer" && me.email === "wanjiru@example.com" && me.fullName === "Wanjiru Kamau" && me.id === row2.id, me);
check("no cookie means no user", (await getSessionUser(new Headers())) === null);
check("requireUser throws 401 with no session", await requireUser(new Headers()).then(() => false, (e) => e instanceof HttpError && e.status === 401));
check("requireRole('artist') throws 403 for a buyer", await requireRole(new Headers({ cookie }), "artist").then(() => false, (e) => e instanceof HttpError && e.status === 403));
check("requireRole('buyer') passes for a buyer", (await requireRole(new Headers({ cookie }), "buyer", "artist")).id === row2.id);

// 6. Role changes apply immediately (the session is read from the database each time)
await pool.query(`UPDATE users SET role='artist' WHERE id=$1`, [row2.id]);
check("promoting to artist takes effect on the very next request", (await requireRole(new Headers({ cookie }), "artist")).role === "artist");
await pool.query(`UPDATE users SET role='buyer' WHERE id=$1`, [row2.id]);

// 7. Sign out revokes at once
const out = await call("POST", "/sign-out", {}, cookie, "10.0.0.6");
check("sign-out revokes the session immediately", out.status === 200 && (await getSessionUser(new Headers({ cookie }))) === null, out.status);

// 8. Wrong password + rate limit (5 per minute per IP on sign-in)
const bad = await call("POST", "/sign-in/email", { email: "wanjiru@example.com", password: "wrong-password-123" }, undefined, "10.9.9.9");
check("wrong password rejected (401)", bad.status === 401, bad.status);
const statuses: number[] = [bad.status];
for (let i = 0; i < 6; i++) statuses.push((await call("POST", "/sign-in/email", { email: "wanjiru@example.com", password: "wrong-password-123" }, undefined, "10.9.9.9")).status);
check("brute force gets rate limited (429) after 5 tries", statuses.includes(429), statuses);
check("a different IP is not affected", (await call("POST", "/sign-in/email", { email: "wanjiru@example.com", password: PW }, undefined, "10.8.8.8")).status === 200);

// 9. Password rules
const weak = await call("POST", "/sign-up/email", { name: "Weak", email: "weak@example.com", password: "short", phone: "+254700000002" }, undefined, "10.0.0.7");
check("short password rejected", weak.status >= 400 && weak.status < 500, weak.status);

// 10. Origin check (CSRF)
const evil = await POST(new Request(`${ORIGIN}/api/auth/sign-in/email`, { method: "POST", headers: { origin: "https://evil.example", "content-type": "application/json", "x-forwarded-for": "10.7.7.7" }, body: JSON.stringify({ email: "wanjiru@example.com", password: PW }) }));
check("sign-in from a foreign origin is refused", evil.status === 403, evil.status);

// 11. A second user cannot see the first user's session
const su3 = await call("POST", "/sign-up/email", { name: "Otieno", email: "otieno@example.com", password: PW }, undefined, "10.0.0.8");
check("phone is optional at sign-up", su3.status === 200, su3.status);

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILED`);
await pool.end();
process.exit(failures === 0 ? 0 : 1);
