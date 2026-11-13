# Task 2: settings, access and credentials

Scope: backend services only. No HTTP routes, OAuth sessions, Discord startup, provider
calls, SDK/model selection or deployment. Application startup still validates config and
exits. Task 3 supplies the model catalog/provider worker; Task 7 supplies authenticated
web routes. The complete approved handoff remains unchanged.

## Access and current membership

`AccessPolicy.resolveAccess(userId, guildId)` returns none/delegate/admin/creator.
Every service operation checks the approved guild ID and current Discord membership
again; there is no TTL permission cache. The bot and actor must both be current members.
Owner and Administrator rights override saved grants. Manage Server (bit 32) alone does
not qualify. Administrator is bit 8, evaluated from current role permissions including
`@everyone`. A creator override requires the immutable configured creator ID and current
membership. Role grants only count if the role still exists and is currently assigned.

`DiscordMembership` accepts an injected bot-authenticated REST GET transport. It fetches
`/guilds/:guildId`, individual actor/bot `/members/:userId` and `/roles`; it validates the
returned IDs and shapes. Each call has a five-second timeout and cancellation signal;
missing members, malformed data, transport errors and lost access deny authorisation.
No guild-member list, gateway member cache or presence/member privileged intent is used.
The official Get Guild Member endpoint is distinct from List Guild Members, whose docs
explicitly require the member intent. Channel checks fetch `/channels/:id`, require the
same guild and type 0 (ordinary guild text). Current message/context permissions remain
Task 4's responsibility.

The injected transport must supply bot authentication privately, preserve Discord rate
limits, honour abort signals, and avoid request/response-body logging. This task never
constructs a network client or contacts Discord. Production transport wiring belongs to
the Discord/web tasks. Do not substitute OAuth guild lists for these current checks.

The service accepts an **authenticated backend actor ID**. The later web layer must get
that ID from its protected session, never a request body. A browser-supplied target guild
ID is always independently checked by policy. Authentication, CSRF and cookies belong to
Task 7; they are not claimed implemented here.

## Settings and transaction boundaries

Create `SettingsService(database, policy, cipher, modelSupport)` with injected dependencies.
`SettingsPatch`/`GuildSettings` are exported from `src/settings/service.ts` and defined in
`validation.ts`. Supported settings cover A2/A8, channel allowlists and explicit provider
patches. Unknown/reset/revision/guild/credential fields are rejected. Decimal daily
allowances use strings and bigint comparison to avoid JavaScript precision loss.

- `getSettings(actorId,guildId)` returns a fresh authorised projection, with provider
  model/effort/priority/allowance and `credentialConfigured` status, never encrypted or
  plaintext key material.
- `updateSettings(actorId,guildId,patch,expectedRevision)` preserves omitted values and
  rejects stale revisions. Patch provider entries identify existing providers; they never
  implicitly create or delete one. Empty/null provider-list reset requests are invalid.
- `grantAccess`/`revokeAccess` require a full manager, a revision and a current valid
  user/role target (revoking a departed target remains possible). Grants require explicit
  acknowledgement of `DELEGATE_SPENDING_WARNING`; `listAccess` returns that warning too.
  Later UI must display it before acknowledgement, rather than silently setting true.
- `setApproval`/`listApprovals` accept only the configured creator identity; approval
  management requires no membership but grants no server-data access. Revocation disables
  immediately in committed database state and deletes keys. Reapproval never enables or
  restores keys. Runtime workers must recheck approval before calls/delivery in later tasks.

All transactional guild operations use the same advisory lock, fresh policy check and safe
errors. New allowlist channels are checked before acquiring that lock, with at most four
lookups in flight and a five-second total deadline/cancellation. Retained IDs are not
re-fetched. The transaction then rechecks current approval, membership and revision; a
revocation during slow validation denies the pending edit. Context use must still recheck
current channel access in Task 4. Revision changes include key/grant updates, preventing stale dashboards from
silently overwriting their effects. Approval revocation shares that lock; a concurrent key
write either finishes before revocation and is removed, or sees revoked access and fails.
Database/network errors are converted to fixed codes without raw bodies/SQL parameters.
Remote permission changes after the final REST check cannot be made atomic with Discord;
there is no claim of cross-system atomicity or persistent permission caching.

Delegates can edit personality/models/frequency/context and lower allowances. They cannot
set/remove keys, grant/revoke ACL, raise allowances, create provider rows, reorder provider
priority, or use reset/partial/omitted fields to bypass funding limits. Owner/admin rights
are not removable through ACL. Full managers can reorder providers transactionally; the
complete encrypted envelopes, model selections and allowances are preserved, and the
separate usage/reservation tables are never reset. Retained channel rows/state are kept
when editing the allowlist, so counters are not inadvertently deleted.

A new key is unfunded (`dailyAllowance=0`) with `modelId=null`. This is why migration 0001
relaxes only the model NOT NULL constraint: no fabricated model ID or funded default.
The injected `ModelSupport` must validate provider/model/effort plus context/generation
bounds. Its default denies all selections. Tests use clearly synthetic model IDs; Task 3
will supply the authoritative current catalog. A saved key is not a claim of live provider
validity or availability. Enablement requires at least one saved, supported, selected,
positively funded provider. Lowering the last allowance to zero or removing its key
automatically disables; an explicit invalid enable request fails.

## Encryption, write-only keys and rotation

`CredentialService` exposes set/remove/status only. `SettingsService` implements it;
there is no plaintext key getter, including for owner/creator. No method returns a key,
nonce, ciphertext or master key in a dashboard response. Setting/removing credentials
preserves historical usage. The internal `CredentialCipher.open` primitive is reserved
for the future provider worker and must never be routed through a web controller.

AES-256-GCM uses a fresh random 12-byte nonce per write and a 16-byte authentication tag
appended to ciphertext. Associated data binds application purpose, guild ID, provider and
key version. Altered ciphertext, substituted guild/provider context, unknown key versions
or the wrong master key fail authentication with `credential_invalid`. Key-ring buffers
use private fields and defensive copies; serialising the cipher exposes no keys.

The active 32-byte random encryption key lives outside Git and the database. The key-ring
constructor can retain older versions for decrypting existing rows and always seals with
the active version. Operational rotation must load old+new keys from secret storage,
re-encrypt each envelope internally using its original guild/provider context and a new
nonce, and retain old keys until all rows and retained backups have migrated/expired.
There is no web endpoint that exports plaintext for rotation. Alternatively authorised
staff can replace a provider key through `setCredential`, preserving its settings and
usage. Do not destroy the old encryption keys before confirming restore requirements.

Restore requires the database **and** the correct encryption key versions, held separately.
Without the keys, credentials are unrecoverable and staff must replace them. The task does
not configure backups or touch a live deployment. Actual operational rotation/restore
commands belong in the supervised runbook tasks, not an ad-hoc production script.

## Audit, migrations and verification

Audits contain actor IDs, action codes, safe changed-field names and timestamps, never
instructions, keys, provider response bodies or settings values. Global approval events
use a nullable non-FK `target_guild_id` so the creator's approval history identifies its
target even without an installed guild config. Migration 0002 adds this field and its
snowflake-format constraint. Guild-owned audit rows still cascade; global approval history
is independent. Review generated SQL and snapshot/journal files together.

Task 2 adds permission-table, REST-adapter, authenticated-encryption and PostgreSQL service
tests. The local full suite passed 83 unit tests and 32 integration tests, plus lint,
typecheck and build. Tests cover cross-server denial, revoked roles/members/approval,
write-only keys, tampering/substitution, stale revisions, delegate bypasses, priority swaps,
channel-state preservation, global approval privacy concurrent revocation/key writes, retired-model disablement and revocation during blocked
channel validation.
A real isolated Cloud PostgreSQL instance is used; Discord and model support are injected.
CI runs the same suites on AMD64 and native ARM64. The Task 2 PR records remote results;
no browser/live-provider/VPS check is represented as passing.


The fresh branch review found one Important issue: slow sequential channel checks held
the guild lock and could cause revocation to time out. The regression failed against
that implementation, then passed after prevalidation/deadline/cancellation and locked
revalidation were added. No other actionable review findings remained; the full suites
were rerun after the fix. Remote results are reported in the PR.
