# 数据目录清理通道与保留边界（`~/.taiji/` 现行登记）

> **状态**：现行登记（2026-10-12 用户裁决收敛，[ADR-0133](../adr/decisions.md)——会话下挂内容的回收统一归删主会话级联，原五缺口登记全部关闭，本文件转为数据目录清理通道与保留边界的现行对照表）。**来源**：2026-10-03 实测盘点（体量列为该时点锚）；2026-10-11 清理执行轮；2026-10-12 级联裁决。
>
> 会话下挂内容（子代理文件族 / manifest / .events / session-view 导出物 / artifacts / attachments / cache/images / base-tool-enhance 后台任务目录）的回收 = 删主会话级联单一通道（`packages/runtime/src/services/session/session-content-cascade.ts` + `session-lifecycle.ts` purgeSessionSidecars，ADR-0133）；外部删除主会话文件场景的残留按裁决接受。非会话下挂域各有独立机制，见下表。

## 清理通道对照表

| 目录 | 体量（2026-10-03 实测） | 清理机制 | 归属域 |
|---|---|---|---|
| `logs/` | 2.7G | `apps/electron/main/logs/log-retention.ts`：保留 7 天（`TAIJI_LOG_KEEP_DAYS`），启动扫 + 每日复扫，按 mtime | main |
| `engines/<engineId>/<分组>/` | 425M | 引擎 journal 30 天 mtime TTL（`packages/subagent-core/src/execution/persistence/engine-journal-gc.ts` → `cleanupExpiredJournals`；定时器经扩展进程级维护接线：启动扫一次 + 24h 复扫） | 引擎运行证据域（ADR-0133 保留项） |
| `agent/subagents/` | 160M | 删主会话级联（子代理文件族随族删，`session-content-cascade.ts`；sidecar 名单 = `SUBAGENT_SESSION_SIDECAR_EXTS`） | 会话下挂 |
| `update/` | 131M | 版本封顶：下载登记时按版本号保留最新 3 个安装包（`preloaded-update.ts` `sweepStaleInstallers`）；升级完成/失败/回滚后 `cleanupCompletedUpdate`（`update-self-healer.ts`） | main |
| `attachments/` | 924K | 删会话级联（purgeSessionSidecars） | 会话下挂 |
| `agent/tmp/` | 256K | session-view 导出物由删会话级联删除（cascade A21 段）；tmp 目录本身无独立清扫 | 会话下挂 |
| `tts-cache/` | 6.7M | 双条件 FIFO 封顶（文件数 + 总字节，`tts-audio.ts`） | main |
| `cache/images/` | 0B | 删会话级联（purgeSessionSidecars）；main 侧另有 image-cache 孤儿扫描（`apps/electron/main/images/image-cache.ts`，main 域取舍待后续裁决） | 会话下挂 + main |
| `gen-stats/` | 224K | 30 天 GC 窗口 | main |
| `agent/sessions/` | 22M | 随会话删除（trash + sidecars 清理） | 会话本体 |
| `run/` | 16K | relay sock 启动与关闭时 unlink；checkpoint 失败件保留最近 3 份 | main/runtime |

## 裁决边界（2026-10-12，ADR-0133）

**保留项（非会话下挂域，机制维持）**：

- 引擎 journal 30 天 TTL——journal 是引擎运行证据域，record 主数据（主 session 文件里的 subagent-record entry）死亡对 core 无触发点，done record 的 journal 无精确回收锚，workflow 域（taskId 占位）同样无锚；
- zcode 隔离会话库条目 TTL 30 天（引擎侧 sweep，C-data-22；pi 侧 transcript 无独立 TTL 后两域不再有「同窗」绑定，窗口值维持）；
- workflow run 孤儿对账与统一保留维护轮（`run-state-evidence.ts` 的 `runRetentionMaintenanceRound` / `pruneTerminalRunFiles`——判据本就以主会话引用集为锚，维持现状）；
- main 域各机制（log-retention / tts-cache 封顶 / gen-stats / update 版本封顶）。

**接受残留（显式不回收）**：

- 外部删除主会话文件场景（绕过删除链路直接 rm）的下挂内容残留；
- 级联枚举/引用扫描失败时保守放弃族删除的残留（宁保留不误删 fork 共享文件）；
- worktree `.patch` 回传件（按 branch 命名、无会话锚，级联清单不含）；
- main 侧 image-cache 孤儿扫描的保留/退役属 main 域裁决，不在 ADR-0133 射程内。

## 原五缺口的关闭口径

- 缺口 1（engine journal 保留期触发）：机制收窄为 journal-only（定时器 = `startEngineJournalGcTimer`）；原 subagent 会话树清理面随裁决删除（回收归级联）。
- 缺口 2（subagent 会话文件回读窗口）：裁决前提消失——子代理会话文件生命周期 ⊆ 主会话生命周期（随族删），不存在独立回读窗口可裁；续聊锚失效走既有 reopen 降级（permanent-session-model §3.2.3）。
- 缺口 3（预载升级产物）：版本封顶已实施（`sweepStaleInstallers`，commit `c23cb01f3`）。
- 缺口 4（attachments 删除级联）：已实施（purgeSessionSidecars 的 attachments 段）。
- 缺口 5（agent/tmp 导出物清扫）：回收归级联 A21 段（export 写入点顺带清扫面随裁决删除）。
