import { withTransaction } from "@/lib/db";
import { listLocations } from "@/lib/catalog";

export const runtime = "nodejs";

// Public. Only cities that currently have at least one listed artwork.
export async function GET(): Promise<Response> {
  const cities = await withTransaction((client) => listLocations(client));
  return Response.json(cities);
}
