---
'@zhushanwen/subagent-engine-sdk': minor
'@zhushanwen/pi-subagent-workflow': patch
---

New `relay-frames` module exports the relay channel frame vocabulary as the single source: `RELAY_FRAME_KINDS` (handshake/accept/reject/data/exit), `RELAY_FRAME_DIRS` (down/up/up-stderr), and `RELAY_REJECT_REASONS` (version/identity/duplicate/malformed), plus derived union types. The runtime relay registry previously spelled these sixteen frame literals inline at construction and comparison sites — the runtime side now imports the constants, and the zero-dependency relay.mjs proxy keeps its embedded literals but gains conformance assertions locking every protocol point (frame construction, negotiation comparison, pump direction, exit) to the SSOT values, closing the gap where the env-constant family had a static lock while the frame vocabulary relied only on end-to-end behavioral tests.
