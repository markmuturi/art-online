import { listBanks } from "@/lib/paystack";

export const runtime = "nodejs";

// Public: lets a signup form populate a bank picker before the artist has an account at all.
export async function GET(): Promise<Response> {
  try {
    const banks = await listBanks();
    return Response.json(banks);
  } catch (err) {
    return new Response(`Could not fetch bank list: ${(err as Error).message}`, { status: 502 });
  }
}
