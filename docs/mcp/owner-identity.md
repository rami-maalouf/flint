# Owner browser identity seam

The provider serves a standalone `GET` and `POST` at `/mcp/account/sign-in`. This page is for an owner opening connections or a reward quote in a browser. It does not use the OAuth signed query, issue an MCP grant, mint a full Snapback credential, or place a pending credential in the vault.

The GET accepts no query parameter except one `return_to`. When omitted, it defaults to `/mcp/connections`. The only other return is `/mcp/reward-confirmation?token=<opaque quote>`, where the token is bounded to 32 through 4096 URL-safe characters. The provider requires the canonical relative spelling and one token, rejecting external URLs, encoded path changes, fragments, duplicate keys and extra parameters. The form carries that return path in a hidden field. Its ten-minute CSRF signature binds the path, expiry and a separate HttpOnly, SameSite=Lax cookie. POST requires canonical Origin, rejects cross-site Fetch Metadata, requires form encoding, bounded body and fields, and one value for each expected field. The return path is validated again before authentication. A successful POST returns 303 to that exact relative path and copies the supported Better Auth session cookie. Bad credentials render a visible error without creating browser authority.

The supported `createAuthEndpoint` plugin calls the existing read identity bridge, verifies the Snapback principal and account mapping, creates a Better Auth user only when needed, creates a fresh browser session, and uses `setSessionCookie`. It does not stage the transient read credential. Signing into a different account changes the browser cookie but does not delete independent OAuth grant sessions. The private plugin endpoint is not directly routed to callers.

## Private provider API

```ts
ownerConnections(request: Request): Promise<readonly Readonly<{
  grantId: string;
  clientId: string;
  scopes: readonly string[];
  active: boolean;
  credentialScope: 'read' | 'full';
  expiresAt: number;
}>[]>;
ownerResumeContext(request: Request, grantId: string): Promise<AuthContext>;
```

`ownerConnections(request)` requires a current provider browser session and returns a frozen list of at most 100 frozen metadata records. `expiresAt` is UTC milliseconds.

The list is account constrained. `active` requires the grant's provider user ID to equal the verified browser account ID, plus current grant permissions, upstream custody and expiry, and the provider grant session's user and expiry. It contains no bearer, password, vault binding or provider session token. If the account has more than 100 grants, it throws `OwnerConnectionLimitError` with an explicit limit message; it does not silently truncate.

`ownerResumeContext(request, grantId)` is a private server call for the parent's owner-resume POST. It requires exact Origin, a live browser session for the same account, a current full grant whose provider user ID matches that account, write permission, a live provider grant session, and usable encrypted full custody. It returns an `AuthContext` for that exact grant, including its upstream session only inside the server process. `assertActive()` repeats the owner browser-session, grant metadata, provider-session and vault checks. The parent must perform its route CSRF and account-queue approval checks before calling this API, then keep the returned context private. It must never serialize the context or upstream bearer to HTML or a response. Existing `revokeGrant({ accountId, grantId })` remains the revocation API after the parent's same-account CSRF check.

The provider does not render the connections or reward-confirmation pages. Those routes, their CSRF checks, and owner resume approval remain with the parent. This seam only supplies the owner browser identity and exact private grant context they need.

## Verification

`services/mcp/tests/http-owner-auth.test.ts` uses real Node 24.22.2, HTTP, the official OAuth SDK, SQLite and disposable Snapback accounts. It covers safe standalone return paths, wrong credentials, CSRF, Origin and duplicate-field refusal, no grant or vault custody from owner login, account switching, account-isolated metadata, exact full-grant selection, read/cross-account denial, grant and provider-session expiry, revocation, and the 100-grant bound. No production account or real client is used.
