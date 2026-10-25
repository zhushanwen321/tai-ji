---
"@zhushanwen/pi-scheduler": minor
---

Due-task dispatch now routes through the unified delivery port instead of calling `pi.sendMessage` directly: each tick uses an idempotency key (`taskId:epoch`, unique per round), handles the three receipt branches of the port acceptance contract, and falls back to direct send when the port is absent. Dispatch failures are no longer silent — failed attempts are recorded as failed entries and retried on the next tick through the single retry channel.
