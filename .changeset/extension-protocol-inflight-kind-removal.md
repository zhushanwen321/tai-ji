---
'@xyz-agent/extension-protocol': minor
---

BREAKING CHANGE (0.x, carried as minor): the subagent in-flight report protocol drops the `kind` field. The exported type `InFlightReportKind` and constant `INFLIGHT_REPORT_KINDS` are removed, and `SubagentInFlightReport` no longer carries a required `kind` field — a frame is now `{ inFlight, sessionId?, emittedAt }`, and the `isSubagentInFlightReport` guard accepts the narrowed shape. Consumers producing or consuming in-flight frames must stop writing and reading `kind`.
