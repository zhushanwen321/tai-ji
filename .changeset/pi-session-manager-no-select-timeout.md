---
"@zhushanwen/pi-session-manager": minor
---

Session management tools (`create`/`send`/`history`/`status`/`list`/`abort`) no longer time out after 30–60 seconds: a slow runtime response resolves whenever it arrives, and the transport-failure error text now reads "cancelled or channel error" (requires pi 1.0.0).
