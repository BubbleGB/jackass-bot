# Runtime operations

These procedures describe the Task 8 package and the repository-only Task 9 deployment
preparation. Validation uses dummy configuration and isolated mocked external services.
Production deployment, registry publication, DNS changes, secrets placement and VPS access
require separate instruction. Use the [Task 9 checklist](task-9-checklist.md) for remaining
inputs and live acceptance checks.

## Confirmed inventory and production routing

The owner supplied this read-only inventory on 14 November 2026: Ubuntu 24.04 ARM64,
Docker 29.6.2, Compose 5.3.1, approximately 167 GB free. Existing Traefik v3 owns ports
80/443 on external network `aio_network`; it and Watchtower belong to project `aio` at
`/opt/docker/compose.yaml`. No Galaxy container exists. Watchtower uses
`nickfedor/watchtower:latest`, but its **effective update mode is unconfirmed**: absent
labels on current containers do not establish its filters or update behaviour. This PR
makes no changes to that Compose file, Traefik, Watchtower, Stremio or their containers.

Galaxy's production configuration is the explicit merge of `compose.yaml` followed by
`compose.production.yaml`, with project name `galaxy-neegy`. Compose 2.24.4+ is required
for `!override` (the inventoried 5.3.1 supports it). Do not deploy the base file alone:
it retains a loopback port mapping for isolated image tests. The production override
uses `ports: !reset []` to remove that inherited mapping; a plain empty list would not.
It replaces the app's networks, so the base `public` network is not joined in production.

| Service | Networks | Published host ports | Traefik enabled | Watchtower enabled |
| --- | --- | --- | --- | --- |
| app | `galaxy-neegy_backend`, existing `aio_network` | none | true | false |
| postgres | `galaxy-neegy_backend` (internal) | none | false | false |
| migrate (ops profile) | `galaxy-neegy_backend` (internal) | none | false | false |

The app listens on `0.0.0.0:3000` inside its container. Its router/service are named
`galaxy-neegy`: ``Host(`galaxy.bubbleaio.uk`)``, entrypoint `websecure`, TLS enabled,
certificate resolver `letsencrypt`, explicit backend port `3000`, and
`traefik.docker.network=aio_network`. TLS terminates at the existing Traefik; app HTTP
is internal. The app's public origin is fixed to `https://galaxy.bubbleaio.uk` by the
production override. These entrypoint/resolver names are requested configuration; their
presence in the existing Traefik's effective static configuration still needs a targeted
read-only confirmation before deployment. No live TLS/DNS routing is claimed verified. Also confirm outbound access from
`aio_network` before deployment; rendering cannot test an existing network’s egress.

The **exact Discord OAuth redirect** to register later is:
`https://galaxy.bubbleaio.uk/auth/discord/callback`.

For isolated rendered-configuration validation, run `npm run test:compose`. It uses only
dummy values and `--env-file /dev/null`, includes the ops profile, and prints only service
networks, published ports and labels. It asserts no published app/database/migrator ports,
private database isolation, external app network, routing labels and port/origin agreement.
It does not start services, create networks, pull images or read real secret files.

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
`CONTACT_URL` and `ENCRYPTION_KEY_VERSION` (default 1). Set `PUBLIC_ORIGIN` to
`https://galaxy.bubbleaio.uk` even though the override fixes its effective value, because
the base file interpolates this required field before merging. `GALAXY_HTTP_PORT` applies
only to the base image-test configuration; it publishes nothing with the production override.
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

PostgreSQL has no published port and only joins Galaxy's internal backend network. Only
the app additionally joins the existing external `aio_network` for Traefik and egress;
no Galaxy service publishes a host port. The external network is referenced, not created
or reconfigured. The database and migrator explicitly disable Traefik exposure. Both
long-running services, plus the one-shot migrator, explicitly opt out of Watchtower;
this does not confirm the existing updater's effective mode. Docker socket access is never
mounted into the application. The initial database script creates a non-superuser
`galaxy` role that owns only its application database/schema. V1 uses that role for
explicit migrations too. It has DDL authority within this database, not cluster admin.
The bootstrap script runs only on a new volume; changing its password file later does
not rotate an existing role's password.

## Start, migrate, observe and stop

After Task 9 approval and environment/secrets preparation, the intended project-scoped
sequence is:

```sh
# Future deployment only, after separate approval. Run from Galaxy's checkout.
# This env file contains nonsecret metadata; secret values stay in mounted files.
galaxy_compose() {
  docker compose --env-file /path/to/galaxy-deployment.env \
    --project-name galaxy-neegy -f compose.yaml -f compose.production.yaml "$@"
}
galaxy_compose --profile ops config --quiet
galaxy_compose up -d --wait postgres
galaxy_compose --profile ops run --rm migrate
galaxy_compose up -d --wait app
galaxy_compose exec -T app node -e "fetch('http://127.0.0.1:3000/health/ready',{signal:AbortSignal.timeout(2000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# Graceful stop when needed; does not touch the aio project.
galaxy_compose stop app
```

Use both files and the same project/env file for every operation, including migration,
health checks, stop and recovery. Host `curl localhost:3000` is not a production health
check because no host port is published. Do not combine Galaxy with
`/opt/docker/compose.yaml`, use the `aio` project name, recreate `aio_network`, or run
broad stop/down/prune commands. The confirmed existing services stay in their project.

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
For intermittent dashboard access warnings, see [the reproduced settings-load sequence](settings-access-investigation.md).
Failed protected API reads/writes emit only route template, status, timingMs and category;
temporary Discord verification failures are 503, while confirmed access denials remain
403. Capture only those four fields when checking a live failure; do not dump headers,
cookies, environment variables, response bodies or raw Discord errors.
Container/proxy retention and encrypted backups must be configured separately in Task 9.

For repeated settings-page failures, see [dashboard REST reliability](dashboard-reliability.md).
Collect only the existing route/status/timingMs/category diagnostic records. The fix
requires no new secrets, database migration or Compose setting. Permission lookups are
shared only while pending; a later operation verifies current membership again.

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


## Remaining release, DNS, secrets and recovery gates

These are preparations to review, not actions performed by this PR:

1. Choose registry, visibility/access and approved source commit; separately authorise
   publication of tested native AMD64/ARM64 images, immutable commit tags and a manifest
   digest. Record the verified digest in `GALAXY_IMAGE`; no mutable `latest` deployment.
   Push/PR CI builds/tests locally and never publishes. The proposed manual-only
   [registry release procedure](release.md) must be reviewed before first use; merging
   it does not publish or deploy. It verifies exact-source CI, builds/smokes natively,
   publishes tested archives and reports the observed index digest/platforms/pull access.
   Host registry authentication,
   if needed, must be arranged through secret storage after authorisation.
2. Separately authorise DNS for `galaxy.bubbleaio.uk` to the verified public Oracle
   address. The inventory's `10.0.0.214` is private and is not an Internet DNS target.
   Confirm any AAAA record, Cloudflare proxy/challenge compatibility and the existing
   `cloudflare-ddns` updater's scope before changing records. Confirm Traefik's
   `websecure`/`letsencrypt` configuration and certificate issuance; do not alter the
   current proxy or other routes as a side effect.
3. Supply application/creator/test guild IDs and contact URL, then provision the six
   secret files above with verified container readability and host protection. Keep
   provider keys in the dashboard's write-only credential flow. Register the exact
   OAuth redirect above in Discord and perform live login/secure-cookie checks later.
4. Choose an off-VPS destination, encryption method/key custody, schedule and maximum
   seven-day retention. Implement project-scoped, consistent PostgreSQL backups,
   encryption before off-host transfer, monitored failures and deletion/expiry. Protect
   the separate application encryption key so restored provider credentials remain
   recoverable. No backup automation or successful backup is claimed by this PR.
5. Before enabling AI, restore a backup into an isolated database/project without live
   Discord/provider egress. Verify schema head, settings/approval, encrypted credentials,
   accounting/uncertain holds and replay prevention; record recovery time and results.
   Test schema-aware recovery, since an older image rejects a different migration head.
   A backup file without a demonstrated restore is not a verified recovery plan.
6. Reconfirm the existing stack and Watchtower's effective mode with selected read-only
   fields. Only after a separate deployment instruction, deploy Galaxy's exact approved
   digest with explicit migrations, check HTTPS readiness and complete the remaining
   opt-in live/physical Android checks in the checklist. Verify Stremio remains healthy.
