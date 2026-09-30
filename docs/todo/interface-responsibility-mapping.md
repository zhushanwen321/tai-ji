# `interface/` 职责归位：文件 → 类别映射与目标结构

范围：`extensions/universal/subagent-workflow/src/interface/`（36 个文件 = 25 个非测试源文件 + 11 个测试文件/fixture）。
出处：`docs/todo/subagent-workflow-issues.md` §2.0 表 D3（按 command / format / gui / tool / tui 五类归位，先出映射与目标结构，再分五批搬迁，每批行为等价）。本条只做结构归位，不改任何判定逻辑。

说明一处口径差异：§2.5 写的「`interface/` 22 文件」= 顶层非测试源文件数（实际 22 个，逐个核过）；`views/` 下 3 个非测试源文件与 11 个测试文件未计入该口径，本文件全部列出。

---

## 0. 数字与结论的核实方法

| 项 | 方法 | 备注 |
|---|---|---|
| 行数 | `find src/interface -type f \| sort \| xargs wc -l`（工作目录 = `extensions/universal/subagent-workflow`） | 合计 11,153 行 |
| 导出面 | 逐个文件读源码 + `grep -nE "^\s*export\b"` | 导出名逐条来自读到的内容，不按文件名推断 |
| import 面 | 遍历全仓 `.ts/.js/.mjs/.vue`（排除 `node_modules`/`dist`/`.git`），抽出 `from` / `vi.mock` / 动态 `import()` / `require()` 的字面量，对相对路径做 `path.resolve` 后与目标文件**全路径比对**，再按批次去重统计 | 仅按文件名 grep 会误命中同名文件（实测误命中 `packages/pi-rpc/src/commands.ts`、`packages/core/src/transport/mock/file.ts` 里的 `format.ts` 字符串、`packages/renderer` 测试里的提示文本），下表数字均为 resolve 后比对的结果 |
| 跨类 import 边 | 同上的 resolve 比对，并抽出被导入符号名 | 见 §2.3 |
| 路径型依赖（非 import） | `grep -rn "readFileSync\|readSrc\|path.join"` 定向核对 | 见 §3 各批风险点 |

---

## 1. 现状清单

### 1.1 非测试源文件（25 个）

类别取值：`command` / `format` / `gui` / `tool` / `tui` / `other`。导出面列出全部导出名（超过 8 个的只列前 8 个并标总数）。

| # | 相对路径（`src/interface/` 下） | 行数 | 导出面 | 类别 | 判定依据（头部注释或主要导出） |
|---|---|---|---|---|---|
| 1 | `format.ts` | 716 | `ThemeLike` `formatTokens` `formatElapsedSeconds` `shortId` `statusGlyph` `spinnerGlyph` `sanitizeLabel` `firstLine` …共 **28** 个（含 `ELLIPSIS` `statusDotStr` `formatStatusBadge` `formatRunStatusElapsed` `formatTraceEventLine` `formatTokenStat` `renderTextFallback` `formatActivityLine` `PhaseFoldProjection` `PhaseGroup` `buildPhaseGroups` `formatPhaseLine` `formatAgentOneLiner` 等） | `format` | 头部第 3 行「纯格式化函数.零 Pi 依赖、零 runtime 依赖,可单测.」；导出全部是「值 → 文本/颜色/徽标」的纯函数 |
| 2 | `id-preview.ts` | 12 | `ID_PREVIEW_LENGTH`（1） | `format` | 头部第 3 行「run/subagent 标识符的截断展示口径（单点常量）」，是展示口径常量 |
| 3 | `display-state.ts` | 112 | `RunDisplayStatus` `RunDisplayState` `runDisplayStateOf` `isFailedTerminal` `runToneOf` `formatRunBadge` `runDisplaySignaturePart`（7） | `format` | 头部第 3 行「展示态单一中间表示——run 域所有展示映射的唯一输入」；导出是色调/徽标/签名片段的字符串映射，零 pi-tui 依赖 |
| 4 | `gui-mappers.ts` | 74 | `toGuiCtx` `mapRunStatus` `mapRunIcon`（3） | `gui` | 头部第 2 行「GUI 协议映射辅助函数 —— run/subagent 状态字符串 → 协议 TreeItem 状态 + 图标」 |
| 5 | `bg-notify-render.ts` | 315 | `renderBgNotifyMessage`（1） | `gui` | 头部第 3 行「background 完成通知的对话流渲染器」，经 `pi.registerMessageRenderer` 挂到宿主消息通道 |
| 6 | `subagent-actions.ts` | 176 | `AdapterInput` `adapter` `buildGuiComponent`（3） | `gui` | 头部第 3 行「subagent tool 六 action 的 TUI/GUI 渲染壳」；第 10–11 行「本壳只做渲染：adapter（领域对象 → {content, details}）+ buildGuiComponent（GUI 协议组件）」（边界见 §5） |
| 7 | `command-actions.ts` | 155 | `SubagentRpcAction` `WorkflowRpcAction` `parseSubagentRpcCommand` `parseWorkflowRpcCommand`（4） | `command` | 头部第 2 行「RPC 模式 slash command action 解析纯函数」 |
| 8 | `commands.ts` | 325 | `registerWorkflowsCommand`（1） | `command` | 头部第 4 行「仅注册 /workflows 命令（FR-6）」 |
| 9 | `subagents.ts` | 268 | `SubagentDirectiveDetails` `registerSubagentsCommand`（2） | `command` | 头部第 3 行「/subagents 命令。薄壳——打开 list overlay」；主导出即命令注册函数 |
| 10 | `subagent-tool.ts` | 337 | `registerSubagentTool`（1） | `tool` | 头部第 3 行「`subagent` LLM 工具。薄壳——参数解析 + 调 runtime.execute」 |
| 11 | `subagent-tool-schema.ts` | 172 | `SLUG_MAX_LENGTH`（re-export）`SubagentParams`（2） | `tool` | 头部第 3 行「`subagent` 工具的参数 schema 纯常量叶子（零运行时依赖）」 |
| 12 | `tool-workflow.ts` | 599 | `WorkflowAction` `TOOL_TOP_LEVEL` `WorkflowToolDetails` `registerWorkflowTool` `actionRun` `displayStatusOf` `actionResume`（7） | `tool` | 头部第 2 行「Workflow Extension — workflow tool（4 actions…）」；导出为 tool 注册 + action 实现 + 展示判定 |
| 13 | `tool-workflow-script.ts` | 398 | `ScriptParams` `WorkflowScriptToolDetails` `WorkflowScriptExecuteResult` `buildScriptGui` `registerWorkflowScriptTool` `actionGenerate`（6） | `tool` | 头部第 4 行「workflow-script tool，5 actions（…）」（括号原文为 FR 编号） |
| 14 | `tool-subagents.ts` | 321 | `FAN_OUT_SCRIPT_NAME` `SubagentsToolParams` `SubagentsToolDetails` `generateBatchSlug` `runSubagentsBatch` `registerSubagentsTool`（6） | `tool` | 头部第 4–5 行「本文件是 **tool**（模型调用的批量派发面…名为 `subagents`…）」 |
| 15 | `tool-render.ts` | 342 | `RenderContext` `renderSubagentCall` `renderSubagentResult`（3） | `tool` | 头部第 3 行「对话流 tool block 渲染。renderCall（标题行）+ renderResult」，是 `subagent-tool.ts` 注册时用的渲染回调实现（边界见 §5） |
| 16 | `tool-result.ts` | 40 | `ToolTextContent` `RunStartDetails` `WorkflowToolResult`（3） | `tool` | 头部第 11 行「层归属：Interface（纯类型层，无运行时依赖）」，是三个 tool 结果的公共形状 |
| 17 | `tool-shared.ts` | 152 | `RenderableToolResult` `assertNotAborted` `optionSlugSuffix` `renderTextResult` `RunSpecFromScriptOptions` `buildRunSpecFromScript` `withGuiAttach`（3 个重载声明，1 个名）`throwPrefixed`（9 个名） | `tool` | 头部第 2 行「workflow / subagents / workflow-script 三个 tool 的同粒度共享构件」 |
| 18 | `reentry-guard.ts` | 30 | `ReentryGuardRef` `REENTRY_BUSY_MESSAGE` `acquireReentryGuard` `releaseReentryGuard`（4） | `tool` | 头部第 2 行「Shared reentry guard helpers for workflow tools」；仅被 `tool-workflow.ts` 与 `tool-subagents.ts` 消费（边界见 §5） |
| 19 | `tui-kit.ts` | 305 | `PAGE_SCROLL_DEFAULT` `TerminalRowsSource` `termRows` `BorderTheme` `b` `dash` `dashes` `titleBorder` …共 **14** 个（含 `plainBorder` `walled` `padToVisible` `segFillColored` `truncLine` `wrapText`） | `tui` | 头部第 3 行「TUI 终端零件 kit（post-convergence C4）：全屏视图族的共享零件单点」 |
| 20 | `list-shared.ts` | 84 | `LIST_LIMIT` `ViewState` `DetailKeyContext` `TuiLike` `NotifyFn` `KeyResult` `KeyHandler` `applyFilter`（8） | `tui` | 头部第 3 行「list-view 与 list-component 共享的类型/常量/纯函数，避免两者循环依赖」 |
| 21 | `list-component.ts` | 737 | `SubagentsListComponent`（1） | `tui` | 头部第 3 行「/subagents list 全屏带框左右分屏组件实现」 |
| 22 | `list-view.ts` | 430 | `createSubagentsView` `processKey`（2） | `tui` | 头部第 3 行「/subagents list 全屏带框左右分屏 overlay」，返回 `ctx.ui.custom` 的 overlay 工厂 |
| 23 | `views/WorkflowsView.ts` | 1160 | `ViewActions` `collectNodeLiveProgress` `computeRenderSignature` `createWorkflowsView`（4） | `tui` | 头部第 2 行「Workflow Fullscreen TUI View — Three-level navigation」 |
| 24 | `views/detail-content.ts` | 369 | `LiveProgressView` `projectRecordProgress` `statusLabel` `buildDetailContent` `detailContentLength` `DetailScrollContext` `DetailKeyResult` `processDetailKey`（8） | `tui` | 头部第 2 行「L2 详情内容构建 + 滚动按键处理（纯函数）」，抽取目标是给全屏视图用 |
| 25 | `views/view-constants.ts` | 19 | `SIDEBAR_WIDTH` `PROMPT_FOLD_LINES` `OUTPUT_TRUNCATE_BYTES` `BOX_BORDER_CHARS` `BUDGET_TOKENS_DIVISOR` `MAX_TOOL_CALLS_DISPLAY`（6） | `tui` | 头部第 3 行「workflow 全屏视图族专属布局常量（WorkflowsView + detail-content 消费）」 |

统计：`command` 3、`format` 3、`gui` 3、`tool` 9、`tui` 7，**`other` = 0**。

`other` 为 0 的说明：最接近「不属于五类」的是 `reentry-guard.ts` 与 `tool-shared.ts`——两者都不是 tool 定义或参数/结果处理，而是 tool 执行期的共享小构件。本映射把「tool 定义 + 参数 schema + 结果形状 + 执行期共享构件」一并写进 `tool/` 的准入规则（§2.2），因此不留 `other`。若设计裁决不接受这条准入规则，这两个文件应作为 `other` 留在 `interface/` 根，而不是塞进别的类别。

### 1.2 测试与 fixture（11 个）

| # | 相对路径 | 行数 | 导出面 | 随迁批次 | 说明 |
|---|---|---|---|---|---|
| 1 | `__tests__/capture-tool.ts` | 56 | `CapturedTool` `ScriptResultToolView` `captureTool`（3） | tool | 被 `tool-subagents.test.ts`、`tool-workflow.test.ts`、`tool-workflow-script.test.ts` 相对 import 的 fixture |
| 2 | `__tests__/tool-workflow.test.ts` | 884 | 无模块导出 | tool | 第 77 行以 `join(__dirname, "../tool-workflow.ts")` 读源码 |
| 3 | `__tests__/tool-workflow-script.test.ts` | 557 | 无模块导出（第 273 行 `export const foo = 1;` 是测试用脚本文本，不是模块导出） | tool | 同上形态 |
| 4 | `__tests__/tool-subagents.test.ts` | 492 | 无模块导出 | tool | 第 40 行读 `../tool-subagents.ts` 源码；第 216–217 行断言该源码含字符串 `"interface/subagents.ts"` |
| 5 | `__tests__/tool-prompt-contract.test.ts` | 361 | 无模块导出 | tool | 第 39–42 行读 `../subagent-tool.ts`、`../tool-workflow.ts`、`../tool-workflow-script.ts` 源码文本 |
| 6 | `__tests__/tool-render.test.ts` | 227 | 无模块导出 | tool | import `tool-render.ts` |
| 7 | `__tests__/subagent-tool-path-guard.test.ts` | 174 | 无模块导出 | tool | import `subagent-tool.ts` |
| 8 | `__tests__/tool-workflow-resume.test.ts` | 131 | 无模块导出 | tool | import `tool-workflow.ts`（转发契约） |
| 9 | `__tests__/display-state.test.ts` | 125 | 无模块导出 | format | import `display-state.ts` + `format.ts` |
| 10 | `__tests__/commands-resume.test.ts` | 103 | 无模块导出 | command | import `commands.ts` |
| 11 | `views/__tests__/WorkflowsView.test.ts` | 395 | 无模块导出 | tui | import `WorkflowsView.ts` + `detail-content.ts` |

跨切面测试（`src/__tests__/*`，共 30 余个文件）不随迁，只改其中的 import 路径与 `vi.mock` 路径。

---

## 2. 目标结构设计

### 2.1 目标目录

```
src/interface/
├── command/          # 命令注册与命令参数解析（3 个文件迁入）
├── format/           # 纯格式化与展示口径常量（3 个文件迁入）
├── gui/              # GUI 协议映射与宿主消息/组件适配（3 个文件迁入）
├── tool/             # pi tool 定义、参数 schema、结果形状、tool 执行期共享构件（9 个文件迁入）
├── tui/              # 终端视图与零件（4 个文件 + views/ 3 个文件迁入）
│   └── views/        # 全屏视图族（保留一层子目录，位置与文件名不变）
└── __tests__/        # 迁移完成后应为空（测试随各自类别迁入 <类别>/__tests__/）
```

`package.json` 的 `files` 白名单是目录级 `"src/interface/"`，新增子目录自动包含，**不需要改 package.json**。

### 2.2 准入规则与禁止项

| 类别 | 准入规则（什么样的文件属于这一类） | 禁止项 |
|---|---|---|
| `command/` | 注册 pi slash command、解析命令参数串、把命令分发到 service/lifecycle 或视图入口的文件 | 不得含领域判定与拒绝文案（入参校验、拒绝分流必须来自 core）；不得内联构造 GUI 协议组件（走 `gui/`）；不得内联格式化文本（走 `format/`） |
| `format/` | 输入是值、输出是文本/颜色/徽标/宽度口径的纯函数与展示常量；可单测、无宿主状态 | 不得 import pi-tui 的组件类（只允许 `visibleWidth` / `truncateToWidth` 这类纯函数）；不得读 runtime / service / 聚合根状态；不得定义布局常量（布局归 `tui/`） |
| `gui/` | 把领域对象映射成宿主 GUI 协议形状（`extension-protocol` 的 `GuiContext` / `GuiComponent` / `TreeItem`），或渲染宿主自定义消息块的文件 | 不得含领域规则（状态判定必须取 core 投影，例如 `display-state.ts` 的 `runSummary` 单源）；不得定义 tool 参数 schema |
| `tool/` | 定义/注册 pi tool（含 action 实现与 `renderCall`/`renderResult` 回调实现）的文件；tool 参数 schema；多个 tool 共用的结果形状与执行期共享构件（入口前置检查、结果渲染片段、重入检查、GUI attach 单点） | 不得复制 core 已有的领域判定（`tool-workflow.ts` 的 resume args 校验已归 core，是这条规则的先例）；不得新增对 `src/` 其它目录的相对 import |
| `tui/` | 终端视图（overlay 全屏视图、列表视图、详情区）与终端零件（边框/布局/翻页/按键分发）的文件 | 不得直接读写运行态 store（现行实现经 core service 与聚合根读，见 `list-component.ts:9` 的依赖说明）；不得新增非终端输出通道（通知/消息渲染归 `gui/`） |

`tui/` 的 `views/` 子目录保留：`WorkflowsView.ts` 已按行数上限抽出 `detail-content.ts`（`WorkflowsView.ts:72`），把这层压平只会让文件数与行数检查更难维护。

### 2.3 现状跨类 import 边（搬迁只改路径，不消除这些边）

按 §2.1 分组后的跨类边（`source → target`，括号内是被导入的符号）：

| 边 | 具体 | 方向性质 |
|---|---|---|
| `gui → format` | `bg-notify-render.ts → format.ts`（`firstLineSanitized` `shortId` `statusGlyph` `ThemeLike`）；`subagent-actions.ts → id-preview.ts`（`ID_PREVIEW_LENGTH`） | 允许（`gui/` 用纯格式化） |
| `gui → tui` | `bg-notify-render.ts → tui-kit.ts`（`padToVisible` `truncLine`） | 允许（终端布局零件） |
| `gui → tool` | `subagent-actions.ts → tool-shared.ts`（`withGuiAttach`） | **反向边**：`gui/` 依赖 `tool/` 的 attach 单点 |
| `command → format` | `commands.ts → id-preview.ts`（`ID_PREVIEW_LENGTH`） | 允许 |
| `command → tui` | `commands.ts → views/WorkflowsView.ts`（`createWorkflowsView` `ViewActions`）、`commands.ts → list-shared.ts`（`LIST_LIMIT`）、`subagents.ts → list-shared.ts`（`LIST_LIMIT`）、`subagents.ts → list-view.ts`（`createSubagentsView`） | 允许（命令打开视图） |
| `command → tool` | `commands.ts → tool-workflow.ts`（`displayStatusOf`） | 允许但值得注意：命令壳直接取 tool 文件的展示判定 |
| `tool → format` | `subagent-tool.ts → format.ts`（`extractAgentName`）、`tool-render.ts → format.ts`、`tool-shared.ts → format.ts`（`renderTextFallback`）、`tool-workflow.ts → format.ts`（`formatRunStatusElapsed`）+ `id-preview.ts` | 允许 |
| `tool → gui` | `subagent-tool.ts → gui-mappers.ts`（`toGuiCtx`）与 `subagent-actions.ts`（`adapter`）；`tool-workflow-script.ts → gui-mappers.ts`（`toGuiCtx`） | 允许（tool 结果要挂 GUI 组件） |
| `tool → tui` | `tool-render.ts → tui-kit.ts`（`truncLine`） | **反向边**：`tool/` 依赖 `tui/` 的布局零件（仅 1 个符号） |
| `tui → format` | `list-component.ts`、`list-view.ts`、`views/detail-content.ts`、`views/WorkflowsView.ts → format.ts`（`ThemeLike` `formatElapsedSeconds` `formatTokenStat` 等）与 `display-state.ts`（`runDisplayStateOf` `formatRunBadge` `runDisplaySignaturePart`） | 允许 |
| `tui → tool` | `views/WorkflowsView.ts → tool-workflow.ts`（`displayStatusOf`） | **反向边**，与 `tool → tui` 构成目录级双向依赖 |

三条反向边（`gui → tool`、`tool → tui`、`tui → tool`）是现状事实。搬迁批次只改路径，**不消除**它们；消除需要单独裁决（候选：`displayStatusOf` 与 `runDisplayStateOf` 合并到 `format/`；`withGuiAttach` 移到 `gui/`；`truncLine` 由 `format/` 转出）。这些属后续独立小改，不并入本五批。

---

## 3. 搬迁批次

顺序建议：**批 1 format → 批 2 tui → 批 3 gui → 批 4 command → 批 5 tool**（按「参与的外部耦合面」由小到大；批 2/3/4 可互换，批 5 必须靠后）。

通用动作（每批都做）：

1. `git mv` 本批文件到 `<类别>/`（`views/` 保持子目录层级）。
2. 改本批文件内**所有**相对 import：指向同批文件改为新相对路径，指向尚未搬迁的 `interface/` 根文件改为 `../xxx.ts`（从 `<类别>/` 看）或 `../../xxx.ts`（从 `<类别>/views/` 看）。
3. 改批外 import 者的相对路径（下表「import 面」逐个数出）。
4. 改 `vi.mock` 路径、源码文本读取路径、`docs/testing/e2e-map.json` 登记（仅批 5 涉及）。
5. 门禁：仓库根 `pnpm extensions:typecheck && pnpm extensions:lint && pnpm extensions:test`；涉及 vitest 的定向跑测从 `extensions/universal/subagent-workflow` 目录发起（AGENTS.md 测试红线：禁止从包目录外触发扫描式跑测）。

### 批 1：`format/`（3 个文件，840 行）

涉及：`format.ts`（716）、`id-preview.ts`（12）、`display-state.ts`（112）；测试 `__tests__/display-state.test.ts`（125）随迁为 `format/__tests__/display-state.test.ts`。

import 面（真实数字，命令与结果见 §0 方法）：

```
批外 import 者 = 15 个文件（其中测试 4、barrel 0）
  src/__tests__/format.test.ts
  src/__tests__/list-component.test.ts
  src/interface/__tests__/display-state.test.ts        （随迁）
  src/interface/bg-notify-render.ts
  src/interface/commands.ts
  src/interface/list-component.ts
  src/interface/list-view.ts
  src/interface/subagent-actions.ts
  src/interface/subagent-tool.ts
  src/interface/tool-render.ts
  src/interface/tool-shared.ts
  src/interface/tool-workflow.ts
  src/interface/views/WorkflowsView.ts
  src/interface/views/__tests__/WorkflowsView.test.ts
  src/interface/views/detail-content.ts
批内互引 = 1 个文件（display-state.ts → format.ts）
vi.mock 命中 = 0 处；e2e-map 登记 = 0 处；跨包候选路径 = 0 处；barrel（src/index.ts）= 0 条
```

风险点：

- `format.ts` 是 `interface/` 内被引最多的模块（14 个 import 者）；改动量大但全部是机械路径替换，无 `vi.mock`、无 barrel、无测试断言源码文本，且导出全是纯函数 → 等价性由既有 `format.test.ts` / `display-state.test.ts` 直接锁住。
- `format.ts` 的头部注释（第 10、417、425 行）声称布局家族「经 re-export 保持既有导入面」，实测该文件**没有**任何 `./tui-kit.ts` 的 import 或 re-export（`grep -n "tui-kit" src/interface/format.ts` 只命中 3 行注释）。搬迁时不要照注释假设存在 re-export 面，实际消费方（`bg-notify-render.ts` / `tool-render.ts` / 测试）都是直接 import `tui-kit.ts`。
- `src/__tests__/format.test.ts`（不随迁）同时 import `format.ts`（批 1）与 `tui-kit.ts`（批 2）；`display-state.test.ts` 随本批迁入 `format/__tests__/`：这两个文件的路径在本批与批 2 各改一次，属预期内的两轮改动。

### 批 2：`tui/`（7 个文件，3,104 行）

涉及：`tui-kit.ts`（305）、`list-shared.ts`（84）、`list-component.ts`（737）、`list-view.ts`（430）、`views/WorkflowsView.ts`（1160）、`views/detail-content.ts`（369）、`views/view-constants.ts`（19）；测试 `views/__tests__/WorkflowsView.test.ts`（395）随迁为 `tui/views/__tests__/WorkflowsView.test.ts`。

```
批外 import 者 = 8 个文件（其中测试 4、barrel 0）
  src/__tests__/format.test.ts
  src/__tests__/list-component.test.ts
  src/__tests__/truncline-snapshot.test.ts
  src/interface/bg-notify-render.ts
  src/interface/commands.ts
  src/interface/subagents.ts
  src/interface/tool-render.ts
  src/interface/views/__tests__/WorkflowsView.test.ts     （随迁）
批内互引 = 4 个文件（list-component / list-view / views/detail-content / views/WorkflowsView）
vi.mock 命中 = 0 处；e2e-map 登记 = 0 处；barrel = 0 条
```

风险点：

- 本批行数最大（含 1,160 行的 `WorkflowsView.ts`），但没有 `vi.mock` 与 barrel 依赖，属于「改动量集中、耦合面小」。
- 四个批外非测试 import 者（`bg-notify-render.ts`、`commands.ts`、`subagents.ts`、`tool-render.ts`）分别在批 1/3/4 才搬迁：本批要先把它们指向 `tui/` 的新路径，后续批再随自身搬迁改一次。
- `truncline-snapshot.test.ts`（`src/__tests__/`，不随迁）以 `__fixtures__/truncline.snapshot.json` 逐字节锚定 `tui-kit.truncLine` 的输出；fixture 在测试侧目录，只改 import 路径即可，**不要移动 fixture**。
- `views/WorkflowsView.ts` 同时 import `display-state.ts`（批 1 已迁）与 `tool-workflow.ts`（批 5 未迁）：批 2 落地后该文件会同时出现 `../format/display-state.ts` 与 `../tool-workflow.ts` 两种形态，批 5 才收敛为 `../tool/tool-workflow.ts`。

### 批 3：`gui/`（3 个文件，565 行）

涉及：`gui-mappers.ts`（74）、`bg-notify-render.ts`（315）、`subagent-actions.ts`（176）。批内无测试（`gui.test.ts`、`subagent-actions.test.ts` 都在 `src/__tests__/`，不随迁）。

```
批外 import 者 = 10 个文件（barrel 1 + 测试 7 + interface 内其它非测试 2）
  src/index.ts                                          （barrel：renderBgNotifyMessage）
  src/__tests__/bg-notify-render.test.ts
  src/__tests__/gui.test.ts
  src/__tests__/scenario-08-orphan-reap.test.ts
  src/__tests__/scenario-19-orphan-reap-legacy.test.ts
  src/__tests__/session-lifecycle.test.ts
  src/__tests__/session-start-once-guard.test.ts
  src/__tests__/subagent-actions.test.ts
  src/interface/subagent-tool.ts
  src/interface/tool-workflow-script.ts
批内互引 = 1 个文件（subagent-actions.ts → gui-mappers.ts）
vi.mock 命中 = 4 处（scenario-08:80、scenario-19:77、session-lifecycle:105、session-start-once-guard:178，均针对 bg-notify-render.ts）
```

风险点：

- `bg-notify-render.ts` 是唯一被组合根 `src/index.ts:50` import 的本批文件，`vi.mock` 4 处也全部指向它：漏改任意一处 `vi.mock` 路径会让 mock 不生效而测试仍绿（假绿风险），必须逐个改并核对 mock 生效（可用「mock 未命中即报错」的断言或跑完对应测试看是否仍按真实实现走）。
- 本批 2 个批外非测试 import 者（`subagent-tool.ts`、`tool-workflow-script.ts`）属批 5：批 3 落地后这两个文件先指向 `gui/`，批 5 再随自身搬迁改一次。
- `subagent-actions.ts` 反向依赖 `tool-shared.ts`（批 5 未迁）：批 3 落地后为 `gui/subagent-actions.ts → ../tool-shared.ts`，批 5 收敛为 `../tool/tool-shared.ts`。

### 批 4：`command/`（3 个文件，748 行）

涉及：`command-actions.ts`（155）、`commands.ts`（325）、`subagents.ts`（268）；测试 `__tests__/commands-resume.test.ts`（103）随迁为 `command/__tests__/commands-resume.test.ts`。

```
批外 import 者 = 10 个文件（barrel 1 + 测试 9）
  src/index.ts                                          （barrel：registerWorkflowsCommand / registerSubagentsCommand）
  src/__tests__/index-session-start.test.ts
  src/__tests__/rpc-command-handling.test.ts
  src/__tests__/scenario-08-orphan-reap.test.ts
  src/__tests__/scenario-19-orphan-reap-legacy.test.ts
  src/__tests__/sdk-contract.test.ts
  src/__tests__/session-lifecycle.test.ts
  src/__tests__/session-start-once-guard.test.ts
  src/__tests__/workflow-events.test.ts
  src/interface/__tests__/commands-resume.test.ts        （随迁）
批内互引 = 2 个文件（commands.ts / subagents.ts → command-actions.ts）
vi.mock 命中 = 10 处，分布在 6 个测试文件
  src/__tests__/index-session-start.test.ts:78      （commands.ts）
  src/__tests__/scenario-08-orphan-reap.test.ts:84  （commands.ts）
  src/__tests__/scenario-19-orphan-reap-legacy.test.ts:81（commands.ts）
  src/__tests__/session-lifecycle.test.ts:119       （commands.ts）
  src/__tests__/session-start-once-guard.test.ts:187（commands.ts）
  src/__tests__/workflow-events.test.ts:61          （commands.ts）
  src/__tests__/scenario-08-orphan-reap.test.ts:79  （subagents.ts）
  src/__tests__/scenario-19-orphan-reap-legacy.test.ts:76（subagents.ts）
  src/__tests__/session-lifecycle.test.ts:102       （subagents.ts）
  src/__tests__/session-start-once-guard.test.ts:175（subagents.ts）
```

风险点：

- 本批是 `vi.mock` 密度最高的批（10 处 / 6 个测试文件）：`scenario-*` 与 `session-lifecycle` 系列测试靠 mock 掉命令注册来隔离组合根，路径写错会导致测试直接失败（这类 mock 是整模块替换，缺失会报「未导出被 mock 的成员」或真实执行副作用），比批 3 的假绿更易发现，但仍需逐个改。
- 组合根 `src/index.ts` 有 2 条本批 import（第 51、54 行）：只改路径，不改注册顺序与调用位置。
- 源码文本路径 1 处：`src/__tests__/contract.notify-custom-types.test.ts:35` 用 `path.join(SRC_ROOT, "interface/subagents.ts")` 读源码，断言该文件不本地定义 `SUBAGENT_DIRECTIVE_CUSTOM_TYPE` → 必须同批改字符串。
- 跨批注意：`tool-subagents.test.ts:217` 断言 `tool-subagents.ts` 源码含字符串 `"interface/subagents.ts"`。本批不改 `tool-subagents.ts` 的文件头；批 5 若要把该头注释里的路径改成 `command/subagents.ts`，必须同批改这条断言，否则红。

### 批 5：`tool/`（9 个文件，2,391 行）

涉及：`subagent-tool.ts`（337）、`subagent-tool-schema.ts`（172）、`tool-workflow.ts`（599）、`tool-workflow-script.ts`（398）、`tool-subagents.ts`（321）、`tool-render.ts`（342）、`tool-result.ts`（40）、`tool-shared.ts`（152）、`reentry-guard.ts`（30）；测试与 fixture 8 个随迁：`__tests__/capture-tool.ts`、`tool-prompt-contract.test.ts`、`tool-render.test.ts`、`tool-subagents.test.ts`、`tool-workflow-resume.test.ts`、`tool-workflow-script.test.ts`、`tool-workflow.test.ts`、`subagent-tool-path-guard.test.ts`（迁入 `tool/__tests__/`）。

```
批外 import 者 = 20 个文件（barrel 1 + 测试 16 + interface 内其它非测试 3）
  src/index.ts                          （barrel：registerSubagentTool / registerWorkflowTool / registerWorkflowScriptTool / registerSubagentsTool）
  src/interface/commands.ts             （displayStatusOf）
  src/interface/subagent-actions.ts     （withGuiAttach）
  src/interface/views/WorkflowsView.ts  （displayStatusOf）
  src/__tests__/gui.test.ts
  src/__tests__/scenario-08-orphan-reap.test.ts
  src/__tests__/scenario-19-orphan-reap-legacy.test.ts
  src/__tests__/scenario-24-args-mismatch-rejection.test.ts
  src/__tests__/sdk-contract.test.ts
  src/__tests__/session-lifecycle.test.ts
  src/__tests__/session-start-once-guard.test.ts
  src/__tests__/subagent-actions.test.ts
  src/__tests__/workflows-e2e.test.ts
  src/interface/__tests__/*.test.ts     （7 个，均随迁）
批内互引 = 4 个文件（subagent-tool / tool-subagents / tool-workflow / tool-workflow-script）
vi.mock 命中 = 15 处，分布在 4 个测试文件
  scenario-08-orphan-reap.test.ts:78,81,82,83      （subagent-tool / tool-workflow / tool-subagents / tool-workflow-script）
  scenario-19-orphan-reap-legacy.test.ts:75,78,79,80（同上 4 个）
  session-lifecycle.test.ts:99,108,113,116         （同上 4 个）
  session-start-once-guard.test.ts:172,181,184     （subagent-tool / tool-workflow / tool-workflow-script）
```

需要同批改的**非 import 路径面**（这是本批风险集中的真正原因）：

| 登记处 | 现状 | 不改的后果 |
|---|---|---|
| `docs/testing/e2e-map.json` | `interface/tool-subagents.ts` 出现 4 次（E2E-BATCH-01 的 `assets[].ref`、E2E-BATCH-02 的 `scope` + `assets[].ref`、E2E-BATCH-04 的 `assets[].ref`）；`interface/subagent-tool-schema.ts` 出现 2 次（E2E-BATCH-05 的 `scope` + `assets[].ref`） | `node scripts/validate-e2e-map.mjs` 的 `assets[].ref` 强校验要求磁盘存在 → 文件移动后直接报错；`scope` 是精确路径全等匹配（`scripts/select-affected-e2e.mjs` 的 `scopeCovers`），旧路径不再命中 → 按改动范围选 e2e 时静默漏选 |
| `extensions/universal/structured-output/tests/cross-package-contract.test.ts` | `SW_TOOL_SCHEMA_CANDIDATES = ["../../subagent-workflow/src/interface/subagent-tool-schema.ts"]`（唯一候选） | 定位失败会 `ctx.skip()` 降级（测试仍绿但不校验），必须在候选数组里改成新路径 |
| `src/__tests__/prompt-quality.test.ts` | `readSrc("src/interface/tool-workflow.ts")`、`readSrc("src/interface/tool-workflow-script.ts")`、`readSrc(join("src","interface","tool-workflow-script.ts"))` | 读不到文件 → 测试直接抛错 |
| `src/interface/__tests__/*.test.ts`（随迁） | 以 `join(__dirname, "../tool-*.ts")` / `"../subagent-actions.ts"` 读源码文本 | 随迁进 `tool/__tests__/` 后 `../xxx.ts` 仍指向 `tool/`，路径形态不变，**但** `tool-subagents.test.ts:217` 对源码文本的断言含 `"interface/subagents.ts"` 字面量，需与本批的文件头注释保持一致 |
| `docs/extensions/subagents/architecture.md` | 第 126 行机制落点表引用 `shell interface/tool-subagents.ts`（另一处 `interface/` 引用在同文件） | 该文档是 AGENTS.md 登记的资产，且 `scripts/check-doc-symbol-drift.mjs` 的映射**不含**该文件 → 机器不拦，必须人工同批回写 |

风险点补充：

- 本批 9 个文件中 `tool-render.ts`（`→ tui-kit`）、`tool-workflow-script.ts`（`→ gui-mappers`）在批 2/3 落地后已有跨类路径：批 5 要把它们从 `../tui-kit.ts` / `../gui-mappers.ts` 改成 `../tui/tui-kit.ts` / `../gui/gui-mappers.ts`（路径串变化）。
- `tool-workflow.ts` 保留 `journalDir = dirname(store.stateFilePath(runId))` 的同源要求（§2.5 已登记：core 按模块锚解析会静默读成「无记录」）；搬迁不得触碰这段，只改 import。
- 本批 `vi.mock` 15 处全部集中在 4 个测试里（`scenario-08`、`scenario-19`、`session-lifecycle`、`session-start-once-guard`），这 4 个测试都 mock 掉组合根注册面（`subagent-tool` / `subagents` / `bg-notify-render` / `tool-workflow` / `tool-subagents` / `tool-workflow-script` / `commands`）→ 路径漏改会表现为「真实注册被执行」，比批 3 的假绿更早暴露。

---

## 4. 边界与不做的事

**不该动的文件**

- `interface/tool-workflow.ts`：其领域规则部分（D14 resume args 一致性判定，含篡改检测与三套拒绝文案）已下沉 core 单源 `orchestration/resume-args-guard.ts`；壳内只剩装配（把 `args` 与 `journalDir` 传给 `resumeRun`）与成功文案。判断：**装配职责留在 `tool/`**，不迁 core、不切分、不改判定位置；`readHistoricalArgs` 与壳内 record 流 JSONL 解析已不存在，不重新引入。
- `interface/` 之外的 `src/` 文件（`host/`、`injectors/`、`session-lifecycle.ts`、`workflow-events.ts`、`jsonl-run-store.ts`、`model-events.ts`、`subagents-events.ts`、`workflow-notify.ts`）：不动实现，只改 import 路径——实测这些文件中只有 `src/index.ts` 需要改（7 条 interface import，见 §3 各批）。
- 跨切面测试（`src/__tests__/*`）：不随迁、不重组，只在其 import 的模块搬迁时改路径。
- `src/__tests__/__fixtures__/truncline.snapshot.json`：位置与内容都不动（批 2 只需改测试里的 import 路径）。

**搬迁后应保持原样的依赖**

- 对 `@zhushanwen/subagent-core` 的获取方式保持 barrel：25 个非测试源文件里 **19 个** 经 barrel 取符号，非测试源文件中**没有**深路径 import（唯一的 deep path 出现在 `subagent-actions.ts:6` 的注释里）。搬迁不得顺手改成深路径，也不得要求 core 新增导出。
- 对 `@zhushanwen/extension-protocol`（6/25 文件）、`@earendil-works/pi-tui`（13/25）、`@earendil-works/pi-coding-agent`（12/25）、`@zhushanwen/pi-extension-logger`（3/25）、`@zhushanwen/pi-ext-guards`（4/25）、`@earendil-works/pi-ai`（4/25）、`typebox` 的依赖保持原样，不借搬迁调整包级依赖方向。
- `interface/` 内部**没有**任何指向该目录之外的相对 import（实测 `grep -rn 'from "\.\./' src/interface/*.ts` 无命中，`views/` 下的 `../` 也只落在 `interface/` 内）——搬迁只改 `interface/` 内部相对路径，不触碰跨目录相对引用。

**明确不做**

1. 不为 `interface/` 新增统一 barrel（`index.ts`）：会掩盖 §2.3 的跨类边，且让每次搬迁变成两轮改动。
2. 不在搬迁批里消除 §2.3 的三条反向边（`gui → tool`、`tool → tui`、`tui → tool`）；每批只改路径，保证行为等价。
3. 不改 `package.json`（`files` 是目录级白名单）、不改 vitest 配置与测试防线、不改 `docs/todo/subagent-workflow-issues.md`。
4. 不改任何 tool 的 schema、description、错误文案、渲染输出与注册顺序；搬迁批不允许出现「顺手改文案」。
5. 不合并/拆分文件（除 `views/` 保留一层子目录外，目标结构与现状一一对应）。

---

## 5. 待确认（判定留待设计裁决，不是事实缺失）

| # | 条目 | 现状事实 | 缺什么才能定论 |
|---|---|---|---|
| 1 | `subagent-actions.ts` 归 `gui/` 还是 `tool/` | 头部自述是「六 action 的 TUI/GUI 渲染壳」，一半是 GUI 协议组件构造（`buildGuiComponent`），一半是 tool 结果装配（`adapter` 产出 `content`/`details`，被 `subagent-tool.ts` 的 execute 消费） | 分类口径裁决：按「GUI 协议组件构造」归 `gui/`，还是按「tool 结果装配」归 `tool/`。本映射按前者归 `gui/` |
| 2 | `tool-render.ts` 归 `tool/` 还是 `tui/` | 是 `subagent-tool.ts` 注册时传入的 `renderCall`/`renderResult` 实现（tool 定义的一部分），同时是纯终端渲染（import `Container`/`Text`/`truncLine`） | 同上口径：渲染回调算 tool 定义的一部分，还是算终端视图。本映射按前者归 `tool/` |
| 3 | `reentry-guard.ts` 归 `tool/` 还是留 `interface/` 根（`other`） | 不是 tool 定义、不是参数/结果处理，只是被两个 tool 的 execute 消费的重入检查小构件（30 行） | 是否接受 `tool/` 准入规则包含「执行期共享构件」。本映射按接受处理，因此 `other` = 0 |
| 4 | `displayStatusOf`（`tool-workflow.ts`）与 `runDisplayStateOf`（`display-state.ts`）的同源关系 | 两处都是「run → 展示三态」的投影，`display-state.ts:16-17` 注释声明与 `tool-workflow.displayStatusOf` 同源；`views/WorkflowsView.ts` 两边都 import | 是否允许在搬迁之外的独立小改里把 `displayStatusOf` 并入 `format/`，从而消掉 `tui → tool` 反向边。本映射不动它 |
| 5 | `format.ts` 头部注释与实现的偏差 | 注释（第 10、417、425 行）称布局家族经 `format.ts` re-export 保持既有导入面；实测 `format.ts` 无 `./tui-kit.ts` 的 import / re-export | 是注释过期还是曾有 re-export 面被删。不影响搬迁（消费方本就直连 `tui-kit.ts`），但批 1 之前应确认没有遗漏的第三方消费面 |
