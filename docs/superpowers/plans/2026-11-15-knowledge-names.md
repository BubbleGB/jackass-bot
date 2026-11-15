# Knowledge and names implementation plan

Spec: [knowledge-names.md](../../knowledge-names.md), authorised handoff amendment.
Base: `556ac6b87a83d35e01ee21497ce20872246b3007`; branch `feat/server-knowledge-names`.
Mocks/isolated PG only; no paid calls, keys, registry, VPS, merge or rollout.

## Task 1 — central limits, schema, CRUD and retrieval

- [x] RED tests for code-point validation/chunking/query safety and authenticated PG
  CRUD, quotas/races, conflicts, revoked/delegated/cross-guild access, fresh FTS results.
- [x] Add `src/knowledge/{limits,text,types,service,repository}.ts`; entry metadata/detail
  API and safe error mappings. Reuse AccessPolicy and exact advisory locks. Add required
  settings `knowledgeTokenLimit` and nullable audit entry UUID; generated weighted FTS
  chunks and GIN/guild indexes in Drizzle migration/snapshot. Central limits per spec.
- [x] Verify existing populated migration, cascade, metadata-only audits and bounded
  search plans/index costs. List metadata only; body endpoint max 2 MiB JSON requests.

## Task 2 — names and jointly fitted context

- [x] RED unit/integration tests for hostile/Unicode names, safe fallback and 16 logical
  IDs; relevant/no-match/zero-budget retrieval; required input and deterministic trimming.
- [x] Extend domain contracts with optional displayName/KnowledgePassage; bounded name
  metadata/resolver including /ask. `ContextBuilder.buildBundle()` returns fitted
  `{context,knowledge}`; keep message-array wrapper and automatic result compatibility.
- [x] Shared provider payload uses user JSON reference envelope; complete and baseline
  counters enforce marginal knowledge plus overall/model ceilings. Trim ranked knowledge
  to its cap; trim oldest optional history then knowledge for overall fit. Never split
  code points or cut required input; retain automatic human anchor.
- [x] Inject repository freshness into ProviderInputCounter/Router; fail closed if
  passages lack checker; check before/after count and after beforeSend. Reserve full
  estimate and recheck fallback budget; configuration_changed bypasses provider health.
- [x] Wire both direct/automatic production composition and tests through accounting and
  delivery. Notification identities remain context humans only, capped by existing code.

## Task 3 — dashboard editor and public contracts

- [x] RED browser regressions for Knowledge deep-link/auth, 390px large paste/edit/save,
  draft reload/retry/conflict/delete recovery, safe rendering and visible feedback.
- [x] Add Knowledge Settings section/link and budget, independent page/drafts/styles;
  body/title code-point counts, limits, explicit conflicts/switch/discard/save-as-new.
  Reuse backend access/CSRF and no raw HTML. New sign-in return/static routes.
- [x] Update provider privacy/help, runbook migration/recovery and retrieval limitations.
  Capture/inspect mobile and desktop screenshots of actual flows.

## Task 4 — verification and delivery

- [x] Full lint/typecheck/unit/PG/browser/build/Compose and migration-drift checks;
  review migration/index measurement and no sensitive logs. One independent final
  review/fix pass (or scoped task review for delegated task), then commit/push/new PR.
- Delivery gate: verify latest AMD64/native ARM64 project and image CI, fix failures in scope,
  report screenshots/results/rollout requirements; leave PR unmerged.

Review focus: privilege/tenant separation, stale reference transmission even to counters,
request-local failure health, quota races and content-free audits, Unicode/body limits,
full actual accounting and fallback, draft loss, exact schema-hash rollback, malicious
names/reference instructions and notification identity separation.

Observed local verification: 292 unit, 149 isolated PostgreSQL integration and 56 browser
cases pass; lint, typecheck, build, Compose, 40 release-policy checks and migration
snapshot generation pass. Independent review found two reproduced edge cases (fitting
round exhaustion and blank indexed chunks); both have RED-to-GREEN regressions. Native
CI evidence is recorded on the PR rather than predicted here.
