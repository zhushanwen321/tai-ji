---
"@zhushanwen/pi-structured-output": minor
---

Gate terminal shutdown now relies solely on the graceful abort + shutdown sequence: the 15-second force-exit fallback timer is removed, along with the `TEARDOWN_FORCE_EXIT_MS` and `armForceExitTeardown` exports (requires pi 1.0.0).
