# settings.json 损坏全局防线：读侧统一 fail-fast + pi 会话启动门禁（已交付）

状态：已交付（2026-10-05 用户终裁：settings.json 损坏一律 fail-fast，唯一路径——「这是核心配置，损坏就不应该能启动 pi」；读侧统一阻断 + 启动门禁 + 写侧预检入锁全部落地，本登记关闭）。

## 现行机制

settings.json 是 taiji / pi / 用户三方共享的核心配置（`<piAgentDir>/settings.json`，跨进程锁协议与字段域归属见 [data-source-registry §6](../architecture/data-source-registry.md)）。损坏判定单点 `getSettingsCorruption()`（`packages/runtime/src/infra/pi/pi-settings-store.ts`）：每次现查（无缓存），直接读原文件文本 + JSON.parse，检测动作自身不触发隔离；检测两形态——原路径存在但 JSON 非法 / 原路径不存在但有 `.corrupt-<时间戳>` 副本。

四道防线共用这一个判定单点：

| 防线 | 落点 | 行为 |
|------|------|------|
| 读侧统一阻断 | `readSettings()` 读前现查 | 损坏抛 `SettingsCorruptedError`（code `settings_corrupted`，message 含路径与修复指引）；预检与读盘间的并发改坏竞态由 JsonStore `corruptReadPolicy:'throw'` 堵住后统一转译——settings 读取路径零隔离、零回落。settings 之外的 JsonStore 消费方隔离行为不变（机制默认值仍 `quarantine`） |
| pi 会话启动门禁 | `process-manager.createSession`（唯一 spawn 入口：创建 / 恢复 / 崩溃重生 / 重启重连 / fork / 短命附着） | spawn 前现查，损坏零副作用拒绝（进程未启动、错误信封含路径与指引）；已运行会话不受影响 |
| 写侧拒入 | `updateSettingsFields` 锁内首行预检 | 损坏抛 `SettingsWriteRejectedError`；启动写点（`cleanLeakedPackages` / codemode 启动迁移）拒写 + 结构化告警，不阻塞启动，修复后重启自动补跑 |
| 消费方转译 | codemode `getEnabled`/`setEnabled`、config-service skills 迁移 | 判错误码（`errorCodeOf`）转译为各自既有错误态信封 / 结构化告警；错误文案单一来源组装于错误类构造处 |

## 恢复路径

修复或删除 `<piAgentDir>/settings.json`（原内容可从 `.corrupt-*` 副本找回），然后：运行中的 runtime 下次 pi spawn 自动放行（现查语义，无需重启）；启动写点重启后自动补跑。

## 重审触发

`.corrupt-*` 副本高频出现（指向预检-写入窗口竞态或其他写方损坏）时，先重审写侧预检时点，再排查其他写方损坏源。
