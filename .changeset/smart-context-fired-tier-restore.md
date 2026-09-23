---
'@zhushanwen/pi-smart-context': patch
---

Fired reminder tiers are now restored from session entries on startup, so compact-context reminders survive a session reload instead of re-firing from scratch; reminder follow-ups are delivered quietly without stealing focus.
