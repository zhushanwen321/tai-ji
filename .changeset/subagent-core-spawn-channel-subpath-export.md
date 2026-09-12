---
'@zhushanwen/subagent-core': minor
---

Add controlled subpath export `./spawn-channel` exposing the shared pi process-channel primitive facade (LF line reader, response id router, stdin command writers with EPIPE accounting, kill chain, get_state client/handshake, and the SpawnChannelPolicies four-dimension strategy contract). Consumers (notably the runtime) can now depend on the single shared implementation instead of maintaining a parallel copy of the same primitives (design: subagent-agent-end-recovery D4, unit U7b). Workspace TS consumers resolve to `src` via the `import` condition; npm CJS consumers resolve to `dist` via `require` (same dual-form mapping as the existing semantic subpath entries).
