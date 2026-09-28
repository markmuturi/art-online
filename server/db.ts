import { Pool, type PoolClient } from "pg";

// Cache the pool on globalThis so Next.js hot reload in dev doesn't open a new pool per edit.
const globalForPg = globalThis as unknown as { pgPool?: Pool };

export const pool: Pool =
  globalForPg.pgPool ?? new Pool({ connectionString: process.env.DATABASE_URL, max: 10 });

if (process.env.NODE_ENV !== "production") globalForPg.pgPool = pool;

export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// Logging is the floor. Wire this to email, Slack or WhatsApp before you take real money.
export function alertAdmin(message: string, context?: unknown): void {
  console.error("[ADMIN ALERT]", message, context ?? "");
}
