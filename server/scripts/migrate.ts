import { Client } from "pg";
import { migrate } from "./migrate-lib";

// npm run db:migrate                 apply whatever has not been applied yet
// npm run db:setup                   same, but create the database first if it does not exist
// tsx --env-file=.env scripts/migrate.ts --baseline 006
//                                    mark 001..006 as already applied (for a hand-built database)

const args = process.argv.slice(2);
const createDb = args.includes("--create-db");
const baselineAt = args.indexOf("--baseline");
const baseline = baselineAt >= 0 ? args[baselineAt + 1] : undefined;
if (baselineAt >= 0 && !baseline) {
  console.error("--baseline needs a migration prefix, for example: --baseline 006");
  process.exit(1);
}

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set. Add it to .env, for example:\n  DATABASE_URL=postgres://postgres:YOURPASSWORD@localhost:5432/artonline");
  process.exit(1);
}

function explain(err: unknown): string {
  const e = err as { code?: string; message?: string };
  switch (e.code) {
    case "28P01":
      return "Postgres rejected the username or password in DATABASE_URL.";
    case "3D000":
      return "That database does not exist yet. Run `npm run db:setup` to create it, or create it in pgAdmin.";
    case "ECONNREFUSED":
      return "Could not reach Postgres. Check that it is running and that the host and port in DATABASE_URL are right.";
    default:
      return e.message ?? String(err);
  }
}

async function ensureDatabase(connectionString: string): Promise<void> {
  const target = new URL(connectionString);
  const name = decodeURIComponent(target.pathname.slice(1));
  if (!/^[A-Za-z0-9_]+$/.test(name)) throw new Error(`Refusing to create a database named "${name}". Use letters, digits and underscores only.`);
  const maintenance = new URL(connectionString);
  maintenance.pathname = "/postgres";
  const client = new Client({ connectionString: maintenance.toString() });
  await client.connect();
  try {
    const exists = await client.query(`SELECT 1 FROM pg_database WHERE datname = $1`, [name]);
    if (exists.rowCount === 0) {
      await client.query(`CREATE DATABASE "${name}"`);
      console.log(`created database ${name}`);
    }
  } finally {
    await client.end();
  }
}

try {
  if (createDb) await ensureDatabase(url);
  const result = await migrate(url, { baseline, log: (m) => console.log(m) });
  const changed = result.applied.length + result.baselined.length;
  console.log(changed === 0 ? `Database is up to date (${result.alreadyApplied.length} migrations already applied).` : `Done. Applied ${result.applied.length}, baselined ${result.baselined.length}.`);
} catch (err) {
  console.error(`FAIL  ${explain(err)}`);
  process.exit(1);
}
