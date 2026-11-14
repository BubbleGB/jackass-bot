# Registry release procedure (review required before first use)

PR #9 was verified at `bf78226` and squash-merged as
`2268d0df4b85608f9d8f3aab5dae53c5ce55e143`. Both main workflows passed on that exact
merged source, including native ARM64 production-image smoke:
[project checks](https://github.com/BubbleGB/jackass-bot/actions/runs/43624299310) and
[production images](https://github.com/BubbleGB/jackass-bot/actions/runs/43624299366).
No release procedure existed at that point. Per the owner's instruction, this PR adds
one and stops for review, **without publishing an image or merging itself**.

The proposed registry is `ghcr.io/bubblegb/galaxy-neegy`, linked to this repository.
Publication is separate from deployment. No release job connects to the VPS, changes
DNS, registers Discord commands, receives production bot/provider credentials or runs
the app against production services. Neither merging this PR nor pushing a tag
publishes anything: `release.yml` has only a manual `workflow_dispatch` trigger.

## Release an approved immutable source

After reviewing/merging the workflow PR and authorising its use, wait for both main
workflows to pass on the workflow's own commit. In GitHub Actions choose **Registry
release → Run workflow**, branch **main**, and provide:

- `source_commit`: the full merged source SHA, initially
  `2268d0df4b85608f9d8f3aab5dae53c5ce55e143`.
- `verify_only`: **false** for first publication; **true** to verify an existing release.

Do not substitute the moving name `main`, a short SHA or the earlier PR head. The gate
requires a full lowercase SHA on main's ancestry, completed successful **main push**
Project checks and Production image runs at that exact SHA, and successful AMD64 and
native ARM64 jobs on the expected hosted runner labels. A newer failed/pending run
cannot be bypassed by selecting an older success. The reviewed workflow/control commit
must pass those same checks too. The source checkout is separate, so this procedure
can release the original source even though it predates the release tooling.

Native runners build the exact source with OCI source/revision labels, run the actual
image smoke with mocked external services and save the tested images. They have no
registry-write permissions. Only after **both** succeed does a packages-write job
download the archives, verify archive hashes and loaded image identities, recheck CI,
and push those same images. It never rebuilds after smoke testing. Ordinary image CI
also exercises the archive save/record/load round-trip on both native architectures.

The final tag is `sha-<full-source-SHA>`. Architecture staging tags include the workflow
run/attempt/architecture; the final index is assembled from their verified digests,
not mutable staging-tag lookups. Explicit `docker push --platform linux/<architecture>`
ensures each staging reference is a single-platform image, including with Docker's
containerd image store; the runner needs Docker API 1.46+ for that flag. Workflows are serialized and refuse an existing
commit tag. GHCR itself does not make tags immutable against other authorised writers;
operators must deploy by the **verified manifest digest**, never by `latest` or a tag.
This first procedure publishes an ordinary two-platform index without separate build
attestation descriptors. Source identity is verified in each child image's OCI labels.

## Registry verification and pull access

The read-only verification job fetches the actual registry index and both child configs,
checks response bytes against their digests, requires exactly `linux/amd64` and
`linux/arm64`, checks each config's OS/architecture and exact source/repository labels,
and tests a fresh anonymous registry request. It emits `release-report.json` and the
workflow summary with:

- `image`: `ghcr.io/bubblegb/galaxy-neegy@sha256:<verified-index-digest>`;
- `sourceCommit`: exact full source SHA;
- `platforms`: the observed index platforms, including `linux/arm64`;
- `registryCredentialsRequired`: false only when anonymous access to that digest works,
  true after an explicit anonymous 401/403. Network errors, rate limits and ambiguous
  responses fail verification rather than being called public/private.

Config-blob storage redirects are limited to three HTTPS hops, with registry authorization
removed on cross-origin redirects and config digest verification retained. Signed storage
URLs and credentials are never printed. Token and manifest requests do not follow redirects.

Package visibility is **not assumed** or changed automatically. GHCR normally creates
new packages privately. An owner can later choose public visibility in package settings,
then rerun **verify-only** to establish anonymous access. If verification reports private
access, the VPS needs a pull-capable credential (for example a classic PAT with
`read:packages` and appropriate package access) unless the owner makes the package public.
Provisioning a VPS credential remains a later authorised step; never paste it into chat,
Git, Compose or image arguments. Workflow authentication uses only the job-scoped
`GITHUB_TOKEN`; no PAT or production API credential is required for this procedure.
Repository Actions/package policy can still block publication; report that blocker.

## Failure and recovery

Do not claim publication from a successful build or mocked registry tests. Only the
registry verification report establishes the digest/platform/access result. If native
testing or the gate fails, no publish job runs. A publication failure can leave staging
tags, or a completed final tag followed by a failed verification. Do not overwrite a
commit tag or silently treat that run as successful. Use **verify-only** after resolving
registry access/visibility/transient failures if the final tag already exists. If only
staging tags exist, a new authorised run uses distinct staging tags. Cleanup is a separate
operator decision; this workflow never deletes packages.

Keep the approved source SHA, workflow/control SHA, run URL and verification report.
Record the verified digest in the nonsecret `GALAXY_IMAGE` deployment metadata only
during the later authorised deployment preparation. VPS access, production secrets,
DNS/TLS, backup/restore and deployment remain in [the Task 9 checklist](task-9-checklist.md).
