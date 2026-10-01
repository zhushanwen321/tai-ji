# @zhushanwen/pi-smart-context

## 0.3.5

### Patch Changes

- 0d36077d4: All smart-context notifications — compact results (success and failure), threshold reminder, and the two model_select notices (boundary crossing and downshift suggestion) — now flow through a single `sendSmartContextNotice` exit on the `nextTurn` delivery lane: they ride in with the next user prompt as custom-role context instead of starting their own run. This removes the race where a notification run contended with the user's next message and got it rejected with "Agent is already processing" — most notably right after a compaction finished. Accepted trade-off: the threshold reminder no longer takes effect while the agent sits idle; it lands with the user's next message, with pi's built-in overflow auto-compaction as the backstop. Notices stay visible in the conversation flow (`customType: smart-context`, `details.source` records the origin for troubleshooting).

## 0.3.4

### Patch Changes

- 43a50ae2e: chore: refresh dependency range (triggered by @zhushanwen/pi-llm-shared@0.9.0 → @zhushanwen/pi-llm-shared@0.10.0)

## 0.3.3

### Patch Changes

- 8285841af: Fired reminder tiers are now restored from session entries on startup, so compact-context reminders survive a session reload instead of re-firing from scratch; reminder follow-ups are delivered quietly without stealing focus.

## 0.3.2

### Patch Changes

- a59739edb: feat(smart-context): change default reminder thresholds to 400K/500K/600K
