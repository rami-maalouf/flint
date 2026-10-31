# Reward claim acceptance

M19 exercises the service as another local-first client of Snapback. The acceptance test in `services/mcp/tests/http-rewards.test.ts` starts an actual Snapback deployment with `deploy` and `startServe`, uses Node 24.22.2 SQLite, completes OAuth over loopback HTTP, and calls the service through the official MCP Streamable HTTP client. Its accounts and records are synthetic.

## Claim flow

1. Call `get_reward_claim_preview` with a reward ID, time zone, and new UUID v4 operation ID. The response quotes the reward version, cost, observed coin balance, balance after claim, expiry, and a confirmation URL. Preview neither spends nor reserves coins.
2. Open the confirmation URL in a browser signed in to the same account. GET displays the quote. Approval requires the form's CSRF value, the browser session cookie, a same-origin POST, and an affordable quoted balance.
3. Call `claim_reward` with the same operation ID and confirmation token. The service checks the OAuth account and client binding, prior approval, expiry, and current reward version. The core command checks affordability in its SQLite transaction. The result reports the immutable ledger entry ID, title snapshot, cost, logical date, transaction balance, and delivery state.
4. After an uncertain HTTP response, retry the same arguments and operation ID or call `get_operation`. A completed operation returns its original receipt even if the reward is later edited or deleted. Reusing that ID for another tool or other arguments is rejected.

The quote is an observation, not a coin reservation. An intervening balance change is accepted if the core transaction still has enough coins. A reward edit requires a new preview and browser approval. An expired quote also requires a new preview and approval.

## Offline economics

The product accepts two devices claiming the same previously affordable coins while one is offline. Each claim is an immutable ledger fact. When the offline device later uploads and pulls, both claims remain and the converged balance can be negative. The test verifies the exact claim IDs and mutation stamps in a second SQLite replica, accepted journal tuple hashes for the MCP claim, and the final negative ledger sum. The service does not reserve funds or promise a nonnegative balance across devices.

## Verification boundary

The acceptance test verifies OAuth HTTP pages and cookies, the confirmation GET and CSRF POST, the official MCP SDK transport and tool catalog, real Snapback delivery, and SQLite convergence. It does not automate a rendered browser GUI or connect a real ChatGPT account. Real client compatibility and rendered confirmation states require their separate browser and client verification tasks. The test sends no personal account data to the backend.
