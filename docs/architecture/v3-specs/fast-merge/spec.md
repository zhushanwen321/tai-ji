# Fast Merge · 多分支差异聚合（设计单元 spec）

> 层级 **L2 跨区联动 + Extension** · 痛点2 主线 · 依赖痛点1 基础层（parentSession + forkEntryId）
> 配套 draft：待做（交互形态与 fast-fork 的 composer 贴入一致，复用 fast-fork 的 fork-notice 反馈行范式）
> 上游规范：`../fast-fork/spec.md`（痛点1，parentSession + forkEntryId 基础层）、`../../design-tokens.md`（冷蓝暗色 SSOT）

## 0. 背景与问题

用户从主线 fork 出 N 条后台分支各自试探（痛点1 的 fork-to-ask），每条分支演化出自己的结论。试探结束后，用户希望**把这些分支的结论整合成一个总结回主线**。

这不是 git merge（不合并代码/状态），是**多路调研结论的汇总**。

核心挑战：分支的原始差异对话可能很长，直接贴入主线 composer 会**token 爆炸**。需要先把每个分支的差异压缩成精炼摘要，再把 N 份摘要贴入主线。

## 1. 能力边界与方案演进

### 排除的方案

| 方案 | 排除原因 |
|---|---|
| 原始差异直接贴 composer（C2） | **token 爆炸**（用户明确否决） |
| 主线 pi 聚合原始差异 | **token 爆爆**（用户明确否决） |
| runtime import pi 调 generateBranchSummary | 破坏进程隔离架构（架构约定 #5） |
| runtime 自己写 summarizer | 用户否决，重复 pi 的 prompt 模板 |
| 改 pi 加 summarize RPC | 用户明确不愿改 pi |
| extension 调 completeSimple 绕过 agent loop | **自己重组上下文 = 重造半个 pi**，放弃 pi 的 context 构建/token 管理/system prompt 基础设施，长期维护成本高 |

### 锁定方案：B+C+F 三件套（structured-output + 工具集封锁）

经深入调研 pi extension API（源码逐项验证），确认**复用 pi 的 agent loop，只介入"限制工具集 + 强约束 prompt"**是正解。让 pi 继续负责上下文组装（session history 自动进 context、token 管理、system prompt 构建），我们只保证 agent 产出结构化输出。

**核心机制（pi 已有的 API，零改 pi）**：

| 件 | pi API | 作用 |
|---|---|---|
| **B: setActiveTools** | `pi.setActiveTools(["structured-output"])`（`agent-session.ts:840-855`） | 结构性删工具。agent 工具列表只剩 structured-output，调不出 read/grep/write。删工具同时**重建 system prompt**（"Available tools"一节只剩 structured-output） |
| **C: before_agent_start** | `pi.on("before_agent_start", ...)`（`runner.ts:1054-1057`） | 往 system prompt 追加强约束："本轮唯一任务是调 structured-output，schema=XXX，禁止文本输出"。xyz-agent 已有 `xyz-system-prompt-extension.js` 走这个 hook |
| **F: turn_end 兜底** | `pi.on("turn_end", ...)`（现有 structured-output `index.ts:175-210`） | 万一 agent 没调（理论上不会，工具列表只有一个），`sendUserMessage({deliverAs:"steer"})` 重试，最多 2 次 |

**正面先例**：pi 官方示例 `examples/extensions/plan-mode/index.ts` 完整演示了这套模式（setActiveTools `:104-114` + tool_call block `:164-174` + before_agent_start 注入 `:201-247` + turn_end `:250-259`）。ask-user extension 也用 setActiveTools 禁用工具（`extensions/ask-user/src/index.ts:37-44`）。

### 关键架构判断

**为什么不用 completeSimple 绕过 agent loop**（用户质疑纠正）：

completeSimple（`compat.ts:270-277`）能直接发单次 LLM 请求绕过 agent loop，"零污染、通信简单"。但代价是**放弃 pi 的全部基础设施**：
- 上下文组装（session history → context messages）：要自己拼
- token 预算管理（超窗 compaction）：要自己实现
- system prompt 构建（含工具说明、项目规范）：要自己写
- 读文件补充上下文（agent 能调 read/grep）：做不到

对 handoff/merge 这种"压缩已有 session 内容"的场景，看起来上下文就是 session history，但实际包括 system prompt 构建、token 管理、历史压缩后的 context 还原——这些 pi 都帮你做了。**自己拼很容易拼错或漏掉，且 pi 改了 context 构建逻辑你的代码不跟随**。B+C+F 三件套让 pi 继续做这些，只介入"锁工具集"，是正解。

**为什么不用 generateBranchSummary**（原 spec 方案，推翻）：

generateBranchSummary（`branch-summarization.ts:287`）是 pi 内部函数，接受任意 entries 生成摘要。但：
- extension 调它仍要自己组 entries（从 SessionManager 读 + 定位 forkEntryId 后切片），等于半重组上下文
- 它的 prompt 模板是固定的"被放弃分支便条"语义（Goal/Progress/Decisions/Next Steps），不是为"多分支结论聚合"设计的
- 三件套复用 pi 的 agent loop + structured-output，更灵活（schema 可定制）且不重组上下文

## 2. 核心裁决 · 三件套生成差异摘要 + 引导前缀 + 贴 composer

**两层职责**：
- **extension 层（pi 进程内，跑在主线 session 的 pi 里）**：触发后用 setActiveTools 锁工具集 + context event 注入 schema + 让 agent 产出符合 schema 的结构化差异摘要。LLM 调用 100% 在 pi 的 agent loop 内
- **runtime + 前端层**：触发 slash command、收集 N 份摘要、**加整合引导前缀**、贴入主线 composer、用户编辑后发送

**最终产出形态**（决策 A 选项 3，审查 2-C1 修正）：
- extension 产出 **N 份并列摘要**（每分支一份，结构化）
- 贴入 composer 时，**runtime 自动在前面加一句引导前缀**："以下是 N 个分支的试探结论，请综合成一份总结，标注各结论来源分支、冲突点、推荐采纳项："
- 用户编辑后发送 → 主线 pi 收到明确的整合指令 + N 份摘要 → 自然聚合成一份总结
- 这样既不加额外 LLM 调用（整合由主线 pi 在正常对话完成），又给主线 pi 明确的整合角色（不是被动复述，是主动综合）

**为什么不会 token 爆炸**：每个分支的差异被 agent 压成一份符合 schema 的结构化摘要（structured-output tool 产出，schema 控制字段数和粒度）。N 份摘要贴入 composer，总量可控。

**为什么贴 composer 而非自动进消息流**：
- merge 是创作动作，用户需挑选/组织/删减
- 用户能在编辑时发现"这个分支结论明显错了，不要"
- 贴 composer 绕开 role/compact 技术坑
- 呼应痛点1"后台分支试探"心智：试探本质是大部分会被丢弃，merge 让用户有挑选权

## 3. 完整流程

```
【主线上触发 merge】
  → 前端：用户在主线点"merge"，勾选要合并的 N 个分支
    （⚠️ 分支选择器过滤掉 streaming 中的分支，见 §5 分支完成态门控）
  → runtime：从 SessionSummary 读每个分支的 { sessionFile, forkEntryId }
  → runtime：触发主线 session 的 slash command /merge-branches
    （RPC prompt("/merge-branches <json: branches info>")）

【extension 生成差异摘要】（主线 pi 进程内，agent loop 跑）
  → extension command handler（跑在主线 pi 内）：
      - 解析 branches 参数（每个含 sessionFile + forkEntryId）
      - 设置 CURRENT_SCHEMA（merge 摘要的 JSON Schema）
      - setActiveTools(["structured-output"])（锁工具集）
      - ACTIVE = true，保存 SAVED_TOOLS = pi.getActiveTools()
      - 对每个分支串行：
          - sendUserMessage(buildInstruction(branch, schema))，启动一个新 agent run
          - context event（types.ts:655-658）注入强约束 + 本分支的 forkEntryId 差异上下文
          - agent 调 structured-output tool 产出符合 schema 的摘要
          - tool_execution_end 事件捕获 tool result 的 details（摘要数据）
          - turn_end 检测成功 → 收集摘要
      - setActiveTools(SAVED_TOOLS) 恢复工具集（agent_end / session_shutdown hook 兜底）
      - 把 N 份摘要通过 sendMessage(custom_message) 回传 runtime
        （customType 'merge-result'，含 { requestId, branches: [{name, summary, ...}] }）

【回主线 composer】
  → runtime 经 event-adapter 收到 custom_message 'merge-result'
  → 前端拼装文本块：
      [引导前缀] + N 份并列摘要（每段：【分支名 · fork 时间】<摘要>）
  → 贴入主线 composer（复用 fast-fork composer 模式视觉）
  → 用户编辑/组织/发送
  → 主线 pi 收到"请综合成一份总结"+ N 份摘要，自然聚合回复
```

### 关键技术裁决：纯 turn_end 事件驱动（审查 2-C2 + 时序验证修正）

⚠️ **原 spec 方案的问题**（时序模型验证发现）：
- `before_agent_start` 是 per-agent-run，串行 N 分支只触发一次，只对第一个分支注入 schema
- `context event` 返回 `{messages?}` 无 systemPrompt 字段，且每次 LLM 调用触发会重复注入
- `sendUserMessage` 返回 void fire-and-forget，`await processBranch()` 立即返回，handler 挂不住

**改为纯 turn_end 事件驱动**（subagent 验证推荐，structured-output 生产先例 `index.ts:153-210`）：
- handler 入口为每个 branch 预构建 instruction（含 fs 读取的差异文本），不用 context event 注入
- handler 启动第一个 branch 后**立即 return**（RPC ack 即时发，runtime 不卡）
- 后续 branch 靠 turn_end 事件推进，用 `deliverAs:"steer"` 在同一 agent run 内续命（避免 "already processing" 错）
- 状态机用 module-level 变量，handler return 后闭包存活

详细伪代码见 §4.2。时序模型验证依据：`agent.ts:314-321`（waitForIdle 语义）+ `agent-session.ts:2256-2264`（sendUserMessage void）+ `agent-session.ts:1286-1290`（steer 续命）+ structured-output `index.ts:175-210`（turn_end steer 生产先例）。

### 主线污染控制（审查 2-M1 修正）

⚠️ extension 在主线 session 跑 N 个 turn 会产生：N 条 sendUserMessage 的 user message + N 条 structured-output tool call + 1 条 custom_message。N=5 时主线对话流多出 11 条记录，且全部持久化（重开还在）。

**控制策略**：extension 处理过程的这些 entry 标记为"系统过程"（custom_message 或 entry 的 metadata 标记 `systemProcess: true`），前端 message-stream 对标记的 entry **折叠/灰显**（类似 subagent trace 的处理方式），不计入正常对话叙事。用户展开可查看过程，默认折叠不干扰主线阅读。

**为什么不在临时 session 跑**：临时 session 增加 fork 开销 + 结果回传复杂度。标记折叠是更轻的方案。

## 4. Extension 设计（xyz-merge-extension.js）

### 4.1 职责边界

extension 做：**接收 runtime 的 merge 请求（N 个分支的 sessionFile + forkEntryId），在主线 session 内用三件套让 agent 产出每个分支的差异摘要，结果回传 runtime**。

不做：
- ❌ 决定哪些分支 merge（用户在前端选）
- ❌ 把摘要贴 composer（runtime/前端做）
- ❌ 主线整合（主线 pi 正常对话处理，由引导前缀驱动）
- ❌ 新建/删除 session（runtime 做）

### 4.2 extension 状态机（审查 B1/B2/B3 修正：纯 turn_end 事件驱动）

⚠️ **审查发现的核心问题与修正**：
- 原 spec 用 `await processBranch()` + `context event` 注入——但 `sendUserMessage` 返回 void（fire-and-forget），await 立即返回；context event 返回 `{messages?}` 无 systemPrompt 字段
- **改用纯 turn_end 事件驱动**（subagent 验证推荐，structured-output 生产先例）：handler 立即 return（RPC ack 即时），状态机靠 module-level 变量 + turn_end 事件推进。后续分支用 `deliverAs:"steer"` 在同一 agent run 内续命

```javascript
// xyz-merge-extension.js（跑在主线 pi 进程内）
const TOOL_NAME = "structured-output"
const MAX_BRANCHES = 50

// ── module-level 状态机（handler return 后仍存活）──
let queue = []                    // 待处理分支队列
let summaries = {}                // 已收集摘要 { branchName: summaryData }
let isRunning = false             // 防重入
let savedTools = undefined        // merge 前工具集快照
let currentBranchData = undefined // 本 turn 的 structured-output 结果

export default function mergeBranchesExtension(pi) {
  // ── 工具结果采集：structured-output 成功调用时记下 data ──
  pi.on("tool_execution_end", async (event) => {
    if (event.toolName !== TOOL_NAME || event.isError) return
    currentBranchData = event.result?.details
  })

  // ── 状态机核心：每个 turn 结束推进 ──
  pi.on("turn_end", async (event) => {
    if (!isRunning) return
    // stopReason="toolUse" → 模型还在调工具链，等下个 turn_end
    if (event.message?.stopReason === "toolUse") return

    // ① 收集本 branch 的结构化输出
    const job = queue.shift()
    if (job && currentBranchData !== undefined) {
      summaries[job.name] = currentBranchData
    }
    currentBranchData = undefined

    // ② 还有剩余 branch → steer 续命同一 run（不启动新 run，避免 "already processing" 错）
    const next = queue[0]
    if (next) {
      pi.sendUserMessage(next.instruction, { deliverAs: "steer" })
      return
    }

    // ③ 全部跑完 → 恢复工具集 + 回传结果
    isRunning = false
    if (savedTools) {
      pi.setActiveTools(savedTools)
      savedTools = undefined
    }
    pi.sendMessage({ customType: "merge-result", content: { summaries } })
  })

  // ── 入口：handler 立即 return，纯靠事件驱动推进 ──
  pi.registerCommand("merge-branches", {
    handler: async (args, _ctx) => {
      if (isRunning) throw new Error("merge-branches already in progress")
      const branches = JSON.parse(args)  // [{ sessionFile, forkEntryId, name }, ...]
      if (!branches.length || branches.length > MAX_BRANCHES) {
        throw new Error(`Invalid branch count: ${branches.length}`)
      }

      // 初始化队列（每个 branch 预构建 instruction，含差异文本）
      queue = branches.map(b => ({ name: b.name, instruction: buildMergeInstruction(b) }))
      summaries = {}
      currentBranchData = undefined
      isRunning = true
      savedTools = pi.getActiveTools()
      pi.setActiveTools([TOOL_NAME])  // B: 锁工具集

      // 启动第一个 branch（agent idle 状态，直接触发新 run，不需 deliverAs）
      pi.sendUserMessage(queue[0].instruction)  // void fire-and-forget

      // handler 立即 return → RPC ack 即时发 → runtime 不卡
      // 后续推进全部交给 turn_end handler
    },
  })
}
```

**关键设计点**（验证结论 + 实测发现）：
- **handler 立即 return**：避免 RPC ack 延迟（`rpc-mode.ts:390-411` preflightResult 在 handler resolve 后才触发）。⚠️ 注意：这是 RPC 模式的方案；`--print` 模式下 pi 会提前退出，验证脚本需用 `ctx.isIdle()` 轮询等 run 启动 + `ctx.waitForIdle()` 等 run 结束
- **registerTool 的 parameters 必须用 typebox `Type.Object`**（实测发现）：普通 JSON schema 对象会被静默忽略，tool 注册了但 setActiveTools 时被过滤变空数组。structured-output 用 typebox，本 extension 也要用（`require("typebox")` + `Type.Object({...})`）
- **steer 续命**：后续分支用 `deliverAs:"steer"`（`agent-session.ts:1286-1290`），在同一 agent run 内追加，不触发 "Agent is already processing"。实测：2 个分支 4 次 turn_end（每分支 2 次：toolUse + stop），steer 成功推进
- **stopReason="toolUse" 跳过**：structured-output 调用是 tool-use，模型还在工具链时不推进，等真正的 turn 结束（实测：每个分支会先 turn_end{toolUse} 再 turn_end{stop}）
- **module-level 状态**：handler return 后闭包变量存活，turn_end 事件驱动状态机持续运转（structured-output `index.ts:153-210` 同模式）

**⚠️ handler 内同步 fs 读 N 分支的权衡（未化解的矛盾）**：handler 入口的 `branches.map(b => ({..., instruction: buildMergeInstruction(b)}))`（§4.2 伪代码）会**同步**为 N 个分支各跑一次 `readBranchDiffEntries` → `fs.readFileSync` + JSONL parse + `slice`（§4.3）。这与「handler 立即 return」**有张力**：

- N=5 个长分支（每分支 1-5MB JSONL），同步读 + parse 总耗时约几百 ms 到数秒，handler **实际阻塞这么久才 return**，RPC ack 也跟着延迟
- 这不是真正的「立即 return」，是「做完 N 次 IO 才 return」。spec 原文说「handler 立即 return → RPC ack 即时发」**不严谨**

**两种化解路径（实现时二选一）**：
1. **接受 handler 阻塞做 IO**：N≤10 分支时几百 ms 可接受，handler 同步预构建完所有 instruction 后再启动第一个 run 并 return。优点：状态机简单（所有 instruction 早早入队），turn_end 只管推进。缺点：N 大或分支大时 ack 延迟明显
2. **IO 推迟到 turn_end 按需读**：handler 只入队分支元信息（sessionFile/forkEntryId/name），turn_end 处理某分支前**才**读该分支 JSONL 构建 instruction。优点：handler 真正立即 return，IO 分散到各 turn 之间。缺点：turn_end 逻辑变重，且 turn_end 是事件回调不宜做长同步 IO（可能阻塞 pi 事件循环）

**推荐方案 1**（除非实测 N 大分支 ack 延迟超 1s 才切方案 2）。实现时必须实测 N=10 × 5MB 分支场景的 handler 阻塞时长，写进 verify 脚本。

**验证依据（如实）**：`tools/verify-merge-extension.cjs` 在 **`--print` 模式 + `ctx.waitForIdle()` 阻塞模式**下实测通过（V1-V8 PASS，2 分支 33.8s），证实了下列 **pi API 层面的能力成立**：turn_end 事件触发、`deliverAs:"steer"` 在同一 run 内续命、`tool_execution_end` 捕获 `result.details`、`setActiveTools` 锁/恢复（`verify-merge-extension.cjs:152-165`）。

⚠️ **生产方案（RPC 模式 handler 立即 return + 后台事件驱动）已实测通过**——`tools/verify-merge-rpc-mode.cjs` 在 pi `--mode rpc`（长驻不退出）下验证：handler 立即 return（**RPC ack 延迟仅 1ms**），agent run 在后台由 turn_end 事件驱动完整推进（2 分支 5 次 turn_end + 1 次 steer 续命 + COMPLETE，30.5s）。两个验证脚本互补：`verify-merge-extension.cjs`（--print 阻塞模式）证明 pi API 能力，`verify-merge-rpc-mode.cjs`（RPC 模式）证明生产方案端到端可行。

**验证依据汇总**：
- pi API 能力（turn_end/steer/details 捕获/setActiveTools 恢复）：`verify-merge-extension.cjs` V1-V8 PASS
- 生产方案（handler 立即 return + 事件驱动 + RPC ack 即时）：`verify-merge-rpc-mode.cjs` R1-R4 PASS（ack 1ms，状态机完整跑完）
- 未覆盖：abort 取消 + agent_end 兜底恢复（实现时补验证）、N>2 大分支压力测试

### 4.3 差异 entries 的获取（fs 读 + instruction 预构建）

**修正**（审查 C2）：原 spec §4.3 标题"复用 pi agent loop 不自己读 JSONL"与正文"fs 读分支 JSONL"矛盾。实际方案是后者——在 handler 入口就为每个 branch 预构建 instruction（含 fs 读取的差异文本），不用 context event 注入。

```javascript
const fs = require("node:fs")

function buildMergeInstruction(branch) {
  // extension 无沙箱，直接 fs 读分支 JSONL
  const diffEntries = readBranchDiffEntries(branch.sessionFile, branch.forkEntryId)
  const diffText = serializeEntries(diffEntries)
  return `本轮唯一任务：把下面这段分支对话的差异总结成结构化摘要。
禁止调用除 structured-output 外的任何工具（工具列表已锁）。
禁止输出文本答案，必须调 structured-output tool。
schema = ${JSON.stringify(MERGE_SUMMARY_SCHEMA)}

分支名：${branch.name}
分支差异内容（从 fork 点 ${branch.forkEntryId} 之后）：
${diffText}
`
}

function readBranchDiffEntries(sessionFile, forkEntryId) {
  const raw = fs.readFileSync(sessionFile, "utf-8")
  const entries = parseJsonl(raw)  // 每行 JSON parse，跳过坏行
  if (!forkEntryId) return entries  // 降级：无锚点总结整分支
  const idx = entries.findIndex(e => e.id === forkEntryId)
  if (idx === -1) return entries    // 降级：锚点不存在
  return entries.slice(idx + 1)     // fork 点之后的差异
}

function serializeEntries(entries) {
  // 参考 pi session-history.ts mapEntriesToPiMessages 的转换逻辑
  // message → [role] text；compaction → [compacted] summary；custom/branch_summary 适配
  return entries.map(e => {
    if (e.type === "message") return `[${e.message.role}] ${normalizeContent(e.message.content)}`
    if (e.type === "compaction") return `[compacted] ${e.summary}`
    if (e.type === "custom_message") return `[${e.customType}] ${e.content}`
    if (e.type === "branch_summary") return `[branch] ${e.summary}`
    return ""  // session_info/thinking_level_change 等跳过
  }).filter(Boolean).join("\n\n")
}
```

**边界场景**（审查 C2）：
- `forkEntryId` 不存在（旧分支）→ 总结整个分支内容（§5 Key States 的"旧分支降级"）
- 分支为空 → instruction 仍发送，agent 产出"无差异"摘要
- JSONL 坏行 → parseJsonl 跳过（pi 的 parseJsonl 已有容错）

### 4.4 runtime ↔ extension 通信（修正：触发对齐 workflowAction，回传无先例需自建）

**修正**（审查 B3 + 复核纠正）：原 spec 说「触发与结果回传都对齐 workflowAction 先例」是**误读**。实测 `workflowAction`（`session-service.ts:550-554`）是 `await client.prompt("/workflows <action> <runId>")`，**fire-and-forget 无结果回传**——pause/resume/abort 的副作用在扩展侧执行（改 workflow state、SIGTERM 子进程等），runtime 不收任何结果，只等 `session.workflowActionDone` 的 RPC reply（`session-message-handler.ts:141-143`，reply 仅含 sessionId/action/runId 标识，无业务结果）。

而 spec 原文引用的 `handleWorkflowResult`（`event-interpreter.ts:625`）/ `handleSubagentBgNotify`（`event-interpreter.ts:575`）处理的是 **workflow 进度推送**（`workflow-result` customStart，run 完成通知）和 **subagent 完成通知**（`subagent-bg-notify` customStart）——这两个是 pi-subagent-workflow 扩展独立发的 custom_message，**不是 workflowAction 的回传**。把这两个当 action 回传先例引用是错的。

- **触发**：runtime 的 merge-service 调 `client.prompt("/merge-branches <json>")`（`session-service.ts:550-554` workflowAction 同模式，`_tryExecuteExtensionCommand` 走 `agent-session.ts:1178-1202`）。args JSON 是分支数组，无需 requestId
- **回传（无直接先例，需自建）**：extension `pi.sendMessage({customType:"merge-result", content:{summaries}})`（`types.ts:382-383` 的 sendMessage 签名）→ runtime 经 event-adapter 转 `message.customStart`（`event-adapter.ts:496-513`）→ event-interpreter 新增 `handleMergeResult` 分支消费。**消费模式可参照** `handleSubagentBgNotify`（L575）的 `customType` 校验 + details 解析范式，但注意那是 subagent 完成通知不是 action 回传——仅借鉴 custom_message 消费模式，不等同 action 结果回传
- **防并发**：extension 用 `isRunning` 防重入（同 session 同时只能一个 merge）。跨 session 并发不冲突（状态机是 per-session）
- **⚠️ 超时兜底（硬缺口）**：原 spec 说「无超时风险」**不准确**——handler 立即 return 后，runtime 收到 RPC ack（`session.mergeBranchesDone`）只代表「command 已派发」，**不代表 merge 已完成或会完成**。runtime 不知道 extension 何时跑完（可能 agent 不调 structured-output 死循环、可能 LLM 超时）。runtime 侧 merge-service **必须配超时兜底**（建议 N × 单分支预算，如 60s/分支），超时后向前端报错 + 通过另一条 slash command（如 `/merge-branches-cancel`）通知 extension 中止

### 4.5 extension 打包与注入（修正 B4：三处对称改动）

**修正**（审查 B4）：原 spec 说"extension-service.getExtensionPaths 追加"过于笼统。实际现在只有两个 extension 文件槽位（`extensionFilePath` + `systemPromptExtensionFilePath`），加第三个要三处对称改动：

1. **`extension-service.ts:98-99`**：加 `mergeExtensionFilePath` 字段（constructor 参数）
2. **`extension-service.ts:122-123`**：constructor 初始化赋值
3. **`extension-service.ts:261-265`**：`getExtensionPaths()` push 第三个路径
4. **`electron-builder.yml:65-70`**：extraResources 加第三条 `- from: ../../xyz-merge-extension.js / to: xyz-merge-extension.js`
5. **`postbuild-validate.sh:136-155`**：加第三段文件存在性校验

模式与 `systemPromptExtensionFilePath` 完全对称，照抄改字段名即可。

## 5. Key States

| 状态 | 触发 | 用户需看到/感到 |
|---|---|---|
| **merge 入口** | 主线 session 有 ≥1 个**完成态**子分支 **且 structured-output 扩展已安装**（§8.2 前置检查） | merge 入口可见（位置倾向侧栏分支列表头部）。structured-output 未装时入口 disabled + tooltip「需先安装 structured-output 扩展」+ 「去安装」跳 Settings |
| **分支选择** | 点 merge | 分支选择器列出子分支，可勾选。**默认勾选未 merge 的，已 merge 的标视觉标记**（见下方"已 merge 标记"） |
| **分支完成态门控** | 选择器过滤分支 | **streaming 中的分支 disabled 或标 warning**（审查 2-M2：读不完整差异无意义）。只允许 done/stopped/error 态分支被选中 |
| **摘要生成中** | 确认选择 | loading 态，每分支一行（"正在总结 [分支名]..." spinner + 完成打勾），串行。主线对话流的处理 entry 折叠灰显（§3 污染控制） |
| **单个分支失败** | 该分支 turn_end 重试 2 次仍未调 structured-output | 该分支标记失败，其他继续；用户可重试 |
| **摘要回传完成** | 全部分支处理完 | custom_message 'merge-result' 到达，runtime 贴入 composer |
| **composer 编辑态** | 摘要贴入后 | 引导前缀 + N 份并列摘要拼好，用户删减/组织 |
| **发送后** | 用户发送 | 作为 user message 进主线对话流（含引导前缀 + N 份摘要），主线 pi 聚合回复一份总结 |
| **空状态** | 当前 session 无子分支 | merge 入口不显示或 disabled |
| **已 merge 标记** | merge 成功发送后 | 被选中的分支 SessionItem 加 `lastMergedAt` 视觉标记（如"已 merge"小 pill 或灰显），防止用户重复合并同一批分支（审查 2-M3） |
| **旧分支降级** | 选中无 forkEntryId 的旧分支（基础层落地前 fork 的） | 提示"该分支无 fork 锚点，将总结整个分支内容"；或 disabled 并提示"旧分支不支持 merge"（审查 2-M4） |

### 已 merge 标记的数据层（⚠️ 待设计项，非已验证）

**核查纠正**：原 spec 把 `lastMergedAt` 持久化当成「确定方案」是**未经验证的假设**。读码确认 `SessionSummary` 是**运行时聚合对象**（`session-scanner.ts:40-55` 的 `listAll` = `svc.getActiveSummaries()` 内存态 + `sessionStore.scanSessions()` 磁盘扫描，两者合并去重），**没有任何字段从持久化层回填 merge 相关状态**：

- `scannedToSummary`（`session-scanner.ts:63-81`）只从 `ScannedSession` 取 **7 个字段**（`id`/`name`/`cwd`/`outcome`/`lastModified`/`filePath` + `git.*`），**不读 `.meta.json` sidecar 之外的任何 merge entry**。即便 merge 写了 JSONL `session_info` 行或 custom_message，scanner 也不解析
- sidecar `.meta.json`（`session-file-utils.ts:79-101`）当前**只承载 session 终态**（`outcome`/`reason`，由 `persistSessionEnd` 写），扩展它的 schema 要同步改 `scanSessionMeta` 的读取与缓存失效逻辑（`session-file-utils.ts:115-128`）
- active 路径的 `toSummary`（`session-service.ts:567-570` 等）从内存 `IManagedSessionView` 取数，merge 状态要在这条路径也注入

**待设计项**（实现时先验证再编码）：
1. **存哪**：JSONL append（参照 `persistSessionName`，`session-file-utils.ts:204` — 但注意它只写 `session_info` 类型，merge 状态没有现成 entry 类型）还是 sidecar `.meta.json` 扩展（参照 `persistSessionEnd`，需扩 schema + 同步改 scanner 读回 + 缓存失效）
2. **scanner 怎么读回**：`scannedToSummary` 当前不读 merge 相关 entry，**必须扩展**——加 sidecar 字段读取 或 加 JSONL 尾读找 merge entry
3. **active 路径注入**：`toSummary` 也要读出 `lastMergedAt` 注入 `SessionSummary`

**v1 可降级方案**（推荐先落地）：`lastMergedAt` **只存内存**（runtime `IManagedSessionView` 加字段，merge 成功后 `session-service` 更新内存态）——不持久化，runtime 重启后丢失。先解决「**同一 session 内（不重启 runtime）不重复合并同一批分支**」的基本需求。持久化作为 v2 跟进，待 scanner 扩展方案验证后再做。

> ⚠️ 不降级的代价：若 v1 硬上持久化但不改 scanner，会出现「merge 后内存可见标记 / 重启后标记消失」的不一致（违反架构约定 #7.5 双通路）。先用内存降级避免半成品持久化。

## 6. 视觉规范（复用 fast-fork 范式）

| 元素 | 规范 |
|---|---|
| merge 入口 | 侧栏"本会话的分支"小列表头部"merge 选中"按钮（待用户最终确认位置） |
| 分支选择器 | Dialog/Popover，复用 xyz-ui，列出子分支（标题 + 时间 + 状态点）+ checkbox |
| 生成中 loading | 每分支一行，spinner + "正在总结 [分支名]..."，完成打勾 |
| 摘要贴入 composer | 复用 fast-fork composer 模式视觉，chip 文案"已合并 N 个分支摘要 · 编辑后发送" |
| 摘要文本块格式 | `【分支名 · fork 时间】\n<结构化摘要>`，每分支一段 |
| 失败标记 | danger 色标注 + "重试" |

**不用 banner**（架构约定 #3）。**不用左色条 accent**（design-system 反模式）。

## 7. Open Questions

### 7.1 需用户定

1. **merge 入口位置**：侧栏分支列表头部（倾向）/ PanelHeader / message-stream 末尾
2. **必须选中还是默认全选**：倾向必须选中（用户主权，试探分支大部分要丢弃）
3. **composer 草稿保留**：用户不发送就关掉是否保留（倾向保留）

### 7.2 实现时验证项

1. **context event 注入的具体形态**：§3 裁决用 context event（非 before_agent_start）。实现时验证：context event 的 messages 改写是否能让 agent 正确接收差异文本 + schema 强约束（写 `tools/verify-merge-extension.cjs` 覆盖 N=3 + 1 分支需重试场景）
2. **串行 N 分支的 turn 推进**：turn_end 里 sendUserMessage 启动下一分支 turn，时序是否可靠（pi 是否保证前一个 turn 完全结束才开始下一个）
3. **tool result details 捕获**：tool_execution_end 事件的 result 结构，details 字段（structured-output `index.ts:104` 写入）怎么读
4. **extension 读分支 JSONL**：用 Node fs 直接读（无沙箱，已验证），还是 import SessionManager.open。fs 更简单但绕过 pi 的 session 加载逻辑

## 8. 实现锚点

### 8.1 新增文件

- `xyz-merge-extension.js`（项目根）：registerCommand('merge-branches') + setActiveTools + **context event** + turn_end 三件套（§3 技术裁决：context event 非 before_agent_start）
- `packages/runtime/src/services/merge-service.ts`：runtime 侧 merge 编排（收集分支 info、触发 slash command、监听 custom_message 收摘要、回前端）
- `packages/renderer/src/components/panel/merge/`：前端 merge UI（分支选择器 + loading + 贴 composer）

### 8.2 复用现有

- 痛点1 的 parentSession + forkEntryId（基础层，知道分支血缘 + fork 锚点）
- structured-output extension（已注册 structured-output tool，本 spec 复用其 tool + Ajv 校验）
- fast-fork 的 composer 贴入范式 + fork-notice 反馈行范式
- xyz-system-prompt-extension.js 的 before_agent_start hook 先例

⚠️ **structured-output 非 builtin（硬前置依赖）**：`@zhushanwen/pi-structured-output` 在 2026-07-04 改为「Settings → Extensions 推荐安装」（架构约定 #11），**用户可能未装**。读码确认 `setActiveToolsByName`（`pi-mono/.../agent-session.ts:840-855`）对找不到的 tool 名**静默忽略**：

```ts
for (const name of toolNames) {
  const tool = this._toolRegistry.get(name);
  if (tool) { tools.push(tool); validToolNames.push(name); }  // 找不到就跳过，无报错
}
this.agent.state.tools = tools;  // structured-output 未装时 tools=[]
```

→ 若 structured-output 未装，merge extension 的 `setActiveTools(["structured-output"])` 会把活动工具集锁成**空数组**，agent 无任何工具可调，turn_end 兜底重试无效（工具列表为空，重试也是空），状态机死循环到 MAX_BRANCHES 上限才退出。

**merge 入口必须前置检查**：runtime 检测 structured-output 是否在已安装 extension 列表（`ExtensionService` 的已安装清单，按 npm 包名 `@zhushanwen/pi-structured-output` 精确匹配，参照 AGENTS.md #11 推荐机制）。未装时：
- merge 入口 **disabled** + tooltip 提示「需先安装 structured-output 扩展」
- 提供「去安装」按钮跳转 Settings → Extensions
- 不要在用户点 merge 后才报错（用户体验差，且工具集已被锁）

### 8.3 改动现有

- `electron-builder.yml`：extraResources 加 `xyz-merge-extension.js`
- `extension-service.getExtensionPaths`：追加
- `postbuild-validate.sh`：校验产物
- `session-message-handler.ts`：路由 merge 相关 WS/RPC

## 9. 联动与依赖

| 联动点 | 说明 |
|---|---|
| **← 痛点1 基础层** | 强依赖。parentSession + forkEntryId 字段 + 磁盘链路是 merge 前置（知道分支血缘 + fork 锚点） |
| **→ structured-output extension** | 复用其 structured-output tool + Ajv 校验。本 spec 的 extension 负责锁工具集 + 注入 schema，structured-output 负责产出 + 校验 |
| **→ 痛点3 handoff** | 共享"structured-output + 三件套 + slash command + extension"架构。痛点3 用 before_agent_start（单 turn），本 spec 用 context event（串行多分支） |
| **→ pi extension API** | 首次用 setActiveTools + context event 强制结构化输出。验证后为后续 extension 复杂能力铺路 |
| **→ 架构约定 #11** | 新 extension 走 builtin 文件型 |

## 10. 反模式（本 spec 明确禁止）

- **❌ 自动回灌分支结论到主线**：用户失控，试探失败结论污染主线。必须走 composer 编辑
- **❌ 原始差异贴 composer**：token 爆炸。必须先经 structured-output 压缩
- **❌ runtime 调 LLM**：违反"LLM 封装在 pi 内部"。LLM 只在 pi agent loop 内
- **❌ extension 调 completeSimple 绕过 agent loop**：放弃 pi 的 context 构建/token 管理/system prompt 基础设施，重造轮子
- **❌ runtime import pi 代码**：破坏进程隔离
- **❌ 改 pi 代码**：用户明确否决
- **❌ 主线 pi 聚合原始差异**：token 爆炸
- **❌ 自动 merge 全部分支**：试探分支大部分要丢弃，用户必须有权挑选
- **❌ 自己读 JSONL 组 entries 喂 generateBranchSummary**：半重组上下文，且 prompt 模板语义不对（被放弃分支便条 vs 多分支结论聚合）

## 11. 验收 checklist

- [ ] merge 入口在主线 session 有 ≥1 子分支时可见
- [ ] **structured-output 未安装时 merge 入口 disabled + 引导安装**（前置检查，§8.2 硬依赖）
- [ ] **runtime merge-service 配超时兜底**（handler 立即 return 后 runtime 不知何时完成，§4.4 硬缺口）
- [ ] 分支选择器列出子分支，可勾选
- [ ] 确认后 extension 用三件套生成摘要（loading + 串行进度）
- [ ] **LLM 调用 100% 在 pi agent loop 内**（extension 锁工具集让 agent 调 structured-output）
- [ ] 摘要只含 forkEntryId 之后的差异（extension 读分支 JSONL 按 forkEntryId 切片）
- [ ] 摘要符合 schema（structured-output Ajv 校验）
- [ ] N 份摘要贴入主线 composer，可编辑
- [ ] 失败分支有错误标记 + 重试
- [ ] extension 走 builtin 打包路径
- [ ] **不改 pi 代码**（pi-mono 零改动，git diff 核查）
- [ ] **runtime 零 pi import**（grep `@earendil-works` in runtime/src 应零命中）
- [ ] setActiveTools 在 merge 完成后恢复（try/finally + agent_end + session_shutdown hook 三重兜底，防状态泄漏）
- [ ] **用 context event 非 before_agent_start**（串行 N 分支每 turn 注入，见 §3 技术裁决）
- [ ] 贴 composer 时加引导前缀（"请综合成一份总结…"）
- [ ] 分支选择器过滤 streaming 中分支（完成态门控）
- [ ] 已 merge 分支有 lastMergedAt 标记 + 默认不勾选
- [ ] 主线处理过程的 entry 折叠灰显（污染控制）
- [ ] 无 token 爆炸（贴入的是结构化摘要非原始差异）

## 12. 路线图位置

依赖痛点1 基础层，是"session 工作树"心智层第二块：

```
基础层（痛点1 §8.1）→ 痛点1 fork 体验（§8.2-8.5）
                        ↓
                     基础层就绪（parentSession + forkEntryId 可见）
                        ↓
              痛点2 merge（本 spec）← 三件套 + structured-output
              痛点3 handoff ← 三件套 + 新建空白 session
```
