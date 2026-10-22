import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "pg";
import { requireAdminUrl } from "../scripts/db";
import { migrate } from "../scripts/migrate-lib";

let failures = 0;
const check = (name: string, ok: boolean, extra?: unknown): void => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || extra === undefined ? "" : "  -> " + JSON.stringify(extra)}`);
};

const adminUrl = requireAdminUrl();
const REAL_DIR = join(import.meta.dirname, "..", "migrations");
const realFiles = readdirSync(REAL_DIR).filter((f) => f.endsWith(".sql")).sort();

async function freshDb(name: string): Promise<string> {
  if (!/^art_test_migrate_[a-z0-9_]+$/.test(name)) throw new Error("bad test db name");
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const u = new URL(adminUrl);
  u.pathname = `/${name}`;
  return u.toString();
}
async function q<T = any>(url: string, sql: string): Promise<T[]> {
  const c = new Client({ connectionString: url });
  await c.connect();
  try {
    return (await c.query(sql)).rows as T[];
  } finally {
    await c.end();
  }
}
const tempDir = (files: Record<string, string>): string => {
  const dir = mkdtempSync(join(tmpdir(), "art-online-mig-"));
  for (const [name, sql] of Object.entries(files)) writeFileSync(join(dir, name), sql);
  return dir;
};
const rejects = (p: Promise<unknown>): Promise<string | null> => p.then(() => null, (e) => (e as Error).message);
const tableExists = async (url: string, table: string): Promise<boolean> =>
  (await q(url, `SELECT to_regclass('public.${table}') AS t`))[0].t !== null;

// ---- 1. a fresh database gets everything, once
const url1 = await freshDb("art_test_migrate_fresh");
const first = await migrate(url1);
check(`a fresh database applies all ${realFiles.length} real migrations in order`, first.applied.join() === realFiles.join(), first);
check("each is recorded", (await q(url1, `SELECT count(*)::int n FROM schema_migrations`))[0].n === realFiles.length);
check("the schema is really there, including the seeded genres", (await tableExists(url1, "users")) && (await q(url1, `SELECT count(*)::int n FROM genres`))[0].n >= 8);
const second = await migrate(url1);
check("running again changes nothing", second.applied.length === 0 && second.alreadyApplied.length === realFiles.length, second);

// ---- 2. a migration that fails leaves no trace, and the fix can be re-run
const dirFail = tempDir({
  "001_ok.sql": "CREATE TABLE ok_table (id int);",
  "002_bad.sql": "CREATE TABLE half_table (id int); SELECT 1/0;",
  "003_after.sql": "CREATE TABLE after_table (id int);",
});
const url2 = await freshDb("art_test_migrate_fail");
const failMsg = await rejects(migrate(url2, { dir: dirFail }));
check("a failing migration is reported by name and says it was rolled back", !!failMsg && failMsg.includes("002_bad.sql") && failMsg.includes("rolled back"), failMsg);
check("the table the failing migration created BEFORE it hit the error does not exist", !(await tableExists(url2, "half_table")));
check("the migration before it stays applied and recorded", (await tableExists(url2, "ok_table")) && (await q(url2, `SELECT name FROM schema_migrations`)).map((r) => r.name).join() === "001_ok.sql");
check("later migrations were not attempted", !(await tableExists(url2, "after_table")));
writeFileSync(join(dirFail, "002_bad.sql"), "CREATE TABLE half_table (id int);");
const fixed = await migrate(url2, { dir: dirFail });
check("after fixing the file, a re-run applies the rest", fixed.applied.join() === "002_bad.sql,003_after.sql" && (await tableExists(url2, "after_table")), fixed);

// ---- 2b. a migration and its bookkeeping row succeed or fail together
// This migration succeeds on its own but moves the bookkeeping table away, so recording it must fail.
// If the migration and its record were not one transaction, the rename would survive the failure.
const dirPair = tempDir({ "001_sabotage.sql": "ALTER TABLE schema_migrations RENAME TO schema_migrations_moved;" });
const url2b = await freshDb("art_test_migrate_pair");
const pairMsg = await rejects(migrate(url2b, { dir: dirPair }));
check("when recording a migration fails, the migration itself is undone with it", !!pairMsg && (await tableExists(url2b, "schema_migrations")) && !(await tableExists(url2b, "schema_migrations_moved")), pairMsg);

// ---- 3. editing an applied migration is refused, before anything else runs
const dirEdit = tempDir({ "001_a.sql": "CREATE TABLE a_table (id int);" });
const url3 = await freshDb("art_test_migrate_edit");
await migrate(url3, { dir: dirEdit });
writeFileSync(join(dirEdit, "001_a.sql"), "CREATE TABLE a_table (id int); -- quietly changed");
writeFileSync(join(dirEdit, "002_b.sql"), "CREATE TABLE b_table (id int);");
const editMsg = await rejects(migrate(url3, { dir: dirEdit }));
check("an applied migration that was edited is refused, naming the file", !!editMsg && editMsg.includes("001_a.sql") && editMsg.includes("edited"), editMsg);
check("and the new migration beside it was NOT applied", !(await tableExists(url3, "b_table")));

// ---- 4. Windows line endings and a BOM are not edits
const dirWin = tempDir({ "001_w.sql": "CREATE TABLE w_table (\n  id int\n);\n" });
const url4 = await freshDb("art_test_migrate_windows");
await migrate(url4, { dir: dirWin });
writeFileSync(join(dirWin, "001_w.sql"), "\uFEFFCREATE TABLE w_table (\r\n  id int\r\n);\r\n");
const winRun = await rejects(migrate(url4, { dir: dirWin }));
check("the same SQL saved with CRLF line endings and a BOM is not treated as an edit", winRun === null, winRun);
const dirBom = tempDir({ "001_bom.sql": "\uFEFFCREATE TABLE bom_table (id int);" });
const url4b = await freshDb("art_test_migrate_bom");
check("a migration file that starts with a BOM still runs", (await rejects(migrate(url4b, { dir: dirBom }))) === null && (await tableExists(url4b, "bom_table")));

// ---- 5. a database whose early migrations were run by hand in pgAdmin
const url5 = await freshDb("art_test_migrate_baseline");
for (const f of realFiles.filter((f) => f < "007")) await q(url5, readFileSync(join(REAL_DIR, f), "utf8"));
const naive = await rejects(migrate(url5));
check("without --baseline, a hand-built database fails loudly instead of corrupting itself", !!naive && naive.includes(realFiles[0]), naive);
const based = await migrate(url5, { baseline: "006" });
check("with baseline 006, 001-006 are marked applied without running, and the rest run", based.baselined.length === 6 && based.applied.join() === realFiles.filter((f) => f >= "007").join(), based);
check("so the seed from 007 arrived", (await q(url5, `SELECT count(*)::int n FROM genres`))[0].n >= 8);
check("a baseline prefix that matches no file is rejected", (await rejects(migrate(await freshDb("art_test_migrate_badbase"), { baseline: "999" })))?.includes("999") === true);

// ---- 6. three migrators started at the same moment
const url6 = await freshDb("art_test_migrate_race");
const runs = await Promise.allSettled([migrate(url6), migrate(url6), migrate(url6)]);
const appliedTotal = runs.reduce((n, r) => n + (r.status === "fulfilled" ? r.value.applied.length : 0), 0);
check("three simultaneous runs all succeed", runs.every((r) => r.status === "fulfilled"), runs.map((r) => (r.status === "rejected" ? String(r.reason) : "ok")));
check("and every migration was applied exactly once between them", appliedTotal === realFiles.length && (await q(url6, `SELECT count(*)::int n FROM schema_migrations`))[0].n === realFiles.length, { appliedTotal });

for (const d of [dirFail, dirPair, dirEdit, dirWin, dirBom]) rmSync(d, { recursive: true, force: true });
console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
