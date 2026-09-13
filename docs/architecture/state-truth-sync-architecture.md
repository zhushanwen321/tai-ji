# 状态真值同步架构优化：单一解析层 + 等价性守卫 + 对账收敛

> **一句话结论**：「新 session 生效配置」收敛为单一解析模块 `resolveLaunchConfig`（显示与创建共用同一输出，构造性保证「所见即所建」），配套等价性机器守卫防复发、改状态回执契约机器化、fork/handoff 源真值继承，对账机制按「保核心 / 收编 / 删除」三分处置收敛。

**层声明**：当前层 = 技术方案设计（架构改造）；下一层 = dev-flow 实施计划（分批 impl-plan）。本文设计深度止于下一层单元拆分，不到函数签名级实现。

**行号锚点声明**：本文行号锚点以 impl-plan 基线 7fd3d100e 时点为准，现势符号位置以代码实读为准。

---

## §1 背景目标

**用户看到的配置就是实际生效的配置，且这条等价性由结构保证、由机器守卫，不再靠人肉纪律。**

- **S（情境）**：xyz-agent 是 Electron + Vue 3 + Node runtime 的 AI Agent 桌面工作台。renderer 持有 session 状态副本，runtime/pi 持有真值，两者经 WebSocket 广播 + RPC 同步。landing 页（新建任务空态）的 composer 有一排 chip：模型、思考档位、预设、目录。
- **C（冲突）**：landing 模型 chip 显示的模型与发送后实际生效的模型不一致——用户看到 A、实际跑 B（trace 证实）。这不是第一次：「显示值 ≠ 生效值」家族已有 6 起有据事故、本次是第 7 起（§2.4 时间线），每次单点修复后换个形态复发；全库积累 ~45 处手工对账机制对付状态同步竞态，复杂度仍在增长。
- **Q（问题）**：如何让「显示值 ≡ 生效值」成为结构性成立（by construction）而非逐点修补出来的性质，同时把对账机制收敛到「只为真正的外部异步真值服务」的最小核心？
- **A（答案）**：单一解析层（landing 配置的显示与创建消费同一 resolve 输出）+ 等价性机器守卫（显示 ≡ 创建入参 ≡ pi 读回值，三段等价进测试）+ 改状态回执契约机器化 + 对账机制三分处置。本文展开这个答案。

### 1.1 问题定义（Step 0 三问）

1. **用户描述的问题**：landing composer 选中/显示模型 A，发送后对话流 composer 与 trace 显示模型 B；且「系统太脆弱，总是出这类问题」。
2. **是不是真问题**：是。代码实读确认显示链（`pendingModel → lastUsedModel → defaultModel`，`packages/core/src/domain/composer/model-thinking.ts:209`）与生效链（`pendingModel → preset.modelOverride → pi 全局默认`，`flow.ts:264` → `session-message-handler.ts:185` → `session-lifecycle.ts:268`）是两条独立 fallback 链，`lastUsedModel` 只存在于显示链。两条链各自「按设计正确」，组合起来必然发散。
3. **隐藏的根本问题**：不是「landing 少传了一个字段」，而是——**同一概念值（「新 session 用什么配置」）在仓内有 ≥5 个独立解析点，无单一真源函数**；以及更广泛的「renderer 副本 vs runtime/pi 真值」同步靠每个特性手工发明对账机制，无共享抽象、无裁决标准、无机器守卫。只修 landing 模型这一个点，等于第四次重演历史上三次「修好了」。

### 1.2 设计目标（从使用者体验倒推）

- **G1 所见即所建**：landing 页 chip 区显示的模型/档位/预设，就是发送后新 session 实际生效的配置；trace 与对话流 composer 必然一致（构造性一致，非对账出来的一致）。
- **G2 改状态即见生效值**：任何「请求值 ≠ 生效值」的改状态操作（pi 钳制档位、pattern 引擎换模），UI 从回执生效值更新，永不显示请求值假值；这条纪律从人肉执行升级为机器强制。
- **G3 对账只留核心**：全库对账机制按「为外部异步真值服务（保留）/ 同构重复（收编为共享原语）/ 根修后失去存在理由（删除）」三分处置；新增 session 级状态不再需要手工发明对账。
- **G4 复发有机器拦截**：「显示 ≡ 生效」等价性进入测试与 runtime 对账探针，未来任何新链路引入发散时 CI/dev 即刻拦截，不再活到用户手里。

### 1.3 Scope

**In scope**（对应架构审查候选 C1-C5）：
- C1：landing 生效配置单一解析层（model / thinkingLevel / presetId / cwd），消除发散 ①②③；skills 的 preset noSkills 边缘：生效侧随 D3 对齐（preset 生效则 noSkills 生效），显示侧残留发散声明为已知残留（D10-E10 自愈路径），不在本设计三批内
- C2：「显示 ≡ 生效」等价性守卫（测试层 + runtime 对账探针）
- C3：对账机制三分处置与两族共享原语抽取（in-flight 去重族、KV 单键族）
- C4：「改状态必回生效值」契约机器化 + 乐观/回执裁决标准
- C5：fork/handoff 双入口模型继承语义统一
- landing 的 cwd 显示链的发散残留（两空静默落 homedir 补 toast，D10-E7）随 C1 一并处理

**Out of scope**：
- 已建 session 的模型/档位切换链路（armed 意图族保护的是 pi 异步事件时序，属「外部异步真值」核心对账，本设计保留不重构；仅受 C3 处置框架登记）
- 打包/环境边界家族（env 出站契约、pnpm store 等，已由 C-proc-09 等机制化，不属本次）
- 消息流 seq/reconcile 机制（已收敛，不动）
- pi 源码（MANDATORY 不改 pi；所有适配在 xyz-agent 侧）

---

## §2 现状与问题分析

**landing chip 区的每个 chip 都有两条互不知情的解析路径：一条决定「显示什么」，一条决定「创建什么」。**

### 2.1 使用者视角的现状（真实例子）

landing 页 chip 区（`packages/renderer/src/components/new-task/Landing.vue` 模板 `#meta-row` slot）有四个 chip：目录、分支、预设、（composer 工具条内）模型 + 思考档位。

**本次 bug 的完整事件序列**（用户实遇）：

1. 用户此前在某 session 显式切到模型 `zai-coding-cn/glm-5.3` → `onModelSelect` 非 staging 分支写 `lastUsedModel` KV（`model-thinking.ts:385/402`，key `xyz-agent:last-used-model`）
2. 用户回到 landing 新建任务，**没有碰模型 chip**。chip 按显示链兜底：`pendingModel(null) → lastUsedModel('zai-coding-cn/glm-5.3')` → **显示 GLM-5.3**
3. 用户输入消息发送 → `submitFirstMessage` 只透传 `pendingModel.value`（null，`flow.ts:264`）→ `session.create` 无 `modelOverride`
4. runtime 创建链：`modelOverride(无) → preset.modelOverride(无 preset) → pi 全局默认`（`launch-params.ts:165` → `rpc-client.ts:169-173` 读 pi settings.json `defaultProvider/defaultModel`，用户机器上 = `xiaomi-token-plan-cn/mimo-v2.5-pro`）
5. 进入对话流，composer 切「已建态」读 session 真值（get_state 读回播种）→ **显示 MiMo-V2.5-Pro**；trace 同

用户视角：「我明明选中的是 A」——实际上他选中的是显示层的兜底值，生效层从未见过它。

### 2.2 物理数据流图（现状）

```
【显示链】landing chip 显示什么
  KV xyz-agent:last-used-model ──┐
  flow.pendingModel（显式选择）──┼─→ model-thinking.ts:209 regularModelId
  settingsStore.defaultModel ────┘   = pendingModel || lastUsedModel || defaultModel
                                       → chip 显示 + useQuotaDisplay 跟着此值走

【生效链】session 实际用什么（与显示链零共享）
  flow.pendingModel ──→ submitFirstMessage → session.create payload.modelOverride
  preset.modelOverride ──→ launch-params.ts:165 effectiveModel = override ?? preset
  pi settings.json 全局默认 ──→ rpc-client.ts resolveStartModel（两者都空时兜底）
                                       → pi spawn --model → get_state 读回播种
                                       → 对话流 chip（已建态真值）+ trace
```

两条链唯一的交集是第一个节点 `pendingModel`——只在用户**显式点击**时非空。用户不点，两条链在第二节点必然分叉。

### 2.3 失败模式清单（全部实读核实，附触发条件）

**主榜：确认发散（显示 ≠ 生效，用户可见出错）**

| # | 失败模式 | 触发条件 | 证据锚点 |
|---|---|---|---|
| ① | landing 模型显示 ≠ 生效（本次 bug） | lastUsedModel ≠ pi 全局默认，且用户不点 chip 直接发送 | 显示链 `model-thinking.ts:209`；生效链 `flow.ts:264` → `launch-params.ts:165` |
| ② | preset chip 回显 ≠ 透传 | landing chip 显示「默认预设 X」（`packages/ui/src/features/new-task/PresetSelectChip.vue:143-155` onMounted 回显 `defaultPresetId`，**不 emit select**，B6 刻意「回显≠透传」），`pendingPreset` 保持 null → runtime 完全不解析 preset（`session-lifecycle.ts:443` `presetId ? resolve : undefined`）——chip 显示的预设可能带 modelOverride/工具限制，实际 session 以无 preset 创建 | 另：FR-15 perCwd 默认特性全链（`preset.getCwdDefault / setCwdDefault / getCwdDefaults` 三通道，`preset-service.ts:427`、`protocol.ts` 类型段、`preset-message-handler.ts` 三 handler）renderer/core **零消费**，纯死链 |
| ③ | preset.thinkingLevel 被永久遮蔽 | landing 挂载时 immediate watch（`model-thinking.ts:281`）必给 `localThinkingLevel` 赋自动值（记忆档/最高档）→ 发送恒传 `thinkingOverride`（`send.ts:237`）→ `launch-params.ts:168` 的 `resolution?.thinkingLevel` 永不触达。用户在 preset 里配的档位对 landing 新建 session **永不生效** | 显示侧自洽，但配置 ≠ 生效 |
| ④ | fork/handoff 快捷路径丢当前模型 | sidebar 快速 fork（`useForkActions.ts:58-70` 不传 override）：runtime `resolveForkInheritedBindings`（`session-lifecycle.ts:1082`）继承源 **preset**（或 builtin:full），模型落 preset.modelOverride ?? 全局默认；⌘H handoff（`useHandoffActions.ts:108` 无 staging）：`handoff-service.ts:273-278` 走 `sessionService.create` 只传 override、**不传 presetId** → 不解析任何 preset，模型落 pi 全局默认。两者都**不继承源 session 当前切换后的模型**；而 staging 路径（fork-ask）快照当前值。同一用户意图，入口间结果不同 | 新 session chip 读自身真值（显示自洽），但用户预期「带着当前模型继续」落空 |

**次榜：已被护栏兜住（列出为防误伤，C3 处置时属「保留」类）**

- thinkingLevel 已建态三链已收敛（回执生效值 + 读回播种 + 独立帧补齐 + 纪元守卫）
- cwd 有 INV-7 降级 toast 护栏（残留：两空时 `create('')` 静默落 homedir 无提示；INV-7 窗口内 branch chip 短暂显示死目录分支）
- usage/tokenCount 单一 owner + 哨兵；scopedModels×defaultModel 有广播收敛；label 双写源已收口

### 2.4 复发时间线（「总是出这类问题」的证据）

基于全量挖掘（6281 条 commit 中 fix 类 2427 条占 39%、64 篇 ADR、92 条约束登记、troubleshooting.md 全文）：

| 时间 | 事故 | 修法 |
|---|---|---|
| 2026-08-20 | thinking 档位钳制登记进 troubleshooting 观察项 #4 | 登记（人读） |
| 2026-08-27 | 事故 B：设最高档过一会自动变关——乐观写请求值，pi 钳制后无人回读 | C-pi-13「改状态 RPC 一律回生效值」机制修 |
| 2026-08-27 | 事故 A 附属：终态统一坍缩 `closedReason:"gc"`，三处下游各自重新推导成败 | 单点修 |
| —— | structured-output：校验 LLM 自报 schema 致修复静默丢失（自报值 ≠ 权威值同族） | 方案 A：唯一权威 schema 校验 |
| —— | u3 记忆表被非用户动作污染（auto 值经首发透传写进 per-model 记忆） | u3 D2 跟随 watch 门禁 |
| 2026-09-04 | composer-model-chaos：session 模型串台 + restore 窗口假值，6 机制根因、4 轮对抗 review | D1-D5（sidecar 持久化 / 显示分流 / 移除 config.defaults 广播 / lastUsedModel KV） |
| **本次** | lastUsedModel 进了显示链但没进生效链 | D4 修上一个问题时引入的新形态 |

**元教训**：人读登记 / review 级约束挡不住复发（8-20 登记了照样 8-27 犯）；机器守卫落地后该类才真正止血（②时序、③双写、⑤协议漂移三族均如此）。「显示 ≠ 生效」是目前唯一尚无机器守卫的高发族。

### 2.5 根因分析（四层）

- **R1 多链解析无单一真源**：同一概念值「新 session 用什么模型/档位/预设」在 ≥5 处独立解析（landing 显示链 / flow 透传链 / runtime 创建链 / runtime 播种链 / pi 启动默认链），fallback 顺序各异。①②③④ 全是这一根因的实例。
- **R2 对账无共享抽象**：「renderer 副本 vs runtime/pi 真值」的同步竞态，由每个特性手工发明对账机制——全库 ~45 处独立机制，6 族同构重复（in-flight 去重 6+ 处 / epoch 守卫 4 形态 / 失效重拉 4 处 / 订阅规避 3 解法 / KV 镜像 2 处 / 乐观裁决 2 种相反结论）。`ReplicatedState`（runtime 标量域）是唯一一次通用化，renderer/core 未跟进。
- **R3 裁决无标准**：同一「请求值 ≠ 生效值」竞态，`usePiPresets` 选乐观写+回滚、`useModel` 选弃乐观写用回执值——相反裁决并存，因为没有「何时可乐观」的裁决标准。
- **R4 验证缺口**：既往验收只断言「显示对」（如 D4 验收 V6 只截 chip 图），从未断言「显示 ≡ 生效」端到端等价；约束登记（C-pi-13）靠人肉执行，新链路照常绕过。

### 2.6 术语锚定（首次出现，绑 §2.2 例子）

- **生效配置（LaunchConfig）**：新 session 创建时实际生效的一组配置 {model, thinkingLevel, presetId, cwd}。在 §2.2 里，就是「生效链」末端 pi 真正用到的那些值。
- **显示链 / 生效链**：§2.2 图的上下两行。显示链 = chip 渲染取值路径；生效链 = session.create → pi spawn 取值路径。
- **真值 / 副本**：真值 = pi 进程内实际生效状态（get_state 可读回）；副本 = renderer sessionStore 的镜像。已建 session 的 chip 读真值（经读回播种），landing 的 chip 无真值可读（session 未创建）——这是 landing 需要解析层的根本原因。
- **回执生效值**：改状态 RPC 的 reply 携带 pi 实际生效的值（可能被钳制/改换），而非请求值。C-pi-13 已登记此纪律。
- **对账机制**：为让副本逼近真值而写的守卫/补偿代码（armed 意图、epoch 守卫、防抖重拉等）。§2.5 R2 的 45 处。

---

## §3 解决方案

### 3.1 终态（使用者视角）

**终态一句话：landing chip 区显示的每个值，就是新 session 生效的值；显示旁有来源可见性（哪些是自己的选择、哪些是默认）；改状态操作永远显示回执生效值。**

**交互样例 1：landing 新建（成功路径，验证 G1）**

```
[用户] 此前在别的 session 显式用过 GLM-5.3 → 回 landing
[chip 区] 模型 chip 显示「GLM-5.3」（来源：上次选择）；预设 chip 显示「全工具模式」（来源：默认）
[用户] 不点任何 chip，输入「帮我重构这个函数」发送
[系统] resolveLaunchConfig 解析：model=zai-coding-cn/glm-5.3（lastUsed）、thinking=记忆档、preset=builtin:full
[系统] session.create 携带解析终值 → pi 以 GLM-5.3 启动
[对话流] composer 模型 chip 显示 GLM-5.3，trace 显示 GLM-5.3 —— 与 landing 所见一致（构造性）
```

**交互样例 2：landing 新建（失败路径：上次选择的模型已失效，验证 G1 的恢复）**

```
[用户] 上次显式用过的模型 provider 已在 Settings 删除/禁用
[chip 区] 模型 chip 显示全局默认模型（lastUsedModel 被有效性校验跳过，KV 保留原值不覆写）
         —— 不显示死模型；无 toast 打扰，静默回落即恢复指引
[用户] 发送 → 新 session 生效 = chip 显示的全局默认
[用户] 重新启用该 provider → landing chip 自动回到用户上次选择（KV 原值恢复生效）
恢复指引：想用别的模型 → 点模型 chip 重选（popover 只列有效模型）
```

**交互样例 3：预设生效（验证 G1 + 修复②③）**

```
[用户] 在 Settings 把「只读模式」预设（allowlist: read/grep/find/ls，thinkingLevel=off）设为默认
[chip 区] 预设 chip 显示「只读模式」；思考档 chip 显示 off（preset 档位进入解析链，不再被自动值遮蔽）
[用户] 发送 → 新 session 实际以只读工具集 + off 档创建（pi get_commands 读回验证）
对比现状：chip 同样显示「只读模式」，但实际以全工具 + 最高档创建（②③）
```

**交互样例 4：快捷 fork（验证 G1 + 修复④）**

```
[用户] session A 里把模型切到 GLM-5.3-Flash（全局默认是 MiMo）
[用户] 右键消息「Fork」/ ⌘H handoff
[系统] 新 session 继承源 session 当前生效值 GLM-5.3-Flash（runtime 从源真值读取，无需 renderer 传参）
对比现状：快捷 fork 落 preset/全局默认（MiMo），staging fork-ask 才继承 Flash —— 两入口统一为继承当前值
```

**错误统一恢复原则**：所有「配置无法按预期生效」的失败路径，恢复指引统一指向 chip 区重选（显示层即权威入口）；runtime 创建失败沿用现有差异化 error code（MODEL_NOT_CONFIGURED → 引导 Settings）。

### 3.2 总体方案对比

| 方案 | 长期架构 | 短期成本 | 风险 | 裁决 |
|---|---|---|---|---|
| **A：单一解析层 + 快照契约（选）** | 「新 session 生效配置」从 ≥5 个解析点收敛到 1 个纯函数模块，显示与创建共用输出——发散 by construction 不可能；新增 landing 配置项自动继承等价性 | 中：新增 core 模块 + 三处消费方改线（chip 显示 / submit / create 契约）+ preset 默认生效化行为变更 | preset 默认生效化改变「从未设默认预设」以外用户的行为（builtin:full 等价性 ✅ 探针 P2 已实跑验证，等价成立）；renderer 解析需持有 preset 数据（已有 preset store ✅） | ✅ |
| B：双链保留、逐点对齐 | 架构不变，给生效链补 lastUsedModel fallback、给 preset 补透传、给 thinking 补 preset 档——即历史上三次「修好了」的修法第四次重演 | 小：每点 5-30 分钟 | 四条链的 fallback 顺序仍各自演化，下一个配置项（permission mode 等）进来即再发散；无机器守卫，复发无拦截 | ❌ 若用它，§3.1 样例 1 这次对了，但样例 3 的 preset 与 thinking 仍各说各话；且明年第五起同族事故照犯 |
| C：runtime 集中解析（renderer 发裸 pending 值，runtime 做全部 fallback） | 真源在 runtime 一侧更「权威」 | 大：landing 态无 session，需新增「预解析 launch config」RPC；chip 显示变异步（loading 态/闪烁窗口）；perCwd 默认等数据要全部下发或实时询问 | 显示即时性受损（landing 是首页，首屏 chip 等 RPC 不可接受）；解析逻辑从 renderer 移到 runtime 但仍是一个新模块，复杂度未减只是搬家 | ❌ 若用它，§3.1 样例 1 的 chip 在 RPC 返回前显示占位/旧值，landing 首屏体验回退 |

**推荐理由（A）**：解析所需的全部数据（providers 能力表、preset 列表与默认、全局默认、lastUsedModel KV、记忆表）renderer 均已持有（settings store / preset store / core KV 模块），无需新 RPC；解析做成纯函数后 display 与 submit 消费同一输出，等价性是构造性的而非对账性的——这是唯一让「显示 ≡ 生效」不再依赖人肉纪律的形态。B 是被历史证伪三次的路线；C 用首屏体验换「权威位置」，但权威位置不解决多链问题（链还在，只是搬了家）。

### 3.3 关键决策与权衡

**D1：`resolveLaunchConfig` 单一解析模块（C1 核心，选定）**
- **采用**：新增 core 域模块 `packages/core/src/domain/new-task-search/launch-config.ts`，纯函数 `resolveLaunchConfig(input): LaunchConfig`。输入 = pending 三兄弟（显式选择）+ 生效 preset 解析 + lastUsedModel KV + 记忆表 + providers 能力表 + 全局默认；输出 = { model, thinkingLevel, presetId, cwd } + **每字段 provenance 标签**（`explicit / preset / lastUsed / memory / default`）。三个消费方全部改读它的输出：① chip 显示（`model-thinking.ts` landing 分支）；② `submitFirstMessage` → `session.create` 透传解析终值；③ PresetSelectChip 回显（替代 B6 本地 echo ref）。provenance 同时供 UI 角标（如「默认」样式）与对账日志。store 数据经 deps 注入（遵守 core 零 store 依赖约束，同 ModelThinkingDeps 先例）；KV/记忆表模块为 core 域内单例直接 import（同 model-thinking 先例）。**explicit 输入的 authored 守卫（结构性保证）**：landing auto 值机制（follow watch、landing armed 设立及其消费写 localThinkingLevel）与 resolve 的 memory tier 是两个 auto 值源，并存必然发散（auto 值被误标 explicit 时 D2 的 preset > memory 序直接反转），U2 同批删除（已建 session 的 armed 族不动）——删除后 **`localThinkingLevel` 的唯一写点 = `onThinkingSelect`**，resolve 直读 `localThinkingLevel` 即等价于 authored 值（单一写点结构保证，G1 单源不新增快照机制；唯一理论例外 = 分支 3 安全网，见 D10-E10）。**submit 侧加载窗口语义**：`submitFirstMessage` 在 create 前先 `await ensureLaunchDataReady()`（presets 列表 / defaultPresetId / providers / lastUsedModel KV / 记忆表五者的加载完成 Promise；已加载即同步返回）——加载完成前 resolve 输出是占位值，直接发送会把占位值永久固化进新 session（设了「只读模式」默认预设的用户在冷启动窗口内新建会拿到全工具）。加载是本地 WS + localStorage，常态毫秒级（✅ P5 已实跑：单测 + Gate B V1 场景实测毫秒级）；**尾部语义**：相关 RPC 均有 65s backstop 强制超时（transport pending/request 层）+ WS 断开 fast-fail rejectAll + KV=localStorage 同步读——不会永久卡死；await 期常态无感，超阈值（如 1s）发送按钮显 loading 态（实现层细节）；五者各自加载失败按 E1/E4 既有语义收敛后继续（回落默认，不阻塞发送）
- **被否**：解析放 renderer composable 层——core 是 composer/session 域所在层，flow.ts（submit）也在 core，放 renderer 会把 core flow 反向依赖 renderer；解析放 runtime——见 §3.2 方案 C
- **证据**：双链坐标 §2.2；core deps 注入先例 `model-thinking.ts` ModelThinkingDeps；KV 模块 `last-used-model.ts` 已是 core 域单例
- **效果**：G1 成立（显示 ≡ 生效 by construction）；①②③ 结构性消除

**D2：字段优先级序（选定）**
- **采用**：
  - model：`explicit（pendingModel）> preset.modelOverride（生效 preset 的）> lastUsedModel（校验后）> 全局默认`
  - thinkingLevel：`explicit（用户本次选档，authored-guarded——仅 `onThinkingSelect` 置位的值，不含任何 auto 写入）> preset.thinkingLevel > 记忆表（per-model 记忆档，可用性校验后）> 最高可用档`
  - **记忆表防污染：记录路径收窄为 authored-only（与 thinking 序配套，缺一不可）**：preset 档首次进入 landing 生效链后，任何「生效即记录」语义的通道都会把 preset 档反查写进 per-model 记忆表——反例：mem[glm-5.3]=max → 设 off 档默认预设 → landing 直发生效 off → 记忆被覆写为 off → 删掉预设后污染永久留存；且重访/重挂/分屏第二实例/重启均会重演（记录 watch 是 `{immediate:true}` + 换绑不跳过，mount 即记录载入值）。处置（减法）：**记录点只挂 `onThinkingSelect` 显式入口**（三分支统一：landing 记当时选中模型；已建记 session 当前模型；staging 记 `stagingModel` 试选模型——选档动作的上下文模型即归属模型，三分支均是用户显式选择），记录时带 UI key + 可用性校验），**删除已建态「生效即记录」watch 及其纪元守卫/第三形态守卫全套**——非 authored 值（preset 档 / pi 归一档 / 钳制值 / session 加载值 / 切模型自动对齐值）结构性不再到达记录路径，防污染 by construction，无需任何门禁标记。反例重演：上述序列下 mem[glm-5.3] 保持 max（preset 档从未到达记录路径）→ 重访该 session（无 watch，安全）→ 手动调 high（onThinkingSelect 正常入表）→ 删预设后新建回到记忆档 ✅。语义变化声明：记忆从「用户实际生效的档」收窄为「用户显式选过的档」——被动加载老 session 不再入表（该通道同时是 armed 纪元/第三形态守卫存在的唯一理由，一并删除属 G3 净减法）
  - presetId：`explicit（pendingPreset）> 全局默认预设 > builtin:full`
  - cwd：`explicit（pendingCwd）> 最近 session 目录预填 > defaultCwd`（现行为不变，INV-7 toast 护栏保留；补「两空静默落 homedir」提示——见 D10-E7）
- **被否**：lastUsedModel > preset.modelOverride——preset 是用户当次或默认选择的**捆绑包**，其 modelOverride 是捆绑意图的一部分（用户选「GLM 专用预设」就是要 GLM）；lastUsedModel 是跨任务的便利默认，deliberate bundle 优先于便利默认。若用它，§3.1 样例 3 变成：用户设了带模型的默认预设，chip 显示 lastUsed 的旧模型，预设意图落空。~~记录 watch 保留 + creationProvenance 内存一次性门禁~~（v2 方案，被两轮独立击穿：①「首个记录 flush」相对记录 watch 四道既有守卫未锚定——可用性守卫跳过播种 flush 时标记悬留，吃掉用户下一次手动调档；②内存标记只罩首次绑定，重访/重挂/分屏第二实例/重启全部绕过）；~~provenance 持久化到 session meta~~（引入 wire 面 + 「用户改回同值」边界 + 比较语义，复杂度高于收益）
- **证据**：runtime 现有生效序即 `override > preset > 全局默认`（`packages/runtime/src/services/session/launch-params.ts:165` C-RL-6），D2 与之同向（把 preset 档提到 lastUsed 前 = 把已成立的 C-RL-6 优先级延伸到显示链）；记忆表可用性校验先例 `model-thinking.ts` followRememberedOrDefault；记录 watch 条件 b 原文实读（`model-thinking.ts` 记录 watch 注释，即污染通道本体）；L1 含「记录路径结构性无 watch + onThinkingSelect 入表」断言（D7）
- **效果**：③（preset.thinking 遮蔽）消除；②的模型子情形消除；防污染 by construction（门禁零新增，反而净删一套守卫）；V8 恢复路径（armed 消费）不受影响。**已接受代价**（语义收窄，四要素）：记忆从「用户实际生效的档」收窄为「用户显式选过的档」——①被动加载老 session / pi 旁路调档不再入表（本产品 pi 是 runtime 子进程，CLI 旁路近似不可达；旧通道实证污染大于学习——被删的两套守卫存在理由就是拦它）；②armed 恢复的值冻结在最后一次显式选择，不再被后续生效值刷新（陈旧档死角：用户长期用钳制/归一后的档但未手动选过，记忆停留在旧显式值）——量级：仅影响「选过档后再未显式调整」的用户，且恢复值仍是其本人选过的合法档；恢复路径：手动再选一次即更新记忆；重审触发：收到「记忆档陈旧/不随使用更新」反馈即重审；显式判定：可接受——「显式选择语义」比「被动学习」更忠实于用户意图，且同时关闭全部污染通道。**staging 试选留痕声明**：staging 试选后取消（未 commit）/ landing 选后未发送，记忆已在选择时刻留痕（记录不问生效）——这是对旧代码注释「暂存取消时不该入表」排除语义的**刻意反转**：与「显式选过的档」语义一致（用户确实选过），双向可用性校验兜底，良性自愈，声明于此防验收误报

**D3：默认预设生效化（修复②，选定）**
- **采用**：landing 的生效 presetId = 解析输出（explicit pendingPreset > 全局默认预设），创建时透传。**出厂等价判定**：新增工具函数 `isFactoryFullPreset()` 逐字段比对「merge 后的 builtin:full」与出厂 DEFAULT 定义——比对键 = PiLaunchPreset 的 **10 个 launch 生效字段全集**（toolMode / allowedTools / deniedTools / extensionMode / allowedExtensions / deniedExtensions / modelOverride / thinkingLevel / noSkills / noContextFiles；`packages/shared/src/pi-preset.ts:51-95` 类型实读。skillPaths **不是** preset 字段——它是 resolution 派生输出，不在比对集）。**穷尽守卫**：比对键列表用 TS 映射类型对 PiLaunchPreset 生效键编译期强制（新增生效字段时类型红）+ 守卫测试（枚举比对键 vs 类型键全集）——防未来 schema 加字段被静默误判出厂——**出厂 builtin:full 时 resolve 输出 presetId=undefined 不透传**（行为与写入面全等现状：不传 presetId 的 session 不写 launchPresetId meta 与 .preset.json sidecar）；**builtin:full 被用户字段级覆写过**（savePreset 只保护 id/builtin/order/name 四字段，modelOverride/thinkingLevel/toolMode/扩展列表等均可改，`preset-service.ts:311-338`）→ 视为非出厂预设正常透传（生效与 chip 显示一致）。设过非 builtin 默认预设的用户，chip 显示即所得；透传后每个新 session 写 launchPresetId meta + .preset.json sidecar——该写入面今日显式选预设时已存在（`session-lifecycle.ts:554/593-594`），只是频率变高；**V9-④ 根修注记（2026-09-09，3ba8d96ba）**：Gate B 实证 landing create 路径因 pi 延迟 flush × jsonl-exists 守卫结构性永不落盘（上句「已存在」在 create 路径被证伪），根修为 create 路径 sidecar 落盘经 skipJsonlExistsGuard 放行 jsonl-exists 守卫（pi 0.84.4 SessionManager 构造即生成确定性路径，.jsonl 未 flush ≠ session 无效；fork/restore 守卫不变，model 面留 turn-end tryPersistModelBinding 补偿）；.preset.json 已在 purgeSessionSidecars 清理清单（`session-lifecycle.ts:703` 实读），生命周期随 session 删除。B6 的「回显≠透传」刻意语义随之废除（它保护的是「不把回显伪装成用户选择」，本设计用 provenance 标签区分来源，比「显示一个永远不生效的值」更诚实）。FR-15 perCwd 默认特性全链（三通道 RPC + handler + 协议类型，perCwd > global > builtin:full 三级）不接入解析链（零消费 = 该特性事实上死亡；接入会给 resolve 热路径加异步 RPC），随 C3 批完整删除（范围见 §5 U9）并在 constraints 登记
- **被否**：chip 停止回显默认预设（空态「选择预设」）——「设为默认」功能（`onToggleDefault` 写 pi-presets.json）的产品意图就是「新任务默认用它」，空态等于功能烂尾；且 landing 四 chip 一贯「所见即所得」风格（目录 chip 预填最近 cwd 同构）。~~恒透传（含出厂 builtin:full）~~（v1 方案，被主审击穿：出厂等价只在未覆写时成立，恒透传会把「写入面扩大 + 覆写人群行为变化」藏在等价声称下）
- **证据**：`preset-service.ts:289-297`（默认预设存在性兜底 builtin:full）；出厂 builtin:full 内容实读（`packages/shared/src/pi-preset.ts:107-113`，全工具无 override）；字段级覆写面实读（`preset-service.ts:229-253` mergePresets 字段级合并）；死链 grep 证据 §2.3-②
- **效果**：②消除；「设为默认」功能首次真正生效。**已接受代价 1**：设过非 builtin 默认预设的用户，新 session 行为变化（工具集/模型按预设生效）——量级：仅影响设过默认预设且其 preset 与裸创建不同的用户；恢复路径：landing preset chip 一键改选/改默认；重审触发：若收到「默认预设不该生效」反馈即重审 D3；显式判定：可接受——这是「设为默认」的原意图，且 chip 始终显示生效预设名（可发现、可一键改）。**已接受代价 2**：手改过 builtin:full 字段但从未设默认预设的用户，覆写字段从「仅显式选 full 时生效」变为「每次 landing 新建生效」——量级：需手工编辑 pi-presets.json 覆写 builtin 的人群，极小众，且其改 full 的意图大概率就是希望它生效；恢复路径：改回 JSON 或在 Settings 改默认预设；重审触发：收到相关反馈即重审；显式判定：可接受（chip 显示与生效一致方向正确）

**D4：lastUsedModel 有效性校验（选定）**
- **采用**：resolve 消费 lastUsedModel 前校验：provider 存在且 enabled、model 在该 provider models 列表内（settings store providers 经 deps 注入）。失效 → **链内跳过（回落下一优先级），KV 保留原值不覆写**——provider 是临时禁用还是永久删除无法区分，非破坏性跳过让 provider 恢复后用户选择自动回来；resolve 保持纯函数（无 KV 写点），chip 显示回落值且 provenance=default（诚实标「默认」而非把系统行为错标成「上次选择」）。校验逻辑与 `findValidDefaultModel`（runtime `packages/runtime/src/infra/pi/pi-provider-store.ts:302/337`，`:445` getDefaultModel 调用点）同语义不同层
- **被否**：不校验（现行为）——provider 删除/禁用后 chip 显示死模型、实际跑默认（§2.3-①的恶化形态）；KV 写入时校验——写入时有效不代表读取时仍有效（provider 可在此后被删）。~~失效时 KV 自更新为最终生效值~~（v1 方案，被影响面审击穿：遗忘用户显式选择无恢复通道 + 系统写入值下次被 provenance 错标为「上次选择」+ 与 resolve 纯函数声称冲突 + split 多实例并发写未声明）
- **证据**：`last-used-model.ts` 全文件无校验逻辑（实读）；死模型场景 §3.1 样例 2
- **效果**：①的恶化形态消除；landing quota 展示（`useQuotaDisplay.ts:64` 跟 chip 值走）自动跟着对。**已接受代价**：provider 禁用期间用户看到的 chip 是全局默认而非其上次选择——量级：限禁用窗口期；恢复路径：provider 恢复后 KV 原值自动生效，零动作；重审触发：收到「禁用期间想强制用回上次模型」反馈即重审；显式判定：可接受（死模型本不可用，显示可用默认优于显示死模型）

**D5：session.create 契约快照化 + post-create 双重 apply 删除（选定）**
- **采用**：create payload 的 `modelOverride/thinkingOverride` 语义从「可选覆盖值」强化为「landing 解析终值」（landing 新建恒非空）。**runtime 侧 `buildPresetClientOptions` 形状不变**——它被 create/fork/restore 三入口共享（S-RT-4），fork/restore 与 agent-managed create（`packages/runtime/src/transport/session-manager-handler.ts:215`）不经 landing 解析层，其 `override > preset > 默认` fallback 链整体保留作兜底；landing 路径恒传解析终值后，preset 档对 landing 不可达但不删除（对其他入口仍在用）。分层原则：renderer 解析「用户可见配置的选择」（model/thinking/presetId），runtime 解析「preset 的内部展开」（tools/extensions/skills/noSkills，`resolveCreateLaunch` 不变）——renderer 不需要知道工具集细节。**post-create 双重 apply 随快照化删除**（处置声明，经审查补齐）：`createSessionFlow` step 7 `applyModel`（`create-session-flow.ts:227`）与壳层 C-W4-3 `setThinkingLevel`（`flow.ts:277`）在 landing 恒传终值后是对每个新 session 的同值二次 RPC（现状显式选择时已存在该重复），一并删除。landing 分支不再设立 armed（D1/U2 删除 landing auto 值机制），悬留问题结构性不存在；u3 的「armed 消费恢复记忆档」通道在 landing→已建转换场景不再必要——D2 后记忆档经 resolve 链随 create 直接透传，语义保持、路径更直（已建 session 的 armed 族不变）。连带：`create-session-flow.test.ts` 与壳层 composer 测试更新（U2 声明）。runtime 本决策的其余改动只有：L2 对账探针（D7）+ 契约注释语义强化
- **被否**：create 改传完整展开后配置（含 tools 等）——renderer 被迫理解 preset 内部结构，跨层泄漏；简化 `buildPresetClientOptions` 删掉 preset 档——fork/restore/agent-managed 入口共享该函数（S-RT-4 提取初衷即防三处漂移），删档 = 这些入口静默丢失 preset 模型继承（P0-12 接管绕过反模式）；保留双重 apply「兜底」——同值二次 RPC 让 armed 机制在全新 session 上空转，且恒传后无「override 未传」的 landing 场景可兜
- **证据**：wire contract 实读 `packages/shared/src/protocol.ts:291-303`（modelOverride/thinkingOverride 为 optional，条件 spread 在 `packages/core/src/transport/api/domains/session.ts:55-56`，向后兼容成立）；preset 展开在 runtime 的现结构 `resolveCreateLaunch`（`session-lifecycle.ts:443-450`）；双重 apply 实读（`create-session-flow.ts:227` step 7 + `flow.ts:277` 壳层补 apply）
- **效果**：runtime 侧「二次 fallback」对 landing 新建路径消除（单一解析在 renderer 完成）；每个新 session 少两次同值 RPC；wire 契约向后兼容（字段语义强化而非变更形状）

**D6：fork/handoff 继承源 session 当前生效值（C5，选定）**
- **采用**：runtime 侧两入口各加一档「源 session 当前生效值」，**两条链分别声明**（二者现状不同，不合并）：
  - **fork**：`staging override > 源 session 当前生效值 > 源 preset > 全局默认`——fork 现状本有「源 preset」档（`resolveForkInheritedBindings`，`session-lifecycle.ts:1082`），保留；新增档插在 override 与 preset 之间
  - **handoff**：`staging override > 源 session 当前生效值 > 全局默认`——handoff 现状走 `handoff-service.ts:273-278` 的 `sessionService.create`（不传 presetId，无 preset 档），**不新增 preset 继承档**（否则 handoff 将首次继承源 preset 的 tools/noSkills 全套限制——夹带行为变更，被影响面审查出后删除该档）
  源真值从 runtime 内存实例 meta 读（活跃 session）或 sidecar `.model.json` 读（pi 已退出/未恢复 session）——复用 restore-seeding 的 `readEffectiveModelFromState` 既有读取链（实施经偏差 #13 裁决改走 findScannedSession 薄适配——`readEffectiveModelFromState` 输入形态为 get_state 回执解析器，不匹配内存 meta/sidecar 双源，见 impl-plan 偏差 #13）。**「源当前生效值」字段范围 = modelId + thinkingLevel 两字段**（sidecar BINDING_FIELDS 家族 `.model.json` 同源两字段，`session-binding-fields.ts:87`），fork/handoff 承接 session 的模型与档位一并继承；其余绑定字段（projectId/label 等）各有既有继承通道，不在本决策。renderer 快捷路径（`useForkActions.forkSession` / `useHandoffActions` ⌘H）**不改调用形状**（仍不传 override），语义自动变对；staging 路径（fork-ask）行为不变（override 优先）
- **被否**：renderer 快捷路径从 session store 读真值传 override——store 是副本，restore 窗口/防抖窗口内可能读占位值；runtime 侧读源真值更权威（与 D5 分层一致：真值读取归 runtime）。全局统一「不继承」（现行为）——违背「从这里继续」的用户意图，且与 staging 路径矛盾。~~fork/handoff 合并为一条链（含源 preset 档）~~（v1 方案，被影响面审击穿：handoff 现状无 preset 继承，合并链给它偷渡了从未有过的 tools/noSkills 限制）
- **证据**：fork 现状实读（`session-lifecycle.ts:1082` 仅继承 preset/project）；handoff 现状实读（`handoff-service.ts:273-278` create 不传 presetId）；sidecar 读取链 `restore-seeding.ts:212-244` 已存在（实施经偏差 #13 改走 findScannedSession 薄适配）；✅ 探针 P4 已实跑（源真值可读性 + 陈旧窗口，三类源 + E9 回落全过，8f8d70b36）
- **效果**：④消除；两入口在「带着当前模型继续」语义上统一。**已接受代价**：sidecar 陈旧窗口——源 session 切模后未 restore 即死、随后被 fork 时读到旧 sidecar 值（restore-seeding 注释自证漂移窗口存在，靠 restore 读回自愈；fork 不触发源 restore）——量级：限「切模 → 未再激活 → 直接 fork」序列；恢复路径：fork 后 chip 改选；重审触发：收到 fork 模型不对反馈即重审；显式判定：可接受——严格优于现状（现状恒落 preset/默认，新链在 sidecar 新鲜的大多数情况继承当前值）

**D7：「显示 ≡ 生效」等价性守卫两层（C2，选定）**
- **采用**：
  - **L1 构造性等价测试**（core vitest）：输入组合矩阵（pending 有无 × lastUsed 有无/有效性 × preset 有无 × 默认有无）下断言 `chip 显示值 ≡ resolveLaunchConfig 输出 ≡ createSessionFlow 的 create 入参`，外加「记录路径结构性无 watch（grep 守卫）+ onThinkingSelect 显式入口正常入表」（D2 authored-only）与「窗口内 submit 在 ensureLaunchDataReady 后入参 = 加载后 resolve 输出」（D1）两条断言。D1 后三者同源，此测试是防未来改线回归的「结构锁」（参照消息流域 `apply-entry-equivalence` 先例：「live ≡ reload」构造性 + 测试守卫）
  - **L2 runtime 对账探针**（observability）：`readBackCreateState` 已有 get_state 读回——增加读回值 vs create 入参的比对，不一致时结构化 warn 日志（`[launch-config] effective mismatch: requested=… effective=…`）。**触发条件 = 仅不一致时，速率上限 ≤ 1 行/create**（人类操作速率有界 + 日志 date/size 轮转已机制化，无刷屏面）。**不设硬断言**：pi pattern 引擎静默换模/钳制是合法行为（读回播种已保证显示收敛到真值），此探针的目的是让「renderer 请求的与 pi 收到的」漂移可观测、可 grep 排查，而非判死
- **被否**：只做 L1——L1 防 renderer 内部改线回归，防不了 wire 契约漂移（runtime 侧改了解析顺序）；L2 设硬断言抛错——pi 合法钳制会误杀（同 zcode 300s 墙钟误杀教训，规则 19「量级按对象粒度校准」）；e2e 层再加 Playwright 等价断言——L1 已锁结构，e2e 留 §4 真实场景验收人肉/半自动执行，不进 CI 防线（性价比低）
- **证据**：等价性测试先例 `apply-entry-equivalence`（AGENTS.md 规则 9）；读回播种实装点 `session-lifecycle.ts` readBackCreateState；元教训 §2.4（机器守卫才止血）
- **效果**：G4 成立；①类家族首次有机器守卫

**D8：改状态回执裁决标准 + 协议层机器强制（C4，选定）**
- **采用**：
  - **裁决标准（落 ADR）**：「后端可能变换请求值的 mutation（pi 钳制/pattern 换模）→ 禁乐观写，回执生效值唯一写 store 路径；后端原样存储的 mutation（preset CRUD、项目重命名等 runtime 自有数据）→ 允许乐观写 + reply 权威覆盖 + 失败回滚」。现有两个域恰好已分居两侧（`useModel` 回执值 / `usePiPresets` 乐观+回滚），裁决标准把它们从「相反结论」变成「同一条规则的两个合法实例」
  - **机器强制**：① shared 协议类型层——mutation 类 RPC 的 reply 类型强制含生效值字段（`XxxMutationReply = { effective: … }` 命名约定 + 类型必需字段，编译期强制；落地形态见 ADR-0065「二、机器强制」：reply 复用既有形状、生效值字段必需不 optional，非字面 effective 命名）；② runtime 契约测试——枚举全部 mutation RPC（model.switch / session.setThinkingLevel / preset.* / session.rename …），逐一断言 reply 携带生效值字段（新增 mutation 不入清单即测试红）
- **被否**：全禁乐观写——runtime 自有数据（preset CRUD）无 pi 变换，乐观写有真实体验收益且 reply 覆盖幂等已有先例；纯人肉纪律（C-pi-13 现状）——§2.4 元教训已证伪
- **证据**：C-pi-13 登记（constraints.json）；相反裁决并存实证（`usePiPresets.ts:76-133` vs `useModel.ts:10-61`）
- **效果**：G2 成立；新 mutation 诞生即被套上契约，①类复发的上游被机器拦截

**D9：对账机制三分处置（C3，选定——「只保留核心对账」的执行框架）**
- **采用**：全库 ~45 处对账机制按下表三分处置。**判据**：该机制对抗的竞态根源是「外部异步真值」（pi 事件时序/钳制/静默换模/进程死亡——xyz 无法消灭的）还是「自致发散」（双链解析/乐观写无回执/多真源——本设计根修的）？
  | 处置 | 判据 | 代表（盘点证据见 §2.5-R2） |
  |---|---|---|
  | **保留（核心对账）** | 对抗外部异步真值 | armed 意图族（pi `thinking_level_changed` 独立帧时序）、回执生效值写 store（pi 钳制）、readback 播种（pattern 换模）、ReplicatedState、消息流 seq/reconcile、dead 穿越守卫、session 隔离 Map 分区（ADR-0049） |
  | **收编为共享原语** | 同构重复 ≥3 处且语义真同构 | in-flight 去重族 6+ 处 → `createInflightDedup()` factory（core foundation，与 `useSessionScopedState` 同层）；KV 单键族 2 处逐字节镜像 → `createKVSlot(key)` 参数化 factory（吸收加载窗口守卫 + deferred persist + persistChain）。epoch 守卫族 4 形态语义差异真实（seq 簿记 vs 三元组比较），**不强抽**，以 D8 裁决 ADR 统一记录各自合法域 |
  | **删除（根修后失去存在理由）** | 存在理由 = 自致发散，根修后不可达 | B6「回显≠透传」本地 echo ref 机制（D3 后 chip 直读 resolve 输出）；**landing auto 值机制**（follow watch `followRememberedOrDefault` + `localAuthored` 冻结标志 + landing 分支 armed 设立——与 resolve 的 memory tier 是两个 auto 值源，U2 同批删除，`localThinkingLevel` 只存 authored 值，唯一例外见 D10-E10）；**「生效即记录」watch 及纪元/第三形态守卫**（D2 authored-only 后非 authored 值结构性不可达，U2 同批删除——净减法，比 v2 的门禁方案少一个机制、少一类边界）；FR-15 perCwd 默认特性全链（D3，范围见 §5 U9） |
  - 每批实施时按本框架产出全量逐机制处置表（下一层 impl-plan 产物），本表为框架 + 代表实例
- **被否**：全量删除 armed 族等重型机制——它们对抗的是 pi 异步事件时序（外部真值），根修不改变 pi 行为，删了即 9-04 composer-model-chaos 重演；不处置只新增——对账代码只增不减，复杂度无界
- **证据**：45 处机制盘点（侦查报告机制总表）；armed 族保护的不变量实读（`model-thinking.ts:307-313` 纪元守卫注释即 V4 实测污染事故）
- **效果**：G3 成立；「新增 session 级状态」的开发者从「复制最近的对账实现再改出新边界 case」变为「组装 factory + 声明字段」

**D10：错误规格与恢复指引**

| # | 失败场景 | 行为 | 恢复指引 |
|---|---|---|---|
| E1 | lastUsedModel/记忆 KV 读失败或损坏 | resolve 回落下一优先级（沿用 E4 语义，不抛不阻塞） | 无需动作；KV 加载完成响应式重算 |
| E2 | landing 极早期 providers/presets/KV 未加载 | 显示侧：resolve 输出全局默认占位，数据到达后响应式重算 chip；**submit 侧：`submitFirstMessage` create 前 await `ensureLaunchDataReady()`**（D1），窗口内发送等待加载完成后再解析透传——占位值不会固化进新 session。量级：本地 WS + localStorage，常态毫秒级（✅ P5 已实测毫秒级）；**尾部：RPC 65s backstop 强制超时 + WS 断开 fast-fail——不永久卡死** | 无需动作（等待无感）；加载失败按 E1/E4 收敛后回落默认继续发送 |
| E3 | lastUsedModel 失效（provider 删除/禁用） | 链内跳过 + chip 显示回落值（provenance=default）；KV 保留原值不覆写（D4） | 想换模型 → 点 chip 重选（popover 只列有效模型）；provider 恢复后原选择自动回来 |
| E4 | 默认预设指向已删 id | preset service 兜底 builtin:full（既有 `preset-service.ts:294-297`） | 无需动作 |
| E5 | create 失败（模型未配置） | 沿用差异化 error code MODEL_NOT_CONFIGURED → 引导 Settings | Settings 配置模型后重发 |
| E6 | pi 读回值 ≠ 请求值（pattern 换模/钳制） | 读回播种生效值（显示自愈）+ L2 对账 warn 日志 | grep 日志 `[launch-config] effective mismatch` 排查 |
| E7 | landing cwd 两空（未选目录且无 defaultCwd） | 现行为静默落 homedir（`notifyCwdFallback` 空串守卫跳过 toast）→ 补 toast 提示「已在主目录创建」 | 想换目录 → 对话流内无 cwd chip，重建任务选目录 |
| E8 | P2 探针发现出厂 builtin:full 与无 preset 路径在完整 launch surface 上不等价 | resolve 对出厂 builtin:full 输出 presetId=undefined 不透传（D3 设计即此语义）；探针失败说明「出厂等价」假设本身错误 → 阻断 D3 上线，回排查 preset resolve 展开差异 | 排查 `buildPresetClientOptions`/extension-filter/skillPaths 展开差异后重新探针 |
| E9 | fork 源真值不可读（老会话无 sidecar 且实例不在内存） | 回落 fork/handoff 各自链的下一档（现行为，不劣化） | 无需动作 |
| E10 | landing slash 浮层选了 skill，但生效 preset 带 noSkills；**分支 3 理论残留**（sync watch 首次触发可用性安全网：landing authored 值 + map undefined→defined 迁移时理论上可写入非 authored 值到 localThinkingLevel） | chip 插入的 skill 文本照发；pi 侧报 skill not found（用户可见反馈）。显示侧残留发散（浮层不感知 preset flags）为已知残留：量极小（默认预设含 noSkills × landing 用 slash 的交集），显示过滤（CommandPopover 消费 resolve 输出的 preset flags）列为后续候选，不在本设计三批内。分支 3 残留：几近不可达（需 authored 后能力表迁移）且后果良性——写入值恰是可用性安全网值（authored 档当时已被判不可用，写的是首个可用档），声明为已知残留不加门禁（此即 D9「`localThinkingLevel` 只存 authored 值」断言的唯一例外，交叉引用） | pi 报错后用户可知；要去掉该 skill → 编辑消息重发 |

### 3.4 运行时断言探针清单（准则 7）

| ID | 验证的行为 | 探针方式 | 状态 | 失败时降级路径 |
|---|---|---|---|---|
| P1 | 双链坐标与发散条件（§2.2/§2.3 ①②③④） | 实读源码核实（本设计过程已逐点 read） | ✅ 已测 | — |
| P2 | **出厂** builtin:full 与「不传 presetId」路径在**完整 launch surface** 上等价（D3 前提）：presetClientOptions 全字段 + extensionPaths（含顺序）+ skillPaths + 持久化字段 | Batch 1 实施前：runtime 单测对 **merge 后** `getPreset('builtin:full')`（非 DEFAULT fixture——否则用户覆写场景空转通过）与无 preset 路径逐面对比 | ✅ 已实跑（63d861ca1）：merge 后逐面对比等价成立，D3 透传前提通过，E8 未触发 | 失败 → E8：阻断 D3 上线，排查展开差异 |
| P2b | `isFactoryFullPreset()` 对用户覆写过的 builtin:full 判定为非出厂 | Batch 1：单测覆写 modelOverride/noSkills/**allowedExtensions（数组字段比对语义）**后断言判定翻转 + resolve 输出 presetId='builtin:full' 正常透传 | ✅ 已实跑（fce03ec13）：覆写字段判定翻转 + resolve 透传正常 | 失败 → 覆写人群被静默改变行为，阻断上线 |
| P3 | 死模型 modelOverride 传给 pi createSession 的行为（报错 or 静默换模）；post-create 双重 apply 删除后 pi 侧无同值 set_model 空调用残留 | Batch 1：本地 pi CLI rpc 模式发死模型 create 观察 reply/错误；grep create 后日志无紧跟的同值 set_model/set_thinking_level | ✅ 已实跑（fce03ec13）：pi 非静默换模，未知 model 走 turn 级报错可见，无需增补校验（impl-plan 偏差 #11） | 静默换模 → runtime create 增加 modelOverride 有效性校验，死模型返回错误码走 E5 路径 |
| P4 | fork 时源 session 当前生效值可读（内存在实例 / sidecar 两路径）；**含陈旧窗口场景**：切模后未 restore 的 dead 源 fork 行为符合 D6 代价声明 | Batch 2：对活跃源、pi 已退出源、「切模→死→直接 fork」三类源各跑一次 fork，断言继承值 | ✅ 已实跑（8f8d70b36）：三类源继承 + E9 回落全过，陈旧窗口按 D6 代价声明 | 失败 → 降级为 renderer 从 store 读值传 override（接受副本窗口，L2 探针对账） |
| P5 | ① resolve 输出对 KV/记忆表晚到的响应式（landing 挂载毫秒级窗口内 chip 自动脱离默认值）；② `ensureLaunchDataReady` 量级实测与窗口内 submit 语义（await 后 create 入参 = 加载后 resolve 输出） | Batch 1：core 单测模拟 KV 延迟 resolve，断言 chip computed 更新 + await 后入参等价；dev 环境实测冷启动加载耗时 | ✅ 已实跑（fce03ec13 单测 + Gate B V1 场景实测）：毫秒级，loading 态兜底未触发 | 失败 → 保留 onLoaded 回调补算（现有机制平移）；加载慢于预期 → 发送按钮在等待期显 loading 态 |

---

## §4 验收（真实场景，非单测非 mock）

**改动规模：大（架构行为变更）→ 多场景真实验证。验证环境：`pnpm dev` 起真实 Electron app（dev renderer :1420），真实 pi 子进程，真实数据目录 `~/.xyz-agent-dev`；浏览器侧用 browser-automation 连 :9222 截图断言；runtime 侧用日志探针。**

| # | 回溯目标 | 验证场景（真实业务例子） | 步骤 | 通过标准 |
|---|---|---|---|---|
| V1 | G1（修复①，本次 bug 本体） | 用户上次显式用过 GLM-5.3，回 landing 直接发送 | ① session A 切 GLM-5.3 发一轮；② ⌘N 新建任务，不碰 chip，发送「hi」；③ 看对话流 composer + trace | landing chip、对话流 chip、trace 三者恒为 GLM-5.3；runtime 日志无 `effective mismatch` |
| V2 | G1（①的失效形态 + D4） | 上次用过的模型 provider 被禁用后新建 | ① V1 基础上 Settings 禁用 zai-coding-cn；② ⌘N 新建发送；③ 重新启用 zai-coding-cn 再 ⌘N | 禁用期间 landing chip 显示全局默认（不显示死模型），新 session 生效 = 全局默认；**KV 保留原值**（重新启用后 chip 自动回到 GLM-5.3，无需重选） |
| V3 | G1（修复②，D3） | 设「只读模式」为默认预设后新建 | ① Settings 设只读模式为默认；② ⌘N 新建发送「列一下 src 目录」；③ pi 侧 get_commands 读回 | landing 预设 chip 显示「只读模式」；新 session 实际工具集 = allowlist(read/grep/find/ls)（get_commands 无 write/bash/edit）；模型 chip 与生效一致 |
| V4 | G1（修复③，D2 thinking 序） | 默认预设带 thinkingLevel=off，用户不碰档 chip 直接发 | ① 默认预设（off）+ 记忆表有该模型 max 记录；② ⌘N 新建发送；③ pi get_state 读回 | 新 session 生效档位 = **off**（preset 档优先于记忆档）；landing 档 chip 显示 off |
| V5 | G1 反向（用户显式选择恒赢） | landing 显式改模型/档位/预设后发送 | ① 默认预设+lastUsed 均存在的条件下，landing 显式选 kimi-coding/k3-256k + high 档；② 发送 | 三处显示与生效均为 k3-256k + high（explicit 覆盖一切默认） |
| V6 | G1（修复④，D6） | 源 session 切过模型后快捷 fork / ⌘H | ① session A（全局默认 MiMo）切到 GLM-5.3-Flash + 档位调 high 发一轮；② 右键消息快捷 fork；③ ⌘H handoff | 两条路径的新 session trace 均显示 Flash；侧栏新增 session 的 chip 显示 Flash；**新 session 生效档位 = high（thinkingLevel 一并继承，pi get_state 读回）** |
| V7 | G4（等价性机器守卫生效） | 故意引入发散，看守卫拦截 | ① CI 跑 L1 等价测试全矩阵绿；② 临时改线让 submit 绕过 resolve 传死值 → L1 测试红；③ dev 模式临时改 runtime 解析顺序 → L2 日志出现 mismatch warn | ①绿 ②红（结构锁生效）③warn 可 grep |
| V8 | G3（对账收敛不破坏既有） | 已建 session 切模型的既有护栏回归 | ① session A 里 flash 调 high、glm-5.3 调 max，来回切；② 观察档 chip 自动恢复记忆档 | 记忆恢复行为与现状一致（armed 族保留）；新代码路径下无 chip 突跳 |
| V9 | 邻居系统不变量（准则 11 外部共享面） | 全程操作后检查宿主表面（**前提：验收机的默认模型有效**——既有 `getDefaultModel()` 在默认模型失效时 auto-fix 写盘 settings.json，非本设计引入，该前提不满足会误红） | ① V1-V8 跑完后：cat pi settings.json；② 看 KV（devtools localStorage）；③ 重启 app 点进老 session；④ 看新建 session 的 sidecar | pi settings.json defaultProvider/defaultModel 未被改写；KV 仅 lastUsedModel/记忆两键（无新键泄漏）；老 session 显示模型与升级前一致（sidecar 真值未被触碰）；新 session 的 .preset.json sidecar 仅在生效 preset 非出厂 builtin:full 时存在（D3 写入面声明），session 删除时随之清理 |
| V10 | G2（改状态即见生效值，事故 B 回归） | 对不支持 max 档的模型请求 max，pi 钳制后 UI 显示钳制后值 | ① 已建 session 切到不支持 max 的模型（如 flash 系）；② 档 chip 请求 max；③ 观察 chip 与 runtime 日志 | chip 从回执生效值显示钳制后档（不显示请求值 max 假值）；mutation 契约测试（D8）枚举内全部 mutation RPC reply 携带生效值字段 |
| V11 | G1 反向（记忆表不被 preset 污染，审查反例回归） | 设 off 档默认预设建站后删预设，记忆档不受污染 | ① 记忆表有 mem[glm-5.3]=max（手动调过）；② 设 off 档预设为默认 → landing 直发（生效 off）；③ **关闭重开该 session（重访）**；④ 该 session 内手动调回 max；⑤ 删除默认预设 → ⌘N 新建 | ②后记忆表仍为 max（authored-only：preset 档结构性不到达记录路径）；③重访安全（无「生效即记录」watch）；④正常入表（用户动作）；⑤新建 landing 档 chip 显示 max（记忆档未被 preset 覆写） |

单测定位：L1 等价矩阵测试与 resolveLaunchConfig 纯函数单测是回归辅助（进 CI），不计入上表验收——上表全部是真实 app + 真实 pi 的场景验证。

---

## §5 下一层拆分

**实施分三批，各批独立可验收、可回滚；批间有依赖序（C3 剪枝必须在 C1/C4 根修落地后）。**

### Batch 1（P1）：单一解析层 + 等价性守卫 —— 关闭 ①②③，G1/G4 主体

| 单元 | 内容 | justification | 验收 |
|---|---|---|---|
| U0 | constraints.json 登记新约束（landing 配置单一解析点 / mutation 回执契约 / 对账三分处置框架）+ render-constraints 重生成 | 项目纪律「先登记再写代码」 | — |
| U1 | core：`launch-config.ts` resolveLaunchConfig 纯函数 + D2 优先级 + D4 校验 + provenance 标签 + isFactoryFullPreset（含 P2/P2b/P3/P5 探针实跑，✅ 均已实跑通过——状态见 §3.4） | 单一解析模块是全部消费方的前置 | V1/V2 部分 |
| U2 | core/renderer 改线三消费方 + 双重 apply 删除 + landing auto 值机制/记录 watch 删除：model-thinking landing 分支（chip 读 resolve；删 follow watch + localAuthored + landing 分支 armed 设立；「生效即记录」watch 及纪元/第三形态守卫删除，记录点收窄为 onThinkingSelect）/ submitFirstMessage（ensureLaunchDataReady await + 透传 resolve 输出）/ PresetSelectChip 回显（废 B6 echo）；删 `createSessionFlow` step 7 applyModel 与壳层 C-W4-3 setThinkingLevel（D5），连带更新 create-session-flow.test.ts、model-thinking.test.ts（跟随 describe 与记录 watch describe 重写）、壳层 composer 测试 | 同源消费即等价；两个 auto 值源并存必发散（auto 误标 explicit 会反转 D2 序），记录 watch 与跟随机制必须与 resolve 改线同批删 | V1/V2/V3/V4/V5/V11 |
| U3 | runtime：create 契约快照化（D5）+ L2 对账探针 warn 日志 | 与 U2 同批防协议半态 | V7-③ |
| U4 | L1 等价矩阵测试 + resolve 纯函数单测 | 结构锁随结构同批落地 | V7-①② |

### Batch 2（P2）：回执契约机器化 + fork/handoff 继承 —— G2 + 修复④

| 单元 | 内容 | justification | 验收 |
|---|---|---|---|
| U5 | D8：ADR 落裁决标准 + shared 协议 reply 类型强制 + runtime mutation 契约测试清单 | 契约先行，改线有据 | V7 扩展 |
| U6 | D6：runtime fork/handoff 源真值继承档（P4 探针 ✅ 已实跑，状态见 §3.4）+ 两入口语义统一 | 依赖 U1 的 resolve 分层概念但代码独立；放 P2 因源真值读取复用 restore-seeding 链（与 P1 无耦合） | V6 |

### Batch 3（P3）：对账三分处置执行 —— G3

| 单元 | 内容 | justification | 验收 |
|---|---|---|---|
| U7 | 收编：`createInflightDedup()` factory（core foundation）+ 6+ 处逐个迁移 | 同构族逐个迁移各自回归，独立可回滚 | V8 |
| U8 | 收编：`createKVSlot(key)` factory + model-thinking-memory / last-used-model 迁移 | 逐字节镜像族合并，消一类漂移 | V2/V8 |
| U9 | 删除：B6 echo 机制残留 / **FR-15 perCwd 默认特性全链**（协议三件套 `preset.getCwdDefault/setCwdDefault/getCwdDefaults` + protocol.ts 类型段 + preset-message-handler.ts 三 handler + 两测试文件的 FR-15/W-RT-3 describe + W-RT-2 僵尸清理逻辑死代码处置；W-RT-3 共享 helper 与 getDefaultPresetId 共用——保留声明）+ perCwdDefaults 存量数据生命周期（load 时惰性清除并重存——字段无消费者，驻留无害但混淆未来读者，清除成本一行）+ 全量处置表收尾 + thinking-level-sync.ts 耦合注释清理 | 必须在 Batch 1/2 根修验收绿后执行（删的是根修后的死代码，非在用机制；跟随/记录 watch 的删除已随 U2 落地，本单元不再含 model-thinking 行为变更） | V8/V9 |

### 文件改动地图（主要面）

- **新增**：`packages/core/src/domain/new-task-search/launch-config.ts`；`packages/core/src/foundation/create-inflight-dedup.ts`、`create-kv-slot.ts`（Batch 3）
- **改写**：`model-thinking.ts`（landing 分支读 resolve + 删跟随/landing armed/记录 watch 全套 + 记录点收窄为 onThinkingSelect）、`flow.ts`（submit 透传 resolve 输出 + ensureLaunchDataReady await + 删 C-W4-3 补 apply）、`packages/ui/src/features/new-task/PresetSelectChip.vue`（回显改读 resolve）、`create-session-flow.ts`（快照语义 + 删 step 7 applyModel）、`packages/runtime/src/services/session/launch-params.ts` / `session-lifecycle.ts`（D5 契约注释 + D6 继承档 + L2 探针）、`handoff-service.ts`（D6 handoff 链）、`packages/shared/src/protocol.ts`（D8 reply 类型 + U9 FR-15 类型段删除）
- **收敛/删除**：`useForkActions.ts` / `useHandoffActions.ts`（语义自动变对，调用形状不变）、FR-15 全链（U9 清单）、6+ 处 in-flight 手写实现（迁移 factory）、model-thinking.test.ts 跟随 describe（重写）
- **文档**：本设计 + ADR（D8 裁决标准）+ constraints.json 三批登记（u3 的「生效即记录」D2 机制被本设计 authored-only 整体废除；原回写目标 `docs/design/model-thinking-level-memory.md` 已删除，git 可追溯，现行权威 = `packages/core/src/domain/composer/model-thinking-memory.ts` 头注释）

### 待验证检查点（诚实标注）

1. ✅ P2/P2b（已验证）：出厂 builtin:full 与无 preset 路径在完整 launch surface 上的等价，及覆写检测——已实跑等价成立，D3 透传前提通过，E8 未触发（P2：63d861ca1；P2b 覆写翻转：fce03ec13）
2. ✅ P3（已验证）：pi 对死模型 modelOverride 的真实行为 + 双重 apply 删除后无同值 RPC 残留——实测 pi 非静默换模（turn 级报错可见），无需补校验层（fce03ec13）
3. ✅ P4（已验证）：pi 已退出的源 session 其 sidecar 在 fork 时刻的可达性与陈旧窗口——三类源 + E9 回落全过，无需 renderer 降级路径，陈旧窗口按 D6 代价声明（8f8d70b36）
4. D2 中 thinking 的 `preset > memory` 序是产品裁决（捆绑意图 vs 个人习惯）——若真实用户反馈相反，调整只需改 resolve 一处序（这正是单一解析层的收益）
5. C3 收编的迁移顺序以 impl-plan 的全量处置表为准；armed 族（保留类，已建 session 模型切换路径）在 Batch 3 不做任何改动

---

## 附录：版本历史

- v1（2026-09-08）：初版。前置分析：架构审查报告（三份全库侦查：双链发散盘点 / 45 处对账机制盘点 / 6281 commit + 64 ADR + 92 约束的历史事故挖掘）。
- v2（2026-09-08）：对抗式审查 R1 修复（主审 2 must-fix + 8 suggestions，影响面审 5 must-fix + 3 suggestions，全部当轮修完）。被否谱系：D3 恒透传（含出厂 builtin:full）被「字段级覆写 + 写入面扩大」击穿；D4 KV 自更新被「遗忘用户选择 + provenance 错标 + 纯函数冲突」击穿；D6 fork/handoff 合并链被「handoff 偷渡 preset 档」击穿；D2 无门禁被「preset 档写穿记忆表」击穿。新增机制：creationProvenance 门禁（D2，v3 废除）、ensureLaunchDataReady（D1）、isFactoryFullPreset 出厂判定（D3）。
- v3（2026-09-08）：对抗式审查 R2 修复（主审 3 must-fix + 2 suggestions，影响面审 1 must-fix + 4 suggestions，全部当轮修完）。方案性变更：creationProvenance 内存门禁被双审独立击穿（首个 flush 语义被守卫悬留 + 重访/重启绕过）→ 废除，改为**记录路径 authored-only**（减法：记录 watch 及纪元/第三形态守卫整套删除，非 authored 值结构性不可达，防污染 by construction）；landing auto 值机制（follow/landing armed）前移至 U2 删除（与 resolve memory tier 双源发散，auto 误标 explicit 会反转 D2 序）；isFactoryFullPreset 字段全集修正（10 个 launch 生效字段，skillPaths 非 preset 字段、allowedExtensions/deniedExtensions 补上）+ 类型层穷尽守卫；D6 字段范围界定 modelId+thinkingLevel；ensureLaunchDataReady 尾部语义（65s backstop）；.preset.json 清理清单实读转正。
- v4（2026-09-08）：对抗式审查 R3/R4 修复（两轮均双份 0 must-fix；R3 5 条 + R4 4 条 suggestions 全部当轮修完）。声明级补齐：staging 记录点三分支统一（试选未 commit 也留痕的刻意反转已声明）；D2 语义收窄四要素（含 armed 陈旧档死角）；E10 分支 3 残留论据修正（安全网值语义，与 D9 断言交叉引用）；D1 authored 守卫明确为单一写点结构保证；P2b 补数组字段用例；文件地图登记 u3 文档回写连带（C-proc-10）。
- v5（2026-09-09）：design-code-sync 校准轮：探针 P2/P2b/P3/P4/P5 状态回写为已实跑通过（结论与 commit 锚点见 §3.4/§5）；D3 写入面补 V9-④ 根修注记（3ba8d96ba：create 路径 sidecar 落盘经 skipJsonlExistsGuard 放行 jsonl-exists 守卫）；D6 读取链补偏差 #13 findScannedSession 薄适配注记；D8 补 ADR-0065 落地形态引用；头部加行号锚点声明。
