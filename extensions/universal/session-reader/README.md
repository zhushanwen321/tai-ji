# @zhushanwen/pi-session-reader

按语义结构读取 pi session 文件（对话历史）的工具：`session_read` 提供 11 个 action，覆盖 session 定位、fork/subagent/workflow 家族追踪、渐进式阅读（概览 → 单 turn → 全文）、全文/跨 session 搜索、素材提取、workflow run 概览、subagent 结果获取与环境自检——不需要直接读原始 `.jsonl`。

## 提供的工具

### `session_read`

所有 action 共用一套参数，按 action 取用：

| action | 关键参数 | 用途 |
|--------|---------|------|
| `find` | `query`（uuid 片段 / 文件名 / name 关键词 / `"recent"`） | 定位 session；可选 `cwd` / `source`（`main` / `subagent`）/ `limit`（默认 20）；零匹配返回提示不报错 |
| `family` | `session` | fork 父子 / subagent / workflow 关系；`recursive: true` 返回任意深度嵌套的执行树 |
| `outline` | `session` | turn 级概览（约 1500 token）；`granularity: "entry"` 平铺到 entry、`allBranches` 含废弃侧分支 |
| `expand` | `session` + `turn`（如 `"T013"`） | 单 turn 的 entry 列表 |
| `detail` | `session` + `turns`（如 `"T013-T015"` 或 `"T013"`） | turn 全文；`includeToolResult` / `includeThinking` 控制是否包含噪音（默认省略） |
| `search` | `session` + `pattern` | 全文 grep（子串或正则）；`session` 可传逗号分隔 ≤10 个完整 id 做跨 session 搜索；`scope` 过滤 `user` / `assistant` / `toolResult` |
| `export` | `session` | 物化到文件；`format`: `outline`（默认）/ `full` / `family` |
| `extract` | `session` + `what` | 按类型抽取素材：`user-messages` / `commands` / `files` / `commits` / `tool-results`；`tool` 按工具名过滤 commands/tool-results |
| `workflow` | `session` | workflow run 概览（status / budget / steps）；`runId` 聚焦单个 run；step 的 call sessionId 可跳转 outline/detail |
| `result` | `session` | 取 subagent 最终结果正文（与其完成通知同内容）；单个 id 或逗号分隔 ≤10 个批量；`limit` 限每条字符数（默认 8000，超长截断并附全文文件指引） |
| `doctor` | — | 环境自检：host 环境判定（纯 pi / taiji）+ 候选 session 根目录诊断；`includeSubagents: true` 附带扫描 subagent 根文件数 |

`session` 参数支持四种形态：完整 uuid、uuid 片段（如 `e6c96`）、subagent record id（`sa-xxx` 精确反查）、`.jsonl` 绝对路径（支持 `~` 前缀）；`#` 前缀自动剥离。

**渐进式阅读**：`outline`（概览）→ `expand`（单 turn）→ `detail`(全文)，默认省略 toolResult / thinking 噪音。不用于当前 session（宿主已提供当前会话访问），也不用于编辑 session（pi 有 `/resume` `/fork`）。

## TUI 附加能力（仅 TUI 模式）

- `/session-pick` 命令：交互式选择当前 cwd 目录下的 session
- `#` 前缀自动补全：编辑器输入 `#` 弹出当前目录的 session 引用补全

RPC 模式（如 taiji 子进程）自动跳过 TUI 注册，`session_read` 工具本身不受影响。

## 核心机制

- **分层**：`tool-handler.ts` 纯逻辑 handler（agentDir / 环境信号注入，零 pi 依赖，可单测）+ `index.ts` pi 注册层（registerTool + TUI 挂载）
- **多根发现与降级**：session 根按 [live]（当前 session 目录）→ [default] → [legacy] 及 subagent 根多根合并扫描；`doctor` 可诊断实际生效的根
- **session 解析三形态**：绝对路径直读首行 header → `sa-` 前缀经 record manifest 精确反查 → 片段模糊匹配（多匹配返回消歧候选列表而非报错）
- **错误契约**：handler 抛出含 👉 恢复指引的 Error，pi 置 `isError: true`，模型可按指引一步修正重试
- **成本控制**：标题元数据走 pi `SessionManager.listAll`（仅当前 cwd 目录，惰性调用）；search 长扫描可被 AbortSignal 中断

## 安装

```bash
# npm 方式（正式）
pi install npm:@zhushanwen/pi-session-reader
```

本地开发可用 `--extension` 直接加载：

```bash
pi --extension <repo>/extensions/universal/session-reader/index.ts "<prompt>"
```

## 使用示例

```jsonc
// 定位 session（片段匹配，多命中返回候选列表）
{ "action": "find", "query": "e6c96" }

// 概览 → 深读某段 turn
{ "action": "outline", "session": "e6c96" }
{ "action": "detail", "session": "e6c96", "turns": "T013-T015" }

// 追踪 fork / subagent 家族（嵌套执行树）
{ "action": "family", "session": "e6c96", "recursive": true }

// 取 subagent 最终结果（批量 ≤10）
{ "action": "result", "session": "sa-abc123, sa-def456" }

// 跨 session 搜索用户消息
{ "action": "search", "session": "<id1>,<id2>", "pattern": "登录逻辑", "scope": "user" }

// 抽取全部 bash 命令
{ "action": "extract", "session": "e6c96", "what": "commands", "tool": "bash" }

// 环境自检
{ "action": "doctor" }
```

## 文件结构

```
session-reader/
├── index.ts              # 入口 — re-export src/index.ts
└── src/
    ├── index.ts          # pi 注册层（registerTool + promptGuidelines + TUI 命令/补全挂载）
    ├── tool-handler.ts   # 纯逻辑 handler（action 分发 + session 解析 + 各 action 编排）
    ├── search-across.ts  # search 管线（单 session / 跨 session）
    ├── extract.ts        # extract 预设（user-messages/commands/files/commits/tool-results）
    ├── result-action.ts  # result action（subagent 最终结果，批量 ≤10）
    ├── doctor.ts         # doctor action（host 环境判定 + 根目录诊断）
    ├── no-match.ts       # find 零匹配自检行
    ├── handler-utils.ts  # 低层小工具（pad/err/stripHash/turn 解析等）
    ├── core/             # 解析与渲染（parser / tree / turns / family / execution-tree / workflow / render / toolcall）
    ├── discovery/        # session 发现（roots / find / subagents / workflows / env / session-header）
    └── tui/              # TUI 挂载（session-pick 命令 + # 补全 provider）
```
