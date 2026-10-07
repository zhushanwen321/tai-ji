---
"@zhushanwen/pi-subagent-workflow": minor
---

Workflow runs now support runtime model switching: `/workflows resume <runId> [model]` and the workflow tool's resume action accept an optional model ("provider/modelId") that is recorded as the run's user override, drives all re-dispatched steps, and persists for later resumes. A new internal `/subagent-model` RPC command (taiji GUI channel; non-RPC invocations get a pointer notice) applies panel model switches to chat records and workflow runs, and the restored run status now folds in the effective model override.
