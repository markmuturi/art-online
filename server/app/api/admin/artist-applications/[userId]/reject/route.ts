import { withTransaction, alertAdmin } from "@/lib/db";
import { requireRole, errorResponse } from "@/lib/auth/session";
import { rejectApplication, ApplicationError } from "@/lib/artists/applications";
import { deleteTransferRecipient } from "@/lib/paystack";

export const runtime = "nodejs";

interface RejectBody {
  note?: unknown;
}

export async function POST(req: Request, { params }: { params: Promise<{ userId: string }> }): Promise<Response> {
  try {
    await requireRole(req.headers, "admin");
  } catch (err) {
    return errorResponse(err);
  }
  const { userId } = await params;

  let body: RejectBody = {};
  try {
    body = await req.json();
  } catch {
    // a body is optional here, an empty POST is fine
  }
  const note = typeof body.note === "string" && body.note.trim() ? body.note.trim() : null;

  let recipientCode: string | null;
  try {
    recipientCode = await withTransaction((client) => rejectApplication(client, userId, note));
  } catch (err) {
    if (err instanceof ApplicationError) return new Response(err.message, { status: 400 });
    throw err;
  }

  // Best-effort cleanup, outside the transaction, after the rejection is already committed.
  // A failure here does not undo the rejection, it would just leave an idle Paystack recipient.
  if (recipientCode) {
    try {
      await deleteTransferRecipient(recipientCode);
    } catch (err) {
      alertAdmin(`Rejected application for ${userId} but could not delete Paystack recipient ${recipientCode}`, err);
    }
  }

  return Response.json({ status: "rejected" });
}
