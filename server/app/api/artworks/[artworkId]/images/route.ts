import { randomUUID } from "node:crypto";
import { pool, alertAdmin } from "@/lib/db";
import { requireRole, errorResponse } from "@/lib/auth/session";
import { processPublicImage, InvalidImageError } from "@/lib/images";
import { uploadPublicObject } from "@/lib/storage";

export const runtime = "nodejs";

const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;
const MAX_IMAGES_PER_ARTWORK = 8;

export async function POST(req: Request, { params }: { params: Promise<{ artworkId: string }> }): Promise<Response> {
  let user;
  try {
    user = await requireRole(req.headers, "artist");
  } catch (err) {
    return errorResponse(err);
  }
  const { artworkId } = await params;

  const owner = await pool.query<{ artist_id: string }>(`SELECT artist_id FROM artworks WHERE id = $1`, [artworkId]);
  if (owner.rowCount === 0) return new Response("Artwork not found.", { status: 404 });
  if (owner.rows[0].artist_id !== user.id) return new Response("You don't own this artwork.", { status: 403 });

  const count = await pool.query<{ n: string }>(`SELECT count(*) n FROM artwork_images WHERE artwork_id = $1`, [artworkId]);
  if (Number(count.rows[0].n) >= MAX_IMAGES_PER_ARTWORK) {
    return new Response(`Maximum of ${MAX_IMAGES_PER_ARTWORK} images per artwork.`, { status: 400 });
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
  let processed;
  try {
    processed = await processPublicImage(raw);
  } catch (err) {
    if (err instanceof InvalidImageError) return new Response(err.message, { status: 400 });
    throw err;
  }

  // Key is built from a server-generated UUID, never from the client's filename, so nothing
  // about the request body influences where the object lands in the bucket.
  const key = `artworks/${artworkId}/${randomUUID()}.${processed.extension}`;
  const url = await uploadPublicObject(key, processed.buffer, processed.contentType);

  try {
    const row = await pool.query<{ id: string }>(
      `INSERT INTO artwork_images (artwork_id, url, position)
       SELECT $1, $2, COALESCE(MAX(position) + 1, 0) FROM artwork_images WHERE artwork_id = $1
       RETURNING id`,
      [artworkId, url],
    );
    await pool.query(`UPDATE artworks SET primary_image_url = COALESCE(primary_image_url, $2) WHERE id = $1`, [artworkId, url]);
    return Response.json({ id: row.rows[0].id, url });
  } catch (err) {
    alertAdmin(`Uploaded ${key} to R2 but the database write failed for artwork ${artworkId}`, err);
    throw err;
  }
}
