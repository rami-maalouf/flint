# MCP activation and handover

Status: **activated on 2026-10-31** at `https://habits.ramimaalouf.com/mcp`. The immutable application source is `22217f3c14c430fcc82457329b126a93ff847d38`; installed recovery tooling is `b88bb754b0d65f9bfaa3ca1d33e48d64031e04c9`. The current-runtime paired restore and final independent review preceded activation. Artifact hashes and quality gates are recorded in [verification](verification.md).

## Activation record

The complete pre-schema backend archive was encrypted and transferred to the private Mac backup destination. The reviewed additive recovery-head schema was deployed with the backend stopped under the shared recovery lock, then the backend restarted successfully. The existing daily timer keeps its schedule and now invokes the reviewed shared-lock native backup entry. Fresh MCP state, keys, config and the external ready latch were created with private ownership and durable writes. No existing account or phone credential was used.

The exact ARM64 artifact is installed under its full source SHA and runs as `habitmcp`, with a 512 MB memory cap, one CPU, 128 tasks and 4,096 file descriptors. MCP listens only on `127.0.0.1:4413`; the bridge listens only on `172.26.0.1:4414`. The service and bridge socket are wanted by `multi-user.target`. A complete cold paired snapshot, including separate encrypted data and keys, was copied off-host and both ciphertext digests verified before the public synthetic write proof.

The first public baseline exposed an earlier staging cleanup that had removed the existing Snapback router. Its three committed entries were restored before enabling MCP. Only the three named MCP entries were then added; every unrelated parsed provider entry was preserved. No shared Traefik restart occurred. Root-only release extraction permissions were corrected so the unprivileged service could execute Node and read its immutable code; file contents and reviewed hashes were unchanged.

Public SDK 2.4.0 acceptance passed with fifteen advertised tools, read/write separation, stable check-in retry, targeted undo, approval with missing/forged CSRF refusal, claim replay, exact ledger receipt/reversal linkage, independent pull-only convergence, write-grant cutoff and a surviving independent read. Earned/spent/balance totals were 5/4/1. All synthetic session cleanup checks passed. Anonymous MCP returned 401 with its resource challenge, both metadata endpoints returned 200, foreign Origin returned 403, and the existing backend probe returned 401.

Rollback removed only MCP routing and stopped only its service and bridge, retaining config, keys, latch and data. A non-author independently observed MCP inactive with no 4413/4414 listeners, the original backend and bridge active, the expected provider hash, public MCP 404 and backend 401. Reactivation used the same artifact and retained custody; all config/key/latch hashes matched. A fresh read of the same synthetic account passed and its temporary grant was revoked.

Sanitized operational logs are in the ignored `.artifacts/fullstack/mcp-activation-20261031.2zfn0U/` directory. The private public-proof evidence SHA256 is `9bbc2895ac11a11af2f333f68b4a52966c84818b9089428815635099fe187940`; the paired production backup ciphertexts have SHA256 `7bdf5e6da903907a6fc836b62ba990023b75f9c99a995d66ca6965bac321a75f` (data) and `b6091c17f022de43d72f3f4a92a4afbc0924107495a5bbe2a3185b0628b91a89` (keys). Credentials, database contents and encryption identities remain private and untracked.

The remaining sections are the repeatable activation and rollback procedure. The user's own sign-in and real ChatGPT/Claude connections remain pending. The synthetic paired restore proves its scoped controller adapter; automated production restoration remains disabled until the exact production SSH/latch branch is separately verified.

## Before activation

1. Confirm the reviewed release archive, main, schema and provenance hashes. Recheck the Oracle architecture, free disk, Traefik gateway, existing backend/bridge identities and ports 4413/4414. Refuse a collision. Preserve a private backup and semantic digest of the shared provider file.
2. Confirm the existing native backup service is inactive before changing its entry point. Install the independently reviewed shared recovery helper tree and pinned Node link, private recovery lock directory and tmpfiles rule, then the updated native shell entry. Verify their ownership, hashes and physical symlink targets. Keep the existing timer schedule. Every subsequent scheduled or manual native backup must use the shared exclusion described in [backups](backups.md#native-backup-timer-coordination).
3. Take and verify the complete existing backend backup before deploying the additive recovery-head schema. Stop only the owned Snapback service for its schema deployment, use the pinned CLI as `habitsystem`, and verify restart and public authentication behavior. Preserve the prior schema and archive privately. Never inspect user session rows or migration exports. The mobile product schema and existing wire operations do not change.
4. Install the immutable MCP artifact under `/opt/habit-system-mcp/releases/<reviewed-sha>`. For a genuinely new production installation only, create private empty state and fresh config, keys and installation ID. Retain the installation ID in the independent Mac controller. Provision its ready latch outside both restore roots with exclusive creation and file/parent fsync. Refuse existing production state or custody rather than replacing it. Restoration never follows this fresh-provisioning path.
5. Verify the exact service and bridge units on Oracle, then start the loopback MCP service without its public route. Check private ownership, health, canonical discovery, resource caps and fixed diagnostics. Take the complete encrypted paired snapshot with separate keys, transfer it to the private Mac destination and verify both digests. A VPS archive alone is not an off-host backup.

## Public activation

Merge only the three named entries in [the routing fragment](../../ops/mcp/traefik-mcp.fragment.yml). Preserve every other provider entry and compare their parsed semantics with the saved baseline. Start the owned MCP bridge on the verified gateway. Do not restart shared Traefik or other services.

Verify public TLS, the anonymous challenge, both metadata routes, Origin refusal and the expected Snapback responses. Confirm the active service unit points to the reviewed release and measure its resource use. Use the explicit synthetic acceptance helper only after these gates:

```sh
bun build services/mcp/tests/helpers/public-release.ts --target=node --packages=external \
  --outfile services/mcp/.artifacts/public-release-proof.mjs
/path/to/node-24.22.2 services/mcp/.artifacts/public-release-proof.mjs self-check
MCP_RELEASE_WRITE_PROOF=synthetic-account-only /path/to/node-24.22.2 \
  services/mcp/.artifacts/public-release-proof.mjs run
```

The helper is restricted to `https://habits.ramimaalouf.com`, creates a new synthetic account and private local fixture, and never takes a real account credential. It checks the fifteen-tool catalog and exercises read-authority refusal, a check-in and stable retry, targeted undo, exact-cost browser approval, claim replay, a second pull-only SQLite replica, and independent connection revocation. Its public flow passed during the activation above. Preserve sanitized evidence and account credentials only in the private rehearsal directory. Do not commit them.

## Rollback rehearsal

Remove only the three owned MCP routing entries and stop only the owned MCP service and bridge. Preserve its config, keys, latch, replicas and journal. Verify the remaining provider semantics, Snapback health/authentication, existing non-MCP routes and backend identity. Do not restore an older operation database, clear a latch, reset an account generation or roll back accepted recovery metadata.

Reactivate the same reviewed artifact and routing entries using the retained state, then verify health and a synthetic read again. A normal restart preserves the current authorization epoch; a supported restore deliberately invalidates old authority and remains write-fenced. If any state migration cannot safely run backward, leave MCP disabled and reconcile with the retained evidence.

## Connection handover

After the activation record confirms success, configure a remote HTTP MCP connection at `https://habits.ramimaalouf.com/mcp`. Sign in privately with the existing app account. Start with `habits:read` and `coins:read`; notes and writes require their separate scopes. A write connection requires fresh credentials, and each reward claim requires its own browser approval. Manage connections at `https://habits.ramimaalouf.com/mcp/connections`.

The official SDK profiles and browser evidence are listed in [compatibility](compatibility.md). Real ChatGPT, Claude and the user's private account connection remain unverified until actually exercised. Refresh does not extend an expired upstream session; reconnect when required. Whole-VPS rollback outside the independent controller and guaranteed upstream logout during an outage remain outside the demonstrated guarantees.

The release record must include the final source/operational commits, active artifact, backup digests, synthetic public result, rollback result, independent review and linked PR. Open the PR without merging it. The activation record above supports activation and rollback; it makes no claim that the user's private client is connected.
