---
'@zhushanwen/pi-todo': minor
---

todo add learns stale-list auto-GC and list-scale guidance.

- **add-time auto-GC**: when every existing todo is `completed`, `add` now clears the stale list before appending the new items and resets `nextId` to 1 — starting a new task no longer leaves the finished backlog attached to it (previously the stale items lingered until the delayed 2-round auto-clear). The tool result reports the cleared count. `handleAdd` also resets `completionSteered` / `allCompletedAtCount` so a new task cycle gets its own completion quality-check steer.
- **Soft scale cap**: the recommended maximum is now 10 todos per session (`RECOMMENDED_MAX_TODOS`). When `add` pushes the total above 10, the tool result appends a reminder to consolidate fine-grained steps or delete items no longer needed. Advisory only — the call is never rejected.
- **Tool description / promptGuidelines** document both behaviors (keep the list under ~10 items; finished lists are cleared automatically on the next `add`).
