/**
 * BrowserViewManager 单元测试。
 *
 * 覆盖 Wave 1 核心生命周期：create / navigate / hide / show / destroy，
 * 以及零信任 webPreferences、下载拦截、状态暂存、destroy 顺序等 [HISTORICAL] 不变量。
 * Wave 3 覆盖：setRect（rect 同步）+ isVisible 显隐标志（hide 态 setRect 不重显）。
 *
 * Mock 策略：vi.hoisted 创建稳定引用（vi.mock factory 被 hoist，顶层 const 在
 * factory 执行时尚处 TDZ），vi.mock('electron') 注入桩 WebContentsView + session，
 * 用最小 IWindowManager 实现（FakeWindowManager）提供 BrowserWindow 形状。
 *
 * 运行：cd apps/electron/main && npx vitest run test/browser-view-manager.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { IWindowManager } from '../interfaces.js'

// ── electron mock（vi.hoisted 保证 factory 内可引用）─────────────
type WcListener = (...args: unknown[]) => void

// vi.hoisted：vi.mock factory 被 hoist 到文件顶部，顶层 const 在 factory 执行时
// 尚处 TDZ，必须用 vi.hoisted 才能在 factory 内引用 createdViews / sessionOn。
const hoisted = vi.hoisted(() => {
  // 由 WebContentsView mock 写入，测试读取断言
  const createdViews: Array<{
    webPreferences: Record<string, unknown> | undefined
    setBounds: ReturnType<typeof vi.fn>
    getBounds: ReturnType<typeof vi.fn>
    wc: {
      url: string
      destroyed: boolean
      listeners: Map<string, WcListener[]>
      navigationHistory: {
        canGoBack: ReturnType<typeof vi.fn>
        canGoForward: ReturnType<typeof vi.fn>
        goBack: ReturnType<typeof vi.fn>
        goForward: ReturnType<typeof vi.fn>
      }
      zoomFactor: number
      loadURL(url: string): Promise<void>
      on(event: string, listener: WcListener): void
      isDestroyed(): boolean
      close(): void
      setZoomFactor(factor: number): void
      getZoomFactor(): number
      executeJavaScript: ReturnType<typeof vi.fn>
      setWindowOpenHandler: ReturnType<typeof vi.fn>
      session: { on: ReturnType<typeof vi.fn> }
    }
  }> = []
  const sessionOn = vi.fn()
  // D2b：browser-view-manager 现引入 shell（window.open 的 http/https 转系统浏览器）
  const shellOpenExternal = vi.fn(() => Promise.resolve())
  // WebContentsView mock：用普通 function（可 new），内部构造 view + webContents 桩
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const WebContentsViewMock = function (this: any, options?: { webPreferences?: Record<string, unknown> }) {
    const listeners = new Map<string, WcListener[]>()
    // navigationHistory 桩：Wave 5 notify() 会读 canGoBack/canGoForward。
    // 默认 false，测试可改写以验证 back/forward 方法。
    const navigationHistory = {
      canGoBack: vi.fn(() => false),
      canGoForward: vi.fn(() => false),
      goBack: vi.fn(),
      goForward: vi.fn(),
    }
    const wc = {
      url: '',
      destroyed: false,
      listeners,
      navigationHistory,
      zoomFactor: 1,
      loadURL(url: string) {
        this.url = url
        return Promise.resolve()
      },
      on(event: string, listener: WcListener) {
        if (!this.listeners.has(event)) this.listeners.set(event, [])
        this.listeners.get(event)!.push(listener)
      },
      isDestroyed() {
        return this.destroyed
      },
      close() {
        this.destroyed = true
      },
      setZoomFactor(factor: number) {
        this.zoomFactor = factor
      },
      getZoomFactor() {
        return this.zoomFactor
      },
      // executeJavaScript 默认 resolve undefined（模拟 viewport 注入成功但无 autoFit 数据）。
      // autoFit 测试用例改写为返回 [scrollWidth, innerWidth] 数组触发缩放逻辑。
      executeJavaScript: vi.fn(() => Promise.resolve(undefined)),
      // D2b 新窗口分支：create 时注册（mock 只记录 handler，语义断言见下方用例）
      setWindowOpenHandler: vi.fn(),
      session: { on: sessionOn },
    }
    const setBounds = vi.fn()
    const getBounds = vi.fn(() => ({ x: 0, y: 0, width: 100, height: 100 }))
    createdViews.push({ webPreferences: options?.webPreferences, setBounds, getBounds, wc })
    this.setBounds = setBounds
    this.getBounds = getBounds
    this.webContents = wc
  }
  return { createdViews, sessionOn, shellOpenExternal, WebContentsViewMock }
})

const createdViews = hoisted.createdViews
const sessionOn = hoisted.sessionOn

vi.mock('electron', () => ({
  // vi.fn 包裹普通 function 使其既可 new 又能被 vi.mocked/spy
  WebContentsView: vi.fn(hoisted.WebContentsViewMock as never),
  session: { defaultSession: { on: hoisted.sessionOn } },
  shell: { openExternal: hoisted.shellOpenExternal },
}))

import { BrowserViewManager } from '../browser/browser-view-manager.js'

// ── FakeWindowManager（最小 IWindowManager 实现，仅满足测试所需 get）────
function makeWindowManager(windowId: string, win: object): IWindowManager {
  return {
    get: (id: string) => (id === windowId ? (win as never) : undefined),
  } as unknown as IWindowManager
}

// 标准窗口桩（含 contentView.addChildView / removeChildView / isDestroyed）
function makeWindow(opts: { destroyed?: boolean } = {}) {
  return {
    isDestroyed: () => opts.destroyed ?? false,
    contentView: {
      addChildView: vi.fn(),
      removeChildView: vi.fn(),
    },
  }
}

describe('BrowserViewManager', () => {
  beforeEach(() => {
    createdViews.length = 0
    sessionOn.mockClear()
    hoisted.shellOpenExternal.mockClear()
  })

  describe('create', () => {
    it('创建 view 并 attach 到窗口（addChildView 被调用），初始 setBounds 隐藏', () => {
      const win = makeWindow()
      const mgr = new BrowserViewManager(makeWindowManager('win-1', win))
      mgr.create('sess-1', 'win-1')

      expect(win.contentView.addChildView).toHaveBeenCalledTimes(1)
      // 初始隐藏：setBounds 至少被调用一次（值为 {0,0,0,0}）
      expect(createdViews[0].setBounds).toHaveBeenCalled()
      const boundsCall = createdViews[0].setBounds.mock.calls[0][0]
      expect(boundsCall).toEqual({ x: 0, y: 0, width: 0, height: 0 })
    })

    it('零信任 webPreferences：contextIsolation/sandbox 开启，nodeIntegration 关闭', () => {
      const win = makeWindow()
      const mgr = new BrowserViewManager(makeWindowManager('win-1', win))
      mgr.create('sess-1', 'win-1')

      expect(createdViews[0].webPreferences).toEqual({
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      })
    })

    it('注册下载拦截 will-download（MANDATORY 安全默认）', () => {
      const win = makeWindow()
      const mgr = new BrowserViewManager(makeWindowManager('win-1', win))
      mgr.create('sess-1', 'win-1')

      expect(createdViews[0].wc.session.on).toHaveBeenCalledWith('will-download', expect.any(Function))
    })

    it('D2b：注册 setWindowOpenHandler，window.open 一律 deny（http/https 转系统浏览器）', () => {
      const win = makeWindow()
      const mgr = new BrowserViewManager(makeWindowManager('win-1', win))
      mgr.create('sess-1', 'win-1')

      expect(createdViews[0].wc.setWindowOpenHandler).toHaveBeenCalledWith(expect.any(Function))
      const handler = createdViews[0].wc.setWindowOpenHandler.mock.calls[0][0] as
        (details: { url: string }) => { action: 'allow' | 'deny' }
      // 无论 http(s) 与否都不建新窗口；http(s) 额外转系统浏览器
      expect(handler({ url: 'https://example.com' })).toEqual({ action: 'deny' })
      expect(handler({ url: 'file:///etc/passwd' })).toEqual({ action: 'deny' })
      expect(hoisted.shellOpenExternal).toHaveBeenCalledWith('https://example.com')
      expect(hoisted.shellOpenExternal).not.toHaveBeenCalledWith('file:///etc/passwd')
    })

    it('sessionId 已存在时幂等（不重复创建）', () => {
      const win = makeWindow()
      const mgr = new BrowserViewManager(makeWindowManager('win-1', win))
      mgr.create('sess-1', 'win-1')
      mgr.create('sess-1', 'win-1')

      expect(createdViews).toHaveLength(1)
      expect(win.contentView.addChildView).toHaveBeenCalledTimes(1)
    })

    it('windowId 不存在时记录日志且不创建（不抛错）', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const mgr = new BrowserViewManager(makeWindowManager('win-1', makeWindow()))
      mgr.create('sess-1', 'nonexistent')

      expect(createdViews).toHaveLength(0)
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('window not found'))
      warnSpy.mockRestore()
    })

    it('窗口已销毁时跳过 addChildView', () => {
      const win = makeWindow({ destroyed: true })
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const mgr = new BrowserViewManager(makeWindowManager('win-1', win))
      mgr.create('sess-1', 'win-1')

      expect(win.contentView.addChildView).not.toHaveBeenCalled()
      // 但 view 仍被创建并跟踪（getState 可读）
      expect(mgr.getState('sess-1')).not.toBeNull()
      errSpy.mockRestore()
    })
  })

  describe('navigate', () => {
    it('调用 webContents.loadURL 并返回 resolved promise', async () => {
      const win = makeWindow()
      const mgr = new BrowserViewManager(makeWindowManager('win-1', win))
      mgr.create('sess-1', 'win-1')

      await mgr.navigate('sess-1', 'https://example.com')
      expect(createdViews[0].wc.url).toBe('https://example.com')
    })

    it('sessionId 不存在时 reject', async () => {
      const mgr = new BrowserViewManager(makeWindowManager('win-1', makeWindow()))
      await expect(mgr.navigate('nope', 'https://example.com')).rejects.toThrow('session not found')
    })

    it('loadURL reject 时透传（调用方经 IPC 接住）', async () => {
      const win = makeWindow()
      const mgr = new BrowserViewManager(makeWindowManager('win-1', win))
      mgr.create('sess-1', 'win-1')
      createdViews[0].wc.loadURL = vi.fn(() => Promise.reject(new Error('DNS fail')))

      await expect(mgr.navigate('sess-1', 'https://nope.invalid')).rejects.toThrow('DNS fail')
    })

    describe('scheme guard (PR #100 B1 defense-in-depth)', () => {
      it('javascript: 协议被拒（manager 第二层防御）', async () => {
        const win = makeWindow()
        const mgr = new BrowserViewManager(makeWindowManager('win-1', win))
        mgr.create('sess-1', 'win-1')
        const loadURLSpy = vi.spyOn(createdViews[0].wc, 'loadURL')

        await expect(mgr.navigate('sess-1', 'javascript:alert(1)')).rejects.toThrow(/dangerous scheme/)
        // loadURL 未被调用（scheme 校验在 loadURL 之前）
        expect(loadURLSpy).not.toHaveBeenCalled()
      })

      it('data: 协议被拒', async () => {
        const win = makeWindow()
        const mgr = new BrowserViewManager(makeWindowManager('win-1', win))
        mgr.create('sess-1', 'win-1')

        await expect(mgr.navigate('sess-1', 'data:text/html,<script>1</script>')).rejects.toThrow(/dangerous scheme/)
      })

      it('file:///etc/passwd 协议被拒', async () => {
        const win = makeWindow()
        const mgr = new BrowserViewManager(makeWindowManager('win-1', win))
        mgr.create('sess-1', 'win-1')

        await expect(mgr.navigate('sess-1', 'file:///etc/passwd')).rejects.toThrow(/dangerous scheme/)
      })

      it('blob: 协议被拒', async () => {
        const win = makeWindow()
        const mgr = new BrowserViewManager(makeWindowManager('win-1', win))
        mgr.create('sess-1', 'win-1')

        await expect(mgr.navigate('sess-1', 'blob:https://example.com/abc')).rejects.toThrow(/dangerous scheme/)
      })

      it('裸域名被拒（不是 http/https 白名单）', async () => {
        const win = makeWindow()
        const mgr = new BrowserViewManager(makeWindowManager('win-1', win))
        mgr.create('sess-1', 'win-1')

        await expect(mgr.navigate('sess-1', 'example.com')).rejects.toThrow(/only http\(s\) URLs/)
      })

      it('大小写不敏感（JavaScript: 大小写变体被拒）', async () => {
        const win = makeWindow()
        const mgr = new BrowserViewManager(makeWindowManager('win-1', win))
        mgr.create('sess-1', 'win-1')

        await expect(mgr.navigate('sess-1', 'JavaScript:alert(1)')).rejects.toThrow(/dangerous scheme/)
      })

      it('scheme 校验失败时 pendingAutoFit 不置 true（loadURL 未触发）', async () => {
        const win = makeWindow()
        const mgr = new BrowserViewManager(makeWindowManager('win-1', win))
        mgr.create('sess-1', 'win-1')
        const loadURLSpy = vi.spyOn(createdViews[0].wc, 'loadURL')

        await expect(mgr.navigate('sess-1', 'file:///etc/passwd')).rejects.toThrow(/dangerous scheme/)
        // pendingAutoFit 保持 false：下次 dom-ready 不会误触发 autoFit 缩放
        // 间接验证：navigate 后 webContents.loadURL 调用次数 = 0
        expect(loadURLSpy).not.toHaveBeenCalled()
      })
    })
  })

  describe('hide / show', () => {
    it('hide 从 contentView 移除 view 并 setBounds 隐藏；show 重新挂载并恢复 rect', () => {
      const win = makeWindow()
      const mgr = new BrowserViewManager(makeWindowManager('win-1', win))
      mgr.create('sess-1', 'win-1')
      // 通过 setRect 设置 lastRect（由 setRect 正确维护，hide 不再覆盖）
      mgr.setRect('sess-1', { x: 10, y: 10, width: 200, height: 300 })

      mgr.hide('sess-1')
      // hide 时从 contentView 移除 + setBounds 为 {0,0,0,0}
      const hideBoundsCall = createdViews[0].setBounds.mock.calls.at(-1)![0]
      expect(hideBoundsCall).toEqual({ x: 0, y: 0, width: 0, height: 0 })
      // 验证 view 从 contentView 移除
      expect(win.contentView.removeChildView).toHaveBeenCalledTimes(1)

      mgr.show('sess-1')
      // show 时重新挂载到 contentView + 恢复 lastRect
      const showBoundsCall = createdViews[0].setBounds.mock.calls.at(-1)![0]
      expect(showBoundsCall).toEqual({ x: 10, y: 10, width: 200, height: 300 })
      // 验证 view 重新挂载到 contentView
      expect(win.contentView.addChildView).toHaveBeenCalledTimes(2) // create + show
    })

    it('hide/show 不存在的 session 幂等无操作', () => {
      const mgr = new BrowserViewManager(makeWindowManager('win-1', makeWindow()))
      expect(() => mgr.hide('nope')).not.toThrow()
      expect(() => mgr.show('nope')).not.toThrow()
    })
  })

  describe('失败路径日志（PR #100 W1）', () => {
    it('setRect / hide / show / destroy 对不存在 session 走 console.warn，不再静默', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const mgr = new BrowserViewManager(makeWindowManager('win-1', makeWindow()))
      mgr.setRect('nope', { x: 0, y: 0, width: 10, height: 10 })
      mgr.hide('nope')
      mgr.show('nope')
      mgr.destroy('nope')

      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('setRect: session not found'))
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('hide: session not found'))
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('show: session not found'))
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('destroy: session not found'))
      warnSpy.mockRestore()
    })

    it('focus target 不存在时走 console.debug（spec 允许的 LRU 淘汰场景）', () => {
      const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {})
      const mgr = new BrowserViewManager(makeWindowManager('win-1', makeWindow()))
      mgr.focus('never-created')
      expect(debugSpy).toHaveBeenCalledWith(expect.stringContaining('focus: target not found'))
      debugSpy.mockRestore()
    })

    it('focus target 存在时静默（现有场景无 DEBUG 噪声）', () => {
      const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {})
      const win = makeWindow()
      const mgr = new BrowserViewManager(makeWindowManager('win-1', win))
      mgr.create('sess-1', 'win-1')
      debugSpy.mockClear()
      mgr.focus('sess-1')
      expect(debugSpy).not.toHaveBeenCalled()
      debugSpy.mockRestore()
    })
  })

  describe('setRect + isVisible（Wave 3）', () => {
    it('create 后 isVisible=false；show 后 isVisible=true；hide 后=false', () => {
      const win = makeWindow()
      const mgr = new BrowserViewManager(makeWindowManager('win-1', win))
      mgr.create('sess-1', 'win-1')
      // 模拟 view 当前真实 rect（show 后 getBounds 返回此值）
      createdViews[0].getBounds.mockReturnValue({ x: 10, y: 10, width: 200, height: 300 })

      // 初始隐藏：setRect 仅更新 lastRect，不 setBounds（isVisible=false）
      mgr.setRect('sess-1', { x: 5, y: 5, width: 100, height: 100 })
      const setBoundsCountAfterSetRect = createdViews[0].setBounds.mock.calls.length

      // show：isVisible=true，setBounds(lastRect=刚推的 rect)
      mgr.show('sess-1')
      const showBoundsCall = createdViews[0].setBounds.mock.calls.at(-1)![0]
      expect(showBoundsCall).toEqual({ x: 5, y: 5, width: 100, height: 100 })

      // 可见态 setRect：立即 setBounds（增量调用）
      mgr.setRect('sess-1', { x: 20, y: 20, width: 300, height: 400 })
      expect(createdViews[0].setBounds.mock.calls.length).toBeGreaterThan(setBoundsCountAfterSetRect + 1)
      const lastBoundsCall = createdViews[0].setBounds.mock.calls.at(-1)![0]
      expect(lastBoundsCall).toEqual({ x: 20, y: 20, width: 300, height: 400 })

      // hide：isVisible=false，setBounds(HIDDEN_RECT)
      mgr.hide('sess-1')
      const hideBoundsCall = createdViews[0].setBounds.mock.calls.at(-1)![0]
      expect(hideBoundsCall).toEqual({ x: 0, y: 0, width: 0, height: 0 })

      // 隐藏态 setRect：仅更新 lastRect，不 setBounds（防 hide 中 resize 意外重显）
      const countBeforeHiddenSetRect = createdViews[0].setBounds.mock.calls.length
      mgr.setRect('sess-1', { x: 50, y: 50, width: 500, height: 600 })
      expect(createdViews[0].setBounds.mock.calls.length).toBe(countBeforeHiddenSetRect)

      // 再次 show：setBounds(lastRect=隐藏态推的最新 rect)
      mgr.show('sess-1')
      const reShowBoundsCall = createdViews[0].setBounds.mock.calls.at(-1)![0]
      expect(reShowBoundsCall).toEqual({ x: 50, y: 50, width: 500, height: 600 })
    })

    it('setRect 不存在的 session 幂等无操作', () => {
      const mgr = new BrowserViewManager(makeWindowManager('win-1', makeWindow()))
      expect(() => mgr.setRect('nope', { x: 0, y: 0, width: 10, height: 10 })).not.toThrow()
    })

    it('show 前未推 rect 时 setBounds(HIDDEN_RECT)（create 默认 lastRect）', () => {
      const win = makeWindow()
      const mgr = new BrowserViewManager(makeWindowManager('win-1', win))
      mgr.create('sess-1', 'win-1')
      // 不调 setRect 直接 show：lastRect 仍是 HIDDEN_RECT
      mgr.show('sess-1')
      const showBoundsCall = createdViews[0].setBounds.mock.calls.at(-1)![0]
      expect(showBoundsCall).toEqual({ x: 0, y: 0, width: 0, height: 0 })
    })

    it('PR #100 W2：create 调 addChildView 1 次，setRect 不重复 addChildView（仅 setBounds）', () => {
      const win = makeWindow()
      const mgr = new BrowserViewManager(makeWindowManager('win-1', win))
      mgr.create('sess-1', 'win-1')

      // create 调一次 addChildView
      expect(win.contentView.addChildView).toHaveBeenCalledTimes(1)

      // 推多次 setRect：visible 态只 setBounds，不重复 addChildView
      mgr.show('sess-1') // visible=true
      mgr.setRect('sess-1', { x: 5, y: 5, width: 100, height: 100 })
      mgr.setRect('sess-1', { x: 10, y: 10, width: 200, height: 200 })
      mgr.setRect('sess-1', { x: 20, y: 20, width: 300, height: 300 })

      // addChildView 仍仅 1 次（create 那次）
      expect(win.contentView.addChildView).toHaveBeenCalledTimes(1)
      // setBounds 被多次调（visible 态）
      expect(createdViews[0].setBounds.mock.calls.length).toBeGreaterThan(1)
    })

    it('PR #100 W2：hide 态 setRect 不调 addChildView（防御性，防隐藏中意外重显）', () => {
      const win = makeWindow()
      const mgr = new BrowserViewManager(makeWindowManager('win-1', win))
      mgr.create('sess-1', 'win-1')
      expect(win.contentView.addChildView).toHaveBeenCalledTimes(1)

      // 不调 show（保持 hide 态）→ setRect 不应触发 addChildView
      mgr.setRect('sess-1', { x: 5, y: 5, width: 100, height: 100 })
      expect(win.contentView.addChildView).toHaveBeenCalledTimes(1)
    })
  })

  describe('destroy', () => {
    it('destroy 先 removeChildView 再 webContents.close（[HISTORICAL] 顺序）', () => {
      const win = makeWindow()
      const mgr = new BrowserViewManager(makeWindowManager('win-1', win))
      mgr.create('sess-1', 'win-1')
      const view = createdViews[0]

      mgr.destroy('sess-1')

      expect(win.contentView.removeChildView).toHaveBeenCalledTimes(1)
      // webContents.close 被调用（Electron 42 销毁 webContents 的正确 API）
      expect(view.wc.destroyed).toBe(true)
      // 之后 getState 返回 null
      expect(mgr.getState('sess-1')).toBeNull()
    })

    it('destroy 幂等（再次调用不抛错）', () => {
      const win = makeWindow()
      const mgr = new BrowserViewManager(makeWindowManager('win-1', win))
      mgr.create('sess-1', 'win-1')
      mgr.destroy('sess-1')
      expect(() => mgr.destroy('sess-1')).not.toThrow()
    })

    it('窗口已销毁时跳过 removeChildView，但仍 close webContents', () => {
      const win = makeWindow()
      const mgr = new BrowserViewManager(makeWindowManager('win-1', win))
      mgr.create('sess-1', 'win-1')

      // 模拟 destroy 时窗口已关
      win.isDestroyed = () => true
      const view = createdViews[0]
      mgr.destroy('sess-1')

      expect(win.contentView.removeChildView).not.toHaveBeenCalled()
      expect(view.wc.destroyed).toBe(true)
    })
  })

  describe('状态暂存（webContents 事件 → state）', () => {
    it('did-navigate 更新 currentUrl 并清空 error', () => {
      const win = makeWindow()
      const mgr = new BrowserViewManager(makeWindowManager('win-1', win))
      mgr.create('sess-1', 'win-1')

      // 先制造一个 error（用非 ABORTED 错误码，-3 已被过滤）
      createdViews[0].wc.listeners.get('did-fail-load')![0](undefined, -105, 'ERR_NAME_NOT_RESOLVED', 'https://x')
      expect(mgr.getState('sess-1')!.error).not.toBeNull()

      // did-navigate 清空 error 并设 currentUrl
      createdViews[0].wc.listeners.get('did-navigate')![0](undefined, 'https://example.com', 200, 'OK')
      const state = mgr.getState('sess-1')!
      expect(state.currentUrl).toBe('https://example.com')
      expect(state.error).toBeNull()
    })

    it('did-navigate-in-page 更新 currentUrl', () => {
      const win = makeWindow()
      const mgr = new BrowserViewManager(makeWindowManager('win-1', win))
      mgr.create('sess-1', 'win-1')

      createdViews[0].wc.listeners.get('did-navigate-in-page')![0](undefined, 'https://example.com/page#hash')
      expect(mgr.getState('sess-1')!.currentUrl).toBe('https://example.com/page#hash')
    })

    it('did-fail-load 记录 error（ABORTED -3 过滤：重定向正常取消不算错误）', () => {
      const win = makeWindow()
      const mgr = new BrowserViewManager(makeWindowManager('win-1', win))
      mgr.create('sess-1', 'win-1')

      // -3 ABORTED（重定向过程中的正常取消）应被过滤，不记录 error
      createdViews[0].wc.listeners.get('did-fail-load')![0](undefined, -3, 'ERR_ABORTED', 'https://redirecting')
      expect(mgr.getState('sess-1')!.error).toBeNull()

      // 真错误（如 -105 ERR_NAME_NOT_RESOLVED）应记录
      createdViews[0].wc.listeners.get('did-fail-load')![0](undefined, -105, 'ERR_NAME_NOT_RESOLVED', 'https://blocked')
      const state = mgr.getState('sess-1')!
      expect(state.error).toEqual({ errorCode: -105, errorDescription: 'ERR_NAME_NOT_RESOLVED', validatedURL: 'https://blocked' })
    })

    it('did-start-loading / did-stop-loading 切换 isLoading', () => {
      const win = makeWindow()
      const mgr = new BrowserViewManager(makeWindowManager('win-1', win))
      mgr.create('sess-1', 'win-1')

      createdViews[0].wc.listeners.get('did-start-loading')![0]()
      expect(mgr.getState('sess-1')!.isLoading).toBe(true)

      createdViews[0].wc.listeners.get('did-stop-loading')![0]()
      expect(mgr.getState('sess-1')!.isLoading).toBe(false)
    })
  })

  describe('onStateChange 回调推送（W2）', () => {
    it('did-navigate / did-start-loading 触发 onStateChange，携带 sessionId + state', () => {
      const onStateChange = vi.fn()
      const win = makeWindow()
      const mgr = new BrowserViewManager(makeWindowManager('win-1', win), onStateChange)
      mgr.create('sess-1', 'win-1')

      // did-start-loading → isLoading: true
      createdViews[0].wc.listeners.get('did-start-loading')![0]()
      expect(onStateChange).toHaveBeenLastCalledWith('sess-1', expect.objectContaining({ isLoading: true }))

      // did-navigate → currentUrl 更新 + error 清空
      createdViews[0].wc.listeners.get('did-navigate')![0](undefined, 'https://example.com')
      expect(onStateChange).toHaveBeenLastCalledWith(
        'sess-1',
        expect.objectContaining({ currentUrl: 'https://example.com', error: null }),
      )
    })

    it('未注入 onStateChange 时（旧调用方）内部 state 仍更新，不抛错', () => {
      const win = makeWindow()
      // 不传第二参数（向后兼容：Wave 1 调用方 new BrowserViewManager(windows)）
      const mgr = new BrowserViewManager(makeWindowManager('win-1', win))
      mgr.create('sess-1', 'win-1')

      expect(() => {
        createdViews[0].wc.listeners.get('did-navigate')![0](undefined, 'https://example.com')
      }).not.toThrow()
      expect(mgr.getState('sess-1')!.currentUrl).toBe('https://example.com')
    })
  })

  describe('历史导航 + 缩放（Wave 5）', () => {
    it('canGoBack / canGoForward 透传 webContents.navigationHistory，不存在 session 返回 false', () => {
      const win = makeWindow()
      const mgr = new BrowserViewManager(makeWindowManager('win-1', win))
      mgr.create('sess-1', 'win-1')

      // 默认桩返回 false
      expect(mgr.canGoBack('sess-1')).toBe(false)
      expect(mgr.canGoForward('sess-1')).toBe(false)

      // 改写桩返回 true
      createdViews[0].wc.navigationHistory.canGoBack.mockReturnValue(true)
      createdViews[0].wc.navigationHistory.canGoForward.mockReturnValue(true)
      expect(mgr.canGoBack('sess-1')).toBe(true)
      expect(mgr.canGoForward('sess-1')).toBe(true)

      // 不存在 session 一律 false
      expect(mgr.canGoBack('nope')).toBe(false)
      expect(mgr.canGoForward('nope')).toBe(false)
    })

    it('goBack / goForward 在可导航时调 navigationHistory.goBack/goForward', () => {
      const win = makeWindow()
      const mgr = new BrowserViewManager(makeWindowManager('win-1', win))
      mgr.create('sess-1', 'win-1')
      const nav = createdViews[0].wc.navigationHistory

      // canGoBack=false 时无操作
      mgr.goBack('sess-1')
      expect(nav.goBack).not.toHaveBeenCalled()

      nav.canGoBack.mockReturnValue(true)
      mgr.goBack('sess-1')
      expect(nav.goBack).toHaveBeenCalledTimes(1)

      // canGoForward=false 时无操作
      mgr.goForward('sess-1')
      expect(nav.goForward).not.toHaveBeenCalled()

      nav.canGoForward.mockReturnValue(true)
      mgr.goForward('sess-1')
      expect(nav.goForward).toHaveBeenCalledTimes(1)
    })

    it('goBack / goForward / setZoomFactor / getZoomFactor 对不存在 session 幂等无操作', () => {
      const mgr = new BrowserViewManager(makeWindowManager('win-1', makeWindow()))
      expect(() => mgr.goBack('nope')).not.toThrow()
      expect(() => mgr.goForward('nope')).not.toThrow()
      expect(() => mgr.setZoomFactor('nope', 1.25)).not.toThrow()
      expect(mgr.getZoomFactor('nope')).toBe(1.0)
    })

    it('setZoomFactor / getZoomFactor 读写 webContents 缩放因子', () => {
      const win = makeWindow()
      const mgr = new BrowserViewManager(makeWindowManager('win-1', win))
      mgr.create('sess-1', 'win-1')

      // 默认 1.0
      expect(mgr.getZoomFactor('sess-1')).toBe(1)

      mgr.setZoomFactor('sess-1', 1.25)
      expect(mgr.getZoomFactor('sess-1')).toBe(1.25)

      mgr.setZoomFactor('sess-1', 0.75)
      expect(mgr.getZoomFactor('sess-1')).toBe(0.75)
    })

    it('notify 在事件推送时同步 canGoBack / canGoForward 到 state', () => {
      const onStateChange = vi.fn()
      const win = makeWindow()
      const mgr = new BrowserViewManager(makeWindowManager('win-1', win), onStateChange)
      mgr.create('sess-1', 'win-1')

      // 改写桩：did-navigate 触发 notify 后，state.canGoBack 应为 true
      createdViews[0].wc.navigationHistory.canGoBack.mockReturnValue(true)
      createdViews[0].wc.navigationHistory.canGoForward.mockReturnValue(false)

      createdViews[0].wc.listeners.get('did-navigate')![0](undefined, 'https://example.com')
      const state = mgr.getState('sess-1')!
      expect(state.canGoBack).toBe(true)
      expect(state.canGoForward).toBe(false)
      expect(onStateChange).toHaveBeenLastCalledWith(
        'sess-1',
        expect.objectContaining({ canGoBack: true, canGoForward: false }),
      )
    })

    it('create 初始化 state.canGoBack / canGoForward 为 false', () => {
      const win = makeWindow()
      const mgr = new BrowserViewManager(makeWindowManager('win-1', win))
      mgr.create('sess-1', 'win-1')
      const state = mgr.getState('sess-1')!
      expect(state.canGoBack).toBe(false)
      expect(state.canGoForward).toBe(false)
    })
  })

  describe('autoFit 自动缩放（navigate 后 dom-ready 触发）', () => {
    // 触发 dom-ready 并 flush 异步链（executeJavaScript 返回 Promise，.then 链需 await）
    async function fireDomReady(wc: { listeners: Map<string, WcListener[]> }): Promise<void> {
      wc.listeners.get('dom-ready')![0]()
      // executeJavaScript 链：viewport 注入 .then → autoFit 读 dims .then → setZoomFactor。
      // 需多轮 microtask flush（每个 .then 一轮）
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    }

    it('navigate 后 dom-ready：scrollWidth > innerWidth（溢出）→ setZoomFactor(viewW/scrollW)', async () => {
      const win = makeWindow()
      const onStateChange = vi.fn()
      const mgr = new BrowserViewManager(makeWindowManager('win-1', win), onStateChange)
      mgr.create('sess-1', 'win-1')

      // 第一次 executeJavaScript（viewport 注入）resolve undefined；第二次（读 dims）返回 [800, 600]
      const wc = createdViews[0].wc
      let callCount = 0
      wc.executeJavaScript = vi.fn(() => {
        callCount++
        // 第一次返回 undefined（viewport 注入完成），第二次返回 [scrollWidth, innerWidth]
        return Promise.resolve(callCount === 2 ? [800, 600] : undefined)
      })

      await mgr.navigate('sess-1', 'https://baidu.com') // 设 pendingAutoFit=true
      await fireDomReady(wc)

      // fitFactor = 600 / 800 = 0.75
      expect(wc.zoomFactor).toBe(0.75)
      // state.zoomFactor 同步 + onStateChange 推送（renderer 据此更新 useBrowserZoom 基准）
      expect(mgr.getState('sess-1')!.zoomFactor).toBe(0.75)
      expect(onStateChange).toHaveBeenLastCalledWith('sess-1', expect.objectContaining({ zoomFactor: 0.75 }))
    })

    it('navigate 后 dom-ready：scrollWidth <= innerWidth（不溢出）→ 不缩放', async () => {
      const win = makeWindow()
      const mgr = new BrowserViewManager(makeWindowManager('win-1', win))
      mgr.create('sess-1', 'win-1')

      const wc = createdViews[0].wc
      let callCount = 0
      wc.executeJavaScript = vi.fn(() => {
        callCount++
        return Promise.resolve(callCount === 2 ? [600, 600] : undefined) // scrollWidth == innerWidth
      })

      await mgr.navigate('sess-1', 'https://example.com')
      await fireDomReady(wc)

      // 不溢出 → zoomFactor 保持默认 1
      expect(wc.zoomFactor).toBe(1)
      expect(mgr.getState('sess-1')!.zoomFactor).toBe(1)
    })

    it('未 navigate 直接触发 dom-ready（页内链接/后退前进）→ pendingAutoFit=false，不缩放', async () => {
      const win = makeWindow()
      const mgr = new BrowserViewManager(makeWindowManager('win-1', win))
      mgr.create('sess-1', 'win-1')

      const wc = createdViews[0].wc
      let callCount = 0
      wc.executeJavaScript = vi.fn(() => {
        callCount++
        // 即使返回溢出数据，因 pendingAutoFit=false，第二次 executeJavaScript 不应被调用
        return Promise.resolve(callCount === 2 ? [1000, 400] : undefined)
      })

      // 不调 navigate，直接触发 dom-ready（模拟页内链接跳转）
      await fireDomReady(wc)

      // executeJavaScript 只被调用 1 次（viewport 注入），第二次（autoFit 读 dims）因 pendingAutoFit=false 跳过
      expect(callCount).toBe(1)
      expect(wc.zoomFactor).toBe(1)
    })

    it('fitFactor 低于下限 0.5 时钳制到 0.5（保可读性，接受部分溢出）', async () => {
      const win = makeWindow()
      const mgr = new BrowserViewManager(makeWindowManager('win-1', win))
      mgr.create('sess-1', 'win-1')

      const wc = createdViews[0].wc
      let callCount = 0
      wc.executeJavaScript = vi.fn(() => {
        callCount++
        // scrollWidth=2000, innerWidth=400 → fitFactor=0.2，应钳制到 0.5
        return Promise.resolve(callCount === 2 ? [2000, 400] : undefined)
      })

      await mgr.navigate('sess-1', 'https://wide-page.com')
      await fireDomReady(wc)

      expect(wc.zoomFactor).toBe(0.5)
    })

    it('用户手动 setZoomFactor 后 state.zoomFactor 同步 + notify renderer', () => {
      const onStateChange = vi.fn()
      const win = makeWindow()
      const mgr = new BrowserViewManager(makeWindowManager('win-1', win), onStateChange)
      mgr.create('sess-1', 'win-1')

      mgr.setZoomFactor('sess-1', 1.5)
      expect(mgr.getState('sess-1')!.zoomFactor).toBe(1.5)
      expect(onStateChange).toHaveBeenLastCalledWith('sess-1', expect.objectContaining({ zoomFactor: 1.5 }))
    })
  })
})
