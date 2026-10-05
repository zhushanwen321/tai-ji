---
"@zhushanwen/pi-subagent-workflow": minor
---

Journal entries now stream to the host runtime over an ack-confirmed push channel as they are written (grouped per file), keeping live run and record views current without polling; the in-flight reporter's bounded retry loop is replaced by event-driven re-push (requires pi 1.0.0).
