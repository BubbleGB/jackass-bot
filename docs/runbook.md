# Runtime operations

These procedures describe the Task 8 package. They have only been exercised with isolated
data and mocked external services. They do not authorise a deployment. Use the
[Task 9 checklist](task-9-checklist.md) for missing inputs and live acceptance checks.

## Package and configuration

`Dockerfile` pins the multi-architecture Node 26.13.1 image by digest, checks bundled npm
11.20.0, installs the lockfile without lifecycle scripts and builds the TypeScript server
and dashboard. The final image contains production dependencies, compiled code/assets,
committed migrations and package manifests. Sources, tests, `.env`, credentials, build
credentials and dev dependencies are excluded. The default command is `node dist/main.js`.
It runs as UID/GID 1000, with a read-only filesystem and `/tmp` tmpfs in Compose.

Set only nonsecret deployment metadata in the operator's Compose environment:
`GALAXY_IMAGE` (an approved immutable registry digest), `GALAXY_SECRETS_DIR`,
`PUBLIC_ORIGIN` (HTTPS origin), `DISCORD_CLIENT_ID`, `CREATOR_USER_ID`, optionally
`CONTACT_URL`, `GALAXY_HTTP_PORT` (default 3000) and `ENCRYPTION_KEY_VERSION` (default 1).
The contact link may be omitted until supplied. Do not put credentials in Compose,
image arguments, shell history, Git, chat or logs.

Prepare six secret files outside the repository:

| File | Consumer / value |
| --- | --- |
| `database_url` | app + migration; URL for the `galaxy` role at `postgres:5432/galaxy` |
| `app_db_password` | initial PostgreSQL bootstrap; same password, URL-encoded in the URL |
| `postgres_password` | separate PostgreSQL bootstrap administrator password |
| `encryption_key` | app; canonical base64 encoding of 32 random bytes |
| `discord_bot_token` | app; Discord bot credential |
| `discord_client_secret` | app; Discord OAuth credential |

Compose file-backed secrets are bind mounts, not an encrypted secret store. The host
must protect their directory and backups, and ensure the files are readable by their
container UID (app 1000; the pinned PostgreSQL image's database user is 999). Verify
ownership and permissions on the actual host; standalone Compose does not implement
file-secret `uid/gid/mode` remapping. Test files deliberately use synthetic values.
The application also supports direct environment secrets outside Compose, but rejects
setting both `NAME` and `NAME_FILE`. File read/configuration errors expose field names
only. Do not rotate the encryption key without a separate re-encryption plan.

PostgreSQL has no published port and only joins an internal backend network. The app
also joins an egress-capable network and publishes HTTP to loopback only. Both long-running
services, plus the one-shot migrator, explicitly opt out of Watchtower. Task 9 must inspect
the actual proxy/network arrangement before adding HTTPS. Docker socket access is never
mounted into the application. The initial database script creates a non-superuser
`galaxy` role that owns only its application database/schema. V1 uses that role for
explicit migrations too. It has DDL authority within this database, not cluster admin.
The bootstrap script runs only on a new volume; changing its password file later does
not rotate an existing role's password.

## Start, migrate, observe and stop

After Task 9 approval and environment/secrets preparation, the intended project-scoped
sequence is:

```sh
docker compose up -d --wait postgres
docker compose --profile ops run --rm migrate
docker compose up -d --wait app
curl --fail http://127.0.0.1:3000/health/ready
docker compose stop app
```

Runtime never migrates automatically. It compares the latest migration hash in the
database with the packaged migration head and fails closed on mismatch. Back up before
DDL. An older image with a different expected migration head will also refuse startup;
do not assume image rollback is possible after a schema change. Recovery requires a
verified compatible image/ledger or a separately tested restore/migration procedure.
Never delete the volume to solve a migration failure.

Startup verifies schema and bot identity, acquires the PostgreSQL single-worker advisory
lock and fenced ownership, recovers uncertain work, binds Fastify, waits for actual
gateway readiness, obtains a complete REST guild-membership listing, reconciles removals
and runs maintenance. Only then is Discord ingress enabled. A competing instance fails
before gateway login/event processing. This is a single-worker deployment, not active-active
scaling. Lost ownership stops ingress and initiates shutdown. All instances must use the
same database for this exclusion to work.

`GET /health/live` returns only `{"status":"alive"}` while HTTP is listening.
`GET /health/ready` returns `{"status":"ready"}` or HTTP 503
`{"status":"not_ready"}`. Readiness checks running phase, gateway readiness, database
reachability and current lock ownership. Probes are bounded and coalesced. Responses
expose no identifiers or connection errors. Readiness is not proof of provider funding,
valid provider credentials or delivery permission in every channel.

SIGTERM/SIGINT stop admission and the gateway, drain admitted/queued work while retaining
ownership for up to 90 seconds, then cancel remaining work and allow 20 seconds to settle.
HTTP connections and the pool close before exit; the process has a final 115-second
deadline and Compose gives 120 seconds. Shutdown failures produce a sanitised failure
and nonzero exit. In-flight answers may finish delivery during the drain after current
access/permission checks. No new events are admitted. Minimum direct cooldown state
resets on restart (accepted for v1); durable receipts/counters remain.

After a crash, reserved usage becomes an uncertain conservative charge. Uncertain
requests are not regenerated or automatically redelivered. Automatic pending counts
survive, and only a later eligible human event can trigger a new assessment. Never clear
reservation/receipt tables to get past an allowance or uncertain result. A Discord send
whose acknowledgement was lost may have reached users: v1 does not retry that ambiguous
send, to avoid duplicate answers. Definitively failed/rate-limited sends use bounded
delivery-only retries; they never call the provider again. Later-chunk failure preserves
already delivered chunks. See [Discord contracts](discord.md).

Guild removal, retention, session lifetimes and backup disclosures are in
[privacy.md](privacy.md). REST outage/incomplete membership listing prevents startup
readiness and never triggers deletion. During operation it logs a fixed failure and
retries reconciliation on a later guild/resume event or daily maintenance. No raw SDK,
HTTP, provider, database or configuration exception is written to the runtime log.
Fatal uncaught exceptions or unhandled rejections trigger a sanitised nonzero shutdown;
the runtime does not continue serving after such a fault. PostgreSQL is configured to
omit SQL statements, parameters and detailed error rows from its logs.
Use private dashboard error codes for diagnosis; do not enable request-body logging.
Container/proxy retention and encrypted backups must be configured separately in Task 9.

## Reproduce image verification without external credentials

```sh
docker build -t galaxy-image:test .
npm run test:image -- galaxy-image:test
```

Run with pinned Node/npm, Docker and Compose on each native architecture. The image
test creates its own temporary Compose project, secret files and volume, and removes
only those resources. It mounts external test fixtures read-only and substitutes only
Discord SDK network boundaries and HTTP external services. These fixtures are excluded
from the image; its normal command has no environment-controlled mock endpoint or test
bypass. No registry push or paid call occurs. CI runs the committed Dockerfile natively
on `ubuntu-24.04` and `ubuntu-24.04-arm` and retains the JSON result as an artifact.

The smoke test runs the actual compiled entry point, non-root filesystem, private database
and bootstrap role, explicit migrations, real Access/Settings/Context/Queue/Usage/Router
services, both health endpoints, starting/not-ready state, a competing production process,
compiled dashboard/deep links/privacy/JS/logo, mock Discord mention through preflight and
OpenAI generation to safe message delivery/ledger settlement, graceful in-flight drain,
restart deduplication, hard-kill recovery and conservative no-replay accounting. The SDK's
WebSocket login/event transport and external HTTP responses are mocked, not live-tested.
Google adapter behaviour and staff/approval/permission boundary changes are covered by
the separate provider and runtime integration suites, not claimed as image smoke paths.
Live OAuth, invitations, real gateway/REST delivery, HTTPS cookies and a physical Android
browser remain Task 9. Do not infer their success from Chromium emulation or image tests.
