import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { notFound } from "next/navigation";
import { cache } from "react";
import { getSessionUser } from "@/lib/auth/session";
import { getArtwork } from "@/lib/artworks";
import { withTransaction } from "@/lib/db";
import { formatKes } from "@/lib/format";
import { isUuid } from "@/lib/ids";

export const dynamic = "force-dynamic";

// cache() lets generateMetadata and the page share one lookup instead of querying twice.
const load = cache(async (artworkId: string) => {
  const user = await getSessionUser(new Headers(await headers()));
  const viewer = user ? { id: user.id, role: user.role } : null;
  return withTransaction((client) => getArtwork(client, artworkId, viewer));
});

type Props = { params: Promise<{ artworkId: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { artworkId } = await params;
  if (!isUuid(artworkId)) return { title: "Not found" };
  const art = await load(artworkId);
  if (!art) return { title: "Not found" };
  return {
    title: `${art.title} by ${art.artist.displayName}`,
    description: art.description?.slice(0, 160) ?? `${art.title}, ${art.genre.name} by ${art.artist.displayName}.`,
    openGraph: art.primaryImageUrl ? { images: [art.primaryImageUrl] } : undefined,
  };
}

function availability(art: NonNullable<Awaited<ReturnType<typeof load>>>): { text: string; unavailable: boolean } {
  if (art.status === "draft") return { text: "Draft. Only you can see this.", unavailable: true };
  if (art.status === "removed") return { text: "Removed. Only you can see this.", unavailable: true };
  if (art.available) return { text: "Available", unavailable: false };
  return { text: art.fulfillmentType === "digital" ? "Sold out" : "Sold, or held by another buyer", unavailable: true };
}

export default async function ArtworkPage({ params }: Props) {
  const { artworkId } = await params;
  if (!isUuid(artworkId)) notFound();
  const art = await load(artworkId);
  if (!art) notFound();

  const status = availability(art);
  const edition =
    art.fulfillmentType !== "digital"
      ? null
      : art.editionType === "original"
        ? "Unique digital original"
        : `Edition of ${art.editionSize}, ${Math.max(0, (art.editionSize ?? 0) - art.editionsSold)} left`;

  return (
    <div className="piece">
      <div>
        {art.images.length === 0 ? (
          <p className="nophoto">No photos yet.</p>
        ) : (
          art.images.map((img) => (
            <figure key={img.id}>
              <img src={img.url} alt={`${art.title} by ${art.artist.displayName}`} />
            </figure>
          ))
        )}
      </div>

      <aside>
        <h1>{art.title}</h1>
        <p className="by">
          <Link href={`/?artist=${art.artistId}`}>{art.artist.displayName}</Link>
        </p>

        <dl className="facts">
          <dt>Genre</dt>
          <dd>{art.genre.name}</dd>
          {art.artist.locationCity && (
            <>
              <dt>Artist based in</dt>
              <dd>{art.artist.locationCity}</dd>
            </>
          )}
          <dt>Format</dt>
          <dd>{art.fulfillmentType === "digital" ? "Digital file" : "Physical work, shipped to you"}</dd>
          {edition && (
            <>
              <dt>Edition</dt>
              <dd>{edition}</dd>
            </>
          )}
        </dl>

        <p className="price-large">{formatKes(art.priceCents)}</p>
        <p className={status.unavailable ? "status unavailable" : "status"}>{status.text}</p>

        {art.description && <p className="description">{art.description}</p>}

        <Link className="back" href="/">Back to all work</Link>
      </aside>
    </div>
  );
}
