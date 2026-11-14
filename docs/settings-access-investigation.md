# Intermittent settings access warning: reproduced cause and verification

Investigated against deployed application `2268d0d`. Main `0277fa1` contains the same
`src/` and `web/` code; its changes only add release tooling. No VPS, production session,
production token, Discord network request or paid provider request was used here.

## Actual load and pre-fix reproduction

`Settings.load()` starts four HTTP GETs concurrently: settings, channels, status and
errors. It awaits `Promise.all` before installing editor state. A failed initial read
therefore leaves only the error/recovery screen. Once those reads succeed for a manager,
the mounted `Access` component issues a fifth GET for grants. Before this fix, that
failure set the parent's error string, leaving a full editor with a global access warning.

Settings performs two fresh access checks, and the other initial routes one each.
Each membership lookup reads guild, actor membership, bot membership and current roles
using the bot REST transport. Channels also reads channel metadata. Controlled HTTP
traces measured **five lookups / 21 Discord reads** before grants, then **six / 25**.
The three protected database reads serialize on the guild lock; this does not make the
four browser HTTP requests sequential or remove overlapping membership lookups.

Before production-code changes, tests through the actual DiscordRest, DiscordMembership,
AccessPolicy, SettingsService, Fastify, PostgreSQL and browser components reproduced:

- Concurrent roles lookups subject to a mocked route limit returned Discord 429. The
  same individual endpoints succeeded sequentially with the same signed-in cookies,
  while the concurrent page load returned a forbidden 403 and no editor.
- A Discord 429 on lookup six let all four initial reads succeed (settings level
  `creator`), then returned 403 for grants and displayed the full editor with a red
  access warning. Both screen states reproduced at 390px and desktop widths.
- A five-second lookup timeout and HTTP 502 likewise became a grants 403.

The confirmed code cause was loss of failure information: DiscordMembership caught
every error and returned null; AccessPolicy caught errors and returned `none`, and
`require()` converted that to forbidden. The UI then described a role/access problem
and recommended signing in again. The mocked bucket is an engineering fixture, not a
claim about Discord's actual bucket size or the exact live incident's upstream status.

## Resulting behaviour

| Condition | HTTP result | User recovery |
| --- | --- | --- |
| Discord timeout, 429, service/transport failure or malformed response | 503 `verification_unavailable` | Explain temporary access verification failure; read-only retry |
| Explicit Discord 403/404, missing membership/bot, identity mismatch, removed role/grant or unapproved guild | 403 `forbidden` | Explain current access denial; recheck current permissions |
| Missing/expired dashboard session | 401 `sign_in_required` | Sign in again |
| Missing/invalid CSRF or origin on a mutation | 403 `csrf_failed` | Reload/retry the security check, keep the draft |
| Dashboard request rate limit | 429 `rate_limited` | Wait, then retry |
| Database/channel metadata unavailable | 503 `storage_failed` | Retry server-data loading |

Temporary results still authorize nothing. No positive membership cache, creator
membership bypass, relaxed guild checks or automatic mutation retry is introduced.
Approval and grants are checked through the same repository/transaction locks and
current actor/bot memberships and roles remain required on every protected operation.
The original five-second membership and 15-second browser request limits remain.

Initial failures offer Retry loading settings without an unnecessary sign-in prompt;
the tab draft can restore after a successful retry. Grants failures have a local panel
and read-only Retry loading grants. Unverified grant controls are disabled. Retrying
that list preserves unsaved settings, and older list responses cannot overwrite a newer
load after a revision change. Staff Discord commands also distinguish temporary access
verification from provider/allowance exhaustion, retaining private acknowledgements.

## Safe live diagnosis and remaining checks

Failed protected API routes now emit only four fields: a **registered route template**,
HTTP status, elapsed milliseconds and a fixed error category. Examples include
`verification_rate_limited`, `verification_timeout`, `verification_unavailable`,
`verification_invalid_response`, `forbidden` and `csrf_failed`.

```json
{"route":"/api/guilds/:guildId/grants","status":503,"timingMs":5004,"category":"verification_timeout"}
```

No literal guild/user IDs, query strings, full URLs, cookies, instructions, keys,
conversation text, request/response bodies or raw exceptions are logged. Diagnostic
sink failures do not affect access decisions. Runtime/container log retention remains
an operator responsibility; this adds no database table or conversation persistence.

After owner review, release and separately authorised rollout, repeat signed-in page
loads and grants retries on the live phone/browser. Confirm which route/category occurs
under real Discord timing, that the retry succeeds without reauthentication, that drafts
survive and that actual member/role/approval revocation still denies the next operation.
The individual historical live responses do not identify which upstream request failed
during the intermittent load. This PR confirms and fixes the reproducible error path;
the exact live upstream trigger remains to be confirmed using only the safe metadata.
External failures can still make loading unavailable; this fix keeps that distinct from
a verified access denial and provides recovery without weakening authorization.
