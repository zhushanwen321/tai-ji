---
'@zhushanwen/pi-goal': minor
---

The goal engine's status machine is now declared via `@zhushanwen/state-machine` instead of the hand-written adjacency table. **Breaking for direct importers: the exported `VALID_TRANSITIONS` constant was removed from the goal engine — the state machine declaration is the single source of truth for legal transitions.** The public `transitionStatus` wrapper keeps its signature and behavior: identical legal transitions, identical throw (same message) on out-of-table transitions. Users interacting only through the `/goal` command see no change.
