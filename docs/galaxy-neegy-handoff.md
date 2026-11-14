# Galaxy Neegy — approved specification and Codex handoff

Date: 13 November 2026. Owner: BubbleGB. Repository: https://github.com/BubbleGB/jackass-bot

## User amendment — 13 November 2026 (supersedes earlier accounting requirement)

Daily token allowances are practical usage safeguards, not guaranteed hard billing caps.
This amendment explicitly supersedes the earlier A4 requirement to reject models whose
accounting cannot be reliably bounded. Keep both OpenAI and Google. Use documented
request token counting where supported, include countable instructions, history and
structured-output content, and reserve estimated input plus the enforced total generation
limit. Document any margin as an engineering estimate, never a guaranteed upper bound.
Verify OpenAI count payload coverage rather than assuming that “exact” covers the request.

Keep context/request limits, atomic reservations, concurrency safeguards and conservative
timeout charges. Reconcile all reported actual usage, including amounts above reservations;
block further calls once the allowance is exhausted. Estimation error and concurrent
in-flight requests can overshoot the allowance. Never silently raise configured allowances.
The current implementation and assumptions are in [providers-usage.md](providers-usage.md)
and [google-reservation-investigation.md](google-reservation-investigation.md).

Development/testing moved to Codex Cloud at `/workspace/jackass-bot`; Termux setup below
is historical. The Oracle VPS remains the eventual deployment target. PR #3 stays unmerged;
no Task 4, paid calls, production keys, VPS access or deployment is authorized by this amendment.

## Task 4 execution authorization — 14 November 2026

The user authorized verifying and squash-merging PR #3, then implementing Task 4 in Cloud.
PR #3 merged as `796719f` after its latest AMD64/ARM64 checks passed and reviews/threads
showed no blockers. The accounting amendment above remains in force; its former PR #3 /
Task 4 stop point is historical. Task 4 must stop with its new PR unmerged. Task 5, VPS
access and deployment remain unauthorized. See [Task 4 contracts](context-direct.md).

## Task 4 required-input correction — 14 November 2026

The user's correction supersedes Task 4's initial builder cap/truncation decisions.
Human/own-bot history limits govern previous messages only. Always include the intact
current mention/reply or /ask prompt once, separately from those caps, even when human
history is zero. Server instructions and current direct text are required: remove optional
history first, never silently truncate required input, and return typed user-safe
`input_too_large` without generation when required input plus the configured generation
ceiling cannot fit. Automatic context must retain usable human conversation with unchanged
instructions or return a diagnosable skip; this does not authorize Task 5 scheduling.
The user accepts cooldown state clearing on restart for v1. Live Discord wiring remains
later-task work. Keep PR #4 unmerged, preserve the accounting amendment, and do not start
Task 5, access the VPS or deploy.

## Task 5 execution authorization — 14 November 2026

The user authorized merging PR #4 only after verifying latest head `abb4b08`, passing checks
and no review blockers. It squash-merged as `6fb49ab`. The user now authorizes Task 5 in
Cloud on `feat/task-5-automatic`, with injected clocks, mocks and isolated PostgreSQL.
Earlier Task 5 stop points above are historical; preserve their accounting and required-
input policies. Stop with Task 5's PR unmerged. Live Discord wiring and deployment remain
later phases; no paid calls, production keys, VPS access or deployment is authorized.

## Read this first

The user approved the consolidated design in chat. No application code has been implemented here. This file contains the approved requirements and phased implementation plan. Numerical defaults explicitly labelled below are engineering proposals, not previously requested values. Do not silently widen the scope.

Work locally in the user's Debian Termux checkout at `~/jackass-bot`, not `~/roblox-dev`. Inspect git status and local instructions before changes; preserve existing work. The remote README was checked on 13 November and contains only `# jackass-bot` and `bot for aa`; recheck the actual checkout before scaffolding.

The user is new to this workflow and wants simple, sequential instructions. Explain necessary user actions, verify their outcome and never assume setup has happened. Do not ask the user to pick routine libraries or architecture details. Do not deploy during implementation tasks. Do not push or merge merely because a local task is complete.

### Confirmed setup

- Oracle Ubuntu ARM64 VPS: 4 OCPUs, 24 GB RAM, Docker installed; also runs Stremio addons and Watchtower.
- Domain controlled through Cloudflare; intended URL `https://galaxy.bubbleaio.uk`. DNS, HTTPS, OAuth redirects and reverse proxy have NOT been configured or verified.
- Discord application created, bot added to the user's server, Message Content Intent enabled. User confirmed server-only install settings, bot/application-command scopes, and View Channels, Send Messages, Read Message History, Embed Links permissions. Verify in deployment; do not request Administrator for the bot.
- Debian Termux has Codex and OpenSSH. Git repository cloned. SSH login to `ubuntu@145.241.204.168` using `~/.ssh/galaxy_codex` passed, including a BatchMode `whoami` test returning `ubuntu`.
- Key is passphrase protected. An SSH agent was loaded in the tested Debian shell; a new shell or restarted phone may need the agent set up again. Never embed passphrases, private keys, bot tokens or provider keys in this file, prompts, logs or Git.
- This ChatGPT cloud conversation does not itself have VPS access. Termux Codex can use the tested SSH connection when launched from the shell with the agent environment.
- Public name: Galaxy Neegy. Repository name: jackass-bot. User supplied a purple/navy/gold cosmic mascot logo; copy it only when available locally, do not regenerate or invent it.

## A. Product specification

### A1. Scope and exclusions

One text-only conversational bot, public landing page, Discord sign-in and mobile-friendly per-server dashboard. Public pages provide Add to server, sign-in, contact-for-approval guidance and privacy information. Only creator-approved server IDs may configure or use AI. No approval-request workflow: owners contact the creator directly. Do not invent a contact handle.

No DMs, threads, forum posts, attachments, image interpretation, browsing, external AI tools, durable chat memory or user profiles. No moderation, music, economy, billing system or other all-in-one modules in v1. Ignore edits as new triggers; never count the same message twice.

New servers start disabled. Require approval, at least one valid provider configuration, model selection and explicit enablement. An unapproved installation must not consume provider tokens or expose server settings. Creator can approve/revoke server IDs through a creator-only page.

### A2. Configuration and conversation rules

One configuration and instructions/personality per server; no per-channel model/personality overrides. Automatic participation has an explicit channel allowlist. Direct responses have one server-wide switch, applying to mentions, replies to this bot and /ask. Restrict v1 to Discord ordinary guild text channels; threads, forum posts and all other channel types are excluded even if permissions allow them. Never process other servers' settings or conversation data.

Only human messages count toward automatic activity. Ignore other bots and webhooks as triggers and context. Include this bot's own previous responses only under its separate context cap. Context comes only from the responding channel, chronological, with recent messages selected by count, not elapsed time. For /ask, include its submitted prompt once. Deduplicate the triggering message if already fetched from history. Do not fetch remote referenced-message content from another channel. Respect current channel permissions and fail closed if context access is lost.

Mentions and replies normally receive answers, including short greetings, jokes, slang and typos. Silence only for clearly meaningless spam/gibberish. A cheap prefilter may reject obvious spam; contextual judgement can consume tokens even when silent. Model silence must be explicit structured output, not an empty-text transport failure.

Five-second direct cooldown per user per guild, across channels, beginning when the request is accepted. Only one outstanding direct request per user/guild. Cooldown messages are not queued; slash interactions still need an acknowledgement, so send a brief private cooldown notice. Mentions/replies during cooldown can be ignored silently. Other users have independent cooldowns.

Automatic responses use message count ONLY. Staff choose always-contribute or only-when-appropriate. A successful assessment resets the counter even when choosing silence; API failure does not. Direct responses never reset it. Direct-triggering human messages still count. A message eligible for both gets a direct response only and leaves the automatic counter ready for a later human message. Configurable minimum gap between automatic assessments is a brake, not a timer: if threshold is reached during the gap, trigger only on the next eligible human message after the gap. Successful silent assessments also set the gap timestamp.

Process channel requests serially, with bounded queues and deduplication. When an automatic assessment starts, snapshot the count; on success consume only that snapshot, preserving messages received while it ran. Persist state sufficient to avoid resets on normal restarts. Do not promise exactly-once external API execution across crashes; uncertain attempts must not be blindly replayed.

Show typing while generating; deliver complete messages rather than streaming edits. /ask defers publicly, then edits its public answer. Split long text at Discord's supported size boundaries without malformed formatting, maintaining notification restrictions on every part. Notify only explicit individual user IDs present among human participants in supplied context (including requester), capped to prevent mass notification. Disable automatic reply-author notification unless deliberately allowed. Never enable role/everyone mentions through raw generated content.

### A3. Commands

- /help: general usage, website and disclosure that recent messages go to configured AI providers; no keys or privileged details.
- /ask prompt: public text answer, same switch, context, personality, cooldown and quota rules as mentions/replies.
- /settings: authorised users only; private dashboard link.
- /status: authorised users only; private model/provider availability and allowance information.

Enforce checks at execution, not only command registration. Disabled direct responses do not disable staff settings/status commands. No commands operate in threads or DMs.

### A4. Providers, budgets and failure handling

Save both OpenAI and Google keys; staff choose priority. Each has its own supported model, supported effort setting and daily token allowance. Curated model catalog in one code file; verify current official provider documentation before selecting concrete IDs, SDK versions, effort values and usage accounting. Do not assume all models accept the same parameters or expose identical token fields. Google uses the API-key-based Gemini API unless the user later requests Vertex AI.

Fallback on local allowance exhaustion, provider credit/quota exhaustion, rate limits and temporary availability errors. Do not fallback to evade safety refusals. Invalid credentials/model configuration should surface as actionable staff errors; prevent repeated failing attempts and permit the other configured provider where applicable. One request tries each eligible provider at most once; respect Retry-After and bounded timeouts. Periodic recovery means an eligible future request can probe a provider after its backoff, not autonomous paid test calls.

Allowances reset at 00:00 UTC, explicitly shown in UI. They are practical usage safeguards, not guaranteed hard billing caps. Atomically reserve estimated input plus the enforced total generation limit, including hidden reasoning where model accounting requires it. Use the documented request-counting facility where supported and include countable instructions, history and structured-output content. Label additional margins as engineering estimates, not guaranteed upper bounds. The user amendment above supersedes the earlier reject-unbounded-model requirement: lack of a guaranteed input accounting bound alone must not disable a model. Reconcile the full reported actual usage without double counting cached input or reasoning already included in output totals, even when actual usage exceeds the reservation. Stop further calls once known usage plus uncertain charges and reservations exhausts the configured allowance. Estimates and already in-flight requests can cause overshoot; never silently increase the allowance. For timeouts with uncertain billing, retain the estimated reservation and label it uncertain; it is not proof of the maximum billed usage and must not be released as definitely free. Track each provider attempt separately, including a failed primary followed by a successful fallback.

When all eligible providers are exhausted/unavailable, stop automatic messages silently and give a brief rate-limited direct-request notice without an AI call. Never regenerate merely because Discord delivery failed; retry delivery boundedly using the already-generated response in memory. After a crash, do not regenerate uncertain delivery automatically.

Show provider tokens, request counts, remaining allowance, reset time, active/last-used provider and sanitised error codes. No monetary estimates. Successful silent assessments count as usage. Do not expose raw provider response bodies as errors.

### A5. Access control

Full per-server control: server owner; current Discord Administrator members; creator (immutable configured Discord user ID) if both creator and bot are currently members. Manage Server alone does not qualify.

Owner/admin/creator may grant dashboard access to individual members or roles. Delegates may edit ordinary settings, including models and personality, view usage/status and lower allowances. They may NOT manage keys, grant access, raise allowances or create a new funded provider configuration. Clearly warn grantors that delegates changing models/frequency can affect spending even without raising token allowances. Prevent delete/recreate, provider reorder, omitted fields and settings reset from bypassing budget/key restrictions.

Only creator manages global approval. Creator approval management does not allow viewing arbitrary server data unless the creator membership rule is satisfied. Keep /status and /settings private to caller. Saved keys are write-only to everyone, including creator: set/replace/remove/status, never retrieve plaintext.

Validate backend access for every action using authenticated identity and current Discord membership/roles. Fail closed on unverifiable permissions. Discord owner/admin rights cannot be removed through delegated ACL. Resolve a member's current roles through documented REST/OAuth capabilities; do not enable broad member/presence intents without demonstrated need. Invalidate sessions/access caches on known changes and revalidate protected operations rather than trusting OAuth guild lists indefinitely.

### A6. Architecture and database

Chosen approach: one modular TypeScript application serving Discord gateway, Fastify backend and built React/Vite assets, plus PostgreSQL/Drizzle. Alternative considered: separate bot/web services; rejected initially because independent restarts do not justify extra deployment coordination for a few servers. No Redis, microservices, Kubernetes, sharding or runtime plugin loader.

Single process/replica only in v1, with a database singleton lease/lock preventing accidental second active bot worker during deployment. Current supported Node LTS and compatible package versions must be verified and pinned at implementation; commit lockfile. npm scripts provide consistent lint/typecheck/unit/integration/build commands. Real database integration tests run in CI because proot on Android may not support Docker; do not run tests against production.

Logical tables (all guild-owned records include guild_id and cascade from guild config):
- approved_guilds(guild_id PK, approved_by, approved_at): creator-controlled allowlist, independent of installed guild config.
- guild_settings(guild_id PK, instructions, enabled, direct_enabled, context limits, auto policy/gap/threshold, revision, timestamps).
- provider_configs(guild_id, provider composite PK, ciphertext+nonce+key_version, model_id, effort, priority, daily_allowance, configuration revision).
- auto_channels(guild_id, channel_id composite PK); channel_state(guild_id, channel_id composite PK, pending_count, assessment snapshot state, last_success_at).
- access_grants(guild_id, subject_type user|role, subject_id composite unique, granted_by).
- daily_usage(guild_id, provider, utc_date composite PK, known input/output/reasoning-normalized totals, uncertain tokens, reserved tokens, requests).
- usage_reservations(id UUID PK, guild_id, provider, utc_date, reserved, state, attempt id unique, timestamps). Preserve original UTC bucket on settlement across midnight.
- request_receipts(guild_id, event_id unique, state, timestamps): identifiers only for deduplication, no prompt/response text.
- web_sessions(opaque hashed session ID, user ID, encrypted OAuth token material if required, expiry).
- audit_events(guild_id nullable for approval actions, actor, action, safe changed-field names, timestamp); operational_errors(guild_id, provider, safe code, correlation ID, timestamp).

Store Discord snowflakes as strings in application code; avoid JavaScript number precision loss. Constraints enforce nonnegative counters and unique priorities. Use optimistic settings revision checks to prevent lost dashboard edits. Do not put keys/instructions/chat text into audit diffs.

### A7. Security, retention and privacy

Encrypt provider keys and any stored OAuth tokens with authenticated encryption and random nonces; key lives outside Git and database. Bind ciphertext to guild/provider context to prevent swapping. Document key rotation and restore requirements. Use secure HttpOnly SameSite cookies, OAuth state, session rotation, CSRF protections, origin checks, backend validation and request limits. Never trust a guild ID supplied by the browser. Render instructions/model output safely; no raw HTML injection. Disable sensitive request/body logging.

No conversation text or responses persisted in DB/logs; fetch bounded Discord history on demand and hold briefly in memory. External providers may retain data according to their policies: do not claim zero provider retention. Publish creator access and provider context disclosure in privacy information. Never place secrets in AI prompts. Separate staff instructions from untrusted chat; models cannot operate tools or change settings. Prevent prompt-injection attempts from affecting application permissions, secrets or notification policy.

Engineering retention defaults: sanitised operational errors 7 days; settings audit and daily usage 90 days; completed receipts/reservations 7 days after aggregation, retaining unresolved usage conservatively; sessions expire after 7 days. Daily cleanup. Successful bot removal from a guild deletes its keys, settings and related live records; approval remains. Startup reconciles stale installations after verifying actual membership (API outage is not removal). Encrypted backups may retain deleted records until expiry; disclose maximum 7-day backup retention. Revoking approval disables immediately and deletes credentials; do not automatically re-enable on reapproval.

### A8. Engineering default values (reviewable proposals)

Disabled initially; no auto channels; threshold 30 human messages; automatic gap 60 seconds; conditional participation; 30 human context messages, 5 own-bot messages, context token ceiling 8,000; visible answer target 400 tokens, model-aware total generation ceiling 2,048 tokens including reasoning where applicable. Reject incompatible combinations rather than silently exceeding model budgets. Instructions limited to 8,000 characters; max configured context 100 human messages and 20 bot messages; max context tokens 32,000, bounded by model limits; threshold 1–10,000; gap 5–3,600 seconds. At most 3 notified participants per answer.

No default funded daily allowance: require owner/admin/creator to enter a positive allowance before activation. Display output targets vs hard model token ceilings separately. Two concurrent provider calls globally, 10 waiting requests per channel, 100 globally; direct requests have priority without starving auto indefinitely. Drop stale queued requests after 30 seconds with a short direct notice. Provider timeout 60 seconds; short transport backoff begins at 30 seconds, capped at 15 minutes; respect longer Retry-After. Permanent auth faults need settings change before retry. Make limits centrally defined and tested.

### A9. Deployment

Dedicated Compose project and folder. PostgreSQL has no published port. Application runs unprivileged, without Docker socket; add health/readiness endpoints without sensitive diagnostics. Persist DB and keep secrets out of image layers. Pin image versions/digests; exclude application and DB from Watchtower and verify its actual configuration before deployment.

Inspect existing containers, published ports, proxy, firewall, storage and Docker Compose support read-only first. Never restart/update Stremio, Watchtower, the OS or unrelated services. Build/test ARM64 images in GitHub CI; deployment chooses an exact tested image, backs up, runs migrations explicitly, starts one active instance and checks health. Do not use floating latest for production. No destructive migrations without a recovery plan. Previous image rollback is valid only with compatible schema.

Use existing proxy if appropriate; otherwise propose a dedicated HTTPS route after inspection. Configure Cloudflare DNS, HTTPS and exact Discord OAuth redirect `https://galaxy.bubbleaio.uk/auth/discord/callback` during deployment, not during coding. Use HTTPS-only production cookies. Require an encrypted off-VPS backup destination before live usage; retain 7 daily backups, keep recovery encryption key separately, and perform a restore drill in an isolated environment. Backup setup is a pending user/provider choice, not completed work.

Pending deployment inputs: Discord application/client ID, creator user ID, first approved guild ID, bot token, OAuth client secret, contact link, available logo file, registry/image permissions, backup destination. Obtain secrets through environment files or appropriate secret storage, never chat or committed files. Staff provider keys are supplied through the finished dashboard.

## B. Implementation plan

> For agentic workers: use superpowers:executing-plans if available to implement task-by-task. If unavailable, follow this checklist directly. No subagents are required. The user selected a Termux Codex workflow; do not switch execution environments without explaining why.

**Goal:** Build the approved Galaxy Neegy v1 without touching unrelated VPS services.

**Architecture:** One modular backend/bot process serves a compiled dashboard and uses PostgreSQL. Single replica with explicit concurrency, accounting and delivery boundaries.

**Tech stack:** TypeScript, supported Node LTS, discord.js, Fastify, React/Vite, PostgreSQL, Drizzle, npm, Vitest, Playwright and Docker Compose. Verify exact versions against official sources before installation.

**Spec:** Section A of this file. On adoption, store this complete file as `docs/galaxy-neegy-handoff.md`; optionally split Section A into `docs/superpowers/specs/2026-11-13-galaxy-neegy-design.md` and Section B into `docs/superpowers/plans/2026-11-13-galaxy-neegy.md`, preserving cross-links.

### Global constraints

- No application implementation or VPS modification until the user instructs implementation; approval of this handoff is not a deployment request.
- Text only; no threads/DMs/other bots; per-guild isolation; 5-second direct cooldown; no chat persistence.
- New installs disabled; staff keys write-only; creator override requires guild membership; approval global to creator only.
- All tests use mocks or isolated test database. No paid provider calls unless explicitly enabled for a small smoke test.
- Verify current Discord/provider APIs and models from official sources; document links checked in `docs/compatibility.md`.
- Finish each task with focused verification, a review of its diff and a local commit; stop after the requested task. Do not commit failing work as complete.

### File ownership map

`src/config.ts` environment validation; `src/main.ts` lifecycle; `src/domain/types.ts` shared contracts; `src/db/schema.ts` database; `drizzle/` reviewed migrations; `src/access/` access policy; `src/settings/` validated configuration; `src/discord/` adapters and commands; `src/conversation/` context/eligibility/orchestration; `src/providers/` provider adapters/catalog/fallback; `src/usage/` reservations/accounting; `src/web/` auth/routes; `src/ops/` logging/health/cleanup; `web/src/` UI; `tests/unit/`, `tests/integration/`, `tests/e2e/`; `deploy/` production runbooks and configuration; `.github/workflows/` checks/images.

### Shared interfaces

Define these in `src/domain/types.ts` in Task 1 and keep consumers aligned:

- `ProviderId = 'openai' | 'google'`; `AccessLevel = 'none' | 'delegate' | 'admin' | 'creator'`.
- `RequestSource = 'mention' | 'reply' | 'ask' | 'automatic'`.
- `BotRequest { id: string; guildId: string; channelId: string; userId: string; source: RequestSource; prompt?: string; receivedAt: Date }`.
- `ContextMessage { id: string; authorId: string; kind: 'human' | 'self'; text: string; timestamp: Date }`.
- `NormalizedUsage { inputTokens: number; outputTokens: number; reasoningTokens: number; totalTokens: number; certainty: 'reported' | 'estimated' }`. Reasoning is a breakdown, not necessarily an additional charge; adapters calculate non-double-counted totalTokens.
- `GenerationResult = { kind: 'answer'; text: string; usage: NormalizedUsage } | { kind: 'silence'; usage: NormalizedUsage } | { kind: 'refusal'; text: string; usage: NormalizedUsage }`.
- `ProviderError { category: 'rate_limit' | 'quota' | 'auth' | 'configuration' | 'transient' | 'uncertain'; retryAfterMs?: number; usage?: NormalizedUsage; safeCode: string }`.
- `GenerationInput { instructions: string; context: ContextMessage[]; mode: 'direct' | 'auto_always' | 'auto_conditional'; modelId: string; effort?: string; maxGenerationTokens: number }`.

### Review focus

1. Removed members/roles and forged guild IDs must lose access: Task 2 and Task 7.
2. In-flight messages, duplicate events and midnight rollover must not lose counts or double-spend: Tasks 3 and 5.
3. Malicious prompt output must not create mass pings, expose keys or execute HTML: Tasks 4, 6 and 7.
4. Provider timeout, Discord delivery failure and process restart must not blindly regenerate: Tasks 3, 5 and 6.
5. Updating this project must not affect existing services or destroy recoverable data: Task 9.

### Task 1 — foundation and isolated data layer

Files: `package.json`, lockfile, TypeScript/lint configs, `.gitignore`, `.env.example`, `src/config.ts`, `src/domain/types.ts`, `src/main.ts`, `src/db/schema.ts`, `drizzle.config.ts`, `drizzle/`, `compose.dev.yaml`, `tests/unit/config.test.ts`, `tests/integration/schema.test.ts`, `.github/workflows/checks.yml`, `docs/compatibility.md`, README.

Interfaces: `loadConfig(env: NodeJS.ProcessEnv): AppConfig`; `createDatabase(url: string): Database`; define AppConfig/Database exports locally. Schema implements A6 with safe constraints and deletion boundaries. AppConfig requires secrets only in enabled runtime modes; tests must not need real credentials.

- [ ] Inspect status/README/AGENTS; create a local feature branch without overwriting work. Record confirmed setup and pending inputs.
- [ ] Verify supported Node/library/Postgres/ARM64 combinations and official API documentation; select pinned versions and scripts: lint, typecheck, test, test:integration, test:e2e, build.
- [ ] Write config tests: missing production encryption key rejected; invalid origin rejected; secrets omitted from validation output. Run focused tests and confirm meaningful initial failure.
- [ ] Implement environment validation, contracts and DB schema/migrations; no live Discord/provider startup yet.
- [ ] Test migrations against isolated PostgreSQL: duplicate provider priority rejected; negative usage rejected; large snowflake round-trip preserved; deletion leaves approval but removes guild-owned data. CI supplies PostgreSQL if local Docker unavailable.
- [ ] Run lint, typecheck, focused tests, integration tests where available, and build. Report skipped local checks honestly with CI evidence when obtained. Review diff and commit `chore: establish Galaxy Neegy foundation`.

Acceptance: clean reproducible install/build, safe config errors and passing schema tests. No VPS connections or paid calls.

### Task 2 — settings, access and encrypted credentials

Files: `src/access/policy.ts`, `src/access/discord-membership.ts`, `src/settings/service.ts`, `src/settings/validation.ts`, `src/settings/credentials.ts`, `tests/unit/access.test.ts`, `tests/integration/settings.test.ts`.

Interfaces: `resolveAccess(userId: string, guildId: string): Promise<AccessLevel>` via injected membership repository; `updateSettings(actorId: string, guildId: string, patch: SettingsPatch, expectedRevision: number): Promise<GuildSettings>`; `setCredential(actorId: string, guildId: string, provider: ProviderId, key: string): Promise<void>`. Define/export SettingsPatch/GuildSettings matching A2/A8. Credential service never exposes plaintext through web-facing methods.

- [ ] Write permission-table tests: owner/admin/creator/member/delegate roles, departed creator, deleted role, unapproved guild, spoofed guild, Discord lookup failure. Assert fail-closed behaviour.
- [ ] Implement access and approval services with injected Discord lookup and centrally enforced action permissions.
- [ ] Write encryption/settings tests: ciphertext tamper and cross-guild substitution rejected; no key in returned object/log/audit; concurrent stale revision rejected; delegate cannot increase allowance through reset, reorder, partial update or recreate.
- [ ] Implement authenticated encryption, validation, revision checking and safe audit records.
- [ ] Run focused tests, typecheck and lint; review and commit `feat: secure server settings and access`.

### Task 3 — provider adapters and token accounting

Files: `src/providers/catalog.ts`, `src/providers/openai.ts`, `src/providers/google.ts`, `src/providers/router.ts`, `src/usage/service.ts`, `tests/unit/providers.test.ts`, `tests/integration/usage.test.ts`.

Interfaces: `ProviderAdapter.generate(input: GenerationInput, credential: string, signal: AbortSignal): Promise<GenerationResult>`; `reserveUsage(guildId: string, provider: ProviderId, attemptId: string, estimate: number, now: Date): Promise<Reservation | null>`; `settleUsage(id: string, usage: NormalizedUsage | null, outcome: 'known' | 'uncertain' | 'not_sent'): Promise<void>`; `generateWithFallback(request: BotRequest, input: GenerationInput): Promise<GenerationResult>`. Define Reservation with id, original UTC date, provider, amount and state.

- [ ] Verify exact model IDs/effort/usage APIs; write fixture tests for both adapters, including reasoning and cached-token non-double-counting, empty response vs explicit silence, and refusal.
- [ ] Implement a small curated catalog and adapters with request limits, cancellation, safe errors and no external tools.
- [ ] Write PostgreSQL concurrency tests: concurrent estimates cannot be admitted above the allowance; underestimated actual usage is recorded in full, including concurrent overshoot, and blocks further calls after exhaustion without raising allowances; repeated settle idempotent; midnight settlement belongs to original bucket; uncertain timeout does not free reserved usage; success on fallback records both attempts correctly.
- [ ] Implement atomic reservations and bounded provider routing/backoff. Test priority, quota fallback, rate-limit recovery and no safety-refusal fallback.
- [ ] Run unit/integration checks, typecheck and lint; commit `feat: add bounded AI providers and usage accounting`.

### Task 4 — bounded context and direct requests

Files: `src/conversation/context.ts`, `src/conversation/eligibility.ts`, `src/conversation/direct.ts`, `tests/unit/context.test.ts`, `tests/unit/direct.test.ts`.

Interfaces: `buildContext(request: BotRequest, settings: GuildSettings): Promise<ContextMessage[]>`; `acceptDirect(request: BotRequest, now: Date): Promise<'accepted' | 'cooldown' | 'disabled' | 'unsupported' | 'busy'>`. Inject clock, history fetcher and access/config repositories.

- [ ] Write tests for channel-only history, ignored bots/webhooks, own-bot cap, no threads/DMs, removed permissions, bounded history fetches, duplicate trigger, /ask prompt inclusion and token truncation.
- [ ] Implement chronological context selection and server-level eligibility; newest relevant content survives truncation; never download attachments or linked pages.
- [ ] Write fake-clock tests: user blocked at 4,999 ms, eligible at 5,000 ms if no outstanding request; another channel does not bypass; another user unaffected; completion clears outstanding state on every outcome.
- [ ] Implement direct orchestration and conservative gibberish handling. Verify greetings and slang still reach provider; model receives structured untrusted messages, not fabricated privileged instructions.
- [ ] Run focused checks and commit `feat: add channel context and direct response rules`.

### Task 5 — automatic assessments and scheduling boundaries

Files: `src/conversation/automatic.ts`, `src/conversation/queue.ts`, `src/conversation/receipts.ts`, `tests/unit/automatic.test.ts`, `tests/integration/channel-state.test.ts`.

Interfaces: `observeMessage(request: BotRequest, now: Date): Promise<'counted' | 'eligible' | 'ignored'>`; `completeAssessment(guildId: string, channelId: string, snapshotCount: number, succeeded: boolean, now: Date): Promise<void>`; `enqueue(request: BotRequest): 'accepted' | 'full'`. Integrate duplicate-event IDs before incrementing.

- [ ] Write tests for selected channels, threshold, minimum gap without timers, direct/auto collision, silent success reset, API failure retention and no count from other bots.
- [ ] Implement persisted counters, snapshot consumption and assessment locks. Test human messages arriving during the call remain counted and normal restart retains counters.
- [ ] Implement bounded channel queues, global concurrency and singleton-worker guard. Test stale/full queues, fair priority, overlapping triggers and duplicate gateway delivery.
- [ ] Test crash recovery releases processing locks but does not automatically repeat uncertain AI calls; reconcile quota conservatively.
- [ ] Run checks and commit `feat: add automatic conversation participation`.

### Task 6 — Discord commands and safe output delivery

Files: `src/discord/client.ts`, `src/discord/events.ts`, `src/discord/commands.ts`, `src/discord/delivery.ts`, `src/discord/register.ts`, `tests/unit/discord.test.ts`.

Interfaces: `handleDiscordRequest(request: BotRequest): Promise<void>`; `deliverAnswer(request: BotRequest, text: string, participantIds: string[]): Promise<void>`. Only this module sends Discord messages; routing module returns a result, never sends twice.

- [ ] Write adapter tests for command visibility/access, direct switch, thread exclusion, fast slash defer, typing cleanup and actionable staff errors without secret leakage.
- [ ] Implement guild-scoped test registration first, then production registration command; no registration on every reconnect.
- [ ] Write tests for mass/role mentions, fabricated user mentions, reply-author ping, long text splitting, Discord rate limits and failed delivery. Assert retries do not call provider again and every message segment preserves allowed-mentions restrictions.
- [ ] Implement delivery and bounded retries. Add non-AI allowance/unavailability notices with a per-channel 60-second notice limiter; slash requests must still be acknowledged privately when a public notice is suppressed.
- [ ] Run checks; commit `feat: connect Discord commands and safe delivery`.

### Task 7 — website, login and mobile dashboard

Files: `src/web/server.ts`, `src/web/auth.ts`, `src/web/routes.ts`, `web/src/App.tsx`, `web/src/pages/Landing.tsx`, `web/src/pages/Servers.tsx`, `web/src/pages/Settings.tsx`, `web/src/pages/Creator.tsx`, `web/src/styles.css`, `tests/integration/web-auth.test.ts`, `tests/e2e/dashboard.spec.ts`.

Interfaces: `createWebServer(deps: WebDependencies): Promise<FastifyInstance>`; authenticated GET/PATCH `/api/guilds/:guildId/settings`, GET usage/status, write-only PUT/DELETE provider-key routes, ACL routes, creator approval routes. Settings PATCH requires revision. Define WebDependencies as injected services from Tasks 2–3; do not duplicate policy in controllers.

- [ ] Write auth tests: OAuth state mismatch/reuse, session fixation, forged guild IDs, expired membership, CSRF, blocked origins, private key retrieval impossible and no secrets in HTTP errors.
- [ ] Implement Discord OAuth/session handling and explicit backend authorisation for all routes. Rate-limit auth and credential endpoints.
- [ ] Build responsive navy/purple/gold pages; use supplied logo when available. Include onboarding checklist, validation, provider priority/effort, counters, context controls, ACL, quotas, safe error history and approval management. Show only supported effort controls. Preserve unsaved edits and handle revision conflicts visibly.
- [ ] Test desktop and 390px-wide layouts, keyboard access, field labels, no horizontal overflow, admin/delegate distinctions and malicious instructions rendered as plain text. Dashboard never offers monetary estimates.
- [ ] Run Playwright against mocks/isolated services, API integration tests, build and typecheck; inspect screenshots; commit `feat: add Galaxy Neegy website and dashboard`.

### Task 8 — integrated reliability and operational packaging

Files: `src/ops/health.ts`, `src/ops/logging.ts`, `src/ops/cleanup.ts`, `Dockerfile`, `compose.yaml`, `.github/workflows/image.yml`, `tests/integration/lifecycle.test.ts`, `docs/privacy.md`, `docs/runbook.md`, README.

Interfaces: `startApplication(config: AppConfig): Promise<{ stop(): Promise<void> }>`; authenticated internal lifecycle dependencies and public minimal GET `/health/live`, `/health/ready`.

- [ ] Test end-to-end event-to-provider-to-delivery with fake providers; prove cross-guild isolation, settings changes during queued work, global disable and approval revocation rechecked before calls/delivery.
- [ ] Implement startup/shutdown, readiness, lease ownership, cleanup, guild-removal purge and sanitised logs. Test startup Discord outage does not purge installed guilds; actual removal does. Test retention and pending reservations.
- [ ] Build multi-stage nonroot ARM64 image and Compose with no public DB port, health checks, explicit secrets and Watchtower exclusion. CI builds without production secrets and tests dependencies before publishing immutable commit tags.
- [ ] Run full test suite and image smoke checks in CI or another isolated capable environment. Do not substitute production VPS for unavailable proot Docker.
- [ ] Review privacy/runbook consistency, secret scanning and dependency findings; commit `build: package tested ARM64 deployment`.

### Task 9 — supervised deployment and recovery (separate authorisation)

Files: `deploy/README.md`, `deploy/backup.sh`, `deploy/restore.sh`, `deploy/deploy.sh`, optional project-scoped proxy configuration after inspection.

- [ ] Stop and obtain explicit deployment instruction. Confirm missing IDs, contact link, logo, secrets placement and off-VPS backup destination. Do not treat earlier SSH setup as permission to deploy now.
- [ ] Read-only inspect VPS containers, ports, routing, disk, Compose and Watchtower configuration; present exact intended changes. Verify SSH host identity through trusted existing access before sensitive deployment if not previously verified.
- [ ] Prepare project-only deployment/backup/restore procedures, validate shell and Compose configuration, and verify private DB network. Never run global prune, broad down commands or OS upgrades.
- [ ] Configure secrets, DNS/HTTPS and OAuth redirect with user assistance only where needed. Verify callbacks and certificate. Deploy exact tested image using explicit migration step and health check.
- [ ] Test encrypted off-VPS backup and isolated restore before enabling AI. Demonstrate rollback procedure for compatible schema and document migration-recovery limits.
- [ ] Run small opt-in provider smoke tests in user's server; confirm usage, failover, mentions, auto counts and dashboard roles. Check existing Stremio services remain healthy. Enable friends only after owner acceptance.
- [ ] Record image commit, migration version, verification results and recovery instructions; commit only nonsecret runbooks. No claim of success without observed checks.

## C. First prompt for Termux Codex

Read `docs/galaxy-neegy-handoff.md` completely. It is the approved design and ordered implementation plan for this repository. First inspect the checkout, git status, instructions and installed tooling. Summarise what is ready and what is missing. Do not implement application code, install dependencies, push commits or connect to/change the VPS yet. Preserve the current README and unrelated work. Wait for my instruction to begin Task 1. Use clear, short instructions suitable for a beginner working on Android. This project is separate from ~/roblox-dev.

## D. Progress record

- [x] Feature/design discussion approved by user.
- [x] Discord application and server installation confirmed by user.
- [x] Debian SSH key connection and BatchMode check confirmed by user.
- [x] Phone checkout cloned, confirmed by user.
- [x] Specification and phased task handoff prepared.
- [ ] Handoff copied into phone checkout and read by Termux Codex.
- [ ] Task 1 explicitly started.
- [ ] Tasks 1–8 implemented and verified.
- [ ] Deployment authorised and Task 9 verified.

Plan self-review: every A1–A9 requirement maps to Tasks 1–9; shared provider/usage contracts are consistent; failure cases assigned in Review focus. Runtime/provider compatibility, live logo availability, remote service inventory and off-VPS backup destination remain execution checks, not claimed completed work.
