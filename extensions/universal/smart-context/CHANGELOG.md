# @zhushanwen/pi-smart-context

## 0.4.2

### Patch Changes

- 318994f4a: The `compact_context` tool is now always declared to the model (resident) instead of being activated only through tool_search.

## 0.4.1

### Patch Changes

- df839883b: chore: refresh dependency range (triggered by @zhushanwen/extension-protocol@0.22.0 → @zhushanwen/extension-protocol@0.23.0, @zhushanwen/pi-llm-shared@0.11.3 → @zhushanwen/pi-llm-shared@0.12.0)

## 0.4.0

### Minor Changes

- 796f01b29: compact_context 结果 details 新增 summary 收起态一行摘要，并新增 TUI 折叠态渲染。

## 0.3.9

### Patch Changes

- 7babdefa7: chore: refresh dependency range (triggered by @zhushanwen/pi-ext-guards@0.4.4 → @zhushanwen/pi-ext-guards@0.5.0, @zhushanwen/pi-llm-shared@0.11.2 → @zhushanwen/pi-llm-shared@0.11.3)

## 0.3.8

### Patch Changes

- 993ee907f: Mark compact_context exposure:deferred (it activates on a tool_search hit instead of the resident tool list) and trim its description — the three-condition self-check remains the single source of calling discipline.

  Standalone pi users: deferred tools activate via pi's built-in tool_search, which ships inactive — add `"+tool_search"` to `defaultTools` in `<agentDir>/settings.json` (the `+` prefix keeps the read/bash/edit/write defaults) before the tool is reachable; without it the tool stays invisible to the model.

## 0.3.7

### Patch Changes

- 0c4bec66e: chore: refresh dependency range (triggered by @zhushanwen/pi-ext-guards@0.4.3 → @zhushanwen/pi-ext-guards@0.4.4, @zhushanwen/pi-llm-shared@0.11.1 → @zhushanwen/pi-llm-shared@0.11.2)

## 0.3.6

### Patch Changes

- 802af968f: Pin the pi peer dependency range to ^1.0.0 (smart-context also pins typebox; stale pi implementation anchors in comments refreshed to 1.0.0). No behavior change.

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
