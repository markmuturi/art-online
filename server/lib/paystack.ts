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

export interface CreateRecipientArgs {
  type: "mobile_money" | "kepss";
  accountName: string; // the name on the M-Pesa line or bank account, not the public artist name
  accountNumber: string; // phone number for mobile_money, account number for kepss. Never persisted by us.
  bankCode: string; // "MPESA" for M-Pesa wallets, or a Kenyan bank code from listBanks() for kepss
}

export interface Recipient {
  recipientCode: string;
  bankName: string;
}

// NOTE: Paystack's exact accepted phone number format for Kenya mobile_money (07XXXXXXXX vs
// 2547XXXXXXXX vs +254...) was not confirmed against a live call while building this. Test
// against the real sandbox before launch and adjust normalizePhone below if it rejects a format.
export async function createTransferRecipient(args: CreateRecipientArgs): Promise<Recipient> {
  const data = await paystackPost<{ recipient_code: string; bank_name: string }>("/transferrecipient", {
    type: args.type,
    name: args.accountName,
    account_number: args.accountNumber,
    bank_code: args.bankCode,
    currency: "KES",
  });
  return { recipientCode: data.recipient_code, bankName: data.bank_name };
}

// Best-effort cleanup when an application is rejected. A failure here is not worth blocking
// the rejection over, Paystack does not charge for unused recipients sitting idle.
export async function deleteTransferRecipient(recipientCode: string): Promise<void> {
  const res = await fetch(`${BASE_URL}/transferrecipient/${recipientCode}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${secretKey()}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Paystack recipient delete failed (${res.status})`);
}

export interface Bank {
  name: string;
  code: string;
}

// For populating a bank picker ahead of a kepss (Kenyan bank account) application.
// Mobile money applicants don't need this, the bank_code is always the fixed "MPESA".
export async function listBanks(): Promise<Bank[]> {
  const res = await fetch(`${BASE_URL}/bank?country=kenya&currency=KES&type=kepss`, {
    headers: { Authorization: `Bearer ${secretKey()}` },
    signal: AbortSignal.timeout(15_000),
  });
  const json = (await res.json()) as PaystackEnvelope<Array<{ name: string; code: string }>>;
  if (!res.ok || !json.status || !json.data) throw new Error(`Paystack bank list failed (${res.status}): ${json.message}`);
  return json.data.map((b) => ({ name: b.name, code: b.code }));
}
