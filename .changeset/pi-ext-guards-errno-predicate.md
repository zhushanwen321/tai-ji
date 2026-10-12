---
"@zhushanwen/pi-ext-guards": patch
---

Add `isErrnoWithCode(error, code)` shared predicate: a parameterized generalization of `isEnoentError` that matches Node system-call errors by any errno code, keeping the same zero-cast narrowing discipline (`"code" in error`, no type assertions). Extension packages adopt it instead of duplicated inline error-code checks.
