import { withTransaction, alertAdmin } from "@/lib/db";
import { requireUser, errorResponse } from "@/lib/auth/session";
import { createOrder, CheckoutError } from "@/lib/orders/create";
import { initializeTransaction } from "@/lib/paystack";

export const runtime = "nodejs";

interface CheckoutBody {
  artworkId?: unknown;
  shippingAddressId?: unknown;
}

// The ONLY thing this route does with Paystack's response is hand the buyer a URL to
// pay at. It never marks anything paid. The webhook route is the one and only place
// that happens, because this route's response is driven by the buyer's browser, which
// is not a trustworthy witness to whether money actually moved.
export async function POST(req: Request): Promise<Response> {
  let user;
  try {
    user = await requireUser(req.headers);
  } catch (err) {
    return errorResponse(err);
  }

  let body: CheckoutBody;
  try {
    body = await req.json();
  } catch {
    return new Response("Invalid JSON body", { status: 400 });
  }
  if (typeof body.artworkId !== "string" || body.artworkId.length === 0) {
    return new Response("artworkId is required", { status: 400 });
  }
  if (body.shippingAddressId !== undefined && body.shippingAddressId !== null && typeof body.shippingAddressId !== "string") {
    return new Response("shippingAddressId must be a string or null", { status: 400 });
  }

  const appUrl = process.env.APP_URL;
  if (!appUrl) {
    alertAdmin("APP_URL is not set, cannot build a Paystack callback URL");
    return new Response("Checkout is temporarily unavailable", { status: 500 });
  }

  let order;
  try {
    order = await withTransaction((client) =>
      createOrder(client, {
        buyerId: user.id,
        artworkId: body.artworkId as string,
        shippingAddressId: (body.shippingAddressId as string | null | undefined) ?? null,
      }),
    );
  } catch (err) {
    if (err instanceof CheckoutError) return new Response(err.message, { status: 400 });
    throw err;
  }

  // Deliberately outside the transaction above, same reasoning as the payout call in
  // worker/index.ts: never hold a database lock while waiting on a third party. If this
  // throws, the order is already committed and simply sits in pending_payment. Nothing
  // needs to be unwound by hand, the 30-minute expiry job frees the piece on its own.
  try {
    const { authorizationUrl } = await initializeTransaction({
      email: user.email,
      amountCents: order.amountCents,
      reference: order.reference,
      callbackUrl: `${appUrl}/orders/${order.orderId}`,
    });
    return Response.json({ orderId: order.orderId, authorizationUrl });
  } catch (err) {
    alertAdmin(`Paystack initializeTransaction failed for order ${order.orderId}`, err);
    return new Response("Could not start payment. Try again.", { status: 502 });
  }
}
