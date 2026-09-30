# subagent-workflow 体系问题总登记（剩余未修项）

> **本文件定位**：subagent 体系（`packages/subagent-core` / `packages/subagent-engine-sdk` / `packages/pi-subagent-cli` / `packages/zcode-subagent-cli` / `extensions/universal/subagent-workflow` 及 runtime 投影消费链）的剩余问题、待裁决项与收尾跟踪的**单一登记处**。已修复条目随修复批次移出本文件（追溯 = git log 中 2026-09-29 的 fix(subagent) 快速修复批 commit）。
>
> **来源**：2026-09-29 三轮对抗式架构审查（DDD 与六边形视角，关键发现全部经源码核实）+ 既有分散登记合并；§1.4 / §1.5 / §2.1 / §2.2 / §2.3 的正文于 2026-09-30 按源码复核结果修正。修复优先级：§1 行为级缺陷各自独立可单独修；§2 结构性需 tech-design 排期；§3/§4 为一致性收敛；§5 为已裁决记录（四项均已定案）。

---

## 1. 行为级缺陷（已核实，修复最优先）

### 1.1 resume 复活 run 的时间预算在首次错误重试后静默失效（P1）

- 状态：**已修**（2026-09-30 批次，main 线）；run-created 载预算 + resume 三档回落 + 生效预算随 run-resumed 落盘 + spec 重建读取——重试重建与引擎投影同源。遗留：`budgetTokens` 仍未恢复（resume 后 token 上限失效，与墙钟同族，见本批次报告）。

证据链三环（2026-09-29 逐一核实）：
- `packages/subagent-core/src/orchestration/resume-run.ts:838-847`：rebuildRunFromRecord 构造的 spec 只含 scriptSource/args/scriptName/scriptPath/model，**结构性不含 budgetTimeMs**（RunSpec.budgetTimeMs 是 readonly 也无法写回）。
- `packages/subagent-core/src/orchestration/worker-message-pump.ts` remainingTimeBudgetMs：`if (!budget || budget <= 0) return undefined` 在查 D10 复活预算账本**之前**提前返回——账本唯一写入方是 resume 链（noteRunResumedBudget 全仓仅 resume-run.ts:571 调用），即账本唯一写入场景恰好是它结构性读不到的场景。
- 后果链：复活 run 带 time 预算 → 任一 worker/script 错误进重试 → rebuildRuntime → RunRuntime.release 清掉 timer → 预算与引擎级超时（lifecycle.ts:283 `maxTimeMs: spec.budgetTimeMs`）双双静默失效。
- 设计决策点：预算权威源放哪（spec 字段 vs 账本唯一化）；remainingTimeBudgetMs 消费顺序；重试重建的 timer 重排挂点；不传 time 的 resume 是否继承原预算。

### 1.2 worktree reconstruct 的 patch 丢失判定在完整重建之后执行，已重建 worktree 泄漏 + 每续轮重复重建

- 状态：**已修**（2026-09-30 批次）：patch 丢失判定前置（degrade-reopen 变无副作用）；stale git 元数据恢复抽共享原语。

- `packages/subagent-core/src/execution/worktree/worktree-manager.ts`：分支存在性检查最先（:280），patchFile 存在性检查却排在 worktree add / registry.add（:309）/ symlink（:319-325）全部完成之后（:332-335）——该判定只依赖入参路径，完全可以前置。
- 后果：走 degrade-reopen 降级时已重建的 checkout + 注册表条目 + symlink 留存到宿主进程死亡；消费方 conversation-continuation.ts:618 对 degrade-reopen 不接收 handle，下一续轮再进 rebuildWorktreeBinding（:605）→ 每续轮重复全套 git 重建再丢弃。
- 设计决策点：判定前置后 degrade-reopen 语义是否需带「未重建」标记；与 1.3 的 git 元数据清理统一为共享原语。

### 1.3 worktree create() 无 prune-retry，与 reconstruct 不对称——陈旧 git 元数据残留时同 recordId 永久卡死

- 状态：**已修**（2026-09-30 批次）：create/reconstruct 共享陈旧元数据恢复（prune + 分支清理 + 重试）；保留分支不回收维持既有裁决。

- create 前置 rmSync 清目录（:176-182）但不清 git 元数据；上次 create 回滚的 `worktree remove` 失败被 bestEffort 吞掉（:221-224）留下 `<repo>/.git/worktrees/<branch>` 陈旧登记后，`worktree add` 报 already registered 恒失败。reconstruct 对同形态有 prune+重试（:296-305），create 没有。
- 关联登记：keepBranch 保留的 pi-sub-* 分支无终局回收（单调累积），回收策略（TTL / 数量上限 / 显式清理）待裁决。

### 1.4 轮终收尾遇陈旧 extension 上下文崩溃（P1，间歇性，2026-09-22 登记；机制 2026-09-30 核实）

- 症状：GUI 派发 subagent，轮终收尾时 **pi 会话进程** exit 1（登记原文写「runtime 进程」不准确：runtime 只写 `pi-crash-*.log` 并把会话重新拉起，runtime 自身的未处理拒绝只记日志不退出），当轮 record 丢失、轮终 manifest 投影未执行；复验 3 轮仅第 1 轮触发。「supervisor 重启循环约 6 分钟」未能核实（现场证据目录已不在盘上）。
- 调用链（11 跳全无捕获）：onRunSettled（conversation-continuation.ts:337-348）→ settleRoundSuccess / settleRoundFailed（:667 / :701）→ finalizeRoundOutcome（chat-rounds.ts:569）→ finalizeRoundToIdle（:729-745）→ doFinalizeRoundToIdle（finalize-record.ts:266-278）→ store.markRoundIdle → markRoundIdleImpl（record-store-rounds.ts:251，登记原文的行号 :207 已漂移）→ notify-host.ts:82 的 `pi?.events.emit("pending:unregister", …)` → pi 侧 assertActive() 抛错。该步排在 manifest 投影（同文件 :275）之前，所以 manifest 丢失。
- 死亡通道：conversation-continuation.ts:344/:347 用 `void this.settleRoundX(...)` 起了一条无人接的 promise 链，异步抛错变成未处理的 promise 拒绝；pi 在 rpc 模式下没有安装未处理拒绝 / 未捕获异常处理器（0.84.4 只在交互模式注册）→ Node 默认退出，exit 1。
- 陈旧上下文机制（本次核实到窗口级）：pi 在会话替换（newSession / fork / switchSession / reload）时把旧 runner 标记失效——teardownCurrent 的顺序是 session_shutdown → session.dispose()（即失效）→ `await createRuntime()` → 新 session_start → initSession(新 pi)。失效后旧 api 的每个方法首行断言并抛错，文案含 `stale after session replacement`（已登记为 pi 语义断言 PS-30，探针随 pi 版本门禁重验）。
- 命中窗口：SessionBaselines._pi（session-baselines.ts:169）全文只有 initSession（:257）一处赋值、**从不置空**；SubagentService.dispose()（subagent-service.ts:784-823）只置 `_disposed`；reload 分支（workflow-events.ts:540-548）直接返回、跳过清理（有意保留在途 run 交给 reload 后的接管）→ 在途 run 的轮终收尾正好落在「旧句柄已失效、新句柄尚未注入」的窗口里。该窗口已在 workflow-events.ts:138-152 显式登记为设计接受的窗口（降级检查放在消费侧）。
- 缺口定位：陈旧上下文的普查与机器检查只覆盖 `extensions/` 三组目录，`packages/subagent-core` 不在扫描范围内。core 全域同形无保护的 `pi?.` / `getPi()?.` 共 **15 处**（notify-host 4 处 :70/:82/:95/:110；record-store 族 7 处含 :425/:461 的轮终与注册条目写点；subagent-service / finalize-record / sweep-binding / chat-rounds 各 1 处）。只给通知面加捕获，等于把崩溃挪到下一跳（条目写点）且不留痕。
- 修复方向（三者组合，缺一即掩盖或留后门）：(a) 从根源消窗口——session-baselines 增 pi 绑定代际，代际不符时 `get pi()` 返回 null；dispose() 与 reload 分支都显式作废句柄；轮终收尾给有界的「句柄就绪」等待，避免窗口内丢写。(b) 通知路径 best-effort 化（notify-host.ts:69-86 及 :95、:110；core 不能 import `@zhushanwen/pi-ext-guards`，需包内极小分类常量并注释指向 PS-30）。(c) 把 `void this.settleRoundX(...)` 改成带 `.catch(bestEffort)`——消灭「任何轮终链异常 → 整进程退出」这一最坏后果，不只陈旧上下文一种成因。
- 为什么 (b) 单独做属掩盖：注销被吞后 pending 差集残留（要靠下一轮对账补），而同一窗口的条目写点仍会抛；且静默降级的影响面尚无登记。
- 证据与取证：原证据目录 `.tmp/dev-flow/b1b2-verify/` 已不在盘上；复核建议先在 `<dataDir>/logs/` 找 `pi-crash-*.log` 核对崩溃栈是否含上述文案，并与同一 `pi-<date>-<sid>.jsonl` 的 shutdown / start 时间戳对齐。

### 1.5 resume 档 1 补收丢失结构化调用的对象形态（2026-09-30 用户裁决：删除该通道，见 [ADR-0092](../adr/decisions.md)）

- 现状（已核实）：活体链的 schema 调用把校验后对象 `AgentResult.parsedOutput` 写进 agent-settled 事件，但 resume 档 1（结果补收）构造的事件只带 `extractAssistantTextContent` 提取的正文文本（resume-run.ts:531-543，全文件无 parsedOutput）；worker 侧回放恒 `parsedOutput ?? content` 优先（worker-script-builder.ts:183 与缓存路径 :303）→ schema 调用经档 1 补收后脚本拿到 JSON 文本串，且脚本无感知（returnMeta.error 仍为 undefined）。测试覆盖应精确表述为「**对象形态无覆盖**」：档 1 集成用例存在（resume-tier-budget.test.ts:227-252），只断言 content 与 sessionFile。
- 裁决语义（2026-09-29 用户定案，**已被 2026-09-30 裁决取代**）：schema 调用的结果必须是对象形态，**没有文本回落选项**；拿不到对象形态就不该判档 1。
- **2026-09-30 用户裁决（现行，权威登记 = ADR-0092）**：不修补收，**删除「从子代理会话文件复用未提交结果」这条通道**。恢复只保留两种形态——① 该调用已有已提交结果（record 流里那条 `agent-settled`）→ 原样回放、零成本；② 没有 → 重跑（能定位到同一成员会话则续写，定位不到则重开）。删除面 = `classifyResumeTierFromContent` / `dispatchTierCollectFrames` / `planResumeTiers` 里按名字取会话文件的部分，以及由此派生的时间下界、跨库身份查询、按契约判档、契约未知分支、原因枚举；`run-resumed` 档位词收敛为 `continue(tier-2)/restart(tier-3)`，判据换为「能否定位到该调用所属的成员会话」。保留项 = 结果出口按契约判断一处（带 schema 却既无对象也无显式错误时不得静默回落文本，可单独实施）。裁决依据（走查 9 条缺口证明读侧方案无法自洽 + 需求证据为零：本机 7 份 run 记录 / 23 次调用中未完成调用 0 个、`run-resumed` 0 次）见 ADR-0092。
- 附带隐患（**推断成立**：判据形态支持，无 fixture 直证）：档 1 判据 classifyResumeTierFromContent（resume-run.ts:219-245）只看「最后一条 assistant 回复有正文文本块」，不校验结构化输出是否成功配对——崩溃发生在「校验失败轮已落盘、steer 重试未完成」窗口时，未验收文本会被当成结果回放。修复必须一并封住。
- 证据来源（本次核实）：record 流拿不到工具级验收痕迹——mapToolCalls（agent-result-mapper.ts:78-83）只留 `{name, input}`，丢掉 isError 与 details；且被判档的 call 定义上就没有 agent-settled 事件。成员会话文件里有：工具调用是 assistant 消息 content 内的 `{type:"toolCall", id, name, arguments}` 块，工具结果是独立 `role:"toolResult"` 条目并带 `toolName` / `toolCallId`（实测 515/515 配对），权威类型还带 details 与 isError。限制：`packages/session-core` 的 Entry 不保留未知字段 → 方向 A 需直读原始 JSONL 或扩展 session-core。
- 实现要点（方向 A）：该 call 是否结构化调用由 agent-started 事件的 `opts.schema` 判定；是则在补收前从成员会话文件提取最后一个非错误的 `structured-output` 工具调用参数作为对象，补收事件带 parsedOutput；拿不到可信对象就不判档 1，改判档 2 续写重花。补两类测试（对象形态补收 / 未验收不补收）。第二道闸（方向 B，非根因、须与 A 同批）：worker 侧在 schema 调用命中无 parsedOutput 的缓存结果时不回落文本，改为报错或降档。
- 出处：workflow-run-resume-revision 设计 §5 检查点 7。影响窗口窄。

---

## 2. 结构性 / 架构问题（需排期，多数走 tech-design 立项）

### 2.1 双 `RunState` 同名异义（已改名，2026-09-30）

- `orchestration/models/run-state.ts:25`（status / reason / budget / calls / trace / errorLogs / error / scriptResult 执行快照形态，WorkflowRun 聚合持有）vs `orchestration/run-events.ts:613`（lifecycle 五态 + outcome 状态机两维形态，转移表与 fold 消费）。同包同词两义。头部注释「两半各对一半」（2026-09-30 核实）：`RunStore.save 触发持久化` 已失效（壳侧 save 是显式 no-op），`重启时从 JSONL 重新加载` 仍真但**残缺**——loadAll 重建时 `budget` 与 `errorLogs` 不恢复（重启后令牌 / 费用统计归零、诊断日志清空）；「callCache 保留」是错误归因（那是 worker 侧脚本的重放缓存，与重建无因果）。另：「旧形态是 v1 兼容层」只对状态轴成立，budget / calls / trace / errorLogs / scriptResult 是 TUI 的唯一活体数据面，整体当兼容层退役会拆掉 WorkflowsView 的数据源。修法：先做纯改名（如 `RunExecutionSnapshot` / `RunLifecycleState`）+ 注释回写；补齐 budget / errorLogs 重建属行为变更，需先裁决「重启后统计归零是否预期」。
- 同族实例：`isProcessAlive` 在 pid-file.ts:174（三态，EPERM = 不确定）与 persistence/alive-store.ts:91（二态，EPERM = 保守判活）同名异义——警示注释已在 pid-file.ts:170-172；三态版**无任何外部 import**（只在 pid-file.ts 内用），实际无误用面，二态版被 worktree-reconcile / worktree-manager / session-file-gc 消费。`ModelCatalogEntry` 在 core（`{provider, id}`，`orchestration/model-catalog.ts:33`）与 SDK 协议（`{id, aliases?, canonicalRef?}`，`protocol/contract-types.ts:447`）同名不同形，两者之间无类型关联或转换函数（core 那份 extensions/ 零消费，SDK 那份被 `execution/engine/` 6 个文件消费）。


- 状态：**改名与注释回写已完成**（2026-09-30）：
  - `RunState`（执行快照，`models/run-state.ts`）→ **`RunExecutionSnapshot`**（消费面：`models/workflow-run.ts` + barrel；注释回写为「活体执行快照，状态轴权威源已归 record 流 fold；持久化 = record 事件流追加，壳侧 save 是 no-op；重启重建覆盖 status/reason/calls/trace 与 spec，budget 计数与 errorLogs 不重建」）。
  - `RunState`（状态机两维，`run-events.ts`）→ **`RunLifecycleState`**，常量 `INITIAL_RUN_STATE` → `INITIAL_RUN_LIFECYCLE_STATE`（消费面：terminal-actions / run-registry / run-events 测试 / 注释）。
  - 三态 `isProcessAlive`（`execution/engine/client/pid-file.ts`）→ **`probePidAliveness`**（与 `persistence/alive-store.ts` 的二态同名函数脱钩；两函数语义差异真实，刻意不合并，注释已写明）。
  - core `ModelCatalogEntry`（`orchestration/model-catalog.ts`）→ **`PiRegistryModelEntry`**（与 SDK 引擎协议同名类型区分；engine 侧消费的仍是 SDK 类型，未受影响）。
  - 全仓 `RunState` 零残留；core 236 文件 / 3617 用例绿，扩展 typecheck 绿。
- **budget 重建已补齐**（2026-09-30）：新增 core 单源 `orchestration/run-accounting.ts`
  （`runAccountingFromEvents` / `rebuildBudget`），四处归零点收敛为同一口径——壳侧 fold
  （`jsonl-run-store.ts`：条目真值优先，缺席回落帧推导）、终态条目补写（原硬编码
  `usedTokens: 0`）、core `resume-run` 重建（原 `new Budget(maxTimeMs)`）、中断条目
  （原 `usedTokens: 0`）。权重走 `Budget.consume` 同一公式，不引第二套折算。
  - **精度边界（写进代码注释）**：帧推导是**下界近似**——中间失败尝试的消耗不在事件流
    （`agent-retrying` 不载 usage），且两条「写 settled 帧但不计数」路径会让帧计数略大；
    要精确需给 `agent-retrying` 加 usage 字段（改介质，ADR 级）。
  - **errorLogs 明确接受重启即空**：worker `console.*` 捕获不进 record，任何持久面都
    没有；要恢复只能改介质（新增诊断事件 + ADR）。当前形态是**显式接受的债务**，不是遗漏
    （GUI 零消费；TUI 仅 run 级诊断面）。
  - 测试：core 新增 `orchestration/__tests__/run-accounting.test.ts`（6 例：加权口径 /
    缺 usage 帧 / 非 settled 帧不计 / 条目真值优先 / maxTimeMs 条件式）；core 237 文件
    与扩展 76 文件全绿。
### 2.2 run 生命周期状态判定散布（9 处以上）+ 展示层映射未归并（2026-09-30 核实修正）

- 状态表达位置（登记原列 7 处，实测 9 处以上）：`WorkflowRun.state.status` 两态（聚合根，v1 兼容层）、`WorkflowRunMeta.interruptedAt` 标记、record 事件流 fold 五态（唯一权威）、DoneReason 五因、RunOutcome 四值、shared `WorkflowRunStatus` 第三份字面量副本，外加登记未列的 `shared/workflow.ts` 的 `WorkflowDoneReason` 与 `WorkflowRunOutcome` / `WORKFLOW_RUN_OUTCOME_ALL`、runtime `workflow-extractor.ts:69/:72` 的两份副本、`assembly/types.ts:58` 的 `ExecutionStatus`。映射有单点（doneReasonToRunOutcome）但单点两侧仍是两套词表。**值级一致性断言只有 outcome 轴有**（`packages/runtime/test/workflow-outcome-vocab-parity.test.ts`），status 轴没有。
- 展示层同构问题（原 workflow-architecture-backlog G2 并入）：「运行状态 → 展示文案/颜色/图标」映射实测 **7 处 / 4 文件、跨文件零共享**——`interface/format.ts` 内 3 处（:146-161 状态字形 / :451-460 颜色 token / :470-483 徽标文案）+ `interface/views/detail-content.ts:87-95` + `interface/gui-mappers.ts:62-67` 与 `:76-81` + `interface/bg-notify-render.ts:240-264`。唯一的共享是同文件内的 `statusDotStr → statusColorToken`（后者是 private，跨文件无法复用）。
- gui-mappers 现状：对现行真实输入域（ExecutionStatus 的 running / idle）覆盖正确；潜伏错映射格实测 **5 个**（created / settling / interrupted / active 都落 done；terminal 落 done 但丢失 failed / cancelled / time_limited 区分），入参裸 string 无类型防线。数据流不流入有充分类型证据：list 分支唯一入参是 `ExecutionStatus`，「结构性不流入」成立，一旦有人改传 run 域词表或扩字段，错格立刻活跃。
- 状态：**A 档 + run 域 B 档已落**（2026-09-30）。
  - A 档（commit 65dfb19f4）：三处可见错误修复（终局徽标补 `done` 分支 / 失败通知改按 outcome 出 ✗ / `budget_limited`·`time_limited` 色档与徽标对齐）；入参收窄——`statusLabel` 吃 `ExecutionTraceNode["status"]`、`mapRunStatus`/`mapRunIcon` 吃 `ExecutionStatus`（死关键词分支退役，保留运行时兜底）。
  - run 域 B 档（本批）：新增 `interface/display-state.ts`——`RunDisplayState` 单一中间表示 + `runDisplayStateOf`（**不判定状态**，status 直取 core `runSummary`，判定仍 1 个）+ 三张映射（`runToneOf` / `formatRunBadge` / `runDisplaySignaturePart`）。`WorkflowsView` 三处消费点（头部徽标 / footer 的 abort 可用性 / 渲染签名首段）全部切到它上面；签名改为「展示态生命周期面全字段」（新增字段自动进签名，不再依赖 DS8 手工同步表）。
  - **刻意不并域**：`gui-mappers.ts`（子代理执行状态域）与 `bg-notify-render.ts`（通知域）留在各自域——两域与 run 生命周期无共同输入词汇，强行共用一张表是把两套语义塞进一个枚举。日后若收敛 GUI/renderer 侧（`tray-tone.ts` / `WorkflowTab.vue`），等价窄形态进 `shared/src/workflow.ts` 而不是跨包共享本模块。
  - 测试：新增 `interface/__tests__/display-state.test.ts`（15 例：三态投影与可中断性 / 色调·徽标逐形态 / 失败族判定 / **与既有 `formatStatusBadge` 同输入同输出**的防漂移对拍 / 签名片段失效性）；扩展 77 文件 936 例全绿。
- 设计决策点（剩余）：v1 兼容层退役顺序；内活性状态唯一读口（建议 fold checkpoint 进程内缓存）；DoneReason 是否只活在引擎协议侧；展示映射归并形态（先做入参类型收窄，再做单表归并）；补 status 轴的值级一致性断言（对齐 outcome 轴先例）。

### 2.3 orchestration ↔ execution 双向循环依赖（20 / 6 文件；机器检查已落地 2026-09-30）

- 6 个 orchestration 文件 import execution（其中 3 个是值导入；terminal-actions.ts:26-28 一次值 import 5 处），**20 个** execution 文件 import orchestration（登记原写 19；其中 10 个是值导入，例如 execution/service/workflow-dispatch.ts:33-43 值导入 model-catalog / terminal-actions）。终局编排的归属在两域间摇摆。
- 防线现状（2026-09-30 更新）：core 侧的包级值依赖循环检查已落地（`scripts/check-subagent-core-value-cycles.mjs` + 其测试，见 commit 65440e5b1）——「core 内无对应防线」这一条已不成立。剩余工作 = 拆边（终局编排整体入 orchestration，或反向边收窄到端口），属架构排期项。
- 修法方向：先加 core 版循环依赖机器检查止血，再谈拆边（终局编排整体入 orchestration、execution 只暴露 persistence 端口，或反向边收窄到端口）。

### 2.4 领域核心类型反向依赖应用层目录（已修：反向依赖全断 + 领域类型归位两批落地）

- 现状（2026-09-30 更新）：
  - `models/types.ts:23` 的 `WorktreeHandle` 反向依赖**已断**（§2.3 起直连 SDK）。
  - `models/ports.ts:13` 的 `SubagentStream` 反向依赖**已断**（2026-09-30）：新增 shared 最低层结构契约 `src/shared/agent-stream.ts` 的 `AgentStreamSink`（只声明 `onDelta` / `dispose`），编排端口（`ports.ts` AgentRunner）、引擎端口（`engine/port.ts` RunContext.stream）、编排执行器（`execute-agent-call.ts`）与服务层五个透传位置全部改依赖该契约；具体类 `SubagentStream`（应用/UI 层，含 widget 装配）不再是端口的依赖对象，编排层对它零调用（只透传 + 一处 `dispose`）。
  - `ports.ts` 头注「零 infra 依赖（AC-1）」与 `models/types.ts` 头注「D-12 三层架构，AC-1」的引用**仍无权威定义源**（constraints.json 零命中、全史仅自指注释）——要么补成正式约束 + 机器检查，要么删引用（待裁决）。
- **类型归位第一批已落**（2026-09-30）：新增领域模块 `execution/domain/record-types.ts`（零内部依赖：不 import assembly / orchestration），迁出 record 域的**状态与身份词汇**共 21 个导出——状态词表（`ExecutionStatus` / `RecordOrigin` / `ClosedReason` / `StopReason` / `ExecutionOutcome` / `ProjectedOutcome` / `ExternalState` / `ExecutionMode`）、身份与谱系值对象（`Epoch` / `AbandonedRoundMark` / `PiTranscriptRef` / `ZcodeTranscriptRef` / `TranscriptRef` / `AliveMarker`）、配套常量与错误（`RECONNECTABLE_FINAL_REASONS` / `ReconnectableFinalReason` / `CLOSED_REASONS` / `NEW_STOP_REASONS` / `ROUND_TERMINAL_STOP_REASONS` / `STOP_REASONS` / `ResurrectDeniedError`）。`execution/assembly/types.ts` 保留全部 re-export 与内部导入——消费面（~100 处 import + barrel + 壳）零改动，core 237 文件 / 3623 例与扩展 76 文件全绿，值依赖环守卫仍零环。
  - **类型归位第二批已落**（2026-09-30）：新增 `execution/domain/record-model.ts`，迁出 aggregate `ExecutionRecord`（record 聚合根，约 200 行）、`AgentResult`（内嵌调用结果值对象）、两个判定谓词（`isReconnectableFinalReason` / `isValidStopReason`）、两个判别联合守卫（`isPiTranscriptRef` / `isZcodeTranscriptRef`）与 `DEFAULT_AGENT_NAME`；模块只依赖 `./record-types.ts`（同层）与 SDK 契约类型（`Turn` / `ToolCall` / `WorktreeHandle` / `AgentFailureKind` / `AgentUsageTotal`），**不 import assembly / orchestration**（值依赖环守卫 C-data-26 覆盖）。
  - **判断修正（有字段证据）**：`SubagentRecord` **留在 assembly**，不迁领域——其字段含 `eventLog: AgentEventLogEntry[]` 与 `displayItems: DisplayItem[]`，是同时携带领域字段与展示载荷的**应用层读模型**；强行迁入会逼出「领域层 import 展示 DTO」的反向依赖。早先「按领域只读视图放领域层」的判断据此更正（口径不变：业务不变量与业务语言 = 领域；怎么把领域接到外部 = 应用/接口）。
  - 其余刻意留在 assembly 的族不变：装配（`ExecuteOptions` / `ExecutionHandle` / `SessionResolveInput` / `ResolvedSessionContext` / `SubagentsGlobalConfig`）、展示与工具 DTO（`SubagentListItem` / `SubagentToolDetails` / 各 Response / `RecordSnapshot` / `DisplayItem` / `AgentEventLogEntry`）、worktree 错误类与 `PatchResult`。
  - 测试：core 238 文件（唯一红为 `journal-tail` 的 fs.watch 负载敏感 flake，隔离跑 16/16 绿）、扩展 77 文件 936 例绿，两侧 typecheck 与 eslint 干净。

- 剩余（非阻塞，均为「可选深挖」而非未完成项）：
  - 收掉 `assembly/types.ts` 的 re-export：需等应用/接口族（装配 / 展示 DTO / 读模型）也各自归位后一次收口——现在收会让 ~100 处消费面 import 全部改路径，收益（路径语义更准）与代价（大范围 diff + 冲突面）不成比例。
  - `ExecutionRecord` 内混装 `controller` / `worktreeHandle` 等运行时技术资源（「聚合里装了技术资源」）——单独立项拆分，不并入归位。
  - `AgentResult` 在 workflow 侧另有同名类型（`orchestration/models/types.ts` 的 workflow 调用结果）仍待区分命名（§2.1 只处理了执行侧）。
- 判断口径（本轮两次搬迁据它决策，避免被目录带偏）：业务不变量与业务语言的载体、且不依赖外部系统形状 → 领域；描述「怎么把领域接到外部」（入参/返回值/句柄/渲染单元/条目载荷）→ 应用或接口层。

### 2.5 壳层混入领域规则（领域规则部分已修；interface 职责混装属独立议题）

- 状态：**领域规则部分已修**（2026-09-30）。D14 resume args 一致性判定（含篡改检测与三套拒绝文案）已下沉 core 单源 `orchestration/resume-args-guard.ts`，由 `resumeRun` 的资格段用**已读到的** run-created 事件执行；壳 `tool-workflow.ts` 只做装配（`args` + `journalDir`）与成功文案，`readHistoricalArgs` 与壳内的 record 流 JSONL 解析整体删除——第三份平行读实现消失（另两份见 §3.2，已由 core/壳共享校验原语收敛）。
  - 方案取 B（零端口改动）：core 资格段本就已读到 run-created 事件，无需给 `RunStore` 加读原语（该端口是公共 semver 面，宿主自写实现会因此编译期破裂）。
  - 必须同源的一条：壳传入的 `journalDir` = `dirname(store.stateFilePath(runId))`；否则 core 按模块锚解析，多 session 场景会静默读成「无记录」→ D14 静默放行（安全语义反转）。
  - 测试：core 侧新增 `orchestration/__tests__/resume-args-guard.test.ts`（17 例：纯逻辑 + 数据源形态 + 判定文案 + resumeRun 端到端「拒绝且零副作用——不落 run-resumed 帧、不占 run」）；壳侧 `tool-workflow-resume.test.ts` 改为转发契约（args/journalDir 原样下传）；真链路锁 = `scenario-24-args-mismatch-rejection.test.ts`（7 例，文案逐字不变）。
  - 「ADR 候选：D14 判定刻意放壳」随之作废（本就不是刻意——根因是端口无读原语与实现惯性）。
- 遗留（不属本条）：`interface/` 22 文件的职责混装（命令处理 / 格式化 / GUI 映射 / 工具定义 / TUI 基建）单独排期，与领域规则下沉无关。

### 2.6 进程级 globalThis Symbol 槽键前缀混用（已修，2026-09-30）

- 原状：subagent-core 与壳两包共 **18** 个唯一 `Symbol.for` 注册键（登记原文写「17 键 3 前缀」自身加不起来，已核实更正），命名空间前缀 **4** 种并存且与实际归属不符——`@zhushanwen/pi-subagent-workflow.*` 8 个（全部住在 core 内）/ `@zhushanwen/pi-subagents.*` 6 / `@zhushanwen/subagent-core.*` 2 / `@zhushanwen/subagent-engine-sdk.*` 2。撞名无编译期报错，只会静默抢槽。
- 已修：全部 18 键集中在两处声明文件——core `src/shared/global-slots.ts`（统一前缀 `@zhushanwen/subagent-core.`，含壳侧托管槽 dialogQueue / workflowDomainState，经 core barrel 导出；见 commit 65440e5b1）与 SDK `src/global-slots.ts`（SDK 自有 2 键保留 SDK 前缀，因 SDK 不得 import core）。
- 防复发：`scripts/check-global-slot-keys.mjs`（字面量只允许出现在两处声明文件 + 前缀/唯一性校验）+ 约束 C-state-20 + pre-commit/CI 双接线 + fixture 单测 5 例。
- 兼容性须知：改键不破坏跨进程语义（槽是运行时单例，重启即空），但 dev 热重载期间新旧代码各自成槽、需整进程重启收敛。

### 2.7 靠 process.env 探针区分父/子进程角色（路 A 主体已接通，2026-09-30）

- 用户裁决：**路 A**（重新接通身份传递，不退役递归可见性）。
- 已实现（2026-09-30）：
  - 键名单源 = SDK `src/identity-env.ts` 的 `SUBAGENT_IDENTITY_ENV`（12 键 + 值语义注释）；core 的 `ENV_SELF_RECORD_ID` / `ENV_ROOT_SESSION_ID` / `ENV_DEPTH` / `ENV_ROOT_CWD` 与壳、引擎同取该表——写入方与读者键名不再可能各自漂移。
  - 写入方 = pi 引擎 `spawn-runner.ts` 的 `applyIdentityEnvToChildEnv`（纯函数，可单测），在 `buildOutboundChildEnv` 的 **deny 终态之后**写回（relay 归属键同款先例）。值来源分层：`selfRecordId`/`agent`/`task` 取 run 参数；`rootSessionId` 参数优先回落引擎 env；`rootCwd` 引擎 env 优先回落 spawn cwd；`depth` = 引擎 env 深度 + 1；`forkDepth`/`worktree` 继承；`parentRecordId` = 引擎自身 `selfRecordId`；`mode` 继承、缺省 `background`。
  - 关键否定结论（已核实并写进 SDK `env.ts` 注释与引擎开发指南）：**engine-host 的 `identityEnv` 通道不是本项的载体**——引擎宿主长驻（每窗口一个），而身份是 per-run 的（子进程自己的 recordId/depth 每 run 不同），宿主级钉值只能得到粗粒度值。
  - 测试：引擎侧 `src/__tests__/identity-env.test.ts`（4 例：参数面/回落 / 嵌套链贯穿 / rootSessionId 回落与 worktree 声明 / 覆盖既有值）；引擎 26 文件 318 例绿、core 238 文件绿（唯一红为 `journal-tail` 的 fs.watch 负载敏感 flake，隔离跑 16/16 绿，与本次改动无关）、扩展 76 文件绿。
  - 文档：`docs/extensions/subagents/engine-development-guide.md` §9 增「子代理身份 env」义务条目（该文档的更新触发含 env 变更）。
- 遗留（不阻塞本项验收）：
  1. `slug` / `startedAt` / 精确 `mode` 属 record 级字段，协议未携带 → 当前不写，壳读者回落（slug 可选 / startedAt 用 `Date.now()`）。要补齐需把 record 身份挂上 `RunContextParams`（additive），并同批更新 C-proc-23 词表锁。
  2. 真机验收未跑：需嵌套派发（父→子→孙）后核对 `/subagents` 树与子会话文件出现 `subagent-identity` 条目、且 core 三个读者不再判「主进程」。真机命令见 AGENTS.md「extension 改动优先在本地 pi CLI 实测」。
### 2.8 决策记录两处并存（已修，防复发规则已立）

- 状态：**已修**（2026-09-30）：包内 3 个 ADR 与 12 个历史设计文档已删除（仍有效的决策折入 `docs/adr/decisions.md` ADR-0091，git 可追溯；清单：resource-exposure / agentref-path / discovery-session-level、v2/v3/v4 与 workflow-one-shot 族、idle 侦查、dsh 对比、agent-ref-v3）。
- 防复发：`docs/extensions/extension-conventions.md` 新增「决策记录与设计文档归属 [MANDATORY]」——扩展包内不得自建 ADR / 长期设计文档源。
- 遗留一项：`docs/design/recursive-subagent-visibility.md` 是 §2.7 的现行依据（live 代码注释引用），随 §2.7 改写为 `docs/architecture/` 下的现行形态文档后删除包内副本。

### 2.9 测试深路径 import（已裁决关闭，勿重复怀疑）

- 2026-09-29 用户裁决：属 C-ext-27 已裁决设计（测试/bench/mocks 的深路径是 u-2c 决议，测试消费符号不塞 barrel，经 vitest alias + tsconfig paths 双轨解析，不受该约束管辖），本项关闭；否定性结论登记见 §7.8。

### 2.10 subagents 批量 tool 的执行形态（描述已更正，不重构）

- 现状（2026-09-29 核实更正）：handler **不生成脚本文本**——`args = {tasks, agents?, aggregate?}`（`tool-subagents.ts:214-216`）经固定名 `fan-out` 解析内置模板（`:201`）后交 `runWorkflow` 管道执行；旧表述「tasks[] 确定性转译为模板脚本」是更早实现的说法。
- 真正的间接层 = **worker 执行模型**（脚本 eval 进 Worker + postMessage 调用协议），同时是 resume 重放（脚本确定性重跑 + 已 settled 调用走 record 回放）、注入安全（`workerData.scriptPath` 定位 `_shared`，不回退当前目录）与脚本可探索/可测试性（`@pi-meta` 进可用 workflow 清单）三项能力的载体。
- 2026-09-29 用户裁决：**不做一等原语重构**（拆掉会引入第二份「按下标短路」重放实现，收益仅少一层 postMessage 与一次 Worker 启动）；若未来出现性能或调试痛点再立项。

### 2.11 两引擎 server.ts 平行双实现（第一批已落，主循环待续）

- 现状（2026-09-30）：两包各持同名 `EngineProtocolServer`（pi 463 行 / zcode 355 行），约六成逐字同文：`FrameWriter`、`REVERSE_TIMEOUT_DEFAULT_MS`、`ActiveRun`、`handleFrame`、`dispatch`（未知方法错误码）、`cancel`/`read`、`emitEvent`（seq 单调）、`reverseRequest(Internal)`（含写失败就地收尾）、`toProtocolError`（只差恢复文案）。引擎特有 = 引擎实例创建 / 查询面 / `run` 前门与 ctx 还原扩展 / 应答等待语义（pi 两阶段 ack + askUI 结果检查；zcode ack 即结算）。
- **第一批已落（2026-09-30，commit c8e5e3f 一族）**：SDK 新增 `./server` 子入口（`src/server/index.ts`），先收敛声明与纯函数——`FrameWriter` / `REVERSE_TIMEOUT_DEFAULT_MS` / `ActiveRun` / `ReversePending` / `ProtocolErrorPayload` / `toProtocolError(err, recoveryText)`（复用 SDK 单源 `toErrorMessage`）；两引擎 server 改为消费该入口并删除本地副本，恢复指引文案仍由各引擎注入。打包面同批打通：`tsup` entry `server/index` + `package.json` 的 `exports` 与 `publishConfig.exports` 双写 `./server`；`engine-development-guide.md` 的「SDK 消费入口两入口」改为三入口。
- **为什么先做声明层**：§2.11 的真正风险在打包与导出面（CJS/ESM 双形态、`exports` 与 `publishConfig` 双写、tsup 具名 entry），先打通它并保持两套 `server.test.ts` 全绿（pi 26 文件 318 例 / zcode 24 文件 287 例），后续迁主循环时不必再同时面对打包风险。
- 后续批次（未做）：
  1. `handleFrame`（帧分类 + 坏帧应答）与 `dispatch`（未知方法错误码）迁入 SDK，按「纯函数返回动作」形态（`dispatch` 回调注入）。
  2. `initialize`（版本协商 + models 投影）与反向请求客户端（`reverseRequest(Internal)` + clock + 60s 超时 + 写失败就地收尾）迁入，`settleReverse` 的两阶段 ack 语义用钩子开关保留（**不得统一**——统一会让 pi 的 askUser 长等待被判超时；需专门用例）。
  3. `run` 段（差异最大）最后迁；`buildRunContext` 的引擎特有字段走 `buildRunContextExtras` 钩子。
  4. 全过程保持各包导出类名与构造签名不变（两套 `server.test.ts` 即等价性回归网）；骨架不得依赖引擎包内符号、不得有模块级可变状态（CJS 无 splitting 会跨 entry 内联复制）。

## 3. 双实现与词表镜像（一致性收敛，每处需「单源放哪 + 真差异判别」小设计）

### 3.1 同策略双实现（修一处漏一处即漂移）

1. **[已修 2026-09-30] manifest 写面检查逃逸**（R1 名单补 `materializeBoundRecordManifest` + 缩进常量单源）：写面检查 check-record-write-surface R1 只拦七个函数名字面，record-store-rounds.ts:44 经别名 materializeBoundRecordManifest 逃逸，与该文件:75 自己写的「不 import manifest 写函数」注释矛盾；MANIFEST_INDENT_SPACES 双定义（字节格式兼容靠两处都=2）。
2. **[已修 2026-09-30] eventLog/getFullText 派生规则**（deriveEventLog/emptyTurn/addUsage/joinTurnText 单源于 execution-record，副本已删）：session-reconstructor.ts:229-255 对 execution-record.ts:518-540 逐字节复制（含 TURN_SUMMARY_MAX=80 常量副本）——注释自称「避免循环依赖」，实测反向 import 无环，理由不成立；磁盘重建路径走副本。
3. **[已修 2026-09-30] seq journal 基座**（`shared/jsonl-event-journal.ts` 泛型基座 + 两域策略注入；R7 白名单随写者文件更新）：record 域 FileRecordEventJournal.append 与 run 域 FileRunEventJournal.append 各约 90 行 95% 同文，真差异仅 header 行契约与无 seq 存量行兼容两点——可合并为泛型基座。
4. **[已处置 2026-09-30] updateFromEvent 双 reducer**：两份实现保留（core execution-record.ts:451 / SDK journal-replay.ts:321，逐字等价）；新增差分对拍 `packages/subagent-core/src/execution/__tests__/reducer-parity.test.ts`（同一事件序列分喂两侧、逐字段断言）作为真漂移防线——既有 conformance C5 只跑 SDK 侧，不构成防线。原「core 委托 SDK」的收敛方案已**回退**：经 SDK barrel 会把 spawn/env/child_process 整图拖进 core 持久化模块，与 4 个 `vi.mock("node:child_process")` 测试冲突（全量套件 72 例红）；两侧注释已改为「两份 + 差分对拍锁定」。
5. **[已修 2026-09-30] binding 载荷双构造**（身份域子载荷单源，spawn 与 settle 两处共用）：run-orchestration.ts:431-453 手写 15 字段 vs terminal.ts:452-476 fullBindingPayload 人肉同步——两处注释同时记录了历史上两次补字段漏拷贝事故。
6. **[已修 2026-09-30] collectPatch 接线双份**（`worktree/worktree-patch-collection.ts` 单源）：finalize-record.ts:124-137 vs record-lifecycle.ts:337-352（注释自称「同款」）。

### 3.2 record 流严格读面双实现（branch-review R1 条 2 并入）

- **[已修 2026-09-30]** 判据单源：core 导出 `parseRecordStreamLine(line, { requireSeq })`（规则集：JSON/信封/词表/outcome/agent-settled result/seq 宽容度开关）+ `parseLegacyArgsSummary`（旧格式 argsSummary 尽力恢复），两侧读面各留自己的错误文案与 ENOENT 分流；壳侧本地词表投影（`RUN_EVENT_TYPE_SET`）与信封检查（`hasEventEnvelope`）已删。真差异只剩「core 查 seq 断档 + 英文文案」vs「壳不查 seq + 中文文案」。
- core readRecordStreamStrict / rebuildRunFromRecord（resume-run.ts）vs 壳 readRecordStream / foldRecordStreamToRun（jsonl-run-store.ts），其余严格度差异与 fold 面（两侧各自的投影构造）不在本次收敛范围。

### 3.3 「v1 停写」前提被纠偏链打破（数据正确性窗口）——[已修 2026-09-30]

- 原问题：孤儿纠偏路径 `reportSubagentRecord`（恒写 `v:1` 全量快照）+ runtime journal-projection 的 v1 冻结定界优先仲裁（同 id 的 v1 快照遮蔽 v2 fold 投影）——「事件流事实源被投影遮蔽」，方向反了。
- **[裁决]** 无 v1 数据（项目未上线）→ 不迁移不兼容，全量收敛 v2、删除兼容层。
- **[已修] 写侧**：`toSubagentRecordEntry` / `reportSubagentRecord` 与两条 v1 纠偏循环删除；孤儿恢复改由 v2 形态承担——事件文件在者归 `adoptV2Orphans` → `adoptInterruptedRecord`（幂等追加 v2 终态事件 + 终态条目 + manifest 物化）；**新增 entry-only 通道** `recoverEntryOnlyOrphans`（注册条目在、无事件文件、无子文件锚、不在内存）→ 补写 v2 终态条目（`buildEntryOnlyOrphanSettledEntry`，stopReason=interrupted-by-restart）；身份域损坏（agent/task/startedAt 缺失）拒绝重建并 warn，不产无身份幻影条目。
- **[已修] 读侧**：core classification 收为 v2-only（`ok:true` = 当前版本；v1 形态归 `future-v`）；`collectV2EntryPairs` / `v2PairToRecord` 取代 v1 收集/重建路径（含 `entrySourceRecords` 与 `scanLastRecordEntries`）；runtime `v1Subagents`/`v1Workflows` 源与冻结仲裁删除；`subagent-extractor` 与 session-reader 锚链（`entry-anchor` / `zcode-anchor-classify`）改按 v2 条目对读取。
- **[已修] 检查与文档**：`check-record-write-surface` R4 白名单清空（`toSubagentRecordEntry` 回潮即红），R5/R6 保持全域拒绝；ADR-0078 失效清单改写为「已删除」记录、CONTEXT / TEST-STRATEGY / data-source-registry / subagents architecture / e2e-map 同批回写；constraints C-data-20 的表述已就地改好（登记 §3.3 收尾 + R4 白名单清空），随该文件的下一次提交落地——本批未单独提交它，避免把他人未提交的整体改写卷进本次变更。
- 测试面：subagent-core 16 个文件、runtime 16 个文件（src/services/session + src/__tests__ + test/）、session-reader 5 个文件、packages/core 1 个文件、renderer 1 个文件把 v1 播种迁移到 v2 条目族（新增 core 测试辅助 `helpers/v2-record-entry.ts`）；v1 专有断言（closedReason / batchFinalized / eventLog / displayItems / resumable / engineFallback / entry 携带 trace）随载体消亡删除，能改判到 v2 载体的（终态域取 settled 条、身份域取 registered 条）一律保留。
- **[遗留·已登记]** ① `engineFallback` 在 v2 没有任何持久化载体（原 v1 快照携带）——重启后 SubagentTab 的 fallback 提示不可达，需要一次载体裁决（manifest 投影 / binding / 终态条目三选一）；② `record-access.rematerializeReconnectableEntryManifests` 的 gate（`isLegacyClosedSettled ∧ isReconnectableFinalReason(closedReason)`）在 v2 无输入（终态条目不携带 closedReason）——本轮删除该不可达方法，物理判据版自愈（按「终态条目在场但查询面不可见」重物化）待裁决；③ workflow-record（run 族）的 v1 快照分支与 session-reader 旧指针 fallback 不在本轮范围（属 run 侧历史数据处置）。
---

## 4. record 域轮次轴 CAS 缺口

- 「意图原语即状态机（CAS 拒绝表外转移）」在轮次轴不成立：markRoundIdle 唯一保护是 endedAt 终态检查（rounds.ts:190），无 status CAS（错误信息自认「调用方负责 gate」）；markRoundStarted（:132-138）对 running 中的 record 静默清在途轮数据。对照 markReopened（CAS+回滚，terminal.ts:377-425）是全库参照形态。
- 设计决策点：CAS 拒绝语义（抛错 vs 幂等返回 false）；三个生产调用链（finalize-record / run-orchestration / record-lifecycle）是否都保证前置 status==="running" 需逐一核实——可能有调用方依赖「重复调用幂等」现状，补 CAS 会把静默变抛错。

---

## 5. 已裁决项（2026-09-30 用户裁决；四项均已定案）

### 5.1 无主 run 对账清理的持续损坏计数封顶——裁决：**不加封顶，维持现状**

- 事实修正（2026-09-30 核实）：形成「孤儿永不删除」循环的前提比原文更窄——必须是**登记文件每轮写入都失败**（磁盘 / 权限故障）；单纯读侧损坏一轮就会被末尾的原子重写自愈（`orphan-reap.test.ts:252-278` 断言「一次性自愈」）。循环期间不产生误删。
- 裁决理由：① 触发前提是磁盘 / 文件系统已经故障，此时「强制删除」多半同样失败；② 强制删除与维护轮的明文纪律冲突（`run-state-evidence.ts:747-748`：删除只会延后、永不提前）；③ 写失败时日志已带完整恢复指引（该文件可安全删除、下一轮重建），人工介入路径已存在；④ 累积速率极低（每个 run 几件小文件），原子写已消除主成因——加封顶属重复保险式过度工程。
- 留档条件：将来若该循环被现场证据坐实，优先只做「连续写失败升级为告警」，不改删除语义。
- 出处：`.tmp/tech-design/workflow-run-resume-revision/round-3/dispositions.json` D-3-3。

### 5.2 zcode 宿主 run 双源收敛——裁决：**不做，维持挂起**

- run record 单源收敛只在 pi 壳侧落地；core 侧 FileRunStore 已随 commit bd5750b70 退役删除（读侧收敛到 run-state-evidence.ts 的证据判定核）。zcode 引擎当前没有 workflow 编排链路，无落点可做。
- 裁决：维持挂起；等 zcode 出现 workflow 编排需求时，再按「是否直接采用 pi 壳同款 record 单源形态」立项裁决。

### 5.3 workflow resume scriptPath 锚定——裁决：**关闭（候选 A）**

- 关闭判据 = 修复实现 + 确定性回归 + 真机写入侧取证三重验证。**commit 引用修正**：实现是 `1d51b490f`（run-created 携带可选 scriptPath + 双侧恢复 + 六个内置模板检查收紧）；`a32df2905` 只是 A2/A4 回归用例（两个测试文件）——登记原文把实现与回归网混为一谈。
- 真机写入侧证据：记录里字段正确携带、fold 完整走完、无 `Cannot find module _shared`；真机 kill/resume 阶段被无关缺陷（§6.2 zcode provider）阻断，**不再作为关闭前置**。
- 语义不变：内置模板 scriptPath 缺席即报错是防注入安全设计（回退 `process.cwd()` 会打开用户目录误加载通道），修复不改变该语义。

### 5.4 args 撞名防御只盖一个入口——裁决：**扩到所有派发入口（已实现 2026-09-30）**

- 问题：宿主预声明名单（20 名，与模板 IIFE 作用域机器对账）原先只在 AI 生成路径生效；手工编写或拷进来的脚本顶层重声明宿主名（`args` / `$ARGS` / `agent` / …）只会在 Worker 启动后以**异步**语法错暴露，被 worker 错误矩阵吃满 3 次重试才失败，且丢分类与行号。
- 实现（commit `60a628383`）：新增 `orchestration/script-syntax.ts` 承载名单、语法检查与派发期错误类（`WorkflowScriptSyntaxError`）；`runWorkflow` 与 `resumeRun` 在一切副作用之前断言脚本可编译（run 未注册、run-resumed 未落），空脚本文本跳过（旧格式记录无全文）；生成路径的诊断文案保持逐字不变（CA2 前提）。
- 回归网：两个入口各一条用例（失败零副作用）+ 内置模板对账用例（六个模板必须全部通过本闸）+ 原有无效夹具 `execute() {}` 换成合法源码。
- 追溯 = commit `60a628383`；本条移出登记。

---

## 6. 已实施待验证（收尾跟踪）

### 6.1 notify 陈旧上下文崩溃（见 §1.4）——机制已核实（2026-09-30），修复方向定为三段组合

- 修改方向：从根源消窗口（pi 绑定代际 + dispose/reload 显式作废句柄 + 轮终收尾有界等待）+ 通知路径 best-effort 化（含 core 其余同形无保护的 `pi?.`，清单见 §1.4）+ 轮终链改为带 `.catch(bestEffort)`。三段缺一即掩盖或留后门，理由与落点见 §1.4。
- 未核实项：本例与轮终重叠的那一次具体会话替换（需现场日志取证）、「supervisor 重启循环约 6 分钟」的归因。

### 6.2 zcode 引擎 Provider Registry / reasoningLevel 接线（2026-09-29 已落地，剩真机复验）

- 根因定案（bundle 解剖 + 活体探针对拍）：app 3.14.x 起 plan 家族 provider 全部 `access=zhipu-account`（entitlement 门控），CLI 自举 fail-closed——外部 spawn 形态只有 `~/.zcode/v2/provider_config.json` 个人 provider 可装载，plan 家族 id 一律 provider-not-found（报错文案误导性写「不存在 Model」）；GUI 正常因其宿主有完整 env 配方 + 账号供数链；裸起崩溃是 CLI 相对路径推导算到根目录，launcher 目录注入是外部 spawn 启动前提。
- 已落地：preparer.ts 模型源切换 provider_config.json / 缺席模型返回空串走 CLI 缺省；ZCODE_FALLBACK_DEFAULT_MODEL 常量双侧删除；ZCODE_BASE_URL 注入；reasoningLevel 最小档解析经 create 帧 options 自动补档；包全量单测绿。
- 剩余：真机复验（zcode 修复整体收尾后随 a1a4 复跑，剧本成员模型已钉注册表内快档 mimo-v2.6-flash）。
- 关联长期登记：settings 页面引擎默认 provider/model 配置 = `engine-default-provider-setting.md`（保留在 todo，不属本登记范围）。

---

## 7. 否定性结论（2026-09-29 审查核实，后续勿重复怀疑）

1. **防御堆积假设在 notify/ui/lifecycle 三域证伪**：notify 七层防线各自覆盖不同丢失窗口，与设计三路径三桶一一对应；ui 三层错误围栏各承独立契约。
2. **reaper 与 pid-file 无误杀路径**：判据全是身份四元组（宿主死 + 引擎活 + cmdline + lstart 四道闸），无端口/时间窗启发式。
3. **run journal append 物理单写点成立**：全仓恰 1 处生产写点（terminal-actions.ts appendTransition），dispatchRunTrigger 唯一投递漏斗，无第六写点。
4. **reentry-guard check-set 竞态不成立**：acquire 同步无 await，原子性构造性保证。真实窗口是 guard 未进 domain-state 槽（reload 后新旧 guard 并存，窄窗口）。
5. **gui-mappers 现行输入域覆盖正确**（见 §2.2）。
6. **19 组包间同名文件 12 组是合法垫片/参数化收敛形态**，真差异双实现仅 best-effort / logger / data-dir / server 四组且均有文档登记。
7. **worktree reconcile 无误删路径**：判死清理有 mtime+宽限防 create 窗口误清；方向一要求双消失且查询失败保守跳过；歧义宁跳勿删。
8. **测试深路径 import 不是缺陷**（2026-09-29 用户裁决）：属 C-ext-27 已裁决设计——测试/bench/mocks 消费符号不塞 barrel，经 vitest alias + tsconfig paths 双轨解析；生产码深路径由该约束的 ESLint 门单独拦（见 C-ext-27 原文）。
9. **subagents 批量 tool 无文本生成**（2026-09-29 核实）：handler 只做 args 组装与按名解析内置模板，`@pi-meta` 与 `workerData.scriptPath` 注入安全锚均有效；「模板由 tasks[] 生成」的表述与实现不符，已在 §2.10 更正。

---

## 8. 未覆盖次级区域（继续挖的候选，边际收益低）

orchestration 外围工具文件（member-reuse-pool / agent-opts-resolver / workflow-files / skill-discovery / config-loader）、assembly 剩余（concurrency-pool / cold-lookup / channel-registry-access 等）、两引擎包 spawn 链逐行细节（spawn-run-pump 事件转换、zcode parser/session-channel）、壳 views/TUI 组件内部。测试域 2026-09-27 刚做过全量审计，有意跳过。
