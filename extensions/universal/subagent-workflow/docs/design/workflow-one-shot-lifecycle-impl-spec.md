# Workflow 一次性生命周期 — 实施规格（U1/U2/U3）

> **一句话结论**：父文档（`workflow-one-shot-lifecycle.md`）是方案层，本文档是其下一层产物——文件级改动规格，是实施与验收的**唯一权威输入**。全部原「实施期确认」悬置点已在本文档定稿（§0 总表）；builder 不得再引入设计决策，verifier 按本文档逐项验收。两文档冲突时，以本文档为准（更细粒度）。

## 层声明

- **当前层**：文件级改动规格（接口/数据模型/错误规格/测试处置/验收手册）
- **上游**：`workflow-one-shot-lifecycle.md`（方案与决策依据，D-1~D-6 编号在父文档）
- **实施方式**：3 个串行 unit（U1 行为删除 → U2 类型与持久化收窄 → U3 文档回写），每个 unit 独立 commit、typecheck/lint/test 全绿、按本文档验收

---

## §0 定稿决策总表（原悬置点 → 定稿值）

| # | 原悬置点（父文档位置） | 定稿 | 依据 |
|---|---|---|---|
| F1 | D-2 落点 1 helper 形态「复用 abortRun 骨架 vs 抽新 helper，以不引入循环依赖为准」（§5 检查点 2） | **新增独立导出 `terminateRunningRuns(deps, reason)`**（lifecycle.ts）。per-run 行为：`state.error = reason` → `transition("done","failed")`（内部先 releaseRuntime，A4）→ `await store.save(run)` → `eventBus.emit("pending:unregister", {id, reason:"failed"})`。**不调 `deps.onRunDone`**。单 run 失败（try/catch + log）不中断其余 run | 对齐 session_start 恢复先例（index.ts:456-465：发 unregister、不发 onRunDone）——session 切换/关闭语境下主 agent 已离开本 session，发完成通知只会把消息注入已离开的 session。不复用 abortRun 因其附带 onRunDone（lifecycle.ts:392）行为不同；两者也无循环依赖差异（index.ts 已 import 两者） |
| F2 | D-3 discardInFlightCalls 挪入崩溃重建路径的落点 | **函数从 lifecycle.ts 移入 error-recovery.ts（模块级私有），调用点唯一：`rebuildRuntime` 内 `run.replaceRuntime(...)` 之后同步调用（无 await 间隔）**。源码 MUST_FIX (round-4 #1) 注释随移除，按新语境重写 | replaceRuntime 同步 abort 旧 controller + terminate 旧 worker；在飞 executeAgentCall 的 finalize 发生在 `await runner.run` resolve 后的 microtask——同步点在飞 call 仍为 running/pending，`status !== "done"` 过滤精确命中。放 delay 退避之前会误删退避期间自然完成的真结果（重跑重复耗 token）；放任何 await 之后假失败已 finalize 挡不住 |
| F3 | S4/场景 D 错误文案机制（父文档原断言「Unknown action "pause". Supported: run, status, abort + 👉」不可达） | **工具侧接受 pi 核心校验拦截**：action enum 删 pause/resume 后，`{"action":"pause"}` 在 pi `validateToolArguments`（execute 之前）throw `Validation failed for tool "workflow": ...`，扩展不可定制。预防性指引（one-shot 语义、用 abort）写进 tool description 与 promptGuidelines。**命令侧定制提示**：command-actions.ts 新增 `REMOVED_LIFECYCLE_VERBS`，`/workflows pause|resume <id>` 解析为 `{action:"lifecycle-removed", verb}`，commands.ts 输出定制文案（§2.1.U1-6 定稿文案） | pi 核心拦截本身即结构化错误（LLM 可见 enum 与 Received arguments，重试可自纠）；为定制文案保留 enum 是「保留能力宣传」，违背 G3 |
| F4 | D-1「创建即 running」合并形态（assignRuntime 去留、runs.set 时序） | **两段归位（R4 定稿）**：**U1 完全不动创建路径**（初始 `status:"paused"` 两步保留——U1 后 RunStatus 三态仍是合法值，assignRuntime 前置校验 `requires status==="paused"`（workflow-run.ts:222-224）无需动；paused 在创建路径中仅存于同步代码窗口，落盘时（save 在 assignRuntime 后）已是 running）。**「创建即 running」整体挪 U2**，与 types 收窄同 commit：① runWorkflow 初始 status 改 "running"；② `deps.runs.set` 从 worker.start 之前（:205）移到 assignRuntime 之后；③ assignRuntime 前置校验改 `status==="running" && runtime===undefined`；④ 构造函数 `validateInvariants`（workflow-run.ts:102→:125-138）的 I1 构造期检查（:127-132 `running && runtime===undefined → throw`）**改为构造期跳过 I1（仅查 I2 等），I1 完整校验移入 assignRuntime 末尾**（transition 内保持）——否则「构造即 running」撞构造期 I1 fail-fast，任何 run 无法创建。I1 窗口（构造到 assignRuntime 间）对外不可见由 runs.set 后移保证 | 「构造直接吃 runtime」成循环引用（makeHandlers 闭包需捕获 run 实例，构造先于 handlers）；「构造期保留 I1 校验」与「创建即 running」物理冲突（构造时 runtime 必为 undefined）。runs.set 后移兼得「worker.start 抛错时无孤儿注册」 |
| F5 | unit 划分「U1 独立 commit」编译依赖矛盾 | **两阶段垂直切分**：U1 = 行为删除（RunStatus 类型暂留 "paused" 死值）；U2 = 类型/快照收窄（删死值）。U1/U2/U3 全串行（领地交叉：lifecycle.ts 等被 U1/U2 先后触碰） | RunStatus 收窄的一瞬间，WorkflowsView `=== "paused"` 比较（:438/:446/:696）等全部编译断——类型收窄无法与行为删除拆为两个可独立编译的 commit；先删行为（paused 成为无写入者无消费者的死值，编译全绿）再收窄类型，两个 commit 都可独立全绿 |
| F6 | meta.pausedAt 字段处置（D-5 未提） | **v2 内删除**：workflow-run.ts 定义（:53-54）+ jsonl-run-store.ts 反序列化重建（:205）+ 序列化投影同步删。旧 v1 文件整体跳过，无兼容负担 | 保留 = 永不写入的死字段；v1 已跳过无迁移路径 |
| F7 | S7「在飞时崩溃」注入构造（顶层 await 期间脚本暂停，process.exit 不可达；且脚本重跑后 setTimeout 再次注册——注入必须「仅首次执行」） | **`setTimeout(() => process.exit(1), 300)` 异步触发 + 缓存命中判别**：以 PHASE_A 的返回耗时区分真跑与 replay（真跑为 LLM 调用秒级，replay 命中为同步 Map 查找 <50ms），仅首次真跑注入，重跑不再注入。脚本全文见 §3 S7 手册 | 顶层 await 只暂停 JS 控制流，不阻塞 libuv timer；worker thread 内 setTimeout 标准可用（worker-script-builder 无沙箱层，R3 核实）；「仅首次注入」保证 rebuild 后 b 重跑成功 → completed 自愈路径可达（R4 发现的脚本自反问题由此消除） |
| F8 | ReleaseMode = "pause" \| "terminal"（run-runtime.ts:30，pause 场景删除后 "pause" 无调用方） | **收窄为 `"terminal"`**（U2） | run-runtime.ts:26 注释自述两值行为等价、仅为调用方语义可读性；"pause" 语义随 pauseRun 消失 |
| F9 | executeNestedWorkflow 轮询是否引用 paused（父文档检查点 3） | **关闭**：R3 grep 实证 launcher.ts pollRunToResult/runAndWait/executeNestedWorkflow 无 paused 引用，无需改动 | — |

---

## §1 U1 — 行为删除（pause/resume 全链路 + session 终止重定位）

**目标**：pause/resume 从全部接口面与生命周期消失；session 切换/关闭当刻 run 转 done,failed；discard 重定位进崩溃重建。**创建路径不动**（初始 "paused" 瞬态两步保留——paused 仅存在于同步代码窗口，落盘时已是 running）；完成后 RunStatus 仍含 "paused"（仅创建路径瞬态写入、无持久化写入者；消费者仅剩升级前遗留 v1 快照经 loadAll 恢复的 gui/format 死分支——U2 删），typecheck/lint/test 全绿。

### 1.1 源码改动清单

**U1-1 `src/orchestration/lifecycle.ts`**

| 位置（现状） | 改动 |
|---|---|
| 模块头注释 :8-9 | 导出清单重写：runWorkflow / abortRun / terminateRunningRuns / evictDoneRunsBeyondCap / scheduleTimeBudget；删除 pauseRun/resumeRun 行；:18-23 的 A4/G3-001 段中「pause/abort」「pause 时整个 RunRuntime 丢弃」「resume 时 assignRuntime 重建」表述改写为 abort/terminate/rebuild 语境 |
| `runWorkflow` :155-235 | **U1 完全不动创建路径**（初始 status:"paused" 两步 + runs.set :205 + assignRuntime :220 保留原序——F4 两段归位，「创建即 running」整体属 U2） |
| `pauseRun` :251-279 | **整函数删除** |
| `discardInFlightCalls` :288-297 | **整函数移出本文件**（移入 error-recovery.ts，见 U1-2）；本文件删除 |
| `resumeRun` :312-338 | **整函数删除** |
| 新增（置于 abortRun 之后） | `terminateRunningRuns`（F1 定稿签名）：`export async function terminateRunningRuns(deps: LifecycleDeps, reason: string): Promise<void>`。遍历 `deps.runs.values()`，对 `status==="running"` 的每个 run 执行：`run.state.error = reason` → `run.transition("done","failed")` → `await deps.store.save(run)` → `deps.eventBus?.emit("pending:unregister",{id:run.runId,reason:"failed"})`；per-run try/catch（log error 带 runId/reason，继续下一个 run）。JSDoc 注明：不发 onRunDone（对齐 session_start 恢复先例——主 agent 已离开本 session，注入通知无意义）；不调 discardInFlightCalls（run 已终态不再 replay，缓存无关紧要） |
| `scheduleTimeBudget` :115-119 注释 | 「run/resume 各启动一个」→「runWorkflow 启动」；「pause+resume 重置墙钟预算」语义描述删除（改为 rebuildRuntime 重排） |
| `evictDoneRunsBeyondCap` :403/:427 注释 | 「与 paused（resumeRun 可恢复）永不淘汰」→「与 running（活跃执行）永不淘汰」；:427「running/paused 误删」→「running 误删」 |

**U1-2 `src/orchestration/error-recovery.ts`**

| 位置 | 改动 |
|---|---|
| `handleWorkerMessage` :177-178 守卫 | `if (isTerminal(run) || run.state.status === "paused") return;` → `if (isTerminal(run)) return;` |
| :624 stale 完成守卫 | 删除 paused 条件（保留 isTerminal/等价判据，具体形态 builder 对照原句——判据统一为「run 已终态」） |
| :667 error 计数污染防护 | 同上 |
| :699 handleScriptError 守卫 | 同上（注意：该处是 script-error 守卫，非 replay 判断——父文档原文「replay 判断」不准确，此处更正） |
| 注释 :169/:177/:218/:346/:414/:453/:622/:698 | 「终态/paused」→「终态」等 paused 措辞清理 |
| `rebuildRuntime` :140-158 | **`run.replaceRuntime(new RunRuntime(...))`（:157）之后同步插入 `discardInFlightCalls(run);`（无 await）**。函数从 lifecycle.ts 原样移入本文件（模块级私有），注释按 F2 定稿重写：清除被旧 runtime abort 的在飞 call——replaceRuntime 同步 abort 旧 controller，在飞 call 尚未 finalize（finalize 在 `await runner.run` resolve 后的 microtask），此刻仍为 running/pending 可精确清理；genuinely-done call 保留（重跑 replay）。**移除源码 `MUST_FIX (round-4 #1)` 标记** |
| :148-152 注释 | 「直到 pause/resume 才重排」→「直到 rebuildRuntime 重排」（该注释描述历史 bug 语境，保留 bug 描述但更新指向） |
| `scheduleRebuild` :736-752 | paused 重检分支删除（保留终态重检） |

**U1-3 `src/index.ts`**

| 位置 | 改动 |
|---|---|
| :62 import | `pauseRun, resumeRun` 删除，增 `terminateRunningRuns` |
| session_tree handler :527-545 | :527 注释「切分支前 pause 所有 running run」→「切分支前终止所有 running run」；:535-543 的 for 循环 + `await pauseRun(...)` + bestEffort 替换为：`try { await terminateRunningRuns(makeDeps(state, ctx), "Session switched: run terminated"); } catch (err) { bestEffort(err, "terminateRunningRuns (session_tree handler)"); }` |
| session_shutdown handler :594-619 | :585/:587/:598 注释「pause workflows」→「terminate workflows」；:603-605 W2C5 编排顺序注释重写为「terminate（await，failed 落盘——重启后 kill-9 恢复不误判）→ store.dispose → delete」；:606-608 `await Promise.allSettled(running.map((run) => pauseRun(run.runId, makeDeps(state, _ctx))))` 替换为 `await terminateRunningRuns(makeDeps(state, _ctx), "Session shutdown: run terminated")`（:602 的 running 数组预过滤删除——helper 内部自过滤） |

**U1-4 `src/interface/tool-workflow.ts`**

| 位置 | 改动 |
|---|---|
| :39 import | `pauseRun, resumeRun` 删除 |
| `WorkflowAction` :54-59 + `WORKFLOW_ACTIONS` :61-67 | 删 `"pause"` / `"resume"`（类型与数组同步） |
| `runId` 参数描述 :83 | `"Workflow run ID (pause/resume/abort)"` → `"Workflow run ID (abort action)"` |
| execute case :372-377 | 删 `case "pause"` / `case "resume"` 两分支（default never 穷尽检查自然适配三 action） |
| abort 处理函数 :556 起 | pause/resume 分支删除（保留 abort；若函数内 verb 分发依赖 WorkflowAction，随类型收窄同步） |
| tool description + promptGuidelines :330-342 | ① `- pause/resume/abort: {"action":"pause","runId":"<id>"} (abort optional: ,"error":"<reason>"})` → `- abort: {"action":"abort","runId":"<id>"} (optional: {"error":"<reason>"})`；② 新增一次性语义句（F3 预防性指引）：`Runs are one-shot: there is no pause/resume — to stop a run early use abort; for a fresh result start a new run.` |

**U1-5 `src/interface/commands.ts` + `src/interface/command-actions.ts`**

commands.ts：

| 位置 | 改动 |
|---|---|
| :25 import | `pauseRun, resumeRun` 删除 |
| `STATUS_ORDER` :34-38 | 删 `paused: 1` 行（running:0 / done:2 保留，权重不重排——注释 :190「running/paused 优先」→「running 优先」） |
| description :68 | `"Open workflow panel. /workflows [runId] | /workflows pause|resume|abort <runId>"` → `"Open workflow panel. /workflows [runId] | /workflows abort <runId>"` |
| 补全 :74-80 | 删 pause/resume 两项（保留 abort）；:83 `parts[0] === "pause" || parts[0] === "resume" ||` 条件删除 |
| RPC case :104-119 | 删 pause/resume 分支（:109-111 的 pauseRun/resumeRun 调用与 :112 pastTense 三态逻辑——abort 单态后 pastTense 固定 `"aborted"`）；新增 `case "lifecycle-removed"`：`ctx.ui.notify(\`Workflow \${parsed.verb} has been removed — runs are one-shot. To stop a run early: /workflows abort <runId>\`, "warning")` |
| openView ViewActions 注入 :218-219 | `pause: (runId) => pauseRun(runId, deps)` / `resume: ...` 注入删除（ViewActions 对象收窄为仅 abort） |

command-actions.ts：

| 位置 | 改动 |
|---|---|
| `WorkflowRpcAction` :18-23 | 删 pause/resume 成员；新增 `| { action: "lifecycle-removed"; verb: "pause" | "resume" }` |
| `LifecycleVerb` :26 + `LIFECYCLE_VERBS` :29 | 收窄为 `"abort"` / `new Set(["abort"])` |
| 新增 | `const REMOVED_LIFECYCLE_VERBS: ReadonlySet<"pause" | "resume"> = new Set(["pause", "resume"]);` |
| `parseWorkflowRpcCommand` :67-77 | verb 判定顺序：`REMOVED_LIFECYCLE_VERBS.has(verb)` → 返回 `{action:"lifecycle-removed", verb: verb as "pause"|"resume"}`（含无 runId 与有 runId 两种——removed verb 优先于 missing-id 判定，提示语义优先）；`isLifecycleVerb(verb)` → abort 分支不变 |
| 注释 :59-66 | 格式说明更新（pause/resume → removed 提示） |

**U1-6 `src/interface/views/WorkflowsView.ts`**

| 位置 | 改动 |
|---|---|
| `ViewActions` :129-130 | 删 `pause` / `resume` 成员 |
| 按键分支 :433-446 | `p` 键 pause/resume 分支删除（保留 `a` abort；:438 `=== "paused"` / :446 `=== "paused"` 比较随之删除） |
| :696-698 | `actionParts` 的 `p pause` / `p resume` 删除（:696 `status === "paused"` 比较删除） |
| :572 footer 提示 / :21 / :248 注释 | `p pause` 措辞与 pause/resume 能力描述删除 |

**U1-7 领地外禁改**：`models/types.ts`（RunStatus 三态保留——U2）、`models/workflow-run.ts`（创建路径/构造契约/assignRuntime 校验全不动——「创建即 running」整体属 U2）、`jsonl-run-store.ts`、`gui-mappers.ts`、`views/format.ts`、`tool-workflow.ts` 的 WorkflowToolDetails 类型（:232/:286-288——与 gui.test.ts pause action 用例同 unit 处置，归 U2）本 unit 不碰。

### 1.2 U1 测试处置

| 测试文件 | 处置 |
|---|---|
| `src/orchestration/__tests__/lifecycle.test.ts` | 删 `describe("pauseRun")`（:131）与 `describe("resumeRun")`（:191）整套；:491 W3TC1 淘汰白名单断言改（paused 从「不可淘汰」表述中移除）；:2/:9/:11/:14/:22-23 import 与 mock 清理；**新增** `describe("terminateRunningRuns")`：① 多 run 仅 running 被终止（done 不动）；② 每 run 发 pending:unregister、不调 onRunDone；③ state.error = reason、reason 字段 = "failed"；④ 单 run save 抛错不中断其余（其余 run 仍落盘） |
| `src/orchestration/__tests__/error-recovery-handlers.test.ts` | :13/:209/:211 paused 守卫用例改为 isTerminal 语义（paused 输入用例删除）；**新增** rebuildRuntime 后 discardInFlightCalls 生效用例（在飞 call 清除、done call 保留） |
| `src/orchestration/__tests__/error-recovery-workflow-call.test.ts` | :9/:141/:160 同上处置 |
| `src/orchestration/__tests__/launcher-nested-workflow.test.ts` | :23-25 deps mock 删 `pauseRun/resumeRun` 字段 |
| `src/orchestration/__tests__/workflow-nesting-e2e.test.ts` | :23-25 同上 |
| `src/__tests__/command-handlers.test.ts` | :194/:214/:221 pause/resume 命令用例删除；:25/:27/:39 mock 删两函数；**新增** `/workflows pause <id>` → lifecycle-removed 提示文案断言 |
| `src/execution/__tests__/index-session-start.test.ts` | :147-153 `vi.mock(lifecycle, {pauseRun: mockPauseRun})` 改 mock `terminateRunningRuns`；:383-416 W2TC16 重写为「terminateRunningRuns 完成（save 落盘后 resolve）→ store.dispose」顺序断言 |
| 全量 | `pnpm extensions:typecheck && pnpm extensions:lint && pnpm extensions:test` 全绿（U1 后 paused 为死值，jsonl/gui 等测试仍测三态属预期——它们在 U2 处置） |

### 1.3 U1 验收绑定

S1（快照 v2 断言除外）+ S2 + S4 + S7 + S8a（§3 手册）。S8a = `grep -rn "pauseRun\|resumeRun" src/` 在 U1 领地（7 源文件 + 8 测试文件，含 builder 裁决扩入的 command-actions.test.ts 与 robustness-low-batch1.test.ts）内零命中；全域残留仅限清单外 6 处（gui.test.ts:429/:437 fixture 字符串、trace.ts:156 / budget.ts:103 / run-runtime.ts:27 / jsonl-run-store-session-file.test.ts:404 存量注释——全部已在 U2 §2 处置范围，全域真零命中由 S8b 断言）。

**R6 裁决补遗（builder 实施发现，规格测试清单原遗漏 2 文件）**：

| 测试文件 | 遗漏原因 | 处置 |
|---|---|---|
| `src/__tests__/command-actions.test.ts` | R3 grep 模式 `pauseRun\|resumeRun\|paused` 不命中 verb 字面量（`action: 'pause'`），但它是契约 #4（parseWorkflowRpcCommand 收窄）的直接单测文件 | 4 用例改断言 `{action:"lifecycle-removed", verb}`（pause/resume × 有/无 runId） |
| `src/__tests__/robustness-low-batch1.test.ts` | 不含 pause 关键词，但 F2 把 discardInFlightCalls 移入 rebuildRuntime 后，该文件的 duck-typed run mock（无 `state.calls`/`state.trace`）在 rebuild 路径抛 TypeError | mock 的 state 补 `calls: new Map(), trace: { removeByStepIndex: vi.fn() }` |

---

## §2 U2 — 类型与持久化收窄

**目标**：RunStatus 收窄两态 + 「创建即 running」（构造/assignRuntime 契约同步调整，F4 第二段）+ 快照 v2 + 死值/死分支/死字段清零（含 WorkflowToolDetails 死类型）。前置：U1 已 commit。

### 2.1 源码改动清单

**U2-1 `src/orchestration/models/types.ts`**

- :20-25 状态机注释：3 态图 → 2 态（`running → done`，done 唯一终态）
- :27 `RunStatus = "running" | "done"`
- :40-44 `VALID_RUN_TRANSITIONS = { running: ["done"], done: [] }`
- :46 `ALL_RUN_STATUSES = ["running", "done"]`

**U2-2 `src/orchestration/models/workflow-run.ts` + `src/orchestration/lifecycle.ts`（创建即 running，F4 两段归位的第二段）**

- workflow-run.ts：① `validateInvariants`（:102→:125-138）的 I1 构造期检查（:127-132）改为**构造期跳过 I1（仅查 I2 等），I1 完整校验移入 assignRuntime 末尾**（transition 内保持）——「创建即 running」要求构造瞬间 running 无 runtime 合法；② `assignRuntime` 前置校验（:222-224）改 `status==="running" && runtime===undefined`（原 `requires status==="paused"` 随 paused 值删除而失效）；③ `releaseRuntime` 内 `release("pause")` 硬编码（:243）改 `release("terminal")`（F8 收窄后类型强制）；④ `meta.pausedAt` 定义（:53-54）删除（F6）
- lifecycle.ts `runWorkflow`：① 初始 `status:"paused"`（:178）改 `"running"`；② `deps.runs.set`（:205）移到 `run.assignRuntime(runtime)`（:220）之后（save / pending:register 顺序不变）——I1 窗口对外不可见 + worker.start 抛错无孤儿注册

**U2-3 `src/interface/tool-workflow.ts`（死类型收窄，与 gui.test.ts 同 unit）**

- `WorkflowToolDetails` lifecycle 分支 `action: "pause" | "resume" | "abort"`（:232）收窄为仅 `"abort"`
- `buildWorkflowGui` 的 severity 分支（:286-288，`details.action === "pause"` warn 判定）简化为 abort 单分支
- 与 §2.2 `gui.test.ts` :426-438 的 pause/resume action 用例**必须同一 unit**（先收窄后删用例会中间态挂测试，反之亦然）

**U2-4 `src/orchestration/models/run-runtime.ts`**

- :30 `ReleaseMode = "terminal"`（F8）；:24-29 注释（「pause 与 terminal 等价」段）改写为单一 terminal 语义；release 的 `@param mode` 注释同步

**U2-5 `src/orchestration/jsonl-run-store.ts`**

- :61 `SNAPSHOT_VERSION = "wf-run-v2"`
- :205 反序列化 `meta.pausedAt` 重建删除；快照 status 类型随 types 收窄（本文件如含 `"paused"` 显式分支/字面量，grep 清零）
- :59-65 bump/跳过注释补 v2 条目（「wf-run-v2：status 两态、无 pausedAt；v1 文件 loadAll 静默跳过——含 v1 running 残留跳过 = 静默消失不显示，接受（父文档 D-5 边界声明）」）

**U2-6 `src/interface/gui-mappers.ts`**

- :34-44 `mapRunStatus` 删 `s.includes("paused")`（注释 :38「含 paused」表述删）
- :63-69 `mapRunIcon` 删 `s.includes("paused")`（注释 :63「paused → pause」删）

**U2-7 `src/interface/views/format.ts`**

- :88 `case "paused": return ...PAUSED` 删除；:42 注释 `"paused"` 字样删

**U2-8 注释清理（现役能力描述）**

- `models/run-state.ts` :25/:28/:34、`models/run-spec.ts` :21/:33、`lifecycle.ts` 残余、`run-runtime.ts` :46-47（「resume 会重新调度」注释）——grep `"paused"|pause/resume` 逐处清（S8b 断言）

### 2.2 U2 测试处置

| 测试文件 | 处置 |
|---|---|
| `src/orchestration/__tests__/jsonl-run-store-session-file.test.ts` | :279/:368-404/:530-549 构造 paused 快照的用例**改写为 v1 跳过用例**（v1 头 + paused 快照 → loadAll 跳过、不崩、不显示）；新增：新 run 快照 `version === "wf-run-v2"`、status 无 paused、序列化投影无 pausedAt |
| `src/__tests__/gui.test.ts` | :32-33/:79-80 paused 映射用例删；:102-105/:426-438 pause/resume lifecycle action 用例随收窄删 |
| `src/interface/views/__tests__/WorkflowsView-signature.test.ts` | :108 渲染签名按按键简化改写（无 p pause/p resume） |
| `src/execution/__tests__/crash-recovery.test.ts` | :139 `"running" \| "paused" \| "done"` union 收窄两态 |

### 2.3 U2 验收绑定

S3（kill-9 + session 切换完整两路）+ S5 + S6 + S8b（`grep -rn '"paused"' src/` 零命中（历史注释/CHANGELOG 除外）**且 `grep -rn "pauseRun\|resumeRun" src/` 全域零命中**（U1 遗留的 6 处在 U2 一并清：trace.ts:156 / budget.ts:103 / run-runtime.ts:27 存量注释改写、gui.test.ts:429/:437 fixture 字符串改名、jsonl-run-store-session-file.test.ts:404 注释改写）+ 旧 v1 快照启动不崩不显示 + 新快照 v2 + 三命令全绿）。

---

## §3 验收执行手册（S1-S8，真实 pi 环境）

**环境模板**（所有场景共用；`$WF` = `<workspace>/feat-subagent-continuous-chat/extensions/subagent-workflow`（按本机实际 workspace root 替换））：

```bash
SESSION_DIR=/tmp/wf-one-shot-$(date +%s)
TAIJI_AGENT_DEBUG=1 pi --mode rpc --session-dir "$SESSION_DIR" \
  --model xiaomi-token-plan-cn/mimo-v2.5-pro --approve --extension "$WF"
# stdin 发 prompt JSONL 驱动主 agent 调 workflow 工具（pi rpc-mode 标准 prompt 命令；
# 首次执行时把实际 prompt 报文记入验收报告）
```

**注入脚本**（S7 专用，验收前写入 `/tmp/crash-mid-flight.js`；schema 最小化为 word 单字段。**脚本必须带 `@pi-meta` 头且声明 `phases`**——registry 经 config-loader 的 `parseResourceMeta`（`src/shared/meta-parser.ts`）解析脚本 meta，meta 必填字段为 name（非空）/ description / phases（数组），任一缺失则 parse null → registry 标 `available=false` → `sourceCode=""`，runWorkflow 以空脚本启动、秒完成 completed（scriptResult=null、零 agent 调用——U1 verifier 实测裸脚本两次复现，注记 ①）。**「仅首次注入」判别**：以 a 的返回耗时区分真跑与 replay——真跑为 LLM 调用（秒级），replay 命中为同步 Map 查找（<50ms）；重跑时 a 秒回故不再注入，保证 b 重跑成功 → completed 自愈路径可达（F7））。最终脚本全文（U1 verifier 实测跑通版本）：

```js
// /tmp/crash-mid-flight.js
// $ARGS.crashAt: "second"（PHASE_B 在飞时 worker 退出，仅首次执行注入）
//                | "always"（每次执行（含重跑）都在 PHASE_A 前退出）| "none"（不注入）
// $ARGS.throwAt: "always"（顶层 throw，脚本错误路）
/* @pi-meta
name: crash-mid-flight
description: S7 崩溃自愈验收注入脚本（crashAt/throwAt 控制注入路径）
phases: [agents]
parameters:
  type: object
  properties:
    crashAt: { type: string, enum: ["second", "always", "none"] }
    throwAt: { type: string, enum: ["always"] }
*/
const SCHEMA = { type: "object", properties: { word: { type: "string" } }, required: ["word"] }
if ($ARGS.throwAt === "always") throw new Error("injected script error")
if ($ARGS.crashAt === "always") process.exit(1)
const t0 = Date.now()
const a = await agent({ prompt: "Reply with exactly: alpha", schema: SCHEMA })
// 真跑 > 500ms（LLM 调用）；replay 命中 < 50ms（同步缓存查找）。仅首次真跑注入。
if ($ARGS.crashAt === "second" && Date.now() - t0 > 500) {
  setTimeout(() => process.exit(1), 300)
}
const b = await agent({ prompt: "Reply with exactly: beta", schema: SCHEMA })
return { a, b }
```

**嵌套脚本**（S5 专用，`/tmp/nested-chain.js`；嵌套 name 走 `deps.registry.getPath(name)`——launcher.ts:328，与 actionRun 同一解析方法（registry-impl.ts:77），绝对路径口径已核实（R4）；worker 全局 `workflow(name, args)` 存在于 worker-script-builder.ts:354）：

```js
// /tmp/nested-chain.js
const inner = await workflow("/abs/path/to/chain.js", { task: "分析当前目录结构" })
return { inner }
```

| # | 场景 | 步骤（命令级） | 通过标准 |
|---|---|---|---|
| S1 | 正常完成回归（U1） | 发 prompt 令主 agent 调 `{"action":"run","name":"<WF>/workflows/chain.js","args":{"task":"分析当前目录结构"}}` → 等完成通知 | status done/completed；result 含三步产出；**U2 后追加**：`$SESSION_DIR/workflow-state/<runId>.jsonl` 首行含 `"version":"wf-run-v2"` |
| S2 | 主动 abort（U1） | run `<WF>/workflows/review-fix-loop.js`（args targetType:"text" 长任务）→ 进行中发 `{"action":"abort","runId":"<id>"}` | done/aborted；`ps aux \| grep -i "pi\|worker"` 无残留 worker 与 pi 子进程；`{"action":"status"}` 列表显示 aborted |
| S3 | 崩溃与切换作废（U2） | ① run review-fix-loop → 进行中 `kill -9` 主 pi 进程 → 同 SESSION_DIR 重启 pi；②a run review-fix-loop → **分支导航**（优先 TUI `/tree` 选择另一分支；RPC `navigateTree` 需先从 session 树获取目标 branchId，步骤繁复不推荐）→ 切回；②b run review-fix-loop → **切 session**（TUI `/new`，或 RPC `switch_session`）→ 切回 | ① 残留 run 显示 done/failed 且 state.error 含 "Process killed"；无 running 幽灵；②a 切回后 run 显示 failed、state.error 含 **"Session switched"**（session_tree 路径）；②b 同显 failed、state.error 含 **"Session shutdown"**（session_shutdown 路径——`/new` 与 `switch_session` 都走 before_switch + shutdown，不触发 session_tree）；resume 任何形态不可达 |
| S4 | 已删能力指引（U1） | ① 工具调 `{"action":"pause","runId":"<id>"}`；② 命令 `/workflows pause <id>`（RPC 通道） | ① 结构化错误，文本匹配 `Validation failed for tool "workflow"`（enum 拒绝），无成功 payload；② 提示 `Workflow pause has been removed — runs are one-shot. To stop a run early: /workflows abort <runId>`；③ 命令补全列表无 pause/resume（注记：pi rpc-mode 无补全探测入口——rpc-mode 无 completion 命令，不可 E2E 探测，以源码 diff 为证：`getArgumentCompletions` 补全列表仅剩 `abort`，二段条件 `parts[0] === "abort"`——U1 verifier 注记 ③） |
| S5 | 嵌套回归（U2） | run `/tmp/nested-chain.js` | 父子均 done/completed；子 run 的 token 消耗计入父（`{"action":"status"}` 父 run 预算字段含子消耗；对照单独跑 chain.js 的量级） |
| S6 | 预算终态（U2） | `{"action":"run","name":"<WF>/workflows/chain.js","args":{...},"tokens":100}` | done/budget_limited；无 pause 分支残留行为 |
| S7 | 崩溃自愈（U1） | ① `crashAt:"second"` run → 观察自愈完成；② `crashAt:"always"` run → 观察重试耗尽；③ `throwAt:"always"` run → script error 重试。token 对照前先 `touch /tmp/wf-marker`（`-newer` 基准） | ① `result = {a:{word:"alpha"}, b:{word:"beta"}}`——**b 重跑成功即 discard 生效**（若 discard 失效，b replay 假失败/abort 错误）；**a 不重复消耗 token**：`find ~/.pi/agent/subagents -name "*.jsonl" -newer /tmp/wf-marker` 中 PHASE_A 对应子进程 session 文件恰 1 份（重跑不新增）、PHASE_B 恰 2 份（崩溃前 + 重跑）；**rebuild 以行为证据判定**——rebuild 路径（handleWorkerExit/scheduleRebuild/rebuildRuntime）无 deps.log 调用，扩展日志查不到 rebuild 字样（U1 verifier 实测注记 ②）：`meta.workerErrorCount=1`（崩溃 1 次 + rebuild 1 次）+ 上述 session 文件计数 + 最终 scriptResult 正确；② 3 次重建后 done/failed（workerErrorCount 计数至 4 耗尽）；③ 同为重试后 failed（scriptErrorCount 分账，两条计数互不污染——快照 meta 计数可证：always 路 worker=4/script 未设，throwAt 路 script=4/worker 未设） |
| S8 | 静态断言（U1=S8a / U2=S8b） | `grep -rn "pauseRun\|resumeRun" src/`；`grep -rn '"paused"' src/`；启动含旧 v1 快照的 session；`pnpm extensions:typecheck && pnpm extensions:lint && pnpm extensions:test` | S8a（U1 后）：pauseRun/resumeRun 零命中 + 三命令全绿（"paused" 死值仍在，允许）。S8b（U2 后）：`"paused"` 零命中（types/workflow-run/run-runtime/jsonl-run-store/gui-mappers/format/run-state/run-spec 及全部 src 注释；CHANGELOG 与本 docs/ 除外）+ 旧 v1 快照不崩不显示 + 新快照 v2 + 三命令全绿 |

---

## §4 U3 — 文档回写

| 文件 | 改动 |
|---|---|
| `workflows/README.md` | pause/resume 能力描述删除，补一次性语义句（与 tool description 一致：runs are one-shot; abort is the only early-stop） |
| `interface/tool-workflow.ts` | description/promptGuidelines 终稿核对（U1 已改，U3 对照代码终态复核防漂移） |
| `CHANGELOG.md` | breaking change 条目：① workflow tool action enum 收窄（run/status/abort——pause/resume 移除，调用得 Validation failed）；② /workflows 命令 verb 收窄（pause/resume → removed 提示）；③ session 切换/关闭时 running run 从「挂起可 resume」变更为「作废转 failed」（token 投入作废）；④ 快照格式 v1→v2（旧文件跳过） |
| 源码注释残余 | `grep -rn -i "pause\|resume" src/` 逐处审：历史/迁移说明（CHANGELOG 引用、本文档引用）保留，现役能力描述清零 |

U3 验收：S8b 注释 grep 复跑 + README/CHANGELOG 人工核对。
