# Task 9 deployment preparation implementation plan

> Inline execution with one final independent review; repository preparation only.

Goal: prepare the explicitly requested Traefik/Compose configuration for the confirmed
Oracle inventory, validate it with dummy inputs and open an unmerged PR. No deployment.
Spec: the user's Task 9 preparation request and docs/task-9-checklist.md.
Architecture: retain the Task 8 base Compose for isolated image testing; add an explicit
production override. Compose !reset removes inherited port mappings and !override replaces
app networks with backend + the existing external aio_network. No existing stack edits.

Constraints: own project galaxy-neegy; only app joins aio_network; DB/migrator backend only;
no published app/DB ports; router galaxy-neegy at Host(`galaxy.bubbleaio.uk`), websecure,
TLS letsencrypt, service galaxy-neegy port3000; traefik false on DB/migrator; Watchtower
false on app/DB/migrator, effective host Watchtower mode unconfirmed. No new credentials,
registry publication, DNS, VPS connection, live services, deployment or merge.

Review focus:
- Inherited base loopback mapping survives a naive empty list: assert real merged ports[].
- App retains its base egress network: assert exact backend/aio_network membership.
- PostgreSQL or migrator joins shared network/becomes routable: assert private-only/labels.
- TLS router service port/public origin disagree with runtime: assert3000/HTTPS origin.
- Runbook accidentally points operators at base-only commands: use explicit two-file commands.

### Task 1: production override and executable rendered-config contract
Files: compose.production.yaml, compose.yaml (explicit Traefik exclusions),
tests/compose/production.mjs, package.json, eslint.config.js, .github/workflows/image.yml.
- [x] Add real Compose-rendering regression with dummy env/--env-file /dev/null.
- [x] Observe inherited-port failure before adding !reset; assert networks, labels, port3000
      and production public origin. Check all services including ops migrator.
- [x] Add override with exact requested routing and explicit network/port replacement.
- [x] Run contract; emit safe per-service network/ports/label summary, no env/secrets.
- [x] Put same contract before native image CI on both architectures, no daemon mutation.

### Task 2: operations/checklist documentation and verification
Files: docs/runbook.md, docs/task-9-checklist.md, README.md.
- [x] Record confirmed inventory and unconfirmed Watchtower/Traefik static settings.
- [x] Document explicit two-file project commands, internal HTTP3000, exact OAuth redirect,
      no host ports, unchanged external stack, image/DNS/secrets/backup/restore gates.
- [x] Run lint/types/unit/build and real rendered-config check locally; review diff.
- [ ] Commit/push/open PR, observe latest AMD64/ARM64 CI (including existing mocked image
      and DB/browser jobs); fix in-scope failures; stop unmerged.
