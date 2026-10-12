# 数据目录累积物清理缺口（`~/.taiji/` 实测盘点）

> **状态**：缺口 1/4/5 已修（2026-10-11 快速清理执行轮，机制描述见各缺口段「现状」）；缺口 3 已修（2026-10-12 用户裁决版本封顶方案并实施，机制见缺口段「现状」）；缺口 2 待用户裁决（30 天回读窗口是否匹配产品期望）。**来源**：2026-10-03 实测盘点（用户提问触发，feat-chat-html-support 会话）；2026-10-04 D2 一致性审查反哺更正（证据见各缺口现状段）；2026-10-11 清理执行轮修复缺口 1/4/5。本文件为这 5 项的单一登记处。
>
> **与 AGENTS.md 的关系**：修复时若触及 runtime/主进程清理逻辑，按常规流程走（不阻塞）。**与 chat-html-support 设计的互指**：该设计新增的会话产物目录（`<dataDir>/artifacts/<sessionId>/`）属「已设计清理」一侧（删会话级联删除 + 超龄保留期扫描，默认 7 天），与本登记的 5 项同类缺口（数据目录累积物）互为参照——本文件是数据目录累积缺口的单一登记处，见 [ADR-0118](adr/decisions.md)。

## 实测数据（2026-10-03）

| 目录 | 体量 | 文件数 | 内容 | 清理机制 | 判定 |
|---|---|---|---|---|---|
| `logs/` | **2.7G** | 286 | `pi-relay-*` 2.0G/216 · `pi-*` tee ~0.7G/46 · `renderer-console-*` 8.4M · `runtime-*` 6.3M · `renderer-error-*` 5.6M · `main-*` 208K | `apps/electron/main/logs/log-retention.ts`：保留 7 天（`TAIJI_LOG_KEEP_DAYS`），启动扫 + 每日复扫，按 mtime | ✅ 有清理（超龄 0 个）；**体量观察**：7 天窗口 ≈2.7G ≈ 390MB/天 |
| `engines/pi/shared/` | **425M** | 124 | `journal-sa-*.jsonl`（子代理 run journal，单文件最大 12M），最旧 2026-09-24 | **有**：`packages/subagent-core/src/execution/persistence/session-file-gc.ts` 的 `cleanupExpiredJournals`（30 天 mtime TTL；确定性触发，见缺口 1） | ✅ 已修（缺口 1：触发确定性化） |
| `agent/subagents/` | **160M** | 1544 | 子代理会话 JSONL（按 cwd 分目录），最旧 2026-09-22 | **有**：同文件 `walkAndClean` → `cleanExpiredJsonl`（30 天 mtime TTL + `.alive` 探活豁免；确定性触发，见缺口 1） | ⚠️ 缺口 2（待用户裁决：TTL 与期望回读窗口是否匹配） |
| `update/` | **131M** | 5 | 预载 DMG `TaiJi-0.10.11-mac-arm64.dmg` 137MB + `pending/preloaded-update.json` + `update-error.log` | 版本封顶清扫：每次下载登记时按版本号保留最新 3 个安装包（`preloaded-update.ts` 的 `sweepStaleInstallers`）；升级完成/失败/回滚后 `cleanupCompletedUpdate`（`update-self-healer.ts`） | ✅ 已修（缺口 3） |
| `attachments/` | 924K | 25 目录 | 粘贴图片（按 sessionId 分目录） | **有**：删会话级联 `rmSync(recursive, force)`（`session-lifecycle.ts` 的 `purgeSessionSidecars`，见缺口 4） | ✅ 已修（缺口 4） |
| `agent/tmp/` | 256K | 1 | `session-view-01a0d292-….md`（**2026-09-24**，260KB） | **有**：30 天 mtime 保留期，export 写入时顺带清扫（`session-reader/src/tool-handler.ts` 的 `sweepExpiredSessionViews`，见缺口 5） | ✅ 已修（缺口 5） |
| `tts-cache/` | 6.7M | 2 | WAV 缓存 | 双条件 FIFO 封顶（文件数 + 总字节，`tts-audio.ts`） | ✅ |
| `cache/images/` | 0B | 0 | toolResult 图片缓存 | 删 session 时级联 `rmSync`（`session-lifecycle.ts`） | ✅ |
| `gen-stats/` | 224K | 21 | ttft/speed/cache-ratio 日文件 | 30 天 GC 窗口 | ✅ |
| `agent/sessions/` | 22M | 55 | 主会话 JSONL | 随会话删除 | ✅ |
| `run/` | 16K | — | markers / checkpoint / sock / children pid | relay sock 启动与关闭时 unlink；checkpoint 失败件保留最近 3 份 | ✅ 大体有（崩溃后 marker/sock 可能残留） |

**放大效应（跨缺口观察）**：同一次子代理执行的数据落在三处——`agent/subagents/*.jsonl`（会话）+ `engines/pi/shared/journal-sa-*.jsonl`（引擎 journal）+ `logs/pi-relay-*.jsonl`（stdout 镜像，recordId 同为 `sa-*`）。logs 里 2.0G 的 relay 镜像即该族之一。

## 缺口 1（已修）：engine journal 保留期——触发确定性化

- **现状（已修，2026-10-11）**：30 天 mtime TTL GC 保留不变（`packages/subagent-core/src/execution/persistence/session-file-gc.ts` 的 `cleanupExpiredSessionFiles`，同一轮内调 `cleanupExpiredJournals(getEngineDataDir(), TTL_MS)` 覆盖 `journal-*.jsonl`）；触发由「每次 session_start 5% 概率」改为**确定性**——`startSessionFileGcTimer`（同文件）进程内首次接线即扫一次 + 每 24h 定时复扫（unref 不 hold 进程退出，形态对齐 `apps/electron/main/logs/log-retention.ts` 的启动扫 + 每日复扫）；挂接点 = `extensions/universal/subagent-workflow/src/session-lifecycle.ts` 的 `runProcessLevelMaintenance`（`oncePerProcess` 检查防重复接线）。清理滞后于产生速率的问题消除；journal 清理与 session 文件清理共用同一轮，无双判据。
- **未采办的评估项**（确定性触发落地后如体量仍超预期再评估）：TTL 按消费方（resume 回放 / 通知链 `session_read` 指针）容忍度校准；「run 终态 + 保留最近 K 份」补裁剪。

## 缺口 2（待用户裁决）：subagent 会话文件回读窗口

- **现状**：`agent/subagents/<cwd 归一化目录>/sessions/*.jsonl` 的 30 天 TTL GC 机制存在（`session-file-gc.ts` 对 `<agentDir>/subagents` 递归 `walkAndClean`，`cleanExpiredJsonl` 带 `.alive` 探活保护 + 同名 sidecar 同删）；触发已随缺口 1 确定性化，不再有概率性清理滞后。本缺口剩余的裁决点**只剩窗口取值**。
- **待裁决**：30 天是否就是期望的回读窗口（这些是 `session_read` 可回读的 subagent 历史，删除损失可回读性）。若需延长/缩短改 `TTL_DAYS` 单点；若要与主会话删除联动，在既有 GC 判据内扩展（勿另起删除判据）。

## 缺口 3（已修）：预载升级产物版本封顶清扫

- **现状（已修，2026-10-12）**：`writePreloadedUpdate`（`apps/electron/main/update/preloaded-update.ts`，预载登记唯一入口，app 自下载与手动认领两条产物路径全覆盖）成功落登记后执行 `sweepStaleInstallers`——枚举 `update/` 目录直属普通文件中命中安装包命名（`TaiJi-<version>-*.dmg/exe/AppImage`，口径 = electron-builder `artifactName`）的文件，按版本号降序保留最新 3 个（刚登记的产物永不删），其余按版本最老优先删除。安全边界：版本解析不出的文件跳过不删（无法参与排序的宁可不删）；非包文件（json/log/脚本/.downloading 临时件）与子目录零触碰；删除前 `path.resolve` 包含校验（对齐 `update-self-healer.ts` 防篡改先例）；best-effort 失败仅 warn，不阻断下载登记主链。不做 TTL / 不读 `downloadedAt`（保留期方案 2026-10-12 用户裁决否决）。

## 缺口 4（已修）：attachments 删除级联

- **现状（已修，2026-10-11）**：删 session 链路（`packages/runtime/src/services/session/session-lifecycle.ts` 的 `purgeSessionSidecars`）已补 attachments 级联——`rmSync(getAttachmentsDir(sessionIdFromSessionFilePath(filePath)), { recursive: true, force: true })`，与 `cache/images` / `artifacts` 级联同一落点、同一幂等形态（目录名派生沿用既有 `sessionIdFromSessionFilePath`，`getAttachmentsDir` 自带 sessionId 穿越校验），best-effort 不阻断删除主链。孤儿附件目录不再无上界累积。

## 缺口 5（已修）：`agent/tmp/` 导出物保留期清理

- **现状（已修，2026-10-11）**：`extensions/universal/session-reader/src/tool-handler.ts` 的 export 动作在写入 `session-view-<sessionId>.md` 时顺带清扫 `<agentDir>/tmp/` 下超 30 天 mtime 的 `session-view-*.md`（`sweepExpiredSessionViews`）。取保留期（30 天，对齐既有 GC 的 TTL 口径）而非用完即删——导出物有二次检索价值（read/grep 可回读）；不新增常驻定时器，清扫落点 = 导出写入点（低频动作顺带）；只触碰本工具命名产物（`session-view-*.md` 前缀），不扫 tmp 下其他写入方的文件；best-effort（目录不存在 / 单文件失败静默跳过）。

## 已核实的对照项（避免重复质疑）

- `logs/` 的 7 天保留、`tts-cache` 双条件封顶、`cache/images` 级联、`gen-stats` 30 天窗口、`run/` 的 sock 清理与 checkpoint 保留份数——均为**已实现**的清理机制，不在缺口范围。
- `agent/subagents/` 与 `engines/*/` 的 **30 天 TTL GC**（`session-file-gc.ts`：`walkAndClean` / `cleanExpiredJsonl` / `cleanupExpiredJournals`，`.alive` 探活保护，进程级确定性触发：启动扫一次 + 每 24h 复扫）——**已实现**，缺口 1 的触发面已确定性化。
- `artifacts/`（`<dataDir>/artifacts/<sessionId>/`，对话流 HTML 产物目录，chat-html-support 设计引入）——**已设计清理**，不在缺口范围：① 删会话级联删除（与 `cache/images` 同一落点、同一幂等形态）；② 保留期扫描（默认 7 天，`TAIJI_ARTIFACTS_KEEP_DAYS` 可覆盖；判据 = 子树最新文件 mtime 超龄且三棵会话树（主 / subagent / btw）无同名会话文件——文件系统级，不依赖进程级在场集）。与本登记 5 项缺口同标准（「不成为新的无界累积物」），见 [ADR-0118](adr/decisions.md)。
- `logs/` 2.7G 属保留期内的正常体量（非未清理），但 390MB/天的速率值得与缺口 1/2 的体量观察一并考虑（三族数据的存储放大）。
