---
'@zhushanwen/pi-session-reader': minor
---

`session_read` can now route into zcode engine sessions: resolves zcode session ids and record anchors (with an explicit db-path allowlist gate and a readable error surface for unsupported hosts or schema drift), reads zcode manifests directly, and includes zcode subagent nodes in family queries. Parse/header first-line primitives now come from `@zhushanwen/session-core`, keeping byte-level behavior identical.
