# Task 4: bounded channel context and direct eligibility

These are internal backend services, with injected Discord REST, clocks, counters and
configuration. Runtime Discord events, slash acknowledgement, sending/typing and output
mention controls remain Task 6; queueing/global worker control remains Task 5. Foundation
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
status; it does not deliver Discord messages. `acceptDirect(request, now?)` returns
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
- The current trigger or synthetic `ask:<interactionId>` prompt occupies one human slot;
  all human context stays within humanContextLimit, and self stays within selfContextLimit.
  With humanContextLimit=0, direct context fails closed: enable at least one human slot to
  include the required request. No cap or allowance is silently raised.
- Count all actual supplied instructions, structured untrusted history and schema using
  each eligible funded selected model's Task 3 input estimator. The entire estimated input
  (including Google's engineering margin) must fit contextTokenLimit, and input + total
  generation ceiling must fit the catalog's existing conservative context check. Unknown
  models/incompatible settings are rejected. Failed/unavailable provider preflights update
  health and may leave another eligible model; safety/unknown rejection is terminal.
- Drop oldest optional history first, keeping newer content, then binary fit the required
  message's counted fitting Unicode-code-point suffix. Never duplicate the required ID;
  if even one code point plus framing cannot fit, reject without generation. The tokenizer
  is not assumed universally monotone; every returned candidate itself passed its count.
- At most 24 sizing rounds and one 20-second context deadline, including uncooperative
  injected dependencies. Over-budget bytes are trimmed before provider counting; adapters'
  existing 1 MB context/8,000 instruction/120 message guards remain. Ask/message text is
  limited to 6,000 characters. A late timed-out counter cannot start another count.

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
to one process, so a restart clears this five-second gate. Task 5's singleton/queue guard
is still required before runtime activation. There is no automatic retry or delivery here.
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
