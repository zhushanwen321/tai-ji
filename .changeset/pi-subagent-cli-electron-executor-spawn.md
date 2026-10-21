---
"@zhushanwen/pi-subagent-cli": patch
---

fix: resolve task-pi spawn correctly when the engine process runs under the Electron executor

Packaged taiji spawns the engine CLI with the host Electron binary as the node
executor (ELECTRON_RUN_AS_NODE=1), so the engine process execPath is Electron,
not the pi binary. getPiInvocation's "non-node/bun execPath means pi binary"
heuristic then spawned Electron with pi CLI flags, which the node option parser
rejects ("bad option: --mode", exit 9) — every subagent/workflow dispatch failed
within milliseconds. Branch 2 now requires the execPath basename to match the pi
binary naming (npm bin or pi-<platform>-<arch>); otherwise it falls through to
`pi` on PATH, which the runtime already makes resolvable via the injected PATH
prefix.
