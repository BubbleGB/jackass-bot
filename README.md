# Galaxy Neegy

A Discord bot and mobile dashboard with per-server access control, encrypted write-only
provider credentials, bounded channel context, direct/automatic requests and daily usage
safeguards. Development and testing use Codex Cloud; the Oracle ARM64 VPS remains the
future deployment target. Tasks 1–7 are merged. Task 8 adds the integrated runtime and
production package; deployment and live acceptance require separate Task 9 authorisation.

`APP_MODE=foundation` validates configuration and exits without services. `APP_MODE=runtime`
starts the Discord gateway, Fastify dashboard/API, database-backed single worker, health
checks and daily maintenance. Runtime configuration requires credentials; do not enable it
against live services during mocked tests. See the [approved handoff](docs/galaxy-neegy-handoff.md),
[operations runbook](docs/runbook.md), [privacy policy](docs/privacy.md) and
[remaining Task 9 inputs/checks](docs/task-9-checklist.md).

## Install and verify in Cloud

Use pinned Node **26.13.1** and bundled npm **11.20.0**. `.node-version`, `.nvmrc`,
`package.json` and `.npmrc` enforce these versions. No production credentials are needed.

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

Foundation mode is the default. `.env.example` contains only public local-test values;
never commit real `.env` files or secrets. Dependency lifecycle scripts are disabled.
Migrations are explicit (`npm run db:migrate`); runtime checks the packaged migration
head and refuses a mismatch. It never changes the schema at startup.

## Isolated database and browser tests

```sh
docker compose -f compose.dev.yaml up -d --wait
export TEST_DATABASE_URL=postgresql://galaxy_test:galaxy_test@127.0.0.1:55432/galaxy_neegy_test
npm run test:integration
npx playwright install chromium
npm run test:e2e
npm run db:generate
docker compose -f compose.dev.yaml down
```

The development database is loopback-only with disposable tmpfs data. Tests require an
explicit local URL whose database name contains `test`; they never use `DATABASE_URL` as
fallback. Each suite creates/migrates/drops its own isolated database (test role needs
`CREATEDB`). Do not substitute a production database or the VPS. Browser tests run at
390px and desktop widths with fake Discord/provider services and real HTTP/access/settings
services; CI retains screenshots/traces. Chromium emulation does not establish physical
Android, live OAuth or HTTPS-cookie success.

## Production package verification

```sh
docker build -t galaxy-image:test .
npm run test:image -- galaxy-image:test
```

The multi-stage image pins Node by digest and runs as non-root. `compose.yaml` keeps
PostgreSQL private, mounts secret files, excludes app/database from Watchtower and makes
migrations an explicit operator step. The image smoke test uses temporary test credentials,
a separate Compose project and mounted external-service fixtures. It executes the actual
compiled entry point, database, dashboard/logo, singleton guard, event-to-accounting/delivery,
graceful shutdown and crash recovery. It never publishes an image or calls a paid API.
The [runbook](docs/runbook.md) states the exact paths and limitations.

[Project CI](.github/workflows/checks.yml) runs lint, types, unit/database/browser tests,
build, migration drift and foundation startup. [Image CI](.github/workflows/image.yml)
builds and runs the production image on native AMD64 and ARM64 runners. All jobs use
mocks/test credentials; none deploy or release to a registry. Consult the current PR's
latest commit checks for observed results, rather than historical progress notes.

## Behaviour and service contracts

- [Settings/access](docs/settings-access.md) and [dashboard security](docs/dashboard.md):
  current membership/roles on protected operations, creator approval and restricted delegates.
- [Providers/accounting](docs/providers-usage.md): OpenAI and Google preflight count the
  actual request where supported, reserve atomically and reconcile full reported usage.
  **Daily allowances are practical safeguards, not hard billing caps.** Estimation errors
  and in-flight calls can overshoot. Configured allowances never increase automatically.
- [Context/direct requests](docs/context-direct.md): required instructions/current text
  appear once and are never silently truncated; zero history still permits the current
  question. Optional history trims first. Cooldown memory resets on restart for v1.
- [Automatic scheduling](docs/automatic.md): durable counters, message deduplication and
  one worker; no timer-only generation or replay of uncertain provider outcomes.
- [Discord delivery](docs/discord.md): prompt acknowledgements, safe mentions, permission
  rechecks, typing cleanup and bounded delivery-only retries. Command registration is
  explicit and never runs on reconnect.

The supplied Galaxy Neegy logo is bundled locally. Production IDs/credentials, contact
link, registry release/digest, HTTPS/proxy inventory and encrypted off-host backup setup
remain Task 9 inputs. No VPS access or deployment occurred during Task 8.
