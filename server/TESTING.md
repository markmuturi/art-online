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

`npm test` runs, in order: a TypeScript check, then `test/flow.ts` (checkout, webhooks, the
order state machine, the worker, payouts), then `test/auth.test.ts` (sign-up, email
verification, sessions, rate limiting). Each test file drops and recreates its own
throwaway database (`art_test_flow`, `art_test_auth`) before running, so re-running is
always safe and never touches a database you care about. `scripts/db.ts` refuses to
touch any database not named `art_test_*`.

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
pgcrypto`. `npm test` ends with `ALL PASSED` twice, once for each test file, with no
`FAIL` lines above it.
