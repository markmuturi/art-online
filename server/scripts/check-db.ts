import { Client } from "pg";
import { requireAdminUrl } from "./db";

const client = new Client({ connectionString: requireAdminUrl() });
try {
  await client.connect();
  const version = await client.query<{ v: string }>("SELECT version() AS v");
  const ext = await client.query<{ name: string }>(
    `SELECT name FROM pg_available_extensions WHERE name IN ('pgcrypto', 'citext') ORDER BY name`,
  );
  console.log("Connected:", version.rows[0]?.v);
  console.log("Extensions available:", ext.rows.map((r) => r.name).join(", "));
  if (ext.rows.length !== 2) {
    console.error("pgcrypto and citext must both be available. Reinstall PostgreSQL with the default components.");
    process.exit(1);
  }
  await client.end();
} catch (err) {
  console.error("Could not connect:", (err as Error).message);
  process.exit(1);
}
