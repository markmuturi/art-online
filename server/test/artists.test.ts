import { requireAdminUrl, resetDatabase } from "../scripts/db";

process.env.DATABASE_URL = await resetDatabase(requireAdminUrl(), "art_test_artists");
process.env.BETTER_AUTH_URL = "http://localhost:3000";
process.env.BETTER_AUTH_SECRET = "test-secret-test-secret-test-secret-123456";
process.env.PAYSTACK_SECRET_KEY = "sk_test_local";
process.env.RESEND_API_KEY = "re_test";
process.env.EMAIL_FROM = "Art Online <noreply@example.com>";

const recipientsCreated: Array<Record<string, unknown>> = [];
const recipientsDeleted: string[] = [];
const emailsSent: Array<{ to: string; text: string }> = [];
let nextRecipientFails = false;
let recipientCounter = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  if (url.includes("api.resend.com")) {
    const body = JSON.parse(String(init?.body));
    emailsSent.push({ to: body.to[0], text: body.text });
    return new Response("{}", { status: 200 });
  }
  if (url.includes("api.paystack.co/transferrecipient") && (init?.method ?? "GET") === "POST") {
    const body = JSON.parse(String(init?.body));
    if (nextRecipientFails) {
      nextRecipientFails = false;
      return new Response(JSON.stringify({ status: false, message: "Invalid account number" }), { status: 400 });
    }
    recipientCounter += 1;
    recipientsCreated.push(body);
    const bankName = body.bank_code === "MPESA" ? "M-PESA" : "Equity Bank";
    return new Response(
      JSON.stringify({ status: true, message: "ok", data: { recipient_code: `RCP_test${recipientCounter}`, bank_name: bankName } }),
      { status: 200 },
    );
  }
  if (url.includes("api.paystack.co/transferrecipient/") && init?.method === "DELETE") {
    recipientsDeleted.push(url.split("/").pop()!);
    return new Response(JSON.stringify({ status: true, message: "deleted" }), { status: 200 });
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
const { POST: applyPOST, GET: applyGET } = await import("../app/api/artist-applications/route");
const { GET: adminListGET } = await import("../app/api/admin/artist-applications/route");
const { POST: approvePOST } = await import("../app/api/admin/artist-applications/[userId]/approve/route");
const { POST: rejectPOST } = await import("../app/api/admin/artist-applications/[userId]/reject/route");

const ORIGIN = "http://localhost:3000";
const authCall = (path: string, body: unknown, cookie?: string, ip = "10.2.0.1") => {
  const headers: Record<string, string> = { origin: ORIGIN, "content-type": "application/json", "x-forwarded-for": ip };
  if (cookie) headers.cookie = cookie;
  return authPOST(new Request(`${ORIGIN}/api/auth${path}`, { method: "POST", headers, body: JSON.stringify(body) }));
};
const cookieFrom = (res: Response): string => res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
const PW = "correct-horse-battery";

async function signUpVerified(email: string, ip: string): Promise<string> {
  await authCall("/sign-up/email", { name: "Test User", email, password: PW }, undefined, ip);
  const mail = emailsSent.find((m) => m.to === email && /verify-email\?token=/.test(m.text))!;
  const link = mail.text.match(/https?:\/\/\S+verify-email\?\S+/)![0];
  await authGET(new Request(link.replace(/&callbackURL=.*/, ""), { headers: { "x-forwarded-for": ip } }));
  const si = await authCall("/sign-in/email", { email, password: PW }, undefined, ip);
  return cookieFrom(si);
}

const apply = (body: unknown, cookie?: string): Promise<Response> => {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (cookie) headers.cookie = cookie;
  return applyPOST(new Request(`${ORIGIN}/api/artist-applications`, { method: "POST", headers, body: JSON.stringify(body) }));
};
const myStatus = (cookie?: string): Promise<Response> =>
  applyGET(new Request(`${ORIGIN}/api/artist-applications`, { headers: cookie ? { cookie } : {} }));
const adminList = (cookie?: string): Promise<Response> =>
  adminListGET(new Request(`${ORIGIN}/api/admin/artist-applications`, { headers: cookie ? { cookie } : {} }));
const approve = (userId: string, cookie?: string): Promise<Response> =>
  approvePOST(new Request(`${ORIGIN}/x`, { method: "POST", headers: cookie ? { cookie } : {} }), { params: Promise.resolve({ userId }) });
const reject = (userId: string, note: string | null, cookie?: string): Promise<Response> =>
  rejectPOST(new Request(`${ORIGIN}/x`, { method: "POST", headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: JSON.stringify({ note }) }), {
    params: Promise.resolve({ userId }),
  });
const one = async <T = any>(sql: string, p: unknown[] = []): Promise<T> => (await pool.query(sql, p)).rows[0] as T;

const mpesaPayload = { displayName: "Wanjiru Art", bio: "Oil paintings", locationCity: "Nairobi", payoutChannel: "mpesa", payoutAccountName: "Wanjiru Kamau", accountNumber: "0712345678" };

// ---- setup: a buyer, an admin, another buyer
const buyerCookie = await signUpVerified("buyer1@x.ke", "10.2.1.1");
const buyerId = (await one(`SELECT id FROM users WHERE email='buyer1@x.ke'`)).id;
await signUpVerified("admin@x.ke", "10.2.1.2");
await pool.query(`UPDATE users SET role='admin' WHERE email='admin@x.ke'`);
const adminCookie = cookieFrom(await authCall("/sign-in/email", { email: "admin@x.ke", password: PW }, undefined, "10.2.1.3"));
const buyer2Cookie = await signUpVerified("buyer2@x.ke", "10.2.1.4");
const buyer2Id = (await one(`SELECT id FROM users WHERE email='buyer2@x.ke'`)).id;

// ---- auth and validation
check("no session -> 401", (await apply(mpesaPayload)).status === 401);
check("missing displayName -> 400", (await apply({ ...mpesaPayload, displayName: "" }, buyerCookie)).status === 400);
check("bad payoutChannel -> 400", (await apply({ ...mpesaPayload, payoutChannel: "card" }, buyerCookie)).status === 400);
check("bank channel without bankCode -> 400", (await apply({ ...mpesaPayload, payoutChannel: "bank", bankCode: undefined }, buyerCookie)).status === 400);
check("not yet applied -> status null", (await myStatus(buyerCookie).then((r) => r.json())).kycStatus === null);

// ---- Paystack rejects bad account details
nextRecipientFails = true;
const badApp = await apply(mpesaPayload, buyerCookie);
check("Paystack rejection surfaces as 400 with its message, not a generic 500", badApp.status === 400 && (await badApp.text()).includes("Invalid account number"), badApp.status);
check("no artist_profiles row left behind after a failed Paystack call", (await one(`SELECT count(*)::int n FROM artist_profiles WHERE user_id=$1`, [buyerId])).n === 0);

// ---- happy path: mobile money application
const r1 = await apply(mpesaPayload, buyerCookie);
const j1 = await r1.json();
check("mpesa application accepted, recipient created with bank_code MPESA and currency KES", r1.status === 200 && j1.status === "pending" && j1.bankName === "M-PESA", j1);
check("Paystack recipient call used type mobile_money, the correct account number, and did NOT send the public display name as the account name", recipientsCreated[0]?.type === "mobile_money" && recipientsCreated[0]?.account_number === "0712345678" && recipientsCreated[0]?.name === "Wanjiru Kamau", recipientsCreated[0]);
const profile1 = await one(`SELECT display_name, payout_account_last4, payout_bank_name, kyc_status FROM artist_profiles WHERE user_id=$1`, [buyerId]);
check("DB stores only the masked last 4 digits, never the full phone number", profile1.payout_account_last4 === "5678" && profile1.kyc_status === "pending" && profile1.payout_bank_name === "M-PESA", profile1);
check("role is still buyer until approved", (await one(`SELECT role FROM users WHERE id=$1`, [buyerId])).role === "buyer");
check("GET own application reflects pending status", (await myStatus(buyerCookie).then((r) => r.json())).kycStatus === "pending");

// ---- cannot reapply while pending
check("reapplying while pending is blocked (400)", (await apply(mpesaPayload, buyerCookie)).status === 400);

// ---- a non-admin cannot see or act on the admin queue
check("buyer cannot list applications (403)", (await adminList(buyerCookie)).status === 403);
check("buyer cannot approve (403)", (await approve(buyerId, buyerCookie)).status === 403);
check("unauthenticated cannot approve (401)", (await approve(buyerId, undefined)).status === 401);

// ---- admin sees the pending queue
const queue = await adminList(adminCookie).then((r) => r.json());
check("admin queue lists the pending mpesa application", queue.some((a: any) => a.userId === buyerId && a.kycStatus === "pending"), queue);

// ---- admin approves
const approveRes = await approve(buyerId, adminCookie);
check("approve succeeds", approveRes.status === 200, approveRes.status);
check("role flips to artist and kyc_status flips to verified, with a timestamp", (await one(`SELECT role FROM users WHERE id=$1`, [buyerId])).role === "artist" && (await one(`SELECT kyc_status, kyc_verified_at FROM artist_profiles WHERE user_id=$1`, [buyerId])).kyc_status === "verified");
check("approving twice fails cleanly, no pending application left (400)", (await approve(buyerId, adminCookie)).status === 400);
check("now-artist cannot apply again (400, already an artist)", (await apply(mpesaPayload, buyerCookie)).status === 400);

// ---- reject flow on a second applicant, bank channel, with Paystack cleanup
const bankPayload = { displayName: "Otieno Studio", payoutChannel: "bank", payoutAccountName: "James Otieno", accountNumber: "1100229988", bankCode: "068" };
const r2 = await apply(bankPayload, buyer2Cookie);
const j2 = await r2.json();
check("bank-channel application accepted with the bank's returned name", r2.status === 200 && j2.bankName === "Equity Bank", j2);
check("bank recipient call used type kepss and the chosen bank_code", recipientsCreated[1]?.type === "kepss" && recipientsCreated[1]?.bank_code === "068", recipientsCreated[1]);

const rejRes = await reject(buyer2Id, "Could not confirm identity by phone", adminCookie);
check("reject succeeds", rejRes.status === 200, rejRes.status);
const profile2 = await one(`SELECT kyc_status, kyc_note FROM artist_profiles WHERE user_id=$1`, [buyer2Id]);
check("rejected applicant stays a buyer, with the admin's note recorded", profile2.kyc_status === "rejected" && profile2.kyc_note === "Could not confirm identity by phone" && (await one(`SELECT role FROM users WHERE id=$1`, [buyer2Id])).role === "buyer");
check("rejection triggers Paystack recipient cleanup", recipientsDeleted.includes("RCP_test2"), recipientsDeleted);
check("rejected applicant no longer appears in the pending queue", !(await adminList(adminCookie).then((r) => r.json())).some((a: any) => a.userId === buyer2Id));

// ---- reapplying after rejection is allowed and overwrites the old row
const r3 = await apply({ ...bankPayload, displayName: "Otieno Fine Art", accountNumber: "2200998877" }, buyer2Cookie);
check("reapplication after rejection succeeds", r3.status === 200, r3.status);
const profile2b = await one(`SELECT display_name, payout_account_last4, kyc_status, kyc_note FROM artist_profiles WHERE user_id=$1`, [buyer2Id]);
check("reapplication overwrites the previous row: new name, new last4, pending again, old note cleared", profile2b.display_name === "Otieno Fine Art" && profile2b.payout_account_last4 === "8877" && profile2b.kyc_status === "pending" && profile2b.kyc_note === null, profile2b);

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILED`);
await pool.end();
process.exit(failures === 0 ? 0 : 1);
