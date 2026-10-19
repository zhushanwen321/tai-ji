---
"@zhushanwen/subagent-engine-sdk": minor
---

Relay 通道退役、control 通道上位的公共面变更（relay-spawn-transport M3，ADR-0145）：

- 删除 `relay-env` 与 `relay-frames` 模块及其 re-export——`TAIJI_SUBAGENT_RELAY_*` env 键与 relay 帧词表（kind / dir / reject reason）不再从 SDK 导出；
- 新增 `control-env` 模块：control 通道 env 键（`TAIJI_SUBAGENT_CONTROL_SOCKET` / `TAIJI_SUBAGENT_CONTROL_ROOT_SESSION_ID`）与 transport 选择谓词 `isControlEnvActive` 的单源；
- `protocol` 面新增 control 协议词表（control 帧 / 方法）与 `ENGINE_TRANSPORT_ERROR_CODES` 族。

迁移：relay env / 帧常量的导入改指 control 面；托管态判定一律经 `isControlEnvActive`（禁各处自读 env）。0.x 版本线按 pre-1.0 惯例以 minor 记录本次破坏性表面变更（removed exports）。
