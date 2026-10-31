# verified login and identity bridge (m06b)

`services/mcp/src/auth/identity.ts` provides internal identity verification for the provider. it uses the pinned snapback4 0.4.49 password login and online client, with no expo imports or new dependencies. it does not implement oauth, browser sessions, consent, grant issuance, durable browser bindings, or credential custody. this component alone does not complete m06.

## provider api

```ts
import { createIdentityBridge, IdentityError } from '../../services/mcp/src/auth/identity';
import type { IdentityConfig, LoginCredentials, ReadSession, VerifiedIdentity } from '../../services/mcp/src/auth/identity';

type ReadSession = Session & { readonly scope: 'read' };
type VerifiedIdentity = Readonly<{
  accountId: string;
  backendUrl: string;
  principal: string;
  session: ReadSession;
}>;
type IdentityConfig = Readonly<{
  backendUrl: string;
  timeoutMs?: number;
  allowTestLoopback?: boolean;
  fetch?: typeof fetch;
}>;
type LoginCredentials = Readonly<{ email: string; password: string }>;

function createIdentityBridge(config: IdentityConfig): {
  login(credentials: LoginCredentials): Promise<VerifiedIdentity>;
};
```

the provider constructs one bridge from trusted startup configuration, for example `createIdentityBridge({ backendUrl: 'https://habits.ramimaalouf.com' })`. the url must be an https origin, optionally with one trailing slash. credentials, paths, query strings, fragments, control characters and backslashes in the url are rejected. the canonical binding uses `new URL(backendUrl).origin`, including any non-default port. redirects are refused and outgoing requests remain on that origin. passwords and bearer tokens must never be forwarded across redirects.

`allowTestLoopback: true` is only honored in a node test process with `NODE_TEST_CONTEXT`, for literal `http://127.0.0.1:<port>`. the integration test uses it only with its own temporary `startServe` host. it is not production configuration. `fetch` is a trusted transport hook used to observe real traffic and inject failures in tests; never derive it or any configuration from public request fields.

login accepts exactly `email` and `password`. extra fields such as owner, backend, principal, account id and session are rejected at runtime. password strings are transient and are not stored in the bridge, vault or returned value. javascript strings cannot be reliably zeroed; the caller must also avoid logging or retaining the login request. email is passed to snapback without changing its case and is never used to construct identity.

## verification and empty accounts

1. call the supported `login(backendUrl, email, password, { scope: 'read', ...deadline })` api. require an explicit, unexpired read session of kind `user`, including any capability expiry.
2. create a short-lived client with `{ url: backendUrl, token: session.token, readOnly: true }`. supplying only the token avoids sdk-managed rotation and shared session storage.
3. query the generated `api.profile` handle. the read-only sdk first validates the exact bearer through its supported `/probe?scope=1` gate. require a successful, fresh, complete profile query with explicit upstream completeness metadata and no cut or continuation.
4. after successful verification, require the supported `client.viewer()` authenticated identity to equal `session.principal` for every account, including empty accounts. when profile data is non-null, also require `profile.owner === session.principal`. a complete `null` profile is a healthy empty account only after the authenticated viewer matches the immutable login principal. never call `ensureAccount`, create a profile, borrow a full credential, or infer an owner from email.
5. return frozen identity and read-session values, then close the temporary client. one deadline covers login, probing, response bodies and query verification. the default is 10,000 ms; configured values must be integral and between 1 and 60,000 ms.

account ids are lowercase sha256 hex of `JSON.stringify([canonicalBackendUrl, immutablePrincipal])`, matching the m01 proof's subject derivation. they are opaque identifiers, not secrets. repeated login, email case changes and service restart preserve identity; another backend authority or principal gets a separate binding. every login requests an independently issued bearer. no email-keyed or process-wide credential cache aliases logins.

## shared auth context

### private write-consent authentication (m13b)

`createWriteIdentityBridge(config).login(credentials, expectedAccount)` is a separate trusted service API. Invoke it only after an authenticated, CSRF-checked consent POST explicitly accepts write scopes. `expectedAccount` is the existing browser's verified `{ accountId, backendUrl, principal }`; it is never supplied by a tool or selected from an email. The read bridge continues to request only read sessions and has no scope argument.

The write path obtains a fresh independent full session through supported Snapback login, then verifies that exact bearer with the documented authenticated `/probe?scope=1` response. It requires full scope, the matching principal and a bounded healthy store response before the same complete profile/viewer verification. A read bearer with forged full login metadata is refused. A different authenticated account cannot replace the browser account; its newly verified independent full credential is logged out best-effort and never returned or stored. Existing read credentials remain valid and read-only. Logout failure cannot establish authority or release a rejected credential to custody.

The caller must encrypt the returned full session under the exact consented grant and preserve its independent lifecycle. This helper does not implement consent, grant issuance, delivery authorization, scope escalation through refresh or session rotation. Fifteen actual Node/SDK/server tests pass, including a full synthetic mutation under the returned session, read refusal, account mismatch, forged scope and all prior read-identity cases. Public write activation still requires the remaining M13 integration and review gates.

`services/mcp/src/auth/context.ts` exports this exact worker contract. `Session` comes from `snapback4/auth`; `Scope` comes from `tools/contracts`.

```ts
type AuthContext = {
  accountId: string;
  clientId: string;
  grantId: string;
  principal: string;
  scopes: readonly Scope[];
  backendUrl: string;
  session: Session;
  assertActive: () => Promise<void>;
};
```

the provider constructs context from an admitted browser/grant binding and its vault credential, never from mobile credentials, tool arguments or a client-supplied identity. account/tool workers await `assertActive()` before protected work and before delivery; the provider supplies the revocation/expiry barrier. this contract supports that barrier but does not implement authentication or grant lifecycle management.

`VerifiedIdentity` is internal and includes a bearer secret. never serialize it into an oauth response, browser page, tool result or log. m07 must map the verified backend/principal/account id into the maintained better-auth external-identity integration, then bind custody to each browser/grant with explicit consent. vault insertion uses `{ backend: identity.backendUrl, principal: identity.principal, accountId: identity.accountId, grantId, scope: 'read' }` and `identity.session`. the vault rejects bearer reuse across grants; account-level token sharing is forbidden. account switching must create a distinct binding and must not overwrite an existing browser/grant credential. this helper does not obtain write authority or revoke upstream sessions when verification fails; unused read sessions expire naturally.

## safe failures and evidence

`IdentityError` exposes only a fixed message and one code, with no upstream cause, sql, response body, password or bearer:

- `INVALID_CONFIG`: invalid trusted backend or deadline configuration.
- `INVALID_INPUT`: invalid credentials shape or unexpected identity fields.
- `INVALID_CREDENTIALS`: delivered password-login auth refusal.
- `IDENTITY_INVALID`: malformed session/verification, missing explicit read scope, expired credential, invalid bearer, or authenticated-viewer/profile/principal mismatch.
- `VERIFICATION_INCOMPLETE`: partial, stale, cut or continued verification.
- `BACKEND_UNAVAILABLE`: transport failure, timeout, overload or server unavailability.

the meaningful red check used the existing m01 better-auth sign-in endpoint with a real deployed snapback server and a newly signed-up account with no profile. it returned 401 where successful identity verification required 200. the final tests exercise the production bridge directly on node 24.22.2, using real snapback signups, logins, authenticated queries and mutation refusals. success is never mocked. only failure paths alter responses or interrupt requests.

the independent-review regression changes only the empty account's login-response principal to the second account's principal. the real sdk probe still identifies the first account and its real profile query still returns complete `null`. before the viewer equality check, the bridge incorrectly returned the second account's binding and the rejection assertion failed. the corrected bridge rejects with `IDENTITY_INVALID`, while unchanged healthy empty and populated logins continue to succeed.

the suite covers healthy absence, initialized profiles, email case, distinct accounts, canonical and different backend authorities, independent login bearers, revocation isolation, read-only enforcement, forged scope/full-token substitution, owner mismatch, malformed/incomplete responses and safe network/deadline failures. fault batches restart their owned server to isolate production auth rate limits, preserving the deployed database. fixtures, clients and servers are cleaned up. no live backend or mobile credentials are used.

run the service's `bun run test`, with `MCP_NODE=/tmp/node-v24.22.2-darwin-arm64/bin/node`, plus `bun run lint` and `bun run typecheck`. provider durability, browser/cookie/csrf behavior, consent, refresh and actual grant revocation remain m07 integration responsibilities.
