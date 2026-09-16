# u6-collect-compat 验证记录：存量读侧兼容（只验证不改）

- 单元：u6-collect-compat（P2.3）｜上游：u5（core collect 机制全量退役已 committed，读侧保留面按设计 D6 不删）
- 设计依据：`.tmp/tech-design/subagents-batch-tool-fanout.md` §3.3 D6「存量数据兼容」行 / ⛔待验证检查点第 4 项
- 执行日期：2026-09-16
- **判定：读侧容忍面成立**。三项验证 24/24 断言通过，无需回改 D6。

## 样本（真实存量，只读 cp）

| 样本 | 原文件（`~/.taiji/agent/sessions/`） | 规模 | batchFinalized entry |
|------|--------------------------------------|------|---------------------|
| sample-1 | `--Users-zhushanwen-Code-tai-ji-workspace-feat-optimize-subagent-workflow-bash-tasks--/2026-09-16T03-42-56-924Z_01a0a84f-7d9c-7e36-be25-22b2b5f24be9.jsonl` | 701 行 / 4.1MB | 24 处（12 个 batchFinalized record，status=idle、result 非空、均含子文件指针） |
| sample-2 | `--Users-zhushanwen-Code-tai-ji-workspace-fix-pending-msg-after-compact--/2026-09-16T05-55-30-247Z_01a0a8c8-d947-7890-ae2c-56581603862c.jsonl` | 132 行 / 1.7MB | 8 处（3 个 batchFinalized record，同上形态） |

配套 cp 数据：两个 enc 段 `records/` 存量 manifest（18 + 3 个，批时代词汇 status/executionStatus 双写）与 batchFinalized record 的 `sessionFile` 指向的存量子 session 文件（15 个）。

## 红线遵守

- 真实数据目录（`~/.taiji/`）零写入、零删除、零移动；仅 `cp` 只读复制到 `.tmp/dev-flow/u6-samples/`（验证后已按计划删除）。
- 验证工作布局每次运行 `mkdtemp` 自建、结束自删。
- `pi.appendEntry` 为 no-op stub（零写盘）；`SubagentService.initSession` 恢复链对主文件副本只读。
- 仓库源码零改动（脚本在 `.tmp/dev-flow/u6-verify-collect-compat.mts`，gitignore 区，保留供阶段 5 复验）。

## 数据保真说明（deviation D-1）

主文件副本与 manifest 副本对 `record.data.sessionFile` / `manifest.sessionFile` 做了**路径串改写**（真实 `~/.taiji/agent/subagents/<enc>/sessions/` → 临时布局内 sessions 目录），否则 session-reader `resolveByRecordId` 的 `existsSync` 会命中真实数据目录子文件（反查泄出到 `~/.taiji` 只读路径，违背全链封闭 .tmp 的红线意图）。

保真对照（python 逐字节比对，两样本）：剔除路径串后与原文件**逐字节全等**——sample-1 改写 113 处 span、sample-2 改写 32 处，entry 结构、batchFinalized 标记、result 全文、manifest 批时代词汇（status/executionStatus/intent 等）原样保留。改写只影响「数据存放在哪」，不影响「数据长什么样」，容忍面解析对象结构不变。

## 验证① record-store 重建容忍

调用方式同 u5 保留的读侧守卫测试（`batch-finalized.test.ts` / `rebuild-indexes.test.ts`）：真实 `RecordStore(sessionsDir, ManifestStore, pi, manifestDir)` 组合。

```
[PASS] ①a rebuildIndexes 全量重建不抛
       RecordStore(sessionsDir, ManifestStore, pi, manifestDir).rebuildIndexes() 正常返回
[PASS] ①b collectRecords 四源合并投影不抛（含批历史 record）
       投影出 18 条 record（sample-2: 3 条）；id 形态样例: sa-b2199250-…, sa-ca7b1473-…, sa-1489a210-…
[PASS] ①c scanLastRecordEntries 主文件 entry 末条扫描链不抛（session-reader 反查投影同源）
       entry 扫描投影 18 条 record，其中 batchFinalized=true 12 条（sample-2: 3/3，标记被容忍读回）
[PASS] ①d batchFinalized 标记在 entry 扫描投影中可见（容忍面核心断言）
       样例: sa-394b525b-… status=idle result=非空
```

发现（设计内行为，非缺陷）：存量子 session 文件**无 `subagent-identity` entry**（旧版写侧不写），`reconstructFromFile` 按设计返回 undefined → 不进 rebuildIndexes 扫描集（rebuild-indexes.test.ts 的 junk 降级路径同款），rebuildIndexes 对子文件源补建数为 0，整轮不抛。批历史 record 的可见性由 manifest 源（`mergeManifestRecords`）与 entry 末条扫描链（`scanLastRecordEntries`）两通路承担——与 batch-finalized.test.ts 头注的通路描述一致。

## 验证② session-reader 反查投影

调用方式同跨包测试 `cross-package-subagent-core.test.ts`：`handleSessionRead({ action: "result", session: "<sa-id>" }, { agentDir })`，manifest 由存量 records/ 目录提供。

```
[PASS] ②a listRecordManifests 读存量 manifest 目录
       sample-1: 18 个 manifest 文件解析通过 15 条；sample-2: 3/3（差额 = 缺必填字段的设计内静默跳过）
[PASS] ②b result 反查命中 batchFinalized record sa-394b525b-…
       正文 2294 字符（totalChars=2294），session=命中目标 id，sessionFile 全链封闭布局
       （sample-2: sa-9d43e058-… 正文 8475 字符，totalChars=14743——超 8000 触发 MAX_RESULT_LENGTH 截断，属通知体积机制设计内行为）
[PASS] ②c 反查正文与 record.result 同源（record.result 首行前 80 字符在反查正文中命中）
[PASS] ②d 批量反查（3 个 batchFinalized id 逗号串）正常，count=3，输出含 [1/N] 序号头
```

发现（设计内行为，非缺陷）：sample-1 有 3 个存量 manifest 被 `isRecordManifest` 拒收（缺 `sessionFile` 字段——对应无子文件锚的 record），`tryReadManifest` 静默跳过不中断扫描（函数头注明示的降级语义）。这些 record 不出现在反查候选中，不炸。

## 验证③ 加载历史会话形态（生产入口全链）

`SubagentService.initSession` 是生产读旧 session 文件的唯一入口（batch-finalized.test.ts 注释）。模拟「重开历史会话」：sessionId 取主文件 header 真实 id（`01a0a84f-…` / `01a0a8c8-…`）。

```
[PASS] ③a SubagentService.initSession 打开存量主 session 文件不抛（恢复扫描全链，无 EEXIST/解析崩溃）
       initSession({pi: no-op stub, sessionId: "01a0a84f-…", mainSessionFile: <副本>}) 正常返回
[PASS] ③b 恢复后 queries.collectRecords 投影存量 record
       恢复面投影 18 条 record（sample-2: 3 条）——与 ①b store 面口径一致
[PASS] ③c dispose 收尾不抛
```

运行期出现一条 host 接线降级日志（`NotifyDomainPorts.createDelivery not configured - falling back to direct-send delivery`）：验证脚本未接 host notify 配置所致的正常降级警告，与本验证目标无关。

## ⛔ 期门结论

**读侧容忍面成立**：存量 `batchFinalized` entry / 存量批时代 manifest / 存量子 session 文件，经 record-store 重建（rebuildIndexes / collectRecords / scanLastRecordEntries）、session-reader 反查投影（listRecordManifests / result 单查与批量）、SubagentService.initSession 恢复全链，均不炸、标记与正文可读、无 EEXIST 类失败。设计 D6「存量数据兼容」行的读侧保留面（容忍解析、反查投影、重建路径兼容）对真实存量数据有效，无需回改。

## 产物与复验

- 验证脚本：`.tmp/dev-flow/u6-verify-collect-compat.mts`（保留；运行方式见文件头注，含样本重新 cp 指引）
- 样本副本：已按计划删除（`.tmp/dev-flow/u6-samples/`）
- 工作布局：每次运行 mkdtemp 自建自删
- 运行命令：`npx tsx .tmp/dev-flow/u6-verify-collect-compat.mts`（仓库根）
- 最终运行结果：`===== 总结: 24/24 通过 =====`，exit 0

## Deviations

1. **D-1 副本路径串改写**：见上文「数据保真说明」。目的 = 反查/恢复链全封闭 .tmp、零读真实数据目录；代价 = 副本与原文件在 sessionFile 路径串上不同（剔除路径串后逐字节全等已对照验证）。
2. **D-2 无**其余偏离。三项验证内容、调用方式、样本均按实施计划 u6 行执行。
