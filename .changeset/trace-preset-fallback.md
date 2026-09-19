---
'@zhushanwen/pi-system-prompt-trace': minor
---

Trace entries can now carry a `presetFallback` record (from/to model ids) injected via environment keys, so a runtime-side preset fallback is visible in the system-prompt trace instead of being silent. No fallback injected means the field is absent — no false disclosure.
