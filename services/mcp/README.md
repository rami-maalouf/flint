# Habit System MCP service

This is the app-owned remote MCP service boundary. Install its dependencies separately from the mobile application. The authoritative service lock is `bun.lock` in this directory. The root package and its AJV 6/native Snapback patch remain independent.

Use Bun **1.4.3** for package management/builds and Node **24.22.2** for execution. Node 24.13.0 corrupts embedded-NUL SQLite TEXT reads; production adapters refuse it. Do not execute the service through Bun's SQLite emulation.

```sh
bun install --frozen-lockfile
bun run lint
bun run typecheck
bun run build
MCP_NODE=/absolute/path/to/node24.22.2 bun run test
MCP_NODE=/absolute/path/to/node24.22.2 bun run test:integration
MCP_NODE=/absolute/path/to/node24.22.2 MCP_PROOF_PUBLIC_CIMD=1 bun run test:protocol
```

Run those commands from `services/mcp`. Tests compile into private ignored `.artifacts` files, execute on real Node, and clean their generated test entry points. Independent runs use distinct filenames. Unit, integration and protocol commands select different suites; the protocol suite includes the actual SDK/provider proof. Public CIMD tests are explicitly skipped unless opted in. `bun run test:coverage` enables Node's coverage report across all suites.

`src/core.ts` is the shared-core runtime boundary. Its Node bundle contains the existing domain, migration, sync and injectable transport implementations, without Expo or React runtime imports. Each request gets its own immutable clock and zone. The dependency graph test checks the actual build metadata and loads its artifact on Node. The HTTP server entry will replace this build entry when the authenticated vertical slice is integrated; this foundation alone does not expose an endpoint.

Clean Linux ARM64 evidence was collected in the private isolated `/home/ubuntu/habit-mcp-proof-20261030/source` directory on Oracle. A checksum-verified private Node 24.22.2 binary and existing Bun 1.4.3 ran frozen service installation, the 94-module build, lint, strict typechecking and all 25 foundation unit tests. The minimal proof used only shared core, generated API and this service's pinned dependency graph, without installing Expo. No production service, listener or routing changed. macOS archive metadata was removed from this disposable staging copy before linting; it is not source.

The server is single-process by design. Deployment, credential keys, OAuth/grant lifecycle, recovery fencing, browser pages and production routing require their own integration gates. Operational configuration must fix the canonical backend/resource/issuer and keep state and key recovery private. Do not connect a real account or publish mutation tools from an unverified partial build.

Contracts and proof boundaries are recorded in `../../docs/mcp/`. The current implementation ledger is `../../tasks/mcp-todo.md`. Full release acceptance requires all listed tools, synthetic HTTP/client/convergence/recovery evidence, independent review and the staging/backup gates.
