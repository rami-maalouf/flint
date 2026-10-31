# Shared Traefik and service-user staging

The 2026-10-31 rehearsals used the reviewed `b3f05d24f9f58f11e1f5efaa0e17a9d7969c3728` ARM64 release described in [Linux acceptance](linux-staging.md). They tested the actual Oracle Traefik 3.7.16 instance and public certificate for `https://habits.ramimaalouf.com`, then removed the conditional route and stopped the staging services. This was not production MCP activation.

## Isolation and permissions

A separate unprivileged `habitmcp` system user ran the reviewed release from `/opt/habit-system-mcp/releases/<sha>`. The staging-only config and state were `/etc/habit-system-mcp-stage` and `/var/lib/habit-system-mcp-stage`, owned by that user with mode 0700. Config, independently generated keys and the external latch were mode 0600. The installation binding was retained privately on the Mac before fresh latch provisioning. No restored latch was provisioned or cleared.

The actual service template was staged with only its config and writable-state paths changed. Target `systemd-analyze verify` passed; its warnings referred to executable permission bits on pre-existing Oracle monitoring units, which were left untouched. The running service reported `User=habitmcp`, `ProtectSystem=strict`, `NoNewPrivileges=yes`, `ReadWritePaths=/var/lib/habit-system-mcp-stage`, `MemoryMax=536870912` and `CPUQuotaPerSecUSec=1s`. It had no restart failures. The listener was `127.0.0.1:4413`; the socket proxy bound only the rechecked Traefik gateway `172.26.0.1:4414`.

## Conditional public route

Only three temporary named entries were added to the shared provider: `habit-system-mcp-stage`, its service and its request-header middleware. They used the reviewed [fragment](../../ops/mcp/traefik-mcp.fragment.yml), plus a `Header` selector required alongside the canonical host and MCP paths. The selector selected staging; OAuth still protected account access. Requests without it continued to the existing Snapback router. The merge parsed and compared every original provider value before atomic replacement; removal deleted only those entries and verified that all original values matched afterward.

The actual static configuration used a directory bind mount containing `/config/provider.yml`, an unlimited `web-secure` write timeout and 180-second idle timeout. The application continued to derive authority from its fixed canonical config, rather than forwarded headers. The temporary route used the existing TLS resolver and immediate response flushing. See the versioned [routing rules](https://doc.traefik.io/traefik/v3.7/reference/routing-configuration/http/routing/rules-and-priority/) and [file-provider contract](https://doc.traefik.io/traefik/v3.7/reference/install-configuration/providers/others/file/).

| Public check | Observed result |
| --- | --- |
| Health with staging selector | 200, `restoreFenced: false` |
| Anonymous `/mcp` | 401 with the canonical protected-resource metadata challenge |
| Resource and authorization-server discovery | 200 through validated public TLS |
| Foreign Origin | 403 |
| Actual synthetic sign-up, provider browser forms, PKCE and token exchange | Official SDK 2.4.0 connected successfully |
| Catalog and synchronized read | All fifteen tools; `list_habits` succeeded |
| Read-only grant calling `create_checkin` | Structured `FORBIDDEN`; no habit was created |
| Current protocol with delayed request body | The SDK-generated 2026-07-28 packet and headers returned 200 after 2,519.8 ms; response content type was `application/json` |
| Canceled partial request | A subsequent health request returned 200 |

The extra raw-request probe initially omitted the modern per-request metadata and `Mcp-Method` header and correctly received 400. Replaying the actual SDK-generated envelope and headers passed. This earlier run checked delayed request bodies and cancellation before a response, not a deliberately held public response. The separate Linux rehearsal holds a real Snapback upload response and proves accepted-write shutdown over validated private TLS. The service uses bounded stateless Streamable HTTP responses; this run did not establish an old SSE-only transport.

## Final public response flush and cancellation proof

The final fixture is `services/mcp/tests/helpers/public-proxy-staging.ts`. It ran the same reviewed `main.js` as `habitmcp` on a newly checked `127.0.0.1:4415` listener, using a private stage config that differed from the previous config only in `port`. The installed main's observed SHA256 was `edddaac92d0b179566b10780b9d4c2bb01cfe81b0ffee0e3681e54a9a05e5e0a`, matching the reviewed release. A temporary Node HTTP forwarder listened on `127.0.0.1:4413`; the reviewed socket bridge listened on `172.26.0.1:4414`. Only the same three Header-selected Traefik entries were added, with a new exclusive backup name. The previous `provider.yml.mcp-stage-before-20261031` backup was never overwritten. All ordinary requests passed through the forwarder. Only a marked, SDK-derived `tools/list` request caused it to send the first byte of the real MCP response and hold the remaining bytes for three seconds. It forwarded the original status and body bytes without altering authentication or product data. The fixture recorded only status, byte counts and timing or close events; it did not record bearer tokens, account identifiers or request and response bodies.

The helper's local negative fixture sent an otherwise valid response with zero hold and confirmed that its timing assertion rejected it. The positive fixture passed. The final public run's private evidence is `/home/ubuntu/habit-mcp-staging-acceptance-20261030/public-proxy-20261031/public-proxy-evidence.json` on Oracle; `forwarder-counters.json` records the two marked requests. The earlier run in this same root was retained separately as `public-proxy-evidence-r1.json`, before the final close-order assertions were added.

| Final check | Asserted observation |
| --- | --- |
| Anonymous selected `/mcp` | 401 with protected-resource challenge |
| Resource and authorization-server metadata | Both 200 over public TLS |
| Foreign Origin | 403 |
| Selector-free `/mcp/health` | Existing backend 404 |
| Real synthetic OAuth and pinned SDK 2.4.0 / protocol 2026-07-28 | Connected; fifteen tools and synchronized `list_habits` read |
| Read-only grant calling `create_checkin` | Structured `FORBIDDEN`; no habit write |
| Delayed request body, separate from response hold | 200; first response byte at 2,517 ms |
| Held real MCP response through Traefik | First public TLS byte at 52 ms; complete response at 3,057 ms. The forwarder released it after 3,002 ms and preserved all 54,621 upstream bytes with status 200. |
| Abort during held response | First public TLS byte at 52 ms; forwarder recorded downstream close, then upstream close 1 ms later, before release or upstream completion. A subsequent public health request and SDK read succeeded. |

This proves public TLS response flushing and cancellation propagation across the actual Traefik route and bridge for a fixture-held MCP `tools/list` response. It does not claim that Snapback held a response in this public run; the separate Linux acceptance helper exercised a held Snapback upload. Traefik 3.7 documents that a negative [`flushInterval`](https://doc.traefik.io/traefik/v3.7/reference/routing-configuration/http/load-balancing/service/#configuration-options) flushes immediately after each write. The observed 52 ms first byte is the concrete public-route evidence here.

All credentials and account identifiers remained private. These public checks created separate disposable synthetic accounts on the existing backend; they did not use a real user's account or create synthetic habits in it. Only the temporary MCP stage held its OAuth grants and replicas. Evidence and one-off replay scripts remain under ignored `.artifacts/fullstack/mcp-service-user/` and `services/mcp/.artifacts/public-staging.*`.

## Cleanup and release boundary

The conditional entries were removed after each run. After the final run, the provider parsed identically to the original reviewed backup. All final-run temporary units, the port-only config and the new provider backup were removed; the earlier reviewed backup remains. Ports 4413, 4414 and 4415 had no listeners. The original backend and bridge stayed active on 4410 and 4411 with unchanged main PIDs `1378826` and `1335320`; unauthenticated `/q/profile` returned 401 through both. Public `/mcp/health` returned the existing backend's 404 after route removal. No backend schema or existing router was changed, and no other service was restarted. Private staging directories and the new service user remain for inspection; they are not production state or keys.

Production activation still requires the paired encrypted restore proof, final independent review, a fresh production installation binding and keys, a current reviewed release artifact, pre-activation backup and a separate route merge. No user account is connected by this rehearsal.
