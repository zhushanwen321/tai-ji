---
'@zhushanwen/pi-smart-context': patch
---

All smart-context notifications — compact results (success and failure), threshold reminder, and the two model_select notices (boundary crossing and downshift suggestion) — now flow through a single `sendSmartContextNotice` exit on the `nextTurn` delivery lane: they ride in with the next user prompt as custom-role context instead of starting their own run. This removes the race where a notification run contended with the user's next message and got it rejected with "Agent is already processing" — most notably right after a compaction finished. Accepted trade-off: the threshold reminder no longer takes effect while the agent sits idle; it lands with the user's next message, with pi's built-in overflow auto-compaction as the backstop. Notices stay visible in the conversation flow (`customType: smart-context`, `details.source` records the origin for troubleshooting).
