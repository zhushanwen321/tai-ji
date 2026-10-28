/**
 * cookie-refresher 单测（隐藏窗口 cookie 刷新器）。
 *
 * 覆盖（任务验收条款）：
 * - 导航白名单 / 登录页判定 / cookie 域过滤三个纯函数的边界
 * - 种 cookie：secrets 文件存在 → cookies.set 逐对种入；文件缺失 → 零种入
 * - API 轮询成功路径：200 → 导出目标域 cookie 写回 secrets 文件（内容 + 0600 权限断言）
 * - 登录页转可见路径：登录页停留 5s → win.show() + 超时放宽 120s；登录完成恢复成功
 * - 超时失败路径：15s 无 200 → ok:false；转可见后 120s 未登录 → 放宽超时生效
 * - 同 provider 重入去重：返回同一 Promise、只开一个窗口
 * - IPC 注册（quota:refresh-cookie）：payload 校验 / 转发 / 注册幂等
 *
 * electron mock：BrowserWindow / session.fromPartition 为 EventEmitter 假件
 * （window-factory.test.ts 的 MockBrowserWindow + log-retention-ipc.test.ts 的
 * ipcMain.handle 捕获两形态合用）；真实文件 IO（secrets 读写）落 mkdtemp tmpdir
 * （fs-guard 生效中），dataDir 经 deps 注入。
 *
 * 异步时序约定：BrowserWindow 在 seedCookies 完成后的微任务里创建，用例统一经
 * windowOf() 等窗口出现、再改写假件状态（URL / API status），最后 await 结果。
 *
 * 运行：cd apps/electron/main && npx vitest run quota/__tests__/cookie-refresher.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ── electron 假件（hoisted：mock 工厂与用例共享同一可变状态容器）──────────────

type FakeCookie = {
  name: string
  value: string
  domain: string
}

type CookieSetCall = {
  url: string
  name: string
  value: string
}

const fake = vi.hoisted(() => {
  /** 最小事件发射器（hoisted 作用域内不可 import node:events，手写 on/emit 够用）。 */
  class MiniEmitter {
    private listeners = new Map<string, Array<(...args: unknown[]) => void>>()
    on(event: string, fn: (...args: unknown[]) => void): void {
      this.listeners.set(event, [...(this.listeners.get(event) ?? []), fn])
    }
    emit(event: string, ...args: unknown[]): void {
      for (const fn of this.listeners.get(event) ?? []) fn(...args)
    }
  }

  class FakeWebContents extends MiniEmitter {
    /** 当前页面 URL（用例改写驱动登录页检测）。 */
    url = ''
    /** window.open 拦截器（setWindowOpenHandler 捕获）。 */
    windowOpenHandler: ((detail: { url: string }) => { action: string }) | null = null
    setWindowOpenHandler(fn: (detail: { url: string }) => { action: string }): void {
      this.windowOpenHandler = fn
    }
    getURL(): string {
      return this.url
    }
    async executeJavaScript(expr: string): Promise<unknown> {
      return state.execImpl(expr)
    }
  }

  class FakeBrowserWindow extends MiniEmitter {
    static instances: FakeBrowserWindow[] = []
    readonly webContents = new FakeWebContents()
    shown = false
    destroyed = false
    constructor(public options: unknown) {
      super()
      FakeBrowserWindow.instances.push(this)
    }
    async loadURL(url: string): Promise<void> {
      state.loadUrls.push(url)
      // 用例可覆写为 reject（驱动 ERR_ABORTED / 加载故障分支）；缺省成功加载
      if (state.loadUrlImpl) return state.loadUrlImpl(url, this)
      this.webContents.url = url
    }
    show(): void {
      this.shown = true
    }
    isDestroyed(): boolean {
      return this.destroyed
    }
    destroy(): void {
      this.destroyed = true
    }
  }

  class FakeCookies {
    jar: FakeCookie[] = []
    setCalls: CookieSetCall[] = []
    async set(details: { url: string; name: string; value: string }): Promise<void> {
      this.setCalls.push({ url: details.url, name: details.name, value: details.value })
      // 真实 Electron 按 set url 的 host 落 domain；假件同构推导供导出过滤消费
      this.jar.push({ name: details.name, value: details.value, domain: new URL(details.url).hostname })
    }
    async get(_filter: Record<string, unknown>): Promise<FakeCookie[]> {
      return [...this.jar]
    }
  }

  const partitions = new Map<string, { cookies: FakeCookies }>()
  /** ipcMain.handle 捕获（key=channel）。 */
  const handlers = new Map<string, (...args: unknown[]) => unknown>()

  const state = {
    /** executeJavaScript 实现（beforeEach 重置 401，用例覆写驱动成功/悬置）。 */
    execImpl: (async () => 401) as (expr: string) => Promise<unknown>,
    /** loadURL 覆写（缺省 null = 成功加载并落 url；用例 reject 驱动 ABORTED 分支）。 */
    loadUrlImpl: null as null | ((url: string, win: FakeBrowserWindow) => Promise<void>),
    loadUrls: [] as string[],
    partitions,
    handlers,
    partitionNames: [] as string[],
  }

  return { MiniEmitter, FakeWebContents, FakeBrowserWindow, FakeCookies, state }
})

vi.mock('electron', () => ({
  BrowserWindow: fake.FakeBrowserWindow,
  session: {
    fromPartition: (name: string) => {
      fake.state.partitionNames.push(name)
      let ses = fake.state.partitions.get(name)
      if (!ses) {
        ses = { cookies: new fake.FakeCookies() }
        fake.state.partitions.set(name, ses)
      }
      return ses
    },
  },
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
      fake.state.handlers.set(channel, fn)
    },
  },
}))

// mainLogger mock：刷新器日志落盘会往 dataDir 写 main log（防污染 + 用例可断言 warn 通道）
vi.mock('../../logs/main-logger.js', () => ({
  mainLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import { refreshQuotaCookie } from '../cookie-refresher.js'
import {
  isAllowedQuotaRefreshNavigation,
  isQuotaRefreshLoginUrl,
  isTargetCookieDomain,
} from '../cookie-refresher.js'
import { registerQuotaCookieRefreshHandler, isValidQuotaRefreshCookiePayload } from '../quota-cookie-ipc.js'
import { QUOTA_REFRESH_COOKIE, getQuotaRefreshTarget } from '@taiji/shared'
import { mainLogger } from '../../logs/main-logger.js'

type FakeWindow = typeof fake.FakeBrowserWindow.prototype

const MIMO = getQuotaRefreshTarget('mimo')!
const OPENCODE = getQuotaRefreshTarget('opencode-go')!

const CONSOLE_URL = 'https://platform.xiaomimimo.com/console/plan-manage'
const LOGIN_URL = 'https://account.xiaomi.com/signin?callback=xxx'

/** 每用例共享的前置：tmp dataDir + 默认 exec 401。 */
let tmpDir: string

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'quota-cookie-refresher-test-'))
  fake.FakeBrowserWindow.instances = []
  fake.state.loadUrls = []
  fake.state.loadUrlImpl = null
  fake.state.partitionNames = []
  fake.state.partitions.clear()
  fake.state.execImpl = async () => 401
  vi.mocked(mainLogger.warn).mockClear()
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

/**
 * 等刷新器把窗口建出来（BrowserWindow 在 seedCookies 的 await 之后的微任务里创建，
 * 微任务不受 fake timers 控管，逐跳 Promise.resolve 轮询即可，两种 timer 模式通用）。
 */
async function windowOf(_refresh: Promise<unknown>): Promise<FakeWindow> {
  for (let i = 0; i < 10 && fake.FakeBrowserWindow.instances.length === 0; i++) {
    await Promise.resolve()
  }
  const win = fake.FakeBrowserWindow.instances.at(-1)
  expect(win, '刷新器应已创建 BrowserWindow').toBeDefined()
  return win!
}

/** 往最近创建的 partition 种一枚目标域会话 cookie（模拟服务端续期后的 Set-Cookie）。 */
function seedSessionCookie(): void {
  const lastName = fake.state.partitionNames.at(-1)
  expect(lastName, '刷新器应已创建 partition').toBeDefined()
  const ses = fake.state.partitions.get(lastName!)
  if (ses && !ses.cookies.jar.some((c) => c.name === 'sid')) {
    ses.cookies.jar.push({ name: 'sid', value: 'refreshed', domain: '.xiaomimimo.com' })
  }
}

/** API 就绪态：URL 在 console 页 + 探测 200（不种 cookie，供自备 jar 的用例）。 */
function makeApiOk(win: FakeWindow): void {
  win.webContents.url = CONSOLE_URL
  fake.state.execImpl = async () => 200
}

/** 造就绪态 = makeApiOk + 服务端种会话 cookie。 */
function makeReady(win: FakeWindow): void {
  makeApiOk(win)
  seedSessionCookie()
}

function cookiePath(providerId: string): string {
  return join(tmpDir, 'secrets', `${providerId}-cookie.txt`)
}

/** 标准成功路径：发起刷新 → 等窗口 → 就绪态 → await 结果。 */
async function refreshAndReady(providerId: string): Promise<{ result: ReturnType<typeof refreshQuotaCookie>; win: FakeWindow }> {
  const result = refreshQuotaCookie({ fetcherId: 'mimo', providerId }, { dataDir: () => tmpDir })
  const win = await windowOf(result)
  makeReady(win)
  return { result, win }
}

// ── 纯函数：导航白名单 / 登录页判定 / cookie 域过滤 ───────────────────────────

describe('isAllowedQuotaRefreshNavigation（导航白名单）', () => {
  it('目标站点域放行（pageUrl / apiUrl 同域的任意路径）', () => {
    expect(isAllowedQuotaRefreshNavigation(CONSOLE_URL, MIMO)).toBe(true)
    expect(isAllowedQuotaRefreshNavigation('https://platform.xiaomimimo.com/api/v1/tokenPlan/usage', MIMO)).toBe(true)
    expect(isAllowedQuotaRefreshNavigation('https://platform.xiaomimimo.com/anything/else', MIMO)).toBe(true)
  })

  it('账号域放行（loginUrlPatterns 的 host 形态 pattern 命中）', () => {
    expect(isAllowedQuotaRefreshNavigation(LOGIN_URL, MIMO)).toBe(true)
    // opencode 的 'auth\\.' host 形态：auth 子域放行
    expect(isAllowedQuotaRefreshNavigation('https://auth.opencode.ai/authorize', OPENCODE)).toBe(true)
  })

  it('第三方域 deny（cookie 不得被导航带到不可信站点）', () => {
    expect(isAllowedQuotaRefreshNavigation('https://evil.com/login', MIMO)).toBe(false)
    expect(isAllowedQuotaRefreshNavigation('https://evil.com/console/plan-manage', MIMO)).toBe(false)
    expect(isAllowedQuotaRefreshNavigation('https://account.xiaomi.com.evil.com/', MIMO)).toBe(false)
  })

  it('非 http(s) 协议 deny + 非法 URL deny', () => {
    expect(isAllowedQuotaRefreshNavigation('file:///etc/passwd', MIMO)).toBe(false)
    expect(isAllowedQuotaRefreshNavigation('javascript:alert(1)', MIMO)).toBe(false)
    expect(isAllowedQuotaRefreshNavigation('not a url', MIMO)).toBe(false)
  })

  it('路径形态 pattern（/login）不参与放行：opencode 目标域外同名路径 deny', () => {
    expect(isAllowedQuotaRefreshNavigation('https://opencode.ai/login', OPENCODE)).toBe(true)
    expect(isAllowedQuotaRefreshNavigation('https://evil.com/login', OPENCODE)).toBe(false)
  })
})

describe('isQuotaRefreshLoginUrl（登录页判定）', () => {
  it('SSO 账号域与平台自身登录路径命中', () => {
    expect(isQuotaRefreshLoginUrl(LOGIN_URL, MIMO)).toBe(true)
    expect(isQuotaRefreshLoginUrl('https://platform.xiaomimimo.com/login', MIMO)).toBe(true)
    expect(isQuotaRefreshLoginUrl('https://opencode.ai/login', OPENCODE)).toBe(true)
  })

  it('console 页 / 无关域不命中', () => {
    expect(isQuotaRefreshLoginUrl(CONSOLE_URL, MIMO)).toBe(false)
    expect(isQuotaRefreshLoginUrl('https://example.com/', MIMO)).toBe(false)
  })
})

describe('isTargetCookieDomain（导出域过滤）', () => {
  const hosts = new Set(['platform.xiaomimimo.com'])

  it('域 cookie（前导点）与 host-only cookie 均命中', () => {
    expect(isTargetCookieDomain('.xiaomimimo.com', hosts)).toBe(true)
    expect(isTargetCookieDomain('platform.xiaomimimo.com', hosts)).toBe(true)
  })

  it('无关域 / 空域 / 后缀伪装域不命中', () => {
    expect(isTargetCookieDomain('.evil.com', hosts)).toBe(false)
    expect(isTargetCookieDomain('', hosts)).toBe(false)
    expect(isTargetCookieDomain('.xiaomimimo.com.evil.com', hosts)).toBe(false)
  })
})

// ── 集成路径（mock electron + 真实 secrets 文件 IO）──────────────────────────

describe('refreshQuotaCookie：种 cookie', () => {
  it('secrets 文件存在：逐对种入 partition（url = pageUrl origin）', async () => {
    mkdirSync(join(tmpDir, 'secrets'), { recursive: true })
    writeFileSync(cookiePath('p-seed'), 'a=1; b=2')

    const { result } = await refreshAndReady('p-seed')
    expect(await result).toEqual({ ok: true, cookieWritten: true })

    const ses = fake.state.partitions.get('persist:quota-p-seed')
    expect(ses, 'partition 应为 persist:quota-<providerId>').toBeDefined()
    expect(ses!.cookies.setCalls).toEqual([
      { url: 'https://platform.xiaomimimo.com', name: 'a', value: '1' },
      { url: 'https://platform.xiaomimimo.com', name: 'b', value: '2' },
    ])
  })

  it('secrets 文件缺失：零种入（partition 历史登录态自效）', async () => {
    const { result } = await refreshAndReady('p-noseed')
    expect(await result).toEqual({ ok: true, cookieWritten: true })
    // setCalls 只可能来自种入路径（成功路径导出走 get），缺失时必须为空
    const ses = fake.state.partitions.get('persist:quota-p-noseed')
    expect(ses!.cookies.setCalls).toEqual([])
  })
})

describe('refreshQuotaCookie：API 轮询成功路径', () => {
  it('200 → 导出写回 + 窗口形态（隐藏 / 双隔离 / persist session）+ 弹窗 deny + destroy 收尾', async () => {
    const { result, win } = await refreshAndReady('p-ok')
    expect(await result).toEqual({ ok: true, cookieWritten: true })

    const options = win.options as {
      show?: boolean
      webPreferences: { nodeIntegration: boolean; contextIsolation: boolean; session: { cookies: unknown } }
    }
    expect(options.show).toBe(false)
    expect(options.webPreferences.nodeIntegration).toBe(false)
    expect(options.webPreferences.contextIsolation).toBe(true)
    // session 即该 partition 的 session（fromPartition 返回的同一对象）
    expect(options.webPreferences.session).toBe(
      fake.state.partitions.get('persist:quota-p-ok'),
    )
    // 加载入口 = pageUrl
    expect(fake.state.loadUrls).toEqual([CONSOLE_URL])
    // 弹窗一律 deny
    expect(win.webContents.windowOpenHandler!({ url: 'https://evil.com' })).toEqual({ action: 'deny' })
    // 收尾：destroy 释放（不用 close）
    expect(win.destroyed).toBe(true)
    expect(win.shown).toBe(false)
  })

  it('写回内容只含目标域 cookie，格式与手贴一致 + 0600 权限', async () => {
    // partition 预置历史登录态：目标域域 cookie + host-only + 无关域各一枚
    const cookies = new fake.FakeCookies()
    fake.state.partitions.set('persist:quota-p-export', { cookies })
    cookies.jar.push(
      { name: 'sid', value: 'token-1', domain: '.xiaomimimo.com' },
      { name: 'uid', value: '42', domain: 'platform.xiaomimimo.com' },
      { name: 'tracker', value: 'x', domain: '.evil.com' },
    )

    const result = refreshQuotaCookie(
      { fetcherId: 'mimo', providerId: 'p-export' },
      { dataDir: () => tmpDir },
    )
    makeApiOk(await windowOf(result))

    expect(await result).toEqual({ ok: true, cookieWritten: true })
    const written = readFileSync(cookiePath('p-export'), 'utf-8')
    // 无关域被过滤；'name=value; name2=value2' 手贴格式（顺序按 cookies.get 返回序）
    expect(written).toBe('sid=token-1; uid=42')
    expect(statSync(cookiePath('p-export')).mode & 0o777).toBe(0o600)
  })
})

describe('refreshQuotaCookie：loadURL 中断处理', () => {
  it('ERR_ABORTED(-3)（SSO 链页面自导航打断初始加载）→ 放行进轮询，API 200 仍成功', async () => {
    fake.state.loadUrlImpl = async (url, win) => {
      // 复现真机形态：平台页 JS 跳 genLoginUrl 打断 loadURL（Electron 以 ABORTED reject）
      win.webContents.url = `${url}/api/v1/genLoginUrl`
      throw Object.assign(new Error(`ERR_ABORTED (-3) loading '${url}'`), { code: -3 })
    }
    const result = refreshQuotaCookie({ fetcherId: 'mimo', providerId: 'p-aborted' }, { dataDir: () => tmpDir })
    const win = await windowOf(result)
    makeReady(win)

    expect(await result).toEqual({ ok: true, cookieWritten: true })
    expect(win.destroyed).toBe(true)
  })

  it('非 ABORTED 加载故障（DNS 解析失败）→ 仍立即失败并携带 page load failed 文案', async () => {
    fake.state.loadUrlImpl = async () => {
      throw Object.assign(new Error('ERR_NAME_NOT_RESOLVED (-105)'), { code: -105 })
    }
    const result = await refreshQuotaCookie(
      { fetcherId: 'mimo', providerId: 'p-dns' },
      { dataDir: () => tmpDir },
    )
    expect(result.ok).toBe(false)
    expect(result.error).toContain('page load failed')
    expect(result.error).toContain('ERR_NAME_NOT_RESOLVED')
  })
})

describe('refreshQuotaCookie：登录页转可见路径', () => {
  it('登录页停留 5s → win.show() + 超时放宽；登录完成（离开登录页 + 200）恢复成功', async () => {
    vi.useFakeTimers()
    try {
      const result = refreshQuotaCookie(
        { fetcherId: 'mimo', providerId: 'p-login' },
        { dataDir: () => tmpDir },
      )
      const win = await windowOf(result)
      // SSO 把页面重定向到小米登录页，API 恒 401（exec 缺省）
      win.webContents.url = LOGIN_URL

      // 停留不满 5s（SSO 过境窗口）：不转可见（loginSince 从首个命中轮起算，
      // 最晚 t=1000，4999ms 处最多停留 3999ms）
      await vi.advanceTimersByTimeAsync(4_999)
      expect(win.shown).toBe(false)

      // 满 5s（推进到 6999ms，覆盖 show 判定的最早与最晚边界轮次）：转可见
      await vi.advanceTimersByTimeAsync(2_000)
      expect(win.shown).toBe(true)

      // 推进到 ~22s（> 无交互总超时 15s）仍未终局 = 放宽生效的直接证据
      await vi.advanceTimersByTimeAsync(15_000)

      // 用户完成登录：跳回 console + API 放行 + 服务端种会话 cookie；再推进一轮让轮询取到新状态
      makeReady(win)
      await vi.advanceTimersByTimeAsync(2_000)
      expect(await result).toEqual({ ok: true, cookieWritten: true })
      expect(win.destroyed).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('登录页离开后停留计时重置：过境 <5s 不误判转可见', async () => {
    vi.useFakeTimers()
    try {
      const result = refreshQuotaCookie(
        { fetcherId: 'mimo', providerId: 'p-transit' },
        { dataDir: () => tmpDir },
      )
      const win = await windowOf(result)
      // SSO 链路过境登录域 3s 后跳达 console
      win.webContents.url = LOGIN_URL
      await vi.advanceTimersByTimeAsync(3_000)
      win.webContents.url = CONSOLE_URL
      await vi.advanceTimersByTimeAsync(3_000)
      expect(win.shown).toBe(false)

      makeReady(win)
      await vi.advanceTimersByTimeAsync(2_000)
      expect(await result).toEqual({ ok: true, cookieWritten: true })
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('refreshQuotaCookie：超时失败路径', () => {
  it('无登录交互：15s 内 API 未 200 → ok:false + destroy', async () => {
    vi.useFakeTimers()
    try {
      const result = refreshQuotaCookie(
        { fetcherId: 'mimo', providerId: 'p-timeout' },
        { dataDir: () => tmpDir },
      )
      const win = await windowOf(result)
      win.webContents.url = CONSOLE_URL // 不命中登录页，exec 恒 401（缺省）

      await vi.advanceTimersByTimeAsync(20_000)
      const settled = await result
      expect(settled.ok).toBe(false)
      expect(settled.cookieWritten).toBe(false)
      expect(settled.error).toContain('timed out')
      expect(win.destroyed).toBe(true)
      expect(win.shown).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('转可见后 120s 未完成登录 → 放宽超时生效（若未放宽会在 15s 失败且文案不同）', async () => {
    vi.useFakeTimers()
    try {
      const result = refreshQuotaCookie(
        { fetcherId: 'mimo', providerId: 'p-login-timeout' },
        { dataDir: () => tmpDir },
      )
      const win = await windowOf(result)
      win.webContents.url = LOGIN_URL
      // 推进过 5s 停留阈值（覆盖 loginSince 首个命中轮的最早/最晚交错：t=5000 或 6000）
      await vi.advanceTimersByTimeAsync(7_000)
      expect(win.shown).toBe(true)

      await vi.advanceTimersByTimeAsync(130_000)
      const settled = await result
      expect(settled.ok).toBe(false)
      // 放宽超时的失败文案（120s 登录窗口），区别于 15s API 轮询超时
      expect(settled.error).toContain('login not completed within 120s')
      expect(win.destroyed).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('refreshQuotaCookie：同 provider 重入去重', () => {
  it('在途刷新重入返回同一 Promise，只创建一个窗口', async () => {
    // 手动闸门：首轮 fetch 悬置，制造在途刷新
    let releaseStatus: (status: number) => void = () => {}
    const gate = new Promise<number>((resolve) => {
      releaseStatus = resolve
    })
    fake.state.execImpl = () => gate

    const p1 = refreshQuotaCookie(
      { fetcherId: 'mimo', providerId: 'p-dedup' },
      { dataDir: () => tmpDir },
    )
    const win = await windowOf(p1)

    const p2 = refreshQuotaCookie(
      { fetcherId: 'mimo', providerId: 'p-dedup' },
      { dataDir: () => tmpDir },
    )
    expect(p2).toBe(p1)
    expect(fake.FakeBrowserWindow.instances).toHaveLength(1)

    // 闸门放行前先种会话 cookie（模拟服务端在登录态续期后的 Set-Cookie；
    // 不走 makeReady——它会覆盖 execImpl 破坏闸门）
    seedSessionCookie()
    releaseStatus(200)
    const [r1, r2] = await Promise.all([p1, p2])
    expect(r1).toEqual({ ok: true, cookieWritten: true })
    expect(r2).toEqual(r1)
    expect(win.destroyed).toBe(true)
  })

  it('在途结束后同 provider 再刷新 → 重新执行（inflight Map 收尾清除）', async () => {
    const first = await refreshAndReady('p-again')
    expect(await first.result).toEqual({ ok: true, cookieWritten: true })
    expect(fake.FakeBrowserWindow.instances).toHaveLength(1)

    const second = await refreshAndReady('p-again')
    expect(await second.result).toEqual({ ok: true, cookieWritten: true })
    expect(fake.FakeBrowserWindow.instances).toHaveLength(2)
  })
})

describe('refreshQuotaCookie：导航拦截接线', () => {
  it('will-navigate 到第三方域被 preventDefault，账号域放行', async () => {
    const { result, win } = await refreshAndReady('p-nav')
    await result

    const blocked = { prevented: false, preventDefault() { this.prevented = true } }
    win.webContents.emit('will-navigate', blocked, 'https://evil.com/phish')
    expect(blocked.prevented).toBe(true)
    expect(mainLogger.warn).toHaveBeenCalled()

    const allowed = { prevented: false, preventDefault() { this.prevented = true } }
    win.webContents.emit('will-navigate', allowed, LOGIN_URL)
    expect(allowed.prevented).toBe(false)
  })
})

// ── IPC 注册（quota:refresh-cookie）───────────────────────────────────────────

describe('quota:refresh-cookie IPC', () => {
  let savedDataDir: string | undefined

  beforeEach(() => {
    // IPC handler 无 deps 注入面，dataDir 走 getDataDir()：env 重定向到本用例 tmp
    // （log-retention-ipc.test.ts 同款先例）
    savedDataDir = process.env.TAIJI_AGENT_DATA_DIR
    process.env.TAIJI_AGENT_DATA_DIR = tmpDir
  })

  afterEach(() => {
    if (savedDataDir === undefined) delete process.env.TAIJI_AGENT_DATA_DIR
    else process.env.TAIJI_AGENT_DATA_DIR = savedDataDir
  })

  it('注册幂等：重复调用不重复 handle', () => {
    registerQuotaCookieRefreshHandler()
    registerQuotaCookieRefreshHandler()
    expect(fake.state.handlers.get(QUOTA_REFRESH_COOKIE)).toBeDefined()
    expect([...fake.state.handlers.keys()].filter((c) => c === QUOTA_REFRESH_COOKIE)).toHaveLength(1)
  })

  it('合法 payload 转发刷新器（成功路径）', async () => {
    registerQuotaCookieRefreshHandler()
    const handler = fake.state.handlers.get(QUOTA_REFRESH_COOKIE)!

    const invoke = handler(undefined, { fetcherId: 'mimo', providerId: 'p-ipc' }) as Promise<{
      ok: boolean
      cookieWritten: boolean
    }>
    makeReady(await windowOf(invoke))
    expect(await invoke).toEqual({ ok: true, cookieWritten: true })
  })

  it('非法 payload reject：空字段 / 非对象 / 不在册 fetcherId，且不触达刷新器', async () => {
    registerQuotaCookieRefreshHandler()
    const handler = fake.state.handlers.get(QUOTA_REFRESH_COOKIE)!
    await expect(handler(undefined, { fetcherId: '', providerId: 'p' })).rejects.toThrow(/invalid payload/)
    await expect(handler(undefined, { fetcherId: 'mimo', providerId: '' })).rejects.toThrow(/invalid payload/)
    await expect(handler(undefined, 'mimo')).rejects.toThrow(/invalid payload/)
    await expect(handler(undefined, { fetcherId: 'zhipu', providerId: 'p' })).rejects.toThrow(/invalid payload/)
    // 均未开窗口（校验前置）
    expect(fake.FakeBrowserWindow.instances).toHaveLength(0)
  })

  it('isValidQuotaRefreshCookiePayload 纯函数边界', () => {
    expect(isValidQuotaRefreshCookiePayload({ fetcherId: 'mimo', providerId: 'p' })).toBe(true)
    expect(isValidQuotaRefreshCookiePayload({ fetcherId: 'opencode-go', providerId: 'p' })).toBe(true)
    expect(isValidQuotaRefreshCookiePayload(null)).toBe(false)
    expect(isValidQuotaRefreshCookiePayload(undefined)).toBe(false)
    expect(isValidQuotaRefreshCookiePayload({ fetcherId: 1, providerId: 'p' })).toBe(false)
    // 在册 QUOTA_PRESETS 但无刷新目标（api-key 类）：拒绝
    expect(isValidQuotaRefreshCookiePayload({ fetcherId: 'minimax', providerId: 'p' })).toBe(false)
  })
})
