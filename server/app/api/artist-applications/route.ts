import { withTransaction, alertAdmin } from "@/lib/db";
import { requireUser, errorResponse } from "@/lib/auth/session";
import { checkCanApply, saveApplication, getOwnApplication, ApplicationError } from "@/lib/artists/applications";
import { createTransferRecipient } from "@/lib/paystack";

export const runtime = "nodejs";

interface ApplyBody {
  displayName?: unknown;
  bio?: unknown;
  locationCity?: unknown;
  payoutChannel?: unknown; // 'mpesa' | 'bank'
  payoutAccountName?: unknown; // name on the M-Pesa line or bank account. Not persisted.
  accountNumber?: unknown; // phone number or bank account number. Not persisted.
  bankCode?: unknown; // required when payoutChannel is 'bank'; a code from GET /api/banks
}

function badRequest(msg: string): Response {
  return new Response(msg, { status: 400 });
}

export async function GET(req: Request): Promise<Response> {
  let user;
  try {
    user = await requireUser(req.headers);
  } catch (err) {
    return errorResponse(err);
  }
  const app = await withTransaction((client) => getOwnApplication(client, user.id));
  return Response.json(app ?? { kycStatus: null });
}

export async function POST(req: Request): Promise<Response> {
  let user;
  try {
    user = await requireUser(req.headers);
  } catch (err) {
    return errorResponse(err);
  }

  let body: ApplyBody;
  try {
    body = await req.json();
  } catch {
    return badRequest("Invalid JSON body");
  }

  const displayName = typeof body.displayName === "string" ? body.displayName.trim() : "";
  const payoutChannel = body.payoutChannel;
  const payoutAccountName = typeof body.payoutAccountName === "string" ? body.payoutAccountName.trim() : "";
  const accountNumber = typeof body.accountNumber === "string" ? body.accountNumber.trim() : "";
  const bio = typeof body.bio === "string" && body.bio.trim() ? body.bio.trim() : null;
  const locationCity = typeof body.locationCity === "string" && body.locationCity.trim() ? body.locationCity.trim() : null;

  if (displayName.length < 2) return badRequest("displayName is required.");
  if (payoutChannel !== "mpesa" && payoutChannel !== "bank") return badRequest("payoutChannel must be 'mpesa' or 'bank'.");
  if (payoutAccountName.length < 2) return badRequest("payoutAccountName is required.");
  if (accountNumber.length < 6) return badRequest("accountNumber is required.");
  const bankCode = payoutChannel === "bank" ? (typeof body.bankCode === "string" ? body.bankCode : "") : "MPESA";
  if (payoutChannel === "bank" && bankCode.length === 0) {
    return badRequest("bankCode is required for payoutChannel 'bank'. See GET /api/banks.");
  }

  // Read-only check first, before we create anything at Paystack, so a disallowed
  // reapplication fails fast instead of creating an orphaned recipient.
  try {
    await withTransaction((client) => checkCanApply(client, user.id));
  } catch (err) {
    if (err instanceof ApplicationError) return badRequest(err.message);
    throw err;
  }

  // Outside any transaction, same reasoning as checkout and the payout job: never hold a
  // database lock while waiting on Paystack.
  let recipient;
  try {
    recipient = await createTransferRecipient({
      type: payoutChannel === "mpesa" ? "mobile_money" : "kepss",
      accountName: payoutAccountName,
      accountNumber,
      bankCode,
    });
  } catch (err) {
    return badRequest(`Could not register your payout details: ${(err as Error).message}`);
  }

  try {
    await withTransaction((client) =>
      saveApplication(client, {
        userId: user.id,
        displayName,
        bio,
        locationCity,
        payoutChannel,
        recipientCode: recipient.recipientCode,
        bankName: recipient.bankName,
        accountLast4: accountNumber.slice(-4),
      }),
    );
  } catch (err) {
    // The Paystack recipient now exists but our own write failed. Not fatal, reusable,
    // and a resubmission will simply create (or Paystack will dedupe) another one.
    alertAdmin(`Application saved Paystack recipient ${recipient.recipientCode} but the DB write failed for user ${user.id}`, err);
    throw err;
  }

  return Response.json({ status: "pending", bankName: recipient.bankName });
}
