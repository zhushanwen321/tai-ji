# TODO：settings.json 损坏全局防线（store 读侧统一阻断 + JsonStore 读时隔离行为裁决）

状态：未解决——两项待裁决，须独立立项；源自 codemode 接入设计裁决项 A1「独立改进项」节（.tmp/tech-design/codemode.md，随该设计交付登记）

## 背景

settings.json 是 taiji / pi / 用户三方共享的全局配置文件（`<piAgentDir>/settings.json`，跨进程锁协议与字段域归属见 [data-source-registry §6](../architecture/data-source-registry.md)）。codemode 接入已把自己域内的读写路径收敛为损坏 fail-fast：

- 损坏检测单点 `getSettingsCorruption()`（`packages/runtime/src/infra/pi/pi-settings-store.ts`）：raw 预检直接读原文件文本 + JSON.parse，**不经 JsonStore、不触发其读时隔离改名**，结果不缓存每次现查；检测两形态——原路径存在但 JSON 非法 / 原路径不存在但存在 `.corrupt-<时间戳>` 隔离副本。
- 写点拒入：codemode 启动迁移与开关 set 进字段域写之前先查该单点，损坏拒绝写入 + 结构化告警（含路径与恢复指引）。
- 读侧错误态：`config.getCodemodeEnabled` 先查该单点，损坏返回错误态（含路径与副本提示），设置页呈错误态；修复后重试即恢复，无需重启。

该防线只覆盖 codemode 域。其余字段域（model / skills / extension / retry）与设置页其他 Section 的既有读路径仍走 JsonStore——损坏文件被它们读到时按既有行为隔离改名（`.corrupt-<时间戳>` 留底）后以回落值继续（如启动窗口内的 `cleanLeakedPackages`）。codemode 的承诺边界 = 自己的读写路径绝不触发或加速该隔离，并让用户响亮地看到损坏与修复路径；全局面不在其范围。

## 待裁决两件事

1. **store 读侧统一阻断**：损坏时所有字段域拒读、pi 会话启动全局防线。影响所有字段域与 pi 启动主链，超出单功能设计范围，须独立设计（错误传播面、启动 fail-fast 粒度、各读方降级形态、与既有「隔离后继续」行为的兼容策略）。
2. **JsonStore 读时隔离行为是否保留**：既有行为 = 读到损坏文件即改名留底 + 以回落值继续，与「损坏从严 fail-fast」哲学相悖（隔离后以回落基线继续写，是用户其他字段被合法化覆盖的通道）。与第 1 项一并裁决：统一阻断落地则阻断域内隔离行为退役，未覆盖域仍需单独裁决保留与否。

## 实现要点（届时从这起步）

- 检测原语已有单点可复用：`getSettingsCorruption()`（每次现查、检测动作自身不触发隔离）——扩展为全局防线时复用该原语，不另起第二检测实现。
- codemode 设计已登记的重审触发条件：`.corrupt-*` 隔离副本高频出现（指向预检-写入窗口竞态或其他写方损坏）时，先重审 raw 预检移入锁内或增加写后复检，再评估全局防线优先级。
