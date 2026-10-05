import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

// Drops and recreates a throwaway database, then applies every migration in filename order.
// The art_test_ prefix guard stops a typo from dropping a database you care about.
export async function resetDatabase(adminUrl: string, dbName: string): Promise<string> {
  if (!/^art_test_[a-z0-9_]+$/.test(dbName)) {
    throw new Error(`Refusing to reset "${dbName}". Test databases must be named art_test_<something>.`);
  }

  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${dbName}`);
  } finally {
    await admin.end();
  }

  const url = new URL(adminUrl);
  url.pathname = `/${dbName}`;
  const db = new Client({ connectionString: url.toString() });
  await db.connect();
  try {
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
    for (const file of files) {
      try {
        await db.query(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
      } catch (err) {
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
      }
    }
  } finally {
    await db.end();
  }
  return url.toString();
}

export function requireAdminUrl(): string {
  const url = process.env.TEST_DB_ADMIN_URL;
  if (!url) {
    console.error(
      "TEST_DB_ADMIN_URL is not set. In Git Bash run:\n" +
        "  export TEST_DB_ADMIN_URL='postgres://postgres:YOURPASSWORD@localhost:5432/postgres'",
    );
    process.exit(1);
  }
  return url;
}
