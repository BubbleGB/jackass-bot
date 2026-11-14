# Task 7 dashboard implementation plan

> Execute inline with TDD and one fresh whole-branch review.

Goal: implement the approved handoff Task 7 and the user's six dashboard flows.
Architecture: Fastify JSON/auth boundary, PostgreSQL opaque sessions, React/Vite assets;
all policy remains in Task 2 services. Foundation startup remains validation only.
Spec: ../../galaxy-neegy-handoff.md Task 7, current user acceptance cases.

Constraints: navy/purple/gold; supplied logo only (never recreate); Android 390px and
desktop; no live credentials/OAuth/provider calls/DNS/VPS/deployment; PR stays unmerged.

Decisions: identify-only OAuth; discover installed approved guild candidates from DB,
fresh AccessPolicy on each read/write, so no stored OAuth token or stale guild-list proof.
Hashed one-use browser-bound state (10 min), session rotation (12 h), HttpOnly/Lax/Secure
production host cookie; synchronizer CSRF token and exact Origin on all mutations.
Relative return paths limited to /servers or /servers/:snowflake preserve /settings links.
Drafts stay in memory/tab session storage (never keys), revision conflict requires an
explicit compare/rebase-or-discard step; no automatic overwrite. API keys never persisted
in browser storage. Existing SettingsService owns grants, credentials and allowance limits.

Review focus: session fixation/state replay; removed roles/left guild with open browser;
forged guild/actor and direct delegate mutations; conflict retry loses unrelated edits;
XSS/secret leakage and cross-origin mutation. Each gets backend/browser regression coverage.

- [x] Auth/HTTP RED→GREEN: state mismatch/reuse/expiry, cookies, CSRF/Origin, session
  rotation/logout, deep links. Files src/web/auth.ts, oauth.ts, server.ts; tests web-auth.
- [x] Real-service isolated-PG routes RED→GREEN: fresh access/forged IDs, dashboard
  settings, channels/ACL, status/errors/approval, write-only keys/delegate restrictions.
  Files src/web/routes.ts, directory.ts; SettingsService safe diagnostics as needed.
- [x] React pages + responsive CSS: landing, selector, settings, creator. Browser tests
  before UI, then 390px/desktop save/errors/conflict/drafts/safe text/permissions tests.
- [x] Exact registry pins and official OAuth/cookie documentation; build/test scripts,
  native browser CI, architecture checks, screenshots, setup/privacy contracts.
- [ ] Full checks, inspect captures, fresh review/fix regressions; commit/push/PR and
  verify latest AMD64/native ARM64 CI. Publication results recorded in PR.

Execution note before first push: fresh whole-change review completed. Regression fixes
cover pending-mutation locks, real safe-error codes, long-name wrapping, live usage refresh
and separation of backend/static output. Native CI evidence will be recorded in the PR.
