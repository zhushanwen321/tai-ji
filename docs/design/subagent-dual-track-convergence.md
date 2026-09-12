# subagent 体系双轨收敛与深化设计（dual-track convergence）

> 层声明：本文档是「架构重构方案层」的设计——把架构走查（2026-09-02，三分支并行 explorer 走查 + 主 agent 抽查实证）发现的 8 个摩擦点收敛为可实施的分组方案。下一层产物是**各组的实现计划与代码任务**（逐文件迁移清单、测试切换清单），不跨层到逐函数实现与具体测试用例。
>
> 上游资产：[subagent-engine-abstraction.md](../architecture/history/engine-abstraction-2026-09/subagent-engine-abstraction.md)（引擎中立抽象，D1-D12，P1-P5 已落地；已被引擎协议化取代）、[subagent-core-package-extraction.md](subagent-core-package-extraction.md)（core 抽包 + HostServices，已落地）、subagent-engine-gui-visibility.md（record 通道引擎中立；已删除，git 可追溯，现行权威 = [subagent-engine-protocolization.md](subagent-engine-protocolization.md)）。

## 1. 背景目标

**一句话结论**：前两轮重构（引擎抽象、core 抽包）都停在「新轨可用」而没有「旧轨收敛」，体系内现在有 10 对双轨/双实现，其中 4 对已开始行为漂移（有实证）；本设计按依赖关系分 3 组收敛它们——**每个概念一个实现点**，机制要么接线要么删除，不留「假兑现」中间态。

### SCQA

- **S（情境）**：subagent 体系（`packages/subagent-core` + `extensions/universal/subagent-workflow` 壳）刚完成两轮大重构：引擎中立抽象（EnginePort + pi/zcode 双 adapter + 公共降级层）与 core 抽包（HostServices 宿主端口 + 双宿主形态）。抽象资产已就位，测试全绿。
- **C（冲突）**：两轮重构为了控制回归风险，刻意保留了旧实现（pi spawn 链原地不动、runtime 手写 journal reducer 不删）。这本是实施期的风险隔离策略，但策略没有退出机制——于是每个被抽象覆盖的概念都留下两份实现，且双轨已经开始各自漂移：同一份 journal 格式有两个 reducer（runtime 版不记 message_end 的 error 记账且零测试）、同一动作有两种杀链（grace 30s vs 5s）、同一个函数有两份拷贝（format 小时分支只在一侧）。
- **Q（问题）**：如何在不破坏「pi 宿主行为零回归」底线的前提下，把这些双轨收敛为单一实现，让 EnginePort 抽象对 pi 也成为真 seam（而非只对 zcode 成立），并让每个已落地的机制要么真的接线、要么显式删除？
- **A（答案）**：本文的 3 组 8 项收敛方案——组 1 独立清理（journal 读取链收敛 + 壳内双轨 + 池生命周期裁决），组 2 execution 主轴（pi 执行轨下沉 → 引擎无关件归一 → Service 按轴拆分），组 3 orchestration（收尾单点化 + 任务形状三态往返消除）。

### 系统是什么（给不熟悉内部的读者）

pi-subagent-workflow 体系 = 模型可调用的 `subagent`/`workflow` 工具背后的完整执行与编排基建，物理上三块：

```
[pi 主会话进程]                                          [xyz-agent runtime 进程]
  extensions/universal/subagent-workflow（壳）             subagent-engine-history.ts
    interface/ 工具面 + TUI 视图 + injectors                 ├─ 读 record（主会话 entry 投影）
    host/ pi 宿主接线                                       ├─ 读 journal / 引擎原生存储
    index.ts 组合根（event handler + 装配）                  └─ → GUI 历史详情 / 子代理列表
    └── 依赖 packages/subagent-core（core，workspace 引用）
          execution/   SubagentService 编排 + spawn 执行链 + record/journal
          execution/engine/  EnginePort 抽象 + pi/zcode 双 adapter + 公共降级层
          orchestration/ workflow 引擎（worker thread 跑脚本，AgentRunner port 回调执行层）
          shared/      资源发现（agent/skill/workflow 多源扫描）
```

**术语**（首次出现即定义，后文反复使用）：

- **双轨（dual track）**：同一概念存在两份实现、两条调用路径。例：派一个 pi 引擎的 subagent，chat 域（模型在主会话里直接调 `subagent` 工具）走 `SubagentService.kickOffBackground → session-runner.runSpawn`，workflow 域（workflow 脚本里的 `agent()` 调用）走 `SubprocessAgentRunner → EnginePort → PiEngine → SubagentService.executeAndAwait`——同一个「spawn pi 子进程」动作有两条入口路径。
- **假兑现**：机制的代码已写（且有测试），但生产链路无人调用，语义不会执行。例：`engine/common/pool-manager.ts`（226 行，池引用计数 acquire/release）零生产调用方——隔离池实际只增不减。
- **deletion test**：想象删掉某 module——若复杂度消失，它是浅 pass-through；若复杂度摊回 N 个调用方，它有价值。本走查用它判定每个疑似浅模块。
- **seam / depth / shallow / adapter / leverage / locality**：架构词汇，定义见 `~/.agents/skills/improve-codebase-architecture/LANGUAGE.md`；本文用「深 module」指 interface 窄而 implementation 厚的 module，「浅 adapter」指纯委托、自身不吸收复杂度的 adapter。

### 设计目标（从使用者体验倒推）

受益者排序：③ 开发者（维护者/AI agent）> ② xyz-agent 用户（GUI 正确性）> ① 模型（工具面不变）。

1. **GUI 历史详情读在有测试守护的实现上**。生产读取通路从「零测试的手写副本」切换到「conformance C5 守护的 core 实现」——收益是守护对称与 engine-generic 正确性：对现役 zcode 无可观察行为变化（其 journal 的 message_end 由 parser 合成、只带 usage，错误走独立 error 事件且两侧 reducer 均已处理），但已分叉的 reducer 语义（core 记 message_end error、runtime 不记）从「生产走无守护侧」变为「生产走守护侧」，未来 parser 演进或新引擎接入产出该形态时由守护实现正确记账；compaction 的 GUI 可见性属新增行为（现状 core 分支为刻意 no-op），不在本设计范围（见 D1 被否谱系）。
2. **每个概念一个实现点**。开发者改杀链 grace 窗口、journal 格式、资源清单注入逻辑、TUI 时间格式化，都只有一个写点；改完一处即全局生效。
3. **pi 与 zcode 同形**。理解任意引擎的执行，入口都是 `engines/<id>/` 的四件套（launcher/parser/preparer/reader）；不存在「pi 特殊，要去 execution/ 根目录找 session-runner」。
4. **缺省路径不付多引擎税**。一个 workflow 内派 pi 子代理（占绝对多数的调用形态），任务形状只映射一次；新增/修改任务字段只动一处类型定义。
5. **机制无假兑现**。代码里存在的每个机制要么在生产链路被调用，要么被删除且设计文档同步修订——「模块在但语义不执行」的中间态清零。

### in / out of scope

**in**：8 个走查候选的收敛（分组见 §3.1），落在 `packages/subagent-core` 与 `extensions/universal/subagent-workflow` 壳、`packages/runtime` 的 subagent 读取侧。

**out**：①core barrel 与壳侧 63 个深路径 import 的两张皮（semver 契约面收口）——真实摩擦但与 8 候选无文件交叠，单独立项更干净；②新引擎接入（claude-code 等，EnginePort 设计预留位）；③notifier 的 ledger/delivery-kernel 双路径——那是 pi-boundary-reliability 设计的刻意降级链，非双轨；④zcode 仓 zsw 壳迁移（extraction 设计的 Phase 2，另一仓）；⑤subagent pause/resume（ADR-0038 已裁决不做）；⑥resource-discovery 的 sync/async 双轨——sync 路径唯一租户是 agent-registry 热重载，是否消灭取决于 agent-registry 消费形态决策，标记待清理不在本设计；⑦journal compaction 事件的 GUI 可见性——属新增行为而非收敛（core 现状分支为刻意 no-op），见 D1 范围声明。

## 2. 现状与问题分析

**首句结论**：现状不是缺抽象——抽象资产（EnginePort、公共降级层、HostServices）都已就位；问题是旧轨未退出导致的 10 对双轨/双实现，其中 4 对已发生行为漂移、2 个机制假兑现，且生产代码跑在无守护的那一侧。

### 2.1 使用者视角的现状（真实例子）

**例一（开发者/维护者视角，GUI 历史详情的守护不对称）**：详情页数据来自 runtime 进程 `subagent-engine-history.ts` 手写的 journal 重放 reducer（`applyJournalEvent` :339-366，恰好 7 个 case，零测试守护）。core 侧另有一份完整语义（`execution-record.ts:updateFromEvent` 的 message_end 分支 :389-397 记录 lastError），且有 conformance C5 契约测试守护——**但生产零调用**（`EnginePort.read()` 的调用方只在测试里）。两份 reducer 已在 message_end 维度分叉（core 记 error、runtime 不记 :310-322），**但对现役生产流无可观察影响**：zcode 的 message_end 由 parser 合成、只带 usage 永不带 error（parser.ts:303-308），错误走独立 `error` 事件且 runtime 的 `applyErrorEvent`（:330）已处理；该分叉形态只在 pi 事件流出现，而 pi 历史走 runtime 自有 JSONL 直读链不经此 reducer。真实的暴露路径是结构性的：用户读的、AI 排障时信的那份历史，跑在没有守护的副本上——zcode parser 演进（如开始产出带 error 的 message_end）或第三引擎接入时，错误记账语义由无测试侧决定。本设计不声称修复用户可见缺陷，声称的是消灭「生产走无守护侧」这一结构风险。（compaction 维度两侧等价：core 的 compaction 分支是刻意 no-op（:403「不产生数据（不变）」），zcode journal 也不含 compaction 事件——本设计不声称修复 compaction 可见性。）

**例二（开发者视角，改一处要懂 N 处）**：开发者想调整子代理超时的杀链宽限窗口。搜到 `session-runner.ts:893 killChildWithEscalation`（SIGTERM → 30s → SIGKILL，timer 式），改完上线——zcode 引擎的任务行为没变，因为它走 `engine/common/kill-chain.ts:55 killChain`（SIGTERM → 5s grace（:38）→ SIGKILL，promise race 式）。两个实现的 grace 参数已经不一样（30s vs 5s），**漂移不是假设而是现状**。同理，「调用前拒绝不支持的参数」分散两处且各管一段：`assertEngineParamSupport`（subagent-service.ts:1641，仅被 Service 引擎路径 :1617 调用，拦 conversation/fork/worktree）与 `rejectUnsupportedTaskShapes`（zcode-engine.ts:543，zcode 专属，:227 调用，拦 fork/conversation/maxTurns）。合成的真实图景是：maxTurns 是 pi 的已支持能力（engine/types.ts:93「pi 引擎专属」，由 turn-limiter 执行）——pi 两域都不拦、zcode 两域都拦；而 **worktree 出现跨域缺口**：chat 域的 zcode 任务带 worktree 会被 :1617 拦下，workflow 域的 zcode 任务带 worktree 则因 SAR 不调 assertEngineParamSupport 而**漏拦**。

**例三（模型视角，一切正常）**：模型调 `subagent` 工具，入参返回不变——本设计不改变工具面。**但工具面之下的成本在累积**：workflow 域一次 `agent()` 调用经历四套任务形状——`AgentCallOpts`（orchestration，18 字段）→ `ExecuteOptions`（execution，含 thinkingLevel/chatMode/skillPath 等 9 处 pi 专有语义残留）→ `AgentTaskSpec`（engine 中立）→ 在 pi engine 内**还原回** `ExecuteOptions`。两个 mapper 文件（`execute-options-mapper.ts` 115 行、`engines/pi/task-spec-mapper.ts` 100 行）加一套「往返保真」逐字段测试锁住这条链。从不切换引擎的缺省路径付了全额多引擎税。

### 2.2 双轨/双实现清单（实证，含 deletion test 结论）

走查方法：三个 explorer 并行覆盖 execution / orchestration+壳 / 跨边界+测试拓扑，全部发现要求 file:line 证据 + deletion test；主 agent 分两轮 rg/read 抽查复核（走查当日 7 项 + 审查轮 30+ 项，2026-09-02）。

| # | 概念 | 两份实现 | 漂移实证 | deletion test |
|---|------|---------|---------|---------------|
| 1 | journal 重放 reducer | core `journal-replay.ts`（C5 守护，生产零调用） vs runtime `subagent-engine-history.ts`（`applyJournalEvent` :339-366，7 事件，零测试，生产唯一通路） | **是（结构性）**：runtime 不记 message_end 的 error（core :389-397 记账）——该形态现役 zcode 生产不产出（parser 合成仅带 usage、错误走独立 error 事件且两侧均处理），漂移的意义是守护不对称而非用户可见缺陷；compaction 维度两侧等价（core 分支为刻意 no-op :403） | 删 runtime 副本：复杂度消失（core 版是有守护的上位实现） |
| 2 | pi 执行路径 | Service 旧轨 `kickOffBackground`(:778/:952) → session-runner（pi 机制九件合计 ≈3079 行在 execution/ 根） vs 引擎轨 `executeViaEngine`(:723) → PiEngine（415 行，真逻辑只有 probe，其余纯委托回 Service） | **是**：interact/read 能力面生产零调用；chat 域永走旧轨 | 删旧轨（迁移后）：双路由/双 journal 接线/双预检随之消失 |
| 3 | 任务形状映射 | 三形态四映射（AgentCallOpts→ExecuteOptions→AgentTaskSpec→ExecuteOptions） | 否（靠保真测试锁死） | 删两个 mapper：复杂度净消失 |
| 4 | 杀链 | `session-runner.ts:893`（30s grace） vs `kill-chain.ts:55`（5s grace，:38 常量） | **是**：grace 参数已分叉 | 合一：参数化 grace，一处实现 |
| 5 | 引擎路由编排 | `subagent-service.ts:694-737` vs `subprocess-agent-runner.ts:126-170`（后者多 pi 短路 + registry 注入） | 否（逻辑同构但各自演进） | 收敛 routing.ts 单实现两调用点 |
| 6 | journal 接线 | `subagent-service.ts:1712-1731` vs `subprocess-agent-runner.ts:176-231`（writer+retarget+回填两份） | 否 | 提 host 共享 helper，复杂度消失一份 |
| 7 | 调用前预检 | `assertEngineParamSupport`（Service 层 :1617 调用，拦 conversation/fork/worktree） vs `rejectUnsupportedTaskShapes`（zcode 引擎层 :227 调用，拦 fork/conversation/maxTurns） | **是**：worktree 跨域缺口——chat 域 zcode 被拦、workflow 域 zcode 漏拦（SAR 不调前者）；maxTurns 为 pi 已支持能力（两域都不拦） | capabilities 驱动单点化于引擎边界（每引擎拦「自己不支持的能力」） |
| 8 | TUI format | `interface/format.ts`(541，有小时分支) vs `interface/views/format.ts`(320，无小时分支) | **是**：同名函数两份定义且已分叉——WorkflowsView/detail-content 只消费 views 版，>1h 显示 `75m30s` 而非 `1h15m`；interface 版的小时分支无人惠及 views 消费面 | 删 views 版：ThemeLike 等 5 构件单定义 |
| 9 | 资源清单 injector | `subagent-list-injector.ts`(263) vs `workflow-list-injector.ts`(227)：缓存对/唯一写点/发现函数/格式化/三 handler 逐字同构 | 否（尚未漂，但改 fallback 策略要同步两处） | 参数化工厂，~150 行消失 |
| 10 | 嵌套防护 | `subagent-service.ts:681`（execCtxAls，pi 路径） vs `engine/common/nesting-guard.ts`（仅 zcode 用） | 否 | 合一为公共层单点 |

**假兑现（代码在、语义不执行）**：

| # | 机制 | 证据 |
|---|------|------|
| A | pool-manager 池引用计数（设计 §3.3.9 refs.json 方案） | `pool-manager.ts` 226 行零生产调用；refs.json 文件形态未落地（:9 注释自认）；preparer :318 直接 `resolvePoolDir` 建目录不经 acquire——隔离池（含 db.sqlite 的隔离 HOME）只增不减 |
| B | EnginePort.read / interact 能力面 | 全仓生产调用方零命中（rg 实证）；pi 的交互走 `deliverMessage` 直调 `sendPromptCommand`（pi RPC stdin 协议知识在编排层 deliverMessage :981 / sendPromptCommand :992），不经 `engine.interact` |
| C | 壳导出 `formatSubagentStatusSnapshot` | index.ts:127，零生产消费者（注入 hook 已删，L111 注释自认），函数连同其测试属死代码 |

**测试拓扑的投影**（interface 过宽的间接证据，计数为 rg -l 口径）：mock temp-prompt ≈20 个测试文件（spawn 链叶子硬编码 import 所致）；整类 mock `SubagentService` ×7 文件（走查计数，实施期复核）；`session-start-reaper.test.ts` 单文件 12 个 vi.mock（被测 reaper 逻辑内联于壳 index.ts 装配，无同名源文件）；mock alive-store ≈21 处。seam 位置正确的对照组：`child_process` mock ×24 且有共享 `spawn-mock.ts` helper。

### 2.3 根因

**首句结论**：两轮重构都正确地采用了「先回填/先抽离、行为零回归」策略，但策略里「旧轨何时退出」没有 owner 和触发条件——风险隔离形态从临时措施固化成了终态。

具体到两条主线：

1. **pi 回填选择了「盖壳」而非「下沉」**（engine-abstraction P1）。当时为保「40+ 测试 import 路径零变化」，PiEngine 盖在 `SubagentService.executeAndAwait` 上而非 spawn 链上。后果是结构性的：chat 域永远走不到 EnginePort（PiEngine.run 只在 workflow 域经 SAR 可达），interact/read 两面天然悬空，双轨清单 #2/#5/#6/#7/#10 全是这一选择的下游。
2. **core 抽包后 runtime 副本的删除理由失效但没人删**（extraction P0 端口化之后）。runtime 手写 reducer 的注释理由是「import core 会连带 pi-extension-logger 进 bundle」——P0 端口化后 core 依赖闭包已无 pi 包（`journal-replay.ts` 闭包 = node 内置 + `core/logger.ts` 端口），防线已上移，副本的存在理由消失，但没有触发删除动作。

### 2.4 物理数据流（现状，双轨标注）

```
【派发路径（双轨）】
chat 域：模型调 subagent 工具
  → subagent-tool.ts → subagent-actions.ts → SubagentService.execute()
  → [pi] kickOffBackground → runAndFinalize → session-runner.runSpawn → spawn pi 子进程   ← 旧轨（pi 唯一生产路径）
  → [zcode] executeViaEngine → EnginePort.run → ZcodeEngine（preparer→launcher→parser）     ← 新轨
workflow 域：脚本 agent() 调用
  → worker agent-call 消息 → SubprocessAgentRunner.run()
  → routeEngine → EnginePort.run → {PiEngine→委托回 Service 旧轨 | ZcodeEngine}

【GUI 历史读取路径（双轨，生产走无守护副本）】
journal 文件：<dataRoot>/engines/<engineId>/<poolKey>/journal-<taskId>.jsonl
  → core 链：EnginePort.read() → ①引擎原生 reader → ②journal-replay（8 事件，C5 守护）→ ③outcome-only
       └─ 生产零调用（死通路）
  → runtime 链（生产唯一通路）：session-service.ts:1071 → subagent-engine-history.ts
       → ①readZcodeNativeTier（引擎 id 硬编码 :130）→ ②手写 journal reducer（7 事件，message_end error 不记账，零测试）→ ③outcome-only
       → Message[] → WebSocket → GUI 详情页
```

## 3. 解决方案

**首句结论**：按用户已裁决的 3 组依赖序执行 8 项收敛；方案层的真实分叉点只有三个（C2 是否重开 P1「不物理移动」决策、C8 池生命周期接线还是删除、C1 收敛形态），逐一在 §3.3 做方案对比，其余候选的最优形态无争议直接给出决策。

### 3.1 终态（使用者视角先行）

**终态一：GUI 历史详情有守护且语义 engine-generic。** 用户打开任何引擎子代理的历史详情：内容语义与 core 守护实现一致——对现役 zcode 为内容 parity（其生产流本就无可观察差异），message_end 携带 error 的记账语义随守护实现就位，未来 parser 演进或新引擎接入产出该形态时正确生效；读取通路 = core 单一实现（runtime 薄调用）。runtime 侧不再存在「引擎 id 硬编码分支」——接入第三个引擎时 runtime 零改动。

**终态二：每个概念一个写点。** 开发者改杀链：只改 `engine/common/kill-chain.ts`，pi/zcode/未来引擎同时生效（grace 窗口作为参数，pi 传 30s 保持现状行为，zcode 传 5s；timer unref 语义与 SIGKILL 升级 warn 留痕也随 grace 一并按引擎参数化——**一致性审查 r1 补充：A1 零回归要求的两个设计未点名维度**）；改 TUI 时间格式：只改 `interface/format.ts`；改资源清单注入策略：只改 injector 工厂。

**终态三：pi 与 zcode 同形。** 新开发者理解任意引擎执行：`engines/<id>/` 四件套 + capabilities 声明就是全部入口。`SubagentService` 只剩编排核（execute / record 生命周期 / cancel），interface 从 27 个 public 方法收窄到 ~10 个。

**终态四：缺省路径一次映射。** workflow 派 pi 子代理：`AgentCallOpts`（与 AgentTaskSpec 合流后的中立形状）→ pi 边界一次映射为 spawn 参数。两个 mapper 文件与其往返保真测试被删除。

**终态五：机制无假兑现。** pool-manager 要么接线（池目录有界），要么删除且设计文档 §3.3.9 同步修订为「preparer 幂等重建即清理语义」；`formatSubagentStatusSnapshot` 死代码删除；EnginePort.read 的实现获得生产复用——复用形态为 module 级（runtime 薄调用复用同一 reader/journal-replay module），port 面由 conformance 守护（「经 port 面生产调用」被 D1 被否②自己封死：runtime 跨进程不可达 pi 进程内 EnginePort，module 级复用是唯一可行路径——**一致性审查 r1 修正，2026-09-03**）。

**失败路径（均带恢复指引）**：

- 迁移中途某步测试红：每组内部按单元提交（见 §5），回退粒度 = 单 commit；C2 的物理迁移是单 commit 机械 rename + import 更新，回退即 revert。
- C2 迁移后 pi 行为回归：A1 零回归口径守护（§4 V4 record entry 快照 diff）；若 diff 不可消，降级路径 = 保留 `execution/session-runner.ts` 旧路径 re-export shim 一个 PR 周期（双轨过渡期显式登记，下个小版本删 shim）。
- runtime 切换 core 读取模块后出现未知字段解析问题：③级 outcome-only 降级语义不变（已有兜底），用户看到摘要卡而非报错；恢复 = `git revert` runtime 侧薄调用即可回到手写副本（副本删除与切换分两 commit）。

### 3.2 方案对比（整体执行策略）

| | 方案 A：8 候选各自独立 PR | 方案 B：3 组依赖序收敛（推荐） | 方案 C：单一大重构分支 |
|---|---|---|---|
| 形态 | 每个候选独立分支独立合入 | 组 1（独立清理）先行；组 2（execution 主轴 C2→C5→C6 严格串行）；组 3（orchestration C7→C3）与组 2 并行 | 全部改动一个分支一次合入 |
| 长期架构合理性 | 中：无视依赖——C5/C6 在 C2 之前做会把「归一到哪」落在旧轨上，做完即返工 | 好：依赖方向（C2 是 C5/C6 上游）显式化；每组完成即是一个自洽的架构状态 | 中：终态同 B，但中间状态长期半双轨 |
| 短期实现成本 | 表面最低，实际最高（C5 归一到旧轨 → C2 后再归一一次，付两次） | 中：组内顺序消除返工 | 最低（一次性） |
| 风险 | 低 per PR，但总回归面最大（同一文件多轮改） | 中：每组独立验收（§4），回退粒度单 commit | 最高：数千行迁移 + 行为变化混在一个 diff，回归定位难 |
| 若用它，§2 例子会怎样 | 例二的杀链：先归一到 session-runner（C5 先行），C2 迁移时又重写一遍 | 例二：C2 下沉后归一到 kill-chain，一次到位 | 同 B 终态，但中途任何一处回归都阻塞全部 8 项 |

**推荐方案 B**（用户已裁决分 3 组，此处给出论证闭环）。

### 3.3 关键决策与权衡

**D1（组 1 / C1）：journal 读取链收敛为 core 单一 module，runtime 删手写副本（选定）**

- **采用**：core 新增 `engine/common/session-view-service.ts`（或等价命名）纯函数 module，收敛三段：①三级降级链编排（原生 reader → journal 重放 → outcome-only）②`SessionView → Message[]` 投影（现 runtime 手写版的那半份）③引擎分发（reader registry 查表取代 `subagent-engine-history.ts:130` 的 `if (engine === ZCODE_ENGINE_ID)` 硬编码）。runtime 改为薄调用 + 删除手写 reducer（`applyJournalEvent` 等 ~150 行）与 `projectEngineHandle`（subagent-extractor.ts:137）/`extractRecordEngineHandle`（subagent-engine-history.ts:69）双守卫之一（收敛为 core 单一 guard）。pi 分支维持现状（runtime 走自己的 JSONL 直读链，A1 守护），本决策只统一 journal/引擎原生读取通路。**范围声明**：本决策不新增 compaction GUI 可见性——core 的 compaction 分支是刻意 no-op（execution-record.ts:403「不产生数据（不变）」），收敛后该维度行为与现状等价。**收益口径（r2 审查钉正）**：收敛收益 = 守护对称（生产路径从零测试副本切到 C5 conformance 守护实现）+ engine-generic 正确性（message_end+error 记账语义就位）——**对现役 zcode 无可观察行为变化**（该形态 zcode 生产不产出：parser 合成仅带 usage、错误走独立 error 事件且 runtime `applyErrorEvent` :330 已处理；pi 侧虽有该形态但其历史不经此链），不声称修复用户可见缺陷。compaction surfacing 属新增行为（updateFromEvent 记账 + 投影 + Message 映射三处新代码），记入 out-of-scope 待独立评估。
- **被否**：①保留 runtime 副本、把 error 记账分支补上并加测试——两份实现继续各自演进，漂移只是时间问题（§2.2 #1 的漂移就是这么来的）；②runtime 经 RPC 回调 pi 进程内的 EnginePort.read()——跨进程来回一跳且把读历史变成依赖 pi 进程存活，休止 session 的历史读取（runtime 独立直读是既有能力）会退化；③「收敛顺带让 GUI 显示 compaction」——击穿反例：core compaction 分支为刻意 no-op（:403）、zcode journal 与 reader 全文零 compaction，收敛后无任何一层能产出 compaction 数据，该收益不存在（被否谱系：审查 r1 击穿，MF2）。
- **证据**：§2.2 #1（行为分叉 + bundle 理由失效 + 守护不对称三重实证，applyJournalEvent 7 case / core message_end error 记账均经审查 r1 实读核实）；explorer 实测 core 侧闭包无 pi 依赖（`journal-replay.ts` 闭包 = node 内置 + `core/logger.ts` 端口，`subagent-core/package.json` dependencies 无 pi 包）；⛔ 实施期门：①迁移前复核 `session-view-service` 完整依赖闭包（含 SessionView→Message 投影所需的类型）仍无 pi 包——若投影层牵连 runtime 侧 Message 类型，降级路径 = 投影留在 runtime、只上移「降级链编排 + journal 重放」，runtime 删除范围相应收窄；②message_end 含 error 的 journal 样本从现有 golden 库确认可得，缺则补录——用途限定为 V1③ 的回归校验（守护链对该形态的记账正确性），非生产可达路径的验收证据（该形态 zcode 生产不产出，见范围声明）。
- **效果**：目标 1/2 成立；C5 conformance 覆盖生产路径；新引擎接入 runtime 零改动（终态一）。

**D2（组 2 / C2）：pi 执行轨物理下沉 engines/pi/，Service 收敛单轨——重开 P1「不物理移动」决策（选定）**

- **采用**：`session-runner.ts` / `pi-invocation.ts` / `stdin-writer.ts` / `spawn-event-adapter.ts` / `get-state-handshake.ts` / `output-collector.ts` / `temp-prompt.ts` / `argv-mirror.ts` / `turn-limiter.ts` 九件物理移入 `execution/engine/engines/pi/`（rename 级成本）；`PiEngine` 持有四件套并原生实现 `interact`（吸收 `deliverMessage`/`resumeRound` 的 pi 协议知识）；`SubagentService` 删除 `kickOffBackground` 旧轨，chat 域与 workflow 域统一经 EnginePort——chat 域入口 `executeViaEngine`、workflow 域入口 SAR（两入口见 §3.5 终态图；**一致性审查 r1 措辞修正：原文「统一走 executeViaEngine」与 §3.5 及实现矛盾，统一的是「经 EnginePort」而非单一入口函数**）。迁移形态：**单 commit 机械 rename + 同 commit 全量更新 import（含 40+ 测试文件），不留 re-export shim**——shim 即新双轨，违反本设计根因。
- **重开 P1 决策的论证**：P1「不物理移动」是回填期的回归隔离策略（保测试 import 路径零变化），其代价当时未知、现已实证——§2.2 #2/#5/#6/#7/#10 五对双轨全部是该选择的下游，interact/read 两面因此悬空。触发条件已满足：zcode 引擎已全量落地 + conformance 套件转绿（P4 完成），EnginePort seam 已被一个深 adapter 验证；继续保留旧轨的每日成本（双写点漂移）已超过一次性迁移成本。
- **被否**：①维持双轨 + 文档声明「旧轨冻龄」——冻龄无机器约束，§2.3 根因一已证明人工纪律守不住；②只删 PiEngine 壳、让 Service 旧轨合法化——放弃多引擎对 chat 域的覆盖，EnginePort 退化为 workflow 专用接口，与 engine-abstraction §3.3.1 的终态图矛盾；③渐进迁移（先移文件留 shim 分两 PR）——中间态即双轨，本设计的根因就是中间态无退出机制。
- **证据**：§2.2 #2（双轨证据与九件合计 ≈3079 / PiEngine 415 行数对比）；pi-engine.ts 文件头自认「不物理移动」；⛔ 实施期门：①迁移对 pi builtin staged 打包的影响核对——extension 经 esbuild bundle 为单文件 staged，预期零影响，实施期跑 `bash scripts/validate-runtime-bundle.sh` + 打包产物探针实证；②`engines/pi/reader.ts` 仅被 PiEngine.read 消费（pi-engine.ts:41 import readPiSessionView），而 read 生产零调用（runtime pi 历史走自有 JSONL 链）——迁移时一并裁决：删除或标注保留理由，不新增第三个 SessionView 装配实现。探针失败的降级路径见 §3.1 失败路径第二条。
- **效果**：目标 3 成立；C5（D4）与 C6（D5）的归一/拆分获得落点；interact/read 面获得生产调用方。

**D3（组 2 / C5）：引擎无关件五对归一（选定）**

- **采用**：①杀链合一——`kill-chain.ts` 为唯一实现，grace 窗口参数化（pi 传 30s 保持行为不变、zcode 传 5s），`killChildWithEscalation` 删除；②路由单点——`routing.ts` 收敛为唯一实现，Service 与 SAR 两调用点（SAR 的 pi 短路 + registry 注入并入）；③journal 接线提为 host 共享 helper（writer+retarget+handle 回填一处）；④预检单点化于引擎边界——capabilities 驱动：每个引擎拦截「自己 capabilities 声明不支持的能力」（pi 不拦 maxTurns——那是 pi 的已支持能力（engine/types.ts:93），由 turn-limiter 执行；zcode 继续拦 fork/conversation/maxTurns），并把 worktree 检查补进 SAR 路径（修复 §2.2 #7 的 workflow 域 zcode 漏拦缺口），`assertEngineParamSupport` 删除。**检查点位置钉死（r2 审查补充）**：单点的是拦截实现（capabilities 驱动 module），调用点仍是两处——chat 域保持在 `execute/executeViaEngine` 同步段、record 创建前（engine.capabilities() 同步可得），承接现行不变量「全部同步拒绝发生在 record 创建前、不产生孤儿 record」（executeViaEngine :1606-1609 注释自认；其后的 `kickOffEngineRun` 为 fire-and-forget :1679，检查若只落在 engine.run 内则拒绝异步化为「派发成功 + 静默失败 record」）；SAR 路径在 run 前同模块调用。**maxTurns 实施形态裁定（r3 审查补充）**：给 `EngineCapabilities` 新增 `maxTurns` 能力位（pi=true、zcode=false）——现状 11 个能力位无可承载 maxTurns 的语义位，若 zcode 侧保留 `rejectUnsupportedTaskShapes` 的硬编码 shape 检查则拦截逻辑重回两套（位驱动 + 引擎内 shape 检查），重演双轨根因，故扩位而非保留硬编码（types.ts :88-95 已注明 maxTurns 与 fork 同为「其他引擎 prepare 期显式拒绝」模式）。**fork 判据实施修正（u-2b 实施期发现）**：原「fork 拦截借 caps.steer 判」不可照抄——pi 的 steer 声明 'unsupported'（RPC 通道有、spawn 链路未接通），纯 steer 判会误拦 pi fork、违反 V4⑤ 反向守护；实现为「session 分叉通道族任一可用即放行」（steer **或** conversation 非 unsupported），两引擎行为矩阵与验收完全一致（pi 放行 / zcode 拦截），裁定理由见 capability-gate.ts 模块注释；⑤嵌套防护合一（公共层 `nesting-guard` 单点，pi 的 execCtxAls 路径并入）。**行为变化声明**：唯一行为变化是④的 workflow 域 zcode+worktree 由漏拦变拦截（修真实缺口，有意修正）；pi 的 maxTurns 等既有合法能力不受任何影响（§4 V4④⑤ 正反向验收）。
- **被否**：①「逐对各自评估去留」拆开决策——五对的根因同一（pi 旧轨未退出），拆开评估会在每对上重复同样的论证；合成一条决策、五个执行项；②「预检取两处拦截面的并集（maxTurns 与 worktree 都拦）」——击穿反例：maxTurns 是 pi 已支持参数（engine/types.ts:93「pi 引擎专属」），并集拦截 = 拒绝 pi 既有合法能力，属回归（被否谱系：审查 r1 击穿，MF1）；正确机制是 capabilities 驱动的 per-engine 拦截。
- **证据**：§2.2 #4/#5/#6/#7/#10 行号；⛔ 实施期门：pi SIGTERM 优雅退出时序实测（A10 杀链 grace 窗口取值的既有依据），确认统一实现下 pi 传 30s 的语义与现状逐字节一致。
- **效果**：目标 2 对执行层成立；同引擎跨域行为一致。

**D4（组 2 / C6）：SubagentService 按变化轴拆分（选定，排在 D2/D3 后执行）**

- **采用**：D2/D3 完成后剥离四块：①通知簇（`notifyComplete/notifyClosed/piAdapter/toNotifyRecord` :557-659）→ notifier 的 host 面；②`onRoundSettled` 95 行业务闭包（:2163-2258）→ 独立轮次结算 module；③冷路径 resurrect 四件（:1130-1249）→ record-store 邻接 module；④UI 请求/对话队列接线 → 壳侧装配点。Service 保留编排核：execute/executeAndAwait 入口、record 生命周期、cancel。目标 interface ≈10 public 方法。
- **被否**：按「方法数量平均切半」机械拆分——拆分轴是变化轴（§2 谁改什么）不是体积；也否决「不拆」——27 public 方法的 interface 宽度已由测试拓扑投影实证（整类 mock ×7）。
- **证据**：§2.1 例二；explorer 走查的 14 职责轴清单。
- **效果**：测试可按轴构造；interface 收窄即 leverage 提升。

**D5（组 3 / C7）：workflow 运行收尾单点化 + 错误分诊结构化（选定）**

- **采用**：①`orchestration/error-recovery.ts` 更名/拆分为 `worker-message-pump.ts`（名实相符：它承载消息路由 + IPC 序列化防御 + retry/重建 + 终态化四类职责，「error-recovery」名下找消息路由必漏）；②「transition → save → pending:unregister → onRunDone」四步终态 coda（8 处逐字复制：error-recovery ×6、lifecycle ×2）收敛为 `finalizeRun(run, deps, {notifyDone?})` 单写点——`terminateRunningRuns` 不发 onRunDone 的真差异用参数承载；③跨层错误分诊结构化：`AgentResult` 增加 `failureKind` 字段（`stale_context` / `schema_deterministic` / `unknown`），产出侧（`execution/engine/engines/pi/output-collector.ts`，u-2a 下沉后位置）识别 pi 错误文案后写字段，消费侧（execute-agent-call）读字段分诊，删除 execute-agent-call 侧的子串分诊表（:60-74）与 `DETERMINISTIC_SCHEMA_FAILURE_PREFIX` 字面量消费。**语义守恒**：`unknown`（含缺省）= 可重试——保持现行默认重试语义（execute-agent-call:240「可重试失败：退避后递归」），仅 stale_context（不重试、换参重发）与 schema_deterministic 维持特判。**词表归属声明**：`STALE_CONTEXT_PATTERNS` 表本身保留在产出侧 output-collector（其 :96 neutralizeStalePatterns 服务用户可见错误文本的中和，与分诊无关）——文案词表依存并未消除，而是从「跨模块消费 seam」收窄为「产出侧包内单点识别」；词表漂移的失效模式是 `failureKind=unknown` → 保守重试（安全默认），不再是静默漏诊。
- **被否**：①保留文案匹配 + 加固交叉锁定测试——把脆弱性锁进测试不等于消除脆弱性，pi 升级时红的是测试、断的是生产分诊；structured-output 方案 A 的教训（校验权威唯一）同构适用于分诊权威——分诊依据必须是结构化数据不是文案；②「缺省/未知 failureKind = 不重试（保守处理）」——击穿反例：现行语义是默认重试（:240），反转后瞬态 provider 错误、spawn 失败等一切未标注路径将静默丢失重试（被否谱系：审查 r1 击穿，MF4）；正确机制是 unknown = 可重试。
- **证据**：§2.2 表外走查发现（error-recovery.ts L240-251/L573-595/L807-815/L864-872/L912-918/L973-980 六处 + lifecycle.ts L337-345/L388-391 两处）；execute-agent-call.ts:59-64/:97。
- **效果**：新增终态路径不再靠人工复制第 9 份；pi 升级敏感面消除一处。

**D6（组 3 / C3）：任务形状合流，缺省路径一次映射（选定）**

- **采用**：`AgentCallOpts`（orchestration，18 字段）与 `AgentTaskSpec`（engine 中立）合流——orchestration 直产 TaskSpec，删 `execute-options-mapper.ts`；pi 边界内 `taskSpecToExecuteOptions`（pi-engine.ts:203）替换为 `agentCallToExecuteOptions`——合流形状 `AgentCallOpts` → `ExecuteOptions`（spawn 编排参数集）一次性直出映射，消除 AgentTaskSpec 中间态与第二次映射（**一致性审查 r1 措辞修正：原「TaskSpec → pi spawn 参数（不还原 ExecuteOptions 中间态）」易误读为 pi 边界不再出现 ExecuteOptions；实际消除的是 AgentTaskSpec 往返与第二次映射，ExecuteOptions 按 D6 被否①保留为 Service 内部编排形状**），删 `engines/pi/task-spec-mapper.ts` 与往返保真测试。`ExecuteOptions` 类型本身保留——它是 SubagentService 内部编排形状（record 投影/轮次结算消费），本决策消除的是 SAR 链路上的中间态，不是类型本身。
- **被否**：①彻底删除 ExecuteOptions（Service 内部也改吃 TaskSpec）——Service 的 record 投影/chatMode 编排深度耦合 ExecuteOptions 字段，改动面从「删两个 mapper」膨胀为「重写 Service 编排」，ROI 不成立（准则 8：先做减法里最小的）；②维持往返 + 文档化——税照付，字段演进仍三点同步。
- **证据**：§2.1 例三（三形态四映射链）；⛔ 实施期门：字段完整性清单——从两个 mapper 现有测试提取字段全集作对照表，新单映射按表逐字段核对。
- **效果**：目标 4 成立；删除 2 个 mapper module + 1 套保真测试。

**D7（组 1 / C4）：壳内双轨合并（选定）**

- **采用**：①`interface/views/format.ts` 并入 `interface/format.ts`——workflow 特有的 badge/phase 函数作差异段保留，`formatElapsedSeconds` 以有小时分支版为准（修掉 WorkflowsView 的 `75m30s` 漂移），`ThemeLike` 单定义；②两个资源清单 injector 合并为 `createResourceListInjector({kind, parse, format, includeTmp})` 工厂——真差异（agent 的 frontmatter 解析失败 warn、workflow 的 description 截断、guide 文案）参数化承载；`model-list-injector` 不参与合并（数据源是 ModelRegistry 内存快照，真差异）；③删 `formatSubagentStatusSnapshot` 连同其测试文件；④engine-awareness 的 before_agent_start 接线从 index.ts 内联第 4 处收进统一 setup 函数，注入链序不再靠注释维护。
- **被否**：保留双 format 但同步小时分支——双轨清单 #8/#9 证明「同步维护」即漂移温床；本组全部改动纯壳内，零跨包风险。
- **证据**：§2.2 #8/#9（含漂移实证与交叉 import 证据）；§2.2 假兑现 C。
- **效果**：目标 2 对壳成立；~150 行同构 + 死代码消失。

**D8（组 1 / C8）：池生命周期——接线完成 D5 语义，而非删除（选定）**

- **采用（方向 A，分域接线）**：接线 pool-manager——preparer 建池前 `acquirePool(taskId)`、record GC/删除时 `releasePoolRef(taskId)` 并删对应 journal、refs.json 文件形态落地（进程重启后计数可恢复）、计数归零删池内引擎原生状态（journal 除外）、清理失败置 `.cleanup-failed` 标记。语义全部沿用 engine-abstraction §3.3.9 的既定设计，本决策不新造规则，只接线。**分域口径（id 键现状）**：chat 域 taskId = record.id（runEngineTask 成立）直接接线；workflow 域 taskId 是 `sa-${randomUUID}` 占位（SAR :167-174 注释自认，P4 决策保留占位，「record GC 时无法按 taskId 联动删 journal」）——workflow 域接线以前置门为条件： taskId↔record id 打通影响面评估（是否需改 createRecordForMode 签名或 hook record store），评估为「浅」（纯 SAR 内部可解）则接线，「深」（改签名/外露 record id）则 workflow 域显式声明维持 TTL 回收现状并登记于本文档，不强行接线。**实施期门裁决记录（u-1c，2026-09-02）**：门①触发点盘点 6 项归并两类语义（archive 保留类 / 文件 TTL 类），真删除锚点 ≤2，未触发降级；门②判深——SAR 注释自认打通需 hook record store 且改 createRecordForMode 签名，直接命中判深判据，workflow 域 SAR 零改动、显式维持 TTL 回收。**事实修正（doc_error，实施期发现）**：本决策原文称「journal 现依赖 30 天 TTL 自然回收」——该表述在实施前是假许诺（session-file-gc 只扫 `subagents/` 目录树，`engines/` 根不在任何扫描范围，journal 原本无任何回收路径）；u-1c 以 `cleanupExpiredPoolRefs` 将该 TTL 真正落地后，workflow 域 journal/refs 条目由兜底覆盖，TTL 回收方为事实。
- **被否（方向 B）**：删除 pool-manager（-226 行）+ 修订设计文档为「preparer 幂等重建即清理语义」——理由：隔离池含 db.sqlite 与凭据 config，只增不减是用户磁盘的真实累积（agent 种类 × 引擎数增长），且模块代码 + 测试已写好，删除等于废弃已验证资产并把设计文档的许诺改为「不兑现」。若实施期发现 release 接线面牵连 record GC 生命周期过深，降级为方向 B 并在设计文档标注降级理由。⛔ 实施期门两条（任一判深即触发降级评估）：①record GC 全部触发点盘点（disposeAllRecords / session-start-reaper（逻辑内联于壳 index.ts 装配）/ 用户删除 record，≥3 处且语义各异则降级）；②workflow 域 taskId↔record id 打通影响面评估（改 createRecordForMode 签名 / hook record store 即判深——该 id 键不通是 P4 明确暂缓项，是方向 A 最大的已知阻塞，比触发点盘点更可能触发降级）。
- **证据**：§2.2 假兑现 A（零调用 rg 实证 + refs.json 未落地自认）。
- **效果**：目标 5 成立；池目录有界。

### 3.4 错误规格与行为变化（每类配恢复指引）

| 变化 | 触发 | 用户/模型可见行为 | 恢复指引 |
|------|------|------------------|---------|
| 预检 capabilities 化（D3-④） | workflow 域派 zcode 子代理带 worktree（原漏拦） | 模型收到 `engine_capability_unsupported` 结构化错误（既有错误族），不创建进程——漏拦缺口修复；chat 域保持 record 创建前同步拒绝（现行「不产生孤儿 record」不变量承接，检查点位置见 D3-④ 钉死）——**u-2b 实施期声明（拒绝时点前移）**：chat 域 zcode+maxTurns 旧形态为 record 创建后 engine.run 内异步拒绝（failed record + background 句柄），新形态为 record 创建前同步 throw——拒绝事实本身不变（旧也拒绝），时点与可见形态前移是「检查点钉死」的直接结果（V4④ 与⑤对称验收）；多违规参数组合首报顺序统一 conversation→fork→maxTurns→worktree（纯文案维度）；pi 的 maxTurns 等既有能力不受影响 | 错误文案含可操作指引（换参数/换引擎），与既有 D11 处置一致 |
| runtime 读取切换（D1） | core 模块解析失败/未知字段 | 降级③级 outcome-only 摘要卡（既有兜底），不白屏不弹错 | runtime 日志含 core 模块错误详情；revert runtime 薄调用 commit 回手写副本 |
| 杀链统一（D3-①） | 无（pi 传 30s 参数保持现状，zcode 传 5s 保持现状） | 无行为变化 | —（A1 守护，V4 验收快照 diff） |
| C2 物理迁移 | import 路径全量更新 | 无运行时行为变化 | staged 打包探针（§4 V4 ④）；回归即 revert 单 commit |
| failureKind 结构化（D5-③） | 进程内契约（output-collector → execute-agent-call 同包内） | 无跨进程兼容面；分诊读结构化字段，词表漂移失效模式 = unknown → 保守重试（非静默漏诊） | 若产出侧遗漏写 failureKind：缺省 = unknown = 可重试，与现行默认重试语义一致，无行为回退 |

### 3.5 物理数据流（终态）

```
【派发路径（单轨）】
chat 域 → SubagentService.execute → executeViaEngine（chat 域唯一入口；capabilities 预检在 record 创建前同步段——D3-④ 位置钉死）
workflow 域 → SubprocessAgentRunner.run()（SAR，第二预检调用点，run 前同模块调用）
  → routing.ts（唯一路由实现，两调用点）
  → EnginePort.run
      ├─ engines/pi/   launcher(session-runner 下沉) + parser(spawn-event-adapter) + preparer + reader
      │                 ↑ interact 原生实现（deliverMessage/resumeRound 协议知识下沉）
      └─ engines/zcode/ （现状不变）
  → 公共层：kill-chain（唯一杀链，grace 参数化）/ nesting-guard（唯一防护）/ journal helper（唯一接线）
  → pool-manager：preparer acquire → record GC release → refs.json → 计数归零删池（chat 域；workflow 域过 id 前置门前维持 TTL 回收，分域口径见 D8）

【GUI 历史读取路径（单实现）】
journal / 引擎原生存储
  → core session-view-service（降级链编排 + 重放 + 投影 + reader registry 分发）
      ├─ extension 内 EnginePort.read() 复用同一 module
      └─ runtime 薄调用（workspace 依赖，无引擎 id 硬编码）
  → Message[] → WebSocket → GUI 详情页
  （pi 主会话历史：runtime 自有 JSONL 直读链，不变）
```

## 4. 验收

**首句结论**：大改动多场景——每组至少一个真实环境验收场景（`pnpm dev` + 真实 pi/zcode CLI + 真实模型调用），全部回溯 §1 目标；测试基线（extensions 三连 + subagent-core / runtime vitest 全绿）是每个场景的公共前提，不单列。

| # | 场景 | 步骤 | 通过标准 | 回溯 |
|---|------|------|---------|------|
| V1 | journal 读取收敛：生产路径切换 + 守护对称（组1/D1） | ①迁移前采集基线：dev 下真实 zcode 引擎跑一个完整子代理任务，保存 GUI 历史详情渲染对照（截图/DOM）；②迁移后重跑同任务并打开详情页；③确定性故障注入（定位为回归校验项，非生产可达路径——该形态 zcode 生产不产出，见 D1 收益口径）：构造 message_end 含 error 字段的 journal 样本（golden fixture 注入——仅构造数据形态，读取链全真）经 core 守护链读取；④代码断言 | ②与基线渲染等价（内容 parity——目标 1 的主验收证据）；③core 守护链对该样本正确记账 error（守护实现的回归校验）；④runtime 手写 reducer 文件删除、`subagent-engine-history.ts` 无 `ZCODE_ENGINE_ID` 硬编码分支（原 :130）、core `session-view-service` 闭包复核无 pi 包 | 目标 1/2 |
| V2 | 壳内合并后 TUI 行为正确（组1/D7） | ①dev 下跑一个 workflow（或注入伪造时长的 record——仅构造数据形态，渲染链全真）使 WorkflowsView 显示 >1h 时长；②触发 before_agent_start，检查注入的 agent 清单与 workflow 清单 | ①显示 `1h15m` 形态而非 `75m30s`；②两份清单内容完整、缓存生效（二次触发无重复扫描日志）；views/format.ts 文件不存在 | 目标 2 |
| V3 | 池生命周期接线生效——chat 域（组1/D8） | dev 下 chat 域派一个 zcode 子代理 → 检查 `<dataRoot>/engines/zcode/<poolKey>/`；删除该子代理 record | 任务启动后 refs.json 含该 taskId（chat 域 taskId=record.id，acquire 即时）；record 删除后引用与 journal 的回收走兜底路径——idle-GC 30 天归档或 pool TTL（`cleanupExpiredPoolRefs`），手动/关闭类删除属 archive 保留语义不即时释放（依据 D8 门①裁决：disposeAllRecords/user-close 归并 archive 保留类，真删除锚点 ≤2 未触发即时接线）；workflow 域按 D8 分域口径验收（门②判深，显式维持 TTL 回收——**一致性审查 r1 同步：原「引用归零/journal 随 record 删除」的即时回收口径与 u-1c 固化裁决不一致**） | 目标 5 |
| V4 | pi 零回归 + 单轨化（组2/D2/D3） | ①采集基线后迁移：chat 域派 pi 子代理（带 schema 任务）+ 一个多步 workflow，record entry JSON 快照与基线 diff（volatile 字段白名单归一：timestamps / record id / sessionFile 路径 / runId 允许不同，其余字段级一致）；②GUI 四视图（对话流/工具面板/record 详情/WorkflowsView）与基线一致；③`pnpm run build` 打包 + `validate-runtime-bundle.sh`；④workflow 域派 zcode 子代理带 worktree + chat 域派 zcode 子代理带 worktree + 任一域派 zcode 子代理带 maxTurns；⑤chat 域派 pi 子代理带 maxTurns=3 | ①快照 diff 仅白名单字段；②视图一致；③打包双验证 exit 0；④worktree 两域均收到 `engine_capability_unsupported` 且无进程创建（漏拦缺口修复的正向验收），chat 域 `subagent` 工具调用**立即同步返回错误而非 background 模式句柄**（「同步」的观察特征——异步化回归的形态是先 background 成功、稍后 failed record），GUI 子代理列表与 record store 均无该次调用的新增条目（「无孤儿 record」断言落点），zcode+maxTurns 同步拦截（现状行为保持的正向守护，与⑤对称）；⑤正常执行、无拦截（反向验收：pi 既有合法能力无回归）；rg 无 `kickOffBackground` 残留 | 目标 2/3（A1 守护） |
| V5 | workflow 收尾单点（组3/D5） | dev 下跑真实 workflow：①正常完成路径；②构造 budget_limited 路径（小预算）；③注入 stale-context 错误（mock 模型返回陈旧上下文错误——确定性故障注入，执行链全真）；④注入瞬态错误（模拟 provider 5xx） | ①②两路径的 run 终态四步各执行恰好一次（store 状态 + pending 计数核对）；③execute-agent-call 按 `failureKind=stale_context` 分诊（换参重发、不退避重试）；④按默认语义退避重试（unknown = 可重试，现行语义守恒） | 目标 2 |
| V6 | 任务形状单映射（组3/D6） | dev 下 workflow 派带 schema + model + maxTurns 的 pi 子代理 | 子代理行为与迁移前一致（record 字段级一致）；两个 mapper 文件与往返保真测试已删除；字段完整性对照表（实施期门产物）逐项核对通过 | 目标 4 |

## 5. 下一层拆分

**首句结论**：3 组 8 单元；组 1 内部三项可任意序、组 2 严格串行、组 3 两项串行；组 2 与组 3 可并行，唯一文件交叠（`subprocess-agent-runner.ts`，D3-② 与 D6 都碰）到时错开或串行。

| 组 | 单元 | 内容 | justification / 验收挂钩 |
|----|------|------|--------------------------|
| 1 | 1a | D1 journal 读取链收敛（core session-view-service + runtime 薄调用 + 删副本 + 去 id 硬编码） | 切换生产读取通路、正确性敏感度最高（守护对称收益，见 D1 收益口径），零依赖先行；验收 V1 |
| 1 | 1b | D7 壳内合并（format / injector 工厂 / 死代码 / engine-awareness 接线） | 纯壳内零跨包风险；验收 V2 |
| 1 | 1c | D8 pool-manager 接线（chat 域先行 + refs.json；workflow 域过 id 门后定） | 需先过实施期门（GC 触发点盘点 + taskId↔record id 影响面评估）；验收 V3 |
| 2 | 2a | D2 pi 执行轨下沉（单 commit rename + import 全量更新） | 组 2 上游，一切归一的前提；验收 V4①②③ |
| 2 | 2b | D3 五对归一（预检 capabilities 化含 worktree 缺口修复） | 双轨消失后归一才有落点；验收 V4④⑤ |
| 2 | 2c | D4 Service 按轴拆分 | 拆分面在 2a/2b 后才稳定；验收 V4 回归复跑 |
| 3 | 3a | D5 收尾单点 + failureKind（unknown=可重试；词表留产出侧） | orchestration 内闭环，与组 2 零文件交叠；验收 V5 |
| 3 | 3b | D6 任务形状合流 | 排在 3a 后（同目录）；与组 2 的 SAR 交叠错开；验收 V6 |

**文件改动地图（主要落点）**：

- 组 1a：`packages/subagent-core/src/execution/engine/common/`（+session-view-service）、`packages/runtime/src/services/session/subagent-engine-history.ts`（删改）、runtime tsup `noExternal` 登记核对
- 组 1b：`extensions/universal/subagent-workflow/src/interface/format.ts`、`interface/views/format.ts`（删）、`injectors/`（合并）、`index.ts`（删死代码 + 接线统一）
- 组 1c：`engine/common/pool-manager.ts`（含 refs.json 落盘）、`engine/engines/zcode/preparer.ts`（acquire）、record GC 触发点（实施期门盘点后定；chat 域 taskId=record.id 先行）
- 组 2a：`execution/session-runner.ts` 等九件 → `execution/engine/engines/pi/`；40+ 测试 import 机械更新；`subagent-service.ts` 删旧轨
- 组 2b：`engine/common/kill-chain.ts`、`routing.ts`、`subagent-service.ts`、`subprocess-agent-runner.ts`、预检两处
- 组 2c：`subagent-service.ts` 拆分出 notifier 面/轮次结算/冷路径三 module
- 组 3a：`orchestration/error-recovery.ts`（更名拆分）、`lifecycle.ts`、`execute-agent-call.ts`（删分诊表、消费 failureKind）、`execution/engine/engines/pi/output-collector.ts`（failureKind 产出 + 词表保留；u-2a 下沉后位置）
- 组 3b：`execute-options-mapper.ts`（删）、`engines/pi/task-spec-mapper.ts`（删）、`subprocess-agent-runner.ts`、`orchestration/models/types.ts`

**待验证检查点（实施期必须实证，不预设结论）**：①D1 的 core 投影 module 依赖闭包复核（降级路径已备）+ message_end error 样本 golden 库可得性；②D2 迁移对 staged 打包零影响（validate-runtime-bundle.sh + 产物探针）；③D3 pi SIGTERM 退出时序实测确认 grace 参数语义不变；④D8 两道门：record GC 触发点全量盘点 + workflow 域 taskId↔record id 打通影响面评估（改 createRecordForMode 签名 / hook record store 即判深 → workflow 域维持 TTL 回收并显式登记）；⑤D6 字段完整性对照表从现有 mapper 测试提取；⑥走查计数类断言实施期复核（SubagentService public 方法数、整类 mock ×7、40+ 测试 import、coda 全量清单 rg 提取）。
