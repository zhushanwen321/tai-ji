/**
 * scheduler-manager 插件行为面单测。
 *
 * 构建者白盒 + 使用者黑盒：经 plugin-sdk createMockAgentAPI mock 驱动 activate()
 * 与注册的 command handlers，覆盖八块：
 * ① handleWrite 回执分支矩阵（accepted/busy/compacting/bash/command-missing/其余
 *    + 无效 id + TASK_NOT_FOUND 自愈）
 * ② doRefresh 的 E11 游标失效全量重拉与 E4 恢复两态（terminal vs recovering）
 * ③ 重试预算耗尽态稳定（不重试不清零，外部信号重置预算）
 * ④ handleOpen modal 开合链（showModal 调参 + 不等防抖首拉的首帧推树 + 无焦点
 *    会话分支 + E10 pending 对话框拒绝）
 * ⑤ 生命周期拆镜（onModalClosed 清 notice / onDidDestroySession → teardownMirror
 *    后失效信号冻结）
 * ⑥ 恢复窗口写路径两支用户文案（写成功提示 restore 副作用 / 写抛错提示手动打开）
 * ⑦ onDidActivateSession 焦点切换（focusSessionId → open 链指向新会话 +
 *    ensureMirror 为新 sid 补挂）
 * ⑧ 展示层三态分支（已过期「即将触发」两态文案 / 上次成败标记 + 失败原因行 /
 *    成功标记且无原因行——经 handleOpen 推树断言）
 *
 * 隔离：被测模块持有模块级状态（mirrors Map / focusSessionId），每条用例
 * vi.resetModules() 后动态 import 取 fresh 模块。timer 面（防抖 200ms / 重试 2s）
 * 全部走 fake timers。
 *
 * 相对路径 import 的理由见 vitest.config.ts 头注（resources/plugins 不在 workspace，
 * 裸包名解析不到；type-only import 运行时被剥离，.js 后缀仅 typecheck 期解析）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockAgentAPI } from '../../../../packages/plugin-sdk/src/index.ts'
import type {
  PluginModalClosedReason,
  PluginSessionEntries,
  SessionInfo,
} from '../../../../packages/plugin-sdk/src/index.ts'
import type { PluginContext } from '../../../../packages/runtime/src/services/plugin-service/plugin-types.js'
import type { GuiComponent, ScheduledTask, TreeItem } from '../../../../packages/extension-protocol/src/index.ts'

/** sendMessage 回执 reason 词表（与 SDK sendMessage 签名的闭集同源） */
type SendReceipt = {
  accepted: boolean
  reason?: 'busy' | 'compacting' | 'bash' | 'command-missing' | 'hook-blocked' | 'error'
}

type PluginModule = typeof import('../index.ts')

// ── 常量（与 index.ts 内部实现值同步；断言依赖）─────────────────────────────

const TASK_ENTRY_TYPE = 'pi-scheduler:task'
const READ_DEBOUNCE_MS = 200
const READ_RETRY_MS = 2_000
const READ_RETRY_MAX = 5
const SESSION_FILE = '/sessions/s-1.jsonl'

// ── fixture 构造 ─────────────────────────────────────────────────

function makeSession(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id: 's-1',
    label: 'test-session',
    cwd: '/w',
    status: 'idle',
    createdAt: 1,
    lastActiveAt: 100,
    ...overrides,
  }
}

/**
 * upsert custom entry（event sourcing 起点）——过 isSchedulerEntryOp 守卫的最小形状。
 * taskOverride 覆写快照字段（展示层三态等场景：过期 nextRunAt / lastStatus + lastError），
 * 默认空对象 = 原最小形状，既有用例零影响。
 */
function upsertEntry(
  taskId: string,
  enabled: boolean,
  entryId: string,
  ownerFile: string = SESSION_FILE,
  taskOverride: Partial<Omit<ScheduledTask, 'ownerSessionFile' | 'pending'>> = {},
): PluginSessionEntries['entries'][number] {
  const snapshot: Omit<ScheduledTask, 'ownerSessionFile' | 'pending'> = {
    id: taskId,
    name: `task-${taskId}`,
    prompt: 'do it',
    kind: 'recurring',
    schedule: { mode: 'interval', intervalMs: 60_000 },
    enabled,
    createdAt: 1,
    nextRunAt: Date.now() + 3_600_000,
    runCount: 0,
    history: [],
    ...taskOverride,
  }
  return {
    id: entryId,
    timestamp: '1970-01-01T00:00:00.000Z',
    type: 'custom',
    customType: TASK_ENTRY_TYPE,
    data: { op: 'upsert', taskId, ownerSessionFile: ownerFile, task: snapshot },
  }
}

/** ansi-text 节点判别（GuiComponent 是泛型接口非 union，narrow 用显式 guard） */
function isAnsiNode(node: GuiComponent): node is GuiComponent & { props: { lines: string[] } } {
  return node.type === 'ansi-text'
}

interface Harness {
  mod: PluginModule
  api: ReturnType<typeof createMockAgentAPI>
  /** activate() 注册的 command handlers（id → handler） */
  handlers: Map<string, (args?: unknown) => unknown>
  /** onEntriesInvalidated 捕获的失效回调（外部信号注入口） */
  invalidate: (sessionId: string) => void
  /** readEntries 调用记录 */
  readCalls: Array<{ sessionId: string; opts: { customType: string; sinceEntryId?: string } }>
  /** sendMessage 调用记录 */
  sendCalls: Array<{
    sessionId: string
    role: string
    content: string
    requireCommand?: string
  }>
  /** showModal 调用记录（modalId + opts） */
  showModalCalls: Array<[string, { sessionId: string }]>
  /** notify.warning 调用记录（用户可见提示断言入口） */
  notifyWarnings: string[]
  /** onModalClosed 捕获的回调（modal 关闭信号注入口） */
  closeModal: (modalId: string, reason?: PluginModalClosedReason) => void
  /** onDidDestroySession 捕获的回调（会话销毁信号注入口） */
  destroySession: (session: SessionInfo) => void
  /** onDidActivateSession 捕获的回调（会话激活/焦点切换信号注入口） */
  activateSession: (session: SessionInfo) => void
  /** views.update 收到的最新树（modal 内容断言入口） */
  lastTree: () => GuiComponent[]
}

/**
 * 装配被测插件：fresh 模块 + mock API + activate()。
 * readScript 是 readEntries 的顺序脚本（逐条消费，耗尽后返回空 envelope）。
 */
async function setup(opts: {
  readScript?: Array<PluginSessionEntries | Error>
  session?: SessionInfo
  /** 冷启动 list() 返回面（空数组 → 无焦点会话分支） */
  sessions?: SessionInfo[]
  sendMessageReceipt?: SendReceipt
  sendMessageError?: Error
  showModalError?: Error
  /** 失效订阅 dispose 抛错（teardown 防御分支：释放失败不阻断其余清理） */
  invalidateDisposeError?: Error
}): Promise<Harness> {
  vi.resetModules()
  const mod = await import('../index.ts')
  const api = createMockAgentAPI()

  const readCalls: Harness['readCalls'] = []
  const script = [...(opts.readScript ?? [{ entries: [] }])]
  api.sessions.readEntries = vi.fn(
    async (
      sessionId: string,
      readOpts: { customType: string; sinceEntryId?: string },
    ): Promise<PluginSessionEntries> => {
      readCalls.push({ sessionId, opts: readOpts })
      const next = script.shift()
      if (next instanceof Error) throw next
      return next ?? { entries: [] }
    },
  )

  const sendCalls: Harness['sendCalls'] = []
  api.sessions.sendMessage = vi.fn(
    async (params: {
      sessionId: string
      role: 'user' | 'system'
      content: string
      requireCommand?: string
    }): Promise<SendReceipt> => {
      sendCalls.push(params)
      if (opts.sendMessageError) throw opts.sendMessageError
      return opts.sendMessageReceipt ?? { accepted: true }
    },
  )

  api.sessions.list = vi.fn(async () => opts.sessions ?? [opts.session ?? makeSession()])
  // get 面向 E4 两态断言开放覆写（default = idle，可恢复路径之外不触发终态分支）
  api.sessions.get = vi.fn(async () => opts.session ?? makeSession())
  // getCommands 返回空 → E13 判定 disabled: true（按钮灰置不是本组用例焦点，固定即可）
  api.sessions.getCommands = vi.fn(async () => [])

  const handlers = new Map<string, (args?: unknown) => unknown>()
  api.commands.register = vi.fn(
    async (
      cmd: { id: string },
      handler: (args?: unknown) => unknown | Promise<unknown>,
    ): Promise<{ dispose: () => void }> => {
      handlers.set(cmd.id, handler)
      return { dispose: () => {} }
    },
  )

  const trees: GuiComponent[][] = []
  api.views.update = vi.fn(
    async (_viewId: string, tree: GuiComponent[], _opts: { sessionId: string }): Promise<void> => {
      trees.push(tree)
    },
  )
  api.ui.updateHeaderAction = vi.fn(async () => ({ updated: true }))

  let invalidateHandler: ((sessionId: string, customType: string) => void) | null = null
  api.sessions.onEntriesInvalidated = vi.fn(
    (
      _sessionId: string,
      _customType: string,
      handler: (sessionId: string, customType: string) => void,
    ): { dispose: () => void } => {
      invalidateHandler = handler
      return {
        dispose: () => {
          if (opts.invalidateDisposeError) throw opts.invalidateDisposeError
        },
      }
    },
  )

  const showModalCalls: Harness['showModalCalls'] = []
  api.ui.showModal = vi.fn(
    async (
      modalId: string,
      modalOpts: { sessionId: string },
    ): Promise<{ opened: true; epoch: number }> => {
      showModalCalls.push([modalId, modalOpts])
      if (opts.showModalError) throw opts.showModalError
      return { opened: true, epoch: 1 }
    },
  )

  const notifyWarnings: Harness['notifyWarnings'] = []
  api.notify.warning = vi.fn(async (message: string): Promise<void> => {
    notifyWarnings.push(message)
  })

  let modalClosedHandler:
    | ((event: { modalId: string; reason: PluginModalClosedReason }) => void)
    | null = null
  api.ui.onModalClosed = vi.fn(
    (
      handler: (event: { modalId: string; reason: PluginModalClosedReason }) => void,
    ): { dispose: () => void } => {
      modalClosedHandler = handler
      return { dispose: () => {} }
    },
  )

  let destroyHandler: ((session: SessionInfo) => void) | null = null
  api.sessions.onDidDestroySession = vi.fn(
    (handler: (session: SessionInfo) => void): { dispose: () => void } => {
      destroyHandler = handler
      return { dispose: () => {} }
    },
  )

  let activateHandler: ((session: SessionInfo) => void) | null = null
  api.sessions.onDidActivateSession = vi.fn(
    (handler: (session: SessionInfo) => void): { dispose: () => void } => {
      activateHandler = handler
      return { dispose: () => {} }
    },
  )

  const context = { api, subscriptions: [] } as unknown as PluginContext
  await mod.activate(context)

  return {
    mod,
    api,
    handlers,
    invalidate: (sessionId: string) => invalidateHandler?.(sessionId, TASK_ENTRY_TYPE),
    readCalls,
    sendCalls,
    showModalCalls,
    notifyWarnings,
    closeModal: (modalId: string, reason: PluginModalClosedReason = 'dismissed') =>
      modalClosedHandler?.({ modalId, reason }),
    destroySession: (session: SessionInfo) => destroyHandler?.(session),
    activateSession: (session: SessionInfo) => activateHandler?.(session),
    lastTree: () => trees[trees.length - 1] ?? [],
  }
}

/** 收集一棵树里全部 ansi-text 行文案（notice/空态提示/失败态提示都在这） */
function ansiLines(tree: GuiComponent[]): string[] {
  const out: string[] = []
  for (const node of tree) {
    if (isAnsiNode(node)) out.push(...node.props.lines)
  }
  return out
}

/** list-tree 节点判别（与 isAnsiNode 同形态：泛型接口 narrow 用显式 guard） */
function isListNode(node: GuiComponent): node is GuiComponent & { props: { items: TreeItem[] } } {
  return node.type === 'list-tree'
}

/** 收集一棵树里全部 list-tree 行文案（任务行展示断言入口） */
function treeLabels(tree: GuiComponent[]): string[] {
  const out: string[] = []
  for (const node of tree) {
    if (isListNode(node)) out.push(...node.props.items.map((item) => item.label))
  }
  return out
}

/** 最后一次 updateHeaderAction 调用参数 */
function lastHeaderAction(api: ReturnType<typeof createMockAgentAPI>): {
  sessionId: string
  badge?: string
  disabled?: boolean
} {
  const calls = vi.mocked(api.ui.updateHeaderAction).mock.calls
  return calls[calls.length - 1]?.[1] ?? { sessionId: '' }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

// ── 激活链 + 首拉（其余用例的前置语义，独立断言）────────────────────────────

describe('activate: 冷启动兜底 + 首拉折叠 + 徽标', () => {
  it('list() 兜底焦点会话，防抖后全量首拉，徽标 = 启用任务数', async () => {
    const h = await setup({
      readScript: [
        {
          sessionFile: SESSION_FILE,
          entries: [upsertEntry('aaaabbbb', true, 'e1'), upsertEntry('ccccdddd', false, 'e2')],
          leafEntryId: 'e2',
        },
      ],
    })

    // 防抖窗口内未拉取
    expect(h.readCalls).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(READ_DEBOUNCE_MS)

    expect(h.readCalls).toEqual([
      { sessionId: 's-1', opts: { customType: TASK_ENTRY_TYPE } },
    ])
    // 徽标只数 enabled
    expect(lastHeaderAction(h.api).badge).toBe('1')
    // 树含统计行与两个任务的操作条（每任务 list-tree + action-bar 一对）
    const tree = h.lastTree()
    expect(tree.find((n) => n.type === 'stats-line')).toBeDefined()
    expect(tree.filter((n) => n.type === 'action-bar')).toHaveLength(2)
  })

  it('增量拉取：游标后 append，不动累计前缀', async () => {
    const h = await setup({
      readScript: [
        { sessionFile: SESSION_FILE, entries: [upsertEntry('aaaabbbb', true, 'e1')], leafEntryId: 'e1' },
        {
          sessionFile: SESSION_FILE,
          entries: [upsertEntry('ccccdddd', false, 'e2')],
          leafEntryId: 'e2',
        },
      ],
    })
    await vi.advanceTimersByTimeAsync(READ_DEBOUNCE_MS)

    h.invalidate('s-1')
    await vi.advanceTimersByTimeAsync(READ_DEBOUNCE_MS)

    // 第二次带 sinceEntryId 游标，累计 entries 两任务同屏
    expect(h.readCalls[1]?.opts.sinceEntryId).toBe('e1')
    expect(lastHeaderAction(h.api).badge).toBe('1')
    expect(h.lastTree().filter((n) => n.type === 'action-bar')).toHaveLength(2)
  })
})

// ── ① handleWrite 回执分支矩阵（guidance MF-1-7 第 1 块）────────────────────

describe('handleWrite: 回执分支矩阵', () => {
  const TASK = 'aaaabbbb'

  async function writeSetup(receipt: SendReceipt): Promise<Harness> {
    return setup({
      readScript: [
        {
          sessionFile: SESSION_FILE,
          entries: [upsertEntry(TASK, true, 'e1')],
          leafEntryId: 'e1',
        },
      ],
      sendMessageReceipt: receipt,
    })
  }

  it.each([
    ['busy', '会话正在忙，操作未生效（可手敲 /schedule off aaaabbbb）'],
    ['compacting', '会话正在忙，操作未生效（可手敲 /schedule off aaaabbbb）'],
    ['bash', '会话正在忙，操作未生效（可手敲 /schedule off aaaabbbb）'],
  ] as const)('reason=%s → 忙碌文案 + 命令已发出', async (reason, expected) => {
    const h = await writeSetup({ accepted: false, reason })
    await vi.advanceTimersByTimeAsync(READ_DEBOUNCE_MS)

    await h.handlers.get('scheduler-manager.toggle')?.({ id: TASK, enabled: false })

    // 白名单子命令 + requireCommand 原子校验双断言
    expect(h.sendCalls).toEqual([
      {
        sessionId: 's-1',
        role: 'user',
        content: `/schedule off ${TASK}`,
        requireCommand: 'schedule',
      },
    ])
    expect(ansiLines(h.lastTree())).toContain(expected)
  })

  it('reason=command-missing → 扩展检查指引文案', async () => {
    const h = await writeSetup({ accepted: false, reason: 'command-missing' })
    await vi.advanceTimersByTimeAsync(READ_DEBOUNCE_MS)

    await h.handlers.get('scheduler-manager.toggle')?.({ id: TASK, enabled: false })

    expect(ansiLines(h.lastTree())).toContain(
      '命令不可用，操作未生效 —— 若持续失败，请到 设置 → 扩展检查 该会话的 scheduler 扩展',
    )
  })

  it('reason=其余（hook-blocked）→ 通用重试文案', async () => {
    const h = await writeSetup({ accepted: false, reason: 'hook-blocked' })
    await vi.advanceTimersByTimeAsync(READ_DEBOUNCE_MS)

    await h.handlers.get('scheduler-manager.toggle')?.({ id: TASK, enabled: false })

    expect(ansiLines(h.lastTree())).toContain('操作未生效，请重试')
  })

  it('accepted=true → 清除 notice（树无 ansi-text）', async () => {
    const h = await writeSetup({ accepted: true })
    await vi.advanceTimersByTimeAsync(READ_DEBOUNCE_MS)

    await h.handlers.get('scheduler-manager.run')?.({ id: TASK })

    expect(h.sendCalls).toHaveLength(1)
    expect(ansiLines(h.lastTree())).toEqual([])
  })

  it('sendMessage 抛错 → 错误提示携带手敲恢复动作', async () => {
    const h = await setup({
      readScript: [
        { sessionFile: SESSION_FILE, entries: [upsertEntry(TASK, true, 'e1')], leafEntryId: 'e1' },
      ],
      sendMessageError: new Error('channel closed'),
    })
    await vi.advanceTimersByTimeAsync(READ_DEBOUNCE_MS)

    await h.handlers.get('scheduler-manager.delete')?.({ id: TASK })

    expect(ansiLines(h.lastTree())).toEqual([
      `操作未生效：channel closed（可手敲 /schedule rm ${TASK} 重试）`,
    ])
  })

  it('无效 id → 不发命令 + 无效标识提示', async () => {
    const h = await writeSetup({ accepted: true })
    await vi.advanceTimersByTimeAsync(READ_DEBOUNCE_MS)

    await h.handlers.get('scheduler-manager.toggle')?.({ id: 'not-hex!' })

    expect(h.sendCalls).toHaveLength(0)
    expect(ansiLines(h.lastTree())[0]).toContain('无效的任务标识')
  })

  it('TASK_NOT_FOUND：快照无该 id → 不发命令 + 刷新自愈', async () => {
    const h = await setup({
      readScript: [
        { sessionFile: SESSION_FILE, entries: [upsertEntry(TASK, true, 'e1')], leafEntryId: 'e1' },
        { sessionFile: SESSION_FILE, entries: [], leafEntryId: 'e1' },
      ],
      sendMessageReceipt: { accepted: true },
    })
    await vi.advanceTimersByTimeAsync(READ_DEBOUNCE_MS)

    await h.handlers.get('scheduler-manager.run')?.({ id: 'deadbeef' })

    expect(h.sendCalls).toHaveLength(0)
    expect(ansiLines(h.lastTree())).toContain('任务已不存在，列表已刷新')
    // 自愈：防抖重拉已武装，推进后 readEntries 第二次（带游标增量）
    await vi.advanceTimersByTimeAsync(READ_DEBOUNCE_MS)
    expect(h.readCalls).toHaveLength(2)
    expect(h.readCalls[1]?.opts.sinceEntryId).toBe('e1')
  })
})

// ── ② E11 游标失效 + E4 恢复两态（guidance MF-1-7 第 2 块）───────────────────

describe('doRefresh: E11 游标失效全量重拉', () => {
  it('增量抛 Entry not found → 清累计清游标 → 无 sinceEntryId 全量重拉', async () => {
    const h = await setup({
      readScript: [
        { sessionFile: SESSION_FILE, entries: [upsertEntry('aaaabbbb', true, 'e1')], leafEntryId: 'e1' },
        new Error('Entry not found: e1'),
        {
          sessionFile: SESSION_FILE,
          entries: [upsertEntry('aaaabbbb', true, 'e1'), upsertEntry('ccccdddd', true, 'e2')],
          leafEntryId: 'e2',
        },
      ],
    })
    await vi.advanceTimersByTimeAsync(READ_DEBOUNCE_MS)
    expect(h.readCalls).toHaveLength(1)

    h.invalidate('s-1')
    await vi.advanceTimersByTimeAsync(READ_DEBOUNCE_MS)

    // 第二次带游标 → E11；第三次无游标全量（自愈对用户无感、对排查出声）
    expect(h.readCalls[1]?.opts.sinceEntryId).toBe('e1')
    expect(h.readCalls).toHaveLength(3)
    expect(h.readCalls[2]?.opts).toEqual({ customType: TASK_ENTRY_TYPE })
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('cursor invalidated, full re-pull'),
    )
    // 折叠结果 = 全量重拉后的 2 任务
    expect(lastHeaderAction(h.api).badge).toBe('2')
  })
})

describe('doRefresh: E4 读失败两态', () => {
  it('会话 dead → terminal「会话不可用」，不武装重试', async () => {
    const h = await setup({ readScript: [new Error('pi exited')] })
    vi.mocked(h.api.sessions.get).mockResolvedValue(makeSession({ status: 'dead' }))
    await vi.advanceTimersByTimeAsync(READ_DEBOUNCE_MS)

    expect(ansiLines(h.lastTree())).toEqual([
      '会话不可用：pi exited —— 请从侧栏重新打开该会话',
    ])
    // terminal 不自动重试：推进远超重试窗口仍只有初始一次读
    await vi.advanceTimersByTimeAsync(READ_RETRY_MS * (READ_RETRY_MAX + 2))
    expect(h.readCalls).toHaveLength(1)
  })

  it('会话 active → 「正在恢复」+ 自动重试，恢复成功后列表/徽标回归', async () => {
    const h = await setup({
      readScript: [
        new Error('SESSION_NOT_ACTIVE: no live pi'),
        {
          sessionFile: SESSION_FILE,
          entries: [upsertEntry('aaaabbbb', true, 'e1')],
          leafEntryId: 'e1',
        },
      ],
    })
    vi.mocked(h.api.sessions.get).mockResolvedValue(makeSession({ status: 'active' }))
    await vi.advanceTimersByTimeAsync(READ_DEBOUNCE_MS)

    expect(ansiLines(h.lastTree())).toEqual(['会话正在恢复，请稍候…'])

    // 恢复窗口重试（2s 间隔）→ 第 2 次读成功 → 失败态清除 + 徽标回归
    await vi.advanceTimersByTimeAsync(READ_RETRY_MS)
    expect(h.readCalls).toHaveLength(2)
    expect(ansiLines(h.lastTree())).toEqual([])
    expect(lastHeaderAction(h.api).badge).toBe('1')
  })
})

// ── ③ 重试预算耗尽态稳定（guidance MF-1-7 第 3 块）──────────────────────────

describe('scheduleRetry: 预算耗尽态稳定', () => {
  it('恒败 + 可恢复会话 → 恰好 READ_RETRY_MAX 次重试后停，文案升级「恢复超时」', async () => {
    const h = await setup({
      readScript: Array.from({ length: 20 }, () => new Error('still down')),
    })
    vi.mocked(h.api.sessions.get).mockResolvedValue(makeSession({ status: 'active' }))
    await vi.advanceTimersByTimeAsync(READ_DEBOUNCE_MS)

    // 初始 1 次 + 5 次重试 = 6 次；预算内保持「正在恢复」
    await vi.advanceTimersByTimeAsync(READ_RETRY_MS * 2)
    expect(ansiLines(h.lastTree())).toEqual(['会话正在恢复，请稍候…'])

    await vi.advanceTimersByTimeAsync(READ_RETRY_MS * (READ_RETRY_MAX - 2))
    expect(h.readCalls).toHaveLength(1 + READ_RETRY_MAX)
    // 耗尽：提示升级为恢复超时（含恢复动作）
    expect(ansiLines(h.lastTree())).toEqual(['会话恢复超时，请从侧栏重新打开该会话'])

    // 耗尽态稳定：不重试（调用数冻结）不清零（长时间推进无第 7 次读）
    await vi.advanceTimersByTimeAsync(READ_RETRY_MS * 30)
    expect(h.readCalls).toHaveLength(1 + READ_RETRY_MAX)
  })

  it('外部失效信号重置预算 → 耗尽后可获新一轮重试', async () => {
    const h = await setup({
      readScript: Array.from({ length: 20 }, () => new Error('down')),
    })
    vi.mocked(h.api.sessions.get).mockResolvedValue(makeSession({ status: 'active' }))
    await vi.advanceTimersByTimeAsync(READ_DEBOUNCE_MS)
    await vi.advanceTimersByTimeAsync(READ_RETRY_MS * READ_RETRY_MAX)
    expect(h.readCalls).toHaveLength(1 + READ_RETRY_MAX)

    // 外部信号（会话侧新证据）→ scheduleRefresh 重置预算 + 防抖重拉
    h.invalidate('s-1')
    await vi.advanceTimersByTimeAsync(READ_DEBOUNCE_MS)
    expect(h.readCalls).toHaveLength(1 + READ_RETRY_MAX + 1)
    // 新一轮预算在身：再推进重试窗口，读次数继续增长
    await vi.advanceTimersByTimeAsync(READ_RETRY_MS)
    expect(h.readCalls).toHaveLength(1 + READ_RETRY_MAX + 2)
  })
})

// ── ④ handleOpen modal 开合链（MF-2-7 补齐）──────────────────────────────────

describe('handleOpen: modal 开合链', () => {
  it('无焦点会话 → notify.warning 提示，不开 modal', async () => {
    const h = await setup({ sessions: [] })

    await h.handlers.get('scheduler-manager.open')?.()

    expect(h.notifyWarnings).toEqual(['定时任务：当前没有可打开的会话'])
    expect(h.showModalCalls).toEqual([])
  })

  it('有焦点会话 → showModal(MODAL_ID + sessionId)，不等防抖首拉立即推首帧树', async () => {
    const h = await setup({})

    await h.handlers.get('scheduler-manager.open')?.()

    expect(h.showModalCalls).toEqual([['scheduler-manager.panel', { sessionId: 's-1' }]])
    // 首帧不依赖防抖首拉（readCalls 仍 0），树已推到本 modal 视图（空态提示而非空白）
    expect(h.readCalls).toHaveLength(0)
    const lastCall = vi.mocked(h.api.views.update).mock.calls.at(-1)
    expect(lastCall?.[0]).toBe('modal-scheduler-manager-scheduler-manager.panel')
    expect(lastCall?.[2]).toEqual({ sessionId: 's-1' })
    expect(ansiLines(lastCall?.[1] ?? [])).toContain(
      '本会话还没有定时任务 —— 在对话里说，或手敲 /schedule <排期> <内容> 创建。',
    )
  })

  it('showModal 被 pending 对话框拒绝（E10）→ notify.warning 含「请先回应宿主弹窗」且不推树', async () => {
    const h = await setup({ showModalError: new Error('MODAL_BLOCKED_BY_UI_REQUEST') })

    await h.handlers.get('scheduler-manager.open')?.()

    expect(h.notifyWarnings).toEqual([
      '定时任务面板暂时无法打开：MODAL_BLOCKED_BY_UI_REQUEST（请先回应宿主弹窗后重试）',
    ])
    expect(vi.mocked(h.api.views.update)).not.toHaveBeenCalled()
  })
})

// ── ⑤ 生命周期：onModalClosed 清 notice / onDidDestroySession 拆镜（MF-2-7）───

describe('onModalClosed / onDidDestroySession: 生命周期', () => {
  const TASK = 'aaaabbbb'
  const BUSY_LINE = '会话正在忙，操作未生效（可手敲 /schedule off aaaabbbb）'

  it('本 modal 关闭清 notice；别的 modal 关闭不清', async () => {
    const h = await setup({
      readScript: [
        { sessionFile: SESSION_FILE, entries: [upsertEntry(TASK, true, 'e1')], leafEntryId: 'e1' },
        { sessionFile: SESSION_FILE, entries: [], leafEntryId: 'e1' },
      ],
      sendMessageReceipt: { accepted: false, reason: 'busy' },
    })
    await vi.advanceTimersByTimeAsync(READ_DEBOUNCE_MS)

    // 制造行内 notice（忙碌文案）
    await h.handlers.get('scheduler-manager.toggle')?.({ id: TASK, enabled: false })
    expect(ansiLines(h.lastTree())).toContain(BUSY_LINE)

    // 别的 modal 关闭：notice 保留（下一轮失效刷新后仍可见）
    h.closeModal('other-plugin.modal')
    h.invalidate('s-1')
    await vi.advanceTimersByTimeAsync(READ_DEBOUNCE_MS)
    expect(ansiLines(h.lastTree())).toContain(BUSY_LINE)

    // 本 modal 关闭：notice 清除（重开首帧干净，树中无 ansi 行）
    h.closeModal('scheduler-manager.panel')
    h.invalidate('s-1')
    await vi.advanceTimersByTimeAsync(READ_DEBOUNCE_MS)
    expect(ansiLines(h.lastTree())).toEqual([])
  })

  it('会话销毁 → 拆订阅清镜像；其后失效信号不再触发拉取', async () => {
    const h = await setup({
      readScript: [
        { sessionFile: SESSION_FILE, entries: [upsertEntry(TASK, true, 'e1')], leafEntryId: 'e1' },
      ],
    })
    await vi.advanceTimersByTimeAsync(READ_DEBOUNCE_MS)
    expect(h.readCalls).toHaveLength(1)

    h.destroySession(makeSession())
    h.invalidate('s-1')
    await vi.advanceTimersByTimeAsync(READ_DEBOUNCE_MS + READ_RETRY_MS * (READ_RETRY_MAX + 2))
    // 镜像已删：防抖不武装，长时间推进读次数冻结
    expect(h.readCalls).toHaveLength(1)
  })

  it('dispose 抛错不阻断 teardown：出声留诊断，镜像仍删除', async () => {
    const h = await setup({
      readScript: [
        { sessionFile: SESSION_FILE, entries: [upsertEntry(TASK, true, 'e1')], leafEntryId: 'e1' },
      ],
      invalidateDisposeError: new Error('subscription table gone'),
    })
    await vi.advanceTimersByTimeAsync(READ_DEBOUNCE_MS)

    h.destroySession(makeSession())

    expect(console.warn).toHaveBeenCalledWith(
      '[scheduler-manager] dispose failed during teardown:',
      'subscription table gone',
    )
    // 清理未被 dispose 失败阻断：镜像已删，失效信号冻结
    h.invalidate('s-1')
    await vi.advanceTimersByTimeAsync(READ_DEBOUNCE_MS)
    expect(h.readCalls).toHaveLength(1)
  })
})

// ── ⑥ 恢复窗口写路径两支用户文案（MF-2-7）────────────────────────────────────

describe('handleWrite: 恢复窗口两支文案', () => {
  const TASK = 'aaaabbbb'

  /** 前置 = 首拉成功（快照留任务）→ 失效重拉抛 SESSION_NOT_ACTIVE → 恢复窗口中 */
  async function recoveringSetup(opts: {
    sendMessageReceipt?: SendReceipt
    sendMessageError?: Error
  }): Promise<Harness> {
    return setup({
      readScript: [
        { sessionFile: SESSION_FILE, entries: [upsertEntry(TASK, true, 'e1')], leafEntryId: 'e1' },
        new Error('SESSION_NOT_ACTIVE: no live pi'),
      ],
      ...opts,
    })
  }

  async function enterRecoveringWindow(h: Harness): Promise<void> {
    await vi.advanceTimersByTimeAsync(READ_DEBOUNCE_MS)
    h.invalidate('s-1')
    await vi.advanceTimersByTimeAsync(READ_DEBOUNCE_MS)
    // 前置自证：读失败进恢复态（快照保留，写路径可达）
    expect(ansiLines(h.lastTree())).toEqual(['会话正在恢复，请稍候…'])
  }

  it('恢复窗口写成功 → 显式提示 restore 副作用（到期任务照常触发）', async () => {
    const h = await recoveringSetup({ sendMessageReceipt: { accepted: true } })
    await enterRecoveringWindow(h)

    await h.handlers.get('scheduler-manager.run')?.({ id: TASK })

    // 重试窗口走出失败态后，恢复提示作为行内 notice 可见
    await vi.advanceTimersByTimeAsync(READ_RETRY_MS)
    expect(ansiLines(h.lastTree())).toContain('会话已恢复，未完成的排期任务将照常触发')
  })

  it('恢复窗口写抛错 → 提示手动打开会话的恢复动作', async () => {
    const h = await recoveringSetup({ sendMessageError: new Error('boom') })
    await enterRecoveringWindow(h)

    await h.handlers.get('scheduler-manager.run')?.({ id: TASK })

    await vi.advanceTimersByTimeAsync(READ_RETRY_MS)
    expect(ansiLines(h.lastTree())).toContain('会话恢复失败：boom —— 请从侧栏手动打开该会话后再管理')
  })
})

// ── ⑦ onDidActivateSession 焦点切换 + ensureMirror 补挂（MF-3-5）──────────────

describe('onDidActivateSession: 焦点切换 + ensureMirror 补挂', () => {
  it('激活另一会话 → 焦点切换，open 链与新会话镜像均指向新 sid', async () => {
    const SESSION_FILE_2 = '/sessions/s-2.jsonl'
    const h = await setup({
      readScript: [
        // s-1 冷启动兜底首拉（空）
        { sessionFile: SESSION_FILE, entries: [] },
        // s-2 激活补挂首拉（1 个启用任务）
        {
          sessionFile: SESSION_FILE_2,
          entries: [upsertEntry('aaaa1111', true, 'e1', SESSION_FILE_2)],
          leafEntryId: 'e1',
        },
      ],
    })

    // 前置：冷启动兜底焦点 = s-1，open 链指向 s-1
    await h.handlers.get('scheduler-manager.open')?.()
    expect(h.showModalCalls).toEqual([['scheduler-manager.panel', { sessionId: 's-1' }]])

    // 用户激活另一会话 s-2：焦点切换 + ensureMirror 为新 sid 补挂（防抖武装）
    h.activateSession(makeSession({ id: 's-2', label: 'other-session' }))
    await vi.advanceTimersByTimeAsync(READ_DEBOUNCE_MS)

    // 补挂证明：readEntries 出现 s-2 的全量首拉（新镜像游标从零起，无 sinceEntryId）
    expect(h.readCalls).toEqual([
      { sessionId: 's-1', opts: { customType: TASK_ENTRY_TYPE } },
      { sessionId: 's-2', opts: { customType: TASK_ENTRY_TYPE } },
    ])
    // 新会话树 + 徽标推到 s-2（折叠出 1 个启用任务）
    expect(lastHeaderAction(h.api)).toMatchObject({ sessionId: 's-2', badge: '1' })
    expect(h.lastTree().filter((n) => n.type === 'action-bar')).toHaveLength(1)

    // 焦点已切换：再次 open 的 showModal 与首帧树均指向 s-2
    await h.handlers.get('scheduler-manager.open')?.()
    expect(h.showModalCalls.at(-1)).toEqual(['scheduler-manager.panel', { sessionId: 's-2' }])
    const lastCall = vi.mocked(h.api.views.update).mock.calls.at(-1)
    expect(lastCall?.[0]).toBe('modal-scheduler-manager-scheduler-manager.panel')
    expect(lastCall?.[2]).toEqual({ sessionId: 's-2' })
  })
})

// ── ⑧ 展示层三态分支（MF-4-3：buildTaskRows 经 handleOpen 推树断言）───────────

describe('buildTaskRows: 展示层三态', () => {
  it('已过期 → 即将触发；失败 → 成败标记 + 独立原因行；成功 → 标记且无原因行', async () => {
    const h = await setup({
      readScript: [
        {
          sessionFile: SESSION_FILE,
          entries: [
            // ① 已过期 enabled 任务：nextRunAt 在过去 → 「即将触发」两态文案
            upsertEntry('aaaa1111', true, 'e1', SESSION_FILE, { nextRunAt: Date.now() - 60_000 }),
            // ② 失败任务：lastRunAt + lastStatus='failed' + lastError → 「· 失败」标记 + 独立原因行
            upsertEntry('bbbb2222', true, 'e2', SESSION_FILE, {
              nextRunAt: Date.now() + 2 * 86_400_000,
              runCount: 3,
              lastRunAt: Date.now() - 120_000,
              lastStatus: 'failed',
              lastError: 'boom',
            }),
            // ③ 成功任务：lastStatus='success' → 「· 成功」标记、无原因行
            upsertEntry('cccc3333', true, 'e3', SESSION_FILE, {
              nextRunAt: Date.now() + 2 * 86_400_000,
              runCount: 2,
              lastRunAt: Date.now() - 86_400_000,
              lastStatus: 'success',
            }),
          ],
          leafEntryId: 'e3',
        },
      ],
    })
    await vi.advanceTimersByTimeAsync(READ_DEBOUNCE_MS)

    await h.handlers.get('scheduler-manager.open')?.()

    // 启用按 nextRunAt 升序：过期任务最前；b/c nextRunAt 相等 → 稳定排序保持插入序。
    // 相对时间值均留单位边界裕度（防抖推进 200ms 不翻转：2m/1d/in 1d）。
    // toEqual 全量闭合断言同时证明③「成功无原因行」（boom 仅出现一次且只属失败任务）。
    expect(treeLabels(h.lastTree())).toEqual([
      'task-aaaa1111',
      'every 1m · 即将触发',
      '已执行 0 次',
      'task-bbbb2222',
      'every 1m · 下次 in 1d',
      '已执行 3 次 · 上次 2m ago · 失败',
      'boom',
      'task-cccc3333',
      'every 1m · 下次 in 1d',
      '已执行 2 次 · 上次 1d ago · 成功',
    ])
  })
})
