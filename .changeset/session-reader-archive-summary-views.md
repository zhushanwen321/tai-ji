---
'@zhushanwen/pi-session-reader': minor
---

session_read now recognizes archived sessions: referencing an archived session by name or id fragment returns a summary-only view marked as archived (built from its plain-text ledger without decompression) instead of "no match", with archive hints added to find/doctor output; environments without an archive directory behave exactly as before.
