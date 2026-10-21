---
'@zhushanwen/pi-session-manager': minor
---

Adds two new session tools: archive_session tidies a finished session into the user-reversible archive area (safe to call on the agent's own initiative), and delete_session permanently removes a session with all its derived data (strictly user-initiated only); all tools also gain concise prompt snippets and richer descriptions with examples and stale-id recovery guidance.
