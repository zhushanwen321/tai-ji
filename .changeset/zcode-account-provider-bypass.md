---
"@zhushanwen/zcode-subagent-cli": minor
---

Fix reasoning-level resolution for registry models whose catalog rules use lowercase stems (match case-insensitively — GLM-5.3-Flash was rejected with reasoning-level-not-supported) and let an explicit thinking level pick within the catalog value domain. Allow `account:*` model refs for engine dispatches: the app-server launcher injects `entitled:true` for zhipu-account builtin entries and neutralizes the external-spawn account gate in the CLI bundle (in-memory, no files touched), so plan-family account providers (e.g. account:zai-individual-coding-plan) load into the registry.
