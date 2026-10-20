---
'@zhushanwen/subagent-core': patch
---

Fix packaged-app subagent dispatch failure: session-store path derivation inside pi/engine processes no longer routes through @taiji/shared getDataDir (whose C-proc-26 admission check throws when TAIJI_AGENT_PACKAGED is stripped by the C-proc-09 outbound deny list). Store formulas now import from the new pure module @taiji/shared/session-store-paths, with the base resolved via getEngineDataDir (env TAIJI_AGENT_DATA_DIR → host dataRoot). Adds a bundle-time + postbuild machine gate (C-ext-31) that rejects any staged extension/engine bundle containing the admission-check code.
