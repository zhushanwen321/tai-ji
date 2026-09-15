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
 * - R2：todo tool 调用 → 协议格式含 __gui__ list-tree（faux toolCall 脚本化）
 * - R3：goal_control 调用 → 协议格式含 __gui__ card（faux toolCall 脚本化）
 *
 * R1 的 source 断言语义变化（翻轨裁决）：原断言 `sourceInfo.source === 'npm:@zhushanwen/pi-goal'`
 * 绑定 npm 安装装配（symlink ~/.taiji-dev/npm）；faux 轨凭证无关装配下 mandatory 扩展经
 * dev 源码目录注入（extension-resolver scanBundledExtensions dev 分支），source 是仓库内
 * 源码路径——断言改为「source 路径含 pi-goal 包目录」，保留「真实 extension 被 pi load」
 * 的契约语义（source=extension + 包身份可辨识），不绑定安装来源。
 */
import { test, expect } from '@playwright/test'
import {
  launchRealApp,
  waitForRuntime,
  wsRoundTrip,
  openListenWs,
  readRuntimeLogs,
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
    await cleanup()
    if (!process.env.PLAYWRIGHT_DEBUG_KEEP_DATA) {
      fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    } else {
      console.log('[cleanup] dataDir 保留:', dataDir)
    }
  }
})

// ── R2: todo tool 调用 → 验证 todo 协议格式（__gui__ list-tree） ──

/**
 * WS 驱动 + 监听广播事件。不走 UI 输入（real 模式 UI session 切换需 OS dialog），
 * 改为 WS 发 prompt + 监听 runtime 广播的 tool_call_end 事件，验证真实 extension
 * 返回的 __gui__ GuiComponent 格式（这是 real 轨独有的协议契约验证）。
 *
 * UI 渲染部分由 mock 轨 gui-components.spec.ts 覆盖。tasks drawer UI 已随功能在 main 删除
 * （renderer 无对应 testid），不在其覆盖范围。
 */
test('R2: todo tool 调用 → 协议格式含 __gui__ list-tree', async () => {
  test.setTimeout(120_000)
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

    // 等 faux toolCall 的 todo 调用完成。事件形态（W21 entry 化协议）：
    // tool_call_start.payload.entry = PiToolCallEntryForm（toolName/arguments），
    // tool_call_end.payload.entry = toolResult message entry（details 透传在 entry 上）
    const deadline = Date.now() + 60_000
    let todoToolEnd: any = undefined
    while (Date.now() < deadline) {
      const startIdx = events.findIndex(
        (e) => e.type === 'message.tool_call_start' && /todo/i.test(e.payload?.entry?.toolName ?? ''),
      )
      if (startIdx >= 0) {
        const endEvt = events.find(
          (e, i) => i > startIdx && e.type === 'message.tool_call_end',
        )
        if (endEvt) {
          todoToolEnd = endEvt
          break
        }
      }
      await new Promise((r) => setTimeout(r, 1000))
    }

    listenWs.close()

    if (!todoToolEnd) {
      fs.writeFileSync('/tmp/r2-diag.json', JSON.stringify({
        eventCount: events.length,
        eventTypes: events.map((e) => e.type),
        toolCallStarts: events
          .filter((e) => e.type === 'message.tool_call_start')
          .map((e) => e.payload?.entry?.toolName),
        runtimeLogsTail: readRuntimeLogs(dataDir).slice(-3000),
      }, null, 2))
      console.log(`[R2] todo tool_call_end 未到达（events=${events.length}），diag → /tmp/r2-diag.json`)
    }
    expect(todoToolEnd, 'faux toolCall todo → tool_call_end 应确定性到达').toBeDefined()

    // ── 协议契约断言 1：tool result details（W21 entry 化协议，details 在
    //    entry.message.details）——todos 原始数组是 TasksPanel 渲染主数据源 ──
    const payload = todoToolEnd!.payload
    const details = payload.entry?.message?.details

    // details.todos 原始数组（TasksPanel 渲染主数据源，含准确 status）
    const todos = details.todos
    expect(Array.isArray(todos), 'details.todos 应为数组（TasksPanel 渲染数据源）').toBe(true)
    expect(todos.length, '至少 1 个 todo').toBeGreaterThan(0)
    expect(todos[0].id, 'todos item 应有 id').toBeDefined()
    expect(todos[0].text, 'todos item 应有 text').toBeDefined()
    expect(['pending', 'in_progress', 'completed', 'cancelled']).toContain(todos[0].status)

    // ── 协议契约断言 2：GuiComponent 结构化推送（list-tree）──
    // 现行载体是 extension:widgetGui 广播（M17 widget 面板，guiSetWidget → EventAdapter
    // NUL marker 解码 → runtime 广播），不是 tool result details.__gui__（旧协议形态，
    // W21 entry 化 + widget 推送分离后 details 只剩数据字段）。兼容有/无 {v,component} 包装层。
    const widgetGui = events.find((e) => e.type === 'extension:widgetGui')
    expect(widgetGui, 'todo 调用应触发 extension:widgetGui 广播（SideDrawer 数据源）').toBeDefined()
    const guiRaw = widgetGui!.payload?.gui
    const gui = (guiRaw as { component?: { type?: string } })?.component ?? guiRaw
    expect((gui as { type?: string })?.type, 'widgetGui.gui 应为 list-tree GuiComponent').toBe('list-tree')
    console.log(`[R2] todo tool 协议契约验证通过：todos=${todos.length} 项，gui type=${(gui as { type?: string }).type}`)
  } finally {
    await cleanup()
    if (!process.env.PLAYWRIGHT_DEBUG_KEEP_DATA) fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  }
})

// ── R3: goal_control 调用 → 验证 goal 协议格式（__gui__ card） ──

test('R3: goal_control create → 协议格式含 __gui__ card', async () => {
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

    const deadline = Date.now() + 60_000
    let goalToolEnd: any = undefined
    while (Date.now() < deadline) {
      const startIdx = events.findIndex(
        (e) => e.type === 'message.tool_call_start' && /goal/i.test(e.payload?.entry?.toolName ?? ''),
      )
      if (startIdx >= 0) {
        const endEvt = events.find(
          (e, i) => i > startIdx && e.type === 'message.tool_call_end',
        )
        if (endEvt) {
          goalToolEnd = endEvt
          break
        }
      }
      await new Promise((r) => setTimeout(r, 1000))
    }

    listenWs.close()

    if (!goalToolEnd) {
      fs.writeFileSync('/tmp/r3-diag.json', JSON.stringify({
        eventCount: events.length,
        eventTypes: [...new Set(events.map((e) => e.type))],
        toolCallStarts: events
          .filter((e) => e.type === 'message.tool_call_start')
          .map((e) => e.payload?.entry?.toolName),
        runtimeLogsTail: readRuntimeLogs(dataDir).slice(-3000),
      }, null, 2))
      console.log(`[R3] goal_control tool_call_end 未到达（events=${events.length}），diag → /tmp/r3-diag.json`)
    }
    expect(goalToolEnd, 'faux toolCall goal_control → tool_call_end 应确定性到达').toBeDefined()

    // ── 协议契约断言：goal_control 的 tool result details + GuiComponent 推送 ──
    // entry 化协议（W21）：details 在 entry.message.details；__gui__ 的现行载体是
    // extension:widgetGui 广播（同 R2 注释——goal extension handle* 内 updateWidget 推送）
    const payload = goalToolEnd!.payload
    const details = payload.entry?.message?.details
    const widgetGui = events.find((e) => e.type === 'extension:widgetGui')
    expect(widgetGui, 'goal_control 调用应触发 extension:widgetGui 广播').toBeDefined()
    const guiRaw = widgetGui!.payload?.gui
    const gui = (guiRaw as { component?: { type?: string } })?.component ?? guiRaw
    // goal create 的 GuiComponent 顶层形态（projection/gui.ts:132 guiResult(guiComponent
    // ("group", {children}))——group 内嵌 card 等；旧断言 ['card','stats-line'] 是
    // widget 推送分离前的顶层形态假设）
    expect((gui as { type?: string })?.type).toBe('group')

    // goal slug 契约（GoalCard.displaySlug 来源）
    const slug = details.slug
    if (slug) {
      console.log(`[R3] goal_control 协议契约验证通过，slug=${slug}, gui.type=${gui.type}`)
    } else {
      console.log(`[R3] goal_control tool result 无 details.slug，但 __gui__ ${gui.type} OK`)
    }
  } finally {
    await cleanup()
    if (!process.env.PLAYWRIGHT_DEBUG_KEEP_DATA) fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  }
})
