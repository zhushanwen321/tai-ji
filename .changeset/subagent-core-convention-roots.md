---
'@zhushanwen/subagent-core': minor
'@zhushanwen/pi-subagent-workflow': patch
---

**@zhushanwen/subagent-core**: exports `conventionRootDirs` — the ordered convention-root path set (`~/.agents/<kind>`, `<workspaceRoot>/.pi/<kind>`, `<workspaceRoot>/.pi/<kind>/.tmp` when `includeTmp`, `<workspaceRoot>/.agents/<kind>`) derived from the same single-source helpers that `buildScanTargets` consumes for its hardcoded slots.

**@zhushanwen/pi-subagent-workflow**: the empty-state discovery-roots hint (`(none discovered; roots: ...)`) now projects the core `conventionRootDirs` derivation instead of duplicating the four convention-root joins — convention-root changes land in core only. Injector tests also hardcode the LIST_GUIDE texts as expectations, so guide copy rewrites now fail tests instead of passing silently.
