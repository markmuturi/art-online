import { withTransaction } from "@/lib/db";
import { requireRole, errorResponse } from "@/lib/auth/session";
import { archiveArtwork, ArtworkError } from "@/lib/artworks";

export const runtime = "nodejs";

export async function POST(req: Request, { params }: { params: Promise<{ artworkId: string }> }): Promise<Response> {
  let user;
  try {
    user = await requireRole(req.headers, "artist");
  } catch (err) {
    return errorResponse(err);
  }
  const { artworkId } = await params;
  try {
    await withTransaction((client) => archiveArtwork(client, artworkId, user.id));
  } catch (err) {
    if (err instanceof ArtworkError) return new Response(err.message, { status: 400 });
    throw err;
  }
  return Response.json({ status: "removed" });
}
