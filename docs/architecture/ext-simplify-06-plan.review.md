# ext-simplify-06-plan 设计文档审查报告

> **审查对象**：`docs/design/ext-simplify-06-plan.md`（v1，2026-09-12，自称「已起草待审查」——见 `docs/design/ext-simplify-index.md:17`）
> **审查方法**：over-engineering-audit skill 四问框架 + 反模式清单 + 豁免规则（`~/.agents/skills/over-engineering-audit/references/evidence-signals.md`），对抗式：设计文档每条现状声称逐条定点核实当前源码，方案每个新增/保留机制过四问。
> **源码基线**：本 worktree 当前 HEAD，`extensions/universal/plan/` src 自 2026-09-12 起零变更（`git diff 1725c4c94..HEAD -- .../compact.ts` 为空），pi SDK 为实装 `@earendil-works/pi-coding-agent@0.84.4`（`node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts`，下称 SDK types）。
> **关键时间线**（本次审查 git 考古结论，must-fix 1 的根因依据）：crash-resilience u1（`8ca11d330`，09-10 01:48）给 plan 的 compact.ts 加了 `guardStaleCtx` 守卫与 logger 使用；本文档 v1 于 09-12 08:01 提交（`1725c4c94`）。**crash-resilience 早于本文档起草 2 天，但本文档的 compact.ts 行号与 crash-resilience 之前的版本逐行吻合**（详见 must-fix 1）。

---

## 1. 总判定

```
VERDICT: NEEDS-FIX (must-fix 1 / suggestion 4)
```

方案方向成立：6 组现状问题中 5 组属实、1 组（F5/D5 的 logger 剥离前提）部分失实；四个决策（砍 tree 档、goal 桥显式化、模板单源、删 PlanPhase）方向均被源码证据支撑；方案自身经四问核对无新增投机（详见 §5）。唯一 must-fix 是 D5 的一个子项基于过期源码快照、按文档执行会 typecheck 红，必须修文档后才能进入实施。

---

## 2. 事实核对表

设计文档声称 × 当前源码核实 × 判定。行号均为当前实读值（文档基线行号如有漂移在备注列说明）。

| # | 设计文档声称（文档位置） | 源码核实（file:line） | 判定 |
|---|---|---|---|
| 1 | tree 档只 notify，用户在对话框的选择被静默丢弃（§3.1/§3.2 F1） | `extensions/universal/plan/src/compact.ts:253-256`（`case "tree"` 仅 `ctx.ui.notify("Use /tree to manually navigate back...")`）；chosenMode 经 `handlePlanComplete(pi, ctx, state, isolation, execMode)`（tool.ts:327 → compact.ts:197-203）传入后在 tree 分支不被任何代码消费；AI 收到的 result content 为 `Plan approved. File: ...`（tool.ts:335），无丢弃提示。**完整复现路径已核实**：AI 传 `isolation="tree"`（schema 允许，tool.ts:358）→ 用户选 Goal-driven → chosenMode="goal"（tool.ts:297）→ switch 走 tree case → 无 steer、无 goalInit、plan mode 已退出（tool.ts:330 reset） | 属实 |
| 2 | tree 档结构性不可实装：navigateTree 只在 command ctx（§3.3/§5.1） | SDK types：`ExtensionContext`（:209-226）无 navigateTree；`ExtensionCommandContext extends ExtensionContext`（:255）含 navigateTree（:275）；工具 execute 签名的 ctx 为 `ExtensionContext`（:372）；`ExtensionContextActions`（:1265-1273，含 compact）无 navigateTree，`ExtensionCommandContextActions`（:1293）才有 | 属实（文档记 :254/:274，±1 行漂移） |
| 3 | plan CHANGELOG 全文无 tree/isolation 条目（§5.1 证据） | `extensions/universal/plan/CHANGELOG.md` grep 仅命中两条**其他包**条目的无关子串（:119 "instance isolation"、:121 "worktree"） | 属实 |
| 4 | tryGoalInit 5 个静默 false 出口（§3.2 F2） | compact.ts:136（goal 未加载）/:139（`startsWith("(")` plan 不可读哨兵）/:143（0 步骤）/:145-151（`goalInit()` 返回 false）/:152-154（catch） | 属实（文档记 :132/:135/:139/:141-147/:148-150，+4 行漂移） |
| 5 | 3 处调用点不消费返回值（§3.2 F2） | compact.ts:233（onComplete 内）/:243（onError 内）/:261（direct），三处均裸调用 `tryGoalInit(...)` | 属实（文档记 :222/:227/:241，系 crash-resilience 前快照） |
| 6 | steer 先发、承诺可无凭据（§3.1/§3.2 F2） | compact.ts:209（modeMessages 含 "Execute via /goal: set up tracked task decomposition..."）；:232 steer 发送先于 :233 tryGoalInit（direct 档 :260→:261 同序） | 属实 |
| 7 | M1 三源模板机制 + create-template ≈ 投机生态（§3.2 F3） | templates.ts:34-50（project `.pi/plan-templates` → global `getAgentDir()/plan-templates` → builtin，`seen` 去重）；source 三值（:11）；create-template 全链：tool.ts:19（PLAN_ACTIONS）/ :44-48（CreateTemplateDetails）/ :147-151（renderResult case）/ :213-235（executeCreateTemplate）/ :356（templateContent 参数） | 属实 |
| 8 | M2 步骤正则仅命中 1/5 模板（§3.2 F4） | 正则 compact.ts:164 `/^##\s*(实现步骤\|实施步骤\|Implementation\|Steps)/i`；5 模板 `##` 标题实读：feature-plan:18 `## Implementation Steps` **唯一命中**；implementation-plan:12/:15（任务分解/实现顺序）、refactor-plan:15（分步骤计划）、bugfix-plan:15（修复策略）、research-plan:21（后续步骤）全部脱靶；fallback 全局扫编号列表 cap 10（:181-191） | 属实（「24 个 section 标题」实为 **25** 个，见 S4） |
| 9 | extractPlanSteps 唯一生产调用在 tryGoalInit（§5.4 证据） | compact.ts:142（tryGoalInit 内），产物只进 buildPlanSuccessCriteria（:121-129） | 属实 |
| 10 | M3 三处动态 import（§3.2 F5） | index.ts:20-24（含 :19 注释 "avoids cross-group static import"）、tool.ts:255（buildExecOptions）、tool.ts:326（executeComplete） | 属实 |
| 11 | **extension-logger 依赖的唯一使用点是 index.ts:2/:9/:23**（§3.2 F5） | **失实**：compact.ts:7（`import { getLogger }`）、:12（实例化）、:236/:246（guardStaleCtx onStale 回调 `logger.warn` ×2）也是使用点——crash-resilience u1（09-10）加入，早于本文档 v1（09-12） | **失实** → must-fix 1 |
| 12 | **compact.ts 运行时零跨组依赖（唯一外部引用是 import type GoalInitFn）**（§5.5 D5 被否方案） | **失实**：compact.ts:5 运行时 import `guardStaleCtx, toErrorMessage`（@zhushanwen/pi-ext-guards）；:7 getLogger（@zhushanwen/pi-extension-logger）；package.json:44-47 两个 dependencies；extension-dependencies.json:93-95 已登记 pi-ext-guards 为强依赖 | **失实** → must-fix 1 |
| 13 | peer 声明与事实倒挂（§3.2 F6） | package.json:24（`@zhushanwen/pi-goal: workspace:*` 硬 peer）vs :26-30（peerDependenciesMeta 仅 pi-ai optional）；extension-dependencies.json:87（`"type": "optional"`） | 属实 |
| 14 | check-extension-dependencies.mjs 不校验 peer 字段（§8.1 u5） | `scripts/check-extension-dependencies.mjs` grep `peer\|optional` 零命中 | 属实 |
| 15 | PlanPhase 与 isActive 双编码、无 invariant（§3.2 F7） | state.ts:3-11（四态 + 布尔并存）；tool.ts:205（executeSelectTemplate 不检查 isActive 即写 `phase="writing"`）/:319-320；command.ts:152（写 brainstorming）/:114（handleStatus 显示）；widget.ts:6 只读 isActive | 属实 |
| 16 | **persist(phase=complete) 与 reset 之间「无任何 await」**（§3.2 F7） | **字面失实**：tool.ts:326 `await import("./compact.js")` 位于 :319（写 complete）与 :330（reset）之间——且本文档 F5 自己引用过该行动态 import，自相矛盾。语义上该 await 在 `ctx.compact()`（:327 经 handlePlanComplete 启动）**之前**执行，compact 事件不可能在该微任务间隙触发，事件不可达窗口的结论方向仍成立；P1 探针把关 | 部分属实 → S1 |
| 17 | phase="complete" 是死状态、compact.ts:25 else 分支不可达（§3.2 F7） | compact.ts:29-31（`state.phase !== "complete"` 三元）；重建路径核实：resetPlanState（state.ts:52-67）persist idle entry + 删缓存 → handler `getPlanState` 重建读最后一条 plan-state entry → isActive=false。方向论证成立，但属源码推理，**P1 探针未实跑**（见 #22） | 方向属实（待 P1 实证） |
| 18 | goal 侧 docstring：true 成功 / false = 已有 active goal 或 ctx 缺失（§1，引 goal/src/index.ts:168/:213-220） | goal/src/index.ts:129（挂载处 docstring `@returns true 创建成功；false 已有 active goal 或 ctx 缺失`）/:133-143（`api.__goalInit` 挂载）/:171/:173-179（GoalInitFn 类型导出，docstring 同句）。ext-simplify-03 实施后行号漂移，语义与 03 设计「`pi.__goalInit` 签名不变（plan 包消费方零感知）」（ext-simplify-03-goal.md:226）一致 | 属实（行号漂移，已被 03 实施改变） |
| 19 | 5 个 builtin 模板同一提交自产（§5.3） | `git log --follow -- extensions/universal/plan/templates/` 仅 1 条（05d64e48e，2026-08-22 目录重组带入） | 属实 |
| 20 | pi-plan 无外部消费（§5.3 证据） | 全仓 `rg -l "@zhushanwen/pi-plan"`：extension-dependencies.json、goal CHANGELOG、`packages/core/src/domain/new-task-search/launch-config.test.ts`、一个 .xyz-harness 产物 plan.md——无生产消费方 | 属实 |
| 21 | SDK `ui.select` 只收 string[]（发现 8 依据） | SDK types:70 `select(title: string, options: string[], opts?)`；现状 label 双处硬编码（tool.ts:256 push 与 :265 比对必须字面一致——真实双知识源） | 属实 |
| 22 | ⛔ 探针 P1/P2（§5.7，任务描述称 §6.6——文档实际无 §6.6 节，探针在 §5.7） | **未执行**：`.tmp/` 无探针产物，plan src 自 09-12 零变更（未进入实施期）。文档自身定位 P1/P2 为「⛔ 合入前」的实施期门（§8.1 u0「不通过不开工」），流程自洽；但方案方向当前仅有源码推理支撑，D6/D2 的两个关键行为断言（死状态、goalInit 在 onComplete 时序下存活）尚无实测结论 | 如实登记（非文档缺陷） |
| 23 | 基线计数：src 7 文件 1076 行 / 测试 6 个 / pi-plan 0.4.3 / promptSnippet 30 行 / 24 个标题（开篇/§6） | 实读：src 7 文件 **1096** 行；测试文件 **7 个**（漏计 compact.test.ts）；版本 **0.4.4**；promptSnippet **22 行**（tool.ts:363-384）；模板 `##` 标题 **25 个** | 部分属实 → S4 |

---

## 3. must-fix 清单

### MF1：D5「extension-logger 依赖剥离」子项基于过期源码快照，按文档执行会 typecheck 红

- **文档位置**：§3.2 F5（「这是 `@zhushanwen/pi-extension-logger` 依赖的**唯一**使用点，index.ts:2/:9/:23」）、§5.5 D5（「index.ts 删 logger……与 `@zhushanwen/pi-extension-logger` 依赖（package.json:44-46）」+ 被否方案「compact.ts 运行时零跨组依赖」）、§5.5 效果（「-1 个 npm 依赖」）、§6 表格（package.json「dependencies 删 extension-logger（D5）」+「净删约 250 行」估算）。
- **源码证据**：
  - `extensions/universal/plan/src/compact.ts:5`：`import { guardStaleCtx, toErrorMessage } from "@zhushanwen/pi-ext-guards";`（运行时依赖）
  - `extensions/universal/plan/src/compact.ts:7/:12`：`import { getLogger } from "@zhushanwen/pi-extension-logger"` + `const logger = getLogger("pi-plan")`
  - `extensions/universal/plan/src/compact.ts:236/:246`：guardStaleCtx 的 onStale 回调 `logger.warn(...)` ×2（compact onComplete/onError 双守卫）
  - `extensions/universal/plan/package.json:44-47`：dependencies 含 pi-ext-guards 与 pi-extension-logger 两项
  - **根因考古**：本文档自称「plan 包行号均为 2026-09-11 实读值」（证据基线节），但其 compact.ts 行号（tree case :233-236 / tryGoalInit :128-151 / 调用点 :222/:227/:241 / detectGoalCapability :71-79）与 `8ca11d330^`（crash-resilience 之前的 08-25 版本，245 行）**逐行吻合**（已用 `git show 8ca11d330^:...compact.ts` 比对），与当前源码（:253-256/:132-155/:233/:243/:261/:74-82，265 行）不符。crash-resilience u1 提交于 09-10 01:48，早于本文档 v1 提交（09-12 08:01）——即起草时工作区已含该改动，文档的 compact.ts「实读」读的是过期快照。
- **问题**：按文档实施「删 extension-logger 依赖」后 compact.ts 的 getLogger 无来源，typecheck 失败；§6 的 package.json 改动项与净删行数随之失真。这属于「设计文档声称的现状问题与源码不符」级别的事实基础错误（该子项的收益论证「-1 个 npm 依赖」不成立）。
- **为什么必须修**：D5 是文档六个决策之一，u1 是实施排期第一个代码单元；实施者按 §6 表格执行会在第一步撞墙，或更糟——为删依赖顺手删掉 compact.ts 的守卫日志（破坏 crash-resilience D1 的降级语义登记）。
- **建议修法**（保留 D5 主体，收缩失效子项）：
  1. D5 的「3 处动态 import 改静态」**维持**——该三条现状属实（#10），且「同包静态 import 无循环」的论证不受影响（compact.ts 新增的两个运行时依赖均不构成 tool.ts→compact.ts 的环；反向 compact.ts 不 import tool/index）；
  2. index.ts 局部删 logger 使用（:2/:9/:23 随 `.catch` 消失）**维持**；
  3. 包级 `@zhushanwen/pi-extension-logger` 依赖**保留**（消费方 = compact.ts guardStaleCtx onStale 降级日志），「-1 个 npm 依赖」效果声明删除；
  4. 同步更新 §3.2 F5 / §5.5 / §6 表格 / 净删行数，并把全部 compact.ts 行号刷新为当前值（§6 表格 compact.ts 行的改动要点不受影响）。

---

## 4. suggestion 清单

### S1：F7「无任何 await」论证与 F5 自相矛盾，建议改写为精确表述

- **文档位置**：§3.2 F7「写入它（tool.ts:319）与 resetPlanState 归零（tool.ts:330）之间无任何 await」。
- **源码证据**：tool.ts:326 `const { handlePlanComplete } = await import("./compact.js");` 位于两者之间；文档 §3.2 F5 自己把 tool.ts:326 列为 M3 动态 import 证据——同一文档两处互相矛盾。
- **问题与建议**：语义上该 await 在 `ctx.compact()` 启动（:327）之前，事件不可达窗口结论方向成立；且 P1 探针（u0）恰排在 u1（删动态 import）之前，对含 await 的现状实测反而是更强的验证。但「无任何 await」的字面断言会误导实施者跳过 P1（以为纯同步推理已闭合）。建议改写为「唯一 await（:326 动态 import，模块缓存后近似同步）位于 ctx.compact() 启动之前，事件窗口不存在；u1 删除该动态 import 后才严格无 await」，P1 保留为门。

### S2：GoalBridgeOutcome 的 4 值 reason 与 5 个失败出口「一一对应」不闭合

- **文档位置**：§5.2 D2（「5 个 false 出口改为返回 GoalBridgeOutcome = { started: false; reason: "goal-unavailable" | "plan-unreadable" | "no-steps" | "init-refused" }……出口与 §3.2 F2 列举一一对应」）、§4.2（reason 列表 4 值）。
- **源码证据**：F2/实读出口 5 个：compact.ts:136/:139/:143/:145-151/:152-154；catch 出口（:152-154）在 4 值枚举中无对应 reason。
- **问题与建议**：「一一对应」表述失准，实施时 catch 出口的映射需临场裁决——与设计目标「每个失败出口都有指向恢复动作的 reason」相悖。建议补第 5 值（如 `internal-error`，恢复动作=报告 + 降级 steer）或显式声明 catch→`init-refused` 的归并规则。

### S3：V2 验收仅实测 4 个 reason 中的 1 个（no-steps）

- **文档位置**：§7 V2。
- **源码证据**：4 reason 中，V2 ①「不装 goal 包：对话框无 goal 选项」验证的是 `buildExecOptions` 的 detectGoalCapability 路径（tool.ts:253-260），并非 tryGoalInit 的 `goal-unavailable` 出口（该出口文档自认「正常交互下不可达，防御保留」）；②实测 no-steps。`init-refused`（已有 active goal）与 `plan-unreadable` 无真实场景覆盖。
- **问题与建议**：D2 的核心新行为是「失败降级 steer + 恢复动作」，reason 文案的可信度是验收对象。init-refused 构造成本极低（先 `/goal x` 建一个再 complete 选 goal 档），建议并入 V2；plan-unreadable 可删 plan.md 后 complete 复现，可选。

### S4：基线快照漂移汇总，建议实施前刷新

- **文档位置**：开篇（「src 7 文件 1076 行」「0.4.3」）、§6（测试 6 个、净删约 250 行）、§5.3/§5.4（24 个标题）、§3.2 F3（promptSnippet 30 行）、全文 compact.ts/goal 行号。
- **源码证据**：实读 src 1096 行 / 测试文件 7 个（§6 漏计 compact.test.ts——其 extractPlanSteps 用例在 D4 下无需改，漏列无实质影响但改动地图不完整）/ 版本 0.4.4 / promptSnippet 22 行（tool.ts:363-384）/ 模板标题 25 个 / compact.ts 行号系统性 +4~+20（MF1 根因）/ goal/src/index.ts 行号漂移（03 实施后）。
- **问题与建议**：均为计数/行号级漂移，不动摇任何结论方向；但文档若不刷新，实施者按行号定位会持续错位。建议随 MF1 一并刷新基线（含 §6 测试文件清单补 compact.test.ts「不变」行）。

---

## 5. 已核实无问题（附证据快照，防后续重复怀疑）

### 5.1 现状问题声称（A 部分）

- **F1 静默丢弃真实可复现**：完整链路 tool.ts:310（resolveCompleteChoice）→ :314（chosenMode）→ :318（isolation = AI 参数，用户未见过）→ :327（handlePlanComplete）→ compact.ts:253-256（tree case 仅 notify，chosenMode 零消费）→ tool.ts:330（reset，plan mode 已退）→ :335（result 无丢弃提示）。立论基础扎实。
- **D1「结构性不可实装」SDK 证据**：navigateTree 仅存在于 ExtensionCommandContext（SDK types:255/:275）与 ExtensionCommandContextActions（:1293）；工具 execute 的 ctx 类型为 ExtensionContext（:372），ExtensionContextActions（:1265-1273）无 navigateTree。`ctx.compact(): void`「Trigger compaction without awaiting completion」（:246）；`session_before_compact`/`session_before_tree` 为真实事件（:443/:500，on() 类型化重载 :913/:917）。
- **F2 goal 桥 5 出口 + 3 调用点不消费**：见核对表 #4/#5/#6。
- **F3 三源 + create-template 全链 ≈200 行**：见核对表 #7；模板目录仅 1 commit（05d64e48e）。
- **F4 正则脱节**：见核对表 #8/#9；fallback 会误收非步骤编号项的下游代价论证成立（extractPlanSteps 产物直接进 goal successCriteria，compact.ts:121-129——goal 完成判定的证据审计依据）。
- **F6 peer 倒挂 + 无守卫联动**：见核对表 #13/#14。
- **F7 双编码 + executeSelectTemplate 无 isActive 门**：见核对表 #15；死状态方向论证（#17）+ P1 门兜底。
- **发现 7 依据**：两处 `pi as ExtensionAPI & { __goalInit? }` 断言（compact.ts:77/:134）；detectGoalCapability 的 try/catch 包裹纯属性访问（`typeof api.__goalInit === "function"`），plain object 无抛错路径。
- **发现 8 依据**：SDK ui.select 只收 string[]（:70）；现状 label 双处硬编码（tool.ts:256/:265）确为真实双知识源，EXEC_MODE_OPTIONS 查表有真实依据。

### 5.2 方案有效性（B 部分）

- **tree isolation 档零真实使用（仓内证据）**：tree 档全部暴露面 = command.ts:185 提示文案一行 + tool.ts:358 schema 枚举 + compact-handler.test.ts:98 测试；promptSnippet 示范只用 compact（tool.ts:378）；CHANGELOG 无来历（#3）；仓内无任何 agent/workflow/文档教 AI 传 tree。npm 外部用户无法从仓内证明，但文档已用「审计四问①与本次实读均未找到需求方 + 量级趋零」如实限定表述。砍档删除面 = 全部消费方，无孤儿。
- **替身论证**：complete-cancelled（Modify the plan first / Save for later → tool.ts:286-295 cancelled result，不 reset，留在 plan mode）与 abort（tool.ts:237-250，退出不 steer）均真实存在；「批准后不自动执行」有既有出口。
- **/tree 手动导航不受 D1 影响**：session_before_tree handler 按 `state.isActive` 服务（compact.ts:46-61），与 complete 的 isolation 参数无交集。
- **D6 兼容论证**：reconstructPlanState 为逐字段 `??` 白名单读取（state.ts:88-93），删 phase 后旧 entry 的 phase 字段自然忽略；新版 entry 被旧版读仅 phase 显示退化 idle，无功能损失。
- **降级 steer 新行为有真实场景验证**：V2 是 TUI 真实流程（装卸 goal 包、构造无编号步骤 plan.md），覆盖主路径 no-steps + goal 未装时选项隐藏；缺口见 S3。
- **探针 P1/P2 未执行但流程自洽**：文档将 u0 定为「不通过不开工」的实施期门并配降级路径（D6 回退 3 态 / goalInit 提前重审时序），§8.2 诚实标注「纪律上以实跑为准」。本审查确认：当前无任何探针产物，实施时必须先兑现 u0（D6/D2 的两个行为断言目前仅有源码推理支撑）。

### 5.3 方案自身的过度设计检查（C 部分，四问逐机制）

| 方案机制 | ①赌的决策 | ②接口/实现复杂度 | ③依据 | ④反模式 | 结论 |
|---|---|---|---|---|---|
| GoalBridgeOutcome 联合类型（D2） | goal 桥失败原因分类——由现存 5 个出口真实定义，非想象 | 4-5 值枚举替代语义真空的 boolean，接口远简于实现 | 现存 5 出口（compact.ts:136-154） | 无 | 通过（S2 补映射闭合） |
| EXEC_MODE_OPTIONS 查表（发现 8） | label↔mode 映射稳定——由 SDK string[] 签名强制 | 3 项静态表，消除现状两处字面耦合 | SDK :70 + 现状双处硬编码 | 无 | 通过 |
| 模板-正则守卫测试（D4） | 非抽象，测试钉死单一知识源 | — | F4 双知识源脱节实证 | 无 | 通过 |
| getGoalInit 单一断言点（发现 7） | 消重（两处断言→一处） | 降低 | 现状两处（compact.ts:77/:134） | 无 | 通过 |
| goalInit 先行后 steer（D2） | 时序保守（保持 onComplete 时序，P2 验证） | 无新增间接层 | steer 先发的正确性缺陷实证 | 无 | 通过 |
| D3 砍三源/create-template、D1 砍 tree、D6 删 PlanPhase、D5 改静态 import | 纯减法 | — | 各自现状问题实证 | 均为反模式的**删除**（inner-platform/leaky/双编码） | 通过 |

- **净概念数变化**：删 tree 档（1）、三源优先级 + source 字段 + 元创建（≈3）、PlanPhase（1）、动态 import 防御 + detectGoalCapability try/catch（≈1）vs 增 GoalBridgeOutcome（1）、EXEC_MODE_OPTIONS（1）——读者需理解的独立概念净下降，符合简化铁律。
- **second-system 检查**：当前真实调用方为 0 的新能力占比 = 0（两个新增机制均有现存双知识源/多出口证据）；无「顺便把通用性做进去」。
- **改测试迁就简化检查**：删 tree/create-template/phase 用例属被砍行为的配套删除（行为本身经裁决），非为通过而弱化断言。
- **保留的「本质复杂度」复核**：per-session 状态三件套（state.ts:28-39 Map 缓存 / :41-49 appendEntry / :79-97 reconstruct）与 compact/tree 事件处理器（compact.ts:14-62）确有真实行为支撑（跨 compact/重启存活：index.ts:27-36 session_start 重建 + 工具集再限制），设计文档列为不动，判定正确。

---

## 6. 审查结论

文档的对抗式怀疑未被推翻的部分占绝大多数：6 组现状问题里 5 组半经得起逐行核对，方案四问全过、无投机新增。需要修的只有一处——D5 的 logger 剥离子项建立在与当前源码不符的断言上（根因：compact.ts 实读基于 crash-resilience 合入前的过期快照，而文档自称晚于该合入的日期实读）。修掉 MF1（收缩 D5 子项 + 刷新基线行号）并酌情采纳 S1-S4 后，文档可进入实施；实施排期必须维持 u0 探针门先行（P1/P2 当前均未执行）。
