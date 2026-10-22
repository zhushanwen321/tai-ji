---
'@zhushanwen/subagent-core': patch
---

Reject legacy fan-out args shapes with dedicated migration messages. Legacy shapes (`tasks` elements as plain strings, or a top-level `agents` key) now fail with an explicit migration hint — naming the old shape, the mapping from `agents="/a.md,/b.md"` to per-member `agent`, and the recovery action (re-dispatch a new run with member-object tasks) — both at the ajv chokepoint (`validateRunArgs`) and as a second layer inside the fan-out workflow script for hosts that bypass validation. Rejection semantics are unchanged (schema stays the sole type authority).
