# MCP activation and handover

Status: **not activated**. M24's current-runtime restore rehearsals and M25's final independent verification remain prerequisites. The executable artifact and completed quality checks are recorded in [verification](verification.md). This file describes the owned activation sequence; it does not claim those operations have run.

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

The helper is restricted to `https://habits.ramimaalouf.com`, creates a new synthetic account and private local fixture, and never takes a real account credential. It checks all fifteen tools, read-authority refusal, a check-in and stable retry, targeted undo, exact-cost browser approval, claim replay, a second pull-only SQLite replica, and independent connection revocation. Its local guards have been checked; its public flow is pending activation. Preserve sanitized evidence and account credentials only in the private rehearsal directory. Do not commit them.

## Rollback rehearsal

Remove only the three owned MCP routing entries and stop only the owned MCP service and bridge. Preserve its config, keys, latch, replicas and journal. Verify the remaining provider semantics, Snapback health/authentication, existing non-MCP routes and backend identity. Do not restore an older operation database, clear a latch, reset an account generation or roll back accepted recovery metadata.

Reactivate the same reviewed artifact and routing entries using the retained state, then verify health and a synthetic read again. A normal restart preserves the current authorization epoch; a supported restore deliberately invalidates old authority and remains write-fenced. If any state migration cannot safely run backward, leave MCP disabled and reconcile with the retained evidence.

## Connection handover

After the activation record confirms success, configure a remote HTTP MCP connection at `https://habits.ramimaalouf.com/mcp`. Sign in privately with the existing app account. Start with `habits:read` and `coins:read`; notes and writes require their separate scopes. A write connection requires fresh credentials, and each reward claim requires its own browser approval. Manage connections at `https://habits.ramimaalouf.com/mcp/connections`.

The official SDK profiles and browser evidence are listed in [compatibility](compatibility.md). Real ChatGPT, Claude and the user's private account connection remain unverified until actually exercised. Refresh does not extend an expired upstream session; reconnect when required. Whole-VPS rollback outside the independent controller and guaranteed upstream logout during an outage remain outside the demonstrated guarantees.

The release record must include the final source/operational commits, active artifact, backup digests, synthetic public result, rollback result, independent review and linked PR. Open the PR without merging it. No activation, rollback or private client connection is claimed by this runbook alone.
