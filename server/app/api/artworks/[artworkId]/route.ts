import { withTransaction } from "@/lib/db";
import { getSessionUser } from "@/lib/auth/session";
import { getArtwork, updateArtwork, ArtworkError } from "@/lib/artworks";

export const runtime = "nodejs";

// No auth required: anonymous browsing must be able to see a listed artwork. The visibility
// rule (draft/removed hidden from non-owners) lives inside getArtwork, not here.
export async function GET(req: Request, { params }: { params: Promise<{ artworkId: string }> }): Promise<Response> {
  const viewer = await getSessionUser(req.headers);
  const { artworkId } = await params;
  const art = await withTransaction((client) => getArtwork(client, artworkId, viewer));
  if (!art) return new Response("Not found.", { status: 404 });
  return Response.json(art);
}

interface PatchBody {
  title?: unknown;
  description?: unknown;
  genreId?: unknown;
  priceCents?: unknown;
}

export async function PATCH(req: Request, { params }: { params: Promise<{ artworkId: string }> }): Promise<Response> {
  const viewer = await getSessionUser(req.headers);
  if (!viewer) return new Response("Sign in required", { status: 401 });
  const { artworkId } = await params;

  let body: PatchBody;
  try {
    body = await req.json();
  } catch {
    return new Response("Invalid JSON body", { status: 400 });
  }

  if (body.title !== undefined && (typeof body.title !== "string" || body.title.trim().length < 2 || body.title.trim().length > 200)) {
    return new Response("title must be 2-200 characters.", { status: 400 });
  }
  if (body.genreId !== undefined && !Number.isInteger(body.genreId)) {
    return new Response("genreId must be an integer.", { status: 400 });
  }
  if (body.priceCents !== undefined && (!Number.isInteger(body.priceCents) || (body.priceCents as number) < 100)) {
    return new Response("priceCents must be a positive integer.", { status: 400 });
  }
  if (body.description !== undefined && body.description !== null && typeof body.description !== "string") {
    return new Response("description must be a string or null.", { status: 400 });
  }

  try {
    await withTransaction((client) =>
      updateArtwork(client, artworkId, viewer.id, {
        title: typeof body.title === "string" ? body.title.trim() : undefined,
        descriptionProvided: body.description !== undefined,
        description: typeof body.description === "string" ? body.description.trim().slice(0, 5000) : null,
        genreId: body.genreId as number | undefined,
        priceCents: body.priceCents as number | undefined,
      }),
    );
  } catch (err) {
    if (err instanceof ArtworkError) return new Response(err.message, { status: 400 });
    throw err;
  }
  return Response.json({ updated: true });
}
