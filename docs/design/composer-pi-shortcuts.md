# Composer 对齐 pi 快捷键：shift+tab / ctrl+p / ctrl+shift+p / ctrl+x

> **层声明**：技术方案层（可实现的接口/行为规格）→ 下一层产物 = 代码任务。
> **功能分级**：P0（行为本体「模型与 thinking level」见 `docs/FEATURE-PRIORITIES.md` L51——用户控制 agent 智能水平/成本的核心旋钮；本次为该能力新增键盘触发通路）。
> **风险分**：10/10（P0 基数 9 + 仓内无「composer 内命令动作表」先例 +1；无数据迁移/协议变更）。
> **权威依据**：pi 快捷键语义取自 `@earendil-works/pi-coding-agent@0.84.4` 实装版（`docs/keybindings.md` + `dist/core/keybindings.js`），分析全文见会话记录《pi TUI 快捷键 → GUI 适配分析报告》（2026-09-16）。

## 1. 背景目标

**结论：让 pi TUI 用户的键盘肌肉记忆在太极 GUI 的输入框中原样成立——不新增鼠标操作，不新增第二套切换真相源。**

- **S（场景）**：pi 用户在终端里用 `shift+tab` 循环 thinking 档位、`ctrl+p`/`ctrl+shift+p` 快速换模型、`ctrl+x` 复制最后回复，全天候不离键盘。
- **C（冲突）**：同一用户打开太极 GUI，这四个动作全部退化为「鼠标移到 composer 工具条 → 点开 popover → 视觉定位 → 点击」的多步操作；高频会话中鼠标往返打断输入心流。
- **Q（问题）**：composer 的键盘分发链只覆盖了「输入与发送」（Enter/Alt+Enter/箭头/Esc），没有任何「命令类」键位段；模型与档位这两个 P0 旋钮没有键盘入口。
- **A（答案）**：在 composer 键盘分发链中新增一个「命令动作表」分支（对齐 pi 的 editor 动作表模型），把 4 个键位接到**既有**的 `onModelSelect` / `onThinkingSelect` 入口和剪贴板能力上——动作下半身零新机制。

**目标**：

- G1 pi 肌肉记忆平移：4 个键位在 composer 输入框聚焦时的行为与 pi TUI 语义一致。
- G2 与鼠标通路等价：键位触发的切换与 popover 点击走**同一**入口（core `useComposerModelThinking` 三分支路由），不产生平行真相源。
- G3 零回归（一处显式让位除外）：原生编辑行为（剪切/IME）、命令浮层、staging（fork/handoff）等既有键盘语义不被破坏；唯一让位 = composer 内 `shift+tab` 的原生反向焦点导航被档位循环接管（§3.3 决策 9 登记代价与恢复路径）。

**In scope**：composer 输入框聚焦时的 4 个键位（`shift+tab`、`ctrl+p`、`ctrl+shift+p`、`ctrl+x`）+ 3 个动作（thinking 循环 / 模型双向循环 / 复制最后回复）+ 守卫矩阵 + 反馈 + 单测。
**Out of scope**：用户自定义键位与设置页重录 UI（P1 注册表化，见 §5）、其他 pi 键位（esc 中断等）、应用级全局键、`super`/⌘ 系绑定。平台差异已裁决：pi 在 win/WSL 的 `alt+p` 向后键不跟进，GUI 全平台统一 `ctrl+shift+p`（§3.3 决策 6 显式声明偏离）。

## 2. 现状与问题分析

**结论：切换能力的「下半身」（RPC、三分支路由、回执真值、模型序、档位序、剪贴板）全部已存在，唯一缺口是 composer 分发链没有命令键位段。**

### 2.1 使用者视角的现状

已建 session、模型 chip 显示 `zai-coding-cn/glm-5.3`，用户想把 thinking 从「中」调到「高」：

- **GUI 现状**：鼠标移到 composer 工具条档位 chip → 点开 ThinkingLevelPopover → 视觉找「高」→ 点击。全程离开键盘，高频会话中每个回合都可能重复。
- **pi TUI 现状**：`shift+tab` 一按，档位循环到下一档，边框色/状态栏即变。`ctrl+p`/`ctrl+shift+p` 在模型循环序上前/后切换（`dist/core/keybindings.js:39-47` `app.model.cycleForward/Backward`）。`ctrl+x` 复制最后一条 assistant 正文（`app.message.copy`，带 flash 确认）。

### 2.2 现状机制（取自代码）

| 机制 | 现状 | 文件 |
|---|---|---|
| composer 键盘分发 | 纯事件分派器，链序：浮层→IME→staging Esc→裸箭头→Enter；deps 只读注入，无自有状态 | `packages/renderer/src/composables/panel/composer-keydown.ts` |
| 切换入口 | core `useComposerModelThinking` 暴露 `onModelSelect`/`onThinkingSelect`，内部三分支路由（staging 暂存快照 / landing 记 pending / 已建走 RPC）+ 回执真值写 store（`switchModel`/`setThinkingLevel` 失败不写 store 并 rethrow） | `packages/core/src/domain/composer/model-thinking.ts`、`packages/renderer/src/composables/features/model/useModel.ts` |
| 当前值 | `currentModelId`（"provider/modelId" 复合串）/ `currentThinkingLevel` / `currentSupportedLevels`（当前模型档位可用集），三分支感知的 computed | 同上 |
| 模型列表序 | `settingsStore.models` = runtime `aggregateModelsWithScoped` 产出，**已被 scopedModels 白名单过滤+重排（序=显示序）**；前端对 `enabled === false` 再兜底过滤（ModelSelectPopover 同款双保险） | `packages/core/src/domain/settings/settings-store.ts:53-58`（scoped/aggregate 契约注释 + `models` 声明）、`packages/renderer/src/components/panel/ModelSelectPopover.vue:112-121` |
| 档位序 | `THINKING_LEVELS` 7 档全序（off→max，对齐 pi 实装序）；`normalizeSupportedLevels` 恒含 `off`；non-reasoning 模型 = `['off']` | `packages/core/src/domain/composer/thinking-levels.ts` |
| 复制能力 | `chatStore.getMessages(sid)` 最后一条 `role==='assistant'` 消息，`normalizeContent(content)` 归一纯文本（`@taiji/shared` segments）；`navigator.clipboard.writeText` | `packages/core/src/domain/chat/store.ts:554`、`packages/shared/src/segments.ts:243` |
| 反馈基建 | `useToast()`（`info`/`error`/`warning`，无 success 级；ToastContainer 挂 PanelContainer main-area 右上角，composer 可见） | `packages/renderer/src/composables/useToast.ts` |
| 应用级快捷键表 | window 级 keydown（bubble 阶段，`useEventListener(window, 'keydown')`）；mod 判定 = `metaKey \|\| ctrlKey`（**纯 ctrl 组合同样命中**）；`open-preset-select` 条目（mod+shift+p）无 composer 焦点守卫，不检查 `defaultPrevented` | `packages/renderer/src/composables/shell/useGlobalShortcuts.ts:89,105,117` |
| 行数红线 | `Composer.vue` `<script setup>` 285 行（`vue_rules_checker.py` 计数口径 = script 体行数，不含 `<script setup>`/`</script>` 两个标签行；含标签 287），距 MAX_SCRIPT_LINES=300 余 15 行——计划期 283 → 交付后 285 | 同文件头注释（composer-keydown.ts 拆出原因） |

### 2.3 根因

composer 分发链（U02 重构）按「输入与发送」语义设计，命令类键位从未被纳入。pi 的对应机制是**编辑器动作表**：`app.*` 动作全部挂在编辑器焦点上，按序匹配（extension 快捷键 → pasteImage → interrupt → exit → 历史 → 其余动作表 → 编辑器基类，`dist/modes/interactive/components/custom-editor.js:28-81`）。GUI 缺的不是能力，是这一段「焦点内命令键位 → 动作」的通路。

### 2.4 物理数据流（以 ctrl+p 为例，实施后）

```
键盘 ctrl+p（composer 聚焦）
  → ComposerInput @keydown → useComposerKeydown 链
  → 动作表分支命中（stopPropagation + preventDefault，决策 7；连按按意图目标续步，决策 8）
  → settingsStore.models（enabled 兜底过滤，scopedModels 重排序）定位 currentModelId → 取下一模型
  → onModelSelect({provider, modelId}) —— core 三分支路由：
      ├─ [staging] 写暂存快照（发送时 getStagingConfig 透传 fork/handoff）
      ├─ [landing] setPendingModel + lastUsedModel 记录（首发 create 透传）
      └─ [已建]  useModel.switchModel → WS model.switch → runtime → pi 生效
                 → 回执 {provider, modelId} → sessionStore.applySnapshot → chip 即时更新（回执真值）
```

thinking 循环同构（`onThinkingSelect` → `session.setThinkingLevel` → 回执档位写 store）。

## 3. 解决方案

### 3.1 终态（使用者视角）

已建 session，composer 输入到一半：

```
用户：按 shift+tab
系统：档位 chip 从「中」变「高」（RPC 回执真值）；再按回到「极高」，循环往复。
      （pi 钳制：模型不支持的档位按回执生效值显示，与 popover 手动切换行为完全一致）

用户：按 ctrl+p
系统：模型 chip 切到模型列表的下一个模型；按 ctrl+shift+p 切回上一个；到表尾绕回首尾。
      模式 popover 不受影响：它由全局快捷键 mod+shift+p 触发（mac ⌘⇧P / win·Linux ctrl+shift+p，
      mod 判定含纯 ctrl，见 §2.2）——但 composer 聚焦时除外：动作表拦截同名组合只切模型
      （决策 7）；要开模式选择用鼠标点工具条。
      快速连按逐步前进（RTT 内按本地意图续步，不重步，§3.3 决策 8）；按住不放只切一步
      （auto-repeat 忽略）。

用户：按 ctrl+x
系统：右上角 toast「已复制最后回复」；到聊天工具/别处粘贴 = 最后一条 AI 回复全文。
      流式输出中按 = 复制当前已生成的部分文本（与 pi 一致）。

失败路径：
- 模型列表只有 1 个（或空）→ ctrl+p 无反应（键已吞掉，无错误噪音）。
- 切换 RPC 失败 → chip 保持旧值（回执真值语义），console.warn，无误导性 UI 变化；
  连按步进从真值重新起算。
- composer 内选中了文字按 ctrl+x → 原生剪切，不触发复制动作。
```

### 3.2 方案对比

#### 决策 1：键位接入点

| 候选 | 长期架构合理性 | 短期实现成本 | 风险 |
|---|---|---|---|
| **A. composer-keydown 新增命令动作表分支**（推荐） | 与 pi「焦点内动作表」模型同构；键位语义跟随焦点上下文（输入框），未来加 pi 键位（esc 中断等）有唯一落点；分发链已有清晰段序可插入 | 低：新文件 + 分发链插一行 | 5：新增分支与既有段（浮层/IME/箭头）的优先级需矩阵化定义（§3.4），误插序会破坏既有语义 |
| B. useGlobalShortcuts keymap 扩条目（加「仅 composer 聚焦」反向门控） | 差：该 keymap 的守卫语义是「全局生效、可选在输入框禁用」，反转为「仅输入框生效」需新门控；window 级监听在 split 多实例下还需路由到聚焦实例 | 中：门控 + 实例路由都要新写 | 7：window 级监听与组件级监听并存，双入口截断语义（CommandPopover 先例）易出隐蔽竞态 |
| C. Composer.vue 内逐键 `@keydown` 监听 | 差：键位散落 4 处，违背 U02 收口的分发架构；且键位监听把新增段写进 `<script setup>`（现 285/300，余量有限） | 低 | 6：散落监听与分发链并存，未来每次加键位都面临「放哪」的二义 |

被否理由：B 引入第二分发层制造双入口；C 是 U02 已付成本换来的收口的倒退。选 A。

#### 决策 2：模型循环顺序源

| 候选 | 合理性 | 成本 | 风险 |
|---|---|---|---|
| **A. `settingsStore.models`（enabled 兜底过滤）自然序**（推荐） | 该序 = runtime 按 scopedModels 白名单过滤+重排的产出（序=显示序），与 popover 展示序**同源同序**；pi 的「scoped models 循环顺序」语义被既有机制天然承载，零新状态 | 近零 | 3：顺序随设置页 scopedModels 调整而变，属预期行为 |
| B. 新建用户自定义循环顺序 | pi 有 `/scoped-models` reorder，但 GUI 已用 scopedModels 白名单承载同语义；再造一份排序 = 第二真相源 | 高 | 8：双排序源发散 |

选 A。被否的 B 属过度设计：GUI 用户已能在设置页用 scopedModels 排序控制循环范围与顺序。

#### 决策 3：循环取值纯逻辑落点

| 候选 | 合理性 | 成本 | 风险 |
|---|---|---|---|
| **A. 内聚在新动作文件内（renderer）**（推荐） | 逻辑是 `(idx±1+len)%len` 级别的薄函数，无跨域复用点 | 近零 | 2 |
| B. core domain 新建 cycle 模块 | 为 6 行函数建跨层模块，测试与维护成本 > 收益 | 中 | 4：过度抽象 |

选 A（减法：不新建 core 文件；守卫与循环逻辑连同键位判定一起单测）。

#### 决策 4：复制动作的反馈

| 候选 | 合理性 | 成本 | 风险 |
|---|---|---|---|
| **A. toast（info「已复制最后回复」/ error「复制失败」）**（推荐） | 剪贴板是隐形操作，键盘触发又无图标反馈锚点，闭环反馈必要；复用 useToast 基建；pi 同样有 flash 确认 | 低 | 3：连续按键产生 toast 排队——有在列上限（5 条）与 4s 停留兜底，可接受 |
| B. 无反馈 | 副作用不可见，用户无法确认是否生效 | 零 | 7 |
| C. 复用 useCopy 图标反馈态 | 该模式锚定在按钮图标上，composer 无对应 UI 锚点 | 中 | 5 |

选 A。与 `useCopy` 现状（失败静默）的差异是刻意的：按钮场景有图标态闭环，键盘动作没有，失败也需提示。

### 3.3 关键决策与权衡

- **键位语义（pi 实装默认值为基准）**：

| 键 | pi id（命名锚点） | 动作 |
|---|---|---|
| `shift+tab`（无其他修饰，非 repeat） | `app.thinking.cycle` | 档位在 `normalizeSupportedLevels(currentSupportedLevels)` 序内循环 +1 |
| `ctrl+p`（无 shift/alt/meta，非 repeat） | `app.model.cycleForward` | 模型在 `settingsStore.models`（enabled 过滤）序内循环 +1 |
| `ctrl+shift+p`（无 alt/meta，非 repeat） | `app.model.cycleBackward` | 同序循环 −1 |
| `ctrl+x`（无 shift/alt/meta） | `app.message.copy` | 复制最后一条 assistant 消息（`normalizeContent` 纯文本）+ toast |

  动作 id 沿用 pi 的 namespaced id 作为常量名（`COMPOSER_ACTION_KEYS`），注释声明与 pi `keybindings.json` 同构——P1 注册表化时的迁移锚点，本版不做用户配置。ctrl+x 不标非 repeat：复制动作幂等且无 RPC，repeat 不产生级联，不忽略（与三个切换键的差异见决策 8）。
- **决策 6：平台差异裁决——GUI 统一 `ctrl+shift+p`，不跟进 pi 的 win/WSL `alt+p`**。pi 0.84.4 实装中 `app.model.cycleBackward` 在 win/WSL 是 `alt+p`（`windowsKeybindings ? "alt+p" : "shift+ctrl+p"`，win/WSL 判定含 `WSL_DISTRO_NAME` 环境变量）——该差异的动机是终端键盘生态约束（部分终端无法传递完整 ctrl 组合），不是语义设计。GUI 是 Electron：KeyboardEvent 完整无终端约束，统一 `ctrl+shift+p` 让跨平台行为一致、文档与提示单一。代价：pi 的 Windows/WSL 用户向后循环肌肉记忆为 `alt+p`，GUI 上不成立——显式偏离，不做 alt+p 双绑定（双绑定压缩了未来 P1 用户自定义的空间且增加守卫矩阵维度；如收到 win 用户反馈再重审，重审条件 = win/WSL 用户反馈）。
- **决策 7：与全局快捷键表的裁决——composer 聚焦时动作表优先，命中键 `stopPropagation + preventDefault`**。被击穿的旧论断（记入被否谱系）：「ctrl 系与 ⌘ 系键位表分离，互不冲突」——实况是 `useGlobalShortcuts` 的 mod 判定为 `metaKey || ctrlKey`（L117），`open-preset-select`（mod+shift+p）条目无 composer 焦点守卫且不检查 `defaultPrevented`，其监听挂 window bubble 阶段：若动作表只 `preventDefault`，ctrl+shift+p 会在**全平台**双触发（模型循环 + 模式 popover）。裁决：动作表**命中任一键位即同时 `stopPropagation() + preventDefault()`（含动作 no-op 的情形）**（唯一例外 = §3.4 矩阵「composer 内有选区」行的 ctrl+x：放行原生剪切，不拦截）——事件不再冒泡到 window 层，键位语义归动作表统一裁决；⌘⇧P（metaKey）不受影响（动作表要求 `!e.metaKey`，meta 组合正常冒泡触发模式选择）。与 `shortcutOverrides` 用户重录的关系：composer 聚焦时动作表恒优先（重录的是全局键位语义）；用户在 composer 内要开模式选择用鼠标点工具条（popover 现有入口）。重审条件：用户反馈「composer 聚焦时无法用全局键开模式选择」的诉求聚集，或 P1 注册表化时统一裁决全局/composer 两层键位优先级。
- **决策 8：连按与 auto-repeat——`e.repeat` 忽略 + 本地意图目标续步**。已建态切换是回执写 store（U6 弃乐观写），计算起点滞后于 RPC 往返：直接基于 store 真值算目标，RTT 窗口内两次快按会算出同一目标（被击穿方案，记入被否谱系）。裁决：① `e.repeat === true` 直接忽略（按住只走一步，防 auto-repeat ~20-30Hz 的 RPC 风暴与记忆 KV 写穿放大）；② 动作模块持有本地意图目标（模型串/thinking 档各一）：计算起点 = 意图目标 ?? store 真值，算出新目标后立即写意图目标并发起动作；store 真值（回执/同步写）到达且**等于**意图目标时清除；动作 promise reject 时清除（回到真值起算）；**sessionId 变化即清除**（deps 已含 sessionId，防跨 session 意图残留错一步起点）；**仅已建态设立与续步**——staging/landing 分支是同步写（无 RTT 问题）不设意图，进入 staging 时清除既有已建意图（deps 补 staging 活跃只读信号，防跨态残留；影响面审 S-1）。反例重演：RTT 内快按 3 次 → 目标 A1→A2→A3 逐次递进，RPC 三发各不相同，最终一致；回执乱序/钳制（回执值 ≠ 意图目标）不清，直到等于或失败才清；乱序回跳最坏亚秒级，由既有 state_changed 防抖快照收敛自愈（runtime 侧 replicated-state markDirty 置失效 → 防抖重拉 → 快照广播 → renderer store applySnapshot，session.state_changed 通路；影响面审第 2 轮核实闭环）。级联量级：人手速连按（≤5 次/秒）与 popover 连点同量级，记忆 KV 写穿为既有每次显式选档同款语义，有界。
- **决策 9：`shift+tab` 接管原生反向焦点导航（显式让位，P0-20 四要素）**：① 量级 = composer 聚焦时 shift+tab 不再移出输入框（Tab 前向移动不受影响）；② 恢复路径 = Tab 前向移焦 / 鼠标点击 / popover 内 Esc；③ 重审条件 = 键盘可访问性（a11y）用户反馈；④ 显式判定 = 接受——反向移焦低频，档位循环是 pi 同语义高频动作，pi TUI 中该键本就无焦点语义。
- **thinking 循环的起点**：`currentThinkingLevel` 为 undefined（占位）时取归一序列第一个（`off`）；当前档非 undefined 但不在归一集（脏值/钳制残值）时，与模型侧规则对称：forward 取第一档、backward 取最后一档。行为确定、可预期；落点仍走 `onThinkingSelect`（authored 记忆记录点——cycle 是用户显式选择，语义正确）。
- **模型循环的起点**：`currentModelId` 不在列表（landing 占位空串 / 当前模型被禁用）时，forward 取列表第一个、backward 取最后一个。
- **RPC 失败**：动作层 `catch`（防 unhandled rejection），`console.warn`，无 toast——chip 显示值由回执真值语义天然保持旧值（U6），UI 不说谎；与 popover 手动路径（事件绑定同样不弹错误）观感一致；同时清除决策 8 的意图目标（连按从真值重新起算）。
- **无探针新增**：本设计零运行时断言——所有行为复用既有 RPC 与状态链，无新协议/新数据流。`switchModel`/`setThinkingLevel` 的回执语义已有既有测试覆盖。

### 3.4 守卫与优先级矩阵

动作表分支在分发链中的位置：**浮层 → IME → 【动作表】 → staging Esc → 裸箭头 → Enter**（插在 IME 之后：IME 组合中的按键绝不触发动作；在 staging Esc 之前：动作表只判定自己的 4 键，与 Esc 无交集，无顺序耦合）。

| 上下文 | shift+tab | ctrl+p / ctrl+shift+p | ctrl+x |
|---|---|---|---|
| 命令浮层 open | 不触发（浮层段已 return/短路——浮层对未消费键放行后动作表跳过，见下） | 同左 | 同左 |
| IME 组合中（`isComposing`） | 不触发 | 不触发 | 不触发 |
| 键盘 auto-repeat（`e.repeat === true`，按住不放） | 忽略（只首按走一步，决策 8） | 忽略 | **不忽略**（幂等无 RPC，决策 8 例外——与 §3.3 键位表注记同口径） |
| composer 内有选区 | 正常触发（与选区无关） | 正常触发 | **放行原生剪切**，不触发动作 |
| staging 活跃（fork/handoff） | 改暂存档位（快照） | 改暂存模型（快照） | 正常复制（staging 不影响消息流） |
| landing 态（sessionId=null） | 写 `localThinkingLevel`（authored） | 写 `pendingModel` | 按 §3.5 空流规则 no-op（landing 必无消息流） |
| 已建 session | RPC + 回执真值（连按按决策 8 续步） | 同左 | 正常复制 |
| 档位可用集仅 `off`（non-reasoning） | no-op（键吞掉） | — | — |
| 模型列表 ≤1 个 | — | no-op（键吞掉） | — |

**事件拦截语义**：动作表命中任一键位（含 no-op 行）→ `stopPropagation() + preventDefault()`（决策 7：阻断 window 层 `open-preset-select` 双触发）；未命中 → 原样放行（不拦截、不阻断冒泡，既有段行为不变）。**唯一例外 = 矩阵「composer 内有选区」行**：`ctrl+x` 在 composer 内有选区时放行原生剪切——返回未消费，不 `preventDefault`、不 `stopPropagation`（与选区行同口径，验收 S5/S11 钉住）。`shift+tab` 的 preventDefault 即接管原生反向焦点导航（决策 9 已登记让位）。

浮层 open 的动作表跳过实现：分支入口先判 `cmdOpen.value` → 直接 return false（不逐键放行进动作表）。理由：GUI 命令浮层是强模态上下文（与 pi autocomplete 仅豁免 esc 不同），切模型/档位属上下文干扰；四个键在浮层内也无既有语义，跳过零损失。

### 3.5 错误规格表

| 失败/边界 | 用户可见 | 内部行为 |
|---|---|---|
| 切换 RPC reject（网络/runtime 异常） | chip 保持旧值，无 toast | `catch` → `console.warn`（不写 store = 回执真值语义，既有 `switchModel`/`setThinkingLevel` 行为） |
| `clipboard.writeText` reject（权限策略） | toast error「复制失败」 | catch 分支提示（键盘显式动作需闭环反馈，见决策 4） |
| 最后一条 assistant 消息不存在（新 session 空流） | 无反应 | no-op，不弹 toast（避免空态噪音） |
| 剪贴板覆盖（已接受代价，P0-20 登记） | ctrl+x 无条件覆盖用户剪贴板原内容（OS 全局态、无确认、无恢复通道） | pi 同语义（last-write-wins 覆盖式、无累积、量级极小） |
| 最后一条 assistant 消息为错误消息 | 照常复制错误全文 + toast | 本项目错误以 assistant 消息入流（AGENTS.md 前端规范第 3 条），无法可靠区分「真回复」与「错误消息」（需内容判定，复杂度无收益）；pi 同语义（copy last assistant message 不挑内容） |
| 复制内容为空串 | toast info 照常提示 | 写剪贴板空串无害 |
| 模型/档位列表为空或单元素 | 无反应 | no-op（键已 preventDefault，无原生行为可泄漏） |
| 已建态连按（RTT 内多按） | 每按前进一步（决策 8 意图目标续步），最终与逐次回执一致 | 每按一次 RPC（与 popover 连点同量级）；RPC reject 时清除意图目标回到真值起算；回执乱序最坏亚秒回跳由既有 state_changed 防抖快照收敛自愈（已核实既有机制，非新增） |
| 回执乱序（极小概率，runtime 双跳无串行队列） | chip 短暂回跳后自愈 | 既有 state_changed 防抖重拉收敛（影响面审第 2 轮核实的自愈闭环），不新增机制 |
| toast 风暴（连按 ctrl+x） | 在列上限 5 条 + 4s 停留（既有限流） | 超限丢弃（`UI_TOAST_LIMITS` 既有机制） |

## 4. 验收

**结论：4 个键位在真实会话中逐一按过、与鼠标通路结果一致、既有键盘语义零回归，即验收通过。**（小改动单点验证原则：场景均可在 dev 实例中手动完成，无需真实 LLM e2e。）

实施环境：`TAIJI_DEV_BACKGROUND=1 pnpm dev`，经 dev-instance 装配器连接（项目 browser-automation 通路），或人工真机操作。

场景回溯注记：S10 承接 §3.5「RPC reject」与「连按」行；S11 承接「空流」与「选区」行；S12 承接决策 7；S13 承接「auto-repeat」与决策 9。§3.5 实钉 = 上述 7 行 + S1-S9 正向覆盖；未实钉低风险行（错误消息复制/剪贴板覆盖/空串/toast 风暴）由 U1 单测矩阵与实现评审覆盖——真机逐一钉住的边际价值低于成本，显式收窄而非声称全覆盖。

| # | 场景（谁在什么上下文做什么 → 看到什么） | 回溯 | 通过标准 |
|---|---|---|---|
| S1 | 开发者 A 在已建 session（模型含多档位）流式输出中，光标在 composer，按 `shift+tab` 三次 | G1/G2 | 档位 chip 按序推进且绕回；popover 打开后选中态与 chip 一致（同一真相源）；pi 侧下一条回复的 thinking 行为符合新档位 |
| S2 | 同一 session 按 `ctrl+p` 与 `ctrl+shift+p` 各两次（模型列表 ≥3） | G1/G2 | 模型 chip 前进/后退各一步，到表尾/表头正确绕回；ModelSelectPopover 打开后列表高亮与 chip 一致 |
| S3 | 新任务页（landing，session 未建）按 `ctrl+p` 切到目标模型，输入首发消息提交 | G2 | 创建的 session 使用该模型（session 详情/chip 显示）；再次 `shift+tab` 在新 session 上生效（landing → 已建迁移无断裂） |
| S4 | 有 ≥1 条 AI 回复的 session 中按 `ctrl+x`，到外部编辑器粘贴；再在流式输出中按一次 | G1 | 非流式时粘贴内容 = 最后一条回复全文（含 markdown 纯文本形态）；流式时 = 当前已生成部分文本；toast「已复制最后回复」出现 |
| S5 | composer 内输入文字并选中一段，按 `ctrl+x` | G3 | 触发原生剪切（文字进剪贴板、从输入框消失），**无**「已复制最后回复」toast |
| S6 | 按 `/`（或既有唤起方式）打开命令浮层，按 `ctrl+p` 与 `shift+tab`；再按 `ctrl+shift+p` | G3 | 浮层行为不受影响，模型/档位 chip 不变；`ctrl+shift+p` 冒泡触发模式 popover 弹出（既有行为：浮层 open 时动作表 cmdOpen 守卫不拦截、全局表正常命中——两 popover 并存为现状语义，非本设计引入） |
| S7 | 中文输入法组合中（候选词悬浮）按 `shift+tab` 与 `ctrl+p` | G3 | 组合不中断、不触发任何动作；上屏后按键恢复正常触发 |
| S8 | 进入 fork staging 模式（chip 出现），按 `shift+tab`/`ctrl+p`，提交 fork | G2/G3 | 源 session 的模型/档位不变；新 fork session 使用暂存后的值（`getStagingConfig` 透传） |
| S9 | 单模型环境（或仅剩 1 个 enabled 模型）按 `ctrl+p`；non-reasoning 模型按 `shift+tab` | G3 | 无反应、无报错、无 toast 噪音 |
| S10 | 停掉 runtime（或断开后端）后按 `ctrl+p`，再连按 2 次 | G2/G3 | chip 保持旧值不变（回执真值），无错误 toast；恢复后按 1 次，从真值起算切到下一个（拒绝的意图目标不残留） |
| S11 | 新建空 session（无任何消息）按 `ctrl+x`；再在 composer 内选中文字按 `ctrl+x` | G3 | 空流时无反应、无 toast；选中时触发原生剪切、无「已复制」toast |
| S12 | 已建 session 按 `ctrl+shift+p` | G3 | 模型 chip 切到上一个；**模式 popover 不弹出**（动作表 stopPropagation，决策 7）；鼠标点工具条/⌘⇧P 仍可打开模式选择（既有入口不回归） |
| S13 | 已建 session 长按 `shift+tab`（auto-repeat）1 秒后松开；焦点在 composer 内按一次 `shift+tab` 后观察焦点 | G1/G3 | 长按期间仅首按切换一步（不风暴）；切换后焦点仍在 composer（反向焦点让位，决策 9） |

**e2e 影响面评估**：改动面 = renderer composer 键盘分发 + 动作触发（零 runtime / 零 pi / 零协议变更）。既有 e2e/真实进程测试面不受影响（runtime equivalence real-pi 池、`TAIJI_PI_LIVE` 轨均不触及 renderer 键盘层）；开发阶段按改动面跑 `node scripts/select-affected-e2e.mjs --base main` 圈定结果，预期仅需 composer 相关 mock 轨（如有）。**单测化路径**：守卫矩阵（§3.4 全行）与循环取值全部可单测（`composer-keydown.test.ts` 既有模式扩展），是本设计回归防线的主体。

## 5. 下一层拆分

| # | 单元 | 内容 | justification | 文件 |
|---|---|---|---|---|
| U1 | 动作表实现 | 新建 `useComposerShortcutActions(deps)` → 返回 `(e: KeyboardEvent) => boolean`（与 `commandPopoverRef.handleKeydown` 同构）：键判定（§3.3 表，含 `e.repeat` 忽略）→ 守卫（§3.4 矩阵全行，含首行 `cmdOpen` 守卫）→ 动作编排（决策 8 意图目标续步 + 调 `onModelSelect`/`onThinkingSelect`/剪贴板 + toast）。deps 注入 `{ cmdOpen, sessionId, isStaging, currentModelId, currentThinkingLevel, currentSupportedLevels, enabledModels, onModelSelect, onThinkingSelect, getMessages, toast }`（`enabledModels` = settingsStore.models 经 enabled 过滤的循环序源，与 ModelSelectPopover 双保险同款；`isStaging` = staging 活跃只读信号，意图目标仅已建态设立/续步用；全部只读复用，不新增持久状态——ADR-0049 同判：无 per-session 存储；意图目标是模块内瞬态变量（非响应式，仅模块内闭包读写、无外部消费者），非 per-session 分区——绑定聚焦中的 composer 实例生命周期，split 多实例各持各的，sessionId 变化即清） | 键位判定/守卫/编排内聚一处，独立单测；分发链改动最小化 | `packages/renderer/src/composables/panel/composer-shortcut-actions.ts`（新）+ `composer-shortcut-actions.test.ts`（新） |
| U2 | 分发链接线 | `ComposerKeydownDeps` 增 1 项（动作表处理器），分发链插 1 分支 + 头注释链序更新 | 既有收口架构上的最小增量 | `packages/renderer/src/composables/panel/composer-keydown.ts` + `composer-keydown.test.ts` 补守卫矩阵用例 |
| U3 | 壳层组装 | composer-shell 组装 U1 deps（读 sessionStore/settingsStore/chatStore + useToast 适配窄接口） | 壳层是既定 deps 组装点（`composer-shell.ts` 职责注释） | `packages/renderer/src/composables/panel/composer-shell.ts` |
| U4 | i18n | toast 文案 2 条（复制成功/失败，zh/en） | 项目 i18n 规范 | 各语言包 |

**待验证**（实施期确认，设计期不编造）：无——两项原待验证项已核实销项：① toast split 可见性成立（ToastContainer 仅两处条件挂载：`PanelContainer.vue` chat view 锚点——Workspace 单一 PanelContainer 实例承载单/双 panel，composer 所在 panel 必在其内；`MainPanel.vue` 非 chat view 兜底；useToast 模块级单例，同一时刻至多一处渲染）；② useToast 无 success 级（仅 `info`/`error`/`warning`），复制成功用 `info`。

**P1 展望（out of scope，仅锚点）**：统一 KeybindingRegistry（pi `KeybindingsManager` 模型：整键替换/`[]` 禁用/冲突检测）+ 设置页重录 UI 扩展；`COMPOSER_ACTION_KEYS` 的 pi 同构 id 即迁移锚点。

## 6. 自检记录

- 五段骨架完整；SCQA 开篇；每章首句结论 ✓
- 方案对比 4 组决策均 ≥2 候选并给推荐 ✓
- 验收 13 场景全部回溯 G1-G3（含 5 个反向/边界场景钉住 §3.5 全部负面行为），含 e2e 影响面评估与单测化路径 ✓
- scope = 技术方案 → 代码，未跨层 ✓
- 运行时断言：零新增（复用既有链路），错误规格表覆盖全部失败路径 ✓
- 术语：沿用 `docs/CONTEXT.md` 既有词条（thinking 档位 / 模型 chip / staging / landing），“命令动作表”为本设计定义的内部机制名（实现层概念，不进领域术语表）✓

### 审查-修复循环记录

**第 1 轮（2026-09-16）**：主审 1 MF + 2 S / 影响面审 3 MF + 3 S / 简洁审 0 + 0。全部修复：

| # | 来源 | 修复落点 |
|---|---|---|
| MF | 主审 P0-11：pi win/WSL `cycleBackward=alt+p`，「全平台同键」失实 | §3.3 决策 6（显式偏离裁决）+ §1 Out of scope 改写 |
| MF | 影响 P0-12+11：`ctrl+shift+p` 与 `open-preset-select` 全平台双触发（mod=meta\|\|ctrl） | §3.3 决策 7（stopPropagation 裁决）+ §3.4 事件拦截语义 + §2.2 补事实行 + S12 |
| MF | 影响 P0-12：连按/auto-repeat 在回执真值语义下循环失步 | §3.3 决策 8（e.repeat 忽略 + 意图目标续步）+ §3.4 矩阵行 + §3.5 行 + S13 |
| MF | 影响 P0-12+20：shift+tab 接管焦点反转未声明 | §3.3 决策 9（四要素登记）+ G3 措辞修正 + S13 |
| S | 主审 P1-10：负面行为无验收承接 + thinking 不在归一集落点未定义 | §3.3 起点条目补对称规则 + S10/S11/S12 + 场景回溯注记 |
| S | 主审 P1-5：错误消息形态遗漏 | §3.5 补行（裁决：照常复制） |
| S | 影响 P0-12：U1 deps 缺 cmdOpen | §5 U1 补入 |
| S | 影响 P0-19：剪贴板覆盖未登记 | §3.5 补已接受代价行 |
| S | 影响：待验证① 可实证收敛 | §5 待验证①② 双销项（附证据） |

被否谱系：①「本 4 键全平台同键，无差异项」（击穿反例：pi 0.84.4 win/WSL `alt+p` + `useGlobalShortcuts` mod=meta\|\|ctrl 双触发）→ 决策 6/7；②「基于 store 真值直接算循环目标」（击穿反例：RTT 窗口内快按算出同一目标，逐步承诺失效）→ 决策 8；③「ctrl 系与 ⌘ 系键位表分离互不冲突」（击穿反例：同 ①后半）→ 决策 7；④「RTT 内吞键/节流替代意图目标」（否决：静默丢键违反 §3.1「每按前进一步」承诺；复用 armed/inFlightCallIds 契约冲突 ×4——5s 过期保险丝 / sync watch 中途消费放回失步 bug / 成功无条件清 ≠ 等值清 / staging 也设立 vs 意图仅已建态，且 thinking 侧两信号皆无需 core 新建机制，净机制数更高——简洁审第 2 轮论证）→ 决策 8。

**第 2 轮（2026-09-16，聚焦复审）**：主审 1 MF + 5 S（影响面审/简洁审串行复审因环境故障待跑，见下）。全部修复：

| # | 来源 | 修复落点 |
|---|---|---|
| MF | 主审：§3.3 旧版键位表残留未删（含已击穿的「同键」表头，与新表重复并存——第 1 轮编辑残留） | 删除旧表整块，保留新表；ctrl+x 行补非 repeat 差异说明 |
| S | 主审：§3.1「模式选择只由 ⌘⇧P（mac）触发」为被否论断③语义残留 | 按 mod=meta\|\|ctrl 事实改写（win/Linux composer 外同样触发模式选择） |
| S | 主审：意图目标生命周期缺跨 session 清除 | 决策 8 + U1 补 sessionId 变化即清 |
| S | 主审：§4 注记「全部负面行为均钉住」过宽 | 收窄为实钉清单 + 未钉行（低风险）归 U1 单测矩阵，显式声明而非声称全覆盖 |
| S | 主审：U1 deps 缺模型循环序源 | 补 enabledModels（与 ModelSelectPopover 双保险同款） |
| S | 主审：§2.4 数据流图注记增强 | 补 stopPropagation+preventDefault 与意图目标续步标注 |

**第 2 轮（2026-09-16，影响面审聚焦复审）**：0 MF + 4 S，全部修复：

| # | 来源 | 修复落点 |
|---|---|---|
| S | 影响 S-1：意图目标跨态残留（已建 in-flight → fork staging 续步错起点） | 决策 8 补「仅已建态设立与续步 + 进 staging 清除」；U1 deps 补 isStaging |
| S | 影响 S-2：乱序回跳自愈依赖未登记 | §3.5 补行（state_changed 防抖快照收敛，既有机制） |
| S | 影响 S-3：决策 7 缺重审条件 | 补（用户反馈聚集 / P1 注册表统一裁决） |
| S | 影响 S-4：S6 未注明浮层内 ctrl+shift+p 并存弹出为既有行为 | S6 通过标准补注 |
**第 2 轮（2026-09-16，简洁审聚焦复审）**：1 MF + 1 S，全部修复：

| # | 来源 | 修复落点 |
|---|---|---|
| MF | 简洁：§3.4 矩阵 auto-repeat 行 ctrl+x 格「忽略」与 §3.3/决策 8「不忽略（幂等例外）」规范互斥 | 矩阵格改为「不忽略（幂等无 RPC，决策 8 例外）」，口径唯一 |
| S | 简洁：决策 8 被否谱系缺「RTT 内吞键」替代候选 | 被否谱系补第④条（否决理由：违反逐步承诺 + armed 复用契约冲突 ×4 + thinking 侧无信号，净机制数更高） |

INFO 交接（范围外）：`packages/core/src/domain/composer/model-thinking.ts` 多处注释残留「RPC + 乐观更新」措辞，与 useModel.ts U6 回执真值现状漂移——实施期顺手清扫（不阻塞本设计）。
