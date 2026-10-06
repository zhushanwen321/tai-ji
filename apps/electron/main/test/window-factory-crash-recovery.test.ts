/**
 * window-factory render-process-gone 崩溃处理单测（ADR-0122：失败显式上报）。
 *
 * [HISTORICAL] 原 u3-renderer-recovery「60s 滑窗 ≤3 次自动 reload + 熔断转静态页」
 * 已删（ADR-0122：自动重试属无效防御）。现行语义：一次崩溃即加载静态错误页，
 * 手动重试是唯一恢复通道。
 *
 * 覆盖（验收：详情落盘 + 崩溃台账 + 一次崩溃即静态错误页 + 手动重试日志）：
 * - 详情落盘：main-logger（mock）收到含 windowId/reason/exitCode/detectedAt 的结构化 meta
 * - 显式失败：首次崩溃即 data:text/html 静态错误页（文案 + logsDir 注入断言）+ 台账行
 * - 重试导航回应用源记日志；destroyed 窗口只落盘不加载；clean-exit 不进错误页
 *
 * electron mock 捕获 BrowserWindow 实例（logs/__tests__/renderer-log-handler.test.ts 与
 * test/privileged-handlers.test.ts 同款形态）；main-logger mock 断言结构化行（不触真实
 * 文件系统）。纯逻辑零 fs 写。
 * 运行：cd apps/electron/main && npx vitest run test/window-factory-crash-recovery.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── electron mock（外层稳定引用）──────────────────

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
  // 非 mac 分支取主屏工作区算默认尺寸（mac 跑测不触达，为 CI linux 跑测补跨平台 mock）
  screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }) },
}))

// ── main-logger mock（u5a writer 的 API 面；断言结构化 meta，不触文件系统）──

const mainLoggerStubs = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}

vi.mock('../logs/main-logger.js', () => ({ mainLogger: mainLoggerStubs }))

// 台账断言面：捕获 append 调用；未 init 的真实单例 append 本就是 no-op，
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

/** 动态 import 拿当前模块实例。 */
async function loadFactory() {
  return await import('../window/window-factory.js')
}

interface FactoryModule {
  createWindow: (
    options: { windowId?: string; sessionId?: string } | undefined,
    deps: { isDev: boolean; generateId: () => string },
  ) => Promise<{ win: FakeBrowserWindow; windowId: string }>
  buildAppQuery: (windowId: string, sessionId?: string) => URLSearchParams
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
    crashJournalAppend.mockClear()
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

  it('destroyed 窗口：详情仍落盘，但不触发错误页加载', async () => {
    const factory = (await loadFactory()) as unknown as FactoryModule
    const win = await createProdWindow(factory, 'win-dead')
    win.isDestroyed.mockReturnValue(true)
    crash(win)
    expect(mainLoggerStubs.error).toHaveBeenCalledTimes(1)
    // 初始加载（createWindow 时）之外不得有加载；prod 形态全程无 loadURL
    expect(win.loadFile).toHaveBeenCalledTimes(1)
    expect(win.loadURL).not.toHaveBeenCalled()
  })
})

describe('window-factory render-process-gone：一次崩溃即显式失败（ADR-0122）', () => {
  beforeEach(() => {
    vi.resetModules()
    FakeBrowserWindow.instances.length = 0
    for (const fn of Object.values(mainLoggerStubs)) fn.mockClear()
    for (const fn of Object.values(electronStubs)) fn.mockClear()
    crashJournalAppend.mockClear()
    process.env.TAIJI_AGENT_DATA_DIR = FAKE_DATA_DIR
    delete process.env.TAIJI_E2E
  })

  it('首崩即加载静态错误页（无自动 reload）+ 台账 crash 行 + warn 显式上报', async () => {
    const factory = (await loadFactory()) as unknown as FactoryModule
    const win = await createProdWindow(factory, 'win-fail')
    crash(win, 'oom')
    // prod 形态：无任何恢复性 loadFile（自动 reload 已删），错误页经 loadURL
    expect(win.loadFile).toHaveBeenCalledTimes(1) // 仅初始加载
    const pages = staticErrorPageCalls(win)
    expect(pages).toHaveLength(1)
    expect(pages[0]).toContain('应用界面发生崩溃，点击重试恢复；若反复出现，请重启应用。')
    expect(pages[0]).toContain('诊断日志位于')
    expect(pages[0]).toContain(`${FAKE_DATA_DIR}/logs`)
    expect(pages[0]).toContain('重试')
    // 台账：crash 事件 + reason 透传（无 reload 事件、无 circuit-breaker 合成 reason）
    expect(crashJournalAppend).toHaveBeenCalledTimes(1)
    expect(crashJournalAppend).toHaveBeenCalledWith({ layer: 'renderer', event: 'crash', reason: 'oom' })
    // 显式上报 warn（取证：静态错误页出现的原因）
    expect(mainLoggerStubs.warn).toHaveBeenCalled()
  })

  it('再次崩溃仍直接展示错误页（每次崩溃独立显式上报，无熔断状态）', async () => {
    const factory = (await loadFactory()) as unknown as FactoryModule
    const win = await createProdWindow(factory, 'win-again')
    crash(win)
    crash(win)
    expect(staticErrorPageCalls(win)).toHaveLength(2)
    expect(crashJournalAppend).toHaveBeenCalledTimes(2)
  })

  it("clean-exit（正常退出路径）：不写台账、不进错误页", async () => {
    const factory = (await loadFactory()) as unknown as FactoryModule
    const win = await createProdWindow(factory, 'win-clean')
    crash(win, 'clean-exit', 0)
    // 早退：无详情落盘、无台账行、无错误页（prod 形态全程无 loadURL）
    expect(mainLoggerStubs.error).not.toHaveBeenCalled()
    expect(crashJournalAppend).not.toHaveBeenCalled()
    expect(win.loadURL).not.toHaveBeenCalled()
  })

  it('手动重试导航回应用源：记 info 日志；data: URL（错误页自身加载）不记', async () => {
    const factory = (await loadFactory()) as unknown as FactoryModule
    const win = await createProdWindow(factory, 'win-retry')
    crash(win)
    expect(staticErrorPageCalls(win)).toHaveLength(1)
    // data: URL 是错误页自身的程序化加载，非重试导航
    win.webContents.emit('did-navigate', {}, 'data:text/html;charset=utf-8,...')
    expect(mainLoggerStubs.info).not.toHaveBeenCalled()
    // 用户点重试：页面发起导航回 file:// 构建产物（过 will-navigate 白名单的同一 URL 形态）
    win.webContents.emit('did-navigate', {}, `file://${APP_INDEX_HTML}?windowId=win-retry`)
    expect(mainLoggerStubs.info).toHaveBeenCalled()
    // 重试导航监听一次性：再次导航不再重复记
    mainLoggerStubs.info.mockClear()
    win.webContents.emit('did-navigate', {}, `file://${APP_INDEX_HTML}?windowId=win-retry`)
    expect(mainLoggerStubs.info).not.toHaveBeenCalled()
  })
})

describe('window-factory 崩溃链纯函数', () => {
  beforeEach(() => {
    vi.resetModules()
    process.env.TAIJI_AGENT_DATA_DIR = FAKE_DATA_DIR
    delete process.env.TAIJI_E2E
  })

  it('buildAppQuery：windowId 必带、sessionId 按需合并（初始加载共用构造）', async () => {
    const factory = (await loadFactory()) as unknown as FactoryModule
    expect(factory.buildAppQuery('w1').get('windowId')).toBe('w1')
    const withSession = factory.buildAppQuery('w1', 's1')
    expect(withSession.get('sessionId')).toBe('s1')
    const noSession = factory.buildAppQuery('w1')
    expect(noSession.has('sessionId')).toBe(false)
  })

  it('buildStaticErrorPageHtml：显式失败文案 + logsDir 注入 + 重试按钮', async () => {
    const factory = (await loadFactory()) as unknown as FactoryModule
    const html = factory.buildStaticErrorPageHtml('/data/logs', 'http://localhost:1420/?windowId=w1')
    expect(html).toContain('应用界面发生崩溃，点击重试恢复；若反复出现，请重启应用。')
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
