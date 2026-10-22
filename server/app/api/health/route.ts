import { pool } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// For you, a deploy platform's health check, or an uptime monitor: is the app up and can it reach Postgres?
export async function GET(): Promise<Response> {
  try {
    await pool.query("SELECT 1");
    return Response.json({ ok: true });
  } catch {
    return Response.json({ ok: false }, { status: 503 });
  }
}
