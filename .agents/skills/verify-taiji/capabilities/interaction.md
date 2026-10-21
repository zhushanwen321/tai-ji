# interaction · agent↔用户闭环（提问 / 权限 / 计划审阅 / 画布）

本文件覆盖四个 capability id：

- `interaction.askuser`（P0）
- `interaction.permission`（P1）
- `interaction.plan-review`（P2）
- `interaction.canvas`（P2）

四者的共同形态：**agent 侧发起一次阻塞式请求，pi 进程挂起等用户裁决，裁决经
`extension.ui_response` 回 pi 的 Promise**。差异只在「请求走哪条渲染通道」：
统一表单（FormOverlay）/ 简单对话框（CompanionBand）/ 画布 overlay。三者是**三个不同
的渲染面**，不要互相套用锚点。

---

## interaction.askuser · agent 提问表单（FormOverlay）

- **通道**：A（表单浮层 + 提交后对话流）/ B（`session.history` 末态、工具调用帧）/ C（pi jsonl 工具记录、会话树 logs）
- **前置**：`requires: faux`（唯一触发入口是 agent 调工具）+ 依赖 `session.create` / `chat.send` / `chat.wait` / `extension.load`
  （`@zhushanwen/pi-ask-user` 属 `feature` tier，随 builtin 恒装载）
- **用于**：`p0-form-overlay`（矩阵口径；covers: `interaction.askuser`, `chat.send`, `chat.wait`）

### 入口（用户 POV / 协议 / 副作用点）

- 用户 POV：无手动入口。发一条消息 → agent 决定提问 → 表单浮层出现 → 用户点选项 / 填 Other → 提交或取消。
- 协议入口：pi 扩展 `@zhushanwen/pi-ask-user` 的 `ask_user` 工具 execute 内调
  `ctx.ui.select(ASK_USER_MARKER, [{action,params}])`；runtime `event-adapter` 的 marker 分支
  `tryTranslateAskUserSelect` 把它翻成 `form: true` 的统一表单帧
  （出处：`packages/runtime/src/infra/pi/event-adapter.ts`，grep `ASK_USER_MARKER` /
  `MARKER_DIALOG_FALLBACKS`；契约标记在 `packages/shared` 的 ui-presentation 段）。
- 副作用点：**回合不结束**。工具处于「执行中」，直到用户应答；应答经
  `extension.ui_response`（renderer → runtime → pi）解挂，pi 继续下一轮。
- 现有剧本：`features/ask-user-form.md`（本 capability 与它同源；该文件是用户视角剧本，
  本文件是机器可断言的契约面）。

### 驱动

1. faux 响应脚本第一 step 即 `ask_user` 工具调用（`fixtures/faux-responses/ask-user-two-questions.json`）：

   ```json
   [{ "toolCalls": [{ "name": "ask_user", "args": { "questions": [
       { "header": "DB", "question": "选哪个数据库？",
         "options": [{ "label": "SQLite", "description": "零运维" },
                     { "label": "Postgres", "description": "强一致" }] },
       { "header": "Region", "question": "部署区域？",
         "options": [{ "label": "us-east-1", "description": "美东" }] } ] } }],
     "stopReason": "toolUse" },
    { "text": "已按你的选择继续。", "stopReason": "stop" }]
   ```

2. 建 session 并首发提交（见 `features/new-task.md`）；脚本第一 step 立即触发。
3. `expectVisible(testid=form-overlay)`；`expectText(testid=form-question-text, /选哪个数据库/)`。
4. 点选项：`click(testid=form-option-Postgres)`（testid 值 = option.label 原文）或按标签文本
   `click(text=Postgres)`；单选选中普通项会**自动前进**到下一题
   （出处：`packages/renderer/src/components/extension/form/ChoiceQuestion.vue`，
   grep `emit('advance'` / `optValue`）。
5. 多题时 `form-tab-<i>` 出现已答标记 `form-tab-answered`；可点 `form-next` 手动翻题。
6. 末题后 `form-submit` 可点 → 点击 → 浮层消失，第二 step 文本进入对话流。
7. 取消路径：另起一轮提问后点 `form-cancel`（回传取消，pi 侧工具结果标记为取消）。

### 断言（期望终态 / 失败信号）

| # | 通道 | 断言 | 失败信号 |
|---|------|------|----------|
| 1 | A | `form-overlay` 可见且 `form-question-text` 含问题原文 | 只有 turn 工作态、无浮层 = marker 翻译断或扩展未装载 |
| 2 | A | 选项条数 = 脚本 options 数 + 1（Other 由 UI 自动附加，`form-option-__other__`） | 出现「Other」却来自脚本 = schema 违规（agent 自带 Other 会被拦截） |
| 3 | A | 提交后 `form-overlay` 消失 + 对话流出现第二 step 文本 | 浮层消失但无后续文本 = 应答未送达 pi（工具结果未回灌） |
| 4 | B | `session.history` 末轮含 `ask_user` 工具块与 assistant 收尾文本 | 历史无工具块 = 事件链断了（不应发生） |
| 5 | C | `<dataDir>/ext-sessions/<sid>/logs/pi-<date>.jsonl` 有 `ask_user` 的 toolCall 与 toolResult（toolResult 内含所选 label） | 文件不存在 = pi 尚未 flush（pi 首次落盘条件，见 AGENTS.md 规则 6） |

> 断言跨 A+B+C 三通道：A 是用户可见终态，B 是协议真相，C 是落盘证据。只有 A 视为
> `weak-anchor`（浮层可能是 mock 残留）。

### 证据（A/B/C 各抓什么）

- **A**：截图 `askuser-form-multi.png`（多题 tab 态）、`askuser-form-submitted.png`（提交后对话流）；
  DOM 抓 `form-overlay` 的 `outerHTML` 摘要 + 选项 testid 列表 + 提交后浮层节点数（0）。
- **B**：`session.history` 末轮 JSON（截断到 8KB）——工具块 + 收尾文本。
- **C**：pi jsonl grep 行 `grep -n '"name":"ask_user"' ext-sessions/<sid>/logs/pi-*.jsonl`；
  会话树 `ls ext-sessions/<sid>/`（确认树内域在场，布局 SSOT = ADR-0151）。

### 证不了

- **阻塞期间的「无文本流」不等于挂死**：A 通道无法单独证明 pi 在等；必须用 C 的
  toolCall 无 toolResult 组合证明「工具已发起、结果未回」。
- **pi 侧取消语义的精确 tag**：取消后工具结果的文本形态由扩展决定，未做契约断言
  （只断言浮层消失 + 回合继续/结束）。→ 需补：`pi-ask-user` 取消结果文案的稳定锚点。
- **多选（`multi:true`）的自动前进语义**：与单选不同，当前只断言可勾选多项，不断言前进时序。

### Gotchas

- `options` 每项必须是 `{label, description}` 对象；`questions.length > 1` 时每题必须带
  `header`；**不要自带 Other**（UI 自动追加，agent 自带会被扩展层友好拦截）。
- `form-option-<label>` 的 testid 值就是 label 原文（含空格 / 中文也照原样），
  `getByTestId` 需精确匹配；不确定时用 `form-option-label` 文本锚点。
- 浮层经 reka portal 挂到 `<body>`：查询不要限定在 panel 容器内（`docs/testing/00-overview.md`
  的 Portal 注意）。
- scheduler / plan 复用同一 FormOverlay 壳（同 testid 家族）；要验它们的特有字段
  （日期时间选择 `schedule-create-*`）再读对应组件，不要在本 capability 里硬塞。

---

## interaction.permission · 工具审批（pi-permission）与插件权限审批（两个子系统！）

- **通道**：A（审批浮层）/ B（`session.history` 工具结果、`plugin:permissionRequest` 广播）/ C（权限配置写回、pi jsonl、扩展日志）
- **前置**：`requires: faux`（触发工具调用）+ 依赖 `chat.send` / `chat.wait` / `extension.load`；
  **权限模式必须不是 `yolo`**（默认就是 `yolo`，见下）
- **用于**：`p1-permission-approval`（矩阵口径；covers: `interaction.permission`, `chat.send`, `chat.wait`）

### 入口（用户 POV / 协议 / 副作用点）

本 capability 覆盖**两套互不相干的权限体系**，验收时先确认要验哪一套：

| 体系 | 谁触发 | 渲染面 | 锚点来源 | 默认可达性 |
|------|--------|--------|----------|------------|
| **A. 工具审批**（`@zhushanwen/pi-permission`） | pi `tool_call` hook → `ctx.ui.select(title, ["Approve (once)","Deny"])`（rpc 模式） | **CompanionBand**（底部简单对话框） | `packages/ui/src/extension-host/CompanionBand.vue` | 可达（需切非 yolo 模式） |
| **B. 插件权限审批**（taiji PluginService） | runtime `PluginActivator` 权限门 → 广播 `plugin:permissionRequest` | **PermissionRequestDialog**（reka Dialog） | `packages/ui/src/extension-host/PermissionRequestDialog.vue`（由 `packages/renderer/src/App.vue` 挂载） | **默认不可达**（见「证不了」） |

> 任务清单里提到的 `permission-dialog` 家族属 **B 体系**；不要拿它断言 A 体系。
> `grep` 路径提示：它不在 `packages/renderer/src/components/**/permission*`，而在
> `packages/ui/src/extension-host/PermissionRequestDialog.vue`（renderer 只是宿主）。

**A 体系（工具审批）用户路径**：

1. 四档模式（出处：`extensions/universal/permission/src/types.ts`，
   `PERMISSION_MODES` / `MODE_DESCRIPTIONS`）：
   - `yolo`（默认）：完全放行，不跑管道；
   - `auto`：安全规则放行 → 非安全过 AI classifier → AI 认为安全放行 / 非安全人工审批；
   - `approve`：无 AI，规则匹配后安全放行、非安全人工审批；
   - `strict`：**全部工具人工审批**（出处：`extensions/universal/permission/src/pipeline.ts`
     的 `if (mode === "strict")` 分支）。
2. 切模式两条路：
   - 用户路径：composer 里发 slash 命令 `/permission strict`
     （出处：`extensions/universal/permission/src/commands.ts`，`registerCommand("permission")`
     在 `index.ts`）；
   - 预置路径：启动前写 `<dataDir>/agent/config/permission-ext-config.json`
     （路径出处：`extensions/universal/permission/src/types.ts` 注释 +
     `config.ts` 的 `getConfigPath()`；`<agentDir>` = `<dataDir>/agent`，
     见 `packages/shared/src/paths.ts` 的 `getPiAgentDir`）：
     ```json
     { "mode": "strict", "enabled": true, "classifier": { "enabled": true, "model": "auto" }, "userRules": [] }
     ```
3. agent 发起任意工具调用 → hook 挂起 → `ctx.ui.select` → runtime `translatePlainDialogRequest`
   → `extension.dialog` → renderer bridge → **`companion-band`**（`method=select`）。

**B 体系（插件权限）用户路径**：安装/启用一个 `sandbox` 且声明了 `permissions` 的插件 →
`PluginActivator.gateOnPermissionApproval` 广播 `plugin:permissionRequest`
→ `permission-dialog` 弹出（权限列表 + 全选 + 批准/拒绝）。

### 驱动

A 体系（推荐，唯一可自动化的真机路径）：

1. 先用 `seed-faux.mjs` 预置数据目录，启动前**追加写入**权限配置：
   `<dataDir>/agent/config/permission-ext-config.json`（父目录不存在则建）。
2. faux 脚本用 `fixtures/faux-responses/permission-tool.json`（bash 工具调用）。
3. 首发提交 → 等 `expectVisible(testid=companion-band)`
   （testid 出处：`CompanionBand.vue`，grep `data-testid`）。
4. 读 `companion-band-title`：应含 `Tool: bash` 与 `Reason: strict mode: all tools require approval`
   （文案出处：`extensions/universal/permission/src/approval.ts` 的 `formatTitle` +
   `pipeline.ts` 的 strict 文案）。
5. 批准：点 `role=radio` 的 `companion-select-option-Approve (once)`（值 = 选项字符串原文，
   见 `normalizeOptions`：string → `{label:item,value:item}`，出处
   `packages/ui/src/extension-host/shell-adapters.ts`），再点 `companion-select-ok`。
6. 撤回/拒绝：点 `companion-select-cancel`（回传 null → 扩展记 `user dismissed the prompt`，
   fail-closed deny）。

B 体系：无默认夹具，见「证不了」。

### 断言（期望终态 / 失败信号）

| # | 通道 | 断言 | 失败信号 |
|---|------|------|----------|
| 1 | A | `companion-band` 可见 + `companion-band-title` 含 `Tool: bash` | 什么都没弹 = 模式仍是 yolo / 扩展未装载 / `enabled=false` |
| 2 | A | 批准后 band 消失，对话流出现 bash 工具块（含命令与输出） | band 消失但工具块报错 = 应答未到达 pi（`extension.ui_response` 失败） |
| 3 | B | `session.history` 该轮 toolResult 非 error | toolResult 为 error 且 reason 含 `denied via rpc` = 被拒 |
| 4 | C | pi jsonl 有 bash toolCall + toolResult | 无 toolCall = 工具未真正执行 |
| 5 | C | 页面刷新/重开 session 后权限配置仍在（文件对照） | 配置被覆盖回 yolo = 写侧被别处整表替换 |

> 1+2 是 A 通道，3/4 是 B/C。A 单独不足以证明「审批真的拦住了工具」——必须看 4 的时序
> （批准前无 toolResult，批准后才出现），或看拒绝分支的 3。

### 证据（A/B/C 各抓什么）

- **A**：`permission-band-pending.png`（band + 选项）、`permission-band-approved.png`（工具块）；
  DOM 抓 `companion-band-title` 文本 + `companion-select-option-*` 的 testid 列表。
- **B**：`session.history` 该轮原文；若是 B 体系则抓 `plugin:permissionRequest` 广播帧
  （`payload { pluginId, permissions, requestId }`）。
- **C**：`<dataDir>/agent/config/permission-ext-config.json` 原文；pi jsonl grep
  `'"name":"bash"'`；`TAIJI_AGENT_DEBUG=1` 时抓 `<dataDir>/agent/logs/pi-permission-<date>.log`
  （路径公式：`extensions/shared/extension-logger/src/index.ts` 的 `fileLog` → `<agentDir>/logs/<extName>-YYYY-MM-DD.log`；
  注意 taiji 恒注入 `TAIJI_AGENT_EXT_LOG=1`，INFO 级本来就会落盘）。

### 证不了

- **B 体系（`permission-dialog`）真机不可达**：唯一 builtin 插件 `scheduler-manager` 的
  `trustLevel = trusted` 且 `source = built-in`，`PluginPermissionChecker` 对
  trusted/built-in 直接放行（出处：`packages/runtime/src/services/plugin-service/plugin-permission.ts`，
  `descriptor.trustLevel === 'trusted' || descriptor.source === 'built-in'`）；仓内无
  sandbox 插件夹具（`grep -rln permission-dialog e2e` 零命中，只有
  `packages/ui/src/extension-host/__tests__/PermissionRequestDialog.test.ts` 单测）。
  → 记为 `verified-unreachable`，前置缺失 = 「需一个 sandbox 且声明 permissions 的插件 + 安装通道」。
- **`auto` 模式的 AI classifier 分支**：classifier 走真实 LLM（`classifier.model='auto'` 取首个
  可用模型）。理论上 faux 演员可以充当 classifier 返回风险 JSON，但 prompt→JSON 契约未在
  taiji 侧固定，**本轮不验**；只用 `strict`（确定性分支）。
- **TUI 分支**：`ctx.mode === 'tui'` 的审批组件（`ApprovalComponent`）在 taiji（rpc 模式）不可达。
- **`Approve (session)` / `Approve (always)` 作用域**：源码明确 TODO 未实现（`approval.ts` 注释）。

### Gotchas

- **默认 yolo 什么都不弹**：`DEFAULT_CONFIG.mode = 'yolo'`（`types.ts`）。忘了切模式会误判成
  「审批功能坏了」。
- pi 主进程的 `--approve` 与 pi-permission 无关（前者是 pi 原生工具确认，后者是扩展
  hook）；带 `--approve` 不会绕过扩展审批。
- 审批期间 turn 停在「工具运行中」，无文本流是正常态；禁止用固定 sleep 判超时。
- `companion-select-option-<value>` 的 value 是**选项字符串原文**（含空格与括号），
  Playwright 的 `getByTestId` 精确匹配可用，但 shell 里拼选择器要加引号；
  更稳的写法是 `role=radio` + `name` 文本。
- band 有 minimize/restore（`companion-minimize` / `companion-restore`）；收起后 body 不渲染，
  断言选项前先确认 `companion-restore` 不存在（即处于展开态）。
- `permission` 扩展的 `tool_call` hook 对**所有**工具生效（含 read/write/ask_user），
  strict 模式下连提问工具也要先批准——编排脚本时不要只给 bash。

---

## interaction.plan-review · 计划审阅三键裁决

- **通道**：A（PlanReviewBar / PlanDocsPanel）/ B（`session.planState`、`extension.ui_response` 的决策 payload）/ C（`.tmp/plans/<slug>/` 文档、pi jsonl 的 plan entry）
- **前置**：`requires: faux`；依赖 `chat.send` / `chat.wait` / `interaction.askuser`（同壳家族）/ `session.switch`
- **用于**：`p1-plan-review`（covers: `interaction.plan-review`, `chat.send`, `session.history`）

### 入口（用户 POV / 协议 / 副作用点）

- 用户 POV：
  1. composer 输入 `/plan <需求描述>`（或 agent 自行 `plan(action='enter')`）→ 计划模式激活，
     composer 下方常驻 `plan-mode-bar`；
  2. agent 写文档 → `plan(action='register-doc')` → 右侧抽屉「计划产物」tab（`plan-docs-panel`）；
  3. agent `plan(action='submit-review', selfReview=...)` → 行内审批条 `plan-review-bar` 出现；
  4. 用户三键裁决：**提交评论并要求修订**（`plan-review-revise`，0 草稿时禁用）/
     **确认并执行**（`plan-review-approve`）/ **搁置**（`plan-review-dismiss`）。
- 协议入口：plan 扩展在 `submit-review` 时发 `ctx.ui.select(PLAN_REVIEW_MARKER, ...)`；
  runtime 的 `tryTranslatePlanReviewSelect` 翻成 `planReview: true` 的表单帧；renderer 的
  `useExtensionUI` 把请求镜像进 plan-store 分区，`PlanReviewBar` 从分区读取。
  决策回传 = `extension.ui_response`，payload 是 **JSON 字符串**
  `{"decision":"approve"}` / `{"decision":"revise","comments":[{"quote","comment"}]}` /
  `{"decision":"dismiss"}`（出处：`packages/renderer/src/components/panel/plan/PlanReviewBar.vue`，
  `submit()` + `PlanReviewResponse`）。
- 副作用点：`approve` 清空评论草稿并让 pi 侧 plan 进入完成流程；`revise` 把评论注入对话流；
  `dismiss` **不杀 turn、不清草稿**（D3 非破坏语义）。

### 驱动

`docs/testing/testids-plan.md` 是**权威 testid 清单**（本文件不复刻），驱动按它取锚点。

1. 进计划模式：`type(role=textbox, '/plan 验证计划审阅')` + Enter
   → `expectVisible(testid=plan-mode-bar)`、`plan-mode-bar-stage` 三步指示可见。
2. faux 脚本编排（顺序敏感，faux 每轮消费一个 step）：
   - step1 `bash`：写文档到 `.tmp/plans/<slug>/plan.md`（slug 由 requirement 派生：
     非 `[a-z0-9]` 折叠成 `-`，空则 `untitled`，同名冲突递增 `-2`
     出处：`extensions/universal/plan/src/enter.ts`）；
   - step2 `plan` `{"action":"register-doc","fileName":"plan.md"}`；
   - step3 `plan` `{"action":"submit-review","selfReview":"自审结论…（必填）"}`。
   
   注意 `plan` 工具的参数是**扁平**的（`action` / `fileName` / `selfReview` 在顶层，
   出处：`extensions/universal/plan/src/tool.ts` 的 `parameters: Type.Object`）。
3. `expectVisible(testid=plan-review-bar)`；断言三键均可见，`plan-review-revise` 在 0 草稿时
   `isDisabled`（`title` 给出原因）。
4. 裁决：
   - 直接执行：`click(testid=plan-review-approve)` → bar 消失，`plan-mode-bar-stage` 推进
     （approved 档三步全对勾，出处：`testids-plan.md` §1）；
   - 修订：先在 `plan-docs-panel` 划选文本 → `plan-comment-trigger` → 填 `plan-comment-input`
     → `plan-comment-save` → bar 上出现草稿计数 → `plan-review-revise`；
   - 搁置：`click(testid=plan-review-dismiss)` → bar 消失但 plan 模式保持（stage 不变）。
5. 退出：`plan-mode-bar-exit` → 确认层 `plan-mode-bar-exit-cancel` / 确认按钮（与容器同名
   testid `plan-mode-bar-exit-confirm`，易误选，用容器内按钮定位）。

### 断言（期望终态 / 失败信号）

| # | 通道 | 断言 | 失败信号 |
|---|------|------|----------|
| 1 | A | `/plan` 后 `plan-mode-bar` 可见，`plan-mode-bar-stage` 含「需求探索/文档撰写/审阅确认」 | bar 不出现 = 命令未送达 pi（`session.getCommands` 里应能看到 `plan`） |
| 2 | A | 文档写完后 `plan-docs-panel` 有 `plan-docs-tab` 且 `plan-docs-content` 非空 | 只有 `plan-docs-empty` / `plan-docs-pending-*` = register-doc 未成功 |
| 3 | A | submit-review 后 `plan-review-bar` + 三键 | 只有 `plan-review-degraded` = 挂起请求丢失（走 degraded 降级分支） |
| 4 | B | `session.getPlanState` 的 `planState` 阶段随裁决变化（reviewing → approved/planning） | 阶段不动 = 决策 payload 未被 pi 解析 |
| 5 | C | `.tmp/plans/<slug>/plan.md` 存在且内容 = agent 写入内容 | 目录不存在 = `plan(enter)` 未真正激活 |
| 6 | C | pi jsonl 有 `plan` 工具调用与 details（`action` 字段） | 无 = 工具调用未落盘（pi flush 前提） |

> 3 是 A，4 是 B，5/6 是 C。注意 **`plan-review-bar` 的 degraded 分支自带 2s 稳定窗**
> （`testids-plan.md` §2 分支公式），断言「bar 出现」必须用带超时的可见性等待，
> 禁止断言「立刻出现」。

### 证据（A/B/C 各抓什么）

- **A**：`plan-bar.png`、`plan-review-ready.png`、`plan-review-approved.png`；DOM 抓
  `plan-mode-bar` 的 `data-*`/文本 + `plan-review-*` 可见 testid 清单 + `plan-docs-tab` 计数。
- **B**：`session.getPlanState` 前后快照；`session.history` 里 `plan` 工具块（含 details.action）。
- **C**：`.tmp/plans/<slug>/plan.md` 全文（或 sha256 + 行数）；pi jsonl grep `'"name":"plan"'`；
  会话树 `ext-sessions/<sid>/` 无 plan 域（plan 产物落项目目录，不在会话树——不要找错地方）。

### 证不了

- **划选评论的精确选区**：`plan-comment-trigger` 依赖 `plan-docs-content-area` 内的
  `Selection`，CDP 里可用 `document.createRange` 构造，但对 markdown 节点结构敏感；
  当前登记为 weak-anchor（只验「能开浮层 + 能保存草稿」，不验 quote 文本逐字相等）。
- **`plan-review-degraded` 的稳定窗时长**：源码注释写「2s 持续或主动拉取真值豁免」，
  这是时间平抑逻辑（AGENTS.md 红线场景）。本 capability **不把它做成断言**，只登记
  「degraded 分支存在」；要验它必须直接构造「挂起请求丢失」前置，代价高，暂列不可达。
- **移动壳的 plan 面**：本文件只覆盖桌面壳。

### Gotchas

- `plan-review-dismiss` 与旧 testid `plan-review-ignore` 不是同一个东西（前者是协议级
  dismiss 决策、非破坏；后者已退役）。旧脚本残留会红，见 `testids-plan.md` §5 变更登记。
- 修订键 0 草稿时禁用，不是 bug；不要用「点了没反应」判缺陷。
- `plan-mode-bar-exit-confirm` 同时是**容器**与**确认按钮**的 testid（同名），
  选择器要限定在确认层容器内。
- slug 冲突会生成 `-2` 后缀目录：反复验收同一需求时要么换 requirement，要么接受新目录
  （断言用「最新 mtime 的 plans 子目录」而不是硬编码 slug）。
- plan 模式激活后 agent 的工具集被收窄（`setActiveTools`）；faux 脚本里不要在同一 mode 下
  调被禁的工具，否则会得到工具不可用错误而非计划流。

---

## interaction.canvas · 问题解决画布（agent 生长 + 用户裁决）

- **通道**：A（`canvas-*` overlay / tray 面板）/ B（`canvas.list` / `canvas.get` / `canvas.updated` 广播）/ C（`ext-sessions/<sid>/canvases/<canvasId>/` 事件日志）
- **前置**：`requires: faux`；依赖 `chat.send` / `chat.wait` / `extension.load`；
  **必须先 `tool_search` 激活**（canvas 六工具是 `exposure:"deferred"`）
- **用于**：`p2-canvas-loop`（covers: `interaction.canvas`, `chat.send`, `session.history`）

### 入口（用户 POV / 协议 / 副作用点）

- 用户 POV：
  1. 让 agent「用画布把这个问题拆开」→ agent 先 `tool_search` 再调 `canvas_enter`；
  2. 画布 overlay 自动打开（`canvas-pane`）；
  3. 用户在画布上裁决：选方案（`canvas-action-select`）/ 否决（`canvas-detail-transitions` →
     `canvas-transition-to-rejected`）/ 评论（`canvas-action-comment`）/ 方向裁决
     （`canvas-direction-action`）/ 发起审查（`canvas-review-action`）/ 确认收敛
     （`canvas-converge-action`）；
  4. 用户裁决以「画布事件通知」形式回推给 agent（agent 下一轮先 `canvas_read` 再响应）。
- 协议入口（两条，一个 handler）：
  - **marker 通道**：六工具 execute 把调用翻成 `ctx.ui.select(CANVAS_MARKER, [{action,params}])`
    → `event-adapter` 显式分支 → runtime `CanvasService`（通道调用方恒为 agent）；
  - **WS 通道**：`canvas.list` / `canvas.get` / `canvas.mutate`，`payload.actor` 恒 `'user'`
    （GUI 操作链）。
  成功 mutate 后广播 `canvas.updated { canvasId, sessionId, evType, eventId, summary }`
  （出处：`packages/runtime/src/transport/canvas-message-handler.ts` 文件头 +
  `services/canvas/canvas-service.ts` 的 `broadcast()`；协议名在 `packages/shared/src/protocol.ts`）。
- 副作用点：画布归属 = 创建它的 session（`owner` 持久在落盘路径）；画布状态唯一权威在
  runtime `CanvasService`，renderer 只是镜像 + 失效重拉；**agent 侧 mutate 不触发回推**
  （防回环），用户侧 mutate 才回推一条通知。

### 驱动

1. 预置：faux 剧本 `fixtures/faux-responses/canvas-enter.json`（三步：`tool_search` → `canvas_enter`
   → 收尾文本；**deferred 激活链未实测**，见 README「跑不通」节）。若不用该剧本，手写等价两步：
   step1 `tool_search` `{"query":"canvas enter problem solving"}`，
   step2 `canvas_enter` `{"statement":"…","criterias":["…"],"scope":["…"]}`
   （参数 schema 出处：`extensions/taiji/canvas/src/tool-enter.ts` 的 `CanvasEnterParams`）。
2. 后置断言入口（不经 GUI 也能验状态）：`protocol.call('canvas.list', { sessionId })`。
3. 首发提交 → 等 `expectVisible(testid=canvas-pane)`。
   自动打开来源：`use-canvas-sync.ts` 的 `autoOpenListener`（`canvas.updated` → `openCanvas`，
   用户手动关过则不再自动开）。
4. 用户侧裁决（GUI 操作才会回推）：
   - 详情面板 `canvas-detail-panel` → tab `canvas-detail-tab-detail`；
   - 选方案：`canvas-action-select` → `canvas-op-dialog` → 填 `canvas-op-field-*` → `canvas-op-submit`；
   - 审查：`canvas-review-action`（header）/ `canvas-review-request`（空态）→
     `canvas-review-status` 变化；
   - 收敛：`canvas-converge-action` → `canvas-export-gates` 三格 `data-gate=ok`。
5. 分发：执行叶子 `canvas-node-dispatch-button` / `canvas-execution-dispatch-<leafId>`
   → 生成需求卡（下游产物指针在 `canvas-detail-dispatched` / `canvas-node-dispatched-badge`）。

### 断言（期望终态 / 失败信号）

| # | 通道 | 断言 | 失败信号 |
|---|------|------|----------|
| 1 | B | `canvas.list` 返回 1 条，`canvas.get` 的 state 含 root 节点与 3 要素 | 空列表 = marker 未路由到 CanvasService（看 runtime 日志 `canvas` 段） |
| 2 | A | `canvas-pane` 可见 + `canvas-phase-badge` 有值 | 不自动开 = 用户此前手动关过（`closedByUser` 打标）或广播丢失 |
| 3 | A | `canvas-node-question` 存在，`canvas-node-title` 含问题陈述 | 只有 `canvas-pane-loading` 常驻 = 拉取失败（看 `canvas-pane-error`） |
| 4 | C | `ext-sessions/<sid>/canvases/<canvasId>/` 下有事件日志，行数随 mutate 增长 | 目录为空 = 领域事件未落盘 |
| 5 | B | 用户裁决后 `canvas.updated` 帧到达（`evType` 与操作对应） | 无帧 = WS mutate 失败（`canvas.*` reply 两态信封的 `ok:false`） |

> 1/5 是 B，2/3 是 A，4 是 C。**只验 A 不够**：画布 UI 是镜像，权威在 `canvas.get`。

### 证据（A/B/C 各抓什么）

- **A**：`canvas-pane.png`（图 + 阶段徽标）、`canvas-review.png`、`canvas-export-gates.png`；
  DOM 抓 `canvas-pane` 的 `data-*`、节点 testid 计数（`canvas-node-*`）。
- **B**：`canvas.list` / `canvas.get` 的完整 reply（截断）；`canvas.updated` 帧序列。
- **C**：`ls -R ext-sessions/<sid>/canvases/<canvasId>/`（布局 SSOT = ADR-0151，
  路径推导 = `packages/shared/src/paths.ts` 的 `getSessionCanvasesDir`）。

### 证不了

- **canvas 六工具的「未激活直接调用」错误形态**：工具是 `deferred`，扩展自己在
  `<available_tools>` 注入段要求「先 `tool_search`」（出处：`extensions/taiji/canvas/src/index.ts`
  文件头 + 注入段文案）。未激活时 pi 对未声明工具的行为未在 taiji 侧断言（**需补**：
  用 faux 发一次裸 `canvas_enter` 记录实际错误帧）。
- **宿主谓词**：工具执行前要求 `TAIJI_AGENT_EXT_LOG === "1"` 且 `ctx.mode === "rpc"`
  （`isTaijiGuiHost`）。taiji runtime 恒注入前者、pi 以 `--mode rpc` 启动，故真机恒真；
  **裸 pi CLI 下画布工具会返回结构化「非 taiji 宿主」错误**，别在 pi CLI 里验画布。
- **画布「自动打开」的抑制态**：用户手动关闭后打标（`markCanvasClosedByUser`）阻止自动重开，
  该打标无 UI 可见面，只能通过「关掉后 agent 再 mutate 不重开」的行为反证 → weak-anchor。
- **画布导出产物内容正确性**（`canvas-export-planning` / `canvas-export-requirement` 的文档质量）：
  只验「按钮可用 + 产物落盘」，不验文档语义。

### Gotchas

- 画布 overlay 挂在 **workflow-viz overlay** 容器里（`WorkflowVizOverlay.vue` 的 canvas body
  分支），不是右抽屉 tab；用 `canvas-pane` 定位，不要找 `drawer-tab-canvas`。
- 画布按归属会话隔离：切到别的 session 打不开本会话的画布（会 `forbidden`），
  脚本里别在 A 会话创建、B 会话读取。
- tray 面板第 5 件「画布」在**零画布时外壳按钮隐藏**（`tray-canvas-create` 随首张画布出现），
  所以「创建画布」的用户入口只有 agent（或已有画布后的 tray 按钮）。
- 画布事件日志与 `canvas.updated` 广播是两条路：广播丢失可由 `canvas.list/get` 补读收敛
  （ADR-0097 拉为主），断言不要依赖「必须收到广播」。
