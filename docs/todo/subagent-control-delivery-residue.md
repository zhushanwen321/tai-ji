# subagent control 通道交付残留（relay-spawn-transport 收尾登记）

状态：已交付（4 项残留/承接窗口登记，2026-10-18 收尾；逐项待排期）

## 1 degraded 提示仅拉取可见（DC-8）

- **现状**：runtime `markDegraded()` 只改 tee/查询态，不发布推送帧；`degraded` 只在 `session.getSubagentStreamState` 拉取响应中返回。`useSubagentTabData` 仅在订阅建立与 chunk 失步时拉取。
- **后果**：drawer 已打开、之后无 chunk 时，用户看到 live 流停止但无提示条，直到重开/刷新。
- **候选修法**：runtime 在 markDegraded 时发布 `session.subagentStreamDegraded {sessionId, recordId}`，renderer 经 event-bus 应用到同一 per-(virtualId,recordId) 位（单一事实源不变）。
- **权威登记**：relay-spawn-transport impl-plan §5 DC-8（工作流过程产物，已随 .tmp 清理，git 外；登记内容以本文件与 ADR 登记为准）。

## 2 非缺省引擎首轮 probe→run 双 spawn（DC-12）

状态：已修复（2026-10-23，just-do-it 批次 3 T12c）

- **修法（选项 a，数据正确性优先）**：`EnginePort.probe` 契约扩展 `opts.rootSessionId`，两个生产调用点（`run-orchestration.ts` chat 域 / `workflow-dispatch.ts` workflow 域）注入 service 层权威根（`this.sessionRootId`，与 runCtx.sessionRootId 同源 = `envRoot ?? init.sessionId`）——probe 与 run 命中同一 `(socket, root)` 共享连接，单 open 零 rebind。read/setModel 作用于 run 已锚定权威根的连接（`requestedRootSessionId` 持久），无参 `ensureConnected` 恒安全，不受双连接窗口影响（remote-engine.ts 成员注释登记）。验证：transport-runtime.test.ts `[DC-12]` 用例（单 open / 单连接 / 无 engine_close）。
- **权威登记**：impl-plan §5 DC-12。

## 3 真机/混合版本验收窗口（A5 / A11 / A13）

- **A5/A13**：真实 app + 真实模型场景（S1 真机场次、S3 小 prompt、S4 并发 5 实例、S6 主对话半场、S8 真实 pi ack、S10/S13/S15）需有人窗口随 E2E-BATCH 族承接。代码面已有：A1 剧本归档（M1 行为）、A4 真实引擎×假 pi 全链、pi-cli/runtime/core 单测。
- **A11**：新旧版本混合矩阵（旧 runtime × 新 extension 等）未机器化；协议级版本拒绝有单测（hello_reject reason=version → engine_protocol_mismatch）。承接窗口见 DC-14。
- **A6**：Windows 真机未跑；Windows 分支（taskkill /T、child pid 集合、start time 不可得保守跳过）由 mock 用例覆盖。

## 4 已知遗留命名（非缺陷）

- `record.engineHandle.relayChildren` 字段与 crash-forensics 中标注为「当前不生效」的存量描述保留（引擎池抽象退役遗留），未在 relay-spawn-transport 范围内清理。

## 5 D5 复审遗留的 info 级卫生项

- `outbound-queue.ts` 的 `hasPendingFrames` 无调用方——已删除（2026-10-23，just-do-it 批次 3 T12c；全仓 grep 零引用）。
- `pid-file.ts` 的 `.pid.tmp-*` 残片不在 sweep 扫描面（只扫 `*.pid`）——已修复（2026-10-23，just-do-it 批次 3 T12d：sweepOrphanEnginePids 扫描范围扩为同时匹配 `.pid.tmp-<writerPid>-<hex>` 残片直接清，写者 = 本实例的在途原子写跳过；sweep.test.ts 覆盖）。
- `outbound-queue` 的 destroyed 判定未覆盖半关闭态；溢出标记后不再复判上限（行为已显式失败，仅记录）。
- `sweep` 的 owner 判活只有 `isPidAlive`，`instanceId` 恒等于 runtimePid（一致性校验在正常数据上不触发）；pid 复用误判「owner 活着」时仍会跳过收割——已修复（2026-10-23，just-do-it 条目 65：owner 判活改 pid + start time 二元组，pid 文件登记 `runtimePidStartSec`（登记侧读一次缓存，ps 取不到省略该键），sweep 比对不匹配判 owner 死进收割链；旧格式登记无该字段 / sweep 侧取不到（Windows）一律保守判活跳过，存量登记不清）。选型记录：连接探活不可行——init() 顺序中 sweepStaleControlSockets 先 unlink 死 socket，owner 死后探活依据已灭失，且 socket 探活验证「路径有人听」而非「pid 同一进程」。
- Windows 引擎意外退出时 child pid 集合来自 host/childSpawned 反向帧；只按 `isAlive` 选目标，无 start-time 二次校验（Windows 不可得，设计已接受「宁不杀勿误杀」的降级）。
