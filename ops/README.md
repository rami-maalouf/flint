# Snapback 4 on Oracle

The app uses `https://habits.ramimaalouf.com`. DNS is an unproxied A record to Oracle `192.18.154.172`; the existing Traefik installation terminates TLS with its `default` Let's Encrypt resolver. Its other routes remain intact.

## Runtime and capacity

Pin npm `snapback4@0.4.49` and matching source commit `2a58bf4b1c60efada322ec3fbc1530d6bd4d8e20` in `expo/snapback`. Main was already 0.4.50 during setup. npm 0.4.49 supplies no Linux ARM64 binary. This native build was verified on the VPS:

```sh
docker run --rm --name habit-system-snapback-build --cpus=2 --memory=8g \
  -e CARGO_BUILD_JOBS=2 -e CARGO_INCREMENTAL=0 \
  -v /home/ubuntu/habit-system-fullstack-build:/work -w /work \
  rust:1.97-bookworm cargo build --release --locked -p snapback4
```

Recorded image digest: `sha256:0e2bcaef56d041a486784e54104a81aebe0da44bd03019bd70bc0401e42e4a97`. Build time was about 13 minutes. The VPS has four ARM cores and 24 GB RAM. The backend initially used about 18 MB; its service is limited to 512 MB and one CPU. No Postgres or external object store is required for this SQLite deployment. These observations are not a load benchmark.

- Binary and schema: `/opt/habit-system-fullstack/{snapback4,schema.q}`.
- Durable deployment: `/var/lib/habit-system-fullstack/deployment`, owned by unprivileged `habitsystem`, mode 0700.
- Backend: `habit-system-fullstack.service`, loopback `127.0.0.1:4410`.
- Traefik bridge: `habit-system-fullstack-proxy.socket` on `172.26.0.1:4411`, forwarding to loopback. Check the `traefik` Docker network's gateway before copying these units elsewhere.
- Routing: merge `traefik-habits.yml` into `/matrix/traefik/config/provider.yml`, preserving existing entries. The VPS holds `provider.yml.fullstack-before-20261030` for comparison.

The proxy strips `x-snapback-persona`, preserves Authorization and Origin, flushes immediately, and uses the existing entrypoint's unlimited write timeout for long polls. Backend and bridge ports do not bind public interfaces.

```sh
ssh oracle sudo systemctl status habit-system-fullstack --no-pager
ssh oracle sudo journalctl -u habit-system-fullstack -n 50 --no-pager
curl -i https://habits.ramimaalouf.com
```

An unauthenticated request returns HTTP 401. For private diagnostics, forward `4410:127.0.0.1:4410` over SSH and use a separate development database with that server URL.

## Releases

Run `bun install --frozen-lockfile`, `bun run backend:check`, `bun run test:backend` and app gates before deployment. `postinstall` generates the ignored typed API. Back up the live deployment, stop only this service, copy the reviewed schema, and deploy as its owner:

```sh
sudo -u habitsystem /opt/habit-system-fullstack/snapback4 deploy \
  /var/lib/habit-system-fullstack/deployment --schema /opt/habit-system-fullstack/schema.q
sudo systemctl start habit-system-fullstack
```

Check the pinned CLI's help before future releases. Initial deployment is release 1, generation 1. Never edit SQLite, release metadata or generated client code manually. The app's pinned Bun patch corrects Expo native host detection in the SDK; keep `tests/backend/native-host.test.mjs` green when upgrading.

## Backups and restoration

`backup-oracle.sh`, installed as `/opt/habit-system-fullstack/backup.sh`, is the entry point for the unchanged daily timer and manual native backups. Once MCP recovery is configured, it dispatches to the reviewed pinned-Node `native-backup.mjs`. That helper takes the same `/run/habit-system-mcp-recovery/lock.sqlite` exclusion lock as MCP backup and restore marking before unit inspection, stops only the Habit System backend if initially active, archives the entire deployment including SQLite sidecars/assets/releases, and verifies the original unit state after restart before reporting success. Missing helper, runtime or lock fails closed without a service call. Before MCP recovery is configured, the legacy path remains available with restart cleanup armed before stop. Archives remain private mode 0600 in `/var/backups/habit-system-fullstack`. Install the reviewed shell entry, root-owned recovery helper tree and checksum-verified Node 24.22.2, and prepare the private recovery lock directory before activating MCP or allowing paired backups. See [MCP backup coordination](../docs/mcp/backups.md#native-backup-timer-coordination) for the exact path and installation contract; no production installation is implied by these files.

The timer runs daily at 04:00 UTC plus up to five minutes of jitter, including missed runs after reboot. Initial next run: 2026-10-31 04:04:24 UTC. Sync briefly pauses during backup; local commands continue offline. Retention and ongoing off-host replication are not automated. Monitor disk usage and transfer archives to independent storage; the rehearsal includes one such off-host copy in ignored private artifacts.

```sh
ssh oracle sudo /opt/habit-system-fullstack/backup.sh /var/backups/habit-system-fullstack
```

Restore into a new empty directory using the same binary, preserve permissions/ownership, and serve it on a separate loopback port. Verify authentication and record contents before replacing a live deployment. The final rehearsal used `/var/lib/habit-system-fullstack/restore-20261030T165358`, port 4412, and temporary unit `habit-system-restore-qa-final`. Authentication passed and all five record payloads/digests matched the live snapshot, including the native offline check and coin. The temporary unit was stopped. Restoration cannot undo external effects.

## Integration and capabilities

SQLite remains the authoritative local store. Commands and native intents atomically append to the inherited outbox; the adapter sends wire schema 2 through generated Snapback APIs. Owner rules isolate accounts. Canonical HLC stamps order mutable records, server-verified content identities retain immutable variants, and an atomic per-owner revision supports pagination. Profile observation reconciles its first snapshot and later revisions. Local validation admits remote economic facts.

The app uses Snapback identity, typed queries/mutations, access rules, observation and release deployment. Its existing SQLite engine supplies local-first behavior; it does not embed Snapback's separate replica runtime. Multipart payloads support large immutable facts without trusting client digests. Uploaded parts remain durable after retries and updates; inspect storage growth before adding media-heavy features.

The session manager owns SecureStore persistence and expiration. Its SDK connection uses the supported bearer-token option, preventing SDK-managed rotation from replacing a token without saving it. Expired sessions require sign-in again; offline local use continues. Automatic session renewal is not implemented.

Snapback 4's pinned CLI has no verified MCP interface. MCP files in the older Snapback tree do not establish a working v4 service. Jobs, presence and media features are not added without a product use. Never expose development doors or claim an unimplemented MCP endpoint.
