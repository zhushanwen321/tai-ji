---
'@zhushanwen/subagent-core': patch
---

Fix packaged-app subagent dispatch failure: session-store path derivation inside pi/engine processes no longer routes through @taiji/shared getDataDir (whose C-proc-26 admission check throws when TAIJI_AGENT_PACKAGED is stripped by the C-proc-09 outbound deny list). Store formulas now import from the new pure module @taiji/shared/session-store-paths, with the base resolved via getEngineDataDir (env TAIJI_AGENT_DATA_DIR → host dataRoot). Adds a bundle-time + postbuild machine gate (C-ext-31) that rejects any staged extension/engine bundle containing the admission-check code.

Data root migration notice: for standalone pi installs (no taiji env), the session store tree root moves from `~/.taiji-dev` to the pi agent directory (`getAgentDir()`). Records written to the old root before this change will no longer be discovered; no read-only fallback channel is introduced (the old root was the taiji dev tree, never shared with the pi instance, and a fallback would recreate a journal/store dual-root split). The taiji-hosted form is unaffected — its env (`TAIJI_AGENT_DATA_DIR` / `TAIJI_AGENT_PACKAGED`) is always injected.
