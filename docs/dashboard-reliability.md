# Dashboard reliability after application 2d7649f

The previous fix distinguished temporary verification failure from denial, but did not
reduce requests or handle Discord rate limits. This investigation uses the deployed
`2d7649feb3ee457e8a937b5861e65061fe882d79` source, real transport/access/Fastify/browser
code and isolated PostgreSQL. External HTTP is mocked; no production access or paid
API call is used. The precise live bucket/status still requires the safe production
diagnostics, not an inference from the two user-facing error strings.

## Transport, sequence and measured counts

The gateway uses discord.js 14.28.1, configured with retries zero and
`rejectOnRateLimit: () => true`. Dashboard bot GETs instead use Galaxy's custom
`DiscordRest`, **not** `client.rest` or the SDK's bucket queue. The SDK's general
queue can cancel waiting entries via a signal; its bucket-delay loop also contains
ordinary sleeps. Neither was running for these dashboard reads. Changing SDK options
alone would therefore not fix them.

Originally the four concurrent settings/channels/status/errors HTTP reads made five
membership lookups: settings checked once inside its service and again for the displayed
level. Each lookup fetched guild, current actor, current bot and current roles. Channel
discovery added one GET. Grants then added another lookup. Three service reads held an
exclusive advisory transaction lock during verification, serializing otherwise
concurrent operations and frustrating in-flight sharing.

| Signed-in server-editor load | Before | After, overlapping reads |
| --- | ---: | ---: |
| Four initial API reads | 5 lookups / 21 Discord GETs | 1 lookup / 5 Discord GETs |
| Later grants read | 1 lookup / 4 GETs | 1 fresh lookup / 4 GETs |
| Complete load | **25 GETs** | **9 GETs** |

These are measured successful HTTP attempts, without a 429 retry. A read that begins
after the previous lookup settles always performs a new verification: there is no TTL
cache. With no overlap at all, the new upper bound is five lookups plus channel
discovery: **21 GETs**, versus 25 before. Each GET has at most three attempts, so the
complete-load bound including retries is 63 HTTP attempts (27 for the two-lookup
overlapping case), usually cut shorter by the deadlines. No automatic whole-page retry
loop is introduced.

`/api/site` and `/api/session` make no Discord requests. Visiting the server selector
separately adds five bot GETs per accessible guild (four for access, one for its display
name); it is not loaded again during an editor refresh. A new OAuth callback adds two
separate OAuth-authenticated HTTP calls, not membership checks. Thus a one-server
selector followed by the editor is 30 bot GETs before, normally 14 after; a direct
signed-in editor refresh has the 25/9 counts above.

## Reproductions and resulting behaviour

Before changes, a mocked Discord-style roles bucket with remaining/reset headers and
429 retry_after responses made repeated complete loads return 503s despite healthy
membership. The old custom transport ignored reset headers and made a single attempt.
The new request-bound test observed the old 25 GETs. Browser regressions also proved
that any optional usage/errors/channels failure hid the whole editor through Promise.all.

The fix shares **only identical pending actor/guild membership lookups**, removes them
on success/denial/error/timeout, and aborts sibling requests when a lookup ends. Read
transactions use a shared advisory lock; settings/key/grant/approval mutations retain
the same exclusive lock and fresh authorization. Settings and displayed access level
now come from one protected operation. No controller can supply a claimed access level
and no settled positive or negative permission result is reused.

The custom transport now serializes GETs by normalized route and major resource,
honours zero remaining/reset-after headers and route/global 429 retry_after, and allows
at most two retries. A 25ms reset margin is an engineering scheduling allowance, not a
Discord guarantee. Queue admission is limited to 128 waiting reads per route. Writes
remain single-attempt, preserving delivery's existing explicit retry/uncertain-send policy.
Different routes can run concurrently; unexpected limits sharing a bucket across routes
are still handled by their actual 429 and the same bounded retries. This is a small
GET scheduler, not the full SDK rate-limit implementation.

The existing **five-second membership deadline includes queue time**, as does the
directory's five-second channel-metadata signal. REST retains its ten-second outer
bound and the browser its fifteen-second bound. Original reads had no SDK queue to
leave behind: abort reached fetch, but sibling reads could continue until their own
deadlines. New waiting reads are removed on abort and an active bucket wait is
cancelled; tests verify no HTTP request fires later after a timed-out lookup. Harmless
rate-limit reset metadata may remain until expiry; it is never an authorization result.
Future operations verify afresh and recover when the upstream bucket permits them.

The editor now installs as soon as its required settings read succeeds. Channels,
usage, errors and grants load independently, with panel-specific retry buttons. A
failed optional refresh never replaces the settings draft or hides the editor. Missing
usage/errors are not presented as zero usage or no errors. Missing channel metadata
does not remove saved channel IDs. Saving, credential changes and grant changes still
recheck current access in the backend. Confirmed departure/role/approval/bot loss and
forged guild IDs remain denied; no stale allow-cache delays revocation.

Regression tests exercise four repeated complete loads with reset headers and latency,
bounded call counts, concurrent actor/guild isolation, queued cancellation/recovery,
global 429 waits, exhausted retries, immediate revocation, optional failure/retry and
preserved editable/savable drafts on 390px and desktop. The mock's short bucket window
is a deterministic engineering fixture, not a statement of Discord's actual limits.

## Remaining live verification

No new sensitive diagnostics are added. Failed protected routes still emit only route
template, HTTP status, timingMs and fixed category; no IDs, bodies, keys, headers or
raw exceptions. After review and a separately authorised release/rollout, repeat phone
refreshes and optional retries and inspect only those fields for remaining failures.
Slow/outage/reset delays exceeding five seconds still fail closed and require retry;
external service availability cannot be guaranteed. The exact live failure category,
physical phone behaviour and observed real bucket timing remain to be checked.

No migration, dependency, Compose or secret change is required by this fix. Provider
accounting and delivery decisions remain in their existing services.
