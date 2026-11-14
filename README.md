# jackass-bot
bot for aa


## Galaxy Neegy — settings and access foundation

A TypeScript foundation recovered from the phone and extended through Task 7 of the approved [handoff](docs/galaxy-neegy-handoff.md).
The current program validates configuration and exits. HTTP/dashboard factories are available; integrated runtime activation remains Task 8.
Task 2 adds backend access/settings/credential services. Task 3 adds provider adapters and
atomic usage accounting; see [provider/accounting contracts and limitations](docs/providers-usage.md).
Task 4 adds bounded channel context and direct eligibility/cooldowns; see
[context and direct-request contracts](docs/context-direct.md).
Task 5 adds durable activity/snapshot accounting and a bounded single-worker queue; see
[automatic scheduling contracts](docs/automatic.md).
Task 6 adds Discord gateway/command adapters and safe output delivery; see
[Discord composition, acknowledgements and explicit registration](docs/discord.md).
Task 7 adds Discord sign-in, protected HTTP routes and the mobile dashboard; see
[dashboard setup, security, drafts and live-check limits](docs/dashboard.md).
The services are tested with mocks and are not activated by foundation startup.

Development and testing now happen in **Codex Cloud** at `/workspace/jackass-bot`.
The Oracle ARM64 VPS remains an eventual deployment target; it is not a test database.
The handoff includes the user’s revised allowance policy; its Termux paths and original
progress record are historical. Daily token allowances are practical safeguards, not hard
billing caps: estimation error and in-flight calls can overshoot them. Both providers use
request-based preflight counts and reconcile full reported usage; allowances never increase automatically. See [recovery and verification](docs/task-1-verification.md) and
[version compatibility](docs/compatibility.md).

### Install and check

Use Node **26.13.1** (Lithium LTS) and its bundled npm **11.20.0**.
`.node-version`, `.nvmrc`, `package.json` and `.npmrc` enforce the chosen versions;
activate them with your existing version manager before running npm.

```sh
node --version
npm --version
npm ci --ignore-scripts
npm run lint
npm run typecheck
npm test
npm run build
npm start
```

`npm start` loads `.env` if present and validates only. Do not set `APP_MODE=runtime`:
service startup is reserved for later tasks and fails explicitly today. No production
credentials are needed for foundation mode. Unit tests pass their own synthetic config.
Dependency lifecycle scripts are disabled during installation; the lockfile supplies
the platform packages used by Vitest and Drizzle.

### Isolated database tests

Start only this project's disposable PostgreSQL instance in Cloud. The credentials
below are public, local test credentials. The port is bound to loopback; the data is
in tmpfs and disappears when the container is removed.

```sh
docker compose -f compose.dev.yaml up -d --wait
export TEST_DATABASE_URL=postgresql://galaxy_test:galaxy_test@127.0.0.1:55432/galaxy_neegy_test
npm run test:integration
docker compose -f compose.dev.yaml down
```

The integration suite never defaults to `DATABASE_URL`. It requires an explicit local
PostgreSQL URL whose database name contains `test`, rejects query overrides, creates a
uniquely named database, runs committed migrations twice, verifies constraints/deletion
boundaries and drops that database in teardown. Its disposable DB user needs `CREATEDB`.
Do not use production URLs, credentials, or the VPS for these tests.

To inspect migrations on the disposable base database instead:

```sh
npm run build
DATABASE_URL=postgresql://galaxy_test:galaxy_test@127.0.0.1:55432/galaxy_neegy_test npm run db:migrate
npm run db:generate
```

`db:generate` is offline and should report no schema changes unless the schema changed.
Commit generated SQL and snapshot/journal files together after review. Migrations run
only through the explicit command; application startup does not run them.

### Configuration and CI

`.env.example` documents optional foundation settings and the future required runtime
fields. Copy it to a local `.env` only if needed; real `.env` files are ignored.
Runtime mode requires a PostgreSQL URL, HTTPS public origin in production, a canonical
base64 32-byte encryption key, Discord bot/OAuth credentials and creator snowflake.
Config errors contain field names, never supplied values. Task 2 provides authenticated provider-key storage through the service layer;
Task 7 exposes authenticated write-only key endpoints; no live worker is activated.

The read-only [checks workflow](.github/workflows/checks.yml) installs from the lockfile,
runs lint/typecheck/unit/build/database checks, checks migration drift and smoke-tests
foundation startup on native AMD64 and ARM64 Linux runners. It uses a fresh PostgreSQL
service and no deployment secrets. Task 1 passed both architectures before PR #1 was squash-merged.
Tasks 1–6 passed both architectures before merging. See the current PR for the latest
dashboard/browser results; local checks alone never establish remote success.

`npm run test:e2e` runs Chromium mobile (390px) and desktop scenarios against real HTTP/
access/settings services with fake Discord and isolated PostgreSQL. Run `npx playwright
install chromium` once in Cloud; CI installs its browser on both architectures. Screenshots
and failure traces are retained as workflow artifacts. No image publication or deployment
workflow is present.

Pending later inputs include application/creator/guild IDs, credentials through secret
storage, contact link, registry access and an encrypted off-VPS
backup destination. None is needed to run mocked checks. The supplied logo is now bundled locally. Task 7 is the current boundary; its PR stays unmerged. Live Discord login/registration,
production credentials, VPS access and deployment require further instruction. Current direct text is separate from
history caps and never silently truncated; oversized required input gets a typed rejection.
The user accepts the in-memory cooldown resetting on restart for v1.
