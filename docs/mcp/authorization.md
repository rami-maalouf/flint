# Authorization

## Read-only service integration (M06c and M07)

`services/mcp/src/auth/provider.ts` exports the listener-free asynchronous factory:

```ts
const authorization = await createAuthorizationService({
  publicOrigin: 'https://habits.example.com',
  backendUrl: 'https://habits.ramimaalouf.com',
  databasePath: '/private/service/provider.sqlite',
  secret: providerSecret,
  vault,
  authorizationEpoch: trustedExternalRestoreEpoch,
});
```

Run with real Node **24.22.2** and install with Bun **1.4.3**. `databasePath` must be absolute, with an owner-only directory and file. The provider creates a missing final directory with mode 0700 and a missing database with mode 0600; it refuses unsafe existing storage. Provider users, browser sessions, DCR/CIMD clients, consent, refresh state, signing keys and application grant metadata persist in this database. Encrypted upstream read and consented full credentials live exclusively in the separately supplied `CredentialVault`. Supply the provider secret and vault key ring externally, preserve both across restart, and back up their databases together. `close()` closes the provider database; the caller owns the vault and listener lifetimes.

`publicOrigin` is a fixed canonical HTTPS origin. Request Host and forwarded headers never choose the issuer, backend or redirects. Loopback HTTP requires both `allowTestLoopback: true` and a Node test context. `identityOptions` forwards only trusted startup transport/timeout options to the identity bridges; it never comes from browser input. Tests map a synthetic canonical HTTPS backend to a disposable real loopback Snapback server without changing vault binding rules. `accessTokenExpiresIn` defaults to 300 seconds and accepts integer values from 1 through 900.

### Restore epochs and reauthentication

`authorizationEpoch` is mandatory, including for a read-only provider. Its trusted, parent-owned `current()` returns `Promise<Readonly<{ epoch: string; mode: 'normal' | 'degraded_read' }>>`. The source lives outside the provider and vault roots being restored. It keeps one epoch across ordinary restarts and changes to a new unique value before each supported restore resumes admission. A missing or corrupt external marker yields a fresh process-bound `degraded_read` epoch; a rejected or malformed callback fails closed. The provider never derives or provisions an epoch from restored SQLite data.

Private pending and grant rows and provider browser-session IDs carry their issuing epoch. Legacy rows have no epoch and are not adopted. Existing connections and browser cookies therefore require fresh verified sign-in after this upgrade or a supported restore. Access and refresh tokens, unexchanged codes, pending consent, owner sessions and delivery status are checked against the current epoch. A new verified read sign-in can complete in `degraded_read`; full consent and full-grant owner resume are refused there. The operation recovery latch remains the separate permanent write fence. Normal grant A revocation leaves the epoch unchanged and preserves independent grant B. A restore rotates the epoch for every previously issued grant.

The external controller must quiesce admission and durably publish the new epoch before replacing provider or vault snapshots. Whole-host rollback or copying the independent marker outside that procedure is outside this guarantee. No external sequence write is required for an ordinary consent or revocation.

### M13c write-consent configuration and custody

The factory remains read-only by default. Trusted startup can expose `checkins:write` and `rewards:claim` only by supplying a complete account lifecycle coordinator. Starting without that coordinator refuses a provider database with any still-active write grant, including a quarantined earlier epoch. A configuration downgrade cannot bypass the retained account lifecycle boundary:

```ts
writeConnections: {
  revoke: async (grantMetadata, commitRevocation) => {
    // durably pause account delivery and enter its serialized lane before this call.
    await commitRevocation();
  },
}
```

`grantMetadata` is the frozen exact `PrivateGrant` record: account, backend, principal, client, provider session, operation lineage, OAuth scopes, independent `credentialScope`, issuing epoch, expiry and active state, with no bearer. The callback must durably pause delivery and enter the account lane before calling `commitRevocation` exactly once. The provider invokes it for trusted revocation, authenticated standard refresh/access token revocation, and a provider-session deletion hook, even when a grant already ended or its upstream credential expired. The commit fences the exact grant, tombstones its vault credential and, where needed, deletes its provider session. The session hook has a reentrancy guard so provider deletion inside the commit does not queue itself again. If the coordinator fails or omits the commit, revocation fails rather than reporting success. A trusted coordinator is required: passing a function that does not actually provide the durable account barrier would violate the service contract. No bearer or password is passed to it.

Sign-in still calls the read identity bridge and stages only a read session. A write consent page names each write permission and requests fresh email and password. Only an authenticated browser session with a valid signed continuation, canonical Origin and CSRF token can submit approval. After those checks, the provider calls `createWriteIdentityBridge(config).login(credentials, browserVerifiedAccount)`. The helper authenticates and probes a new full Snapback session, including exact account/backend/principal match. The provider consumes the pending read credential once, inserts an inactive private grant with explicit `credential_scope = 'full'`, encrypts the independent full session under that grant, then activates the grant. If activation fails, it tombstones custody; if the process stops first, startup finds the inactive grant and tombstones the exact vault binding before serving requests. The vault API performs its normal authenticated encryption checks throughout. Wrong credentials, account switching, stale sessions, denied consent or invalid CSRF do not create an active write grant. Passwords are never stored, returned to the OAuth client or used for automatic renewal. A read consent never asks for or mints a full session. `rewards:claim` requires `coins:read`; check-in notes remain a separate read permission.

The private `mcp_grants` and `mcp_pending` tables store custody scope independently of editable OAuth permission metadata. Vault binding and revocation use this stored custody scope. Admission requires an explicit `read` or `full` custody value, OAuth scopes that agree with it, and currently allowed permissions. Startup refuses private tables whose custody columns lack the expected constraints, even if their present rows contain valid values. A compatible private migration labels existing M07 grants and pending rows `read`; it refuses legacy rows claiming write permission because M07 issued read grants only. It does not change the product or vault schema.

After durable local cutoff, the provider attempts Snapback's supported exact-session `logout` for the credential captured before vault tombstoning. This is bounded best effort. The private grant row records `retirement_uncertain = 1` before the attempt and an attempt time when it runs, without storing the bearer or claiming upstream confirmation. A network failure or process stop can leave the upstream bearer live, while local grant and epoch checks continue to refuse it. No principal-wide logout is used; other grants and phone-like independent sessions retain their own authority.

The OAuth access token carries only scoped grant authority and the private grant claim; it never contains the Snapback credential. Admission and `assertActive()` check exact provider user, session, client, resource, scopes, vault binding and unexpired upstream session. Write scopes appear in `AuthContext` only for an approved write grant. A full upstream session does not upscope a read grant. Reconnect creates a new provider session, pending read credential, write approval and independent full credential; the stable account/client operation lineage does not transfer bearer custody. Full-session expiry requires interactive reconnect. Neither OAuth refresh nor a surviving second grant rotates or rescues an expired upstream session.

### Public API for the HTTP server

| Member | Contract |
| --- | --- |
| `handler(request)` | Fetch HTTP handler for discovery, provider endpoints, OAuth browser pages and standalone owner sign-in. Owns no listener. Its `/mcp` response is an anonymous bearer challenge; mount the real MCP handler there. |
| `authenticate(request)` | Verifies the MCP bearer and returns the agreed `AuthContext`; throws the bounded `AuthorizationDenied` error on refusal. |
| `verifyAccessToken(token)` | Official SDK verifier result: `token`, `clientId`, domain `scopes`, `expiresAt` in seconds, canonical `resource: URL`, and private `extra.authContext`. Translate refusal to the SDK's `invalid_token` error. Never serialize or log `extra.authContext`. |
| `browserSession(request)` | Current durable provider browser identity or null: `accountId`, `principal`, `backendUrl`, `providerSessionId`. Contains no credentials. |
| `lookupGrant({ accountId, grantId })` | Private metadata lookup, account constrained, with `operationLineageId`, client, OAuth scopes, independent `credentialScope`, issuing epoch, upstream expiry and active flag. Returns undefined on an account mismatch. |
| `deliveryGrantStatus(grantId)` | Private actor policy query. Returns frozen `{ accountId, clientId, active, scopes }`, or null only for an unknown grant. `active` checks the current epoch and mode, durable grant flag, custody/permission agreement, stored upstream expiry and supported adapter provider-session user and expiry. It does not read or return a vault credential. The account barrier independently matches account and client against its expected binding. |
| `revokeGrant({ accountId, grantId })` | Trusted server hook: passes the exact grant through `writeConnections.revoke` when configured, then fences its custody and provider session. Caller obtains the account from admitted browser identity, never a model argument. |
| `issuer`, `resource`, `resourceMetadataUrl`, `close()` | Canonical discovery values and idempotent provider shutdown. |

Use `requireBearerAuth({ expectedResource: new URL(authorization.resource), resourceMetadataUrl: authorization.resourceMetadataUrl, verifier: { verifyAccessToken } })` around the real SDK MCP handler. The verifier adapter must translate `AuthorizationDenied` to `new OAuthError(OAuthErrorCode.InvalidToken, 'Connection refused')`. Read workers receive `authInfo.extra.authContext` and must await `assertActive()` before protected work and again before returning data. Tool-specific scope checks remain mandatory. Stable operation lookup uses the actual OAuth client id within the verified account, matching `AuthContext.clientId`. The private grant's `operationLineageId` is additional stable account/client metadata.

### Routes, browser identity and consent

- MCP resource: `/mcp`.
- Provider base: `/mcp/auth`; browser pages: `/mcp/sign-in` and `/mcp/consent`. These paths do not claim Snapback's `/auth` routes.
- Protected resource metadata: `/.well-known/oauth-protected-resource/mcp`. Authorization-server metadata: `/.well-known/oauth-authorization-server/mcp/auth`. JWKs: `/mcp/auth/jwks`. The maintained provider serves discovery, and the actual SDK discovers it in HTTP tests.
- Better Auth's supported endpoint plugin and internal adapter create a provider user from the verified backend/principal account id, then a fresh browser session. The entered email is never ownership evidence. No Better Auth password account or public signup endpoint exists.
- Passwords are transient sign-in inputs. The identity bridge supplies a verified read-only Snapback session, staged in encrypted custody for at most ten minutes of pending connection admission. Successful consent consumes it exactly once. Each connection receives a new grant and independent upstream bearer; another client or reconnect must privately authenticate again after consumption.
- Application grants bind the actual provider user, client, provider session and session-specific consent reference. Each account/client pair keeps a stable operation lineage across reconnects. Account switching creates a separate lineage and cannot retarget an earlier grant.
- Consent consumption happens synchronously before awaiting provider consent, so concurrent forms cannot share one credential or revoke the winning connection. Any failed provider consent fences that attempted grant. A grant row precedes vault custody; only confirmed custody permits activation. Inactive grants and consumed pending credentials are reconciled through the vault API on startup. Cross-database crash windows fail closed and require reauthentication.

Forms are server rendered, escape all client/permission text, use fixed canonical actions, reject extra/duplicate fields, bound input size, and require a signed provider continuation plus a short-lived HMAC CSRF token bound to an HttpOnly, SameSite browser cookie. POST requires the exact canonical Origin and refuses cross-site Fetch Metadata. Successful login creates a fresh provider session instead of adopting an existing browser session. There are no GET sign-in, consent approval or revocation mutations. Cookies are Secure in HTTPS deployments, scoped to `/mcp`, and are not cached as browser identity JWTs.

The response policy uses `Referrer-Policy: strict-origin`. An actual Chromium walkthrough reproduced `Origin: null` on navigational form POSTs with `no-referrer`; accepting null origins would weaken CSRF admission. `strict-origin` preserves Origin evidence while keeping signed query strings out of referrers. CSP disallows scripts, external resources, framing and foreign form actions. DevTools' automatic local workspace probe is intentionally blocked by that policy.

### Scope, registration and revocation boundaries

The default admitted scopes are `habits:read`, `habits:notes:read`, `coins:read`, `openid` and `offline_access`. Notes require their own permission. With a trusted `writeConnections` coordinator, `checkins:write` and `rewards:claim` are also admitted after explicit write consent and separate full-session authentication. Client-credentials grants remain refused.

DCR explicitly admits public clients with `token_endpoint_auth_method: none`, S256 PKCE, authorization-code/refresh grants, and bounded HTTPS or port-qualified loopback callbacks. Confidential, unsafe callback, skip-consent, pairwise and write-capable DCR profiles are refused. CIMD uses the unmodified maintained `@better-auth/cimd/node` SSRF-safe transport and pinned `mcp-2026-07-28` metadata profile, including the maintained authenticated client profile. The public client-registration capability is not a user authorization grant.

The maintained claim extension receives the actual client, provider session and consent reference, and adds only the application claim `https://habits.ramimaalouf.com/mcp/grant`. It never overwrites reserved OAuth claims. Resource admission uses `OAuthProviderApi.requireActiveAccessToken` for JWT signature, issuer, expiry and provider-session liveness, then checks the exact resource audience, optional configured UserInfo audience, current durable grant, user, client, session, scopes and upstream expiry. A Snapback bearer is never an MCP token. `assertActive()` repeats these checks without an authorization cache.

Both the trusted revocation hook and successful standard token-revocation requests fence the whole owning connection, including future refresh. Refresh binding uses the supported provider token-hash capability and documented adapter model; no raw refresh token is added to application storage. Ended or replayed refresh authority is rejected before provider rotation, keeping another provider session's connection intact.

Standard revocation of known tokens runs inside the supported `createAuthMiddleware` request hook at the actual `/oauth2/revoke` endpoint. `OAuthProviderApi.authenticateClient` authenticates the client exactly once, retaining the real endpoint's assertion audience and replay checks. The provider's token normalizer/hash resolves a refresh record, or `requireActiveAccessToken` verifies an active JWT before the hook checks issuer, resource audience, expiry and its application grant binding. Only a matching authenticated client can fence that exact grant and delete its provider session through the supported adapter. Before fencing an access JWT, the hook stores a keyed digest of its exact bytes, grant id and verified expiry in private SQLite. It stores no raw JWT. A later exact-token match can identify the ended grant after session deletion; the expiry check and authenticated client binding still apply, while arbitrary or tampered JWTs cannot create or match this evidence. Expired evidence is ignored and pruned on startup or a subsequent verified access revocation. Known ended tokens return an idempotent JSON-null success after client authentication; wrong registered clients receive the same harmless success. Unknown tokens retain the provider's native authentication and unknown-token responses. No request forwards an already-ended refresh record into the provider's client/user-wide refresh replay invalidation. Concurrent and repeated revocation therefore preserve a newer connection for the same client and account. Provider-session deletion also fences the associated local grant. The provider still owns codes, PKCE, registration, signatures, client authentication, token issuance, refresh rotation and protocol errors. This follows the documented provider capability and request-hook contracts; the provider's own JWT revocation response is `unsupported_token_type` for a still-valid self-contained token, so the session and application grant are the actual cutoff.

### Verification and evidence limits

The actual owned test path is **`services/mcp/tests/http-auth.test.ts`**, so the existing launcher includes it in the protocol group. No package, lock, identity, context, vault, actor, journal, core or git-index change is part of this slice.

From `services/mcp`:

```sh
MCP_NODE=/tmp/node-v24.22.2-darwin-arm64/bin/node MCP_PROOF_PUBLIC_CIMD=1 bun run test:protocol
bun run typecheck
bun run lint
```

The first red run failed to resolve the not-yet-created provider. Behavioral reds reproduced refresh revocation leaving an access token usable and the real-browser null-Origin failure. Independent-review regression tests then reproduced a revoked connection A, a healthy same-client/account reconnect B, and repeated or concurrent old-A refresh revocations returning 400 and making B refresh return 400. They also caught an ended-token fast path skipping client authentication. The authenticated request hook makes these cases pass, including a provider-rotated refresh record, unknown-client/native-response equivalence, wrong registered clients, SDK refresh and a subsequent real read. A further real-HTTP red reproduced a second old-A access-JWT revocation returning 400 after reconnect B. Its green regression verifies an authenticated repeated 200 across provider restart, B refresh and read, wrong-client no-op, unknown-client authentication enforcement, and tampered-token refusal. The later restore-epoch increment makes `authorizationEpoch` a required factory option.

The integrated tests exercise the real provider, SDK v2, SQLite and disposable real Snapback accounts, including healthy empty identity, initialized identity, independent concurrent clients, private reauthentication, account switching, consent denial, origin/host/CSRF/redirect refusal, S256, code replay, wrong verifier/resource, separate notes permission, both token-revocation forms, expiry, unchanged read-only upstream authority, stable reconnect lineage, and a fresh Node process reopening the encrypted credential and signing keys. Fixtures are short lived and removed; no production accounts or writes are used.

M13c extends that actual HTTP fixture with a configured lifecycle hook. Its focused red failed at SDK DCR with `invalid_scope` for `checkins:write`. The green path proves zero full-session custody after write-request sign-in, fresh matching credentials only on the CSRF-checked consent POST, wrong-password/account/Origin refusal, full scope and independent encrypted grant custody, a synthetic full-session mutation, a configured read consent retaining read-only authority, and a fresh Node process reopening the full grant without rotation. Revocation cases assert the coordinator sees the exact frozen grant before cutoff, failures do not claim revocation, provider-session deletion does not recurse, and repeated old refresh/access revocation leaves a same-client reconnect and another full grant usable. Review regressions reproduced a live full vault orphan on grant INSERT failure and a live full token after OAuth-scope drift. The owned green tests now cover both, plus a child process killed immediately after vault custody and fresh-process cleanup of its inactive grant. The upstream-expiry case refuses MCP admission and refresh without silently obtaining another full session. These tests do not establish the account worker's durable barrier or mixed-queue behavior; those require the separate delivery integration and parent composition.

The restore regression in `tests/http-auth-restore.test.ts` uses the official SDK, actual HTTP, disposable Snapback accounts and provider/vault SQLite snapshots taken before grant A cutoff. Before the fix, restoring those snapshots made A's old access token authenticate again. The green test refuses old access, refresh, unexchanged code, pending consent, browser owner identity and full resume after an epoch change. It admits a fresh verified read connection in degraded mode and refuses write consent. An injected Snapback logout outage leaves A's upstream bearer live but local cutoff durable; the private row records retirement uncertainty. A later exact-session logout retires only its selected session. The separate physical marker tests and parent restore controller own marker durability and restore ordering.

The M13c write consent markup was rendered at 390 px and 1024 px in light and dark styles through T3 HTML Preview. Spacing was tightened so the primary approval action is visible within an 844 px phone viewport, and all listed permissions, fields and cancel action wrap without clipping. The HTML Preview renderer required substituting the viewport-based top margin with an equivalent fixed preview margin; dark styling was applied with the same CSS variables. T3's live collaborative preview opened the page but its snapshots timed out twice, and the native browser fallback reported its browser access host unavailable. This is renderer-only inspection of the write page, not a complete live browser approval-flow walkthrough.

The earlier M07 read-only sign-in, error and consent forms were inspected in actual Chromium through the native browser fallback. That walkthrough checked 390 by 844 dark and 1024 by 768 light appearances and completed a browser form approval with canonical Origin and a 303 callback. It did not inspect the new M13c write consent page in Chromium.

Real ChatGPT and Claude application connections remain **unverified**. Published ChatGPT CIMD discovery and the synthetic SDK profiles do not prove a connector login or private-key exchange in either application. M13c implements explicit write consent and independent full-session custody. Account delivery integration, public mutation tools, connection-management UI and production deployment/rate budgets remain separate work.

### Safe coordination failures

Unexpected lifecycle-coordinator failures are translated to a fixed service-unavailable API error without an attached cause before entering the provider's exception logger. Failed coordination still refuses cutoff and leaves the grant active when no commit occurred. The actual protocol regression first captured a raw coordinator message in provider logs, then passed after this boundary was added; all thirty authorization tests remain green. Raw messages, SQL payloads or credential material must never be attached to this public/provider error.

### Live browser callback verification

The later M22 Chromium walkthrough completed read sign-in, fresh write consent, the official SDK code exchange, an acknowledged check-in, browser reward approval, an acknowledged claim, disconnect, standalone owner sign-in and explicit resume against one live disposable synthetic service. This supersedes the earlier renderer-only limitation for that flow. It is still not a ChatGPT or Claude app connection.

That walkthrough exposed a failure absent from HTTP-only tests: Chromium blocked the cross-origin client callback after consent because the page used `form-action 'self'`. Consent pages now add only the callback origin from the signed OAuth query after the maintained provider's prelogin validation. Other pages retain same-origin form targets; request-origin, CSRF, registered-redirect and PKCE checks remain in place. The thirty-case HTTP suite asserts this policy on actual consent pages, and the live browser callback then succeeded. This accounts for the [CSP form submission navigation check](https://www.w3.org/TR/CSP/#directive-form-action).

## Historical M01 feasibility proof

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
