# Task 5: automatic assessments and scheduling

Internal services only. No Discord client/events, typing, sending or deployment is started.
The foundation program still validates config and exits. All provider/Discord HTTP tests
use injected fixtures and an isolated PostgreSQL database. No new dependency is added.

## Composition

Create one `PostgresWorkerGuard`, one `ConversationQueue(clock)`, and one `AutomaticService`
with the config/history/context/direct/provider services from Tasks 3–4, an
`AutomaticRepository`, the same clock, and an in-memory `onOutcome` callback. Call
`service.start()` before accepting events. It takes the database session advisory lock,
recovers interrupted metadata, then accepts work. A second worker cannot start. Graceful
`service.stop()` first closes admission, waits for an overlapping startup/recovery, rejects
waiting work and drains active pipelines including successful completion bookkeeping, then
releases the lock. Active work retains ownership while draining; new events are refused.

`observeMessage(request, now?)` accepts current human message events (automatic, mention,
reply), returning counted/eligible/ignored. Slash interactions do not increment activity;
use `submitDirect(request)` for /ask. The future Discord adapter supplies authenticated
IDs and awaits admission, then consumes `onOutcome` or direct results for delivery. This
module never sends a Discord message or retries delivery. Keep one shared queue for both
modes; bypassing it or the worker guard is not supported runtime composition.

Direct acceptance/cooldown happens before queueing. A queued request remains outstanding
for its user/server; full/stale/stopped/error/success cleanup releases that state without
erasing the five-second cooldown. Cooldown reset on restart remains accepted for v1.

## Durable observation and readiness

Fresh Task 4 channel/member permissions and a channel-scoped trigger lookup verify the
human author. Reject bots/webhooks, DMs, threads, other guild/channel content and disabled
or unapproved servers. Selected automatic channels alone accumulate activity; a valid
direct trigger in an unselected channel can still use the server's direct switch.

Under the same PostgreSQL guild advisory transaction lock used by settings and usage:

1. Check current approval, enablement, config revision and selected channel.
2. Insert `event:<messageId>` receipt. On conflict, do nothing: no duplicate count or
   second queued direct request, including simultaneous Discord deliveries.
3. Increment selected channel pending_count once. Persist only latest human event/user
   IDs, timestamp and whether it is a direct trigger. Compare IDs to retain the newest
   message when events arrive out of order. No chat text or generated answers enter DB.
4. A mention/reply with direct enabled clears automatic readiness and dispatches direct
   only. It still counts toward activity; its response never consumes automatic counts.
5. Otherwise mark ready only when threshold is met, the last-success gap has elapsed,
   and no assessment is active. A new ordinary eligible human event is necessary.

`ready_event_id` separates ready work from a merely large count. Crossing the gap boundary
or restarting does not set it. There is no timer, polling loop, autonomous recovery probe
or automatic startup scan that turns pending counts into provider calls. Removing a
selected channel cascades its activity state. Existing settings locks prevent stale
configuration observations from being committed.

## Snapshots and policies

At queue dispatch, `begin` checks current selected/approved/enabled settings and readiness
again. It stores a UUID assessment ID and the entire pending count as assessment_snapshot.
The request uses the latest counted human metadata, so messages arriving while a job was
waiting are included in the start snapshot. If the latest event was a direct trigger,
queued automatic work skips and leaves activity ready for a later ordinary human event.

Build context with Task 4's full instructions/meaningful-human rules. Modes are explicitly
instructed in the trusted provider prompt:

- Always contribute: contribute to meaningful conversation; clearly meaningless spam may
  still receive deliberate structured silence.
- Only when appropriate: choose structured silence if a useful contribution is unwarranted.

The provider, including its explicit refusal/silence result, still goes through Task 3's
normal reservations and usage reconciliation. A successful result consumes exactly the
snapshot and sets last_success_at. Starting at 30 while three new messages arrive leaves
3, including on deliberate silence. Finish matches assessment UUID and amount, so duplicate
or stale completion cannot subtract twice or clear a newer assessment. Provider failure,
pre-generation context skip or changed config preserves counts and last-success time,
clears the processing snapshot, and requires another eligible human event before retry.

## Queue boundaries

Limits live in `schedulingLimits`: two active pipelines globally, ten waiting requests per
channel and 100 waiting globally. Active work is excluded from waiting limits. Each
channel runs one job at a time in admission FIFO order across direct/automatic work.
Direct priority applies to ready channel heads; after three direct starts, a waiting
automatic head gets a turn. A direct request never jumps ahead of an earlier job in its
own channel. Channel identity includes guild ID. Completed/failed jobs free all slots.

At dispatch, drop work 30 seconds old according to the injected clock. Queue expiry does
not call providers; safe request_stale/queue_full/worker_stopped outcomes go to the caller
for future slash acknowledgement/direct notices. No timeout timer initiates automatic
assessments. A full/stale automatic job preserves activity; a later eligible message can
try again. Queued jobs and any direct text live only in memory, bounded by these limits.

## Ownership loss and restart

The singleton is a session advisory lock on a dedicated PostgreSQL connection, with
serialized health probes and a persisted UUID fencing token in `worker_ownership`. Taking
ownership replaces the token before startup recovery. Every activity observation, begin
and finish checks that token under a shared row lock inside its transaction, before the
guild lock. Recovery takes an exclusive row lock and requires the same token. A delayed
old transaction therefore either finishes before takeover/recovery or is rejected; it
cannot claim or erase replacement readiness. The token contains no credentials or chat. It does not use a clock-expiring lease that could expire while
a healthy process still runs a provider call. Losing/stopping the session aborts the
worker signal and closes queued work. Context/token-count requests receive that signal.
The provider router checks ownership and current eligibility before counts and immediately
before each generation, including fallback, with its existing attempt deadline.

A provably unsent reserved attempt is released. An interrupted generation keeps its full
uncertain charge and cannot fall back after worker loss. Remote inference already sent
may continue despite local cancellation; no guarantee of exactly-once remote execution or
hard billing caps is made. Keep such charges/reservations conservative.

Startup under the exclusive lock marks processing generation receipts uncertain and seeds
an uncertain receipt for an interrupted assessment event if necessary. It clears processing
snapshots/readiness, preserves pending counts/latest metadata/last-success time and never
frees usage reservations. No queued text or answer is recovered from DB. The same event is
not replayed. Only a new eligible human event can initiate a new request; old uncertain
charges still reduce available allowance. UUID matching fences late old completions.

A process/DB/network failure can leave a remote call or delivery uncertain. Task 6/8 must
preserve this no-regeneration boundary when adding live transport/delivery/lifecycle.
Task 8's receipt retention must continue preventing old gateway replay after cleanup;
this task adds no cleanup schedule or claims of indefinite event retention.

## Verification and remaining scope

Unit tests cover queue limits, FIFO/no overlap, fairness, stale work, stop/failure cleanup,
direct outstanding/cooldown admission and provider ownership cancellation. Real PostgreSQL
integration tests cover duplicate/concurrent messages, direct collisions, gap without
clock-only triggering, 30+3 snapshots, idempotent/stale finish, both policies, silence,
failure/context skip, worker overlap, delayed stale transactions, startup/shutdown overlap, successful active
shutdown completion and interrupted real-router recovery with an unchanged
uncertain charge. Latest local and native AMD64/ARM64 CI results are recorded in the PR.

Task 3's practical allowance policy and Task 4's intact required-input/history rules stay
in force. Model counters and Google margins remain estimates as documented; actual usage
is recorded in full and allowances never increase silently. Mocks do not establish live
Discord freshness, API acceptance, billing or operational deployment behavior. Delivery,
slash acknowledgement/typing, gateway lifecycle and deployment remain their later tasks.
