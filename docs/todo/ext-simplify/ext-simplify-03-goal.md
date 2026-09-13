# ext-simplify-03：goal 包过度设计简化

> **一句话结论**：goal 包（@zhushanwen/pi-goal）的 7 组审计发现全部收敛——类型层换用 pi SDK 具名类型（删 7 个降级子集接口）、resume 恢复状态机查表强制、删 2 个 write-only 持久化必填字段（白名单 deserialize 天然兼容旧数据）、接口显式声明 theme、删零消费成员与死字段；除 C10 是行为修复（本就是合法转换，行为等价）外全部为纯减法。

<!-- 审计溯源与版本锚点见附录；正文自包含，不依赖审计报告上下文。 -->

## 开篇（SCQA）

- **S（情境）**：`@zhushanwen/pi-goal`（0.13.0）是 Codex 式 /goal 持久目标驱动自主循环的 pi extension——用户给一个 objective，extension 通过 continuation prompt 驱动 AI 多轮自主工作，附带 token 预算熔断、轮次活性熔断、证据式完成校验。包内分层：engine/（零 Pi 依赖纯函数）→ ports.ts（能力接口）→ adapters/（Pi 桥接）→ projection/（渲染）→ service.ts（协调）。
- **C（冲突）**：2026-09-11 过度设计审计发现该包 7 组问题：本地 Like* 事件类型是 SDK 具名类型的**降级子集**（负防腐）；状态机唯一防线（转换表）被 `/goal resume` 绕过；2 个 write-only 字段占据持久化**必填**位（缺失即 state 全丢，放大 schema 脆性却零消费）；message_end 同一形状知识三重表述；接口隐藏真实能力迫使两处断言走私；接口含零消费成员；一组 low 级死字段/转发层/微碎片。
- **Q（问题）**：怎么在不破坏现有持久化数据、不改变用户可感知行为的前提下，把这些投机面与漂移面收敛到单一权威源？
- **A（答案）**：3 个决策（Like* 迁移方式、持久化兼容策略、微碎片合并方案）+ 7 个执行项，全部行为等价或行为修复；唯一兼容代价是版本单向性（新版写的 entry 不含已删字段，降级回 0.13.0 读取会丢 state——已量化并给恢复路径）。

## 1. 背景：被设计的系统是什么

**goal 包是「目标驱动的自主循环」extension，本次设计只动它的类型层、接口面与持久化 schema，不动循环机制本身。**

使用者视角的现有能力（全部保留）：`/goal <objective>` 建 goal（AI 经 goal_control toolcall 重述目标并生成 slug/successCriteria）、`/goal pause`/`resume`/`clear`/`update`/`status`/`history`、token 预算 70%/90% 预警与耗尽终态、轮次活性熔断（continuation 封顶 + 退避）、pending 操作 defer、GUI/TUI 双渲染通道。跨扩展 API：`pi.__goalInit`（plan 包消费）。

包拓扑（行数为 2026-09-12 实测）：包根 7 文件 998 行（index/service/persistence/session/commands/ports/constants）、adapters/ 12 文件 1652 行、engine/ 4 文件 478 行、projection/ 3 文件 604 行。分层约束 D-22：engine/ 与 service/session/persistence 零 Pi import（机器可查，`rg "@earendil" src/engine/` 零命中）。

**审计已核实为本质复杂度、本次不动的部分**：liveness 双判据状态机（2026-09-08 真实事故驱动）、VALID_TRANSITIONS 状态表本身（6 状态全可达）、预算三档严重度（ok/warn/danger 阈值 0.7/0.9 均可达）、prompts 四构造器（各有唯一真实调用方）、persistence 双迁移点（time_limited 归一化 + successCriteria W1 迁移，对应真实历史数据）。

## 2. 设计目标

**改造后维护者能做到：事件类型只认 SDK 一个权威源；状态转换只有一个执行点；持久化 schema 每个必填字段都有真实消费者；接口声明的每个成员都可直接使用（无需断言走私或记忆约定）。**

1. **G1 类型权威源唯一**：删 7 个 Like* 接口，事件类型 = pi SDK 具名导出；SDK 演进时编译报错而非静默漂移（验证 §8 场景 3）。
2. **G2 状态机防线恢复强制**：全部状态变更走 `transitionStatus` 查表；新增非法转换在代码评审外还有守卫兜底（验证 §8 场景 1）。
3. **G3 持久化 schema 无死重**：删 2 个 write-only 必填字段；旧数据（含已删字段）加载不 throw（验证 §8 场景 2）。
4. **G4 接口即事实**：UiPort 显式声明 theme（删两处断言）；SessionPort 删零消费成员。
5. **G5 结构税清零**：budget dimension 死字段、formatBudget 转发层、barrel/单消费方 shared 文件、port/ctx 双通道惯例——各自收敛或显式成文。

**In-scope**：goal 包 src/ 内上述 7 组改动点 + 受影响测试同步。
**Out-of-scope**：
- **isGui 四分支组合 helper**（todo+goal 跨包同构）：修复点在 extension-protocol（设计 13 裁决）。本包消费侧配合点：`updateWidget`（widget.ts:235-260）与 `setGuiWidget`/`isGui` 断言注释（adapters/ports.ts:60-77）在 UiPort 接口收敛时的联动——设计 13 落地时本包只改消费代码，不再动接口定义。
- **rename-session 的 `TurnEndLikeEvent`**：审计称「复用 goal 的 TurnEndLikeEvent」**不成立**——实读证实它是 rename-session 本地独立定义（rename-session/src/index.ts:17，读 `message.stopReason`、带 `& object` 逆变考量），与 goal 无 import 关系。归设计 15。
- **engine/projection 其余 low 发现**（getBudgetColor 单位口径、状态后缀双份、slug fallback 双口径、90% 通知 else-if 时序、DEFAULT_BUDGET 空展开、getElapsedSeconds 转发、renderProgressBar width 参数）：不在本次任务覆盖清单，移交后续 code-simplify 批次；其中 DEFAULT_BUDGET（engine/types.ts:44）与 M14 同文件，实现期触达时可顺带删除，不单独立单元（实施注记：u3 触达 types.ts 时未顺带删除，现随本清单其余 low 项一并归 code-simplify 移交）。
- **message renderer 的 `LikeCustomMessage`/`LikeMessageRenderOptions` 消费逻辑**：只换类型不动渲染行为。

## 3. 现状：使用者与维护者眼下是什么样的

**现状的知识源是三份的：SDK 一份、goal 本地一份、运行时守卫一份——三份都自洽，但互不监督。**

### 3.1 七组现状（真实代码，截至 373b96451）

**(a) Like*Event×7——SDK 类型的本地降级子集**（index.ts:40-74，7 个接口）：

```ts
interface AgentEndLikeEvent  { type: "agent_end"; messages: unknown[]; }        // SDK: messages: AgentMessage[]
interface SessionStartLikeEvent { type: "session_start"; reason: string; }      // SDK: reason: "startup"|"reload"|"new"|"resume"|"fork"
interface SessionShutdownLikeEvent { type: "session_shutdown"; reason: "quit"|"reload"|"new"|"resume"|"fork"; }  // 与 SDK 一致
// BeforeAgentStartLikeEvent / TurnEndLikeEvent / LikeCustomMessage / LikeMessageRenderOptions 同模式
```

SDK 侧（实装 0.84.4，`dist/index.d.ts:7` 实读确认）：`BeforeAgentStartEvent`/`TurnEndEvent`/`MessageEndEvent`/`AgentEndEvent`/`SessionStartEvent`/`SessionShutdownEvent`/`MessageRenderOptions` 全部包根导出，且 `pi.on()` 按事件名重载自动推导 handler 参数（`dist/core/extensions/types.d.ts:908-949`）。接口头注自述动机「避免 any on Pi callback/event signatures」——该决策形成于 SDK 未导出事件类型的时期，前提已消失。5 个 handler 的事件参数以 `_event` 忽略（index.ts:111-135），类型标注纯装饰；仅 message_end 真实消费。

**(b) VALID_TRANSITIONS 被绕过**：转换表 `engine/types.ts:25-36` 头注明言 forcing function（「新增状态时必须更新此表」），`transitionStatus`（engine/goal.ts:25-33）查表 throw。全包走表 3 处（command-adapter.ts:124 pause、service.ts:192 finalizeGoal、goal-control-adapter.ts:289 report_blocked），绕过 1 处——`/goal resume`（command-adapter.ts:157）：

```ts
if (state.status !== "active") {
    state.status = "active";            // ← 裸赋值，跳过查表
    state.timeStartedAt = Date.now();
}
```

**(c) write-only 必填字段**：`lastProgressTurn`（engine/types.ts:74 定义、goal.ts:53 初始化、persistence.ts:98 `req()` 必填）与 `objectiveUpdatedAt`（types.ts:76、goal.ts:55、persistence.ts:100 必填）。全链路唯一「写」点是 `/goal update` 的重置（command-adapter.ts:316,318——重置不是消费）；**读路径为零**（四问记录 grep 证实：所有命中均为定义/初始化/持久化/重置）。`req()` 的语义：字段缺失 → throw → 整个 state 丢弃（session 重建失败，goal 静默消失）。

**(d) message_end 三重表述**：同一「message_end 事件形状」知识存了三份——`MessageEndLikeEvent`（message-end.ts:15-23，类型层）、`MessageEndEventData` + `toMessageEndData`（service.ts:203-249，40 行运行时逐字段守卫）、SDK `MessageEndEvent { message: AgentMessage }`。调用链 index.ts:119（标注 Like 类型）→ message-end.ts:36 `applyEvent(session, "message_end", event)` → applyEvent 签名立即降级 `unknown`（service.ts:249）→ toMessageEndData 重建——类型标注的信息在真正消费点被丢弃。

**(e) UiPort 隐藏 theme 成员**：接口刻意不声明 fg/bold（ports.ts:40-57）；adapters/ports.ts:80-86 构造时私挂 fg/bold 再整体 `as UiPort` 断言；消费端 widget.ts:205-219 的 `asTheme` 用 `as unknown as ThemeLike` 双重断言取回（4 个消费点：widget.ts:246,255,260 + before-agent-start.ts:95）。三处文件累计约 30 行注释解释这条断言链。

**(f) SessionPort 零消费成员**：`getContextUsage`/`signal`（ports.ts:79-80 声明、adapters/ports.ts:105-112 实现）。唯一 context usage 消费方 before-agent-start.ts:108 直接调 `ctx.getContextUsage()`；ESC 守卫全部直读 `ctx.signal?.aborted`（message-end.ts:33、turn-end.ts:27、agent-end.ts:68）——port 通道无人走。

**(g) low 簇**：`BudgetDimension = "token"` 单成员类型 + BudgetDecision/BudgetCheckResult/checkBudgetOnResume 返回值携带 `dimension` 死字段（budget.ts:39-46,133,139,141,150-155；消费侧 agent-end.ts:124-131 只读 `w.type`）；`formatBudget(state, style)` 分发层——percent/line 两分支零共享逻辑（prompts.ts:47-83，两个私有函数各 3 行，调用点各 1 处）；event-adapter.ts 17 行纯 re-export barrel（生产消费方仅 index.ts:32）；shared.ts 27 行 `makeStaleChecker` 唯一消费方是 agent-end.ts:56；port/ctx 双通道混用（agent-end.ts:96-130,220 直呼 `ctx.ui.notify` vs :252 走 `ports.ui.notify`；before-agent-start.ts:95 `buildPorts().ui` vs :96-97 直呼 `ctx.ui`）。

### 3.2 怎么出错（真实失败模式）

- **F1（b 的失败面）**：下一个人给 resume 类场景新增状态变更（如「blocked → paused 中转」）时，参照 :157 的先例写裸赋值——非法转换静默通过，状态机不变量（终态不可逆）失去防线。这不是假设：本包已有 1 处先例，且 4 个写 status 的位置里恰好最晚加的那个绕了表。
- **F2（c 的失败面）**：任何字段级 schema 演进（改名/类型变更）都要先排除这两个幽灵字段的干扰；更实际的风险是**反向**——它们的必填地位诱导后来者继续往 `req()` 清单里加「记账完整」字段，GAP-4（缺字段 → state 全丢）的爆炸半径持续扩大。
- **F3（a/d 的失败面）**：pi SDK 升级给 `SessionStartEvent.reason` 增加枚举值、或 `AgentEndEvent.messages` 泛型化时，goal 本地 Like* **不会报编译错误**——窄化类型静默吞掉新值（`reason: string` 接受任何值），行为漂移要到运行时才暴露。check-pi-semantics 守卫管版本锚点，管不到字段级漂移。
- **F4（e 的失败面）**：改 theme 行为（如新增色彩维度）必须同时改接口构造（私挂）、断言注释、asTheme 取回三层——漏一层即运行时 undefined。这正是 leaky abstraction 的判定：修 bug 必然穿透抽象层。

### 3.3 根因 + 物理数据流

**共同根因：「为未来准备的层」没有跟随前提条件的变化退役。** Like* 形成于 SDK 无导出的时期（前提已消失）；`req()` 必填清单按记账完整性增长（消费者从未出现）；断言走私是 D-22「接口最小化」对「渲染必然需要 theme」这一稳定需求的错误赌注（三条渲染路径全部使用 fg/bold——这不是可变决策）。

M14 涉及的持久化数据流（字段在链上的位置）：

```
磁盘 session.jsonl 的 goal-state entry（22 字段，含 lastProgressTurn/objectiveUpdatedAt）
  → session_start 事件 → reconstructGoalState（session.ts:65 走 ports.session.getEntries）
  → deserializeState（persistence.ts:82）── req("lastProgressTurn") :98  ← 必填校验点（缺失 throw → state 全丢）
  → 内存 session.state
  → 消费：widget 渲染（读 status/tokensUsed/slug/...，不读这两字段）/ prompt 构造（读 objective/budget，不读）
  → /goal update → command-adapter.ts:316,318 重置两字段（唯一写点）
  → persistState → serializeState → appendEntry 写回 JSONL（新 entry 继续携带）
```

> **白名单 deserialize** = 现行反序列化模式：`deserializeState` 只对已知字段逐个 `req()`/可选解析，**从不遍历 entry 的全部 key**——entry 里多出的未知字段天然被忽略。先例：旧格式 `tasks` 字段（persistence.ts 头注「向后兼容忽略不 throw」）。这是 D2 决策的兼容性基石。

## 4. 终态：维护者眼里将是什么样的

**终态下三类维护操作各只剩一条路径：事件类型去 SDK 查、状态变更抄查表先例、持久化字段对着消费点增删——三重表述、断言走私、白名单里的幽灵字段全部消失。**

### 4.1 成功路径（类型与状态机）

- **事件接入**：index.ts 的 6 个 `pi.on(...)` 回调不再携带本地类型标注——`_event` 忽略的 5 个直接省略参数类型（on 重载推导），message_end 显式 `import type { MessageEndEvent }` 标注；文件顶部 `import type { ... } from "@earendil-works/pi-coding-agent"` 替代 7 个本地接口。SDK 升级改事件形状 → goal 包 `pnpm typecheck` 直接红。
- **/goal resume**：`state.status = transitionStatus(state.status, "active")`——与 pause/report_blocked/finalizeGoal 同一执行模式；新成员想加状态变更，抄到的先例是查表调用。
- **持久化**：goal-state entry 20 字段（22 − 2），每个必填字段在 widget/prompt/状态机/熔断逻辑里有读点；旧 entry（含已删字段）打开 session 照常重建。

### 4.2 失败路径（带恢复指引）

- **非法状态转换**（新增代码试图终态→active）：`transitionStatus` throw `Invalid goal state transition: complete → active`——错误消息含当前/目标状态，恢复动作 = 回到 VALID_TRANSITIONS 表（engine/types.ts:25-36）核对合法路径后改走表内转换。
- **旧版本降级读新数据**：0.13.0 读新版 entry → `Missing required field: lastProgressTurn` → session.state 为 null → goal 显示未激活。恢复动作 = `/goal <objective>` 重建（goal 本身是会话级状态，非不可再生数据）。该代价的量化见 §6 D2「效果」栏。

## 5. 关键决策与权衡

**三个决策（D1/D2/D3）分别锁定 Like* 迁移方式、持久化兼容策略、微碎片合并方案；每个执行项的方向已由审计给定（code-right），不重复立决策。**

### 5.1 D1：Like*Event×7 的迁移方式（选定：显式 import SDK 具名类型 + 忽略点省略标注）

- **采用**：
  1. 删 index.ts:40-74 的 7 个接口；真实消费的 message_end 在 index.ts 用 `import type { MessageEndEvent }` 标注（经 M15 执行项贯通到 message-end.ts）。
  2. 5 个 `_event` 忽略的 handler 参数**省略显式标注**——`pi.on()` 按事件名重载推导（SDK types.d.ts:908-949 实读确认），省略后类型仍精确且零维护。
  3. message renderer 用 SDK `MessageRenderOptions`（`registerMessageRenderer` 签名即 `MessageRenderer<T>`，types.d.ts:889）：`LikeCustomMessage`/`LikeMessageRenderOptions` 删除，回调参数 `(message, _options, theme)` 由 SDK 签名推导——`message: CustomMessage<T>`（T 默认 `unknown`），`content` 是与泛型无关的 SDK 固定类型 `string | (TextContent | ImageContent)[]`（messages.d.ts:32-38 实读：泛型 T 只参数化 `details?: T`）。现行消费写法 `typeof message.content === "string" ? message.content : JSON.stringify(message.content)` 对该固定类型天然兼容（string 收窄走前者、数组走 stringify），消费代码零改动。
- **被否**：
  - *B1 保留 Like* 但字段升级对齐 SDK*（messages: AgentMessage[] 等）——手抄 SDK 类型一遍，DRY 违例仍在，SDK 演进仍静默漂移（§3.2 F3 原样保留），只是抄得更像了。
  - *B2 全部省略标注纯靠推导*——message_end 消费点需要显式类型做 narrowing 与文档锚点；且全文件无一处事件类型 import 会让「类型权威源在哪」不可见。
  - *B3 rename-session 式宽松交叉类型（`& object`）*——那是「不 import pi 类型 + 只读子集字段」的特例方案（rename-session 有自己的逆变教训）；goal 直接 import SDK 类型后 handler 参数与 `ExtensionHandler<T>` 同型，不存在逆变摩擦，无需引入宽松层。
  - *B4 降级路径回调首参显式标裸 `CustomMessage<unknown>`*（v1 的 P-like-2 降级写法，第 1 轮审查证伪）——`CustomMessage` 不在 pi 0.84.4 包根导出清单（dist/index.d.ts 实读），包根 import 该类型直接编译失败，降级路径不可达；已改为包根可达的 `MessageRenderer` 类型锚定（见 P-like-2 降级栏）。
- **证据**：SDK `dist/index.d.ts:7` 导出清单实读（0.84.4 实装版）；`pi.on()` 重载实读；goal 包 `peerDependencies: ^0.84.4`（package.json）；5 个忽略点 + 1 个消费点的分布实读（index.ts:111-135,119）。
- **效果**：G1 成立——类型权威源收敛为 SDK 单一来源；编译期漂移检测恢复（SDK 改字段 → goal 编译红，替代运行时静默漂移）。
- **探针**（⛔ 实施期门，U2 完成前必跑）：

| ID | 验证的行为 | 探针 | 状态 | 失败降级路径 |
|---|---|---|---|---|
| P-like-1 | SDK 事件类型可直接标注 handler 参数且 tsc 通过 | `pnpm extensions:typecheck`（替换后） | ⛔ U2 | 单点逆变报错 → 该参数回退省略标注（重载推导），不影响其余迁移 |
| P-like-2 | renderer 回调经 SDK 签名推导后，content 判型消费编译与运行时兼容 | index.test.ts 工厂实例化用例跑绿（探针载体，文件预期不改） | ⛔ U2 | 类型冲突 → 回调整体用包根导出的 `MessageRenderer` 类型锚定（`import type { MessageRenderer }`，`const renderer: MessageRenderer = (message, _options, theme) => ...` 后传入），T 保持默认 `unknown`。注：裸 `CustomMessage` **不在包根导出清单**（index.d.ts:7 全量核对，custom 相关仅 session 侧 `CustomMessageEntry` 与 components 侧 `CustomMessageComponent`），显式 import 该名直接编译失败；且 T 只进 `details` 而 goal 不读 details，泛型窄化冲突在类型面不存在——降级预期无需触发 |

### 5.2 D2：M14 write-only 字段的持久化兼容策略（选定：一步删除，白名单 deserialize 天然兼容）

- **采用**：单批删除 `lastProgressTurn`/`objectiveUpdatedAt` 四处（types.ts:74,76 定义、goal.ts:53,55 初始化、persistence.ts:98,100 必填行、command-adapter.ts:316,318 重置行）+ 测试 fixture（criteria-array-migration.test.ts:27,29、deserialize-state.test.ts:35,37,62,64、goal.test.ts:56）+ handleUpdate 注释同步。**不写迁移代码**：deserialize 是白名单模式（§3.3），旧 entry 的多余字段在新代码下自动忽略——与 `tasks` 字段先例（persistence.ts 头注）同一机制。
- **被否**：
  - *B1 两步走（先降可选、下版再删）*——白名单模式下「删字段」本就前向兼容，两步走只是让 write-only 持有税多缴一个发布周期，且中间态（optional + 仍写）不改变任何行为。
  - *B2 保留字段并补读点*（如 widget 显示「上次进展轮」）——为死字段发明消费者是 second-system 加深；四问已证无真实需求方，且 handleUpdate 的「重置」语义本就由 `currentTurnIndex = 0` 承担。
- **证据**：零读点 grep（四问记录：全部命中为定义/初始化/持久化/重置）；白名单 deserialize 机制实读（persistence.ts:82-140 只对已知 key 取值）；`tasks` 先例实读。
- **效果**：G3 成立。**已接受代价（量化四要素）**：量级 = 版本降级场景（新 entry 被 0.13.0 读取）才触发，桌面 builtin 用户随 app 升级不降级、npm CLI 用户降级属罕见操作；恢复路径 = `/goal <objective>` 重建 goal（会话级可再生状态，历史 entry 的 goal-history 不受影响——history 是独立 entry 类型）；重审触发 = 若未来出现「降级兼容」产品要求，则在 deserialize 补两字段宽容解析（10 行内）；显式判定 = 可接受（单向升级是项目既有惯例：W5 熔断字段同为「旧数据无字段 → 归零」的单向兼容）。
- **探针**：

| ID | 验证的行为 | 探针 | 状态 | 失败降级路径 |
|---|---|---|---|---|
| P-m14-1 | 旧 entry（含两字段）在新代码下加载成功 | deserialize-state.test.ts 加「legacy entry 含已删字段」用例（构造 0.13.0 形状 entry → deserializeState 返回完整 state） | ⛔ U4 | 失败 → 说明白名单假设不成立，改走 D2-B1 两步走 |
| P-m14-2 | 新写入 entry 不含两字段 | serializeState 输出断言（现有 schema.test.ts 扩一条） | ⛔ U4 | 失败 = 删除不完整（fixture 残留），补删即过——无方案分支，不构成单点依赖 |

### 5.3 D3：event-handlers 微碎片（选定：删 barrel + shared 并入 agent-end，保留 per-event-per-file）

- **采用**：
  1. 删 event-adapter.ts（17 行纯 re-export barrel）；index.ts 的 import 直连 `./adapters/event-handlers/*`（6 个符号）。
  2. shared.ts 的 `makeStaleChecker`（唯一生产消费方 agent-end.ts:56）并入 agent-end.ts；stale-checker.test.ts 的 import 路径同步。
  3. **保留** message-end/turn-end/session-start/session-shutdown 四个微 handler 的 per-event-per-file 布局。
- **被否**：
  - *B1 四个微 handler 合并为单 events.ts（~147 行）*——破坏「pi.on 注册点 ↔ handler 文件」一一对应的心智模型（6 个事件一致的浏览/测试定位约定）；且 session-shutdown.ts 的 23 行中约 15 行是 MF-R2-1 根修的 SDK 触发序知识注释（reload/new/resume/fork/quit 五路径的 invalidate 时序论证），强行合并会稀释这段注释的可发现性——它正是未来排查「timer 带崩 pi 进程」类问题的第一锚点。
  - *B2 全部不动*——barrel 是教科书 pass-through（删掉让 index.ts 直连，行为不变），审计四问已按 code-right 定向；shared 的文件名「shared」名不副实（单消费方），是理解税。
- **证据**：barrel 生产消费方仅 index.ts:32（grep 实测）；makeStaleChecker 生产消费方仅 agent-end.ts:46,56；max-lines 门 = taste-lint/base.mjs:79（max 500，skipBlankLines+skipComments，warn 级）——agent-end.ts 现测算 355 行，并入 makeStaleChecker（净增约 15 行代码 + 头注）后远低于阈值，**合并不需要任何 lint 豁免**。
- **效果**：G5 的微碎片项成立——文件数 −2、import 链少一跳（index → barrel → handler 变 index → handler）；per-event 约定与注释知识保留。

### 5.4 决策与执行项总表

| 项 | 来源（审计编号） | 类型 | 内容一句话 | 涉及文件 |
|---|---|---|---|---|
| D1 | C3-goal | 决策 §5.1 | 删 Like*×7，SDK 具名类型 + 忽略点省略标注 | index.ts |
| D2 | M14 | 决策 §5.2 | 一步删 2 个 write-only 必填字段，白名单天然兼容 | engine/types.ts、engine/goal.ts、persistence.ts、adapters/command-adapter.ts |
| D3 | low（微碎片） | 决策 §5.3 | 删 barrel + shared 并入 agent-end，per-event 文件保留 | adapters/event-adapter.ts（删）、adapters/event-handlers/{shared→agent-end}.ts、index.ts |
| E1 | C10（high） | 执行 | resume 裸赋值改 `transitionStatus(state.status, "active")`（command-adapter.ts:157）+ 裸赋值守卫测试（regex 扫 src，见下） | adapters/command-adapter.ts、engine/__tests__/goal.test.ts |
| E2 | M15 | 执行 | message_end 类型统一 SDK `MessageEndEvent`：删 `MessageEndLikeEvent`（message-end.ts:15-23），index.ts/message-end.ts 标注 SDK 类型；**保留** `toMessageEndData` 运行时守卫与 applyEvent 的 `unknown` 边界（service 零 Pi import 的架构纯粹性 + no-unsafe-cast + 「pi 适配层不信任外部格式」三重依据） | adapters/event-handlers/message-end.ts、index.ts |
| E3 | M16 | 执行 | UiPort 显式声明 `readonly theme: ThemeLike`；`ThemeLike` 定义上移 ports.ts（接口层拥有形状）；adapters/ports.ts 构造 `theme: { fg, bold }` 嵌套成员（fg 的 string→ThemeColor 断言留在 adapter 包装）；删 `as UiPort` 整体断言 + widget.ts `asTheme` 及其 4 个消费点改 `uiPort.theme` | ports.ts、adapters/ports.ts、projection/widget.ts、adapters/event-handlers/before-agent-start.ts（测试连带见 §9.3） |
| E4 | M17 | 执行 | SessionPort 删 `getContextUsage`/`signal`（ports.ts:79-80 + adapters/ports.ts:105-112 实现 + 测试 fake 同步） | ports.ts、adapters/ports.ts（测试连带 5 文件见 §9.3） |
| E5 | low（budget） | 执行 | 删 `BudgetDimension` 类型与全部 `dimension` 字段（BudgetDecision/BudgetCheckResult.terminal/checkBudgetOnResume 返回值/4 处生产字面量）；budget.test.ts 4 处断言同步删字段 | engine/budget.ts、engine/__tests__/budget.test.ts |
| E6 | low（formatBudget） | 执行 | 删 `formatBudget` 分发层与 `BudgetFormatStyle`；`formatBudgetPercent`/`formatBudgetLine` 转导出，2 个调用点直调；prompts.test.ts 改直测两函数；「FR-3.4 唯一收敛出口」注释随决策推翻一并删除 | projection/prompts.ts、projection/__tests__/prompts.test.ts |
| E7 | low（双通道惯例） | 执行 | doc-right：adapters/ports.ts 头注补惯例声明「port 对象仅用于传入 service/session 的实参；handler 自用的 UI/日志直呼 ctx」——把口头知识成文，不改调用代码 | adapters/ports.ts（头注） |

**E1 守卫设计**（防再犯，轻量测试守卫而非 lint 规则）：goal.test.ts 增一条源码扫描用例——对 `src/**/*.ts`（排除 `__tests__`）做正则扫描 `\.status\s*=(?![=>])(?!\s*transitionStatus\b)`，断言 0 命中（E1 修复后的基线）。**基线重演矩阵（2026-09-12，rg -P（PCRE2）与 JS RegExp 双引擎实测一致）**：现状 src 唯一命中 = command-adapter.ts:157 的绕过点；3 处合法查表赋值（command-adapter.ts:124、service.ts:192、goal-control-adapter.ts:289）与 16 处 `===` 比较语句全部排除；红队验证 = 任一 src 文件插入 `state.status = "active"` 裸赋值 → 扫描即命中并指认文件行号，还原即回 0（守卫非恒真断言）。**为何是这两个前瞻（回溯免疫原理）**：初版形态 `\.status\s*=\s*(?!transitionStatus\b)` 被实测证伪——① `\s*=` 会命中 `===` 的前缀（16 处比较误报）；② `=` 后空格被 `\s*` 吞掉后负向前瞻失败，引擎回溯把 `\s*` 退成零宽、前瞻改在空格前求值（` transitionStatus` 不匹配字面量）→ 3 处合法赋值也误报，落地即恒红 20 处。修正形态的两个前瞻均无回溯空间：`(?![=>])` 紧贴 `=` 之后（中间无可变宽空白）排除 `==`/`===`/`=>`；`(?!\s*transitionStatus\b)` 把「可选空白 + 白名单函数」整体放进前瞻——前瞻内部由引擎穷举所有 `\s*` 宽度且都以「匹配 `transitionStatus\b`」收口，`= transitionStatus(...)` 的任意空格数形态均被排除，而非法赋值右侧（如 `"active"`）两个分支都不匹配 → 负向通过 → 命中。已知边界：**误报面**——注释/字符串内的字面形态（如注释里写 `state.status=complete`）同样命中，现状 src 无此形态，未来触发时再调（轻量守卫的已知税）；**扫描粒度**——以整文件内容为单位而非逐行：前述「`\s*` 穷举宽度」的回溯免疫论证隐含整文件扫描前提（`\s*` 须能跨行吃换行，才能排除 `state.status =\n transitionStatus(...)` 这类跨行白名单赋值形态），逐行实现会对该形态误报；**漏报面**——守卫只覆盖 `\.status\s*=` 直接赋值形态，威胁模型是防 F1 的无意模仿、不防蓄意绕过：解构赋值目标（`({ status: state.status } = src)`）、`??=`/`||=` 条件赋值、括号访问（`state["status"] = ...`）、`Object.assign(state, {...})` 五类形态结构性不在防线上，归 code review 层——F1 定义的实际威胁（参照 ：157 先例的无意模仿）已被覆盖，G2 主张不因此受损。选测试守卫而非自定义 lint 规则的理由：零基建成本（无 taste-lint 规则开发）、随 `pnpm test` 默认运行、误报面已由上矩阵实测收敛为 0。

**E3 与设计 13 的联动边界**：本次只加 `theme` 成员声明——UiPort 的 `setWidget`/`setGuiWidget`/`isGui` 双 API 模式分发（updateWidget 内 `if (isGui)` 四分支）属 extension-protocol 组合 helper 议题（设计 13 裁决）。设计 13 落地若收敛 UiPort 接口（如单一 `setGoalWidget`），本包接口面随之调整，届时 theme 成员声明保持不变（模式分发与主题能力正交）。

## 6. 实现机制（把终态落到代码层）

**本章只给模块归属与接口形状约定，实现代码零（设计文档纪律）；每个执行项的实现细节以 §5 表格的文件清单 + 下述约束为准。**

- **类型层（D1/E2）**：adapters 层允许 import Pi 类型（现行惯例，command-adapter.ts:17 已有先例）；service.ts 保持零 Pi import（连 type import 都不加——E2 的 SDK 类型只出现在 index.ts 与 message-end.ts，applyEvent 的 `unknown` 边界不动）。
- **接口层（E3/E4）**：`ThemeLike` 上移后 projection/widget.ts 的渲染函数参数类型改从 `../ports` import（方向：渲染层消费接口层形状，与 GoalHistoryEntry 同向）。E4 删除后 SessionPort 仅剩 `getEntries`（唯一有消费方的成员，session.ts:65）。
- **状态机（E1）**：resume 的修复不触碰同分支的 `state.timeStartedAt = Date.now()`（tick 语义与转换语义正交）；`cappedActive` 路径（status 已 active）本就不进赋值分支，不受影响。
- **持久化（D2）**：serializeState 是浅拷贝透传（`{ ...state, budget: {...} }`），字段从 GoalRuntimeState 删除后输出自动少两键，无 serialize 侧改动。

## 7. 方案对比总览（决策级）

**三个决策各有 2-3 个候选，下表汇总裁决与三栏评估；「被否若用」段让取舍可感知。**

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|---|---|---|---|---|
| D1-A SDK 具名类型 + 忽略点省略（选） | 权威源唯一，编译期漂移检测 | 低（改 1 文件 + typecheck） | 逆变摩擦点需逐个编译验证（P-like-1 探针 + 降级路径） | ✅ |
| D1-B 保留 Like* 对齐 SDK 字段 | 手抄维护义务仍在，漂移面不变 | 中（字段升级逐个核对） | 静默漂移原样保留 | ❌ |
| D2-A 一步删除（选） | schema 必填位 = 真实消费面 | 低（4 文件 + 测试 fixture） | 降级场景 state 丢失（已量化，恢复 = 重建 goal） | ✅ |
| D2-B 两步走（先可选再删） | 与 A 终态相同，多一个中间版本 | 中（两次发布 + 中间态测试） | 无额外风险，纯成本 | ❌ |
| D3-A 删 barrel+shared、保 per-event（选） | 结构税清零，注释知识与约定保留 | 低（2 文件操作 + import 改写） | 无（max-lines 余量充足） | ✅ |
| D3-B 微 handler 全并单文件 | 文件数更少但破坏事件↔文件对应 | 中（注释归属重排） | MF-R2-1 知识注释可发现性下降 | ❌ |

**被否若用（可感知取舍）**：D1-B 下，SDK 给 SessionStartEvent.reason 加新枚举值时 goal 无感继续跑（`reason: string` 吞掉），直到某个 handler 开始消费 reason 才发现从未收窄过——F3 失败面原样保留。D3-B 下，排查「session 切换后 timer 带崩进程」的人要先在 147 行合并文件里找到那段五路径时序注释——锚点从「文件即注释」退化为「文件内搜索」。

## 8. 验收（真实场景，非单测非 mock）

**改动规模：中——行为修复 1 处（E1）+ 持久化 schema 变更 1 处（D2）+ 其余为行为等价重构。验收按此分档投入：E1/D2 多场景真实验证，类型/接口项以 typecheck + 真实 CLI 冒烟 + 测试绿验证，纯等价项测试绿即可。**（extension 改动按项目规约在**本地 pi CLI** 实测，不在 xyz-agent 桌面。）

| # | 场景 | 回溯目标 | 真实流程/数据/路径 | 通过标准 |
|---|---|---|---|---|
| 1 | resume 查表转换真实链路 | G2（§2 目标 2） | `pi --mode rpc --session-dir <tmp> --model xiaomi-token-plan-cn/mimo-v2.5-pro --approve --extension extensions/universal/goal` stdin JSONL：发 `/goal write a haiku`（AI 调 goal_control create）→ `/goal pause` → `/goal resume` | resume 后 `/goal status` 显示 `Status: active`，续跑 prompt 发出（followUp user message），全程无 throw；与改造前行为一致（本就是合法转换） |
| 2 | 终态不可 resume（负向，不回归） | G2 | 同上链路：goal complete（AI 调 goal_control complete）后 `/goal resume` | 提示 `terminal state ... cannot resume`（isTerminalStatus 守卫既有行为不回归），不抛未捕获异常 |
| 3 | 守卫真的能抓裸赋值（负向） | G2 | E1 守卫用例的红队验证：临时在任一 src 文件插入 `state.status = "active"` 裸赋值 → 跑 goal.test.ts 该用例 | 用例转红并指出文件行号；还原后转绿（守卫非恒真断言） |
| 4 | 旧持久化数据加载兼容 | G3（§2 目标 3） | 手工构造 session JSONL：goal-state entry 按 0.13.0 形状含 22 字段（含 lastProgressTurn/objectiveUpdatedAt），pi 打开该 session → `/goal status` | state 重建成功，status/objective 显示正确（白名单 deserialize 兼容性实证，对应 P-m14-1 的真实场景版） |
| 5 | 新写入 round-trip | G3 | 场景 4 同一 session 里 `/goal update new objective` 后读回最新 goal-state entry | entry 不含两字段（P-m14-2 真实场景版），再次重开 session 加载正常 |
| 6 | message_end token 累加链路（类型迁移冒烟） | G1（§2 目标 1） | 场景 1 链路：`--tokens 50000` 建 goal，连续对话 2-3 轮后 `/goal status` | `Token: N/50000` 计数随轮次增长（SDK 类型贯通后 accumulateTokens 链路无损）；`pnpm extensions:typecheck` 零错 |
| 7 | theme 渲染链路（断言删除冒烟） | G4（§2 目标 4） | 本地 pi TUI 模式加载 goal，触发 widget 渲染（goal 激活后状态栏） | 状态栏颜色正常（accent/警告色），无 theme undefined 运行时错；headless（`--mode json`）不渲染不报错（hasUI 既有行为） |
| 8 | 等价重构回归 | G5 | `pnpm --filter @zhushanwen/pi-goal test` 全绿（含同步修改的 budget/prompts/deserialize/stale-checker 测试）+ `pnpm extensions:lint` | 测试与 lint 零红（E5/E6 断言更新后语义等价） |

**宿主表面不变（邻居系统场景）**：goal 的 entry 类型（goal-state/goal-history customType）与字段语义不变（只减不增不改），session-reader / xyz-agent runtime 对这些 entry 的既有读取不受影响；前端 widget 投影链（guiSetWidget marker → runtime 解码 → M17 对话流面板渲染，builtin-contributions.ts:32-33 登记）亦零影响——buildGoalGui（gui.ts:79 起）只读 slug/goalId/status/currentTurnIndex/tokensUsed/budget/successCriteria，不读被删两字段，且 E3 的 theme 取法变化不进 GuiRenderResult（GUI 通道颜色经 severity 枚举表达，fg/bold 只存在于 TUI 文本行路径）；`pi.__goalInit` 签名不变（plan 包消费方零感知——GoalInitBudget 虽与 BudgetConfig 同构，不在本次范围，保持原样）。

## 9. 实施

**分 5 个阶段（M0-M4）顺序交付，每阶段独立 commit、独立验收；顺序 = 行为修复先行、类型/接口各成一批、结构清理收尾。**

### 9.1 迁移路径

| 阶段 | 内容 | 交付终态的什么 | 独立验收 |
|---|---|---|---|
| M0 | E1（状态机修复 + 守卫） | G2 全部 | 场景 1/2/3 |
| M1 | D1 + E2（类型层一批） | G1 全部 | 场景 6 前半（typecheck） |
| M2 | D2（字段删除 + 兼容测试） | G3 全部 | 场景 4/5 |
| M3 | E3 + E4（接口层一批） | G4 全部 | 场景 7 |
| M4 | D3 + E5 + E6 + E7（结构清理批） | G5 全部 | 场景 8 |

顺序理由：E1 是唯一行为修复项，最先落并单独验证（行为面最小化时验证最干净）；类型层与接口层各自成批（同为「形状收敛」，typecheck 一次覆盖）；结构清理放最后（前面批次可能又触达同文件，避免合并冲突返工）。每阶段独立 commit（逐个 commit 逐个验证，项目打包纪律）。

### 9.2 下一层拆分清单

| 单元 | 说明 | justification |
|---|---|---|
| U1 = M0/E1 | resume 改查表 + goal.test.ts 守卫用例 | 行为修复独立验证（场景 1-3），不与重构混批 |
| U2 = M1（D1+E2） | index.ts Like* 删除 + message-end.ts/service 边界贯通 | 同一编译单元的类型变更，拆开则中间态类型链断裂 |
| U3 = M2（D2） | 四文件字段删除 + P-m14-1/P-m14-2 测试 | 持久化兼容独立验收（场景 4/5），回滚面独立 |
| U4 = M3（E3+E4） | UiPort.theme + SessionPort 删成员 | 同改 ports.ts 双接口，测试 fake 触碰面（widget/service/goal-control-adapter/criteria-array-adapter/session 共 5 文件，完整枚举见 §9.3）一批完成，避免两次触碰同一批 fake |
| U5 = M4（D3+E5+E6+E7） | barrel/shared/formatBudget/dimension/注释 | 纯等价清理，风险最低放最后 |

### 9.3 文件改动地图

| 文件 | 操作 | 承载项 |
|---|---|---|
| src/index.ts | 改 | D1（删 7 接口、import SDK 类型、renderer 泛型化）、E2（MessageEndEvent 标注）、D3（import 直连 handlers） |
| src/adapters/command-adapter.ts | 改 | E1（:157 查表）、D2（:316,318 删重置 + 注释） |
| src/engine/types.ts | 改 | D2（删 2 字段） |
| src/engine/goal.ts | 改 | D2（删 2 初始化） |
| src/persistence.ts | 改 | D2（删 2 必填行） |
| src/adapters/event-handlers/message-end.ts | 改 | E2（删接口、SDK 类型） |
| src/service.ts | 不动 | E2 明确保留 unknown 边界与守卫 |
| src/ports.ts | 改 | E3（ThemeLike 上移 + UiPort.theme 声明）、E4（SessionPort 删 2 成员） |
| src/adapters/ports.ts | 改 | E3（theme 嵌套成员、删整体断言）、E7（头注惯例） |
| src/projection/widget.ts | 改 | E3（删 asTheme、消费点改 uiPort.theme、ThemeLike 改 import） |
| src/adapters/event-handlers/before-agent-start.ts | 改 | E3（:95 asTheme 调用点） |
| src/adapters/event-adapter.ts | 删 | D3 |
| src/adapters/event-handlers/shared.ts | 删（内容并入 agent-end.ts） | D3 |
| src/engine/budget.ts | 改 | E5 |
| src/projection/prompts.ts | 改 | E6 |
| src/engine/__tests__/goal.test.ts | 改 | E1（守卫用例 + fixture）、D2（P-m14 fixture 共用） |
| src/projection/__tests__/widget.test.ts | 改 | E3：`makeUiPort`（:209-227）与 `makeGuiUiPort`（:295-315）**两处** fake 平铺 fg/bold 改 `theme` 嵌套——直测 updateWidget 消费 `uiPort.theme`，缺成员即运行时 TypeError；`ThemeLike` import 路径随定义上移改 `../ports` |
| src/__tests__/service.test.ts | 改 | E3+E4：ui fake（:32-38）平铺改 theme 嵌套——persistAndUpdate 用例经 service.ts:115 updateWidget 触达；session fake（:46-48）删 getContextUsage/signal；:37 asTheme 注释同步 |
| src/__tests__/goal-control-adapter.test.ts | 改 | E3+E4：makeFakePorts（:28-63）ui fake 平铺改 theme 嵌套——handleCreate 成功用例经 goal-control-adapter.ts:215 updateWidget 触达；session fake 删 2 成员；:55 asTheme 注释同步 |
| src/__tests__/criteria-array-adapter.test.ts | 改 | E3+E4：makeFakePorts（:18-52）同款改造——handleCreate 成功用例（:57/:147）经 updateWidget 触达 |
| src/__tests__/session.test.ts | 改 | E4：makeFakeSessionPort（:30-36）删 getContextUsage/signal——保持 fake 与接口一致（E4 后无运行时读点，测试不会红，纯一致性同步） |
| src/__tests__/budget.test.ts | 改 | E5（dimension 断言） |
| src/__tests__/prompts.test.ts | 改 | E6（直测 formatBudgetPercent/Line） |
| src/__tests__/deserialize-state.test.ts、criteria-array-migration.test.ts | 改 | D2 fixture + P-m14-1 |
| src/__tests__/schema.test.ts | 改 | D2（P-m14-2 输出断言） |
| src/__tests__/stale-checker.test.ts | 改 | D3（import 路径随 shared 并入 agent-end） |
| 测试（预期不动） | — | index.test.ts（P-like-2 探针载体：fake 经 `as unknown as` 整体断言、ctx.ui.theme 已嵌套，P-like 红触发降级时才动）；event-adapter / command-adapter / circuit-breaker / goal-control-rpc / ports.test（ctx fake 的 ui.theme 均已嵌套形态，E3/E4 无感；goal-control-rpc.test.ts:47-49 头注提 getContextUsage/signal 被 buildPorts 读取，E4 后顺手校正注释） |

> 测试连带面说明：extensions/tsconfig.json exclude `**/__tests__`——测试文件不经 `pnpm extensions:typecheck` 检查，fake 形状漂移的后果全部是**运行时**的（TypeError 或假绿），不可能是编译错；上表「必改」判定按运行时触达路径给出（widget 直测 updateWidget、service 经 persistAndUpdate、goal-control-adapter/criteria-array-adapter 经 handleCreate），session.test.ts 无触达路径、列为一致性同步。**重审触发（判定基石登记）**：本节三级判定建立在「测试不经 typecheck」前提上——前提当前成立（tsconfig exclude；CI 的 extensions 类型检查通路仅 `extensions:typecheck` 一项，ci.yml:93 / release-npm.yml:90），但存在同仓翻转先例：renderer 侧 CI 步骤 `typecheck:test`（tsconfig.typecheck-test.json 专测测试文件）已证明「测试纳入 typecheck」是本仓落地过的模式，extensions 侧跟进属自然延伸、翻转概率不可忽略。触发条件：extensions/tsconfig.json 若将 `__tests__` 纳入编译范围，或 CI 为 extensions 测试新增 typecheck 通路，本节各文件判定等级需按编译视角重估（重点复核当时未改的 fake 文件）。翻转冲击实测有限（实测记录见 `.review/ext-simplify-03-impact.md` 聚焦复审 R1）：必改 5 文件两前提下行动不变；「预期不动」组被 `as unknown as ExtensionContext`（event-adapter:92/command-adapter:83/circuit-breaker:98/goal-control-rpc:79）与 `as UiPort` 断言兜住，typecheck 开启也编译绿；唯一新增红灯面是 service.test/session.test 的无断言字面量 fake（excess property check 生效），两文件本就在改动清单内。

### 9.4 待验证检查点（设计阶段无法确定，诚实标注）

- **P-like-1 的逆变摩擦全集**：6 个事件 + renderer 的 SDK 类型替换在 tsc 下是否存在本设计未预见的重载匹配问题（rename-session 的 `& object` 教训提示 pi 类型交叉处有非显然行为）。降级路径已给（单点回退省略标注）。
- **场景 4 的手工 entry 构造**：0.13.0 真实写入的 entry 形状以「persistence.ts 的 req 清单 + serializeState 输出」推导，若历史版本有未记录字段差异，以实际 npm 0.13.0 产物为准校准 fixture。
- **E3 的 theme 嵌套形状**：`theme: { fg, bold }` 与 SDK `ctx.ui.theme` 的其余成员（如 bg）无关——goal 只需这两个方法（widget.ts 渲染函数的实读消费面）。若实现期发现 SDK Theme 类型直接可赋值给 ThemeLike（结构子类型），adapter 可直接透传 `ctx.ui.theme` 免包装；两种形态都满足接口声明，属实现自由度。

## 附录：变更历史与溯源

- v1（2026-09-12）：初稿。来源 = over-engineering-audit 20260911 候选 3（goal 部分）/候选 10/M14-M17/low 清理点；四问记录三份（goal 包根 `~/.pi/agent/tmp/session-view-01a09053-242e-732a-*.md`、engine+projection `...-242a-*.md`、adapters `...-4e4d-*.md`——注：审计附录原索引把 2419 标为 engine+projection，实读证实 2419 是 base-tool-enhance 记录，goal 包根实际在 242e-732a，本设计按实读内容取材）。全部 file:line 于分支 `feat-optimize-extensions-over-engineering` HEAD `373b96451`（2026-09-12）实读复核；goal 包最近提交 `f1a495816`。
- 审计四问记录中的其余 goal 单元发现（getBudgetColor 口径、状态后缀双份、slug fallback 双口径、90% 通知时序、finalizeGoal 测试导出、GoalInitBudget 同构双类型、UiPort isGui 模式外泄、persistState 3 行重复、散点微仪式）：见 §2 Out-of-scope 的处置去向（code-simplify 批次 / 设计 13 / 设计 15 / 不做登记）。
- v2（2026-09-12）：审查-修复循环第 1 轮。审查锚点 HEAD `2f78fac77`，pi 0.84.4 实装；输入 = `.review/ext-simplify-03.md`（2 must-fix）+ `.review/ext-simplify-03-impact.md`（2 must-fix, 1 suggestion）。逐条对账：
  - **MF-A（主审 MF1 + 影响面 MF1 同根因合并，§5.4 E1 守卫）**：原正则 `\.status\s*=\s*(?!transitionStatus\b)` 证伪重演属实——实跑 rg -P 复现 src 命中 20 处（16 处 `===` 前缀误报 + 3 处合法 transitionStatus 赋值被 `\s*` 回溯击穿误报 + 1 处真绕过）。**审查建议的修正形态 `\.status(?!\s*=\s*(?:transitionStatus\b|[=>]))` 重演后不采纳**：该式消费仅 `.status`、前瞻只拦「紧跟赋值/比较」，全部读取位置（`isActiveStatus(...)`、`switch (state.status)`、模板插值等）命中数十处，其「实测 0 命中」声明与实跑不符。最终采用自行推导的回溯免疫形态 `\.status\s*=(?![=>])(?!\s*transitionStatus\b)`（原理见 §5.4），双引擎验证：基线 src 唯一命中 :157、红队样本插入即命中指认行号/还原即绿、13 用例行为矩阵（含 `==`、无空格赋值、白名单外新函数报红、读取/插值不命中）全 PASS。§8 场景 3 基线（现状绿/插入红/还原绿）经该矩阵证实可达，场景文本无需改动。
  - **MF-B（主审 MF2，§5.1 D1 采用第 3 点 + P-like-2）**：dist 实读证实——`CustomMessage<T = unknown>`（messages.d.ts:32-38）泛型 T 只参数化 `details`，content 为固定类型 `string | (TextContent | ImageContent)[]`；包根导出清单（index.d.ts:7）无裸 `CustomMessage`，v1 降级写法不可达。修复：D1.3 机制描述改写（content 固定类型 + 现行判型写法天然兼容、消费代码零改动）；P-like-2 降级路径改包根可达的 `MessageRenderer` 类型锚定；v1 降级写法以击穿反例记入 D1 被否 B4。D1 主方向不动（与主审结论一致）。
  - **MF-C（影响面 MF2，§9.3 测试清单）**：漏列文件已补并升级为逐文件枚举（widget/service/goal-control-adapter/criteria-array-adapter 各自承载项 + 触达路径 + session.test 一致性同步）。两处裁决偏离审查原文（以实读为准）：① 影响面审第 ④ 项 event-adapter.test.ts「平铺 fg/bold」不成立——实读 :83-86 是 ctx.ui 的 theme **嵌套**成员，该文件无需改；② 「session.test.ts excess property check 编译错」机制修正——extensions/tsconfig.json exclude `**/__tests__`，测试不经 typecheck，fake 漂移后果全为运行时面；session.test.ts 无运行时触达路径，列为一致性同步而非必改防红。另补两审查均遗漏的第二处 fake：widget.test.ts `makeGuiUiPort`（:295-315）。
  - **S-1（影响面 suggestion，§8）**：宿主表面不变段已补前端 widget 投影消费方（guiSetWidget marker → M17 对话流面板），零影响复核成立——buildGoalGui（gui.ts:79 起）只读 slug/goalId/status/currentTurnIndex/tokensUsed/budget/successCriteria 七源，theme 取法变化不进 GuiRenderResult。
  - **INFO（机械校准）**：DEFAULT_BUDGET :55→:44、applyEvent :276→:249、VALID_TRANSITIONS :26-38→:25-36（两处）、SDK import 先例 :20→:17。
  - 联动同步清单过账：正文 D1（采用第 3 点/被否 B4/P-like-2）✓；终态数据流图（本轮无决策触及数据流，不适用）；失败路径（§4.2 无新增边界，§8 场景 3 基线重演成立）✓；§9.2 U4 justification + §9.3 文件改动地图 ✓；§8 宿主表面不变 ✓。§5.4 E3/E4 行涉及文件栏同步加测试连带指引。
- v3（2026-09-12）：第 2 轮审查-修复循环（聚焦复审 R1 suggestion 闭合）。输入 = `.review/ext-simplify-03.md` 主审聚焦复审 R1（0 must-fix / 1 suggestion）+ `.review/ext-simplify-03-impact.md` 影响面聚焦复审 R1（0 must-fix / 1 suggestion）。逐条对账：
  - **S-1（主审 P1-8，§5.4 E1 守卫段）**：已知边界句补漏报面声明——威胁模型显式定为「守卫防 F1 的无意模仿、不防蓄意绕过」，解构赋值目标/`??=`/`||=`/括号访问/Object.assign 五类结构性绕过不在防线上、归 code review 层；并指明扫描粒度为整文件内容（`\s*` 白名单前瞻须能跨行匹配才能排除跨行白名单赋值形态，逐行实现会误报）。
  - **S-2（影响面 P0-20 交叉，§9.3 测试连带面说明）**：「测试不经 typecheck」判定基石补重审触发条件登记（extensions/tsconfig.json 纳入 `__tests__` 或 CI 新增 extensions 测试 typecheck 通路时，本节判定等级按编译视角重估），并登记翻转冲击有限的实测依据（必改 5 文件两前提下行动不变；「预期不动」组被 `as unknown as`/`as UiPort` 断言兜住；实测记录见 `.review/ext-simplify-03-impact.md` 聚焦复审 R1）。
  - 联动自查：两处均为局部声明补充（威胁模型 + 触发条件登记），无机制改动；数据流图/错误规格/决策总表/§8 验收场景不受触及，无联动点。
- v4（2026-09-12）：实施后一致性审查（阶段 3）doc_errors 修正：§5.4 E5 行「3 处生产字面量」实为 4 处（checkBudgetOnTurnEnd 3 处 + checkBudgetOnResume 1 处，budget.ts 实读），实现按「全部 dimension 字段」权威表述已删 4 处（一致）。
