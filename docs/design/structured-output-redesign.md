# structured-output 终态重设计：参数即数据，失败必有界

> **一句话结论**：现行 `{schema, data}` 双参数 envelope 是被 8 个业界主流 agent harness 全体回避的异类设计——它强制模型传一个「传了也没用」的 schema 参数，制造 100% 首调失败与 deepseek 参数撕裂死循环（345 次调用烧 40 分钟）两层事故。终态设计：**workflow 模式下工具的 `parameters` 就是权威 schema 本身（模型参数即 data，「模型永不在 payload 携带 schema」从文案约束升级为结构约束）；失败收敛为有界（同签名校验错误连续 3 次 → 闸门优雅终止子进程，把无上限空转变为秒级快速失败）**；日常模式（模型自愿自报 schema）保留双参数不变。消费者链路（`agent({schema})` → `parsedOutput`）零改动。

- **层声明**：当前层 = extension 技术方案层 → 下一层产物 = 实现单元拆分（§10 U1-U5）+ 代码任务。涉及运行时行为 / 数据流 / 错误处理，层敏感准则（物理数据流图 / 错误恢复指引 / 运行时断言附探针）全适用。
- **证据基线**：本文全部事故证据取自 2026-08-27 碳上生产事故的对抗式核实（session `~/.pi/agent/sessions/--Users-zhushanwen-Stock--/2026-08-27T16-49-36-235Z_01a04420-81eb-78c9-9c00-5b744572cd03.jsonl` T001-T002，下称「事故核实 session」）与 8 项目业界调研（同 session T003，下称「调研 session」）；pi 行为断言全部直读本机实装 `@earendil-works/pi-coding-agent@0.84.2` 与 `pi-agent-core@0.84.2` / `pi-ai@0.84.2` 的 dist 编译 JS（§11 探针清单逐条标注）。

---

## 开篇（SCQA）

- **S（情境）**：`@zhushanwen/pi-structured-output` 是 pi extension 体系的 schema 强制通道——workflow 脚本 `agent({schema})` 声明输出形状，subagent-workflow 经 `PI_WORKFLOW_SCHEMA` env 注入子进程，扩展注册 `structured-output` 工具强制模型以工具调用产出校验过的 JSON，宿主从 `result.details` 提取 `parsedOutput`。股票日报等生产 workflow 依赖此链路。
- **C（冲突）**：2026-08-27 生产事故：deepseek-v4-pro 子进程对 structured-output 发起 **345 次调用**（342 次为字节级相同的「参数撕裂」形态），空转 40 分钟直到外部 pkill。核实发现这不是模型偶发——工具描述、prompt 注入、hook 提醒三方一致告诉模型「只传 `data`」，参数验证层却把 `schema` 设为必填而拦截——**所有模型（glm-5.3 与 deepseek  alike）第一轮 100% 按描述只传 `data`、100% 被拦**。glm-5.3 错 1-2 轮后修复，deepseek 有 1/5 概率修复动作本身撕裂成死循环。
- **Q（问题）**：终态应该长什么样，才能让任何模型都不会被接口误导、且失败无论何种形态都有界？更根本地：为什么我们的接口设计要求模型做一件 8 个业界 harness 无一要求的事（在 payload 里携带 schema）？
- **A（答案）**：向业界收敛形态对齐——workflow 模式合成「单参数工具」：`parameters` = 权威 schema，模型调用参数就是 data 本身（Claude Code / opencode / qwen-code / deepseek-harness 4 家同款）；配 turn 内硬闸门（同签名错误连续 3 次 → 终止子进程快速失败，qwen-code/Claude Code 同款思路）。本文展开这个答案。

---

## 1. 背景：被设计的系统是什么

**本章结论：structured-output 是「workflow 声明形状 → 模型产出数据 → 宿主回收结果」三段链路上的校验关口；本次设计聚焦关口本身（工具定义 + 校验 + 闸门），链路两端（声明 API 与结果回收）不动。**

structured-output 扩展（`extensions/universal/structured-output/`，当前 5.0.2）向 pi 注册一个 `structured-output` 工具。它服务两种场景：

1. **workflow 模式（权威校验）**：workflow 脚本里 `agent({ prompt, schema })` 声明输出形状。subagent-workflow 的 `agent-opts-resolver.ts` 把 schema JSON 字符串经 `PI_WORKFLOW_SCHEMA` env 注入子进程，同时向 system prompt 注入「必须调用 structured-output」指令。扩展在子进程加载时读到 env，注册工具 + turn_end 强制 hook。模型的调用经校验后，结果从 `result.details` 被宿主 `output-collector.ts` 的 `extractParsedOutput` 提取为 `AgentResult.parsedOutput`。**方案 A [HISTORICAL]**：env 里的权威 schema 是唯一校验权威，模型自报的 schema 不参与校验（2026-08-01 事故：ds-flash 重写 schema 自洽通过，4 条修复静默丢失）。
2. **日常模式（自报校验）**：交互式 pi 主 agent（无 env）自愿产出结构化 JSON 时调用同一工具，自己传 `{schema, data}`，扩展用自报 schema 校验。这是主 agent 的 `structured_output` 工具用法（如本文档生成会话所见）。

> **权威 schema** = workflow 脚本作者声明、经 env 注入的 JSON Schema，是 workflow 模式下唯一的校验依据。就是下文 §3.1 例子里 L4-L6 决策那个 17 字段 schema。
> **参数撕裂** = 模型在流式生成深层嵌套 JSON 时丢失层级状态，把内层字段上提到外层的畸形产物。就是 §3.2 失败模式 B 里那个 `{"schema": {...}, "required": [...]}`。

## 2. 设计目标

**本章结论：改造后，workflow 模式下任何模型首次调用即按正确形态传参（结构保证而非文案恳求），任何失败形态都在 ≤4 次调用内收敛为可读错误；日常模式行为不变。**

从使用者（= 调用 `agent({schema})` 的 workflow 脚本作者 / 看 workflow 运行结果的用户）体验倒推：

- **G1 首调即成功**：模型读完任务后第一次调 structured-output 就是正确形态。不存在「按工具描述传参却被参数层拦截」的系统性第一轮浪费（当前 glm-5.3 与 deepseek 均 100% 命中此坑）。
- **G2 失败必有界**：无论模型多弱、schema 多复杂，structured-output 相关的连续失败在同签名错误第 3 次后终止子进程（当前上限 = 无上限，实测 345 次空转 40 分钟），终止原因进日志与调用记录、带恢复指引。
- **G3 接口不自相矛盾**：模型从任何信息源（工具描述 / 工具参数 schema / prompt 注入 / hook 提醒）看到的调用约定都一致——不是靠四处文案对齐维持，而是矛盾在结构上不可能存在。
- **G4 日常模式回归为零**：交互式主 agent 的自报双参数用法行为逐字节不变。

**In-scope**：`extensions/universal/structured-output/`（工具定义、execute、hook、新增闸门）；`extensions/universal/subagent-workflow/` 内三处 prompt 文案（`agent-opts-resolver.ts` 注入段、`session-runner.ts` 的 `formatSchemaInstruction`、hook reminder 文案口径）。
**Out-of-scope**：pi 上游（[MANDATORY] 不改）；`agent({schema})` API 与 `parsedOutput` 回收链路（零改动是设计约束）；emulated 引擎的 schema 仿真层（`schema-emulation.ts` 服务 zcode 等无 native 链路的引擎，与 pi 链路硬分流，不动）；workflow 侧 schema 扁平化改造（L4-L6 的 17 字段深嵌套是独立的工作量，调研方案 4，可后续单做）；maxTurns 兜底（workflow 层既有议题，不因本设计取消）。

## 3. 现状：使用者眼里是什么样的

**本章结论：模型眼中的现状 = 三处文案齐声说「只传 data」+ 参数 schema 默默要求「schema 必填」；这个矛盾让每个模型第一轮必错，把 deepseek 类模型逼上「被迫生成巨型双参数 JSON」的钢丝，1/5 概率摔成无上限死循环。**

### 3.1 现状的真实样子

以生产在用的股票日报 L4-L6 决策为例（事故核实 session 的真实负载）：workflow 对每只股票派一个分析 subagent，`schema` 要求 17 个字段（`overall_direction` / `action`（枚举：建仓/加仓/持有不动/减仓/清仓/立即止损/观望）/ `assessments` 数组套对象 / ...）。

模型在子进程里看到的四方信息（全部取自当前代码，未编造）：

**① 工具 description**（`tool-definition.ts`）：

> "When the schema is system-enforced (workflow mode), pass ONLY `data` — the `schema` parameter is ignored (the system validates `data` against the authoritative schema)."

**② prompt 注入段**（`agent-opts-resolver.ts`，拼进 system prompt）：

> "The schema is enforced by the system (PI_WORKFLOW_SCHEMA). You only pass `data` — do NOT pass a `schema` parameter."
> "- Call structured-output with ONLY the `data` parameter. The system validates it against the schema above automatically."

**③ hook 重试提醒**（`workflow-hook.ts`，模型调错被 steer 时看到）：

> "The schema is enforced by the system (PI_WORKFLOW_SCHEMA) — do NOT pass your own `schema` parameter."
> "Call the structured-output tool AGAIN with ONLY the `data` parameter conforming to this schema."

**④ 工具参数 schema**（模型在工具清单里看到的 `parameters`，`tool-definition.ts`）：

```ts
parameters: Type.Object({
  schema: Type.Unknown({ description: "JSON Schema draft-07 object. ..." }),
  data: Type.Unknown({ description: "The value to validate against schema. ..." }),
})
```

typebox 的 `Type.Object` 默认全部属性必填——即④说「`schema` **必填**」，与①②③的「只传 `data`」正好相反。pi-ai 的 `validateToolArguments`（execute 之前的参数层）按④校验：只传 `data` → 抛 `Validation failed for tool "structured-output": - schema: must have required properties schema`（typebox 措辞；事故 session 回显截断于 "schema: must have re…”，探针实测同族措辞补全）。

而 execute 内部（`execute.ts` 权威分支）：模型千辛万苦传进来的 `schema` **不参与校验**，仅供错误回显。即现状强制模型传一个「传了也没用」的参数。

### 3.2 怎么出错

**失败模式 A：首调系统性被拦（100% 命中，所有模型）**。模型读①②③后第一轮只传 `data`（正确理解），被④拦下。事故核实 session 的跨模型证据：

```
8/24 glm-5.3 批次:   [只传data]→被拦→[data+schema]→成功   ×2
                     [只传data]→被拦→[只传data]→被拦→[data+schema]→成功  ×1（错 2 轮才修复）
8/27 deepseek 批次:  [只传data]→被拦→[data+schema]→成功   ×4
                     [只传data]→被拦→撕裂×342              ×1（失败模式 B）
```

**失败模式 B：参数撕裂 → 无上限死循环（deepseek 1/5 概率，单次事故烧 40 分钟）**。被拦后模型被迫在第二轮同时生成「大 schema（17 字段深嵌套）+ 大 data（10+ 条 assessments）」的双参数巨型 JSON。撕裂产物解剖（342 次调用逐字节相同，各 1439 字符）：

```json
{
  "schema": {
    "type": "object",
    "properties": { /* 前 9 个字段，正确嵌套 */ },
    "overall_direction": {"type": "string"},   ← schema 后 8 个字段被摊平到上一层
    "action": {"type": "string", "enum": ["建仓", ...]}
  },
  "required": ["code", "action", ...]          ← schema.required 被撕到 arguments 顶层
                                               ← data 整个消失
}
```

模型意图完全正确（混入字段的值是 schema 片段，它在努力重建权威 schema），但自回归生成在 properties 第 9 个字段后丢了「我在哪一层」。撕裂产物进上下文后锚定复读 342 次——thinking 每轮正确诊断（"I keep making the same mistake"），toolCall 却逐字节重复。

**为什么没有任何闸门拦住它**：turn 内自循环期间 `stopReason="toolUse"`，`workflow-hook.ts` 的 turn_end hook 直接 `return`（设计如此：模型还在调工具链不干预）；hook 上限 `MAX_HOOK_RETRIES=2` 只覆盖 turn_end 注入，管不到 turn 内。死循环 session 里 user 消息全程只有 1 条（任务 prompt）——hook 从未介入。`agent()` 未设 maxTurns → turn-limiter 禁用；watchdog 按 10 turns 估算 50 分钟才 SIGTERM。四层防线全部落空。

### 3.3 业界对照：这是异类设计

调研 session 深调 8 个有 structured-output 实现的 agent harness（codex-cli / Claude Code / opencode-anomaly / qwen-code / deepseek-harness / kimi-code / hermes-agent / openclaw），结论：

1. **8/8：schema 由调用方/harness 持有；0/8：让模型生成或回传 schema**。无一例外。模型侧只有三种安全形态：API 约束解码（codex/kimi，schema 是请求参数）；合成工具、参数即 data（Claude Code/opencode/qwen-code/deepseek-harness）；裸 JSON 文本 + 事后校验（hermes/openclaw）。三条路线殊途同归：**模型永不在 payload 里携带 schema**。
2. **闸门是标配**：Claude Code 重试 5 次硬上限后终止会话；qwen-code 同一 (tool, errorMessage) 连续 3 次 → RETRY LOOP DETECTED 强制换策略 + `--max-session-turns` 兜底；deepseek-harness「正常结束却没调用 → 硬错误返回，不做 re-prompt」。
3. **对模型 JSON 弱点的防护靠收窄与预修复，不靠逼模型重生成更大的 JSON**：deepseek-harness 强制 schema 扁平子集（禁 $ref/anyOf/深嵌套，不支持的关键字直接拒绝）；qwen-code 校验前做四遍类型修复。

我们的双参数 envelope 在三件事上全是孤例：让模型带 schema、无 turn 内闸门、修复路径要求模型生成更大的 JSON。

## 4. 根因 + 物理数据流

**本章结论：症状的共同根因是「双参数 envelope」这一个接口形态——它同时制造了①矛盾文案（描述 vs 必填）、②危险动作（被迫生成巨型双参数 JSON）、③第二校验权威隐患（模型 schema 必须被显式忽略才安全）。闸门缺口是独立第二根因。**

```
磁盘/配置层                          子进程（模型眼前）                     校验层
─────────────────────────────────────────────────────────────────────────────────
workflow 脚本 agent({schema})
  └─ orchestration/models/types.ts
        │ schema: Record<string,unknown>
        ▼
agent-opts-resolver.ts                system prompt 注入段：
  ① stringifySchemaCached(schema) ──►  "You only pass `data` — do NOT pass a `schema`"
  ② schemaEnv = 同一串
        │
        ▼ spawn (runSpawn → applySchemaEnvToChildEnv)
childEnv[PI_WORKFLOW_SCHEMA] ───────► structured-output 扩展加载（index.ts）
                                         ├─ registerTool(createToolDefinition())
                                         │     parameters = Type.Object({schema, data})  ← 双双必填
                                         │     description = "pass ONLY data"            ← 与上一行矛盾
                                         └─ setupWorkflowHook(pi, schemaEnv)              ← 只管 turn_end
        │ 模型调 structured-output({data})（按描述的正确形态）
        ▼
pi-ai validateToolArguments（execute 之前的参数层）
        └─ ✗ "must have required property 'schema'" ──► toolResult isError ──► 模型读错误自驱重试
                                                                                  ↑ 此环路无任何闸门
        │ （第二轮传 {schema, data}，或撕裂）
        ▼ 参数层通过后
execute.ts 权威分支：仅 env schema 参与校验（模型的 schema 被忽略，仅错误回显）
        │
        ▼ result.details = data
output-collector.ts extractParsedOutput ──► AgentResult.parsedOutput ──► workflow 脚本
```

根因分层（责任归属，承事故核实 session 结论并收紧）：

- **R1 接口形态错（根因，可修）**：双参数 envelope 要求模型携带 schema；workflow 模式下该参数又不参与校验。三处文案只能与参数 schema 打架——矛盾是形态的必然产物，不是文案没写好。
- **R2 turn 内闸门缺位（独立根因，可修）**：hook 管 turn_end、limiter 管 maxTurns、watchdog 管墙钟——唯独「同一错误在 turn 内无限重复」无人认领。业界（qwen-code/Claude Code）证明这层闸门必须存在。
- **R3 模型层级跟踪弱点（放大器，不可修只能绕过）**：深层嵌套流式生成丢层级是当代 LLM 已知弱区。绕过方式 = 不让模型生成巨型双参数 JSON（R1 修复后该动作消失），而非期待模型变强。

## 5. 终态：使用者眼里将是什么样的

**本章结论：workflow 模式下，模型看到的工具 `parameters` 就是权威 schema 本身——「传什么」由工具定义自描述，不再需要任何「不要传 schema」的警告；失败时第 4 次调用被硬拦，workflow 层收到带指引的失败而非 40 分钟空转。**

### 5.1 成功路径（§3.1 同一 L4-L6 例子的终态）

workflow 脚本不变：`agent({ prompt: "你是L4-L6决策专家...", schema: <17 字段 schema> })`。

子进程内模型看到的工具清单（`parameters` = 权威 schema，逐字段 description 直接成为模型可见的字段说明）：

```
structured-output — Return the structured result for this task.
parameters: {
  type: "object",
  properties: {
    overall_direction: { type: "string", description: "..." },
    action: { type: "string", enum: ["建仓","加仓","持有不动","减仓","清仓","立即止损","观望"] },
    assessments: { type: "array", items: { type: "object", properties: {...} } },
    ...
  },
  "required": ["code","action",...],
  "additionalProperties": false   ← D4：根级注入（作者 schema 未显式声明时），见 §6.4
}
```

交互样例：

```
[模型] 分析完成，调用 structured-output({
        overall_direction: "...", action: "持有不动", assessments: [...], ... })
        ↑ 参数即 data。模型习惯携带的 `schema` 字段被根级 additionalProperties:false 显式
          拒绝（参数层报错、模型自修正）——「不带 schema」从文案恳求变为结构约束
[pi-ai 参数层] 按权威 schema 校验（自带类型矫正：字符串 "42"→42、可选 null 归一等）
[execute] 透传已校验参数 → result.details = data
[宿主] extractParsedOutput → AgentResult.parsedOutput → workflow 脚本照常消费
```

首调即成功（G1）；「不要传 schema」类警告从全部文案中删除——不是对齐了，是**结构上不可能传**（G3）。

### 5.2 失败路径（带恢复指引）

**失败形态 a：data 不合权威 schema（如缺必填字段）**——模型收到 pi-ai 参数层原生错误：

```
Validation failed for tool "structured-output":
  - assessments.0.impact: must be string

Received arguments: {...}
```

错误文本由 pi-ai 内部格式化，参数层失败不经过任何可改写文案的扩展 hook——故恢复指引静态携带在工具 description 里（「校验失败时按工具参数 schema 修正后重试」）。错误本身已含具体字段路径与实参回显，模型按工具 schema 自修正重试，无需外部信息源。

**失败形态 b：同签名校验错误连续 3 次（模型陷入重复失败——事故形态 B 的终态版本）**——闸门在 `tool_execution_end` 事件上计数，第 3 次同签名失败到达时进入 bounded teardown 链：`ctx.abort()` 截断当前 turn 的 token 燃烧（实测 ~25s 窗口）→ `ctx.shutdown()` 优雅终止子进程（单用途 workflow 子进程，退出即终态）→ 15s 兜底硬退 timer（覆盖 pi 挂死不 settle 的异常态；链路依据见 §6.3 v4 补记）。workflow 作者看到的：

```
（子进程 stderr → pi-<date>-<sessionId>.jsonl tee / 扩展日志）
[structured-output gate] Terminated: the same validation error occurred 3 times
consecutively; shutting down this single-purpose workflow subprocess.
Last error: assessments.0.impact: must be string
👉 (workflow 作者) 检查 workflow 脚本的 outputSchema 是否过苛（深嵌套/超长 required），
   或更换更强模型后重跑该步骤。

（AgentResult）success=false，parsedOutput=undefined，error 带确定性失败前缀（`Structured output failed deterministically:`——宿主 `executeAgentCall` 据此短路重试：不可满足 schema 重试必同结果，见 §7 补记）；3 次校验错误保留在 toolCalls 供检视
```

子进程退出 → session-runner 走现有「子进程结束但未产出 structured-output」失败路径（与 hook 重试放弃同一路径，消费者零改动）。单次失败成本 = 3 次调用 ≈ 十几秒，而非 345 次 ≈ 40 分钟（G2）。

**失败形态 c：模型从未调用工具（直接文本作答）**——turn_end hook steer（保留现状，上限 2 次）；2 次后放弃，子进程结束，workflow 层判失败（与 deepseek-harness「不调用→硬错误」语义对齐）。

**失败形态 d（workflow 作者角度）：env 里的权威 schema 本身非法**（keyword-less / boolean true）——子进程加载时 fail-fast，错误指回 workflow 脚本的 `schema` 定义（现有防御保留，见 §7）。

## 6. 关键决策与权衡

**本章结论：5 个决策共同把现状变成终态——D1 双模式物理分岔（workflow 单参数 / 日常双参数）、D2 execute 透传不做第二校验、D3 闸门计数 + shutdown 硬终止、D4 根级 additionalProperties:false 堵污染、D5 文案与测试收敛。D1 的方案对比见下表。**

### 6.1 D1：workflow 模式合成单参数工具（选定）

- **采用**：扩展加载时读 `PI_WORKFLOW_SCHEMA`；存在则注册 workflow 变体——`parameters` = 权威 schema（非 object 根包装为 `{value: <schema>}`，execute 解包），description 只讲「返回本任务的结构化结果」。模型的 tool call arguments 就是 data，pi-ai 参数层按此 schema 校验（含自带类型矫正）。
- **被否**：见下方对比表 B/C/D。
- **证据**：业界 4/8 同款（Claude Code 合成工具 `inputJSONSchema`=用户 schema、opencode 单参数 + toolChoice、qwen-code 参数即 data、deepseek-harness 参数即 data）；pi-ai `validateToolArguments` 支持非 typebox 普通 JSON schema 作 parameters（`pi-ai/dist/utils/validation.js` 的 `TYPEBOX_KIND` 分支）且 execute 收到的是校验+矫正后的值（`pi-agent-core/dist/agent-loop.js`：`validateToolArguments` → `prepared.args` → `tool.execute(id, prepared.args)`）——均已直读 dist 证实（§11 P1/P2/P4；校验链已登记 PS-20）。
- **效果**：G1（首调即成功：参数 schema 自描述，无文案可矛盾）、G3（矛盾 by construction 消除）、R3 绕过（模型不再被迫生成巨型双参数 JSON，撕裂土壤消失）。

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|---|---|---|---|---|
| **A. 合成单参数工具（选定）** | ✅ 业界主流形态；「模型不携带 schema」结构保证；免费获得 pi-ai 参数层类型矫正（等效 qwen-code 四遍修复） | 中：工具定义分岔 + execute 简化 + 闸门 + 四处文案 + 测试重写（§10 U1-U5） | parameters 动态化依赖 pi 实装行为（P5 探针兜底）；非 object 根 schema 需包装（P6） | ✅ |
| B. 最小补丁：schema 参数改 `Type.Optional` | ❌ 双参数 envelope 仍是业界孤例；模型仍可传 schema（Optional 不禁止），巨型双参数 JSON 的危险动作保留 | 低：一行 + 文案对齐 | 高：根因未除。事故核实 session 已证明撕裂发生在「修复第一轮失败」的动作里——Optional 只让第一轮不报错，模型一旦传 schema 仍走钢丝 | ❌ |
| C. 弃工具，改 prompt 注入 + 裸 JSON 提取（hermes/openclaw 路线） | ⚠️ 业界 2/8，但失了工具协议层保护：文本提取靠容错解析，pi-ai 参数层矫正随之丧失 | 高：除扩展重写外，`output-collector.ts`（从 details 提取改为从文本提取）与 host 链路全改——违反「消费者零改动」约束 | 对弱模型更脆弱（markdown 围栏/前后废话）；emulated 引擎已走此路（schema-emulation.ts），pi 链路无需降级到此 | ❌ |
| D. API 原生约束解码（codex/kimi 路线） | ✅ 理论上最优（服务端保证合法，非法结构不可能产生） | 不可行：需要 pi 的请求构造层支持 `response_format`，[MANDATORY] 不改 pi | 无（不可行即排除） | ❌（列为演进方向：pi 若未来开放 response_format，workflow 模式可再升级为约束解码，工具层语义不变） |

**被否若用**：B 若用，§3.2 失败模式 A 消失但 B 保留——deepseek 第二轮传撕裂的 `{schema, data}` 时，schema 字段 Optional 照收、data 照样丢，死循环以「参数通过但 data 不合权威 schema」的新形态复发。C 若用，§5.1 例子里 17 字段嵌套 JSON 要靠文本尾提取，glm-5.3-flash 级模型在 markdown 围栏/解释性前缀上的失败率显著高于工具协议层，且 workflow 作者失去参数层类型矫正。

### 6.2 D2：execute 透传，不做第二校验（选定）

- **采用**：workflow 变体的 execute 把收到的（已校验+矫正的）arguments 直接作为 `details` 透传。execute 内的权威分支 ajv 校验删除。
- **被否**：execute 内保留权威 ajv 复核（「双保险」）。
- **引擎差异（如实记录）**：workflow 模式的校验引擎随之从 ajv（strict:false，draft-07）换成 pi-ai 参数层的 TypeBox Compile。「同一份 schema」不等于「同一套校验语义」：实测 TypeBox 强制 const/pattern/minLength/oneOf/$ref 等关键字的执行面与 ajv strict:false 存在理论差；`format` 关键字两侧均不强制（现有 `ajv-validator.ts` 未注册 ajv-formats）。迁移风险由 P8 探针兜底（生产 schema 集合在 TypeBox 下编译 + 关键字强制抽查），并纳入 S1 检查项。
- **证据**：pi-ai 参数层与 execute 用的是**同一份**权威 schema——execute 再 ajv 不是双保险，是第二校验权威，正是方案 A [HISTORICAL]（2026-08-01 校验自报 schema 致修复静默丢失）与 schema-emulation.ts 头注 D4 明令禁止的形态（「宿主侧再叠一层 ajv 会制造第二校验权威」）。准则「减法优先」：砍掉后 execute 在 workflow 模式只剩透传 + 非 object 根解包。
- **效果**：G3 的一部分（单一校验权威 = pi-ai 参数层）；§5.1 中 details 与参数层校验结果严格一致，不存在「参数层过了 execute 又拒」的双层漂移。

### 6.3 D3：turn 内硬闸门——`tool_execution_end` 同签名计数 → `pi.shutdown()`（选定）

- **采用**：扩展新增闸门模块，监听 `tool_execution_end` 累积 structured-output 的连续失败（按错误签名归一：取校验错误行、剔除 arguments 回显——同签名 = 模型无进展；签名变化 = 模型在推进，计数清零）。连续同签名达 3 次进入 terminal 态：闸门写日志（含 §5.2 形态 b 指引）后调 `pi.shutdown()` 优雅终止子进程；turn_end hook 与 terminal 态互斥（进程已死，无需也不再有 steer）。
- **被否**：① **execute 内计数**——不可行：参数层失败（事故中 342/345 的形态）在 execute 之前被 pi-ai 拦下，execute 根本不被调用；② **`tool_call` 事件 `block+terminate`**——初稿方案，结构性不可达：extension 的 `tool_call` 事件接线为 `beforeToolCall`（`pi-coding-agent/dist/core/agent-session.js` `_installAgentToolHooks`），而 agent-loop 的执行顺序是 `validateToolArguments` → `beforeToolCall`（`pi-agent-core/dist/agent-loop.js:404→405`，登记 PS-20），参数校验抛错走 immediate error 路径，**beforeToolCall 对该类失败永不被调用**——闸门对其全部目标失败形态拦不到（与被否①是同一时序推理）；③ **只做 steer 软提醒**（qwen-code RETRY LOOP DETECTED 形态）——软提醒依赖模型配合，事故已证明上下文锚定下模型 thinking 正确但 toolCall 照发，必须硬终止；④ **`pi.abort()`**——中止当前 agent 操作但子进程驻留等下一条命令，spawn 模式 workflow 无人再发命令 → 空转到 watchdog，不是快速失败。
- **证据**：`tool_execution_end` 对 immediate（参数层失败）结果照常触发（`agent-loop.js` sequential 与 parallel 两条路径的 immediate 分支均 `emitToolExecutionEnd`）——计数通道覆盖目标失败形态；`ExtensionContext` 提供 `abort()` 与 `shutdown()`（`pi-coding-agent/dist/core/extensions/types.d.ts`："Gracefully shutdown pi and exit. Available in all contexts."）。以上均直读 dist 证实（§11 P3）；shutdown 后父进程侧终态呈现（session-runner 对 mid-turn 退出的解释）留 P7' 探针。阈值 3 对齐 qwen-code（Claude Code 为 5；workflow 子进程是单用途短会话，更快失败更省）。
- **效果**：G2（同签名失败第 3 次后进程终止，有界且与模型配合度无关）；§3.2 失败模式 B 若再现，3 次调用内收场。shutdown 前无「第 4 次调用」——计数即终止，不给锚定复读留第 4 次机会。
- **诚实边界**：闸门终止的是「同签名无进展」这一种循环形态；签名不断变化的长尾低效（模型每轮犯不同错）不触发闸门，仍由 workflow 层 maxTurns 兜底——分层职责显式化，不虚构闸门覆盖一切循环。

**v4 补记（R3-R6 审计演进）**——签名归一化与 terminal 动作在实施后四轮审计中演进，语义如下（源码 `loop-gate.ts` 注释为权威细化）：

- **签名归一化：token 分桶哈希的四步演进**。v3 定义的「取校验错误行、剔除实参回显」在实施中细化为「错误行字段/路径 token 集合排序哈希」（`fields(<n>)#<fnv1a>`；修好排序靠后字段时消息前缀不变，纯前缀口径会把渐进修复折叠成同签名误杀；required message 需解析完整缺失字段列表——pi-ai bullet 路径位只含 requiredProperties[0]）。此后三步：
  1. **R3：AP keys 并入**——AP（D4 注入 `additionalProperties:false`）错误行无字段名（路径位恒 root），模型逐个删多余字段是真实进展却签名恒定；修法是把实参回显段（`Received arguments:` 后可 JSON.parse）的顶层 keys 并入 token——keys 是结构不是值：keys 缩小 = 删字段 = 进展，值变化（keys 不变）仍不算进展。
  2. **R4：并集恒定陷阱（实测误杀）**——keys 无条件并入后，required 渐进修复场景下字段从缺失列表「迁移」到回显 keys，缺失 token 集缩小恰被 keys 集增大抵消，并集恒定 → 签名恒定 → 3 次误杀（探针复现：6 required 字段每轮修 1 个，三轮签名恒 `fields(6)`）。修法：keys 改挂 **AP 桶**（`key:` 前缀）且**仅当错误行块含 AP 错误行时**才并入——required/格式类错误行天然携带字段名，进展由常规桶 token 独家刻画，keys 并入反而制造对流失衡；AP 错误行的 keys 是其唯一进展信号，机制保留。共享文本原语同轮下沉零依赖 `text-primitives.ts`（破 loop-gate ↔ workflow-hook import 环）。
  3. **R6：嵌套 AP 路径下钻 + marker 精确化**——AP 错误行解析路径位（pi-ai `formatValidationPath` 点分：root / a / a.b / list.0），keys 按路径下钻取**该层** keys 而非顶层（嵌套场景顶层 keys 恒不变会误杀），token 形态 `key:<path>:<name>`——路径限定防兄弟 AP 层同名 key 跨层折叠；下钻中断（路径不存在/非容器）安全降级不贡献 token。AP 行检测从 `/additional propert/i` 子串改为**行级固定后缀精确匹配**（`<path>: must not have additional properties`）——字段名恰含该字样的非 AP 错误不再伪触发 keys 分桶（漏杀方向风险）。
- **terminal 动作：bounded teardown 链（R6）**。v3 的「调 `pi.shutdown()` 优雅终止」在实测暴露燃烧窗口：shutdown 是请求语义（RPC mode 在 `agent_settled` 后才 exit），请求后当前 turn 的工具执行/流式生成继续跑——实测 ~25s 模型 token 白烧。终态链：`ctx.abort()`（止燃）→ `ctx.shutdown()`（优雅退出）→ 15s 兜底硬退 timer（`unref` + terminal 路径幂等 clear；delay 为字面量常量、处 Node setTimeout 安全域；exit code 1，避开 SW 侧信号终止阈值）。实装依据：pi 0.84.1 `ExtensionContext` 仅有 `abort()`/`shutdown()`，无子进程句柄/信号 API（types.d.ts + runner.js 直读核实）。**与被否④的关系**：被否的是 abort **单独**作终止手段（子进程驻留空转到 watchdog）；abort 叠加在 shutdown 之前专司止燃，二者互补，非翻案。

### 6.4 D4：根级 `additionalProperties:false` 注入——堵输出污染（选定）

- **采用**：合成 workflow 工具 parameters 时，若作者 schema 根级**未声明** `additionalProperties`，注入 `false`；作者显式声明的（含 `true` 或子 schema）尊重不动。嵌套层级的宽严完全由作者 schema 自治。
- **被否**：① **execute 内按 properties 白名单剥离多余字段**——可行（属输出规范化而非第二校验权威），但静默丢弃模型产出且不给反馈，模型无从修正携带 schema 的习惯；参数层显式拒绝（模型收到 `must not have additional properties` 后自修正）是反馈闭环，优于静默规范化；② **递归全层级强制 false**——越权改写作者 schema 语义，嵌套对象允许扩展可能是作者本意；③ **不处理**（初稿状态）——审查实测：未声明时多余字段通过校验并整包流入 `details`→`parsedOutput`。旧双参数设计把模型携带的 schema 隔离在 envelope 专用参数里（被忽略、data 干净）；单参数后该习惯直接污染 workflow 输出契约——事故已证明 deepseek 类模型有强烈的携带 schema 倾向（342 次撕裂产物全是重建 schema 的尝试），此洞必须堵。
- **证据**：审查探针实测——权威 schema 未声明 `additionalProperties` 时 `{name, age, schema:{...}}` 校验通过且整包成为 args；声明 `false` 后多余字段被正确拒绝（`must not have additional properties`）。
- **效果**：G3 闭环（「不带 schema」成为结构约束而非文案恳求）；S5 验收断言由「多塞字段不影响提取」（把污染固化为准行）改为「多塞字段被拒绝、重试后 `parsedOutput` 不含声明外顶层字段」。

### 6.5 D5：日常模式保留双参数，两变体物理分岔（选定）

- **采用**：无 env 时注册的日常变体保持现状（双参数自报 + 全部防御链：互换检测 / keyword-less 拒绝 / 编译校验），行为逐字节不变；仅 description 中 workflow 相关一句移到 workflow 变体。两个变体在 `tool-definition.ts` 内分函数定义，加载时按 env 二选一（同名 `structured-output`）。
- **被否**：日常模式也改单形态（如 prompt 注入 + 文本提取）。
- **证据**：日常模式没有外部权威 schema，模型的 schema 只能自报——这不是缺陷而是该场景的语义本身；事故现场全部在 workflow 模式。业界「0/8 让模型携带 schema」针对的是**强制场景**（host 持有形状），不否定自愿自校验场景。改动日常模式 = 为没出事故的地方引入回归风险。
- **效果**：G4（回归为零）；两变体各自自洽（G3 覆盖到文案层）。

## 7. 实现机制（把终态落到代码层）

**本章结论：改动集中于 structured-output 扩展内部 5 个文件 + subagent-workflow 两处文案；消费者链路（output-collector / AgentResult / workflow 脚本 API）零改动。**

**`extensions/universal/structured-output/`**：

1. `tool-definition.ts`：拆为 `createWorkflowToolDefinition(authoritativeSchema)` 与 `createDailyToolDefinition()`。workflow 变体：`parameters` = 权威 schema（object 根直接用；非 object 根包装 `{type:"object", properties:{value:<schema>}, required:["value"], additionalProperties:false}`）；根级 `additionalProperties` 未声明时注入 `false`（D4）；description 重写为单参数口径（「Return the structured result for this task. Your arguments ARE the data; they are validated against this schema.」+ 静态失败重试指引——参数层错误文案无扩展改写通道，指引只能前置携带，见 §5.2 形态 a）。权威 schema 在**加载时**做现有防御（keyword-less 拒绝——现 `validateWithAuthoritative`；boolean true 拦截——现 `executeStructuredOutput` 的 ERR-7 段——两项一并上移到注册期，fail-fast 于子进程启动）。
2. `execute.ts`：workflow 分支简化为透传（非 object 根解包 `value`）；日常分支 `validateAgainstSelfReported` 防御链原样保留。
3. `loop-gate.ts`（新增）：闸门状态机（同签名计数 / terminal 判定 / 计数清零规则）+ 错误签名归一化函数 + terminal 时写日志并调 `pi.shutdown()`。
4. `workflow-hook.ts`：RetryState 增 terminal 态——terminal 时 turn_end 不 steer（防御性保留：shutdown 正常生效时进程已终止，此分支仅是 shutdown 失败路径下的保险）；「完全没调用」的 steer 保留（上限 2 不变）；两分支的 steer 文案同步重写为单参数口径（删除「do NOT pass your own `schema` parameter / with ONLY the `data` parameter」——按 §5.1「警告从全部文案删除」，一致性审查发现本条初版漏列，v3 补）。
5. `index.ts`：装配分岔——读 env → 注册对应工具变体；workflow 模式额外注册闸门（`tool_execution_end` 计数 + shutdown 终止）+ turn_end hook。

**`extensions/universal/subagent-workflow/`（v3 原案：仅文案，不动逻辑；R3 起演进超出原案，见下方补记）**：

6. `agent-opts-resolver.ts` 注入段、`session-runner.ts` `formatSchemaInstruction`：删除「do NOT pass a `schema` parameter」类警告，保留「必须调用工具、参数即 data」的要求。

**显式不改**：`output-collector.ts`（仍按工具名取 `result.details`；R3 起新增失败归因逻辑，见下方补记 A）；`PI_WORKFLOW_SCHEMA` env 契约（两包隐式契约字面量不变；R6 起有跨包契约测试锁字节相等，见补记 C）；`agent({schema})` API；`mandatory-extensions.json`。

### 实施后审计演进（R3-R6 → v4 补记）

M1/M2 落地后四轮对抗式审计（R3 `f69766b44` → R4 `9438940c0` → R5 `1dfd93b1a` → R6 `3f934637c`）对「失败必有界」（G2）做了递进修复，其中两轮是**对上轮修复本身的回归修复**（R4 修 R3 签名算法的并集恒定误杀、R5 修 R3 失败表面化引入的 retry 放大——方法论沉淀见 TEST-STRATEGY.md「修复后验证纪律」节）。签名分桶与 teardown 的演进已记 §6.3 v4 补记；本节回写 SW 侧与其余语义：

**A. 失败表面化全链路（R3 → R4 → R5）**。「gate 终止的 run 被报告 completed 且 parsedOutput={}」的静默吞没修复是一条三层链，逐轮补齐：

1. **R3（isError 跳过 + 三态归因）**：`extractParsedOutput` 跳过 `isError:true` 的调用（pi 失败路径 details 默认 `{}`，当 parsedOutput 会让失败 run 静默 completed）；schemaExpected 而 run 结束无有效 parsedOutput 时置 `success=false` 并写三态归因（优先级：校验失败 w/ last error > 从未调用 SO tool > 调用过但无 details），error 经 AgentResult 逐层传播。
2. **R4（归因文本防误诊 + 失败分类）**：归因动态段（模型/provider 原始错误文本）可含 `STALE_CONTEXT_PATTERNS` 命中词（"aborted" 等）→ 被 SW 重试分诊误诊为 stale-context；修法：动态段先截断后中和（命中词替换 `[redacted]`），固定前缀静态无命中（测试锁定）。同轮把失败原因按实际内容分类（`schema validation` vs `execution failure`，锚点为 SO 侧校验失败固定文案前缀）——isError 只说明调用失败，硬编码校验语义会误导排障。
3. **R5（确定性失败不重试矩阵）**：三态归因的 error 恰好落入 `executeAgentCall` 的 retryable 分支——不可满足 schema 重试必同结果，实测放大 3×（attempts=3、4 个子进程、235s vs 修复前 67s，每轮含 ~25s gate teardown 窗口）。修法（可重试性矩阵，标记前缀 SSOT 在 `execute-agent-call.ts` 的 `DETERMINISTIC_SCHEMA_FAILURE_PREFIX`）：

   | 归因态 | 带确定性标记 | 可重试性 | 理由 |
   |---|---|---|---|
   | ① 从未调用 SO tool | 是 | 不可重试 | 缺 extension 是环境确定性（安装盲区），同环境重试必同结果 |
   | ② SO 调用 isError（gate 终止/不可满足 schema/provider 错误） | 是 | 不可重试 | 同 schema 重试必同结果；实测回归即此态循环烧钱 |
   | ③ 调用过但无 details | 否 | 可重试 | 可能瞬态（提取/序列化异常），保留既有重试语义 |

   标记词与 `STALE_CONTEXT_PATTERNS` 逐字核对不命中（虽同样不重试，但归因语义不被污染）；`executeAgentCall` 对标记前缀与 stale-context 同构短路。注：态② 含 execution failure（provider 瞬态）也不重试——isError 态整体从重试面摘除，瞬态恢复交由上层 workflow 编排。
4. **R4（exit(0)-no-terminal worker 兜底）**：workflow 返回值不可结构化克隆时 worker 侧 `DataCloneError` 被吞 → `exit(0)` 无终端消息 → run 永久 running。修法：worker post 可克隆的 error fallback；主侧 per-generation `receivedTerminalMessage` flag——`exit(0)` 而无终端消息即 fail 该 run（script-error 重试退避窗口豁免）。该 flag 同轮被 R6 复用为 worker 崩溃双事件幂等守卫（见 E）。

**B. 【披露】失败表面化后 run 级 reason 语义**：gate 终止的 run 在 `agent()` 调用层仍 resolve（content fallback）——错误经 `returnMeta:true` 的 `result.errors` 暴露，run 级 `reason` 保持 completed（R5 登记的设计裁决：workflow 编排层消费 error，不改 reason 语义）。

**C. schema 256KiB 双侧防线（R6）**：schema 经 env 注入子进程随 spawn 走 execve 语义，单条 env 值过大叠加继承的 process.env 可触发 E2BIG（ARG_MAX 约束），spawn 失败且错误难归因（报在 spawn 调用点，表象与 schema 内容无关）。防线双侧：

- **SW 注入点硬拒**：`shared/schema-env.ts`（零依赖叶子模块，避免跨包契约测试拖入 session-runner 依赖树）的 `SCHEMA_ENV_MAX_BYTES = 256 KiB`，超限注入前 fail-fast，错误含实际字节数与 E2BIG 指引；
- **SO 注册期 warn**：`tool-definition.ts` 的 `SO_SCHEMA_SIZE_WARN_BYTES = 256 KiB`，超限 stderr warn（CLI 实测 300081 bytes 触发）——硬拒在 SW 注入侧，SO 侧 warn 兼顾独立安装用户直设 env 的可见性；
- **跨包契约测试**：`cross-package-contract.test.ts` 经 `pathToFileURL` 动态 import SW 叶子模块（绕过 vitest root 折叠），断言 env 名 `PI_WORKFLOW_SCHEMA` 与 256 KiB 上限**字节相等**——两包各自保留常量副本（独立 npm 包不能直接 import），漂移即红。

**D. 加固机制清单（R4-R6，与闸门正交）**：

- **worker 双事件幂等（R6）**：worker 崩溃时 error + exit(1) 双事件各派发一次 `handleWorkerError`，无守卫时同次崩溃计两次；per-generation flag 使第一次事件标记后第二次短路。
- **SIGKILL 升级链（R6）**：watchdog SIGTERM 后 30s 仍存活升级 SIGKILL（`assertSafeTimerDelay` + unref + 退出清理；kill-chain 本身 SIGTERM → grace → SIGKILL + 10s 有界收尸；watchdog 默认关闭语义不变）。
- **监听器单例（R5）**：pi 0.84.1 `on()` 无 off——每次 session_start 注册新 `agent_settled` handler 只翻转 disposed 标志，N 次 session 切换泄漏 N 个死 handler；修法：模块级单例 handler + boundLedger 引用切换（notify-ledger）。
- **路径校验三通道（R5）**：`skillPath`/`cwd` schema pattern + 运行时 guard（绝对路径、无 `..` 穿越——pi 不对 schema pattern 做运行时校验，真门在 `executeSubagent`）；skill discovery 解析路径必须仍在 skills root 内（穿越尝试按 not-found 反馈）；显式 agent ref 查不到时 throw 并列出可用 subagents（不再静默降级 general-purpose）。
- **单写者不变量（R6 注册，R5 元审查结论）**：session JSONL 原子性依赖「每 session 单写进程」——pi `_persist` 首写 wx（无 O_APPEND）、compaction 截断重写，均仅单写者前提下原子；引入第二写进程即尾部丢 entry/compaction 截断丢并发写入。代码内注册禁止双写者（子进程写独立 subagent sessionDir，主 session 仅本进程单线程写）。
- **workflow-state 无 GC（R6 验证登记）**：pi 0.84.1 无 session GC；`workflow-state/` state 文件与 session entry 无按 age/数量的 retention，唯一删除路径是 TUI SessionSelector 删除 session——无限累积是已知接受特性。

**E. 【披露】workflow state 快照体积膨胀（B3）**：每次 save 去抖后 flush 都序列化**全量 run 快照**写 state 文件并同步 append 同一 snapshot 的自描述 entry 到 session JSONL（W17 D4：pi 文件是持久化权威，state 文件降级纯性能缓存）——该设计支撑「live ≡ reload」（重启后从 entry 重建全部 run），代价是长 run 的 entry 体积**线性膨胀**（N 次 flush = N 份全量快照）。已知未优化：去抖已把相邻 save 合并，但跨步骤/跨子进程的 flush 间隔下快照重复存储仍在；优化方向（增量/diff entry）留待体积成为真实问题再做。

**测试**：`prompt-quality.test.ts` 文本断言随 description 重写更新（锁定新口径）；新增 loop-gate 状态机单测（同签名计数 / 签名变化清零 / terminal 触发 shutdown / hook terminal 不 steer）；`structured-output.test.ts` 保留日常模式全量用例，workflow 分支改为「透传 + 解包」断言；`retry-state.test.ts`（RetryState 加 terminal 态的行为契约）与 `characterization-hook.test.ts`（锁定 hook 时序基线）随设计变更重锁基线——characterization 用例按「行为基线重锁」处理，不是零改动全绿。

## 8. 验收（真实场景，非单测非 mock）

**本章结论：大改动（接口形态变更），5 个真实场景验收——在本地真实 pi CLI + 真实模型 + 生产真实 schema 上验证 G1-G4，含 1 个负面反向验证。**

### 8.1 改动规模

大改动：workflow 模式工具接口形态变更（模型可见面）+ 新增闸门行为。按项目规范走本地 pi CLI 实测（`pi --mode rpc --session-dir <dir> --model <m> --approve --extension <path>` + stdin JSONL 发 prompt），不走 xyz-agent 桌面（打包/隔离层掩盖版本差异）。

### 8.2 验收场景

| 场景 | 回溯目标 | 真实流程/数据/路径 | 通过标准 |
|---|---|---|---|
| S1 首调即成功 | G1、G3 | 本地 pi --mode rpc 起子进程，env 注入**生产真实的 L4-L6 17 字段 schema**，发真实分析 prompt（取自事故核实 session 的任务文本），分别用 `glm-5.3-flash` 与 `deepseek-v4-flash`（撕裂事故模型同族）各跑 3 次 | 6/6 首次 structured-output 调用即成功（session JSONL 中无 `Validation failed`）；`parsedOutput` 被正常提取 |
| S2 失败有界 | G2 | 构造 schema 含不可满足约束（如 `const: "__IMPOSSIBLE__"` 配 required），真实子进程跑简单任务 | 同签名调用 3 次后子进程退出（秒级，非 40 分钟）；子进程日志 / pi-*.jsonl tee 含 `[structured-output gate] Terminated` 与「检查 outputSchema / 换模型」指引；父进程 AgentResult success=false 且 parsedOutput=undefined |
| S3 链路兼容 | G3 + 消费者零改动 | 本地真实跑一个内置带 schema 的 workflow（如 `chain` 配 outputSchema 的 agent 步骤），端到端 | workflow 完成；reduce 步拿到 `parsedOutput` 正常消费；`extractParsedOutput` 无改动 |
| S4 日常模式回归 | G4 | 交互式 pi（无 env）主 agent 调 structured_output 自报双参数（含故意传错触发互换检测/keyword-less 拒绝） | 行为与现状逐点一致：合法调用过、防御链错误文案不变 |
| S5 负面反向验证 | G1 的反面 + D4 | S1 运行中检查：模型不再收到任何「must have required properties schema」错误；诱导模型自作主张多塞 `schema` 字段 | 该错误形态 0 次出现；多塞字段被根级 `additionalProperties:false` 拒绝（`must not have additional properties`），模型重试后 `parsedOutput` 不含 schema 声明之外的顶层字段；另抽查 L4-L6 schema 全部关键字（enum/required/嵌套 items）在 TypeBox 参数层被真实强制（引擎差异风险，见 §6.2） |

依赖说明：全部场景用真实 pi、真实模型 API、真实 schema，无 mock；S1 的 deepseek 场景即事故原型的复现环境（本地而非 carbon，模型同族）。

**版本矩阵（验收前置项）**：本设计全部 pi 行为断言锚定全局实装 0.84.2；项目 node_modules 锁 0.84.1（package.json 精确版本），碳上生产 pi 版本未登记。按版本漂移教训（0.80.3 clone 断言 0.84.1 行为连产 4 条漂移 bug），验收前须：① 在项目锁定版本 0.84.1 上复跑 P3 时序探针（validate→beforeToolCall 顺序、immediate 路径触发 tool_execution_end、shutdown 可用性）；② 登记碳上生产 pi 版本并核对同一探针；三者任一不符则对应环境的验收结果不生效。

## 9. 实施

**本章结论：两个里程碑交付终态——M1 单参数工具（G1/G3），M2 闸门（G2）；M1 独立完成大部分收益，M2 增量叠加。**

| 阶段 | 内容 | 交付终态的什么 |
|---|---|---|
| M1 | U1（工具分岔 + execute 简化 + 加载期 schema 防御 + 根级 additionalProperties 注入）+ U4（文案收敛）+ U3（测试改写）+ 验收 S1/S4/S5 | §5.1 成功路径；失败模式 A 消除 |
| M2 | U2（闸门 + hook terminal 态）+ 验收 S2/S3 | §5.2 失败路径；失败模式 B 有界 |

M1 先行可独立上线（首调即成功单独已消除 80% 事故面）；M2 不阻塞 M1。

## 10. 下一层拆分

**本章结论：5 个单元；U1/U2 是行为核心，U3/U4 随迁，U5 是验收执行。**

| 单元 | 说明 | justification（为什么这么拆） |
|---|---|---|
| U1 workflow 单参数工具 | tool-definition 双变体 + execute 透传/解包 + 加载期权威 schema 防御 + index 装配分岔 | 终态的形态核心，独立可验（S1/S4/S5）；不依赖闸门 |
| U2 有界失败闸门 | loop-gate.ts（同签名计数 + shutdown 终止）+ RetryState terminal 态 | 独立状态机可单测；与 U1 正交（U1 消除参数层失败主源后，闸门守剩余形态） |
| U3 测试改写 | prompt-quality 文本断言更新 + loop-gate 单测 + workflow 分支断言改写 + retry-state / characterization-hook 基线重锁 | prompt-quality 是源码文本锁，description 一改即红，必须与 U1/U2 同 PR 演进 |
| U4 文案收敛 | agent-opts-resolver 注入段 + formatSchemaInstruction | 纯文案、零逻辑，与 U1 同 PR 但独立 commit 以便回溯 |
| U5 实机验收 | §8 五个场景执行与记录 | 验收是 DoD 的一部分，单独成单元防「码完不收」 |

文件改动地图见 §7（U1→文件 1/2/5，U2→3/4/5，U4→6）。

## 11. 待验证检查点（探针清单）

**本章结论：4 条 pi 行为断言已直读 dist 证实（✅）；5 条留实施期门（⛔），每条带降级路径；1 条初稿断言被对抗式审查证伪后作废（P3-old，如实保留以警后）。**

> v4 注：⛔ 各项已在 M1/M2 实施与 R3-R6 审计实跑中逐项消耗（探针证据见各轮 commit message 与 /tmp/pi-probe5/；P3 系时序断言在 R6 以「pi 0.84.1 ExtensionContext 无信号能力」重新核实），表内状态保留为设计期快照。

| ID | 验证的行为 | 探针 | 状态 | 失败时的降级路径 |
|---|---|---|---|---|
| P1 | pi-ai 参数层支持非 typebox 普通 JSON schema 作工具 parameters | 直读 `pi-ai/dist/utils/validation.js`：`TYPEBOX_KIND` 符号检测分支 + `Compile` 编译 | ✅（0.84.2 dist） | — |
| P2 | execute 收到的是校验+类型矫正后的 arguments（非原始值） | 直读 `pi-agent-core/dist/agent-loop.js`：`validateToolArguments` → `prepared.args` → `tool.execute(id, prepared.args)` | ✅（0.84.2 dist） | — |
| P3-old ~~`tool_call` handler 返回 `{block, terminate}` 拦停 tool 批可充当闸门~~ | 机制字面存在（types.d.ts `ToolCallEventResult`、agent-loop `shouldTerminateToolBatch`），但**时序使其对目标失败形态不可用**：`tool_call` 接线为 `beforeToolCall`（agent-session.js），执行顺序 validate → beforeToolCall（agent-loop.js:404→405），参数层失败走 immediate 路径永不到达 handler | ❌ 作废（审查证伪） | 已用 P3-new 替代 |
| P3-new | 闸门通道成立：① `tool_execution_end` 对 immediate（参数层失败）结果照常触发；② `ExtensionContext.shutdown()` 实存且「available in all contexts」 | 直读 agent-loop.js sequential/parallel 两路径 immediate 分支均 `emitToolExecutionEnd`；types.d.ts `shutdown()` 注释 | ✅（0.84.2 dist） | — |
| P4 | pi-ai 参数层自带类型矫正（等效 qwen-code 预修复） | 直读 validation.js：`Value.Convert` + `coerceWithJsonSchema` + `normalizeOptionalNulls` | ✅（0.84.2 dist） | — |
| P5 | 注册期动态 parameters（env 派生）在模型可见工具清单中正确呈现权威 schema，且 TS 类型层成立 | U1 实施期：`pi --mode rpc` 实发 prompt，从 session JSONL 确认模型看到的 schema 与首次调用形态 | ⛔ M1 内 | 失败 → `Type.Unsafe` 包装为合法 TSchema；仍失败 → parameters 用 `Type.Object({})` 兜底 + execute 内恢复权威 ajv 校验（放弃 D2） |
| P6 | 非 object 根权威 schema 的 `{value}` 包装在 tool call 协议层可行（arguments 必须 object） | U1 实施期：array 根 schema 实测一次调用 | ⛔ M1 内 | 失败 → workflow 模式显式拒绝非 object 根 schema，错误指引 workflow 作者自行包一层对象 |
| P7' | 闸门 terminal 调用 `pi.shutdown()` 后：① 事件 handler 内调用安全（不死锁/不丢日志）；② 父进程 session-runner 把 mid-turn 退出解释为 success=false 且错误可读（record 收尾 / AgentResult.error 形态） | U2 实施期：S2 场景实跑，检查子进程退出码、父进程 AgentResult、日志含闸门 reason | ⛔ M2 内 | 失败 → 退化路径：terminal 态不发 shutdown，改为 hook 侧 steer 一次「停止重试、文本收尾」+ 依赖 workflow 层 maxTurns 物理兜底，G2 降级为「有界但分钟级」并在 §5.2 如实描述 |
| P8 | 生产在用 schema 集合（L4-L6 17 字段 + 内置 workflows 声明的全部 schema）在 TypeBox Compile 下编译通过，且关键关键字（enum/required/嵌套 items）被真实强制 | U1 实施期：收集全量生产 schema 跑编译 + 关键字强制抽查（并入 S5 检查项） | ⛔ M1 内 | 失败 → 该 schema 关键字落在 ajv/TypeBox 语义差内：改写 schema 避开差集，或对该 schema 启用 P5 降级路径（execute 内 ajv 校验，放弃 D2 的纯透传） |
| P9 | 版本矩阵：P3-new/P1/P2 的时序与 API 事实在项目锁定 0.84.1 与碳上生产版本同样成立 | 验收前置：0.84.1 node_modules dist 复读同三点；登记碳上版本并复跑 | ⛔ 验收前 | 失败 → 该版本环境的验收结果不生效，逐版本定适配（不跨版本假设） |

> 设计阶段无法确定、不影响架构的项（如归一化签名的具体截断长度）留实施期定，不预判。

---

## 附录：变更历史

- v1（2026-08-28）：初版。基于事故核实 session（72cd03 T001/T002 对抗式核实）与 8 项目业界调研（T003），从终态视角重设计 workflow 模式为单参数合成工具 + tool_call 硬闸门。
- v2（2026-08-28）：对抗式审查修订（审查报告 `structured-output-redesign.review.md`，23 项事实抽查 18 命中 5 偏离，2 must-fix 全部落盘）。① D3 闸门机制推翻重选：初稿 `tool_call` 事件 `block+terminate` 被证实对参数层失败结构性不可达（beforeToolCall 位于 validate 之后），改为 `tool_execution_end` 同签名计数 + `pi.shutdown()` 硬终止——初稿否掉 execute 内计数的时序推理同样适用于 tool_call，初稿只排查了三处出口中的两处；② 新增 D4 根级 `additionalProperties:false` 堵输出污染（审查实测未声明时多余字段整包流入 parsedOutput）；③ §5.2 形态 a 错误文案改为 pi-ai 原生（参数层失败无 hook 改写通道，指引下移到工具 description 静态携带）；④ 补 ajv→TypeBox 引擎差异（P8）、版本矩阵（P9）、retry-state/characterization-hook 测试基线重锁。
- v3（2026-08-28）：实施期一致性审查修订。① §7.4 补 workflow-hook steer 文案重写条目（初版漏列，致实现照单执行后 hook 提醒残留旧双参数口径，成为终态下唯一矛盾信息源）；② session-runner formatSchemaInstruction 的 `data` 术语残留统一（resolver 侧已用 result）。
- v4（2026-08-28）：R3-R6 四轮审计修复（`f69766b44`→`9438940c0`→`1dfd93b1a`→`3f934637c`）语义回写——前六轮演进（R1 设计对抗审查→v2、R2 实施一致性审查→v3、R3-R6 代码审计）中后四轮的实装语义此前未回写，本次补齐：① §6.3 签名归一化四步演进（token 集合哈希→R3 AP keys 并入→R4 并集恒定陷阱与 AP 桶门控→R6 嵌套路径下钻 `key:<path>:<name>` + AP marker 整句后缀精确匹配）；② §6.3/§5.2 terminal 动作升级 bounded teardown 链（abort 止燃实测 ~25s 窗口→shutdown→15s 硬退兜底；pi 0.84.1 无信号能力）；③ §7 补记 A/B 失败表面化全链路（isError 跳过→三态归因→STALE_CONTEXT_PATTERNS 中和→确定性失败不重试矩阵；exit(0)-no-terminal worker 兜底）；④ §7 补记 C schema 256KiB 双侧防线（SW 注入点硬拒 + SO 注册期 warn + 跨包契约测试锁字节相等）；⑤ §7 补记 D 加固清单（worker 双事件幂等、SIGKILL 升级链、监听器单例、路径校验三通道、单写者不变量、workflow-state 无 GC）；⑥ §7 补记 E 披露 workflow state flush 全量快照体积线性膨胀（live≡reload 代价，未优化）；⑦ §11 ⛔ 探针状态补注。R4/R5 两轮「修复自身引入回归」的教训沉淀入 TEST-STRATEGY.md「修复后验证纪律」。
