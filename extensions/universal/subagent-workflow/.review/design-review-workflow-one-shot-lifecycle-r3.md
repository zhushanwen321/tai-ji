# 设计审查报告（第三轮·可开发性）：workflow-one-shot-lifecycle.md

## Summary

**5 must-fix, 5 suggestions.**

一句话总评：方案层（问题定义/方案对比/行为变更诚实性）经 R1/R2 已收敛，但**作为实施与验收的唯一上游输入，本文档当前不足以让 builder 零设计决策实施**——三个结构性缺口：① U1-U4 文件清单**零测试文件**，而 11 个测试文件含 109 处 pause/resume 引用，不改测试 typecheck/test 必挂且 3 类测试需按新语义重写而非纯删；② U1「可独立 commit、独立验收」物理不成立（删 pauseRun export 后 U3 领地的 index.ts/commands.ts/tool-workflow.ts 编译即断）；③ 两处悬置决策（D-2 helper 形态、D-3 discard 落点）实际影响运行时行为与代码形态，不是「实施期定」的细节。补齐这三类缺口后即可进入实施。

## Findings

| 优先级 | 位置 | 维度 | 描述 | 修复方向 |
|--------|------|------|------|----------|
| MUST_FIX | §5 U1-U4 全部 | IR-2 / P0-12 | **四个 unit 的文件清单不含任何测试文件**，S8 验收却要求 `extensions:typecheck`/`extensions:test` 全绿。11 个测试文件 109 处引用（证据清单见下节）：U1 删 pauseRun/resumeRun 后 `lifecycle.test.ts`（43 处，含 `describe("pauseRun")`/`describe("resumeRun")` 整套）**编译失败**；U2 bump v2 后 `jsonl-run-store-session-file.test.ts`（12 处，含构造 paused 快照的用例）失败；U3 后 `command-handlers.test.ts`（10 处）/`gui.test.ts`（12 处）/`index-session-start.test.ts`（6 处）/`WorkflowsView-signature.test.ts`（1 处）断言失败。其中 3 类是**按新语义重写**而非纯删（见下节处置方向），builder 无法不做决策地完成 | 每个 unit 的文件清单补入对应测试文件 + 每类测试的处置方向（删套件/改断言/重写语义），见下节清单 |
| MUST_FIX | §5 U1 + §5 依赖声明 | IR-4 | **U1「可独立 commit、独立验收」物理不成立**。U1 删除 `lifecycle.ts` 的 pauseRun/resumeRun export（:251/:312）后，以下 **U3 领地文件编译即断**：`index.ts:62`（import）/:538/:540/:607（调用）、`commands.ts:25/:109/:110/:218/:219`、`tool-workflow.ts:39/:575/:577`；`lifecycle.test.ts` 同断。U1 验收绑定 S8（typecheck 全绿）+ S1（「stateFile 快照 v2 格式」是 U2 产物）——U1 单独完成时两者均不可达。「U1 是核心、U2/U3 依赖其状态定义」的顺序声明与「可独立 commit」自相矛盾，builder 必须自行发明中间态策略（暂留函数？扩 U1 领地？合并 U1+U3？）——三选一产出不同的 commit 划分 | 定稿 unit 划分策略：或将 pauseRun/resumeRun 的函数删除与全部调用点清理（含 index.ts/commands.ts/tool-workflow.ts 调用点替换为临时 abortRun 或直接完成 D-2 helper）绑进同一 unit；或 U1 只做状态机收敛（WorkflowRun/types/守卫），pauseRun/resumeRun 函数删除挪入 U3；并同步修正各 unit 验收绑定（U1 验收去掉 S1 的 v2 断言） |
| MUST_FIX | §3.1 场景 D、§3.3 D-4、§4 S4 | IR-1 + IR-3 / P0-11 | **S4/场景 D 展示的错误文案在 D-4 设计下不可达**。D-4 要求 action enum 从 schema 删 pause/resume；则 LLM 调 `{action:"pause"}` 会在 **pi 核心参数校验层**被拦截并 throw：`Validation failed for tool "workflow":\n  - /action: <typebox 错误消息>\n\nReceived arguments: ...`（pi 源码 `packages/ai/src/utils/validation.ts:298-306`，`validateToolArguments` 在 execute 之前 throw，扩展无法定制文案、无法附加 👉 指引）。文档场景 D 的精确文案「Unknown action "pause". Supported actions: run, status, abort.」与 S4 ① 的验收断言（该文案 + 指引）没有实现路径。命令侧 S4 ② 同病：`command-actions.ts` 的 `LIFECYCLE_VERBS` 删 pause/resume 后，`/workflows pause <id>` 落 `parseWorkflowRpcCommand` 的 noop 分支，提示「View workflows in the sidebar Flows tab」（commands.ts），与「同语义提示」（pause 已删、用 abort）不符 | 定稿错误文案产生机制并对齐三处（场景 D / D-4 / S4）：a) 接受 pi 默认校验错误，S4 ① 断言改为匹配 `Validation failed for tool "workflow"` 前缀，指引内容转入 description/promptGuidelines（预防性）；b) 若坚持定制文案，需声明实现路径（如 execute 内运行时校验——与「enum 删 pause」矛盾，需改 D-4）。命令侧需声明未知 verb 的报错文案落点（parse 层新增分支 or 保留 noop） |
| MUST_FIX | §3.3 D-2 落点 1、§5 检查点 2 | IR-1 | **D-2 helper 形态二选一是行为分歧，不是实现细节**。选项 A「复用 abortRun 骨架」若指直接调 `abortRun(runId, deps, "Session switched...", "failed")`，会附带 `emit pending:unregister` + `deps.onRunDone?.(run)`（lifecycle.ts:388-392）——Interface 层通知（含完成通知链）被触发；选项 B「自抽 helper」只 transition+save，不发事件。session 切换时 run 转 failed **是否触发 onRunDone 通知是用户可见行为差异**，两个 builder 产出不同行为。session_start 先例（index.ts:457-464）发 `pending:unregister` 但不发 onRunDone——文档未声明 session 切换路径对齐哪个先例 | D-2 落点 1 定稿为单选 + 副作用清单（pending:unregister 发不发、onRunDone 发不发、state.error 原因串字面值），从「待验证检查点」中移除 |
| MUST_FIX | §3.3 D-3、§5 U1、§4 S7 | IR-1 + IR-5 | **discardInFlightCalls「挪入崩溃重建路径」的落点与同步约束未定，且正确窗口唯一**。该函数的精确性前提是「与 abort 同步执行、无 await 间隔，此时在飞 call 仍为 running/pending」（lifecycle.ts:272-275 注释自述）。崩溃路径的正确落点只有一个：`rebuildRuntime`（error-recovery.ts:140-158）内 **`run.replaceRuntime(...)`（:157，同步 abort 旧 controller + terminate 旧 worker）之后同步调用**——replaceRuntime 同步返回时 finalizeCall 尚未发生（execute-agent-call.ts:153-155 的 finalize 在 `await runner.run` resolve 后的 microtask），可精确清理。若 builder 放在 `handleWorkerError` 入口或 `scheduleRebuild` delay 之前：delay 退避（≥1s）期间在飞 call 可能**自然完成并把真结果写入缓存**，被误删 → 重跑重复消耗 token（直接违反 D-3 自己的验收 S7「已完成的 agent 调用不重复消耗 token」）；若放在任何 await 之后：call 已 finalize 为 "done"（假失败），`status !== "done"` 过滤挡不住 replay 假失败。另外 S7 的注入构造覆盖不了「在飞时崩溃」断言：脚本顶层 `await agent()` 期间脚本暂停，`process.exit(1)` 无法在调用进行中执行——需 `setTimeout(() => process.exit(1), delay)` 异步触发技巧，S7 步骤未给出 | U1 改动描述补 discard 落点（rebuildRuntime 内 replaceRuntime 后同步调用）+ 为什么（时序窗口）；S7 补注入脚本全文（含 setTimeout 异步 exit 构造「在飞崩溃」、两个 agent 调用序列），使 verifier 可复制执行 |
| SUGGESTION | §5 U1 文件清单 | IR-4 / P1-8 | U1 清单遗漏 `orchestration/models/types.ts`——RunStatus 定义（:27）、RUN_TRANSITIONS 转换表（:41）、ALL_RUN_STATUSES（:46）才是「状态定义」所在；文档称 workflow-run.ts 是「状态定义与契约所在」属事实错位。另 `interface/views/format.ts:88`（`case "paused": "⏸ PAUSED"` 状态徽章 + :42 注释）不在任何 unit 清单且 S8 grep（`"paused"` 带引号）会命中 | U1 清单补 types.ts；U3 清单补 format.ts。顺带 D-6 注释清单补 run-state.ts:25/:28/:34、run-spec.ts:21/:33（现役能力描述注释，S8 第二条 grep 会命中）；run-runtime.ts:30 的 `ReleaseMode = "pause" \| "terminal"` 字面量不在 S8 grep 模式内，需 D-6 显式覆盖（或保留并注明历史语义） |
| SUGGESTION | §3.3 D-1 | IR-1 | 「创建即 running」的合并形态仍有自由度：构造函数直接接受 runtime（assignRuntime 失去全部调用方后是否删除）vs 保留两步但改造前置校验；且现状 `deps.runs.set`（lifecycle.ts:205）先于 `workerHost.start`（:211），一步化后 worker start 抛错时 run 是否已注册的时序行为随之改变。S1/S2/S7 行为验收可兜底，不阻塞，但预期形态一句话写明更稳 | D-1 补预期形态（建议：构造函数接受 runtime、初始即 running；assignRuntime 与 runs.set 时序调整一并声明） |
| SUGGESTION | §4 S5/S6/S7 | IR-3 | S1/S2/S4 命令级可操作（环境模板 + 内置 workflow 名齐全）；S5（「跑一个脚本内 workflow("chain.js", {...}) 嵌套调用的自定义脚本」——嵌套调用的全局函数签名/最小示例未给）、S6（「极小 tokens 预算」——传参方式是 tool 参数 `tokens:N` 还是 args 字段，未写）、S7（注入脚本全文，见 MF-5）需 verifier 自行发明脚本 | 三个场景各补最小脚本全文或传参示例（S5：嵌套脚本模板；S6：`{"action":"run","name":"...","tokens":100}` 示例；S7：见 MF-5） |
| SUGGESTION | §2.1 事实2、§3.3 D-4 | IR-5 / P1-8 | 行号与描述小偏移（不影响决策）：scheduleRebuild 重检实际在 error-recovery.ts:752（文档/§2.1 引 :736 为函数声明行）；commands.ts 解析调用实际 :99、case 实际 :101-103（文档写 :83/:105-107）；WorkflowsView 按键分支实际 :433-446（文档 :435-446）；gui-mappers paused 分支实际 :44/:69（:34 是注释规则行）；error-recovery :699 是 handleScriptError 守卫，R1 起称「replay 判断」不准（replay 判断在 dispatchAgentCall 的 cached 路径） | 引用处按实测行号校正；「4 处守卫」的逐处语义描述改为「stale 消息/stale error/stale exit/script error 守卫」 |
| SUGGESTION | §3.3 D-5 | IR-5 | D-5 只提「快照 status 枚举收窄」，未提 `meta.pausedAt` 字段的处置（workflow-run.ts:53-54 定义、jsonl-run-store.ts:205 反序列化重建、序列化侧投影）。删 paused 态后该字段永不写入——保留（无害，向后兼容）还是 v2 内删除，一句话定 | D-5 补一句：pausedAt 保留 or 删除（若删除，deserializeRun 与 RunSnapshot 投影同步） |

## 悬置决策点清单（IR-1 全量列举，含判定）

| # | 位置 | 悬置内容 | 判定 | 依据 |
|---|------|---------|------|------|
| 1 | §5 检查点 2 | D-2 helper 形态（复用 abortRun 骨架 vs 抽新 helper，「以不引入循环依赖为准」） | **阻塞 → MUST_FIX（MF-4）** | 两形态产出**不同运行时行为**（abortRun 附带 pending:unregister + onRunDone，自抽 helper 不发）；「循环依赖」根本不是二者的分辨依据——两个都不引入循环依赖（index.ts 已 import abortRun，无环） |
| 2 | §5 检查点 1 | S7 注入点「已定稿且源码核实可达」 | 半悬置 → 并入 MF-5 | 两路注入（process.exit(1)/顶层 throw）确实可达（R2 已核，本轮复查 worker-script-builder 链路属实），但「在飞时崩溃」的断言（S7 后半）无构造路径（顶层 await 期间脚本暂停），需 setTimeout 异步 exit——脚本全文缺失 = verifier 自行发明 |
| 3 | §5 检查点 3 | executeNestedWorkflow 轮询是否引用 paused | 不阻塞 | grep 实证：launcher.ts 的 pollRunToResult/runAndWait 无 paused 引用（「grep 未命中，实施时编译期确认」与实测一致），检查点可关闭 |
| 4 | §3.3 D-1 契约调整 | assignRuntime 前置校验怎么改、assignRuntime 去留、runs.set 时序 | 不阻塞 → SUGGESTION（SG-2） | 编译期强制 + S1/S2/S7 行为验收兜底，产出形态差异不影响验收判定 |
| 5 | §3.3 D-3 | discardInFlightCalls「挪入崩溃重建路径」的具体落点 | **阻塞 → MUST_FIX（MF-5）** | 落点影响正确性（唯一正确窗口 = replaceRuntime 后同步调用）；放错位置直接违反 S7 自己的断言（误删真结果→重复耗 token / 挡不住假失败 replay） |
| 6 | §3.1 场景 D / S4 | 错误文案的产生机制 | **阻塞 → MUST_FIX（MF-3）** | 文案在 schema 收窄设计下由 pi 核心生成、不可定制；builder 面临三选一设计决策 |
| 7 | §5 表格「U1 是核心（U2/U3 依赖其状态定义）」+ 每 unit「可独立 commit」 | unit 间编译依赖的真实方向 | **阻塞 → MUST_FIX（MF-2）** | U1 删 export 反向破坏 U3 文件编译；「独立 commit」与依赖顺序矛盾 |

## 测试文件影响清单（IR-2 grep 证据，文件:行号 + 处置方向）

grep 模式 `pauseRun|resumeRun|paused`，范围 `src/**/__tests__/*.test.ts`（本项目测试在 `src/**/__tests__`，非 `tests/`）。共 11 文件 109 处：

| 测试文件 | 命中数 | 关键行 | 性质 | 归属 unit | 处置方向 |
|---|---|---|---|---|---|
| `src/orchestration/__tests__/lifecycle.test.ts` | 43 | :131 `describe("pauseRun")`、:191 `describe("resumeRun")`（:132/:192/:211/:239/:257 用例）、:491 W3TC1 淘汰白名单、:2/:9/:11/:14/:22/:23 import 与 mock | **编译断**（直接调用已删函数） | U1 | 删两个 describe 套件；W3TC1 淘汰用例改断言（paused 从白名单表述中移除）；import/mock 清理 |
| `src/__tests__/gui.test.ts` | 12 | :32-33 `mapRunStatus("paused")→"running"`、:79-80 `mapRunIcon("paused")→"pause"`、:102-105、:426-438 pause action → stats-line | **断言失败**（删分支后 mapRunStatus("paused") 落 default） | U3 | 删 paused 映射用例；pause/resume lifecycle action 用例随 WorkflowToolDetails 收窄删除 |
| `src/orchestration/__tests__/jsonl-run-store-session-file.test.ts` | 12 | :279/:368-404/:530-549（构造 paused 快照与 loadAll 断言） | **断言失败**（v2 不再有 paused） | U2 | paused 快照构造用例删除或改写为「v1 旧文件跳过」用例；v2 序列化断言新增 |
| `src/__tests__/command-handlers.test.ts` | 10 | :194「RPC + pause + runId → pauseRun 调用」、:214、:221、:25/:27/:39 mock | **断言失败 + mock 断** | U3 | 删 pause/resume 命令用例；mock 对象删 pauseRun/resumeRun；按 S4 ② 新报错语义补未知 verb 用例 |
| `src/execution/__tests__/index-session-start.test.ts` | 6 | :147-153 `vi.mock(lifecycle, pauseRun: mockPauseRun)`、:383-416 W2TC16「pause 之后 dispose」顺序断言 | **需重写**（mock 与顺序断言语义随 D-2 helper 改变） | U3 | W2TC16 重写为「running→done,failed 落盘之后 dispose」顺序断言（形态取决于 MF-4 定稿） |
| `src/orchestration/__tests__/error-recovery-handlers.test.ts` | 3 | :13/:209/:211（守卫测试的 paused 用例） | 断言失败 | U1 | paused 守卫用例删除或改为 isTerminal 单判据语义 |
| `src/orchestration/__tests__/error-recovery-workflow-call.test.ts` | 3 | :9/:141/:160 | 同上 | U1 | 同上 |
| `src/orchestration/__tests__/launcher-nested-workflow.test.ts` | 2 | :23-25 deps mock 含 `pauseRun/resumeRun: vi.fn()` | 多余 mock 字段（通常不报编译错，视 LifecycleDeps 类型对齐） | U1 | mock 字段清理 |
| `src/orchestration/__tests__/workflow-nesting-e2e.test.ts` | 2 | :23-25 同上 | 同上 | U1 | 同上 |
| `src/execution/__tests__/crash-recovery.test.ts` | 1 | :139 `status: "running" \| "paused" \| "done"` 独立 union 类型 | 类型宽于新 RunStatus（不报错），语义待收窄 | U1 | union 收窄为两态 |
| `src/interface/views/__tests__/WorkflowsView-signature.test.ts` | 1 | :108（渲染签名含 paused 条件） | 断言失败 | U3 | 按按键分支简化改写 |

## 事实抽核记录（IR-5，逐条 ✓/✗）

| # | 文档声称 | 核实 | 结论 |
|---|---------|------|------|
| 1 | pauseRun :251 / resumeRun :312 / discardInFlightCalls :288 / MUST_FIX 注释 :265 / 创建 paused :178 / assignRuntime :220 / abortRun paused 防御 :374（lifecycle.ts） | 逐行读 lifecycle.ts 全文 | ✓ 全部精确 |
| 2 | index.ts session_tree :527-545（pauseRun :538）/ session_shutdown :594-607（:607）/ session_start 恢复 :453-465（state.error + transition :458-460） | 读 index.ts:440-619 | ✓（恢复逻辑实测 :457-465，1-2 行偏移不影响） |
| 3 | workflow-run.ts:222-224 assignRuntime `requires status==="paused"` 前置校验 | 读全文 | ✓ |
| 4 | error-recovery 4 处执行级守卫 :178/:624/:667/:699 | grep + 读上下文 | ✓ 精确命中（handleWorkerMessage/WorkerError/WorkerExit/ScriptError） |
| 5 | **4 守卫简化为 isTerminal 单判据语义正确**（IR-5 重点） | isTerminal=done（:108-110）；runtime 释放且 status 变 done 的场景由 isTerminal 覆盖；replaceRuntime（status 保持 running）场景的 stale 事件由 WorkerHandle.isCurrent 在 infra 层吞掉（worker-handle.ts:84-114 onMessage/onError/onExit 三回调均 `if (!this.current) return`）；pause 场景删除后不复存在 | ✓ 语义正确 |
| 6 | scheduleRebuild :736 重检 | 重检代码实际 :752（:736 是函数注释区） | ✗ 行号偏移（SG-4，不影响决策） |
| 7 | SNAPSHOT_VERSION `wf-run-v1` + bump/跳过先例（jsonl-run-store.ts:61-65） | 读 :55-100 | ✓（:61 常量、:59-62 注释） |
| 8 | D-2 落点 1「复用 abortRun 的 transition+save 骨架」两形态均可行 | abortRun（:354-393）骨架存在且 save 为 await ✓；但两形态**行为不同**（abortRun 附带 pending:unregister+onRunDone :388-392） | ✓ 可行 / ✗ 未披露行为差异（→ MF-4） |
| 9 | D-3「崩溃重建路径同样存在 abort 假 failed 入缓存场景」 | rebuildRuntime（:140-158）→ replaceRuntime → release("terminal") → controller.abort()（run-runtime.ts:82-90）；execute-agent-call.ts:153-155 abort 后 finalizeCall 入缓存 | ✓ 机制存在；但**挪入位置的正确窗口唯一且未定**（→ MF-5） |
| 10 | S4 场景 D 错误文案「Unknown action "pause". Supported actions: run, status, abort. + 👉」 | pi 核心 `packages/ai/src/utils/validation.ts:298-306`：schema 校验失败 throw `Validation failed for tool "workflow": - /action: ...`，发生在 execute 之前，扩展不可定制 | ✗ 文案不可达（→ MF-3） |
| 11 | tool-workflow enum :54-67 / runId 描述 :83 / actionLifecycle :556；commands 补全 :76-78；WorkflowsView ViewActions :129-130 / 按键 :433-446 / actionParts :696-698；gui-mappers paused :44/:69 | 逐处读 | ✓（commands 解析 :99/case :101-103 与文档 :83/:105-107 有偏移，SG-4） |
| 12 | 检查点 3：executeNestedWorkflow 轮询无 paused 引用 | grep launcher.ts（pollRunToResult/runAndWait/executeNestedWorkflow 路径） | ✓ 无命中，检查点可关闭 |
| 13 | S7 两路注入可达（process.exit(1) / 顶层 throw） | R2 已核 worker-script-builder eval 内联 + WORKER_TEMPLATE catch→error 链路；本轮复查属实 | ✓（但「在飞时崩溃」构造缺失，→ MF-5） |
| 14 | 验收素材存在（workflows/chain.js、review-fix-loop.js、README.md） | ls workflows/ | ✓ |
| 15 | U1 文件清单「workflow-run.ts 是状态定义与契约所在」 | RunStatus/RUN_TRANSITIONS/ALL_RUN_STATUSES 实际在 models/types.ts:27/:41/:46 | ✗ 归属错位（SG-1） |

## 与 R1/R2 的关系说明

R1 的 4 MUST_FIX、R2 的 4 SUGGESTION 修复情况经本轮抽查均维持有效（假前提修正、行为变更声明、index.ts 纳入 D-4/U3、S7 注入点链路、V4 P5 摘要、state.error 落点均属实）。本轮未发现前轮结论错误；全部 findings 为 R2 之后视角切换（implementation readiness）暴露的新问题。P0-1/2/3/7/8/9/10/13/14/15/16/17/18 复扫维持 R2 通过判定，本轮修订未破坏结构。
