import { withTransaction } from "@/lib/db";
import { requireRole, errorResponse } from "@/lib/auth/session";
import { approveApplication, ApplicationError } from "@/lib/artists/applications";

export const runtime = "nodejs";

export async function POST(req: Request, { params }: { params: Promise<{ userId: string }> }): Promise<Response> {
  try {
    await requireRole(req.headers, "admin");
  } catch (err) {
    return errorResponse(err);
  }
  const { userId } = await params;
  try {
    await withTransaction((client) => approveApplication(client, userId));
  } catch (err) {
    if (err instanceof ApplicationError) return new Response(err.message, { status: 400 });
    throw err;
  }
  return Response.json({ status: "verified" });
}
