# Subagents 架构（现状 SSOT）

> **本文件定位**：subagent 体系的**结构导航页**——回答「这套能力现在由哪些包组成、各包边界在哪、关键机制落在哪个模块」，并指向各主题的权威文档。机制细节不在本文件展开（避免与设计文档双源漂移）。
>
> **最后校准**：2026-09-11（对照当时的源码结构与 package 拓扑逐项核实）。
> **历史**：本文件此前描述的是 M0 拆分前的**单包三层实现**（TUI / Runtime / Core 全在 extension 内，`session-runner.ts` / `session-factory.ts` / `executor` 等文件）。那些结构已随 core 抽包、引擎协议化、双轨收敛退役，对应实现迁至 `packages/subagent-core` 与两个引擎包（见 §7 历史沿革）。

---

## 1. 包拓扑

subagent 能力现由 5 类包协作，跨进程边界只有一处（宿主 ↔ 引擎，走 engine-protocol v1 NDJSON stdio）。

```
┌───────────────────────────────────────────────────────────────────────┐
│ shell（宿主进程内）                                                     │
│  extensions/universal/subagent-workflow   @zhushanwen/pi-subagent-workflow │
│   - 工具面 / 命令 / TUI 渲染 / injectors / 宿主端口实现 / relay.mjs 代理  │
└──────────────────────────────┬────────────────────────────────────────┘
                               │ 经 core barrel（semver 契约面）消费
┌──────────────────────────────▼────────────────────────────────────────┐
│ host core（宿主进程内）                                                 │
│  packages/subagent-core                @zhushanwen/subagent-core        │
│   - execution/（执行·记录·通知域 + 引擎子域）                            │
│   - orchestration/（workflow 域：脚本生成/校验/worker/运行存储）          │
│   - core/（宿主端口）+ shared/（零依赖原语）                             │
│   - 通过 HostServices 端口反向依赖宿主（禁 pi SDK：闭包红线）             │
└──────────────────────────────┬────────────────────────────────────────┘
                               │ 同一份契约（SDK）
┌──────────────────────────────▼────────────────────────────────────────┐
│ engine（独立子进程）                                                    │
│  packages/pi-subagent-cli      @zhushanwen/pi-subagent-cli              │
│  packages/zcode-subagent-cli   @zhushanwen/zcode-subagent-cli           │
│   - 协议 server + 引擎适配（pi：spawn pi 子进程；zcode：app-server RPC） │
└──────────────────────────────┬────────────────────────────────────────┘
                               │ 协议 + 契约类型闭包
┌──────────────────────────────▼────────────────────────────────────────┐
│ contract                                                               │
│  packages/subagent-engine-sdk  @zhushanwen/subagent-engine-sdk          │
│   - protocol/（方法/载荷/反向通道）+ port-contract + env/spawn/relay/    │
│     journal/kill-chain/nesting-guard/ui-* + node-executor + paths       │
└────────────────────────────────────────────────────────────────────────┘
        ▲
        │ 宿主侧 relay 通道（tee 帧归属）
   packages/runtime/src/infra/relay/（relay-env / relay-paths / relay-registry / relay-server / relay-tee）
```

## 2. 各包职责与关键模块

### 2.1 shell — `extensions/universal/subagent-workflow`

宿主进程内的薄壳。**不含执行运行时**（已迁 core），职责 = 注册面 + 宿主适配 + 渲染。

| 路径 | 职责 |
|---|---|
| `src/index.ts` | 组合根（装配点）：注册 3 tool + 2 command + messageRenderer + `pi.__workflowRun` + session 事件；接线 core 宿主端口（`configureCore` / `configureNotifyDomain`） |
| `src/session-lifecycle.ts` | 会话生命周期装配 seam（bootstrap seam）：让测试注入 fake 依赖验证装配行为，不必挂载整个组合根 |
| `src/host/pi-host.ts` | pi 宿主端口实现（`HostServices` 的 pi 侧兑现），核心抽包时的宿主契约落点 |
| `src/injectors/` | 提示注入器：engine-awareness / model-list / resource-list / subagent-list / workflow-list |
| `src/interface/` | 注册胶水与展示：`subagent-tool` / `tool-workflow-script` / `commands` / `list-view` / `tool-render` / `bg-notify-render` / `gui-mappers` / `subagent-actions` |
| `src/jsonl-run-store.ts` | workflow 运行存储（RunStore 端口的 JSONL 落盘实现） |
| `relay/relay.mjs` | 零依赖代理脚本（tee 子进程 stdout/stderr）；常量内嵌镜像，与 SDK 单源一致性由 conformance 断言锁定 |

### 2.2 host core — `packages/subagent-core`

宿主侧执行/记录/通知/编排的全部运行时。消费契约 = `src/index.ts` 的 barrel（D5 定稿：exports 面即 semver 契约，收窄不放宽）。

| 子域 | 内容 |
|---|---|
| `src/execution/` | 执行域主体：`subagent-service.ts`（装配壳）+ `service/`（六聚合：`session-baselines` / `sync-collect-domain` / `record-lifecycle` / `record-access` / `workflow-dispatch` / `run-orchestration` + `service-bootstrap`）、`conversation-continuation.ts`（chat→run 统一，H1 唯一新增组件）、`subprocess-agent-runner.ts`（workflow 域 run 入口）、`record-store.ts`（内存 + 磁盘重建容器）、`execution-record.ts`（唯一状态对象与 CAS）、`concurrency-pool.ts`（background 并发与优先级排队）、`state-marker.ts` / `alive-store.ts`（终态与探活 sidecar）、`lifecycle-manager.ts`（idle timer）、`settled-watchdog.ts`（轮次活性守护）、`notifier.ts` / `notify-ledger.ts`（确认式送达）、`worktree-manager.ts` / `worktree-git-ops.ts` / `worktree-registry.ts`（worktree 隔离）、`manifest-store.ts` / `sessions-index.ts` / `session-reconstructor.ts` / `session-file-gc.ts` / `idle-gc.ts`（持久化与回收）、`dialog-queue.ts` / `ui-request-handler-factory.ts`（反向 UI 通道） |
| `src/execution/engine/` | 引擎接入面：发现（`engine-discovery-roots` / `engine-discovery-scan` / `engine-inspect-package` / `engine-manifest`）、注册与路由（`registry` / `routing` / `types` / `port`）、`client/`（`client-options` / `engine-client` / `mirror` / `pid-file` / `reaper` / `remote-engine` 协议客户端 / `reverse-router`）、`common/`（`capability-gate` / `event-journal` / `journal-wiring` / `journal-replay` / `kill-chain` / `nesting-guard` / `pool-manager` / `persona-router` / `session-view-*` / `data-dir`）、`host/`（`host-bridge` / `host-ui-endpoint` / `pi-host-binding` / `spawned-children`） |
| `src/execution/round-supervisor/` | 轮次监督器：看门狗与待决重认领（`supervisor` / `service-binding` / `notify-accounting` / `reconcile-sweep`） |
| `src/orchestration/` | workflow 域：脚本生成与校验（`script-generate` / `script-lint` / `args-validator` / `workflow-files`）、执行（`execute-agent-call` / `launcher` / `lifecycle`）、worker（`worker-host` / `worker-script-builder` / `worker-message-pump`）、运行存储与快照（`file-run-store` / `run-snapshot`）、资源发现（`skill-discovery` / `config-loader` / `agent-opts-resolver`） |
| `src/core/` | 宿主端口与日志（`host-services` / `notify-ports` / `logger` / `error-message`） |
| `src/shared/` | 零依赖原语（`agent-event` / `atomic-write` / `injection-render` / `timer-delay` / `schema-jsonify` / `resource-discovery` 等） |

外部消费者形态：workspace 走 TS 源码，npm 走 dist（ESM + CJS 双形态）——细节见 `package.json` 的 `exports` 与 D5 说明。

### 2.3 engine — `packages/pi-subagent-cli` / `packages/zcode-subagent-cli`

两个独立引擎进程，各自实现同一份 engine-protocol v1 契约：

- **pi 引擎**：spawn `pi` 子进程（RPC 模式），stdout pump 解析事件、握手取 session 身份、relay 身份键注入；`base-tool-enhance` 等扩展负责子进程侧行为。
- **zcode 引擎**：只走 app-server RPC（禁 CLI spawn 链，约束 C-ext-20），共享宿主 HOME，会话库隔离到独立 sqlite（不进 GUI 侧边栏）。

两包均只依赖 SDK（不依赖 core），保证引擎侧无宿主耦合。

### 2.4 contract — `packages/subagent-engine-sdk`

跨进程契约与两侧共用的零依赖原语。协议面按「可序列化」收窄（`protocol/` 子入口），进程内类型与端口契约走主 barrel。

## 3. 协议面（engine-protocol v1）

正向方法恰好 9 个（`packages/subagent-engine-sdk/src/protocol/methods.ts`）：

`initialize` · `probe` · `run` · `cancel` · `read` · `listModels` · `validateModel` · `dispose` · `ping`

反向通道（引擎 → 宿主）覆盖进度与交互：`host/streamDelta`（增量文本）、`host/askUser`（UI 请求）、`host/childSpawned`（子进程注册）、`host/childStateChanged`（任务子进程生命周期上报，C-pi-16）等。chat 域独立协议面（原第 9 通道 `host/roundLifecycle` 与 `interact` 方法）已随 H1（[subagent-chat-run-unification.md](../../design/subagent-chat-run-unification.md)）退役：续聊轮 = 新 run + resume 锚点（`RunParams.resume`），轮活性经 run 事件通道既有事件（含 `activity` 变体）与 run 终态应答承载（约束 C-proc-13，authority 已改挂该设计）。

`run` 的上下文（`RunContextParams`）承载每次运行的定位信息：`taskId` / `poolKey` / `recordId` / `sessionRootId`（relay 身份键权威源，见 F6 修复）等——引擎据它重写子进程的 relay 身份 env，不靠 env 继承。

## 4. 关键机制（落点索引）

| 机制 | 落点 | 说明 |
|---|---|---|
| 状态单一真源 | `execution-record.ts` + `record-store.ts` | 内存 record 与 `session.jsonl` 磁盘重建两条通路共用同一 reducer；对外状态两态（`active` / `ended`） |
| 终态标记 | `state-marker.ts` | 单一 `<session>.state` sidecar（`{status, reason?, endedAt?}`）标记 finalized / cancelled；旧名 `.finalized` / `.cancelled` 只读兼容；record 绑定 sidecar `<session>.record-binding`（UF-1：id→file + rootSessionId，跨重启续聊数据源）同挂本载体族 |
| 进程探活 | `alive-store.ts` | `.alive`（pid + 启动时刻）探活面——写者未随 H1 消亡：随 U6 从 cold-resurrect.ts 改名迁入 cold-lookup.ts，resurrect 回边（跨重启续聊活链）仍调 `writeAliveMarker`（`cold-lookup.ts:157`，把 `.alive` 刷新为当前进程以翻回磁盘活态）——非零写者；[subagent-record-persistence-consolidation.md](../../design/subagent-record-persistence-consolidation.md) D3 的「零写者后删除」清理执行前须先处置该写点 |
| chat→run 统一 | `conversation-continuation.ts` | ConversationContinuation = H1 chat→run 统一唯一新增组件（每 chatMode record 一个实例）：`onMessage` 状态迁移（终态 guard 分流 / 在途轮 abort 入队 / 空则派发）、`dispatchRound` 每轮派发（载荷组装 + 轮活性守护挂载 + 经泛化主干发起 run）、`onRunSettled` 轮末收口（doFinalizeRoundToIdle + 通知门路由）；[subagent-chat-run-unification.md](../../design/subagent-chat-run-unification.md) §3.4 |
| 空闲回收 | `lifecycle-manager.ts` | per-record idle timer——chat 域长驻消亡后 arm 面（armChatIdleTimer）随 H1 退役，仅存 disarm 防误杀与超时回落常量（`XYZ_SUBAGENT_IDLE_TIMEOUT_MS`） |
| 楔死回收 | `settled-watchdog.ts` | settled 永不到达的两段式守护：中段无进展检测（刷新源 = run 事件通道既有事件）+ 收尾段固定上界（交棒 = run 应答驱动）；run 域（含 chatMode 续聊轮）与 workflow 域共用同一原语 |
| 引擎装载 | `engine/engine-discovery*.ts` → `registry.ts` → `routing.ts` | 三级发现装载 cli descriptor；core 壳侧零内建引擎（`pi` 亦经发现装载） |
| 协议客户端 | `engine/client/remote-engine.ts` + `engine-client.ts` | 宿主侧唯一协议适配点：帧编解码、能力门、反向路由、句柄镜像 |
| journal | `engine/common/event-journal.ts` + `journal-wiring.ts` | 事件落盘（②级数据源）；池 key 占位 + `onPoolResolved` retarget，路径与 handle 声明同源 |
| relay 通道 | shell `relay/relay.mjs` + `runtime/src/infra/relay/` | 代理脚本 tee 子进程输出；父身份键（SESSION_ID / RECORD_ID）由引擎按 `run.params.ctx` 重写，防误归属 |
| 结果通知 | `notifier.ts` + `notify-ledger.ts` | 结果语义通知必须走确认式送达（持久账本 + 幂等键），约束 C-ext-19 |
| 反向 UI | `dialog-queue.ts` + `ui-request-handler-factory.ts` + `host/host-ui-endpoint.ts` | 引擎 `host/askUser` → 宿主 UI 请求队列 → 应答回传 |
| worktree 隔离 | `worktree-manager.ts` / `worktree-git-ops.ts` | 子 agent 在 worktree 内改动，收尾回传 patch |

## 5. 测试与验证

- 单元/集成测试按包分布：`packages/subagent-core/src/**/__tests__/`、两个引擎包的 `src/__tests__/`、shell 的 `src/**/__tests__/`。
- 协议一致性由 conformance 套件锁定（引擎 manifest、relay 常量镜像、run 帧映射）。
- 分层与测试策略见仓库根 [TEST-STRATEGY.md](../../../TEST-STRATEGY.md) 与 [docs/testing/](../../testing/)。

## 6. 约束与权威文档

**约束登记**（机器权威 [docs/constraints.json](../../constraints.json)，人读视图 [docs/constraints.md](../../constraints.md)）：

| id | 内容 |
|---|---|
| C-ext-19 | 结果语义通知必须走确认式送达（持久账本 + 幂等键） |
| C-ext-20 | zcode 引擎单一 app-server 形态（禁 CLI spawn 链回归） |
| C-proc-13 | 引擎协议 v1.x chat 域语义与轮次活性权威 |
| C-pi-12 / C-pi-13 | pi 能力事实单点 / 改状态 RPC 回生效值 |
| C-proc-09 | 子进程 env 出站契约（`buildOutboundChildEnv` + deny 清单） |

**主题文档**：

| 主题 | 文档 |
|---|---|
| 引擎中立抽象 | [docs/architecture/subagent-engine-abstraction.md](../../architecture/subagent-engine-abstraction.md) |
| GUI 可见性链（协议帧 → 前端） | [docs/architecture/subagent-engine-gui-visibility.md](../../architecture/subagent-engine-gui-visibility.md) |
| 实时通道 | [docs/architecture/subagent-realtime-channel.md](../../architecture/subagent-realtime-channel.md) |
| 体系深化设计（方案层，含体系图与术语） | [docs/design/subagent-post-convergence-architecture.md](../../design/subagent-post-convergence-architecture.md) |
| core 抽包与 barrel/semver 契约（D5） | [docs/design/subagent-core-package-extraction.md](../../design/subagent-core-package-extraction.md) |
| 双轨收敛（双份实现归一） | [docs/design/subagent-dual-track-convergence.md](../../design/subagent-dual-track-convergence.md) |
| 引擎协议化（引擎外移独立 CLI 进程） | [docs/design/subagent-engine-protocolization.md](../../design/subagent-engine-protocolization.md) |
| SubagentService 六聚合拆分（壳 + 聚合） | [docs/design/subagent-service-decomposition.md](../../design/subagent-service-decomposition.md) |
| 不通知根因与恢复链（F 系列） | [docs/design/subagent-agent-end-recovery-replay.md](../../design/subagent-agent-end-recovery-replay.md) |
| 无界等待与回收层上界审计 | [docs/design/subagent-core-unbounded-wait-audit.md](../../design/subagent-core-unbounded-wait-audit.md) |
| zcode 引擎形态与会话库隔离 | [docs/design/zcode-engine-appserver-resident.md](../../design/zcode-engine-appserver-resident.md) · [docs/design/zcode-session-db-isolation.md](../../design/zcode-session-db-isolation.md) |

## 7. 历史沿革（本节为归档说明，不描述现状）

早期实现是**单包三层**：`extensions/universal/subagent-workflow` 内部同时容纳 TUI 层（`tool-render` / `list-view` / `bg-notify-render` / `format`）、Runtime 层（双 Service + `executor` + `record-store` + `notifier` + `tombstone-store` + `session-file-gc`）、Core 层（`session-runner`（含内联 session-factory / EventBridge）+ `output-collector` + 叶子原语），依赖方向自下而上严格单向，Pi SDK 只在 `session-runner` 与外壳注册两处出现。

该结构随后被三步重构取代：

1. **core 抽包**（[subagent-core-package-extraction.md](../../design/subagent-core-package-extraction.md)）：Runtime/Core 两层整体迁入 `packages/subagent-core`，壳只留注册面、宿主适配与渲染。
2. **引擎协议化**（W 系列）：进程内引擎退役，pi / zcode 各自成为独立引擎进程，宿主经 engine-protocol v1 通信；`session-runner` 及其内联件随之删除，其职责拆入 core 的引擎子域与引擎包。
3. **双轨收敛**（[subagent-dual-track-convergence.md](../../design/subagent-dual-track-convergence.md)）：chat 域与 workflow 域的双份实现归一到单份。

已删除的旧文件（本节仅作索引，勿按名查找）：`session-runner.ts`、`session-factory.ts`、`event-bridge.ts`、`executor.ts`、`tombstone-store.ts`、`finalized-marker.ts`、`progress-widget.ts`、`config-wizard.ts`。

旧版三层架构图与分层铁律表见 git 历史（本文件 2026-09-11 之前的版本）。
