/**
 * window-factory render-process-gone 崩溃台账接线单测（crash-forensics-and-watchdog
 * §3.3 D1 renderer 行，实施计划 u1f）。
 *
 * 覆盖（验收：render-process-gone oom 与普通 crash reason 可区分 + 熔断事件断言）：
 * - reload 决策 → reload 行，reason 透传 Electron 枚举（'oom' 与 'crashed' 在台账可区分）
 * - 熔断决策（60s 滑窗第 4 次）→ crash/circuit-breaker 行，该次不产生 reload 行
 * - destroyed 窗口 → 无台账行（恢复链在 isDestroyed 守卫后，台账挂同守卫之后）
 * - webContents 'unresponsive' → unresponsive/renderer-unresponsive 行（D1 renderer 行
 *   第三事件）：同一次持续卡死防重复记行，responsive 恢复复位后卡死↔恢复循环各记一行
 *
 * electron mock / FakeBrowserWindow 形态复刻 test/window-factory-crash-recovery.test.ts；
 * crash-journal mock 捕获 append 调用（真实现 fs 面由 logs/__tests__/crash-journal.test.ts
 * 覆盖）。纯逻辑零 fs 写。
 * 运行：cd apps/electron/main && npx vitest run test/window-factory-crash-journal.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── electron mock（形态复刻 window-factory-crash-recovery.test.ts）────────────

interface FakeListener {
  fn: (...args: unknown[]) => void
  once: boolean
}

class FakeWebContents {
  listeners = new Map<string, FakeListener[]>()
  openDevTools = vi.fn()
  send = vi.fn()
  setWindowOpenHandler = vi.fn()

  on(event: string, fn: (...args: unknown[]) => void): void {
    this.push(event, fn, false)
  }

  once(event: string, fn: (...args: unknown[]) => void): void {
    this.push(event, fn, true)
  }

  off(event: string, fn: (...args: unknown[]) => void): void {
    const list = this.listeners.get(event) ?? []
    this.listeners.set(event, list.filter((l) => l.fn !== fn))
  }

  removeListener(event: string, fn: (...args: unknown[]) => void): void {
    this.off(event, fn)
  }

  emit(event: string, ...args: unknown[]): void {
    const list = this.listeners.get(event) ?? []
    for (const l of [...list]) {
      if (l.once) this.listeners.set(event, (this.listeners.get(event) ?? []).filter((x) => x !== l))
      l.fn(...args)
    }
  }

  private push(event: string, fn: (...args: unknown[]) => void, once: boolean): void {
    const list = this.listeners.get(event) ?? []
    list.push({ fn, once })
    this.listeners.set(event, list)
  }
}

class FakeBrowserWindow {
  static instances: FakeBrowserWindow[] = []
  webContents = new FakeWebContents()
  listeners = new Map<string, FakeListener[]>()
  loadURL = vi.fn((_url: string) => Promise.resolve())
  loadFile = vi.fn(() => Promise.resolve())
  isDestroyed = vi.fn(() => false)
  destroy = vi.fn()
  show = vi.fn()
  showInactive = vi.fn()

  constructor() {
    FakeBrowserWindow.instances.push(this)
  }

  on(event: string, fn: (...args: unknown[]) => void): void {
    const list = this.listeners.get(event) ?? []
    list.push({ fn, once: false })
    this.listeners.set(event, list)
  }

  once(event: string, fn: (...args: unknown[]) => void): void {
    const list = this.listeners.get(event) ?? []
    list.push({ fn, once: true })
    this.listeners.set(event, list)
  }

  emit(event: string, ...args: unknown[]): void {
    const list = this.listeners.get(event) ?? []
    for (const l of [...list]) {
      if (l.once) this.listeners.set(event, (this.listeners.get(event) ?? []).filter((x) => x !== l))
      l.fn(...args)
    }
  }
}

vi.mock('electron', () => ({
  app: { getAppPath: vi.fn(() => '/fake/app/root'), isPackaged: false },
  BrowserWindow: FakeBrowserWindow,
  shell: { openExternal: vi.fn(() => Promise.resolve()) },
}))

const mainLoggerStubs = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}
vi.mock('../logs/main-logger.js', () => ({ mainLogger: mainLoggerStubs }))

// 台账断言面：捕获 append 调用（接线单测只断言「写了什么行」，不触文件系统）
const crashJournalAppend = vi.hoisted(() => vi.fn())
vi.mock('../logs/crash-journal.js', () => ({
  crashJournal: { append: crashJournalAppend },
  initCrashJournal: vi.fn(),
  getCrashJournalDir: vi.fn(() => '/tmp/taiji-test/crashes'),
}))

// ── 夹具 ───────────────────────────────────────────────────────────

const FAKE_DATA_DIR = '/tmp/taiji-crash-journal-test-data'

interface FactoryModule {
  createWindow: (
    options: { windowId?: string; sessionId?: string } | undefined,
    deps: { isDev: boolean; generateId: () => string },
  ) => Promise<{ win: FakeBrowserWindow; windowId: string }>
}

/** 动态 import 拿当前模块实例（vi.resetModules 后 rendererRecovery 单例为全新状态）。 */
async function loadFactory(): Promise<FactoryModule> {
  return (await import('../window/window-factory.js')) as unknown as FactoryModule
}

async function createProdWindow(factory: FactoryModule, windowId: string): Promise<FakeBrowserWindow> {
  const { win } = await factory.createWindow({ windowId }, { isDev: false, generateId: () => 'gen' })
  return win
}

/** 驱动一次渲染进程崩溃（details 形态对齐 Electron RenderProcessGoneDetails 最小面）。 */
function crash(win: FakeBrowserWindow, reason = 'oom', exitCode = -1): void {
  win.webContents.emit('render-process-gone', {}, { reason, exitCode })
}

/** 台账 append 的全部事件行（断言辅助） */
function journalEvents(): Array<Record<string, unknown>> {
  return crashJournalAppend.mock.calls.map((c) => c[0] as Record<string, unknown>)
}

describe('render-process-gone 台账接线（crash-forensics D1 renderer 行）', () => {
  beforeEach(() => {
    vi.resetModules()
    FakeBrowserWindow.instances.length = 0
    for (const fn of Object.values(mainLoggerStubs)) fn.mockClear()
    crashJournalAppend.mockClear()
    process.env.TAIJI_AGENT_DATA_DIR = FAKE_DATA_DIR
    delete process.env.TAIJI_E2E
  })

  it('首崩 reason=oom → reload 行（renderer OOM 与普通崩溃在台账可区分，评估器 #9/#10 数据源）', async () => {
    const factory = await loadFactory()
    const win = await createProdWindow(factory, 'win-oom')
    crash(win, 'oom')
    expect(journalEvents()).toEqual([
      { layer: 'renderer', event: 'reload', reason: 'oom' },
    ])
  })

  it('首崩 reason=crashed → reload 行 reason=crashed（与 oom 行 reason 可区分）', async () => {
    const factory = await loadFactory()
    const win = await createProdWindow(factory, 'win-crashed')
    crash(win, 'crashed')
    expect(journalEvents()).toEqual([
      { layer: 'renderer', event: 'reload', reason: 'crashed' },
    ])
    expect(journalEvents()[0].reason).not.toBe('oom')
  })

  it('同窗口 60s 内第 4 次崩（熔断）→ crash/circuit-breaker 行，该次无 reload 行', async () => {
    const factory = await loadFactory()
    const win = await createProdWindow(factory, 'win-breaker')
    for (let i = 0; i < 3; i++) crash(win, 'oom')
    crash(win, 'oom') // 第 4 次：熔断转静态页
    const events = journalEvents()
    expect(events).toHaveLength(4)
    expect(events.slice(0, 3)).toEqual([
      { layer: 'renderer', event: 'reload', reason: 'oom' },
      { layer: 'renderer', event: 'reload', reason: 'oom' },
      { layer: 'renderer', event: 'reload', reason: 'oom' },
    ])
    expect(events[3]).toEqual({ layer: 'renderer', event: 'crash', reason: 'circuit-breaker' })
  })

  it('destroyed 窗口 → 无台账行（恢复链与台账同在 isDestroyed 守卫之后）', async () => {
    const factory = await loadFactory()
    const win = await createProdWindow(factory, 'win-dead')
    win.isDestroyed.mockReturnValue(true)
    crash(win)
    expect(crashJournalAppend).not.toHaveBeenCalled()
  })
})

describe('webContents unresponsive 台账接线（crash-forensics D1 renderer 行第三事件）', () => {
  beforeEach(() => {
    vi.resetModules()
    FakeBrowserWindow.instances.length = 0
    for (const fn of Object.values(mainLoggerStubs)) fn.mockClear()
    crashJournalAppend.mockClear()
    process.env.TAIJI_AGENT_DATA_DIR = FAKE_DATA_DIR
    delete process.env.TAIJI_E2E
  })

  it('unresponsive 触发 → unresponsive/renderer-unresponsive 行；同一次持续卡死重复触发不重复记行', async () => {
    const factory = await loadFactory()
    const win = await createProdWindow(factory, 'win-hang')
    win.webContents.emit('unresponsive')
    win.webContents.emit('unresponsive') // 同一次卡死期内再次触发（无 responsive 复位）
    expect(journalEvents()).toEqual([
      { layer: 'renderer', event: 'unresponsive', reason: 'renderer-unresponsive' },
    ])
  })

  it('responsive（恢复）复位标记：卡死↔恢复循环每次各记一行', async () => {
    const factory = await loadFactory()
    const win = await createProdWindow(factory, 'win-cycle')
    win.webContents.emit('unresponsive')
    win.webContents.emit('responsive')
    win.webContents.emit('unresponsive')
    expect(journalEvents()).toEqual([
      { layer: 'renderer', event: 'unresponsive', reason: 'renderer-unresponsive' },
      { layer: 'renderer', event: 'unresponsive', reason: 'renderer-unresponsive' },
    ])
  })
})
