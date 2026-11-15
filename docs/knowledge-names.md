# Server knowledge and participant names

Authorised by the owner, 15 November 2026. This is the design/specification for the
additions in the current request, extending the handoff rather than replacing existing
access, required-input, accounting, queue, delivery or notification rules.

## Data and access

Central `src/knowledge/limits.ts` defines title 120, body 100,000 Unicode code points,
50 entries and 1,000,000 total body code points/guild; default knowledge tokens 2,000,
range 0–8,000; 2 MiB knowledge-write HTTP limit; chunk target 1,000 code points, at
most eight retrieved passages and bounded query/retrieval work. Reject NUL/unpaired
surrogates, blank titles/bodies and invalid types without truncating editor drafts.
These are owner limits except chunk/query/name engineering bounds documented below.

Add `knowledge_entries` keyed by guild/UUID with title/body/enabled/revision/timestamps,
and `knowledge_chunks` with composite guild/entry foreign key, chunk ordinal, text,
title and generated weighted `simple` tsvector. Add GIN search and guild lookup indexes.
Entries/chunks cascade on confirmed guild removal; separate approval remains. Add
nullable knowledge target UUID to audit events; mutations record actor, guild, entry
ID, action and changed field names, without content. Audit retention stays 90 days.

`KnowledgeService(database,access)` authorises every CRUD/list/read through the existing
AccessPolicy (`read` or `settings`, which delegates may use). Mutations hold the same
exclusive guild advisory lock as settings/approval; reads use its shared form. Validate
count/aggregate quotas under that lock, entry revisions on edit/delete, and 404 missing
IDs only after guild authorisation. Entry edits have independent revisions and do not
overwrite or silently rebase the ordinary settings draft. No new access grants or keys.

List returns bounded metadata/counts, not all bodies; fetch one body for editing.
POST creates; PATCH uses expected entry revision and validated fields; DELETE requires
revision. New protected routes are `/api/guilds/:guildId/knowledge` and `/:entryId`.
Route-specific 2 MiB limits allow worst-case valid Unicode/escaped JSON (100,000 astral
characters can require 1.2 MB when encoded as escaped surrogate pairs); normal backend
limits, CSRF, sessions, origin checks and sanitised diagnostics stay in place.

## Retrieval and provider boundary

`KnowledgeRepository.retrieve(guildId,query,signal)` uses parameterised PostgreSQL FTS,
joins enabled entries, ranks matching chunks and uses stable entry/ordinal tie breaks.
`current(guildId,passages,signal)` verifies that referenced entry/chunk identities and
versions still exist, are enabled and belong to this guild. No result cache. No match
means an empty list. Whitespace-only search chunks are omitted; the saved source body
is preserved exactly. Direct query takes current text first plus bounded recent humans;
automatic query uses bounded recent humans only. Query text/terms/rows are capped;
Unicode words and punctuation are normalised safely, never executed as SQL/query syntax.

`KnowledgePassage { entryId,revision,chunkIndex,title,text }` is optional on
GenerationInput, separate from conversation messages/notification participants.
ContextBuilder adds a bundle method while retaining its existing message-array wrapper;
direct and automatic orchestration pass the same fitted bundle to ProviderRouter.
Static application instructions label staff references/names as untrusted data.
References are JSON-encoded user content under a distinct staff-reference envelope,
with no system role, tool, permission or hidden conversation state.

Use each eligible provider's existing complete-input counter on the same full bundle
and on its knowledge-free baseline. Incremental input (including reference framing)
must fit the knowledge cap; all input plus generation must also fit existing configured
and model ceilings. Google retains its documented engineering-estimate policy. Reduce
lowest-ranked knowledge deterministically to meet its cap; for overall fitting remove
oldest optional history first, then knowledge. Required instructions/current direct
text are never cut; automatic mode retains a usable human anchor. Reduce strings only
at grapheme boundaries without splitting Unicode characters. Counts/rounds remain bounded; no approximate character-to-token
claim substitutes for provider counting. A zero budget skips retrieval.
The last bounded fitting round tests the required input alone (or the usable human
anchor for automatic mode), omitting optional material if incremental trimming consumed
the earlier rounds. This prevents optional references from falsely rejecting a small
request and does not increase provider-count work or truncate required text.

ProviderInputCounter and ProviderRouter check current references before counting/use,
after estimation and immediately before generation (including fallback candidates).
Router independently enforces both knowledge and overall ceilings, reserves the full
input estimate plus output cap, and preserves full/idempotent/uncertain settlement.
Changed/disabled/deleted passages abort preparation as request-local
`configuration_changed`, never as a provider-health failure, rather than send stale text;
new requests retrieve current versions. Text already sent to an in-flight provider
cannot be recalled; the check is a pre-send boundary, not retroactive deletion.

## Names and dashboard

Owner amendment, 15 November 2026: names use Discord global display name (`globalName`
in the SDK / `global_name` in REST), falling back to username when blank or missing.
Guild nicknames are never selected. This supersedes the original nickname-first policy
for current/history messages, /ask and bounded member-ID lookup fallback. Available
author metadata is sufficient; no nickname-dependent lookup is needed.
Bound names to 80 code points, remove control/bidi formatting characters,
JSON-encode as message data, retain the actual author ID, and never derive permissions
or notification recipients from a name. Use message metadata where present; otherwise
resolve at most 16 selected participant IDs with bounded concurrency/deadline and
username fallback on failure. No bulk membership endpoint or new intent. /ask gets
the same resolution. Model guidance permits natural names only when useful. Delivery's
three-participant cap and allowed-mentions enforcement remain unchanged on every chunk.
The 16-ID bound is logical lookups, not wire attempts: the existing transport permits
at most three attempts per GET (thus at most 48 name HTTP attempts), normally curtailed
by the shared two-second name-resolution deadline.

Dashboard Settings adds a Knowledge section/link and token-budget control. A dedicated
`/servers/:guildId/knowledge` editor avoids competing Save bars and supports large pasted
Android text with counts, validation, explicit save/delete messages and safe plain-text
rendering. Preserve the active draft in this tab under a user/guild-scoped key cleared
on logout. Switching/discarding a dirty draft requires explicit action. Conflicts fetch
latest, then offer explicit load-latest or keep-draft-on-latest; deletion offers an
explicit save-as-new path. Retry reads without replacing drafts. Disclose provider
transmission of selected passages and absence of secrets guidance.

## Alternatives, costs and limits

Local PostgreSQL FTS is chosen over embeddings/external retrieval, as authorised. A
dedicated editor page is chosen over a large form nested in ordinary Settings. Pending
queries/read snapshots are used instead of stale permission/knowledge caches. Separate
entry revisions avoid unrelated settings edits being lost after knowledge changes.

Chunk bodies duplicate bounded source text and add a GIN index; measure rows/index size
on synthetic limits. New tables start empty; constant-default settings column and nullable
audit target are additive. Migrations remain an explicit deployment step. Review rollback
compatibility and full existing-data migration before rollout; no VPS migration here.
The runtime requires an exact latest migration hash matching its bundled migrations.
After applying this migration an older image will refuse startup even though the SQL
change is additive. Recovery requires a matching-schema image or explicit restoration
of the pre-migration backup; do not promise an ordinary previous-image rollback.

An isolated PostgreSQL 18.7 test with 1,000,000 ASCII body characters across ten entries
produced 1,010 chunks: entries occupied 638,976 bytes and chunks including indexes
8,306,688 bytes, of which the GIN index was 4,153,344 bytes. A selective query planned
in 0.163 ms and ran in 4.395 ms on the Cloud AMD64 host. The planner chose a sequential
scan for this small single-guild dataset; this is not evidence of GIN use or a VPS
latency/storage guarantee. Production language, compressibility, vocabulary and guild
counts change these costs. Migration tests also verify populated prior settings,
credentials and usage survive the upgrade; knowledge tables initially contain no rows.

Retrieval is lexical, not semantic: no embeddings, guaranteed factuality, perfect typo
matching or language-aware segmentation. Ranking/common terms and chunk boundaries may
miss relevant material or choose imperfect passages. No-match omission and per-request
budgets are guaranteed application behaviour. Names can be stale/missing in Discord
metadata and fall back to bounded usernames/IDs. Provider-count estimates retain the
existing allowance overshoot limits; none of this creates a hard monetary billing cap.
The `simple` configuration does not provide stemming or reliable segmentation of
unspaced languages. Query terms use bounded OR matching, so a common term can produce
weak matches. Token-count endpoints can receive candidate passages during fitting,
including passages later omitted from generation; they have the same provider privacy
boundary as generation. No knowledge text is written to application diagnostics.
