# Owner connection management

M20 adds a private owner browser handler for exactly `/mcp/connections`. The handler is not an MCP tool and does not activate a public mutation route or production startup wiring. The parent composition can mount it through the existing browser `fetch` seam:

```ts
const connections = createConnectionsHandler({
  authorization,
  accounts,
  publicOrigin,
  secret: independentRandomSecret,
});
const browser = {
  fetch: async (request: Request) =>
    await connections.fetch(request) ?? confirmation.fetch(request),
};
```

`accounts` only needs `resumeDelivery`. `authorization` supplies `browserSession`, `ownerConnections`, `ownerResumeContext`, `lookupGrant` and `revokeGrant`. The secret must be at least 32 characters and independent of bearer material. The handler returns `null` for every other path. Existing provider `writeConnections.revoke` wiring remains responsible for serializing the durable account cutoff before provider grant and session fencing.

## Browser flow

Anonymous GET redirects to `/mcp/account/sign-in?return_to=%2Fmcp%2Fconnections`. Authenticated GET calls the provider's metadata-only `ownerConnections(request)` and renders the actual requesting client ID, readable permissions, credential type, active/disconnected/expired state and stored expiry. It does not load a bearer, upgrade to a full session, query product rows or mutate the queue. An ended or expired connection says to reconnect from the requesting app using the same account. This page does not rotate or refresh Snapback sessions.

Each form uses a 10-minute HMAC token bound to the fixed public origin, owner account/principal/backend, current provider browser session, exact grant ID, action, expiry and a random `HttpOnly; SameSite=Lax` cookie scoped to `/mcp/connections`. HTTPS adds `Secure`. POST requires the exact `Origin`, refuses cross-site fetch metadata, accepts only a bounded 4 KiB URL-encoded body, and rejects duplicate or unknown fields. Successful POST clears the form cookie. No GET performs a revoke or resume.

Disconnect verifies the exact owner account and grant via `lookupGrant`, then calls provider `revokeGrant`. The provider lifecycle hook performs the account-wide durable pause and serialized commit. Another grant remains valid, but cannot silently drain pending work after a cutoff. Repeating a disconnect remains a provider lifecycle decision; this page never deletes a session itself.

Resume is offered only for an active full write connection. The owner must check the explicit `all_pending` box, which authorizes that selected connection to attempt delivery of all accepted pending account work, including mixed origins, disconnected grants and read-derived facts. POST then obtains the private full `ownerResumeContext(request, grantId)` and calls `accounts.resumeDelivery(context, decision)`. The decision callback revalidates the same owner browser session and `context.assertActive()` inside the account lane. The account barrier snapshots exact queue IDs for this grant. It cannot execute another grant's prepared command or clear a restore latch. The success page says an attempt was authorized; it does not claim that every pending record was acknowledged. Recovery, reconnect and service failures use fixed text without SQL, token, account data or internal exception messages.

## Verification and limits

`services/mcp/tests/http-connections.test.ts` mounts the handler through the full HTTP service and uses real Node 24.22.2, OAuth, Snapback and SQLite. It creates pending MCP work by rejecting only the synthetic fixture backend's upload endpoint, revokes A from B's separate browser session, proves B cannot create another effect while paused, recreates the browser handler, then confirms B's explicit resume and exact journal/outbox acceptance. It also covers anonymous and no-effect GET, owner/action/grant/cookie/Origin swaps, duplicate and oversized forms, read and expired grants, restore-latch refusal and escaped client metadata. Test data is synthetic.

The author inspected a fixed-margin preview at phone and desktop sizes. The parent then served the actual current production renderer without margin changes in T3 Chromium at 390 x 844 and 1024 x 844, light and dark. Thirty-six captures cover active write/read, empty, expiry, resume, disconnect, refusal and recovery states, including scrolled phone actions. No horizontal overflow was measured. Resume is 48 pixels tall; disconnect is 50 pixels tall and remains below it. Expiry uses a readable UTC date, and consent describes related account updates in plain language. Evidence is under ignored `.artifacts/fullstack/mcp-connections/`.

Independent review accepted the bounded route, form and real HTTP proof; the parent reran all three tests after the final display-copy changes. No production endpoint or real OAuth client UI was activated here. Full process restart is covered separately by runtime composition; automatic upstream session rotation remains unimplemented, and expiry requires a fresh connection from the requesting app. A complete interactive owner browser walkthrough remains a release check.
