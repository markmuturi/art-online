import type { PoolClient } from "pg";

export type SortOption = "newest" | "price_asc" | "price_desc";

export interface BrowseFilters {
  genreSlug?: string;
  location?: string;
  artistId?: string;
  fulfillmentType?: "physical" | "digital";
  q?: string;
  sort: SortOption;
  limit: number;
  offset: number;
}

function mapCatalogRow(r: any) {
  return {
    id: r.id,
    title: r.title,
    priceCents: r.price_cents,
    currency: r.currency,
    fulfillmentType: r.fulfillment_type,
    primaryImageUrl: r.primary_image_url,
    createdAt: r.created_at,
    genre: { name: r.genre_name, slug: r.genre_slug },
    artist: { id: r.artist_id, displayName: r.artist_display_name, locationCity: r.artist_location_city },
  };
}

const ORDER_BY: Record<SortOption, string> = {
  newest: "a.created_at DESC, a.id",
  price_asc: "a.price_cents ASC, a.id",
  price_desc: "a.price_cents DESC, a.id",
};

// Public catalog search. Only ever reads artist_profiles.display_name and .location_city,
// listed explicitly rather than selected with a wildcard: the same table also holds payout
// and KYC fields that must never reach an anonymous response.
//
// The trailing ", a.id" in every ORDER BY is a tiebreaker. Without it, two artworks with the
// same price (or created in the same instant) have no defined relative order, and paging with
// LIMIT/OFFSET can then show one twice and skip another.
export async function browseArtworks(client: PoolClient, filters: BrowseFilters) {
  const conditions: string[] = [`a.status = 'listed'`];
  const params: unknown[] = [];

  if (filters.genreSlug) {
    params.push(filters.genreSlug);
    conditions.push(`g.slug = $${params.length}`);
  }
  if (filters.location) {
    params.push(`%${escapeLike(filters.location)}%`);
    conditions.push(`ap.location_city ILIKE $${params.length}`);
  }
  if (filters.artistId) {
    params.push(filters.artistId);
    conditions.push(`a.artist_id = $${params.length}`);
  }
  if (filters.fulfillmentType) {
    params.push(filters.fulfillmentType);
    conditions.push(`a.fulfillment_type = $${params.length}`);
  }
  if (filters.q) {
    params.push(`%${escapeLike(filters.q)}%`);
    conditions.push(`(a.title ILIKE $${params.length} OR ap.display_name ILIKE $${params.length})`);
  }

  const fromWhere = `FROM artworks a
       JOIN genres g ON g.id = a.genre_id
       JOIN artist_profiles ap ON ap.user_id = a.artist_id
      WHERE ${conditions.join(" AND ")}`;
  const filterParams = [...params];

  params.push(filters.limit);
  const limitParam = params.length;
  params.push(filters.offset);
  const offsetParam = params.length;

  // count(*) OVER() rides along in the same query instead of costing a second round trip.
  const { rows } = await client.query(
    `SELECT a.id, a.title, a.price_cents, a.currency, a.fulfillment_type, a.primary_image_url, a.created_at,
            g.name AS genre_name, g.slug AS genre_slug,
            ap.user_id AS artist_id, ap.display_name AS artist_display_name, ap.location_city AS artist_location_city,
            count(*) OVER() AS total_count
       ${fromWhere}
      ORDER BY ${ORDER_BY[filters.sort]}
      LIMIT $${limitParam} OFFSET $${offsetParam}`,
    params,
  );

  let totalCount = rows[0] ? Number(rows[0].total_count) : 0;
  // A page past the end returns no rows, so the window count above has nothing to ride on and
  // would wrongly report 0. In that one case, ask for the real total separately.
  if (rows.length === 0 && filters.offset > 0) {
    const counted = await client.query<{ n: string }>(`SELECT count(*) AS n ${fromWhere}`, filterParams);
    totalCount = Number(counted.rows[0].n);
  }

  return {
    items: rows.map(mapCatalogRow),
    totalCount,
    limit: filters.limit,
    offset: filters.offset,
  };
}

// ILIKE treats % and _ as wildcards. A search for "100%" or "a_b" should match those literal
// characters, not turn into a pattern. This is not an injection risk (the value is always
// bound as a parameter), it is a correctness one: unescaped, searching "%" matches everything.
function escapeLike(input: string): string {
  return input.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export async function listGenres(client: PoolClient): Promise<Array<{ id: number; name: string; slug: string }>> {
  const { rows } = await client.query(`SELECT id, name, slug FROM genres ORDER BY name`);
  return rows;
}

// Only cities that currently have at least one LISTED artwork. A location filter that leads
// to zero results is worse than not offering it at all.
export async function listLocations(client: PoolClient): Promise<string[]> {
  const { rows } = await client.query<{ city: string }>(
    `SELECT DISTINCT ap.location_city AS city
       FROM artist_profiles ap
       JOIN artworks a ON a.artist_id = ap.user_id AND a.status = 'listed'
      WHERE ap.location_city IS NOT NULL
      ORDER BY city`,
  );
  return rows.map((r) => r.city);
}
