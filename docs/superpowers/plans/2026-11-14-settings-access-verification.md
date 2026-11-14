# Settings access warning investigation and regression plan

Goal: reproduce the actual settings-page load from application2268d0d with mocked
Discord HTTP and isolated PG, then fix confirmed transient/denial misclassification.
Current main0277 has no src/web changes from2268. Stop with PR unmerged; no live
credentials, paid provider calls, registry release, VPS access or deployment.

Task1: instrument test fixtures only, retain real DiscordRest/DiscordMembership/AccessPolicy/
SettingsService/Fastify and real browser Settings/Access components. Trace four concurrent
initial GETs(settings/channels/status/errors), then grants after successful render. Test
healthy slow responses, concurrency-induced429, late grants429/5s timeout, true404/member
loss. Confirm old HTTP403 and both warning-only/full-editor-warning states BEFORE fixes.

Task2: minimal typed verification-unavailable classification through membership/policy/web,
503 for uncertainty while explicit denials stay403; no cached positive permissions,
no creator bypass or relaxed guild/role/approval/grant checks. Accurate retry UI, drafts
safe; grant-list loading failures scoped to that panel. Add only safe failed-route
telemetry if required: fixed route template,status,timing,error-category, never IDs,
URLs, text, keys, cookies/raw exceptions. Keep existing time bounds and request freshness.

Task3: unit fake-clock edge cases, real-PG HTTP concurrency/slow/429/denial regressions,
mobile+desktop browser initial/retry/grants scenarios. Preserve revoked approval/roles,
member departure, forged IDs, delegated-user restrictions and unsafe mutations.
Docs must separate reproduced code cause from unobserved live upstream failure.

Review focus: swallowed transient errors mislabeled403; stale allow-cache; per-server
isolation; deferred grants failure blamed on session; retries overwriting drafts;
CSRF403 confused with membership; diagnostics leaking identifiers or raw errors.

- [x] Characterize actual old page-load/HTTP outcomes and record evidence.
- [x] RED→GREEN classification and retry regressions, no authorization weakening.
- [x] Full unit/integration/browser/lint/types/build; fresh independent review/fixes.
- [ ] Commit/push/open PR; latest AMD64/native ARM64 CI; stop unmerged/no release.
