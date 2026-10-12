import { withTransaction } from "@/lib/db";
import { listGenres } from "@/lib/catalog";

export const runtime = "nodejs";

// Public. Lets a frontend populate a genre filter without hardcoding the list.
export async function GET(): Promise<Response> {
  const genres = await withTransaction((client) => listGenres(client));
  return Response.json(genres);
}
