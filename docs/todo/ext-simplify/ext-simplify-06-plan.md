# ext-simplify-06：plan 包过度设计简化（complete 交互矩阵整合 + 模板单源 + 防幻影剥离）

> **一句话结论**：`@zhushanwen/pi-plan`（0.4.3）的 6 组审计发现全部收敛——complete 动作砍掉结构性不可实装且静默丢弃用户选择的 tree isolation 档（3×3 交互矩阵降为 2×3）、goal 桥失败从静默 return false 改为「降级 steer + 显式告知」、三源模板机制收缩为 builtin 单源（砍 create-template action）、5 个内置模板步骤节标题统一并以守卫测试钉死解析正则、3 处防幻影动态 import 改静态（extension-logger 依赖随之剥离）、PlanPhase 删除（isActive 单一编码）、pi-goal peer 依赖 optional 化。除 C8 是行为修复外全部为纯减法；实施前置 1 个行为断言探针（⛔ 见 §6.6）。

## 开篇（SCQA）

- **S（情境）**：`@zhushanwen/pi-plan` 是 pi coding agent 的轻量 plan mode extension（非 mandatory，npm 独立发布，src 7 文件 1076 行）：`/plan <requirement>` 进入 plan mode（限工具集、注入只读约束 prompt），AI 探索并写 `.xyz-harness/<slug>/plan.md`，`plan` 工具的 `complete` action 收尾——弹对话框让用户选执行方式（subagent / goal / single-agent），再按 AI 传入的 `isolation` 参数决定上下文策略（compact / tree / direct）。
- **C（冲突）**：2026-09-11 过度设计审计（候选 8 + M1/M2/M3）发现该包 6 组问题，其中一组是正确性缺陷：isolation=tree 档把用户在对话框选的执行方式静默丢弃（只发一句「Use /tree to manually navigate back」）；goal 桥 `tryGoalInit` 5 个失败出口全部静默 return false，而 steer 消息已承诺「Execute via /goal」——AI 与用户被引向不存在的状态。另有：三源模板机制赌一个不存在的模板生态、`extractPlanSteps` 正则与自家 4/5 内置模板脱节、3 处防幻影动态 import 防的是一个不存在的运行时依赖、peer 依赖声明与事实倒挂、PlanPhase 与 isActive 双重编码同一事实。
- **Q（问题）**：如何在不损失 plan mode 主链路（工具集门禁、状态跨 compact/重启存活、plan 上下文穿越压缩与树导航）的前提下，让 complete 的每次交互言出必行、把无证据的投机面砍到只剩有真实需求方的部分？
- **A（答案）**：4 个决策（tree 档处置、goal 桥失败显式化、模板单源、phase 删除）+ 2 个执行项（静态 import、peer optional 化），全部行为修复或行为等价；仅模板单源带一项已量化的兼容代价（存量自定义模板目录变孤儿）。

**层声明**：本文档是「技术方案设计」层（下一层产物 = 可实施的代码任务 + 测试改造清单），准则 5/6/7 全适用。

**证据基线**：pi SDK 断言全部核对自本 worktree 实装 `@earendil-works/pi-coding-agent@0.84.4` dist 编译产物（`npm ls` 确认版本），SDK 文件引用 `dist/core/extensions/types.d.ts`（下文简写 SDK types）。plan 包行号均为 2026-09-11 实读值；审计为同日快照，个别行号有 1-2 行机械漂移（如审计记 resolveCompleteChoice 为 tool.ts:281-297，实读为 :279-298），本文一律以实读为准，语义无出入。与 goal 的接口以 `docs/design/ext-simplify-03-goal.md` 的结论为准：goal **保留** `pi.__goalInit` 跨扩展 API（GoalInitFn 为 API-1 单一权威源，goal §1），Like* 归一与 VALID_TRANSITIONS 保留决策均不触及 plan 消费面。

---

## 1. 背景：被设计的系统是什么

**plan 包解决的问题是「plan mode 的状态与上下文要跨压缩、跨重启存活，且退出时用户对执行方式有显式决定权」。**

使用者视角的完整生命周期：

1. 用户 `/plan add dark mode`（`src/command.ts:134-188`）：建 `.xyz-harness/add-dark-mode/plan.md`，工具集限为 `["read","bash","grep","find","ls","plan"]`，注入一条 user message 写明只读约束与 Phase B/C/D 流程；状态落盘为 session JSONL 的 `plan-state` custom entry。
2. AI 探索代码 → `plan(list-template)` 列模板 → `plan(select-template)` 选模板 → bash 写 plan.md。
3. 用户批准 → AI 调 `plan(complete, isolation=compact|tree|direct)`：先弹对话框让用户选执行方式（`ctx.ui.select`，goal 未装时自动隐去 goal 选项），再按 isolation 分发——compact 先压缩上下文再 steer；direct 直接 steer；tree 只发一句手动导航提示。
4. 执行方式为 goal 时，经 goal 包挂在 `pi.__goalInit` 上的编程式接口预建 goal（goal 侧 docstring：返回 true 成功；false = 已有 active goal 或 ctx 缺失，`extensions/universal/goal/src/index.ts:168/:213-220`）。

跨边界存活的机制（审计「疑似本质复杂度」四条，本次全部不动）：per-session 状态三件套（`state.ts` Map 缓存 + `appendEntry` 持久化 + session_start 重建）；`session_before_compact` / `session_before_tree` 事件处理器（`compact.ts:14-57`，让 plan 上下文穿越压缩与树导航——两个事件均为 SDK 真实事件，SDK types :442/:499，`on()` 有类型化重载 :913/:917）；工具集限制/恢复与 complete-cancelled 交互；tool/command/事件三入口拆分。

与 goal 的桥是唯一的跨包运行时接触面：`import type { GoalInitFn } from "@zhushanwen/pi-goal"`（compact.ts:5，**类型擦除，运行时零依赖**），运行时靠 `typeof pi.__goalInit === "function"` 鸭子探测降级（compact.ts:70-78）。

## 2. 设计目标

**改造后使用者和 AI 能确信：complete 对话框里做出的每个选择都会被真实消费；AI 收到的执行指令永远反映真实状态；包内每个机制都有真实需求方。**

1. **G1 交互矩阵一致**：complete 的 isolation×执行方式每个组合都有真实行为，无「问了不消费」的档位（验证 §7 V1/V3）。
2. **G2 承诺与状态一致**：goal steer 只在 goal 实际创建成功时发出；失败必须降级且告知 AI 与用户下一步（验证 §7 V2 负面场景）。
3. **G3 模板机制收缩到有证据的部分**：builtin 单源；步骤提取与模板 by construction 对齐（验证 §7 V4）。
4. **G4 声明面与事实对齐**：peer 声明、import 形态、状态编码、类型断言点各自单一化（验证 §7 V5）。

**In-scope**：`extensions/universal/plan/`（src + tests + templates/*.md + package.json）。
**Out-of-scope**：
- goal 包本体（`__goalInit` 签名、VALID_TRANSITIONS、Like* 归一均由 ext-simplify-03 承载，本包只做消费方，接口引用不变）；
- `session_before_compact`/`session_before_tree` 两个事件处理器与 per-session 状态三件套（本质复杂度）；
- execMode=subagent 的 steer-only 语义（它只是给 AI 的委派提示，无 subagent 编排接线——审计未认定其为发现，本次不扩不砍）；
- low 级清理项中无争议部分（移交 code-simplify，清单见 §8.3）。

## 3. 现状：使用者眼里是什么样的

**本章结论：complete 的 3×3 交互矩阵有 1/3 组合是假的（tree 档丢弃用户选择），goal 承诺可以无凭据发出，模板/防幻影/状态编码各养着一个无需求方的机制。**

### 3.1 complete 动作的真实现状（取自代码）

用户批准 plan 后，AI 调 `plan(complete, isolation=compact)`，实际发生的事（`src/tool.ts:301-338` → `src/compact.ts:193-245`）：

```
AI: plan(action="complete", isolation="compact")
① resolveCompleteChoice (tool.ts:279-298)
   对话框: "Plan is ready. Choose execution method:"
   选项: [Subagent-driven execution, Goal-driven execution (/goal),   ← goal 未装时不出现
          Single-agent (current session), Modify the plan first, Save for later]
   用户选: "Goal-driven execution (/goal)"  → chosenMode = "goal"
② isolation = params.isolation ?? "direct"          ← AI 传的，用户没见过这个参数
③ handlePlanComplete (compact.ts:193-245)
   steer 文案已按 chosenMode 组装："Execute via /goal: set up tracked task
   decomposition with budget control using the goal extension."     ← :205
④ isolation 分发:
   "compact" → ctx.compact(...) → onComplete: steer(goal 文案) + tryGoalInit   ← :217-231
   "tree"    → ctx.ui.notify("Use /tree to manually navigate back. ...")        ← :233-236
               ①里用户选的执行方式（含 "Modify the plan first" 之外的三年选择）全部丢弃，
               无 steer、无 goalInit——plan mode 已退出，什么都没发生
   "direct"  → steer + tryGoalInit                                              ← :238-243
```

### 3.2 真实失败模式

- **F1（C8a，选择被静默丢弃）**：isolation=tree 时，用户在 ① 对话框的任何选择都不产生效果——对话框问的是「谁来执行」，tree 档却什么都不执行，只提示用户手动 `/tree`。AI 侧收到的 result content 是 `Plan approved. File: ...`（tool.ts:335），同样不知道选择被丢弃。
- **F2（C8b，承诺不兑现）**：`tryGoalInit`（compact.ts:128-151）有 5 个静默失败出口——`:132` goal 未加载、`:135` plan 文件不可读（`readPlanFileSafe` 失败返回 `"(plan file could not be read)"`，用 `startsWith("(")` 判定）、`:139` 提取到 0 步骤、`:141-147` `goalInit()` 返回 false（已有 active goal / ctx 缺失）、`:148-150` catch。3 处调用点（:222、:227、:241）全部不消费返回值。失败后 steer 文案仍写着「Execute via /goal」——AI 去 `set up tracked task decomposition` 时 goal 根本不存在。
- **F3（M1，投机模板生态）**：三源模板机制（`templates.ts:34-50`：project `.pi/plan-templates` → global `getAgentDir()/plan-templates` → builtin，`seen` 去重）+ `create-template` action（tool.ts:213-235，AI 可写模板文件）≈ 200 行，服务的本质需求只是「给 LLM 一段初始 markdown」。5 个 builtin 模板同一提交自产，project/global 两级与元创建机制零真实消费者（inner-platform effect）。
- **F4（M2，正则与模板脱节）**：`extractPlanSteps` 的步骤节正则 `^##\s*(实现步骤|实施步骤|Implementation|Steps)`（compact.ts:160）在 5 个内置模板中只命中 feature-plan 的 `## Implementation Steps`；implementation-plan（任务分解/实现顺序）、refactor-plan（分步骤计划）、bugfix-plan（修复策略）、research-plan（后续步骤）全部脱靶退化为 fallback（全局扫任意编号列表，cap 10 条，:177-187）。模板结构与解析器是两套无机制绑定的知识（leaky abstraction）。
- **F5（M3，防幻影防御）**：3 处动态 import（index.ts:20-25、tool.ts:255、tool.ts:326）注释称「avoids cross-group static import」，但 compact.ts 唯一外部引用是 `import type { GoalInitFn }`（类型擦除）——赌的运行时依赖不存在。代价：promise 链 + `.catch` + 一条 `logger.warn`（这是 `@zhushanwen/pi-extension-logger` 依赖的**唯一**使用点，index.ts:2/:9/:23），并把 `buildExecOptions` 被迫 async 化。
- **F6（发现 5，声明倒挂）**：`package.json:24` 把 `@zhushanwen/pi-goal` 声明为硬 peer（无 peerDependenciesMeta.optional；对比 :26-30 pi-ai 标了 optional）——npm≥7 安装 pi-plan 会自动强装 pi-goal；而 `extension-dependencies.json` 登记的是 `type: "optional"`，运行时也是鸭子探测降级。声明面（强）与事实面（弱）倒挂。
- **F7（发现 6，双重编码 + 死状态）**：`PlanPhase` 四态（state.ts:3）与 `isActive` 布尔在所有写入点冗余共存，无 invariant 保证（`executeSelectTemplate` tool.ts:205 不检查 isActive 即写 `phase="writing"`）。实读追加一条审计未点透的证据：**`phase="complete"` 是死状态**——`executeComplete` 写入它（tool.ts:319）与 `resetPlanState` 归零（tool.ts:330）之间无任何 await（persist/restore/handlePlanComplete 入口均同步；`ctx.compact()` 是 fire-and-forget void，SDK types :246/:1270），JS 单线程保证事件处理器读到该状态的唯一窗口不存在；等 compact 事件真正触发时缓存已被删、重建出的状态 isActive=false。因此 compact.ts:25 的 `state.phase !== "complete"` else 分支（「Awaiting user decision」文案）不可达，brainstorming/writing 两态则零行为差异（唯一行为分支键于一个永不可观测的值）。

### 3.3 根因

**为想象中的未来付费：模板生态、运行时幻影依赖、阶段化行为门禁、编程式树导航，四个「未来」一个都没来；而真实用户每天都在走的 complete 路径，其交互矩阵却没有闭环。** tree 档的根因是 SDK 能力错位——编程式树导航 `navigateTree` 只存在于 `ExtensionCommandContext`（SDK types :254 extends / :274），而 complete 的触发点 `plan` 工具 execute 拿到的 ctx 是 `ExtensionContext`（:209，actions 面 :1260-1274 无 navigateTree）——tree 档从触发点就结构性不可实装，只能退化成一句提示；goal 桥的根因是失败路径从未被当成需求；模板与 phase 的根因是把「可能有用」当「已有需求」。

## 4. 终态：使用者眼里将是什么样的

**本章结论：对话框的每个选择必然产生真实效果；AI 收到的执行指令永远反映 goal 是否真实存在；模板名单与解析正则同仓同测。**

终态分发与报告通道（对照 §3.1 现状，唯一保留的分支轴是 isolation 两档，每档都消费 execMode）：

```
AI: plan(action="complete", isolation="compact"|"direct")     ← schema 两值，tree 传参即被拒
① 对话框选执行方式（goal 未装则无该选项）
② D2 分发：
   goalInit 先行 ──成功──> goal steer（"Execute via /goal: ..."）
                 └─失败──> 降级 steer（"Goal execution was not started (<reason>). Execute
                            step by step..." + 恢复动作） + ctx.ui.notify 警告
③ isolation 分发（steer 内容已按 ② 定稿，两档都发）：
   compact → ctx.compact(customInstructions) → onComplete: 发送 ② 的 steer
             （goalInit 失败时 add warning notify；result 已返回，报告走 steer+notify 通道）
   direct  → 立即发送 ② 的 steer；goalInit 结果同步写进 result content 与 details
```

### 4.1 成功路径（goal 档，isolation=compact）

```
AI: plan(action="complete", isolation="compact")     ← isolation 只有 compact | direct
对话框: 选 "Goal-driven execution (/goal)"（goal 已装时才出现该选项）
→ ctx.compact(customInstructions="Plan file: ... Read plan and execute implementation.")
→ onComplete: goalInit(...) 成功
   → steer: "Execute via /goal: set up tracked task decomposition with budget control..."
   → goal widget 出现，successCriteria 含 "All N steps of plan executed and verified" + 3 条步骤 preview
→ AI 与用户看到的状态与 steer 承诺一致
```

### 4.2 失败路径（带恢复指引）

- **goalInit 失败（任一原因）**：不再发 goal steer，改发降级 steer（AI 可见）：`"Goal execution was not started (<reason>). Execute step by step in the current session. Read the plan file and start implementing."` + `ctx.ui.notify` 警告用户。direct 档的 result content 追加一行说明（compact 档 result 已返回，走 steer + notify 通道——两档差异如实登记）。reason 取值与本设计新增的失败出口一一对应：`goal-unavailable`（goal 未加载，正常交互下不可达，防御保留）/ `plan-unreadable`（👉 AI 检查 plan.md 是否存在后重试 complete）/ `no-steps`（👉 AI 按 `## Implementation Steps` 节补编号步骤后重试）/ `init-refused`（已有 active goal → 👉 先 `/goal clear` 或沿用现有 goal；ctx 缺失 → 属 pi 内部异常）。每个 reason 指向一个具体恢复动作，不做纯日志字符串。
- **AI 传 `isolation="tree"`**：参数 schema（`StringEnum(["compact","direct"])`，tool.ts:357-361）直接拒绝并回显合法值，AI 可自纠——不再有「接受参数但行为与参数无关」的档位。
- **模板找不到**（`Template not found: xxx`）：list-template 重看可用名单（builtin 5 个），恢复动作在错误消息中已可推导，行为不变。

## 5. 关键决策与权衡

**本章结论：6 项——D1/D2 修 C8 正确性缺陷，D3/D4 收模板面，D5/D6 剥防幻影与双编码；另有 peer optional 化等 3 个无争议执行项（§6 表格）。**

### 5.1 D1：tree isolation 档处置（选定：砍掉，isolation 收敛为 compact | direct）

- **采用**：`params.isolation` 的 `StringEnum` 收为 `["compact","direct"]`；`handlePlanComplete` 删 `case "tree"`；command.ts:185 注入提示的 `(compact/tree/direct)` 同步改 `(compact/direct)`。矩阵从 3 isolation × 3 execMode 降为 2×3，每个组合都消费 ① 对话框的选择。plan 活跃期间的 `/tree` 手动导航不受影响——`session_before_tree` handler（compact.ts:42-57）按 `state.isActive` 服务，与 complete 的 isolation 无关，原样保留。
- **被否**：
  - **实装 tree 档**——`navigateTree` 仅存在于 `ExtensionCommandContext`（SDK types :274），complete 的触发点是工具 execute（ctx 为 `ExtensionContext`，无该能力），「实装」意味着把 complete 从工具改成 command（改变交互发起方，产品形态变更）或让 AI 提示用户手动操作（= 现状被否形态）。且该档存在依据答不出具体决策：CHANGELOG 无 isolation=tree 的来历记录，审计四问①与本次实读均未找到「批准后不自动执行、专门要跳树分支」的需求方。「批准后不自动执行」的既有替身：complete-cancelled（Modify the plan first / Save for later，留在 plan mode）与 abort（退出且不 steer，plan.md 留盘）。若用它，§3.1 例子中 ① 的选择继续被丢弃，F1 永续。
  - **维持现状**——F1/F2 是正确性缺陷，静默丢弃在用户感知线之下但破坏信任（审计核心无损锚）。
- **证据**：compact.ts:233-236（tree case 仅 notify）；SDK types :209/:254/:274（navigateTree 的 ctx 归属）；command.ts:185（提示文案三值并列）；plan CHANGELOG 全文无 tree/isolation 条目。
- **效果**：G1 成立；「砍一个边缘档位」换「交互矩阵闭环 + 消灭一类静默失败」（审计小取舍/大简化论证）。

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|---|---|---|---|---|
| 砍 tree 档（选） | 矩阵每个组合行为真实；删除面 = 全部消费方，无孤儿概念 | 低：schema/case/提示三处删改 + 测试 | 极端手动偏好用户少一个显式选项（有 abort/cancelled 替身，量级趋零） | ✅ |
| 实装 tree 档 | 需把 complete 搬进 command ctx 或加 SDK 面，为 0 需求方改产品形态 | 高 | 无需求证据支撑的新交互面 = 新投机 | ❌ |
| 维持现状 | 3×3 表面完备，1/3 组合是假的 | 零 | F1 静默丢弃永续 | ❌ |

### 5.2 D2：goal 桥失败显式化（选定：reason 单点化 + 双通道报告）

- **采用**：`tryGoalInit` 的 5 个 false 出口改为返回 `GoalBridgeOutcome = { started: true } | { started: false; reason: "goal-unavailable" | "plan-unreadable" | "no-steps" | "init-refused" }`（本设计新增类型，出口与 §3.2 F2 列举一一对应）；`handlePlanComplete` 改为「先 goalInit、后按结果选 steer」——成功发 goal steer，失败发降级 steer（文案含 reason 与恢复动作）+ notify 警告；direct 档 outcome 同步可得，executeComplete 把结果写进 result content 与 details；compact 档 goalInit 在 onComplete 回调内执行（保持现状时序——goal 状态 entry 须在压缩后的世界里创建，提前到 compact 前有被压缩边界丢弃的风险，本次不动该时序），失败经 steer + notify 报告，result content 已返回故不含它，文档如实登记这一通道差异。随手术顺带：`:73`/`:131` 两份 `pi as ExtensionAPI & { __goalInit? }` 断言收敛为单一 `getGoalInit(pi)`（发现 7），删 `detectGoalCapability`（:71-79）里包裹纯属性访问的 try/catch（无抛错路径）。
- **被否**：仅把 boolean 打进 console/logger——AI 与用户都看不到，不解决「被引向不存在的状态」；goalInit 提前到 compact 之前以求 result 统一携带——引入「goal entry 被压缩边界吞掉」的新行为风险，需另立探针验证 goal 持久化与 compact 的交错，收益只是通道形式统一，得不偿失。
- **证据**：compact.ts:222/:227/:241（三处不消费返回值）；goal/src/index.ts:168（false 语义权威定义）；ext-simplify-03-goal.md §1（`__goalInit` 保留为跨扩展 API，本设计不改其签名，消费方式不变）；`deliverAs: "steer"` 的消息进对话流、AI 可见（compact.ts:221 现状用法）。
- **效果**：G2 成立——「Execute via /goal」这句话只在 goal 真实存在时说出。

### 5.3 D3：模板机制收敛 builtin 单源（选定：砍 project/global 两级 + create-template action）

- **采用**：`listTemplates`/`loadTemplate` 只读 builtin 目录（templates.ts 收敛为单源扫描，`getAgentDir` import、`TemplateInfo.source` 字段、`seen` 去重随之删除）；`PLAN_ACTIONS` 删 `create-template`（tool.ts:19），连带删 `executeCreateTemplate`（:213-235）、`CreateTemplateDetails`（:44-48）、renderResult case（:147-151）、`templateContent` 参数与 promptSnippet 对应行；promptSnippet 的 30 行「plan 工具 vs bash 分工」教学段随 create-template 删除一并压缩（审计认定它是模板抽象泄露的下游症状）。
- **被否**：
  - **保留三源**——模板 = 轻量 DSL、create-template = 元创建机制，是 inner-platform effect；5 个 builtin 模板同一提交自产（git log 仅 1 commit），project/global 优先级与去重服务的是不存在的生态。
  - **中间态（保 project 砍 global）**——仍是两源赌注，只是赌注减半，认知税（source 字段、优先级、去重）一分没少。
- **证据**：templates.ts:9-50（三源扫描 + source 三值）；tool.ts:19/:44-48/:147-151/:213-235（create-template 全链）；全仓 `rg -l "@zhushanwen/pi-plan"` 仅 goal/CHANGELOG、core 测试、extension-dependencies.json，无外部消费证据。
- **效果**：G3 成立。**已接受代价（四要素）**——量级：存量用户若曾在 `.pi/plan-templates`（project）或 `<agentDir>/plan-templates`（global）放过自定义模板，升级后不再被发现，目录变孤儿（典型 ≤ 每目录数个 md 文件，每文件 < 1KB）；恢复路径：CHANGELOG 破坏性说明 + 用户手动把模板内容贴进对话（无需清理代码）；重审触发条件：出现 ≥1 个真实的多项目复用模板需求时，按当时需求重建单一级别；显式判定：可接受（本机与仓内均无该目录使用证据，生态赌注已由审计证伪）。

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|---|---|---|---|---|
| builtin 单源（选） | 机制面 = 证据面；删 ~150 行 + 2 概念（三源优先级/元创建） | 中：templates.ts/tool.ts/测试联动 | 存量自定义模板孤儿（已量化，见上） | ✅ |
| 保留三源 | 为 0 消费者维持扫描/去重/元创建机器 | 零 | 每次改动持续缴税，F3 永续 | ❌ |
| 保 project 两源 | 折中但概念数不减 | 中 | 双源赌注延续，判定标准模糊 | ❌ |

### 5.4 D4：步骤节标题统一 + 守卫测试钉死解析（选定：改模板对齐正则）

- **采用**：5 个 builtin 模板的步骤节统一标题为 `## Implementation Steps`——implementation-plan 的「任务分解/实现顺序」合并为一节（注释保留两段引导语）、bugfix-plan「修复策略」、refactor-plan「分步骤计划」、research-plan「后续步骤」改名；compact.ts:160 正则**不变**（已命中）；新增守卫测试：断言每个 `templates/*.md` 恰有一个 `## Implementation Steps` 节且 `extractPlanSteps` 对该节内的编号列表能提取——模板（生成端）与正则（解析端）同仓同测，漂移即红。旧版模板写出的存量 plan.md 由既有 fallback（任意编号列表）兜底，兼容。
- **被否**：
  - **扩正则穷举全部模板标题**（把 任务分解|实现顺序|分步骤计划|修复策略|后续步骤 加进正则）——双知识源依旧，未来每加一个模板都要记得改正则，F4 的 leaky 原样保留只是覆盖变宽。
  - **砍 header 检测只留 fallback**——全局扫编号列表会把 Requirements/风险缓解等节的编号项误收进步骤，goal successCriteria 质量降级（successCriteria 是 goal 完成判定的证据审计依据，误收有真实下游代价）。
- **证据**：`grep -H "^## " templates/*.md` 实读：24 个 section 标题中仅 feature-plan 的 `## Implementation Steps` 命中现有正则；extractPlanSteps 唯一生产调用在 tryGoalInit（compact.ts:138），产物只进 `buildPlanSuccessCriteria`（:117-125）。
- **效果**：G3 第二半成立——「模板引导结构」与「机器提取结构」单一知识。

### 5.5 D5：防幻影动态 import 改静态 + extension-logger 依赖剥离（选定：全删）

- **采用**：index.ts:20-25 改 `registerPlanEventHandlers` 静态 import 直调；tool.ts:255/:326 改静态 import（`buildExecOptions` 变同步）；index.ts 删 logger（其唯一使用点是动态 import 失败 warn，:23）与 `@zhushanwen/pi-extension-logger` 依赖（package.json:44-46）。
- **被否**：保留动态 import——compact.ts 运行时零跨组依赖（唯一外部引用 `import type { GoalInitFn }` 类型擦除），防的幻影不存在；同包内静态 import 无循环（compact.ts 只依赖 state.js 与 node 内置）。
- **证据**：compact.ts:1-8 import 面实读；`rg -n "logger" src/*.ts` 仅 index.ts 三行；index.ts:19 注释自述的「cross-group static import」前提无对应物。
- **效果**：G4 部分成立；-1 个 npm 依赖、-1 层 promise 链、`buildExecOptions` 去 async（为 D1/D2 的同步化铺路）。

### 5.6 D6：删除 PlanPhase，isActive 单一编码（选定：砍字段）

- **采用**：`PlanState` 收为 `{ isActive, planFilePath, requirement, templateName }`；删 `PlanPhase` 类型、所有 phase 写入/读取行（state.ts persist/reconstruct、tool.ts:205/:319、command.ts:152）；compact.ts:25-27 的 phase 三元退化为常量提示行（handler 已有 isActive 门，能走到这里的必然是进行中）；handleStatus（command.ts:114）与 renderPlanResult（tool.ts:142）显示面同步简化。兼容：reconstruct 是逐字段 `??` 白名单式读取（state.ts:88-92），删 phase 行后旧 entry 的 phase 字段被自然忽略；降级场景（新版写的 entry 被旧版读）isActive 仍在写入，仅 phase 显示退化为 "idle"，无功能损失。
- **被否**：
  - **3 态单一编码（idle/active/complete，isActive 派生）**——保留一个已证不可观测的 complete 态（§3.2 F7 死状态论证）没有信息量，还要为它写派生规则。
  - **保留 4 态补转移守卫**——为纯展示字段加状态机的税，方向反了。
- **证据**：§3.2 F7（phase="complete" 死状态的实读论证 + ⛔ 探针 P1 把关）；`rg -n "phase" src/*.ts`（排除测试）写入 5 处/读取 2 处，全部在本设计改动面内。
- **效果**：G4 收口——一个事实（plan mode 是否活跃）只有一个编码。

### 5.7 探针清单（⛔ 实施期门）

| ID | 验证的行为 | 探针 | 状态 | 失败时的降级路径 |
|---|---|---|---|---|
| P1 | `executeComplete` 内 persist(phase=complete) 与 reset 之间无事件窗口：compact 事件处理器读到的 isActive 恒为 false（D6 死状态断言） | 本地 pi CLI（TUI）：plan mode 写 plan.md → complete(isolation=compact) → 在 session_before_compact handler 临时加调试日志记录读到的 state → 日志应显示 isActive=false、无 phase="complete" 观测 | ⛔ 合入前 | 若观测到 phase="complete"（存在未预见的 await 窗隙）→ D6 回退为 3 态方案（idle/active/complete 单一编码，isActive 派生），保留 complete 语义并回本文档重审 |
| P2 | compact 档 goalInit 在 onComplete 时序下创建的 goal 状态在压缩后世界可用（D2 保持现时序的前提） | 本地 pi CLI：complete(isolation=compact) 选 goal 档（plan.md 含编号步骤）→ 压缩完成后 goal widget 出现、`/goal status` 可见 | ⛔ 合入前 | 若 goal 状态被压缩吞掉 → goalInit 提前到 compact 之前（同步执行，result 可统一携带 outcome），D2 的通道差异登记作废并重审 |

> P1/P2 共用一个临时 session-dir 与脚本化步骤；两探针都是「现状行为 + 收敛后行为一致」的守护，不引入新行为赌注。

## 6. 实现机制与文件改动地图

**本章结论：改动收敛在 7 个源文件 + 5 个模板 + 6 个测试文件 + package.json，净删约 250 行（src 1076 行的 ~23%）。**

| 文件 | 动作 | 要点（决策归属） |
|---|---|---|
| `src/tool.ts` | 改+删 | PLAN_ACTIONS 删 create-template（D3）；删 executeCreateTemplate/CreateTemplateDetails/renderResult case/templateContent 参数（D3）；isolation schema 收 2 值（D1）；buildExecOptions 同步化、chosenModeFromChoice 改查表映射 `EXEC_MODE_OPTIONS: Array<{label, mode}>`（发现 8——SDK `ui.select(title, options: string[])` 只收字符串数组，SDK types :70，无法传结构化选项，故用本地映射表而非文案反查）；resolveCompleteChoice/executeComplete 接 GoalBridgeOutcome、result content/details 携带 goal 结果（D2）；删 phase 写入与显示（D6）；promptSnippet 压缩（D3） |
| `src/compact.ts` | 改+删 | tryGoalInit → 返回 GoalBridgeOutcome，handlePlanComplete 先 init 后 steer + 降级分支 + notify（D2）；删 case "tree"（D1）；`getGoalInit(pi)` 单一断言点、删 detectGoalCapability 的 try/catch（发现 7 顺带）；删 phase 三元（D6）；正则不变（D4） |
| `src/templates.ts` | 大删 | 单源 builtin 扫描；删 source 字段/getAgentDir/seen 去重/projectDir 参数（D3） |
| `src/state.ts` | 删 | PlanPhase 类型、phase 字段全链（D6） |
| `src/command.ts` | 改 | 注入提示 isolation 两值 + completion dialog 描述同步（D1）；handleEnterPlanMode/handleStatus 删 phase（D6） |
| `src/index.ts` | 改 | 静态 import + 删 logger 与 catch（D5） |
| `src/widget.ts` | 不变 | 只消费 isActive（现状即如此） |
| `templates/*.md`（5 个） | 改 | 步骤节统一 `## Implementation Steps`（D4） |
| `package.json` | 改 | peerDependenciesMeta 增 `"@zhushanwen/pi-goal": { "optional": true }`（发现 5）；dependencies 删 extension-logger（D5）；version patch bump |
| `src/__tests__/`（6 个） | 改写 | tool（create-template/tree 用例删、goal 失败降级用例增）、compact-handler（tree 用例删、outcome 用例改）、compact-criteria-array/state/command/templates（phase/create-template/多源断言改）、新增模板-正则对齐守卫测试（D4） |

错误规格不变量：`readPlanFileSafe` 不抛错（读失败返回标记字符串，其 `startsWith("(")` 判定随 GoalBridgeOutcome 改为显式信号，消除哨兵字符串比较）；工具 action 校验失败消息含合法值列表（现状保留）。

## 7. 验收（真实场景，非单测非 mock）

**本章结论：改动规模「大」（行为变更：complete 交互矩阵重排 + goal 桥失败显式化 + 模板机制收缩），用 5 个真实场景验收，每个回溯 §2 目标；单测仅作回归辅助不计入验收。**

执行环境：本地 pi CLI 直装本包（项目纪律：extension 改动优先本地 pi 实测，不用 xyz-agent 桌面以免打包层掩盖差异），goal 包同装（V2 装卸控制）。

| # | 场景 | 回溯目标 | 真实流程（谁/上下文/做什么/看到什么） | 通过标准 |
|---|---|---|---|---|
| V1 | complete→goal 全链路（compact 档） | G1+G2 | TUI：`/plan` 走完生命周期，plan.md 含 `## Implementation Steps` 编号步骤 → `plan(complete, isolation="compact")` → 对话框选 Goal-driven → 等压缩完成 | steer 消息为 goal 文案且 goal widget 出现、`/goal status` 可见、successCriteria 含步骤 preview；无 warning notify（正向承诺兑现） |
| V2 | goal 失败降级（负面行为反向验证） | G2 | ①不装 goal 包：对话框无 goal 选项；②装 goal 但 plan.md 全文无编号列表：选 goal 档 | ①无法选到 goal；②收到含 `no-steps` 与恢复动作的降级 steer + warning notify，且**没有**「Execute via /goal」承诺、没有 goal widget（不该发生的不发生） |
| V3 | tree 档消灭 + 手动导航保留 | G1 | ①AI 传 `isolation="tree"`：工具报参数错误并回显合法值；②plan mode 活跃期间用户执行 `/tree` 跳转 | ①schema 拒绝；②跳转后的分支上下文仍含 plan 注入（session_before_tree handler 未回归）；`/tree` 手动路径与改动前一致 |
| V4 | 模板单源 + 提取对齐 | G3 | `plan(list-template)` 看名单 → select-template → 写 plan.md → complete 选 goal | 名单恰为 5 个 builtin（无 source 后缀）；`plan(create-template)` 报未知 action；V1 的 successCriteria 步骤提取自 `## Implementation Steps` 节（用 bugfix-plan 再跑一遍验证改名模板命中）；旧标题的存量 plan.md 由 fallback 兜底仍能提取 |
| V5 | 声明面对齐 + 宿主表面不变 | G4 | ①`npm install @zhushanwen/pi-plan --dry-run`（模拟外部用户）；②跑完 V1-V4 后重开 session、检查会话 JSONL 与项目目录 | ①安装计划不含 @zhushanwen/pi-goal（optional peer 生效）；②新写的 plan-state entry 无 phase 字段、旧 entry 的 session 重开后 plan mode 重建正常；`.xyz-harness/` 外无新文件、无 logger 相关报错；goal 侧表面由 ext-simplify-03 验收承载 |

## 8. 下一层拆分

**本章结论：6 个执行单元（1 探针门 + 4 代码单元 + 1 一行声明项），按依赖排序 u0→u1→u2→u3→u4，3 项 low 移交 code-simplify。**

### 8.1 迁移路径与执行单元

| 单元 | 内容（决策归属） | justification |
|---|---|---|
| u0 探针门 | 跑 §5.7 P1/P2，产物留档 | ⛔ 门槛：D2 时序假设与 D6 死状态断言实证，不通过不开工（降级路径见探针表） |
| u1 静态 import + logger 剥离（D5） | index.ts/tool.ts/package.json + buildExecOptions 同步化 | 最小且零行为变更，独立可验收（typecheck + 编译产物无动态 chunk）；为 u2 解开 async 链，先行避免交叉 |
| u2 complete 交互矩阵（D1+D2+发现 7/8 顺带） | tool.ts/compact.ts/command.ts + tool/compact-handler 测试改写 | C8 两半同一触发链（resolveCompleteChoice→handlePlanComplete），拆开会留「tree 已删但 goal 仍静默」的中间态；必须同 commit 保持绿 |
| u3 模板单源 + 标题统一（D3+D4） | templates.ts/tool.ts/templates/*.md + templates 测试 + 新守卫测试 | 模板生成端与解析端改动必须同批（守卫测试同时钉死两者）；与 u2 无文件交集，可并行 |
| u4 phase 删除（D6） | state.ts/compact.ts/tool.ts/command.ts + 3 个测试 | 独立状态面收敛；依赖 u0-P1 结论（死状态实证后才删） |
| u5 peer optional 化（发现 5） | package.json 一行 + dry-run 验证 | 无争议执行项，随任一 commit 带上；check-extension-dependencies.mjs 不校验 peer 字段（实读脚本确认），无守卫联动 |

顺序：u0 → u1 → u2 → u3 → u4（u5 任意点并入）。每单元独立 commit、独立可回滚。

### 8.2 待验证检查点（诚实标注）

- §5.7 P1/P2 实跑结果（设计阶段断言有源码依据，纪律上以实跑为准）。
- RPC 模式下 `ctx.ui.select` 的实际形态：代码现有 `typeof ctx.ui.select !== "function"` 守卫与 SDK `hasUI` 注释（TUI/RPC 为 true）之间的关系未经实测——实施 V2 时顺带确认，若 RPC 下 select 存在但永不返回，headless 分支的触发条件要改写（不影响 D1/D2 结论）。
- npm 对 optional peer 的真实安装行为以 V5 的 dry-run 为准（pnpm workspace 内 `workspace:*` 协议 link 不受影响，已按 pnpm 语义推断，未实测外部 npm 安装）。
- V4 的旧模板存量 plan.md fallback 兜底为推理兼容路径，实施时用一个旧标题 plan.md 实跑一次确认。

### 8.3 移交 code-simplify 清单（low 级、无争议，实现阶段批量执行）

- `validateAction` 导出仅测试消费且与 `StringEnum` schema 双重校验，可内联（tool.ts:26-28/:400）；
- `restoreFullToolSet` 与 command.ts:100 内联同表达式重复；
- CHANGELOG 0.3.13 与 0.3.14 条目正文完全重复（hygiene）。

（发现 7/8 不在此列：它们位于 u2 触达的函数内，随 u2 顺带执行，分开做会产生同函数两批改动。）

---

## 附录

**审计修正记录**：① 审计记 resolveCompleteChoice 为 tool.ts:281-297、tree case 为 compact.ts:231-235、tryGoalInit 为 :128-149，实读为 :279-298/:233-236/:128-151——纯快照漂移，无语义出入；② tryGoalInit 静默出口审计记「×3 不消费」，实读为 5 个 false 出口（3 处调用点不消费返回值，表述沿用审计口径但出口数以实读为准）；③ phase="complete" 死状态与 navigateTree 的 ctx 归属为本设计实读新增证据（审计未及），分别强化 D6 与 D1。

**引用文档**：`docs/design/ext-simplify-03-goal.md`——goal 保留 `pi.__goalInit`（GoalInitFn API-1 单一权威源）与 VALID_TRANSITIONS 状态表；plan 侧消费方式与接口引用不变，peer optional 化不影响 goal 侧声明。

**变更历史**：
- v1（2026-09-12）：初稿。覆盖审计候选 8（C8 high）+ M1/M2/M3 + 四问发现 5/6/7/8 与 suggestions；探针 P1/P2 定为实施期门；3 项 low 移交 code-simplify。
