# 数据目录累积物清理缺口（`~/.taiji/` 实测盘点）

> **状态**：待裁决（5 项，均未动工；**缺口 1/2/5 的现状描述已于 2026-10-04 更正**——缺口 1/2 保留期实为已存在（30 天 TTL GC），缺口 5 写入方已定位）。**来源**：2026-10-03 实测盘点（用户提问触发，feat-chat-html-support 会话）；2026-10-04 D2 一致性审查反哺更正（证据见各缺口现状段）。**性质**：均非某次设计引入，属存量累积型缺口；本文件为这 5 项的单一登记处。
>
> **与 AGENTS.md 的关系**：修复时若触及 runtime/主进程清理逻辑，按常规流程走（不阻塞）。**与 chat-html-support 设计的互指**：该设计新增的会话产物目录（`<dataDir>/artifacts/<sessionId>/`）属「已设计清理」一侧（删会话级联删除 + 超龄保留期扫描，默认 7 天），与本登记的 5 项同类缺口（数据目录累积物）互为参照——本文件是数据目录累积缺口的单一登记处，见 [ADR-0118](adr/decisions.md)。

## 实测数据（2026-10-03）

| 目录 | 体量 | 文件数 | 内容 | 清理机制 | 判定 |
|---|---|---|---|---|---|
| `logs/` | **2.7G** | 286 | `pi-relay-*` 2.0G/216 · `pi-*` tee ~0.7G/46 · `renderer-console-*` 8.4M · `runtime-*` 6.3M · `renderer-error-*` 5.6M · `main-*` 208K | `apps/electron/main/logs/log-retention.ts`：保留 7 天（`TAIJI_LOG_KEEP_DAYS`），启动扫 + 每日复扫，按 mtime | ✅ 有清理（超龄 0 个）；**体量观察**：7 天窗口 ≈2.7G ≈ 390MB/天 |
| `engines/pi/shared/` | **425M** | 124 | `journal-sa-*.jsonl`（子代理 run journal，单文件最大 12M），最旧 2026-09-24 | **有**：`packages/subagent-core/src/execution/persistence/session-file-gc.ts` 的 `cleanupExpiredJournals`（30 天 mtime TTL；概率触发，见下） | ⚠️ 缺口 1（重定义：保留期已存在，体量仍 425M） |
| `agent/subagents/` | **160M** | 1544 | 子代理会话 JSONL（按 cwd 分目录），最旧 2026-09-22 | **有**：同文件 `walkAndClean` → `cleanExpiredJsonl`（30 天 mtime TTL + `.alive` 探活豁免；概率触发，见下） | ⚠️ 缺口 2（重定义：TTL 与期望回读窗口是否匹配） |
| `update/` | **131M** | 5 | 预载 DMG `TaiJi-0.10.11-mac-arm64.dmg` 137MB + `pending/preloaded-update.json` + `update-error.log` | 升级完成/失败/回滚后 `cleanupCompletedUpdate`（`update-self-healer.ts`）；**无 TTL** | ⚠️ 缺口 3 |
| `attachments/` | 924K | 25 目录 | 粘贴图片（按 sessionId 分目录） | 未找到删除链路 | ⚠️ 缺口 4 |
| `agent/tmp/` | 256K | 1 | `session-view-01a0d292-….md`（**2026-09-24**，260KB） | 未找到（写入方已定位：`extensions/universal/session-reader/src/tool-handler.ts:975-976`） | ⚠️ 缺口 5 |
| `tts-cache/` | 6.7M | 2 | WAV 缓存 | 双条件 FIFO 封顶（文件数 + 总字节，`tts-audio.ts`） | ✅ |
| `cache/images/` | 0B | 0 | toolResult 图片缓存 | 删 session 时级联 `rmSync`（`session-lifecycle.ts`） | ✅ |
| `gen-stats/` | 224K | 21 | ttft/speed/cache-ratio 日文件 | 30 天 GC 窗口 | ✅ |
| `agent/sessions/` | 22M | 55 | 主会话 JSONL | 随会话删除 | ✅ |
| `run/` | 16K | — | markers / checkpoint / sock / children pid | relay sock 启动与关闭时 unlink；checkpoint 失败件保留最近 3 份 | ✅ 大体有（崩溃后 marker/sock 可能残留） |

**放大效应（跨缺口观察）**：同一次子代理执行的数据落在三处——`agent/subagents/*.jsonl`（会话）+ `engines/pi/shared/journal-sa-*.jsonl`（引擎 journal）+ `logs/pi-relay-*.jsonl`（stdout 镜像，recordId 同为 `sa-*`）。logs 里 2.0G 的 relay 镜像即该族之一。

## 缺口 1：engine journal 无保留期（425M，单调累积）

- **现状（2026-10-04 更正）**：`engines/pi/shared/journal-sa-*.jsonl` 每 run 一份；**保留期已存在**——`packages/subagent-core/src/execution/persistence/session-file-gc.ts` 的 `maybeCleanupExpiredSessionFiles` 在**同一概率门**内调 `cleanupExpiredJournals(getEngineDataDir(), TTL_MS)`（`../engine/common/pool-manager.ts`，30 天 mtime TTL，`TTL_DAYS = 30` 见该文件 :28-34），前缀匹配 `journal-*.jsonl` 即覆盖 `journal-sa-*.jsonl`；挂接点 = `extensions/universal/subagent-workflow/src/session-lifecycle.ts:576`（进程级 `oncePerProcess` + **5% 概率**触发，见 `session-file-gc.ts:36-38`）。**本条缺口重定义**：不是「无保留期」，而是「保留期存在但（a）触发是概率性的、（b）30 天窗，体量仍达 425M」。（初版登记写「未找到」是调研口径错误：检索落在 `packages/subagent-core/src` 的 journal 写入/扫描路径，未覆盖 `persistence/` 下的 GC 模块与其 engine 池兜底。）
- **影响**：非无界（受 30 天 TTL 约束），但概率触发使清理滞后于实际产生速率；journal 属运行档案（非用户可见交付物），旧 run 的 journal 价值随 run 终态落定而衰减。
- **建议方向**：**不要**再实现第二套保留期（会与既有 30 天 TTL GC 形成两套判据/节奏）——应就地评估既有机制：① 触发从 5% 概率改为确定性（进程启动扫 + 每日复扫，对齐 `log-retention.ts` 形态）；② TTL 取值是否需按 journal 消费方（resume 回放 / 通知链 `session_read` 指针）的容忍度校准；③ 体量仍 425M 的成因（30 天窗 × 产生速率）是否需要按「run 终态 + 保留最近 K 份」补裁剪。

## 缺口 2：subagent 会话文件无保留期（160M，1544 文件）

- **现状（2026-10-04 更正）**：`agent/subagents/<cwd 归一化目录>/sessions/*.jsonl`；**保留期已存在**——同 `session-file-gc.ts:51-63` 对 `<agentDir>/subagents` 递归 `walkAndClean`，`:104-124` 的 `cleanExpiredJsonl` 对超 30 天 TTL 的 `.jsonl` `unlink`（**带 `.alive` 探活保护** + 同名 sidecar 同删），挂接点同上（进程级 + 5% 概率）。**本条缺口重定义**：不是「只增不减」，而是「TTL 与产品期望的回读窗口是否匹配 / 概率触发是否足够」。（初版登记「最旧 2026-09-22」在测量日（2026-10-03）仅 13 天，本就在 30 天窗内，不能支持「只增不减」的结论。）
- **影响**：受 30 天 TTL 约束（非无界）；这些是可被 `session_read` 读取的历史（用户/agent 可能回读 subagent 结果），删除会损失可回读性 → 需产品裁决「30 天是否就是期望的回读窗口」。
- **建议方向**：**不要**新增第二套策略——先裁决「30 天 TTL 是否符合期望回读窗口」，若需延长/缩短则改 `TTL_DAYS` 单点；若要「与主会话删除联动」则在既有 GC 判据内扩展（勿另起删除判据）。

## 缺口 3：预载升级产物无 TTL（131M）

- **现状**：`update/` 的预载 DMG 仅在「升级完成/失败/回滚」路径清理（`update-self-healer.ts` 的 `cleanupCompletedUpdate`）；用户长期不安装（`pending-update.json` 存在）时 DMG 长期驻留。
- **影响**：单版本约 130-140MB 长期占用；跨版本若出现「预载新版本但不安装又预载下一版本」的路径，可能叠加。
- **建议方向**：给预载产物加 TTL（如 7-30 天未安装即清理并回退「未下载」态）+ 确认预载新版本时旧 DMG 的替换路径。

## 缺口 4：attachments 无删除级联

- **现状**：`attachments/<sessionId>/` 由 `attachment-store.ts` 写入；删除 session 的链路（`session-lifecycle.ts`）级联了 `cache/images`，**未见 attachments 级联**。
- **影响**：删会话后粘贴图片残留（当前 924K/25 目录，量小但无上界）。
- **建议方向**：在既有 session 删除链路补 attachments 目录级联删除（与 `cache/images` 同一落点、同一幂等形态 `rmSync(recursive, force)`）。

## 缺口 5：`agent/tmp/` 陈旧文件无清理

- **现状**：`agent/tmp/session-view-<uuid>.md`（2026-09-24，260KB）为一次性导出物；**写入方已定位**——`extensions/universal/session-reader/src/tool-handler.ts:975-976`（`join(agentDir, 'tmp')` + `session-view-${resolved.sessionId}.md`，`export` 动作的物化产物；同文件 :915 注释即该动作说明）。**清理点仍缺失**（写入方只写不删，全仓无对应 unlink/保留期）。
- **影响**：量小，但属「不知谁写、不知谁清」的孤儿文件；同类若继续产生会累积。
- **建议方向**：写入方在本仓（`extensions/universal/session-reader`），可直接在该扩展内定「用完即删」或保留期清理（无需先排查 pi 侧）。

## 已核实的对照项（避免重复质疑）

- `logs/` 的 7 天保留、`tts-cache` 双条件封顶、`cache/images` 级联、`gen-stats` 30 天窗口、`run/` 的 sock 清理与 checkpoint 保留份数——均为**已实现**的清理机制，不在缺口范围。
- `agent/subagents/` 与 `engines/*/` 的 **30 天 TTL GC**（`session-file-gc.ts`：`walkAndClean` / `cleanExpiredJsonl` / `cleanupExpiredJournals`，`.alive` 探活保护，进程级 5% 概率触发）——**已实现**，故缺口 1/2 的定性为「机制存在但触发与窗口待评估」，不是「无清理」。
- `artifacts/`（`<dataDir>/artifacts/<sessionId>/`，对话流 HTML 产物目录，chat-html-support 设计引入）——**已设计清理**，不在缺口范围：① 删会话级联删除（与 `cache/images` 同一落点、同一幂等形态）；② 保留期扫描（默认 7 天，`TAIJI_ARTIFACTS_KEEP_DAYS` 可覆盖；判据 = 子树最新文件 mtime 超龄且三棵会话树（主 / subagent / btw）无同名会话文件——文件系统级，不依赖进程级在场集）。与本登记 5 项缺口同标准（「不成为新的无界累积物」），见 [ADR-0118](adr/decisions.md)。
- `logs/` 2.7G 属保留期内的正常体量（非未清理），但 390MB/天的速率值得在缺口 1/2 的方案里一并考虑（三族数据的存储放大）。
