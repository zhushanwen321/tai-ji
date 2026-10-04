# @zhushanwen/pi-subagent-cli

## 0.5.0

### Minor Changes

- 0d36077d4: Writes the subagent identity env chain into spawned child processes (selfRecordId / agent / task / depth / rootSessionId / rootCwd per the SDK identity-env key table), applied after the outbound-env deny list.

## 0.4.5

### Patch Changes

- 8aa4b40e8: chore: refresh dependency range (triggered by @zhushanwen/subagent-engine-sdk@0.7.0 → @zhushanwen/subagent-engine-sdk@0.7.1)

## 0.4.4

### Patch Changes

- 50f31a73c: Subagent crash kill-chain hardening (from the 2026-09-24 kill-chain forensics: every "crash" that day was a host-side SIGTERM, and 41 of 64 kill-on-disconnect log lines were normal post-settled reaping). Exit-code folding for signal-killed children is now POSIX 128+signo (SIGTERM reads 143, matching the runtime-side view; bare 128 misled triage). The relay proxy sends a goodbye frame before exiting on host SIGTERM, so runtime logs distinguish normal teardown (info) from abnormal disconnects (warn + kill decision) — kill behavior is unchanged. The orphan sweep tiers disposal by activity: idle orphans are reaped immediately, still-productive ones are marked pending (persisted in the pid file), deferred with a 30-minute hard cap and a recheck timer, ending the restart-storm oscillation where a just-recovered subagent was reaped by the next runtime generation; re-registering a recordId also reaps the superseded live pid instead of orphaning its ledger entry. Shutdown now waits for in-flight kill chains before the runtime exits (unref timers previously died with the process, leaving SIGTERMed-but-alive children). Failure notices to the main agent carry a recovery tail that warns to check action:'list' before manually taking over (parallel recovery rounds duplicated work in the incident), and dispose-time killAll logs which still-active children it is about to kill — the previously missing first-scene evidence for host-side disconnects.

## 0.4.3

### Patch Changes

- 43a50ae2e: Test hardening: pin git locale and strip ambient relay env in baseline suites so suite results no longer depend on host locale/relay state.

## 0.4.2

### Patch Changes

- 8285841af: Restores worktree cwd conduction lost by engine protocolization: a `cwd` present on the run-context wire is now merged back into the local full task before `engine.run`. Absent `cwd` stays absent (additive wire semantics) and the engine falls back to its own process cwd, so worktree-isolated subagent sessions spawn with the intended working directory again.

## 0.4.1

### Patch Changes

- a59739edb: refactor: drop dead shells and share runtime/subagent primitives
