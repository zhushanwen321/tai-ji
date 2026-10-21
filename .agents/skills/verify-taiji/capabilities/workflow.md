# workflow · 工作流能力原语（dispatch / runs / overlay / abort / reconnect）

> 骨架遵循 [API-CONTRACT §4](API-CONTRACT.md)：H2 即 capability id。
> 事实源：工具 `extensions/universal/subagent-workflow/src/interface/tool/{tool-workflow,tool-subagents}.ts`；
> 协议 `packages/shared/src/protocol.ts`（`session.getWorkflows` / `session.workflowAction` /
> `session.getWorkflowRunEvents` / `session.getWorkflowDag` / `session.workflowUpdate`）；
> 载荷 `packages/shared/src/workflow.ts`；UI
> `packages/renderer/src/components/panel/workflow-viz/**`（overlay / panel / dag / gantt）+
> `components/panel/tray/TrayNativePanel.vue`。
> testid 权威源 = [docs/testing/02-panels-sidebar.md §W](../../../../main/docs/testing/02-panels-sidebar.md)
> （注意该节有一处**已过时**的「drawer WorkflowTab 回落载体」说法，见 Gotchas 1）。
> mock e2e 资产 = `e2e/workflow-viz-overlay.spec.ts` / `e2e/workflow-sidebar-sync.spec.ts` /
> `e2e/workflow-disconnect-recovery.spec.ts`（e2e-map：E2E-MOCK-01 / E2E-SKILLRELOAD-04）。

## 通用前置

- `env.ready` + `env.doctor`（扩展装载）；**派发同样由 agent 驱动**（无 `workflow_run` 按钮）。
- 观察入口 = composer 任务托盘 `tray-builtin-button[data-kind="workflow"]` → 面板
  `tray-panel[data-panel-key="native:workflow"]` → 行 `tray-workflow-row`（按 `tray-workflow-slug`
  文本精确定位，行 testid 恒定）+ 对话流 `workflow-block` → 全屏 overlay `wfvz-overlay`。
- 托盘 builtin 按钮 **`total === 0` 时不渲染**（`ComposerTray` `builtinItems`）——「没有 workflow 行」
  通常等于「本会话还没有 run」。
- 孙进程（workflow 成员的 agent()）LLM 可达性：**faux 通道不可达（已实测），mock-http 通道可达（已实测）**
  —— SSOT = `capabilities/env.md` + 探针 `scripts/probes/faux-grandchild.mjs`（`verified-unreachable`）/
  `scripts/probes/mock-llm-workflow.mjs`（`mock-workflow-reachable`，两成员 outcome=done）。结构层
  （run 登记 / 列表 / overlay / abort 通道）与执行层（成员真的跑完）**都可零 token 验**：
  执行层用 `createInstance({ llm })` 的 mock-http 通道。
  - 成员剧本硬要求：workflow 模式下 `structured-output` 是单参数合成工具（parameters 即权威 schema），
    成员必须在终局调用它，否则 `schema_deterministic` 失败。
  - 想让成员落「成员演员」队列，需在 `workflow_run` 传 run 级 `model`（否则成员继承主 agent 模型）。

---

## workflow.dispatch · 派发 workflow run

- **通道**：A（对话流 workflow 块 + 托盘行）+ B（工具受理 → `session.workflowUpdate` 信号 →
  `session.getWorkflows` 列表）+ C（`ext-sessions/<rootSid>/workflow/runs/<runId>.record.jsonl`）
- **前置**：`requires` = faux（结构层）| **mock-http | live**（执行层）；依赖 `session.create`
  `chat.send` `chat.wait` `subagent.dispatch`（批量为 fan-out）`workflow.runs`
- **用于**：`p0-workflow-run`（主）、`p0-subagent-dispatch`（批量形态）、`p0-workflow-abort`

### 入口（用户 POV / 协议 / 副作用点）

#### 先问：workflow 脚本从哪来？（不搞清这条，`workflow_run` 必报 `workflowNotFoundMessage`）

`workflow_run.name` 必须是**已发现脚本的绝对路径或注册名**，来源是资源发现（7 源同名
last-writer-wins，优先级低→高，SSOT = `packages/subagent-core/src/shared/resource-discovery.ts`）：

| 序 | 源 | 路径 |
|---|-----|------|
| 1 | user pi agent | `~/.pi/agent/workflows/*.{js,mjs}` |
| 2 | user .agents | `~/.agents/workflows/` |
| 3 | npm global | 全局安装的 pi 包（`pi.workflows` manifest） |
| 4 | npm dev | dev-link 包（`pi.workflows` manifest） |
| 5 | ext-paths | `TAIJI_EXTENSION_PATHS` 指向的包（extension 内置 workflow） |
| 6 | project .pi | `<cwd>/.pi/workflows/` |
| 7 | project .pi/.tmp（**仅 workflow**） | `<cwd>/.pi/workflows/.tmp/` |
| 8 | project .agents（**最高**） | `<cwd>/.agents/workflows/` |

- **extension 内置 workflow**（如 `@zhushanwen/pi-subagent-workflow` 的 `fan-out`）经 `pi.workflows`
  manifest 发现；`subagents` 工具的批量能力**固定**走内置 `fan-out` 模板（`FAN_OUT_SCRIPT_NAME`）。
- **内置模板**（review-fix-loop 等）与**用户自写脚本**走同一发现链——没有第二套注册表。
- 验收时**怎么知道有哪些脚本**：agent 侧看 `<available_workflows>`（就是上面 8 源合并后的清单）；
  人工侧对照上表直接 `ls`。找不到 = 脚本没放进任何源目录（这是 `workflowNotFoundMessage` 的唯一成因）。
- 本技能的测试脚本放 `fixtures/workflows/fanout-canary.workflow.js`，探针里用**绝对路径**传给
  `workflow_run.name`（免依赖发现链）——这是验收时最稳的写法。

- **用户 POV**：对话里让 agent 跑一个 workflow（如「跑 review-fix-loop」）→ assistant 回合出现
  `workflow-block`（`工作流` + 脚本名 · slug，下挂 `workflow-block-chips` 阶段 chips）→
  点击该块 → 全屏 overlay；托盘出现 `tray-workflow-row`（进度条 + N/M + 耗时 + abort）。
- **协议（agent → 工具）**：
  - `workflow_run { name, args, tokens?, time?, model?, thinkingLevel? }` —— 直接启动（无需用户确认）。
    `name` 必须来自 `<available_workflows>`；**args 是嵌套的**（`{name, args:{...}}`，禁止把
    args 子字段平铺到顶层——工具 promptGuidelines 明写这是反模式）。
  - `workflow_control { action: 'status' | 'abort' | 'resume', runId? }` —— run 级控制；
    `resume` 只对 `interrupted` 态有效（断点续跑，不是挂起恢复）。
  - 批量：`subagents { tasks: string[] }` → 内部固定 `fan-out` 模板（`FAN_OUT_SCRIPT_NAME`），
    等价于一个 workflow run（`tool-subagents.ts` 头注）。
  - 用户侧 slash：`/workflows [runId]`（TUI 面板开在当前终端）/ `/workflows abort <runId>` /
    `/workflows resume <runId> [model]`。**RPC 模式（taiji GUI）不开 TUI**：
    `parseWorkflowRpcCommand` 只识别 `abort` / `resume`（`command-actions.ts`），
    其余形态（含裸 runId）回落 `noop`。
- **副作用点**：`runWorkflow` → 建 run 记录（record 事件文件，写入方唯一入口 = core record 写侧）
  → 成员 agent() spawn 引擎子进程 → `publishRecordChanges` 发 `session.workflowUpdate`
  增量信号 → renderer `triggerWorkflowReload` 拉 `session.getWorkflows`。

### 驱动

```
# A 路径（让 agent 派发）
click  role=textbox ; type "用 workflow_run 跑 fan-out，args 里放两个任务" ; press Enter
expect testid=workflow-block visible
expect testid=workflow-block-chips count>0            # 阶段 chips（fold 快照）
expect testid=tray-builtin-button[data-kind=workflow] visible
click  testid=tray-builtin-button[data-kind=workflow]
expect testid=tray-panel[data-panel-key="native:workflow"] visible
expect testid=tray-workflow-row count>0
```

```js
// 结构层对账（run 是否登记）
const { workflows } = await p.call('session.getWorkflows', { sessionId: rootSid },
  { replyType: 'session.workflows' })
```

### 断言（期望终态 / 失败信号）

- 期望：`workflow-block` 出现且 header 含脚本名/slug；`session.workflows` 里出现该 run
  （`runId` / `scriptName` / `slug` / `status` / `startedAt` / `agentCalls`）；
  托盘行有 `tray-workflow-slug`，running 时有 `tray-workflow-spinner` 与进度；
  C：`workflow/runs/<runId>.record.jsonl` 出现且含 `run-created` 帧（词表同上）。
- **失败信号（具体形态）**：
  - 工具报 `workflowNotFoundMessage`（脚本名不在 registry）→ 用了 `<available_workflows>` 之外的
    名字/路径；
  - 工具报 reentry busy（`REENTRY_BUSY_MESSAGE`）→ 同一时刻已有 workflow/subagents run 在跑
    （共用 reentry guard）；
  - 工具报 args 校验失败（`findFlattenedArgKeys`）→ args 被平铺到顶层；
  - 派发后 `session.workflows` 空且随后出现 `running 信号后 workflow 列表为空` 的 warn →
    record 未落盘/读不到（`workflow-store` 的诊断日志），托盘永久无量；
  - `workflow-block` 出现但托盘无行 → 列表拉取链断（信号丢失 / RPC 失败）；
  - 行一直 running 无进度、成员无子进程 → 执行层未跑（真实引擎装配问题；faux 通道下预期如此，
    mock-http 通道下则应看到 members 逐步 settled——没 settled 先查成员剧本是否调了 structured-output）。

### 证据（A/B/C 各抓什么）

- A：对话流 workflow 块（含 chips）截图 + 托盘行截图。
- B：`session.getWorkflows` reply 中该 run 的字段；`session.workflowUpdate` 信号帧。
- C：`ls <dataDir>/ext-sessions/<rootSid>/workflow/runs/`；`jq -r .type <runId>.record.jsonl | head`；
  成员子进程（`ps`）。

### 证不了

- 孙进程 LLM 可达性：faux 通道不可达（见通用前置）；mock-http 通道可验（探针
  `scripts/probes/mock-llm-workflow.mjs`）。mock 回复无语义，所以「编排质量 / 真实耗时/成本」仍证不了。
- 「脚本语义正确性」（跑出来的业务结果对不对）：那是 workflow 脚本自身的验收，不是 harness 能力。

### Gotchas

1. **args 嵌套**：`{"name":"x","args":{"task":"..."}}`；平铺会被工具的 `findFlattenedArgKeys`
   拒单并给出可用参数清单。
2. **一次只允许一个 run/批**：`subagent_start`/`subagents`/`workflow_run`/`workflow_control`
   **共用** reentry guard（`registerSubagentTool` 注释）；并发第二次派发直接 busy。
3. **`resume` 只认 `interrupted`**：终态 run 不能 resume；要新结果就开新 run（一次性生命周期，
   pause 已废弃）。
4. **`subagents` 批量 = fan-out workflow**：它出现在 workflow 列表里（同一条 run 管道），
   断言「批量」时不要只看 subagent 记录。
5. **`session.workflowUpdate` 是 state topic（last-value）**：只有「最新一次」信号能被快照回放；
   中间信号丢失由「收到信号 → 拉全量列表」兜住（不是靠信号本身承载数据）。

---

## workflow.runs · run 列表与状态

- **通道**：B（`session.getWorkflows` 拉取 + `session.workflowUpdate` 信号；stateSnapshot 回放）
  + A（托盘行 / overlay 标题栏 pill）
- **前置**：`requires` = none（读结构）；依赖 `workflow.dispatch`
- **用于**：`p0-workflow-run`、`p0-workflow-abort`、`p0-workflow-overlay`、`p0-workflow-reconnect`

### 入口（用户 POV / 协议 / 副作用点）

- **用户 POV**：composer 托盘 workflow 面板：进行中 / 已结束两桶；行内：状态点或 spinner、
  脚本名、slug、进度条 + `done/total`、耗时；running 行（pinned）有 abort；`interrupted` 行有
  `tray-workflow-interrupted`（「已中断（可续跑）」）。
- **协议**：`session.getWorkflows { sessionId }` →
  `session.workflows { sessionId, workflows: WorkflowRunRecord[], oversize?, found? }`；
  增量信号 `session.workflowUpdate { sessionId, update: { runId, status, reason? } }`
  → renderer 立刻 `loadWorkflows`（并 force 重拉活跃 run 的事件流）。
  `status ∈ {running, interrupted, done}`（`WorkflowRunStatus`）。
- **副作用点**：无（读）；写侧是 dispatch/abort/resume 和成员执行。

### 驱动

```js
const { workflows } = await p.call('session.getWorkflows', { sessionId: rootSid },
  { replyType: 'session.workflows' })
```

```
click testid=tray-builtin-button[data-kind=workflow]
expect testid=tray-panel[data-panel-key="native:workflow"] visible
expect testid=tray-workflow-row visible
expect testid=tray-workflow-slug text=<slug>
```

### 断言（期望终态 / 失败信号）

- 期望：列表含 run 的 `runId/scriptName/slug/status/startedAt/completedAt?/agentCalls[]/
  totalCallCount?/usedTokens?/errorCode?/phases?`；`done` 时 `reason ∈ {completed, failed, aborted}`；
  托盘行状态点/进度与 `status` + `agentCalls` 一致；`done && errorCode` 时 overlay 标题栏出现
  `wfvz-overlay-error-code`。
- **失败信号**：
  - 托盘行与 `session.workflows` 不一致（行多/少）→ 列表帧与展示源分叉；
  - 终态 run 仍显示 spinner → 信号未触发重拉 / 行状态未收敛；
  - `interrupted` 显示成「运行中」→ 状态文案映射错（`tray-workflow-interrupted` 缺失）；
  - `found=false` 时把列表清空 → 消费方误处理（应保留旧分区）；
  - `oversize=true` 无降级提示 → 「不可用」被当成「无数据」。

### 证据（A/B/C 各抓什么）

- A：托盘面板截图（两桶 + 一个终态行 + 一个 interrupted 行）。
- B：`session.getWorkflows` reply（run 摘要字段）；`session.workflowUpdate` 帧序列。
- C：`workflow/runs/<runId>.record.jsonl` 的终态帧（`run-settled`，词表见
  `packages/subagent-core/src/orchestration/run-events.ts`）。

### 证不了

- run 的「真实耗时/成本」在真实模型下的量级（faux / mock-http 恒零 token，无真实消耗）。

### Gotchas

1. **列表不是广播推全量**：信号只带 `runId/status/reason`，列表必须自己拉。断言「列表更新」
   要等 `getWorkflows` 的新回执（或 UI 行变化），不能等信号本身。
2. **同一 run 可能被重拉多次**：`workflowUpdate` 每变更一次就 force 重拉事件流（overlay 活跃时），
   这是设计行为，不是重复 bug。
3. **`oversize` 与 `found` 缺省**：旧 runtime/广播帧可能不带；消费方按 `false`/`true` 处理。
4. **行无 `data-run-id`**：`tray-workflow-row` 每行同 testid，只能按 `tray-workflow-slug`（可缺省！）
   或脚本名文本过滤；并发同名 run 时会双命中 → 建议补 `data-run-id`（当前锚点缺口）。

---

## workflow.overlay · 可视化浮层（双入口 + DAG + 多级 tab）

- **通道**：A（全屏 overlay 的 DAG/实况面板/标题栏）+ B（`session.getWorkflowDag` +
  `session.getWorkflowRunEvents`）+ C（可选：脚本文件 / record 文件）
- **前置**：`requires` = none（有 run 记录即可；DAG 需要 record 里带 scriptSource）；
  依赖 `workflow.runs` `workflow.dispatch`
- **用于**：`p0-workflow-overlay`（主）、`p0-workflow-abort`（overlay 内模型全切入口）、
  `p0-workflow-reconnect`

### 入口（用户 POV / 协议 / 副作用点）

- **用户 POV（双入口 + 两个同壳 tab 直达）**：
  1. 托盘 workflow 行点击（`tray-workflow-row`）→ `openWorkflow(runId)`；
  2. 对话流 `workflow-block` 点击（header 行）→ `openWorkflow(name, {slug, sessionId})`
     → renderer 内 `findRun` 反查（先 runId 精确、再 `(scriptName, slug)` 取最新；
     脚本名做了 basename 归一，主 agent 传绝对路径也能命中）。
  3. 定时任务直达：`openSchedulerTab(sessionId)` → 同壳 `scheduler` tab；
  4. 画布直达：`openCanvasTab(canvasId, sessionId)` → 同壳 `canvas` tab。
- **协议**：
  - `session.getWorkflowDag { sessionId, runId }` → `{ dag }` **或** 领域回执
    `{ code ∈ parse_failed | no_script_source | record_not_found | path_rejected, message }`
    （错误臂**不走** error envelope；`parse_failed` 可重试——runtime 只缓存成功结果）。
  - `session.getWorkflowRunEvents { sessionId, runId }` → `{ events, oversize? }` **或**
    `{ code: 'record_not_found', message }`。
  - `session.getWorkflows`（列表，供 `findRun` 反查与 live 面板）。
- **副作用点**：overlay 开合态 SSOT 在 `packages/core/src/domain/overlay`（`openOverlay/closeOverlay`）；
  DAG 缓存留 renderer（`overlayDag/overlayDagError`）；事件流缓存归 `workflowStore`（LRU5，
  overlay 关闭不清）。
- **壳**：`OverlayShell`（`wfvz-overlay` / `wfvz-overlay-panel` / `wfvz-overlay-header` /
  `wfvz-overlay-close`；点遮罩与右上 X 两通道关闭；**Esc 归键盘栈序编排器**，壳不监听）。

### 驱动

```
# 入口 1：托盘
click  testid=tray-builtin-button[data-kind=workflow]
click  testid=tray-workflow-row（按 slug 过滤）
expect testid=wfvz-overlay visible
expect testid=wfvz-overlay-dag-pane visible
expect testid=wfvz-dag-node-<nodeId> visible
expect testid=wfvz-overlay-run-pill  attr data-status=running|done|interrupted

# 入口 2：对话流块
click  testid=workflow-block   locator('[data-testid="tool-block-header"]')
expect testid=wfvz-overlay visible

# 三子页
click  testid=wf-viz-subpage-trace      # 默认
expect testid=wf-viz-trace-table visible
click  testid=wf-viz-subpage-events
expect testid=wf-viz-event-stream visible
click  testid=wf-viz-subpage-gantt
expect testid=wf-viz-subpage-gantt-panel visible
```

```
# 三通道关闭
press  Escape                            # 编排器
# 或 click testid=wfvz-overlay（遮罩，click.self）
# 或 click testid=wfvz-overlay-close
expect testid=wfvz-overlay count=0
expect testid=composer-box visible         # 焦点回 composer
```

### 断言（期望终态 / 失败信号）

- 期望：
  - 标题栏：脚本名 + `wfvz-overlay-slug` + `wfvz-overlay-run-pill`（`data-status`）+ 可选
    `wfvz-overlay-error-code` / `wfvz-overlay-elapsed`；run 级模型触发器 `wfvz-overlay-model-trigger`；
  - DAG：`wfvz-dag-node-<nodeId>` 带 `data-state ∈ {running, done, failed, retrying, pending, skipped}`
    + `wfvz-dag-edge-<edgeId>` + `wfvz-dag-legend`（图例六态）；
  - 实况面板：`wf-viz-live-panel` + L2 tab 条 `wf-viz-tabbar`（workflow 固定 tab + phase 动态 tab）
    + 三子页（trace 表 / 事件流 / Gantt）；
  - 三类内容同壳切换：`wfvz-overlay-tab-runs|scheduler|canvas`（`wfvz-overlay-scheduler-title` /
    `wfvz-overlay-canvas-title` 对应在场）。
- **失败信号（具体形态）**：
  - DAG 降级：`wfvz-overlay-dag-fallback` + `wfvz-overlay-dag-error-code`
    （`parse_failed` 才有 `wfvz-overlay-dag-retry`；`no_script_source` / `record_not_found` 无重试钮）；
  - 解析中：`wfvz-overlay-dag-loading`（三态互斥：loading / 就绪 / 降级）；
  - 事件流错误：`wf-viz-events-error` + `wf-viz-events-retry`；`record_not_found` 是静态指引
    （无重试）；`oversize` 走 `wf-viz-events-oversize`；
  - **点击入口无反应**：`findRun` 反查未命中 → 只弹 toast（`panel.workflowViz.workflowNotFound`），
    overlay 不开（**没有 drawer 回落**了，见 Gotchas 1）；
  - overlay 打开但空画布：`wfvz-dag-empty`（零节点 run，纯门禁脚本）——合法态；
  - 实例未匹配：`wfvz-overlay-unmatched` + `wfvz-overlay-unmatched-group-<phase>`（不静默丢弃）。

### 证据（A/B/C 各抓什么）

- A：overlay 全屏截图（DAG + 右面板）、三子页各一张、降级态一张。
- B：`session.getWorkflowDag` reply（成功 `dag` 或 `code`）；`session.getWorkflowRunEvents` reply
  （`events` 条数 / `oversize` / `code`）；打开前后的 `session.getWorkflows` 对照。
- C：`workflow/runs/<runId>.record.jsonl`（DAG 的 scriptSource 来源）；脚本文件本体（可选，
  用于核对 `@pi-meta` phases）。

### 证不了

- 像素级视觉回归（overlay 不进 shell/composer 基线视口；e2e 像素轨不覆盖，见
  docs/testing/02 §W 坑位③）。
- 多显示器/超长 DAG 的布局体验。

### Gotchas

1. **[口径冲突，重要] 回落载体已不存在**：`docs/FEATURE-PRIORITIES.md`（§2）与
   `docs/testing/02 §W` 仍写「drawer WorkflowTab 保留作回落载体」，但源码注释明确
   `openWorkflowInDrawer` 与 drawer `workflow` tab 已于 2026-10-19 删除
   （`packages/core/src/domain/drawer/coordination.ts` 头注、`RightDrawerTab` 联合里没有
   `workflow`、`WorkflowVizOverlayHost.vue` 头注）。现役回落 = **toast 提示 + 重开重试**
   （Guard `:key="guardEpoch"` 每次点击重挂）。写 scenario 时不要指望去 drawer 找 workflow tab。
2. **overlay 是单例换内容**：已开态再点另一个 run/入口 = 换载荷（`isOpen` 保持），不会叠两层。
3. **`wfvz-overlay` 与浏览器浮层共用壳**：`BrowserOverlay` 也渲染这个 testid；断言 workflow
   浮层要叠加 `wfvz-overlay-dag-pane` 或 `wfvz-overlay-tabs`。
4. **DAG 错误臂不走 error envelope**：拿 `error` 帧等 DAG 失败会等不到；判别字段是 `code`
   （renderer 侧再把通道错误归一成 `'channel'`）。
5. **block 入口的名字归一**：主 agent 传脚本绝对路径是常态，`findRun` 用 `normalizeWorkflowScriptName`
   取 basename；直接比较 `scriptName` 全等会 miss。
6. **Esc 关闭不归壳**：壳只监听遮罩与 X；Esc 由 `key-orchestrator` 按栈序路由（浮层打开时
   还可能先关 FindBar/抽屉）。测 Esc 关闭要确认当前栈顶是 overlay。

---

## workflow.abort · 中止 run

- **通道**：A（托盘行两段式 abort / overlay 标题栏 pill 转中断态）+ B（`session.workflowAction`
  回执 + `session.workflowUpdate` 信号）+ C（record 终态帧 / 成员进程消失）
- **前置**：`requires` = faux | mock-http（要有 running run）；依赖 `workflow.dispatch` `workflow.runs`
  `workflow.overlay`
- **用于**：`p0-workflow-abort`（主）、`p0-interrupt-cancel`（执行域子项）

### 入口（用户 POV / 协议 / 副作用点）

- **用户 POV**：
  1. 托盘 workflow 面板（pinned）running 行右侧 abort 钮 `tray-workflow-abort`（两段式：
     `tray-workflow-abort-confirm` 二次确认）；
  2. 对话流 `/workflows abort <runId>`（RPC 模式下执行 lifecycle 动作）；
  3. agent 侧 `workflow_control { action:'abort', runId }`。
- **协议**：`session.workflowAction { sessionId, action: 'abort', runId }` →
  `session.workflowActionDone { sessionId, action:'abort', runId }`（ack）；
  实况变化经 `session.workflowUpdate` 信号推回（`status` 变化）。
- **副作用点**：`abortRun`（core）→ 成员 agent 调用被取消 / 子进程终止 → run 终态
  （`done` + `reason='aborted'`，或 `interrupted` 视在途形态）→ record 追加终态帧 →
  `session.workflowUpdate`。

### 驱动

```
click  testid=tray-builtin-button[data-kind=workflow]
hover  testid=tray-workflow-row（running 行）
click  testid=tray-workflow-abort
click  testid=tray-workflow-abort-confirm
expect 该行 spinner 消失 / 状态点变终态
```

```js
await p.call('session.workflowAction',
  { sessionId: rootSid, action: 'abort', runId }, { replyType: 'session.workflowActionDone' })
// 随后等 session.workflowUpdate status 变化 + session.getWorkflows 收敛
```

### 断言（期望终态 / 失败信号）

- 期望：reply `{action:'abort', runId}`；`session.workflowUpdate` 带该 runId 的 status 变化；
  `session.getWorkflows` 里 run 收敛为 `done`（`reason='aborted'`）或 `interrupted`；
  A：行 spinner 停、abort 钮消失；overlay `wfvz-overlay-run-pill` 的 `data-status` 更新；
  C：record 终态帧；成员子进程消失。
- **失败信号（具体形态）**：
  - reply 成功但 run 仍 running（无后续信号）→ abort 命令没到执行域（只写了意图）；
  - run 变 `interrupted` 但 UI 提示「运行中」→ 文案映射错；
  - 成员子进程残留（`ps` 命中）→ 只终止了 run 状态没杀进程（孤儿）；
  - 行内 abort 钮点一次就断言停止 → 两段确认没走完；
  - abort 后 `session.workflows` 不刷新 → 信号/拉取链断。

### 证据（A/B/C 各抓什么）

- A：abort 前后托盘行 / overlay 标题栏截图（含确认态）。
- B：`session.workflowActionDone` reply；`session.workflowUpdate` 帧；`session.getWorkflows` 前后。
- C：`workflow/runs/<runId>.record.jsonl` 的终态帧；成员进程 `ps` 前后。

### 证不了

- 「中止是否立刻停止 token 消耗」（真实 provider 行为；faux / mock-http 均无成本）。

### Gotchas

1. **两段确认**：首击变 `tray-workflow-abort-confirm`，二击才执行（`TrayConfirmButton`）。
2. **只有 running 行有 abort 钮**（`v-if="pinned && record.status === 'running'"`）；终态行没有。
3. **workflow 是一次性生命周期**：没有 pause/resume 按钮；`interrupted` 只能 `resume`（agent 工具
   或 `/workflows resume <runId> [model]`），UI 无 resume 入口。
4. **abort ≠ 删除**：run 记录保留（可看事件流/trace）；要新结果开新 run。
5. **`session.workflowAction` 只认 `abort`**：payload 的 `action` 是字面量联合 `'abort'`；
   resume 走 agent 工具 `/workflows resume`，不是这个 RPC。

---

## workflow.reconnect · 断连 / 重开后的收敛

- **通道**：B（`session.subscribe` 的 `stateSnapshot` 回放 + `session.workflowUpdate` 触发重拉
  + `session.getWorkflows` / `getWorkflowRunEvents` 拉取）+ A（overlay 行/面板内容收敛）
  + C（record 文件是最终事实）
- **前置**：`requires` = faux | mock-http（要有 run）；依赖 `workflow.runs` `workflow.overlay`
  `protocol.subscribe` `session.subscription`
- **用于**：`p0-workflow-reconnect`（主）、`p0-session-persistence`（恢复面）

### 入口（用户 POV / 协议 / 副作用点）

- **用户 POV**：overlay 开着时网络闪断/应用重开 → 面板内容自己回到最新（不用手动刷新）；
  run 在断连期间完成，重连后能看到终态。
- **协议（三条收敛路径，别混）**：
  1. **重订阅回放**：WS 重连 → `resubscribeAll()`（`packages/core/src/coordination/
     subscription-state.ts`）→ `session.subscribe { fromSeq }` → reply
     `{ snapshot, stateSnapshot, lastSeq, gap? }`。`session.workflowUpdate` 是 **state topic**
     （`TOPIC_TABLE`），其 last-value 帧从 `stateSnapshot` 回放 → 触发 `triggerWorkflowReload`
     → 拉 `session.getWorkflows`；若 overlay 有活跃 run，还会 `force` 重拉事件流并自增
     `activeRunSignalEpoch`（agent tab 快照重拉）。
  2. **signal → refetch**：任何 `session.workflowUpdate` 都走上面的拉取（列表 + 活跃 run 事件）。
  3. **重开 overlay**：`openWorkflowVizOverlay` 每次打开都无条件重拉 DAG（`loadDag`），
     与断连无关但同样收敛。
- **副作用点**：`workflowStore` 分区写（`loadWorkflows`）；事件流缓存 `force` 覆盖 ready 缓存；
  DAG 缓存**不**随断连失效（静态蓝图，runtime 按 runId 缓存成功结果）。

### 驱动

**① 可确定性复现的「重开收敛」（不依赖网络故障）**

```
expect testid=wfvz-overlay visible
click  testid=wfvz-overlay-close
click  testid=tray-workflow-row            # 重开
expect testid=wfvz-overlay-dag-pane visible
# 断言 DAG 重新拉取成功（无 dag-error）且 live 面板内容为最新 list 快照
```

**② WS 断连（真实重连路径）——待实测**

```js
// Playwright/CDP 侧断网再恢复（chromium context.setOffline）会关闭 WS；
// 恢复后 core 的 connected false→true 触发 resubscribeAll（use-connection 的 watch）。
// 该手法尚未在本技能内实测，标记为待实测；对应的机器资产见 ③。
```

**③ 已有 e2e 资产（推荐直接复用，不重写）**

- `e2e/workflow-disconnect-recovery.spec.ts`（e2e-map `E2E-SKILLRELOAD-04`，L2.5）：
  「WS 断开期间 run 完成 → 重连后 stateSnapshot 回放/主动拉取恢复 + GUI 收敛」。
- `e2e/workflow-viz-overlay.spec.ts`（`E2E-MOCK-01`）：overlay 打开形态 / 三子页 / 降级 / 关闭通道。

### 断言（期望终态 / 失败信号）

- 期望：
  - 重连后（或重开后）`session.getWorkflows` 的 run 状态 = record 文件终态；
  - overlay 行/面板无「幽灵 running」；活跃 run 的事件流重新拉到最新（`wf-viz-event-stream`
    行数增加或 `wf-viz-events-*` 不再是 loading）；
  - 断连期间完成的 run 在重连后可见（状态不再 running）。
- **失败信号（具体形态）**：
  - 重连后托盘仍有「运行中」但 record 已终态 → 信号未回放/列表未拉；
  - overlay 事件流停在断连前（`wf-viz-events-loading` 常驻 / 旧行集）→ 活跃 run 的 force 重拉没发生；
  - `session.subscribe` reply `gap=true` 时仍按增量处理 → 必丢帧（应全量重拉）；
  - 重开后 DAG 报 `record_not_found` 但 record 文件在盘 → `findRun`/sessionId 归属错
    （overlay 载荷的 sessionId 不是 run 所属会话）；
  - 重连后重复条目（同 run 两行）→ 分区写未去重。

### 证据（A/B/C 各抓什么）

- A：断连前 / 重连后 overlay 截图（run pill 状态、事件流行数）。
- B：`session.subscribe` reply（`gap` / `stateSnapshot` 里是否含 `session.workflowUpdate`）；
  重连后的 `session.getWorkflows` reply；`getWorkflowRunEvents` 的 `events` 条数。
- C：`workflow/runs/<runId>.record.jsonl` 的终态帧（最终事实，用于判定 UI 是否滞后）。

### 证不了

- **CDP 断网手法本身**在本技能内尚未实测（②）：标记 `待实测`，优先复用 ③ 的 e2e 资产。
- runtime 整体重启后的 workflow 收敛：runtime 重启会杀掉全部 pi 子进程，run 变
  `interrupted`（不是「断连」语义），且 bus 内存态清空——期望不同，不要混为一谈。

### Gotchas

1. **`stateSnapshot` 只回放 state 类**：`session.workflowUpdate` 是 state；`session.workflows`
   （列表）不是——列表永远靠 RPC 拉。所以「重连后列表自己变了」实际上是因为信号触发了拉取。
2. **`gap=true` 必须全量**：`session.subscribe` 的 `fromSeq` 早于 ring 最旧 seq 时，增量为空，
   必须全量重拉（`subscription-state.ts` 注释）。
3. **runtime 重启 ≠ 网络闪断**：前者清 bus 内存态 + 杀 pi（run → interrupted），后者保留 runtime
   与 run。断言期望要分开写。
4. **DAG 不会因为断连变化**（静态蓝图）；重开才重拉。事件流/trace 才是随 run 变化的部分。
