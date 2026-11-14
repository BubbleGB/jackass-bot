# Task 1 compatibility evidence

Checked 13 November 2026 in Codex Cloud. Exact direct dependency versions were recovered
from the phone and retained after querying the official npm registry version endpoints.
`npm ci --ignore-scripts`, `npm ls --depth=0` and the checks in
[task-1-verification.md](task-1-verification.md) verify the installed combination.
No provider SDK or model selection is made in Task 1.

## Runtime and database

- Node **26.13.1**, Lithium LTS; npm **11.20.0** bundled with that release.
  [Official release index](https://nodejs.org/dist/index.json) lists the release dated
  10 November 2026, `lts: Lithium`, and Linux x64/ARM64 binaries.
  [Official release schedule](https://github.com/nodejs/Release/blob/main/schedule.json)
  lists Node 26 LTS starting 28 October 2026 and end of support 30 April 2029.
  The Cloud x64 archive was checked against the release's
  [SHA256 list](https://nodejs.org/dist/v26.13.1/SHASUMS256.txt):
  `5c063e46bab0fbc1c17cc445d7ff129cbdcd0471be6ed83b6ab864f8143bc864`.
- PostgreSQL **18.7**, Debian bookworm, multiarch image index
  `postgres:18.7-bookworm@sha256:ece55f7868da684e400f82f1030a050718adbdd65c23aa500c486f6e2950dc0f`.
  [Official image manifest source](https://github.com/docker-library/official-images/blob/master/library/postgres)
  lists amd64 and arm64v8. Docker's registry manifest confirms both platforms in this
  immutable digest. The running Cloud instance reports PostgreSQL 18.7 on x86_64.
  [PostgreSQL source version](https://github.com/postgres/postgres/blob/REL_18_STABLE/configure.ac)
  also reports 18.7. The PostgreSQL versioning website returned HTTP 503 during this check;
  no claim relies on that failed request.
- [Drizzle PostgreSQL setup documentation source](https://github.com/drizzle-team/drizzle-orm-docs/blob/main/src/content/docs/pg/get-started-postgresql.mdx)
  describes the node-postgres driver and migration workflow. The public documentation
  site returned HTTP 403; the official source was read instead. The pinned ORM accepts
  `pg >=8`; our SQL migrations and driver have run against the pinned PostgreSQL image.

## Exact npm versions

Each version link is the registry metadata endpoint checked in this session.

| Package | Pin | Compatibility evidence |
| --- | --- | --- |
| [drizzle-orm](https://registry.npmjs.org/drizzle-orm/0.45.4) | 0.45.4 | node-postgres peer `pg >=8` |
| [pg](https://registry.npmjs.org/pg/8.23.1) | 8.23.1 | Node >=16 |
| [drizzle-kit](https://registry.npmjs.org/drizzle-kit/0.31.11) | 0.31.11 | Offline generation ran; no schema drift |
| [TypeScript](https://registry.npmjs.org/typescript/6.0.3) | 6.0.3 | Node >=14.17; NodeNext build/typecheck ran |
| [ESLint](https://registry.npmjs.org/eslint/10.14.0) | 10.14.0 | Node ^20.19 / ^22.13 / >=24 |
| [@eslint/js](https://registry.npmjs.org/@eslint/js/10.0.1) | 10.0.1 | ESLint ^10 |
| [typescript-eslint](https://registry.npmjs.org/typescript-eslint/8.72.2) | 8.72.2 | ESLint ^8.57 / ^9 / ^10; TS >=4.8.4 <6.1 |
| [Vitest](https://registry.npmjs.org/vitest/5.1.0) | 5.1.0 | Node ^22.12 / ^24 / >=26; real tests ran |
| [Playwright](https://registry.npmjs.org/@playwright/test/1.65.0) | 1.65.0 | Node >=20; browser scenarios deferred to Task 7 |
| [@types/node](https://registry.npmjs.org/@types/node/26.6.6) | 26.6.6 | Node 26 types; compiler checks ran |
| [@types/pg](https://registry.npmjs.org/@types/pg/8.23.1) | 8.23.1 | Compiler checks ran with pg 8.23.1 |

All transitive resolutions and integrity hashes remain in the recovered lockfile.
The recovered overrides pin minimatch 11.0.1 and the legacy esbuild-kit subtree's esbuild
0.25.12. They were retained after a clean install, lint, migration generation and audit.
Drizzle Kit still brings deprecated `@esbuild-kit/esm-loader` and `core-utils`; npm
warns about these, but the checked registry audit reports zero vulnerabilities.
Do not use `npm audit fix --force` to change this tested dependency graph blindly.

## CI and architecture limits

The workflow pins `actions/checkout` v6 to
`d23441a48e516b6c34aea4fa41551a30e30af803` and `actions/setup-node` v6 to
`249970729cb0ef3589644e2896645e5dc5ba9c38`, resolved from their official GitHub tag refs.
It selects the exact Node version from `.node-version` and checks bundled npm explicitly.
The PostgreSQL service uses the same multiarch digest as Cloud Compose.

Cloud verification here is **Linux AMD64**. Native ARM64 CI is configured on
`ubuntu-24.04-arm`, but has not run because no push was authorised. Metadata confirms
ARM64 availability; it does not establish a successful ARM64 build. Task 8 still owns
building/testing the application ARM64 image and operational packaging.

## Official API documentation checked; implementation deferred

No Discord or provider endpoints were called and no production credentials were used.
These official documentation sources were read for the future integration boundaries:

- Discord [gateway](https://github.com/discord/discord-api-docs/blob/main/developers/events/gateway.mdx),
  [OAuth2](https://github.com/discord/discord-api-docs/blob/main/developers/topics/oauth2.mdx),
  [channel types](https://github.com/discord/discord-api-docs/blob/main/developers/resources/channel.mdx),
  and [guild/member REST](https://github.com/discord/discord-api-docs/blob/main/developers/resources/guild.mdx).
  Official hosted docs returned HTTP 403; their maintained source was read instead.
  Gateway and OAuth/member authorisation still require task-specific verification in
  Tasks 2, 6 and 7; no privileged member/presence intent is enabled by this foundation.
- OpenAI [Node SDK API surface](https://github.com/openai/openai-node/blob/master/api.md)
  confirms the Responses API exists. The hosted API reference returned HTTP 403.
- Google [Gemini API documentation](https://ai.google.dev/gemini-api/docs) was accessible.

Exact Discord/Fastify/React/Vite/OpenAI/Google SDK pins, supported model IDs, effort values,
reasoning/cached-token accounting and model ceilings must be verified when those packages
are introduced. No claim is made that a concrete model or billing boundary has been
validated in Task 1. Recheck current official sources during those tasks.


## Task 2 compatibility notes

Task 2 adds no npm dependencies; the Node 26.13.1/npm 11.20.0 lockfile remains unchanged.
Node's built-in `node:crypto` provides AES-256-GCM, random nonces and authentication tags.
The [official Node crypto API](https://nodejs.org/docs/latest-v26.x/api/crypto.html)
documents `setAAD`, `getAuthTag`, `setAuthTag` and authenticated finalisation; the
implementation uses explicit associated data and the default 16-byte GCM tag.

The official Discord source sections for **Get Guild Member**, **Get Guild Roles**, **Get
Guild**, and **Get Channel** support the injected REST paths in Task 2. The distinct
**List Guild Members** endpoint requires a privileged intent; Task 2 never lists members
or enables a member/presence intent. OAuth's `guilds.members.read` scope is an alternative
for the current user's member endpoint, but this implementation uses individual
bot-authenticated member lookups and never treats OAuth guild lists as current proof.
Fresh transport responses are required on protected operations. No live Discord lookup
was performed. See [settings/access contracts](settings-access.md) for wiring requirements.


## Task 3 official provider contracts — checked 13 November 2026

No SDK dependency was added. Explicit HTTP uses pinned Node 26.13.1 native fetch and
AbortSignal; preflight counting and generation are separate single requests, without SDK automatic retry/replay. All
inference/token-count tests use injected HTTP fixtures, never live credentials or paid
API calls. Documentation and the public Google REST discovery schema were read only.

The small catalog is in `src/providers/catalog.ts`:

| Provider / API | Selected model | Allowed effort | Documented limits |
| --- | --- | --- | --- |
| OpenAI Responses | `gpt-5.4-mini-2026-03-17` | none, low, medium, high, xhigh | 400,000 context, 128,000 output |
| Google Gemini Interactions v1beta | `gemini-3.5-flash-lite` | minimal, low, medium, high | 1,048,576 input/context, 65,536 output |

OpenAI is pinned to the published snapshot. Google publishes this stable model code;
we did not invent a dated snapshot. Its alias may change upstream and must be rechecked
on future catalog updates. GPT-5 mini's older dated snapshot is marked deprecated;
Google 2.5 docs restrict new-project access. Neither was selected for this new project.
No moving `latest` alias, external tool, search, attachment or media capability is enabled.

Official sources read:

- [OpenAI model card](https://developers.openai.com/api/docs/models/gpt-5.4-mini): exact
  snapshot, supported reasoning efforts, structured-output capability and context/output limits.
- [Reasoning guide](https://developers.openai.com/api/docs/guides/reasoning):
  `max_output_tokens` includes reasoning, visible output and non-visible formatting;
  output reasoning is a breakdown of `output_tokens`, not an additional charge.
- [Token-count guide](https://developers.openai.com/api/docs/guides/token-counting):
  exact input count for the model, including instructions/tools/schemas. The
  [official generated request types](https://github.com/openai/openai-node/blob/master/src/resources/responses/input-tokens.ts)
  confirm POST `/v1/responses/input_tokens` accepts `model`, `instructions`, `input`,
  `reasoning`, `text.format`, `tools` and disabled truncation. Counting and generation
  share the same deterministic input/schema payload. A parity regression compares every
  field, allowing only store/stream/max_output_tokens on generation. This audits the
  documented exact input-count claim, not final billing or a universal hard daily cap.
- [Gemini model card](https://ai.google.dev/gemini-api/docs/models/gemini-3.5-flash-lite)
  and [model changes](https://ai.google.dev/gemini-api/docs/whats-new-gemini-3.6):
  selected stable code, limits, structured output and absence of sampling overrides.
- [Gemini thinking](https://ai.google.dev/gemini-api/docs/thinking): model-specific
  levels and the Interactions `max_output_tokens` hard combined thought/output cutoff.
- [Interactions guide](https://ai.google.dev/gemini-api/docs/interactions) and
  [API reference](https://ai.google.dev/api/interactions-api): stateless `store:false`,
  `generation_config`, usage fields and current API representation.
- [Structured outputs](https://ai.google.dev/gemini-api/docs/structured-output):
  `response_format:{type:'text',mime_type:'application/json',schema:...}`.
- [Token guide](https://ai.google.dev/gemini-api/docs/tokens) and
  [countTokens reference](https://ai.google.dev/api/tokens): the documented model counter accepts a generateContentRequest projection. We count
  actual system instructions and serialized history, plus serialized output format/schema
  as a count-only text part. This is a native tokenizer estimate for Interactions, not
  an exact native framing/schema count. See also the
  [Interactions token guide](https://ai.google.dev/gemini-api/docs/interactions/tokens).
- [Legacy usage definitions](https://ai.google.dev/api/generate-content):
  `promptTokenCount` includes cache and total includes prompt/candidates/thoughts. The
  chosen Interactions adapter uses the current `usage.total_*` fields instead; fixtures
  follow those definitions. Legacy and current payload shapes are not interchanged.

For OpenAI, cached input is already included in `input_tokens`; reasoning is already in
`output_tokens`. For Google Interactions, `total_output_tokens` is visible output and
`total_thought_tokens` is separate. Normalized output is their sum. In both adapters,
reported total must equal input + normalized output; cached tokens are not added again.
Unknown/missing/inconsistent usage is retained as uncertain, not interpreted as free.

**Revised reservation policy:** the user explicitly superseded the prior requirement to
reject models without guaranteed accounting bounds. Keep both models. Google now reserves
its actual-request projection count plus `max(32, ceil(count * 0.10))` input margin plus
the configured total generation cap. The margin is an engineering estimate, not a guaranteed
upper bound. With mocked count 120 and generation cap 2,048 the reservation is 2,200.
OpenAI reserves its documented full-request count plus the same enforced generation cap;
no extra engineering margin is currently applied to OpenAI.

All reported actual usage is recorded, even above the reservation. Atomic reservations
prevent admitting estimates beyond remaining funding, but estimation and already in-flight
requests can overshoot the daily allowance. Further calls stop when known, uncertain and
reserved usage exhaust funding. Uncertain timeouts retain the estimated charge, which is
not a guarantee of the billed maximum. No configured allowance is automatically increased.
These are local usage safeguards, not hard billing caps or monetary estimates.

No live model availability, credential validity, billing, safety response distribution or
retention was tested. Provider policy may retain data even when API state storage is off.
See [reservation evidence and short-request examples](google-reservation-investigation.md).

## Task 4 Discord REST contracts — checked 14 November 2026

No SDK/dependency was introduced; native bot-authenticated GET is still injected.
Official Discord documentation source was read:

- [Messages](https://github.com/discord/discord-api-docs/blob/main/developers/resources/message.mdx):
  channel history GET limit 1–100 and before cursor, channel-scoped single message,
  author.bot, webhook_id, mentions and same-channel message_reference/referenced_message.
  Embedded reply references can be absent/null; unresolved author identity fails closed.
- [Channels](https://github.com/discord/discord-api-docs/blob/main/developers/resources/channel.mdx):
  only type 0 GUILD_TEXT qualifies; DM, announcement, forum and thread types are excluded.
- [Permissions](https://github.com/discord/discord-api-docs/blob/main/developers/topics/permissions.mdx):
  owner/Administrator bypass, everyone → aggregate role → member overwrite order,
  View Channel (1<<10), Send Messages (1<<11), Read Message History (1<<16), timeout rules.

Fixtures exercise these fields/overwrites and lost permissions without a Discord network
client or token. Context uses Task 3's complete request counters and accounting policy;
no new “exact” billing claim, model alias or runtime package change is introduced.
See [context/direct contracts](context-direct.md) for wiring, operational limits and tests.
