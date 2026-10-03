---
'@zhushanwen/pi-subagent-workflow': minor
---

The subagent/subagents/workflow tools accept any valid absolute path as the target ref, not only `<location>` values from the injected lists — the file must exist and parse as an agent definition (`.md`) or a `@pi-meta` workflow script (`.js`); bare names and relative paths stay rejected. Display layering lands across rendering surfaces: compact tool lines and tray rows show basename short names (`worker`, `batch`), expanded/detail views keep the full ref, and workflow runs now project `scriptPath` so the GUI header shows the script's absolute path (older runs without the field fall back to `scriptName`).
