# MCP release verification

The reviewed release is active at `https://habits.ramimaalouf.com/mcp`. [The activation record](release.md#activation-record) records the actual backup, public synthetic acceptance and independently observed rollback. This record distinguishes tested source, operational evidence and private client access.

## Current reviewed source

The staged application release is commit `22217f3c14c430fcc82457329b126a93ff847d38`. It includes the fifteen-tool service, the independently reviewed authorization-epoch and operation-history corrections, native backup coordination, and the final Flint browser presentation. Product SQLite remains schema 12; Snapback remains 0.4.49 with its native SDK patch. Later operational fixes and evidence records are tracked separately from this immutable application artifact.

| Gate | Actual result |
| --- | --- |
| Root frozen install | `bun install --frozen-lockfile --ignore-scripts`, exit 0 |
| Root validation | `bun run validate`, 214 suites and 3,116 tests passed; every one of 105 `src/core` files has full statement, branch and function coverage |
| Native gates | `bun run test:native`, 16 plugin checks, 140 intent and 55 CloudKit Swift checks passed |
| Backend gates | `bun run test:backend`, schema check, 18 Node checks and two convergence/read-authority checks passed |
| Mac service coverage | Real Node 24.22.2, public CIMD enabled, age 1.3.2: 319 passed, zero failures/skips, coverage report emitted, exit 0 |
| Isolated dependencies | `bun audit`, zero vulnerabilities in 135 packages |
| Production bundle | `bun run build`, all three entry points built; clean ARM64 source-archive build also passed isolated install, API generation, lint and types |
| Current Linux service coverage | Actual ARM64 Node 24.22.2, public CIMD and age 1.3.2: 319 passed, zero failures/skips, valid coverage report, exit 0 |

The root logs are `/tmp/habit-mcp-merged-{validate,native,backend}.log`; their validated root application files have not changed since the main merge. The final Mac service log is `/tmp/habit-mcp-final-flint-mac-coverage.log`. These contain synthetic test output, not production account evidence. The final Linux audit parses all 163 raw JSON files, finds all 30 committed test entries and the authorization proof, and retains six direct MCP executable reports. Only the exact Snapback proof-command wrapper and its guard are excluded. All 1,105 committed source files remain byte-identical after testing. Whole-tree lint/type checks must also cover completed rehearsal helpers before publication.

## ARM64 artifact

The clean source archive and pinned build produce this release:

| Artifact | SHA256 |
| --- | --- |
| Source archive | `fb0d593bc6588dee5db0c65c1e87332ffb79dbeb38d0d0c5ef6c8cc1a3dd038f` |
| Release archive | `0ea44cbd24219f68413845dd31ebc1d8a50fee4b2eec1b18103f5f61105cdd91` |
| Bundled `main.js` | `cca51dd8abbabb736b16bc7138315b1855c19bf2d04bcc1ff31f45031a8446ac` |
| Backend schema | `2cbcde553c47af60584b842314a17ef89b02e7f0ec7460a16019393aad36e683` |
| Provenance | `7ed3198639cad5563339725b7139a0c139f43f1fb3fe9025efadb66e81186418` |

Oracle build evidence is under `/home/ubuntu/habit-mcp-final-flint-22217f3c14c430fcc82457329b126a93ff847d38.Fx0F/evidence/`. The byte-identical Mac copy is under `.artifacts/fullstack/final-flint-22217f3c14c430fcc82457329b126a93ff847d38/`. Its release manifest records every artifact and gate hash. The raw coverage archive is `125c9e4a5ea1bdfe8b98e00b01d01a722a0ed31cc6bd43939648d5c94da9d4d1` and was independently parsed on Mac. No service was installed or activated by this build. The earlier `36eb847` artifact and 316-test result are historical evidence and are superseded for activation.

## Completed release gates and remaining limits

- The accepted final paired helper passed its actual Flint `22217f3` Oracle/Mac rehearsal, including complete pending-queue hashes, old-authority refusal, fresh reads, retained receipts and fail-closed mixed graphs. [The paired record](paired-restore.md) separates this result from historical runs. A non-author verified its evidence hashes and lineage.
- The final multi-axis review found no unresolved P0/P1 issue. The stale artifact reference was corrected. Two nonblocking restored-session UX follow-ups remain: an old browser cookie receives 401 without a direct reauthentication link, and an old-epoch connection cannot be disconnected through the current owner control. Old authority remains denied; fresh standalone sign-in is the workaround. Neither applies to adoption of old authority during startup.
- Production installation, complete encrypted off-host backup, the synthetic public workflow and rollback/reactivation passed as recorded in [release](release.md).
- The implementation PR is opened and linked as part of handover, without merging it.

Public proxy and private Linux process evidence retain their separate scopes in [proxy staging](proxy-staging.md) and [Linux staging](linux-staging.md). Restoration never automatically enables writes. A privileged rollback that includes the external trust marker remains outside the demonstrated guarantee.

The extra isolated-clone exercise of the hardcoded production SSH restore branch was deferred after the user asked to end the prolonged rehearsal-tooling work. No clone was launched. The real paired rehearsal uses a scoped synthetic controller adapter; it cannot establish that production branch. Automated production restoration remains disabled pending its separate operational verification. No production database replacement is authorized by the application activation record.

Real ChatGPT and Claude connections, and the user's private account sign-in, remain unverified. See [client compatibility](compatibility.md) for the exact SDK and browser profiles actually exercised.
