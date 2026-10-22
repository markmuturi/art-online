import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

const DEFAULT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

// Any constant works. Everyone running this app's migrations asks for the same lock, so two
// migrators started at once (two deploys, a double-click) take turns instead of colliding.
const LOCK_KEY = 727_274_001;

export interface MigrateOptions {
  dir?: string;
  // A migration filename prefix such as "006". Every not-yet-recorded migration up to and including
  // it is marked as applied WITHOUT running. For a database whose early migrations were run by hand.
  baseline?: string;
  log?: (message: string) => void;
}

export interface MigrateResult {
  applied: string[];
  baselined: string[];
  alreadyApplied: string[];
}

// Line endings and a leading BOM are normalised before hashing and running. Windows editors and
// git's autocrlf change both without anyone touching the SQL, and that must not look like an edit.
function readSql(path: string): string {
  return readFileSync(path, "utf8").replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
}

const checksum = (sql: string): string => createHash("sha256").update(sql).digest("hex");

// Each pending migration runs in its own transaction together with the row that records it, so a
// migration is either fully applied and recorded, or not applied at all. Postgres rolls DDL back
// too. Do not put statements that cannot run inside a transaction (such as CREATE INDEX
// CONCURRENTLY) in a migration file.
export async function migrate(connectionString: string, opts: MigrateOptions = {}): Promise<MigrateResult> {
  const log = opts.log ?? (() => {});
  const dir = opts.dir ?? DEFAULT_DIR;
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  const sqlByFile = new Map(files.map((f) => [f, readSql(join(dir, f))]));

  const client = new Client({ connectionString });
  await client.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [LOCK_KEY]);
    // Created only after the lock is held: two sessions racing on CREATE TABLE IF NOT EXISTS can still collide.
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         name text PRIMARY KEY,
         checksum text NOT NULL,
         applied_at timestamptz NOT NULL DEFAULT now()
       )`,
    );
    const recorded = await client.query<{ name: string; checksum: string }>(`SELECT name, checksum FROM schema_migrations`);
    const applied = new Map(recorded.rows.map((r) => [r.name, r.checksum]));

    // Checked before anything runs, so a bad state never gets a partial apply on top of it.
    for (const [name, sum] of applied) {
      const sql = sqlByFile.get(name);
      if (sql === undefined) {
        log(`warning: ${name} is recorded as applied but its file is missing`);
      } else if (checksum(sql) !== sum) {
        throw new Error(`Migration ${name} was edited after it was applied. Never change an applied migration, add a new one instead.`);
      }
    }

    let baselineIndex = -1;
    if (opts.baseline) {
      baselineIndex = files.findIndex((f) => f.startsWith(opts.baseline as string));
      if (baselineIndex === -1) throw new Error(`--baseline ${opts.baseline}: no migration file starts with that.`);
    }

    const result: MigrateResult = { applied: [], baselined: [], alreadyApplied: [] };
    const record = (name: string, sql: string) =>
      client.query(`INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)`, [name, checksum(sql)]);

    for (const [i, name] of files.entries()) {
      const sql = sqlByFile.get(name) as string;
      if (applied.has(name)) {
        result.alreadyApplied.push(name);
      } else if (i <= baselineIndex) {
        await record(name, sql);
        result.baselined.push(name);
        log(`baselined ${name} (marked applied, not run)`);
      } else {
        await client.query("BEGIN");
        try {
          await client.query(sql);
          await record(name, sql);
          await client.query("COMMIT");
        } catch (err) {
          await client.query("ROLLBACK");
          throw new Error(`Migration ${name} failed and was rolled back: ${(err as Error).message}`, { cause: err });
        }
        result.applied.push(name);
        log(`applied ${name}`);
      }
    }
    return result;
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]).catch(() => {});
    await client.end();
  }
}
