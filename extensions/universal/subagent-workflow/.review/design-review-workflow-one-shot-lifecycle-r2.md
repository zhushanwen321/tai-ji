# 设计审查报告（第二轮）：workflow-one-shot-lifecycle.md

## Summary

**结论：第一轮 4 个 MUST_FIX 全部真正修复（源码交叉核实，非表面措辞替换），无新的 MUST_FIX。0 must-fix, 4 suggestions.**

核实方式说明：本轮对所有修订后新增的运行时断言逐一 read 源码验证——S7 两路注入点（worker-script-builder.ts / worker-host.ts / error-recovery.ts 完整链路）、D-2 落点 1 的 handler 行号与编排时序（index.ts）、「复用 abortRun 骨架」的 save await 语义（lifecycle.ts:354）、守卫行号（error-recovery.ts:178/624/667/699 精确命中）、bump 先例（jsonl-run-store.ts SNAPSHOT_VERSION="wf-run-v1"）。旧表述残留 grep 清零。

## Findings

| 优先级 | 位置 | 维度 | 描述 | 修复方向 |
|--------|------|------|------|----------|
| SUGGESTION | §3.3 D-5、§5 U2 | P1-8 副作用 | bump v2 时 v1 快照若有 running 残留（用户 kill-9 后尚未重开过同 session），loadAll 跳过 → 该 run 静默消失（不显示、不转 failed）。文档声称「旧 run 早已终态，跳过零损失」未覆盖此反例。概率低、损失小（一条历史失败记录的显示差异）、有 bump+跳过先例支撑，不影响方案成立 | D-5 补一句：「v1 running 残留跳过 = 静默消失（不转 failed 不显示），接受」或明确此边界 |
| SUGGESTION | §3.3 D-2 落点 1 | P1-8 细节 | 「原因串统一为 session-switch 语义（如 "Session switched: run terminated"）」未点明字段落点。现状先例（index.ts:458-460 session_start 恢复：`state.error = "Process killed (kill-9 or crash recovery)"` + `transition("done","failed")`）已确立 state.error 模式；D-1 已声明 DoneReason 无新增，实施者可推断，但一句话点明更稳 | 落点 1 补「对齐 session_start 模式：reason="failed" + state.error=<session-switch 原因串>」 |
| SUGGESTION | §3.3 D-6 依据 | P1-3 受众 | 第一轮遗留：「V4 P5 的同类教训」引用 subagent 侧 V4 文档结论仍无一句话摘要，未读过 V4 文档的读者不可理解（D-1 依据的 V4 B-1 已补摘要，此处分 D-6 未补） | 补一句话 V4 P5 结论（如「V4 收敛时文档与代码漂移导致的一次定位事故」） |
| SUGGESTION | §5 检查点 1 | P1-8 事实 | 「实施期只需确认 worker 内 process 全局可访问（应可用；若被沙箱屏蔽则退化）」——此确认设计阶段即可定论：worker-script-builder.ts 用 `new Worker(code, {eval:true})` 内联执行（无 vm/sandbox 层），Node worker_threads 环境 process 全局标准可用。留「实施期确认」尾巴与「S7 注入点已定稿」的表述轻微不一致 | 改为「已核实可达」（或标注核实依据 worker-script-builder.ts），删除退化分支或保留为注释 |

## 第一轮 4 个 MUST_FIX 逐项核实记录

### MUST_FIX 1（假前提「无程序化消费方」）→ 已修复

文档全文一致承认程序化消费方 = session 生命周期自动挂起（session_tree/session_shutdown，行号 :527-545/:594-607 与源码 529/538、594/607 一致）。核实点位：
- 一句话结论（:5-6）：session 切换是「已确认接受的行为变更」；
- SCQA C（:19）：「唯一程序化消费方是 session 生命周期自动挂起（session_tree/session_shutdown 两个 handler…）」；
- §2 结论（:69）、§2.2 P4（:104）：程序化消费方 + 唯一用户链路 + 作废已确认接受；
- §3.2 边界声明（:181）：「设计依据是 §2.2 P4 的价值评估（该存续场景不重要），**而非『不存在消费方』**」——显式与旧论证划清界限；
- D-2 依据、G1、Out-of-scope 均一致。

grep 核实：「没有任何程序化消费方」类旧表述零残留；「诚实化」出现 3 处，全部为否定式（「不是诚实化」「而非『现状诚实化』」）；「现状本就」仅描述 kill-9 恢复（源码属实：index.ts:458-463 running → transition("done","failed")）与 agent() 无 conversation 字段（与 pause 无关）。

### MUST_FIX 2（行为变更伪装成现状诚实化）→ 已修复

- D-2 标题「（有意识的行为变更）」+ 依据段：现状 session 切换是 pauseRun 挂起落盘、paused 可 resume 续跑 → 删除后直接 failed、token 作废，变更已确认接受；
- SCQA A（:20）：「能，但性质要诚实——这是一次**有意识的行为变更**而非『现状诚实化』」；
- §3.1 场景 C 覆盖 session 切换路径：切换当刻 handler 直接转 done,failed 落盘（替代现状 pauseRun 挂起）→ 切回原 session 显示 failed 且不可 resume；
- §3.2 边界声明引用用户确认：「用户已确认接受：session 切换时 workflow 直接作废可接受」。

### MUST_FIX 3（index.ts 两处 handler 遗漏）→ 已修复

- D-4 首条即 index.ts（session_tree :538 / session_shutdown :607 的 pauseRun 调用，行号源码精确）+ 注释同步重写（「切分支前 pause」→「切分支前终止」）；
- U3 文件列表含 index.ts，内容描述含两处 pauseRun 替换（D-2 落点 1）；
- D-2 落点 1 当刻行为设计完整：transition("done","failed") + 落盘 + 原因串（"Session switched: run terminated"），含 helper 形态选项（复用 abortRun 骨架 vs 抽取新 helper）；
- 「复用 abortRun 的 transition+save 骨架」经源码核实无时序风险：abortRun（lifecycle.ts:354）与 pauseRun 的 save 均为 `await deps.store.save(run)`，替换进 session_shutdown 的 `await Promise.allSettled(running.map(...))` 后，仍满足 W2C5 编排顺序（save 完成后才 store.dispose，index.ts:603-608 注释自证该契约），不打开「shutdown 时刻 pending 去抖写丢失」窗口。

### MUST_FIX 4（S7 注入点不可执行）→ 已修复

S7 注入点定稿两路，均经源码链路核实真实可达：
- **① worker 异常退出（process.exit(1)）**：worker-script-builder.ts 将用户脚本内联进 async IIFE（`WORKER_TEMPLATE_PRE + userScript + WORKER_TEMPLATE_POST`），经 `new Worker(code, {eval:true})` 在真实 Worker thread 执行——process 全局标准可用，无沙箱层；worker-host.ts:89-93 `handle.onExit((code) => void handlers.onExit(code, handle))` → error-recovery.ts handleWorkerExit（非零码委托 handleWorkerError → workerErrorCount ≤ MAX_WORKER_RETRIES=3 → scheduleRebuild 指数退避）✅
- **② 脚本错误（顶层 throw）**：WORKER_TEMPLATE_POST 的 `})().then(...).catch((err) => _safePost({type:"error", ...}))` 确认存在 → handleWorkerMessage case "error" → handleScriptError（scriptErrorCount ≤3，与 workerErrorCount 分账，源码注释自证「两类错误根因不同」）✅
- **$ARGS 条件分支**：worker-script-builder.ts 注入 `const $ARGS = workerData.args`（IIFE 内，用户脚本同作用域可访问），「测试脚本经 $ARGS 条件分支触发」可行 ✅
- 两路注入点、计数分账、退避参数与文档 S7 描述逐项一致。

## 第一轮 6 个 SUGGESTION 修复情况

| # | 修复情况 | 核实 |
|---|---|---|
| 守卫行号改准 | ✅ 已修复 | :178/:624/:667/:699 实测精确命中；lifecycle:374/scheduleRebuild:736 保留 |
| D-6 注释清单遗漏 | ✅ 已修复 | 已补 models 三文件 + index.ts:587/:604 |
| 检查点 1 伪问题 | ✅ 已修复 | 「快照格式含 pending 值」已删除，重写为注入点确认项 |
| V4 引用无摘要 | ⚠️ 部分 | D-1 依据已补摘要；D-6 的「V4 P5 同类教训」仍无摘要（列本轮 SUGGESTION） |
| 源码 D-4 撞号 | ✅ 已修复 | 改称「源码 D-4 标记」并标注实现位置 index.ts:453-465 |
| U1 assignRuntime 契约 | ✅ 已修复 | D-1 新增「契约调整」小节 + U1 条目（workflow-run.ts:222-224 前置校验，源码属实） |

## P0 清单复扫（确认修订未破坏第一轮通过项）

五段骨架完整（P0-1）；无 delta 链引用，产物自包含（P0-2）；各章结论先行（P0-3）；§2.1 旅程图 + §3.1 场景 A-E 使用者视角（P0-5）；四概念表（P0-6）；三方案对比两维度 + 明确推荐（P0-7/8/9）；方案 A 打到根因 R（删除错误形态而非补丁，P0-10）；S1-S8 真实 pi 环境验收、非单测非 mock、每场景回溯 G 目标（P0-13/14/15）；每决策带探针标注（P0-16）；物理数据流图（P0-17）；场景 D 错误恢复指引（P0-18）。
