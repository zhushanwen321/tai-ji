---
'@zhushanwen/pi-subagent-workflow': patch
---

Refactor: converge the duplicated tool-interface plumbing in `src/interface/` — the RPC-mode `__gui__` attach (now the single `withGuiAttach` helper in `tool-shared.ts`), the prefixed catch re-throw (`throwPrefixed`), and the expanded/compact render branches (non-list expanded output now reuses `buildCompactLines` byte-for-byte). The `workflow-script` tool result now uses the shared `WorkflowToolResult` base instead of a local `TextContent` interface, and `AdapterInput` is exported for type-only test imports. No user-visible behavior change: error messages, rendered output, and GUI payloads are byte-identical.
