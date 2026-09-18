# Subagent 引擎开发指南（契约面 + 评估 checklist）

> **状态**：⛔ 骨架（skeleton）——章节结构与已核实锚点就位，各节正文待填。锚点为本指南登记的事实锚（HEAD `a24aeca95` 时点核实），填肉时逐条复核。
> **定位**：面向**引擎作者与引擎改造评估者**的契约义务清单——「对接/开发/改造一个 subagent 引擎要实现什么、声明什么、验收什么」。回答「是什么 + 怎么评」；「这套体系由什么组成、机制落在哪」由 [architecture.md](architecture.md)（现状 SSOT 导航页）承载，本指南不重复。
> **读者/读取时机**：新引擎接入或既有引擎改造的 tech-design 设计期（评估 checklist 输入）、dev-flow 实施期（义务对照）、CR（契约面核对）。
> **断言分级**：反引号内符号 = 现行代码引用（受 doc-symbol-drift 守卫口径约束）；⛔ = 未核实/待补；本会话（2026-09-18 四设计八审查）三重核实过的锚点标 ✅。
> **更新触发（同 commit 义务）**：engine-protocol 版本、capability 枚举值、错误码词表、引擎生命周期语义（轮终/abort/timer/接管点）、SessionView 契约任一变更 → 本指南对应节必须同批更新（登记于根 AGENTS.md 主题索引；机器守卫见 §12）。

## 0. 使用方式

- **新引擎接入**：从 §13 checklist 走，逐条回链 §1-§11 义务节。
- **既有引擎改造**（加能力/换通道/动生命周期）：从 §14 checklist 走——先查 §3 能力位与 §12 映射表确定波及面，再对照义务节评估。
- 两类入口的共同前置：读 [architecture.md](architecture.md) §1 包拓扑与 §3 协议面（本指南只列义务细节，不重复拓扑）。

## 1. 引擎准入形态

**要写的内容**：独立子进程形态约束、依赖红线（引擎包只依赖 SDK 不依赖 core——[architecture.md](architecture.md) §2.3）、引擎 manifest 与发现装载链（`engine-discovery*.ts` → `registry.ts` → `routing.ts`，core 壳侧零内建引擎）、包命名与 `taiji.role` 分组约束（见 [extension-conventions.md](../extension-conventions.md)）。

已核实锚点：
- ✅ 引擎与宿主唯一跨进程边界 = engine-protocol v1 NDJSON stdio（architecture.md §1）。
- ⛔ manifest 必填字段与 `engine-inspect-package.ts` 校验项——待从 `engine-manifest.ts` / `engine-inspect-package.ts` 提取。

## 2. 协议实现义务（engine-protocol v1）

**要写的内容**：正向 9 方法（`initialize` / `probe` / `run` / `cancel` / `read` / `listModels` / `validateModel` / `dispose` / `ping`，`packages/subagent-engine-sdk/src/protocol/methods.ts`）逐方法语义——每个方法写清：调用时机、时序约束、超时分级（控制面单请求秒级 vs 任务级无墙钟，见全局超时默认原则）、幂等性、失败形态。反向通道 6 条及用途。conformance 套件锁定面。

已核实锚点：
- ✅ 方法清单与反向通道数（architecture.md §3；`host/permission` 已退役、`host/poolResolved` 已删）。
- ✅ chat 域独立协议面已退役：续聊轮 = 新 run + `RunParams.resume` 锚点（约束 C-proc-13）。
- ⛔ 逐方法语义表——待从 `protocol/frames.ts` + `protocol/engine-protocol.ts` + 两引擎实装对照提取（probe 超时秒级、run 无墙钟等语义需逐方法落）。

## 3. capabilities 声明契约

**要写的内容**：能力位全集与值语义；声明点（引擎类 + 引擎包 `package.json` `subagentEngine.capabilities` **两处镜像必须同批**）；消费方分支判据；升降位的裁决条件（何时允许改声明）。

已核实锚点：
- ✅ 枚举合法值：`conversation` 含 `cold`/`native`（`packages/subagent-engine-sdk/src/protocol/contract-types.ts:208`/:217 一带，r2 主审逐键）。
- ✅ 声明镜像点：`packages/zcode-subagent-cli/src/zcode-engine.ts:190`（`conversation`）/:200（`resume`）+ zcode `package.json` capabilities 块。
- ✅ 消费判据：按 `!== "unsupported"` 分支放行（`chat-rounds.ts:737`、`capability-gate.ts:144-150`）——升位不破坏消费方，但声明与实装错位会被 CR 追责（wave1 R2 整项即修此类错位）。
- ✅ gate 的声明一致性 warn（`capability-gate.ts:34`）；`steer: "unsupported"` 注释语义在「轮终后 send」方案下仍准确（zcode-engine.ts:184-185）。
- ✅ 升降位裁决先例：zcode `schemaEnforcement` 维持 `emulated` 不升 `native`——位语义未满足升位会误导宿主按 native 假设分流（设计 4 D4）；capability 头注必须与声明同批改写（设计 3 D9b 四处注释清扫清单）。

## 4. 错误码与恢复指引契约

**要写的内容**：两层词表分工（SDK 协议码 vs 宿主词表码）；引擎新增错误码的登记义务；错误消息可操作性要求（错误 → 权威源 → 重试闭环）。

已核实锚点：
- ✅ 宿主词表：`ENGINE_ERROR_CODES` 封闭枚举（`packages/subagent-core/src/execution/engine/common/errors.ts:20-33`）+ `DEFAULT_RECOVERY_HINTS` Record 全集覆盖（:77 一带）——**漏登记编译失败**（机器守卫，指南引用不复制清单）。
- ✅ SDK 协议码：`ENGINE_PROTOCOL_ERROR_CODES` 仅 `engine_*` 前缀（`packages/subagent-engine-sdk/src/protocol/error-codes.ts:23-33`，protocol.test.ts 封闭断言）+ 透传码前缀判定（:48-52）——引擎侧合成码（如 `schema_emulation_failed`，zcode-engine.ts:882 形态）**不进** SDK 词表，由引擎自管 + 宿主枚举登记。
- ⛔ 现行错误码全集一览——待从 errors.ts 提取（一表：码 → 语义 → 恢复指引要点）。

## 5. run.params 与 ctx 载体

**要写的内容**：`RunParams` / `RunContextParams` 字段义务（`taskId` / `recordId` / `sessionRootId` / `resume` 锚 / `task.schema` / `ctx.schemaEnv`）；引擎的重写义务（relay 身份键 env 重写、不靠 env 继承）；engine-aware 的参数分流点。

已核实锚点：
- ✅ ctx 字段与 relay 身份键权威源（architecture.md §3，F6）。
- ✅ `resume` 锚形态 = `engineHandle.sessionRef {sessionId, dbPath}`（设计 3 §2.1）；引擎按锚分派 create/resume（zcode-engine.ts:296-328 形态）。
- ✅ schema 双通道在 wire 上就位：`task.schema`（对象）+ `ctx.schemaEnv`（pi 专用 env 载体，zcode 不消费）——引擎中立原则：resolver 产出双通道，引擎自选消费（设计 4 D9）。
- ⛔ 字段全集与必选/可选矩阵——待从 `contract-types.ts` 提取。

## 6. 事件族与投影义务

**要写的内容**：事件类型全集（AgentEvent 族）；引擎产生事件的上游实名对照（教训：taiji SDK 命名 ≠ 引擎上游实名——SDK `tool_end`（`contract-types.ts:110-111`）vs zcode bundle `tool.updated` 两变体）；journal 落盘义务与 `activity` 豁免；投影决策义务（新事件类型是否向 `ctx.onEvent` 投影需显式声明消费方面）。

已核实锚点：
- ✅ SDK 事件面：`tool_start`/`tool_end` 携带 args（contract-types.ts:110-111）。
- ✅ journal 义务：先落盘再转发、`activity` 豁免不破坏 live≡reload、seq 无空洞（`journal-wiring.ts:60-87`，双侧 reducer no-op 论证在注释）。
- ✅ 反例沉淀：引擎层内部提取不投影 → journal/SessionView/workflow trace 三消费方零新增面；若投影须补 apply-entry-equivalence 用例（设计 4 M2 投影决策）。
- ⛔ 事件类型全集表——待从 `shared/agent-event.ts` + contract-types 提取。

## 7. 生命周期与接管点义务

**要写的内容**：轮终语义（终态 → read 兜底 → close 的时序与「循环必须在 close 前」约束）；abort/取消链（grace 窗、killChain 连坐语义、`interrupted` 不在失败终态）；timer 语义（idle/ceiling 双 timer 挂载点、以 run 边界为界）；**接管点副作用复刻义务**（宿主在 create/resume 确立点的回调时点，引擎必须保证回调发生——漏登记的竞态后果写明）。

已核实锚点：
- ✅ runTurn finally 无条件 `closeSession`（`session-channel.ts:791-794`）；双 timer 挂载（:838-860）。
- ✅ abort 链：`onAbort` → `appServerAbortChain`（zcode-engine.ts:495-501）；grace 窗 3s（`constants.ts:158` `ZCODE_APPSERVER_ABORT_GRACE_MS`）；超窗 killChain 收割共享进程（:598-606，「接受连坐」注释）；`interrupted` 不在 `isFailedTerminalStatus`（:1402-1403 注释）。
- ✅ 接管点：`onSessionCreated`（:475-484）承载 `rt.activeSessions.add`（TTL sweep 豁免集 + dispose close-fire 目标集，:709-718 全仓唯一调用点）与 `onHandleReady` 回传——**resume/续轮形态必须在装载确认时点复刻**，漏登记 = 高龄条目在整轮在途期间可被 TTL sweep 删除（设计 3 D8 实装推演）。
- ✅ 锚回传：`backfillRoundHandle` 整替语义 + 同值幂等；journal 终态路径 `backfillHandle`（journal-wiring.ts:83-86）。
- ⛔ 逐时序图——待画（create 轮 / resume 轮 / 闸门续轮三条泳道）。

## 8. 读取与 SessionView 投影义务

**要写的内容**：①级原生读义务（`read` 方法 → SessionView）；三级降级链（①native → ②journal 重放 → ③outcome-only）与 `source` 字段语义；usage/contextTokens 字段语义边界（消费累计 vs 窗口占用——混用的后果：系统性高估）。

已核实锚点：
- ✅ SessionView 契约：`engineId/sessionId?/turns/usage?/source`（`contract-types.ts:174-182`）；usage = 各 turn usageDelta 聚合（消费累计，非窗口占用）。
- ✅ zcode 读取链：`readZcodeSessionView`（`reader.ts:342` 一带，三级 JOIN 按会话全量读）；`usageFromStepFinish` 只填 input/output/cacheRead/cacheWrite（:107-117）；`contextTokens` 取 `projection.contextUsed`（`parser.ts:68`，run 应答链，窗口占用语义）。
- ✅ 已知投影形态须写进验收防误报：中间轮 user 消息不进 `turns`（reader 只取 assistant 视角）、usage 聚合挂末 turn（`session-view-service.ts:305-310`）（设计 3 D9 两点）。

## 9. env 与数据目录契约

**要写的内容**：子进程 env 出站契约（C-proc-09 `buildOutboundChildEnv` + deny 清单，守卫 `.githooks/check_spawn_env_boundary.py`）；入站准入 `ENV_WHITELIST_PREFIXES`（SSOT = `packages/shared/src/constants.ts`）；引擎数据目录布局（`getEngineDataDir()` 下 `engines/<id>/`：journal `shared/`、会话库隔离模式、脚本/缓存目录的登记义务——新增写入面须显式登记清理通道或登记「无清理可接受」）；路径动态推导红线（禁硬编码，pre-commit 路径白名单检查）。

已核实锚点：
- ✅ journal 固定 `engines/<id>/shared/`（池抽象降级后 SDK `SHARED_POOL_KEY`，architecture.md §4）；30 天 mtime TTL 回收 = journal 唯一清理机制（`pool-manager.ts` `cleanupExpiredJournals`）。
- ✅ 会话库隔离模式先例：`ZCODE_SESSION_DB_PATH` 覆写 + 别名键清空 + 路径单一来源（约束 C-ext-20 / [zcode-session-db-isolation.md](../../architecture/zcode-session-db-isolation.md)）；隔离条目 TTL sweep 引擎侧（C-data-22，zcode-engine.ts:709-718）。
- ✅ 新写入面登记先例：`mcp/` 脚本目录「单文件恒覆盖、无累积——无清理通道判定可接受」的显式登记形态（设计 4 D1）；schema 经 env 传的尺寸上限先例 `SCHEMA_ENV_MAX_BYTES = 256KiB`（`pi-subagent-cli/src/constants.ts:24`，`spawn-args.ts:82-95` fail-fast）。

## 10. 可靠性模式库（降级与可观测）

**要写的内容**：引擎改造反复用到的裁决模式沉淀——设计 3/4 审查中三轮打磨过的形态，新设计对照取用，不再重新发明：

- **降级链族分层**：按失败通道分层定义降级形态（同通道同失败 = 前缀/数据必缺席，不得假设「降级仍可用全量」）；每族给标记值（`degradedReason` 标量字段、随轮覆写、允许冷重建丢）。
- **族差分级告警**：最差形态单次即 error、较轻形态 warn；**不设跨任务连续性计数器**（Worker Thread 多实例无全序语义 + 夹成功清零语义空洞——两次三段论证裁决，native-resume D6 / 设计 4 D8）；常态化信号 = 标记/日志持续出现（日志检索判）。
- **瞬态防护**：幂等 RPC 失败先一次快速重试（限同进程代内）再落最差形态。
- **宽限窗**：异步注册/就绪观察给显式窗口（防竞态误降级），窗长挂探针定型。
- **溢流阀声明**：必然到达态（如上下文耗尽）按「设计内行为」显式声明 + 锯齿形态描述（锚换钉机制下非永久降级）+ 重审条件（量化阈值 + 数据源 + 误差方向）。
- **探针声明纪律**：运行时行为断言 ✅（设计期探针）/ ⛔（实施期探针）逐条分级，⛔ 项必须带回退链。

已核实锚点：✅ 上述全部模式在 zcode-native-resume.md 与 zcode-schema-enforcement.md（.tmp 工作流产物）定型并经三轮审查收敛——落指南时以本节为唯一承载（.tmp 文档不入库），逐模式补仓库内实例引用。

## 11. 验收基线

**要写的内容**：引擎改动的测试分层要求（单测 fake fixture / 真机场景分工——真实 LLM 轮次按改动面空载串行，禁全量扫跑）；go/no-go 探针先行的强制形态（「外部系统对接先验证再编码」）；真机场景通过标准写法（可证伪 + 已知投影形态写进标准防误报）；Electron 形态复验义务（本地 CLI 探针 execPath 是真 node，生产是 `process.execPath + ELECTRON_RUN_AS_NODE=1`——`interfaces.ts:31` / `worker-host.ts:21` ✅）。

## 12. 契约面 → 守卫与资产映射表

**要写的内容**：本指南的更新对账表——每节列出：权威源（源码模块）、机器守卫（现有守卫 + 待建守卫）、关联文档。填肉后据此表在 `scripts/check-doc-symbol-drift.mjs` 的 `DOC_MODULE_MAP` 登记本指南的映射模块（按实际引用符号逐模块登记，守卫宁缺勿滥）。

| 节 | 权威源 | 机器守卫（现状） | 关联文档 |
|---|---|---|---|
| §2 协议 | `subagent-engine-sdk/src/protocol/` | protocol.test.ts 封闭断言 | architecture.md §3、C-proc-13 |
| §3 capabilities | `contract-types.ts` + 两引擎声明点 | 枚举编译校验 | C-ext-20、wave1 R2 |
| §4 错误码 | `errors.ts` + SDK error-codes.ts | **封闭枚举 + Record 全集编译强制** | — |
| §5-§7 run/事件/生命周期 | `contract-types.ts` + `session-channel.ts` + 引擎包 | conformance 套件 | C-proc-09/13、crash-forensics 附录 E |
| §8 读取投影 | `reader.ts` + `contract-types.ts` | — | C-data-20/22 |
| §9 env/目录 | `constants.ts`（shared）+ `data-dir.ts` | check_spawn_env_boundary.py、路径白名单 | env-propagation-boundary.md |
| ⛔ 待建 | 本指南枚举/词表表 ↔ 源码投影 diff（先例：CSS token SSOT check） | — | — |

## 13. 新引擎接入 checklist（骨架）

1. 读 architecture.md §1-§3（拓扑 + 协议面）→ 2. 按 §1 准入形态建包（依赖红线）→ 3. 按 §2 实现 9 方法 + 反向通道（conformance 过）→ 4. 按 §3 声明 capabilities（两镜像）→ 5. 按 §4 登记错误码 → 6. 按 §5-§9 落 params/事件/生命周期/读取/env 义务 → 7. 按 §11 产出验收计划（探针先行）→ 8. 上游引擎（pi/zcode 之外）对接另加：上游语义断言单点登记（先例 C-pi-12）。

## 14. 既有引擎改造评估 checklist（骨架）

1. 定位改动面在 §12 映射表的节 → 2. §3 查能力位是否需升/降位（裁决条件对照）→ 3. §7 查生命周期时序约束（close/abort/timer/接管点四族）→ 4. §10 查可靠性模式（降级/告警/探针声明套用）→ 5. §12 列文档同步面（登记资产同 commit 更新）→ 6. §11 产出验收挂钩。
