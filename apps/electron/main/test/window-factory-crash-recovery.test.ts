/**
 * window-factory render-process-gone 恢复链单测（crash-resilience u3-renderer-recovery）。
 *
 * 覆盖（验收：详情落盘 + 按窗口熔断自动 reload + 超限静态错误页 + 重试重置 + 多窗口隔离）：
 * - 详情落盘：main-logger（mock）收到含 windowId/reason/exitCode/detectedAt 的结构化 meta
 * - 自动 reload：非 destroyed 窗口崩溃后按形态重载（prod loadFile / dev loadURL），
 *   URL 带恢复标志 query（recoveredFrom=crash + crashReason，T2 提示条 main 侧注入形态）
 * - 熔断：同窗口 60s 内第 4 次崩停自动 reload，改 data:text/html 静态错误页（文案 +
 *   logsDir 注入断言）；重试导航回应用源后该窗口计数重置
 * - 多窗口互不影响；destroyed 窗口只落盘不恢复；窗口 closed 清熔断计数
 *
 * electron mock 捕获 BrowserWindow 实例（logs/__tests__/renderer-log-handler.test.ts 与
 * test/privileged-handlers.test.ts 同款形态）；main-logger mock 断言结构化行（不触真实
 * 文件系统）；模块级熔断单例经 vi.resetModules + 动态 import 隔离。纯逻辑零 fs 写。
 * 运行：cd apps/electron/main && npx vitest run test/window-factory-crash-recovery.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── electron mock（外层稳定引用，跨 vi.resetModules 保持）──────────────────

interface FakeListener {
  fn: (...args: unknown[]) => void
  once: boolean
}

/** webContents 桩：捕获事件监听，测试经 emit 驱动崩溃事件。 */
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

  listenerCount(event: string): number {
    return (this.listeners.get(event) ?? []).length
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
  // loadURL/loadFile 是 BrowserWindow 方法（非 webContents），与 window-factory 调用面一致
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

const electronStubs = {
  getAppPath: vi.fn(() => '/fake/app/root'),
  openExternal: vi.fn(() => Promise.resolve()),
}

vi.mock('electron', () => ({
  app: { getAppPath: electronStubs.getAppPath, isPackaged: false },
  BrowserWindow: FakeBrowserWindow,
  shell: { openExternal: electronStubs.openExternal },
}))

// ── main-logger mock（u5a writer 的 API 面；断言结构化 meta，不触文件系统）──

const mainLoggerStubs = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}

vi.mock('../logs/main-logger.js', () => ({ mainLogger: mainLoggerStubs }))

// 台账断言面（clean-exit 早退用例）：捕获 append 调用；未 init 的真实单例 append 本就是 no-op，
// mock 形态与 window-factory-crash-journal.test.ts 同款，不改变既有用例行为
const crashJournalAppend = vi.hoisted(() => vi.fn())
vi.mock('../logs/crash-journal.js', () => ({
  crashJournal: { append: crashJournalAppend },
  initCrashJournal: vi.fn(),
  getCrashJournalDir: vi.fn(() => '/tmp/taiji-test/crashes'),
}))

// ── 夹具 ───────────────────────────────────────────────────────────

const FAKE_DATA_DIR = '/tmp/taiji-crash-test-data'
const APP_INDEX_HTML = '/fake/app/root/renderer/dist/index.html'

/** 动态 import 拿当前模块实例（vi.resetModules 后 rendererRecovery 单例为全新状态）。 */
async function loadFactory() {
  return await import('../window/window-factory.js')
}

interface FactoryModule {
  createWindow: (
    options: { windowId?: string; sessionId?: string } | undefined,
    deps: { isDev: boolean; generateId: () => string },
  ) => Promise<{ win: FakeBrowserWindow; windowId: string }>
  buildAppQuery: (windowId: string, sessionId?: string, extra?: Record<string, string>) => URLSearchParams
  buildStaticErrorPageHtml: (logsDir: string, retryUrl: string) => string
  VITE_DEV_URL: string
}

async function createProdWindow(factory: FactoryModule, windowId: string): Promise<FakeBrowserWindow> {
  const { win } = await factory.createWindow({ windowId }, { isDev: false, generateId: () => 'gen' })
  return win
}

/** 驱动一次渲染进程崩溃（details 形态对齐 Electron RenderProcessGoneDetails 最小面）。 */
function crash(win: FakeBrowserWindow, reason = 'oom', exitCode = -1): void {
  win.webContents.emit('render-process-gone', {}, { reason, exitCode })
}

/** prod 形态下的「恢复性 loadFile」调用（剔除窗口创建时的初始加载）。 */
function recoveryLoadFileCalls(win: FakeBrowserWindow): Array<{ query?: Record<string, string> }> {
  return (win.loadFile.mock.calls as unknown as Array<[string, { query?: Record<string, string> }]>)
    .filter(([, opts]) => opts?.query?.recoveredFrom !== undefined)
    .map(([, opts]) => opts)
}

/** data: 静态错误页的 loadURL 调用（decode 后的 HTML）。 */
function staticErrorPageCalls(win: FakeBrowserWindow): string[] {
  return (win.loadURL.mock.calls as Array<[string]>)
    .map(([url]) => url)
    .filter((url) => url.startsWith('data:text/html'))
    .map((url) => decodeURIComponent(url.slice('data:text/html;charset=utf-8,'.length)))
}

describe('window-factory render-process-gone：详情落盘', () => {
  beforeEach(() => {
    vi.resetModules()
    FakeBrowserWindow.instances.length = 0
    for (const fn of Object.values(mainLoggerStubs)) fn.mockClear()
    for (const fn of Object.values(electronStubs)) fn.mockClear()
    process.env.TAIJI_AGENT_DATA_DIR = FAKE_DATA_DIR
    delete process.env.TAIJI_E2E
  })

  it('main-logger.error 收到含 windowId/reason/exitCode/时间戳的结构化 meta', async () => {
    const factory = (await loadFactory()) as unknown as FactoryModule
    const win = await createProdWindow(factory, 'win-log')
    crash(win, 'oom', -1)
    expect(mainLoggerStubs.error).toHaveBeenCalledTimes(1)
    const [message, meta] = mainLoggerStubs.error.mock.calls[0] as [string, Record<string, unknown>]
    expect(message).toBe('[window] render-process-gone')
    expect(meta.windowId).toBe('win-log')
    expect(meta.reason).toBe('oom')
    expect(meta.exitCode).toBe(-1)
    expect(typeof meta.detectedAt).toBe('string')
    expect(() => new Date(meta.detectedAt as string).toISOString()).not.toThrow()
  })

  it('destroyed 窗口：详情仍落盘，但不触发任何恢复加载', async () => {
    const factory = (await loadFactory()) as unknown as FactoryModule
    const win = await createProdWindow(factory, 'win-dead')
    win.isDestroyed.mockReturnValue(true)
    crash(win)
    expect(mainLoggerStubs.error).toHaveBeenCalledTimes(1)
    // 初始加载（createWindow 时）之外不得有恢复性加载；prod 形态全程无 loadURL
    expect(recoveryLoadFileCalls(win)).toHaveLength(0)
    expect(win.loadURL).not.toHaveBeenCalled()
  })
})

describe('window-factory render-process-gone：自动 reload 与恢复标志', () => {
  beforeEach(() => {
    vi.resetModules()
    FakeBrowserWindow.instances.length = 0
    for (const fn of Object.values(mainLoggerStubs)) fn.mockClear()
    for (const fn of Object.values(electronStubs)) fn.mockClear()
    crashJournalAppend.mockClear()
    process.env.TAIJI_AGENT_DATA_DIR = FAKE_DATA_DIR
    delete process.env.TAIJI_E2E
  })

  it('prod 形态首崩：loadFile 重载构建产物，query 带恢复标志（recoveredFrom=crash + crashReason）', async () => {
    const factory = (await loadFactory()) as unknown as FactoryModule
    const win = await createProdWindow(factory, 'win-reload')
    crash(win, 'oom')
    const recovery = recoveryLoadFileCalls(win)
    expect(recovery).toHaveLength(1)
    expect(recovery[0].query).toMatchObject({
      windowId: 'win-reload',
      recoveredFrom: 'crash',
      crashReason: 'oom',
    })
    expect(win.loadURL).not.toHaveBeenCalled()
  })

  it('dev 形态首崩：loadURL 重载 Vite 源，URL query 带同一组恢复标志', async () => {
    // stub fetch：createWindow 的 dev 分支 waitForVite 会真实轮询 dev server（单测环境
    // 无 Vite，必须 stub；ok:true 立即就绪，不触 30s 超时）
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async () => ({ ok: true })) as unknown as typeof fetch
    try {
      const factory = (await loadFactory()) as unknown as FactoryModule
      const { win } = await factory.createWindow({ windowId: 'win-dev' }, { isDev: true, generateId: () => 'gen' })
      crash(win, 'killed')
      // loadURL 共 2 次：createWindow 初始加载 + 崩溃恢复重载
      expect(win.loadURL).toHaveBeenCalledTimes(2)
      const url = (win.loadURL.mock.calls[1] as [string])[0]
      expect(url.startsWith(`${factory.VITE_DEV_URL}?`)).toBe(true)
      const params = new URL(url).searchParams
      expect(params.get('windowId')).toBe('win-dev')
      expect(params.get('recoveredFrom')).toBe('crash')
      expect(params.get('crashReason')).toBe('killed')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('sessionId 透传：恢复重载保留原 session（窗口迁移语义不因崩溃丢失）', async () => {
    const factory = (await loadFactory()) as unknown as FactoryModule
    const { win } = await factory.createWindow(
      { windowId: 'win-sid', sessionId: 'sess-1' },
      { isDev: false, generateId: () => 'gen' },
    )
    crash(win)
    const recovery = recoveryLoadFileCalls(win)
    expect(recovery[0].query?.sessionId).toBe('sess-1')
  })

  it("clean-exit（正常退出路径）：不计入 RecoveryPolicy、不写台账、不触发任何恢复加载", async () => {
    const factory = (await loadFactory()) as unknown as FactoryModule
    const win = await createProdWindow(factory, 'win-clean')
    crash(win, 'clean-exit', 0)
    // 早退：无详情落盘、无台账行、无恢复性加载（prod 形态全程无 loadURL）
    expect(mainLoggerStubs.error).not.toHaveBeenCalled()
    expect(crashJournalAppend).not.toHaveBeenCalled()
    expect(recoveryLoadFileCalls(win)).toHaveLength(0)
    expect(win.loadURL).not.toHaveBeenCalled()
    // RecoveryPolicy 计数不受污染：clean-exit 后续真实连崩 3 次仍全部自动 reload（未占计数）
    for (let i = 0; i < 3; i++) crash(win)
    expect(recoveryLoadFileCalls(win)).toHaveLength(3)
    expect(staticErrorPageCalls(win)).toHaveLength(0)
  })
})

describe('window-factory render-process-gone：熔断与静态错误页', () => {
  beforeEach(() => {
    vi.resetModules()
    FakeBrowserWindow.instances.length = 0
    for (const fn of Object.values(mainLoggerStubs)) fn.mockClear()
    for (const fn of Object.values(electronStubs)) fn.mockClear()
    process.env.TAIJI_AGENT_DATA_DIR = FAKE_DATA_DIR
    delete process.env.TAIJI_E2E
  })

  it('同窗口 60s 内连崩 4 次：第 4 次不再 reload，改加载静态错误页（熔断）', async () => {
    const factory = (await loadFactory()) as unknown as FactoryModule
    const win = await createProdWindow(factory, 'win-breaker')
    for (let i = 0; i < 3; i++) crash(win)
    expect(recoveryLoadFileCalls(win)).toHaveLength(3)
    crash(win) // 第 4 次：熔断
    expect(recoveryLoadFileCalls(win)).toHaveLength(3) // 不再增加
    const pages = staticErrorPageCalls(win)
    expect(pages).toHaveLength(1)
    expect(pages[0]).toContain('界面反复崩溃，请尝试重启应用。')
    expect(pages[0]).toContain('诊断日志位于')
    expect(pages[0]).toContain(`${FAKE_DATA_DIR}/logs`)
    expect(pages[0]).toContain('重试')
    // 熔断落一条 warn（取证：静态错误页出现的原因）
    expect(mainLoggerStubs.warn).toHaveBeenCalled()
  })

  it('静态错误页「重试」导航回应用自身源后重置该窗口计数：再崩恢复自动 reload', async () => {
    const factory = (await loadFactory()) as unknown as FactoryModule
    const win = await createProdWindow(factory, 'win-retry')
    for (let i = 0; i < 4; i++) crash(win)
    expect(staticErrorPageCalls(win)).toHaveLength(1)
    // 用户点重试：页面发起导航回 file:// 构建产物（过 will-navigate 白名单的同一 URL 形态）
    win.webContents.emit('did-navigate', {}, `file://${APP_INDEX_HTML}?windowId=win-retry`)
    expect(mainLoggerStubs.info).toHaveBeenCalled()
    // 计数已重置：再崩回到自动 reload（= 前 3 次恢复 + 重置后 1 次；错误页不再新增）
    crash(win)
    expect(staticErrorPageCalls(win)).toHaveLength(1)
    expect(recoveryLoadFileCalls(win)).toHaveLength(4)
  })

  it('data: URL 的 did-navigate（错误页自身加载）不触发重置', async () => {
    const factory = (await loadFactory()) as unknown as FactoryModule
    const win = await createProdWindow(factory, 'win-data')
    for (let i = 0; i < 4; i++) crash(win)
    win.webContents.emit('did-navigate', {}, 'data:text/html;charset=utf-8,...')
    crash(win) // 计数未重置 → 仍熔断：不回到自动 reload，且再次展示错误页
    expect(recoveryLoadFileCalls(win)).toHaveLength(3)
    expect(staticErrorPageCalls(win)).toHaveLength(2)
  })

  it('多窗口互不影响：A 窗熔断后 B 窗首崩仍自动 reload', async () => {
    const factory = (await loadFactory()) as unknown as FactoryModule
    const winA = await createProdWindow(factory, 'win-a')
    const winB = await createProdWindow(factory, 'win-b')
    for (let i = 0; i < 4; i++) crash(winA)
    expect(staticErrorPageCalls(winA)).toHaveLength(1)
    crash(winB)
    expect(recoveryLoadFileCalls(winB)).toHaveLength(1)
    expect(staticErrorPageCalls(winB)).toHaveLength(0)
  })

  it('窗口 closed 清熔断计数：同 windowId 重建窗口后首崩回到自动 reload', async () => {
    const factory = (await loadFactory()) as unknown as FactoryModule
    const win = await createProdWindow(factory, 'win-closed')
    for (let i = 0; i < 4; i++) crash(win)
    expect(staticErrorPageCalls(win)).toHaveLength(1)
    win.emit('closed')
    const second = await createProdWindow(factory, 'win-closed')
    crash(second)
    expect(recoveryLoadFileCalls(second)).toHaveLength(1)
    expect(staticErrorPageCalls(second)).toHaveLength(0)
  })
})

describe('window-factory 恢复链纯函数', () => {
  beforeEach(() => {
    vi.resetModules()
    process.env.TAIJI_AGENT_DATA_DIR = FAKE_DATA_DIR
    delete process.env.TAIJI_E2E
  })

  it('buildAppQuery：windowId 必带、sessionId/extra 按需合并（初始加载与恢复共用构造）', async () => {
    const factory = (await loadFactory()) as unknown as FactoryModule
    expect(factory.buildAppQuery('w1').get('windowId')).toBe('w1')
    const withAll = factory.buildAppQuery('w1', 's1', { recoveredFrom: 'crash' })
    expect(withAll.get('sessionId')).toBe('s1')
    expect(withAll.get('recoveredFrom')).toBe('crash')
    const noSession = factory.buildAppQuery('w1')
    expect(noSession.has('sessionId')).toBe(false)
  })

  it('buildStaticErrorPageHtml：设计 T2 定值文案 + logsDir 注入 + 重试按钮', async () => {
    const factory = (await loadFactory()) as unknown as FactoryModule
    const html = factory.buildStaticErrorPageHtml('/data/logs', 'http://localhost:1420/?windowId=w1')
    expect(html).toContain('界面反复崩溃，请尝试重启应用。')
    expect(html).toContain('诊断日志位于')
    expect(html).toContain('/data/logs')
    expect(html).toContain('>重试</button>')
    expect(html).toContain('"http://localhost:1420/?windowId=w1"')
    expect(html).not.toContain('{{LOGS_DIR}}')
    expect(html).not.toContain('{{RETRY_URL}}')
  })

  it('buildStaticErrorPageHtml：logsDir 含 HTML 特殊字符时转义（防标记注入）；retryUrl 的 < 转 unicode', async () => {
    const factory = (await loadFactory()) as unknown as FactoryModule
    const html = factory.buildStaticErrorPageHtml('/data/<script>logs', 'http://x/?a=1<b')
    expect(html).not.toContain('<script>logs')
    expect(html).toContain('&lt;script&gt;logs')
    expect(html).not.toContain('a=1<b')
    expect(html).toContain('a=1\\u003cb')
  })
})
