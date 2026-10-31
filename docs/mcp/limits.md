# M21 limits and diagnostics foundation

`services/mcp/src/limits.ts` is an in-memory admission primitive for the single-owner MCP process. It does not open a listener or read request headers. `services/mcp/src/diagnostics.ts` builds a redacted event and calls only the sink supplied by its caller. Neither module performs work on import.

## Exact default limits

| Admission kind | Sliding window | Default maximum |
| --- | --- | ---: |
| `login` | Global, 60 seconds | 30 |
| `registration` | Global, 1 hour | 30 |
| `token` | Global, 60 seconds | 300 |
| `mcp` | Per verified grant UUID, 60 seconds | 120 |
| `mcp` | Global, 60 seconds | 600 |
| All kinds combined | In-flight requests | 16 |
| Per-grant window map | Distinct active grant windows | 4096 |

`token` covers token issue, refresh and revoke. The global login and registration counters deliberately have no client identity or IP partition. This can limit unrelated users during a burst, but avoids relying on untrusted `Forwarded` or `X-Forwarded-For` values. All rate counters count successful admission once. Rejected requests do not consume a rate token. Released concurrency slots do not refund rate admission. Timestamps expire after the complete window, and the grant map removes expired entries when capacity is needed. A full map with 4096 unexpired grant windows refuses a new grant; it never evicts a valid counter to bypass the rate limit.

## Integration contract

Create one `ServiceLimits` instance per service process. Call `enter(kind)` at the corresponding login, registration or token admission point. After bearer verification, call `enter('mcp', context.grantId)` using the authenticated grant's opaque UUID. Canonical UUID versions 1 through 8, including v7, are accepted and case-normalized for the rate bucket; this check does not verify the grant. Do not derive a key from a forwarded IP, account name, email, title, password, bearer text, or request body. Unknown kinds and malformed or misplaced keys are refused. The parent must identify the precise routes and avoid counting the same request twice.

`enter` returns a release function. Call it in `finally` for success, error, connection close and cancellation, and release exactly when the work actually stops. The release function is idempotent. `LimitedRequestError` has a fixed public message and `code: 'RATE_LIMITED'`; its positive integer `retryAfterSeconds` can be sent as the `Retry-After` header with HTTP 429. A concurrency or map-cap refusal uses one second because completion time is unknown. Never include a key or raw error in the response. Constructor options and overrides must be own data properties; accessors and unknown fields are rejected without reading them. Overrides can only lower the exported defaults and must be positive safe integers; `now` supports a deterministic clock in tests. The clock is clamped against backward movement to avoid replaying expired capacity.

For diagnostics, generate the request UUID on the server and pass only `{ requestId, durationMs, operationId?, tool?, errorCode?, delivery? }` to `recordDiagnostic(input, sink)` or `buildDiagnostic(input)`. The builder snapshots own data properties once and rejects accessors, unknown fields, invalid UUIDs, unknown contract tool names, unknown public error codes or delivery states, and durations outside 0 to 600000 milliseconds. It returns a frozen object containing only those fields. The sink belongs to the caller and should serialize that object only. Do not pass a raw exception, tool arguments, SQL, response body, title, note, balance, password or token. No diagnostic sink is registered automatically.

## HTTP integration

`createHttpService` owns one default limiter, or accepts a supplied `limits` instance for lower tested caps. Before dispatch, sign-in and consent POSTs use `login`, registration POSTs use `registration`, and other authorization/browser requests plus MCP bearer verification use `token`. This latter bucket also bounds discovery and owner-page traffic. Tool execution separately uses `mcp` with the verified grant ID; bearer verification releases its slot before tool work starts. Route and tool releases run in `finally`. Public refusals return fixed HTTP 429 with `Retry-After`; tool refusals return the structured `RATE_LIMITED` contract.

An optional `diagnostics(event)` sink receives only validated server request IDs, successful operation IDs, known tool names, duration and error/delivery enums. Failed arguments and raw exceptions are never passed to the sink. Sink failures cannot alter a committed operation's response. Production startup supplies a JSON-only sink; the HTTP module performs no logging by itself.

`tests/http-limits.test.ts` uses actual OAuth, the official MCP HTTP SDK, Snapback and SQLite. Its initial third call incorrectly succeeded before admission was wired. The passing regression verifies structured call-rate refusal, public login and registration 429 responses, positive retry headers, and absence of credentials and private arguments from diagnostic events. Registration uses a valid HTTPS web-client callback profile.

## Evidence and remaining M21 work

`services/mcp/tests/limits.test.ts` runs actual local Node HTTP requests against a small harness using the primitive. It proves 429 and `Retry-After`, an in-flight cap, cancellation and failure cleanup. Unit cases prove every window, global and per-grant behavior, capacity fail-closed behavior, invalid input refusal and diagnostic privacy. Existing startup body, header, socket and shutdown bounds, and separate account/disk controls are tested in their respective suites. Independent HTTP review accepted admission and redaction. The later [process resource proofs](resource-validation.md) cover occupied exchanges, slow bodies, lost streaming responses, controlled low-disk admission, busy SQLite, upstream deadlines and write drain. Linux measurements and the combined executable SIGTERM/write rehearsal remain staging checks.
