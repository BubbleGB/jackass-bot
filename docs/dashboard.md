# Website and dashboard — Task 7

Current request sharing, bounded GET scheduling and independently retryable panels are
described in [the dashboard reliability investigation](dashboard-reliability.md).

Task 7 adds lazy Fastify HTTP/auth factories and a built React dashboard. Foundation
startup still validates and exits. Integrated production startup, proxy/DNS configuration,
operational cleanup and deployment remain Tasks 8–9, under separate authorization.

## Pages and policy ownership

The landing page uses the supplied Galaxy Neegy artwork, downloaded intact from the
owner's Pixeldrain link after the first Catbox copy proved truncated. The file is bundled
locally, so visitors make no request to either image host. No replacement artwork or
remote fonts were generated. Navy, purple and gold styles support 390px touch screens
and desktop, visible keyboard focus, labels, errors and a sticky Save bar.

Visitors can open the bot invitation or sign in. Owners must contact the creator for
approval; installation alone neither enables AI nor funds an allowance. `CONTACT_URL`
is optional and accepts a public HTTPS or mailto link. Until supplied, the page explains
that the owner must contact the creator directly; there is no invented contact handle
or approval-request workflow. Recent channel messages and instructions can go to the
configured OpenAI/Google provider, whose own retention policy applies.

`createWebServer(WebDependencies)` injects the database, `AccessPolicy`, `SettingsService`,
`DashboardDirectory`, OAuth adapter, origin, application ID and a stable 32-byte session
HMAC secret. Contact URL, clock and static asset root are optional. Use the built
`dist/dashboard` as the static root: backend `dist/web` files and sourcemaps must not be
served. Construct services with the same current Discord membership adapter as Task 6;
no new access decision belongs in the controllers. Nothing logs in, registers Discord
commands, binds a production port or makes AI calls when these factories are imported.

After login, server discovery pages through 50 approved installed candidates at a time.
Each candidate passes a fresh Task 2 access check before its identifier/name is returned.
OAuth guild lists are not proof of access and are not used. A subsequent forged guild ID,
removed delegated role or departed membership fails the protected operation immediately.
A discovery lookup failure can omit a server until retry; it does not authorize it.
Only ordinary guild text channels are offered, and saving new channel IDs uses Task 2's
fresh validation. Access/approval revocation remains enforced by the underlying services.

The settings page edits shared instructions, channel allowlist, server/direct switches,
threshold/gap/mode, independent previous-human/own-bot caps, input ceiling, visible answer
target and total generation ceiling. Zero history still includes the current question;
Task 4's required input policy is unchanged. Each provider uses the existing curated
model/effort catalog and priority. Keys are set/replaced/removed through write-only
routes; no GET key endpoint, plaintext key response or browser key persistence exists.
Delegates can lower existing allowances, but cannot raise them, reorder funding priority,
replace/remove keys or grant access—even when calling the backend directly.

Usage is read from Task 3's ledger, with reported, uncertain and in-flight totals,
remaining allowance, UTC reset, configured priority, last accounted provider, availability
and recent whitelisted error codes/correlation IDs. A last accounted provider can refer
to an uncertain attempt; it is not proof of provider success. Unknown stored error codes
become `provider_error`. Budget estimates and concurrent work can overshoot an allowance;
full reported usage is reconciled and no allowance is raised automatically. No monetary
estimate or guaranteed billing cap is shown.

The creator page lists, approves or revokes server IDs through the existing creator-only
service. It does not grant arbitrary access to server settings. Revocation warns that
it disables the server and removes its saved keys, matching Task 2's policy.

## HTTP and authentication contracts

- Discord confidential authorization code flow, `identify` scope only; exact callback
  `${PUBLIC_ORIGIN}/auth/discord/callback`. Validate Discord's documented issuer
  `https://discord.com`. Token exchange is form encoded, fixed host, no redirects or
  implicit retries. Access tokens exist only during the identity lookup and are discarded;
  no token/refresh token is stored in PostgreSQL, cookies or browser storage.
- A 256-bit state and independent browser nonce are hashed into `oauth_states`, expire
  after ten minutes, and are atomically consumed once. Missing/mismatched browser binding,
  state replay/expiry and unexpected issuer fail closed. A new login replaces the old
  session rather than retaining an attacker-supplied ID.
- Session IDs are random 256-bit opaque values; PostgreSQL stores only SHA-256 hashes and
  user IDs, with a twelve-hour absolute expiry. No role/access snapshot is stored. Keep
  the injected session HMAC key stable and secret across restarts; use a domain-separated
  secret derived from the deployment encryption material or a separately managed key.
- Production uses `__Host-gn_session`/`__Host-gn_state`: Secure, HttpOnly, SameSite=Lax,
  Path=/ and no Domain. Lax permits the top-level Discord callback. Plain HTTP and
  unprefixed development cookies are accepted only for loopback origins.
- Session-bound HMAC CSRF tokens are returned by `/api/session` and held in memory. Every
  mutation requires the token and an exact configured Origin, including logout. GET
  routes never mutate settings. CORS is not enabled. Credentials come from the session,
  never a claimed actor in a browser request. Logout deletes the server session and clears
  this application's tab drafts; known server/role changes need no stale access cache.
- Return destinations are restricted to `/servers` or `/servers/:snowflake`. A Task 6
  `/settings` link renders the login gate and returns to that same server dashboard.
- API responses are no-store; CSP permits only same-origin assets, with no inline script,
  framing, external connections or HTML insertion. Referrer-Policy is no-referrer.
  Fastify logging is off and errors are static safe codes, not raw URLs, OAuth codes,
  provider responses, keys or instructions. Later proxy logs must also redact auth queries.
- Per-process, per-IP limits: 300 API/auth requests/minute, login start 20/10 minutes,
  callback 30/10 minutes, key mutations 10/minute per route. Static assets/pages do not
  consume API limits. `trustProxy` is false: forwarded headers cannot invent a client IP.
  Task 8 must configure only a verified trusted proxy before real reverse-proxy operation;
  otherwise users behind that proxy share the limiter. No distributed rate-limit claim.

Routes: public `/api/site`, login/callback/logout; authenticated `/api/session`,
`/api/servers`, `/api/guilds/:guildId/{settings,channels,status,errors,grants}`;
write-only `PUT/DELETE /api/guilds/:guildId/providers/:provider/key`;
creator `GET /api/creator/approvals`, `PUT /api/creator/approvals/:guildId`.
Settings PATCH takes `{ revision, patch }`. Access mutations also take a revision;
key writes rely on the existing credential service transaction/revision bump.

## Drafts and concurrent changes

Only settings drafts/baselines are kept in tab-scoped sessionStorage, separated by actor
and guild ID. Keys, OAuth material and CSRF/session tokens are never stored there. React
renders staff text as text, never HTML. Logout removes tab drafts; closing the tab clears
sessionStorage. Shared instructions in a draft are visible to someone using that browser
profile, so use Sign out on shared devices. Storage-disabled browsers keep memory drafts
only. A before-unload warning helps avoid accidentally discarding edits.

Controls are locked during save and key/ACL mutations until the response and refresh
finish, preventing later typing from being overwritten. A stale revision returns 409
without modifying newer settings; the page keeps the draft and shows the current version.
Staff explicitly choose “Use latest settings” or “Keep my edits on latest revision,” then
review and Save. Rebase applies only changed fields, including changed provider fields,
so unrelated newer changes survive. Keeping edits to the same field is an explicit
overwrite choice, not automatic conflict resolution. If another staff member removed a
provider, its pending edits remain in the draft; restoring that provider requires a key
manager, or staff can explicitly discard the draft using the latest settings. Save or discard drafts before
changing keys/access; those actions refresh the editor's revision. Usage refreshes after
an allowance save. Session/access failure leaves a clear sign-in or owner-contact path.

## Verification and live checks

Build with pinned Node/npm and `npm ci --ignore-scripts`; `npm run build` emits backend
and dashboard separately. `npm run test:integration` and `npm run test:e2e` require the
explicit local `TEST_DATABASE_URL` from compose.dev.yaml. Playwright runs Chromium at
390×844 with touch/mobile emulation and at 1440×1000 desktop. Its harness composes the real
Fastify, access, settings and PostgreSQL services with fake OAuth/Discord metadata only;
all `/mock/*` routes live in excluded test sources, never the production build.

The browser harness creates a unique database and drops it on shutdown. CI installs the
pinned Playwright browser on native AMD64 and ARM64 and retains screenshots/traces as
artifacts. The six landing/selector/editor captures are in `test-results/screenshots`.
Checks include current/revoked authorization, state/session/cookie/CSRF contracts,
write-only keys, direct delegate requests, mobile validation/Save, both providers, draft
reload/conflict recovery, long-name wrapping, pending-save locks and safe staff text.

Separately authorized live checks remain: exact Discord redirect configuration and real
consent/login/logout, browser cookie handling through the eventual HTTPS proxy, current
Discord owner/role/channel responses, invitation install scopes/permissions, contact link,
Android Chrome keyboard/soft-keyboard behavior on a physical phone, and later dashboard
link integration with the installed bot. Mobile emulation is not a physical-device test.
No production credentials, live registration, paid calls, DNS changes, VPS or deployment
are part of Task 7. Expired session cleanup/retention jobs and integrated startup belong
to Task 8; expired rows already fail authentication and old states are pruned on new login.
## Access verification and retry

The settings editor starts four concurrent reads and then loads grants for managers.
Temporary Discord verification failures use 503 `verification_unavailable`, distinct
from genuine 403 denial. Initial loading and grants listing have read-only retry controls;
grants retries preserve unsaved settings. Membership/roles/approval are still checked
afresh for each protected operation. See [the investigation and live-check limits](settings-access-investigation.md).


## Website usability refresh — 17 November 2026

The landing page keeps the supplied artwork and navy/purple/gold identity, adds a
clearly labelled example conversation, setup steps and native expandable FAQs, and
explains that relevant knowledge and participant names/IDs may reach the provider.
There are no remote fonts or new dependencies. The skip link now has a focusable main
landmark, and main navigation identifies the current area.

Server discovery has a local name/ID search across loaded pages. Pagination remains
explicit; search does not issue extra Discord/API reads. Discovery failures show a
retry action instead of implying that no servers are approved. Previously loaded
servers remain usable after a failed next page; retry uses that page's cursor.
Knowledge entries can be searched locally by title without replacing the editor or
its draft. Saving an entry clears the filter so the saved reference is discoverable.

Settings retain a single form and explicit save/conflict recovery. A sticky, horizontally
scrollable section navigation makes the long page navigable on phones. Timing, history
and response budgets are grouped separately; channel choices have touch-sized rows.
The AI enabled/paused badge describes the saved configuration; changing the switch
requires Save before the badge updates. Usage reset dates include UTC explicitly.
Mobile inputs use at least 16px text and the save bar respects the safe-area inset.
Knowledge actions remain in document flow so they do not obscure pasted text.

Browser regression checks cover discovery failure/retry, local search/pagination,
knowledge draft preservation, keyboard skip/navigation, reduced motion, narrow-screen
layout with enlarged text, and existing mobile save, conflict, provider and access-loss
flows. They use the existing real backend/isolated PostgreSQL harness with mocked Discord.
Viewport emulation is not a physical Android test. This refresh needs no database
migration, Compose change or secret change; publication and VPS rollout are separate.
