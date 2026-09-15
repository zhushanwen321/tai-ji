# W10 H9 测试面处置表（core 深路径测试三选一）

> 实施计划 §2.10「core 测试逐文件三选一处置清单」的执行记录（W10，2026-09-09）。
> 处置依据 = 文件 import 实测 + W5/W7 已迁件核对。处置后 core test 全绿
> （2999 passed | 7 skipped；删除 48 文件 / 改写 5 文件 / 保留待 W11 同批改写 4 文件——保留的 4 文件已随 W3 收口（1 删 3 改写），见 §② 节尾回写注记）。

## ① 已随引擎包迁移 —— 删除 core 重复副本（11 文件）

W5/W7 已把自包含件迁入引擎包（pi-subagent-cli / zcode-subagent-cli `__tests__/`，
两包 test 全绿），core 侧同名副本属重复实现测试，删除：

| core 副本（已删） | 引擎包权威副本 |
|---|---|
| `src/__tests__/fr4-get-state-handshake.test.ts` | pi-subagent-cli `__tests__/get-state-handshake.test.ts` |
| `execution/__tests__/get-state-handshake.test.ts` | 同上 |
| `execution/__tests__/output-collector.test.ts` | pi `__tests__/output-collector.test.ts` |
| `execution/__tests__/pi-invocation.test.ts` | pi `__tests__/pi-invocation.test.ts` |
| `execution/__tests__/temp-prompt.test.ts` | pi `__tests__/temp-prompt.test.ts` |
| `execution/__tests__/stdin-writer.test.ts` | pi `__tests__/stdin-writer.test.ts` |
| `execution/__tests__/spawn-event-adapter.test.ts` | pi `__tests__/spawn-event-adapter.test.ts` |
| `execution/__tests__/spawn-event-adapter-rpc.test.ts` | pi `__tests__/spawn-event-adapter-rpc.test.ts` |
| `execution/__tests__/turn-limiter.test.ts` | pi `__tests__/turn-limiter.test.ts` |
| `execution/__tests__/turn-limiter-semantics.test.ts` | pi `__tests__/turn-limiter-semantics.test.ts` |
| `execution/__tests__/spawn-args.test.ts` | pi `__tests__/spawn-args.test.ts`（core 副本的 `MAX_FORK_DEPTH` 断言面由 `recursive-visibility-baseline`/`nested-visibility` 族承接） |

## ① 随 SDK 原语迁移（1 文件）

| core（已删） | 迁移落点 |
|---|---|
| `execution/engine/__tests__/paths.test.ts` | `subagent-engine-sdk/src/__tests__/paths.test.ts`（import 改 SDK 包内相对路径，5 用例全绿） |

## ② 改写为镜像/协议等价断言 —— 已完成（5 文件）

| 文件 | 改写内容 |
|---|---|
| `src/orchestration/__tests__/execute-agent-call.test.ts` | output-collector 深路径 import → `@zhushanwen/pi-subagent-cli` 公共导出面（25 用例绿） |
| `execution/__tests__/subprocess-agent-runner-routing.test.ts` | `getChildByRecord` 深路径 → core 侧镜像 `host/spawned-children.ts coreSpawnedChildrenMirror().getChildByRecord`（pid 同构判据）；「退出后按句移除」断言移至 protocol-blackbox childStateChanged 用例（inproc 双模不回灌该通道，文件内已注记） |
| `execution/__tests__/chat-engine-routing.test.ts` | 同上（镜像面改写） |
| `execution/engine/__tests__/common/capability-gate.test.ts` | PiEngine/ZcodeEngine 内建构造 → 读两引擎包 package.json manifest `taiji.subagentEngine.capabilities`（同步成员唯一源；11 用例绿） |
| `execution/engine/__tests__/conformance/contract.{probe,abort,read-degradation,agent-events}.test.ts` + `golden-replay.{pi,zcode}.test.ts` + `engine-conformance.live.test.ts` | conformance 契约套件整体协议黑盒化：RemoteEngine × fake 引擎 CLI / golden 语料改引擎包 `__golden__/` + 公共导出面 / live 门改「协议客户端 × 引擎包 CLI」形态（A2 真机形态本身） |

## ② 改写被阻塞 —— 保留 + W10 处置注记，W11 同批改写（4 文件）[v1.x W3 已收口，见节尾回写注记]

`src/__tests__/append-system-prompt-assembly.test.ts`、`execution/__tests__/explicit-agent-ref-guard.test.ts`、`execution/__tests__/delivery-methods.test.ts`、`execution/__tests__/gc-timer.test.ts`。

阻塞原因（同根）：这些文件 `vi.mock("…engines/pi/session-runner.ts")` 拦截的**是 core 生产代码的 inproc 深路径 import**（subagent-service / lifecycle 谓词等消费点在生产侧）——mock 目标改指引擎包或镜像需生产 import 先改线，而 W6 已把改线收敛到 W11 收口（`subagent-service.ts` W7 注 + `lifecycle-predicates.test.ts` 仍深 import spawnedChildren 同证）。W11 删内建当轮必须同批改写这 4 个文件（每文件头部已留 `[W10 处置注记]`）。

> **[v1.x W3 已收口 —— 回写注记（2026-09-09）]** 上方 4 文件已随 commit `0df9ef8b3`（W3 删 inproc pi 引擎 + chat 协议化改线）处理完毕：`append-system-prompt-assembly.test.ts` 删除，其余 3 文件改写为协议等价断言（`explicit-agent-ref-guard.test.ts` / `delivery-methods.test.ts` / `gc-timer.test.ts`，现头注 `[W3 改写]` 可核）。原 `[W10 处置注记]` 已被 `[W3 改写]` 头注取代，W11 对这 4 文件无剩余改写面。本节标题、阻塞原因与文首统计行保留作 W10 时点历史（[HISTORICAL] 纪律），现行状态以本注记为准。

## ③ 声明废弃 —— 删除（34 文件 + 1 helper）

统一理由（按文件另有侧重）：**被测行为 = 内建 pi/zcode inproc 编排实现**，协议化终态下该实现归引擎进程（W11 删除 core `engines/pi|zcode`）；行为面承接：

- **引擎内部行为**（spawn 参数/dispatch/LRU/心跳/EPIPE/收敛）→ `@zhushanwen/pi-subagent-cli` / `zcode-subagent-cli` 包内测试（W5/W7 迁移件，两包全绿）；
- **协议契约面**（run/cancel/read/反向通道/错误帧/结构等价）→ W10 新协议黑盒套件 `conformance/protocol-blackbox.test.ts` + `client/__tests__/*`（W2）；
- **收割/杀链语义**（R9-1 口径：一代子进程 + 组内后代）→ SDK kill-chain 单测 + A3 真机门；
- **inproc 双模过渡态**（TAIJI_SUBAGENT_ENGINE_MODE）本身 = DoD#5 删除对象，不保留锚定测试。

| 已删文件 | 侧重理由 |
|---|---|
| `src/__tests__/session-runner.test.ts` | 引擎内部（pi spawn-runner） |
| ask-user-transit-e2e / ui-request-handler | ui 请求链引擎内部面（pi 包 ui-channels/ui-request-queue 测试 + W10 反向通道用例） |
| chatmode-first-round-closure-spawn / run-and-finalize-chatmode / run-spawn-chatmode-settled | chat 轮次收敛编排（pi 包 spawn-runner；chat 域 HostBridge 编排 W7 已登记 stage-3 gap） |
| descendant-sweep / descendant-sweep-guards / kill-all-escalation / service-kill-escalation / spawned-children | 收割/杀链（SDK kill-chain + A3 真机门；镜像面 = protocol-blackbox） |
| epipe-fallback / session-runner-epipe | EPIPE 兜底（pi 包 stdin-writer/spawn-runner 测试） |
| keep-alive-no-progress / settled-watchdog / timeout-integration | 进度/超时判据（ADR-0047 域）。**处置改写（2026-09-09，Gate B 后纠正）**：原「pi 包 + A8 真机门」承接声称不成立——pi 包内无等价测试（grep keep-alive/no-progress/settled-watchdog/timeout-integration 零命中），Gate B 时点 A8 真机门为 blocked/manual、不构成承接证据；该三测试的行为面**随 keep-alive 协议化偏差登记**（impl-plan §5 2026-09-09 行：workflow 域单次 run 口径 agent_end 即终结，后台后代保活编排未随迁移），**不声称已承接** |
| recursive-visibility-env / start-sync-model-guard / session-runner-schema-env | 引擎内 env 注入面（pi 包 spawn-args/relay-env 测试；W12 env 契约单测） |
| rpc-mode / run-spawn-rpc-mode / run-spawn-integration / run-spawn-resume / run-spawn-edges / run-and-finalize-anchoring / run-spawn-stdout-callback-throw / spawn-worktree-guidance | run 全链编排（pi 包 spawn-runner/protocol-e2e；协议面 = W10 黑盒套件） |
| session-runner-branch-cache-lru / session-runner-close-prune / session-runner-dispatch / session-runner-heartbeat-idle-fallback / session-runner-lifecycle-helpers | session-runner 内部机制（pi 包） |
| max-turns-to-watchdog-ms | turn limiter 换算（pi 包 turn-limiter 测试） |
| subagent-service-message-close | message-close 编排（chat 域 stage-3 gap 承接） |
| worktree-pid-registration.integration | pid 注册集成（镜像面承接；worktree 面归 W12 回归） |
| execution-runtime-face / engine-model-validation / session-view-service-zcode-dbpath | zcode 引擎内部（zcode 包 zcode-engine-* / reader / zcode-session-db-isolation 测试） |
| `helpers/session-runner-mocks.ts` | 消费者全部随上表删除（spawn-mock.ts 保留——3 个存活壳侧行为测试仍消费） |

## 未入清单的既有深路径引用（W11 处置面，W10 显式登记）[v1.x W3 已收口，见节尾回写注记]

以下文件经 `vi.mock` 字符串路径引用 `engines/pi|zcode`（非值 import，grep 字符串命中），
不在 §2.10 三选一清单内、本次未动，W11 删内建时同批核处：
`recursive-visibility-baseline` / `nested-visibility-env-propagation` / `execute-nesting` / `execute-and-await-worktree` / `collect-coordinator-service` / `collect-mixed-dispatch` / `get-record-for-action-restart` / `stream-sink-retirement` / `subagent-agent-runner.test` / `subagent-service-{multiproc-guard,notify-gate,parent-guard,recovery-bounds}` / `sync-collect-recovery` / `helpers/{spawn-mock,subagent-service-mocks}` / `lifecycle-predicates.test`（归 W6/W11）。

> **[v1.x W3 已收口 —— 回写注记（2026-09-09）]** 上节登记的 17 项（14 测试 + 2 helper + `lifecycle-predicates.test`）已全部随 commit `0df9ef8b3`（W3 删 inproc pi 引擎 + chat 协议化改线）处理完毕：节内所列文件在该 commit 全部为改写（M），无一保留原深路径 mock；其中 `subagent-agent-runner.test` 系 `subprocess-agent-runner.test.ts` 的简写登记，同在该 commit 改写。`vi.mock(…engines/pi|zcode)` 深路径命中现全 core 树清零（grep 实测：残留仅注释/用例描述文本，无模块路径引用）；`[W3]`/`[W3 改写]` 标记 17 项中 14 项可核（标记散布文件头部注记与用例旁注，非全在文件头），余 3 项（`execute-and-await-worktree` / `subagent-service-multiproc-guard` / `subagent-service-parent-guard`）无标记但同 commit 已删深路径 mock（diff 可核）。W11（commit `6d5f6747d`）对该面无剩余核处义务。原节登记保留作 W10 时点历史（[HISTORICAL] 纪律），现行状态以本注记为准。


## 主会话修正（2026-09-09，W10 修复轮）

- `engine/__tests__/common/session-view-service-zcode-dbpath.test.ts` 原列 §2.10 清单①（随 zcode 包迁移/W5），但 W5 未迁（它测的是 core 壳侧 session-view-service 白名单分支，非引擎内部行为）、W10 批次误删——已按原样恢复（8 用例绿）。该文件深路径 import（engines/zcode/{reader,constants,db-path}）在 **W11 H1 改写当轮**随 session-view-service 协议化同批改写为协议等价断言（或由 zcode 包 e2e 接替后删除）；在此之前保留为 A plan（zcode-session-db-isolation）生产链验收证据。
- ①类清单中「测 core 壳侧模块」的文件（本件与 execution-runtime-face / engine-model-validation）处置归属应为「W11 H1/H2 同批」而非「随引擎包迁移」——后续处置以本节为准。


## W6 承接回写（2026-09-09，chat-domain v1.x 轮次活性治理）

> 设计权威源：`docs/design/chat-domain-v1x-liveness-governance.md` §3.2 D2/D5 + §5 W6 行。
> 本节回写 §③ 行「keep-alive-no-progress / settled-watchdog / timeout-integration」的
> 处置改写注记（该行「不声称已承接」状态自本节起 supersede）——三测试行为面已随
> W4/W6 落地，承接落点如下。原注记保留作历史，不删（[HISTORICAL] 纪律）。

| 原测试 | 承接落点 | 状态 |
|---|---|---|
| keep-alive-no-progress | **W4 轮次活性监督器**（keep-alive 编排归属裁决 A：core 编排层持有「轮次活性权威」，`execution/round-supervisor/`——no-progress 判定域按设计 D2 域分类收窄：run 域 resumable 无驱动任务归监督器三态；chat 域 idle 稳态豁免归 settled-watchdog/idle 机制）+ conformance 协议黑盒场景链 `conformance/round-liveness-supervisor.test.ts`（SIGTERM crash → 纳管 → 该唤醒 → 该放弃全链 / boot 分区 / 通知对账 / 重建不解管）+ W4 判定矩阵单测 `execution/__tests__/round-supervisor.test.ts` | 已承接（W6 回写） |
| settled-watchdog | **含生产接线归属**：两段守护行为面 = 既有 core 原语套件（`execution/__tests__/subagent-service-recovery-bounds.test.ts`：armSettledWatchdog / mid-round no-progress / settled 硬顶 / 双 disarm 回收面）。**生产接线归属（D5「删件不同批重接 = 失守」约束）**：W4 已立协议事件 API 三入口——`execution/settled-watchdog.ts` 的 `refreshFromProtocolEvent`（协议事件行到达刷新中段）/ `noteRoundSettledFromProtocol`（settled 相位中段让位收尾段）/ `disarmRoundFromProtocol`（idle 相位/close/终态两段一并清），零新语义薄委托、与存量原语幂等并存；**W3 删 `engines/pi/session-runner.ts` 时必须同批把存量 arm/refresh/kill 接线（arm 点 = 轮开始；refresh 源 = host/streamDelta + host/roundLifecycle；kill/终态 = 既有杀链）换到这三个入口**——接线未重接完成前 W3 不得删件 | 已承接（协议事件面已立 + W3 重接认领） |
| timeout-integration | live conformance 门（`conformance/engine-conformance.live.test.ts`，`ENGINE_CONFORMANCE_LIVE=1 PI_LIVE_MODEL=<模型>`；设计验收 A7）——超时/abort/收敛行为在真机引擎 + 真实进程生命周期下验证；单测不再锚定 inproc 实现（原 timeout-integration 的「abort 超时强杀集成」语义由 W7 runtime 三级阶梯测试 + 本 live 门共同承载） | 已承接（live 门） |

**W6 同批新增语义钉住**（conformance 领地，均绿于 `pnpm --filter @zhushanwen/subagent-core test`）：

- 引擎中途 SIGTERM → run 终态 failed（**D5 前置闸：本用例先于 W3 删 `engines/pi/session-runner.ts` 旧 143 误分类器存在并保持绿**，P2 探针的 conformance 承载）→ `conformance/engine-crash.test.ts`；
- chat 轮次协议 v1.x（host/roundLifecycle 三相位 × runId|recordId 关联键回执链 + recordId 键 delta 分路 + conversation gate 负向 A6）→ `conformance/chat-round-protocol.test.ts`；
- 翻档事实（三类型全 process 档、跨时长无 TTL 清理）+ fork 读侧过滤①③两口径 + **bash 跨 session 可见性显式断言**（R4 一刀钉成显式选择）+ 偏差 #4 探针（goal 守卫口径实测）→ `conformance/registry-fork-filter.test.ts`。

**goal 熔断（W5）处置**：**由 extension 侧单测承载，不重复造**——`extensions/universal/goal` 393 例已覆盖双维度熔断（circuit-breaker 6 + liveness 17：50 次封顶必停发、第 5 轮起间隔 ×2、恢复清零退避不重置总数、defer 通知去重）；设计验收 A10（实机熔断场景）仍归 Gate B 真机剧本，不在 conformance 重复。

## 一致性审查批 2 修复回写（2026-09-09，F-2 首轮 arm 重接）

上方 W6 承接回写节「settled-watchdog」行声称的「W3 重接」**当时失实**（一致性审查批 2 F-2 证实）：W3 实际只重接了热路径续聊轮（`deliverChatMessage` 的 arm 调用点），`kickOffChatRound`（spawn 首轮 + 冷续 resume 轮）内无任何 arm 调用——:1382 注释声称「首轮调用点在 kickOffChatRound 的 run 派发后」不存在，被删的 inproc stdout-pump 是首轮唯一中段守护，协议化后引擎侧 spawn-runner 仅 turn 计数无墙钟 → **首轮 wedged 无熔断**（LC-1 场景①重新敞开）。H9 行「已承接」按当时状态属过度声称。

**修复后真实状态**（本行 supersede 上方 W6 行的承接声明）：`kickOffChatRound` 在 run 派发前（pool acquire 成功后）补 `armMidRoundNoProgress`，与热路径 arm 复用同一守护实例语义（同一 `onHotPathSettledWatchdogTimeout` 处置闭包）；refresh 源核实齐备——首轮 runId 键 `ctx.onEvent` 协议事件行（含 text_delta，引擎侧 spawn-runner 对 text_delta 同时走 onEvent/onDelta 两通道）+ `ctx.onRoundLifecycle` settled 相位交棒（`noteRoundSettledFromProtocol`，首轮 runId 键经同一 handleChatRoundPhase 收敛，本批测试核实生效）。承接测试：`execution/__tests__/chat-round-first-round-watchdog.test.ts`（首轮 arm / 冷续轮静默 30min 熔断 / 中段事件行刷新 / settled 交棒不继承中段计时）。
