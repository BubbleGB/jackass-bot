# Task 3: provider usage safeguards

Scope: provider contracts, request routing and PostgreSQL accounting only. Application
startup still validates config and exits. All verification uses mocked HTTP responses
and isolated Cloud PostgreSQL. No live provider inference, production keys, VPS access,
deployment, context fetching, cooldowns or Discord delivery is implemented in this task.

## APIs and catalog

The verified two-model catalog and source links are in [compatibility.md](compatibility.md).
SettingsService now defaults to that catalog while retaining injection for tests. The
OpenAI adapter uses Responses and its documented request input counter. A shared body
builder and parity regression verify that the counter receives model, complete trusted
instructions, serialized context/history, reasoning effort, tools, truncation setting and
JSON output format/schema from the actual generation request. Only non-input controls
`store`, `stream` and `max_output_tokens` are added at generation. OpenAI describes this
preflight input count as exact, including formatting and schemas; this is a documented
input-count contract, not an independently measured guarantee about final billing.

Google keeps stateless Interactions. Before generation, its documented model `countTokens`
facility counts a projection of the actual request: identical system instructions and
serialized context (all supplied human/own-bot history, IDs and timestamps), plus serialized
`response_format` including the complete schema as a count-only text part. That proxy
ensures schema content is tokenized even though native Interactions framing and compiled
schema representation may differ. It is not sent as extra conversation text at generation.
The shared generation-body builder prevents projection drift. No remote conversation,
cache reference or tools add unseen history.

Google reserves `countTokens.totalTokens + max(32, ceil(count * 0.10)) + maxGenerationTokens`.
The extra 32-token/10% margin is an **engineering estimate**, not a provider guarantee or
proven input upper bound. The projection itself may overcount or undercount native schema
handling. The generation cap is the documented hard combined visible/thinking cutoff.
A fixture count of 120 with a 2,048 generation cap reserves **2,200**, not 1,050,624.
Malformed/failed counts stop generation rather than substitute a character estimate.
Existing model/context checks and byte/message/instruction limits remain; the configured
history token ceiling is implemented by Task 4, not by this change.

Both providers reconcile reported actual usage in full. Daily allowances are **practical
usage safeguards**, not guaranteed billing caps. Estimation errors and already in-flight
requests can overshoot them; unknown timeout usage may exceed its retained estimate.
Neither estimation nor settlement changes the configured allowance.

No SDK automatic retries, tools, searches, media, streaming, remote conversation state,
previous-response IDs or reasoning summaries are requested. Both stateful APIs explicitly
set `store:false`. Context is cloned in memory and sent as untrusted user JSON; trusted
personality/model/effort/output limits come from the current saved guild configuration.
Explicit structured `kind:silence` is distinct from an empty/malformed/partial response.
Safety refusals, including OpenAI `incomplete_details.reason=content_filter`, are terminal.
Unknown rejections also stop fallback rather than risk bypassing a policy decision.

`HttpTransport` is injectable; the default transport uses fixed provider URLs, header
credentials, abort signals, disabled redirects and a 2 MiB response-body limit. It never
logs request headers/bodies or raw provider errors. Errors expose only whitelisted codes,
categories, numeric usage and parsed retry delays. Future transport configuration must
preserve these guarantees and configured proxy/CA requirements. `CredentialCipher.open`
is used internally and never exposed through dashboard methods.

## Atomic ledger

`UsageService.reserveUsage(guildId,provider,attemptId,estimate,now)` returns a Reservation
or null. Positive safe-integer estimates and UUID attempt IDs are validated. Under the
same PostgreSQL guild advisory lock used by settings/approval, it checks approval,
enablement, funding and provider health, creates/locks the provider UTC-day bucket and
admits only if:

`known total + uncertain + reserved + estimate <= current daily allowance`.

A unique attempt insertion and bucket update commit together. Duplicate attempt IDs do
not allocate or increment requests twice, including concurrent cross-guild reuse. Local
budget exhaustion and health backoff never generate a provider response. Cheap headroom
checks also skip known insufficient configurations before input counting; the atomic
reservation remains authoritative after races or midnight changes.

Each reservation stores its original UTC date and responsible configuration fingerprint.
Settlement always uses that date, even after 00:00 UTC; new-day requests use a fresh
bucket. This implements a UTC allowance reset, not a provider-billing reset promise.

- `known`: validate reported nonnegative input/output/reasoning/total, release the held
  amount, and add normalized known counters once. Reasoning is a breakdown of normalized
  output. Keep per-attempt known counts as well as daily aggregates.
- `uncertain`: move the full reserved amount into uncertain tokens. Repeated uncertainty
  is a no-op. A later verified known report reconciles it exactly once.
- `not_sent`: release only a reserved attempt proven not executed (for example cancellation
  before sending or a definitive rejection without usage). An already uncertain attempt
  cannot be made free merely by settling it as not_sent.

HTTP errors with valid usage preserve that usage; malformed or partial usage remains
conservative. A crash leaves its reservation charged. There is no automatic release or
replay on startup. If reported usage exceeds its reservation, record the entire amount
and a safe `usage_estimate_exceeded` diagnostic. Do not permanently mark healthy provider
configuration as faulty for underestimation. Atomic admission includes settled actual
usage and remaining live/uncertain charges; it stops further calls when funding is exhausted.
Already admitted requests may still settle and increase the overshoot. Even a later known
report replacing an uncertain charge can exceed the allowance. Only new UTC-day funding
or an explicit authorized allowance edit restores exhausted funding; no automatic increase
occurs. An underestimate below the allowance permits subsequent affordable requests.

`requests` counts admitted generation attempts, including definitive rejected/cancelled
ones, not token-count HTTP calls or unaffordable preflight attempts. Failed primary and
successful fallback are distinct reservations/providers with distinct outcomes. Schema
constraints preserve nonnegative counters and coherent known totals. The additive Task 3
migration leaves committed Task 1/2 migrations unchanged.

## Routing, backoff and replay

`ProviderRouter.generateWithFallback(request,input)` is an internal backend API for an
already eligible BotRequest. Tasks 4–6 must still check channel/membership/direct switches,
select bounded context, queue fairly, enforce global concurrency and guard delivery.
No public HTTP route calls the router yet.

Before provider work, claim a `generation:<request.id>` receipt. That namespace is distinct
from future gateway/automatic-event deduplication. The receipt stores only identifiers,
state and timestamps, never input/output text. Concurrent duplicates and restarts cannot
blindly replay the same generation. A failed/uncertain old event needs a new eligible
request ID; there is no persisted answer cache. This favors conservative recovery over
promising exactly-once external API execution.

Load approved/enabled configuration and priority order. Each provider is tried at most
once. Check current configuration before counting and again after reservation, immediately
before generation. A changed/revoked configuration stops stale work. An HTTP request
already sent cannot be made atomic with a later revocation; later lifecycle/delivery code
must also recheck current approval before delivery and cancel known stale work.

Count plus generation share a 60-second attempt deadline, including a race against
transports that ignore abort. No inline provider retry occurs. A slow/failed primary can
fall back to the other eligible provider once while retaining its own charge. A bookkeeping
failure after an answer was received stops the operation; it never regenerates through
fallback. The existing reservation remains conservative if persistence is uncertain.

Backoff is persisted per guild/provider. Transient failures start at 30 seconds, double
up to 15 minutes, and respect longer numeric/date Retry-After or Google RetryInfo delays.
Recovery is a probe by a future eligible request after the timestamp, not an autonomous
paid timer. Auth/provider-config faults remain blocked until credentials/model/effort change.
Request-local `invalid_input` and `input_too_large` errors are recorded safely but do not
change provider health; an oversized request must not disable subsequent short requests.
The fingerprint covers encrypted envelope, key version, model and effort: allowance/order
edits and no-op revision increments cannot reset a fault. A replacement configuration's
first temporary failure does not inherit an old permanent block.

Structured silence and refusal still count as usage. A refusal never invokes fallback.
If refusal usage is absent, return a safe refusal while keeping the full charge uncertain.
If every provider is skipped/exhausted/unavailable, return a fixed providers_unavailable
error; Task 6 will implement the rate-limited non-AI user notice and slash acknowledgement.
No code here sends Discord messages, retries delivery or selects channel history.

## Verification and remaining boundaries

The unit fixtures exercise native request/response fields, cached/reasoning accounting,
explicit silence, incomplete filtering, refusal with/without usage, error redaction,
RetryInfo, deadlines, bounded fallback and no regeneration after accounting failure.
Real PostgreSQL tests exercise concurrent admission and actual-usage overshoot, small allowances, underestimated input,
post-settlement exhaustion, duplicate settlement, midnight,
uncertainty, configuration replacement, persisted backoff, both fallback attempts and
replay suppression. A fresh review found a content-filter fallback gap and an old-result
configuration-blocking race; both received failing regressions before fixes. The PR records
final local/native AMD64/ARM64 results.

Task 8 must retain unresolved reservations/uncertain charges conservatively, aggregate
completed records before its seven-day cleanup, and avoid blindly replaying processing
receipts. Health rows cascade with guild deletion. No cleanup, production migration,
backup/restore or startup/recovery scheduler is claimed implemented by Task 3.

Limits: Google count projection and margin are estimates, not guaranteed billing bounds.
OpenAI's documented counter is audited for request parity but no live counter/model or
billing was probed. Both providers retain conservative estimated timeout charges without
claiming these cover all possible billed usage. Google uses a stable alias that may change.
Native CI proves fixtures and database contracts, not production API acceptance or pricing.
Queues, the global worker limit and singleton enforcement still belong to Task 5; Task 3
retains atomic cross-request ledger admission and bounded attempts/fallback. No Task 4 work
has begun. [Reservation design/evidence](google-reservation-investigation.md) records the
superseded full-window behavior and revised short-request examples.
