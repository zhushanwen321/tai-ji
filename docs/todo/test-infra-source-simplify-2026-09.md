# 测试体系审计·源码简化候选（2026-09）

> 来源：① 2026-09-14 CI/测试耗时专项的三份审计（renderer 价值审计 / runtime 价值审计 / runtime top10 慢因深挖），完整数据链见会话记录与本文件 §2 证据；② 2026-09-15 测试舰队审查 r2 完整轮（r1+r2 共 915 文件全覆盖，§3 全部条目来源），聚合裁决见其 AGGREGATE.md §2.5、逐文件证据见 findings/batch-r2-NN.md（临时目录 `/tmp/test-audit/`，未入库，本文件即其源码简化信号的落仓登记）。
>
> **⛔ 实施状态：未排期（用户指令：留档）**。本文件只登记候选与证据，不含波次归属；重新评估触发：CI 分片改造（已落地）跑稳后按测试墙钟数据复核，或对应模块下次重构顺路消化。
>
> 前置关联：runtime 测试耗时的头号根因（fakeProc 永不发 exit → kill 走满 2s grace + `STARTUP_DELAY_MS=500` 真睡）由独立小改造修复（`test/helpers/rpc-client-mock.ts` + `RpcClient` 参数注入），**不在本文件范围**；本文件只收「源码本体简化」。

## §1 候选清单

### R1. PanelContainer retryFn 路由收敛（renderer）

- **位置**：`packages/renderer/src/components/workspace/PanelContainer.vue:221-248`
- **现状**：模块级 `let retryFn`（tab 间共享单槽）+ provide 内 if/else 按 tab 路由重试
- **证据（bug 形态同源）**：W31 major-2「terminal 永久卡死」即此形态的实锤事故；现有 3 个专门回归文件（`panel-container-lazy-retry / -detail / PanelContainer.test.ts`，合计 5.9s）钉扎该行为
- **方向**：收敛为 `Map<tabId, retryFn>`，或抽通用 `<AsyncBoundary>` 组件承接「加载失败 → 重试」语义
- **连带收益**：3 个回归文件可合并为 1 个参数化文件（注意：`panel-container-lazy-retry{,-detail}` 现因 vi.mock 成功结果跨用例缓存而**技术性强制分文件**，重构消除该约束后方可合并）

### R2. fileTree projection 下沉 core 纯函数（renderer）

- **位置**：`packages/renderer/src/stores/fileTree.ts`（521L，renderer 最大 store）
- **现状**：projection 逻辑与 Pinia store 共居，`fileTree-projection.test.ts` 等价性用例 ×24 为测纯函数性质却要付 happy-dom 组件环境开销
- **方向**：projection 下沉 `packages/core`（或 renderer 内独立纯函数模块），测试脱离组件环境
- **收益**：24 用例省 environment 开销；store 本体瘦身

### R3. 观察项（不动）：useChat.ts 1339L 单 factory

- 依赖面宽但 chat 域绞杀已完成（`stores/chat.ts` 36 行薄包装，主体在 core），暂无进一步拆分必要性；下次 chat 域重构时顺路复核

### T1. rpc-client 薄 wrapper 表驱动化（runtime）

- **位置**：`packages/runtime/src/infra/pi/rpc-client.ts:785-943`
- **现状**：约 20 个「构造 `{type, params}` → sendCommand → 解包」的同构命令方法
- **方向**：表驱动（command → {type, params} 元数据 + 单个泛型 sender）
- **连带收益**：低价值透传测试家族（streaming-behavior 6t / system-prompt 3t / preset-args 8t 逐 flag 重复锁同一透传契约）可表驱动化归并

### T2. start() 抽 spawnHarness（runtime）

- **位置**：`packages/runtime/src/infra/pi/rpc-client.ts:272-575`
- **现状**：start() 内联 spawn + stderr ring + crash log 收口，300 行单函数
- **方向**：抽 `spawnHarness`（spawn / 崩溃日志 / 启动确认三段），测试可单测 harness
- **风险**：启动链是事故高发区（early-frame-buffer、spawn-markers 落盘均在链上），重构须带等价性测试

### T3. 测试骨架收敛：test/helpers/pi-spawn-stub.ts（runtime，测试基建）

- **现状**：4 份同构 fakeProc 骨架（`rpc-client-spawn-args.test.ts:12` 自注「同构骨架」；已收敛先例 `test/helpers/free-port.ts`、`test/helpers/rpc-client-mock.ts`）
- **方向**：未走共享 helper 的 4 份骨架并入 `rpc-client-mock.ts`（或其继任者），与 #1 时间常量治理同文件落地
- **备注**：此项与 R 类不同，属于纯测试基建，成本低，可在下次触碰 rpc-client 测试时顺路做

## §2 证据锚点（2026-09-14 实测）

| 项 | 关键证据 |
|----|---------|
| R1 | `PanelContainer.vue:221-248` 模块级 `let retryFn`；W31 major-2 事故；`panel-container-lazy-retry.test.ts:14-17` 头注（mock 缓存强制分文件） |
| R2 | `stores/fileTree.ts` 521L；`fileTree-projection.test.ts` 24 例纯函数测试跑在组件环境 |
| T1 | `rpc-client.ts:785-943` 20 个同构 wrapper；透传测试家族重复（streaming-behavior/system-prompt/preset-args） |
| T2 | `rpc-client.ts:272-575` start() 单函数 300 行 |
| T3 | `rpc-client-spawn-args.test.ts:12`「同构骨架」自注；4 份骨架 × ~60 行 |

> 复核提醒：实施前先重跑 `docs/TEST-STRATEGY.md` §7 关联的 nightly coverage 与分片后 CI 墙钟基线，确认这些简化的测试收益仍然成立（分片已消化一部分文件级开销）。

## §3 测试舰队 r2 轮补充登记（2026-09-15，SUT 复杂度信号）

> 来源：测试舰队审查 r2 完整轮（915 文件）跨批结构性信号 §2.5「SUT 复杂度坏味道」+ 各批次 findings 逐文件核实。登记性质沿 §1 既有指令：**只登记不实施**。编号续接 §1（R=renderer / T=runtime 及测试基建）；各条与 §1 既有 R1-R3 / T1-T3 已核对，无重复条目。「证据」中的测试文件数 = 审查时点的锁定面，实施前需按 §1 复核提醒重新确认。

### R4. markdown.ts 增量流式轴拆分（renderer）

- **位置**：`packages/renderer/src/composables/logic/markdown.ts:934-1185`（全文 1188 行）
- **现状**：单文件承载 ≥4 个变化轴（渲染管线/路径识别/公式/编解码/增量流式）；其中增量流式轴（findStableBoundary / renderIncremental / shouldFinalizeStreamingFence，约 350 行）事实上自成体系
- **证据**：6 个测试文件覆盖；专锁增量轴的 `markdown-incremental.test.ts` 601 行（≈ 该轴源码 2 倍），测试已独立成体系而源码未拆。r2-01 评「本批最显著的『需要专门回归文件才锁得住』信号」
- **方向**：拆 `markdown-incremental.ts` 独立模块，测试文件无需动
- **来源**：舰队 r2-01

### R5. useAppUpdate.ts 按变化轴拆分（renderer）

- **位置**：`packages/renderer/src/composables/features/settings/useAppUpdate.ts`（822 行）
- **现状**：9 态状态机 + 守卫（ES4/ES5/pendingRestored/rateLimited）+ 定时器族 + 恢复链 + 错误分类，4 个变化轴挤在一个 composable
- **证据**：5 个测试文件按轴分文件锁定（useAppUpdate / .pending / .manual-channel / .visibility / .w3-acceptance）；r2-02 复核印证「N 个文件才锁得住」但拆分轴各自清晰、属按变化轴拆分而非碎片化。附带测试侧债务：4 个兄弟文件各复制 ~65 行 hoisted mock（r2-01 建议抽 `update-ipc-mock.ts` helper，可随源码拆分顺路消化）
- **方向**：按测试已分的轴拆源码（如 checkLaunchResult / restore 链独立模块）
- **来源**：舰队 r2-01 / r2-02

### R6. SessionItem.vue 按职责块拆子组件（renderer）

- **位置**：`packages/renderer/src/components/sidebar/SessionItem.vue:272-433`（全文 462 行；ContextMenu 段 :192-244）
- **现状**：7 块职责共居（unread / markedDone / importFresh / agent badge / navigateParent / forceQuit 两段确认 / assign 菜单）
- **证据**：5 个专门测试文件 + sidebar-layout D4 共 6 处锁定。r2-05 评「全批次最强的 SUT 复杂度坏味道实证」
- **方向**：按「条目展示 / 上下文菜单 / 徽标」拆子组件，测试随之归位
- **来源**：舰队 r2-05

### R7. subagent/workflow store strike 簿记双实现归一（renderer）

- **位置**：`packages/renderer/src/stores/subagent.ts`（372 行）与 `packages/renderer/src/stores/workflow.ts`（295 行）各自实现的 `emptyResultStrikes` 机制
- **现状**：空结果守卫 + strike 簿记是同一机制两份实现（连续 2 次空才删、非空打断重置、catch 重置）
- **证据**：2 个测试文件同构锁定——subagent.test.ts（35 用例）与 workflow.test.ts（25 用例）的 strike/守卫/clearSession 三组用例逐行同构且互引；用例不可单边删除（删一边即失去对该 store 的守卫）。r2-06 评「全批最明确的源码重复导致测试重复信号」
- **方向**：提取共享守卫工具后，两侧测试收敛为「共享实现测试 + 两处接线冒烟」
- **来源**：舰队 r2-06

### T4. event-interpreter.ts 五域拆分（runtime）

- **位置**：`packages/runtime/src/services/session/event-interpreter.ts:608-915`（密集区，全文 1455 行）
- **现状**：单类承载五个特性域——compaction 编排 + gen-stats 状态机 + agent-settled 延迟注入 + file_changes 帧序 + session-manager 路由
- **证据**：35 用例守护（event-interpreter.test.ts 28 + event-interpreter-file-changes.test.ts 7）+ e2e probe 部分用例；r2-23 的 gen-stats-service.test.ts interpreter 接线 describe 再印证横切面。r2-20 评「本批最强信号」
- **方向**：按变化轴抽协作对象（如 gen-stats 采样器独立成协作对象）降低单类状态面；现有测试已按特性域分组，先有契约后简化是安全顺序
- **来源**：舰队 r2-20（r2-23 印证）

### T5. message-dispatcher.ts 四入口收敛编排（runtime）

- **位置**：`packages/runtime/src/services/session/message-dispatcher.ts`（1232 行）
- **现状**：sendMessage / sendBash / forceQuit / abortBash 四入口共享预检/复位/广播逻辑；abort 阶梯（三级 + 防重入 + 处置竞态）已接近独立模块边界
- **证据**：4+ 个专门测试文件（force-quit 3 用例 / send-rejection 19 / bash 20 / bash-race / compact）+ abort-liveness 9 用例；r2-20 与 r2-23 两批独立印证，与 event-interpreter 同级复杂度集中信号
- **方向**：四入口抽公共收敛编排；abort 阶梯扩张前抽 `AbortLiveness` 类
- **来源**：舰队 r2-20 / r2-23

### T6. settings-message-handler.ts 按域抽子 handler（runtime）

- **位置**：`packages/runtime/src/transport/settings-message-handler.ts:109-160`（routes 表约 50+ 键，全文 815 行）
- **现状**：config 域大杂烩；仓内已有抽离先例 `config-preferences-message-handler.ts:1-9`（头注释自述「Extracted ... to reduce file size」）
- **证据**：4 个兄弟测试文件（supported-levels / llm-retry / rename-mode / model-switch）+ config-preferences 子 handler 测试，测试分裂映射 SUT 域大杂烩。r2-27 评「本批最重要的 SUT 简化信号」
- **方向**：按 config 域继续抽子 handler，测试文件可同步收敛
- **来源**：舰队 r2-27

### T7. worktree-service.ts IConfigService 子接口收窄（runtime，ISP）

- **位置**：`packages/runtime/src/services/worktree/worktree-service.ts:54`（`WorktreeServiceDeps.configService: IConfigService` 胖接口声明）；实消费点 :146 / :305 / :339 / :365 / :378
- **现状**：直接引用整仓胖接口 `IConfigService`，SUT 实际只消费 5 个方法（getDefaultBaseBranch / getBareSetupScript / getWorktreeRootDir / getSetupScript / getTimeout）
- **证据**：worktree-service.test.ts 的 mockConfigService（L66-155）stub 60+ 方法约 90 行，其他 worktree 测试若出现将复制同款 stub。r2-28 评「本批最清晰源码简化信号」并列为跨批源码信号 TOP1
- **方向**：依赖收窄为 5 方法 ISP 子接口，stub 随之缩 90→5 行（接口收窄归 SUT 改造，非测试侧可独立完成）
- **来源**：舰队 r2-28

### T8. session-service.ts / session-lifecycle.ts 存量编排面（runtime）

- **位置**：`packages/runtime/src/services/session/session-service.ts`（1534 行）、`packages/runtime/src/services/session/session-lifecycle.ts`（1671 行）
- **现状**：「core 绞杀迁移」后的存量装配与编排面——SessionRecords / SessionStateProjection / SessionModelControl / SessionHistoryReader / SkillInjector 均已模块化迁出并有独立直测，两文件大半测试是迁移伴随产物
- **证据**：合计约 15 个测试文件锁定（r2-23 SUT-测试映射表：session-service = 本批 4 + src/__tests__ 5 + test/ 1；session-lifecycle = 本批 4 + launch-params + 目录内 2 + src/__tests__ 4）。另：`removeSessionEntry` 汇聚点被 4 个文件锁定——r2-23 判定为「唯一完成入口」约定的设计正确证据而非坏味道，仅指出收敛文档（哪个文件是 SSOT）可更明确
- **方向**：若继续拆（removeSessionEntry 收敛链、create 编排独立模块），测试面随模块自然归位；不拆则维持现状（伴随产物是绞杀迁移的正常成本）
- **来源**：舰队 r2-23

### T9. file-service.ts 私有 withTimeout 可测性（runtime）

- **位置**：`packages/runtime/src/services/file-service.ts:543-550`（私有方法；`READ_TIMEOUT_MS` 常量 :41）
- **现状**：超时包装是私有方法不可直测——file-service.test.ts 的 F6 组 6 用例在测试文件内本地复制 withTimeout 副本自测（且同一 helper 复制 4 份），SUT 超时机制零覆盖（SUT 若坏如漏 clearTimeout 本文件恒绿）。这是该假测试的根因
- **证据**：r2-16 裁决 F6 组可删（或重写为经 SUT 公开路径触发真实超时）；6 用例中仅常量相等与 FileError 构造形状触达真实源码
- **方向**：与 T10 同型——超时包装提取为可注入/可直测的独立单元（或经公开路径触发），测试 import SUT 直测后 F6 组重写为真覆盖
- **来源**：舰队 r2-16
- **备注**：任务清单原文写「terminal-service.ts:543」，经源码核实实为 file-service.ts:543-550（terminal-service 无 withTimeout 符号），本条按源码登记

### T10. plugin-rpc-setup.ts findFiles 内联闭包提取（runtime）

- **位置**：`packages/runtime/src/services/plugin-service/plugin-rpc-setup.ts:310-324`
- **现状**：findFiles handler 是内联闭包（12 行，消费 `process.cwd()` 与 `MAX_FIND_FILES_RESULTS` 常量），结构上无法直测——plugin-findfiles.test.ts 因此在测试内本地重写实现自测，SUT 零覆盖（SUT 改 ignore 列表/上限/错误吞噬测试不红）
- **证据**：r2-12 评「本批最重要发现」，全审计唯一「复制实现自测」反模式（与 T9 同根因：SUT 形态迫使测试复制）
- **方向**：提取 `findFiles(pattern, cwd)` 纯函数（与测试本地副本签名一致），原闭包缩成一行委托；测试 import SUT 直测，5 个用例场景全部保留
- **来源**：舰队 r2-12

### T11. 括号平衡调用窗提取 helper 双实现（runtime，测试基建）

- **位置**：`packages/runtime/src/__tests__/create-derived-callers.test.ts:90`（`extractCallWindows`）与 `packages/runtime/src/__tests__/binding-registry-hydrate.test.ts:210`（`extractCallBlocks`）
- **现状**：同一「括号平衡提取调用窗」功能（均带字符串感知）在两个守卫型测试文件各写一份；两文件 SUT 不同（CREATE_DERIVED_CALLERS 登记表 vs BINDING_FIELDS 矩阵+接线），helper 同型
- **证据**：r2-20 跨文件发现 #3（工具函数重复，P3）；源码侧核实 message-bus.ts 无括号平衡代码，此信号纯在测试侧
- **方向**：抽共享 helper（如 `src/__tests__/helpers/`）；r2-20 同时注明「测试文件自包含也有其价值」，维持现状可接受——两可，触碰时顺路收敛即可
- **来源**：舰队 r2-20
- **备注**：非 SUT 复杂度信号，属测试基建收敛（同 §1 T3 性质）；任务清单原文写「message-bus.ts / other」，与 findings 及源码核实不符，按核实结果登记
