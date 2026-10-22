import Link from "next/link";
import { withTransaction } from "@/lib/db";
import { browseArtworks, listGenres, listLocations, type SortOption } from "@/lib/catalog";
import { formatKes } from "@/lib/format";
import { isUuid } from "@/lib/ids";

// Depends on the query string and the database, so it is rendered per request, never at build time.
export const dynamic = "force-dynamic";

const PAGE_SIZE = 24;
const MAX_PAGE = 400; // 24 x 400 stays under the API's 10,000 offset cap
const SORTS: Array<{ value: SortOption; label: string }> = [
  { value: "newest", label: "Newest first" },
  { value: "price_asc", label: "Price, low to high" },
  { value: "price_desc", label: "Price, high to low" },
];

type Params = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

export default async function Home({ searchParams }: { searchParams: Promise<Params> }) {
  const sp = await searchParams;

  // Anything unrecognised in the URL is ignored rather than turned into an error page.
  const genre = one(sp.genre)?.slice(0, 80) || undefined;
  const location = one(sp.location)?.slice(0, 100) || undefined;
  const q = one(sp.q)?.trim().slice(0, 200) || undefined;
  const sortRaw = one(sp.sort);
  const sort: SortOption = SORTS.some((s) => s.value === sortRaw) ? (sortRaw as SortOption) : "newest";
  const kindRaw = one(sp.kind);
  const fulfillmentType = kindRaw === "physical" || kindRaw === "digital" ? kindRaw : undefined;
  const artistRaw = one(sp.artist);
  const artistId = artistRaw && isUuid(artistRaw) ? artistRaw : undefined;
  const page = Math.min(MAX_PAGE, Math.max(1, Number.parseInt(one(sp.page) ?? "1", 10) || 1));

  const { result, genres, cities } = await withTransaction(async (client) => {
    const result = await browseArtworks(client, {
      genreSlug: genre,
      location,
      artistId,
      fulfillmentType,
      q,
      sort,
      limit: PAGE_SIZE,
      offset: (page - 1) * PAGE_SIZE,
    });
    return { result, genres: await listGenres(client), cities: await listLocations(client) };
  });

  const active = { genre, location, q, sort: sort === "newest" ? undefined : sort, kind: fulfillmentType, artist: artistId };
  const hasFilters = Object.values(active).some(Boolean);
  const pageHref = (n: number): string => {
    const p = new URLSearchParams();
    for (const [key, value] of Object.entries(active)) if (value) p.set(key, value);
    if (n > 1) p.set("page", String(n));
    const qs = p.toString();
    return qs ? `/?${qs}` : "/";
  };

  const totalPages = Math.max(1, Math.ceil(result.totalCount / PAGE_SIZE));
  const first = result.totalCount === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const last = Math.min(page * PAGE_SIZE, result.totalCount);
  const artistName = artistId ? result.items[0]?.artist.displayName : undefined;

  return (
    <>
      <h1 className="intro">Original work, sold directly by the artists who made it.</h1>

      <form className="filters" method="get" action="/">
        {artistId && <input type="hidden" name="artist" value={artistId} />}
        <label>
          Search
          <input type="search" name="q" defaultValue={q} placeholder="Title or artist" />
        </label>
        <label>
          Genre
          <select name="genre" defaultValue={genre ?? ""}>
            <option value="">All genres</option>
            {genres.map((g) => (
              <option key={g.id} value={g.slug}>{g.name}</option>
            ))}
          </select>
        </label>
        <label>
          City
          <select name="location" defaultValue={location ?? ""}>
            <option value="">All cities</option>
            {cities.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        </label>
        <label>
          Kind
          <select name="kind" defaultValue={fulfillmentType ?? ""}>
            <option value="">Physical and digital</option>
            <option value="physical">Physical work</option>
            <option value="digital">Digital file</option>
          </select>
        </label>
        <label>
          Sort
          <select name="sort" defaultValue={sort}>
            {SORTS.map((s) => (
              <option key={s.value} value={s.value}>{s.label}</option>
            ))}
          </select>
        </label>
        <button className="button" type="submit">Search</button>
        {hasFilters && <Link className="clear" href="/">Clear filters</Link>}
      </form>

      {artistName && <p className="result-count">Work by {artistName}</p>}
      {result.items.length > 0 && (
        <p className="result-count">{`Showing ${first} to ${last} of ${result.totalCount}`}</p>
      )}

      {result.items.length === 0 ? (
        <div className="empty">
          {result.totalCount > 0 ? (
            <>
              <p>There is nothing further on this page.</p>
              <p><Link href={pageHref(1)}>Back to the first page</Link></p>
            </>
          ) : hasFilters ? (
            <>
              <p>Nothing matches those filters.</p>
              <p><Link href="/">Show everything</Link></p>
            </>
          ) : (
            <p>No artworks are listed yet. Check back soon.</p>
          )}
        </div>
      ) : (
        <ul className="wall">
          {result.items.map((a) => (
            <li className="work" key={a.id}>
              <Link href={`/artworks/${a.id}`}>
                <div className="frame">
                  {a.primaryImageUrl ? (
                    <img src={a.primaryImageUrl} alt={`${a.title} by ${a.artist.displayName}`} loading="lazy" />
                  ) : (
                    <span className="noimage">No photo yet</span>
                  )}
                </div>
                <div className="label">
                  <p>{a.artist.displayName}</p>
                  <p className="title">{a.title}</p>
                  <p className="detail">{a.genre.name}{a.artist.locationCity ? `, ${a.artist.locationCity}` : ""}</p>
                  <p className="detail">{a.fulfillmentType === "digital" ? "Digital file" : "Physical work"}</p>
                  <p className="price">{formatKes(a.priceCents)}</p>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}

      {totalPages > 1 && (
        <nav className="pager" aria-label="Pages">
          {page > 1 ? <Link href={pageHref(page - 1)}>Previous page</Link> : <span aria-disabled="true">Previous page</span>}
          {page < totalPages ? <Link href={pageHref(page + 1)}>Next page</Link> : <span aria-disabled="true">Next page</span>}
        </nav>
      )}
    </>
  );
}
