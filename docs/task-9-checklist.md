# Task 9: deployment inputs and live acceptance

Repository-only Task 9 deployment preparation is authorised on `feat/task-9-deployment`:
Compose/Traefik configuration, documentation and isolated dummy-value validation only.
PR #8 merged as `126e4f8`. Production credentials, registry release, DNS changes, VPS
connections and deployment still require separate instruction. The supplied
Galaxy Neegy logo is already bundled; no further artwork input is required.

## Inputs and host inventory

- Confirm Discord application, creator, test guild and channel IDs, creator contact link,
  public origin `https://galaxy.bubbleaio.uk` and exact OAuth redirect
  `https://galaxy.bubbleaio.uk/auth/discord/callback`. The hostname is selected; DNS and
  Discord portal configuration are not yet performed.
- Supply production bot/OAuth credentials, provider keys and encryption key through the
  selected secret store only, plus separate application/admin database passwords. Decide
  filesystem ownership, backup-key custody and future credential rotation procedures.
- Choose registry/release permissions and immutable architecture-specific or manifest
  digest for the tested commit. No registry publication is configured by Task 8.
- Choose encrypted off-VPS backup destination, encryption key, schedule and maximum
  7-day retention. Implement and test an isolated restore before enabling AI.
- Initial owner-supplied inventory confirms Ubuntu ARM64, Docker 29.6.2, Compose 5.3.1,
  167 GB free and existing Traefik on `aio_network`, with the aio stack at
  `/opt/docker/compose.yaml`. Watchtower's effective mode remains **unconfirmed**.
  SSH host identity and selected routing/TLS/updater details still need verification
  after separate authorisation; no agent connection to the VPS has occurred.
- Validate `compose.yaml` + `compose.production.yaml` as project `galaxy-neegy`:
  `npm run test:compose` verifies no published ports and only app on `aio_network`.
  PostgreSQL/migrator remain private, Traefik-disabled and Watchtower-excluded.
  Never modify the existing aio Compose project to add Galaxy.
- Present the exact project-only deployment/HTTPS/DNS/migration plan. Do not prune
  globally, replace existing services, expose PostgreSQL or perform unrelated upgrades.

## Live checks carried from Tasks 6–8

- Test the real OAuth redirect, denial/state failure, login/logout, secure cookie through
  HTTPS, session expiry and `/settings` return to the correct server after login.
- Test bot invitation/owner approval guidance and creator contact URL. Confirm intended
  minimal Discord permissions and Message Content intent in the application portal.
- Explicitly register commands in a test guild; approve global registration separately.
  Reconnect/restart must never register commands automatically.
- In an opt-in test server, verify real mentions/replies, public `/ask`, private `/settings`
  and `/status`, typing cleanup, safe user/role/everyone mentions, long-answer chunks,
  permissions disappearing before send and bounded delivery-only retries. Avoid inducing
  ambiguous production sends; document possible accepted-but-unacknowledged messages.
- Verify owner/admin/delegate/creator access, member/role removal during a session,
  approval revocation, key write-only behaviour and direct backend restrictions.
- Check the threshold/direct collision, minimum gap on a later human event, deliberate
  silence, restart pending counts, per-user cooldown and uncertain request no-replay.
- With separately authorised small paid provider calls, verify configured models/efforts,
  reported usage and failover, allowances/UTC reset and provider privacy disclosure.
  Daily allowances remain estimates with possible overshoot, never hard billing caps.
- On a physical Android phone, inspect landing/server/editor/privacy at normal and large
  text sizes: navigation, keyboard, scrolling, Save reachability, errors, conflict recovery
  and confirmation. CI's 390px Chromium viewport is not a physical-device result.
- Verify TLS/certificates, Traefik-to-app routing on `aio_network` with no host ports,
  private database, secret file access,
  read-only/non-root app, Watchtower exclusions, readiness and graceful stop on the actual
  ARM64 host. Check other existing services remain healthy.
- Record image digest, migration head and test evidence. Verify restore and schema-aware
  rollback limits; an older image refuses a newer migration head. Confirm log retention
  and encrypted backup expiry match the public privacy page before owner acceptance.

Enable other servers only after the owner accepts these results. No Task 9 item is
marked passed by Task 8's mocked tests.

The exact two-file operator commands, requested Traefik labels and staged release/DNS/
secrets/backup/restore procedure are in [the runbook](runbook.md). No live checklist item
is passed by a rendered configuration or isolated image test.
