---
'@zhushanwen/pi-session-reader': minor
---

Teach session_read to discover and overview workflow runs recorded in the new v2 record-stream format: workflow refs now resolve through a three-tier entry chain (v2 workflow-record journal anchor > v1 snapshot > legacy workflow-state-link pointer), `.record.jsonl` streams are parsed directly into run overviews with three-state status (running | interrupted | done), and zcode session anchors additionally accept v2 settled subagent-record entries while keeping v1 snapshot reads compatible.
