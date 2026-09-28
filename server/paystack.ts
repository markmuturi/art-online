import { createHmac, timingSafeEqual } from "node:crypto";

const BASE_URL = "https://api.paystack.co";

function secretKey(): string {
  const key = process.env.PAYSTACK_SECRET_KEY;
  if (!key) throw new Error("PAYSTACK_SECRET_KEY is not set");
  return key;
}

// Paystack signs the raw request body with HMAC SHA512 using your secret key.
export function verifyPaystackSignature(rawBody: string, signature: string | null): boolean {
  if (!signature) return false;
  const expected = Buffer.from(createHmac("sha512", secretKey()).update(rawBody).digest("hex"), "utf8");
  const received = Buffer.from(signature, "utf8");
  return expected.length === received.length && timingSafeEqual(expected, received);
}

interface PaystackEnvelope<T> {
  status: boolean;
  message: string;
  data?: T;
}

async function paystackPost<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${secretKey()}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const json = (await res.json()) as PaystackEnvelope<T>;
  if (!res.ok || !json.status || json.data === undefined) {
    throw new Error(`Paystack ${path} failed (${res.status}): ${json.message}`);
  }
  return json.data;
}

export async function initializeTransaction(args: {
  email: string;
  amountCents: number;
  reference: string;
  callbackUrl: string;
}): Promise<{ authorizationUrl: string }> {
  const data = await paystackPost<{ authorization_url: string }>("/transaction/initialize", {
    email: args.email,
    amount: args.amountCents, // Paystack takes the currency subunit: KES cents
    currency: "KES",
    reference: args.reference,
    callback_url: args.callbackUrl,
  });
  return { authorizationUrl: data.authorization_url };
}

// reference must be unique, 16-50 chars, lowercase letters, digits, dash, underscore.
// A deterministic reference per order means a retry can never pay the artist twice.
export async function initiateTransfer(args: {
  amountCents: number;
  recipientCode: string;
  reference: string;
  reason: string;
}): Promise<{ transferCode: string; status: string }> {
  const data = await paystackPost<{ transfer_code: string; status: string }>("/transfer", {
    source: "balance",
    amount: args.amountCents,
    currency: "KES",
    recipient: args.recipientCode,
    reference: args.reference,
    reason: args.reason,
  });
  return { transferCode: data.transfer_code, status: data.status };
}
