import { withTransaction } from "@/lib/db";
import { requireRole, errorResponse } from "@/lib/auth/session";
import { listPendingApplications } from "@/lib/artists/applications";

export const runtime = "nodejs";

export async function GET(req: Request): Promise<Response> {
  try {
    await requireRole(req.headers, "admin");
  } catch (err) {
    return errorResponse(err);
  }
  const apps = await withTransaction((client) => listPendingApplications(client));
  return Response.json(apps);
}
