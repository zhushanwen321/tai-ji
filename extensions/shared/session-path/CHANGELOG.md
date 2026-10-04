# @zhushanwen/pi-session-path

## 0.1.0

### Minor Changes

- 0d36077d4: New shared library `@zhushanwen/pi-session-path` — the single implementation of active-path clipping for pi session entries (walk from `leafId` up the `parentId` chain, keep only entries on the active path). The four state-rebuilding extensions (todo, plan, goal, scheduler) previously carried four isomorphic copies kept in sync only by comment discipline, and their leaf-fallback rules had already diverged (array tail vs last id-bearing entry); the copies are now consolidated here with one unified fallback: when `leafId` is missing or dangling, the leaf falls back to the last entry bearing a string id, id-less entries stay in the output under linear-file semantics, and a file with no tree info at all is passed through unfiltered. Behavior on real pi session files (every entry has an id) is byte-for-byte unchanged; runtime-side rebuild chains and the plugin readEntries projection keep their own implementations by design (extensions cannot import runtime packages).
