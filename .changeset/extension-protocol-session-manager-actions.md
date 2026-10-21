---
'@zhushanwen/extension-protocol': minor
---

The session-manager protocol gains two new actions, `delete` and `archive` (`SESSION_MANAGER_ACTIONS` grows from 7 to 9 entries), together with their `SessionManagerDeleteParams` / `SessionManagerArchiveParams` / `SessionManagerDeleteResult` / `SessionManagerArchiveResult` types and the `isSessionManagerDeleteParams` / `isSessionManagerArchiveParams` guards, all exported from the package entry. `ChannelErrorResult` gains an optional `code` field carrying a structured error code; the change is additive (older runtimes never emit it, older extensions ignore it): `isChannelErrorResult` accepts `code` when absent or a string, and `formatChannelErrorText` emits an extra `error_code: <code>` line only when it is present.
