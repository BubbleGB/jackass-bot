# Task 3: bounded providers and usage

Scope: provider contracts, request routing and PostgreSQL accounting only. Application
startup still validates config and exits. All verification uses mocked HTTP responses
and isolated Cloud PostgreSQL. No live provider inference, production keys, VPS access,
deployment, context fetching, cooldowns or Discord delivery is implemented in this task.

## APIs and catalog

The verified two-model catalog and source links are in [compatibility.md](compatibility.md).
SettingsService now defaults to that catalog while retaining injection for tests. The
OpenAI adapter uses Responses and exact input counting, including the JSON schema.
Google uses the current stateless Interactions API with the documented combined output
cap. It reserves the full documented input ceiling because an exact schema-aware
Interactions counter was not verified. This is deliberately expensive in temporary
headroom: Google needs **1,050,624 remaining tokens** at the default output ceiling.
Known settlement releases unused headroom; insufficient budgets skip the call entirely.

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
replay on startup. If actual reported usage exceeds its reservation, record the actual
value honestly, log a safe accounting-bound error, and block the responsible configuration.
A late old-key/model result cannot block its replacement. Upstream contract violations
can exceed an intended allowance; this is not an exact monetary or billing guarantee.

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
paid timer. Auth/config faults remain blocked until credentials/model/effort change.
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
Real PostgreSQL tests exercise concurrent admission, duplicate settlement, midnight,
uncertainty, configuration replacement, persisted backoff, both fallback attempts and
replay suppression. A fresh review found a content-filter fallback gap and an old-result
configuration-blocking race; both received failing regressions before fixes. The PR records
final local/native AMD64/ARM64 results.

Task 8 must retain unresolved reservations/uncertain charges conservatively, aggregate
completed records before its seven-day cleanup, and avoid blindly replaying processing
receipts. Health rows cascade with guild deletion. No cleanup, production migration,
backup/restore or startup/recovery scheduler is claimed implemented by Task 3.

Limits: Google uses a conservative full-window input reservation; real credentials/model
access and billing were not probed; Google uses a published stable alias rather than a
nonexistent dated snapshot. Native CI proves these fixtures and database contracts, not
provider production acceptance or pricing. No Task 4 implementation has begun.


Follow-up: [Google reservation investigation](google-reservation-investigation.md) traces
both full-window admission sites, separates documented limits from conservative choices,
examines countTokens guarantees/schema coverage, and records small-allowance regressions.
A smaller strict reservation was not established; model/API/allowances remain unchanged.
