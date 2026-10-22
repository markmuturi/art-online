import { withTransaction } from "@/lib/db";
import { requireRole, errorResponse } from "@/lib/auth/session";
import { createArtwork, ArtworkError, type FulfillmentType, type EditionType } from "@/lib/artworks";
import { browseArtworks, type SortOption } from "@/lib/catalog";

export const runtime = "nodejs";

const MIN_PRICE_CENTS = 100; // KES 1.00
const MAX_PRICE_CENTS = 500_000_00; // KES 500,000: a typo guard, not a real business ceiling

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SORT_OPTIONS: SortOption[] = ["newest", "price_asc", "price_desc"];

// Public, no auth. This is how a buyer actually finds something to check out with: every test
// up to now seeded an artworkId directly, nothing before this could discover one.
export async function GET(req: Request): Promise<Response> {
  const sp = new URL(req.url).searchParams;

  const sortRaw = sp.get("sort") ?? "newest";
  if (!SORT_OPTIONS.includes(sortRaw as SortOption)) {
    return new Response(`sort must be one of: ${SORT_OPTIONS.join(", ")}.`, { status: 400 });
  }

  let limit = 20;
  const limitRaw = sp.get("limit");
  if (limitRaw !== null) {
    const n = Number(limitRaw);
    if (!Number.isInteger(n) || n < 1 || n > 50) return new Response("limit must be an integer between 1 and 50.", { status: 400 });
    limit = n;
  }

  let offset = 0;
  const offsetRaw = sp.get("offset");
  if (offsetRaw !== null) {
    const n = Number(offsetRaw);
    if (!Number.isInteger(n) || n < 0 || n > 10_000) return new Response("offset must be an integer between 0 and 10000.", { status: 400 });
    offset = n;
  }

  const artistId = sp.get("artistId") ?? undefined;
  if (artistId !== undefined && !UUID_RE.test(artistId)) return new Response("artistId must be a valid UUID.", { status: 400 });

  const fulfillmentType = sp.get("fulfillmentType") ?? undefined;
  if (fulfillmentType !== undefined && fulfillmentType !== "physical" && fulfillmentType !== "digital") {
    return new Response("fulfillmentType must be 'physical' or 'digital'.", { status: 400 });
  }

  const includeSoldRaw = sp.get("includeSold");
  if (includeSoldRaw !== null && includeSoldRaw !== "true" && includeSoldRaw !== "false") {
    return new Response("includeSold must be 'true' or 'false'.", { status: 400 });
  }

  const result = await withTransaction((client) =>
    browseArtworks(client, {
      genreSlug: sp.get("genre") ?? undefined,
      location: sp.get("location")?.trim().slice(0, 100) || undefined,
      artistId,
      fulfillmentType: fulfillmentType as "physical" | "digital" | undefined,
      includeSold: includeSoldRaw === "true",
      q: sp.get("q")?.trim().slice(0, 200) || undefined,
      sort: sortRaw as SortOption,
      limit,
      offset,
    }),
  );
  return Response.json(result);
}

interface CreateBody {
  title?: unknown;
  description?: unknown;
  genreId?: unknown;
  priceCents?: unknown;
  fulfillmentType?: unknown;
  editionType?: unknown;
  editionSize?: unknown;
}

export async function POST(req: Request): Promise<Response> {
  let user;
  try {
    user = await requireRole(req.headers, "artist");
  } catch (err) {
    return errorResponse(err);
  }

  let body: CreateBody;
  try {
    body = await req.json();
  } catch {
    return new Response("Invalid JSON body", { status: 400 });
  }

  const title = typeof body.title === "string" ? body.title.trim() : "";
  if (title.length < 2 || title.length > 200) return new Response("title must be 2-200 characters.", { status: 400 });

  const description = typeof body.description === "string" && body.description.trim() ? body.description.trim().slice(0, 5000) : null;

  const genreId = typeof body.genreId === "number" ? body.genreId : NaN;
  if (!Number.isInteger(genreId)) return new Response("genreId is required.", { status: 400 });

  const priceCents = typeof body.priceCents === "number" ? body.priceCents : NaN;
  if (!Number.isInteger(priceCents) || priceCents < MIN_PRICE_CENTS || priceCents > MAX_PRICE_CENTS) {
    return new Response(`priceCents must be an integer between ${MIN_PRICE_CENTS} and ${MAX_PRICE_CENTS}.`, { status: 400 });
  }

  if (body.fulfillmentType !== "physical" && body.fulfillmentType !== "digital") {
    return new Response("fulfillmentType must be 'physical' or 'digital'.", { status: 400 });
  }
  const fulfillmentType = body.fulfillmentType as FulfillmentType;

  let editionType: EditionType | null = null;
  let editionSize: number | null = null;
  if (fulfillmentType === "digital") {
    if (body.editionType !== "original" && body.editionType !== "limited") {
      return new Response("editionType must be 'original' or 'limited' for a digital artwork.", { status: 400 });
    }
    editionType = body.editionType;
    if (editionType === "original") {
      editionSize = 1; // matches the DB's original_edition_is_one constraint, set server-side regardless of client input
    } else {
      const size = typeof body.editionSize === "number" ? body.editionSize : NaN;
      if (!Number.isInteger(size) || size < 1) {
        return new Response("editionSize must be a positive integer for a limited edition.", { status: 400 });
      }
      editionSize = size;
    }
  } else if (body.editionType !== undefined || body.editionSize !== undefined) {
    return new Response("editionType/editionSize only apply to digital artworks.", { status: 400 });
  }

  try {
    const art = await withTransaction((client) =>
      createArtwork(client, { artistId: user.id, title, description, genreId, priceCents, fulfillmentType, editionType, editionSize }),
    );
    return Response.json({ id: art.id, status: "draft" });
  } catch (err) {
    if (err instanceof ArtworkError) return new Response(err.message, { status: 400 });
    throw err;
  }
}