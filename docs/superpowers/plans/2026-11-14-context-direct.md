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
- Counts include the current direct message/prompt in the human cap. A zero human cap or
  token budget too small for required input fails closed rather than silently raising caps.
- Required input may be suffix-truncated for token fit, preserving its ID exactly once;
  drop oldest optional history first. Count full instructions/history/schema through an
  injected provider counter for every configured funded supported model; never chars/4.
- At most 3 pages of 100 messages, 300 scanned, max 120 selected. No reference/media fetches.
- Conservative prefilter: reject empty slash prompts only; never guess that slang is spam.

## Review focus

- Cross-guild/channel forged history and duplicate trigger rows must not escape filtering.
- Permission loss or revision changes during fetching/counting must stop provider calls.
- Tiny budgets/oversized trigger: keep newest required content or fail before generation.
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

Local implementation/review complete: 160 unit and 64 isolated PostgreSQL tests, lint,
typecheck, build, migration consistency and foundation startup passed. Two review findings
received failing regressions before fixes: permission loss before native counts and
provider recovery bypassing the fitted input cap. Remote CI results live in the PR.
