/**
 * Tasks Drawer REAL E2E —— 真实 runtime + pi 子进程 + faux LLM 演员（L2.5 翻轨，2026-09-15）。
 *
 * 与 mock 轨的差异：
 * - 不设 VITE_MOCK/TAIJI_MOCK → main spawn runtime → runtime spawn pi 子进程
 * - 真实 goal/todo extension 被 pi load（dev 装配下经 mandatory 源码目录加载），
 *   真实协议格式（__gui__ / ANSI widget）
 * - LLM turn 全部 faux 脚本化（toolCall 参数可预设）——零 token、确定性触发，
 *   原「模型未调 tool → flaky skip」容忍层全部移除
 *
 * 三条 case：
 * - R1：extension load 契约（无 LLM）—— pi 能 load goal/todo extension 无报错
 * - R2：todo tool 调用 → 协议格式含 __gui__ tab-bar 双段（faux toolCall 脚本化）
 *       + meta icon/badge 契约 + **托盘挂载链路终点**（widgetGui 消费端迁移后的 e2e 覆盖，
 *       见下方「R2 的托盘断言来源」）
 * - R3：goal_control 调用 → 协议格式含 __gui__ group（faux toolCall 脚本化）
 *
 * R2 的托盘断言来源（2026-09-16 composer-task-tray）：GUI 协议 widget 的渲染终点由对话流
 * widget pill 迁至 composer 任务托盘（设计 D3/D11），但 **mock 轨无法覆盖该链路**——mock 的
 * `pushSession` 只调 `events.dispatchSession`（session 通道），而 ViewHostStore 的消费者
 * （ExtensionHost bridge）经 `onCrossSession` 订阅，route-inbound 的 crossSession 分发腿在
 * mock 下不存在（修复点在 packages/core/src/transport/mock/index.ts，出 u-e2e 领地）。
 * 故「extension:widgetGui → ViewHostStore → 托盘 icon/badge/面板」的端到端断言落在本 real 轨
 * （真 runtime + 真 WS 帧 + 真 route-inbound），断言值取自真实 todo extension 的推送载荷。
 *
 * R1 的 source 断言语义变化（翻轨裁决）：原断言 `sourceInfo.source === 'npm:@zhushanwen/pi-goal'`
 * 绑定 npm 安装装配（symlink ~/.taiji-dev/npm）；faux 轨凭证无关装配下 mandatory 扩展经
 * dev 源码目录以 --extension 显式注入（extension-resolver scanBundledExtensions dev 分支），
 * pi 对 --extension 注入的扩展报 `sourceInfo.source === 'cli'`（见下方 R1 断言；`source`
 * 仍为 'extension'）——保留「真实 extension 被 pi load」的契约语义，不绑定安装来源。
 */
import { test, expect, type Page } from '@playwright/test'
import {
  launchRealApp,
  waitForRuntime,
  wsRoundTrip,
  openListenWs,
  readRuntimeLogs,
  type WsFrame,
} from './fixtures/launch-app-real'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SAMPLE_PROJECT = path.join(REPO_ROOT, 'e2e', 'fixtures', 'sample-project')

/** R2 faux 脚本：todo add（三步骤）→ stop 文本 */
const R2_FAUX_SCRIPT = [
  {
    toolCalls: [{
      name: 'todo',
      args: { action: 'add', texts: ['分析根因', '修复代码', '验证修复'] },
    }],
  },
  { text: '已把三个步骤加进任务清单。' },
]

/** R3 faux 脚本：goal_control create → stop 文本 */
const R3_FAUX_SCRIPT = [
  {
    toolCalls: [{
      name: 'goal_control',
      args: {
        action: 'create',
        slug: 'optimize-login-perf',
        objective: '优化登录性能',
        successCriteria: ['登录接口响应时间下降'],
      },
    }],
  },
  { text: '已创建 goal。' },
]

// ── R2/R3 共享 helper：tool_call_end 轮询 / 诊断落盘 / 帧结构收窄 / 收尾清理 ──

/** tool result details 最小面（R2 消费 todos，R3 消费 slug） */
type ToolResultDetails = {
  todos?: Array<{ id?: string; text?: string; status?: string }>
  slug?: string
}

/** W21 entry 化协议下 tool_call_end.payload.entry 上的 result message 最小面 */
type ToolResultEntry = { message?: { details?: ToolResultDetails } }

/** extension:widgetGui 推送载荷最小面（托盘 widget 区数据源，断言消费字段） */
type WidgetGuiPayload = {
  gui?: unknown
  meta?: { title?: string; status?: string; icon?: unknown; badge?: string; progress?: { current: number; total: number } }
}

/** tool_call_end 轮询总预算（faux 脚本确定性触发，超时即失败）与复查间隔 */
const TOOL_CALL_END_TIMEOUT_MS = 60_000
const TOOL_CALL_END_POLL_INTERVAL_MS = 1_000

/** 测试收尾：关 app + 清理临时 dataDir（PLAYWRIGHT_DEBUG_KEEP_DATA=1 时保留现场排查） */
async function cleanupRealApp(cleanup: () => Promise<void>, dataDir: string): Promise<void> {
  await cleanup()
  if (!process.env.PLAYWRIGHT_DEBUG_KEEP_DATA) {
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  } else {
    console.log('[cleanup] dataDir 保留:', dataDir)
  }
}

/** W21 entry 化协议：tool_call_start.payload.entry.toolName（缺失按空串处理 → 不命中 pattern） */
function entryToolName(frame: WsFrame): string {
  const entry = frame.payload?.entry as { toolName?: unknown } | undefined
  return String(entry?.toolName ?? '')
}

/** 广播事件流里定位「指定 tool 的 tool_call_start 之后的第一条 tool_call_end」（W21 entry 化协议） */
function findToolCallEnd(events: WsFrame[], toolNamePattern: RegExp): WsFrame | undefined {
  const startIdx = events.findIndex(
    (e) => e.type === 'message.tool_call_start' && toolNamePattern.test(entryToolName(e)),
  )
  if (startIdx < 0) return undefined
  return events.find((e, i) => i > startIdx && e.type === 'message.tool_call_end')
}

/**
 * 轮询广播事件流直到指定 tool 的 tool_call_end 到达（事件由 openListenWs 的 WS 持续追加），
 * 超时返回 undefined（调用方负责落盘诊断 + 断言失败）。
 */
async function waitForToolCallEnd(
  events: WsFrame[],
  toolNamePattern: RegExp,
  timeoutMs = TOOL_CALL_END_TIMEOUT_MS,
): Promise<WsFrame | undefined> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const endEvt = findToolCallEnd(events, toolNamePattern)
    if (endEvt) return endEvt
    await new Promise((r) => setTimeout(r, TOOL_CALL_END_POLL_INTERVAL_MS))
  }
  return undefined
}

/** tool_call_end 超时未到达时的 fail-path 诊断落盘（events 概览 + tool_call_start 清单 + runtime 日志尾） */
function writeToolCallDiag(diagPath: string, label: string, events: WsFrame[], runtimeLogsTail: string): void {
  fs.writeFileSync(diagPath, JSON.stringify({
    eventCount: events.length,
    eventTypes: [...new Set(events.map((e) => e.type))],
    toolCallStarts: events
      .filter((e) => e.type === 'message.tool_call_start')
      .map((e) => entryToolName(e)),
    runtimeLogsTail,
  }, null, 2))
  console.log(`[${label}] tool_call_end 未到达（events=${events.length}），diag → ${diagPath}`)
}

/** W21 entry 化协议：tool result details 透传在 end.payload.entry.message.details */
function toolResultDetails(endFrame: WsFrame | undefined): ToolResultDetails {
  const entry = endFrame?.payload?.entry as ToolResultEntry | undefined
  return entry?.message?.details ?? {}
}

/** 兼容 widgetGui 推送有/无 {v,component} 包装层：取 GuiComponent 内容根 */
function guiContentRoot(guiRaw: unknown): unknown {
  return (guiRaw as { component?: unknown })?.component ?? guiRaw
}

/** __gui__ GuiComponent 顶层 type（tab-bar / group 等） */
function guiComponentType(gui: unknown): string | undefined {
  return (gui as { type?: string } | undefined)?.type
}

/**
 * 通过 WS 创建 session 并激活。OS 原生目录选择 dialog 不可自动化，
 * TEST-STRATEGY 约定用 WS 直连触发等效业务动作。
 */
async function createAndActivateSession(port: number): Promise<string> {
  const createReply = await wsRoundTrip(port, {
    type: 'session.create',
    id: 'tasks-real-create',
    payload: { cwd: SAMPLE_PROJECT, label: 'tasks-real-sample' },
  }, 'tasks-real-create')
  expect(createReply.type).toBe('session.created')
  return (createReply.payload.session as { id: string }).id
}

// ── R1: extension load 契约（无 LLM，确定性强） ──────────────────────────

test('R1: pi load goal/todo extension + session.create 成功', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'taiji-real-tasks-'))
  const { page, cleanup } = await launchRealApp({ dataDir, faux: { responses: [] } })
  try {
    await expect(page).toHaveTitle(/太极/)
    const port = await waitForRuntime(dataDir, 30_000)
    expect(port).toBeGreaterThan(0)

    // runtime 启动后给 1s 让 extension load 日志落盘
    await new Promise((r) => setTimeout(r, 1000))

    const runtimeLogs = readRuntimeLogs(dataDir)

    // 契约 1：extension-resolver 成功解析了 extension（resolve N from M sources）
    const resolveMatches = runtimeLogs.match(/\[extension-resolver\] resolved (\d+) extensions from (\d+) sources/g)
    expect(resolveMatches, 'extension-resolver 应至少被调用一次').not.toBeNull()
    const lastResolve = resolveMatches![resolveMatches!.length - 1]
    expect(lastResolve).toMatch(/resolved [1-9]\d* extensions from [1-9]\d* sources/)

    // 契约 2：session.create 成功（pi 能正常响应——faux 模型预置过 getDefaultModel 门禁）
    const createReply = await wsRoundTrip(port, {
      type: 'session.create',
      id: 'r1-create',
      payload: { cwd: SAMPLE_PROJECT, label: 'r1-sample' },
    }, 'r1-create')
    if (createReply.type !== 'session.created') {
      fs.writeFileSync('/tmp/r1-session-create-error.json', JSON.stringify({
        createReply,
        runtimeLogsTail: runtimeLogs.slice(-3000),
      }, null, 2))
      console.log('[R1] session.create error, diag written to /tmp/r1-session-create-error.json')
    }
    expect(createReply.type).toBe('session.created')
    const session = createReply.payload.session as { id: string }
    const sessionId = session.id

    // 契约 3（核心）：goal/todo extension 被 pi load，出现在 commands 列表里。
    // 这是 real E2E 独有的验证：真实 pi load 真实 extension（dev 装配 = mandatory 源码目录）。
    const cmdsReply = await wsRoundTrip(port, {
      type: 'session.getCommands',
      id: 'r1-cmds',
      payload: { sessionId },
    }, 'r1-cmds')
    if (cmdsReply.type !== 'session.commands') {
      fs.writeFileSync('/tmp/r1-cmds-reply.json', JSON.stringify(cmdsReply, null, 2))
      console.log('[R1] getCommands reply type:', cmdsReply.type, '(diag → /tmp/r1-cmds-reply.json)')
    }
    expect(cmdsReply.type).toBe('session.commands')
    const cmds = cmdsReply.payload.commands as Array<{ name: string; source: string; sourceInfo?: { source?: string } }>
    const goalCmd = cmds.find((c) => c.name === 'goal')
    const todosCmd = cmds.find((c) => c.name === 'todos')
    expect(goalCmd, 'goal extension command 应被 pi load').toBeDefined()
    expect(todosCmd, 'todos extension command 应被 pi load').toBeDefined()
    // source 验证（语义见文件头「R1 的 source 断言语义变化」）：来自 extension 加载 +
    // --extension 显式注入标识（dev 装配 mandatory 源码目录，pi 报 sourceInfo.source='cli'）
    expect(goalCmd?.source).toBe('extension')
    expect(goalCmd?.sourceInfo?.source, 'goal sourceInfo 应为 cli（--extension 注入）').toBe('cli')
    expect(todosCmd?.sourceInfo?.source, 'todos sourceInfo 应为 cli（--extension 注入）').toBe('cli')
  } finally {
    await cleanupRealApp(cleanup, dataDir)
  }
})

// ── R2: todo tool 调用 → 验证 todo 协议格式（__gui__ tab-bar 双段 + meta） ──

/**
 * R2 协议契约断言 1：tool result details.todos（W21 entry 化协议，details 在
 * entry.message.details）——todos 原始数组是 TasksPanel 渲染主数据源。
 * 返回 todos 供后续 meta/badge 与 UI 断言复用。
 */
function assertTodoDetails(details: ToolResultDetails): NonNullable<ToolResultDetails['todos']> {
  const todos = details.todos ?? []
  expect(Array.isArray(details.todos), 'details.todos 应为数组（TasksPanel 渲染数据源）').toBe(true)
  expect(todos.length, '至少 1 个 todo').toBeGreaterThan(0)
  expect(todos[0].id, 'todos item 应有 id').toBeDefined()
  expect(todos[0].text, 'todos item 应有 text').toBeDefined()
  expect(['pending', 'in_progress', 'completed', 'cancelled']).toContain(todos[0].status)
  return todos
}

/**
 * R2 协议契约断言 2：GuiComponent 结构化推送（tab-bar 双段）。现行载体是
 * extension:widgetGui 广播（M17 widget 面板，guiSetWidget → EventAdapter NUL marker
 * 解码 → runtime 广播），不是 tool result details.__gui__（旧协议形态，W21 entry 化 +
 * widget 推送分离后 details 只剩数据字段）。兼容有/无 {v,component} 包装层。
 */
function assertTodoTabBarContract(events: WsFrame[]): WidgetGuiPayload {
  const widgetGui = events.find((e) => e.type === 'extension:widgetGui')
  expect(widgetGui, 'todo 调用应触发 extension:widgetGui 广播（托盘 widget 区数据源）').toBeDefined()
  const widgetPayload = widgetGui!.payload as WidgetGuiPayload
  const guiNode = guiContentRoot(widgetPayload.gui) as {
    type?: string
    props?: { tabs?: Array<{ label?: string; active?: boolean }>; sections?: Array<Array<{ type?: string }>> }
  }
  // 内容根 = tab-bar（todo buildGui 双段容器化改造：单 list-tree → tab-bar + sections 双段）
  expect(guiNode.type, 'widgetGui.gui 应为 tab-bar GuiComponent').toBe('tab-bar')
  const tabs = guiNode.props?.tabs ?? []
  const sections = guiNode.props?.sections ?? []
  expect(tabs.length, 'tab-bar 应有 待办/已完成 两段标签').toBe(2)
  expect(sections.length, 'sections 与 tabs 等长（两段子树）').toBe(2)
  expect(tabs[0]?.label, '首段标签为待办 + 未完成计数').toMatch(/^待办 \d+$/)
  expect(tabs[1]?.label, '次段标签为已完成 + 计数').toMatch(/^已完成 \d+$/)
  expect(tabs[0]?.active, '首段显式 active（宿主初始 tab 依据）').toBe(true)
  // 段内容 = list-tree（两段同构：行首序号 + status 圆点）
  expect(sections[0]?.[0]?.type, '待办段内容为 list-tree').toBe('list-tree')
  expect(sections[1]?.[0]?.type, '已完成段内容为 list-tree').toBe('list-tree')
  return widgetPayload
}

/** R2 协议契约断言 3：meta（托盘 icon/badge 的上游契约，D4 字段；badge 与首段 tab 计数同源，防双口径） */
function assertTodoMetaContract(widgetPayload: WidgetGuiPayload, todos: NonNullable<ToolResultDetails['todos']>): void {
  expect(widgetPayload.meta?.title).toBe('Todo')
  expect(widgetPayload.meta?.icon, 'todo 推 icon=list-checks（宿主 registry 可解析）').toBe('list-checks')
  // badge = 未完成条数（3 条 pending → '3'）
  expect(widgetPayload.meta?.badge).toBe(String(todos.filter((t) => t.status !== 'completed').length))
  expect(widgetPayload.meta?.progress?.total, 'progress.total = 条目全量').toBe(todos.length)
}

/** R2 UI 断言：托盘 widget 区挂载（widgetGui 消费端迁移后唯一可达的端到端链路终点，见 R2 测试头注） */
async function assertTodoTrayUi(page: Page, badge: string, todoCount: number): Promise<void> {
  await page.getByText('tasks-real-sample').click()
  await expect(page.getByTestId('composer-box')).toBeVisible({ timeout: 15_000 })
  const widgetButton = page.locator('[data-testid="tray-widget-button"][data-widget-key="todo"]')
  await expect(widgetButton, 'setWidget 推送的 todo widget 应挂到 composer 托盘').toBeVisible({ timeout: 10_000 })
  // badge = meta.badge；icon 命中宿主 registry（list-checks → glyph，非兜底 paths）
  await expect(widgetButton.getByTestId('tray-widget-badge')).toHaveText(badge)
  await expect(widgetButton.getByTestId('tray-widget-icon-glyph')).toBeVisible()
  await expect(widgetButton.getByTestId('tray-widget-pulse'), 'idle 态不渲染呼吸点（归零不虚亮）').toHaveCount(0)
  // 面板：meta head（title/progress）+ tab-bar 双段渲染（协议断言的 DOM 终点）
  await widgetButton.click()
  const widgetPanel = page.locator('[data-testid="tray-panel"][data-panel-key="widget:todo"]')
  await expect(widgetPanel).toBeVisible({ timeout: 5_000 })
  await expect(widgetPanel.getByTestId('tray-widget-panel-title')).toHaveText('Todo')
  await expect(widgetPanel.getByTestId('tray-widget-panel-label')).toHaveText(`0/${todoCount}`)
  await expect(widgetPanel.getByTestId('gui-tab-bar')).toBeVisible()
  await expect(widgetPanel.getByTestId('gui-tab-bar-section').getByTestId('gui-list-tree'))
    .toContainText('分析根因')
}

/**
 * WS 驱动 + 监听广播事件。协议断言不走 UI 输入（real 模式**新建** session 需 OS 原生目录选择
 * dialog，不可自动化），改为 WS 发 prompt + 监听 runtime 广播的 tool_call_end 事件，验证真实
 * extension 返回的 __gui__ GuiComponent 格式（这是 real 轨独有的协议契约验证）。
 *
 * 协议断言之后补一段 UI 断言：把该 session 在侧栏激活 → 托盘 widget 区渲染该 widget
 * （icon/badge 出现 + 面板内容渲染）。这是 widgetGui 消费端迁移（对话流 pill → 托盘）后
 * 唯一可达的端到端链路（mock 轨缺 crossSession 分发腿，见文件头「R2 的托盘断言来源」）。
 */
test('R2: todo tool 调用 → 协议格式含 __gui__ tab-bar 双段 + 托盘挂载', async () => {
  test.setTimeout(180_000)
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'taiji-real-tasks-'))
  const { page, cleanup } = await launchRealApp({ dataDir, faux: { responses: R2_FAUX_SCRIPT } })
  try {
    await expect(page).toHaveTitle(/太极/)
    const port = await waitForRuntime(dataDir, 30_000)
    const sessionId = await createAndActivateSession(port)

    const { ws: listenWs, events } = await openListenWs(port, sessionId)

    await wsRoundTrip(port, {
      type: 'message.send',
      id: 'r2-send',
      payload: { sessionId, content: '请用 todo tool 把这三个步骤加进任务清单：1. 分析根因 2. 修复代码 3. 验证修复。' },
    }, 'r2-send', 30_000)

    // 等 faux toolCall 的 todo 调用完成（W21 entry 化协议，事件形态见 waitForToolCallEnd）
    const todoToolEnd = await waitForToolCallEnd(events, /todo/i)
    listenWs.close()

    if (!todoToolEnd) {
      writeToolCallDiag('/tmp/r2-diag.json', 'R2', events, readRuntimeLogs(dataDir).slice(-3000))
    }
    expect(todoToolEnd, 'faux toolCall todo → tool_call_end 应确定性到达').toBeDefined()

    // ── 协议契约断言 1：tool result details —— todos 原始数组是 TasksPanel 渲染主数据源 ──
    const todos = assertTodoDetails(toolResultDetails(todoToolEnd))
    // ── 协议契约断言 2+3：GuiComponent tab-bar 双段 + meta icon/badge（托盘数据源）──
    const widgetPayload = assertTodoTabBarContract(events)
    assertTodoMetaContract(widgetPayload, todos)
    console.log(`[R2] todo tool 协议契约验证通过：todos=${todos.length} 项，gui type=tab-bar，badge=${widgetPayload.meta?.badge}`)

    // ── UI 断言：托盘 widget 区挂载（消费端迁移后的渲染终点，见测试头注）──
    await assertTodoTrayUi(page, String(widgetPayload.meta?.badge), todos.length)
    console.log('[R2] 托盘挂载链路验证通过：icon/badge/面板 tab-bar 双段渲染')
  } finally {
    await cleanupRealApp(cleanup, dataDir)
  }
})

// ── R3: goal_control 调用 → 验证 goal 协议格式（__gui__ group 内嵌 card） ──

test('R3: goal_control create → 协议格式含 __gui__ group', async () => {
  test.setTimeout(120_000)
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'taiji-real-tasks-'))
  const { page, cleanup } = await launchRealApp({ dataDir, faux: { responses: R3_FAUX_SCRIPT } })
  try {
    await expect(page).toHaveTitle(/太极/)
    const port = await waitForRuntime(dataDir, 30_000)
    const sessionId = await createAndActivateSession(port)

    const { ws: listenWs, events } = await openListenWs(port, sessionId)

    await wsRoundTrip(port, {
      type: 'message.send',
      id: 'r3-send',
      payload: { sessionId, content: '请用 goal_control tool 创建一个 goal：追踪「优化登录性能」，slug 用 optimize-login-perf。' },
    }, 'r3-send', 30_000)

    const goalToolEnd = await waitForToolCallEnd(events, /goal/i)
    listenWs.close()

    if (!goalToolEnd) {
      writeToolCallDiag('/tmp/r3-diag.json', 'R3', events, readRuntimeLogs(dataDir).slice(-3000))
    }
    expect(goalToolEnd, 'faux toolCall goal_control → tool_call_end 应确定性到达').toBeDefined()

    // ── 协议契约断言：goal_control 的 tool result details + GuiComponent 推送 ──
    // entry 化协议（W21）：details 在 entry.message.details；__gui__ 的现行载体是
    // extension:widgetGui 广播（同 R2 注释——goal extension handle* 内 updateWidget 推送）
    const details = toolResultDetails(goalToolEnd)
    const widgetGui = events.find((e) => e.type === 'extension:widgetGui')
    expect(widgetGui, 'goal_control 调用应触发 extension:widgetGui 广播').toBeDefined()
    const guiRaw = (widgetGui!.payload as WidgetGuiPayload | undefined)?.gui
    const gui = guiContentRoot(guiRaw)
    // goal create 的 GuiComponent 顶层形态（projection/gui.ts:132 guiResult(guiComponent
    // ("group", {children}))——group 内嵌 card 等；旧断言 ['card','stats-line'] 是
    // widget 推送分离前的顶层形态假设）
    expect(guiComponentType(gui)).toBe('group')

    // goal slug 契约（GoalCard.displaySlug 来源）。缺失 = 协议回归，必须 fail：
    // goal_control create 契约确定性回显 slug（goal-control-adapter 返回 { action, goalId, status, slug }），
    // details.slug 为空说明 tool result details 透传链断裂，不得以日志放行
    const slug = details.slug
    expect(slug, 'goal_control tool result 的 details.slug 缺失 = 协议回归（create 契约确定性回显 slug，details 透传断裂）').toBeDefined()
    console.log(`[R3] goal_control 协议契约验证通过，slug=${slug}, gui.type=${guiComponentType(gui)}`)
  } finally {
    await cleanupRealApp(cleanup, dataDir)
  }
})
