# MCP staging handoff - no activation

These are additive M23 artifacts. Nothing in this directory is installed or enabled by creating it. The existing Snapback 0.4.49 service on `127.0.0.1:4410`, Traefik bridge on `172.26.0.1:4411`, shared provider file, mobile schema 12 and native checksum gates remain authoritative. M24 backup/restore proof and M25 independent review precede M26 activation.

## Topology and ownership

| Item | Proposed value | Boundary |
| --- | --- | --- |
| MCP listener | `127.0.0.1:4413` | `startup.ts` hardcodes loopback; private config sets port 4413 |
| Traefik bridge | `172.26.0.1:4414` | socket binds the currently observed `traefik` network gateway only |
| Process | `habitmcp:habitmcp` | separate unprivileged user, no shared Snapback state |
| State | `/var/lib/habit-system-mcp` | owned by `habitmcp`, mode 0700; no automatic creation by these units |
| Config and keys | `/etc/habit-system-mcp/config.json`, `/etc/habit-system-mcp/keys.json` | private files owned by `habitmcp`, mode 0600, parent directory 0700; keys outside app state and backups |
| Release | `/opt/habit-system-mcp/releases/<40-character-git-sha>` | immutable after review; unit instance pins this exact path |

The current version 1 config has exactly `version`, `publicOrigin`, `backendUrl`, `dataDirectory`, `keyFile` and `port`. The proposed values are `1`, `https://habits.ramimaalouf.com`, `https://habits.ramimaalouf.com`, `/var/lib/habit-system-mcp`, `/etc/habit-system-mcp/keys.json` and `4413`. The config parser requires private physical paths and rejects a key file inside state. The unit supplies only `MCP_CONFIG_PATH`; it never puts secrets in environment variables or command arguments. Key custody, encrypted off-host recovery and recovery-latch policy are M24 gates. Do not invent keys or create a fresh writable state directory in a restore path.

The unit caps memory at 512 MB and CPU at one core; the bridge has its own 32 MB and 10 percent CPU caps. These are initial limits, not measured MCP capacity. The service cannot write outside state under `ProtectSystem=strict`; config and release paths are read-only. Node has no public bind. The socket is not socket activation for Node; it forwards private bridge connections to the independently started loopback service.

## Reviewed release artifact

Use a committed, reviewed 40-character Git SHA. On the source checkout, make a deterministic archive of that commit and record its digest. The archive includes the tracked service lockfile, `snapback/schema.q`, shared core and platform transport sources; it excludes ignored exports, sessions and backups. Do not substitute the live working tree for the reviewed commit.

```sh
git archive --format=tar <reviewed-sha> | gzip -n > source-<reviewed-sha>.tar.gz
shasum -a 256 source-<reviewed-sha>.tar.gz
```

Transfer only that archive and the official `node-v24.22.2-linux-arm64.tar.xz` to an isolated, unprivileged ARM64 builder with Python 3.12. Verify the Node archive against the [Node v24.22.2 official SHA256 list](https://nodejs.org/dist/v24.22.2/SHASUMS256.txt): `eb187837a2230d4047161ac0be008584e16b46f726e9c9490ee35dc6b17d9ba8`. The script checks that digest itself, checks the reviewed source archive digest, decompresses the complete tar into a private temporary directory with a 512 MB size limit, checks archive paths and links, and verifies its embedded Git commit before extraction. It also checks Linux ARM64 and Bun 1.4.3, installs the service lock with scripts disabled and `--frozen-lockfile`, generates the pinned Snapback API from tracked schema, runs service lint/typecheck, builds the Node bundle, and emits a release tarball with a SHA256 and provenance record. It runs no service or migration. Commands have timeouts. Run it with explicit absolute input/output paths:

```sh
ops/mcp/stage-release.sh --source-archive /path/source-<sha>.tar.gz \
  --source-sha256 <reviewed-source-digest> --release-sha <reviewed-sha> \
  --node-archive /path/node-v24.22.2-linux-arm64.tar.xz \
  --output /path/habit-system-mcp-<sha>.tar.gz
```

The archive contains `node/bin/node`, `services/mcp/dist`, service `node_modules`, service `package.json` and `PROVENANCE`. Its digest must be reviewed before copying into `/opt/habit-system-mcp/releases/<sha>`. The script does not create that directory, any OS user, private keys, config, state, latch, systemd installation or Traefik route. It has no activation or rollback switch.

## Route merge contract

Merge **only** the named `http.middlewares.habit-system-mcp-request-headers`, `http.routers.habit-system-mcp` and `http.services.habit-system-mcp` entries from `traefik-mcp.fragment.yml` into `/matrix/traefik/config/provider.yml` after backup and review. Never replace the whole shared provider file. The router has explicit priority 10000 above the existing catch-all Habit System router. It owns exact `/mcp`, all `/mcp/` browser/OAuth/health paths, exact `/.well-known/oauth-protected-resource/mcp`, and the authorization server and OpenID discovery paths under `/.well-known/.../mcp/auth`. `/mcp/auth/jwks` is covered by `/mcp/`. Existing `/q`, `/m`, observation, schema/API routes and other hosts remain on their existing routers. Verify actual discovery metadata against the staged server before installing the route; add any required path to this fragment and review it before activation.

The route preserves `Authorization` and `Origin` and strips spoofable persona and forwarding request headers. Review the live Traefik entrypoint's `forwardedHeaders` trust configuration too. TLS uses its existing `web-secure` entrypoint and `default` certificate resolver. `flushInterval: -1ms` requests immediate streaming flush; the live entrypoint's timeouts, `Host`, Origin enforcement, TLS and cancellation behavior still need actual proxy tests. The application validates the canonical host and Origin itself. No other service or host should be edited for MCP.

## Required pre-activation evidence

1. Recheck `uname -m`, Docker `traefik` network gateway and listeners on 4410, 4411, 4413 and 4414 immediately before staging and again before activation. Refuse 4413 or 4414 collisions or a gateway change; do not stop a competing service.
2. Review artifact SHA and provenance against the source commit and official Node digest. Verify systemd units with `systemd-analyze verify` on the target OS before installation. Confirm release contents and permissions, config/key ownership, private state, and startup recovery latch as required by M04R/M24.
3. First run synthetic staging without the public route. Measure `systemctl show` memory/CPU counters and bounded load, low-disk behavior, shutdown, cancellation and long responses. Verify anonymous MCP auth challenge, metadata, JWKS, token flow and no secret output in journal. Confirm local listener is loopback and bridge is gateway-only.
4. Rehearse complete MCP plus Snapback backup/restore per M24. A restored deployment starts write-fenced even when journal heads match. Keep keys separate and recoverable; do not infer completeness from a matching pair of restored databases.
5. After route merge, test public TLS, `Authorization` and `Origin` passage, Streamable HTTP response flush and cancellation, and unchanged Snapback `/q`, `/m` and other host routes. Independently review routing, auth and restore evidence before M26 activation.

No clean ARM64 release artifact, MCP resource measurement, proxy/TLS smoke, load result, backup rehearsal or production deployment is claimed by this M23 file set. The earlier private M05 ARM64 proof established the Node 24.22.2 runtime on Oracle; it is not a test of this release. On 2026-10-30, read-only checks found ARM64, gateway `172.26.0.1`, Snapback 4410 and bridge 4411 active, with no 4413/4414 listeners at that moment. Recheck these values because ports are not reserved.

Review round 1 found that a raw `gzip -dc source.tar.gz | git get-tar-commit-id` pipeline returns 141 on a valid 7.3 MB archive because Git closes the pipe after the header. The original script's `[[ ... ]]` comparison masked that exit status in our isolated test, so the observed script passed source admission; it still had a fragile check. The revised script decompresses to a complete, size-bounded temporary tar, checks members, reads the commit from that file, and extracts only after validation. An isolated Linux ARM64 container using a valid `git archive HEAD`, the official checksum-verified Node archive, and a Bun stub reached the frozen-install call. Wrong source digest, wrong commit and traversal-member cases each failed before extraction. The stub intentionally stopped the process there; no complete ARM64 build is claimed.
