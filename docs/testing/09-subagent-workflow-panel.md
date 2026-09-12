# 09 · Subagent/Workflow 面板测试流程

> 覆盖范围：侧边栏 SegmentedTab 的 Agents/Flows 两个新 tab；subagent 列表加载、卡片渲染、点击进入对话流、返回主 session；workflow 空态占位。
>
> 先读 [00 总览](00-test-strategy-overview.md) 了解双轨制和三视角模型。执行计划原见 test-plan-subagent-workflow.md（已退役，git 历史 `eb884da68` 前版本可查）。

## §1 功能概述

### 主流程

```
用户点击 Agents tab
  → Sidebar watch 检测 activeTab='subagents'
  → useSubagentView.loadSubagents(activeSessionId)
  → sessionApi.getSubagents (WS RPC: session.getSubagents)
  → runtime: SessionService.getSubagents → extractSubagentsFromSessionFile(sessionFile)
  → 读主 session JSONL，提取 subagent 工具调用/结果/bg-notify
  → 返回 SubagentRecord[]
  → 前端渲染卡片列表

用户点击 subagent 卡片
  → useSubagentView.selectSubagent(subagentId)
  → 保存 originalSessionId
  → sessionApi.getSubagentHistory → runtime 读 subagent JSONL → Message[]
  → chatStore.hydrate('subagent:<id>', messages)
  → panel.loadSession(panelId, 'subagent:<id>')
  → Panel 渲染 MessageStream + PanelHeader 显示返回按钮

用户点击返回
  → useSubagentView.backToMainSession()
  → panel.loadSession(panelId, originalSessionId)
  → Panel 恢复原 session header
```

Workflow tab 当前仅为空态占位（无后端逻辑）。

### 架构分层

| 层 | 文件 | 职责 |
|---|---|---|
| 展示组件 | `SubagentList.vue` | 渲染 SubagentRecord[] 卡片，点击 emit select |
| 展示组件 | `SegmentedTab.vue` | 4 tab 等宽均分 + badge 点 |
| 编排 composable | `useSubagentView.ts` | loadSubagents/selectSubagent/backToMainSession，模块级单例 |
| Store | `sidebar.ts` | `activeTab` 状态（sessions/files/subagents/workflows） |
| API domain | `api/domains/session.ts` | getSubagents/getSubagentHistory WS RPC |
| Mock domain | `api/mock/index.ts:259-269` | 返回空数组（mock 无真实 subagent 数据） |
| Runtime extractor | `subagent-extractor.ts` | 解析主 session JSONL → SubagentRecord[] |
| Runtime service | `session-service.ts:320-336` | getSubagents/getSubagentHistory |
| Transport handler | `session-message-handler.ts:88-95` | session.getSubagents/session.getSubagentHistory 路由 |

## §2 组件树

```
Sidebar.vue
├─ SegmentedTab.vue [v-model=sidebar.activeTab]
│   ├─ Button title="会话" (MessageSquare)    count=sessionCount
│   ├─ Button title="文件" (File)             count=fileCount
│   ├─ Button title="Agents" (Bot)            count=subagentCount  badge=subagentCount>0
│   └─ Button title="Flows" (Workflow)        count=0              badge=workflowCount>0
│
├─ [v-if activeTab==='subagents']
│   └─ SubagentList.vue [data-testid="subagent-list"]
│       ├─ [v-if subagents.length > 0]
│       │   └─ div [data-testid="subagent-card"] (@click=emit select)
│       │       ├─ Loader2 v-if="status==='running'" [data-testid="subagent-card-spinner"]
│       │       ├─ span.dot v-else (statusDotClass: bg-success/bg-danger/bg-subtle/bg-accent)
│       │       ├─ span.agent (record.agent)
│       │       ├─ span.id (subagentId slice 12)
│       │       ├─ summary (turns / tokens / elapsed)
│       │       └─ div.task (record.task)
│       └─ [v-else] div [data-testid="subagent-list-empty"]
│           ├─ Bot icon
│           ├─ p "暂无后台任务"
│           └─ p "发起 subagent 后在此查看进度"
│
├─ [v-else-if activeTab==='workflows']
│   └─ div [data-testid="workflow-list-empty"]
│       ├─ Workflow icon
│       ├─ p "暂无工作流"
│       └─ p "发起 workflow 后在此查看进度"
│
└─ [v-else] FileView / file-view-no-session
```

Panel 层（subagent 视图切换时）：

```
Panel.vue
├─ subagentLabel computed: `${record.agent} · ${subagentId.slice(12)}`
├─ PanelHeader.vue
│   ├─ [v-if viewingSubagent] Button [data-testid="subagent-back-btn"] (ArrowLeft)
│   ├─ [v-if viewingSubagent] span (subagentLabel)
│   └─ [v-else] 正常 header（spinner/breadcrumb/buttons）
└─ MessageStream [v-if sessionId && messageCount > 0]
    （virtualId='subagent:<id>' 透明复用，无需特殊处理）
```

## §3 data-testid 清单

| testid | 文件 | 触发/可见条件 |
|--------|------|-------------|
| `subagent-list` | SubagentList.vue:8 | Agents tab 激活时（恒定，容器） |
| `subagent-card` | SubagentList.vue:16 | `subagents.length > 0`，每条记录一个 |
| `subagent-card-spinner` | SubagentList.vue:23 | `record.status === 'running'` |
| `subagent-list-empty` | SubagentList.vue:56 | `subagents.length === 0` |
| `workflow-list-empty` | Sidebar.vue:101 | workflows tab 激活时（恒定） |
| `file-view-no-session` | Sidebar.vue:119 | files tab + 无 active session |
| `subagent-back-btn` | PanelHeader.vue:68 | `viewingSubagent === true` |
| `panel-session-spinner` | PanelHeader.vue:80 | `!viewingSubagent && showSpinner` |

**状态点 CSS 类**（非 testid，但测试可检查）：
- `bg-success` — done 状态（绿色圆点）
- `bg-danger` — failed 状态（红色圆点）
- `bg-accent` — running 或未知（accent 色）
- `bg-subtle opacity-50` — cancelled（灰色）

## §4 调用链

### 4.1 加载 subagent 列表

```
Sidebar watch([activeTab, session.activeId])
  → tab==='subagents' && sid → loadSubagents(sid)
    → sessionApi.getSubagents(sid)
      → transport.send({type:'session.getSubagents', payload:{sessionId:sid}})
        → WS → server.ts → SessionMessageHandler
          → ctx.sessionService.getSubagents(sid)
            → scanSessions() 找 session.filePath
            → extractSubagentsFromSessionFile(filePath)
              → readFileSync → parseJsonl → 遍历 entries
              → 提取 toolCalls / toolResults / bgNotifies / listItems
              → 组装 SubagentRecord[]
          → ctx.reply(ws, msg.id, 'session.subagents', {sessionId, subagents})
        ← reply → pending resolve → SubagentRecord[]
    → subagentRecords.value = records
    → subagentCount computed 更新 → SegmentedTab badge 点亮
```

### 4.2 选中 subagent → 切换对话流

```
SubagentList @click → emit('select', subagentId)
  → Sidebar.onSelectSubagent → subagentView.selectSubagent(id)
    → panel.activePanelId + activeLeafPanel
    → originalSessionId = panel 当前 sessionId（首次进入）
    → currentSubagentId = id
    → isHydrated('subagent:<id>')? 跳过 : sessionApi.getSubagentHistory
      → transport.send({type:'session.getSubagentHistory', payload:{sessionId, subagentId}})
        → runtime: getSubagentHistory → 找 record.sessionFile → getHistoryFromFilePath
          → parseJsonl + convertHistory → Message[]
        ← reply → Message[]
      → chatStore.hydrate('subagent:<id>', messages)
    → panel.loadSession(panelId, 'subagent:<id>')
    → viewingSubagent = true
      → PanelHeader 渲染 back-btn + subagentLabel
      → MessageStream 渲染（messageCount > 0）
```

### 4.3 返回主 session

```
PanelHeader @click back-btn → emit('back')
  → Panel.onSubagentBack → subagentView.backToMainSession()
    → panel.loadSession(panelId, originalSessionId)
    → viewingSubagent = false, currentSubagentId = null, originalSessionId = null
      → PanelHeader 恢复正常 header
      → MessageStream 渲染原 session 消息
```

### 4.4 sessionFile 后备查找（background 模式）

background 模式 subagent 的 sessionFile 可能为 null（bg-notify 不带 sessionFile，listResponse 可能缺失）。extractor 的后备链路：

```
record.sessionFile 查找优先级：
  1. listItem.sessionFile（listResponse.items 中匹配的）
  2. toolResult.sessionFile（bgResponse 返回的，通常 null）
  3. findSubagentSessionFile(mainCwd, startedAt)
     → 扫描 getSubagentSessionDir(mainCwd)/sessions/*.jsonl
     → parseIsoFromFilename 提取文件名中的时间戳
     → 匹配 startedAt ±60s 窗口内最近的文件
```

## §5 MOCK 模式测试（vitest 集成）

mock 层 `getSubagents` 返回空数组，故 mock 轨只能测空态。已有 vitest 单测覆盖组件交互逻辑。

**运行命令**（cwd 敏感）：

```bash
cd packages/renderer && npx vitest run src/__tests__/sidebar/SegmentedTab.spec.ts
cd packages/renderer && npx vitest run src/__tests__/sidebar/SubagentList.spec.ts
cd packages/runtime && npx vitest run test/subagent-extractor.test.ts
cd packages/runtime && npx vitest run test/subagent-service.test.ts
```

**测试矩阵**：

| 用例 | 文件 | 层 | 覆盖点 |
|------|------|---|--------|
| SegmentedTab 4 tab 渲染 | `SegmentedTab.spec.ts` | 集成 | 4 个 Button 存在 + label/title |
| 计数显示 | `SegmentedTab.spec.ts` | 集成 | count > 0 显示数字 |
| badge 显示/隐藏 | `SegmentedTab.spec.ts` | 集成 | subagentCount > 0 → 蓝点 |
| 点击 tab 触发 | `SegmentedTab.spec.ts` | 集成 | emit update:modelValue |
| encodeCwd 各平台 | `subagent-extractor.test.ts` | 单元 | mac/win/linux 路径编码 |
| 同步提取 | `subagent-extractor.test.ts` | 单元 | syncResponse → status/turns/tokens |
| 后台提取 + bg-notify | `subagent-extractor.test.ts` | 单元 | bgResponse + bg-notify 合并 |
| sessionFile 后备查找 | `subagent-extractor.test.ts` | 单元 | null → 扫描目录匹配时间戳 |
| 空文件/不存在 | `subagent-extractor.test.ts` | 单元 | 返回 [] |
| SubagentList 卡片渲染 | `SubagentList.spec.ts` | 集成 | 卡片 DOM + 文本 |
| 空状态渲染 | `SubagentList.spec.ts` | 集成 | subagent-list-empty |
| 点击卡片 select | `SubagentList.spec.ts` | 集成 | emit select(subagentId) |
| spinner 显示 | `SubagentList.spec.ts` | 集成 | running → Loader2 |

### 三视角覆盖核验

| 视角 | 覆盖用例 |
|------|---------|
| 构建者（白盒） | encodeCwd / extractor 数据组装 / service 路由 |
| 使用者（黑盒 DOM） | 卡片渲染 / 空态渲染 / 点击 select / 返回按钮 |
| 观察者（首屏冒烟） | SegmentedTab 4 tab 存在 / SubagentList 容器存在 |

## §6 非 MOCK 模式测试（real-track 手工 E2E）

**铁律：MOCK 全绿 ≠ 功能可用。** mock 层 subagent 返回空数组，必须连真实 runtime 验证。

### 测试通道

```
pnpm dev → Electron (--remote-debugging-port=9222)
  → browser-automation pw.js connectOverCDP
  → Playwright 操作 renderer
```

### 手工冒烟清单

| 步骤 | 操作 | 期望 |
|------|------|------|
| R-1 | 启动 `pnpm dev`，等 Electron 窗口渲染 | CDP 9222 可连，首窗加载 session 列表 |
| R-2 | 点 sessions tab → 选 chat_project cwd 的 session | session 激活，panel 显示对话流 |
| R-3 | 点 Agents tab | 列表加载，出现 subagent 卡片 |
| R-4 | 检查卡片内容 | agent=general-purpose，status=done（绿点），task 描述可见 |
| R-5 | 点 subagent 卡片 | panel 切换到对话流，header 显示返回按钮 + subagent label |
| R-6 | 点返回按钮 | panel 恢复原 session |
| R-7 | 点 Flows tab | 空态「暂无工作流」 |
| R-8 | 切到无 subagent 的 session → Agents tab | 空态「暂无后台任务」 |
| R-9 | devtools console 无报错 | 无 `Cannot read property` / `WebSocket` 类错误 |

### 详细执行步骤

详细执行计划原见 test-plan-subagent-workflow.md（已退役，git 历史 `eb884da68` 前版本可查，含完整命令和断言）。

## §7 Playwright E2E（real-track CDP）

**当前状态：⚠️ 手工执行（非 spec 脚本自动化）**

mock 轨的 Playwright E2E（`e2e/*.spec.ts`）无法覆盖本功能——mock 层返回空数组。real-track 的 Playwright 自动化需要连真实 runtime，现有 `launch-app-real.ts` fixture 仅用于 workspace 持久化测试，不包含 subagent 场景的 session 数据准备。

**手工 E2E 价值**：验证完整数据链路（runtime JSONL 解析 → WS RPC → 前端渲染 → 用户交互），是 mock 单测不可替代的。

**执行方法**：通过 browser-automation skill 的 `pw.js` 连接 dev app CDP 端口，逐用例操作 + 断言。具体命令见 test-plan 文档。

### 未来 spec 自动化方向

若要做成 `npx playwright test` 自动化 spec，需要：
1. 准备一个含 subagent 工具调用的 fixture session JSONL 文件
2. real-track fixture 启动时把 fixture 拷入临时数据目录
3. spec 中 activateSession → 切 tab → 断言

当前因 dev 数据目录已有真实数据且数据准备复杂度高，优先用手工 CDP 验证。

## §8 已知缺口

| 缺口 | 影响 | 缓解 | 优先级 |
|------|------|------|--------|
| mock getSubagents 返回空数组 | mock E2E 无法测列表渲染 | 手工 real-track CDP 测试 | P2 |
| 无自动化 real-track spec | CI 不跑 subagent E2E | 手工冒烟清单 + vitest 单测保底 | P2 |
| workflow tab 无后端逻辑 | 无法测 workflow 数据渲染 | 当前为空态占位，Phase 3 补充 | P3 |
| subagent badge 只按 count 判断 | running 状态不够精确 | 后续按 status 判断（代码注释已标注） | P3 |
| 实时流式未接入 | 后台 subagent 完成不会实时更新列表 | 需刷新 tab 重拉，Phase 2 补 bg-notify WS 推送 | P2 |

## §9 设计文档溯源

- 类型定义：`packages/shared/src/subagent.ts`
- 协议扩展：`packages/shared/src/protocol.ts`（session.getSubagents/session.getSubagentHistory）
- 路径推导：`packages/runtime/src/infra/pi/pi-paths.ts`（encodeCwd/getSubagentSessionDir）
- 提取逻辑：`packages/runtime/src/services/session/subagent-extractor.ts`
- 历史 DRY：`packages/runtime/src/services/session-history.ts`（getHistoryFromFilePath）
