---
'@zhushanwen/pi-structured-output': patch
---

Keep test files out of the npm package: the cross-package contract test now lives under `src/__tests__/`, so the publish surface excludes that directory (the shipped file imported vitest and resolved cross-package paths that do not exist in the published tarball).
