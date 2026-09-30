# subagent-workflow 体系问题总登记（剩余未修项）

> **本文件定位**：subagent 体系（`packages/subagent-core` / `packages/subagent-engine-sdk` / `packages/pi-subagent-cli` / `packages/zcode-subagent-cli` / `extensions/universal/subagent-workflow` 及 runtime 投影消费链）的剩余问题、待裁决项与收尾跟踪的**单一登记处**。已修复条目随修复批次移出本文件（追溯 = git log 中 2026-09-29 的 fix(subagent) 快速修复批 commit）。
>
> **来源**：2026-09-29 三轮对抗式架构审查（DDD 与六边形视角，关键发现全部经源码核实）+ 既有分散登记合并。修复优先级：§1 行为级缺陷各自独立可单独修；§2 结构性需 tech-design 排期；§3/§4 为一致性收敛；§5 为裁决输入。

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

### 1.5 resume 档 1 补收丢失结构化调用的对象形态（用户已裁决应修）

- 现状（已核实）：活体链的 schema 调用把校验后对象 `AgentResult.parsedOutput` 写进 agent-settled 事件，但 resume 档 1（结果补收）构造的事件只带 `extractAssistantTextContent` 提取的正文文本（resume-run.ts:531-543，全文件无 parsedOutput）；worker 侧回放恒 `parsedOutput ?? content` 优先（worker-script-builder.ts:183 与缓存路径 :303）→ schema 调用经档 1 补收后脚本拿到 JSON 文本串，且脚本无感知（returnMeta.error 仍为 undefined）。测试覆盖应精确表述为「**对象形态无覆盖**」：档 1 集成用例存在（resume-tier-budget.test.ts:227-252），只断言 content 与 sessionFile。
- 裁决语义（2026-09-29 用户定案）：schema 调用的结果必须是对象形态，**没有文本回落选项**；拿不到对象形态就不该判档 1。
- 附带隐患（**推断成立**：判据形态支持，无 fixture 直证）：档 1 判据 classifyResumeTierFromContent（resume-run.ts:219-245）只看「最后一条 assistant 回复有正文文本块」，不校验结构化输出是否成功配对——崩溃发生在「校验失败轮已落盘、steer 重试未完成」窗口时，未验收文本会被当成结果回放。修复必须一并封住。
- 证据来源（本次核实）：record 流拿不到工具级验收痕迹——mapToolCalls（agent-result-mapper.ts:78-83）只留 `{name, input}`，丢掉 isError 与 details；且被判档的 call 定义上就没有 agent-settled 事件。成员会话文件里有：工具调用是 assistant 消息 content 内的 `{type:"toolCall", id, name, arguments}` 块，工具结果是独立 `role:"toolResult"` 条目并带 `toolName` / `toolCallId`（实测 515/515 配对），权威类型还带 details 与 isError。限制：`packages/session-core` 的 Entry 不保留未知字段 → 方向 A 需直读原始 JSONL 或扩展 session-core。
- 实现要点（方向 A）：该 call 是否结构化调用由 agent-started 事件的 `opts.schema` 判定；是则在补收前从成员会话文件提取最后一个非错误的 `structured-output` 工具调用参数作为对象，补收事件带 parsedOutput；拿不到可信对象就不判档 1，改判档 2 续写重花。补两类测试（对象形态补收 / 未验收不补收）。第二道闸（方向 B，非根因、须与 A 同批）：worker 侧在 schema 调用命中无 parsedOutput 的缓存结果时不回落文本，改为报错或降档。
- 出处：workflow-run-resume-revision 设计 §5 检查点 7。影响窗口窄。

---

## 2. 结构性 / 架构问题（需排期，多数走 tech-design 立项）

### 2.1 双 `RunState` 同名异义（同一 run 域两个完全不同的类型）

- `orchestration/models/run-state.ts:25`（status / reason / budget / calls / trace / errorLogs / error / scriptResult 执行快照形态，WorkflowRun 聚合持有）vs `orchestration/run-events.ts:613`（lifecycle 五态 + outcome 状态机两维形态，转移表与 fold 消费）。同包同词两义。头部注释「两半各对一半」（2026-09-30 核实）：`RunStore.save 触发持久化` 已失效（壳侧 save 是显式 no-op），`重启时从 JSONL 重新加载` 仍真但**残缺**——loadAll 重建时 `budget` 与 `errorLogs` 不恢复（重启后令牌 / 费用统计归零、诊断日志清空）；「callCache 保留」是错误归因（那是 worker 侧脚本的重放缓存，与重建无因果）。另：「旧形态是 v1 兼容层」只对状态轴成立，budget / calls / trace / errorLogs / scriptResult 是 TUI 的唯一活体数据面，整体当兼容层退役会拆掉 WorkflowsView 的数据源。修法：先做纯改名（如 `RunExecutionSnapshot` / `RunLifecycleState`）+ 注释回写；补齐 budget / errorLogs 重建属行为变更，需先裁决「重启后统计归零是否预期」。
- 同族实例：`isProcessAlive` 在 pid-file.ts:174（三态，EPERM = 不确定）与 persistence/alive-store.ts:91（二态，EPERM = 保守判活）同名异义——警示注释已在 pid-file.ts:170-172；三态版**无任何外部 import**（只在 pid-file.ts 内用），实际无误用面，二态版被 worktree-reconcile / worktree-manager / session-file-gc 消费。`ModelCatalogEntry` 在 core（`{provider, id}`，`orchestration/model-catalog.ts:33`）与 SDK 协议（`{id, aliases?, canonicalRef?}`，`protocol/contract-types.ts:447`）同名不同形，两者之间无类型关联或转换函数（core 那份 extensions/ 零消费，SDK 那份被 `execution/engine/` 6 个文件消费）。

### 2.2 run 生命周期状态判定散布（9 处以上）+ 展示层映射未归并（2026-09-30 核实修正）

- 状态表达位置（登记原列 7 处，实测 9 处以上）：`WorkflowRun.state.status` 两态（聚合根，v1 兼容层）、`WorkflowRunMeta.interruptedAt` 标记、record 事件流 fold 五态（唯一权威）、DoneReason 五因、RunOutcome 四值、shared `WorkflowRunStatus` 第三份字面量副本，外加登记未列的 `shared/workflow.ts` 的 `WorkflowDoneReason` 与 `WorkflowRunOutcome` / `WORKFLOW_RUN_OUTCOME_ALL`、runtime `workflow-extractor.ts:69/:72` 的两份副本、`assembly/types.ts:58` 的 `ExecutionStatus`。映射有单点（doneReasonToRunOutcome）但单点两侧仍是两套词表。**值级一致性断言只有 outcome 轴有**（`packages/runtime/test/workflow-outcome-vocab-parity.test.ts`），status 轴没有。
- 展示层同构问题（原 workflow-architecture-backlog G2 并入）：「运行状态 → 展示文案/颜色/图标」映射实测 **7 处 / 4 文件、跨文件零共享**——`interface/format.ts` 内 3 处（:146-161 状态字形 / :451-460 颜色 token / :470-483 徽标文案）+ `interface/views/detail-content.ts:87-95` + `interface/gui-mappers.ts:62-67` 与 `:76-81` + `interface/bg-notify-render.ts:240-264`。唯一的共享是同文件内的 `statusDotStr → statusColorToken`（后者是 private，跨文件无法复用）。
- gui-mappers 现状：对现行真实输入域（ExecutionStatus 的 running / idle）覆盖正确；潜伏错映射格实测 **5 个**（created / settling / interrupted / active 都落 done；terminal 落 done 但丢失 failed / cancelled / time_limited 区分），入参裸 string 无类型防线。数据流不流入有充分类型证据：list 分支唯一入参是 `ExecutionStatus`，「结构性不流入」成立，一旦有人改传 run 域词表或扩字段，错格立刻活跃。
- 设计决策点：v1 兼容层退役顺序；内活性状态唯一读口（建议 fold checkpoint 进程内缓存）；DoneReason 是否只活在引擎协议侧；展示映射归并形态（先做入参类型收窄，再做单表归并）；补 status 轴的值级一致性断言（对齐 outcome 轴先例）。

### 2.3 orchestration ↔ execution 双向循环依赖（20 / 6 文件；机器检查已落地 2026-09-30）

- 6 个 orchestration 文件 import execution（其中 3 个是值导入；terminal-actions.ts:26-28 一次值 import 5 处），**20 个** execution 文件 import orchestration（登记原写 19；其中 10 个是值导入，例如 execution/service/workflow-dispatch.ts:33-43 值导入 model-catalog / terminal-actions）。终局编排的归属在两域间摇摆。
- 防线现状（2026-09-30 更新）：core 侧的包级值依赖循环检查已落地（`scripts/check-subagent-core-value-cycles.mjs` + 其测试，见 commit 65440e5b1）——「core 内无对应防线」这一条已不成立。剩余工作 = 拆边（终局编排整体入 orchestration，或反向边收窄到端口），属架构排期项。
- 修法方向：先加 core 版循环依赖机器检查止血，再谈拆边（终局编排整体入 orchestration、execution 只暴露 persistence 端口，或反向边收窄到端口）。

### 2.4 领域核心类型反向依赖应用层目录

- `models/ports.ts:13` import `execution/assembly/stream-sink.ts`、`models/types.ts:23` import `execution/assembly/types.ts`——models（领域核心候选）的端口签名依赖 assembly 类型，ports.ts 头部自称「零 infra 依赖（AC-1）」名实不符。
- record 域聚合核心 execution-record.ts 的全部领域类型（ExecutionRecord/ExecutionStatus/Turn 等 20 个）定义在 assembly/types.ts——`assembly/types.ts` 实为跨域公共类型堆积处，领域概念的权威定义位置错位。

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

### 2.7 靠 process.env 探针区分父/子进程角色（裁决 = 路 A 接通身份传递；落地契约已核实）

- 原状：`session-lifecycle.ts`（appendSubagentIdentityEntry）以 `PI_SUBAGENT_SELF_RECORD_ID` 是否存在判主/子进程，并从 `PI_SUBAGENT_MODE` 等一组 env 读身份数据；core 三个读者同源——`record-access.ts:146`（子进程跳过孤儿恢复）、`session-baselines.ts:216`（ROOT_CWD）、`:312/:328`（FORK_DEPTH / 执行嵌套基线）。
- 2026-09-30 用户裁决：**路 A**（重新接通身份传递，不退役递归可见性）。
- 已核实事实（决定落地方案）：
  1. 这组 env 在生产**当前无写入方**（SDK `env.ts:75-82` 自记「两键已无写入方」并把判据改到 `TAIJI_AGENT_SUBAGENT=1`；ext-guards `isSubagentProcess()` 已改用新标记）→ core 三个读者在现行引擎链上恒判「我是主进程」。
  2. **不能用 SDK 的 `identityEnv`（`env.ts:82`，engine-host spawn 通道）单独解决**：引擎宿主是长驻进程（每窗口一个），而身份是 **per-run** 的（子进程自己的 recordId / depth 每 run 不同）——在宿主 spawn 时钉值只能得到进程级粗粒度值，SELF_RECORD_ID 这类必须每 run 传递。该通道保留但**不足以**承载本项（其文档里的「待另行裁决」即指此事）。
  3. `ENGINE_ENV_DENY_LIST` 不含 `PI_SUBAGENT_*`，但**含** TAIJI_SUBAGENT_RELAY_* 两键；引擎侧对 deny 键的既有处置 = `spawn-runner.ts:186-191` **post-deny 显式写回**（relay SESSION_ID/RECORD_ID 先例，注释记有「经 extras 注入会被剥掉致退出码 13」的历史事故）——身份键若走 extras 同理会/可能被剥，应照该先例在 deny 终态之后写回。
- 落地方案（四步，落地时逐条核对）：
  1. **SDK 协议**：`packages/subagent-engine-sdk/src/protocol/methods.ts` 的 `RunContextParams`（:72）加 additive 可选 `identity?: { selfRecordId, rootSessionId, depth?, forkDepth?, rootCwd?, agent?, task?, slug?, mode?, startedAt?, parentRecordId?, worktree? }`；同批更新 C-proc-23 词表锁/契约闭合测试与 `docs/extensions/subagents/engine-development-guide.md`（其「更新触发」明列 RunContext 变更须同 commit）。
  2. **core 组装**：`execution/engine/client/remote-engine.ts:600-615` 的 ctx 组装处（现有 additive 字段先例 `ctx.sessionRootId` / `task.cwd`）从 run/record 取身份写 `identity`；嵌套深度取 SDK `ExecutionNestingState`（`nesting-guard.ts`）。
  3. **pi 引擎注入**：`pi-subagent-cli/src/server.ts` 的 `buildRunContext`（:285-340）→ `SpawnRunParams` 增 identity → `spawn-runner.ts:172-192` 的 `buildChildEnv` 在 `buildOutboundChildEnv` **之后**按 identity 写回 `PI_SUBAGENT_SELF_RECORD_ID` / `ROOT_SESSION_ID` / `DEPTH` / `FORK_DEPTH` / `ROOT_CWD` / `MODE` / `AGENT` / `TASK` / `SLUG` / `STARTED_AT` / `PARENT_RECORD_ID` / `WORKTREE`（key 常量单源放 core `execution/service/service-constants.ts` 或 SDK）。
  4. **验收**：真机嵌套派发（父→子→孙）后核对 `/subagents` 树与子会话文件出现 `subagent-identity` 条目（session-reader 路径），并补「写入方 ↔ 读者同源」测试（engine 侧 env 断言 + core 读者单测）。
- 替代路 B（正式退役递归可见性）已被用户否决，无需再论证。

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

### 2.11 两引擎 server.ts 平行双实现无共享底座

- pi（463 行）与 zcode（355 行）各持 EngineProtocolServer 协议主循环，无共享骨架；协议版本不匹配错帧两引擎各自手搓（SDK 构造器 engineProtocolMismatchError 唯一消费方是 core 侧 engine-client.ts:422）。

---

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

### 5.4 args 撞名防御只盖一个入口

- 闸 4 词表（script-generate.ts:46-67 WORKER_IIFE_HOST_DECLARED_NAMES，20 名与模板 IIFE 作用域精确一致）只在 AI 生成工具路径（tool-workflow-script.ts:242）生效；手工编写/入库的 workflow 脚本顶层 `const/let/var args` 依然运行时 SyntaxError → 三次重试全灭，失败形态远离根因。
- 待裁决：防御扩大到 resume/run 入口统一检查 vs 接受现状。

---

## 6. 已实施待验证（收尾跟踪）

### 6.1 notify stale ctx 崩溃（见 §1.4）——待排查根因后裁决修复方向

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
