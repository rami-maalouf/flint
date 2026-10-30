# Authorization feasibility proof

M01, checked 2026-10-30. Gate A selects Better Auth 1.7.14 with the official MCP SDK v2 on Node 24.22.2 and `node:sqlite`. This is a disposable proof, not a deployed service or production authorization implementation.

## Reproduce

The repository root must first have its pinned Snapback installation and generated API. From the root:

```sh
bun install --frozen-lockfile
bun install --cwd services/mcp --frozen-lockfile
```

From `services/mcp`, with Node 24.22.2 available:

```sh
MCP_PROOF_NODE=/absolute/path/to/node-v24.22.2/bin/node bun run proof:auth
MCP_PROOF_NODE=/absolute/path/to/node-v24.22.2/bin/node MCP_PROOF_PUBLIC_CIMD=1 bun run proof:auth
bun run lint
bun run typecheck
```

`MCP_PROOF_NODE` selects an executable without changing the system installation. The proof asserts both the exact Node version and the absence of `process.versions.bun`. Without the variable, the script uses `node` from the script environment and fails if that runtime is wrong. Do not add `--bun` to a Node launcher.

The second proof command requires public HTTPS access to ChatGPT's published client metadata and Better Auth's documentation redirect. It exercises the same unmodified maintained transport used by the provider. Without `MCP_PROOF_PUBLIC_CIMD=1`, those two network cases are explicitly skipped. No test contacts the configured production Habit System backend.

The proof creates a temporary Snapback memory server from the repository schema, two random synthetic password accounts, temporary private provider SQLite state, ephemeral keys and loopback HTTP routes on an ephemeral port. It cleans up the processes and temporary directory. Root `snapback4@0.4.49` and its existing native-host patch are reused without upgrading. No real account, phone database, production credential, or private migration artifact is needed.

## Tested dependency and runtime selection

| Component | Exact version |
| --- | --- |
| Bun package manager | 1.4.3 |
| Service runtime | Node 24.22.2 |
| `better-auth` | 1.7.14 |
| `@better-auth/mcp` | 1.7.14 |
| `@better-auth/cimd` | 1.7.14 |
| `@better-auth/oauth-provider` | 1.7.14, resolved in service lock |
| `@modelcontextprotocol/server` | 2.4.0 |
| `@modelcontextprotocol/client` | 2.4.0 |
| `@modelcontextprotocol/core` | 2.4.0, resolved in service lock |
| `@modelcontextprotocol/node` | 2.1.2 |
| `zod` | 4.6.7 |
| TypeScript / ESLint / Node types | 6.0.3 / 9.39.1 / 24.10.0 |

The adapter's version line is independent: `@modelcontextprotocol/node@2.4.0` does not exist; 2.1.2 declares the server peer `^2.4.0`. The separate service lock resolves one coherent Better Auth family and one MCP core revision. OAuth dependencies were not added to the root package or root lock.

The default Bun runtime candidate was rejected at the documented security boundary: Better Auth supplies its resolve-once, public-address-only, pinned-connection, TLS-host-preserving, redirect-refusing CIMD transport for Node. Its docs require an equivalent implementation for Bun and provide none there. This proof uses the maintained Node transport directly rather than writing a DNS or redirect layer or substituting ordinary Fetch. There is no claim that running this Node-specific transport on Bun is supported.

Node 24.13.0 was also rejected after the parent's actual opaque-fact storage failure: SQLite stored `a\0z` as hex `61007A`, but that runtime returned only `a` through TEXT decoding. Node 24.22.2 passes the same bound-parameter TEXT round trip in this proof. The parent supplied a binary verified against the official archive checksum at `/tmp/node-v24.22.2-darwin-arm64/bin/node`; that machine-local path is not an installation requirement. ARM64 Linux and the complete asynchronous shared-core adapter remain separate verification gates in M03/M05.

## Supported identity seam

`auth.mjs` registers a Better Auth endpoint plugin using `createAuthEndpoint`. Its only login input is an email and transient password. It calls Snapback's supported `login(..., { scope: 'read' })`, then queries the existing authenticated `profile` operation with that independent bearer. The returned profile owner must equal the session principal.

The provider subject is bound to the canonical backend origin and this immutable principal. A SHA-256 encoding of the tuple supplies a unique synthetic internal email solely for provider storage; it does not use the entered email as ownership evidence. Persisted user fields record the verified backend and principal and reject inconsistent reuse. No password account is created in Better Auth's `account` table.

The documented plugin adapter creates the local user/session, and Better Auth's exported `setSessionCookie` issues the browser cookie. A successful login creates a new session. A browser using Alice's cookie to sign into Bob gets a distinct subject and cookie, while Alice's existing OAuth grant continues to read Alice. Invalid passwords, untrusted Origin, and injected ownership fields fail. The proof does not patch provider internals or implement authorization codes, PKCE, tokens, registration, consent signatures, or refresh handling.

This proves the preferred provider's external-identity seam, so the conditional `node-oidc-provider` fallback is not exercised or installed.

## Demonstrated protocol boundaries

- An anonymous MCP request gets the official SDK's 401 bearer challenge, including protected resource metadata. The SDK discovers both the protected resource and authorization server metadata, including the canonical resource, issuer, S256 support, explicit DCR endpoint and CIMD support.
- The official SDK performs DCR, generates PKCE, follows its own discovery state across the browser leg, exchanges the provider-issued code, and negotiates exactly protocol `2026-07-28` over actual HTTP. Browser interactions use the provider's signed authorization query and consent endpoint. They do not replace OAuth behavior with mocks.
- Three public-client callback profiles complete authorization, tool listing, and an account-specific Snapback read. Two synthetic accounts remain separate across browser account switching and three independent grants. Tool invocation independently enforces scopes and refuses the write probe for every read grant.
- An actual read-scoped Snapback bearer cannot mutate `saveProfile`; the attempted change is refused and a subsequent read is unchanged. An actual full Snapback bearer is rejected as an MCP access token.
- Authorization rejects missing PKCE, an unregistered redirect, and an unconfigured resource. Token exchange rejects an incorrect verifier and a replayed code. Consent denial returns `access_denied`. The real signed access token also fails verification with the wrong issuer or audience.
- The maintained Node CIMD transport rejects HTTP, non-GET/HEAD methods, loopback, localhost DNS, private IPv4, link-local metadata IP, and IPv6 loopback. It retrieves ChatGPT's real public metadata over verified HTTPS. Better Auth's actual 308 response is returned with its Location intact rather than followed.
- With public-network cases enabled, the provider discovers `https://chatgpt.com/oauth/client.json` through that transport, processes consent, issues a code for the exact published callback, and persists the CIMD registration. No ChatGPT private key is available to this proof, so it does not exchange that CIMD code or claim a real ChatGPT connection.
- Closing the provider, reopening the same SQLite database in a fresh Node process, and reconnecting the same Snapback account preserves its subject. DCR/CIMD client records, browser sessions, consent rows, refresh-token state, and the signing key pair survive. An untouched grant refreshes through the SDK and reads the correct account after restart. The code-replay grant is deliberately excluded from that refresh assertion because the provider invalidates its refresh authority.

## Client evidence boundary

| Profile exercised | Registration and transport | Actual evidence |
| --- | --- | --- |
| Official TypeScript SDK 2.4.0 | DCR, public client, loopback callback, Streamable HTTP, pinned `2026-07-28` | Authorization, listing, read, denied write, reconnect/refresh |
| ChatGPT-shaped hosted callback | Synthetic DCR public client, `https://chatgpt.com/connector_platform_oauth_redirect` | Full SDK-driven flow; no request follows the callback to ChatGPT |
| Claude-shaped hosted callback | Synthetic DCR public client, `https://claude.ai/api/mcp/auth_callback` | Full SDK-driven flow; no request follows the callback to Claude |
| Published ChatGPT CIMD | Real metadata document and provider discovery, consent/code issuance, SQLite registration | Discovery side only; `private_key_jwt` exchange and real app connection unverified |
| ChatGPT or Claude application | No application login or connector configured | Unverified |
| Older protocol revisions | No older client revision tested; proof server rejects legacy protocol mode | Unverified; defer to M22 |

The published ChatGPT CIMD currently declares `private_key_jwt`, including a `jwks_uri`. Its metadata cannot be substituted with this proof's DCR public-client profile when describing actual interoperability. M22 must exercise the real application and exact registration method before advertising support.

## Red and green evidence

All commands below used cwd `services/mcp` unless stated otherwise.

1. Red, before `auth.mjs` existed: `bun run proof:auth` exited 1 with `ERR_MODULE_NOT_FOUND`. The test contract already required separate subjects, refused credentials/writes, actual authorization and restart.
2. Behavioral red on the first real provider integration: the untrusted-Origin case returned 200 where 403 was required. Adding the exported provider origin middleware to the custom identity endpoint made that case pass. No OAuth implementation was modified.
3. A real restart attempt after replaying the same grant's authorization code failed `invalid_grant: session not found`. This established an invalidated grant was being reused by the test. The restart proof now refreshes an untouched grant and keeps code replay as a distinct negative assertion.
4. Green: `MCP_PROOF_NODE=/tmp/node-v24.22.2-darwin-arm64/bin/node MCP_PROOF_PUBLIC_CIMD=1 bun run proof:auth`: 12 passed, 0 failed, 0 skipped, including the fresh-process restart and public-network cases.
5. Green: `bun run lint`, `bun run typecheck`, and `bun install --frozen-lockfile`. Lint applies explicit unused-variable, undefined-name, equality and constant-condition rules without importing the mobile config. Typecheck checks the JavaScript proof and SDK declarations with the service's pinned compiler. Production strict TypeScript/build isolation belongs to M05.

The intentionally hostile Origin test emits a Better Auth error line naming the fixed synthetic attacker origin. It does not log login input or bearer tokens. No generated identity, credential, token, key, database, or record dump is committed as evidence.

## Upstream recheck

One upstream inspection on 2026-10-30 resolved `expo/snapback` HEAD to `dd38373d2f99631225f5114eacaf54884c295675`. Its v4 package still identifies as unpublished 0.4.50. The v4 source file listing had no MCP implementation filename, and the inspected CLI dispatch (`snapback4/crates/snapback4/src/main.rs`) and HTTP route module (`serve_routes.rs`) had no MCP command or route. No supported v4 MCP result was found. This is bounded source inspection, not a claim that every archived experiment was audited. The installed/deployed version remains 0.4.49 with its existing patch.

## Limits and next step

The proof only listens on loopback and serves protocol endpoints for synthetic tests. It does not render sign-in/consent pages or install public routing. Browser interaction is simulated through actual HTTP endpoints, so no screenshot or real browser/app connection is claimed.

Provider state and signing keys are durable in the synthetic provider database. Snapback read credentials are deliberately held only in process memory, keyed by the verified provider subject. Restart requires interactive Snapback reconnect before data reads. This does not implement encrypted per-grant credential custody, concurrent-login serialization, session/grant revocation coordination, upstream expiry handling, stable production key provisioning, registration abuse limits, or a production migration path. The proof's startup migrates only a new empty provider database. Those responsibilities remain in M06/M07/M13/M20/M21.

Identity verification currently requires an initialized profile, seeded through the synthetic setup's full session. It fails closed for an account without that row. Supporting otherwise valid empty accounts needs a supported authenticated principal verification path in the production identity task. Read-only replica bootstrap and settlement are outside this proof and remain M03. There is no product/core schema migration here.

Next: freeze the precise scopes and client/security contracts in M02; complete M03 on the selected Node 24.22.2 SQLite runtime, then establish the production package boundary in M05. Parent owns canonical root/native/backend gates, checkpoint/todo updates, independent verification and commits. None of those are claimed by this proof report.

## Sources

- [Better Auth plugin extension API](https://better-auth.com/docs/concepts/plugins), including documented `internalAdapter` session creation; exported APIs checked in installed 1.7.14 declarations and built-in username plugin.
- [Better Auth MCP](https://better-auth.com/docs/plugins/mcp), [CIMD security boundary](https://better-auth.com/docs/plugins/cimd), and [OAuth provider](https://better-auth.com/docs/plugins/oauth-provider); checked against the installed 1.7.14 package APIs.
- [Official MCP SDK authorization](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/serving/authorization.md) and installed 2.4.0 declarations; [MCP authorization profile](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization).
- [OpenAI client authentication documentation](https://developers.openai.com/plugins/build/auth) and [published client metadata](https://chatgpt.com/oauth/client.json), fetched 2026-10-30. [Claude remote connector documentation](https://support.anthropic.com/en/articles/11503834-building-custom-integrations-via-remote-mcp-servers) supplies the hosted callback profile, not proof of a current app connection.
- [Snapback upstream revision](https://github.com/expo/snapback/tree/dd38373d2f99631225f5114eacaf54884c295675/snapback4); installed 0.4.49 `dist/auth.d.ts`, `dist/contract.d.ts`, and existing backend convergence tests supply the actual local session/API contracts.
