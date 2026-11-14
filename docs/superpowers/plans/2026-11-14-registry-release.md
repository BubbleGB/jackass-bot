# Registry release workflow implementation plan

Goal: prepare the missing release procedure as an unmerged PR per the user's explicit
fallback. PR9 headbf78226 verified8green/no reviews or threads; merged2268d0df4b85608f9d8f3aab5dae53c5ce55e143.
No existing workflow publishes or deploys; main merge triggers only isolated checks.

Architecture: manual-only GitHub Actions publication to proposed GHCR package
`ghcr.io/bubblegb/galaxy-neegy`. Require a full immutable source SHA on main, successful
Project checks + Production image runs at that exact SHA (both native architectures).
Build/smoke each architecture natively without registry credentials; archive the tested
images. Only after both succeed, a packages-write job loads those exact archives and
publishes architecture digests and a commit-tagged manifest. A read-only registry step
verifies manifest digest, linux/amd64 + linux/arm64, child config/source labels and
anonymous pull availability. Verify-only mode can recover a failed post-publication
verification without overwriting a commit tag. No push/tag/merge auto-release triggers.

Constraints: user authorised workflow PR only when procedure absent. No publication now,
no VPS/DNS/production secrets/deployment. Use GITHUB_TOKEN only in eventual release;
never store registry credentials in images/artifacts, no new production API keys.
Package visibility is not assumed: anonymous success means no VPS credentials; explicit
401/403 means credentials required; outages/missing metadata fail verification.

Review focus: tag/branch/source injection; CI from another SHA or failed latest rerun;
wrong/missing/duplicate ARM64 descriptor; image rebuilt after smoke; forged source/config
metadata; mutable commit tags; registry auth/network errors disguised as public/private;
manual dispatch from a feature branch; workflow change accidentally releases on merge.

- [x] Test gate rejection of non-SHA/not-main/pending/failed/missing native checks; GREEN.
- [x] Test registry raw digest/platform/source/anonymous access verification with HTTP mocks;
      test wrong platforms/config/credentials/outage and image proof/archive tampering.
- [x] Add pinned manual workflow with least per-job permissions, native builds/smokes,
      tested archive transfer, immutable tag policy, digest manifest/verification report.
- [x] Document exact source2268d0d, chosen GHCR name, access/visibility, manual release/
      verify-only commands, no deployment, remaining owner review gate.
- [x] Verify lint/types/unit/release tests/build/Compose + workflow syntax/actionlint,
      fresh independent review; fix important findings with regressions.
- [ ] Commit/push/open PR, observe latestCI including native image smoke; stop unmerged
      and unpublished. Separately confirm merged2268d0d's main native checks.
