# subagent 执行层引擎中立抽象设计（pi / zcode / 未来多引擎）

> **[HISTORICAL] 取代声明（2026-09-12 补）**：本篇描述的「进程内引擎」形态（PiEngine/ZcodeEngine 以 TS 模块内建在 core 里、registry 经 `id → factory` 进程内取用）**已被引擎协议化取代**——引擎外移为独立 CLI 包（`packages/pi-subagent-cli` / `packages/zcode-subagent-cli`），经 **NDJSON stdio 协议（engine-protocol v1）** 与 core 通信；subagent-core 壳侧**零内建引擎**，registry 改为三级发现（`XYZ_AGENT_ENGINE_ROOTS` + node 解析 + config.json）装载 cli descriptor manifest（registry.ts `kind:"cli"`）。新增引擎 = 装一个独立引擎 CLI 包，**不再改 subagent-core**。随协议化的关键反转与契约漂移：reader 已随引擎包外移，core/runtime 均为协议客户端（本篇 D9「reader 双端复用共享只读模块」被显式反转）；`AgentEvent` 现为 **9 种**（新增 `activity` 纯活性信号）；`AgentTaskSpec` 已并入 `AgentCallOpts`（D6 合流，`run(task: AgentCallOpts)`）；EnginePort 另有 `listModels?` / `validateModel?` / `dispose?` 可选面。**现行权威 = [subagent-engine-protocolization.md](../design/subagent-engine-protocolization.md) + [subagent-post-convergence-architecture.md](../design/subagent-post-convergence-architecture.md)**；本篇按历史设计存档，结构导航读 [docs/extensions/subagents/architecture.md](../extensions/subagents/architecture.md)。

> 层声明：本文档是「引擎抽象架构层」的设计，下一层产物是**可实现的接口/数据模型/技术方案**（EnginePort 接口 + 引擎适配器 + 公共降级层），不跨层到具体测试用例与逐文件实现。2026-08-24 补充：接口契约层（EnginePort 完整签名/中立类型字段/handle 与 journal 格式/四件套接口，原属下一层）已并入 §3.3.5-§3.3.9——实施评审确认缺它无法指导编码；仍未跨入逐文件实现与具体测试代码。
>
> 调研输入：六引擎能力调研（zcode/pi 见 `~/Code/zcode-plugin-workspace/main/docs/research/zcode-vs-pi-extension-capabilities.md` 与本仓现状；claude-code / codex / opencode / kimi-code 见 `docs/research/agent-engine-*.md` 四份，2026-08-24）。
>
> 状态：已过第一轮对抗式审查（2026-08-24，tech-design-review：修后合格——3 must-fix 已修复：①EnginePort 补 interact 交互控制面（chatMode 语义映射）②schema native/emulated 硬分流（护 structured-output 方案 A 唯一权威）③隔离目录池化保留与 record 生命周期挂钩）。2026-08-24 二轮修订：新增 D11 能力缺陷四级处置、D12 conformance 契约套件；D6 第②级改为宿主 event journal（明确 runtime 依赖方向）；D9 补 fallback 路由与 model/engine 正交；D1 补 handle 契约与 abort 分级；D3 capabilities 补 interrupt/permissionMode；错误规格 +4 条；验收 +A9/A10/A11。第二轮对抗式审查（2026-08-24，报告 `.review/design-review-engine-abstraction-r2.md`）：4 must-fix 已修复——①GUI 历史通路级别归属（reader 划为双端复用的共享只读模块，D6/§3.3.1/P5 改写；pi 直读下沉为 pi reader 保 A1）②fallback 三守卫（显式指定/独有能力依赖/model 不可解析时不兜底，A9 改对照组）③补 `engine_run_failed` 运行中失败规格，D11 规则②如实声明封死边界 ④A12 conformance 验收场景；6 suggestion 全部采纳（steer 口径统一/AgentResult 消歧细化/A13 死 handle 场景/池清理降池粒度/env 登记与 journal 定位/存量 record 零迁移）。第三轮复审通过（2026-08-24，报告 `.review/design-review-engine-abstraction-r3.md`：0 must-fix——二轮 4 must-fix 全部闭合、一轮修复无回退；6 suggestion + 1 INFO 已随文处理：fallback 注对齐守卫/守卫 b 声明载体/A14 运行中失败场景/journal 不随池删/reader 双 bundle 打包登记/两表 steer 口径/engines 根锚定 getDataDir()）。**达到可实施门槛**。2026-08-24 接口契约补充：新增 §3.3.5-§3.3.9——EnginePort 完整签名与中立类型字段定义（锚定 execution/types.ts 与 orchestration/models/types.ts 现状）、EngineHandle/journal/SessionView 格式规格、adapter 四件套接口与 parser 产出不变量、conformance 契约套件 C1-C8、隔离池 poolKey/refs.json 方案——补齐「可指导编码」的接口契约层。**实施状态：P1-P5 已全部落地（2026-08-25，分支 `feat-support-zcode`）——P1 引擎中立抽象 + PiEngine 回填 `31b6e510d`、P2 公共降级层 `aa88a0518`、P3 ZcodeEngine spawn 单轮适配 `f8cf4c208`、P4 引擎路由（三级优先级 + 守卫 fallback）+ conformance 套件 `4fdc85ca3`、P5 runtime extractor 分协议读取链 `1a6cfdfb5`；其上的 realtime channel E 方案见 [subagent-realtime-channel.md](subagent-realtime-channel.md)。§2.4 record 通道 engine-neutral 已由 [subagent-engine-gui-visibility.md](subagent-engine-gui-visibility.md) 阶段 1 落地（2026-08-25：chat 域引擎路由统一入口 + engine/engineFallback/engineHandle 三字段贯通 + GUI 引擎标识 + 终止链；阶段 2 协议闭合见该文档 §5）。**分支 `feat-support-zcode`。实施状态补记（2026-08-31，R 线 R1-R6 落地）：zcode engine app-server 常驻化已按 [zcode-engine-appserver-resident.md](../design/zcode-engine-appserver-resident.md) 全部落地——R1 停机面（EnginePort 可选 `dispose()` + registry 重注册 dispose + `killAllSpawnedChildren` 编排扩容）`b0519eccd`、R2 连接层（AppServerConnection，NDJSON 四帧型 + fake-server 用例）`db721187d`、R3 会话层（session-channel + golden 帧序列语料）`44e2120f3`、R4 引擎接线（双模式分派 / D3 abort 链 / D5 capabilities 仅升 eventGranularity=stream / D7 常驻 HOME 锚定 + onHandleReady 回填）`a1370623c`、R5 降级链（probe 冒烟门控 + 首败 spawn 降级 + XYZ_ZCODE_MODE 定向）`498492df8`、R6 conformance 双模式口径 + live gate 改写 + 文档同步（本批）。pi 引擎与 conformance pi 侧零回归；跨仓真机验收段（RA live gate）移交 zsw 会话。

## 1. 背景目标

**一句话结论**：在 pi-subagent-workflow 的执行层之下插入一个「引擎中立抽象」（EnginePort + 中立类型 + 公共降级层），使任意 coding-agent CLI 可作为 subagent 执行引擎插拔；首期落地 pi（回填，行为零变化）+ zcode（新增，spawn 单轮模式），抽象按六引擎能力全集设计，预留 claude-code / codex / opencode / kimi-code 接入位。

### SCQA

- **S（情境）**：xyz-agent 的 subagent 编排（并行派发、workflow、schema 输出、worktree 隔离）全部构建在「spawn pi 子进程 + pi session JSONL 直读」之上。
- **C（冲突）**：zcode 桌面端已具备可用的无头驱动能力（zsub 项目真机验证），用户希望 subagent 可跑在 zcode 上；且长期看 coding-agent 生态多极（claude-code / codex / opencode / kimi-code 各有优势模型与账号体系），绑死单引擎 = 把引擎选型变成了产品级单点。
- **Q（问题）**：如何让 subagent 执行基建支持多引擎插拔，且各引擎巨大的能力差异（schema 强制、运行中插话、sandbox、session 存储、人设注入、环境隔离手段）不污染上层（工具面、workflow 引擎、GUI），也不因某个引擎的契约漂移而连锁崩溃？
- **A（答案）**：本文的 EnginePort 抽象 + capabilities 声明式降级 + 公共降级层设计。

### 系统是什么（给不熟悉内部的读者）

pi-subagent-workflow 是 xyz-agent 的一个 pi extension，跑在 pi 主会话进程内。当模型调用 `subagent`/`workflow` 工具时，它替模型做三件事：①spawn 一个无头 pi 子进程执行任务（带 agent 人设、schema 输出约束、worktree 隔离）②把子进程的实时事件流（工具调用、文本增量、usage）翻译成统一的 `AgentEvent` 流 ③任务结束后把执行记录（`SubagentRecord`）持久化进主会话 entry，供 GUI 与 workflow 引擎消费。「执行引擎」特指①中被 spawn 的 coding-agent——本设计要把「pi」这个硬编码选择变成可插拔项。

### 设计目标（从使用者体验倒推）

1. **模型/用户不感知引擎**：`subagent`/`workflow` 工具的入参、返回、GUI 展示在引擎切换后完全不变（同一份 agent 清单、同一种 record、同一个 schema 校验结果）。
2. **配置自由切换**：全局默认引擎、per-agent 指定引擎（agent .md frontmatter `engine:` 字段）、单次调用覆盖，三层优先级。
3. **能力差异显式化**：某引擎不支持的能力（如 zcode 无 schema 强制）以 capabilities 声明 + 预定降级策略消化，而不是运行时神秘失败。缺陷处置按四级分流（自动仿真/显示降级/调用前拒绝/入口拦截，D11），全部发生在 spawn 之前。
4. **抗版本漂移**：引擎 CLI 升级破坏契约时，探针在入口拦截并给出可操作错误，而不是运行中静默挂死。
5. **新引擎接入成本递减**：接入第 N 个引擎不改上层与既有引擎，只新增一个适配器模块；「递减」由 engine conformance 契约套件 + golden 样本库验证（D12），不靠口号。

### in / out of scope

**in**：subagent 执行层（extensions/universal/subagent-workflow 的 execution 链 + 其 spawn/读取基建）的引擎抽象；pi 回填；zcode 新引擎（spawn 单轮模式）；公共降级层；配置路由；探针体系；xyz-agent runtime 侧 subagent-extractor 的分协议读取（中改动，见 P5）。

**out**：xyz-agent 主会话引擎切换（主链路仍 pi，见 `feat-support-zcode` 分支早前全量评估，另行决策）；conversation 模式（chatMode/idle 续聊）在 zcode 引擎下的支持（降级声明不支持，`--resume` 冷路径留作后续演进）；zcode app-server 常驻模式（引擎内部优化项，不进首期接口实现）——注记（2026-08-30）：本条已由 app-server 终态决策超越，实施见 [zcode-engine-appserver-resident.md](../design/zcode-engine-appserver-resident.md)；除 pi/zcode 外引擎的实际实现（只做抽象适配性验证）。

## 2. 现状与问题分析

### 2.1 现有执行链与「碰巧中立」的类型面

执行层（原 `extensions/universal/subagent-workflow/src/execution/`，约 1.4 万行——**已抽包至 `packages/subagent-core`**，本节为抽包前快照）分层清晰：

```
AgentRunner port（orchestration/models/ports.ts）
  └─ SubprocessAgentRunner（委托）
       └─ SubagentService.executeAndAwait（编排：record/worktree/生命周期）
            └─ session-runner.runSpawn（spawn pi --mode rpc 子进程）
                 ├─ pi-invocation.ts      ← 定位 pi 二进制 + 组装命令行
                 ├─ stdin-writer.ts       ← pi RPC stdin JSONL 协议
                 ├─ spawn-event-adapter   ← pi 事件 → AgentEvent 翻译
                 └─ get-state-handshake   ← pi get_state 握手
```

好消息：四个核心类型**事实上已经中立**——`ExecuteOptions`（task/slug/agent/model/schema/maxTurns/worktree/cwd，语义全是「agent 调用」）、`AgentEvent`（tool_start/tool_end/text_delta/thinking_delta/turn_end/message_end/compaction/error 8 种）、`AgentResult`（orchestration 层 workflow 消费的那份，主字段 content/parsedOutput/usage/error；execution 层另有同名类型，主字段 text/turns/sessionId/toolCalls——泛化时须锚定前者并消歧命名）、`AgentRunner` port。zcode 引擎只要产出同样的 AgentEvent 流与 AgentResult，workflow 引擎、工具层、GUI 全部零改动。

坏消息：中立是**碰巧的，不是设计的**——`(1)` `ExecuteOptions.thinkingLevel` 是 pi 的 7 档枚举语义；`(2)` `skillPath` 假设引擎有 `--skill` flag；`(3)` `ExecuteOptions.conversation/idleTimeoutMs` 是 pi chatMode 专属形态（conversation 模式下子代理轮终进 idle 保留进程与 worktree，等待 tool 面 `message`/`close`/`cancel` action 续聊或收尾，subagent-service.ts:1552-1556、types.ts:556-565）——这是一组 **fire-to-completion 之外的交互控制面**，接口若不覆盖它，pi 回填时要么绕过抽象要么改行为；`(4)` spawn 细节（rpc 握手、stdin 协议、事件适配）全部内联在 session-runner 里，没有「引擎」这个概念；`(5)` record 重建（session-reconstructor）锚定 pi JSONL schema；`(6)` 模型解析（model-resolver）走 pi 的 provider 体系。这些点在「只支持 pi」时无妨，在多引擎下就是污染源。

### 2.2 六引擎能力差异的真实分布

四份新调研 + 两份既有调研横向对比（证据见各调研文档）：

| 能力 | pi | zcode | claude-code | codex | opencode | kimi-code |
|------|----|----|----|----|----|----|
| 一次性 headless spawn | ✅ rpc | ✅ `--prompt --json` | ✅ `-p` | ✅ `exec` | ✅ `run` | ✅ `-p` |
| prompt 投递通道 | stdin RPC | argv only | argv / stdin 双向流 | argv / stdin | argv / HTTP POST | argv only |
| agent 人设注入 | prompt 拼接 + flag | prompt 拼接（无 flag） | `--system-prompt` / `--append-system-prompt` / agent .md | config 叠加层 / prompt | agent .md（兼容 CC 风格）/ server `system` 字段 | `--agent-file`（临时文件） |
| schema 结构化输出 | env 注入 + 工具强制 | ❌ | ✅ `--json-schema` | ✅ `--output-schema` | ❌ | ❌ |
| 运行中插话（steer） | ✅ steer RPC | ❌（未验证） | ✅ stream-json 双向 | ◐ `turn/steer`（仅 app-server） | ◐ 再 POST（仅 server） | ◐ `:btw`（仅 server） |
| resume 续聊 | switch_session | `--resume`（冷启动） | `--resume` + fork | `exec resume` / fork | `-s` + fork | `--session` / `-c` |
| 事件流粒度 | 30+ 事件（最细） | delta / turn 终态（粗） | stream-json 全量（schema 化） | turn/item 两级 | part 级 + SSE | role 序列（粗） |
| usage 回传 | ✅ | ✅（stdout JSON） | ✅（result 消息） | ✅（turn.completed） | ✅ | 部分（meta） |
| OS sandbox | ❌ | ❌ | ❌（权限规则语法） | ✅（seatbelt/landlock） | ❌（权限 ruleset） | ❌ |
| 环境隔离手段 | `PI_CODING_AGENT_DIR` | **HOME 整体覆盖** | `CLAUDE_CONFIG_DIR` | `CODEX_HOME` | `OPENCODE_CONFIG_DIR` | `KIMI_CODE_HOME` |
| 凭据注入 | models.json（隔离目录） | 隔离 HOME 写 config.json | env（`ANTHROPIC_API_KEY`/`BASE_URL`） | env（config env_key） | auth.json / config | **config.toml（不走 env！）** |
| interrupt 优雅中断 | ✅ abort | ❌ | ✅ 一等控制请求 | ✅ `turn/interrupt` | ✅ POST abort | ◐ 仅 server（`:abort`） |
| conversation 同进程多轮 | ✅ chatMode idle 复用 | ❌ | ❌ | ❌ | ❌ | ❌ |
| 权限模式 | ✅ | ✅ `--mode` | ✅ 6 档 | ✅ sandbox+approval | ✅ ruleset+`--auto` | ❌ headless 固定 auto 不可调 |
| CLI 超时 | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| cost 回传 | ❌ | ❌ | ✅ result 自带 | ❌ | ❌ | ❌ |
| 契约稳定性 | rpc.md 官方 | 逆向，无契约 | 官方文档 + Zod schema | `generate-json-schema` 机器契约 | openapi 3.1 入库 | 文档化 |

三个结构性观察（设计的直接依据）：

注：§2.2 表为**引擎能力口径**（引擎某形态下是否存在该能力）；「本仓 subagent 链路是否接通」以 capabilities 声明（D3）为准——如 pi RPC 有 steer 但 spawn 链路未接通，首期声明 unsupported。

**观察一：六引擎都有「一次性 headless spawn」这个最小公约数**——argv 传 prompt、stdout 解析结果、exit code、resume session id。首期抽象锚定这个形态即可全覆盖；常驻 server（zcode app-server / codex app-server / opencode serve / kimi web）是引擎内部的性能/能力优化，不是接口语义。

**观察二：能力呈四档分布，必须显式建模降级**——全引擎可用（prompt/cwd/resume/终态+usage）；多数可用（model 指定、人设、工具 denylist、权限模式宽容差）；少数可用（schema 强制仅 pi/CC/codex、steer 四家、sandbox 仅 codex）；全缺（CLI 级超时——没有任何引擎有，天然是宿主公共层职责）。

**观察三：环境隔离与凭据注入是每引擎一份的「准备逻辑」**——六家六种手段（CONFIG_DIR 重定向 ×4、HOME 覆盖 ×1、配置文件生成 ×1），且互不兼容。这不是参数差异，是需要 per-engine `prepare` 钩子的结构性差异。

### 2.3 根因

当前执行层缺失的不是「if engine === 'zcode'」的分支，而是三个概念：**引擎身份**（spawn 细节没有归属边界）、**能力声明**（上层无从得知「这个引擎给不了什么」）、**降级归属**（schema 仿真、超时、隔离这些「引擎没有但我们要」的能力，没有明确的实现归属地）。本设计补这三个概念。

### 2.4 物理数据流（现状）

```
[pi 主会话进程]
  subagent-workflow extension
    ├─ SubagentService.executeAndAwait
    │    ├─ worktree-manager（引擎无关 ✅）
    │    ├─ spawn: node <pi> --mode rpc ...（env: PI_SUBAGENT_* 身份标记）
    │    │    子进程 pi ←stdin JSONL─ prompt/steer/abort
    │    │    子进程 pi ─stdout 事件流→ spawn-event-adapter → AgentEvent
    │    │    └─ session 落盘: <piAgentDir>/subagents/<enc>/sessions/*.jsonl
    │    └─ record: appendEntry(SUBAGENT_RECORD) 写主会话 ✅（引擎无关）
    └─ session-reconstructor: 直读子代理 pi JSONL → 重建 turns[]
[xyz-agent runtime]
  subagent-extractor.ts: 扫 pi subagents 目录 → 派生列表（GUI）
```

引擎中立化后不变的是：worktree-manager、record 写入通道（主会话仍是 pi，appendEntry 可用）、AgentEvent/AgentResult 消费方。要变的是 spawn 行、事件翻译行、session 落盘与读取行（三行恰好按引擎分叉）。

## 3. 解决方案

### 3.1 终态（使用者视角）

**终态一：模型按 agent 清单选人，不选引擎。** 模型调用 `subagent` 工具时看到的 agent 清单与现在完全一致（reviewer/worker/...）；`engine` 是 agent .md 的 frontmatter 字段（或全局默认），模型不感知。清单注入文案里不出现引擎字样。

**终态二：配置三层切换。**

```
优先级：调用参数 engine > agent .md frontmatter engine > 全局 settings 默认（缺省 'pi'）
```

例：`extensions 配置或 xyz-agent 设置`里默认 `pi`；`~/.agents/agents/reviewer.md` 写 `engine: zcode` 后，所有 reviewer subagent 跑 zcode；某次 workflow step 显式传 `engine: claude-code` 则单次覆盖。

**终态三：能力差异在调用前可见。** 用户在 GUI/设置里给某 agent 指定 `engine: zcode` 时，系统提示「zcode 引擎：schema 输出为仿真降级（prompt 约定 + 解析校验）、不支持运行中插话、事件流为粗粒度」——来源于该引擎的 capabilities 声明，不是散落的 if。

**终态四：引擎坏了给出可操作错误。** zcode CLI 升级导致 stdout 格式变化时，探针在引擎初始化时失败，错误信息形如「zcode 引擎探针失败：stdout 无 sessionId 字段（zcode 0.17.x 格式漂移嫌疑）。恢复：`zcode --version` 确认版本后跑 `pnpm test:engine-probe zcode`，参照 docs/research/agent-engine-zcode.md 更新解析器」。任务默认路由回全局默认引擎（缺省 pi）并留痕（D9①）——引擎是任务前提时（显式指定/独有能力依赖/模型不可解析）不兜底、直接明确报错终止；strict 模式下一切 probe 失败都报错。不静默挂死。

**终态五：新增引擎是一个模块。** 接入 claude-code = 新增 `engines/claude-code/` 目录（launcher + parser + prepare + reader 四件，预计 ≤500 行）+ 注册表登记一行，不改 workflow 引擎、不改工具面、不改其他引擎。

### 3.2 方案对比

| | 方案 A：Service 内 if-else 分派 | 方案 B：EnginePort 抽象 + 引擎注册表 + 公共降级层（推荐） | 方案 C：zsub 外挂引擎 |
|---|---|---|---|
| 形态 | SubagentService 内按 engine 字段 if-else 调 pi/zcode 两套 spawn | 执行层下插入 EnginePort 接口；每引擎一个 adapter 模块；降级能力收口公共层 | 把 zsub CLI（zcode-plugin-workspace 仓）当 zcode 引擎执行器，本仓调 zsub 命令行 |
| 长期架构合理性 | 差：三引擎后 if 嵌套不可维护；pi spawn 细节仍内联，每引擎改 Service | 好：接口契约单点、能力声明显式、降级写一次全引擎复用、符合「新引擎只加模块」目标 | 差：跨仓产品级耦合（zsub 是独立发布产品，接口面为 MCP/CLI 非进程内调用）；zsub record 与 SubagentRecord 双模型 |
| 短期实现成本 | 最低（~3-5 天） | 中（~2-3 周，含 pi 回填与测试守护） | 低-中（zsub 现成，但接缝打磨贵） |
| 风险 | 每加引擎改核心服务，回归面大；能力差异散落 | 接口设计错了要返工（用六引擎调研约束降低此风险）；pi 回填期行为回归 | zsub 演进节奏不受本仓控制；双仓版本矩阵 |
| 若用它，§2 的例子会怎样 | 第三个引擎接入时 reviewer 例子的「人设注入」要在 Service 里写第三种拼法，四份调研里的差异表全部变成散落分支 | 差异表收敛为每引擎一份 adapter + capabilities 表格 | claude-code 接入时 zsub 帮不上忙，回到方案 A 形态 |

**推荐方案 B**。方案 C 中 zsub 的价值以另一种方式吸收：ZcodeEngine 的实现直接参考/移植 zsub 已验证的 driver/bootstrap/model-router 代码（zcode-plugin-workspace 仓），架构上不依赖它。

### 3.3 架构与关键决策

#### 3.3.1 分层总图

```
[上层消费方：subagent 工具面 / workflow 引擎 / GUI]        ← 不感知引擎
        ↓ 消费中立类型
[中立类型层] AgentTaskSpec / AgentEvent / AgentOutcome / SessionView / EngineCapabilities
        ↓ 唯一契约点
[EnginePort]  run(task, ctx) → AgentOutcome
              ~~interact(handle, action) → 交互控制面（message/close/cancel，可选）~~
              （[H1 退役 2026-09-11] 已删除：续聊 = 新 run + resume 锚点；SDK 现行方法恰 9 个，无 interact）
              read(handle) → SessionView
              probe() → ProbeReport
              capabilities() → EngineCapabilities
        ↓ 实现
[引擎注册表 engine registry]（id → factory）
   ├─ PiEngine        （现有 spawn 链回填，行为零变化）
   ├─ ZcodeEngine     （新增，spawn 单轮模式）
   └─ （未来：ClaudeEngine / CodexEngine / OpencodeEngine / KimiEngine）
   （注记 2026-09-12：上图 PiEngine/ZcodeEngine「进程内模块」形态已被取代——
    registry 现行三级发现装载 cli descriptor manifest（kind:"cli"），见头部取代声明）
        ↓ 每引擎内部
[Adapter 四件套] launcher（spawn 命令组装）/ parser（stdout→事件流+终态）
                 preparer（env/隔离目录/凭据生成）/ reader（session 历史读取）
   其中 reader 是**共享只读模块**（无状态纯函数，无 spawn/进程依赖）：
   extension 的 EnginePort.read() 与 runtime extractor 复用同一份
        ↑ 复用
[公共降级层]（引擎无关，写一次全引擎用）
   schema 仿真（prompt 注入 + 三级容错 JSON 提取 + ajv 校验，仅 emulated 引擎）
   abort 两级中断（引擎原生 interrupt → 公共杀链兜底）与超时杀链（SIGTERM → grace → SIGKILL；终态合成）
   event journal（host 消费 onEvent 统一落盘，SessionView 第②级数据源，全引擎免费获得）
   persona 路由（文件落盘 / flag 直传 / prompt 拼接，按 capabilities 选择；兼作 argv 长度分流）
   嵌套防护（统一 NESTED 标记 + 清理各引擎原生标记）
   worktree 隔离（复用现有 worktree-manager）
[（未来）driver host] server-mode 引擎常驻进程管理（spawn-or-connect / 端口分配 / 健康检查 /
   crash 重启 / idle 回收）：registry 持 per-engine 单例，pool-key 与隔离目录池对齐。
   接口不变（onEvent/AbortSignal 已常驻友好），此处命名预留，首个 server-mode 引擎接入时落地
```

**贯穿纪律（全部决策的前提）**：①**宿主编排**——引擎只当单 agent 执行器，六家原生多 agent 机制（CC Task / codex ThreadSpawn / opencode task / kimi AgentSwarm）一律禁用不依赖，编排权、并行、record、worktree 全在宿主（D8 是其推论；codex multiAgentMode 进入变动期印证此判断）；②capabilities 声明「链路接通能力」而非引擎理论能力；③降级写一次、native/仿真硬分流（schema 是样板，其余能力同理）；④依赖方向单向——上层 → 中立类型/port，adapter → 公共层；runtime 永不 import adapter 的运行时件（launcher/preparer/parser）与 EnginePort 实例，例外仅两个：双端复用的无状态 reader 模块与中立制品（record + journal）。

#### 3.3.2 关键决策（每条：选择 + 被否 + 证据）

**D1 接口主语义锚定「一次性任务」，交互控制面单列可选方法。**
`run(task) → outcome` 是 fire-to-completion 语义。pi 现有的 conversation 交互面（chatMode 的 message/close/cancel + idle timer + 进程保留，见 §2.1 坏消息(3)）不折叠进 run——折叠成「run + resume 序列」会改 pi 行为（每轮冷启动 vs 现有同进程 idle 复用），违反 A1。EnginePort 补第四个面 `interact(handle, action: {kind:'message'|'close'|'cancel', payload?})`：pi 首期原生实现（现有 chatMode 行为直通）；zcode 首期 `unsupported`（capabilities 声明，调用前拒绝并提示）；未来低交互引擎可由公共层用「run + resume + 宿主 idle timer」仿真（`resume:'cold'` 路径），但 pi 不走仿真。被否：按「session 型 + run 型」双语义重构整个接口（codex 调研建议方向）——那是主链路 GUI 集成的需求形态，subagent 场景一次性任务占绝对多数，双语义让首期复杂度翻倍；常驻 server 形态（zcode app-server 等）留作引擎内部优化：接口的 `onEvent` 回调 + `AbortSignal` 已按常驻友好设计，引擎内部换常驻实现时接口不动。

**handle 契约三条**（run/interact/read 三面的连接件）：不透明（上层不解构）、可持久化（内嵌 SubagentRecord，主会话 reload 后 `read` 仍可用）、自描述（含 engineId + 引擎 session 定位符 + pool key + adapter 版本）。推论：对进程已死的 handle 调 `interact` 必须返回 `engine_session_not_resumable`（指向 cold resume 路径），而非笼统失败。**abort 分级**：`run` 的 AbortSignal → ①引擎原生优雅中断（CC `interrupt` / codex `turn/interrupt` / opencode POST abort / kimi `:abort`）→ ②公共杀链兜底；CLI-only 引擎（zcode/kimi headless）直接走②，杀死后由宿主合成终态，record 正常收尾不留僵尸。

**D2 中立类型从现有类型泛化，不另起炉灶。**
`AgentTaskSpec` = 现有 `ExecuteOptions` 泛化：剥离 pi 专有语义（`thinkingLevel` 7 档改为引擎无关的 `effort?: string` 由引擎映射或忽略；`skillPath` 改为 `persona` 的一部分；`conversation/idleTimeoutMs` 归 `interact` 控制面的 task 标志，保留原名透传）。`AgentEvent` 8 种、`AgentResult` 字段原样保留（锚定 orchestration 层 workflow 消费的那份，与 execution 层同名类型消歧，见 §2.1）。被否：全新设计一套更「完美」的类型——现有类型被 workflow 引擎/GUI/测试广泛消费，推倒重来是纯迁移成本。

**D3 capabilities 三级声明：`native` / `emulated` / `unsupported`。**

```ts
interface EngineCapabilities {
  schemaEnforcement: 'native' | 'emulated';        // native: --json-schema/--output-schema/env注入
  steer: 'native' | 'emulated' | 'unsupported';     // 注意区分「引擎 RPC 层有此能力」与「subagent 链路已接通」
  conversation: 'native' | 'unsupported';           // interact 控制面（message/close/cancel + idle）
  personaInjection: 'file' | 'flag' | 'prompt';     // 决定 persona 路由策略
  eventGranularity: 'stream' | 'coarse';            // 粗粒度引擎：GUI 显示降级为阶段态
  sandbox: 'native' | 'emulated' | 'none';          // emulated = worktree 隔离
  sessionRead: 'full' | 'partial' | 'outcome-only'; // 重建历史的能力
  resume: 'native' | 'cold' | 'unsupported';
  interrupt: 'native' | 'kill-only';                // 优雅中断 or 只能杀进程（公共杀链兜底，见 D1 abort 分级）
  permissionMode: 'native' | 'fixed' | 'ignored';   // kimi headless 固定 auto = ignored；GUI 据此隐藏/提示
}
```

两个易错点：① capabilities 声明的是**本仓 subagent 链路实际接通的能力**，不是引擎 RPC 层的理论能力——pi 的 RPC 有 steer 但现有 spawn 链路未接通（session-runner steer no-op，schema 强制走 MANDATORY 指令路径），首期 pi 的 steer 应声明 `unsupported`（接通后再升级声明）；② schema 的 native/emulated 分流是硬边界，见 D4。上层据声明选择策略（如 schema 为 emulated 时自动走公共降级层；steer/conversation unsupported 时 UI 隐藏对应入口并提示），而非 try-catch 运行时试错。被否：能力检测做成运行时探测定——探测成本高且不可靠（有的能力要跑到一半才知道）。

**D4 降级能力归属公共层，一次性实现全引擎复用；native 路径与仿真路径硬分流。**
schema 仿真、超时杀链、persona 路由、嵌套防护、worktree 隔离五件放公共降级层，不放各引擎 adapter（避免六个引擎各写一份有差异的仿真）。证据：四份调研的「缺失能力」清单高度重合（schema 4/6 缺、超时 6/6 缺、sandbox 5/6 缺）——公共层是消除重复的正确位置。

**schema 的边界必须显式**：capabilities 为 `emulated` 的引擎（zcode/opencode/kimi-code）走公共仿真层（prompt 注入 + 三级容错提取 + 宿主侧 ajv）；capabilities 为 `native` 的引擎（pi 的 `PI_WORKFLOW_SCHEMA` env 注入链路、claude-code 的 `--json-schema`、codex 的 `--output-schema`）保持各自原生链路，公共层**不做二次校验、不改写其结果**。理由：pi 的 structured-output 方案 A [HISTORICAL]（workflow 模式 env 注入的权威 schema 是唯一校验权威）——宿主侧再叠一层 ajv 会制造第二校验权威，恰是历史上「校验自报 schema 致修复静默丢失」事故的形态。仿真层的 ajv 只在 emulated 路径出现。

**D5 环境隔离与凭据注入走 per-engine preparer 钩子；隔离目录池化保留，随 record 生命周期回收。**
`prepare(task)` 在 spawn 前调用，返回 `{ env, cwd, spawnedFiles[] }`。证据：六家六种隔离手段（观察三），且 kimi 凭据必须写 config.toml、zcode 必须 HOME 覆盖——参数化无法覆盖，只能代码化。隔离目录（`<dataDir>/engines/<engineId>/<pool-key>/`，zcode 按引擎+agent/model 池化，与 zsub HOME 池同构）**跨任务保留复用**，不随单次任务清理——理由：①目录内 db.sqlite 是 D6 降级链第①级（原生读取）的数据源，任务结束即清理会让该级永不可达；②config.json/凭据引导是确定性成本，池化复用摊薄（zsub 经验：源 config mtime 比对 + 按需重建）。清理时序与 record 生命周期挂钩，但**只做到池粒度**：record 被 GC/删除时递减池引用计数（并删该 record 对应 journal），计数归零或引擎配置移除时整池删除——不对共享 db.sqlite 做单 session 手术式删行（逆向 schema 删行与 D6「原生读取必然周期性失效」同构地脆弱）；整池删除仅删引擎原生状态（隔离 HOME/config/db.sqlite，均可由 preparer 重建），**journal 不随池删**——其生命周期跟随 record，避免「配置移除导致仍存 record 的历史从②级静默跌③级」；清理失败置可观测标记而非静默。`spawnedFiles[]`（临时 prompt 文件等单次性产物）任务结束即清理，resume 场景保留。preparer 同时在 spawn 前估算 argv 总长度：仅 argv 投递的引擎（zcode/kimi）超长时在 prepare 期报 `prompt_too_large`（建议缩短 task / persona 移 file 通道 / 换 stdin 引擎），禁止 spawn 后撞 E2BIG 才失败——persona 路由优先 file/flag 已为超长场景分流大头，task 文本通常较短。

**D6 session 读取独立 SessionView 接口 + 三级降级链；第②级归属宿主 event journal（引擎无关）。**
`read(handle)` 返回 `SessionView`（turns[] 派生数据），降级链：①引擎原生读取（pi/CC/codex 的 jsonl、zcode/opencode 的 sqlite、kimi 的 wire.jsonl）②宿主 event journal（execution host 消费 `onEvent` 时统一落盘 `<getDataDir()>/engines/<engineId>/<pool-key>/journal-<taskId>.jsonl`——engines 根锚定 getDataDir() 顶层，extension 写侧与 runtime 校验侧同源推导；中立格式，重放即得 AgentEvent 流）③outcome-only（只有 prompt/result/usage——GUI 显示降级为摘要卡）。第②级归属宿主而非 adapter 的理由：adapter 各自缓存会演变出六种格式；host 统一落盘则全引擎免费获得、格式唯一。journal 同时是探针「已知样本回归」与 golden 语料（D12）的来源。**读取通路的双端归属**：①级 reader 做成无状态只读模块（`engines/<id>/reader`），extension 的 `read()`（session_read 工具）与 runtime 的 GUI 历史链路（getSubagentHistory）复用同一份——GUI 详情页常态走①级拿引擎原生全量；②③级双端皆可用，journal 路径由 handle 自描述绝对路径携带、runtime 校验前缀白名单后读取（路径从 getDataDir() 动态推导，不写死）；pi 的 runtime 直读 JSONL 现状下沉为 pi reader 模块，行为不变（A1 守护）。被否：①只支持原生读取——zcode sqlite schema 随版本迁移、kimi wire.jsonl 官方警告勿手改，原生读取必然周期性失效，必须有一级保底；②runtime 只走 journal 投影（①级仅服务 session_read 工具）——journal 是 AgentEvent 序列（粗粒度引擎仅合成 message_end/turn_end），保真度低于 sqlite 的 session/message/part 全量，且 pi 会成为「纪律约束不了自家引擎」的例外。

**D7 探针体系按契约稳定性分级。**
每引擎 `probe()`：二进制存在 + 版本解析 + 一次「干跑校验」（不调 LLM：zcode 探 `--version` + 解析器对已知样本的回归；codex/CC 用官方 schema 机器校验，探针最轻）。探针在引擎 factory 初始化与「版本变化检测」时触发，失败走终态四的错误形态。证据：zcode 无契约（help flag 漂移实锤：`--max-turns` 列出但拒收）与 codex（generate-json-schema 锁版本）是稳定性光谱两端，统一强探针浪费、统一弱探针危险。

**D8 嵌套防护双层。**
统一 `XYZ_AGENT_SUBAGENT=1` 标记（所有引擎 spawn 都注入，引擎 adapter 检测到即拒绝递归派发）+ 各引擎清理/利用其原生标记（CC 的 `CLAUDECODE`、zsub 的 `ZSW_NESTED`、pi 现有 `PI_SUBAGENT_*`）。被否：只靠「隔离目录里不装扩展」（zsub 第二重门禁）——那依赖配置洁癖，且 opencode/CC 会吃项目级 `.opencode/`/`CLAUDE.md` 配置，env 标记是唯一跨引擎可靠手段。

**D9 配置路由三层，agent .md frontmatter `engine` 字段为 per-agent 主通道。**
与 zsub 的 `frontmatter.model` 先例、六家 agent .md 体系（CC/opencode/kimi frontmatter 字段互有兼容）一致；缺省引擎 = `pi`（回填期零风险默认）。校验：注册表里不存在的 engine id 在 agent 解析期报错（配置错误前置暴露，不留到运行时）。配套三条：①**故障 fallback（有守卫的兜底）**——probe 失败时任务可路由回全局默认引擎（缺省 pi），record 记 `engineFallback: {from, reason}` + GUI 警告条（留痕防配置腐坏被静默掩盖）；但三个守卫任一命中则**不 fallback、按 strict 语义报 `engine_probe_failed`**：a) engine 来自调用参数/step 级显式指定（显式选择 = 能力依赖，静默换引擎违反意图——沙箱类任务被静默卸除安全能力正是要防的形态）；b) task 声明依赖该引擎独有能力（capabilities 对照，如 sandbox: native；首期声明载体 = step/调用级显式 engine，与守卫 a 合流，AgentTaskSpec 下钻时补 `requires?: Partial<EngineCapabilities>` 后独立生效）；c) 显式 model 在默认引擎上不可解析（不静默换模型，报 `model_not_available`）。`engineRouting.strict` 全开则一切 probe 失败直接报错。②**model 与 engine 正交**——不做「按模型名隐式推引擎」；model 在解析出的引擎上解释，不可解析时 prepare 期报 `model_not_available`（列该引擎可用模型）；引擎可用模型受各引擎 provider 体系硬约束（codex 仅 Responses API、kimi 凭据必须 config.toml），「任意引擎」≠「任意模型任意引擎」。③**workflow 脚本不写死 engine**——环境差异由 frontmatter/全局默认承载，step 级 `engine:` 仅限「必须某引擎独有能力」并注释原因。

**D10 MVP 引擎集 = { pi, zcode }；zcode 首期只做 spawn 单轮。**
zcode app-server、conversation 模式、其他四引擎都不进首期。理由见 in/out scope；抽象按六引擎全集设计（防返工），实现按最小可验收集推进（防过度工程）。第二验证引擎建议选 claude-code（契约最清晰、`--json-schema` 原生、能验证 native schema 直传路径）——但明确标注为「后续 Phase，非首期承诺」。
> 注记（2026-08-30）：本决策的「zcode 首期只做 spawn 单轮」终态已由 app-server 常驻化决策超越（spawn 路径保留为降级兜底，EnginePort 仅新增可选 `dispose()`/`onHandleReady` 两处字段级扩展）——设计与实施见 [zcode-engine-appserver-resident.md](../design/zcode-engine-appserver-resident.md)；决策账本 revisit 行见 `.xyz-harness/subagent-engine-abstraction/decisions.md` D-014。

**D11 能力缺陷按四级处置，capabilities 声明是唯一分发依据。**
「对不齐」的能力在使用中的形态（护目标 3/4，明细矩阵见附录 A）：

| 处置 | 适用 | 行为 | 体感 |
|------|------|------|------|
| 自动仿真 | schema（emulated 引擎） | 公共层 prompt 约定 + 三级容错提取 + ajv，产出与 native 同形 | 执行无打扰；引擎配置处常驻「仿真降级」标记 |
| 显示降级 | 粗粒度事件流（zcode/kimi）、kimi 部分 usage、五家 cost 缺失 | 照常执行，信息缺席（引擎侧根本不存在） | GUI 阶段态卡片 / 字段显示不可用，永不弹错 |
| 调用前拒绝 | steer/interact/conversation（声明 unsupported）、嵌套 spawn、argv 超长 | 同步结构化错误，不创建进程 | 模型收到可操作文案（换参数/换引擎）；GUI 隐藏对应入口 |
| 入口拦截 | 探针失败（strict 模式）、凭据缺失、未注册 engine id | 引擎初始化期 / agent 解析期失败 | 错误含恢复指引（见 §3.3.3） |

三条分发规则：①处置方式由能力类别决定，不由引擎 id 决定——新引擎填好 capabilities 声明即继承全部处置逻辑；②错误尽量先于进程创建——配置错误前置 agent 解析期、契约漂移前置探针、argv 超限前置 prepare 期；**封死边界如实声明**：探针只做已知样本回归，运行中漂移（新版本改了探针未覆盖的输出路径）仍会漏网，由 `engine_run_failed` 错误规格与宿主终态合成兜底，不静默挂死；③模型与用户的错误通道分开——模型收到「能改变下一次调用」的文案，用户侧由 GUI 能力标记与入口隐藏让错误尽量没有机会发生。仿真路径自身失败（三级容错 + 重试一次仍不过）才升级为 `schema_emulation_failed`。

**D12 新引擎接入以 engine conformance 契约套件 + golden 样本库为验收门。**
「接入成本递减」（目标 5）由可验证机制承载：一套任何 adapter 必须通过的契约测试（probe 形状 / run 简单任务 / AgentEvent 不变量——终态唯一且必含 usage 或显式 null / abort 行为 / read 降级行为），外加每引擎真实流量录制的 golden 样本（喂 parser 回归 + 探针运行时校验复用；首个样本来自验收前置门的 zcode 实录）。新引擎接入清单 = adapter 四件套 + 注册表一行 + golden 样本 + 契约套件转绿。第三验证引擎建议 opencode（在 claude-code 之后）：它最早迫使 server-mode 通道与 driver host（§3.3.1）从理论变现实，趁早压测接口常驻兼容性，比晚发现接口假设错误便宜。

#### 3.3.3 错误规格（每类配恢复指引）

| 错误 | 触发 | 恢复指引 |
|------|------|---------|
| `engine_not_found` | agent frontmatter 写了未注册 engine id | 指向注册表清单 + 配置文件路径 |
| `engine_probe_failed` | 探针失败（版本漂移/二进制缺失） | 版本确认命令 + 探针重跑命令 + 调研文档路径（终态四样例） |
| `engine_credential_missing` | preparer 找不到凭据源（如 zcode v2 config 无 apiKey） | 指向引擎凭据配置文档节 |
| `nested_spawn_rejected` | 嵌套 spawn 尝试 | 说明防护规则，指向 task 内自行完成 |
| `schema_emulation_failed` | 仿真降级下输出经三级容错仍解析不出 JSON / ajv 不通过 | 重试一次（强化 prompt）后报错，错误含原始输出尾部——与现有 structured-output 重试语义对齐 |
| `engine_timeout` | 宿主超时杀链走完 | 含 stdout 尾部 2000 字 + 「可用 engine: pi 重跑」建议 |
| `engine_capability_unsupported` | 对声明 unsupported 的能力发起调用（interact/conversation/steer） | 同步拒绝不创建进程；模型可操作文案（换单次调用 / `engine: pi`）；GUI 侧入口隐藏使该错误尽量不触发 |
| `engine_session_not_resumable` | 主会话 reload 后对进程已死的 handle 调 interact | 指向 cold resume（`--resume` 系）路径，说明 idle 复用不可跨 reload |
| `model_not_available` | model 在解析出引擎的 provider 体系中不可解释 | prepare 期报，列该引擎可用模型清单；不做隐式换引擎（D9②） |
| `prompt_too_large` | argv 长度估算超限且引擎无 stdin/file 通道 | prepare 期报，建议缩短 task / persona 移 file / 换通道引擎 |
| `engine_run_failed` | 进程已创建后引擎失败：stdout 解析失败 / 非零退出 / 契约漂移越过探针在运行中爆发 | 宿主合成错误终态、record 正常收尾；错误含 stdout 尾部 2000 字 + exit code；恢复：版本确认 + 探针重跑（同时将新样本补录进 golden 库），或 `engine: pi` 重跑 |

注：引擎故障 fallback（D9①）不是错误——record 记 `engineFallback` 字段 + GUI 警告条；三守卫命中（显式指定/独有能力依赖/model 不可解析）或 strict 模式下才以 `engine_probe_failed` / `model_not_available` 终止。

#### 3.3.4 物理数据流（终态，以 reviewer@zcode 为例）

```
模型调用 subagent(agent=reviewer, task=...)
  → 引擎路由: reviewer.md frontmatter engine:zcode → ZcodeEngine
  → 公共层: schema 仿真段拼装 + NESTED env + worktree 创建
  → preparer: <dataDir>/engines/zcode/home-reviewer/ 隔离 HOME
      （config.json: model.main + 凭据，tmp+rename 原子写；无 plugins 块）
  → launcher: spawn node <zcode.cjs> --json --cwd <worktree> --mode yolo
      --disallowed-tools <denylist> --prompt <persona+task+schema 仿真段>
      (env: HOME=隔离目录, XYZ_AGENT_SUBAGENT=1; stdin=/dev/null)
  → parser: stdout 有界收集（头4K+尾64K）→ 单 JSON {sessionId,response,usage}
      → 合成 AgentEvent 流（coarse: message_end + turn_end）→ AgentOutcome
  → journal: host 消费 onEvent 落 <dataDir>/engines/zcode/<pool>/journal-<taskId>.jsonl（中立格式）
  → record: SUBAGENT_RECORD appendEntry（主会话 pi 通道，不变；内嵌可持久化 handle）
  → read(handle): sqlite 读 session/message/part 三级 JOIN → SessionView
      （失败降级 → 宿主 event journal 重放 → outcome-only）
```

#### 3.3.5 EnginePort 与中立类型完整契约（接口签名）

> 本节是 D1/D2/D3 的可编码落地：实施者第一步写的就是这些类型。字段与现有类型逐一锚定（来源：execution/types.ts 与 orchestration/models/types.ts 实测，非凭空设计）；标注「泛化」的条目语义有变，标注「新增」为引擎层新引入。

**AgentTaskSpec**（= 现有 `ExecuteOptions` 泛化）：

```ts
interface AgentTaskSpec {
  task: string;                        // 原样
  slug: string;                        // 原样（≤35 字符）
  agent?: string;                      // 原样（resolveIdentity 的 agent ref）
  model?: string;                      // 原样（在引擎 provider 体系内解释，D9②）
  effort?: string;                     // 泛化：原 thinkingLevel（pi 7 档语义剥离，引擎各自映射或忽略）
  persona?: PersonaSpec;               // 泛化：原 skillPath + appendSystemPrompt 收拢（D2）
  schema?: Record<string, unknown>;    // 原样（native/emulated 分流依据，D4）
  maxTurns?: number;                   // 原样
  graceTurns?: number;                 // 原样
  fork?: boolean;                      // 原样（pi 专属；其他引擎 prepare 期按 capabilities 拒绝）
  worktree?: boolean | WorktreeHandle; // 原样（公共层职责，非引擎职责）
  cwd?: string;                        // 原样
  conversation?: boolean;              // 原样（interact 控制面的 task 标志，D1）
  idleTimeoutMs?: number;              // 原样（同上）
  denyTools?: string[];                // 新增：中立工具 denylist（附录 A 该行的载体）
  permissionMode?: string;             // 新增：中立权限模式（映射按 capabilities.permissionMode）
}

interface PersonaSpec {
  agentRef?: string;                   // agent 名/路径（capabilities.personaInjection 决定注入通道）
  skillPath?: string;                  // 原 skillPath（persona 路由三策略分流，D4）
  appendSystemPrompt?: string[];       // 追加系统提示（schema 仿真段由公共层拼装后放入）
}
```

删字段去向：`signal`/`ctxModel`/`onComplete` 移入 RunContext（运行期句柄不属于任务声明）；`schemaEnv` 内化到 PiEngine——launcher 从 `task.schema` 派生 env 值，映射层保证与现有 schemaEnv 逐字节等值（A1 快照 diff 验证点）。

**AgentEvent**：8 种事件原样保留，唯一权威定义仍是 execution/types.ts（引擎层 re-export，不复制第二份）。新增粗粒度约束：coarse 引擎（zcode/kimi）至少合成一次 `message_end`（含 usage 或显式缺省）+ 一次 `turn_end`——journal 重放与 GUI 降级的最小信息量（不变量全文见 §3.3.7）。

**AgentOutcome**（锚定 orchestration/models/types.ts 的 `AgentResult`——workflow 引擎消费的那份）：

```ts
interface AgentOutcome {
  content: string;                     // 原样（AgentResult.content）
  parsedOutput?: unknown;              // 原样（native 引擎直传 / 仿真层 ajv 产出，D4 硬分流）
  usage?: AgentUsage;                  // 原样（orchestration 版：input/output/cacheRead/cacheWrite/cost/contextTokens/turns）
  durationMs?: number;                 // 原样
  error?: string;                      // 原样（错误码前缀格式见 §3.3.3）
  sessionId?: string;                  // 原样（引擎语义 session id）
  sessionFile?: string;                // 原样
  worktreePath?: string;               // 原样（仅诊断）
  toolCalls?: ToolCallEntry[];         // 原样
  engineId: string;                    // 新增：实际执行引擎（fallback 后可能 ≠ 请求值，D9①）
  engineFallback?: { from: string; reason: string }; // 新增：record 同步投影，GUI 警告条数据源
  exitCode?: number | null;            // 新增：null = 被信号杀死（杀链/abort 合成终态的判据）
}
```

消歧落点（§2.1 坏消息的闭合）：execution 层 `AgentResult`（text/turns/sessionId/toolCalls）保持原名不动——它是 record 内部投影；引擎层终态命名 `AgentOutcome`，与两者不同名，「同名不同义」消除。

**EnginePort 完整签名**：

```ts
interface EnginePort {
  readonly id: string;                                      // 注册表 key（'pi' | 'zcode' | ...）

  capabilities(): EngineCapabilities;                       // D3（同步无副作用——调用前拒绝的判据）
  probe(opts?: { force?: boolean }): Promise<ProbeReport>;  // D7（factory 初始化 + 版本变化检测触发）

  run(task: AgentTaskSpec, ctx: RunContext): Promise<EngineRunResult>;           // D1 主语义
  read(handle: EngineHandle): Promise<SessionView>;         // D6 三级降级链
}

// [H1 退役注记 2026-09-11] 上表原含 `interact(handle, action: InteractAction): Promise<InteractResult>`
// 可选面（chat 续聊/插话/关断控制面）——已随 chat 域统一进 run 域
// （docs/design/subagent-chat-run-unification.md）整族删除：续聊 = run 携 resume 锚点
// （`RunParams.resume {recordId, resume: ResumeAnchor}`，pi `--session` 续写原 session 文件），
// 轮活性经 run 事件通道与 run 终态应答承载（约束 C-proc-13）。

interface RunContext {
  taskId: string;                        // = record.id（bg-N-xxx / run-N）——journal 文件名与池引用计数 key
  poolKey: string;                       // D5 隔离池（宿主分配，见 §3.3.9）
  signal?: AbortSignal;                  // abort 分级入口（D1：原生中断 → 公共杀链）
  onEvent?: (event: AgentEvent) => void; // 事件流出口（host 消费后统一落 journal，D6 第②级）
  ctxModel?: ModelInfo;                  // model 解析第三层兼底（现有 D-008 语义不变）
}

interface EngineRunResult {
  handle: EngineHandle;                  // 可持久化；spawn 成功即构造（失败终态也返回 handle 供 journal 定位）
  outcome: AgentOutcome;                 // 终态（abort/超时/失败时为宿主合成终态）
}

// [H1 退役 2026-09-11] 原 `InteractAction`（message/close/cancel 三 action）与 `InteractResult`
// 类型块已随 interact 控制面删除；close/cancel 语义经 run 域 cancel 方法与 record close 编排承载，
// 续聊经 `RunParams.resume`（约束 C-proc-13）。

interface ProbeReport {
  ok: boolean;
  engineVersion: string;                 // 实测版本（handle.engineVersion 数据源）
  checks: Array<{ name: string; ok: boolean; detail?: string }>; // 二进制存在/版本解析/干跑回归逐项
  error?: { code: string; recovery: string }; // engine_probe_failed 的恢复指引（§3.3.3 终态四）
}
```

run 的错误语义三条（与 §3.3.3 对齐）：①prepare 期错误（credential_missing / model_not_available / prompt_too_large）在进程创建前 reject，不产生 handle；②运行中失败**不 reject**——合成 error outcome + 正常 handle 返回（record 必须收尾）；③abort 走完杀链后同②（exitCode=null + error 含杀链标记）。

#### 3.3.6 EngineHandle 序列化与 event journal 格式（D1/D6 落地细化）

**EngineHandle 序列化形态（JSON，v1）**：

```ts
interface EngineHandleData {             // 持久化形态；内存态 EngineHandle = 反序列化物 + 引擎运行时引用
  v: 1;
  engineId: string;                      // 'pi' | 'zcode' | ...
  /** 引擎自定义键值：pi = { sessionFile }，zcode = { sessionId, dbPath（相对池目录） } */
  sessionRef: Record<string, string>;
  poolKey: string;                       // 隔离池定位（§3.3.9；pi 无池化恒 'shared'）
  journalPath: string;                   // journal 绝对路径（read 第②级数据源；runtime 读前校验前缀白名单）
  engineVersion?: string;                // probe 实测（漂移排查锚点）
  adapterVersion: string;                // 适配器版本（golden 样本对齐排查）
}
```

持久化挂点：`SubagentRecordEntryData` v2 新增 `engine?: { id: string; handle: EngineHandleData }`；v1 存量 entry 缺省 → 按 pi 投影 + sessionFile 定位（零迁移，与 P5 存量 record 规则一致）。不透明性对上层成立：除 record 持久化层与 read 降级链外，任何模块不得解构 handle 字段。

**event journal 格式（JSONL，中立，v1）**：

```
<getDataDir()>/engines/<engineId>/<poolKey>/journal-<taskId>.jsonl
```

每行 schema：

```json
{"v":1,"ts":1724477000123,"taskId":"bg-3-ab12","engineId":"zcode","seq":0,"event":{"type":"message_end","usage":{}}}
```

- `event`：AgentEvent 原样（onEvent 回调对象的 JSON.stringify 直接产物，无二次变换）
- `ts`：host 落盘时刻（Date.now()）；`seq`：host 侧单调递增——重放顺序权威（不依赖文件行序的隐式保证）
- `taskId` = RunContext.taskId = record.id；chatMode 续聊的多轮追加写同一文件——round 边界由 message_end/turn_end 序列自然表达，无需额外轮标记

写入纪律：host（SubagentService 侧）在 onEvent 回调内追加写（有界缓冲 + 批量 flush），run 终态后 flush 并 fsync 一次。journal 不随池删（D5），生命周期跟随 record；record GC 时与池引用计数联动删对应文件（§3.3.9）。

**重放等价性（read 第②级的实现依据）**：journal 重放与 live 通路共用同一 reducer（updateFromEvent 范式，与主会话「live ≡ reload」纪律同构——项目关键规则 9 的既有模式）。因此 SessionView 第②级的 turns 重建逻辑 = live record 的 turns 累积逻辑，不引入第二套解析器；等价性由 conformance C5 断言（§3.3.8）。coarse 引擎 journal 只含合成事件，重放退化为摘要级——D6 已声明的保真度下限，非缺陷。

**SessionView（read 返回，v1）**：

```ts
interface SessionView {
  engineId: string;
  sessionId?: string;
  turns: ReplayedTurn[];                // 与 Turn 同构但无内部态（_status/startedTs 剥离，closed 恒 true）
  usage?: AgentUsageTotal;              // 各 turn usageDelta 聚合
  source: 'native' | 'journal' | 'outcome-only'; // GUI 降级标记数据源（D6/A8）
}

interface ReplayedTurn {
  text: string;
  thinking: string;
  toolCalls: ToolCall[];                // 导出的纯净形状（无 _status）
  closed: true;
}
```

#### 3.3.7 adapter 四件套接口边界与 parser 产出不变量

每引擎包（`execution/engine/engines/<id>/`）内四个模块的职责分界与签名——这是 §3.3.1 四件套的接口化：

**launcher（spawn 命令组装 + 进程启动）——唯一持有 spawn 权的模块**：

```ts
interface EngineLauncher {
  /** 组装 argv（persona 注入/schema env/模型映射在此落成具体 flag）+ spawn 子进程 */
  launch(prepared: PreparedExecution, task: AgentTaskSpec): Promise<EngineProcess>;
}

interface EngineProcess {
  readonly pid: number;
  readonly stdin: Writable | null;      // argv-only 引擎为 null（stdin=/dev/null）
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly abort: (graceMs: number) => Promise<void>; // 杀链执行体（D1 abort 分级②）
  readonly exited: Promise<{ code: number | null; signal?: string }>;
}
```

stdin 写入（pi 的 RPC prompt/steer/abort 协议）归 EngineProcess.stdin，由引擎内部 session 协议模块驱动——不进公共层（仅 pi 有此协议）。

**parser（stdout → AgentEvent 流 + 终态）——对外统一「事件先发、终态后返」**：

```ts
interface EngineParser {
  /**
   * emit：事件增量回调（流式引擎逐条 emit；批量引擎进程退出后一次性 emit 合成事件）。
   * resolve：进程退出 + 解析完成后返回终态。reject 仅限 parser 自身实现错误——
   * 引擎输出异常（格式漂移/解析失败）不 reject，resolve 为含错误信息的 terminal 触发 engine_run_failed。
   */
  consume(proc: EngineProcess, emit: (ev: AgentEvent) => void, signal?: AbortSignal): Promise<ParserTerminal>;
}

interface ParserTerminal {
  exitCode: number | null;
  signal?: string;
  sessionRef?: Record<string, string>;  // 从输出提取的 session 定位符（handle.sessionRef 数据源）
  stdoutTail: string;                   // 有界收集（头 4K + 尾 64K）——错误规格的 stdout 尾部载体
}
```

流式（pi rpc 逐行）与批量（zcode 单 JSON）差异被 parser 边界吸收：launcher/parser 之上的 EnginePort.run 对外只有一种形态（事件先到、终态后返）。

**AgentEvent 产出不变量**（conformance C3 的断言清单，全部引擎必须满足）：

1. 终态序唯一：最后一个非 error 事件必是 `turn_end`；`message_end`（若出现）必在其前
2. `message_end.usage` 出现时为完整 AgentUsage 形状；引擎给不出完整 usage 时显式缺省字段，不给残缺对象
3. 流式引擎：全部 `text_delta` 拼接 === outcome.content（byte 级）；coarse 引擎：`turn_end` 前至少一个 `message_end`
4. `tool_start`/`tool_end` 按名配对；终态前未配对的 tool_start 必须补齐配对 tool_end（isError 可）或后续 error 事件
5. 事件 emit 完成先于 run() resolve——journal 完整性依赖：终态返回时 journal 已可重放出全部事件

**preparer（env/隔离目录/凭据生成）——spawn 前唯一副作用模块**：

```ts
interface EnginePreparer {
  /** argv 超限/凭据缺失/模型不可解析在此报错（§3.3.3 前三行），一律先于进程创建 */
  prepare(task: AgentTaskSpec, pool: PoolContext): Promise<PreparedExecution>;
}

interface PreparedExecution {
  env: Record<string, string>;          // 隔离变量（HOME/CONFIG_DIR）+ NESTED 标记 + 身份标记
  cwd: string;                          // worktree 路径或 task.cwd
  poolDir: string;                      // 隔离池绝对路径（§3.3.9）
  spawnedFiles: string[];               // 单次性产物（临时 prompt/persona 文件）——任务结束即清理，resume 保留
  argvEstimateBytes: number;            // argv 总长估算（超限报 prompt_too_large 的判据）
}
```

resume 保留语义的落点：冷 resume（zcode `--resume`）时 preparer 以 handle.sessionRef 重新定位池与凭据，原 spawnedFiles 中 prompt 文件不再重写（resume 续接原 session，prompt 不重发）。

**reader（session 历史读取）——共享只读模块（双端复用，无状态纯函数，无进程依赖）**：

```ts
interface EngineReader {
  /** 第①级原生读取。失败返回 undefined（不 throw）——降级链由宿主 read() 编排 */
  readNative(handle: EngineHandleData): Promise<SessionView | undefined>;
}
```

reader 是唯一允许被 xyz-agent runtime import 的引擎模块（D6 双端归属）：打包为独立入口（`engines/<id>/reader.ts` 不 import 同包 launcher/preparer/parser），runtime 经 workspace 依赖引入 + tsup `noExternal` 登记（P5；打包纪律项目关键规则 12②）。

#### 3.3.8 conformance 契约套件规格（D12 落地细化）

**位置与框架**：`extensions/universal/subagent-workflow/src/execution/engine/conformance/`，vitest（项目红线：禁 node:test）。两层结构对齐 A12：

| 层 | 内容 | 依赖 | 进 CI |
|----|------|------|-------|
| golden 回放层 | parser 对实录样本回归 | 免 LLM、免二进制 | 是（默认跑） |
| run 层 | 真实 spawn 简单任务 | 已装引擎 + 有效凭据 | 否（`ENGINE_CONFORMANCE_LIVE=1` 手动门） |

**golden 样本库**（`conformance/golden/<engineId>/<engineVersion>/`）：

- `<case>.stdout`：真实 stdout 原始字节（首样本来自验收前置门的 zcode 实录）
- `<case>.expected.json`：期望的 AgentEvent 序列 + ParserTerminal（含 sessionRef 与 stdoutTail 截断后形态）
- `manifest.json`：采集日期、引擎版本、采集命令、样本说明——探针「已知样本回归」（D7）复用同一批样本，一处采集两处消费

**契约用例清单（每个 adapter 必须全绿）**：

| # | 用例 | 断言 |
|---|------|------|
| C1 | probe 形状 | ProbeReport 字段完整；ok=false 时 error.recovery 非空（§3.3.5） |
| C2 | run 简单任务（run 层） | outcome 无 error、content 非空、engineId 正确 |
| C3 | 事件不变量 | §3.3.7 五条逐一断言（流式引擎用 golden 回放；coarse 引擎用合成样本） |
| C4 | abort 行为（run 层） | 运行中 cancel → 合成终态（exitCode=null）、无僵尸进程（alive marker/pid 扫描）、record 正常收尾 |
| C5 | read 降级链 | ①级成功路径；rename 原生存储 → ②级 journal 重放 turns 与 live 一致（重放等价性，§3.3.6）；清空 journal → ③级 outcome-only；三级都不 throw |
| C6 | schema 分流 | emulated：合法输出 ajv 过 / 非法输出三级容错后 schema_emulation_failed；native：env 链路不受仿真层影响（D4 回归） |
| C7 | 嵌套防护 | 注入 NESTED env 后 spawn 被拒（nested_spawn_rejected），无进程创建 |
| C8 | prepare 前置错误 | argv 超限 → prompt_too_large（无进程）；未知 model → model_not_available；凭据缺失 → engine_credential_missing |

负例守护（A12「套件有牙」的实现）：CI 内置一条元测试——故意破坏 zcode parser 的一个不变量样本，断言 C3 转红；若套件未检出破坏则元测试失败。

#### 3.3.9 隔离目录池化与引用计数方案（D5 落地细化）

**目录布局与 poolKey 计算**：

```
<getDataDir()>/engines/<engineId>/<poolKey>/
  config.json | home/ | db.sqlite ...   # 引擎原生状态（preparer 可重建）
  refs.json                              # 池引用登记（host 维护）
  journal-<taskId>.jsonl                 # host 落盘（不随池删）
  （注记 2026-09-12：zcode 的 db.sqlite 已迁出池目录至
    <engineDataDir>/engines/zcode/session-db/db.sqlite——原选址落在整池删除边界内，
    见 [zcode-session-db-isolation.md](../design/zcode-session-db-isolation.md)）
```

poolKey = `<sanitized-agent-name>`（agent 未指定时 `default`；非 [a-zA-Z0-9-] 字符替换为 `-`）。model 不进 key：模型差异由 prepare 期 config 重写消化（zsub 先例：源 config mtime 比对 + 按需重建，成本确定性）。pi 无池化（`PI_CODING_AGENT_DIR` 全局一份），poolKey 恒 `shared`，仅为路径形状统一。

**refs.json（v1）**：

```json
{"v":1,"refs":{"bg-3-ab12":{"taskId":"bg-3-ab12","ts":1724477000123}}}
```

- acquire：run 启动时登记 taskId（幂等：已存在刷新 ts）
- release：record 被 GC/删除时移除该 taskId，同时删对应 journal 文件（journal 生命周期跟随 record，D5）
- 计数归零 → 删池内引擎原生状态（整池删或删目录均可）；引擎配置移除（探测不到该引擎）→ 无视计数整池清理，journal 除外（仍存 record 的历史不降级）
- refs.json 写失败/删池失败 → 置 `<poolDir>/.cleanup-failed` 标记（可观测不静默，D5「清理失败置标记」的落地形态；启动期扫描该标记告警）

**并发约束**：同一池的并发 run 共享引擎原生状态（zcode sqlite WAL 并发读为验收前置门②实证项）；refs.json 读写经进程内互斥——宿主是唯一写者，无跨进程竞争。

## 4. 验收

大改动，多场景。每个场景标注回溯 §1 目标条目。执行环境：真实 xyz-agent dev（`pnpm dev`）+ 本机已装的 zcode（ZCode.app）与 pi。

| # | 场景 | 步骤 | 通过标准 | 回溯目标 |
|---|------|------|---------|---------|
| A1 | pi 引擎零回归 | 合入后跑 subagent-workflow 全量测试 + 手动派一个 `engine` 缺省（=pi）的 subagent 与一个多步 workflow | 测试全绿；手动路径与合入前比对锚点一致：①record entry JSON 快照 diff（字段级）②GUI 关键视图截图基线（对话流/工具面板/record 详情）③schema 任务走 native env 注入链路不受仿真层影响（D4 硬分流的回归确认） | 目标 1 |
| A2 | zcode 引擎真实任务 | reviewer agent frontmatter 加 `engine: zcode`，模型派「审查 packages/shared/src/paths.ts 最近改动，按 schema 输出 {issues[],verdict}」 | 子代理真跑在 zcode（隔离 HOME 的 db.sqlite 出现新 session）；schema 结果 ajv 校验通过；GUI 对话流/工具面板正常显示（允许粗粒度） | 目标 1/2/3 |
| A3 | schema 仿真降级可见 | 同 A2 但查 GUI 引擎提示 | 调用前可见「schema 为仿真降级」提示，不是运行时报错 | 目标 3 |
| A4 | 嵌套防护 | 让 zcode 子代理尝试调用 subagent 工具 | 被拒并给出防护说明，无二级 zcode 进程产生 | 目标 4（防护属错误规格） |
| A5 | 探针拦截（strict 模式） | 开 `engineRouting.strict` + 临时改 zcode 解析器的版本断言（模拟漂移）后派 zcode subagent | 入口即 `engine_probe_failed`，错误含恢复指引（版本命令/探针命令/文档路径），任务不静默挂死 | 目标 4 |
| A6 | 混编 workflow | 一个 workflow 前两步用默认 pi、第三步 step 级指定 zcode | 两引擎 record 结构一致，workflow 汇总正常，GUI 无引擎字段泄漏 | 目标 1/2 |
| A7 | 单次调用覆盖 | 调用参数显式 `engine: pi` 覆盖 reviewer 的 zcode 设置 | 该次跑 pi（隔离目录无新增 zcode session） | 目标 2 |
| A8 | 读取降级链 | 前置确认：该 zcode 任务的隔离池目录与 db.sqlite 正常保留且 `read(handle)` 走第①级（sqlite 原生读取）成功。然后 rename 掉 db.sqlite 再打开该 subagent 详情 | 详情页降级为宿主 event journal 重放重建（第②级）；再清空 journal 后降级为 outcome-only 摘要卡（第③级），不白屏不报错弹窗 | 目标 3（sessionRead 降级） |
| A9 | 引擎故障 fallback 与守卫 | 不开 strict：①engine 来自 frontmatter 的 reviewer@zcode 探针失败（临时移走二进制）→ 派任务；②对照组：调用参数显式 `engine: zcode` + 同样探针失败 | ①路由回默认引擎 pi 完成，record 含 `engineFallback{from:'zcode',reason:'probe_failed'}`，GUI 警告条可见；②**不降级**，报 `engine_probe_failed`，无 pi 进程创建 | 目标 4 |
| A10 | abort 两级中断 | zcode 任务运行中用户 cancel；另派 pi 任务 cancel 对比 | zcode 走公共杀链兜底、宿主合成终态、record 正常收尾无僵尸进程；pi 走原生中断优雅收尾 | 目标 1/4 |
| A11 | 调用前拒绝 | 对 `engine: zcode` 的 agent 发起 conversation 模式与 message 续聊 | 同步返回 `engine_capability_unsupported`（含可操作建议），无 zcode 进程创建；GUI 对应入口隐藏 | 目标 3 |
| A12 | conformance 契约套件 | 本机真实环境（已装 pi/zcode + 有效凭据）跑契约套件：golden 回放层（parser 对实录样本回归，免 LLM）+ run 层（真实 spawn 简单任务，需真实模型调用，作手动门不进 CI 默认）；负例：故意破坏 zcode parser 一个不变量断言 | pi/zcode 双引擎全绿；负例转红并指出失败的不变量——证明套件有牙 | 目标 5 |
| A13 | 死 handle 续聊拒绝 | pi conversation 子代理轮终进 idle 后关闭并重开主会话（子进程死亡），对原 handle 发 message | 同步返回 `engine_session_not_resumable`（含 cold resume 指引），无挂死、无新进程 | 目标 3 |
| A14 | 运行中引擎失败兜底 | 注入损坏的 zcode parser（或喂 golden 样本外的新格式 stdout）模拟运行中解析失败 | 结构化 `engine_run_failed`（含 stdout 尾部 + exit code + 恢复指引）、record 正常收尾、无僵尸进程；新样本补录 golden 库 | 目标 4 |

验收前置门（实施期完成）：A2 前先用真实 zcode CLI 手工跑一次驱动脚本核对 stdout JSON 字段（sessionId/response/usage）与本机 0.16.3 一致——探针的已知样本即来自这次实录。

## 5. 下一层拆分

实施路径五阶段，每阶段可独立验收（A1-A14 分配到阶段门）：

| 阶段 | 单元 | 内容 | justification / 验收挂钩 |
|------|------|------|--------------------------|
| P1 | 中立类型 + EnginePort + PiEngine 回填 | `execution/engine/` 新目录：types.ts（AgentTaskSpec/AgentOutcome/EngineHandleData/SessionView 字段定义见 §3.3.5-§3.3.6）、port.ts（签名见 §3.3.5）、registry.ts；现有 runSpawn 链移入 `engines/pi/`（四件套接口边界见 §3.3.7），ExecuteOptions→AgentTaskSpec 映射层 | 行为零变化靠现有测试守护（session-runner.test 等）；验收 A1/A13。先回填后新增，隔离回归风险 |
| P2 | 公共降级层 | schema 仿真（prompt 拼装 + 三级容错提取 + ajv，**仅服务 emulated 引擎**，见 D4 硬分流）、超时杀链与 abort 两级中断、event journal 落盘（格式见 §3.3.6）、persona 路由（含 argv 长度估算前置拦截）、嵌套防护、preparer 目录池管理（poolKey/refs.json 见 §3.3.9） | 纯新增无回归面；pi 的 native schema 链路（env 注入）不动；验收 A10 |
| P3 | ZcodeEngine | adapter 四件套（launcher/parser/preparer/reader），吸收 zsub driver.js/bootstrapIsolatedHome/model-router 的 TS 重写；sqlite reader | zsub 已真机验证，风险集中在移植保真；验收 A2/A3/A4/A8/A14 |
| P4 | 配置路由 + capabilities + 探针 + conformance | frontmatter engine 字段解析（agent-ref/meta-parser 扩展）、三层优先级与 fallback 路由（D9）、probe 体系、错误规格落地、engine conformance 契约套件骨架 + golden 样本库（D12，pi/zcode 先行各一份；用例清单与 golden 布局见 §3.3.8） | 验收 A5/A9/A11/A12/A6/A7；契约套件转绿是后续新引擎验收门 |
| P5 | runtime 侧 subagent-extractor 分协议 | xyz-agent runtime（subagent-extractor.ts 约 660 行，锚定 pi subagents 目录扫描）改造：按 record 内 engine 字段路由到该引擎**共享 reader 模块**（①级原生读取，extension/runtime 双端复用）→ journal（②级）→ record outcome（③级）；pi 既有直读 JSONL 逻辑下沉为 pi reader，行为不变（A1 守护）；存量 record 无 engine 字段一律按 pi 投影（零迁移）；journal 定位 = handle 自描述绝对路径 + runtime 前缀白名单校验；reader 复用经 workspace 依赖引入，runtime 侧同步登记 tsup `noExternal` 并跑 `validate-runtime-bundle.sh` 验证双 bundle（打包纪律见项目关键规则 12②）；隔离池清理时序协调 | **中改动**（非小改动）：extractor 改为 record + 共享 reader + journal 三段，改动面集中在 session 定位与投影；单独 commit。验收 A2 的 GUI 派生列表部分 + A8 |

文件改动地图（P1-P4 主要落点）：`extensions/universal/subagent-workflow/src/execution/`（engine/ 新增 + journal.ts + session-runner/subagent-service 改造点收口）、`src/shared/`（meta-parser 的 engine 字段）、conformance 套件与 golden 样本目录（落点遵仓内测试目录约定）；新增 `XYZ_AGENT_SUBAGENT` 等 env 须登记 `packages/shared/src/constants.ts` 的 ENV_WHITELIST_PREFIXES SSOT（pre-commit 检查）。P5：`packages/runtime/src/services/session/subagent-extractor.ts`。精确逐文件清单属下一层（实现计划）产物，此处不越层。

待验证检查点（实施期必须实证，不预设结论）：①zcode 0.16.3 spawn 模式 stdout JSON 字段名实录；②隔离 HOME 下 db.sqlite 的并发读行为（WAL）与 message/part schema 细节；③`--disallowed-tools` 对 zcode 内置工具名的实际匹配语义；④argv 超长 prompt 的实际限额（zsub 经验约可用，但需在目标模型场景复核；`prompt_too_large` 的阈值取自本次实录）；⑤zcode 子进程对 SIGTERM 的响应时序（A10 杀链 grace 窗口取值的依据）。

## 附录 A：六引擎能力 × 引擎层补齐矩阵

§2.2 表的完整版，含「xyz-agent 引擎层能否补齐」列（D11 四级处置的依据）。符号：✅ 原生满足 / ◐ 部分或有条件 / ❌ 缺失；补齐列 ✅=公共层真补齐、◐=降级或部分补齐、❌=补不了仅显示降级。口径同 §2.2：引擎能力口径，链路接通状态以 capabilities 声明（D3）为准。

| 能力 | pi | zcode | claude-code | codex | opencode | kimi-code | 引擎层补齐 |
|------|----|----|----|----|----|----|------|
| 一次性 headless spawn | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | 不需要（最小公约数） |
| prompt 超长应对 | stdin 无虞 | 仅 argv | argv/stdin | argv/stdin | argv/HTTP | 仅 argv | ◐ prepare 期估算拦截 + persona file/flag 分流 |
| persona 注入 | prompt+flag | prompt | 一等 flag/file | config 叠加 | agent.md/system | `--agent-file` | ✅ 公共 persona 路由三策略 |
| 指定模型 | ✅ | ✅ | ✅ | ✅ | ✅ | ◐ 别名映射 config.toml | ✅ preparer 翻译；可用范围受引擎 provider 体系硬约束（D9②） |
| effort 档位 | 7 档 | ◐ | 5 档 | ✅ | ✅ `--variant` | ❌ | ✅ 中立 effort + 映射或忽略 |
| schema 强制 | ✅ env 注入 | ❌ | ✅ `--json-schema` | ✅ `--output-schema` | ❌ | ❌ | ◐ emulated 走公共仿真层（best-effort）；native 硬分流（D4） |
| 事件流粒度 | 30+ 最细 | 粗 | 全量 Zod | turn/item | part 级 | role 粗 | ❌ 信息不存在，GUI 阶段态降级 |
| usage 回传 | ✅ | ✅ | ✅ | ✅ | ✅ | ◐ 部分（meta） | ❌ 缺的部分显示降级 |
| cost 回传 | ❌ | ❌ | ✅ | ❌ | ❌ | ❌ | ❌ |
| steer 插话 | ✅ RPC（链路未接通，首期 unsupported——见 D3） | ❌ | ✅ | ◐ 仅 app-server | ◐ 仅 server | ◐ 仅 server | ◐ 首期 unsupported；未来 run+resume 冷仿真 |
| interrupt 中断 | ✅ | ❌ | ✅ 一等 | ✅ | ✅ | ◐ 仅 server | ✅ 公共杀链兜底 + 终态合成（D1） |
| conversation 多轮 | ✅ idle 复用 | ❌ | ❌ | ❌ | ❌ | ❌ | ◐ 宿主 idle timer + cold resume 仿真（体验降级） |
| resume 续聊 | ✅ | ✅ 冷 | ✅+fork | ✅+fork | ✅+fork | ✅ | 不需要（冷热之别） |
| OS sandbox | ❌ | ❌ | ❌ | ✅ 跨平台不齐 | ❌ | ❌ | ◐ worktree 仅文件写维度，无网络/进程隔离 |
| 环境隔离 | ✅ | ✅ HOME | ✅ | ✅ | ✅ | ✅ | ✅ per-engine preparer（D5） |
| 凭据注入 | models.json | config.json | env | env_key | auth.json | config.toml 不走 env | ✅ preparer 生成 |
| 权限模式 | ✅ | ✅ | ✅ 6 档 | ✅ | ✅ ruleset | ❌ 固定 auto | ◐ kimi 声明 ignored，其余映射 |
| 工具 denylist | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ 中立 denylist + 语法映射 |
| 嵌套防护 | PI_SUBAGENT_* | ❌ | CLAUDECODE | 机制变动期 | ❌ | ✅ 内置完善 | ✅ 统一 env 标记 + 清理原生标记（D8） |
| CLI 超时 | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ 公共杀链，6/6 全缺全补 |
| session 读取 | jsonl | sqlite 逆向 | 官方 API | thread/read | REST | wire.jsonl 勿手改 | ✅ D6 三级降级链 |
| 契约稳定性 | rpc.md | 逆向无契约 | Zod | 机器 schema | openapi | 文档化 | ✅ 分级探针 + golden 回归（D7/D12） |

补不了的硬差异仅四条，全部是「信息/能力在引擎侧根本不存在」：粗粒度引擎的实时事件流、kimi 完整 usage 与五家 cost、kimi headless 权限模式、引擎可用模型范围（受 provider 体系约束）。其余缺失（schema 4/6 缺、超时 6/6 缺、sandbox 5/6 缺）由公共层写一次全引擎复用——这是 D4「降级归属公共层」的回报。

## 附：与早前「全量 zcode 适配」评估的关系

本设计是 `feat-support-zcode` 分支早前全量评估（主链路换 zcode，月级工程）的最小切口先行方案：不动主会话引擎、不动其余 19 个 extension、不动 shared 协议与 renderer。若未来走主链路多引擎化，本设计的 EnginePort/中立类型/降级层直接是复用资产（ZcodeEngine 的驱动代码可整体搬去 runtime 层）；若不走，本设计独立成立（subagent 多引擎本身有产品价值：不同引擎绑不同账号体系与优势模型）。
