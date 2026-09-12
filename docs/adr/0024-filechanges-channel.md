# ADR-0024: FileChanges 数据通道（runtime 解析方案）

- 状态：Accepted

> **性质**：契约/设计先行，本文档不含代码实现。为 flow-2（代码变更审查，[ADR-0020](0020-core-user-flows.md)）启动铺数据地基。
> **关联**：[ADR-0020 核心用户流](0020-core-user-flows.md)、`docs/page-design/archive/v3/flow-2-code-review/spec.md`（flow-2 SSOT）、（v3 重建审计档案 wave-W11/W14 已随 `.v3-audit/` 清理，需求追溯见 git 历史）。
> **类型契约**：见 `src-electron/shared/src/message.ts` 的 `FileChange` / `ChangeSetStatus` / `ReviewDecision`（F2-1 已落地）。

## 上下文

flow-2（代码变更审查）是 v3 核心交互（每天高频主路径）。W11 审计 WP-L3-11 确认：**FileChanges 块全链缺失**——shared 无类型、runtime 不解析文件变更、store 无字段、无渲染组件。变更集卡（5 态状态机）和 Side Drawer ChangeSet Detail（W14 WP-L3-34）都以这条通道为前置数据源。

要落地变更集卡，必须先建立「pi 工具调用 → 文件变更记录 → assistant message.fileChanges」的数据通道。本 ADR 定义 runtime 侧的解析方案。

### 现状事实（改前必读真实代码，行号会漂移）

调研 `src-electron/runtime/src/infra/pi/` 全链 + pi 本体 `packages/coding-agent/src/core/tools/`：

1. **pi 工具集是固定的 7 个**（`core/tools/index.ts` 的 `ToolName` 联合）：`read | bash | edit | write | grep | find | ls`。**没有** `mkdir`/`notebook_edit`/`multi_edit`/`create_file`/`delete`。
2. **文件变更型工具只有 3 个**：`write`、`edit`、`bash`。其余 4 个（read/grep/find/ls）只读。
3. **文件路径参数名是 `path`**，不是 `file_path`。pi 仅在 `write.ts`/`edit.ts` 的 render 函数里把 `file_path` 当防御性 fallback（`args?.file_path ?? args?.path`）容错模型偶尔发错的参数名——但**协议契约的权威参数名是 `path`**。
4. **runtime 现状不解析任何文件信息**：`event-adapter.ts` 的 `handleToolExecutionStart` 把整个 `args` 原样当 `input` 透传；`handleToolExecutionEnd` 只抽 `result.content[].text` 和 `result.details`，无文件语义。`message-converter.ts` 同样不解析。
5. **pi 无原生「本 session 改过哪些文件」概念**：`get_state` RPC 的 `RpcSessionState` 不含文件字段；coding-agent 全 `src/` 无 `modified_files`/`files_touched`/`changeset`。pi 自家 example extension（`dirty-repo-guard.ts`、`auto-commit-on-exit.ts`）靠 `pi.exec("git", ["status","--porcelain"])` 对账——**git 是事实来源**。
6. **三个变更型工具的 result 差异极大**（决定行数统计可行性）：
   - `edit`：result.details 含 `{ diff, patch, firstChangedLine }`，`patch` 是标准 unified diff（`diff` npm 包 `createTwoFilesPatch`，4 行上下文）——**能解析行数**。
   - `write`：result 只有 `Successfully wrote N bytes to <path>` 文本，`details: undefined`——**无 diff、无行数**，但 `input.content` 是完整新内容可自行分行计数。
   - `bash`：result 只有命令输出文本，`details` 不含文件信息，`input.command` 是自由字符串——**结构化提取不可行**。

## 决策

### D1 · 解析落点：runtime event-adapter，在 `handleToolExecutionEnd` 增量提取

在 `event-adapter.ts` 的 `handleToolExecutionEnd`（现有 tool 完成处理点）内，按 `toolName` 分派，从已结束的工具调用中提取文件变更。**不在 start 时提取**——start 时 result/details 还没到（edit 的行数、write 的成功/失败都依赖 end）。

提取后挂入一个新的 server-push 事件，由 chat store（F2-3 骨架 + flow-2 完整实施）落进 `Message.fileChanges`。

**理由**：event-adapter 是 pi 协议的唯一适配点（CLAUDE.md 项目铁律 #5「pi 适配层不信任外部格式」），文件语义属于「pi 工具知识」，归 adapter 层而非前端。前端拿到的是已规整的 `FileChange[]`，不重复解析 pi 格式。

### D2 · 工具分派表（精确到参数名 + 状态判定）

| pi 工具 | 提取字段 | status 判定 | 行数来源 | 可靠度 |
|---|---|---|---|---|
| `write` | `input.path` | added（新建）或 modified（覆盖）——需文件系统判定：end 前不存在 → added，否则 modified | `input.content` 按 `\n` 分行计 `addLines`；无基线 → `delLines` 缺省 | 高（参数+内容确定） |
| `edit` | `input.path` | 恒 modified（edit 只改既有文件） | 解析 `result.details.patch`（unified diff）：`+` 行计 `addLines`，`-` 行计 `delLines` | 高（diff 现成） |
| `bash` | 无 `path` 字段；仅 `input.command` | 不可判定 | 不可判定 | 低——见 D4 |

**参数名兜底**：按 pi 容错惯例，取 `args.path ?? args.file_path`。优先 `path`（契约权威），`file_path` 作 fallback 兼容模型偶发错发。

### D3 · write 的 added vs modified 判定

write 工具「覆盖既有」时返回的文本不含「文件已存在」信息，无法从 result 区分。两条路径：

- **方案 A（推荐，长期）**：end 前 `fs.existsSync(absolutePath)` 探测。pi 已 `resolveToCwd(path, cwd)` 归一路径，adapter 同样能 resolve。命中存在 → modified，否则 added。
- **方案 B（短期兜底）**：一律标 modified，交 git 对账（D5）纠正。新增文件在 git status 显示 `??`/`A`，对账时覆盖为 added。

**推荐 A**：existsSync 是单次 stat，开销可忽略，避免对账前的瞬时态错标。落地时注意 pi write 有 `withFileMutationQueue` 串行队列，adapter 探测必须在 queue flush 后（即 end 事件已代表写入完成，时序安全）。

### D4 · bash 工具：不试图结构化解析，走 git 对账降级

bash 的 `command` 是自由字符串（`echo > f`、`sed -i`、`mv`、`rm`、`tee`、here-doc、间接调用脚本……）。启发式正则（匹配 `>`/`>>`/`sed -i`/`mv`/`rm` 等）误报漏报都严重，且无法定位具体文件。

**决策：bash 工具不增量提取 FileChange**。bash 引发的文件变更统一由 D5 的 git 对账在回合边界捕获。代价：bash 改的文件在「回合进行中」不出现在变更集卡（accumulating 态不完整），回合结束对账后才补齐。flow-2 spec 的 accumulating→ready 过渡正是容纳这个延迟的设计（accumulating 带 loading 指示，ready 才等审查）。

**不引入** bash command 解析器（user-memory「不加推测性功能」：当前无需求证明需要细粒度 bash 追踪，git 对账已覆盖审查场景）。

### D5 · git 对账：回合边界（agent_end）的真值校正

`agent_end`（或 pi 的 `turn_end` extension event）时，runtime 在工作目录执行 `git status --porcelain` + `git diff --name-only`，把 git 视角的 A/M/D 文件集与「本回合已收集的 FileChange[]」做并集校正：

- 增量提取漏的（主要是 bash 改的、edit 工具被 retry 覆盖的）→ 补入
- 增量提取错标的（如 write 标 modified 实为 git 视角 `??` 未跟踪新文件）→ 校正为 added
- 已删除文件（git `D`）→ 补 deleted（增量提取永远捕不到 delete，因为没有「delete 工具」）

git status 的 `XY` 码映射到 `FileChangeStatus`：`A`/`??`→added，`M`→modified，`D`→deleted，`R`/`C`→modified（重命名记为目标路径 modified，src 删除细节留 diff 层）。

**这是唯一能可靠捕获 delete 和 bash 变更的机制**，也是 pi 自家 extension 的做法。实现注意：cwd 必须取 pi session 的工作目录（非 runtime 进程 cwd），需从 session 上下文拿；非 git 仓库时跳过对账（只信增量提取，变更集卡标注「非 git 仓库，可能不完整」）。

### D6 · 推送时机：增量 + 回合对账双段

变更集卡 5 态状态机（`ChangeSetStatus`）对推送时机有硬约束：

- **accumulating 态**（agent 工作中）：每个 `edit`/`write` 的 `tool_execution_end` 推一次增量（status 标 accumulating），文件数实时增长，卡带 loading。前端据此即时刷新「N 个文件变更」计数。
- **ready 态**（agent_end）：推一次 git 对账后的完整集合（status 翻 ready），等待用户审查。这是真值收口点。

**不每条 tool_end 都全量重推**——增量推差异（新增的 FileChange），减少前端 diff 成本。变更集卡的累加逻辑（同 filePath 合并、status 取最新）在 chat store 侧（F2-3 + flow-2 实施）。

### D7 · 新事件协议（ServerMessageType 扩展）

新增 server-push 事件（暂定名 `message.file_changes`，加入 `protocol.ts` 的 `ServerMessageType` 联合）：

```
{ type: 'message.file_changes',
  payload: {
    sessionId: string,
    messageId: string,            // 挂到哪条 assistant message
    changes: FileChange[],        // 本帧增量（accumulating）或全集（ready）
    changeSetStatus: ChangeSetStatus,  // accumulating | ready（本通道只推这两态）
    isFullSet: boolean            // true=对账后全集替换，false=增量追加
  } }
```

`partially-reviewed`/`resolved`/`superseded` 三态由前端用户交互（Accept/Reject，W14 Side Drawer）驱动，不经 runtime 推送——所以本通道只承载 accumulating/ready。这维持「runtime 推事实、前端管审查状态」的职责切分。

`isFullSet` 标志让 store 无需自己判断是合并还是替换：ready 帧用 `isFullSet:true` 全量替换（git 对账是权威真值），accumulating 帧用 `isFullSet:false` 增量合并。

### D8 · 集成点（改哪些文件，flow-2 实施时落地）

| 文件 | 改动 | 时机 |
|---|---|---|
| `shared/src/protocol.ts` | `ServerMessageType` 联合加 `'message.file_changes'` | flow-2 实施 |
| `shared/src/message.ts` | 已完成（F2-1：FileChange/ChangeSetStatus/ReviewDecision + Message.fileChanges） | ✅ 本 Wave |
| `runtime/src/infra/pi/event-adapter.ts` | `handleToolExecutionEnd` 增 write/edit 分派提取 + D3 existsSync 判定；emit `message.file_changes`（incremental, accumulating） | flow-2 实施 |
| `runtime/src/infra/pi/`（新增模块） | git 对账器（D5），订阅 agent_end/turn_end 事件触发 | flow-2 实施 |
| `runtime/src/infra/pi/pi-protocol.ts` | 如订阅 turn_end extension event，补事件类型（pi `extensions/types.ts:1123` 已有 turn_end，本仓库 PiEvent 联合需对齐） | flow-2 实施 |
| `renderer/src/stores/chat.ts` | `appendAssistantChunk` 加 `message.file_changes` case（替换现有 `default: return` 静默丢弃） | F2-3 骨架 + flow-2 实施 |
| `renderer/src/components/panel/message-stream/FileChanges.vue` | 变更集卡渲染（5 态状态机 + A/M/D badge + 行数） | W11 WP-L3-11（flow-2 完整） |
| `renderer/src/components/panel/drawer/ChangeSetDetail.vue` | Diff 审查 + Accept/Reject | W14 WP-L3-34（flow-2 完整） |

## 理由

1. **分层归位**：文件语义属 pi 协议知识，归 event-adapter（pi 适配层），前端拿规整后的 `FileChange[]`，不重复解析 pi 格式。符合 CLAUDE.md 铁律 #5 和 context.md「EventAdapter = pi 事件 → ServerMessage 翻译」职责定义。

2. **git 作为真值收口**：pi 自身不追踪文件改动，增量提取（write/edit）注定漏 bash/delete/重试覆盖。git 对账是唯一可靠的真值来源，也是 pi 生态既定做法。把 git 对账放回合边界而非每条 tool，平衡准确性与开销。

3. **状态机职责切分**：runtime 只推 accumulating/ready（事实态），partially-reviewed/resolved/superseded（审查态）归前端用户交互。避免 runtime 反向感知 UI 决策的耦合。

4. **不解析 bash command**：尊重「不加推测性功能」——当前无需求证明需要细粒度 bash 追踪，git 对账已覆盖审查场景。避免维护一个注定误报漏报的正则集。

## 结果与权衡

**优点**：
- write/edit 高频路径有即时增量（accumulating 态体验流畅）
- git 对账保证 ready 态真值完整（含 delete/bash/重试）
- 类型契约先行，flow-2 实施时前端/runtime 并行无阻塞

**代价**：
- accumulating 态对 bash 改的文件不完整（回合结束才补齐）——可接受，spec 的 accumulating→ready 过渡正是为此设计
- 非 git 仓库场景只能信增量提取（无 delete/bash 覆盖），需在变更集卡标注降级态
- existsSync 探测（D3 方案 A）依赖 pi write 队列 flush 完成时序，实施时需验证

**待 flow-2 实施时确认的开放项**：
- pi `turn_end` extension event 在本仓库 `PiEvent` 联合里的对齐（D5/D8）
- 非 git 仓库的降级 UI 文案
- 跨多 turn 的 superseded 变更集归档时机（属前端，非本通道）

> 落地步骤已删除：实现由代码承载（源码内 // ADR-0024 锚点可回链），git 历史可追溯（2026-09-13 ADR 瘦身）

## 调研证据索引

| 事实 | 证据位置 |
|---|---|
| pi 7 工具联合类型 | `pi core/tools/index.ts` `ToolName` / `allToolNames` |
| write 参数 `path`+`content`，result 无 diff | `pi core/tools/write.ts`（schema + result `{content:[{text:"Successfully wrote N bytes..."}], details:undefined}`） |
| edit 参数 `path`+`edits[]`，result.details 含 patch/diff | `pi core/tools/edit.ts`（schema + `EditToolDetails{diff,patch,firstChangedLine}`） |
| bash 参数 `command` 无 path | `pi core/tools/bash.ts`（schema `{command, timeout?}`） |
| pi 无原生文件追踪；git 是既定做法 | pi `get_state` RpcSessionState 无文件字段；example `dirty-repo-guard.ts`/`auto-commit-on-exit.ts` 用 `git status --porcelain` |
| runtime 现状不解析文件 | `runtime/src/infra/pi/event-adapter.ts` handleToolExecutionStart/End（args 原样透传为 input，无 file_path 提取） |
| message-converter 不解析文件 | `runtime/src/infra/pi/message-converter.ts` convertPiHistory（toolCall 只取 name/arguments） |
| pi render 函数 `file_path` 是防御 fallback | `pi core/tools/write.ts` render 内 `args?.file_path ?? args?.path` |

> pi 源码路径：`~/Code/pi-mono-fix-workspace/main/packages/coding-agent/src/core/tools/`（bare repo + worktree；与 `xyz-pi-workspace/main` 同源）。
