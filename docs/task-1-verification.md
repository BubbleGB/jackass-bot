# Task 1 recovery and verification

## Recovery provenance

On 13 November 2026, recovered the supplied `galaxy-phone-recovery.tar.gz` into
`/workspace/jackass-bot` on `feat/task-1-foundation`, based on `83a59a3`.
Archive SHA256: `45b62300dcf5364f6d8710a88df97844b9031510feae6c06a865afab45c25d19`.

Inspected all members before extracting into a separate scratch directory. All were
regular files/directories under `jackass-bot/`; there were no absolute/traversal paths,
links or `.git` entries. Compared every overlapping file: README and the complete
297-line handoff were byte-identical. The existing `.git` directory and handoff were
preserved. The README's original two lines remain at the beginning, followed by setup
instructions. Handoff SHA256 remains
`d55a78fe355e4fbdcac5847237a8bdd8afccfe51643238a231f1669b88344d64`.

The phone's `.superpowers` progress note was recovered as ignored local history only.
It is not evidence of successful tests or a completed task. The original config/schema,
shared types, SQL migration, snapshot/journal, test suites and package lock were retained.
Cloud supersedes the historical Termux development instructions; Oracle is still only
an eventual deployment target. No SSH/VPS access was attempted.

## Work completed in Cloud

- Verified recovered Node/npm pins, all direct npm releases and engine/peer requirements
  against official metadata; installed the pinned runtime and checked its archive hash.
- Installed the recovered lockfile with lifecycle scripts disabled. No dependencies were
  upgraded or replaced. Added strict engine/exact-save npm settings and `.env.example`.
- Reviewed configuration, schema, migration and shared interfaces against Task 1/A6.
  Retained the recovered application code; no Task 2 services were introduced.
- Added disposable PostgreSQL Compose configuration bound to loopback, pinned by image
  digest. Expanded tests for configuration requirements, nonnegative/default allowances,
  coherent assessment snapshots, session envelopes, and preserved usage on key replacement.
- Fixed the integration test URL guard: query options could override its checked host in
  node-postgres. Five regression cases failed before the fix (host/hostaddr/port override,
  URL fragment, wrong protocol), then the complete unit suite passed. The guard now rejects
  query parameters/fragments and unsupported protocols before creating any database pool.
- Added native AMD64/ARM64 GitHub CI, migration drift check, foundation smoke command,
  version evidence and Cloud setup documentation. Start now loads optional local `.env`
  consistently with the explicit migration command.

## Observed checks

Executed in Cloud on Linux AMD64 with Node 26.13.1, npm 11.20.0 and PostgreSQL 18.7.
The verified runtime is installed outside Git at
`/workspace/scratch/galaxy-toolchain/node-v26.13.1-linux-x64/bin`. In this Cloud session,
prepend that directory to `PATH` before npm commands; the environment's default Node
24/npm 11.9 are not the project's pins.

The test server was `galaxy-neegy-dev-postgres-1`, created solely for this task, with a
loopback port and tmpfs data. Integration tests created/dropped their own unique database.

| Check | Observed result |
| --- | --- |
| `npm ci --ignore-scripts` | Clean lockfile installation |
| `npm run lint` | Passed |
| `npm run typecheck` | Passed |
| `npm test` | 47 tests passed |
| `npm run build` | Passed |
| `npm run test:integration` with explicit local test URL | 17 tests passed against PostgreSQL |
| `npm run db:generate` | No schema changes; recovered snapshot matches source |
| Explicit compiled migration runner, repeated | Passed on disposable base test DB |
| Foundation startup | Validates and exits; no live service startup |
| `npm audit` | Zero reported vulnerabilities at check time |
| Compose configuration | Validated; isolated database healthy |
| Actionlint 1.7.12 | Workflow passed after correcting service-port expression context |

The checks above are Cloud observations, not phone progress claims. See the local task
report for the final commit and git status. Git identity was already configured in Cloud;
no identity was invented or changed.

A fresh read-only branch review found no additional Critical, Important or Minor defects.
Its reminders are the unrun remote CI/native ARM64 checks and later-task scope below.
Actionlint first rejected job-level use of the job service context and a numeric port key;
the final workflow uses the context in the integration step and a string port key.

## Boundaries and remaining work

GitHub Actions and native ARM64 checks have **not** run remotely: no push was authorised.
No browser tests exist until Task 7; they were not reported as passing. The deprecation
warnings from Drizzle Kit's legacy esbuild-kit dependencies remain upstream tooling debt.

Task 1 stops at foundation/data-layer verification. Access policy, authenticated key
encryption, settings services and all other Task 2 behaviour are unimplemented. Deployment,
production backups, DNS/HTTPS/OAuth setup and live Discord/provider testing remain pending.
No paid AI call, VPS access, deployment, push or merge was performed.
