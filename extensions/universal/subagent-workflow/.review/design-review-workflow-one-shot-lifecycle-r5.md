# 设计审查报告（第五轮·处置复核）：workflow-one-shot-lifecycle

## Summary

**0 must-fix, 2 suggestions.**

**结论：子文档可交付 builder。** R4 的 3 个 MUST_FIX 全部真正修复（F4 两段归位与 workflow-run.ts 实际代码结构可实现且 transition 路径 I1 覆盖闭合；S7 新脚本的「仅首次注入」判别时序推演成立且「a 不重复耗 token」断言有源码依据；S3 ②a/②b 的触发命令与原因串映射与 pi 事件语义吻合）。R4 的 5 个 SUGGESTION 全部处置到位。本轮扩散检查未发现修改引入的新矛盾；仅余 2 条不影响实施的表述级建议。

## R4 三个 MUST_FIX 逐项核验记录

### MF-A（F4 构造即抛错）→ **已修复** ✓

**核验 (a)：U2-2 构造 I1 调整与 workflow-run.ts 实际结构的可实现性**

- 改造点定位核实（源码 workflow-run.ts）：构造函数 `this.runtime = undefined` 硬编码（:95）后，非 reconstruct 分支调 `validateInvariants()`（:100-102），其 I1 构造期检查 `status==="running" && runtime===undefined → throw`（:127-132）——R4 判定的冲突源属实，F4 两段归位（U1 不动创建路径 + U2 整体改造）正确绕开。
- U2 落地后推演：① 构造 `new WorkflowRun(status:"running")` → 构造期仅查 I2（running 无 I2 约束）→ 通过；② assignRuntime 前置改 `status==="running" && runtime===undefined`（:222-224）→ 通过（:217-221 的「runtime already defined」检查保留，两前置并存自洽）；③ assignRuntime 末尾 `this.validateInvariants()`（:232）**现状已存在**——构造期退出 I1 后由它接管 I1 检查，「I1 移入 assignRuntime 末尾」的职责声明与代码结构吻合（表述上该调用是「已存在、接管」而非「新增」，builder 无论哪种理解产物相同，无歧义风险）。
- **transition 路径 I1 覆盖闭合**：transition 末尾 `validateInvariants()`（:203）保留（U2 删 paused 分支后 `target==="done"` 路径 → releaseRuntime → done ⟹ runtime undefined，I1 通过）；replaceRuntime 末尾校验（:273）不变；reconstruct 路径本就 I2-only（:96-99）不受影响。I1 的第二支检查（:133-137，runtime!==undefined 时 status 必须 running）在构造期跳过无损失——构造时 runtime 恒 undefined，该支恒不触发。
- 衍生时序安全核实：`runs.set` 后移到 assignRuntime 之后（U2-2 lifecycle.ts ②）——`scheduleTimeBudget` 的 timer 回调走 `deps.runs.get(runId)`（lifecycle.ts:128-129 → abortRun :360），timer 创建于 RunRuntime 构造（:213-217）、fire 最早在 maxTimeMs（秒级）后，set 在同步代码段内紧随完成，无 fire-before-set 竞态；signal abort listener（:191-202）在 set 前触发的窗口与现状相同（catch log 容错），无回归。

**核验 (b)：U1「创建路径不动」与 U1 其他条目一致性（扩散检查）**

- U1-1 runWorkflow 行改为「完全不动创建路径」✓；U1-7 禁改清单补 workflow-run.ts（「创建路径/构造契约/assignRuntime 校验全不动」）✓；U1 目标句「仅创建路径瞬态写入，无持久化写入者」与源码事实吻合（save :222 在 assignRuntime :220 之后，快照不落 paused）✓；S8a grep 模式（pauseRun|resumeRun）不命中 `status: "paused"` 字面量 ✓，S8b（U2 后）在 U2-2 ① 将 :178 改 running 后闭环 ✓。
- U1 的 scheduleTimeBudget 注释改动（:115-119「run/resume 各启动一个」→「runWorkflow 启动」）与 resumeRun 删除自洽 ✓；evict 注释改动（:403/:427）独立成立 ✓。
- U2-2 的 lifecycle.ts「仅创建路径」（:178/:205/:220 区）与 U1 已改的 lifecycle.ts（删 :251-279/:312-338、新增 terminateRunningRuns、注释）**无行级交叠** ✓；父文档 §5 U2 源码列标注「orchestration/lifecycle.ts（仅创建路径）」✓。

### MF-B（S7 脚本自反）→ **已修复** ✓

**新脚本时序推演（对照源码逐环节核实）**：

- **首次执行**：a 真跑 = spawn pi 子进程 + LLM 推理（秒级）→ `Date.now()-t0 > 500` 为真 → 注册 `setTimeout(exit, 300)` → b dispatch 在飞（spawn 子进程需数秒，300ms 内不可能完成）→ worker exit(1) → handleWorkerExit（error-recovery.ts:667，code≠0）→ 委托 handleWorkerError → workerErrorCount=1 → scheduleRebuild delay 1s → rebuildRuntime：replaceRuntime 同步 abort 旧 controller → discardInFlightCalls 清除在飞 b（F2 落点）→ 新 worker 重跑。
- **重跑**：a 的 agent-call 消息走 `dispatchAgentCall` 的 cached 路径——**源码核实**（error-recovery.ts:236-241）：`run.state.calls.get(callId)` 命中 done → `postAgentResult(run, callId, cached.result, true)` 直接 IPC 回发——**不 spawn 子进程、不消耗 token**，「a 不重复耗 token」断言的成立路径确认；耗时为主进程↔worker 的消息往返（ms 级）→ `>500` 为假 → 不再注入 → b 真跑 → return {a,b} → completed。**自愈路径可达，自反问题消除**。
- 判别阈值的稳健性：真跑秒级 vs replay ms 级，500ms 阈值两侧各有一个数量级余量；极端反例（真跑 <500ms 导致首次不注入）下 run 正常完成，验收可重试，不阻塞。
- `crashAt:"always"` 语义改为「PHASE_A 前退出」与脚本一致（exit 在 a 调用前），每次 rebuild 立即再退 → 3 次耗尽 failed ✓ 断言 ② 可达；`throwAt` 顶层 throw 每次重跑都触发 → scriptErrorCount 耗尽 ✓ 断言 ③ 可达。
- token 断言的措辞精度核实：「PHASE_A 对应子进程 session 文件恰 1 份」——正确限定了 PHASE_A（b 的 abort 次与重跑次各 spawn 过子进程，文件总数为 3，断言只对 a 计数）✓ 可验；`touch /tmp/wf-marker` 已补进步骤 ✓。

### MF-C（S3 ② 断言错路）→ **已修复** ✓

**触发命令与原因串映射对照 pi 事件语义核实**：

- **②a 分支导航 → "Session switched"**：pi 源码 `AgentSession.navigateTree()` 末尾 emit `session_tree` 事件（agent-session.ts:2911-2917）；RPC 通道 `navigateTree` 命令存在（rpc-mode.ts:328-335 → session.navigateTree）→ extension 的 session_tree handler（index.ts:529）→ `terminateRunningRuns(..., "Session switched: run terminated")` ✓ 链路吻合。
- **②b 切 session → "Session shutdown"**：`/new` 走 session_before_switch(reason:"new") + session_shutdown（index.ts:554-558 注释自证）；RPC `switch_session` 命令存在（rpc-mode.ts:576-581 → runtimeHost.switchSession），shutdown 事件经 emitSessionShutdownEvent 发出（agent-session.ts:2487 同族路径）→ session_shutdown handler → "Session shutdown: run terminated" ✓ 链路吻合。子文档括注「/new 与 switch_session 都走 before_switch + shutdown，不触发 session_tree」与 pi 事件触发矩阵一致。
- 「切回」操作（②a 再次 navigateTree 回原分支）会再触发一次 session_tree → terminateRunningRuns 对已 done 的 run 过滤不命中（helper 只处理 status==="running"）→ no-op 无害 ✓。

### R4 五个 SUGGESTION 处置核验

| # | 处置 | 核实 |
|---|------|------|
| SG-A（ViewActions 注入点） | ✅ U1-5 补 openView :218-219 行（「注入删除，ViewActions 收窄为仅 abort」）；U1-6 残留的「ViewActions 注入方」行已删（不再有位置错误的 tool-workflow/gui 表述） | ✓ |
| SG-B（WorkflowToolDetails 死类型） | ✅ 新增 U2-3（:232 union + :286-288 severity，与 gui.test.ts 同 unit 且显式声明顺序约束）；U1-7 禁改清单加该条 | ✓ |
| SG-C（release("pause") 调用点） | ✅ U2-2 ③ 补 :243 `release("pause")`→`release("terminal")` | ✓ |
| SG-D（S5 尾巴/措辞/marker） | ✅ S5 改实证引用（launcher.ts:328 / registry-impl.ts:77 / worker-script-builder.ts:354，与 R4 核实结论一致）；「手势」→「prompt 报文」；`touch /tmp/wf-marker` 补进 S7 步骤 | ✓ |
| SG-E（父文档 G2/D-1/§5） | ✅ G2 改「pause 族机制（terminate+重跑）删除，discard 补丁随 pause 场景消失并重定位为崩溃重建正式步骤（D-3）」；D-1 探针改两段式引用；§5 U1 行含「创建路径不动 + openView :218-219」、U2 行含「创建即 running（F4 第二段/F8）+ lifecycle.ts（仅创建路径）+ tool-workflow.ts（仅死类型）」 | ✓ |

## 父子文档交叉一致性

| 项 | 父文档 | 子文档 | 判定 |
|----|--------|--------|------|
| F4 两段归位 | D-1「契约调整（两段归位）」+ 被否新增「U1 改初始 running（撞构造期 I1）」+ §5 U1/U2 行 | §0 F4 + §1 U1-1/U1-7 + §2 U2-2 | ✓ 完全一致 |
| G2 discard 表述 | 「随 pause 场景消失并重定位（D-3）」 | F2 保留重定位 | ✓ 矛盾消除 |
| S3 ② 拆分 | §4 S3 泛写「切换 session」（子文档更细，冲突以子文档为准的层声明已覆盖） | §3 手册 ②a/②b 拆分 + 原因串对应 | ✓ 不冲突 |
| S7 三路注入 | §4 S7「process.exit / throw / setTimeout 三路」 | §3 脚本 second/always/throw | ✓ 一致 |
| U2 死类型 | §5 U2 行「WorkflowToolDetails 死类型收窄…与 gui.test.ts 同 unit」 | U2-3 | ✓ |
| 检查点关闭声明 | §5 末尾 ①②③ | §0 F7/F1/F9 | ✓ |

## Findings

| 优先级 | 位置 | 维度 | 描述 | 修复方向 |
|--------|------|------|------|----------|
| SUGGESTION | 子文档 §3 S3 ②a | IR-3 | RPC 路径的 `navigateTree` 需要 `targetId`（目标分支 leaf id）——verifier 需先查询 session tree 拿分支 id（且 session 需先有分支可切），手册未写获取方式；TUI 路径（/tree 交互选分支）自足。不阻塞（pi 标准操作），补一句更符合「命令级手册」标准 | ②a 补「RPC 需先经 get_state/session tree 查询获取 targetId，或优先用 TUI /tree 路径」 |
| SUGGESTION | 子文档 §1 目标句 | 表述精度 | 「完成后 RunStatus 仍含 "paused"（仅创建路径瞬态写入，无持久化写入者、**无消费者**）」——「无消费者」不精确：U1 后 gui-mappers（:44/:69 includes("paused")）与 format.ts（:88 case）仍会消费**旧 v1 快照** reconstruct 出的 paused run（SNAPSHOT_VERSION 在 U2 才 bump）。不影响实施（U1-7 已禁改这些文件、U2-6/U2-7 负责清理），仅目标句概括过度 | 改为「无新写入来源的持久化消费者（gui/format 对旧 v1 快照 paused 的死分支消费在 U2 清理）」或类似限定 |

## 结论

R4 全部 3 MUST_FIX + 5 SUGGESTION 处置经源码逐点复核成立；本轮扩散检查（U1 创建路径不动与其他条目的一致性、U2-2 与 U1 的 lifecycle.ts 行级交叠、F4/F7 新表述与 §1/§2/§3 及父文档 D-1/§5 的交叉）未发现新引入矛盾。**0 must-fix——子文档（workflow-one-shot-lifecycle-impl-spec.md）可交付 builder 实施，父文档与子文档的权威分工（冲突以子文档为准）自洽。** 2 条 suggestion 为表述级完善，可在 U3 文档回写时顺手处理，不构成交付前置条件。
