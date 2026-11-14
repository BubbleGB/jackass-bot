# Task 9: deployment inputs and live acceptance

Task 8 does not authorise these actions. Obtain a separate Task 9 instruction before
production credentials, registry release, DNS, VPS access or deployment. The supplied
Galaxy Neegy logo is already bundled; no further artwork input is required.

## Inputs and host inventory

- Confirm Discord application, creator, test guild and channel IDs, creator contact link,
  intended public HTTPS origin and OAuth redirect (`/auth/discord/callback`).
- Supply production bot/OAuth credentials, provider keys and encryption key through the
  selected secret store only, plus separate application/admin database passwords. Decide
  filesystem ownership, backup-key custody and future credential rotation procedures.
- Choose registry/release permissions and immutable architecture-specific or manifest
  digest for the tested commit. No registry publication is configured by Task 8.
- Choose encrypted off-VPS backup destination, encryption key, schedule and maximum
  7-day retention. Implement and test an isolated restore before enabling AI.
- Verify SSH host identity and inspect existing containers, ports, proxy, disk, networks,
  Watchtower and Stremio services read-only before proposing project-scoped changes.
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
- Verify TLS/certificates, loopback HTTP proxy routing, private database, secret file access,
  read-only/non-root app, Watchtower exclusions, readiness and graceful stop on the actual
  ARM64 host. Check other existing services remain healthy.
- Record image digest, migration head and test evidence. Verify restore and schema-aware
  rollback limits; an older image refuses a newer migration head. Confirm log retention
  and encrypted backup expiry match the public privacy page before owner acceptance.

Enable other servers only after the owner accepts these results. No Task 9 item is
marked passed by Task 8's mocked tests.
