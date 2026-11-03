# Flint MCP server

A remote [MCP](https://modelcontextprotocol.io) server at `https://habits.ramimaalouf.com/mcp`. Assistants such as Claude and ChatGPT use it to read a Flint account and to record check-ins and claim rewards. It runs on the Oracle host, so it works while the phone is closed.

## How it works

```text
assistant --OAuth bearer--> /mcp --> tools --> account replica (SQLite, shared core) --sync--> Snapback
browser   --> /mcp/sign-in, /mcp/consent, /mcp/connections (Better Auth + Snapback sign-in)
```

- **Sign-in.** Better Auth's `mcp()` and `cimd()` plugins are the OAuth authorization server: discovery, PKCE, client ID metadata documents and dynamic registration. A person signs in with their Flint email and password; the server verifies them against Snapback and never stores the password. The browser identity is the account digest `sha256([backend URL, principal])`, the same digest the phone binds its replica to.
- **Access.** Access tokens are JWTs checked locally against the server's keys. A token also needs its consent to still exist, so disconnecting an app on `/mcp/connections` takes effect at once. Scopes: `habits:read` and `habits:write`; the consent page lets the person leave writes off.
- **Snapback session.** Each account holds one Snapback session, sealed with AES-256-GCM under a key derived from the service secret. It refreshes within two days of expiry, so connections do not need a weekly sign-in. When the last app disconnects, the session is signed out and the account's replica is deleted. If Snapback refuses the session (for example after a password change or sign-out everywhere), every connected app's refresh tokens are revoked too, so each app asks the person to sign in once more.
- **Replica.** Each account has a product SQLite database under `accounts/`, migrated and operated by the same `src/core` the phone runs. All work for an account runs in one lane. Reads pull when the last pull is older than 15 seconds. Writes need a successful pull first, run the core command, then upload. Uploads that fail are retried every five minutes.
- **Retries.** Every write takes a client-generated `operationId`. A retry is recognized from data that syncs with the account, not from server-only state: a check-in stores its derived command ID as its `idempotency_key`, and a claim's ledger ID is derived from its operation. A replica rebuilt from Snapback after a restore or loss therefore still finds the original effect, and the retry does not apply it again.

The replica is a cache of the account. The one thing it holds that Snapback does not is a write whose upload has not succeeded yet.

## Tools

| Tool | Purpose |
| --- | --- |
| `list_habits`, `get_habit`, `get_today` | Habits, streaks and the last 14 days |
| `list_stacks`, `get_stack` | Habit stacks, runs and a year of daily progress |
| `get_checkin_history` | Check-ins with notes, newest first, paged |
| `get_coin_balance`, `get_coin_history`, `list_rewards` | Coins and rewards |
| `preview_reward_claim` | Cost and balance after a claim, without claiming |
| `get_sync_status` | Whether the server copy is in sync |
| `create_checkin` | Record a check-in. A daily habit that is already done returns `created: false` |
| `undo_checkin` | Undo a check-in made by `create_checkin`, by that call's `operationId` |
| `claim_reward` | Spend coins on a reward at the version the user saw |

Claims follow the product spec: the claim rechecks the reward's version inside its transaction, refuses a balance below the cost, and accepts that offline claims on two devices can make the converged balance negative. Clients on the 2026-07-28 protocol that support elicitation get a confirmation form that states the cost and the balance after. The 2025 protocol is served statelessly, so the server cannot ask mid-call; those clients rely on `preview_reward_claim`, the tool instructions, and their own approval prompt for tools that are not read-only.

## Develop and test

Use Node 24.22.0 or later: Node 24.13.0 truncates SQLite text at NUL bytes, and the server refuses to start on it. Run `bun install` at the repository root first; it generates the typed Snapback API the server shares with the app.

```sh
cd services/mcp
bun install --frozen-lockfile
bun run typecheck
bun run test    # real Snapback dev server, real SQLite, real MCP client and OAuth flow
bun run build
```

To run it locally against `snapback4 dev --port 4490 --memory`:

```sh
FLINT_MCP_ORIGIN=http://localhost:4491 FLINT_MCP_BACKEND_URL=http://127.0.0.1:4490 \
FLINT_MCP_DATA_DIR=/tmp/flint-mcp FLINT_MCP_PORT=4491 FLINT_MCP_SECRET=$(openssl rand -hex 32) \
node dist/main.js
```

`FLINT_MCP_SECRET` (or the systemd credential `flint-mcp-secret`) signs OAuth state and seals stored sessions. Changing it signs every user out of their connected apps.

## Deploy

`ops/mcp/` holds the systemd unit, the bridge from the Traefik network, the Traefik router fragment and `deploy.sh`, which installs the committed build as a release under `/opt/flint-mcp/releases` and restarts the service. State lives in `/var/lib/flint-mcp`; `ops/backup-oracle.sh` archives it together with the backend. Restoring an older archive is safe for retries: the replicas resync from Snapback, and connected apps whose consent is newer than the archive must reconnect.

## Client support

Verified with the official MCP TypeScript SDK client 2.4.0 on both protocol eras, through the real OAuth flow. Claude, ChatGPT and other clients follow the same standard flow but are verified only when recorded in the pull request.
