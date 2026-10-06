import type { PoolClient } from "pg";

export class ArtworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArtworkError";
  }
}

export type FulfillmentType = "physical" | "digital";
export type EditionType = "original" | "limited";

function mapRow(r: any) {
  return {
    id: r.id,
    artistId: r.artist_id,
    title: r.title,
    description: r.description,
    genreId: r.genre_id,
    priceCents: r.price_cents,
    currency: r.currency,
    status: r.status,
    fulfillmentType: r.fulfillment_type,
    editionType: r.edition_type,
    editionSize: r.edition_size,
    editionsSold: r.editions_sold,
    primaryImageUrl: r.primary_image_url,
    createdAt: r.created_at,
  };
}

export interface CreateArtworkArgs {
  artistId: string;
  title: string;
  description: string | null;
  genreId: number;
  priceCents: number;
  fulfillmentType: FulfillmentType;
  editionType: EditionType | null;
  editionSize: number | null;
}

// Single INSERT. The genre_id foreign key is the real safety net here, not a separate
// pre-check, so a deleted-genre race can't slip through: it just fails the insert instead.
export async function createArtwork(client: PoolClient, args: CreateArtworkArgs): Promise<{ id: string }> {
  try {
    const row = await client.query<{ id: string }>(
      `INSERT INTO artworks
         (artist_id, title, description, genre_id, price_cents, currency, status, fulfillment_type, edition_type, edition_size)
       VALUES ($1,$2,$3,$4,$5,'KES','draft',$6,$7,$8)
       RETURNING id`,
      [args.artistId, args.title, args.description, args.genreId, args.priceCents, args.fulfillmentType, args.editionType, args.editionSize],
    );
    return { id: row.rows[0].id };
  } catch (err) {
    if ((err as { code?: string }).code === "23503") throw new ArtworkError("Unknown genre.");
    throw err;
  }
}

export async function listMyArtworks(client: PoolClient, artistId: string): Promise<ReturnType<typeof mapRow>[]> {
  const { rows } = await client.query(`SELECT * FROM artworks WHERE artist_id = $1 ORDER BY created_at DESC`, [artistId]);
  return rows.map(mapRow);
}

export interface Viewer {
  id: string;
  role: string;
}

// Draft and removed artworks are only visible to their owner or an admin. Everyone else gets
// a 404-equivalent null, which is deliberate: an artist's unpublished work isn't even
// confirmable to exist from the outside.
export async function getArtwork(client: PoolClient, artworkId: string, viewer: Viewer | null) {
  const { rows } = await client.query(`SELECT * FROM artworks WHERE id = $1`, [artworkId]);
  const art = rows[0];
  if (!art) return null;

  const isOwner = viewer !== null && viewer.id === art.artist_id;
  const isAdmin = viewer !== null && viewer.role === "admin";
  if (!["listed", "sold"].includes(art.status) && !isOwner && !isAdmin) return null;

  const images = await client.query<{ id: string; url: string; position: number }>(
    `SELECT id, url, position FROM artwork_images WHERE artwork_id = $1 ORDER BY position`,
    [artworkId],
  );
  return { ...mapRow(art), images: images.rows };
}

export interface UpdateArtworkArgs {
  title?: string;
  descriptionProvided?: boolean; // distinguishes "clear the description" from "leave it alone"
  description?: string | null;
  genreId?: number;
  priceCents?: number;
}

const EDITABLE_STATUSES = ["draft", "listed"];

export async function updateArtwork(client: PoolClient, artworkId: string, artistId: string, args: UpdateArtworkArgs): Promise<void> {
  const found = await client.query<{ status: string }>(
    `SELECT status FROM artworks WHERE id = $1 AND artist_id = $2 FOR UPDATE`,
    [artworkId, artistId],
  );
  if (found.rowCount === 0) throw new ArtworkError("Artwork not found.");
  if (!EDITABLE_STATUSES.includes(found.rows[0].status)) {
    throw new ArtworkError(`Cannot edit an artwork that is ${found.rows[0].status}.`);
  }

  try {
    await client.query(
      `UPDATE artworks SET
         title = COALESCE($2, title),
         description = CASE WHEN $3::boolean THEN $4 ELSE description END,
         genre_id = COALESCE($5, genre_id),
         price_cents = COALESCE($6, price_cents),
         updated_at = now()
       WHERE id = $1`,
      [artworkId, args.title ?? null, args.descriptionProvided ?? false, args.description ?? null, args.genreId ?? null, args.priceCents ?? null],
    );
  } catch (err) {
    if ((err as { code?: string }).code === "23503") throw new ArtworkError("Unknown genre.");
    throw err;
  }
}

// Publishing is gated on having at least one photo. Nothing about the upload route forced
// this earlier, so a draft with zero images could otherwise go straight to "listed".
export async function publishArtwork(client: PoolClient, artworkId: string, artistId: string): Promise<void> {
  const found = await client.query<{ status: string }>(
    `SELECT status FROM artworks WHERE id = $1 AND artist_id = $2 FOR UPDATE`,
    [artworkId, artistId],
  );
  if (found.rowCount === 0) throw new ArtworkError("Artwork not found.");
  if (found.rows[0].status !== "draft") {
    throw new ArtworkError(`Only a draft can be published (current status: ${found.rows[0].status}).`);
  }

  const images = await client.query<{ n: string }>(`SELECT count(*) n FROM artwork_images WHERE artwork_id = $1`, [artworkId]);
  if (Number(images.rows[0].n) === 0) throw new ArtworkError("Add at least one photo before publishing.");

  await client.query(`UPDATE artworks SET status = 'listed', updated_at = now() WHERE id = $1`, [artworkId]);
}

// Blocked while any order for this piece is in a non-terminal state (not yet released,
// refunded, or cancelled). A physical piece mid-sale, or a digital edition with a payment
// still being chased down, can't be pulled out from under an active buyer.
export async function archiveArtwork(client: PoolClient, artworkId: string, artistId: string): Promise<void> {
  const found = await client.query<{ status: string }>(
    `SELECT status FROM artworks WHERE id = $1 AND artist_id = $2 FOR UPDATE`,
    [artworkId, artistId],
  );
  if (found.rowCount === 0) throw new ArtworkError("Artwork not found.");
  if (!EDITABLE_STATUSES.includes(found.rows[0].status)) {
    throw new ArtworkError(`Artwork is already ${found.rows[0].status}.`);
  }

  const liveOrder = await client.query(
    `SELECT 1 FROM orders WHERE artwork_id = $1 AND state NOT IN ('released', 'refunded', 'cancelled') LIMIT 1`,
    [artworkId],
  );
  if ((liveOrder.rowCount ?? 0) > 0) throw new ArtworkError("Cannot archive while an order for this piece is still in progress.");

  await client.query(`UPDATE artworks SET status = 'removed', updated_at = now() WHERE id = $1`, [artworkId]);
}
