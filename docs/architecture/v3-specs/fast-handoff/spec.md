# Fast Handoff · 一键交接到新 session（设计单元 spec）

> 层级 **L2 跨区联动** · 痛点3 主线
> 配套 draft：`draft-fast-handoff.html`（2026-07-24 完成，5 场景可交互 demo）
> 上游规范：`../../design-tokens.md`（冷蓝暗色 SSOT）、`~/.agents/skills/handoff/SKILL.md`（handoff skill 提示词来源）

---

## ⚠️ 设计修订 2026-07-24（以本节为准，以下 §0-§4 旧设计已 DEPRECATED）

> **核心裁决推翻**：原方案「structured-output 三件套强制 JSON schema」被废弃。改用 **handoff skill 自由格式文档 + xml tag 包装注入**。
> 旧设计（§0-§4 的 extension/setActiveTools/schema/Ajv 校验）保留在下文作历史追溯，标注 DEPRECATED，**不要按旧设计实现**。
> 实现以下文「修订后方案」为准。

### 修订原因

用户（2026-07-24 设计评审）决定：不追求格式强稳定，改用 handoff skill 现有提示词（自由格式文档），用 xml tag 包装边界保证可识别即可。理由：大幅简化架构（不需 extension、不需打包、不需 schema 校验），格式不稳定用 xml tag + action-oriented 注入弥补。

### 修订后方案（实现以此为准）

**生成**：当前 session 的 pi 进程跑 `/skill:handoff`（提示词 = `~/.agents/skills/handoff/SKILL.md`），agent 产出自由格式 markdown 文档字符串。**不需要 xyz-handoff-extension.js、不需要 setActiveTools 三件套、不需要 structured-output schema 校验。**

**包装**：runtime 拿到文档字符串后，用 `<handoff_document>` xml tag 包装边界，追加 action-oriented 指令，注入新 session 作首条消息：

```
<handoff_document source="源 session 名" created="时间戳" file="/tmp/handoff-xxx.md">
[agent 跑 handoff skill 产出的自由格式文档]
</handoff_document>

立即执行文档里尚未完成的下一项。遇到卡点或 blocked 项时停下问我。完成每一步后继续下一项。
```

**新建 + 注入**：runtime 层 handoff-service 持有 SessionService，`create(srcCwd)` 新建空白 session → `sendMessage(newId, wrappedDoc)` 注入首条 → `broadcast({type:'session.handoffComplete'})` 通知前端跳转。

### 已确认的设计决策（2026-07-24 用户拍板）

| # | 决策 | 选择 |
|---|------|------|
| 1 | handoff 入口位置 | **per-turn hover action 区**（非 PanelHeader）。且**仅在最后一条 assistant 消息**出现，中间消息不显示（与 fork 不同，fork 可从任意消息分叉，handoff 是"到此为止交接"无交接点概念） |
| 2 | handoff-ask 模式 | **支持**。镜像 fork-ask：点「handoff 备注」按钮 → composer 进 handoff 模式 → 输入交接备注（作为 handoff skill 的 focus 参数）→ 发送 = 生成 + 新 session + 注入 |
| 3 | 新 session 是否立即执行 | **是**。注入后 action-oriented 指令驱动新 agent 立即干活，不停在"我了解了" |
| 4 | handoff 提示词来源 | 用现有 handoff skill 的 SKILL.md 提示词（不新造 structured-output 三件套） |
| 5 | 文档格式 | 自由格式 markdown（agent 产出），**xml tag 包装**边界（runtime 注入时加，非 agent 生成） |

### turn 尾部 action 行设计（2026-07-24 定稿）

**图标化方案**（用户选定，详见 `draft-fast-handoff.html` 场景 01）：

末条 assistant 的 hover action 行结构：
```
[复制] [复制MD] │ [fork后台] [fork提问] │ [handoff] [handoff备注]
```
- **所有按钮 icon-only**（24×24 命中区，14px 图标），文字标签 + 快捷键收到 hover tooltip（原生 title）
- **默认态全 subtle 灰**（6 个安静图标不刺眼，不割裂），hover 才出 accent-soft 底 + accent-hover 字
- **分组**靠 as-sep 分隔线：copy 组 / fork 组 / handoff 组
- **图标形态区分主次**：fork 后台=线性 GitFork，fork 提问=实心 GitFork，handoff=实心 Upload，handoff 备注=实心 Upload + 右上角小圆点徽章

### 待实现链路（修订后，简化版）

```
前端末条 assistant hover action 「handoff」按钮（Turn.vue）
  → sessionApi.handoff(srcSessionId, { focus?: string })    [renderer API，发 ClientMessage]
  → ClientMessage 'session.handoff'
  → session-message-handler.ts 新 case                     [runtime WS 路由]
  → handoffService.runHandoff(srcSessionId, focus?)         [runtime 层服务]
      ├─ client.prompt("/skill:handoff" + (focus? " "+focus : ""))  [触发 pi handoff skill]
      ├─ 监听 handoff skill 完成（pi agent_end / 产出文档）          [pi → runtime]
      ├─ wrapWithXmlTag(doc, srcName)                               [runtime 包装]
      ├─ this.svc.create(srcCwd, label)                             [新建空白 session]
      ├─ this.svc.sendMessage(newId, wrappedDoc)                    [注入首条]
      ├─ persistHandedOff(srcSessionFile, newId)                    [源 session 标记]
      └─ broker.broadcast({type:'session.handoffComplete'})         [通知前端跳转]
  → 前端收到 session.handoffComplete → 跳转新 session
```

**handoff-ask 模式**：镜像 useComposerForkMode，composer 进 handoff 模式（accent 边 + mode chip），输入 focus 文本后发送，走同一 runHandoff(srcSessionId, focus)。

### 仍需实现时确认的点

1. **handoff skill 完成信号**：pi 跑 `/skill:handoff` 后如何判定文档产出完成？（agent_end 事件？还是 skill 有特定完成标志？）——需查 pi skill 执行机制
2. **文档内容获取**：handoff skill 把文档写到 OS 临时目录（SKILL.md 要求），runtime 如何拿到文档内容？（读文件？还是从 pi 对话流提取？）——skill 产出路径需明确
3. **源 session 污染**：handoff skill 执行过程（thinking + 文档正文）会留在源 session 对话流。倾向方案 A（前端 MergeBlock 折叠灰显标注"handoff 生成过程"，spec §9）
4. **protocol.ts 硬缺口**：仍需加 `session.handoffComplete` 到 ServerMessageType 联合（见 §7.3，此点不变）

### demo 场景索引（`draft-fast-handoff.html`）

| 场景 | 展示 |
|------|------|
| 01 入口 | 末条 assistant 的图标化 action 行（handoff 只在末条，中间消息无） |
| 02 handoff 备注 | composer 进 handoff 模式（accent 边 + glow + mode chip） |
| 03 生成中 | "正在交接"瞬时提示（对标"压缩中"，带取消按钮） |
| 04 完成 | HandoffNotice 反馈行 + 源 session 标记"已交接" |
| 05 新 session | xml tag 包装的交接文档 + action-oriented 指令区 + agent 立即接手 |

---

## ⬇️ 以下为旧设计（DEPRECATED 2026-07-24，保留作历史追溯，勿按此实现）

> 原 §0-§4 基于 structured-output 三件套架构。因 2026-07-24 设计修订（见上方）改为 handoff skill 方案，以下内容不再有效。
> 其中 §5 Key States（状态机）、§6 视觉规范、§7 实现锚点（除三件套部分）、§8-§12 的非架构内容仍有参考价值，但涉及 extension/schema/三件套的细节均以修订后方案为准。



## 0. 背景与问题

用户在当前 session 工作告一段落，想**带着压缩后的上下文，快速开一条新线程继续干**。现状只能手动：`/skill:handoff` 生成文档 → 手动开 session → 手动粘贴。且 handoff skill 产出的是自由格式文档，**不稳定**（agent 输出格式不固定）。

用户诉求：**一键自动化**（生成 handoff → 开新 session → 注入 handoff）+ **格式稳定**（schema 强制）。

### handoff 的本质

handoff 就是"让 agent 产出一段结构化总结文本，喂给新 session 的 agent 读"。它和痛点2 merge 的差异：

| 维度 | 痛点2 merge | 痛点3 handoff |
|---|---|---|
| 总结对象 | N 个分支的差异 | 当前 session 的全部 |
| 输出去向 | 贴主线 composer，用户编辑后发送 | 自动注入新 session 作为首条消息 |
| 新 session 类型 | 不新建（回到主线） | **新建空白 session**（不继承历史，handoff 的意义就是不继承历史） |
| 生成后是否自动 | 否（用户编辑发送） | **是**（一键完成） |

共享部分：**都用 structured-output + 三件套强制结构化输出**。

## 1. 核心裁决 · 三件套生成 handoff + runtime 新建 session

### 排除的方案

| 方案 | 排除原因 |
|---|---|
| 纯 handoff skill（自由格式文档） | 格式不稳定（用户明确指出） |
| extension 调 completeSimple 绕过 agent loop | 放弃 pi 基础设施，重造轮子（痛点2 已论证） |
| fork 当前 session 继续 | 违背 handoff 语义（handoff 的意义就是不继承历史） |

### 锁定方案：与痛点2 共享三件套架构

**extension 在当前 session 的 pi 进程内，用 setActiveTools + before_agent_start + turn_end 三件套，让 agent 产出符合 handoff schema 的结构化交接文档。runtime 拿到文档后新建空白 session 并注入。**

与痛点2 的差异仅在：
- schema 不同（handoff schema：goal/context/keyDecisions/currentProgress/nextSteps/filesModified）
- 输出去向不同（新建空白 session 而非贴 composer）
- 自动化程度不同（一键全自动，用户无需编辑发送）

### 为什么"格式稳定"靠 structured-output + 三件套

用户的核心质疑："agent 自由输出不是固定格式"。解决：
- **structured-output tool**：注册一个 tool，LLM 调它产出符合 JSON Schema 的数据（Ajv 校验）
- **setActiveTools(["structured-output"])**：锁工具集，agent 唯一能做就是调 structured-output
- **before_agent_start 注入**：明示 schema + "禁止文本输出"
- **turn_end 兜底**：没调就 steer 重试

这套结构性保证 agent 产出符合 schema 的数据。**验证现状**（假阳性修正）：痛点2 的 `verify-merge-extension.cjs` V1-V8 覆盖了正常成功路径（turn_end + steer 重试），handoff（单 turn 串行特例）可复用结论；但 **abort 取消 + agent_end 兜底恢复未验证**（verify 脚本无取消用例），handoff §5 的"生成中取消"需补验证（见 §11 验收 + handoff 文档 Step 1）。

## 2. 完整流程（审查 B1 修正：架构分层正确化）

⚠️ 审查 B1 发现原 spec 把 renderer WS RPC（`sessionApi.create` / `chat.send`）当成 runtime 内部调用——这是架构分层错误。runtime 的 handoff-service 应直接持有 `SessionService` 引用调 `.create()/.sendMessage()`（有 `workflowAction` 先例，`session-service.ts:550-564`）。

```
【前端触发】
  → 用户在当前 session 点"handoff 并新开"按钮（PanelHeader）
  → renderer 调 sessionApi.handoff(srcSessionId)（新加 renderer API）
  → 发 ClientMessage 'session.handoff' → runtime

【runtime handoff-service 编排】（注入 SessionService 依赖）
  → session-message-handler.ts 新 case 'session.handoff' → handoffService.runHandoff(srcSessionId)
  → runHandoff 内部：
      1. client.prompt("/handoff") 触发扩展 slash command（同 workflowAction 模式，session-service.ts:550-554）
      2. 监听 custom_message 'handoff-result'（经 event-adapter 转 message.customStart，event-interpreter 消费）
      3. 收到 handoff 结构化数据后：
         - this.svc.create(srcCwd, label) 新建空白 session（SessionService.create，session-service.ts:253）
         - this.svc.sendMessage(newId, formatHandoffToMarkdown(handoff) + action-oriented 前后缀) 注入首条
         - 持久化 handedOffTo 到源 session（见 §7.3）
         - broker.broadcast({type:'session.handoffComplete', payload:{srcSessionId, newSessionId}}) 通知前端跳转（⚠️ 须先在 protocol.ts 注册该 type，见 §7.3 硬缺口）

【extension 生成 handoff 文档】（当前 pi 进程内，agent loop 跑）
  → extension command handler（/handoff）：
      - 设置 ACTIVE = true，保存 SAVED_TOOLS
      - setActiveTools(["structured-output"])（锁工具集）
      - sendUserMessage(buildHandoffInstruction(HANDOFF_SCHEMA))，启动 turn
  → before_agent_start 注入"禁止文本输出，只调 structured-output"轻约束
  → agent 调 structured-output tool 产出符合 schema 的结构化 handoff
  → turn_end 检测成功 → 恢复工具集 → sendMessage(custom_message 'handoff-result') 回传
```

**关键架构原则**（审查 B1）：
- **runtime 层 handoff-service 直接持有 SessionService**（组合根 constructor 注入），不经 WS RPC 自己
- **扩展触发走 client.prompt("/cmd")**（runtime → pi 子进程），与 workflowAction/subagentAction 同模式
- **结果回传走 custom_message**（pi → runtime event-adapter），runtime 监听消费
- **前端跳转走 broker.broadcast**（runtime → 前端），前端收到 session.handoffComplete 事件跳转

### 注入 prompt 设计（决策 B 选项 1：action-oriented，审查 3-C1 修正）

⚠️ 审查 3-C1 发现："请基于此继续"太模糊，新 agent 大概率回复"好的我了解了"然后停下，"一键自动化让新 agent 接手"在最后一步断裂。

**注入 prompt 改为 action-oriented**（驱动新 agent 立即干活，而非只阅读）：

```
这是上一个 session 的 handoff 文档（[源 session 名] · [时间]）：

[handoff markdown]

立即执行 nextSteps 的第一项。遇到 currentBlocker 或 blocked 项时停下来问我。
完成每一步后在 currentProgress 更新状态，继续下一项。
```

**设计要点**：
- **"立即执行 nextSteps[0]"**：给 agent 明确的可执行动作，不停在"我了解了"
- **"遇 blocked 停下问我"**：安全阀，agent 不盲目冲过卡点
- **"完成每步更新状态继续"**：形成自主推进循环，达成"接手"而非"阅读"

**注入的 user message 角色**：这条 message 是明确的 user 指令（不是参考信息），主线 pi 把它当作"要做的事"而非"背景资料"。nextSteps 字段（§3 schema）是 agent 的 TODO 清单，注入 prompt 把它激活。

⚠️ **action-oriented 注入是产品赌注，未经行为验证**（假阳性修正）。新 session 空白无历史 context，agent 收到 nextSteps[0] 指令后是否真能立即执行（而非回"我了解了，请告诉我做什么"）取决于 LLM 能力 + prompt 工程，零验证支撑、不可完全控制。缓解措施：
1. schema 的 `nextSteps` 字段描述要求"具体可执行的动作"（非模糊目标，如"在 `foo.ts` 加 `bar()` 函数"而非"优化性能"）
2. 注入 prompt 明确"不要确认理解，直接动手"（上面 prompt 已含"立即执行"）
3. 实现后**实测多个真实场景**：若 agent 频繁停下确认，考虑退化为"注入后弹 composer 让用户确认首条指令"
4. 这个风险要在 §11 验收时用真实场景测试（不能只验技术链路）

**与 §4.2 取消能力的关联**：注入后新 session 启动一个 turn，如果 agent 跑偏，用户仍可 abort（SessionService.abort）。action-oriented 注入失败不会导致死锁。

### handoff 对当前 session 的污染（审查 m3）

handoff 生成过程（sendUserMessage 指令 + structured-output 调用）会留在当前 session 对话流。**标记为"系统过程"前端折叠灰显**（同 fast-merge §3 污染控制策略），不干扰源 session 叙事。源 session 还加"已 handoff → [新 session]"标记（见 §5）。

### 为什么新建 session 由 runtime 负责（不是 extension）

两个候选：

**候选 A：extension 内用 `ctx.newSession()` 新建**
- 优点：全在 pi 进程内闭环
- 缺点：`newSession`（`types.ts:348`）会切换 pi 的当前 session，时序复杂（extension 还在当前 session 的 turn 里，切换 session 可能干扰）。且 runtime 的前端状态（panel/session store）不同步

**候选 B（推荐）：extension 只生成 handoff，runtime 新建 session**
- extension 职责单一：生成结构化 handoff 文档，写回 session
- runtime 职责：监听 handoff-result → `sessionApi.create`（复用 useNewTaskFlow）→ 发首条 prompt → 跳转
- 前端状态（panel/session store）由 runtime 正常流转，不走 pi extension 的 session 切换
- **复用现有 new-task-flow**，不重造 session 创建逻辑

选 B。职责清晰，复用现有基础设施。

### 为什么"自动注入"而非"贴 composer 让用户编辑"（与痛点2 不同）

痛点2 merge 是"多分支结论聚合"，用户需要挑选/组织（创作动作）。痛点3 handoff 是"把当前工作交接给新 session 继续"，**交接文档本身就是要给新 agent 读的，不需要用户再编辑**（编辑反而是干扰——handoff schema 已结构化，用户编辑会破坏格式）。

所以痛点3 是**一键全自动**：生成 handoff → 新建 session → 注入 → 跳转。用户只点一次按钮。

## 3. handoff schema（审查 3-C2 扩充：承载复杂代码上下文）

⚠️ 审查 3-C2 发现原 schema 对复杂代码上下文承载力不足（filesModified 只有文件名列表、blocked 只是文字描述、缺错误堆栈/卡点细节字段）。扩充为：

```json
{
  "type": "object",
  "properties": {
    "goal": { "type": "string", "description": "当前 session 的核心目标" },
    "context": { "type": "string", "description": "新 agent 需要知道的背景（已做的决策、约束、技术栈等）" },
    "currentProgress": {
      "type": "object",
      "properties": {
        "done": { "type": "array", "items": { "type": "string" } },
        "inProgress": { "type": "array", "items": { "type": "string" } },
        "blocked": { "type": "array", "items": { "type": "string" } }
      },
      "required": ["done", "inProgress", "blocked"]
    },
    "currentBlocker": {
      "type": "object",
      "description": "当前卡点细节（若有），让新 agent 直接接手调试而非重新摸索",
      "properties": {
        "error": { "type": "string", "description": "错误消息/堆栈摘要" },
        "lastAttempt": { "type": "string", "description": "最后尝试的方案" },
        "hypothesis": { "type": "string", "description": "待验证的假设" }
      }
    },
    "keyDecisions": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "decision": { "type": "string" },
          "rationale": { "type": "string" }
        },
        "required": ["decision", "rationale"]
      }
    },
    "nextSteps": { "type": "array", "items": { "type": "string" }, "description": "下一步动作清单，注入 prompt 会让新 agent 立即执行第一项" },
    "filesModified": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "path": { "type": "string" },
          "changeSummary": { "type": "string", "description": "该文件改了什么（不只是文件名，让新 agent 知道每个文件的改动内容）" }
        },
        "required": ["path", "changeSummary"]
      }
    },
    "suggestedSkills": { "type": "array", "items": { "type": "string" } }
  },
  "required": ["goal", "context", "currentProgress", "keyDecisions", "nextSteps"]
}
```

**扩充点**（审查 3-C2）：
- `currentBlocker`：新增结构化卡点字段（error/lastAttempt/hypothesis），让新 agent 直接接手调试，不必重新摸索错误
- `filesModified[].changeSummary`：从文件名列表升级为 {path, changeSummary}，新 agent 知道每个文件具体改了什么
- `nextSteps` description 明确"注入 prompt 会让新 agent 立即执行第一项"，与 §2 注入设计呼应

**信息密度的 trade-off**（审查 3-C2 的论证补全）：
- handoff 是 high-level 接力，不可能承载 session 的全部细节。schema 抓关键结构化字段（目标/进度/卡点/决策/下一步/文件改动摘要）
- 细节新 agent 自己 grep/read 找回——filesModified 的 path + changeSummary 就是 grep 起点
- 不追求"压缩到极致"，追求"新 agent 能快速定位 + 自主推进"。schema 字段描述引导 agent 产出够用的信息密度

schema 可由用户自定义（实现时：固定 schema 起，后续可支持用户在 settings 配置）。

## 4. Extension 设计（xyz-handoff-extension.js）

### 4.1 与痛点2 merge extension 的关系

**两个独立 extension**（不合并），理由：
- 触发时机不同（merge 是多分支场景，handoff 是单 session 收尾）
- schema 不同
- 输出去向不同
- 合并会让 extension 状态机复杂

但**共享三件套的实现模式**（setActiveTools + turn_end 事件驱动）。实现时可抽公共的 `lockToolsAndGenerate(pi, schema, instruction, onResult)` 工具函数，两个 extension 各自调用。

### 4.2 核心 API 使用（审查 B2/B3 修正：完整状态机 + 注入点统一）

⚠️ **审查修正**：
- B2：原 spec 用 `currentSoSucceeded` / `latestToolResultDetails` 未定义变量——必须 extension 自己维护（tool_execution_end 累积）。且 structured-output 的 hook 只在 `PI_WORKFLOW_SCHEMA` env 设置时装（`index.ts:221-224`），交互态没装，handoff extension 必须自带
- B3：schema 注入不能同时走 before_agent_start 和 sendUserMessage（重复）。统一走 **sendUserMessage 的 instruction 带 schema**（user message 是 per-turn 的，可靠），before_agent_start 只做轻量"禁止文本输出"约束

```javascript
// xyz-handoff-extension.js
const TOOL_NAME = "structured-output"
const HANDOFF_SCHEMA = { /* §3 的 schema 常量，写死在 extension 顶部 */ }
const MAX_RETRIES = 2

// ── module-level 状态机 ──
let ACTIVE = false
let savedTools = undefined
let soSucceeded = false
let soCallCount = 0
let retryCount = 0
let latestResult = undefined

export default function handoffExtension(pi) {
  // ── 工具结果采集：维护 soSucceeded / latestResult（参照 structured-output index.ts:164-173）──
  pi.on("tool_execution_end", async (event) => {
    if (event.toolName !== TOOL_NAME) return
    soCallCount++
    if (!event.isError) {
      soSucceeded = true
      latestResult = event.result?.details
    }
  })

  // ── 轻约束：禁止文本输出（schema 走 sendUserMessage，不在这里重复）──
  pi.on("before_agent_start", (event) => {
    if (!ACTIVE) return
    return {
      systemPrompt: event.systemPrompt + `
[handoff 模式] 本轮禁止输出文本答案，必须调 structured-output tool。所需上下文已在对话历史中，不要再探索。`
    }
  })

  // ── 状态机核心：turn_end 检测成功/失败/重试 ──
  pi.on("turn_end", async (event) => {
    if (!ACTIVE) return
    if (event.message?.stopReason === "toolUse") return  // 模型还在调工具链

    if (soSucceeded) {
      // 成功 → 恢复工具集 + 回传 handoff 数据
      pi.setActiveTools(savedTools)
      savedTools = undefined
      ACTIVE = false
      pi.sendMessage({ customType: "handoff-result", content: { handoff: latestResult } })
      return
    }

    // 失败 → steer 重试（参照 structured-output index.ts:175-210）
    if (retryCount >= MAX_RETRIES) {
      // 超上限放弃 → 恢复工具集 + 回传错误
      pi.setActiveTools(savedTools)
      savedTools = undefined
      ACTIVE = false
      pi.sendMessage({ customType: "handoff-result", content: { error: "handoff generation failed after retries" } })
      return
    }
    retryCount++
    soCallCount = 0
    const reminder = soCallCount > 0
      ? `[MANDATORY] structured-output 调用失败。正确 schema: ${JSON.stringify(HANDOFF_SCHEMA)}。请重新调用。`
      : `[MANDATORY] 必须调 structured-output tool，schema=${JSON.stringify(HANDOFF_SCHEMA)}。禁止文本输出。`
    pi.sendUserMessage(reminder, { deliverAs: "steer" })
  })

  // ── 兜底：agent_end / session_shutdown 强制恢复（防状态泄漏）──
  pi.on("agent_end", () => {
    // 只在异常路径恢复（正常路径 turn_end 已恢复）
    if (ACTIVE && savedTools) {
      pi.setActiveTools(savedTools)
      savedTools = undefined
      ACTIVE = false
    }
  })

  // ── 入口：handler 立即 return ──
  pi.registerCommand("handoff", {
    handler: async (_args, _ctx) => {
      if (ACTIVE) throw new Error("handoff already in progress")
      ACTIVE = true
      savedTools = pi.getActiveTools()
      soSucceeded = false
      soCallCount = 0
      retryCount = 0
      latestResult = undefined
      pi.setActiveTools([TOOL_NAME])  // B: 锁工具集

      // C: schema 通过 instruction 带（sendUserMessage），不走 before_agent_start 重复
      pi.sendUserMessage(buildHandoffInstruction(HANDOFF_SCHEMA))  // void fire-and-forget
      // handler 立即 return → RPC ack 即时 → runtime 不卡
      // 后续靠 turn_end 事件驱动
    },
  })
}

function buildHandoffInstruction(schema) {
  // schema 通过 user message 传给 LLM，LLM 调 structured-output 时原样作为参数回填
  return `总结当前对话为 handoff 文档。
调用 structured-output tool，schema = ${JSON.stringify(schema)}，data = <按 schema 产出的 handoff>。
不要输出文本答案。`
}
```

**关键修正说明**（含实测发现）：
- **handler 立即 return**（同 merge）：RPC ack 即时发（`rpc-mode.ts:390-411`），runtime 不阻塞。⚠️ `--print` 模式下需用 waitForIdle 等 run 结束（RPC 模式不影响）
- **状态自维护**：soSucceeded/soCallCount/latestResult 由 tool_execution_end 累积（复制 structured-output `index.ts:164-173` 模式，因交互态 structured-output 的 hook 没装）
- **schema 注入统一走 sendUserMessage**：user message 是 per-turn 的，steer 重试时新 instruction 带 schema；before_agent_start 只做轻约束（避免 §4.2 原方案的重复注入问题）
- **structured-output tool 复用**：structured-output extension 已全局注册其 tool（typebox parameters），本 extension 只需 `setActiveTools(["structured-output"])` 锁成只剩它。**不要自己注册同名 tool**（实测：registerTool parameters 必须用 typebox Type.Object，否则被静默过滤）
- **取消能力**（§5 生成中取消）：runtime 调 `SessionService.abort(sessionId)` → pi 收到 abort → agent_end 触发（stopReason="aborted"）→ 上面的 agent_end handler 兜底恢复工具集。⚠️ **此路径 merge 未验证**（verify-merge-extension.cjs 无取消用例）——实现时必须补：触发 handoff 生成中 → 调 abort → 确认 agent_end 触发 → 兜底 handler 执行

### 4.3 runtime ↔ extension 通信（对齐 merge 模式）

- **触发**：runtime 的 handoff-service 调 `client.prompt("/handoff")`（`session-service.ts:550-554` workflowAction 同模式）
- **回传**：extension `pi.sendMessage({customType:"handoff-result", content})` → runtime event-adapter 转 `message.customStart` → event-interpreter 加 `handleHandoffResult` 分支消费（参照 `handleWorkflowResult` L625）。**数据要传到 handoff-service**：经 `EventInterpreterOptions.onHandoffResult` opt 回调（组合根注入），见 §7.3 的接线细节
- 无需 requestId（handoff 单次操作，extension 用 ACTIVE 防重入）

## 5. Key States

| 状态 | 触发 | 用户需看到/感到 |
|---|---|---|
| **handoff 入口** | 当前 session 有内容（≥1 turn） | "handoff 并新开"按钮可见 |
| **生成中** | 点按钮 | loading 态："正在生成 handoff 文档..."（三件套跑 agent loop，可能几秒~十几秒）。**loading 旁有"取消"按钮**（见下方取消能力） |
| **生成中取消**（审查 3-M1） | 用户点"取消" / Esc | runtime 调 `SessionService.abort(sessionId)` → pi 收到 abort → `agent_end{stopReason:"aborted"}` 触发 → §4.2 的 agent_end handler 兜底恢复 SAVED_TOOLS + 清理 ACTIVE；留在当前 session，不新建 |
| **生成失败** | turn_end 重试 2 次仍未调 structured-output | 错误提示 + 重试按钮；工具集恢复 |
| **新建 session 中** | handoff 生成完成 | 短暂 loading："正在开启新 session..." |
| **跳转到新 session** | 新建 + 注入完成 | 自动跳转，新 session 首条是 action-oriented handoff 注入消息（§2），agent 立即执行 nextSteps[0] |
| **源 session 标记**（审查 3-M2） | handoff 完成跳转后 | 源 session 加"已 handoff → [新 session 名]"轻量标记（不是 disabled，可点击跳回），形成 session 间可见链路。避免连续 handoff 后侧栏一堆 session 分不清交接状态 |
| **空 session** | 当前 session 无内容 | 入口 disabled（无内容可 handoff） |

### 5.1 handoff 入口位置（待用户定）

候选：
- (a) PanelHeader 右侧按钮（GitFork/Share 图标）
- (b) message-stream 末尾 action 行（与 fork 按钮同区，加第三个"handoff"按钮）
- (c) 命令面板 / slash command（`/handoff`）

倾向 (a)：handoff 是 session 级操作（不是某条消息的操作），放 PanelHeader 最合适。fork 是 per-message（从某条 assistant fork），handoff 是 per-session（整个 session 交接），位置应区分。

## 6. 视觉规范

| 元素 | 规范 |
|---|---|
| handoff 按钮 | PanelHeader 右侧，Share/Upload 图标，`--muted` → hover `--fg` |
| 生成中 loading | PanelHeader 按钮变 spinner + tooltip "正在生成 handoff..."；或对话流插一条 system notice "正在生成 handoff 文档..." |
| 新 session 首条消息 | 作为 user 气泡，内容是格式化的 handoff markdown，带 "handoff from [源 session 名]" 前缀 |
| 错误 | system notice danger 色（非 banner） |

**handoff markdown 格式**（runtime 把结构化数据格式化）：
```markdown
**Handoff from [源 session 名]**

## Goal
[goal]

## Context
[context]

## Current Progress
### Done
- [x] ...
### In Progress
- [ ] ...
### Blocked
- ...

## Key Decisions
- **[decision]**: [rationale]

## Next Steps
1. ...

## Files Modified
- ...

## Suggested Skills
- ...
```

## 7. 实现锚点（审查 B1 修正：架构分层）

### 7.0 架构分层（关键，审查 B1）

```
前端 PanelHeader 按钮
  → sessionApi.handoff(srcSessionId)         [新加 renderer API，发 ClientMessage]
  → ClientMessage 'session.handoff'
  → session-message-handler.ts 新 case       [runtime WS 路由]
  → handoffService.runHandoff(srcSessionId)  [runtime 层服务，注入 SessionService 依赖]
      ├─ client.prompt("/handoff")           [触发 pi 扩展 slash command，同 workflowAction 先例]
      ├─ 监听 custom_message 'handoff-result' [pi → runtime event-adapter]
      ├─ this.svc.create(srcCwd, label)       [SessionService.create，runtime 直接调，非 sessionApi]
      ├─ this.svc.sendMessage(newId, formatted)[SessionService.sendMessage]
      ├─ persistHandedOff(srcSessionFile, newId)[持久化源 session 标记]
      └─ broker.broadcast({type:'session.handoffComplete', payload:{...}})  [通知前端跳转；须先在 protocol.ts 注册 type，见 §7.3]
  → 前端收到 session.handoffComplete → 跳转到新 session
```

### 7.1 新增文件

- `xyz-handoff-extension.js`（项目根）：registerCommand('handoff') + 三件套（§4.2）
- `packages/runtime/src/services/handoff-service.ts`：runtime 层服务，constructor 注入 `SessionService`（组合根 `packages/runtime/src/index.ts` 实例化），实现 `runHandoff(srcSessionId)` 编排
- `packages/runtime/src/services/handoff-formatter.ts`：纯函数 `formatHandoffToMarkdown(handoff)` + `buildActionOrientedPrompt(handoff)`（JSON → markdown + 前后缀拼装）
- `packages/renderer/src/api/domains/session.ts` 加 `handoff(sessionId)` 函数（发 ClientMessage `session.handoff`）
- `packages/renderer/src/components/panel/PanelHeader.vue`：加 handoff 按钮（Share 图标）+ loading/cancel UI

### 7.2 复用现有（runtime 层 API，非 renderer API）

- `SessionService.create(cwd?, label?, options?)`（session-service.ts:253，委托 `this.lifecycle.create`）：runtime 直接建 session，签名带可选 `cwd/label/options`
- `SessionService.sendMessage(sessionId, content)`（session-service.ts:332，委托 `this.dispatcher.sendMessage`）：runtime 直接发消息，返回 `{blocked, rejected?}`
- `SessionService.abort(sessionId)`（session-service.ts:336，委托 `this.dispatcher.abort`）：取消用（§5 生成中取消）
- `client.prompt("/cmd")` 触发扩展（session-service.ts:550-554 workflowAction / :561-564 subagentAction 先例）。⚠️ `getClient(sessionId)` 返回 undefined 时抛 `Session not active`——**handoff 要求 srcSession 的 pi 进程在内存中存活**（runtime 重启后历史 session 需先 restoreSession 才能调 handoff）
  - **`/handoff` 无 args 匹配已核实**（pi `agent-session.ts:1229-1253` `_tryExecuteExtensionCommand`）：`text="/handoff"` 时 `spaceIndex=-1`，`commandName=text.slice(1)="handoff"`，正确匹配 `registerCommand("handoff", ...)`。`/handoff <args>` 同样匹配（slice 到首个空格）。`prompt(text: string)` 签名为单字符串参数，`client.prompt("/handoff")` 合法
- `broker.broadcast({type, payload})`（session-service.ts 多处先例）

**组合根注入可行性**（核实 `packages/runtime/src/index.ts` 后确认）：
- 现有先例：`GitService`（index.ts:216）和 `FileService`（index.ts:223-231）都在 `sessionService` 创建后（index.ts:198-210）实例化，constructor 接收 `sessionService`，单向依赖（sessionService 不反向引用它们）。`handoffService` 完全同模式——**无循环依赖**
- 注入时机：`sessionService` 在 Phase 2 创建（index.ts:198），`handoffService` 应紧随其后创建（与 `gitService`/`fileService` 同批），最后经 `server.setServices(...)` 或 `session-message-handler` 路由注册（index.ts:254）
- `EventInterpreter` 的 `onHandoffResult` opt 接线见 §7.3——靠 createAdapter closure 的惰性绑定（运行期才调用 closure，届时 handoffService 已赋值，参照 `onContextUpdate` 引用 `sessionService` 的同模式 index.ts:161-167）

### 7.3 改动现有

- **`packages/shared/src/protocol.ts`**（硬缺口，假阳性修正）：`ServerMessageType` 联合类型（L234-285）**不含 `session.handoffComplete`**，直接 `broker.broadcast({type:'session.handoffComplete'})` 会 tsc 编译失败（ServerMessage.type 收窄不到该字面量）。**必须新增**：
  - `ServerMessageType` 联合追加 `| 'session.handoffComplete'`
  - `ServerMessageMap` 追加 payload 类型 `{ srcSessionId: string; newSessionId: string }`
  - 否则 §7.0 的 broker.broadcast 编译不过
- `electron-builder.yml`：extraResources 加第三条 `xyz-handoff-extension.js`（`extension-service.ts:98-99,122-123,261-265` 三处对称加 `handoffExtensionFilePath` 字段 + 初始化 + push）
- `extension-service.getExtensionPaths`：追加（同上三处）
- `postbuild-validate.sh`：加第三段文件存在性校验（136-155 行模式）
- `session-message-handler.ts`：加 case `session.handoff` → handoffService.runHandoff
- `event-interpreter.ts`：加 `handleHandoffResult` 分支消费 custom_message 'handoff-result'（参照 `handleWorkflowResult` L625 / `handleSubagentBgNotify` L575）。**数据传给 handoff-service 需要 opt 接线**（假阳性修正，原 spec 漏说）：
  - `EventInterpreterOptions`（event-interpreter.ts:42-85）加 `onHandoffResult?: (data: { handoff?: unknown; error?: string }) => void` opt
  - 组合根（`packages/runtime/src/index.ts` L146-196 的 `createAdapter` closure）创建 `EventInterpreter` 时注入 `onHandoffResult: (data) => handoffService.handleResult(...)`（参照现有 `onContextUpdate` / `onTurnFinalize` / `onSilentAbort` 的 opt 注入模式）
  - **接线时序坑**：`createAdapter` closure 在 `sessionService` 之前定义（index.ts:143 vs :198），但 closure 只在 session 创建时才被调用（运行期），届时 handoffService 已实例化——参照 `onContextUpdate` 注释（L161 "sessionService is always set by then"）的同模式处理
- `SessionSummary`（shared/session.ts）：加 `handedOffTo?: string` 字段
- **`handedOffTo` 持久化**（假阳性修正，走 JSONL append 不写 sidecar）：新增 `persistHandedOff(filePath, newSessionId)` 于 `session-file-utils.ts`，append 一行 `{type:'handoff_marker', handedOffTo: newSessionId, timestamp}` 到 JSONL。scanner 读 JSONL 时提取最后一个 `handoff_marker` 的 `handedOffTo`（参照 `extractSessionName` 的尾读模式 `session-file-utils.ts:46-51`）。`ScannedSessionMeta`（L272-282）+ `scannedToSummary` 加 `handedOffTo` 字段回填 `SessionSummary.handedOffTo`。

  **为什么走 JSONL 而非 sidecar**（核实代码后修正原 spec 的错误参照）：
  - 原 spec 称"参照 `persistSessionName` 模式写 sidecar"——**错误**。`persistSessionName`（session-file-utils.ts:204）实际是 **JSONL append**（`{type:'session_info', name, timestamp}` + `openSync('a')`），根本不写 sidecar。
  - 而 `persistSessionEnd`（session-file-utils.ts:83-103）写 sidecar 用 `atomicWrite` **整文件覆盖**，meta 内容固定 `{type:'session_end', outcome, reason, timestamp}`。若 `setHandedOff` 也 atomicWrite 写 sidecar，**会覆盖 outcome**（session 终态丢失，done→idle 回退）。
  - JSONL append 是可行且已验证的路径（pi 自己的 `_persist` + runtime 的 `persistSessionName` 都这么写）。pi 不解析 runtime 写的 `session_info` 之外的 entry，`handoff_marker` 不冲突。

## 8. 联动与依赖

| 联动点 | 说明 |
|---|---|
| **→ structured-output extension** | 复用其 tool + Ajv 校验 |
| **→ 痛点2 merge** | 共享三件套架构。痛点2 用 context event（串行多分支），本 spec 用 before_agent_start（单 turn）。可抽公共 lockToolsAndGenerate 工具函数 |
| **→ SessionService.create / sendMessage** | runtime 层直接调（非 renderer 的 sessionApi），handoff-service 注入 SessionService 依赖 |
| **→ handoff skill** | 本方案替代手动 `/skill:handoff` 流程，自动化 + 结构化。suggestedSkills 字段保留但语义转为"建议新 agent 在回复里提及"（新 agent 无法自行加载 skill，见 §10 m5） |
| **→ 架构约定 #11** | 新 extension 走 builtin 文件型 |

## 9. 反模式

- **❌ 自由格式 handoff 文档**：格式不稳定（用户明确指出）。必须用 structured-output + schema
- **❌ handoff 注入用模糊 prompt**（"请基于此继续"）：新 agent 大概率停下不干活（审查 3-C1）。必须用 action-oriented prompt（"立即执行 nextSteps[0]，遇 blocked 停下问我"）
- **❌ suggestedSkills 字段当死字段**：新 agent 无法自行加载 skill（审查 m5）。要么删，要么明确语义为"UI 提示用户启用"或"agent 在回复里提及"
- **❌ fork 当前 session 继续**：违背 handoff 语义（不继承历史）。必须新建空白 session
- **❌ extension 用 newSession 新建**：时序复杂 + 前端状态不同步。新建由 runtime 负责
- **❌ runtime 调 LLM**：违反"LLM 封装在 pi 内部"
- **❌ extension 调 completeSimple**：放弃 pi 基础设施
- **❌ 改 pi 代码**：用户明确否决
- **❌ handoff 生成污染当前 session**：虽然 handoff 对话会留在当前 session，但 setActiveTools 锁工具集后 agent 不会调 read/grep/write，只有 structured-output 调用 + 少量 assistant 文本。可接受（交接本来就要花时间）

## 10. Open Questions

### 用户定
1. **handoff 入口位置**：PanelHeader（倾向）/ message-stream 末尾 / slash command
2. **schema 可自定义**：v1 固定 schema，后续是否支持用户在 settings 配置
3. **handoff 后当前 session 是否标记完成**：倾向不标记（用户可能还想回来），仅新建 session

### 实现时验证
1. **before_agent_start per-run 限制**：痛点2 同问题（`agent-session.ts:1134` per agent run 非 per turn）。handoff 是单 turn，影响小，但需验证 schema 注入生效
2. **新 session 首条 prompt 的 cwd**：复用源 session 的 cwd（`sessionApi.create(srcCwd)`）
3. **handoff 文档太长**：schema 无硬性长度限制，agent 可能产出冗长文档。需在 schema description 或 system prompt 约束"concise"

## 11. 验收 checklist

- [ ] handoff 入口在有内容的 session 可见
- [ ] 点按钮后三件套生成结构化 handoff（loading 态）
- [ ] **LLM 100% 在 pi agent loop 内**
- [ ] handoff 符合 schema（structured-output Ajv 校验）
- [ ] handoff 文档含 goal/context/progress/decisions/nextSteps，**含 currentBlocker（卡点细节）+ filesModified[].changeSummary（文件改动摘要）**（审查 3-C2 扩充）
- [ ] 新建空白 session（不继承历史）
- [ ] **注入 prompt 是 action-oriented**（"立即执行 nextSteps[0]，遇 blocked 停下问我"），新 agent 立即干活不停在"我了解了"（审查 3-C1）。⚠️ 这是**未经行为验证的产品赌注**——需在真实场景实测 agent 是否真执行而非停下确认；若频繁失败考虑退化为"注入后弹 composer 让用户确认首条指令"（见 §2 警告）
- [ ] **生成中可取消**（取消按钮 + Esc，中断 turn + 恢复工具集，审查 3-M1）
- [ ] **源 session 标记"已 handoff → [新 session]"**（handedOffTo 字段 + 侧栏视觉，审查 3-M2）
- [ ] setActiveTools 完成后恢复（try/finally + agent_end + session_shutdown 三重兜底）
- [ ] extension 走 builtin 打包
- [ ] **不改 pi 代码**
- [ ] **runtime 零 pi import**

## 12. 路线图位置

共享三件套架构，与痛点2 平行：

```
基础层（痛点1 §8.1）→ 痛点1 fork 体验
                        ↓
                     基础层就绪
                        ↓
              痛点2 merge（三件套 + structured-output + 贴 composer）
              痛点3 handoff（三件套 + structured-output + 新建空白 session）← 本 spec
```

痛点3 与痛点2 可并行开发（共享三件套模式），不互相依赖。痛点3 不依赖痛点1 的 parentSession/forkEntryId（handoff 总结当前 session 全部，不需要分支血缘）。
