# Task 4 context and direct requests implementation plan

> For agentic workers: use superpowers:executing-plans inline, then one fresh final review.

Goal: implement Task 4 of the approved updated handoff, using existing backend contracts.
Spec: ../../galaxy-neegy-handoff.md, A1–A4/A8 and Task 4; user's Task 4 execution request.
Architecture: injected Discord REST/history and complete-request input counter, bounded
chronological context, current config/permission checks and a per-guild/user direct gate.
Tech stack: pinned Node 26.13.1/npm 11.20.0, TypeScript, Vitest, existing PostgreSQL.

## Constraints and decisions

- Cloud and isolated data only; no paid calls, production keys, Task 5, VPS or deploy.
- No new dependencies. No durable conversation text, raw errors or API keys in logs.
- Keep Task 3 estimate/actual accounting and bounded fallback unchanged.
- Work in the requested local checkout/feature branch; no extra worktree.
- Use the handoff's already approved design; implementation details are builder choices.
- User correction supersedes the initial cap/truncation decisions: human/self caps
  cover historical messages only; current direct text is separate and included once.
- Instructions and current direct text are required and never truncated. Remove oldest
  optional whole history first; return typed input_too_large without generation if
  required input + generation allowance cannot fit. Preserve one nonblank human message
  for automatic context or return a diagnosable skip; no Task 5 scheduler is introduced.
- At most 3 pages of 100 messages, 300 scanned, 120 history + one direct request selected.
  No reference/media fetches. Restart clearing cooldown state is user-accepted for v1.
- Conservative prefilter: reject empty slash prompts only; never guess that slang is spam.

## Review focus

- Cross-guild/channel forged history and duplicate trigger rows must not escape filtering.
- Permission loss or revision changes during fetching/counting must stop provider calls.
- Tiny budgets/oversized trigger: preserve full required content or return typed rejection without generation.
- Concurrent async eligibility checks must not admit the same user twice; release by ID.
- Count failures/timeouts must fail closed without leaking keys or conversation text.

## Steps

- [x] Context tests RED: isolation, caps, ordering/paging, trigger/ask dedup, token trimming,
   zero caps, model fit, lost permissions, bounded hung fetch/count, adversarial input.
   Implement context.ts and shared conversation ports/errors in types.ts. GREEN.
- [x] Discord tests RED: REST channel types, fresh user/bot permissions and overwrite order,
   channel-scoped message/history retrieval and no webhook/bot triggers. Implement
   discord.ts with injected DiscordGet; no network client/events/delivery. GREEN.
- [x] Direct tests RED: current approved/enabled config, switch, cooldown boundaries,
   cross-channel/user/guild gates, concurrency, outcomes/failures cleanup, greetings,
   stale permission/config and request validation. Implement eligibility.ts/direct.ts.
- [x] Add internal PostgreSQL config reader and isolated tests, plus optional expected
   settings revision on provider router to close stale-context/config race. RED → GREEN.
- [x] Documentation: contracts, counter wiring, limits, zero cap behavior and future wiring.
   Run lint/typecheck/unit/integration/build/drift/startup; final read-only review; fix
   findings with RED → GREEN; commit, push, open PR and monitor native AMD64/ARM64 CI.

Expected: every verification command exits 0; final PR remains open/unmerged.

Initial implementation/review at fa52564: 160 unit and 64 isolated PostgreSQL tests, lint,
typecheck, build, migration consistency and foundation startup passed. Two review findings
received failing regressions before fixes: permission loss before native counts and
provider recovery bypassing the fitted input cap. Remote CI results live in the PR.

Follow-up user correction: regressions cover zero-history mention/reply/ask, exact intact
required input, oversize rejection without generation/reservation, history trimming order,
automatic meaningful-context skip reasons and native 121-message direct request guards.
Updated verification results are recorded in PR #4.

Required-input follow-up verified locally: 180 unit tests, 68 isolated PostgreSQL integration
tests, lint, typecheck, build, migration consistency and foundation startup passed. Fresh
read-only review found no Critical/Important issues; its automatic overlong-trigger fallback
edge received a failing regression, a fix and the full green suite before push.
