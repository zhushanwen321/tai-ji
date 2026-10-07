# @zhushanwen/pi-cw-tool

## 0.6.0

### Minor Changes

- 802af968f: The cw query tool no longer applies a built-in 5-minute default timeout: queries run until they finish or the request is aborted, and a timeout only arms when `timeoutMs` is passed explicitly (requires pi 1.0.0).

## 0.5.5

### Patch Changes

- a59739edb: test(guard): unify vitest data-dir guard repo-wide via test-guard factory
