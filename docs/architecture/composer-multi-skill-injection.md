# Composer 多 Skill 插入：任意位置触发 + Runtime 预处理注入 + 预算预检降级

> **一句话结论**：把 skill chip 从「行首唯一的命令 chip」改造为「任意位置、多个共存的标记 chip」，pi 侧不改一行代码——runtime 在发送前把 chip 标记展开为与 pi 逐字对齐的 `<skill>` 全文注入；预估超窗（>80% contextWindow）时整条消息降级为「短标记 + 模型自主 read」模式，防止单条巨大消息把会话拖入持续失败态。
>
> **R4 修订（2026-09-12）**：注入形态从「原位展开」改为「**正文原样保留占位标记 + 消息末尾集中追加 `<taiji-skill-data>` 包裹块**」（D11）——正文句子不再被全文劈开，resume/复制/编辑重发的数据面干净，降级形态与正常形态统一为同一包裹块。附带两项显示层修复：用户气泡混排 badge 前后换行（D12）、composer skill chip 前后自动空开（D13）。

**当前层 → 下一层**：本文档是**技术方案设计**（下一层产物 = 可实现的接口/数据模型/代码任务），准则 5/6/7（物理数据流、错误恢复、运行时探针）全适用。

---

## 1. 背景目标

### SCQA

- **S（情境）**：taiji 的 composer（聊天输入框）已有一套四符号体系：`/` 行首触发 slash 命令浮层（含 `/skill:`），`$`/`#`/`@` 在任意位置（行首或空格后）触发文件/session/subagent 引用浮层。底层 pi（`@earendil-works/pi-coding-agent` 0.84.4）提供 skill 机制：`/skill:name` 命令把 SKILL.md 全文展开注入 user message。
- **C（冲突）**：pi 的 skill 展开只认「消息以 `/skill:` 开头 + 第一个空格前的一个名字」——第二条 skill、不在消息开头的 skill 全部失效；且多 skill 全文叠加可能撑爆模型上下文，pi 对「单条巨大消息」没有任何防线（详见 §2.3）。
- **Q（问题）**：如何在不改 pi 的前提下，让用户在 composer 任意位置插入任意多个 skill，并保证注入量可控、会话不会因此卡死？
- **A（答案）**：renderer 侧 skill chip 标记化（触发/chip/序列化三层改造）+ runtime 侧发送前预处理注入（展开格式与 pi 逐字对齐）+ 预算预检（超 80% contextWindow 整条降级为短标记，模型自主 read）。

### 系统是什么

taiji 是 Electron + Vue 3 桌面 AI Agent 工作台，三层架构：renderer（Vue，composer 所在）→ WebSocket → runtime（Node 子进程）→ RPC → pi（AI Agent 核心，**不可修改**，语义断言以 node_modules 实装 0.84.4 为准）。

composer 的输入是 contenteditable 富文本，结构化片段（chip）在 DOM 层以 `contentEditable=false` 的 span 存在，发送时经 `getSegmentsFromEl` 解析为 `Segment[]`（判别联合，`packages/shared/src/segments.ts:43-51`），再经 `segmentsToText` 序列化为纯文本 prompt 发给 pi。重开 session 时 badge 从 `segments.json` sidecar（按 clientUuid ↔ userEntryId 映射）恢复。

### 设计目标

从使用者体验倒推，用户要能做到：

1. **G1 任意位置触发**：在输入框任意位置（空格或 tab 后——行首保持命令浮层语义不变，见 D1 仲裁）键入 `/` 唤起 skill 选择浮层（对齐 `#`/`$`/`@` 的体验），选中后 chip 插在光标处。
2. **G2 多 skill 生效**：一条消息里混排任意多个 skill chip 与正文，每个 skill 的全文都真正注入给模型——不是只有第一个生效。
3. **G3 注入可控**：多 skill 全文叠加不会把会话拖入「每轮请求必报错」的持续失败态；超预算时有安全的降级路径，且降级后 skill 仍能被模型使用（自主 read）。
4. **G4 会话可恢复显示**：发送后关闭重开 session，skill chip 仍显示为 chip（不退化为大段 XML 文本）。
5. **G5 零 pi 侵入**：不改 pi 源码、不 fork；pi 原生 `/skill:` 行首语义对「手打文本」保持不变。

### In-scope / Out-of-scope

**In-scope**：
- composer 触发层/chip 层/浮层的 skill 通道改造（dom-core + renderer）
- skill segment 序列化格式改造（shared）
- runtime 发送前预处理注入（展开 + 预检 + 降级）四条发送路径全覆盖
- resume 反渲染兜底（sidecar 之外的标记反解析）
- pi 语义探针守卫（展开格式漂移检测）
- runtime 读 pi stdout 的 readline 分帧防御（顺手修，风险敞口因大文本注入上升）

**Out-of-scope**：
- skill 目录管理/发现/设置 UI（现有 SkillRegistry + SettingsResourcePage 不动其职责）
- pi 原生 `/skill:` 行首语义的任何变更（手打文本行为与今天完全一致）
- system prompt 中 `<available_skills>` 自动触发路径（模型自主 read 机制 pi 已有，本文档只复用不修改）
- prompt token 计量的精确化（用字符估算，见 D6；不引入 tokenizer 依赖）
- 行首 `/` 命令浮层的现有行为（命令混排、扩展命令注册等）

---

## 2. 现状与问题分析

### 2.1 触发与 chip 现状（使用者视角）

用户在 composer 行首输入 `/` 会弹出命令浮层（含 `/skill:xxx` 项，数据来自 pi `get_commands` RPC）。选中后插入一个 **slash chip**——它被强制插到输入框**最前面**，且**只允许存在一个**；输入框里存在任何 chip 时 slash 不再触发（`packages/dom-core/src/composer/input/contenteditable.ts:158-169`、`chip-commands.ts:76-104` 的 `insertSlashChip`）。

对比 `$`（文件）/`#`（session）/`@`（subagent）的体验：触发正则 `/(?:^|\s)X(\S*)$/`（`input-dom.ts:237-254`）——行首或**空格后任意位置**触发；chip 用 `insertChipAtSelection` 插在**光标处**；**多个共存**；选中后 `clearSymbolQueryBeforeCursor` 只删「符号+过滤词」段不吞草稿。

`/` 当年刻意不做任意位置触发（D5 决策，`input-dom.ts:262-264` 注释）：`帮我看看 /usr/local/bin` 这类路径文本高频出现，空格后 `/` 会误弹浮层。

### 2.2 pi 的 skill 展开机制（实装事实）

pi 0.84.4 `dist/core/agent-session.js` 的 `_expandSkillCommand`（:983-1007，已逐行核实）：

```js
if (!text.startsWith("/skill:")) return text;   // ① 必须整条消息以 /skill: 开头
const skillName = ...第一个空格前的 token...      // ② 只取一个名字
const args = ...剩余全部作为 args...              // ③ args 里的 /skill:xxx 不再解析
// 命中后：读 SKILL.md → 剥 frontmatter → 包成 block：
// <skill name="..." location="/abs/SKILL.md">\nReferences are relative to <baseDir>.\n\n<body>\n</skill>
// 返回 args ? block + "\n\n" + args : block
```

展开结果是**本地文本替换**（不发特殊指令），作为普通 user message 发给模型并落盘 session JSONL（JSONL 里存的就是展开后文本）。RPC 模式（`rpc-mode.js:298-323`）对 `prompt`/`steer`/`follow_up` 命令的 message 字段纯透传，同一套展开在 session 内部发生。skill 名不存在时原样透传。

### 2.3 真实失败模式

**失败模式 A（现状隐藏缺陷）：skill chip 不在消息开头 = 完全失效。**
用户先打正文再插 chip 时，`segmentsToText` 产出 `正文 /skill:a`——不满足 pi 的 `startsWith("/skill:")` 检查，`/skill:a` 以**字面文本**发给模型。模型只能靠 system prompt 里的 `<available_skills>` 列表猜测性地自主 read，显式插入意图丢失，且用户毫无感知。

**失败模式 B：第二个 skill 起 = 字面透传。**
`/skill:a /skill:b` 只有 `a` 展开，`b` 是 args 里的字面文本。这是用户提出本需求的直接动因。

**失败模式 C：多 skill 全文叠加 → 会话进入持续失败态（pi 无防线）。**
后果链（全部实装核实）：

1. pi 发送前对 prompt 长度**零校验**（`prompt()` 只检查 compaction 进行中/模型未选/鉴权；skill 展开无截断；LLM 组装层只 clamp 输出 maxTokens，输入原样发送）。
2. 超限 → provider 返回 400（"prompt is too long" 类）→ pi-ai `isContextOverflow` 正则识别 → 移除失败 assistant 消息 → auto-compact → **重试恰好一次**。
3. **切点盲区**：compaction 切点算法 `findCutPoint`（`dist/core/compaction/compaction.js:308-352`）从最新往回累计 token，首次 ≥ `keepRecentTokens`（默认 20000）处落刀、「保留切点及其之后」。**一条自身 ≥ 20000 token（约 8 万字符）的 user message 永远落在保留区，无法被摘要丢弃**。
4. 于是：巨大消息留在上下文 → 重试仍超限 → "Context overflow recovery failed" → 进程/session 存活，但**每轮请求重复失败**。pi 没有头部截断兜底；出路只有换大窗口模型、fork 到消息之前、或新 session。
5. 连带：compact 的摘要请求把历史**全量**（含巨大 skill block）发给模型——摘要请求自己就可能超限失败。taiji 的 smart-context 接管 compact 也救不了：它接管的是**摘要引擎**（same-model/cross-model），切点 `firstKeptEntryId` 来自 pi preparation 入参，只消费不修改（`extensions/universal/smart-context/src/compact-handler.ts:40-44`）。

**失败模式 D：runtime 读 pi stdout 的分帧隐患（既有，敞口将变大）。**
runtime 解析 pi stdout JSONL 曾用 node `readline`（**已随本 feature D10 修复为 LF-only 读取器**，下文为修复前动机记录）；pi 自己刻意不用 readline——JSON 字符串里合法的 U+2028/U+2029 会被 readline 拆帧导致 `JSON.parse` 失败（pi 的 `rpc/jsonl.js:13-48` 自实现 LF-only 读取器并注释了原因）。今天这个隐患就存在；skill 全文注入会显著增加大文本回显流量（历史读取、消息回显），中招概率上升。

### 2.4 物理数据流（现状）

```
[composer DOM]
  chip (slash-chip/skill) + 文本
    ↓ getSegmentsFromEl (dom-core input-dom.ts)          —— DOM → Segment[]
[Segment[]]  {type:'skill', name, location?} 已存在（segments.ts:45）
    ↓ segmentsToText (segments.ts:68-144)                 —— skill → "/skill:name" 内联文本
[promptText]  (+ 非纯文本时: segments.json sidecar 写入 + 尾部 <!--taiji:msg:<uuid>--> 标记)
    ↓ chatApi.send → WS 'message.send'
[runtime] session-message-handler.ts:522 → message-dispatcher.sendPrompt (:79-149)
    ↓ BeforeSend hook → ensureActive → busy 预检          —— 文本零预处理，透传
[pi RPC] {type:'prompt', message}  (steer: :522 / followUp: :527 两分支同样透传)
    ↓ pi _expandSkillCommand —— 只认开头第一个 /skill: token
[provider]  ← 超限无防线（§2.3 失败模式 C）
    ↓ 落盘 session JSONL（展开后文本）
[重开 session] runtime history-rebuild-cache.ts 读 JSONL + segments.json sidecar → badge 恢复
```

根因归纳：**「命令模型」（一条消息 = 行首一个命令 + args）与用户要的「标记模型」（内联、多处、混排）结构性冲突**；pi 协议里没有标记式 skill 的表达，所以注入必须由 taiji 自己做——这决定了方案的形态。

---

## 3. 解决方案

### 3.1 终态（使用者视角）

**场景 1：任意位置插入两个 skill（成功路径）**

> 用户在 composer 输入：`帮我 review 这段代码`，然后空一格、键入 `/rev`——光标处弹出 skill 浮层（只列 skill，不列命令），过滤出 `code-review-graph`，回车选中。输入框变为 `帮我 review 这段代码 [code-review-graph✦]`（chip 在光标处）。再空一格键入 `/simpl`，选中 `code-simplify`，又插一个 chip。发送。
>
> pi 的 session JSONL 里，这条 user message 是（R4 形态，D11）：
> ```
> 帮我 review 这段代码 <taiji-skill name="code-review-graph" location="…"/> <taiji-skill name="code-simplify" location="…"/>
>
> <taiji-skill-data>
> <skill name="code-review-graph" location="/Users/x/.agents/skills/code-review-graph/SKILL.md">
> References are relative to /Users/x/.agents/skills/code-review-graph.
>
> （SKILL.md 全文…）
> </skill>
> <skill name="code-simplify" location="…">
> （SKILL.md 全文…）
> </skill>
> </taiji-skill-data>
> ```
> 正文**原样保留占位标记**（句子完整可读，不被全文劈开）；两个 skill 的全文展开（与 pi 原生 `/skill:` 展开格式逐字一致）集中追加在消息末尾的 `<taiji-skill-data>` 包裹块内，块内按 name 去重。模型回答同时体现两个 skill 的方法论。**消息流里该条消息显示为：正文 + 两个 skill chip badge**（反解析先剥块、再把正文标记还原为 badge），badge 前后不换行（D12 混排内联渲染）。

**场景 2：超大 skill 组合自动降级（安全路径）**

> 用户挂载了 32k 窗口模型，插入两个大 skill（SKILL.md 正文合计约 6 万字符，CJK 为主）。CJK 感知估算 ≈ 6 万 token > 0.8 × 32k = 25.6k 阈值 → 触发降级。（对照：128k 窗口模型下同样输入 ≈ 6 万 token < 102.4k，不降级，走全文注入。）
>
> 发送后：JSONL 里这条消息是正文（标记原样保留）+ 末尾独立的降级包裹块（R4：与正常形态同一 `<taiji-skill-data>` 包裹，旧 `<taiji-skills>` tag 退役）：
> ```
> 帮我 review 这段代码 <taiji-skill name="code-review-graph" location="…"/> <taiji-skill name="code-simplify" location="…"/>
>
> <taiji-skill-data>
> <taiji-skill name="code-review-graph" location="/Users/x/.agents/skills/code-review-graph/SKILL.md"/>
> <taiji-skill name="code-simplify" location="/Users/x/.agents/skills/code-simplify/SKILL.md"/>
> Use the read tool to load the skill files above before continuing the task
> </taiji-skill-data>
> ```
> （指引行 C5 改英文——adversarial-review-fixes §3.4：块进 LLM 上下文，与 pi available_skills 英文措辞对齐；三要素 read 工具名/路径/时机不变。）
> 模型自主 read 这几个 SKILL.md 并应用。**前端该消息仍显示为 skill chip badge（不是标记原文）**，消息流内联提示行（锚点 turn 之后）显示「已按标记模式注入（预算超限）」（实施形态：badge 位于 ui 包 UserBubble 内，提示以消息内联行呈现，降级/失效双 variant——实施落点见合理偏差登记）。
>
> 恢复指引：换大窗口模型 / 减少本次插入的 skill 数量，即可恢复全文注入模式。

**场景 3：skill 已被删除（降级可见路径）**

> 用户昨晚插入过 chip 的 skill 今天被卸载。发送时 runtime 解析 name 失败 → 该标记**原样保留**在 prompt 文本里，同时前端收到一条提示（toast + 消息流内联提示）「skill xxx 不存在，已按原文透传」。不静默、不阻断整条消息。

**场景 4：busy 时补充 skill（steer 路径）**

> 模型正在执行中，用户空格后 `/` 选中一个 skill 发送 → 走 steer 队列，runtime 在 steer 发送前做同样的展开/预检/降级处理。行为与普通发送一致。

### 3.2 方案对比

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|---|---|---|---|---|
| A. 拆多条 RPC prompt（每条一个 skill） | 差：每条 prompt 是独立 agent turn，纯 skill 无正文的消息立即触发模型回复，语义完全错误；且无「批量 pending」RPC 通道 | 中 | 行为错误不可绕过 | ❌ |
| B. renderer 预展开（发送前拉内容拼文本） | 差：renderer 无文件系统访问，需异步 RPC 拉 SKILL.md 内容，点发送时才取内容引入时序复杂度与失败面；prompt 组装逻辑散到两端 | 中 | 发送时序竞态；展开逻辑双份 | ❌ |
| C. runtime 预处理注入，无预算预检 | 中：注入语义正确，但失败模式 C（单条巨大消息 → 会话持续失败）无任何防护，等于给用户一把卡死会话的枪 | 低 | 撑爆后只能 fork/新开 session 救援 | ❌ |
| **D. runtime 预处理注入 + 预算预检 + 降级标记（本设计）** | 好：注入收敛在 runtime 一处、格式与 pi 对齐可探针守护；降级路径复用 pi 已有的「模型自主 read」机制；chip 通道与 pi 原生命令通道正交互不干扰 | 中：触发/chip/序列化/注入四层各一小块 | 降级判断依赖 CJK 感知字符估算（非精确计量）——估算取保守方向（宁可提早降级），漏判由 pi overflow 报错链兜底（D6 漏判-兜底关系） | ✅ |

若用方案 A：§3.1 场景 1 会变成——第一条消息（只含 skill-a 无正文）模型立即开始回答跑偏，用户被迫 abort。若用方案 B：场景 2 降级判断要在 renderer 做，还需要 renderer 额外拉每个 SKILL.md 的字节数与当前 contextWindow，两倍 RPC 时序。若用方案 C：场景 2 中 32k 窗口模型直接进入「每轮 400 → compact-and-retry 失败 → 再 400」循环，会话报废。

### 3.3 关键决策与权衡

**D1：触发模式——空格后 `/` 弹 skill-only 浮层（选定）**
- **采用**：新增 skill 触发检测，正则 **`/[^\S\n]\/(\S*)$/`**（`[^\S\n]` = 空白但非换行：半角空格、tab、全角空格 U+3000、NBSP 等全部覆盖——对齐 `#`/`$`/`@` 的 `\s` 空白语义，仅排除 `\n` 分支；行首与换行后新行行首完整让位给现有命令浮层，见「被否 1」的仲裁说明）。命中的浮层**只列 skill**（panel 态从 commandStore 过滤 `source:"skill"` 项；landing 态用 `useProjectSkills` + `useGlobalSkills` 合并列表），不列命令。行首 `/` 的现有命令浮层（命令 + skill 全量）**保持不变**。
- **被否 1**：正则含 `^` 分支（`(?:^|\s)\/`）——实装（`contenteditable.ts:171-184`）各触发回调独立派发，行首 `/x` 会同时命中命令触发与新 skill 触发，两个浮层打架；仲裁规则：**行首（含换行后新行行首）归命令浮层，仅行中空白（非换行）后归 skill 浮层**，两个正则的触发域互斥无重叠。早期草案用 `[ \t]`——不含全角空格/NBSP，中文输入法全角空格后 `/` 不触发，与「对齐四符号体验」不一致，被否。
- **被否 2**：空格后 `/` 弹全部命令——命令语义仍是「行首命令」（对齐 pi 命令模型），任意位置弹命令会让 `/compact` 等出现在句中造成语义混乱。
- **被否 3**：维持仅行首触发——直接否掉本需求 G1。
- **D5 翻案与误触发缓解**：空格后 `/` 触发当年被 D5 否决（路径文本 `看看 /usr/local/bin` 误弹）。缓解与量级：① 浮层 query 合法性过滤——skill 名 pattern 为 `[a-z0-9-]{1,64}`（**query 过滤含空串合法**：刚敲 `/` 尚无过滤词时列全量 skill，`{1,64}` 指 skill 名本体域；实施为 `{0,64}`），query 一旦含 `/`、大写、下划线等非法字符**立即关闭浮层**（`/usr` 短暂弹出，输入到第二个 `/` 即关闭）；② 误弹量级：当前用户 skill 集（约 30 个，名多为多音节英文）下，常见路径短 token（`tmp`/`usr`/`var`/`home`）前缀命中 0~2 项，误弹为极小浮层且输入即收。**重审触发条件**：skill 集增长导致单字母/双字母前缀命中 > 5 项时，评估加最小 query 长度门槛（如 ≥2 字符才弹）。
- **证据**：`input-dom.ts:237-264`（四符号正则与 D5 注释）、`CommandPopover.vue:158-194`（variant 数据源分支）。
- **效果**：G1 成立（§3.1 场景 1 的 `空一格键入 /rev`），且行首命令行为零变化（场景 6② 回归）。

**D2：skill chip 标记化——光标插入、多个共存、同 skill 去重（选定）**
- **采用**：新增 `insertSkillChip`（类比 `insertFileChip`，`chip-commands.ts`）：插在光标处、多个共存、`×` 删除、Backspace 整块删除；浮层列表里**已插入的 skill 标记「已选」并禁选**（去重，防同一 skill 注入两份全文浪费上下文）。解除「存在任何 chip 时 slash 不触发」对 **skill 浮层**的限制（对行首**命令**浮层保留该限制——命令仍是行首唯一语义）。
- **被否**：复用现有 slash chip（最前、唯一）——与 G1/G2 直接冲突。
- **证据**：`chip-commands.ts:46-58`（insertChipAtSelection 通用机制）、`:76-104`（slash chip 的最前唯一限制；D4-a 就地化改革前状态，现行「唯一/替换 + 视觉就地」语义见 composer-chip-insertion-semantics.md）、`getSegmentsFromEl`（`input-dom.ts:92-107`）已支持解析任意位置多个 skill chip——数据模型层零改动。
- **效果**：G1/G2 的输入侧成立。

**D3：序列化——skill segment 产出私有标记 `<taiji-skill/>`（选定）**
- **采用**：`segmentsToText` 的 skill 分支从 `/skill:${name}` 改为 `<taiji-skill name="${name}" location="${location}"/>`（location 可得时带上，作为降级模式与反解析的自描述数据）。runtime 只认该标记展开。手打文本 `/skill:name` **不处理**，与 pi 原生行为完全一致（整条消息以其开头才被 pi 展开）。
- **被否 1**：维持 `/skill:name` 文本 + runtime 全局替换——用户正文里讨论 `/skill:` 语法（meta 场景）会被误展开，且 chip 与手打无法区分。
- **被否 2**：runtime 同时展开任意位置的 `/skill:valid-name` token——比 pi 更激进（pi 只认行首），扩大误伤面；被否 1 同理。
- **边界声明**：手打 `/skill:a` 与 chip 混排时，**手打文本不位于消息首位**则序列化产物不以 `/skill:` 开头，pi 字面透传（模型可经 `<available_skills>` 自主 read）；手打文本位于首位时 pi 仍原生展开（block + args，args 内的标记与末尾块不受影响）。两情形均为 pi 原生行为：chip 通道才是本设计的增强面，手打行为与 pi 零偏差。
- **证据**：`segments.ts:96-98`（现序列化点，单点改造）。
- **效果**：G5 成立（手打行为零变化）；标记自描述支撑 G4 兜底与降级模式（D7）。

**D4：name → 文件路径的权威源 = taiji SkillRegistry（skill-reload-nondestructive D7 修订；本节原选定的 pi `get_commands` 决策已被反转）**
- **采用（现行）**：runtime 展开器解析 skill name 时，以 taiji SkillRegistry 扫描（`getGlobalSkills() ∪ getProjectSkills(sessionCwd)`，取 `SkillInfo.sourcePath`）为权威映射；**不信任标记自带 location** 的不变式不变——read 路径唯一来自权威扫描。SkillRegistry 职责自本修订起含注入权威映射（在 settings UI / 扫描预览之外）。project 扫描集含 `cwd/.pi/skills`（scan/watch 同源对账）。
- **被否（本修订否决原选定）**：pi `get_commands` 快照——reload 才刷新的滞后快照，与「skill 变更即时生效、不依赖 pi 生命周期」目标冲突；同名覆盖语义保留与 pi first-set-wins 的对齐（global 先载）。反转的完整论证（扫描集差异 / 失败与陈旧窗口语义）见 skill-reload-nondestructive §3.3 D7 与 [ADR-0050](../adr/decisions.md)。
- **证据**：`skill-injector.ts`（`SkillMappingSource` / registry 源映射）、`skill-dirs.ts`（project 扫描集）。

**D5：展开格式与 pi 逐字对齐 + 探针守卫（选定；R4 修订：落点从原位替换改为末尾块内集中，见 D11）**
- **采用**：runtime 展开器产出的 block 格式与 pi `_expandSkillCommand` 逐字一致：`<skill name="..." location="...">\nReferences are relative to ${baseDir}.\n\n${body}\n</skill>`（body = SKILL.md 全文剥 frontmatter 后 trim；**baseDir = `dirname(SKILL.md path)`**，对齐 pi 实装 `skill.baseDir`，不取 `sourceInfo.baseDir`——见 §5 检查点 1 实施定案）。**R4 起 block 不再原位替换正文**：全部展开 block 集中在消息末尾的 `<taiji-skill-data>` 包裹块内（形态与去重规则见 D11），正文标记原样保留。`stripFrontmatter` 剥离逻辑与 pi `dist/utils/frontmatter.js` 逐字镜像（实施修订：pi 包 exports 白名单仅 `.`/`./rpc-entry`/`./client`，深路径 import 被拦、包根 import 会将 TUI/WASM 静态依赖拖进 tsup bundle——镜像的漂移风险由下方探针守卫兜住）。
- **守卫**：PS-24 探针（实施落点：runtime REAL_PI vitest 池 `pi-semantics-skill-expansion-golden.test.ts`，登记于 `docs/pi-semantics.json`；`REAL_PI_READY` 门控，无凭证环境自动 skip——CI 拦截能力以 REAL_PI 池为界）——起真实 pi RPC 进程，发 `/skill:name` prompt，读 JSONL 落盘文本，与 taiji 展开器同输入输出做 golden diff。pi 升级若改格式（如 tag 结构、References 行），探针红。R4 核对：探针 golden diff 的锚定对象是单个 `<skill>` block 内容（不变）；整条消息形态断言（若有）随 D11 更新为「标记保留 + 末尾块」。
- **被否**：自造注入格式（如 markdown 代码块包裹）——与 pi 会话格式割裂，探针无法对齐。
- **证据**：pi `agent-session.js:983-1007`（格式模板）、`utils/frontmatter.js` 导出。
- **效果**：G5 的「零侵入」与长期防漂移；格式一致保证块内 block 与 pi 原生展开可互换理解。R4 代价变更：原「整条消息 = 单个 skill block」在 pi TUI 可折叠渲染的形态不再产生（所有消息 = 正文 + 末尾块混排，pi TUI 显示 XML 原文——§3.5-④ 登记更新）。

**D6：预算预检——CJK 感知字符估算 + 80% contextWindow 阈值 + 整条降级（选定）**
- **采用**：runtime 展开前预估「展开后整条 message 的字符数」（正文 + 各 skill 全文 + 标记/分隔开销），token 估算用 **CJK 感知公式：`CJK 字符数 × 1.0 + 非 CJK 字符数 ÷ 4`**（一个正则数 CJK 字符即可，不引入 tokenizer 依赖）。**B2 修订（adversarial-review-fixes §3.3 B2）**：代码密集文本（非 CJK 占比 > 0.7）的非 CJK 分母收紧为 ÷3（`NON_CJK_CHARS_PER_TOKEN=4` / `CODE_DENSE_NON_CJK_CHARS_PER_TOKEN=3`，实装于 skill-marker.ts estimateTokens），防止代码密集 SKILL.md 低估 1~2 倍放行全文注入。依据：现代 tokenizer 中文实际密度约 0.6~1 token/char（CJK 按 1.0 取区间上界，**保守方向 = 高估 token = 更早降级**）；英文约 4 chars/token（÷4 为准确值）。阈值：**预估 token > 0.8 × contextWindow**（contextWindow 发送时经 RPC `get_session_stats` 的 `contextUsage.contextWindow` 实时取）→ **整条消息降级**（D7 标记模式）。阈值与系数定义为常量（单一处，便于调参）。
- **等效阈值推演**：英文内容 ÷4 准确 → 实际触发点 ≈ 80% 窗口；中文内容估算取上界 → 实际触发点在 48%~80% 窗口之间（密度越接近 1 token/char 越贴近 80%）。即中文场景可能**提早**降级、不会推迟——方向安全。**推演边界**：代码密集的非 CJK 内容（base64、长标识符等，实际 0.3~0.5 token/char）按 ÷4 低估 1~2 倍且无 CJK 上界富余缓冲——此类 SKILL.md（如含大段代码块的）是估算最弱面，由检查点 6 的代码密集型样本校准覆盖。CJK 字符类定义：CJK 统一表意文字及常用全角标点范围（实施时用一个明确的 Unicode 区间正则，与探针同源定义）。
- **漏判-兜底关系（诚实声明）**：估算非精确计量，仍存在漏判可能（如中英混排密度异常、contextWindow 元数据虚标）。漏判时 pi overflow 报错链仍然存在（用户可见错误 + 一次 compact-and-retry），预检目标是**拦住大概率超窗的注入**而非精确计量；真实死亡尺寸（单条 ≥ 20000 token 切点保护线）由 CJK 上界估算覆盖（20000 真实 token 的中文内容按 1.0 密度估算 = 20000，不会被漏判到放行程度）。
- **为什么只看单条消息自身大小、不叠加会话历史占用**：历史占用超阈由 pi 的 threshold compaction 在提交前/每轮前处理（`agent-session.js:893-896`、`:274-287`）——历史是**挤得动**的；而单条 ≥ keepRecentTokens(20000) 的消息受切点算法保护**永远挤不掉**（§2.3 失败模式 C 第 3 步）。所以历史归 pi 已有机制，单条消息自身大小才是本设计必须拦的量。
- **为什么一刀切整条降级、不做逐 skill 贪心**：贪心（选择序展开、预算耗尽后剩余降级）会产生「部分全文 + 部分标记」混合态——模型看到两种注入形态、用户难以感知哪些生效，验证复杂度高；一刀切行为可预测（要么全展开要么全标记）。减法原则。
- **失败安全（fail-safe，修订）**：contextWindow 实时获取失败（RPC 错误）时**降级为标记模式**。——被否：fail-open（获取失败照常全文注入）——`get_session_stats` 失败本身预示 pi RPC 异常（后续 prompt 大概率同样失败），此时放行的大消息若真发出并超窗，落入 §2.3 失败模式 C 的持续失败态（会话报废），与 G3 直接矛盾；fail-safe 的代价只是功能减弱一轮（标记模式 skill 仍可用），方向安全。
- **被否**：拒绝发送（硬拦截）——用户被拦后无法表达意图，降级（标记模式）让消息仍可发且 skill 仍可用，是更软的安全路径。
- **证据**：`compaction.js:308-352`（切点盲区，已亲自复核）、`agent-session.js:893-896`（threshold compaction 时机）、pi `estimateTokens` chars/4（`compaction.js:188-226`，对中文低估 2~4 倍故不可照抄）。
- **效果**：G3 成立（§3.1 场景 2）。

**D7：降级标记形态与 resume 反渲染（选定；R4 修订：降级块并入 `<taiji-skill-data>`，反渲染升级为三形态 + 剥块优先规则）**
- **采用**：降级时 prompt 里的形态（见 §3.1 场景 2，R4 起与正常形态共用同一 `<taiji-skill-data>` 包裹，旧 `<taiji-skills>` tag 退役但反解析保留识别以兼容存量落盘消息）：所有 chip 标记归拢在包裹块内（每项 `<taiji-skill name location/>` 自闭合）+ 一行指引文本「Use the read tool to load the skill files above before continuing the task」（定稿时为中文「请使用 read 工具加载上述 skill 文件后再继续任务」，C5——adversarial-review-fixes §3.4——改英文对齐 pi available_skills 措辞）。归拢成块（而非散在原位）理由：降级形态只需模型理解一次，块状 + 单指引行的指令遵循率高于散点。
- **resume 反渲染多通道**：
  - **主通道（已有，零新增）**：`segments.json` sidecar + `<!--taiji:msg:<uuid>-->` 标记机制按 clientUuid 恢复 Segment[]（`history-rebuild-cache.ts:233`），chip badge 显示不受 JSONL 文本形态影响。展开态/降级态都走这条。
  - **兜底通道（新增，实现位置 = core 转换 SSOT）**：sidecar 丢失/旧版本会话时，**`packages/core/src/domain/chat/apply-entry-convert.ts` 的反解析升级为三形态，按优先序处理**（R4）：① **剥块（最高优先，新增）**——任意位置匹配 `<taiji-skill-data>...</taiji-skill-data>` 整块剔除，块内内容整体丢弃、不参与后续标记解析（块是注入器产物非用户内容）；任意位置而非仅末尾：防御 hook 改写/复述把块挪位，规则更鲁棒；② **标记还原**——全局匹配 `<taiji-skill name="..." location="..."/>`（与降级清单项同语法形态；R4 起块内清单项随 ① 剥除、不经 ② 还原）还原为 skill segment；③ **存量形态兼容（保留）**——`<skill name="..." location="...">…</skill>` block（pi 原生 + 升级前旧展开形态）与 `<taiji-skills>` 降级块（升级前落盘）的原有反解析规则不变，产出交错 `text + skill + text + …` segments。该函数是三条链路共用的转换 SSOT（① live `message_end(user)` 帧喂 reducer，② runtime 历史重建 `convertPiHistory`，③ 文件重放），在此一处升级即全覆盖。现状「block 前后正文保留」已实现（历史轮已修复前置正文丢失缺陷），存量行为不变。
  - **兜底已知边界**：SKILL.md 正文含 `</skill>` 字面量时非贪婪正则截断误还原——与 pi 原生 `parseSkillBlock` 同款局限（对齐 pi 可接受），且仅 sidecar 未命中时启用；正文手打 `<taiji-skill` 字样且 sidecar 同时丢失时误还原为 chip——四要素登记于 §3.5-③。另：反解析为**全局匹配**，用户正文手打 `<skill` 字样（pi tag 前缀）的误匹配面从「仅消息第一个」扩大到「任意位置」——与 `<taiji-skill` 同属手打机器标记前缀的极低概率场景，同 §3.5-③ 判定可接受；R4 新增同族项：手打完整 `<taiji-skill-data>` 块形态字样且 sidecar 丢失时被误剥（§3.5-⑥ 合并登记）；**存量兼容**：pi 原生格式消息（block 前置 + args 在后）反解析产出 `[skill, args-text]` segments，与既有行为等价（回归断言见场景 4⑤）。
- **效果**：G4 成立（§3.1 场景 1/2 的「仍显示为 chip badge」，验收场景 4 含正文保留断言）；R4 附加收益：复制/编辑重发的 normalizeContent 投影恒为「正文占位形态」（不含全文/块）。

**D8：skill 失效降级必须前端可见（选定）**
- **采用**：runtime 展开器对「name 在权威映射（D7 切源后 = SkillRegistry 扫描，原 get_commands）无映射」或「SKILL.md 读取失败」或「`<taiji-skill/>` 标记被 BeforeSend hook 改写破坏至不可解析」的标记：**原样保留**（对齐 pi 的透传行为），同时经现有 runtime → renderer 广播通道发一条消息级提示（renderer 以 toast + 消息内联提示呈现）。禁止静默——静默降级会让用户以为 skill 生效。
- **检测域边界（R4 补登）**：D8 的残缺扫描发生在 runtime 注入器发送前，只覆盖 BeforeSend hook 及之前的改写；**pi 侧 `input` hook 在注入器之后运行**（client.prompt 进入 pi 后触发），其改写破坏标记/块时无检测点、无提示，静默进入 LLM 上下文——不新增机制，依赖 hook 自律（仓内现仅 msg-id-mapper 使用 input hook 且只剥 u- 注释不触碰标记；第三方 extension 为真实暴露面，登记为已知边界）。
- **被否**：整条消息拒绝发送——单个 skill 失效不该阻断整条消息的表达。
- **证据**：pi 对未知 skill 原样透传（`agent-session.js:989-991`）——行为对齐。
- **效果**：§3.1 场景 3。

**D9：四条发送路径统一收敛 + hook 顺序（选定）**
- **采用**：runtime 新增单一展开函数（注入模块），`message-dispatcher.ts` 的三个入口——`sendPrompt`（:79-149，普通发送/landing 首条最终都汇入）、`steerMessage`（:522）、`followUpMessage`（:527）——在把文本交给 `client.prompt/steer/followUp` 之前**统一调用**。
- **挂载顺序（明确）**：注入器挂在 **BeforeSend hook 之后、`client.prompt` 之前**——plugin hook 审核的是用户原文（含标记，语义为「用户提交了什么」），注入器处理 hook 改写后的文本；hook 改写若破坏标记完整性，走 D8 透传+提示（标记残缺不展开、不静默丢内容）。
- **幂等（结构化保证）**：每条消息仅过一次注入器，由 dispatcher 调用点保证（sendPrompt/steerMessage/followUpMessage 各自单次调用）；**不做文本级幂等检测**（grep「已展开否」会被用户正文手打 `<taiji-skill` 字样欺骗而误跳过真实 chip）。
- **被否**：只改 sendPrompt——steer/followUp 场景（busy 补充 skill）注入失效，G2 不完整。
- **证据**：`message-dispatcher.ts:522-529`（steer/followUp 不走 sendPrompt 骨架，需各自挂载）、`:84-137`（hook 先于 client.prompt 的现有顺序）。
- **效果**：§3.1 场景 4。

**D10：runtime readline 分帧防御顺手修（选定）**
- **采用**：`rpc-client.ts:323-324` 的 node `readline` 替换为 pi 同款 LF-only 行读取器（自实现 buffer 累加分帧，或逐字节扫描 `\n`）。本设计大量注入 skill 全文后 pi → runtime 方向大文本回显流量上升，既有隐患敞口变大，随本 feature 一并修。
- **证据**：pi `rpc/jsonl.js:13-17` 注释明确 readline 按 Unicode 分隔符分帧的坑；runtime `rpc-client.ts:323` 现用 readline。
- **效果**：消除大文本注入后的坏帧风险（验收场景 9，含新旧实现对照组）。**已实施**（rpc-client.ts 现为 LF-only 读取器；场景 9 的「新旧对照组」仅存于该次实施的历史验证）。

**D11：注入形态——正文保留占位 + 末尾集中追加 `<taiji-skill-data>` 包裹块（R4 新增，选定）**
- **采用**：正文中的 `<taiji-skill/>` 标记**原样保留**（不再原位替换展开）；全部展开内容集中追加在消息末尾的 `<taiji-skill-data>` 包裹块内（块与正文以空行分隔），两种内容形态：
  - **正常形态（预算内）**：块内为去重后的 `<skill name location>全文</skill>` 列表（展开格式仍遵 D5 与 pi 逐字对齐）；
  - **降级形态（超预算/fail-safe，原 D7 降级块统一并入）**：块内为 `<taiji-skill/>` 标记清单 + 指引行（原 `<taiji-skills>` 块内容整体搬入，旧 tag 退役）。
  - 失效标记（无映射/读取失败/hook 破坏）不进块：正文原样保留 + notice（D8 行为不变）；映射源整体失败（registry 扫描异常 / 晚绑定未绑定，mapping_unavailable；原 get_commands RPC 失败同 reason）同理：正文留标记、不追加块。
- **裁决理由**：① 正文可读性——原位展开把 SKILL.md 全文（最坏 50KB）嵌进句子中间，模型与人都难读；占位保留后句子完整，展开集中尾部；② 显示/数据面干净——反解析从「把 block 从正文中间挖出来」变为「剥尾部一整块 + 正文标记还原 badge」，复制消息（normalizeContent）恒为占位形态，编辑重发草稿不可见全文；③ 降级统一——原降级形态（标记 + 块）与正常形态同构，两 tag 合一后反解析规则从「形态分叉」收敛为「先剥块、再认标记」；④ 多轮上下文中后续 turn 引用「某条消息的 skill」时正文位置稳定。
- **同 name 去重**：块内每个 name 只展开一次（按标记出现序首个归并，notice 不发）。UI 层 D2 已禁选同 skill，此处兜底手打/编辑重发路径；重复全文纯浪费上下文。**数据源澄清**：块内 `<skill>` 的 location **与降级清单条目的 location 均恒取 SkillRegistry 权威扫描的 `sourcePath`**（D4 修订后权威源；「与 pi 逐字对齐」约束的是展开格式而非数据源；标记自带 location 若过时——skill 移动后——不得作为权威 read 路径进入块/清单，否则模型按过时路径 read）；去重归并判定仅按 `name`（不读标记自带 location）；标记自带 location 仅作反解析自描述，非权威数据源。
- **落盘末尾性依赖声明**：useChat 在注入前已于文本尾追加 `<!--taiji:msg:u-…-->` 标记，注入块实际拼接在该注释之后；「真末尾」由 pi 侧 msg-id-mapper input hook 剥除注释实现——该 extension 自身降级（hook 错误标记存活）时落盘为「注释 + 块」，反解析剥块按任意位置匹配不受影响。
- **LLM 关联指引：正常形态不加文本内指引行（选定）**。理由：对齐信号完备——正文标记带 `name`、块内每个 `<skill>` 也带同名 `name`，citation/脚注模式主流 coding 模型可建立映射；块 tag 名语义化。**观察点**：若实测弱模型漏读末尾块（回答未体现 skill 内容），补救路径 = system-prompt extension 经 hook 注入提示词（一处生效全 session，不污染消息文本）；不回退到文本内指引行。降级形态保留指引行（该形态下 read 是唯一获取通道，指引是必要指令非冗余）。
- **被否**：① 维持原位展开——裁决理由 ①②③ 全部反向；② 展开块紧跟各标记后方内联——可读性问题与原位展开等价，只是换个包裹；③ 新降级 tag 与新块并存——同构形态双 tag 徒增反解析与文档分叉；④ **复用既有 `<taiji-skills>` 作统一包裹 tag**——基础设施虽现成（`buildSkillsFallbackBlock`/`parseSkillsFallbackBlocks` 已实装），但 tag 名是 LLM 可读协议面：`taiji-skills`（清单语义）承载全文块语义 stretch，`taiji-skill-data` 对模型的「数据附挂区」语义传达更准；且存量降级块消息与 R4 新形态消息靠 tag 名即可自识别（诊断/测试断言友好），复用则须解析块内子项形态才能区分新旧——概念净增 1 个 tag 换取协议面语义精度与新旧自识别，判定值得。
- **效果**：正文可读；resume/复制/编辑重发数据面干净；降级/正常统一包裹。验收场景 1②/2①/4 形态断言随本决策更新。

**D12：用户气泡混排内联渲染（R4 新增，选定——修复 badge 前后换行）**
- **现状缺陷**：`UserBubble.vue` 渲染循环中 badge（skill/file/session/subagent）与非 text 段（slash 文本还原、image 缩略图）均为 inline 形态，但 text 段经 `MarkdownRenderer` 渲染为**块级**（根元素 `<div class="md-render">` + markdown-it 包裹的块级 `<p>`）——badge 前后任意一侧存在 text 段时该侧必然换行（块级边界），`[text, skill, text]` 段序下 badge 单独占一行。live 与 reload 两侧同构（共用 UserBubble），发送后立即可见。
- **采用**：气泡同时含 text 段与非 text 段（badge/slash/image——实现按非 text 段统一判定，一致性审查登记的扩面）时，给气泡内容容器启用 inline 化修饰 class，scoped CSS 将 `.md-render`、其内部段容器与 `p` 置为 `display:inline`，段落间换行以 `p + p::before { content: "\a"; white-space: pre }` 类手法补偿；纯 text 消息（无 badge）不加 class，复杂 markdown（标题/列表/表格/代码块）排版完全不受影响。
- **已接受代价（四要素）**：混排消息的 text 段含复杂块级 markdown 时排版退化为 inline 流。**量级**：混排场景的 text 段以短句为主（badge 是句中引用形态）；**恢复路径**：不适用（显示形态，非内容损伤）；**重审条件**：用户反馈混排消息代码块/列表显示异常；**判定**：可接受。
- **被否**：text 段弃用 MarkdownRenderer 改轻量 inline 渲染器——等于产品决策「用户气泡非 markdown」，影响面大（现有用例断言 + live ≡ reload 等价性重验），收益不明确。
- **效果**：混排消息 badge 与正文同行（验收场景 10）。

**D13：composer skill chip 前后自动空开（R4 新增，选定）**
- **现状缺陷**：`insertChipAtSelection` 落 chip 后仅插 ZWSP（不可见光标锚点）+ `.slash-chip` 仅有 `margin-right: 4px` 单侧间距；chip 前侧无任何间距处理——触发路径（空格 + `/`）靠清 query 后的前置空格，非触发路径（+ 菜单/搜索注入/landing）chip 紧贴前文。
- **采用**：CSS 单点——`.composer-input :deep(.slash-chip[data-chip-type='skill'])` 增加 `margin-left: 4px`、`margin-right` 提至 6px；行首缩进抑制用 `.composer-input :deep(.slash-chip[data-chip-type='skill']:first-child) { margin-left: 0 }`（scoped CSS 下 :deep() 后代形式，与实现一致；「行首」= DOM 首子节点语义）。纯视觉零数据污染：ZWSP spacer 契约（`isSpacerNode`/Backspace 删 chip 通路）不动，序列化层 `needsBoundarySpace` 的空格补齐逻辑不变。
- **被否**：插入时补真实空格文本节点——DOM 文本污染 + Backspace 联动复杂化 + 与序列化层空格规则双重维护，纯视觉诉求不值得数据层改动。
- **范围**：仅 skill chip（用户报告面）；file/session/subagent chip 的同类间距问题不在本批（后续统一时另行评估）。
- **效果**：composer 中 skill 占位前后各空开约一个空格宽（验收场景 11）。

### 3.4 错误规格表

| 错误场景 | 行为 | 恢复指引 |
|---|---|---|
| skill name 无映射（已卸载/未装） | 该标记原样透传（不进末尾块）+ 前端 toast + 消息内联提示 | 重装 skill 或删除该 chip 重发 |
| SKILL.md 读取失败（权限/损坏） | 同上（透传 + 可见提示） | 检查文件权限；runtime 日志在 `<getDataDir>/logs/`（架构约定，非 `~/.pi/agent/logs/`） |
| `<taiji-skill/>` 标记被 BeforeSend hook 改写破坏 | 标记残缺不展开，原样透传 + 可见提示 | 检查 plugin 的 BeforeSend hook 是否改写了消息文本。**边界**：pi 侧 `input` hook（注入后运行）改写破坏标记时无检测点（D8 检测域声明） |
| 映射源不可用（SkillRegistry 扫描异常 / 晚绑定未绑定；原 get_commands RPC 失败同 reason，实施期补充） | 全部标记原样透传、不追加末尾块（展开与降级清单的 location 数据源均缺失）+ 可见提示；reason=`mapping_unavailable` | 无需恢复；扫描恢复（含 5min 兜底重扫自愈）后下一条消息自动恢复注入。watcher 熔断期存在陈旧窗口（窗口内新增 skill 可能 `skill_missing`），窗口 ≤ 兜底周期且不劣于原快照形态（skill-reload-nondestructive D7 陈旧窗口语义） |
| contextWindow 获取失败（get_session_stats RPC 错误） | fail-safe：降级形态（`<taiji-skill-data>` 内标记清单 + 指引行，D11） | 无需恢复；RPC 恢复后下一条消息自动回到全文注入 |
| 展开后超窗且降级后仍超窗（正文自身巨大） | 正常发送（降级已最小化注入量）；若真超窗，pi overflow 报错 + 一次 compact-and-retry | 发送前预防：缩短正文 / 减 skill；**发送后救援**（§2.3 失败模式 C）：fork 到该消息之前 / 换大窗口模型 / 新 session——巨大消息无法被 compaction 挤掉，会话内无法自愈 |
| sidecar 丢失 | 兜底反解析：先剥 `<taiji-skill-data>` 块、再认正文标记还原 chip（含正文保留，D7） | 无需恢复；兜底也失败则该消息显示纯文本（与现状行为一致） |

### 3.5 影响面与已接受代价（四要素登记）

① **store 去重第三判据失配面扩大（P0-12 登记；R4 修正机制描述）**。`packages/core/src/domain/chat/store.ts` 的 `mergeBaselineWithLive` 第三判据（user 文本多重集）实际比较的是**两侧投影**（`userMessageText`：基线 Array content 走 segmentsToText）——sidecar 命中消息的基线 content 已被 backfillSegments 换回原始 Segment[]，与 live 侧同源**命中**（不双计）；真实失配域 = sidecar 丢失的兜底路径（反解析产物与提交文本存在剥块残留分隔空白等字节差）。store.ts 注释中「pi 文本 ≡ 提交文本」为过时前提（实施期同批更正）。改造后含 skill chip 消息的兜底反解析产物 ≠ 提交文本，判据在该域失配落回「身份+数量对齐」——**现状已存在同类失配**（行首 skill chip 消息，注释明示「skill 展开消息自然失配 → 落回现状」），本设计将触发面从边缘形态扩到主用例。**量级**：仅在 F2 竞态窗口（切入 session 时 getHistory 快照与 live 帧流时序差 + 基线尾部为 assistant）且 sidecar 丢失时短暂双计（badge 版 + 纯文本版各一条）；**恢复路径**：下一轮 reconcile 自动收敛（现状机制，非新增）；**重审条件**：若实跑出现可见双计未收敛，评估归一比对（兜底产物归拢回标记形态再比对）；**判定**：可接受（现状同类边界先例 `store.ts:128-130`）。**R4 注记**：末尾块协议下 pi 落盘文本 = 标记正文 + 末尾展开块，仍 ≠ 提交文本（标记正文），失配面与结论不变。

② **宿主 JSONL 写入量级与跨消息累积（P0-19 登记）**。**量级**：本机实测 SKILL.md 体量 0.9KB~50KB，单条消息注入 N 个 skill = 追加 N×全文；同一 skill 跨消息重复注入**单调累积**（每条挂该 skill 的消息都注入一份全文进历史，每轮请求上下文含全部历史副本），token 成本线性增长（prompt cache 命中时增量主要是 cache read）。**清理通道**：pi compaction 会把旧 skill block 摘掉（普通 skill < 20000 token 不受切点保护，可被摘要——与单条巨大消息的盲区不同）；单条超窗由 D6 预检拦截。**控制旋钮**：单消息内 chip 去重（D2）；跨消息**显式不做去重**——重复插入是用户的显式强调意图，自动跳过会静默违背意图。**重审条件**：用户反馈成本异常时评估跨消息引用提升（如上下文已有同 skill 全文时第二条起降级为标记）。**判定**：可接受。连带：steer 队列回显（`queue_update` 帧的 queuedMessages 全文数组）随注入量膨胀——内存帧不落盘，量级与消息体积同阶，可接受。**R4 补登显示投影**：steer/followUp 入队前已完成注入，QueueBubble 对快照仅剥 defer 标记，skill 标记与包裹块以单行 truncate 原样可见（存量行为非 R4 新增；单行 truncate 天然缓解；重审条件 = 用户反馈排队气泡可读性，届时 QueueBubble 复用反解析投影剥块/还原短标记）。

③ **兜底误还原（D7 边界四要素）**。正文手打 `<taiji-skill` 字样 + 该消息 sidecar 同时丢失时，兜底反解析把手打字样误还原为 chip。**量级**：联合概率极低（需用户精确打出机器标记前缀，且 sidecar 丢失——sidecar 丢失率无历史数据，实施期可经日志观测）；**恢复路径**：不可恢复——偏差**仅限显示层消费**（badge 显示的 name/location 可辨识，pi 已落盘的实际内容不变）；**注意**：若误还原 segment 经编辑重发（§3.5-⑤② 的 draftText 回填路径），序列化回标记 → 注入器真展开，偏差会升级为语义改变——该升级路径只能由 ⑤② 的完整优化项（编辑重发从 Segment[] 重建 chip 而非文本回填）消除（该优化项经评估延期未实施，升级路径仍开放，重审条件不变）；design-code-sync 轮 3（2026-09-10）已单独消除同一路径上的**标记翻倍/重复注入**形态（编辑重发重建时剥离编辑稿里与保留段重复的序列化文本，见 ⑤②），但「误还原 → 真展开」的语义升级本身不受该修复影响；**重审条件**：观测到实际误还原案例时，改用更强唯一性标记（如 name+location+短校验和三属性）；**判定**：可接受（编辑重发升级路径为已登记的低频残余风险，处置见 ⑤②）。

④ **pi TUI 打开混排消息显示 XML 原文（P0-19 登记）**。**量级**：仅 pi CLI 用户打开 taiji 会话时可见（taiji 用户不经过 pi TUI）；**恢复路径**：不适用（显示形态差异，非功能损伤——模型收到的内容一致）；**重审条件**：pi 上游 `parseSkillBlock` 支持混排时自动消除；**判定**：可接受。**R4 更新**：末尾块协议下所有消息均为「正文 + 末尾块」混排形态，原「整条 = 单 block」的折叠渲染形态不再产生——taiji 用户不经 pi TUI，实际影响面不变。

⑤ **`normalizeContent` 纯文本投影面（P0-12 登记）**。`segmentsToText` 注释标明其双用途（「归一化展示用 + pi prompt 序列化唯一实现」），skill 分支改产标记后，展示类消费方看到 `<taiji-skill .../>` 而非 `/skill:name`：复制消息（气泡复制动作 `copy(normalizeContent(...))`）——非自然语言形态变化，可接受；**composer ↑/↓ 输入历史召回（R4 补登）**——`composer-shell.ts` 的 `deriveHistoryFromChatStore` 以 normalizeContent 派生历史条目，召回含 chip 消息时 composer 回填标记原文（非 chip），与编辑重发草稿回填同族（视觉退化、重发后注入器仍生效），按原样接受；重审条件 = 用户反馈召回体验，届时在 deriveHistoryFromChatStore 做标记→可读短形投影；**编辑重发草稿回填**（`UserBubble.startEdit` 的 `draftText = normalizeContent(content)`）——旧消息重发时 composer 显示标记文本而非 chip（视觉退化，按原样接受；重发后 runtime 再展开仍生效）。**[轮 3 收口 · 2026-09-10] 该路径的真实缺陷不是「仅视觉退化」**：提交时编辑稿整串回灌首个 text 段、非 text 段原位保留，任何「序列化形态出现在文本里」的段都会翻倍——`[skill('review'), text('正文')]` → 草稿 `<taiji-skill name="review"/> 正文` → 重建产物序列化出**两个** `<taiji-skill>` 标记 → runtime 注入器按标记逐个展开 ⇒ **同一 SKILL.md 注入两遍**（上下文浪费，且违反 §3.5-② 的单消息内 chip 去重意图）；file/mention/session/handoff 同族翻倍（探针实测，回归锁见 `packages/ui/src/lib/__tests__/segment-rebuild.test.ts` 与 `packages/ui/src/features/chat/__tests__/UserBubble.test.ts`）。已由 `packages/ui/src/lib/segment-rebuild.ts` 的「编辑稿中与保留段重复的序列化文本剥离」收口（skill 用 `buildSkillMarker` SSOT 输出精确匹配；剥离不到即丢弃该段、以文本形态随 prompt 进入——与 slash 段同款「剥离/丢弃」规则；slash 的前缀剥离口径由轮 3 的编辑重发修复（2026-09-10 同批）确立，本收口项未改动 slash 行为）。**image 段（未修项清零轮已修，2026-09-10）**：修复前两个方向均实测复现：① **翻倍**——`[image('/data/a/1.png'), text('正文')]` 编辑重发后 prompt = `\n/data/a/1.png\n/data/a/1.png\n正文`，同一路径出现两次（与上段 skill 同因）；② **删除后路径复活**——用户把编辑稿里的 `/data/a/1.png` 删掉后 prompt 仍为 `\n/data/a/1.png\n正文`（image 段恒保留、不参与剥离）。根因：image 的序列化单元是换行定界的裸路径 `\n<path>\n`，而 `UserBubble.submitEdit` 的 `draftText.trim()` 会吃掉**草稿首尾**的换行（链路：`normalizeContent` → `draftText.trim()` → `rebuildSegmentsWithEditedText` → `segmentsToPrompt`）——**位于草稿首/末位**的 image 其序列化串被 trim 破坏、精确匹配不命中；**居中位置**不受 trim 影响（如 `[text('正文'), image, text('尾部')]` → 草稿 `正文\n<path>\n尾部`，序列化串完整存在 ⇒ 精确匹配会命中），故「精确匹配不可靠」只对首/末位成立，不能一般化为「恒不命中」。**落地修法（行为层）= 裸路径 token 双侧边界匹配 + 剥掉整个 image 序列化单元（路径 + 紧邻换行）+ 未命中即丢弃段**（`packages/ui/src/lib/segment-rebuild.ts`）：前边界（串首或空白）与后边界（串尾或空白）双判定，防 `x/data/a/1.png`、`/data/a/1.png2` 前缀误配；命中 ⇒ 剥掉整个序列化单元（路径连同其紧邻换行，存在才剥、不存在不剥），段保留（序列化后路径只出现一次，①关闭）；未命中 ⇒ 丢弃段（语义 = 用户删掉了该路径，②关闭）。**轮 5 由「只剥裸路径 token」收敛为「剥掉整个序列化单元」**——只剥裸 token 会把路径前后的换行留在文本里，重建时 image 段再补一遍 `\n<path>\n`，未编辑草稿重发**每轮净增一个换行（无界累积，轮 4 遗留项）**；剥掉整单元后该累积关闭。**当前行为边界**：image 居首/居末时编辑重发**幂等**（重建产物与草稿逐字相等）；image 居中时仍受「首个 text 段承接全部正文、chip 位置不动」的既有位置近似影响（round0 与草稿不等，但 round1 = round2 收敛、不累积）——属设计 D6 已登记的可接受项。回归锁见 `packages/ui/src/lib/__tests__/segment-rebuild.test.ts` 与 `packages/ui/src/features/chat/__tests__/UserBubble.test.ts`（**用例数以文件实际为准**，轮 5 该文件用例数再增）。**被否变体（历史）**：序列化串精确匹配 + 匹配不到即丢弃——对**位于草稿首/末位**的 image，`\n<path>\n` 在 `trim()` 后的编辑稿中必不命中（trim 只吃草稿首尾，居中位置不受影响）⇒ 段被丢弃而路径文本仍在，prompt 首行变 `/data/...` 且失去段自带的起首换行，pi 不 trim ⇒ 被当行首命令的风险从「无」变「有」，比翻倍更糟，故对该场景不采纳（该方案覆盖不了首/末位，整体不采纳；「比翻倍更糟」的结论仅在首/末位场景成立，居中位置本可命中、不构成否决理由）。完整的「从原消息 Segment[] 重建 chip 而非文本回填」优化项仍经评估延期未实施——草稿仍显示标记文本这一视觉退化按原样接受；重审条件=用户反馈编辑重发体验；会话摘要/标题（`summarize-turn.ts:21`）、系统通知（`notify-toast.ts:56`）——短标记进摘要 prompt/通知文案，可接受；滚动跟随的末条文本长度观察（现行 `useMessageStreamFollowTriggers.ts` 的 normalizeContent 长度 watch，2026-09 chat-pin-bottom-fix 自已删除的 useMessageStreamScroll 迁入）——无影响。**判定**：①③④可接受，②视觉退化按原样接受（标记翻倍已由 `segment-rebuild.ts` 的序列化剥离消除；image 段的两方向已于未修项清零轮（2026-09-10）修复、其轮 4 遗留的「每轮 +1 换行累积」由轮 5 关闭——命中 ⇒ 剥掉整个序列化单元并保留段、未命中 ⇒ 丢弃段，见上），「从 Segment[] 重建 chip 而非文本回填」的完整优化项仍经评估延期未实施（不阻塞主链路，处置见上）。

⑥ **SKILL.md 自含标记逃逸（2026-09-07 登记，adversarial-review-fixes MS-8 维持）**。SKILL.md 正文自身含字面标记形态（`<skill>` / `<taiji-skill` / `<taiji-skills>` 字样，如写注入格式文档的 skill）经全文注入后进入消息文本，可能形成嵌套块/伪块形态。**量级**：现产线解析器按「嵌套块不在生产形态中」假设处理（`skill-marker.ts` 降级块正则非贪婪取首个闭合标签；`<skill>` 展开块按 pi 原生形态解析）——自含标记只出现在块内正文时被当普通文本保留，不误剥离/误还原；仅在自含形态恰好构成完整可解析块且位于反解析扫描路径（sidecar 丢失的兜底反解析 / message-converter parse）时才可能被误识别为额外 chip。**R4 扩面**：① `<taiji-skill-data>` 块内为 SKILL.md 全文，正文若含 `</taiji-skill-data>` 字样会把块提前闭合（非贪婪截断）——截断后残留内容落入后续标记解析，可能误还原；② 正文手打完整 `<taiji-skill-data>...</taiji-skill-data>` 字样且 sidecar 丢失时整块被误剥（用户文字丢失于显示层，pi 落盘原文不变）；③ **注入器侧（与 ③「手打完整标记 → 真展开」同族）**：手打/粘贴的完整块内标记会被注入器 parseSkillMarkers 全局匹配逐个真展开（注入器不识别块边界）——显示侧误剥与注入侧真展开是同一手打行为的两侧，均已登记。**恢复路径**：偏差仅限显示层（badge 多还原/少还原），pi 已落盘的实际内容不变。**重审条件**：出现 SKILL.md 实际含标记字样的 skill（作者在正文写注入格式示例）且反解析误命中时，评估展开时对 SKILL.md 正文内的标记形态做转义或剥离。**判定**：可接受（联合概率极低，与 ③ 手打字样同族；R4 扩面两项同判定——① 需 SKILL.md 作者精确写出闭合 tag 字样，② 需用户手打完整机器块形态且 sidecar 同时丢失）。

⑦ **subagent/landing 出站注入的预算近似与 encode 膨胀（2026-09-07 登记，指针——裁决与论证 SSOT 在 [adversarial-review-fixes.md](adversarial-review-fixes.md) D-A2-4）**。①注入预算 80% 阈值按主 session contextWindow 计算，subagent / 新 session 实际窗口可能更小——阈值偏松，pi 侧既有上下文裁剪兜底（v1 已知近似，维持）；②注入产物（≤50KB 全文）经 `encodeDirectiveText`（反斜杠翻倍 + 换行转义）后命令长度膨胀，代码密集 SKILL.md 最坏接近翻倍（~100KB 命令串）——pi CLI 单命令长度上限的探针确认（adversarial-review-fixes §5 检查点④）截至 u2 落地尚未回填结论；超限兜底 = 降级块先行（降级块 <1KB 无膨胀问题），出现单命令超长报错即按该检查点处置。

⑧ **历史读取链路字节预算耦合（R4 新增登记）**。注入块使含 chip 消息的落盘体积膨胀（单 skill 最大 50KB），三级读取面随之变化：getHistory 双预算窗口按 turn 字节选窗（HISTORY_BUDGET 640KB / 20 turns）→ skill 重度会话更早触发 truncated、「加载更早」翻页增多；get_entries 全量重建 reply 体积增大；离线尾读分块扩窗同源预算。**量级**：per-turn 字节与注入量同阶；**恢复路径**：翻页/优雅降级（truncated 置位，非正确性问题）；**重审条件**：用户反馈历史加载频繁截断——2026-09-19 已触发（归因不是 skill 注入：重 agent 会话实测 7 轮 3.5MB、单轮均 500KB，640KB 预算窗口只剩 1 轮），处置为触顶自动续载（renderer `useLoadMoreHistory.onScrollOffset`，预算常量未动），本项的注入膨胀耦合维持可接受；**判定**：可接受。

---

## 4. 验收

以下场景全部用**真实 pi 进程 + 真实模型**验证（`pi --mode rpc` 起 dev 实例，或 taiji dev app 连真实 runtime），非单测非 mock。每个场景标注回溯的 §1 目标。

**场景 1：任意位置多 skill 注入生效（回溯 G1/G2/G5）**
- 步骤：在 dev app 的 composer 输入正文 `帮我 review 这段代码`，空格后键入 `/rev` 从浮层选中 `code-review-graph`，再空格键入 `/simpl` 选中 `code-simplify`，发送。
- 通过标准：① 光标处出现两个 chip，浮层只列 skill 不列命令；② 打开该 session 的 pi JSONL，user message 正文**原样保留两个 `<taiji-skill/>` 标记**，末尾 `<taiji-skill-data>` 块内含**两个** `<skill name="..." location="...">` 完整 block（格式与 pi 原生展开逐字一致，可用探针脚本比对；同 name 去重生效）；③ 模型回答内容同时体现两个 skill 的方法论（如提到 call graph 遍历与降认知复杂度）；④ 消息流中该消息显示正文 + 两个 skill badge，且 badge 前后不换行（D12，重开 session 后同样成立）。

**场景 2：预算超限自动降级 + 模型自主 read（回溯 G3）**
- 步骤：切换到 32k 窗口模型（或自定义小 contextWindow 的测试模型），插入两个大 skill（SKILL.md 正文合计约 6 万字符）+ 一句正文，发送。同时用 provider 的真实 usage（assistant 消息 usage 字段）记录该轮实际 input token。
- 通过标准：① JSONL 里该消息正文标记原样保留 + 末尾 `<taiji-skill-data>` 降级形态（标记清单 + 指引行，D11），**无** skill 全文；② 模型回合中出现 read 工具调用读取至少一个 SKILL.md，且回答体现其内容；③ 前端该消息仍显示 skill badge + 「标记模式注入」提示；④ 会话后续 3 轮对话无 context overflow 报错；⑤ CJK 感知估算值与该轮真实 input token 的偏差记录在案（校准 D6 系数，供探针/调参引用）。

**场景 3：skill 失效可见降级（回溯 G3/D8）**
- 步骤：插入一个 chip 后，磁盘上把该 skill 目录移走，发送。
- 通过标准：① 消息正常发送，prompt 里标记原样透传；② 前端出现 toast 与消息内联提示「skill xxx 不存在」；③ 无静默（对比：关掉提示机制重试，用户无从得知 skill 未生效——此为被否状态）。

**场景 2b：contextWindow 获取失败 fail-safe 降级（回溯 G3/D6 fail-safe）**
- 步骤：dev 环境临时屏蔽 runtime 对 `get_session_stats` 的调用（模拟 RPC 失败），发送一条含 skill chip 的消息；随后恢复屏蔽再发一条。
- 通过标准：① 屏蔽期消息走降级形态（JSONL 为标记正文 + `<taiji-skill-data>` 标记清单块）——**fail-safe 生效，不因无信息放行全文**；② 前端降级提示文案与场景 2 的「预算超限」文案**可区分**（如「窗口信息获取失败，已按标记模式注入」——纯文本消息不受影响、无提示）；③ 恢复后下一条消息自动回到全文注入路径。

**场景 3b：BeforeSend hook 破坏标记（回溯 D8/D9）**
- 步骤：装载一个改写消息文本的测试 plugin（BeforeSend hook 把消息尾部截断，破坏 `<taiji-skill/>` 标记完整性），发送含 chip 消息；卸载 plugin 重发。
- 通过标准：① 标记残缺不展开、原样透传（模型看到残缺标记，无 skill 全文）；② 前端可见提示（toast/内联）；③ 整条消息不被阻断，正文完整送达。

**场景 4：重开 session 的 chip 恢复与正文保留（回溯 G4）**
- 步骤：场景 1 完成后关闭该 session 再重开；再构造一个 sidecar 丢失的会话（手动移走 `attachments/<sessionId>/segments.json`）重开。
- 通过标准：① 正常重开：消息显示正文 + 两个 skill badge（sidecar 主通道）；② sidecar 丢失：兜底反解析先剥 `<taiji-skill-data>` 块（块内全文不可见）再将正文两个标记还原为 badge（D7 三形态）；③ **正文保留**：sidecar 丢失时派生 segments 仍含「帮我 review 这段代码」text segment——block 前的正文不得因反解析丢失（此断言专防 core `parseSkillBlock` 现状正则的前置正文丢失缺陷回归）；④ 无 badge 退化为大段 XML 文本的情况（兜底也失败时允许纯文本，记录为已知边界）；⑤ **存量格式回归**：升级前的老会话（pi 原生 `/skill:` 行首展开消息，block 前置 + args 在后）重开后派生 segments 仍为 `[skill badge, args 文本]`——反解析升级不得改变存量消息的既有行为。

**场景 5：steer 路径注入（回溯 G2/D9）**
- 步骤：模型执行长任务中（isGenerating），空格后 `/` 插入一个 skill 发送（steer）。
- 通过标准：steer 消息入队且 JSONL 中该消息含展开 block；当前回合结束后模型在后续上下文中体现该 skill 内容。

**场景 6：路径文本不误弹（回溯 G1 的 D5 缓解，负面验证）**
- 步骤：输入 `帮我看看 /usr/local/bin`，逐字符观察；再输入 `看下 /tmp 文件`；再在全角空格（中文输入法）后输入 `/rev`。
- 通过标准：① `/usr` 时可能短暂弹出，输入到第二个 `/` 时浮层**立即关闭**；② 行首 `/` 命令浮层行为与现状完全一致（回归）；③ `#`/`$`/`@` 浮层行为无变化（回归）；④ 全角空格后 `/` 能唤起 skill 浮层（`[^\S\n]` 空白语义对齐 `#` 符号体验）。

**场景 7：手打 `/skill:` 行首语义回归（回溯 G5）**
- 步骤：不用浮层，手打整条消息 `/skill:code-simplify 帮我看看`（消息以 /skill: 开头），发送。
- 通过标准：pi 原生展开生效（JSONL 单个 block + args），行为与改造前完全一致。

**场景 8：pi 升级格式漂移被探针拦截（回溯 G5/D5 守卫）**
- 步骤：运行 runtime REAL_PI vitest 池的 `pi-semantics-skill-expansion-golden.test.ts`（真实 pi 进程 golden diff；无凭证环境跑 `pi-semantics-skill-expansion-static.test.ts` 静态锚）。`node scripts/check-pi-semantics.mjs` 只做登记表结构校验、不执行 golden diff，不可作为本场景的执行手段。
- 通过标准：golden 测试对 pi 实装 `/skill:` 展开输出与 taiji 展开器输出做逐字 diff，当前版本全绿；人为篡改展开器格式一处（临时实验）golden 测试变红。**R4 核对**：golden diff 锚定对象是单个 `<skill>` block 内容（D11 下不变）；若探针含整条消息形态断言，同步更新为「标记保留 + 末尾块」。

**场景 9：readline 分帧防御（回溯 D10；协议层构造帧验证——例外声明）**
- 例外理由：U+2028/U+2029 无法依赖真实模型输出可靠构造，协议层防御采用确定性构造帧验证（标准做法）；端到端大文本路径已由场景 1/4 的真实会话覆盖。
- 步骤：对 rpc-client 的解析层注入构造帧（含 U+2028、U+2029 的单行 JSON），新旧读取器对照。
- 通过标准：① 新 LF-only 读取器不拆帧，JSON.parse 全部成功；② 旧 readline 实现同样输入下复现拆帧（对照组证明隐患真实）。

**场景 10：混排消息气泡 badge 不换行（回溯 D12；R4 新增）**
- 步骤：composer 输入 `看看这个`，插一个 skill chip，续输 `怎么用`，发送；重开 session 再看同一条消息。用 browser-automation 对气泡截图 + DOM 断言（badge 与前后文本同一行内）。
- 通过标准：① live 气泡中 badge 与前后文本同行（badge 前后无换行）；② 重开 session 后同形态（live ≡ reload）；③ 纯文本多段落消息（无 badge）排版不变（回归）；④ 混排消息中 text 段含行内 code/链接时渲染正常；⑤ 非 skill 段混排回归：file/session badge 及 slash/image 段混排消息渲染形态随 D12 同步变化（正向），抽一例 file badge 混排断言同行渲染。

**场景 11：composer skill chip 前后空开（回溯 D13；R4 新增）**
- 步骤：composer 输入文字后经 + 菜单/搜索跳转注入 skill chip（非触发路径，前贴文字），观察 chip 与前后文字间距；行首插 chip 观察首行缩进。
- 通过标准：① chip 前后各有约一个空格宽间距（getComputedStyle margin-left 4px / margin-right 6px）；② chip 为编辑器首节点时无 margin-left（行首不缩进）；③ Backspace 删 chip 行为不变（整块删，spacer 联动正常）；④ 发送序列化无双重空格（segmentsToText 产物与改造前逐字一致）。

**场景 12：跨消息同 skill 注入的累积观察（回溯 §3.5-②/⑧；R4 新增）**
- 步骤：同一 skill 挂 4–5 条消息依次发送 → 记录每轮真实 usage.input 增量 → 重开 session → （可选）触发 threshold compaction 后观察旧 block 被摘要。
- 通过标准：① 每条消息正文标记保留 + 末尾块含该 skill 全文（同 name 块内去重不跨消息）；② 重开 session 加载正常、badge 无重复；③ usage 增量记录在案（§3.5-② 累积成本与 §3.5-⑧ 字节预算重审条件的基线数据，与场景 2⑤ 校准记录共用形态）；④ compaction 后旧 block 被摘要、会话继续正常。

---

## 5. 下一层拆分

> **实施状态注记（R4 审查后补登）**：本设计的 pre-R4 主体已落地（注入器 `skill-injector.ts` 原位展开形态 + `<taiji-skills>` 降级块、序列化标记、skill 触发/chip/浮层、notice 呈现链、core 反解析两形态、D10 LF-only 读取器均已实施）；**R4 待实施增量** = D11 末尾块（`SKILL_DATA_BLOCK_TAG` 不存在于 shared）、同 name 去重、注入器原位展开→末尾块改造、core 剥块三形态升级、D12 inline 化、D13 CSS。下表「内容」列描述的是该阶段改造后的终态；标注「R4」的条目为本轮真增量，未标注的为已落地基线（实施者勿重复实施）。行号引用以 pre-R4 HEAD 时点为准，实施时按符号检索定位。

### 实施路径（4 个阶段，各自可独立验证/回滚）

| 阶段 | 单元 | 内容 | justification | 对应验收 |
|---|---|---|---|---|
| P1 | **runtime 注入器**（核心，先行） | `packages/runtime/src/services/session/skill-injector.ts`（新增）：标记解析、权威映射（D7 切源后 = SkillRegistry，原 get_commands）、展开（import pi stripFrontmatter）、**[R4] 末尾 `<taiji-skill-data>` 块组装（正文标记保留，D11；同 name 去重）**、预检（CJK 感知估算 + 0.8 阈值常量）、**[R4] 降级形态生成（标记清单 + 指引行并入同一块）**、失效/残缺透传+广播提示；`message-dispatcher.ts` 三入口挂载（hook 之后、client.prompt 之前） | 注入器是全链路枢纽且可独立测（纯函数 + RPC 查询）；先行实施可用手写标记文本验证，不依赖 UI 改动 | 场景 2/3/5/12（用脚本发构造消息；12 = 跨消息累积观察） |
| P2 | **序列化与反解析（含 core SSOT 升级）** | `segments.ts` skill 分支改产 `<taiji-skill/>` 标记；`shared/skill-marker.ts` **[R4]** 新增 `SKILL_DATA_BLOCK_TAG`（`taiji-skill-data`）与块构建/解析辅助；**[R4] `packages/core/src/domain/chat/apply-entry-convert.ts` 反解析升级为三形态**（剥块优先 + 标记还原 + 存量 block/`<taiji-skills>` 兼容，D7，三链路共用 SSOT）；**[R4]** `apply-entry-equivalence` 等价性守卫扩展覆盖「标记 + 末尾块消息」两链路（live ≡ reload，架构关键规则 9）；现有测试更新（`segments.test.ts`、`store.test.ts`、`turn-skill-badge.test.ts`、command-popover 系列——全部锁定旧 `/skill:` 形态将变红） | 序列化格式是 renderer/runtime 契约变更点；core 反解析与序列化同批定义标记语法；等价性守卫是「live ≡ reload」的机器防线，必须随格式变更同步扩展 | 场景 1/4（含正文保留断言） |
| P3 | **composer 触发与 chip + 提示呈现** | `input-dom.ts` 新增 skill 触发正则（`/[^\S\n]\/(\S*)$/` + query 过滤）；`contenteditable.ts` chip 抑制解除（skill 通道）；`chip-commands.ts` `insertSkillChip`；`CommandPopover.vue` skill-only variant + 已选禁选；**`ComposerInput.vue` skill chip 前后空开 CSS（D13，R4）**；**renderer 提示呈现**（降级「标记模式注入」提示行——文案区分「预算超限」vs「窗口信息获取失败」两种降级原因——+ 失效 toast/消息内联提示，复用现有 toast 机制；实施形态 = 消息内联提示行 `SkillNoticeInline`，锚点 turn 之后渲染） | UI 层最后做：P1/P2 就绪后插入即可端到端生效，避免 UI 先行却无注入的空转；提示呈现是场景 2/2b/3/3b 的验收依赖面；**[R4]** D12 混排 inline 化 + D13 chip CSS 落点在本阶段（UserBubble/ComposerInput） | 场景 1/2b/3/3b/6/**10/11** |
| P4 | **守卫与防御** | PS-24 探针（golden diff，实施落点 = runtime REAL_PI vitest 池 + pi-semantics.json 登记）；rpc-client readline 替换 LF-only 读取器 | 守卫与防御独立于功能主线，可并行或收尾 | 场景 8/9 |

### 文件改动地图

| 文件 | 改动 |
|---|---|
| `packages/dom-core/src/composer/input/input-dom.ts` | 新增 skill 触发检测（空格/tab 后 `/` + query 过滤）；getSegmentsFromEl 无需改（已支持） |
| `packages/dom-core/src/composer/input/contenteditable.ts` | 触发状态机加 skill 分路；chip 抑制解除（限 skill 浮层） |
| `packages/dom-core/src/composer/input/chip-commands.ts` | 新增 `insertSkillChip`（insertChipAtSelection 复用） |
| `packages/renderer/src/components/panel/CommandPopover.vue` | skill-only variant + 已选禁选态 |
| `packages/renderer/src/composables/panel/useCommandPopoverTrigger.ts` | skill 触发路由 |
| `packages/renderer/src/components/panel/Composer.vue` | skill 触发转发（slash-trigger 之外新分路） |
| **renderer 提示呈现**（`useSkillNoticeStream.ts` + `SkillNoticeInline.vue` + MessageStream 内联行 + 失效 toast，复用现有 toast 机制；u5 实施落点） | 新增：场景 2③/3② 的呈现面 |
| `packages/shared/src/segments.ts` | skill 序列化分支改 `<taiji-skill/>` 标记（单点） |
| `packages/shared/src/skill-marker.ts` | 新增 `SKILL_DATA_BLOCK_TAG`（`taiji-skill-data`）+ 包裹块构建/解析位置切片辅助（D11/D7，R4） |
| `packages/ui/src/features/chat/UserBubble.vue` | 混排消息 inline 化渲染 class + scoped CSS（D12，R4——badge 前后换行修复） |
| `packages/ui/src/features/composer/ComposerInput.vue` | skill chip 前后空开 CSS（`.slash-chip[data-chip-type='skill']` margin，D13，R4） |
| `packages/core/src/domain/chat/apply-entry-convert.ts` | **[R4] 反解析升级为三形态**：剥块优先（`<taiji-skill-data>` 任意位置剔除）+ 标记还原 + 存量 block/`<taiji-skills>` 兼容（D7 兜底，三链路 SSOT） |
| `packages/runtime/src/services/session/skill-injector.ts` | **新增**：展开/预检/降级/失效提示 |
| `packages/runtime/src/services/session/message-dispatcher.ts` | 三入口挂载注入器（hook 后、client.prompt 前） |
| `packages/runtime/src/infra/pi/rpc-client.ts` | readline → LF-only 读取器（D10） |
| `scripts/check-pi-semantics.mjs` | 不改（PS-24 探针实施落点改为 runtime REAL_PI vitest 池 `pi-semantics-skill-expansion-golden.test.ts` + `docs/pi-semantics.json` 登记，登记 schema 强制 guard.test 指向 .test.ts） |
| 测试连带：`packages/shared/src/__tests__/segments.test.ts`、`packages/core/src/domain/chat/__tests__/store.test.ts`、`packages/renderer/src/__tests__/panel/turn-skill-badge.test.ts`、command-popover 系列测试、`apply-entry-equivalence` 等价性守卫 | 锁定旧 `/skill:` 形态的断言全部更新；等价性守卫扩展「标记消息」两链路 |

### 待验证检查点（实施期核实，不阻塞设计）

1. ~~get_commands 返回的 sourceInfo 字段形态~~ **已核实并修正（实施期）**：pi `skills.js:90-110` 的 `createSkillSourceInfo(filePath, baseDir, source)`——skill 项 sourceInfo 含 SKILL.md 路径；**但 baseDir 字段不可依赖**：`createSkillSourceInfo` 各分支原样透传 `dirname(filePath)`，而 `resource-loader.js:514-518` 的 extension 覆盖链（`findSourceInfoForPath` 命中时直接采用 extension `metadata.baseDir`）与 `:612` 兜底（`<...>` 形态无 baseDir 字段）使 `sourceInfo.baseDir` 与 pi 展开实际使用的 `skill.baseDir = dirname(filePath)`（`skills.js:236/:260`）可分离。实施定案：References 行 baseDir **恒用 `dirname(SKILL.md path)`**（对齐 pi 实装），弃用 `sourceInfo.baseDir`（实施 commit 448c2ef32）；另 get_commands 的 skill 项 name 恒带 `skill:` 前缀（`agent-session.js:1996`），消费侧需剥前缀归一。
2. 两条发送前 RPC 的调用开销与缓存：`get_session_stats`（contextWindow）+ name→path 权威映射（D7 切源后 = SkillRegistry 进程内读取，原 get_commands RPC 已不走）的解析都是每条消息的额外开销（原 get_commands 返回全量命令 + skill 列表）。评估结果缓存（按 session + 失效事件：现有 `config.skillCacheInvalidated` 广播 / 模型切换事件触发失效）。
3. 降级指引文本措辞与 pi system prompt `<available_skills>` 指引的措辞对齐（提升模型 read 遵循率）。
4. landing 态（首条消息）浮层数据源复用 `useProjectSkills`/`useGlobalSkills` 时 name 与 get_commands name 的一致性（两边都应是 SKILL.md frontmatter name）。
5. steer/followUp 消息的 sidecar 写入路径现状（steer 走 `chatApi.steer`，sidecar 是否同写——影响场景 4 对 steer 消息的覆盖）。
6. CJK 感知估算系数与真实 tokenizer 的偏差校准（场景 2⑤ 的实测数据回填；**校准样本须含中文型、英文型、代码密集型（大段代码块/base64）三类 SKILL.md**——代码密集型是 ÷4 公式的最弱面；若偏差 > 30% 调整系数常量）。

---

## 变更历史

- 2026-09-13（R4 对抗审查收口：三审 0 must-fix / 10 suggestion 全修）：主审 4 条——§5 补实施状态注记（pre-R4 基线 vs R4 增量，D10 标注已实施、§2.3-D readline 动机记录标注）；场景 8 执行步骤改为 REAL_PI golden 测试（check-pi-semantics.mjs 不执行 diff，防假绿）；D3 边界声明按位置限定（首位手打 = pi 原生展开）；新增场景 12（跨消息同 skill 累积观察，补 §3.5-②/⑧ 重审条件基线）。影响面审 5 条——§3.5-① 机制描述修正为投影级比较（失配域 = sidecar 丢失兜底；store.ts 注释实施期同批更正）；② 补 QueueBubble 显示投影；⑤ 补 composer ↑/↓ 历史召回消费面；新增 ⑧ 历史读取字节预算耦合；D8/§3.4 补 pi 侧 input hook 检测域边界。简洁审 1 条——D11 补被否变体 ④（复用 `<taiji-skills>` 作统一包裹 tag：LLM 可读性 + 新旧消息 tag 级自识别，判定不复用）。另采影响面 INFO 三条：D11 数据源澄清（location 恒来自 get_commands 映射，D4 口径统一）、落盘末尾性依赖声明（msg-id-mapper 剥注释）、§3.5-⑥ 补注入器侧手打块真展开；场景 10 补非 skill badge 混排回归断言。
- 2026-09-12（R4：末尾集中追加协议 + 气泡混排渲染 + chip 空开）：① **D11 新增**——注入形态从「原位展开」改为「正文原样保留 `<taiji-skill/>` 占位标记 + 消息末尾集中追加 `<taiji-skill-data>` 包裹块」：正常形态（块内 pi 对齐展开全文、同 name 去重）/ 降级形态（标记清单 + 指引行，原 D7 降级块 `<taiji-skills>` 统一并入、旧 tag 退役但反解析保留识别）；失效标记与 mapping_unavailable 不进块；LLM 关联指引正常形态不加（citation 模式 name 双向对齐），观察点登记为 hook 注入系统提示词补救路径。② **D7 修订**——resume 兑底反解析升级三形态（剥块优先 → 标记还原 → 存量 block/`<taiji-skills>` 兼容），剥块任意位置匹配。③ **D5 修订**——block 落点改末尾块内，探针 golden diff 锚定单 block 不变、整条形态断言待核对。④ **D12 新增**——UserBubble 混排消息 inline 化渲染（badge 前后换行修复；复杂块级 markdown 排版退化登记）。⑤ **D13 新增**——composer skill chip 前后 CSS 空开（ZWSP/序列化契约不动）。⑥ 场景 1/2/2b/4/8 形态断言更新，新增场景 10/11；错误规格表四行更新；§3.5-① 补 R4 注记、④ 折叠形态消失更新、⑥ 补块内逃逸与手打块误剥扩面；§5 P1/P2/P3 与文件地图同步。
- 2026-09-05：初版（对齐三轮分析结论：pi 单 skill 限制根因、切点盲区后果链、方案 D 选型）。
- 2026-09-05：第 3 版（R2 双复审 0 must-fix 后的 suggestion 收尾）。主审 4 条：D1 字符类 `[ \t]` → `[^\S\n]`（全角空格/NBSP 缺口，对齐 `#` 符号空白语义）+ 记入被否谱系；D6 补推演边界（代码密集非 CJK 内容 ÷4 低估 1~2 倍，检查点 6 校准样本扩三类）；新增场景 2b（fail-safe 降级 + 文案区分）与 3b（hook 破坏标记）；D10 效果栏验收指向 8→9 更正。影响面审 2 条：§3.5-③「内容无损」限定为仅显示层消费 + 标注编辑重发升级路径由 §3.5-⑤② 消除；D7 补 `<skill` 字面全局匹配边界 + 场景 4⑤ 存量格式回归断言。G1 表述精确化（空格/tab 后，行首归命令浮层）。
- 2026-09-05：第 2 版（双审 7 must-fix + 13 suggestion 全修）。主要修订：D1 触发正则改 `/[ \t]\//`（行首让位命令浮层的仲裁）+ 误弹量级与重审条件；D6 估算改 CJK 感知公式（chars/2「双向保守」声称不实被否）、fail-open 改 fail-safe、补等效阈值推演与漏判-兜底关系；D5 删「pi TUI 正确渲染混排」声称（实装整条锚定不成立，登记 §3.5-④）；D7 兜底反解析实现位置定于 core `apply-entry-convert.ts`（三链路 SSOT）并修复其前置正文丢失缺陷；D9 补 hook 挂载顺序、幂等改结构化保证；新增 §3.5 影响面与已接受代价五项登记（store 判据失配、JSONL 累积、兜底误还原、pi TUI 显示、normalizeContent 投影面）；错误规格表修正三处（日志路径、fail-safe、降级后超窗的会话内救援路径）；§4 场景 2 补真实 token 校准、场景 4 补正文保留断言、场景 9 补例外声明；§5 改动地图补 core/renderer 提示/测试连带条目，待验证检查点 1 已核实关闭、新增检查点 6。
- 2026-09-06：实施期一致性修订（阶段 3 双区审查 doc_errors + 合理偏差同步）。① 检查点 1 正式修正：sourceInfo.baseDir 不可依赖（extension 覆盖链 + 兜底无字段），References baseDir 恒用 dirname(path)，get_commands skill 项 name 恒带 `skill:` 前缀需剥前缀（实施 448c2ef32）；② D5 更新：baseDir 来源标注 + stripFrontmatter 改仓内镜像（exports 白名单与 tsup bundle 约束）+ 探针落点改 runtime REAL_PI vitest 池（CI skip 边界注明）；③ §3.4 错误规格表补 get_commands RPC 整体失败行（mapping_unavailable）；④ 场景 2③/P3/文件改动地图的提示形态措辞更新为「消息内联提示行」（实施落点 useSkillNoticeStream + SkillNoticeInline）；⑤ D1 补 query 空串合法语义（`{0,64}`）。
- 2026-09-10（design-code-sync 轮 3 收口）：§3.5-⑤② 与 ③ 的「编辑重发仅视觉退化 / 优化项延期未实施」判定按实测更正——探针复现证实编辑重发会让非 text 段序列化形态**翻倍**（`[skill, text]` 经 `normalizeContent` → `rebuildSegmentsWithEditedText`（段翻倍）→ `segmentsToPrompt` 序列化出两个 `<taiji-skill>` 标记 ⇒ runtime 逐个展开 ⇒ 同一 SKILL.md 注入两遍；file/mention/session/handoff 同族）。已由 `packages/ui/src/lib/segment-rebuild.ts` 增加「与保留段重复的序列化文本剥离」修复（skill 用 `buildSkillMarker` SSOT 精确匹配，剥离不到即丢弃段；slash 段处理逻辑一字未动——其前缀剥离口径为同轮编辑重发修复引入，见 §3.5-⑤②）。回归锁落在 `packages/ui/src/lib/__tests__/segment-rebuild.test.ts`（该目录为轮 3 新增；`rebuildSegmentsWithEditedText` 此前全仓无单测引用——`git grep -l rebuildSegmentsWithEditedText HEAD -- '*test*'` 为空）与 `packages/ui/src/features/chat/__tests__/UserBubble.test.ts`（两文件共 **66 例** = `segment-rebuild.test.ts` 40 + `UserBubble.test.ts` 26，为**轮 3 收口时点实测值**；修复落地时点为 50 例（25 + 25），其后的 16 例为同轮代码侧新增用例——`[轮 3-4 · RC-A-2]` 4 例、`[轮 3-4 · RC-A-6]` 3 例、`[轮 3-4]` 未编辑草稿重发 8 例，另 `UserBubble.test.ts` 1 例）；整文件回退即红（回退 = 用 HEAD 版覆盖工作区文件，实验必须可逆）：`cp packages/ui/src/lib/segment-rebuild.ts /tmp/segment-rebuild.bak.ts && git show HEAD:packages/ui/src/lib/segment-rebuild.ts > packages/ui/src/lib/segment-rebuild.ts`，还原 = `cp /tmp/segment-rebuild.bak.ts packages/ui/src/lib/segment-rebuild.ts`；回退后 `cd packages/ui && npx vitest run src/lib/__tests__/segment-rebuild.test.ts src/features/chat/__tests__/UserBubble.test.ts` = **43 failed | 23 passed（66）**（2026-09-10 实测，还原后工作区与实验前 `md5` 一致），恢复修复后 **66 passed**。image 段因 `\n<path>\n` 与 `draftText.trim()` 交互无法精确匹配，其「翻倍」与「删除后路径复活」两个方向均作为未修项登记于 ⑤②（附安全变体/被否变体处置方向）。③ 的「误还原 segment → 真展开」语义升级路径仍开放（只能由 ⑤② 完整优化项消除）。另同步 `packages/core/src/domain/composer/dispatch/send.test.ts` 三处失实注释：fixture `draft: '任务描述/compact'` 为构造值（真实 `getText()` 走 `segmentsToText`，产出已归位文本），其作用是锁定「判定源不得退回 `draft.value`」。
