import { withTransaction } from "@/lib/db";
import { listGenres } from "@/lib/catalog";

export const runtime = "nodejs";
// Reads the database on every request. Without this, Next may run the query once at build time and serve that frozen list.
export const dynamic = "force-dynamic";

// Public. Lets a frontend populate a genre filter without hardcoding the list.
export async function GET(): Promise<Response> {
  const genres = await withTransaction((client) => listGenres(client));
  return Response.json(genres);
}
