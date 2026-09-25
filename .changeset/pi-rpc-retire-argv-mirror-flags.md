---
'@zhushanwen/pi-rpc': minor
---

The subagent spawn-args template no longer assembles the pi base flags: the `mirrorFlags` parameter and the `PiMirrorFlags` type are removed from `buildPiSubagentSpawnArgs`, which now never emits `--no-extensions` / `--approve` / `--extension` / `--no-context-files` — that responsibility moved to the engine-side spawn chain, which owns `extensionPaths` as an explicit protocol field. In-workspace callers are migrated in the same change; external callers passing `mirrorFlags` must drop the parameter.
