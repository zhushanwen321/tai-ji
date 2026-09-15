# Agent-Facing 功能编写指南（pi 专属）

> **方法论入口**：设计或审查 agent prompt 前，先加载 `meta-prompt-creator` skill。
> 它提供 15 条通用原则（P1-P15）+ 9 种载体模式（agent-prompt / tool-description / skill-design 等）+ 审查清单（`review/rubric-<carrier>.md`）。
> 本文档**只补充 meta-prompt-creator 不覆盖的 pi 平台落地契约**——通用方法论不写在这里。

## 为什么单独有这份

meta-prompt-creator 回答「怎么想」「怎么查」，是通用方法论 SSOT。pi 有几项平台特有的格式与调用约定，通用 skill 不该管（也不该重复），统一收在这里。两者关系：

| 文档 | 职责 | 何时读 |
|------|------|--------|
| `meta-prompt-creator` | 通用方法论 + 审查清单 | 设计/审任何 agent prompt 时 |
| 本文档 | pi 专属格式契约 | 写 pi 的 agent.md / registerTool / workflow 时查 |

## 1. agent.md frontmatter 格式契约

| 字段 | 必填 | 说明 |
|------|------|------|
| `name` | 是 | kebab-case，与文件 basename 一致（AgentRegistry 按 basename 匹配）|
| `description` | 是 | **能力摘要，不需触发词**——agent 不是概率匹配加载（区别于 SKILL.md 的 description）|
| `tools` | 是 | 逗号分隔的 pi 工具名；最小权限原则（meta-prompt-creator P2）|
| `color` | 否 | 16 进制色值，仅 UI 标识 |
| `model` | 否 | `inherit`（默认）或 `provider/modelId` |

**tools 语法约束**：列 pi 注册的独立工具名。subagent 启动时经 `--tools` flag 注入（`session-runner.ts` buildSpawnArgs），可用工具集以 pi 已安装版为准——核实方法：`ls node_modules/@earendil-works/pi-coding-agent/dist/core/tools/*.js`（每个文件一个独立工具）。常见的独立工具：`read`/`bash`/`write`/`edit`/`grep`/`find`/`ls`/`glob`/`fd`/`tree`/`structured-output`/`subagent`/`todo`/`goal_control`/`workflow`/`ask_user`/... 注意：`grep`/`find`/`ls` 既是 bash 子命令**也是 pi 独立工具**（pi 用 Rust/独立实现，非调 shell），列进 tools 合法且常见（explorer.md 就这么用）。不要列的是 `cat`/`sed`/`awk` 这类纯 shell 命令（pi 无独立实现，只能经 `bash` 调）。

**tools 缺省语义**（重要）：frontmatter 不写 `tools` → `--tools` flag 不传 → subagent 继承 **pi 完整默认工具集**（不是“无工具”）。这是 `parseAgentFrontmatter`（agent-registry.ts）+ `buildSpawnArgs`（session-runner.ts）的明确行为：`tools` 为 undefined 时 fallback 到全集。通用埵底 agent（general-purpose/worker）故意不写 tools 以保留全集；专用 agent（reviewer/doc-reviewer）显式收窄。**审查时不要把“缺 tools”判为 bug**——先判断该 agent 是否应该用全集。

**核实方法**（审查 agent.md tools 字段前必做，否则误判）：(1) 某工具名是否 pi 独立工具 → `ls dist/core/tools/`；(2) 缺 tools 是刻意继承全集还是遗漏 → 看 agent 职责（通用埵底 = 全集合理；专用 = 应收窄）。

**description 写法**（区别于 SKILL.md）：写「这个 agent 能做什么、领域是什么」，不写「Use when user wants...」。

```
好例："TypeScript/Vue 代码品味审查专家。读取品味文档后执行 P0-P3 四级审查"
坏例："Use when user wants to review TypeScript code"（这是 SKILL.md 的写法，agent 不需要）
```

## 2. 被内置 workflow 调用的 schema 契约

`review-fix-loop` 等编排 workflow 用固定 schema 调 review agent。要接入的 agent 必须在正文里**显式告诉 agent 输出哪些字段**（否则 agent 不知道契约，输出不符 schema 被丢弃）：

```
reviewerSchema = {
  report_content,  // 完整报告 markdown（无 write 工具的 agent 用此返回全文）
  report_file,     // 已写盘的报告路径（有 write 工具的 agent）
  must_fix,        // critical+major 计数（clean 判定 = 此值 === 0）
  suggestion,      // minor 计数
  reconciliation,  // 跨轮对账用，首轮空数组
}
```

**两类 agent 的返回路径**：
- **schema-only agent**（tools 无 write，如 `doc-reviewer`）：经 `report_content` 返回全文，workflow 负责落盘到 `<roundDir>/<report>.md`。
- **write agent**（tools 含 write，如 `reviewer`）：自己写盘后经 `report_file` 返回路径。

约定：参考 `doc-reviewer.md` 作为 schema-only agent 的完整范例（含完成定义 + 防注入声明 + schema 字段说明）。

## 3. AgentRegistry 发现优先级

```
builtin（包内 agents/）< npm global < user .pi/agent < user .agents
< project .pi < project .agents        ← 最高，可覆盖内置同名 agent
```

**接入内置 workflow 的方式**：项目级 agent 放 `.agents/agents/<name>.md`，`batch1` 传该 agent 的 `.md` 绝对路径——即 `<available_subagents>` 注入的 `<location>`（裸名会被 resolveAgentDefs 拒收）。同名覆盖关系由 AgentRegistry 发现优先级决定：项目级源优先级高于内置，覆盖发生在注入 `<location>` 的解析时，调用侧无需感知。

## 4. 防平铺守卫（弱模型兼容）

弱模型常把 workflow args 子字段（`task`/`target`/`batchN`）平铺到 params 顶层，导致 `args={}` 静默启动缺参 run（P0）。

known keys 的来源是 **schema 即 SSOT**：workflow 资产在脚本头 `@pi-meta parameters` 声明参数 schema，宿主经 `argKeysFromMeta`（`packages/subagent-core/src/orchestration/args-meta.ts`）自动派生（exact 属性 + patternProperties），无需人工维护检测清单；tool 顶层键（`action`/`name`/`args` 等）由宿主作为 reservedKeys 注入（`tool-workflow.ts` 的 `TOOL_TOP_LEVEL`），workflow 声明同名参数不会被误判为平铺。

新增 workflow 参数时：
1. 在 workflow 资产的 `@pi-meta parameters` 里声明 schema——known keys 随之自动派生
2. 若该 workflow 有配套 `workflows/<name>-utils.cjs`，**手动同步**其 `VALID_ARG_KEYS` 白名单（如 `packages/subagent-core/workflows/review-fix-loop-utils.cjs`）——utils 是零依赖 .cjs，读不到 schema，白名单只能手维护

检测命中时带 Correct JSON 示例纠正（见 `findFlattenedArgKeys`）。

## 5. workflow meta.description 格式

`meta.description` 进 LLM context，决定主 agent 是否选用此 workflow。

- **what + when + when-NOT**（与 tool description 同，meta-prompt-creator P1/P4）
- 必填参数显式标「必填」，枚举值列出
- **参数语义别单行塞满**——长描述重点被稀释（meta-prompt-creator P14 约束衰减）。结构化分行或详解放 README，description 只留摘要 + 必填项

反面案例：把 8 个参数的完整语义压进 description 单行，LLM 选用时抓不住重点。

## 参考实现

- `packages/subagent-core/agents/doc-reviewer.md` — schema-only review agent 范例（四遍方法论 + 完成定义 + 防注入 + schema 契约声明）
- `packages/subagent-core/agents/reviewer.md` — write 型 review agent 范例
- `packages/subagent-core/workflows/review-fix-loop.js` — 编排 workflow + 配套 utils.cjs

## 审查

审查 agent-facing 改动时，走 `meta-prompt-creator` 的 `flow/review.md` + 对应 `review/rubric-<carrier>.md`（快速审查模式走 P0），再补本文档 §1-§5 的 pi 专属检查项。详见 `.agents/agents/review-extension-api.md` 的「Agent-facing 表面 checklist」章节。
