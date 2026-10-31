# Client compatibility

Checked 2026-10-30. The supported connection surface is remote HTTP MCP at `https://habits.ramimaalouf.com/mcp`. Deployment activation and public TLS evidence belong to the release record; local integration tests do not establish that deployment.

| Client or boundary | Exact tested profile | Evidence and limits |
| --- | --- | --- |
| Official TypeScript client 2.4.0 | Streamable HTTP, protocol `2026-07-28`, public DCR, S256 PKCE, resource-bound access token | Actual discovery, fifteen-tool listing, scoped reads, denied scope, refresh/reconnect, check-in/undo, browser-approved claim, durable replay and second-replica convergence. |
| Official TypeScript client 2.4.0 legacy negotiation | SDK legacy mode, protocol `2025-11-25` | Actual ten reads and reward preview, scope isolation, strict input errors and continuation. Claim acceptance is demonstrated with the current protocol; no older application release was installed. |
| T3 Code Beta 0.1.2 browser | Chromium 152.0.7977.167, Electron 44.9.3, macOS | Live sign-in, fresh write consent and SDK callback, wrong-password refusal, exact-cost approval, disconnect, independent owner sign-in and explicit resume. Browser pages were inspected at 390 and 1024 CSS pixels in light and dark. This tests the browser leg, not a T3 MCP connector. |
| ChatGPT | Published CIMD profile and public metadata tested by the M01 proof | Discovery and authorization-code issuance passed. Private-key token exchange and a real ChatGPT connection remain **unverified**. No client access or user login is implied. |
| Claude | Hosted callback registration profile checked by the M01 proof | A real Claude connection remains **unverified**. No installed app version or end-to-end connector result is claimed. |
| Other clients or protocol revisions | Not exercised | **Unverified**. No universal compatibility claim. |

Use the client application's remote MCP connection UI and the endpoint above. Sign in privately with the existing Habit System account. Start with `habits:read` and `coins:read`; notes require separate `habits:notes:read`. Deliberate check-ins require `checkins:write`. Reward claims also require `rewards:claim` and a one-operation approval through the displayed confirmation URL. Write consent requires a fresh matching credential proof and issues independent full-session custody. Never place a password or token in chat.

Refresh does not extend an expired upstream Snapback session. An ended or expired connection requires reconnecting with the same account. The connections page shows expiry and supports disconnect. Resuming a paused mixed queue requires an explicit owner decision under a live write connection; it cannot override a restore fence. Concurrent offline reward claims can converge to a negative balance, as specified by the product.

Reproduce the synthetic protocol checks from `services/mcp`:

```sh
MCP_NODE=/path/to/node-v24.22.2/bin/node MCP_PROOF_PUBLIC_CIMD=1 bun run test:protocol
```

The live browser fixture and captures are ignored local evidence under `.artifacts/fullstack/mcp-live-browser/`. Its credentials and authorization URLs are disposable and are not tracked. Automated cases live in `tests/http-auth.test.ts`, `http-reads.test.ts`, `http-mutations.test.ts`, `http-confirmation.test.ts`, `http-rewards.test.ts`, `http-owner-auth.test.ts` and `http-connections.test.ts`.
