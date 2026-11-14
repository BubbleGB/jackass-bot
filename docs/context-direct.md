# Task 4: bounded channel context and direct eligibility

These are internal backend services, with injected Discord REST, clocks, counters and
configuration. Runtime Discord events, slash acknowledgement, sending/typing and output
mention controls remain Task 6; queueing/global worker control is implemented by Task 5 in [automatic.md](automatic.md). Foundation
startup still validates config and exits. No live provider/Discord calls or production
keys were used to verify this task.

## Composition and boundaries

Construct one `DirectEligibility` per application, with
`PostgresConversationConfigRepository`, `DiscordContextSource` and a clock. Construct
`ContextBuilder(history, providerInputCounter.countInput)`, where `ProviderInputCounter`
uses the existing provider repository, cipher and adapter map. Construct `DirectService`
with those services and `ProviderRouter`. Do not substitute user-only tokenization or
character estimates for this complete-request counter. Keys remain within providers.

`handleDirect(request)` returns an accepted answer/silence/refusal or an eligibility
status. Oversized required input returns the typed
`{status:'input_too_large', message:string}` user-safe result; it never generates a shorter
version of the request. It does not deliver Discord messages. `acceptDirect(request, now?)` returns
accepted/cooldown/disabled/unsupported/busy. The caller obtains all event IDs and identities
from authenticated Discord events/interactions, never a user-supplied identity field.
For mention/reply, request.id is the original message snowflake; for ask it is the
interaction snowflake. All direct IDs must be canonical 17–20 digit strings.

The internal config reader uses one PostgreSQL statement/snapshot for enabled approved
settings and safe provider metadata. It does not grant dashboard access or expose keys.
The direct switch and fresh channel/member permissions are checked before acceptance.
An actual mention/reply trigger is fetched by ID from the same channel, validated as the
requester's human, non-webhook message, and checked for a bot mention or same-channel reply
to this bot. No remote referenced-message content is fetched. Deleted/unresolved reply
references fail closed. Ask prompts are supplied in memory; interactions are never fetched
as channel messages. No heuristic classifies greetings, slang, typos or other languages
as gibberish. Empty/oversized ask prompts are rejected; structured provider silence remains
the only model-level silence signal.

## Current Discord permissions

`DiscordContextSource` uses injected bot-authenticated REST GET calls for the channel,
guild, requesting member, bot member and roles. It accepts only channel type 0 GUILD_TEXT,
matching guild/channel IDs and current human membership. It applies everyone, aggregated
role and member overwrites in documented order; Administrator/owner bypass overwrites.
Bot and requester both need View Channel, Read Message History and Send Messages. Requiring
read history for the requester prevents disclosing channel history they cannot currently
read. Timed-out ordinary members are excluded. No broad member/presence intent is needed.

Context checks permissions before fetching, immediately before each outbound count and after work, and direct orchestration checks again
immediately before routing. The router's optional expectedRevision rejects a changed saved
configuration before any provider count/generation, and its existing candidate checks
remain in place. Each final routing estimate is also checked against the current saved
contextTokenLimit before reservation/generation: a candidate recovering after sizing
cannot bypass the ceiling. Oversized candidates are skipped without permanent blocking. Provider counters also bind to that guild/revision/instructions/model/
effort/generation cap. Network activity cannot be atomic with a later Discord permission
change; Task 6/8 must recheck before delivery and cancel known stale work. No cached
permissions, stored chat, linked page, attachment or media downloads are used.

## History selection and budgets

- At most three pages of 100 messages, including ignored rows when tracking the raw page
  cursor. Repeated/nondecreasing cursors stop pagination. Recent messages are selected by
  count, not age; a page limit may return fewer than configured caps in a busy bot channel.
- Drop other guild/channel data, other bots, webhooks and unsupported system message types.
  Keep this bot's own text under the independent self cap. Content is chronological,
  deduplicated by message ID and ends at the triggering message. Ask snapshots end at
  request.receivedAt. Fresh trigger content replaces duplicate history copies.
- Human/self caps apply to **previous history only**. The intact current mention/reply
  or synthetic `ask:<interactionId>` prompt is required input, separate from history caps,
  and appears exactly once. humanContextLimit=0 disables previous human history while
  allowing direct requests; selfContextLimit remains independent. With both history caps
  zero, no history pages are fetched. Maximum direct context is 100 human history + 20
  own-bot history + one current request, or 121 messages. Automatic context remains 120.
- Count all actual supplied instructions, structured untrusted history and schema using
  each eligible funded selected model's Task 3 input estimator. The entire estimated input
  (including Google's engineering margin) must fit contextTokenLimit, and input + total
  generation ceiling must fit the catalog's existing conservative context check. Unknown
  models/incompatible settings are rejected. Failed/unavailable provider preflights update
  health and may leave another eligible model; safety/unknown rejection is terminal.
- Preserve **all server instructions and all current direct-request text**, including
  when history is trimmed. Drop oldest optional messages in whole-message batches,
  retaining newer history. Never silently shorten instructions or current input. If the
  intact required input cannot fit contextTokenLimit and the model's configured generation
  ceiling, reject with `input_too_large` before reservation/generation. Native counting may
  be used to determine fit; it is not a generation API call. A larger final routing count
  also produces typed input-too-large if no generation was attempted. If a primary was
  already sent before a fallback size rejection, normal failure/uncertainty handling
  remains; it is never labelled as a pre-generation rejection.
- At most 24 sizing rounds and one 20-second context deadline, including uncooperative
  dependencies. Trim optional whole history before retrying over-budget payload bytes;
  never reduce required input to satisfy the 1 MB context / 8,000 instruction / 6,000
  current-text character guards. Oversized required content gets the same typed result.
  A late timed-out counter cannot start another count.

## Automatic context construction (no scheduling)

`buildAutomaticContext(request, settings)` only constructs context; it does not accept,
queue, schedule or generate automatic requests. Task 5 will supply eligible automatic
triggers and consume its typed result. Its mode reflects saved autoPolicy, independent
of the direct switch, and the same current channel/permission checks apply. The current
human event is ordinary capped conversation context here, not an extra direct prompt.

The result is `{status:'ready', context}` or `{status:'skipped', reason}`. Safe reasons are
`no_usable_context`, `input_too_large`, `context_check_limit`, and `context_unavailable`. Ignore blank or overlong optional automatic
rows before counting history slots; retain the newest nonblank human message while
removing optional older messages/own-bot text. Never send instructions alone or bot-only
conversation for an assessment. If the newest whole human message cannot fit, try older whole human messages from the
selected context, newest first. Skip with `input_too_large` only once those choices are
exhausted; if the 24-round work bound is reached, use `context_check_limit` rather than
claiming every candidate is too large. Server instructions and generation limits stay
unchanged throughout. Zero human
history consequently skips automatic context with `no_usable_context`. This is a nonblank
text requirement, not a gibberish/language heuristic: greetings and slang still qualify.

Counting may happen more than once while fitting and again at reservation. It does not
increment generation-attempt counters. Generation still goes exclusively through Task 3's
atomic reservations and normal fallback. Exhausted/permanently blocked/backed-off provider
candidates can be skipped while counting. Final actual usage replaces estimates in full.
The Google schema projection/margin remain engineering estimates; context fitting and daily
allowances are not guaranteed hard billing caps. In-flight calls and estimation error can
overshoot allowances, which are never increased automatically.

## Cooldown and outstanding state

The five-second cooldown begins at acceptance using the injected clock, keyed by guild
and user across channels. The same user has one outstanding request until completion,
even after the cooldown expires. The post-lookup check and insertion have no await between
them, closing concurrent eligibility races. Other users/guilds are independent.

`DirectService` releases outstanding state in finally on answer, explicit silence, refusal,
context/config/permission error and provider failure. Release is matched to request ID;
it does not erase the acceptance cooldown. State contains identifiers/times only, with
10,000 entries maximum and expired idle entries pruned on capacity pressure. It is local
to one process, so a restart clears this five-second gate. The user explicitly accepted
this behavior for v1; cooldown persistence is not a remaining blocker. Task 5's singleton/queue guard now composes these services before runtime activation. There is no automatic retry or delivery here.
Future slash handlers must acknowledge cooldown/busy privately; mentions/replies may be
ignored. Duplicate generation receipts remain Task 3's responsibility; no Task 5 counters
or automatic scheduling have been added.

## Evidence and limits

Unit tests use injected clocks, complete Discord REST fixtures, mocked provider HTTP,
and deterministic counter fixtures. Integration tests use unique disposable PostgreSQL
databases and exercise the real config reader, counter bridge, direct service, router,
reservations and settlement. The PR records exact local/native AMD64/ARM64 results.
Mocked tests prove our boundaries and arithmetic, not real permissions freshness, provider
acceptance or billing. No browser/live Discord/event/delivery scenario is claimed tested.
