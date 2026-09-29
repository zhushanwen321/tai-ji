# subagent-workflow 体系问题总登记

> **本文件定位**：subagent 体系（`packages/subagent-core` / `packages/subagent-engine-sdk` / `packages/pi-subagent-cli` / `packages/zcode-subagent-cli` / `extensions/universal/subagent-workflow` 及 runtime 投影消费链）的问题、待裁决项与收尾跟踪的**单一登记处**——取代此前分散的多份一事一文件登记（已随本文件清空，内容全部并入）。
>
> **修复进度（2026-09-29 快速修复批，8 个并行 subagent + 主会话收口）**：已落地——§1.2（close 幂等键补 epoch 段）、§1.1 附带（回滚清账本）、§3 全部死代码簇（3.1 barrel 清出 46 个零消费导出并恢复 1 个误删的 RecordSettledEvent、3.2 journal-replay 死函数、3.3 manifest-store 五函数、3.4 worktree-git-ops 整文件 402 行、3.5 HostBridge 整文件、3.6 observability 死段、3.7 mirror 三谓词、3.8 updatePid/sessionFile、3.9 零散项 ping/死 import/死 re-export/return 帧 runId 死字段、3.10 僵尸 env 三族、3.11 phaseSettlementTracker 终局回收——实装为账本迁入 terminal-actions 的 notePhaseDispatched/settlePhaseLedger/forgetPhaseSettlement，避免 terminal-actions→pump 反向依赖成环）、§4.2.2（RUN_EVENT_TYPES barrel 单源 + 双向类型锁）、§4.2.3（runtime 行解析补 seq 校验 + 测试）、§4.2.4（stopReason 词表上 barrel，runtime 派生排除 reopened 保行为等价）、§4.2.5（subagent v 判定改 classify 单源）、§4.2.6（WORKFLOW_STATE_LINK_CUSTOM_TYPE 常量化：可替换 3 处 + session-reader 侧测试锚定镜像）、§4.2.7（recordsDir 单源）、§5.1/5.3-5.13 注释失实全部改写实、notify N-3 死分支与 N-5 留痕对齐。未动（需设计或裁决）：§1.1 主体、§1.3/1.4、§1.5、§1.6、§2 全部、§4.1、§4.3、§5.2、§6、§7。
>
> **来源**：① 2026-09-29 三轮对抗式架构审查（9 个并行 subagent + 主会话逐项核实，DDD 与六边形视角，关键发现全部经源码核实）；② 既有 8 份 todo 登记合并（branch-review R1 建议级残余 3 条 / notify stale ctx 崩溃 / orphan-reap 封顶裁决 / resume 档 1 补收退化 / workflow 架构候选清单 / scriptPath 锚定 / zcode Provider Registry / zcode 宿主双源）。
>
> **修复优先级总览**：第一批 = §1 行为级缺陷（各自独立可单独修）；第二批 = §3 死代码清退（机械性强）；第三批 = §2 结构性条目（需排期设计）；§5 注释失实随各批顺带修正；§6 为裁决输入。§7 为已实施待验证项，§8 为否定性结论（后续审查勿重复怀疑）。

---

## 1. 行为级缺陷（已核实，修复最优先）

### 1.1 resume 复活 run 的时间预算在首次错误重试后静默失效（P1）

证据链三环（2026-09-29 逐一核实）：
- `packages/subagent-core/src/orchestration/resume-run.ts:838-847`：rebuildRunFromRecord 构造的 spec 只含 scriptSource/args/scriptName/scriptPath/model，**结构性不含 budgetTimeMs**（RunSpec.budgetTimeMs 是 readonly 也无法写回）。
- `packages/subagent-core/src/orchestration/worker-message-pump.ts` remainingTimeBudgetMs：`if (!budget || budget <= 0) return undefined` 在查 D10 复活预算账本**之前**提前返回——账本唯一写入方是 resume 链（noteRunResumedBudget 全仓仅 resume-run.ts:571 调用），即账本唯一写入场景恰好是它结构性读不到的场景。
- 后果链：复活 run 带 time 预算 → 任一 worker/script 错误进重试 → rebuildRuntime → RunRuntime.release 清掉 timer → 预算与引擎级超时（lifecycle.ts:283 `maxTimeMs: spec.budgetTimeMs`）双双静默失效；pump:329 注释宣称「优先消费 D10 账本」不可达，注释失实。
- 附带：接管失败回滚（resume-run.ts:662-682 interruptRun 后）不清除预算账本条目，驻留至进程退出（每 runId 一条，重 resume 覆盖，量级有界）。

### 1.2 close 归档通知幂等键缺 epoch 段，reopen 后二次 close 提示被账本永久吞

- `packages/subagent-core/src/execution/notify/notifier.ts:451-457`：roundKey 构造在 `record.round == null` 时回退**裸 `record.id`**，epoch 不参与；`notify-host.ts:227` notifyClosed 显式置 `notify.round = undefined` → 终态提示 key 恒为裸 id。
- 场景：close①（key=裸 id，账本已记录且已 ack）→ message 重开（epoch+1，万物可续）→ close② → key 仍为裸 id → 第二次归档提示（含 totalRounds/patch 提示/transcript 指针）被 notify-ledger 同 key 已 ack 拒绝，永久不可达，仅 warn 留痕；跨重启不缓解（ack entry 随 session 文件恢复重建）。
- 讽刺点：notifier.ts:447-450 注释自引「同 key 撞车吞通知是本代码库已修复过的事故类——epoch 是同族防御的构造性根治」，但该根治只落到轮次键（`id:epoch:round`），close 的裸 id 分支漏了。
- 修法方向：roundKey 的 round==null 分支在 epoch>0 时产出 `id:epoch`。

### 1.3 worktree reconstruct 的 patch 丢失判定在完整重建之后执行，已重建 worktree 泄漏 + 每续轮重复重建

- `packages/subagent-core/src/execution/worktree/worktree-manager.ts`：分支存在性检查最先（:280），patchFile 存在性检查却排在 worktree add / registry.add（:309）/ symlink（:319-325）全部完成之后（:332-335）——该判定只依赖入参路径，完全可以前置。
- 后果：走 degrade-reopen 降级时已重建的 checkout + 注册表条目 + symlink 留存到宿主进程死亡；消费方 conversation-continuation.ts:618 对 degrade-reopen 不接收 handle，下一续轮再进 rebuildWorktreeBinding（:605）→ 每续轮重复全套 git 重建再丢弃。

### 1.4 worktree create() 无 prune-retry，与 reconstruct 不对称——陈旧 git 元数据残留时同 recordId 永久卡死

- create 前置 rmSync 清目录（:176-182）但不清 git 元数据；上次 create 回滚的 `worktree remove` 失败被 bestEffort 吞掉（:221-224）留下 `<repo>/.git/worktrees/<branch>` 陈旧登记后，`worktree add` 报 already registered 恒失败。reconstruct 对同形态有 prune+重试（:296-305），create 没有。

### 1.5 轮终收尾遇 stale extension ctx 崩溃 runtime 进程（P1，间歇性，2026-09-22 登记）

- 症状：GUI 派发 subagent，轮终收尾时 runtime 进程 exit 1，当轮 record 丢失、manifest 轮终投影未执行；supervisor 重启循环约 6 分钟。复验 3 轮仅第 1 轮触发。
- 根因（已核实部分）：簿记⑧ emitPendingUnregister（`record-store-rounds.ts:207`）→ notify-host 的 `pi?.events.emit("pending:unregister", …)`——`pi?.` 只挡 null 不挡「非空但已失效」的 stale 适配器，emit 抛错沿 markRoundIdle 调用链未捕获，进程死亡。stale ctx 产生机制未核实，修复前需先排查。
- 同族风险：notify-host 其他 emit 面（register 等）共用同一 `pi?.events.emit` 形态。
- 修复方向：①先排查 stale ctx 来源；②防御面 try/catch + 结构化留痕对齐簿记⑨的 best-effort 定位（通知/过程面失败不崩进程）。
- 证据：`.tmp/dev-flow/b1b2-verify/`（崩溃日志/重启截图）；与 §1.2 同在 notify 域但不同问题（本条是崩溃、1.2 是通知丢失）。

### 1.6 resume 档 1 补收丢失结构化调用的对象形态（用户已裁决应修）

- 现状：活体链 schema 调用的 `AgentResult.parsedOutput`（校验后对象）随 agent-settled 帧落 record 流，但 resume 档 1（结果补收）帧只带 `extractAssistantTextContent` 提取的正文文本（resume-run.ts 补收帧构造处无 parsedOutput）；worker 侧回放恒 `parsedOutput ?? content` 优先——schema 调用经档 1 补收后脚本拿到原始 JSON 文本串而非对象，无测试覆盖。
- 裁决语义（2026-09-29 用户定案）：schema 调用的结果必须是对象形态，**没有文本回落选项**；拿不到对象形态就不该判档 1。
- 附带隐患（推断未完全核实）：档 1 判据（classifyResumeTierFromContent）只看「最后一条 assistant 回复完整带正文」，不校验是否通过 schema 验收——崩溃发生在「校验失败轮已落盘、steer 重试未完成」窗口时，可能把未验收文本当结果回放。修复必须一并封住。
- 实现要点（方向 A）：从 pi 会话文件提取 structured-output 工具调用块参数，「工具调用 + 配对成功 toolResult」双证据确认校验通过；拿不到可信对象形态 → 改判档 2 续写重花（重新走完整验收门禁）。补两类测试（对象形态补收 / 未验收不补收）。
- 出处：workflow-run-resume-revision 设计 §5 检查点 7。影响窗口窄（schema 调用 + 已落盘 + 崩溃 + 判入档 1 同时满足）。

---

## 2. 结构性 / 架构问题（需排期，多数走 tech-design 立项）

### 2.1 双 `RunState` 同名异义（同一 run 域两个完全不同的类型）

- `orchestration/models/run-state.ts:25`（status/reason/budget/calls/trace 执行快照形态，WorkflowRun 聚合持有）vs `orchestration/run-events.ts:613`（lifecycle/outcome 状态机两维形态，转移表与 fold 消费）。同包同词两义。旧形态是 v1 兼容层（W4 sunset 范畴），但其头部注释描述的「RunStore.save 触发持久化 / 重启时从 JSONL 重新加载」机制已随 record 单源收敛删除——注释过期。
- 同族实例：`engine/client/mirror.ts` 与 `engine/host/spawned-children.ts` 的 getChildByRecord/hasLiveProcessHandle 同名一死一活（见 §3）；`isProcessAlive` 在 pid-file.ts（三态）与 persistence/alive-store.ts（二态）同名异义；`ModelCatalogEntry` 在 core（{provider,id}）与 SDK 协议（{id,aliases?,canonicalRef?}）同名不同形。

### 2.2 run 生命周期状态判定散布约 7 处 + 展示层映射未归并

- 状态表达位置：`WorkflowRun.state.status` 两态（聚合根，v1 兼容层）、`WorkflowRunMeta.interruptedAt` 标记（中断态靠 meta 字段投影表达）、record 事件流 fold 五态 RunState（唯一权威）、DoneReason 五因、RunOutcome 四值、shared `WorkflowRunStatus` 第三份字面量副本、壳 gui-mappers 关键字匹配。映射有单点（doneReasonToRunOutcome）但单点两侧仍是两套词表。
- 展示层同构问题（原 workflow-architecture-backlog G2 并入）：「运行状态 → 展示文案/颜色/图标」映射在 4 个文件至少 6 处独立实现——`interface/format.ts` 内部 3 处（:149/:454/:474）+ `interface/views/detail-content.ts:88` + `interface/gui-mappers.ts:62` + `interface/bg-notify-render.ts:260`。
- gui-mappers 精化结论：对现行真实输入域（ExecutionStatus 的 running/idle）覆盖正确；4 个潜伏错映射格（created/settling/interrupted/active 都归 done）靠「数据流不流入」兜底，入参裸 string 无类型防线；嗅探集里 crash/error 两关键词现行输入域无生产方；头注声称的消费方清单已陈旧（helpers.ts 不存在）。

### 2.3 orchestration ↔ execution 双向循环依赖（19 / 6 文件）

- 6 个 orchestration 文件 import execution（terminal-actions.ts:26-28 一次值 import 5 处），19 个 execution 文件 import orchestration（execution/service/workflow-dispatch.ts:37,48,55 值 import model-catalog/terminal-actions/member-reuse-pool）。终局编排的归属在两域间摇摆；runtime 侧有 NO_SERVICE_CYCLE_CHECK 而 core 内无对应防线。
- 修法方向：先加 core 版循环依赖机器检查止血，再谈拆分。

### 2.4 领域核心类型反向依赖应用层目录

- `models/ports.ts:13` import `execution/assembly/stream-sink.ts`、`models/types.ts:23` import `execution/assembly/types.ts`——models（领域核心候选）的端口签名依赖 assembly 类型，ports.ts 头部自称「零 infra 依赖（AC-1）」名实不符。
- record 域聚合核心 execution-record.ts 的全部领域类型（ExecutionRecord/ExecutionStatus/Turn 等 20 个）定义在 assembly/types.ts——`assembly/types.ts` 实为跨域公共类型堆积处，领域概念的权威定义位置错位。

### 2.5 壳层（interface/）混入领域规则 + 自带 record 流解析（原 G7 并入）

- `interface/` 22 文件混装命令处理 / 格式化 / GUI 映射 / 工具定义 / TUI 基建多类职责（原 backlog G7）。
- 领域规则实例：`tool-workflow.ts:570-715` D14 resume args 一致性判定（含篡改检测与拒绝文案）完整实现在壳，readHistoricalArgs 自带 record 流 JSONL 解析与 core scanJournalFile 构成双实现——根因是 RunStore 端口只有 save（no-op）/loadAll/stateFilePath 三方法，没有「读 run-created 帧 args」的原语。
- ADR 候选登记：「D14 args 判定刻意放在壳而非 core resumeRun」若无登记将反复被审查质疑；若非刻意即本条修复入口。

### 2.6 进程级 globalThis Symbol 槽 17 键 3 前缀混用（原 G3）

- subagent-core 与壳两包共 17 个唯一 `Symbol.for` 注册键，命名空间前缀 3 种并存（`@zhushanwen/pi-subagents.*` 6 / `@zhushanwen/subagent-core.*` 2 / `@zhushanwen/pi-subagent-workflow.*` 8），另有 1 个无前缀变体 `pi-subagent-workflow.ui-observability`（ui-request-observability.ts:23，该模块本身是死代码见 §3）。

### 2.7 靠 process.env 探针区分父/子进程角色（原 G4）

- `session-lifecycle.ts:421-440`（appendSubagentIdentityEntry）以 `PI_SUBAGENT_SELF_RECORD_ID` 是否存在判主/子进程，并从 `PI_SUBAGENT_MODE` 等一组 env 读身份数据——角色判定隐式依赖 spawn 约定，无独立裁决入口。

### 2.8 决策记录两处并存（原 G8）

- 包内 `extensions/universal/subagent-workflow/docs/adr/`（3 个 ADR）与 `docs/design/`（13 个设计文档）跟项目级 `docs/adr/decisions.md` 两套文档源头并存，决策与设计位置无单一规则。

### 2.9 测试深路径 import（原 G9）

- 测试直接 import 包内部深层模块路径而非包入口：`interface/__tests__/commands-resume.test.ts:21`（`@zhushanwen/subagent-core/orchestration/resume-run.ts`）等；另有跨包超深相对路径形态（engine/__tests__/conformance/registry-fork-filter.test.ts:35）。

### 2.10 subagents 批量 tool 经模板转译间接层执行（原 F1-C6）

- `interface/tool-subagents.ts:13/:68`：tasks[] 参数经 handler 确定性转译为内置 fan-out 模板脚本再执行，工具契约与执行形态之间隔一层转译。

### 2.11 两引擎 server.ts 平行双实现无共享底座

- pi（463 行）与 zcode（355 行）各持 EngineProtocolServer 协议主循环，无共享骨架；协议版本不匹配错帧两引擎各自手搓（SDK 构造器 engineProtocolMismatchError 唯一消费方是 core 侧 engine-client.ts:422）。

---

## 3. 死代码清退清单（机械性强，第二批）

| # | 位置 | 内容 | 核实状态 |
|---|---|---|---|
| 3.1 | core barrel（src/index.ts） | **58 个零消费导出**（导出但无任何调用点；323 面里 256 活 + 9 弱活 + 58 死；37 类型 + 21 值），四族集中：record-events 词表族 13 / run-state-evidence 保留窗口族 13 / handler 类型闭包族 ~15 / v2 entry 词表族 8。附带：pruneTerminalRunFiles 的 barrel 头注声称「磁盘足迹裁剪单源」实为同文件内部消费 | 穷尽式逐符号核对 + 抽查 2 个复核通过 |
| 3.2 | execution/engine/common/journal-replay.ts | 整文件事实性死亡：replayJournalToSessionView 零消费，②级读降级编排已被 pi read-fallback.ts 与 zcode journal-io.ts 两份同体实现承接 | grep 核实 |
| 3.3 | execution/persistence/manifest-store.ts | 五个自由函数（writeManifestRecordPersisted / rematerializeManifestRecord / rebuildManifestRecordIfMissing / reportManifestWriteFailure / reportInvalidManifestRecord）生产零调用，RecordStore 内各有私有等价实现（双实现，见 §4.1） | grep 核实 |
| 3.4 | execution/worktree/worktree-git-ops.ts | **402 行纯函数内核零生产消费**（collectWorktreePatch / cleanupWorktree / listWorktreePorcelain / gitRun / isTreeDirty）；头注「两处短暂并存待切换」已持续过一次 barrel 收窄；附带 GitRunError 双类、SAFE_ID_RE 三份 | grep 核实 |
| 3.5 | execution/engine/host/host-bridge.ts | createHostBridge 全仓零生产调用（文件自证），仅 3 个测试文件消费 | grep 核实 |
| 3.6 | execution/ui/ui-request-observability.ts | globalThis 桥整段孤儿：notifyMissingHandlerGlobal 零调用；registerGlobalObservability 生产被调但注册的槽无人读（死写）；resetMissingHandlerWarnings 清恒空集合；「待接线」注释已过时（接线 subagent-service.ts:401 已完成） | grep 核实 |
| 3.7 | execution/engine/client/mirror.ts | 三谓词死代码（getChildByRecord / hasLiveProcessHandle / isResumable）——生产链走 spawned-children.ts 的 core 镜像槽；死副本 getChildByRecord 按插入序取首个匹配有遮蔽隐患；条目只增不减（zcode 常驻引擎下镜像随历史 pid 缓增） | grep 核实 |
| 3.8 | execution/worktree/worktree-registry.ts | updatePid + sessionFile 字段死代码（「session-runner first header 补全」链路已随 inproc 引擎删除）；SPAWN_GRACE_MS 的 create→spawn 宽限语义同属死词表 | grep 核实 |
| 3.9 | 零散死代码 | engine-client ping()（且无超时）；engine_model_mismatch 协议错误码零写入方；return 消息的 runId 死协议字段（builder 发 pump 不收）；workflow-dispatch.ts:46 dispatchRunTrigger 死 import；pump:1265 死 re-export 面；markFinalized/markCancelled 双 deprecated 桥接（有 U5 退役计划）；adoptEngineDeath 仅测试可达（注释自认）；run-snapshot 编码面零生产调用（解码面供 v1/v2 兼容读保留） | 各项单独核实 |
| 3.10 | 僵尸 env 通道 3 个 | `TAIJI_SUBAGENT_SPAWN_WATCHDOG_MS`（读点已随 inproc 引擎删除消亡，三处 src 注释仍向用户承诺行为、两个 vitest.setup 防御性清理不存在的通道）；`TAIJI_ENGINE_EVENT_COALESCE`（常量定义但全仓无读取——设了没效果）；`TAIJI_ZCODE_MODE`（纯注释残留） | grep 核实 |
| 3.11 | pump phaseSettlementTracker | run 中断/终局无回收（runId 条目永久残留，纯内存泄漏无行为错误，长驻宿主内单调增长）——pump:160 注释声称「随 MemberReusePool 清理同域回收」但 clearMemberReusePool 物理上够不着 tracker（两模块互不 import）。修法：finalizeRun/interruptRun 同域追加 forgetPhaseSettlement(runId)，或改注释为真实语义 | branch-review R1 条 1 |

---

## 4. 双实现与词表镜像（漂移防线现状不一）

### 4.1 同策略双实现（修一处漏一处即漂移）

1. **manifest 写面**：manifest-store.ts 五自由函数（死）vs RecordStore 内私有等价实现（活）——同一「同步优先/异步兜底 + 三档响亮度」策略两遍；MANIFEST_INDENT_SPACES 双定义（字节格式兼容靠两处都=2）。且写面检查 check-record-write-surface R1 只拦七个函数名字面，record-store-rounds.ts:44 经别名 materializeBoundRecordManifest 逃逸，与该文件:75 自己写的「不 import manifest 写函数」注释矛盾。
2. **eventLog/getFullText 派生规则**：session-reconstructor.ts:229-255 对 execution-record.ts:518-540 逐字节复制（含 TURN_SUMMARY_MAX=80 常量副本）——注释自称「避免循环依赖」，实测反向 import 无环，理由不成立；磁盘重建路径走副本。
3. **seq journal 基座**：record 域 FileRecordEventJournal.append 与 run 域 FileRunEventJournal.append 各约 90 行 95% 同文（连注释同文），真差异仅 header 行契约与无 seq 存量行兼容两点——可合并为泛型基座。
4. **updateFromEvent 双 reducer**：core 活体 reducer（execution-record.ts:451）vs SDK 重放 reducer（journal-replay.ts:321）——「重放与 live 共用同一 reducer」的设计已退化为两份，靠 conformance 行为断言防漂移。
5. **binding 载荷双构造**：run-orchestration.ts:431-453 手写 15 字段 vs terminal.ts:452-476 fullBindingPayload 人肉同步——两处注释同时记录了历史上两次补字段漏拷贝事故。
6. **collectPatch 接线双份**：finalize-record.ts:124-137 vs record-lifecycle.ts:337-352（注释自称「同款」）。

### 4.2 跨包词表/常量镜像

| # | 内容 | 防线现状 |
|---|---|---|
| 4.2.1 | record 流严格读面双实现（branch-review R1 条 2 并入）：core readRecordStreamStrict / rebuildRunFromRecord（resume-run.ts）vs 壳 readRecordStream / foldRecordStreamToRun（jsonl-run-store.ts:193/:434），严格度有意分化（core 多 seq 断档检测），注释「语义对齐」失真；壳另持 parseLegacyArgsSummary 与 core 私有 parseArgsSummary 函数级镜像 | 无；修法 = 坏行判定规则从 barrel 导出为共享校验原语，或登记分层契约 + parity 测试 |
| 4.2.2 | runtime journal-projection RUN_EVENT_TYPE_PROBE 9 键手抄镜像（branch-review R1 条 4 并入）：注释依据「barrel 未导出 RUN_EVENT_TYPES」已失真（index.ts:693 实际导出，壳 jsonl-run-store.ts:176 已有消费先例） | 编译期穷尽检查（防缺键多键，不防值漂移）；修法 = 改 new Set(RUN_EVENT_TYPES) barrel import |
| 4.2.3 | runtime journal-projection 行解析与 core 判定面分叉：parseWorkflowRunEventFileLine（:94-114）完全不校验 seq，core isWorkflowRunEventLine 对 seq 坏值（非正安全整数）判坏行——同一损坏流 core 丢弃、runtime 放行进 fold；注释「对齐最宽共同判定面」与 core 实际不符；测试无 seq 坏值用例 | 无 |
| 4.2.4 | stopReason 词表硬编码：workflow-step-merge.ts:43 + :91-107 字面量判定，core 有 NEW_STOP_REASONS / ROUND_TERMINAL_STOP_REASONS / STOP_REASONS 常量但未上 barrel——runtime 结构上无法单源消费（成因 = 镜像 + barrel 封闭面复合） | genericStopText 兜底分支（词表演进时行为安全但分类粒度静默退化） |
| 4.2.5 | subagent 域 v 判定手写镜像：subagent-extractor.ts:231-242 手写两段式 v 门，core classifySubagentRecordEntryData 已导出且 journal-projection.ts:141 已在消费，workflow 域同构位置已单源 | 行为当前等价 |
| 4.2.6 | 'workflow-state-link' 字面量全仓 4 处散布（runtime workflow-extractor.ts:326 / session-file-extraction.ts:99 / session-reader discovery/workflows.ts:213 / 壳 session-lifecycle.ts:197），core 无对应常量；session-file-extraction.ts:100 的 'subagent-bg-notify' 同类（extension-protocol 有单源常量） | 无；hint 预过滤漏检 = 记录消失 |
| 4.2.7 | recordsDir 布局推导副本：runtime session-records.ts:422-423 手写 join(getPiAgentDir(),'subagents',encodeCwd(cwd),'records')，core getSubagentRecordsDir 已 barrel 导出但 runtime 零消费；encodeCwd 亦双份 | 无 |
| 4.2.8 | engineTimeoutDetail + STDOUT_TAIL_ECHO_CHARS + 恢复文案逐字镜像（core errors.ts ↔ SDK error-codes.ts） | 无机器检查（纯注释承诺） |
| 4.2.9 | v2 entry 词表全仓三处字面量（core record-entry / workflow-record-entry / packages/shared subagent.ts 镜像，shared 不依赖 core 自建） | 双侧测试 |
| 4.2.10 | 壳 jsonl-run-store loadAll 自带第二份 fold（collectRunCallDrafts 等五函数，与 core foldRunEventCheckpoint 的 per-call 语义重复：占位行/'(unknown)'/settled-before-started 兜底） | 测试锁 |

### 4.3 「v1 停写」前提被纠偏链打破（数据正确性窗口）

- 主链已全写 v2 小条目，但孤儿纠偏路径 reportSubagentRecord（record-store.ts:1235 → toSubagentRecordEntry 恒 v:1，调用点 :1299/:1374）**仍在写 v1 全量快照**；叠加 runtime journal-projection 的 v1 冻结定界优先仲裁（:595 `if (subagents.has(id)) continue`），同 id 的纠偏 v1 快照会遮蔽 v2 fold 投影（事件流事实源被投影遮蔽，方向反了）。触发场景窄（崩溃于轮中 + 纠偏触发）；subagent-extractor 头注的「v1 冻结」叙事未反映该活写点。

---

## 5. 注释与声明失实清单（随各批顺带修正）

1. settleRunAccounting docstring（terminal-actions.ts:1013）宣称「interruptRun 终局半边与 finalizeRun 共用」——实测全仓唯一调用方是同文件私有链，interruptRun 从不调它。
2. 「意图原语即状态机（CAS 拒绝表外转移）」在轮次轴不成立：markRoundIdle 唯一保护是 endedAt 终态检查（rounds.ts:190），无 status CAS（错误信息自认「调用方负责 gate」）；markRoundStarted（:132-138）对 running 中的 record 静默清在途轮数据。对照 markReopened（CAS+回滚，terminal.ts:377-425）是全库参照形态。
3. pump:329「优先消费 D10 resume 账本」不可达（§1.1）。
4. 「语义对齐壳侧 readRecordStream」失真（§4.2.1）。
5. barrel 头注 pruneTerminalRunFiles「磁盘足迹裁剪单源」消费方实为同文件内部（§3.1）。
6. TAIJI_SUBAGENT_SPAWN_WATCHDOG_MS 三处注释向用户承诺已不存在的行为（§3.10）。
7. engine-client.ts:447 stdoutBuffer「不做无界缓存——残片即半行，有界」不成立：引擎持续输出无换行数据时 buffer 无限增长，帧违规围栏只对完整行生效（真缺陷不止注释）。
8. conversation-continuation.ts:813 armIdleKeepalive 注释描述已退役的超时终态化语义（原注释宣称超时会执行含 finalize/notifyClosed 的全套终态收尾；实际 idleTimeoutRecycle 不 finalize 不 notifyClosed，lifecycle-manager.ts:16 是正确表述）。
9. ui-request-handler-factory.ts:105「由 session-runner respond 处理」——session-runner 已随协议化删除；ui-interaction-model.ts:5「10 个 method」实为 9。
10. RunStore 端口契约漂移：ports.ts:53 save 在生产唯一实现中显式 no-op（接口注释自认「保留为 port 契约」），LifecycleDeps 注释仍引用已死的 persistState/save 语义。
11. ReadParams.dataDir 死 wire 字段（methods.ts:187 注释称「必填」且设计上固定）：core 每次 read 都发、两引擎 server 都丢弃、引擎各自用别的通道定位。
12. ADR-0071 义务码 engine_method_unsupported 两引擎实装都不回（实装词表外的 engine_protocol_unknown_method，靠透传兜底）。
13. worktree-manager isOrphan 的 pid=0 分支注释指向已删除的补全链路（updatePid 死代码）。
14. makeDeps/persistState、mirror 头注「消费者 = 生命周期谓词」、observability「待接线」等已随 §3 对应条目登记。

---

## 6. 待裁决项

### 6.1 无主 run 对账清理的持续损坏计数封顶

- reapOrphanRuns（workflow-run-resume-revision 裁决点 7）登记文件 `orphan-run-reap.json` 承载 7 天宽限窗：一次性损坏自愈（按空重登记 + 原子重写，损坏路径测试已覆盖，观测面 warn 已补）；**持续损坏**（每轮读/写都坏，如磁盘坏道）才宽限窗反复重起 = 孤儿永不删除。
- 待裁决：是否加「持续损坏计数封顶」（超阈值改告警/强制删除/人工介入）；反方向同样成立——极低频形态 + 原子写已消除主成因，加封顶可能属重复保险式过度工程（评审原文即以待裁收尾）。
- 出处：`.tmp/tech-design/workflow-run-resume-revision/round-3/dispositions.json` D-3-3。

### 6.2 zcode 宿主 run 双源收敛议题（实际等需求出现再裁）

- run record 单源收敛只在 pi 壳侧落地；core 侧 FileRunStore 已随 commit bd5750b70 退役删除（读侧收敛到 run-state-evidence.ts 证据核）。议题变为纯裁决：zcode 宿主未来出现 workflow 编排需求时，run 态持久化是否直接采用 pi 壳同款 record 单源形态（复用证据核），不再引入第二套快照读侧。zcode 引擎现无编排链（包内 workflow_run 等词是 zcode 自身 sqlite 表名），议题挂起。

### 6.3 workflow resume scriptPath 锚定——关闭形态取舍

- 候选 A 已实施（run-created 帧携带可选 scriptPath，双侧恢复 + 六模板检查收紧为带恢复指引的 fail-fast；record-mode 回归网 A2/A4 用例通过，commit a32df2905）。真机复跑 run3 证据：帧正确携带、fold 完整走完 15 帧、无 Cannot find module _shared——但剧本被环境类缺陷（Provider Registry，见 §7.2）阻断在 kill/resume 阶段前。
- 待裁决：A = 接受「修复实现 + 确定性回归 + 真机写入侧」三重验证作为关闭判据（推荐）；B = 等 §7.2 修复后重跑真机拿全绿再关闭。
- 内置模板 scriptPath 缺席即 throw 是防注入安全设计（回退 process.cwd() 会打开用户目录误加载通道），修复不改变该语义。

### 6.4 args 撞名防御只盖一个入口

- 闸 4 词表（script-generate.ts:46-67 WORKER_IIFE_HOST_DECLARED_NAMES，20 名与模板 IIFE 作用域精确一致）只在 AI 生成工具路径（tool-workflow-script.ts:242）生效；手工编写/入库的 workflow 脚本顶层 `const/let/var args` 依然运行时 SyntaxError → 三次重试全灭，失败形态远离根因。且 `args` 绑定未进 builder 头注与 run-events 词表注的 API 面声明（三处口径不一，闸 4 词表是唯一准确源）。

---

## 7. 已实施待验证（收尾跟踪）

### 7.1 notify stale ctx 崩溃（见 §1.5）——待裁决修复方向

### 7.2 zcode 引擎 Provider Registry / reasoningLevel 接线（2026-09-29 已落地，剩真机复验）

- 根因定案（bundle 解剖 + 活体探针对拍）：app 3.14.x 起 plan 家族 provider 全部 `access=zhipu-account`（entitlement 门控），CLI 自举 fail-closed——外部 spawn 形态只有 `~/.zcode/v2/provider_config.json` 个人 provider 可装载，plan 家族 id 一律 provider-not-found（报错文案误导性写「不存在 Model」）；GUI 正常因其宿主有完整 env 配方 + 账号供数链；裸起崩溃是 CLI 相对路径推导算到根目录，launcher 目录注入是外部 spawn 启动前提。
- 已落地：preparer.ts 模型源切换 provider_config.json（个人 provider 单源）/ 缺席模型返回空串走 CLI 缺省；ZCODE_FALLBACK_DEFAULT_MODEL 常量双侧删除；ZCODE_BASE_URL 注入；reasoningLevel 最小档解析（内建目录定位 + modelRules 正则）经 create 帧 options 自动补档；包全量单测绿。
- 剩余：真机复验（zcode 修复整体收尾后随 a1a4 复跑，剧本成员模型已钉注册表内快档 mimo-v2.6-flash）。
- 关联长期登记：settings 页面引擎默认 provider/model 配置 = `engine-default-provider-setting.md`（保留在 todo，不属本登记范围）。

---

## 8. 否定性结论（2026-09-29 审查核实，后续勿重复怀疑）

1. **防御堆积假设在 notify/ui/lifecycle 三域证伪**：notify 七层防线（账本/settled 边沿/看门狗/重启恢复/dispose 复写/compaction 补写/降级路径）各自覆盖不同丢失窗口，与设计三路径三桶一一对应；ui 三层错误围栏各承独立契约。
2. **reaper 与 pid-file 无误杀路径**：判据全是身份四元组（宿主死 + 引擎活 + cmdline + lstart 四道闸），无端口/时间窗启发式——killStaleProcessOnPort 类误杀形态无滋生土壤。
3. **run journal append 物理单写点成立**：全仓恰 1 处生产写点（terminal-actions.ts:310 appendTransition），dispatchRunTrigger 唯一投递漏斗（terminal-actions 10 处 + resume-run 2 处全经它），无第六写点。
4. **reentry-guard check-set 竞态不成立**：acquire 同步无 await，原子性构造性保证。真实窗口是 guard 未进 domain-state 槽（reload 后新旧 guard 并存，窄窗口）。
5. **gui-mappers 现行输入域覆盖正确**（见 §2.2 精化）。
6. **19 组包间同名文件 12 组是合法垫片/参数化收敛形态**（re-export → SDK 单源），真差异双实现仅 best-effort / logger / data-dir / server 四组且均有文档登记。
7. **worktree reconcile 无误删路径**：判死清理有 mtime+宽限防 create 窗口误清；方向一要求双消失且查询失败保守跳过；歧义宁跳勿删。

---

## 9. 未覆盖次级区域（继续挖的候选，边际收益低）

orchestration 外围工具文件（member-reuse-pool / agent-opts-resolver / workflow-files / skill-discovery / config-loader）、assembly 剩余（concurrency-pool / cold-lookup / channel-registry-access 等）、两引擎包 spawn 链逐行细节（spawn-run-pump 事件转换、zcode parser/session-channel）、壳 views/TUI 组件内部。测试域 2026-09-27 刚做过全量审计，有意跳过。收敛判据：第三轮新问题全部落入本文档既有六族（行为缺陷/死代码/双实现/注释失实/保护不对称/词表镜像），无新问题类型。
