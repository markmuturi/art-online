import { pool, alertAdmin } from "@/lib/db";
import { requireRole, errorResponse } from "@/lib/auth/session";
import { deletePublicObject } from "@/lib/storage";

export const runtime = "nodejs";

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ artworkId: string; imageId: string }> },
): Promise<Response> {
  let user;
  try {
    user = await requireRole(req.headers, "artist");
  } catch (err) {
    return errorResponse(err);
  }
  const { artworkId, imageId } = await params;

  const owner = await pool.query<{ artist_id: string }>(`SELECT artist_id FROM artworks WHERE id = $1`, [artworkId]);
  if (owner.rowCount === 0) return new Response("Artwork not found.", { status: 404 });
  if (owner.rows[0].artist_id !== user.id) return new Response("You don't own this artwork.", { status: 403 });

  const img = await pool.query<{ url: string }>(
    `DELETE FROM artwork_images WHERE id = $1 AND artwork_id = $2 RETURNING url`,
    [imageId, artworkId],
  );
  if (img.rowCount === 0) return new Response("Image not found.", { status: 404 });

  // If the deleted image was the primary one, fall back to whatever's left.
  const current = await pool.query<{ primary_image_url: string | null }>(`SELECT primary_image_url FROM artworks WHERE id = $1`, [artworkId]);
  if (current.rows[0]?.primary_image_url === img.rows[0].url) {
    const next = await pool.query<{ url: string }>(
      `SELECT url FROM artwork_images WHERE artwork_id = $1 ORDER BY position LIMIT 1`,
      [artworkId],
    );
    await pool.query(`UPDATE artworks SET primary_image_url = $2 WHERE id = $1`, [artworkId, next.rows[0]?.url ?? null]);
  }

  const key = img.rows[0].url.replace(`${process.env.R2_PUBLIC_BASE_URL}/`, "");
  try {
    await deletePublicObject(key);
  } catch (err) {
    alertAdmin(`Database row for image ${imageId} deleted but the R2 object ${key} could not be removed`, err);
  }

  return Response.json({ deleted: true });
}
