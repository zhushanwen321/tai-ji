# @zhushanwen/pi-system-prompt-trace

## 0.2.0

### Minor Changes

- 8285841af: Trace entries can now carry a `presetFallback` record (from/to model ids) injected via environment keys, so a runtime-side preset fallback is visible in the system-prompt trace instead of being silent. No fallback injected means the field is absent — no false disclosure.

## 0.1.8

### Patch Changes

- a59739edb: test(guard): unify vitest data-dir guard repo-wide via test-guard factory
