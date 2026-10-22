import { Client } from "pg";
import { migrate } from "./migrate-lib";

// Drops and recreates a throwaway database, then builds it with the same migration runner
// that `npm run db:migrate` uses, so every test run also exercises the runner.
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
  await migrate(url.toString());
  return url.toString();
}

export function requireAdminUrl(): string {
  const url = process.env.TEST_DB_ADMIN_URL;
  if (!url) {
    console.error(
      "TEST_DB_ADMIN_URL is not set. In Git Bash run:\n" +
        "  export TEST_DB_ADMIN_URL='postgres://postgres:YOURPASSWORD@localhost:5432/postgres'\n" +
        "In PowerShell run:\n" +
        '  $env:TEST_DB_ADMIN_URL = "postgres://postgres:YOURPASSWORD@localhost:5432/postgres"',
    );
    process.exit(1);
  }
  return url;
}
