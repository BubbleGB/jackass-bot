# Discord handlers and delivery — Task 6

Task 6 connects gateway events and commands to the existing services. All Discord and
provider calls in its tests are mocked; PostgreSQL is disposable Cloud test data.
Neither registration command nor a live gateway login has been executed.

## Composition and ownership

`createDiscordApplication` constructs the existing access, settings, context, direct,
automatic, queue, usage and provider services with an injected Discord transport. Their
eligibility, approval, permission, context fitting, cooldown, counting, reservation and
fallback decisions remain in those services. Delivery outcomes run inside the channel
queue job so a following request cannot overtake an answer's chunks.

`createDiscordClient` normalizes authenticated SDK identities into the handlers. It uses
Guilds, GuildMessages and MessageContent intents, no member/presence intents, no message
cache, and no SDK send/reply helpers. Message bodies are fetched through the existing
channel-scoped context source. Bots, webhooks, DMs and nonordinary text channels are
excluded. Message edits are not new events. Mentions/replies pass through the automatic
observer once: direct/automatic collision and duplicate counting remain Task 5 decisions.

The factories are lazy. A later runtime lifecycle must supply a verified bot user ID
(distinct from application ID), construct `DiscordRest`, start the singleton worker,
and then explicitly start the gateway; on shutdown stop ingress, drain the worker and
close its resources. `npm start` still validates foundation configuration and exits;
integrated startup/shutdown and operational packaging belong to Task 8. No production
credentials are needed to build or test this phase.

## Commands, acknowledgements and typing

All command handlers attempt the initial defer before access, queue or provider work,
with a 2.5-second local deadline against Discord's documented three-second deadline.
An unconfirmed acknowledgement prevents generation; it is never blindly repeated.

- `/ask` defers publicly and edits that response with its public answer. Cooldown, busy,
  deliberate silence and suppressed public-unavailability notices use a private follow-up.
  Deferred visibility cannot change: first complete the original with neutral public
  text, then remove it, then send the private notice. This also avoids Discord's legacy
  first-follow-up behaviour that can ignore the ephemeral flag after a defer. If removing
  the neutral acknowledgement fails, it may remain visible. If completing it cannot be
  confirmed, do not risk a private notice becoming public.
- `/settings` and `/status` defer privately before checking current access. Settings
  supplies the future dashboard link; status uses the settings service's authenticated
  guild-scoped read of model/availability and current UTC usage. Neither exposes keys or
  raw errors. Revoked or unverifiable membership fails closed. Direct disablement does
  not disable authorized staff commands.
- `/help` is private, explains use, and discloses that recent channel context/instructions
  go to the configured OpenAI or Google provider, whose retention policies still apply.
- Unsupported channel commands receive a private rejection, without generation.

Ordinary direct requests refresh typing every eight seconds while their queue job is
active, including context preparation, generation and delivery. All outcomes clear the
interval, with an additional 180-second hard expiry. Discord has no stop-typing endpoint;
the last indicator expires server-side after refresh stops. `/ask` uses the deferred
response indicator. No timer starts an automatic assessment.

## Safe output and bounded delivery

Every answer/refusal/notice uses `allowed_mentions`: empty automatic parse and roles,
explicit supplied human-participant IDs only (at most three), and `replied_user: false`.
Mass mentions, role mentions and fabricated user mentions are neutralized in text as
well. Each chunk repeats these restrictions; reply references do not ping their author.
Participant identities come from the context service, never the model. Staff/help/error
responses permit no mentions.

Answers are rendered as escaped plain text before splitting into at most 32 chunks of
2,000 UTF-16 units, preserving Unicode scalar, mention and escape boundaries. Markdown
formatting is intentionally displayed as text, avoiding broken fences/emphasis across
chunks. A response exceeding this delivery bound fails without regenerating it.

Before each chunk and each retry, delivery rechecks approval/enabled state, channel
selection or direct switch, singleton ownership and current channel permissions. A
failed or unverifiable check stops further sends; previously delivered chunks remain.
Worker ownership is checked again after the permission reads, and its cancellation signal
also reaches in-flight delivery. A send already accepted when revocation occurs remains
an uncertain external outcome; cancellation does not retract a Discord message.

There are at most three attempts per chunk and a 20-second total delivery deadline.
Only an explicitly known retryable non-send or HTTP 429 can retry, with Retry-After at
most two seconds; longer backoff stops this delivery rather than retrying too early.
Forbidden/rejected sends stop. Network timeouts, 408, 5xx, missing message IDs and lost
acknowledgements mean **uncertain acceptance**, not definite failure, and are not retried.
This transport does not turn raw connection errors into known non-sends. Retries reuse
the exact in-memory answer and never call the AI provider, count API or ledger again.

A delivery report records known message IDs and the next chunk index. Later-chunk
failure preserves earlier chunks. For slash responses, a private partial-delivery notice
does not edit/delete the original answer. If the first slash answer's acceptance is
uncertain, no further edit/follow-up is attempted: Discord might already display it.
Reports contain metadata only, never answer text or interaction tokens. They are not yet
persisted or exposed in a dashboard; Task 8 owns sanitized operational diagnostics.

There is no exactly-once delivery promise. If Discord accepted a send but its reply was
lost, an answer/chunk may exist despite an uncertain report. The user should inspect
the channel before manually requesting another answer. Crashes discard the in-memory
answer; recovery never regenerates or replays uncertain delivery automatically. Usage
remains charged by Task 3's reconciliation rules, even if Discord delivery fails.

## Explicit command registration

Registration is a separate bulk replacement operation; it is absent from startup,
ready and reconnect paths. Commands are server-only. Both commands below require a
built application, `DISCORD_CLIENT_ID` and `DISCORD_BOT_TOKEN` via local secret storage.
The test command also requires `DISCORD_TEST_GUILD_ID`:

```sh
npm run build
# Explicitly authorized test-guild registration only:
npm run discord:register:test
# Separate explicit production/global registration:
npm run discord:register:production
```

These are operator instructions for a later authorized live step, not actions performed
in Task 6. Each replaces all application commands in its scope with help/ask/settings/status.
Test-guild registrations do not disappear when global commands are installed; remove
obsolete test registrations explicitly when appropriate. The CLI prints only a static
result/error, never tokens or raw Discord responses.

## Verification and remaining live smoke tests

Mocked gateway, registration, handler and real-service/PostgreSQL tests cover collisions,
public/private visibility payloads, current/revoked staff access, cooldown, unavailable
providers, typing cleanup, permission loss, every-chunk notifications, bounded retries,
partial delivery, worker revocation during permission reads/in-flight sends, actionable
oversized-input rejection through the real queue, and uncertain sends with no repeated
provider generation. Existing
Task 3–5 suites continue to cover provider accounting, context and scheduling policies.

After separate authorization, a test-guild smoke test still needs to verify actual intent
and invite permissions, command propagation, public `/ask` defer/edit, neutral-placeholder
removal and private cooldown follow-ups, private staff commands, typing expiry, real
mention notification behaviour on every chunk, and gateway reconnect without registration.
No paid provider call is necessary for that smoke test if generation stays mocked. Live
rate-limit and lost-ack behaviour cannot be proven by mocks; the bounded conservative
policy above remains the operational limitation.
