---
"@zhushanwen/subagent-core": minor
---

补齐 staged 引擎 cli 形态的翻译面缺口（ADR-0142）：引擎 manifest 新增可选 modelTranslation 段，RemoteEngine 按声明装配/摘除 translateModelRef 成员（纯查表改写，与 capabilities/modelCatalog 同款注册期快照模式）——此前该成员仅在 in-process 引擎类实装，桌面端派发层翻译整体静默失效，偏好层死值直穿引擎侧报错；派发层编排新增生效回执：翻译面缺席按引擎一次告警，不再静默。

**BREAKING（relay 通道退役，ADR-0144 M3）**：删除 `./relay-env` 公开子入口——`package.json` 的 `exports` 与 `publishConfig.exports` 同步移除，`src/execution/relay-env.ts` 删除。迁移：relay env 键 / 帧词表改用 `@zhushanwen/subagent-engine-sdk` 的 `control-env` 与 `protocol` 面；引擎 spawn 权收归 runtime control server（standalone 走 local transport，选择谓词 = SDK `isControlEnvActive`）——仍在经 core `./relay-env` 子入口导入的消费方须改为从 SDK control 面导入。
