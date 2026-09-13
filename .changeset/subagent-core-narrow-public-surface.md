---
'@zhushanwen/subagent-core': minor
---

BREAKING CHANGE (0.x, carried as minor): public surface narrowed. The barrel export shrinks from 298 to 229 symbols, and the `./engines/zcode/reader` and `./engines/zcode/constants` subpath entries are removed — zcode engine reading now lives in the standalone `@zhushanwen/zcode-subagent-cli` package, so consumers of those subpaths must import from its main entry instead. A new `./engine/engine-discovery-scan` subpath entry exposes engine discovery scanning (alongside the existing `./engine/paths`, `./relay-env`, `./workflows/*`). Consumers importing removed barrel symbols must switch to the remaining declared entries or own the logic locally.
