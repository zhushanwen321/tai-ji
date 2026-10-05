---
"@zhushanwen/pi-goal": patch
---

message_end handling now consumes only user/assistant messages, so pi 1.0.0's frequent system-message writes (tool-set changes) and malformed message shapes no longer pollute goal token accounting. Also pins the pi peer dependency range to ^1.0.0.
