# Privacy and data lifecycle

The public `/privacy` page describes this policy before sign-in. Recent messages from
the current selected channel, the current question, server instructions and bounded
history can be sent to the server's configured OpenAI or Google provider. Providers
apply their own retention policies; this application cannot promise zero provider
retention. The bot cannot use AI output to operate tools, change settings or grant access.

Conversation text and generated answers are fetched/held briefly in memory, not stored
in PostgreSQL or application logs. Discord retains messages under its own policies.
The application stores server settings and staff-written personality instructions,
encrypted provider credentials, access grants, approval records, usage totals, minimal
request identifiers, sanitised error codes and settings audit metadata. Provider keys
are write-only in the dashboard; encryption uses the separate deployment key. Database
or secret-store administrators with that key can decrypt them. The creator's management
access requires current membership in the server; creator approval is a separate gate.

Daily maintenance removes sanitised operational errors older than 7 days, audit events
older than 90 days, and completed/failed request receipts and known/not-sent reservation
details older than 7 days after aggregation. Ordinary daily usage is retained for 90
days. Unresolved reservations, uncertain charges, their daily buckets and uncertain
request receipts are retained until reconciled, even beyond those periods. This avoids
resetting usage or replaying a request whose outcome is unknown. Cleanup is performed
at startup and every 24 hours while the worker is healthy, so expiry is not immediate.

Web sessions expire after 12 hours; one-use OAuth state expires after 10 minutes. Expired
rows are removed by maintenance. Unsaved dashboard drafts live in the browser tab's
session storage and clear when that tab's session ends or the user discards them.

A complete successful Discord membership listing that confirms the bot has left a
server deletes its settings, credentials, grants, channels and related live scheduling
state. Temporary errors, incomplete listings and unavailable-guild events do not prove
removal and do not delete records. Approval remains separate. Minimal accounting and
request metadata follow the retention policy above after removal; reinstalling cannot
erase current usage. Revoking approval disables the bot and deletes its credentials;
reapproval does not automatically enable it.

Runtime lifecycle logs contain a fixed event name, timestamp and sometimes a fixed delivery state.
Failed protected dashboard operations additionally log only the registered route template,
HTTP status, elapsed milliseconds and a fixed error category. Templates contain no actual
guild/user IDs; query strings and request bodies are excluded.
No channel text, responses, keys, URLs, identifiers or raw exceptions are logged by the
runtime. Operators must limit retention of container/proxy logs separately. No backup
service is configured yet. Task 9 must implement encrypted off-host backups, a maximum
7-day backup retention and a tested restore before enabling AI. Deletion from live
storage does not erase an already-created backup before its expiry.

Daily token allowances are practical usage safeguards, not guaranteed hard billing caps.
Input estimation errors and concurrent in-flight calls can cause overshoot; reported
actual usage is fully recorded and blocks subsequent calls once exhausted. Allowances
are never raised automatically.
