# M21 resource validation

The resource suite runs under real Node 24.22.2. It builds and launches the production `main.ts` executable in a child process for raw loopback HTTP probes, then uses the real SDK, Snapback proof server and `node:sqlite` for the mutation and account probes. All accounts and credentials are synthetic. Each test owns its temporary directories, HTTP sockets and child processes. The suite does not allocate or exhaust disk space.

## Reproduce

From the repository root:

```sh
bun build services/mcp/tests/resource-runtime.test.ts --target=node --packages=external --outfile=services/mcp/.artifacts/resource-runtime-test-20261030.mjs
/tmp/node-v24.22.2-darwin-arm64/bin/node --test services/mcp/.artifacts/resource-runtime-test-20261030.mjs
cd services/mcp
bun run lint
bun run typecheck
```

The test itself builds `main.ts` into a separately named ignored `.artifacts/resource-main-<pid>-<uuid>.mjs`, runs it with the test runner's Node binary, and deletes that executable in cleanup. The test bundle above is evidence output, not a committed artifact. On another host, use its verified Node 24.22.2 binary for the test runner; child processes inherit that executable path.

Cleanup is registered immediately after creating the fixture directory. The executable path and child process add independent cleanup steps before they can be used. A controlled wrong-working-directory run, with a private `TMPDIR`, still exits 1 because its build path is invalid. Before the cleanup fix it left one `mcp-resource-*` fixture; afterward it left zero. This checks failure cleanup without changing the expected build failure or touching the normal host temp directory.

Observed on macOS ARM64 with Node 24.22.2 after the cleanup fix: all five tests passed in 27.49 seconds. The executable overload case took 0.34 seconds; slow body plus SIGTERM took 11.31 seconds; dropped-stream replay took 5.26 seconds; low-disk/lock/timeout recovery took 5.06 seconds; paused-upload shutdown took 5.07 seconds. The slow-body assertion requires closure between 8 and 14 seconds around the configured 10-second incoming-request deadline. These are test wall times, not production latency targets or memory measurements.

## What is actually proved

| Boundary | Evidence | Limit |
| --- | --- | --- |
| Malicious and oversized input | A raw malformed registration body containing a private sentinel returns 4xx without echoing it; a declared 65,537-byte body returns 413. The executable's combined output contains neither the sentinel nor private key material. Existing `startup.test.ts` also checks oversized headers, header count, chunked excess, GET/HEAD framing and fixed Host. | This is representative adversarial input, not a fuzz campaign. |
| Bounded HTTP load and cleanup | Sixty-four concurrent partial POST bodies occupy the configured exchange budget; the next health request receives 503. After closing those sockets, health returns 200 and the ownership SQLite file remains present. Existing `startup.test.ts` checks the separate 128 OS connection cap and slow header timeout. | The test asserts admission behavior, not a throughput or RSS benchmark. |
| Slow body and shutdown | A one-byte trickle against a larger declared body is closed at the request deadline, and a later admitted request receives 503 after SIGTERM. The real child exits 0, stops listening and prints its fixed stopped message. | The test does not claim that a client receives a result when it disconnects during shutdown. |
| Dropped streaming response | A real authorized `tools/call` receives 200 with `text/event-stream`; the client destroys the response before reading its body. Retrying the same operation ID through the official SDK returns the durable receipt, `get_operation` succeeds, and the account's product SQLite contains exactly one check-in for that board. | The drop occurs after response headers. This proves replay after a lost response, not every possible pre-admission TCP race. |
| Low disk, busy SQLite, upstream timeout | An already bootstrapped synthetic account is denied with `UNAVAILABLE` under a deliberately impossible `minFreeBytes`, without changing the product database. A separate Node process retains an exclusive lock on `replica.sqlite`; a second process confirms the lock is effective and the account read is denied. Releasing it restores reads. A stalled injected upstream fetch is aborted at a 100 ms pull deadline, and the account reads normally after that actor closes. | Low disk is controlled admission injection, not a full filesystem. The upstream stall is a controlled fetch boundary with a real actor and retained SQLite. |
| Graceful account shutdown during a write | A real SDK check-in reaches the upstream upload with its local SQLite effect already committed. A controlled upstream pause holds that upload while actor shutdown starts. Shutdown remains pending, then the upload is released, the call returns its receipt, shutdown finishes, and SQLite still has exactly one check-in. | This exercises actor closure during the write, not the production executable receiving SIGTERM at that exact point. The separate executable test verifies SIGTERM HTTP drain. |

Existing tests add independent proofs: `http-limits.test.ts` exercises real OAuth login, registration and MCP call rate limits plus diagnostic redaction; `accounts.test.ts` covers account queue and replica caps, per-account byte caps, page budgets, cached-read fallback and a separate actor-process ownership lock; `startup.test.ts` covers process restart, duplicate owner refusal, SIGKILL lock release, SIGINT/SIGTERM and encrypted vault persistence. `operations-actor.test.ts` covers durable recovery after interrupted operations, including a child killed after a local effect. These are complementary to this suite. The executable SIGTERM and authenticated write overlap still needs a staging rehearsal.

## Remaining staging checks

On the Linux ARM64 service image, repeat the build and Node test suite with its pinned 24.22.2 binary. Measure peak RSS, CPU, file descriptors and request latency under the unit's 512 MB and one CPU limits. Verify proxy buffering, slow downstream readers, socket resets and long response cancellation through the actual TLS route. Rehearse SIGTERM while an authenticated write is held between durable local commit and upstream acknowledgement, then inspect its journal and retry on restart. Test low free space on a disposable constrained filesystem or injected mount, without filling the host disk. Confirm SQLite busy behavior on the deployment filesystem and that the service user can read the private key/latch paths while holding no broader permissions.
