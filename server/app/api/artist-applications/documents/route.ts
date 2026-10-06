import { randomUUID } from "node:crypto";
import { pool, alertAdmin } from "@/lib/db";
import { requireUser, errorResponse } from "@/lib/auth/session";
import { validateKycImage, InvalidImageError } from "@/lib/images";
import { uploadPrivateObject } from "@/lib/storage";

export const runtime = "nodejs";

const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;
const MAX_DOCS_PER_USER = 5;

export async function POST(req: Request): Promise<Response> {
  let user;
  try {
    user = await requireUser(req.headers);
  } catch (err) {
    return errorResponse(err);
  }

  const existing = await pool.query<{ kyc_status: string }>(`SELECT kyc_status FROM artist_profiles WHERE user_id = $1`, [user.id]);
  const status = existing.rows[0]?.kyc_status;
  if (!status) return new Response("Apply as an artist before uploading documents.", { status: 400 });
  if (status === "verified") return new Response("You're already a verified artist.", { status: 400 });

  const count = await pool.query<{ n: string }>(`SELECT count(*) n FROM kyc_documents WHERE user_id = $1`, [user.id]);
  if (Number(count.rows[0].n) >= MAX_DOCS_PER_USER) {
    return new Response(`Maximum of ${MAX_DOCS_PER_USER} documents.`, { status: 400 });
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return new Response("Expected multipart/form-data with a 'file' field.", { status: 400 });
  }
  const file = form.get("file");
  if (!(file instanceof File)) return new Response("Missing 'file' field.", { status: 400 });
  if (file.size > MAX_UPLOAD_BYTES) {
    return new Response(`File too large, ${MAX_UPLOAD_BYTES / 1024 / 1024}MB max.`, { status: 413 });
  }

  const raw = Buffer.from(await file.arrayBuffer());
  let validated;
  try {
    validated = await validateKycImage(raw);
  } catch (err) {
    if (err instanceof InvalidImageError) return new Response(err.message, { status: 400 });
    throw err;
  }

  const key = `kyc/${user.id}/${randomUUID()}.${validated.extension}`;
  try {
    await uploadPrivateObject(key, validated.buffer, validated.contentType);
  } catch {
    return new Response("Could not store the document. Try again.", { status: 502 });
  }

  try {
    await pool.query(
      `INSERT INTO kyc_documents (user_id, storage_key, file_type, file_size_bytes) VALUES ($1,$2,$3,$4)`,
      [user.id, key, validated.contentType, raw.length],
    );
  } catch (err) {
    alertAdmin(`KYC document uploaded to R2 at ${key} but the database write failed for user ${user.id}`, err);
    throw err;
  }

  return Response.json({ uploaded: true });
}
