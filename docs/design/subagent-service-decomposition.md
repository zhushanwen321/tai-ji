# SubagentService 上帝类拆分

> **层声明**：结构设计层（重构方案）——当前层 = 聚合边界与迁移策略，下一层 = 可实施的抽取 PR 单元（§5）。零行为变化是本设计的硬约束。
> **前置依赖**：H1（chat 域统一）+ H2（workflow record 归位）先行落地后再拆——chat 域 16 方法族消亡、workflow record 进 store 后，类的职责形状才稳定，拆分只做一次不返工。
>
> **一句话结论**：3255 行 / 103 个类成员 / 19 个职责域的 `SubagentService` 按 4 个聚合拆分（SessionBaselines / SyncCollectDomain / RecordLifecycle / RunOrchestration），原类退化为装配壳（类体行数 ≤ 500——口径见 G1）；strangler 式逐聚合抽取，每步全绿、对外 API（`SubagentQueries` / `SubagentChatActions` 聚合面）不变。

---

## 1. 背景目标

### 1.1 SCQA

- **S**：`packages/subagent-core/src/execution/subagent-service.ts` 是 subagent 子系统的编排核——3255 行、103 个类成员，单类同时承担 19 个职责域（§2.1 全表）。
- **C**：约 30 个可变实例字段互相咬合（notifyHost / collectCoordinator / coldResurrectDeps / roundSupervisor / manifestStore / recordsDir…），改任何一个域都要面对整个类的字段面；AI 导航与人工审查 alike 的理解成本都随域数超线性增长；「改 chat 域必须通读引擎编排」是日常。
- **Q**：如何在零行为变化前提下把它拆成可独立理解/测试/演进的单元？
- **A**：按职责域自然分组拆 4 聚合 + 装配壳，strangler 式迁移。

### 1.2 系统是什么（受众认知铺垫）

SubagentService 跑在宿主 pi 主进程内（extension 加载），是 subagent 工具六个 action（start/list/cancel/message/close/fork-from）与 workflow AgentRunner 的统一编排层：创建/管理 ExecutionRecord（record 注册表）、派发引擎任务、维护会话身份基线（哪个主会话、fork 深度）、回收资源、装配通知。它对外已有两个窄接口投影（`SubagentQueries` :134 / `SubagentChatActions` :151）——**拆分的对外形状已经存在**，缺的是内部边界。

### 1.3 设计目标

- **G1 尺寸与聚焦（v2 口径修正）**：壳**类体**行数 ≤ 500（`wc -l` 减去 imports / 模块常量 / 接口声明——**外移后残余非类体行 ~150**，文件口径不可达，见 S2 算术）；每聚合 ≤ 700 行（附算术：RunOrchestration = #6(~12)+#7(~68)+#12(~110)+#14(~440)+#15(~49) ≈ 680 + 注入接口样板，600 不可达——v1 数值与 §2.1 自身算术矛盾，附录 B#1）；每聚合单一职责域族；改一个域不再通读其余。
  - **[终态回写 2026-09-12，阶段 6]** 两处算术被实测证伪、经主 agent 裁决追认（impl-plan §5 D-R4-1 / D-R6-1）：
    - **壳类体 ≤500：达成**——壳 subagent-service.ts 终态 **893 物理 / 409 eslint 折算**（R6 外移后实测）。
    - **每聚合 ≤700：六聚合中五达标**（session-baselines 401 / sync-collect-domain 518 / record-lifecycle 531 / record-access 540 / workflow-dispatch 527，物理行）；**run-orchestration 1506 物理 / 798 eslint 折算超限追认**——本条的 ≈680 估算基于 H2 workflow 族并入前的旧域表口径，实测证伪；为凑 700 硬拆需重走 C-5 回调链协作面，违背「聚焦」本意，lint 面以单列 override `max:800` 零余量锁定当前形态（增长即暴露，演化史注释在 eslint.config.mjs）。
    - **单类成员 ≤40（S2 判据）：不可达追认**——壳成员 **63**（TS AST `ClassDeclaration.members` 全集口径：20 字段 + 31 方法 + 11 getter + 1 ctor；初登记 52 系 grep 口径盲区——漏 ctor 与无修饰符 public 方法）。超限主体 = strangler 转发面（聚合面 getter + 单行转发方法），删转发会把聚合公共面升级为跨包 API、破坏 D3 消费方零改动承诺；G1 防壳积累业务逻辑的实质已达成（壳方法几乎全为单行转发/装配编排）。
    - **两把折算尺对照**（报告数字必须标注口径名）：**eslint 折算口径** = skipBlankLines + skipComments 的全文件折算（壳 409 / run-orchestration 798）；**类体口径** = `wc -l` 减 imports / 模块常量 / 接口声明（本条主口径；R6 三类外移后壳内残余非类体行远低于 v2 预估 ~150）。
- **G2 依赖单向显式**：壳组合聚合；聚合间禁止互调私有方法（需要协作的经壳编排或显式接口）；**service 实例字段**所有权单一（单写者）——共享 `ExecutionRecord` 对象内部字段的写点收口归 H4（见 D1 两级归属）。
- **G3 测试随聚合迁移**：每聚合自持测试面；God-class 级测试拆散归属；**深绑内部结构的测试改写不降低断言强度**（见 D6）。
- **G4 零行为变化**：纯结构重构；全量测试全绿是每步合并门槛；**前置 = R0 前确认基线绿**（存量红先归档豁免清单——2026-09-11 单次实测 `workflow-state-root.test.ts` GC 写回用例红、复跑全绿 2849 用例（2845 passed + 4 skipped / 15.4s），疑似环境相关，R0 前归档定性：可复现则记录复现条件）。

### 1.4 in / out scope

**in**：subagent-service.ts 的内部拆分；关联测试文件迁移；导出面（index.ts barrel）保持不变。
**out**：任何行为/语义变化（含日志文案）；跨模块的搬迁（record-store / notifier 等已是独立模块不动）；H1/H2/H4 的改动内容。

---

## 2. 现状与问题分析

### 2.1 十九职责域全表（行号为 **H1 前基线**（2026-09-10 L 批次后），区间有 ±23 漂移；H1/H2 落地后整域消亡/新增（#9/#16 消亡、#14 增 executeWorkflowAgent），**R0 以重测域表取代本表**，行号仅审查期参照）

| # | 域 | 代表方法 | 行区间 |
|---|-----|---------|--------|
| 0 | 对外面声明 | SubagentQueries / SubagentChatActions | 131–158 |
| 1 | 依赖装配 | constructor + ~30 字段 | 306–573 |
| 2 | session 注入 + ALS/嵌套身份基线 | initSession / initForkDepthBaseline / initExecContextBaseline | 574–691 |
| 3 | 孤儿/manifest 恢复 | recoverOrphansIfRootProcess / recoverOrphanRecords / recoverManifestTmpFiles | 692–757 |
| 4 | 回收面（fork/new/dispose/GC timer） | disposeAllRecords / onParentFork / onParentNew / startGcTimer / dispose | 758–846, 1096–1197 |
| 5 | sync 批（E9/E1） | getCollectSyncBudget / markMembersBatchFinalized / recoverSyncCollectBatch / armSettledRescan ×9 | 847–1095 |
| 6 | model 解析 | resolveModel | ~1200 |
| 7 | run 域执行入口 | execute | ~1215 |
| 8 | 查询面 | findRecord / lookupRecordAnyState / onChange / collectRecords / getFullRecord ×7 | 1282–1344, 1919–1968 |
| 9 | chat 域投递/冷续/看门狗 | deliverChatMessage / resumeColdRound / onHotPathSettledWatchdogTimeout | **H1 后消亡** |
| 10 | action 网关 | getRecordForAction | 1616–1673 |
| 11 | close 三路 | closeSubagent / closeChatIdle / closeAfterRoundSettled | 1674–1814（chat 分路 H1 后消亡） |
| 12 | await 入口 | executeAndAwait | 1815–1918 |
| 13 | 身份解析/record 创建 | resolveIdentity ×2 / createRecordForMode / buildEarlyFailedHandle | 1969–2119 |
| 14 | 引擎编排（run 域） | executeViaEngine / kickOffEngineRun / runEngineTask / adoptResumable / finalizeEngineOutcome / runAndFinalize ×10 | 2120–2560 |
| 15 | pool/worktree 资源 | acquirePoolOrFinalize / resolveWorktreeHandle / releaseRoundResources | 2561–2595 |
| 16 | chat spawn/轮次生命周期 ×13 | kickOffChatRound / handleChatRoundPhase / armChatIdleTimer ×13 | **H1 后消亡**（H1 保留其派发主干并归入 Continuation） |
| 17 | 取消 | cancelBackground | ~3030 |
| 18 | finalize 簇 | finalizeRecord / finalizeFailed / finalizeAborted | 3081–3172 |

H1 落地后 #9/#16 整族与 #11 的 chat 分路消亡（净缩约 600-800 行）；H2 落地后 #14 增 `executeWorkflowAgent` 入口、#8 查询面增 origin 过滤——**拆分在 H1/H2 之后做，剩余约 14 个域**。

### 2.2 痛点（实例）

1. 字段咬合：sync 批恢复（#5）依赖 dispose 状态（#4）与 store 写入（#3）；chat 投递（#9）依赖身份解析（#13）与引擎编排（#14）——改任一处需通读全部。
2. 测试定位难：God-class 级测试文件按场景而非域组织，回归定位要跨文件。
3. AI 导航差：103 成员无分区导航，模型每次理解成本高（本仓 AI 开发为主 workflow，这是真实生产力成本）。

### 2.3 根因

历次功能按「往 God class 加一个方法」的局部最优累积（每单次都合理），从未做过结构性回收。对外窄接口（#0）先于内部边界存在——投影有了、本体没分。

---

## 3. 解决方案

### 3.1 终态结构

```
SubagentService（装配壳，类体 ≤ 500 行）
  ├─ 职责：组合根装配 / initSession·dispose 生命周期时序 / 断言 / 对外聚合面保持
  ├─ SessionBaselines     —— 域 #2：sessionId/sessionRootId/fork 深度 ALS/UI handler/
  │                          dialog 队列/isIdle（纯会话基线，无 record 知识）
  ├─ SyncCollectDomain    —— 域 #5：collectCoordinator 装配 + E9 转账 + E1 批恢复
  │                          （自闭合批语义）
  ├─ RecordLifecycle      —— 域 #3/#4/#8/#10/#11/#13/#17/#18：注册/查询/action 网关/
  │                          close 分流/finalize 簇/孤儿恢复/GC timer/**回收面**
  │                          （disposeAllRecords/onParentFork/onParentNew——v2 补归属，
  │                          批量关闭路径 + E9 先于批量 archive 的时序约束与 SyncCollect
  │                          硬耦合）/cancel/身份解析
  │                          （store 与终态迁移入口的唯一宿主——H4 落点；record 字段级
  │                          写点仍散布，见 D1）
  ├─ RunOrchestration     —— 域 #6/#7/#12/#14/#15：model 解析/execute/await/
  │                          引擎 kick-off/adopt/finalizeEngineOutcome/pool/worktree
  ├─（H1 已立的 ConversationContinuation 与 H2 的 executeWorkflowAgent 归
  │    RunOrchestration 协作面；H1 后 finalizeRoundToIdle wrapper 唯一调用方 =
  │    settleOneShotOutcome，随其归 RunOrchestration 或内联）
  └─（壳终态另永久保留：Init 接口/模块常量/单例访问器外移至 execution/service/
     独立文件经 barrel re-export——R6 单元，导出面不变）
```

### 3.2 多方案对比

| 方案 | 长期合理性 | 短期成本 | 风险 | 判定 |
|------|-----------|---------|------|------|
| **A. 四聚合 strangler 渐进抽取** | 高：边界沿既有域缝，对外形状不变；每步可回滚（**revert 单元 = 每 PR 独立 commit 一键 revert；中间态零持久化格式变化——纯代码结构，任意步 revert 无残留**；重审触发 = R3 归属争议字段 >10 个或 S1 链路行为差异无法归因时，重开聚合边界评审） | 中：4-6 个 PR 分批（含 R6） | 低：每步全绿门槛 | **选定** |
| B. 一次性大爆炸重写到新文件再切换 | 中：边界同 A | 低（单 PR）但审查不可行 | 高：3000+ 行 diff 不可审，行为漂移不可见 | 否——违反「打包子系统改动逐个 commit 逐个验证」的项目教训 |
| C. 不拆，仅加分区注释与导航标记 | 低：字段咬合与测试组织问题原样 | 极低 | 无行为风险但零结构收益 | 否——治标，三个月后仍想拆 |

### 3.3 关键决策

- **D1 聚合边界按「字段所有权」切（v2 扩为两级归属）**：**第一级 = service 实例字段**：每个可变字段归唯一聚合（首个系统性写它的域所属），跨聚合读经显式 getter。**第二级 = record 字段写点通道**：record 字段级写点（engineHandle 回填/sessionFile/result/error/resumable 等）在 RunOrchestration/Continuation 侧仍直写共享 `ExecutionRecord` 对象——H3 零行为变化约束下**不收口**（收口 = H4 写原语落点）；RunOrchestration 经 `finalize-record.ts` 模块函数（两聚合共享底层）与自有直写两通道，调用边界在 R0 归属表逐点声明。「唯一宿主」声明降级为「**store 与终态迁移入口的唯一宿主（H4 落点）**」——**唯一宿主 = H4 写原语落点语义，非唯一访问者**（v3 补：SyncCollect 直调 store 的落标/E1 重建投影写是独立通道，列入 R0 ②表，不得改道 RecordLifecycle——改道即违反零行为变化）；v1「record 状态机唯一所有者」与源码写拓扑（runEngineTask backfill :2309-2333 / outcomeToAgentResult sessionFile :2561-2563 / adopt 写 error/result :2402-2407）冲突，附录 B#2。**被否**：按用例切（use-case 分解会产生大量传参与共享状态复制）。
- **D2 抽取顺序按依赖最少先**：SessionBaselines（几乎零依赖）→ SyncCollectDomain（依赖 store 注入）→ RecordLifecycle（依赖 store/notify，**含域 #4 回收面**）→ RunOrchestration（依赖前三者）。每聚合一个 PR，抽取后原类委托转发（对外方法签名不变）；**R4「删转发」仅指过渡期冗余转发——壳终态永久保留一批非聚合面 public 方法**（逐项清单见 D3+）。
- **D3 对外 API 冻结 + 壳终态委托面清单**：`SubagentQueries`/`SubagentChatActions` 与 barrel 导出签名不变；extension/runtime 消费方零改动。**壳终态保留 public 方法（逐项，v2 补——实证消费方 subagent-actions-core ×23 处 / subprocess-agent-runner / extensions session-lifecycle；v4 补两个漏列活消费点**：`getStreamSink`（:357 定义，workflow `index.ts:269` 经 `getSubagentService()` 直调——包外消费方，删转发后无法经聚合投影修复；`getSessionRootId`（:336 定义，`subprocess-agent-runner.ts:272` 直调）**）**：execute / cancel / executeAndAwait / initSession / dispose / onParentFork / onParentNew / startGcTimer / recoverSyncCollectBatch / recoverManifestTmpFiles / getCollectSyncDefault / ~~executeViaEngine~~（**[终态回写 2026-09-12，阶段 6]** R4 按「R0 重生成清单 + 全仓零消费」删除判据移除该转发——静态清单未跟，划去；与 resolveWorktreeHandle 同为死转发，见 impl-plan D-R4-2）/ asEngineService / getStreamSink / getSessionRootId / queries / chatActions / 单例访问器（getSubagentService/setSubagentService/createSubagentService）。**R4 删除判据绑定 = 按 R0 时全量重生成的清单执行（grep 实例方法直接调用面，queries/chatActions 之外），不按本文静态列表**。
- **D4 协作规则（v2 补第三方向；v3 补下沉前提）**：聚合间禁止互调私有方法；需要跨聚合编排的场景（如 close = cancel + finalize）留在壳层编排或经显式接口；**聚合→壳禁止 import**（assertReady 断言下沉独立模块或经构造注入——现状 9 个调用点直调壳断言 = 反向边，环风险实形态；**下沉选项的依赖形态 = late-bound getter 注入**——assertReady 读 `this.pi`（initSession 时点晚绑定）与 `this._disposed`，构造期注值会使聚合持过期引用破 session 复活，须注入 `() => ({pi, disposed})` 形态 getter 或沿 notifyHost 装配闭包先例经壳运行时读取）；R5 环检查覆盖三方向（聚合间 / 聚合→壳 / 壳→聚合）。
- **D5 H4 同轴预告**：RecordLifecycle 聚合的接口面即 H4「意图级写操作」的落点——本设计只搬不改，H4 在其上收口持久化。
- **D6 深绑测试改写面（v2 新增）**：≥10 个测试文件深绑 service 内部结构——运行时字段替换（`(service as unknown as {notifyHost}).notifyHost = {...}` ×4 文件，依赖「闭包经 this 运行时读取」语义，改显式注入后失效）、`ServiceInternals` 全量内部访问 ×6 文件、`vi.spyOn(internal.manifestStore)`——抽取后**是改写不是搬移**。R0 产出深绑测试全集（grep `as unknown as` / `ServiceInternals`）；R1-R4 每步声明对应测试的改写形态（mock 注入时点 / 访问路径 / ServiceInternals 重定义）；断言强度不降（S4 判据）。

### 3.4 风险与守门

1. 行为漂移：每 PR 全量测试 + diff 逐行审查（搬运不得夹带改写；确需微调的单独标注）。
2. 字段撕扯：归属争议字段暂留壳层并标注 `// owner: pending R?`，最终 PR 清零；争议超阈值（>10）触发聚合边界重审（§3.2 A）。
3. 循环依赖：三方向（聚合间 / 聚合→壳 / 壳→聚合）import 必须无环（lint 守卫已有同款 services 循环依赖检查可参照，subagent-core 侧由 R5 新建守卫）。
4. 基线红：R0 前基线必须核对（G4 前置）；存量红用例归档豁免清单，不阻塞结构 PR 但不得新增红。

---

## 4. 验收（真实场景 + 硬指标；回溯目标）

| # | 场景/指标 | 步骤 | 通过标准 | 回溯 |
|---|----------|------|---------|------|
| S1 | 全功能回归（真实 GUI + 真实 LLM） | 派 one-shot subagent / chat 续聊两轮（H1 后形态）/ 跑一个 workflow / close 在途 / 重启宿主 / **轮在途 kill 引擎 → message 冷启 resume（v2 补第六链，判据对齐 H1 S4：失败通知单发 + 原文件 resume + 无交错行）** | 六条链路行为与拆分前逐项一致（通知/结果/恢复/列表投影）；**执行时点 = R4 后终验 + 全部合并前复跑** | G4 |
| S2 | 尺寸硬指标（v2 口径） | 类体行数（`wc -l` 减 imports/模块常量/接口声明——这三者已由 R6 外移）+ 成员数 | 壳类体 ≤ 500 行；每聚合 ≤ 700 行（算术依据见 G1）；单类成员数 ≤ 40 | G1 |
| S3 | 依赖单向 | 聚合 import 图 | 三方向无环（聚合间 / 聚合→壳 / 壳→聚合）；聚合间无私有方法互调（grep 守卫可机械检查。**[终态回写 2026-09-12，阶段 6]** 私有互调检查可机械覆盖的子集 = 「deps getter 直调」单一文本形态——R5 守卫 `scripts/check-subagent-service-boundary.mjs` 已接管；getter 返回类型接口化 / 实例缓存等通道机器不覆盖，显式划归 code review 职责——阶段3 P3-4 覆盖面登记，守卫文件头注释同步） | G2 |
| S4 | 测试随迁 | 测试文件清单 + 深绑测试改写清单（D6） | 每聚合至少一个同名域测试文件；God-class 级场景测试归壳层集成测试；**深绑测试改写不降低断言强度** | G3 |
| S5 | 全量测试 | **subagent-core 全量**（2849 用例实测 17s，成本可忽略）+ 受影响包（四包 = subagent-core / subagent-engine-sdk / pi-subagent-cli / zcode-subagent-cli，本设计只改 core，其余三包为口径面）+ extension 三连 | 全绿（行为零变化的机器证据；前置 = R0 前基线绿，存量红已归档豁免） | G4 |

---

## 5. 下一层拆分（PR 单元）

| 单元 | 内容 | justification | 可独立验收 |
|------|------|--------------|-----------|
| R0 | 壳内分区整理：按 §2.1 域重排成员 + 分区注释（纯移动零抽取）；**产出三清单：①~30 实例字段逐个归属表 ②record 字段写点通道边界表（D1 第二级，含 store 入口投影写通道——落标/E1 重建）③深绑测试全集（D6）**；**R0 ①清单同时登记已知跨聚合边（v4 主审对抗线索）：壳 dispose 直改 SyncCollect 内部态 `settledRescanState`（:1117，收敛为显式接口）——原第二条 `unregisterChatRoundRoute` 跨聚合边已随 H1（chat 域退役，注销发射点改 Continuation 轮终簿记）消亡，不再登记；验收补两条机械对账（v3）：①清单行数 vs 类字段声明 grep 计数一致 ②写点通道表 vs record 字段赋值 grep 计数一致——给 PR reviewer 完备性量尺，防「自证完备」** | 给后续抽取建立物理锚点，diff 可机械核对；三清单是 R1-R4 的实施依据 | 全量测试绿（基线已先核对，G4 前置）+ 两条机械对账通过 |
| R1 | 抽取 SessionBaselines | 依赖最少先行，模式打样 | S2/S5 |
| R2 | 抽取 SyncCollectDomain | 自闭合批语义，注入面窄 | S2/S5 + sync 批恢复用例 |
| R3 | 抽取 RecordLifecycle（**含域 #4 回收面**） | record 终态迁移宿主最大聚合；与既有 record-store/finalize-record 协作面理顺 | S2/S5 + S1 的 close/重启链路 |
| R4 | 抽取 RunOrchestration + 删过渡期冗余转发（壳终态保留面见 D3 清单；notifyGateAllowsDelivery 壳保留 re-export 或 barrel 路径随迁注明例外） | 依赖前三者最后抽；转发清理收尾 | S2/S3/S5 |
| R5 | 测试归位 + 守卫（三方向循环依赖 / 私有互调 grep 门） | G2/G3 的机械守门 | S3/S4 |
| R6 | 外移 Init 接口 / 模块常量 / 单例访问器至 `execution/service/` 独立文件（**import 纪律（v4）：Init 接口 type-only；单例访问器经 barrel 直接改指向 service-bootstrap、不做壳 re-export（防壳↔bootstrap 值环——bootstrap 必须 new SubagentService，壳侧 re-export 即成环，且 bootstrap 非聚合、三方向环守卫覆盖不到此边）；类体消费的常量留壳或独立叶子模块**；R5 守卫扩壳侧支撑文件方向） | 壳类体 ≤500 门槛的达成单元（文件口径算术见 G1） | S2 + barrel 导出面不变断言 |

**文件改动地图**：`execution/subagent-service.ts`（缩为壳；`notifyGateAllowsDelivery` 模块级导出 :257 壳保留 re-export——逻辑属 notify 面，不随聚合搬迁）；新增 `execution/service/{session-baselines,sync-collect-domain,record-lifecycle,run-orchestration,service-bootstrap}.ts`（service-bootstrap = R6 外移的 Init 接口/模块常量/单例访问器，命名建议新增，实施可调）；`execution/__tests__/` 对应迁移与深绑改写（D6）；barrel 消费方零改动。

**待验证检查点**：① #5 域与 collect-coordinator 的注入闭包拆分点（flushBatch 依赖 service 闭包——抽取时改为显式依赖注入）；② **R0 三清单**（实例字段归属表 + record 字段写点通道边界表 + 深绑测试全集）作为 R1-R4 实施依据；③ dispose 时序在壳层的最终形态（RecordLifecycle 承接域 #4 后，壳 dispose 编排对它的调用顺序与现状等价性——E9 先于批量 archive 的时序约束保持）。

---

## 附：决策溯源与被否谱系

复杂度审查（2026-09-10）将上帝类列为最高可读性收益候选（A3）；用户裁定「H3 你来处理」，执行序定于 H1/H2 之后（chat 聚合消亡后再拆、范围更小）。拆分边界（四聚合）为建议新增命名，实施期可微调但须保持 §3.3 D1-D6 规则。

**被否谱系（v1 首轮双审击穿记录）**：

1. **「壳 ≤500 行 + 每聚合 ≤600 行（文件/单一数值口径）」**——被主审 MF-2 击穿：按 §2.1 自身区间算术，RunOrchestration ≈680 行出生即超、壳按文件口径需 700-800（imports 121 + 接口 74 + 常量 60 + 单例 40）。修正为：类体行数口径 + R6 外移单元 + 聚合门槛 ≤700（附算术）。
2. **「record 状态机的唯一所有者（RecordLifecycle）」**——被双审同点击穿：源码写拓扑 RunOrchestration 大量直写 record 字段（backfill/sessionFile/result/error/resumable），字面执行 = R3 夹带改写违反零行为变化、且把 H4 收口偷进 H3。修正为「store 与终态迁移入口的唯一宿主」+ D1 两级归属。
3. **「域 #4 回收面隐含在壳 dispose 编排」**——被双审同点击穿：disposeAllRecords/onParentFork/onParentNew 三个 record 批量关闭方法不在任何聚合清单，留壳破所有者声明、归 RL 漏列。修正为显式归 RecordLifecycle + 壳时序编排。
4. **「最后一步删转发」**——被影响面 MF-3 击穿：字面实施（删壳 public 委托）直接破 D3 消费方零改动（实证外部消费面 25+ 处）。修正为仅删过渡期冗余转发 + 壳终态保留面逐项清单。**v4 再击穿（主审轮 2）**：静态清单仍漏 2 个活消费点（getStreamSink 包外直调 / getSessionRootId SAR 直调）——修正为 R4 删除判据绑定「按 R0 重生成清单」而非静态列表。
5. **「测试随聚合迁移（按文件归位）」**——被影响面 MF-4 击穿：≥10 文件深绑内部结构（运行时字段替换语义依赖/ServiceInternals/spyOn internal），是改写不是搬移。修正为 D6 改写面声明 + R0 深绑清单 + 断言强度不降判据。
