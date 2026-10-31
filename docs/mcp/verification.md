# MCP release verification

Production activation is pending M24, M25 and M26. This record distinguishes tested source from operational rehearsals and client access. It is not an activation approval.

## Current reviewed source

Commit `36eb8479df6611633dfed7f886f6acbcc2438031` includes the fifteen-tool service, the independently reviewed authorization-epoch and operation-history corrections, and current Flint main. Product SQLite remains schema 12; Snapback remains 0.4.49 with its native SDK patch.

| Gate | Actual result |
| --- | --- |
| Root frozen install | `bun install --frozen-lockfile --ignore-scripts`, exit 0 |
| Root validation | `bun run validate`, 214 suites and 3,116 tests passed; every one of 105 `src/core` files has full statement, branch and function coverage |
| Native gates | `bun run test:native`, 16 plugin checks, 140 intent and 55 CloudKit Swift checks passed |
| Backend gates | `bun run test:backend`, schema check, 18 Node checks and two convergence/read-authority checks passed |
| Mac service coverage | Real Node 24.22.2, public CIMD enabled, age 1.3.2: 316 passed, zero failures/skips, coverage report emitted, exit 0 |
| Isolated dependencies | `bun audit`, zero vulnerabilities in 135 packages |
| Production bundle | `bun run build`, all three entry points built; clean ARM64 source-archive build also passed isolated install, API generation, lint and types |
| Current Linux service coverage | Actual ARM64 Node 24.22.2, public CIMD and age 1.3.2: 316 passed, zero failures/skips, valid coverage report, exit 0; 473.72 seconds |

The Mac logs are `/tmp/habit-mcp-merged-{validate,native,backend}.log` and `/tmp/habit-mcp-current-mac-coverage.log`. They contain synthetic test output, not production account evidence. The Linux audit parses all 148 raw JSON files, finds all 30 committed test entries and the authorization proof, and retains six direct MCP executable reports. Only the exact Snapback proof-command wrapper and its guard are excluded. All 220 audited committed input files remain byte-identical after testing. Whole-tree lint/type checks must also cover the completed rehearsal helpers before publication.

## ARM64 artifact

The clean source archive and pinned build produce this release:

| Artifact | SHA256 |
| --- | --- |
| Source archive | `7e2783b8ff8c08ebf4b62122ee7bcd6866fca19cf0695c443daa325a3887e9da` |
| Release archive | `594386f4c3efb82a470c59dd6234452b49bead288279cda43cc9423d548b09e6` |
| Bundled `main.js` | `403daf929a4b59c7181f42f7c061af058bb5858718e4cc7c5209c4f4f9c8db5b` |
| Backend schema | `2cbcde553c47af60584b842314a17ef89b02e7f0ec7460a16019393aad36e683` |
| Provenance | `6a6adef23b05eabaf98797e790bae8db96b94b0801b76732c28736de0e81af98` |

Oracle build evidence is under `/home/ubuntu/habit-mcp-reviewed-36eb8479.ZNoHEhYP/evidence/`. The Mac copy is under `.artifacts/fullstack/mcp-reviewed-36eb8479.OjnwmxQG/`. Both archives match. No service was installed or activated by this build.

## Remaining release gates

- Complete final helper lint/types.
- Rehearse the updated paired backup and isolated restore with the new authorization epoch. Earlier paired evidence used the pre-epoch release.
- Exercise the exact production SSH/Oracle latch branch in the reviewed isolated clone. The fixture controller adapter does not establish that branch.
- Obtain final independent verification, then perform the separate production backup, activation, synthetic public flow and rollback checks.
- Open and link the implementation PR without merging it.

Public proxy and private Linux process evidence retain their separate scopes in [proxy staging](proxy-staging.md) and [Linux staging](linux-staging.md). Restoration never automatically enables writes. A privileged rollback that includes the external trust marker remains outside the demonstrated guarantee.

Real ChatGPT and Claude connections, and the user's private account sign-in, remain unverified. See [client compatibility](compatibility.md) for the exact SDK and browser profiles actually exercised.
