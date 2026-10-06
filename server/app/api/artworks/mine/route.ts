import { withTransaction } from "@/lib/db";
import { requireRole, errorResponse } from "@/lib/auth/session";
import { listMyArtworks } from "@/lib/artworks";

export const runtime = "nodejs";

export async function GET(req: Request): Promise<Response> {
  let user;
  try {
    user = await requireRole(req.headers, "artist");
  } catch (err) {
    return errorResponse(err);
  }
  const artworks = await withTransaction((client) => listMyArtworks(client, user.id));
  return Response.json(artworks);
}
