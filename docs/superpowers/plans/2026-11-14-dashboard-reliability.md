# Dashboard REST reliability implementation plan

**Goal:** Reliable repeated settings loads with bounded Discord requests and fresh permissions.
**Architecture:** Share only pending actor/guild membership lookups; shared read locks retain exclusive mutation/revocation ordering. Return settings and access level from one protected operation. Rate-aware GET scheduling retains single-attempt writes. Optional panel failures cannot prevent the editor from loading.
**Scope:** The owner's current bug specification; no permission-result TTL, migrations, dependency/configuration change, production access, release or deployment.

## Tasks and evidence

- [x] Trace production transport, SDK configuration, initial reads and grants. Deployed path bypasses SDK; five initial lookups/21 calls, six/25 including grants. SDK is configured to reject rate limits and is used only for the gateway.
- [x] Reproduce old 25-call load and repeated Discord-style reset-bucket failures through real HTTP/access/PostgreSQL. Observe failing coalescing and GET wait/retry unit tests before implementation.
- [x] Add bounded cancellable GET scheduling (`src/discord/read-queue.ts`, transport unit tests), max three attempts, queue-inclusive existing deadlines, no mutation retries.
- [x] Share pending membership by actor/guild only and abort siblings (`src/access/discord-membership.ts`). Test different identities, cancellation, timeout recovery and fresh denial after settlement.
- [x] Use shared advisory locks for reads and return settings+level together (`src/settings/service.ts`, `src/web/routes.ts`). Test isolated PG simultaneous requests, repeat loads, revocation and request bounds.
- [x] Install core settings independently; independently retry channels/usage/errors/grants without touching drafts (`web/src/pages/Settings.tsx`, browser regressions). Test optional failure, delay, retry and saving edits on mobile/desktop.
- [ ] Full lint/typecheck/unit/integration/browser/build; one final independent review and fix findings; commit/push/open PR and latest AMD64/native ARM64 CI. Leave unmerged.

## Review focus

No settled permission reuse or cross-identity coalescing. No queue sends after cancellation. No database mutation under shared locks. No optional retry resetting drafts or presenting unavailable usage as zero. No added sensitive diagnostics. Record observed call counts separately from non-overlapping/worst-case retry bounds; simulated rate limits are engineering fixtures, not claims about Discord's bucket sizes.
