---
'@zhushanwen/pi-ext-guards': minor
'@zhushanwen/pi-llm-shared': minor
'@xyz-agent/extension-protocol': minor
'@zhushanwen/pi-base-tool-enhance': patch
'@zhushanwen/pi-rename-session': patch
'@zhushanwen/pi-plan': patch
'@zhushanwen/pi-rpc': patch
---

ext-simplify-17 cross-package shared extraction (shared-layer convergence):

- ext-guards: new isRecord (array-excluding) and isEnoentError predicates,
  plus SUBAGENT_MARKER_ENV / isSubagentProcess for engine-spawned subagent
  detection (ext-simplify-17 D2/D3/D4)
- llm-shared: adopts toErrorMessage internally; new isThinkingLevel (seven
  values incl. xhigh), normalizeModelSelector, joinTextBlocks exports. Note
  for standalone pi users: llm-shared now depends on @zhushanwen/pi-ext-guards
  (runtime dependency closure grows by one zero-dep package, D1/D5/D6/D7)
- extension-protocol: new callMarkerRpc select+marker RPC primitive with
  MarkerRpcResult discriminated union and ChannelErrorResult error-shape
  single source; GuiContext.ui.select gains timeout field; firstContentText
  helper; mapReasonToStatus pending-entry mapping; plugin-bridge guard family
  moved here (token-identical). Existing type exports keep their names —
  SessionManagerErrorResult / BridgeErrorResponse are now aliases over the
  shared shape, public API unbroken (D8/D9/D10/D11)
- base-tool-enhance: adopts ext-guards toErrorMessage (13 inline sites);
  subagent detection rerooted to the engine-injected XYZ_AGENT_SUBAGENT
  marker (old PI_SUBAGENT_* keys had no injector — in-subagent background
  downgrade was dead and now works again); pending unregister entries now
  write mapped status instead of raw reason (D1/D4/D10)
- rename-session: drops local THINKING_LEVELS / normalizeModelSelector /
  joinTextBlocks / isRecord copies in favor of shared exports; three-site
  code-point truncation merged into truncateCodePoints, byte-identical
  (D3/D5/D6/D7/D13)
- plan: inline firstContentText copy replaced by protocol import (new
  dependency wiring) (D9)
- pi-rpc: ThinkingLevel whitelist gains xhigh — the :xhigh model suffix was
  silently dropped before; now accepted per pi-ai ModelThinkingLevel (P1-a)
