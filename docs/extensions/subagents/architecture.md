# Subagents 架构（现状 SSOT）

> **本文件定位**：subagent 体系的**结构导航页**——回答「这套能力现在由哪些包组成、各包边界在哪、关键机制落在哪个模块」，并指向各主题的权威文档。机制细节不在本文件展开（避免与设计文档双源漂移）。
>
> **最后校准**：2026-09-13（永久会话模型落地后复核——状态机两态化 / `.state` 收条化 / in-flight 推送链重挂 / worktree-reconcile 拆分；同日 execution/ 顶层 51 文件按变化轴落入子目录——persistence / notify / worktree / ui / lifecycle / assembly，目录镜像本表分组，顶层仅留 subagent-service.ts 装配壳与 relay-env.ts（exports 子入口物理位置）；2026-09-11 校准的包拓扑仍有效，见 §7 历史沿革）。
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
| `src/execution/`（顶层） | 装配壳 `subagent-service.ts`（唯一直接留顶层的执行域文件——装配点入口）+ `relay-env.ts`（`./relay-env` exports 子入口物理位置）+ `service/`（六聚合：`session-baselines` / `sync-collect-domain` / `record-lifecycle` / `record-access` / `workflow-dispatch` / `run-orchestration` + `service-bootstrap`） |
| `src/execution/persistence/` | record 持久化轴：`record-store.ts`（内存 + 磁盘重建容器，意图原语唯一写入口 C-data-20；H4 三轴拆分后 = 容器 + 原语立面 + D7 写面收口本体，三轴实现拆至 `record-store-terminal.ts`（终态原语轴）/ `record-store-rounds.ts`（轮次簿记轴）/ `record-store-rebuild.ts`（重建与投影轴）——轴文件经 ctx 注入写面，守卫白名单零改动）、`execution-record.ts`（唯一状态对象与 CAS）、`finalize-record.ts`、`record-entry.ts`、`state-marker.ts` / `alive-store.ts`（轮收口收条与写权声明 sidecar）、`manifest-store.ts` / `sessions-index.ts` / `session-reconstructor.ts` / `sync-rebuild.ts` / `session-file-gc.ts` / `idle-gc.ts`（持久化与回收） |
| `src/execution/notify/` | 通知轴：`notifier.ts` / `notify-host.ts` / `notify-ledger.ts`（确认式送达） |
| `src/execution/worktree/` | worktree 隔离轴：`worktree-manager.ts` / `worktree-git-ops.ts` / `worktree-reconcile.ts` / `worktree-registry.ts`（worktree 隔离与归档重建对账） |
| `src/execution/ui/` | 反向 UI 通道轴：`dialog-queue.ts` / `ui-channels.ts` / `ui-interaction-model.ts` / `ui-request-handler-factory.ts` / `ui-request-observability.ts` |
| `src/execution/lifecycle/` | 生命周期轴：`lifecycle-manager.ts`（idle timer）、`lifecycle-predicates.ts`、`settled-watchdog.ts`（轮次活性守护） |
| `src/execution/assembly/` | 装配与动作编排轴：`conversation-continuation.ts`（chat→run 统一，H1 唯一新增组件）、`subprocess-agent-runner.ts`（workflow 域 run 入口）、`subagent-actions-core.ts`、`agents-assembly.ts`、`agent-registry.ts`、`agent-result-mapper.ts`、`collect-coordinator.ts`、`concurrency-pool.ts`（background 并发与优先级排队）、`cold-lookup.ts`、`host-mode.ts`、`config.ts`、`model-resolver.ts`、`model-config-service.ts`、`stream-sink.ts`、`best-effort.ts`、`channel-registry-access.ts`、`path-encoding.ts`、`session-context-resolver.ts`、`session-pending.ts`、`workflow-state-root.ts`、`types.ts` |
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

反向通道（引擎 → 宿主）覆盖进度与交互：`host/streamDelta`（增量文本）、`host/askUser`（UI 请求）、`host/childSpawned`（子进程注册）、`host/childStateChanged`（任务子进程生命周期上报，C-pi-16）等。chat 域独立协议面（原第 9 通道 `host/roundLifecycle` 与 `interact` 方法）已随 H1（[subagent-chat-run-unification.md](../../architecture/subagent-chat-run-unification.md)）退役：续聊轮 = 新 run + resume 锚点（`RunParams.resume`），轮活性经 run 事件通道既有事件（含 `activity` 变体）与 run 终态应答承载（约束 C-proc-13，authority 已改挂该设计）。manifest conversation 位语义随永久会话模型增 `cold` 值（zcode 冷恢复：resume 读 + 新 session 注入，无热 steering）；capability gate 判据仍 `=== 'unsupported'` 拒绝（`true`/`cold` 均放行，[subagent-permanent-session-model.md](../../architecture/subagent-permanent-session-model.md) §3.2.6）。

`run` 的上下文（`RunContextParams`）承载每次运行的定位信息：`taskId` / `recordId` / `sessionRootId`（relay 身份键权威源，见 F6 修复）等——引擎据它重写子进程的 relay 身份 env，不靠 env 继承。[池抽象降级 2026-09-13] 原 `ctx.poolKey` 字段与 `host/poolResolved` 反向通道（第 8 通道）已删——两引擎 poolKey 恒 `'shared'`，journal 固定落 `engines/<id>/shared/`；[permission 通道退役 2026-09-13] `host/permission` 骨架已删（两引擎 `permissionMode=native` 零 emit、core 零注入），反向通道现为 6 条。

## 4. 关键机制（落点索引）

| 机制 | 落点 | 说明 |
|---|---|---|
| 状态单一真源 | `persistence/execution-record.ts` + `persistence/record-store.ts` | 内存 record 与 `session.jsonl` 磁盘重建两条通路共用同一 reducer；内部状态机两态（`running` / `idle`，[永久会话模型](../../architecture/subagent-permanent-session-model.md)——closed 终态与 ClosedReason 资格角色删除，cancel/close 转为意愿动作：中断当前轮 / 收起归档，stopReason 仅展示排障），对外投影两态（`active` / `idle`，`mapExternalState`——idle 替代旧 ended）。record 为纯数据 interface（贫血+函数式），行为集中在少数 mutate 唯一入口（createRecord/updateFromEvent/completeRecord/project/tryEnterRunning）——函数式 aggregate root，取代旧实现 11 种状态形状 / 6 处 turns 累加器散落（rationale 见 git 历史 subagents/data-model.md，已删） |
| 轮收口 sidecar | `persistence/state-marker.ts` | 单一 `<session>.state`（现行格式 `{status:"idle", stopReason?, endedAt?}`——**上一轮收条**而非死亡证明；旧值 finalized/cancelled 读侧上行映射为 idle+stopReason、写侧不再产）；重建单规则 = 一律得 idle（stopReason 取自 `.state`，缺失视为 interrupted-by-restart）。`.record-binding` 身份/统计/世代 sidecar（id→file、rootSessionId、epoch/lastAbandonedRound/turns——统计单基准）+ zcode 锚键文件族 `<dbPath>.<sessionId>` 同挂本载体族 |
| 进程探活 | `persistence/alive-store.ts` | `.alive`（pid marker）= 跨进程写权声明——写面已全量归 RecordStore（`writeAliveMarker` 唯一包装 = `acquireWriteLease`，acquire 三时机：sessionFile 锚点确立 / resurrect 回边 / running 接管；cold-lookup 直写存量已消亡）；release 两出口 = close 收起（`markArchived`）/ 30 天内存回收（`markIdleEvicted`）；判活 pid 单判据（[subagent-record-persistence-consolidation.md](../../architecture/subagent-record-persistence-consolidation.md) D3 v7） |
| chat→run 统一 | `assembly/conversation-continuation.ts` | ConversationContinuation = H1 chat→run 统一唯一新增组件（每 chatMode record 一个实例）：`onMessage` 状态迁移（idle → `reviveOrThrow` 万物可续 / 在途轮 D2 打断入队 / 轮间直派）、`dispatchRoundGuarded` 每轮派发（载荷组装 + 轮活性守护挂载 + 经泛化主干发起 run）、`settleRoundSuccess`/`settleRoundFailed` 轮末收口（settle 簿记 + 通知门三元组路由 + armIdleKeepalive）；[subagent-chat-run-unification.md](../../architecture/subagent-chat-run-unification.md) §3.4 + [永久会话模型](../../architecture/subagent-permanent-session-model.md) §3.2.7 |
| 空闲回收 | `lifecycle/lifecycle-manager.ts` | per-record idle timer——arm 面 u7a 重挂（`armIdleTimer`/`armIdleKeepalive`：轮成功收口翻入保活 + 推 inFlight=0，新轮 disarm 翻回 executing），常量 `XYZ_SUBAGENT_IDLE_TIMEOUT_MS` |
| 楔死回收 | `lifecycle/settled-watchdog.ts` | settled 永不到达的两段式守护：中段无进展检测（刷新源 = run 事件通道既有事件）+ 收尾段固定上界（交棒 = run 应答驱动）；run 域（含 chatMode 续聊轮）与 workflow 域共用同一原语 |
| 引擎装载 | `engine/engine-discovery*.ts` → `registry.ts` → `routing.ts` | 三级发现装载 cli descriptor；core 壳侧零内建引擎（`pi` 亦经发现装载） |
| 协议客户端 | `engine/client/remote-engine.ts` + `engine-client.ts` | 宿主侧唯一协议适配点：帧编解码、能力门、反向路由、句柄镜像 |
| journal | `engine/common/event-journal.ts` + `journal-wiring.ts` | 事件落盘（②级数据源）；固定分组 key `'shared'`（[池抽象降级] 无 retarget，路径构造即终值），30 天 mtime TTL 回收（`pool-manager.ts` `cleanupExpiredJournals`——journal 生命周期管理唯一清理机制，refs 计数已删） |
| relay 通道 | shell `relay/relay.mjs` + `runtime/src/infra/relay/` | 代理脚本 tee 子进程输出；父身份键（SESSION_ID / RECORD_ID）由引擎按 `run.params.ctx` 重写，防误归属 |
| 结果通知 | `notify/notifier.ts` + `notify/notify-ledger.ts` | 结果语义通知必须走确认式送达（持久账本 + 幂等键），约束 C-ext-19 |
| 反向 UI | `ui/dialog-queue.ts` + `ui/ui-request-handler-factory.ts` + `host/host-ui-endpoint.ts` | 引擎 `host/askUser` → 宿主 UI 请求队列 → 应答回传 |
| worktree 隔离 | `worktree/worktree-manager.ts` / `worktree/worktree-git-ops.ts` | 子 agent 在 worktree 内改动，收尾回传 patch |

## 5. 测试与验证

- 单元/集成测试按包分布：`packages/subagent-core/src/**/__tests__/`、两个引擎包的 `src/__tests__/`、shell 的 `src/**/__tests__/`。
- 协议一致性由 conformance 套件锁定（引擎 manifest、relay 常量镜像、run 帧映射）。
- 分层与测试策略见仓库根 [TEST-STRATEGY.md](../../../docs/TEST-STRATEGY.md) 与 [docs/testing/](../../testing/)。

## 6. 约束与权威文档

**约束登记**（机器权威 [docs/constraints.json](../../constraints.json)）：

| id | 内容 |
|---|---|
| C-ext-19 | 结果语义通知必须走确认式送达（持久账本 + 幂等键） |
| C-ext-20 | zcode 引擎单一 app-server 形态（禁 CLI spawn 链回归） |
| C-proc-13 | 引擎协议 v1.x chat 域语义与轮次活性权威 |
| C-pi-12 / C-pi-13 | pi 能力事实单点 / 改状态 RPC 回生效值 |
| C-proc-09 | 子进程 env 出站契约（`buildOutboundChildEnv` + deny 清单） |
| C-data-20 | record 持久化写面唯一入口（RecordStore 意图原语；两态化后原语清单已刷新——markSettled/markReopened/markArchived/markIdleEvicted 等） |
| C-data-22 | zcode 隔离会话库条目 TTL 引擎侧 sweep（与 pi transcript 同窗 30 天 / 活跃豁免 / 24h 节流） |

**主题文档**：

| 主题 | 文档 |
|---|---|
| 永久会话模型（两态状态机 + 万物可续聊 + 意图原语，2026-09-13 落毕） | [docs/architecture/subagent-permanent-session-model.md](../../architecture/subagent-permanent-session-model.md) |
| 引擎中立抽象（已被引擎协议化取代） | subagent-engine-abstraction.md（已删除，git 可追溯；现行权威 = [docs/architecture/subagent-engine-protocolization.md](../../architecture/subagent-engine-protocolization.md)） |
| GUI 可见性链（协议帧 → 前端） | subagent-engine-gui-visibility.md（已删除，git 可追溯；机制权威 = subagent-core engine/routing.ts 头注释） |
| 实时通道 | subagent-realtime-channel.md（已删除，git 可追溯；机制权威 = relay/relay.mjs 与 pi-invocation.ts 注释） |
| 体系深化设计（方案层，含体系图与术语） | subagent-post-convergence-architecture.md（已删，git 可追溯；谱系见 subagent-core-package-extraction.md 头部） |
| core 抽包与 barrel/semver 契约（D5） | [docs/architecture/subagent-core-package-extraction.md](../../architecture/subagent-core-package-extraction.md) |
| 双轨收敛（双份实现归一） | subagent-dual-track-convergence.md（已删，git 可追溯） |
| 引擎协议化（引擎外移独立 CLI 进程） | [docs/architecture/subagent-engine-protocolization.md](../../architecture/subagent-engine-protocolization.md) |
| SubagentService 六聚合拆分（壳 + 聚合） | [docs/architecture/subagent-service-decomposition.md](../../architecture/subagent-service-decomposition.md) |
| 不通知根因与恢复链（F 系列） | subagent-agent-end-recovery-replay.md（已删，git 可追溯；现行口径 = troubleshooting §12） |
| 无界等待与回收层上界审计 | [docs/architecture/crash-forensics-and-watchdog.md 附录 E](../../architecture/crash-forensics-and-watchdog.md) |
| zcode 引擎形态与会话库隔离 | [docs/architecture/zcode-engine-appserver-resident.md](../../architecture/zcode-engine-appserver-resident.md) · [docs/architecture/zcode-session-db-isolation.md](../../architecture/zcode-session-db-isolation.md) |

## 7. 历史沿革（本节为归档说明，不描述现状）

早期实现是**单包三层**：`extensions/universal/subagent-workflow` 内部同时容纳 TUI 层（`tool-render` / `list-view` / `bg-notify-render` / `format`）、Runtime 层（双 Service + `executor` + `record-store` + `notifier` + `tombstone-store` + `session-file-gc`）、Core 层（`session-runner`（含内联 session-factory / EventBridge）+ `output-collector` + 叶子原语），依赖方向自下而上严格单向，Pi SDK 只在 `session-runner` 与外壳注册两处出现。

该结构随后被三步重构取代：

1. **core 抽包**（[subagent-core-package-extraction.md](../../architecture/subagent-core-package-extraction.md)）：Runtime/Core 两层整体迁入 `packages/subagent-core`，壳只留注册面、宿主适配与渲染。
2. **引擎协议化**（W 系列）：进程内引擎退役，pi / zcode 各自成为独立引擎进程，宿主经 engine-protocol v1 通信；`session-runner` 及其内联件随之删除，其职责拆入 core 的引擎子域与引擎包。
3. **双轨收敛**（subagent-dual-track-convergence.md，已删 git 可追溯；谱系见 subagent-core-package-extraction.md 头部演进注记）：chat 域与 workflow 域的双份实现归一到单份。

已删除的旧文件（本节仅作索引，勿按名查找）：`session-runner.ts`、`session-factory.ts`、`event-bridge.ts`、`executor.ts`、`tombstone-store.ts`、`finalized-marker.ts`、`progress-widget.ts`、`config-wizard.ts`。

旧版三层架构图与分层铁律表见 git 历史（本文件 2026-09-11 之前的版本）。
