import { withTransaction } from "@/lib/db";
import { listLocations } from "@/lib/catalog";

export const runtime = "nodejs";
// Reads the database on every request. Without this, Next may run the query once at build time and serve that frozen list.
export const dynamic = "force-dynamic";

// Public. Only cities that currently have at least one listed artwork.
export async function GET(): Promise<Response> {
  const cities = await withTransaction((client) => listLocations(client));
  return Response.json(cities);
}
