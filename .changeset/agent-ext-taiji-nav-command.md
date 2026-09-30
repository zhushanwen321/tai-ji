---
'@zhushanwen/pi-agent-ext': minor
---

Register the `__taiji_nav__` internal command: the taiji runtime's message-revoke orchestration now rewinds the session tree through `client.prompt('/__taiji_nav__ <entryId>')` — synchronous, no model turn, no tree summary, and a `taiji:revoked` label entry lands on disk so the rewind survives restart. The double-underscore prefix keeps it out of slash menus (front-end filters `/__` commands). This restores the session-tree navigation capability removed 2026-08-31 (ADR-0008), returning under the message-revoke design (ADR-0076 D1) with the runtime revoke orchestration as its consumer.
