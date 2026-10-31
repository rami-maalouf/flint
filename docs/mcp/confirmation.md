# Browser reward confirmation

`createRewardConfirmationHandler` handles `/mcp/reward-confirmation` without a listener or product writer. Its caller mounts it after fixed-origin routing and before the authorization fallback. An unauthenticated GET redirects to the standalone owner sign-in route with only the bounded internal return path. Provider browser identity must match the quote account; an MCP bearer does not substitute for that browser session.

The page displays the escaped reward title, exact cost, quoted balance and balance-after, actual OAuth client ID, claim time zone and expiry. Insufficient or negative quoted balances do not show an approve action. Already-approved, cancelled, expired and refusal states have explicit text. Approval does not spend or reserve coins; the app must submit the bound claim, and the core checks current affordability then.

GET never approves. POST requires the fixed Origin, form content type, same-site admission, one of each allowed field, a bounded body and an unexpired HMAC CSRF value tied to the HttpOnly cookie, current provider browser session and exact quote token. A different account or quote cannot reuse the form. Cookie scope, no-store responses, a strict CSP, clickjacking refusal and strict-origin referrer policy protect the browser flow. Exact stored approval remains authenticated by the quote store.

```sh
bun build services/mcp/tests/http-confirmation.test.ts --target=node --packages=external --outfile=services/mcp/.artifacts/http-confirmation.test.mjs
/tmp/node-v24.22.2-darwin-arm64/bin/node --test services/mcp/.artifacts/http-confirmation.test.mjs
```

The actual Node HTTP/provider/SDK/Snapback/SQLite test verifies two accounts, GET with no approval, exact visible values, stored-title escaping, authenticated approval and replay, cancellation, insufficient funds, expiry, forged CSRF, account/token swaps, wrong Origin/content type, duplicate parameters and unsupported methods. Quote data is synthetic and no claim is submitted in this browser-route test. The account delivery coordinator is isolated here; its real end-to-end coverage is in the operation tests.

The first build failed because the route did not exist. Review then caught a return-path parameter mismatch: the strengthened regression failed before the fix, and now follows the exact `return_to` URL to the real owner sign-in GET. Repeated approval POST also returns the existing approved state. Fresh review accepted both corrections; the implemented test passes on Node 24.22.2.

The current production renderer was served in an owned loopback fixture and inspected in T3's Chromium at 390 x 844 and 1024 x 844, in light and dark. Twenty-four captures cover confirmation, insufficient funds, approval, cancellation, expiry and refusal. No horizontal overflow was measured; phone actions are 48 pixels tall and the primary approval begins at y=461. Evidence is under ignored `.artifacts/fullstack/mcp-confirmation/`. This is rendered page evidence, separate from the actual HTTP authentication and approval proof. A complete interactive owner sign-in continuation and production routing remain release checks; no public production route is activated here.
