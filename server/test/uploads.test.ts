import { readFileSync } from "node:fs";
import sharp from "sharp";
import { requireAdminUrl, resetDatabase } from "../scripts/db";
import { startTestStorage } from "../scripts/test-storage";

process.env.DATABASE_URL = await resetDatabase(requireAdminUrl(), "art_test_uploads");
const stopStorage = await startTestStorage(4588);
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
const { POST: uploadImagePOST } = await import("../app/api/artworks/[artworkId]/images/route");
const { DELETE: deleteImageDELETE } = await import("../app/api/artworks/[artworkId]/images/[imageId]/route");
const { POST: uploadDocPOST } = await import("../app/api/artist-applications/documents/route");
const { GET: adminDocsGET } = await import("../app/api/admin/artist-applications/[userId]/documents/route");

const ORIGIN = "http://localhost:3000";
const authCall = (path: string, body: unknown, cookie?: string, ip = "10.3.0.1") => {
  const headers: Record<string, string> = { origin: ORIGIN, "content-type": "application/json", "x-forwarded-for": ip };
  if (cookie) headers.cookie = cookie;
  return authPOST(new Request(`${ORIGIN}/api/auth${path}`, { method: "POST", headers, body: JSON.stringify(body) }));
};
const cookieFrom = (res: Response): string => res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
const PW = "correct-horse-battery";
const emailsSent: Array<{ to: string; text: string }> = [];
const realFetchForEmail = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  if (String(input).includes("api.resend.com")) {
    const body = JSON.parse(String(init?.body));
    emailsSent.push({ to: body.to[0], text: body.text });
    return new Response("{}", { status: 200 });
  }
  return realFetchForEmail(input, init);
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

function uploadArtworkImage(artworkId: string, file: File, cookie?: string): Promise<Response> {
  const form = new FormData();
  form.append("file", file);
  return uploadImagePOST(new Request(`${ORIGIN}/x`, { method: "POST", headers: cookie ? { cookie } : {}, body: form }), {
    params: Promise.resolve({ artworkId }),
  });
}
function deleteArtworkImage(artworkId: string, imageId: string, cookie?: string): Promise<Response> {
  return deleteImageDELETE(new Request(`${ORIGIN}/x`, { method: "DELETE", headers: cookie ? { cookie } : {} }), {
    params: Promise.resolve({ artworkId, imageId }),
  });
}
function uploadKycDoc(file: File, cookie?: string): Promise<Response> {
  const form = new FormData();
  form.append("file", file);
  return uploadDocPOST(new Request(`${ORIGIN}/x`, { method: "POST", headers: cookie ? { cookie } : {}, body: form }));
}
function adminDocs(userId: string, cookie?: string): Promise<Response> {
  return adminDocsGET(new Request(`${ORIGIN}/x`, { headers: cookie ? { cookie } : {} }), { params: Promise.resolve({ userId }) });
}

const gpsJpeg = readFileSync("test/fixtures/sample-with-gps.jpg");
const gpsFile = (name = "photo.jpg") => new File([gpsJpeg], name, { type: "image/jpeg" });
const notAnImage = () => new File([Buffer.from("this is definitely not an image")], "fake.jpg", { type: "image/jpeg" });

// ---- setup: an artist with an artwork, a second artist (not the owner), a buyer, an admin
const artistCookie = await signUpVerified("artist@x.ke", "10.3.1.1");
const artistId = (await one(`SELECT id FROM users WHERE email='artist@x.ke'`)).id;
await pool.query(`UPDATE users SET role='artist' WHERE id=$1`, [artistId]);
await pool.query(`INSERT INTO artist_profiles (user_id, display_name) VALUES ($1,'Test Artist')`, [artistId]);
const genre = (await one(`INSERT INTO genres (name, slug) VALUES ('Painting','painting') RETURNING id`)).id;
const artworkId = (await one(`INSERT INTO artworks (artist_id,title,genre_id,price_cents,status,fulfillment_type) VALUES ($1,'Sunset',$2,500000,'listed','physical') RETURNING id`, [artistId, genre])).id;

const otherArtistCookie = await signUpVerified("other-artist@x.ke", "10.3.1.2");
const otherArtistId = (await one(`SELECT id FROM users WHERE email='other-artist@x.ke'`)).id;
await pool.query(`UPDATE users SET role='artist' WHERE id=$1`, [otherArtistId]);
await pool.query(`INSERT INTO artist_profiles (user_id, display_name) VALUES ($1,'Someone Else')`, [otherArtistId]);

const buyerCookie = await signUpVerified("buyer@x.ke", "10.3.1.3");
const buyerId = (await one(`SELECT id FROM users WHERE email='buyer@x.ke'`)).id;

await signUpVerified("admin@x.ke", "10.3.1.4");
await pool.query(`UPDATE users SET role='admin' WHERE email='admin@x.ke'`);
const adminCookie = cookieFrom(await authCall("/sign-in/email", { email: "admin@x.ke", password: PW }, undefined, "10.3.1.5"));

// ==== ARTWORK IMAGES ====
check("no session -> 401", (await uploadArtworkImage(artworkId, gpsFile(), undefined)).status === 401);
check("a buyer (not an artist) is rejected (403)", (await uploadArtworkImage(artworkId, gpsFile(), buyerCookie)).status === 403);
check("an artist who doesn't own this artwork is rejected (403)", (await uploadArtworkImage(artworkId, gpsFile(), otherArtistCookie)).status === 403);
check("a corrupt / non-image file is rejected (400), not silently accepted", (await uploadArtworkImage(artworkId, notAnImage(), artistCookie)).status === 400);

const r1 = await uploadArtworkImage(artworkId, gpsFile(), artistCookie);
const j1 = await r1.json();
check("owner's upload succeeds and returns a usable URL", r1.status === 200 && typeof j1.url === "string", { status: r1.status, j1 });

const stored1 = await one(`SELECT url FROM artwork_images WHERE id=$1`, [j1.id]);
check("stored URL matches the real public base URL and bucket", stored1.url === j1.url && j1.url.startsWith(process.env.R2_PUBLIC_BASE_URL!));
const fetched1 = await fetch(j1.url);
const fetchedBuffer1 = Buffer.from(await fetched1.arrayBuffer());
check("the uploaded image is genuinely fetchable at that public URL, unsigned, the way a browser <img> tag would load it", fetched1.status === 200 && fetchedBuffer1.length > 0, fetched1.status);

const outMeta = await sharp(fetchedBuffer1).metadata();
check("stored format is webp, not the original jpeg (re-encoded, not passed through)", outMeta.format === "webp", outMeta.format);
check("EXIF/GPS metadata is gone from the stored copy", !outMeta.exif, outMeta.exif ? "exif present" : "stripped");
const inMeta = await sharp(gpsJpeg).metadata();
check("the original fixture really did have GPS EXIF (so the strip above is a real test, not a false pass)", !!inMeta.exif);

check("artworks.primary_image_url was set from the first upload", (await one(`SELECT primary_image_url FROM artworks WHERE id=$1`, [artworkId])).primary_image_url === j1.url);

const r2 = await uploadArtworkImage(artworkId, gpsFile("second.jpg"), artistCookie);
const j2 = await r2.json();
check("second image accepted, primary_image_url unchanged (still the first)", r2.status === 200 && (await one(`SELECT primary_image_url FROM artworks WHERE id=$1`, [artworkId])).primary_image_url === j1.url);
check("position increments across images for the same artwork", (await one(`SELECT position FROM artwork_images WHERE id=$1`, [j2.id])).position === 1);

for (let i = 0; i < 6; i++) await uploadArtworkImage(artworkId, gpsFile(`extra${i}.jpg`), artistCookie);
const overLimit = await uploadArtworkImage(artworkId, gpsFile("one-too-many.jpg"), artistCookie);
check("the 9th image is rejected, 8-per-artwork cap enforced", overLimit.status === 400, overLimit.status);

check("a non-owner cannot delete this artwork's image (403)", (await deleteArtworkImage(artworkId, j1.id, otherArtistCookie)).status === 403);
const del1 = await deleteArtworkImage(artworkId, j1.id, artistCookie);
check("owner can delete an image", del1.status === 200, del1.status);
check("deleting the primary image promotes the next one, not left dangling", (await one(`SELECT primary_image_url FROM artworks WHERE id=$1`, [artworkId])).primary_image_url === j2.url);
const afterDeleteFetch = await fetch(j1.url);
check("the R2 object itself is actually gone after delete, not just the DB row", afterDeleteFetch.status !== 200, afterDeleteFetch.status);

// ==== KYC DOCUMENTS ====
check("uploading a KYC doc before applying as an artist is rejected (400)", (await uploadKycDoc(gpsFile(), buyerCookie)).status === 400);

await pool.query(`INSERT INTO artist_profiles (user_id, display_name, kyc_status) VALUES ($1,'Buyer Applying','pending')`, [buyerId]);
const kyc1 = await uploadKycDoc(gpsFile("id-front.jpg"), buyerCookie);
check("KYC upload accepted for a pending applicant", kyc1.status === 200, kyc1.status);
check("a corrupt file is rejected for KYC too (400)", (await uploadKycDoc(notAnImage(), buyerCookie)).status === 400);

const docRow = await one(`SELECT storage_key, file_type FROM kyc_documents WHERE user_id=$1`, [buyerId]);
check("KYC document stored under the private bucket's key prefix, not the public one", docRow.storage_key.startsWith(`kyc/${buyerId}/`));
const directPublicAttempt = await fetch(`${process.env.R2_PUBLIC_BASE_URL}/${docRow.storage_key}`);
check("the KYC document is NOT reachable through the public bucket URL", directPublicAttempt.status !== 200, directPublicAttempt.status);

check("a buyer cannot list their own KYC docs via the admin route (403)", (await adminDocs(buyerId, buyerCookie)).status === 403);
const adminView = await adminDocs(buyerId, adminCookie);
const adminViewJson = await adminView.json();
check("admin can list the applicant's documents with a signed download URL", adminView.status === 200 && adminViewJson.length === 1 && typeof adminViewJson[0].downloadUrl === "string", adminViewJson);

const signedFetch = await fetch(adminViewJson[0].downloadUrl);
const signedBuffer = Buffer.from(await signedFetch.arrayBuffer());
check("the signed URL actually downloads the real file bytes", signedFetch.status === 200 && signedBuffer.length === gpsJpeg.length, signedFetch.status);

const kycMeta = await sharp(signedBuffer).metadata();
check("KYC document is stored unmodified (still a jpeg, EXIF intact), unlike the artwork pipeline", kycMeta.format === "jpeg" && !!kycMeta.exif, kycMeta);

for (let i = 0; i < 4; i++) await uploadKycDoc(gpsFile(`extra-doc-${i}.jpg`), buyerCookie);
const tooManyDocs = await uploadKycDoc(gpsFile("one-too-many-doc.jpg"), buyerCookie);
check("KYC document cap enforced (max 5)", tooManyDocs.status === 400, tooManyDocs.status);

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILED`);
await stopStorage();
await pool.end();
process.exit(failures === 0 ? 0 : 1);
