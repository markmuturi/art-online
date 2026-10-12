# Testing this backend locally (Git Bash on Windows)

Tested end to end on this exact folder: Node v22.22.2, npm 10.9.7, PostgreSQL 16.15.
Older Node 20 LTS will likely work too; anything older than 20 is untested.

## Commands, in order

```bash
cd /c/path/to/art-online-backend      # wherever you extracted the zip
npm install
export TEST_DB_ADMIN_URL="postgres://postgres:YOURPASSWORD@localhost:5432/postgres"
npm run db:check
npm test
```

`npm test` runs, in order: a TypeScript check, then seven test files: `test/flow.ts` (checkout,
webhooks, the order state machine, the worker, payouts), `auth.test.ts` (sign-up through
sessions and rate limiting), `checkout.test.ts`, `artists.test.ts` (artist applications and
admin approval), `uploads.test.ts` (artwork photos and KYC documents), `artworks.test.ts`
(creating, publishing and archiving listings) and `catalog.test.ts` (public browse and search).
Each test file drops and recreates its own throwaway database (`art_test_*`) before running, so
re-running is always safe and never touches a database you care about. `scripts/db.ts` refuses
to touch any database not named `art_test_*`. The storage tests use a local stand-in for
Cloudflare R2, so `npm test` needs no cloud account.

`npm run storage:check` is different: it talks to your REAL R2 buckets using the values in your
`.env` file, and is the one command that proves your Cloudflare setup is correct.

## Troubleshooting

**`npm: command not found`** — Node isn't installed or Git Bash was opened before you
installed it. Install Node, then close and reopen Git Bash.

**`ECONNREFUSED` from `npm run db:check`** — Postgres isn't running. Open Windows
Services (`services.msc`), find `postgresql-x64-16`, and start it. The installer
normally sets this to start automatically, so this usually only happens after a reboot
where it didn't.

**`password authentication failed`** — the password in `TEST_DB_ADMIN_URL` doesn't match
what you set for the `postgres` user during install. Use pgAdmin (installed alongside
Postgres) to reset it if you've forgotten it: right-click the PostgreSQL server → Properties.

**`extension "pgcrypto" is not available` (or `citext`)** — unusual on the default
Windows installer, which includes both. If it happens, rerun the Postgres installer and
make sure "Command Line Tools" stays checked.

**The `export` line stops working** — it only lasts for the current Git Bash window.
Either re-run it in each new window, or add it to `~/.bashrc` so new windows pick it up
automatically:
```bash
echo 'export TEST_DB_ADMIN_URL="postgres://postgres:YOURPASSWORD@localhost:5432/postgres"' >> ~/.bashrc
```

**A real `psql` command isn't required anywhere above.** The test scripts talk to
Postgres directly through the `pg` npm package, not the command line tool, so `psql`
being on your PATH or not makes no difference here.

## What you should see

`npm run db:check` prints a Postgres version line and `Extensions available: citext,
pgcrypto`. `npm test` ends with `ALL PASSED` seven times, once per test file, with no
`FAIL` lines above any of them.
