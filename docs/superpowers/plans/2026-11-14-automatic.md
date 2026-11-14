# Task 5 automatic assessments implementation plan

> Execute inline using superpowers:executing-plans, TDD, and one fresh final review.

Spec: ../../galaxy-neegy-handoff.md Task 5 and the user's five acceptance cases.
Goal: durable once-only observation, snapshot accounting and bounded single-worker scheduling.
Architecture: PostgreSQL receipts/channel state under existing guild locks; session advisory
worker lock; one in-memory FIFO per channel, two active pipelines globally, bounded waiting.
Existing Task 3 provider accounting and Task 4 context/direct rules remain authoritative.
Stack: pinned Node26.13.1/npm11.20.0, TypeScript, Drizzle/PostgreSQL, Vitest; no new packages.

## Constraints and decisions

- Cloud only, mocks and isolated PostgreSQL; no live Discord wiring, paid calls, VPS/deploy.
- No chat/prompts/responses in database/receipts/logs; queued direct text stays in memory.
- Event receipts are committed atomically with increments. Mention/reply collisions count
  activity but suppress automatic work until a later eligible ordinary human event.
- Snapshot is captured when queued work starts; consume it once only on successful results,
  including deliberate silence/refusal. Failure/context skip preserve counts and gap time.
- Gap checked only on incoming events/begin, never a timer-triggered assessment.
- Persist latest human IDs/timestamp so queued assessments use current counted context.
- FIFO within channels; direct heads prioritized across channels, max three direct starts
  before an automatic head gets a turn. Two active, ten waiting/channel, 100 waiting total.
- Drop jobs aged30seconds at dispatch; report safe outcomes to future Discord handlers.
- Direct cooldown/outstanding acceptance occurs before queueing; cleanup on full/stale/stop.
- Session advisory lock fences workers. Before provider sends recheck live ownership and
  cancellation. Restart marks unfinished generation receipts uncertain, preserves usage
  holds and counts, clears assessment locks; only a new eligible event schedules work.

## Review focus

- Simultaneous duplicates, direct collisions, out-of-order arrivals and snapshot completion.
- New messages during context/provider work, configuration revocation and stale completions.
- Queue saturation, cross-channel priority/fairness, no per-channel overlap and cleanup.
- Lost worker lock before/between provider calls; unknown remote outcomes remain charged.
- Restart with queued/in-flight work never scans pending counts into automatic paid replay.

## Steps

- [x] RED→GREEN isolated PostgreSQL event receipt/increment, threshold/gap, snapshot,
  idempotent finish, recovery and singleton tests; additive schema/migration only.
- [x] RED→GREEN queue limit/FIFO/concurrency/fairness/stale/stop tests with injected clock.
- [x] RED→GREEN automatic orchestration using fresh current human/channel eligibility,
  Task 4 context builder + Task 3 router; silence/policies/failure/in-flight arrivals.
- [x] Integrate direct admission before common queue; add provider worker-signal/checkpoints
  and tests preventing sends after ownership loss without freeing uncertain accounting.
- [x] Full lint/typecheck/unit/integration/build/drift/startup, final fresh review, fixes,
  docs/commit/push/PR and latest native AMD64/ARM64 checks. Stop with Task5 PR unmerged.

Final review fixes: separate admission from draining; wait for overlapping startup/recovery
before unlock; persist a per-worker fencing UUID checked inside all activity transactions.
Delayed stale begin/finish/recovery cannot steal replacement readiness. Failing regressions
were observed before fixes. Final local lint/typecheck, 192 unit tests, 88 PostgreSQL tests,
build, migration consistency and foundation startup passed. Remote CI results live in PR.
