# Linux ARM64 synthetic acceptance

`services/mcp/tests/helpers/linux-staging.ts` is an explicit Linux-only helper, not an auto-loaded test. It exercises an actual `dist/main.js` Node process under a transient 512 MB, one CPU systemd unit. Its backend is the pinned native Snapback 0.4.49 CLI with a newly deployed synthetic store. Public MCP and backend routes use private loopback HTTPS listeners and a one-day test CA with `127.0.0.1` in the certificate SAN. The main child receives that CA through `NODE_EXTRA_CA_CERTS`; the SDK runner installs only that CA into its own default trust set. No service fetch mock, public host, shared Traefik route, production Snapback store, phone credential, or real account is involved.

The helper refuses a non-Linux ARM64 host, a Node version other than 24.22.2, a Snapback binary whose SHA256 differs from `80bb7af237548866228c7dff6889c7b779b777d1342c76e4b10effa1de88ebcf`, mismatched reviewed release inputs, an occupied port from 4450 through 4455, an active owned transient unit, and an existing fixture path. It does not edit the production service units. The private port map is MCP 4450, public TLS 4451, backend TLS 4452, and native Snapback within 4453-4455. Ports 4410, 4411, 4413, and 4414 are outside its range.

## Run and preserve a cold fixture

Build the helper with Bun from this checkout, then copy it to a private extracted release directory on Oracle. The runner bundle needs the release's `services/mcp/node_modules` beside its `dist` directory. Set `MCP_STAGING_MAIN` to the extracted release `services/mcp/dist/main.js`, `MCP_STAGING_SCHEMA` to the matching saved `snapback/schema.q`, and `MCP_STAGING_RELEASE_ARCHIVE` to the reviewed tarball. Supply the five explicit expected identities shown below. The helper compares those values with observed main, schema, and archive SHA256 digests, the extracted `PROVENANCE`, and the `PROVENANCE` member inside the tarball before creating a fixture. `MCP_STAGING_ARTIFACT_LABEL` is only a human-readable label. The root must be a fresh absolute directory within `/home/ubuntu/habit-mcp-staging-acceptance-20261030/`.

```sh
bun build services/mcp/tests/helpers/linux-staging.ts --target=node --packages=external --outfile=services/mcp/.artifacts/linux-staging.mjs
scp services/mcp/.artifacts/linux-staging.mjs oracle:/home/ubuntu/habit-mcp-staging-acceptance-20261030/release/services/mcp/dist/linux-staging.mjs
ssh oracle '
  MCP_STAGING_ROOT=/home/ubuntu/habit-mcp-staging-acceptance-20261030/reviewed-b3f05d2-<fresh-run-id> \
  MCP_STAGING_MAIN=/home/ubuntu/habit-mcp-staging-acceptance-20261030/reviewed-release-b3f05d2/services/mcp/dist/main.js \
  MCP_STAGING_SCHEMA=/home/ubuntu/habit-mcp-staging-acceptance-20261030/schema.q \
  MCP_STAGING_RELEASE_ARCHIVE=/home/ubuntu/habit-mcp-release-20261030-b3f05d2/release.tar.gz \
  MCP_STAGING_EXPECTED_MAIN_SHA256=edddaac92d0b179566b10780b9d4c2bb01cfe81b0ffee0e3681e54a9a05e5e0a \
  MCP_STAGING_EXPECTED_SCHEMA_SHA256=2cbcde553c47af60584b842314a17ef89b02e7f0ec7460a16019393aad36e683 \
  MCP_STAGING_EXPECTED_RELEASE_SHA256=2d7d39ee79f340613f8cca3611cf1db52aeef7ef694e09f694c52dd3ca1632fc \
  MCP_STAGING_EXPECTED_SOURCE_SHA256=b762e398c210b1f8c42a843051f76603cb8a559a7903d4b07abcda697e87df55 \
  MCP_STAGING_EXPECTED_RELEASE_COMMIT=b3f05d24f9f58f11e1f5efaa0e17a9d7969c3728 \
  MCP_STAGING_ARTIFACT_LABEL=reviewed-b3f05d2-<fresh-run-id> MCP_STAGING_KEEP_FIXTURE=1 \
  /home/ubuntu/habit-mcp-proof-20261030/node-v24.22.2-linux-arm64/bin/node \
  /home/ubuntu/habit-mcp-staging-acceptance-20261030/release/services/mcp/dist/linux-staging.mjs'
```

Replace `<fresh-run-id>` with a unique suffix. The helper writes `evidence.json` in `MCP_STAGING_ROOT`. A zero exit requires all assertions and cleanup to pass, including the pending journal at SIGTERM, an acknowledged SDK response, successful unit exit, acknowledged journal after shutdown, and matching operation and check-in IDs on retry. With `MCP_STAGING_KEEP_FIXTURE=1`, the stopped synthetic graph remains in `fixture/state/`, `fixture/backend/`, and `fixture/keys/{config.json,keys.json}`. The restore latch is in sibling `external-restore-latch/restore-latch`, outside `fixture/`; this layout permits a paired cold-copy rehearsal without treating the latch as backed-up state. The helper closes the MCP process, native Snapback host, TLS listeners, SDK clients, SQLite lock holder, and low-disk tmpfs mount before it returns. It always removes the temporary CA key, TLS files, logs, and seed database. Keep the root private; the key file and synthetic credentials are not chat or PR artifacts. Without the keep flag, the helper also deletes its fixture and latch paths inside its chosen root.

## Reviewed release result, 2026-10-30

The passing evidence is `/home/ubuntu/habit-mcp-staging-acceptance-20261030/reviewed-b3f05d2/evidence.json` on Oracle. The actual service executable was `main.js` from reviewed commit `b3f05d24f9f58f11e1f5efaa0e17a9d7969c3728`, with main SHA256 `edddaac92d0b179566b10780b9d4c2bb01cfe81b0ffee0e3681e54a9a05e5e0a`. The ARM64 release archive SHA256 was `2d7d39ee79f340613f8cca3611cf1db52aeef7ef694e09f694c52dd3ca1632fc`; `PROVENANCE` recorded source SHA256 `b762e398c210b1f8c42a843051f76603cb8a559a7903d4b07abcda697e87df55`, the pinned Node archive, and the pinned Snapback binary. These were checked before extraction and run. The matching schema was extracted from that reviewed source archive, SHA256 `2cbcde553c47af60584b842314a17ef89b02e7f0ec7460a16019393aad36e683`. The root contains a stopped synthetic fixture for the M24 paired backup rehearsal. The unit is inactive, no listeners remain on 4450-4455, and the temporary low-disk mount is gone.

| Check | Observation |
| --- | --- |
| Unit limits, checked before load | `MemoryMax=536870912`, `CPUQuotaPerSecUSec=1s`, `TasksMax=128` |
| Actual process and cgroup use | 190 `/proc` samples; peak RSS 147,181,568 bytes; peak 53 file descriptors; 212 CPU ticks; cgroup CPU usage at held write 2,872,949,000 ns; cgroup memory current 85,176,320 bytes and peak 89,968,640 bytes at that point. RSS includes shared mappings that the cgroup accounts differently. |
| TLS and SDK | Anonymous `/mcp` returned 401 with protected-resource challenge in 8 ms. Real SDK consent and token exchange succeeded through the validated loopback TLS route; the version 2 catalog had 15 tools in 32 ms. One `list_habits` read took 321 ms. Eight concurrent reads took 154-486 ms. |
| Cancellation | A backend query response was held for 2,502 ms; the client aborted its TLS MCP call. A subsequent health check and SDK read succeeded. |
| Busy database | A separate Node process held an exclusive lock on synthetic `product.sqlite`; `list_habits` returned `UNAVAILABLE` in 18 ms and recovered after rollback. |
| SIGTERM during admitted write | The actual reviewed `main.js` received SIGTERM with its local check-in already committed and the real Snapback upload response withheld. The journal was `pending_sync`/`pending` at signal. The response was held 264 ms, the SDK received `backend_acknowledged` after 1,379 ms, and the main unit exited successfully with status 0. |
| Restart and idempotence | The same operation ID returned the same check-in ID after restart; the synthetic board had exactly one check-in. The journal was `backend_acknowledged`/`acknowledged` after shutdown. |
| Low disk | A separate 16,777,216 byte private tmpfs held the service state. An authenticated account read returned `UNAVAILABLE` in 40 ms. The tmpfs was unmounted afterward. |

The CPU tick count is a `/proc/<pid>/stat` delta over the sampled main process lifetime. The cgroup counter is an actual `systemctl show` value taken while that unit was active. They are separate observations, not a combined utilization percentage. Request latencies are bounded synthetic samples, not production service targets.

The previous helper revision passed a second run against the same reviewed `main.js`, recorded at `/home/ubuntu/habit-mcp-staging-acceptance-20261030/reviewed-b3f05d2-exact-tools/evidence.json`. It asserted the exact fifteen tool names and exited 0 with no cleanup errors, then removed that run's fixture. Its peak RSS was 147,812,352 bytes, peak FD count 53, cgroup CPU usage at the held write 2,963,524,000 ns, and eight concurrent read latencies 147-498 ms. That revision recorded the SIGTERM states and SDK outcome but did not assert every one of them; its result remains evidence of the observations above, not proof that its assertions required them. The first reviewed run's private fixture remains stopped for M24. No transient unit, test listener, or tmpfs mount remains active.

The corrected helper ran against the same reviewed release in a fresh root, `/home/ubuntu/habit-mcp-staging-acceptance-20261030/reviewed-b3f05d2-asserted-20261030/evidence.json`. It exited 0 with `ok: true` and no cleanup errors. The evidence records expected and observed SHA256 values for the actual main, schema, and release archive, plus the extracted release provenance matching both the reviewed commit and the archive's `PROVENANCE` member. The test asserted `pending_sync`/`pending` at SIGTERM, a real SDK `backend_acknowledged`/`acknowledged` response after a 279 ms held upload response, successful unit exit with status 0, `backend_acknowledged`/`acknowledged` after shutdown, and the same operation and check-in IDs on retry with exactly one database effect. It also asserted all fifteen tool names, the 512 MB and one CPU unit limits, and low-disk refusal. There were 196 resource samples, peak RSS 145,932,288 bytes, and peak FD count 54. This new run removed its own fixture; `reviewed-b3f05d2/fixture` remains stopped and untouched. The transient unit is inactive, ports 4450-4455 have no listeners, and the temporary low-disk mount is absent.

## Remaining gates

This helper validates a private loopback TLS route; public certificate, shared Traefik route priority, unchanged existing Snapback routes, and production service-user permissions require the separate M23 staging gate. It does not establish production backup custody, off-host encrypted transfer, restore fencing, or real-client interoperability. The preserved synthetic graph is suitable only for the M24 cold-copy and fenced-restore rehearsal. An earlier WIP fixture run is separately recorded at `final-20261030/evidence.json`; it is not used for the reviewed release result above.
