# subagent-workflow 体系问题总登记（剩余未修项）

> **本文件定位**：subagent 体系（`packages/subagent-core` / `packages/subagent-engine-sdk` / `packages/pi-subagent-cli` / `packages/zcode-subagent-cli` / `extensions/universal/subagent-workflow` 及 runtime 投影消费链）的剩余问题、待裁决项与收尾跟踪的**单一登记处**。已修复条目随修复批次移出本文件（追溯 = git log 中 2026-09-29 的 fix(subagent) 快速修复批 commit）。
>
> **来源**：2026-09-29 三轮对抗式架构审查（DDD 与六边形视角，关键发现全部经源码核实）+ 既有分散登记合并。修复优先级：§1 行为级缺陷各自独立可单独修；§2 结构性需 tech-design 排期；§3/§4 为一致性收敛；§5 为裁决输入。

---

## 1. 行为级缺陷（已核实，修复最优先）

### 1.1 resume 复活 run 的时间预算在首次错误重试后静默失效（P1）

证据链三环（2026-09-29 逐一核实）：
- `packages/subagent-core/src/orchestration/resume-run.ts:838-847`：rebuildRunFromRecord 构造的 spec 只含 scriptSource/args/scriptName/scriptPath/model，**结构性不含 budgetTimeMs**（RunSpec.budgetTimeMs 是 readonly 也无法写回）。
- `packages/subagent-core/src/orchestration/worker-message-pump.ts` remainingTimeBudgetMs：`if (!budget || budget <= 0) return undefined` 在查 D10 复活预算账本**之前**提前返回——账本唯一写入方是 resume 链（noteRunResumedBudget 全仓仅 resume-run.ts:571 调用），即账本唯一写入场景恰好是它结构性读不到的场景。
- 后果链：复活 run 带 time 预算 → 任一 worker/script 错误进重试 → rebuildRuntime → RunRuntime.release 清掉 timer → 预算与引擎级超时（lifecycle.ts:283 `maxTimeMs: spec.budgetTimeMs`）双双静默失效。
- 设计决策点：预算权威源放哪（spec 字段 vs 账本唯一化）；remainingTimeBudgetMs 消费顺序；重试重建的 timer 重排挂点；不传 time 的 resume 是否继承原预算。

### 1.2 worktree reconstruct 的 patch 丢失判定在完整重建之后执行，已重建 worktree 泄漏 + 每续轮重复重建

- `packages/subagent-core/src/execution/worktree/worktree-manager.ts`：分支存在性检查最先（:280），patchFile 存在性检查却排在 worktree add / registry.add（:309）/ symlink（:319-325）全部完成之后（:332-335）——该判定只依赖入参路径，完全可以前置。
- 后果：走 degrade-reopen 降级时已重建的 checkout + 注册表条目 + symlink 留存到宿主进程死亡；消费方 conversation-continuation.ts:618 对 degrade-reopen 不接收 handle，下一续轮再进 rebuildWorktreeBinding（:605）→ 每续轮重复全套 git 重建再丢弃。
- 设计决策点：判定前置后 degrade-reopen 语义是否需带「未重建」标记；与 1.3 的 git 元数据清理统一为共享原语。

### 1.3 worktree create() 无 prune-retry，与 reconstruct 不对称——陈旧 git 元数据残留时同 recordId 永久卡死

- create 前置 rmSync 清目录（:176-182）但不清 git 元数据；上次 create 回滚的 `worktree remove` 失败被 bestEffort 吞掉（:221-224）留下 `<repo>/.git/worktrees/<branch>` 陈旧登记后，`worktree add` 报 already registered 恒失败。reconstruct 对同形态有 prune+重试（:296-305），create 没有。
- 关联登记：keepBranch 保留的 pi-sub-* 分支无终局回收（单调累积），回收策略（TTL / 数量上限 / 显式清理）待裁决。

### 1.4 轮终收尾遇 stale extension ctx 崩溃 runtime 进程（P1，间歇性，2026-09-22 登记，2026-09-27 已根治）

- 症状：GUI 派发 subagent，轮终收尾时 runtime 进程 exit 1，当轮 record 丢失、manifest 轮终投影未执行；supervisor 重启循环约 6 分钟。复验 3 轮仅第 1 轮触发。
- 根因（已核实闭环，pi 0.84.4 dist 实装）：pi 官方生命周期契约——session 替换（`newSession`/`fork`/`switchSession`/`reload`）的 `teardownCurrent` 先对扩展发 `session_shutdown`，再调 `session.dispose()` → `runner.invalidate()`，此后旧 pi ExtensionAPI 的所有方法调用一律抛 stale 错（`loader.js` 各方法首行 `assertActive()`；契约原文在 `runner.js` invalidate 默认消息）。缺陷形态：SubagentService 是跨 session 单例，`_pi`（session_start 注入）在 `dispose()` 后残留指向旧 session 的 handle；session 替换窗口内迟到的异步收尾（轮终 `markRoundIdle` 簿记⑧ `emitPendingUnregister` → `pi.events.emit`、迟到 register 的 `appendEntry`）触达 stale handle → 未捕获异常 → 进程崩。间歇性来源：仅「session 替换 × 恰有收尾在飞行中」交叠时触发。
- 修复（根治 = 不在失效对象上调用，commit 32c7db264）：`SessionBaselines.clearSessionHandles()`（单写者）在 dispose 链最末尾（flush 与 pending 落盘复写两步合法 pi 消费之后）回收 `_pi` / `_streamSink`（ctx.ui.setWidget 闭包）/ `_isIdleFn`（ctx.isIdle 闭包）+ `RecordStore.setPi(null)`；消费点全部已有 `pi?.` 空短路 → 迟到写面降级为干净 no-op（旧 session 的通知本就无人消费，丢弃是正确语义）；新 `session_start` 经 `initSession` 重新注入。回归锚：`packages/subagent-core/src/execution/__tests__/subagent-service.test.ts`「dispose 回收 session 句柄：替换窗口内迟到的写面不触达 stale pi」。
- 同族面核查结论：notify-host 其余 emit 面（`emitPendingRegister` 等）与 `appendEntry`/`sendMessage` 消费点全部经 `deps.getPi()` 单点取 handle——句柄回收后全族构造性安全，无需逐点防御（防御性 try/catch 不采用：pi 契约下正确修法是不触达，不是捕获后吞）。
- 证据：`.tmp/dev-flow/b1b2-verify/`（崩溃日志/重启截图）。

### 1.5 resume 档 1 补收丢失结构化调用的对象形态（用户已裁决应修）

- 现状：活体链 schema 调用的 `AgentResult.parsedOutput`（校验后对象）随 agent-settled 帧落 record 流，但 resume 档 1（结果补收）帧只带 `extractAssistantTextContent` 提取的正文文本（resume-run.ts 补收帧构造处无 parsedOutput）；worker 侧回放恒 `parsedOutput ?? content` 优先——schema 调用经档 1 补收后脚本拿到原始 JSON 文本串而非对象，无测试覆盖。
- 裁决语义（2026-09-29 用户定案）：schema 调用的结果必须是对象形态，**没有文本回落选项**；拿不到对象形态就不该判档 1。
- 附带隐患（推断未完全核实）：档 1 判据（classifyResumeTierFromContent）只看「最后一条 assistant 回复完整带正文」，不校验是否通过 schema 验收——崩溃发生在「校验失败轮已落盘、steer 重试未完成」窗口时，可能把未验收文本当结果回放。修复必须一并封住。
- 实现要点（方向 A）：从 pi 会话文件提取 structured-output 工具调用块参数，「工具调用 + 配对成功 toolResult」双证据确认校验通过；拿不到可信对象形态 → 改判档 2 续写重花。补两类测试（对象形态补收 / 未验收不补收）。评估复用 session-reader 已有会话读取能力。
- 出处：workflow-run-resume-revision 设计 §5 检查点 7。影响窗口窄。

---

## 2. 结构性 / 架构问题（需排期，多数走 tech-design 立项）

### 2.1 双 `RunState` 同名异义（同一 run 域两个完全不同的类型）

- `orchestration/models/run-state.ts:25`（status/reason/budget/calls/trace 执行快照形态，WorkflowRun 聚合持有）vs `orchestration/run-events.ts:613`（lifecycle/outcome 状态机两维形态，转移表与 fold 消费）。同包同词两义。旧形态是 v1 兼容层（W4 sunset 范畴），但其头部注释描述的「RunStore.save 触发持久化 / 重启时从 JSONL 重新加载」机制已随 record 单源收敛删除——注释过期。
- 同族实例：`isProcessAlive` 在 pid-file.ts（三态）与 persistence/alive-store.ts（二态）同名异义（已加警示注释，改名待设计批）；`ModelCatalogEntry` 在 core（{provider,id}）与 SDK 协议（{id,aliases?,canonicalRef?}）同名不同形。

### 2.2 run 生命周期状态判定散布约 7 处 + 展示层映射未归并

- 状态表达位置：`WorkflowRun.state.status` 两态（聚合根，v1 兼容层）、`WorkflowRunMeta.interruptedAt` 标记（中断态靠 meta 字段投影表达）、record 事件流 fold 五态 RunState（唯一权威）、DoneReason 五因、RunOutcome 四值、shared `WorkflowRunStatus` 第三份字面量副本、壳 gui-mappers 关键字匹配。映射有单点（doneReasonToRunOutcome）但单点两侧仍是两套词表。
- 展示层同构问题（原 workflow-architecture-backlog G2 并入）：「运行状态 → 展示文案/颜色/图标」映射在 4 个文件至少 6 处独立实现——`interface/format.ts` 内部 3 处（:149/:454/:474）+ `interface/views/detail-content.ts:88` + `interface/gui-mappers.ts:62` + `interface/bg-notify-render.ts:260`。
- gui-mappers 现状：对现行真实输入域（ExecutionStatus 的 running/idle）覆盖正确；4 个潜伏错映射格（created/settling/interrupted/active 都归 done）靠「数据流不流入」兜底，入参裸 string 无类型防线。
- 设计决策点：v1 兼容层退役顺序；内活性状态唯一读口（建议 fold checkpoint 进程内缓存）；DoneReason 是否只活在引擎协议侧；展示映射归并形态。

### 2.3 orchestration ↔ execution 双向循环依赖（19 / 6 文件）

- 6 个 orchestration 文件 import execution（terminal-actions.ts:26-28 一次值 import 5 处），19 个 execution 文件 import orchestration（execution/service/workflow-dispatch.ts:37,48,55 值 import model-catalog/terminal-actions/member-reuse-pool）。终局编排的归属在两域间摇摆；runtime 侧有 NO_SERVICE_CYCLE_CHECK 而 core 内无对应防线。
- 修法方向：先加 core 版循环依赖机器检查止血，再谈拆边（终局编排整体入 orchestration、execution 只暴露 persistence 端口，或反向边收窄到端口）。

### 2.4 领域核心类型反向依赖应用层目录

- `models/ports.ts:13` import `execution/assembly/stream-sink.ts`、`models/types.ts:23` import `execution/assembly/types.ts`——models（领域核心候选）的端口签名依赖 assembly 类型，ports.ts 头部自称「零 infra 依赖（AC-1）」名实不符。
- record 域聚合核心 execution-record.ts 的全部领域类型（ExecutionRecord/ExecutionStatus/Turn 等 20 个）定义在 assembly/types.ts——`assembly/types.ts` 实为跨域公共类型堆积处，领域概念的权威定义位置错位。

### 2.5 壳层（interface/）混入领域规则 + 自带 record 流解析（原 G7 并入）

- `interface/` 22 文件混装命令处理 / 格式化 / GUI 映射 / 工具定义 / TUI 基建多类职责（原 backlog G7）。
- 领域规则实例：`tool-workflow.ts:570-715` D14 resume args 一致性判定（含篡改检测与拒绝文案）完整实现在壳，readHistoricalArgs 自带 record 流 JSONL 解析与 core scanJournalFile 构成双实现——根因是 RunStore 端口只有 save（no-op）/loadAll/stateFilePath 三方法，没有「读 run-created 帧 args」的原语。
- ADR 候选登记：「D14 args 判定刻意放在壳而非 core resumeRun」若无登记将反复被审查质疑；若非刻意即本条修复入口。

### 2.6 进程级 globalThis Symbol 槽 17 键 3 前缀混用（原 G3）

- subagent-core 与壳两包共 17 个唯一 `Symbol.for` 注册键，命名空间前缀 3 种并存（`@zhushanwen/pi-subagents.*` 6 / `@zhushanwen/subagent-core.*` 2 / `@zhushanwen/pi-subagent-workflow.*` 8）。

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

## 3. 双实现与词表镜像（一致性收敛，每处需「单源放哪 + 真差异判别」小设计）

### 3.1 同策略双实现（修一处漏一处即漂移）

1. **manifest 写面检查逃逸**：写面检查 check-record-write-surface R1 只拦七个函数名字面，record-store-rounds.ts:44 经别名 materializeBoundRecordManifest 逃逸，与该文件:75 自己写的「不 import manifest 写函数」注释矛盾；MANIFEST_INDENT_SPACES 双定义（字节格式兼容靠两处都=2）。
2. **eventLog/getFullText 派生规则**：session-reconstructor.ts:229-255 对 execution-record.ts:518-540 逐字节复制（含 TURN_SUMMARY_MAX=80 常量副本）——注释自称「避免循环依赖」，实测反向 import 无环，理由不成立；磁盘重建路径走副本。
3. **seq journal 基座**：record 域 FileRecordEventJournal.append 与 run 域 FileRunEventJournal.append 各约 90 行 95% 同文，真差异仅 header 行契约与无 seq 存量行兼容两点——可合并为泛型基座。
4. **updateFromEvent 双 reducer**：core 活体 reducer（execution-record.ts:451）vs SDK 重放 reducer（journal-replay.ts:321）——「重放与 live 共用同一 reducer」的设计已退化为两份，靠 conformance 行为断言防漂移。
5. **binding 载荷双构造**：run-orchestration.ts:431-453 手写 15 字段 vs terminal.ts:452-476 fullBindingPayload 人肉同步——两处注释同时记录了历史上两次补字段漏拷贝事故。
6. **collectPatch 接线双份**：finalize-record.ts:124-137 vs record-lifecycle.ts:337-352（注释自称「同款」）。

### 3.2 record 流严格读面双实现（branch-review R1 条 2 并入）

- core readRecordStreamStrict / rebuildRunFromRecord（resume-run.ts）vs 壳 readRecordStream / foldRecordStreamToRun（jsonl-run-store.ts:193/:434），严格度有意分化（core 多 seq 断档检测）；壳另持 parseLegacyArgsSummary 与 core 私有 parseArgsSummary 函数级镜像。
- 修法 = 坏行判定规则从 barrel 导出为共享校验原语，或登记分层契约 + parity 测试。

### 3.3 「v1 停写」前提被纠偏链打破（数据正确性窗口，建议优先裁决）

- 主链已全写 v2 小条目，但孤儿纠偏路径 reportSubagentRecord（record-store.ts:1235 → toSubagentRecordEntry 恒 v:1，调用点 :1299/:1374）**仍在写 v1 全量快照**；叠加 runtime journal-projection 的 v1 冻结定界优先仲裁（:595 `if (subagents.has(id)) continue`），同 id 的纠偏 v1 快照会遮蔽 v2 fold 投影（事件流事实源被投影遮蔽，方向反了）。触发场景窄（崩溃于轮中 + 纠偏触发）。
- 裁决点：纠偏链改写 v2 小条目（对齐介质归位终态，需确认纠偏场景 v2 注册条目必在场）vs 仲裁反转（v2 fold 优先、v1 只做无 v2 兜底，需补对账测试）。

---

## 4. record 域轮次轴 CAS 缺口

- 「意图原语即状态机（CAS 拒绝表外转移）」在轮次轴不成立：markRoundIdle 唯一保护是 endedAt 终态检查（rounds.ts:190），无 status CAS（错误信息自认「调用方负责 gate」）；markRoundStarted（:132-138）对 running 中的 record 静默清在途轮数据。对照 markReopened（CAS+回滚，terminal.ts:377-425）是全库参照形态。
- 设计决策点：CAS 拒绝语义（抛错 vs 幂等返回 false）；三个生产调用链（finalize-record / run-orchestration / record-lifecycle）是否都保证前置 status==="running" 需逐一核实——可能有调用方依赖「重复调用幂等」现状，补 CAS 会把静默变抛错。

---

## 5. 待裁决项

### 5.1 无主 run 对账清理的持续损坏计数封顶

- reapOrphanRuns（workflow-run-resume-revision 裁决点 7）登记文件 `orphan-run-reap.json` 承载 7 天宽限窗：一次性损坏自愈；**持续损坏**（每轮读/写都坏，如磁盘坏道）才宽限窗反复重起 = 孤儿永不删除。
- 待裁决：是否加「持续损坏计数封顶」（超阈值改告警/强制删除/人工介入）；反方向同样成立——极低频形态 + 原子写已消除主成因，加封顶可能属重复保险式过度工程。
- 出处：`.tmp/tech-design/workflow-run-resume-revision/round-3/dispositions.json` D-3-3。

### 5.2 zcode 宿主 run 双源收敛议题（实际等需求出现再裁）

- run record 单源收敛只在 pi 壳侧落地；core 侧 FileRunStore 已随 commit bd5750b70 退役删除（读侧收敛到 run-state-evidence.ts 证据核）。议题变为纯裁决：zcode 宿主未来出现 workflow 编排需求时，run 态持久化是否直接采用 pi 壳同款 record 单源形态。zcode 引擎现无编排链，议题挂起。

### 5.3 workflow resume scriptPath 锚定——关闭形态取舍

- 候选 A 已实施（run-created 帧携带可选 scriptPath，双侧恢复 + 六模板检查收紧；record-mode 回归网 A2/A4 用例通过，commit a32df2905）。真机复跑 run3 证据：帧正确携带、fold 完整走完 15 帧、无 Cannot find module _shared——但剧本被环境类缺陷（Provider Registry，见 §6.2）阻断在 kill/resume 阶段前。
- 待裁决：A = 接受「修复实现 + 确定性回归 + 真机写入侧」三重验证作为关闭判据（推荐）；B = 等 §6.2 修复后重跑真机拿全绿再关闭。
- 内置模板 scriptPath 缺席即 throw 是防注入安全设计（回退 process.cwd() 会打开用户目录误加载通道），修复不改变该语义。

### 5.4 args 撞名防御只盖一个入口

- 闸 4 词表（script-generate.ts:46-67 WORKER_IIFE_HOST_DECLARED_NAMES，20 名与模板 IIFE 作用域精确一致）只在 AI 生成工具路径（tool-workflow-script.ts:242）生效；手工编写/入库的 workflow 脚本顶层 `const/let/var args` 依然运行时 SyntaxError → 三次重试全灭，失败形态远离根因。
- 待裁决：防御扩大到 resume/run 入口统一检查 vs 接受现状。

---

## 6. 已实施待验证（收尾跟踪）

### 6.1 notify stale ctx 崩溃（见 §1.4）——已根治（commit 32c7db264，根因/修复/回归锚见 §1.4）

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

---

## 8. 未覆盖次级区域（继续挖的候选，边际收益低）

orchestration 外围工具文件（member-reuse-pool / agent-opts-resolver / workflow-files / skill-discovery / config-loader）、assembly 剩余（concurrency-pool / cold-lookup / channel-registry-access 等）、两引擎包 spawn 链逐行细节（spawn-run-pump 事件转换、zcode parser/session-channel）、壳 views/TUI 组件内部。测试域 2026-09-27 刚做过全量审计，有意跳过。
