# workflow 域 agent() record 归位（进度通道进 store + 状态语义显式化）

> **层声明**：技术方案层设计——当前层 = 方案决策与接口/数据模型规格，下一层 = 可实施的 PR 单元（§5）。
> **前置依赖**：H1（chat 域统一，[subagent-chat-run-unification.md](subagent-chat-run-unification.md)）先行落地。本文档依赖 H1 的方向性决策（record 单一模型 / Continuation 存在 / 守护单点 arm / settleOneShotOutcome 四分支保留）。
> **行号基线（v2）**：本文件引用行号基于 commit `22f77c157` 工作区；H1 落地后 subagent-service.ts 行号将漂移，实施时以符号 grep 锚定为准。
> **实施状态（2026-09-12 终态：W1-W5 + 阶段 3 + Gate A + Gate B 全部关闭）**：W1 f57d1a687 / W2 b09e3371d（含 mergeRunSignals 提取 run-signals.ts）/ W3 358889596（含 streaming 返工一轮）/ W4 ffbe595c5（SAR 529→94 行壳化）/ W5 ba269fb40；阶段 3 两轮收敛 must-fix=0（fb4b30ee2 + 0303fa735）；Gate A 全绿（91db1ce70，1 项环境例外登记）；Gate B 真机三轮终审 PASS（round-2 修复 9c924862c：binding 身份面 origin + 三域喂入 + status elapsed，双载体口径见 D1）。全部偏差与证据逐条登记于 [impl-plan §5/§6/§7](subagent-workflow-record-unification.impl-plan.md)。
>
> **一句话结论**：workflow 脚本里的 `agent()` 调用**现状已有真实执行 record 进 RecordStore 并走共享池**——[H2 实施勘误：H1 后 SAR 直调 engine.run、无 record，本条仅在 22f77c157 基线成立——共享池实为 W2 新增，见 impl-plan 偏差表 W2] 问题不在「record 游离」，而在三处：① pump 为 TUI 进度自建的第二个游离 progress record（挂在 trace.live，与真实 record 并存双 record）；② 真实 record 的成功收口语义寄生于 subagent-tool 的 SP-5（成功恒 running-idle 等 message 升级），对无 message 对端的 workflow agent 是错误语义（hasRunning 被绑架 / 30 天堆积 / 可被误升级为对话容器）；③ 编排层双轨（SubprocessAgentRunner 平行接线 vs service runEngineTask 族）。本设计：进度通道退役改 store 订阅、workflow origin record 成功即终态化、编排归一、可见性隐藏。

---

## 1. 背景目标

### 1.1 SCQA

- **S**：workflow 域是「用户写 JS 脚本编排多子代理」的功能——脚本里 `agent("任务")` 派单个子代理、`parallel()` 并发派多个。脚本本体跑在 worker 子进程，宿主进程侧由 `worker-message-pump.ts`（1295 行）接收 agent() 调用代为执行：pump 建 TUI 进度 record → 调 `SubprocessAgentRunner.run()` → SAR 委托 `subagentService.executeAndAwait`（`subprocess-agent-runner.ts:21/125`）执行。
- **C**：**每个 agent() 调用存在两个 record**——① pump 自建的游离 progress record（`createRecord` 直调 `:708-717`，挂 trace 节点 `live` 字段，run 完即清，不进 store）；② `executeAndAwait` 创建并 `store.register` 的真实执行 record（`:1849-1850` + `:2110`）——已进共享池（`runAndFinalize` → `acquirePoolOrFinalize`，`:2467`）、已受孤儿恢复覆盖[2026-09 实施勘误：H1 后 SAR 直调 engine.run、无 record，本条仅在 22f77c157 基线成立——共享池实为 W2 新增，见 impl-plan 偏差表 W2]。真实 record 的问题在**状态语义**：成功走 `settleOneShotOutcome` 成功分支 → `doFinalizeRoundToIdle` **保持 running-idle**（SP-5：等首条 message 升级 chatMode，`:2536-2538`）——workflow agent 结果由脚本返回值承载、无 message 对端，running-idle 恒挂到 30 天 idle-gc，且 `useBackgroundWork.hasRunning`（`:26`）被绑架为恒真。另有编排双轨：SAR.run 平行接线（路由/预检/journal/守护，`:158-333`）与 service `runEngineTask` 族两份同构编排（journal-wiring 注释自述「两份同构接线提为 common helper」——helper 共享了，编排没归一，`:1-4`）。进度消费面（views/detail-content.ts 3 处、WorkflowsView.ts 3 处）直连 `node.live`，重启即失。
- **Q**：能否让 workflow 里的 agent() 在概念与治理上等同一个 subagent——单一 record、正确终态、store 订阅进度、隐藏可见性？
- **A**：能——真实 record 已在 store（v1 误判「游离」在此修正），增量 = 删进度假 record 换 store 订阅、workflow origin 成功即终态化、编排归一、投影层隐藏。用户已四裁定：agent() 等同 subagent / 可见性隐藏 / 进度从 store 订阅 / 并发共享池（共享池现状已成立，本设计回归验证）。

### 1.2 系统是什么（受众认知铺垫）

**RecordStore** 是所有 subagent record 的统一注册表：内存持有 running、终态从 session.jsonl 重建，持久化/恢复/对账/GUI 列表投影都挂在它上面。**AgentRunner** 是 workflow 引擎调用子代理的 port（`orchestration/models/ports.ts:35`），现由 `SubprocessAgentRunner` 实现——它内部委托 `executeAndAwait`（真实执行），但自持一套**编排**（路由/预检/journal/守护的调度顺序）。**WorkflowRun** 是 workflow 聚合根（含 trace 节点树），持久化在 FileRunStore（JSONL）——run 级状态与 record 级状态是两层，本设计只动 record 级与进度通道。

### 1.3 设计目标

- **G1 agent() 等同 subagent**：同一派发编排、同一 record 模型、同一治理保障（持久化、重启恢复、无进展守护、监督、崩溃终态语义）；**显式例外 = 成功收口形态**（D7：workflow origin 成功即终态化，理由见该条）。
- **G2 可见性 = 隐藏**：workflow record 在投影/列表层默认隐藏；workflow run 视图实时进度从 store 订阅（parentRunId 查询）。
- **G3 并发共享池**：workflow agent() 与手动 subagent 共用同一 `DefaultConcurrencyPool`——**现状已成立**（`runAndFinalize` → `acquirePoolOrFinalize`），本设计保持并回归验证。

### 1.4 in / out scope

**in**：record `origin`/`parentRunId` 字段与投影层过滤；workflow origin 成功收口分支（settleOneShotOutcome）；编排归一（executeWorkflowAgent 接管 SAR.run）；pump 进度 record 删除与 trace.live 退役；views/run-snapshot 的 live 消费面改造；`pending:unregister` 发射面按域分明回写；约束回写。
**out**：workflow 脚本语言/script-lint 本体；WorkflowRun 聚合根与 FileRunStore（run 级状态保留原状）；workflow 视图 UI 改版（只换数据源）；H4 持久化收敛；run 级 pending 注册/注销对（lifecycle ↔ pump，本就配对，不动）。

---

## 2. 现状与问题分析

### 2.1 使用者视角的现状（真实链路）

用户在 GUI 跑一个 workflow：`parallel(() => agent("调研 A"), () => agent("调研 B"), () => agent("写总结"))`。每个 agent() 调用：worker 发消息 → pump `dispatchAgentCall`（`:700-792`）**先建游离 progress record**（挂 trace.live，TUI 进度用）→ `runner.run(opts)` → SAR.run 平行编排（路由/预检/journal/`armMidRoundNoProgress(taskId)`）→ 委托 `executeAndAwait` → **真实 record 注册进 store**（emitPendingRegister `:1849-1850`）→ 池 acquire → 执行 → 成功走 `settleOneShotOutcome` **保持 running-idle**（`:2536-2538`）→ AgentResult 回填 `node.result`、progress record 清除。重启后：WorkflowRun 由 FileRunStore 重水合（trace result 摘要在，进度即失）；真实 record 经 store 孤儿恢复——恢复成什么状态取决于崩溃时点，成功完成的 record 已在 30 天 idle-gc 边缘。

### 2.2 问题清单（带证据）

1. **双 record 并存**：pump progress record（`:708-717` 游离、run 完即清、`execution-record.ts:3,10-13`「唯一创建/更新入口」头注被绕开）+ store 真实 record（`:1849-1850` 注册）——进度真相分裂：TUI/GUI 看假 record，治理面（恢复/对账/监督）管真 record。
2. **成功 record 恒 running-idle（SP-5 寄生）**：`settleOneShotOutcome` 成功分支 → `doFinalizeRoundToIdle` 保持 running-resumable（`:2536-2538`）。四面连带：① `useBackgroundWork.hasRunning`（`:26`）恒真——GUI working 态被 workflow record 绑架；② record 恒挂到 30 天 idle-gc；③ subagent message 按记录可命中并**升级为 chatMode 容器**（actions-core 升级链，语义怪异——脚本持有结果，无人会 message 它）；④ goal continuation 守卫被 SP-5 打穿（`goal/src/adapters/event-handlers/agent-end.ts:192-213` 依赖 record 级 pending:unregister 判收口，成功恒 running 时 defer 恒挂）。
3. **编排双轨**：SAR.run 平行接线（路由 `routeEngineForHost` / 预检 `assertTaskShapeSupported` / model 校验 / journal 接线 / no-progress 守护双刷新源 / `mergeRunSignals` / spawned-children 注册，`:158-333`）与 service `runEngineTask` 族两份同构编排；公共 helper 已共享（D3-②③④ 协议化产物），**编排顺序没有归一**。
4. **进度通道直连且不持久**：`node.live` 消费方 = `interface/views/detail-content.ts`（:79/:222/:274 三处分支）+ `interface/views/WorkflowsView.ts`（:141/:169/:816）+ `orchestration/run-snapshot.ts`（:136/:149 快照序列化剥离 live）；进度不落盘、重启即失。
5. **对账盲区（record 级精确化）**：run 级对账**已有判据收口**（`service-binding.ts:260-266` 生产装配注入 `lookupWorkflowRunState`：running→active / done→terminal / 缺失→missing）；盲区在 record 级——record 状态（running-idle 恒挂）与 run 级终态之间无对账，sweep 对「run 已 done、record 恒 running」的组合无感知。

### 2.3 根因分析

workflow 域早于引擎协议化演进定型。协议化（D3 系列）把真实执行统一到了 `executeAndAwait`（record 注册、共享池、孤儿恢复随之生效——这部分是对的），但三处 pre-协议化形态沿袭未拉直：① pump 的 TUI 进度通道（假 record + trace.live 直连）；② SAR 的编排层（与 service 双轨）；③ 成功收口语义照单全收 subagent-tool 的 SP-5——该语义为「父 agent 可 message 续聊」设计，workflow agent 无此需求。**根因 = 真实路径已统一，进度通道/编排/收口语义三处残留分叉。**

---

## 3. 解决方案

### 3.1 终态（使用者视角）

**成功路径**：

```
用户跑 parallel(3×agent())：
→ 每个 agent() 经 service 统一编排：真实 record（origin:"workflow", parentRunId=<run id>）
   → 池 acquire（与手动 subagent 同池，路由/预检先于 acquire——失败零池占用）→ 守护 arm
   → 引擎执行 → 事件流进 record → AgentResult 回脚本
→ workflow run 视图实时进度 = store 订阅（parentRunId 查询本 run 的 record 集，
   getEventLog/getCurrentActivity 同源）；trace 节点保留终态摘要（result）
→ agent() 成功 → record 即终态化（closed/gc 自然完成，D7）——GUI working 态不被绑架
→ 重启后：run 视图照常（FileRunStore）+ 各步 record 终态由 store 恢复
→ GUI subagent 列表 / TUI /subagents 默认不显示（投影层 origin 过滤；
   list includeFinished:true (add includeWorkflow:true to also see workflow-dispatched subagents)
   可查——排查通道保留）
```

**失败路径**：

| 场景 | 行为 | 恢复指引 |
|------|------|---------|
| agent() 失败 | record 标 failed 终态（现状语义不变）+ trace node 终态 | 脚本重跑该步 |
| 宿主重启于 agent() 在途 | record 经 store 孤儿恢复终态化；WorkflowRun 经 FileRunStore 恢复 | run 视图重开显示各步终态 |
| record 与 trace 摘要不一致 | **record 为真相**，trace node 是摘要缓存（详情视图读 store） | 无需动作 |
| 排查 workflow 子代理 | `subagents action:'list' includeFinished:true` (add includeWorkflow:true to also see workflow-dispatched subagents)（或 run 视图详情按 parentRunId 下钻） | 指引文案随 runner 改造更新 |

### 3.2 多方案对比

| 方案 | 长期合理性 | 短期成本 | 风险 | 判定 |
|------|-----------|---------|------|------|
| **A. 删进度假 record + origin 终态语义 + 编排归一**（本设计） | 高：单一 record 单一进度源，收口语义各归其位；与 H1/H3/H4 同轴 | 中：service 接管 + pump/views 改造约 3-4 PR | 低：结果回脚本语义不变 | **选定** |
| B. 保留双 record，仅删 trace.live 换轮询真实 record | 低：双 record 并存（每调用一次 createRecord 绕开唯一入口），进度真相仍分裂 | 低 | 中：v1 曾走过的半程方案 | 否——假 record 是绕开唯一入口的根源，留着即持续违反 |
| C. workflow agent 用专用轻量结构（非 ExecutionRecord） | 低：第三套「类 record」结构，概念面更差 | 中 | 高：与用户期望（等同 subagent）相悖 | 否 |

### 3.3 关键决策

- **D1 `origin` 字段（建议新增）+ 投影层隐藏**：`ExecutionRecord` 增 `origin: "tool" | "workflow"`（缺省 `"tool"`）与 `parentRunId?: string`。**过滤在投影/查询层，不在 store 层**（治理面 sweep/恢复/监督需全量）。**磁盘重建双载体（Gate B round-2 终态；v3「唯一载体 = 自描述 entry」口径据此扩正）**：① 主 session 自描述 record entry（runtime extractor/GUI 通道，W1 三环）；② 子文件 `.record-binding` sidecar（core `collectRecords`/list/TUI 的 light 重建通道——engine-CLI 化后子文件无身份 entry，binding 是身份面真身，`writeBindingForRecord` 创建、`identityFromBinding` 重建）——两载体均透传 origin/parentRunId（守卫式归一），binding 另携带终态快照 totalTokens/turns/endedAt（`updateRecordBinding` 于 `writeTerminalState`/`cancelBackground` 两终态写点 merge 落盘，缺失跳过不造新；sessions-index 可选字段不升 INDEX_VERSION）；**漏任一载体即该消费面过滤失效（Gate B S3 FAIL = 漏②的真机代价）**。消费面逐一点：
  ① subagents tool `list`（`subagents.ts:234`）默认过滤，增 `includeWorkflow?: boolean` 参数（缺省 false）——runner 恢复指引（`:445/502`）文案更新为带 `includeFinished:true` + `includeWorkflow:true` 配对（与 message-guard 文案族同款）；
  ② renderer `useSidebarCounts` 过滤——badge/active bucket 计数 + `subagentList` 组装点（[阶段3-R1 裁决] 三桶全滤：Agents tab 域 = 手动派发 subagent，与 badge 同语义、与 TUI 对称；下游 filterSubagents/countSubagents/查看全部(N) 同源自洽）；
  ③ renderer `useBackgroundWork.hasRunning`（`:26`）过滤 origin=workflow（配合 D7 终态化后此条自然缓解，过滤保留为双保险）；
  ④ TUI `/subagents` 同 list（同参数）；
  ⑤ 磁盘重建投影不过滤（record 全量持久化，重建后投影层同规则生效）；
  ⑥ 通知恢复链（`recoverOrphanRecords`/revive）全量可见（治理面）。
  **被否**：store 查询层默认过滤（破治理面）；按 slug 前缀推导（隐式约定，规则 19 之鉴）。
- **D2 进度源切换**：trace node 的 `live` 字段删除；views 改 store 订阅（parentRunId 查询 + record 事件 `getEventLog`/`getCurrentActivity` 同源 API）；`run-snapshot.ts` 剥离 live 序列化分支；node 保留 `result` 终态摘要。**stream 通道承接**：pump 的 `new SubagentStream`（`:790-792`）随 progress record 一并删除，streaming 由 service 派发路径既有通道承载（`executeAndAwait` stream 透传）。**查询域显式（v3）**：parentRunId 查询域 = **内存 ∪ 磁盘重建**（`collectRecords` 现状即内存 + 磁盘重建合并，`record-store.ts:8`）——D7 成功即 archive 出内存后，先完成步骤的 record 从磁盘重建面回查，run 视图不丢行；archive 终态快照的**实现锚点（v3 终审补）= 复用 archive 内置 notifyChange tick（订阅方收 tick 后经 parentRunId 查询域重查取终态 record）+ archive 内置终态 entry 同步落盘，store 侧零改动、不新增带 payload 的事件类型**；查询上限沿用 `LIST_LIMIT` 口径（`subagents.ts:236` 现状），超限分页不在本设计范围。
- **D3 并发共享池（定性修正：回归验证非新行为）**：现状 SAR 委托 `executeAndAwait` → `runAndFinalize` → `acquirePoolOrFinalize`——**已走共享池**（v1 检查点①就此定案）[H2 实施勘误：H1 后 SAR 直调 engine.run、无 record，本条仅在 22f77c157 基线成立——共享池实为 W2 新增，见 impl-plan 偏差表 W2]。编排归一后保持「路由/预检**先于** acquire」的现行顺序（失败零池占用语义保留）；全局上限默认值实施期从 settings 读实际数入验收表。
- **D4 守护单点**：no-progress 守护 arm 键从 taskId 归一为 record.id，service 派发路径统一 arm/disarm；**双刷新源包裹（journal.onEvent ∪ stream.onDelta）与 fire 恢复指引追注逐项复刻**（M3 语义不变，与 H1 Continuation 同模式；追注原 SAR 符号 `noteIfNoProgressFired` 已随编排归一消亡，现行落点 = runWorkflowEngineTask 内联追注 + armWorkflowNoProgressWatchdog 的 fired 判定）。
- **D5 发射面按域分明（v2 修正——v1「归一」主张撤销）**：run 级注册/注销**本就配对**（`lifecycle.ts:318-325` 注册 `id: runId, type:"workflow"` ↔ `pump:284-287` 注销 `id: run.runId`），保留于 run 域不动——v1「pump unregister 删除改由 record 终态化发射」会拆散配对、run 级注册永久残留（pending-notifications 未知 id 归 process 档永不 TTL 自愈，残留被放大）。修正后：record 级 register/unregister 已配对（`:1849-1850` / record 终态化注销）不动；C-proc-13 ② 枚举回写为按域分明（record 域注销发射 = 终态化 + chatMode 轮末 idle（Continuation 簿记）+ 对账 sweep 补发；run 域注册/注销对 = lifecycle/pump）。
- **D6 通知语义（v3 出口枚举化）**：workflow agent 的**完成/关闭/失败回注**全部静默（v3 扩失败——失败回注现状真实存在且经同一漏斗，`notify-host.ts:127-133` N1）。**gate 落点 = `toNotifyRecord` 单漏斗**（`notify-host.ts:124-161`；route 六调用点 `:1595/:2269/:2771/:2904/:2930/:3092` 全经此）——漏斗层盖住完成回注 + 失败回注；notifyClosed 对非 chatMode 结构性 no-op（`:190-191` 首行 `if (!record.chatMode) return`），无需处理。**监督器通知族（steer 通道）随 adopt 豁免自然消亡**：`supervisorNotify` 走 `pi.sendMessage` steer 独立通道（`service-binding.ts:48-53`）不经 notifyHost，其四条出口（sendDecisionGuidance / sendReplacedNotice / watchdog-expired 终止 / mergedFailure）全部以「record 被监督器 adopt 纳管」为前提——D7+决策表 v3 对 workflow origin **豁免 adopt**（见决策表）后该族对 workflow record 零触发；豁免理由 = guidance 文案对 workflow record 是死路指引（成功 record 被 endedMessageGuard 硬拒、死亡 record 的脚本早已收到失败），保留则预告落空或死路回注。notify-ledger 不涉入。
- **D7 workflow origin 成功收口 = 终态化（v2 新增，G1 显式例外；v3 补 CAS 规格）**：`settleOneShotOutcome` 增 origin 分支——**置于函数顶部**（现有 CAS :2541 之前，防其先把 memory closedReason 写成 "user-close" 与 finalizeRecord 的 "gc" 参数分叉）、条件 = `record.origin === "workflow" && !aborted`（aborted+success 竞态边缘照旧落现有 cancelled 分支，不漂移）、分支内自行 `tryTransition(record, "closed", "gc")` 抢锁（承接现状「cancel/dispose 抢先 → 静默跳过」守卫语义，`execution-record.ts:739-748`）→ 抢锁成功 `finalizeRecord`（closed/"gc" 自然完成）。失败/取消分支照旧终态化（现状已正确，aborted 映射 "cancelled" 不变）。**例外理由**：SP-5 running-resumable 为「父 agent message 续聊」设计，workflow agent 结果由脚本返回值承载、无 message 对端——终态化连带解决 hasRunning 绑架 / 30 天堆积 / message 误升级 / goal defer 恒挂四面；tool one-shot 分支零改动（H1 B#12 基线不破）。成功终态 reason=`gc` 的 GUI/通知投影兼容 = 实施期核验点⑥。**§2.2-5 的 record 级对账盲区由本决策实质收口**（成功 record 不再恒 running）。

**既有机制 × workflow record 决策表**（record 已在 store，自动接入的治理族逐族定案）：

| 机制 | 处置 |
|------|------|
| round-supervisor 运行期监督 | 纳管照旧（非 chatMode 全量纳管，H1 D8 定案；reconcile-sweep 对 workflow record 走标准对账） |
| round-supervisor **adopt 接管**（v3 改判） | **豁免**——豁免落点 = **service 分诊条件两处**（`runEngineTask` catch 的 engine_crashed 分支 :2379 与 `finalizeEngineOutcome` 的 exitCode===null 分支 :2437，`chatMode !== true` 并列处加 origin，落空即 `finalizeFailed` 立即终态化）**+ supervisor 域分类**（domain.ts:39）双点，防单点豁免留下「无监督、永不终态化、pending 永不注销」的 resumable 僵尸（比现状更差）；理由 = 引擎死亡即 run 失败即 record 终态化（失败路径表），adopt 链的「唤醒→guidance→2h 看门狗→giveUp」对无脚本可回的 record 全程无意义且制造 2h 挂账（watchdog 默认 `WATCHDOG_DEFAULT_HOURS=2`，`supervisor.ts:53`）；v2「纳管照旧」被轮 2 影响面 SUG-1/SUG-2 击穿后改判 |
| superseded 分类（v3 新增行） | **workflow origin 豁免**——classifyReplacement（`supervisor.ts:319-337`）按 same root/agent/slug 判定，parallel 同 slug 并行是 workflow 常态而非替代关系（v2「可接受」定性被击穿：replacedNotice 文案「was already replaced by your new task」把并行任务误述为替代关系） |
| notifyHost 完成/关闭/失败回注 | **静默**（D6：toNotifyRecord 单漏斗 origin gate） |
| 监督器通知族（supervisorNotify steer 通道） | 随 adopt 豁免自然零触发（D6 出口枚举） |
| pending register/unregister（record 级） | 照旧配对（`:1849-1850` / 终态化注销） |
| pending register/unregister（run 级） | 照旧配对（lifecycle ↔ pump），不动（D5） |
| idle-gc 30 天 | 不再适用于 workflow 成功 record（D7 终态化后无 running-idle 堆积） |
| message 升级链（actions-core） | 成功 record 已终态 → `getRecordForAction` not found → endedMessageGuard 硬拒指引（语义正确） |

### 3.4 错误规格（增量）

| 错误 | 触发 | 形态 | 恢复 |
|------|------|------|------|
| 池排队中被 abort | workflow abort 信号 | run 域既有 cancelled 收口（S1 同款分支） | 脚本层重试 |
| record 创建失败（极端） | store 异常 | agent() 同步抛错回脚本 | 文案附原因 |
| 引擎死亡于 workflow agent 在途 | run 失败——engine_crashed 经 catch 合成为 failed result **回脚本**（swallow 语义，脚本观察到失败结果非异常）→ record 由失败路径立即终态化 | adopt 豁免后无 2h 看门狗挂账窗（v3）；完成/失败通知静默（D6） | 脚本层重跑；排查 `list includeFinished:true` (add includeWorkflow:true to also see workflow-dispatched subagents) |

### 3.5 终态数据流

```
worker agent() → pump（薄：消息转调 + run 级收尾）→ service.executeWorkflowAgent(opts, parentRunId)
  → store.register({origin:"workflow", parentRunId})（record 级 pending:register 照旧）
  → 路由/预检（先于池）→ pool.acquire（共享池）→ armMidRoundNoProgress(record.id)（双刷新源）
  → 引擎执行（journal 接线单点）→ 事件流 → observedEvent 喂入 `updateFromEvent(record, event)`
    （三域锚点 = runWorkflowEngineTask / kickOffChatRound / runEngineTask，与 journal-replay 同 reducer；
    **改引擎事件出口必须核对三域喂入不断链——Gate B A3 断链即此环失守**）
  → record（views 经 store 订阅实时渲染）
  → AgentResult 回脚本
  → 成功：record 终态化 closed/gc（D7；完成通知静默 D6；record 级注销随终态化；
    终态写点同步 `updateRecordBinding` 快照落盘——binding 身份面见 D1 双载体）
  → 失败/引擎死亡：record 终态化（现状分支 / giveUp 链）+ 异常通知保留
（run 级 pending:register/unregister 对 lifecycle↔pump 不变，D5）
```

---

## 4. 验收（真实场景；每场景回溯目标）

| # | 场景 | 步骤 | 通过标准 | 回溯 |
|---|------|------|---------|------|
| S1 | 多 agent 实时进度 | GUI 跑 `parallel(3×agent())`（真实 LLM） | run 视图实时进度与现状形态一致（数据源已换 store 订阅；tokens/toolCalls/elapsed/eventLog/currentActivity 逐字段对齐现状 live 投影——字段清单以 W3 实施时的 `projectLiveProgress` 输出为准）；三步结果正确回脚本 | G1/G2 |
| S2 | 重启恢复 | S1 在途时重启宿主 | run 视图重开后各步终态正确（record 为真相）；每个子代理 record 经 `list includeFinished:true` (add includeWorkflow:true to also see workflow-dispatched subagents) 可查 | G1/G2 |
| S3 | 列表隐藏 | S1 完成后开 GUI subagent 列表 + TUI `/subagents` | 两处默认均不含 workflow 子代理；`includeFinished:true + includeWorkflow:true` 成对可见（S1 完成后 record 已终态，缺 includeFinished 不可见）；手动派 subagent 照常显示 | G2 |
| S4 | 并发共享池回归 | workflow parallel(4) + 同时手动派 2 个 subagent（上限值 N = 实施期读 settings 默认值入表） | 任一时刻在途总数 ≤ N（池统计口径一致）；**饿死判定口径**：上限释放后排队任务全部最终执行完成（完成序断言） | G3 |
| S5 | 删除面回归 | 删路完成后 | `grep -n "createRecord(" packages/subagent-core/src/orchestration/` 零命中；views 三文件 + run-snapshot 编译零 live 引用；四包全量测试绿；workflow 崩溃恢复（FileRunStore）行为不变 | G1 |
| S6 | 治理表面不变（反向场景） | workflow run 正常结束 + 注入单步失败 + **注入引擎死亡（v3 变体）**各跑一次；另验宿主重启于在途 | ① pending 注册表差集归零（run 级 + record 级；引擎死亡路径经失败路径**立即**终态化，不等 2h 看门狗——adopt 豁免；pending-notifications 列表无 workflow 残留条目）；② 完成不产生回注通知、不产生 pending 通知条目（D6 负面断言，覆盖 toNotifyRecord 漏斗 + 监督器 steer 族零触发）；③ 失败 record = closed + outcome failed（两态模型口径）+ run 视图终态一致 + 无回注通知；④ goal 守卫口径恢复基线；⑤ 成功 record 不出现在 hasRunning | G1/G2 |

---

## 5. 下一层拆分（PR 单元）

| 单元 | 内容 | justification | 可独立验收 |
|------|------|--------------|-----------|
| W1 | `origin`/`parentRunId` 字段 + **持久化链三环（v3）**：`record-entry.ts` entry schema 加字段 + `recordToSubagent` 投影加字段 + 重建链透传（终态 record 过重启的唯一载体 = 自描述 entry，漏任一环则重启后 origin 丢失、D1 六面全失效——U5 投影缺字段同型事故先例）+ store 查询面（parentRunId 查询、`includeWorkflow` 参数）+ 投影层过滤（list/sidebar/hasRunning/TUI 四处） | 纯 additive 字段先行，消费方可渐进切换 | 单测：entry 往返（写→重建→字段保真）+ 四投影面过滤断言 |
| W2 | service 统一编排入口 `executeWorkflowAgent`（**接管迁移清单**见下表）+ D7 origin 收口分支 + D6 通知 origin gate | 新路径最小闭环；与 H1 咬合点：settleOneShotOutcome 增 origin 分支（tool one-shot 四分支零改动）、守护键与 H1 Continuation 同模式 | 单测：注册面/池顺序/守护 arm 键/D7 收口/D6 gate/治理决策表逐族（**含 bootPartition 对 workflow 形态负面断言——boot 重认领豁免的推导坐实**） |
| W3 | pump 切换：删 progress record + trace.live + `new SubagentStream`；views/detail-content + WorkflowsView + run-snapshot 的 live 消费面改造；订阅源切 store | 消费面切换，W2 就绪后一次切换 | S1/S3 真机 + live 零引用编译 |
| W4 | runner 归位（**v3 定形：保留 SAR 类壳掏空 run() 改纯转调 executeWorkflowAgent——构造签名不变，唯一装配点 `session-lifecycle.ts:537` 零改动不进地图；ctxModel dep 保留签名兼容、run() 内不再消费**）；journal-wiring workflow 域调用点归一（SAR 侧删除，service 单点）；sweep 的 workflow 判据装配处置（run 级判据保留） | 死代码删除，最后做避免中间态；壳形态避免 extension 装配点连带 | S5 + 全量测试 |
| W5 | 约束/文档回写（C-proc-13 ②按域分明、sweep 条款修正、troubleshooting 排查通道更新） | C-proc-10 同步纪律 | doc-symbol-drift 绿 |

**W2 接管迁移清单（SAR.run 内部步骤逐项：复刻/保留/放弃）**：

| SAR.run 内部步骤 | 处置 |
|---|---|
| ① 路由 `routeEngineForHost`（三层+probe+fallback） | 复刻——executeWorkflowAgent 内复用 engine/routing.ts 单点 |
| ② capability 预检 `assertTaskShapeSupported` | 复刻——复用 capability-gate（workflow 域 zcode+worktree 漏拦修复赖此） |
| ③ 非 pi 引擎 model 校验 `validateModelForEngine` | 复刻——复用 |
| ④ journal 接线（wireEventJournal+backfill+close） | 复刻——复用 common helper（本已共享） |
| ⑤ no-progress 守护（arm + 双刷新源包裹 + disarm + fire 追注） | 复刻——service 派发路径统一 arm（D4，键 record.id） |
| ⑥ `mergeRunSignals`（timeout+watchdog+dispose 合流） | 复刻——模块内直调提为公共 helper |
| ⑦ spawned-children 注册（dispose killAll 收割兜底） | 复刻——engine host 层单点复用 |
| ⑧ ctxModel 孪生守卫 | 放弃迁移——service 侧 resolveIdentity 已有 model 解析，不双轨 |

**文件改动地图**：core `execution/types.ts`（origin 字段）/ `execution/record-entry.ts`（entry schema 加字段）/ `execution/record-store.ts`（recordToSubagent 投影 + 重建透传 + 查询面）/ `execution/subagent-service.ts`（executeWorkflowAgent + settleOneShotOutcome origin 分支 + adopt 豁免 origin 分支）/ `execution/subprocess-agent-runner.ts`（归位——注意在 execution/ 非 orchestration/）/ `execution/engine/routing.ts` 与 `engine/common/{capability-gate,journal-wiring}.ts`（复用，无改动或 mergeRunSignals 抽取入 common）/ `execution/round-supervisor/service-binding.ts`（adopt origin 豁免分支）；`orchestration/worker-message-pump.ts`（删 progress record/SubagentStream/emit 不动 run 级注销）/ `orchestration/lifecycle.ts`（零改动，D5 配对保留）/ `orchestration/run-snapshot.ts`（剥 live）；extension `subagent-workflow/src/interface/views/{detail-content,WorkflowsView}.ts` + `interface/subagents.ts`（includeWorkflow）；`session-lifecycle.ts` 零改动（W4 壳形态）。
**H1/H2 重叠咬合点**：subagent-service.ts（H1 重写编排核 + Continuation；H2 增 executeWorkflowAgent 与 origin 分支）——串行执行（H1 先行），H2 实施时行号以符号 grep 锚定；settled-watchdog 键空间（H1 改刷新源、H2 arm 键 record.id 同模式）。

**待验证检查点（实施期门）**：① ~~runner 是否绕池~~（已定案：不绕，D3）；② TUI 渲染面对 `getEventLog`/`getCurrentActivity` 的精确依赖与 `projectLiveProgress` 字段清单（S1 等价表依据）；③ workflow run 视图 GUI 数据源现状链（views 的 trace 投影）；④ FileRunStore 重水合与 store 孤儿恢复的终态对齐（不一致以 record 为真相的实现点）；⑤ 全局并发上限默认值（读 settings 入 S4 验收表）；⑥ D7 成功终态 reason=`gc` 在 GUI 列表/详情与通知投影的显示兼容。

---

## 附：决策溯源与被否谱系

复杂度审查（2026-09-10）发现游离 record（编号 A4）；用户裁定期望形态 = 「workflow 中 agent() 等同一个 subagent」，四裁定（等同 / 隐藏 / store 订阅 / 共享池）。执行序排 H1 之后（两者都动 subagent-service.ts，串行防冲突）。

**v1 首轮双审（9 MF）**：前提翻案（真实 record 已进 store/池，游离仅 pump 进度假 record）、新增 D7、D5 撤销归一改域分明、治理族表、hidden 六面、八步接管清单、live 真实消费方、S4 口径、H1 咬合声明。

**v2 轮 2 双审击穿记录（被否谱系）**：

1. **「D6 静默 = notifyHost 出口 gate」（v2）**——被轮 2 影响面 MF-1 + 主审 SUG-2 联合击穿：①监督器通知族四条走 supervisorNotify pi steer 独立通道不经 notifyHost，gate 一条盖不住；②失败回注现状存在且经同一 route 漏斗（N1），静默域漏「失败」则 S6③ 必挂。修正为出口枚举化（toNotifyRecord 单漏斗盖完成/关闭/失败回注 + steer 族随 adopt 豁免零触发）。
2. **「origin/parentRunId 只进 types.ts + 查询面」（v2 文件地图）**——被轮 2 影响面 MF-2 击穿：终态 record 过重启唯一载体 = 自描述 entry（archive 即删内存），entry schema/投影/重建透传缺任一环则重启后 origin 丢失、D1 六面全失效。修正为 W1 持久化链三环 + record-entry.ts 进地图。[Gate B 真机再证伪 + round-2 收口：binding sidecar 身份面（第二载体）漏登记致 S3 FAIL——归档/重启后 core list/TUI 走 binding 重建通道，origin 仍丢；终态 = 双载体口径，见 D1]
3. **「成功即终态化（未定查询域）」（v2 D7）**——被轮 2 影响面 MF-3 击穿：archive 即出内存，parentRunId 查询域不声明则先完成步骤从 run 视图消失（S1 破）。修正为 D2 查询域显式（内存 ∪ 磁盘重建 + archive 终态快照事件 + LIST_LIMIT 口径）。
4. **「adopt/giveUp 对 workflow 可接受（v2 决策表）」**——被轮 2 影响面 SUG-1/SUG-2 击穿：giveUp 链 2h 挂账（pending 差集非零/list 可见 running）；superseded 对 parallel 同 slug 误述替代关系；guidance 死路指引 + mergedFailure 预告落空。修正为 adopt 豁免 + superseded 豁免（v3 决策表改判）。
5. **「D7 origin 分支 = status 判断后分流（v2 无 CAS 规格）」**——被轮 2 主审 SUG-1 击穿：插 CAS 后则 memory closedReason 被 :2541 先写 "user-close" 与 finalizeRecord "gc" 分叉；条件不含 !aborted 则 aborted+success 边缘从 cancelled 漂移为 gc。修正为函数顶部 + 自带 tryTransition 抢锁 + 条件含 !aborted。
