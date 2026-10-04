/**
 * 层级共存守卫单测（display-containers §7.4 / §5.1 规则 6——S9/S10 主进程侧断言）。
 *
 * 覆盖：
 * 1. 纯策略（gateway/display-gate.ts）：双阈值空间滞回两半边（from shown / from hidden）+
 *    缓冲带双向保持 + show 统一谓词真值表 + IPC payload 解析（error envelope 边界用例）。
 * 2. BrowserViewManager 组装（S9/S10 主进程侧断言）：
 *    - S9：Toast 类 shieldsView rect 在缓冲带内往返 → view 无显隐翻转（from shown 半边）；
 *      相交隐藏后 rect 退到带内 → view 保持隐藏（from hidden 半边——区分单阈值退化的唯一判别态）；
 *      全屏阻塞面无条件隐藏 / 全关恢复（keep-alive 不丢状态）；
 *    - S10：关浮层 → 切走 → 切回 → 无 view 复显（focus 收口，防残影）；
 *      浮层开着切 session → 换显豁免（浮层随行，视口不空白）；
 *    - 错误态联动隐藏 + 重试成功恢复（did-fail-load / render-process-gone 两类占位区分）；
 *    - 会话删除级联 browserDestroy（浮层态复位）+ 反向断言（删非发起会话浮层不动）。
 *
 * 运行：cd apps/electron/main && npx vitest run test/browser-display-gate.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { IWindowManager } from '../interfaces.js'
import {
  CLOSED_OVERLAY,
  SHIELD_HYSTERESIS_PADDING_PX,
  computeShouldShow,
  expandRect,
  isOverlayBrowserActive,
  nextShieldHidden,
  parseOverlayDisplayState,
  parseShieldFacesPayload,
  rectsIntersect,
  type DisplayRect,
  type ShieldFace,
} from '../browser/gateway/display-gate.js'

// ── 纯策略 ─────────────────────────────────────────────────────

const VIEW_RECT: DisplayRect = { x: 100, y: 100, width: 400, height: 300 }
/** 缓冲带：与外扩矩形（76,76,448,348）相交、与原始矩形不相交 */
const BAND_FACE: ShieldFace = { id: 'toast', fullscreen: false, rect: { x: 60, y: 100, width: 30, height: 30 } }
/** 真重叠：与原始矩形相交 */
const OVERLAP_FACE: ShieldFace = { id: 'toast', fullscreen: false, rect: { x: 120, y: 120, width: 50, height: 50 } }
/** 明确分离：与外扩矩形也不相交 */
const FAR_FACE: ShieldFace = { id: 'toast', fullscreen: false, rect: { x: 0, y: 0, width: 50, height: 50 } }

describe('display-gate 纯策略', () => {
  it('rectsIntersect：边重叠不算相交（严格不等号）', () => {
    expect(rectsIntersect(VIEW_RECT, OVERLAP_FACE.rect!)).toBe(true)
    expect(rectsIntersect(VIEW_RECT, FAR_FACE.rect!)).toBe(false)
    expect(rectsIntersect(VIEW_RECT, { x: 500, y: 100, width: 10, height: 10 })).toBe(false)
  })

  it('expandRect：四边各外扩 px', () => {
    expect(expandRect({ x: 10, y: 20, width: 100, height: 50 }, SHIELD_HYSTERESIS_PADDING_PX)).toEqual({
      x: 10 - SHIELD_HYSTERESIS_PADDING_PX,
      y: 20 - SHIELD_HYSTERESIS_PADDING_PX,
      width: 100 + SHIELD_HYSTERESIS_PADDING_PX * 2,
      height: 50 + SHIELD_HYSTERESIS_PADDING_PX * 2,
    })
  })

  it('滞回 from shown 半边：缓冲带内往返不翻转（进入=原始矩形相交）', () => {
    // shown（prev=false）：缓冲带内两切换条件皆假 → 保持 shown
    expect(nextShieldHidden(false, [BAND_FACE], VIEW_RECT)).toBe(false)
    // 真重叠才进入隐藏
    expect(nextShieldHidden(false, [OVERLAP_FACE], VIEW_RECT)).toBe(true)
    expect(nextShieldHidden(false, [{ id: 'modal', fullscreen: true }], VIEW_RECT)).toBe(true)
    // 明确分离 → 保持 shown
    expect(nextShieldHidden(false, [FAR_FACE], VIEW_RECT)).toBe(false)
    expect(nextShieldHidden(false, [], VIEW_RECT)).toBe(false)
  })

  it('滞回 from hidden 半边：缓冲带内保持隐藏（退出=外扩矩形仍不相交）', () => {
    // hidden（prev=true）：缓冲带内（外扩相交 ∧ 原始不相交）→ 保持隐藏（单阈值化会在此错误恢复）
    expect(nextShieldHidden(true, [BAND_FACE], VIEW_RECT)).toBe(true)
    // 真重叠 → 保持隐藏
    expect(nextShieldHidden(true, [OVERLAP_FACE], VIEW_RECT)).toBe(true)
    // 明确分离（外扩矩形仍不相交）→ 恢复
    expect(nextShieldHidden(true, [FAR_FACE], VIEW_RECT)).toBe(false)
    // 全部遮蔽面消失 → 恢复
    expect(nextShieldHidden(true, [], VIEW_RECT)).toBe(false)
  })

  it('滞回互斥性：进入条件为真时退出条件必假（缓冲带内两条件皆假、双向保持）', () => {
    // 任一进入命中（原始相交）⟹ 该面必与外扩矩形相交 ⟹ 退出条件假（不构造反滞回振荡）
    for (const face of [OVERLAP_FACE, BAND_FACE, FAR_FACE]) {
      const enters = nextShieldHidden(false, [face], VIEW_RECT)
      const exits = !nextShieldHidden(true, [face], VIEW_RECT)
      expect(enters && exits).toBe(false)
    }
  })

  it('fullscreen 面无条件隐藏；rect 缺失的非全屏面保守按相交处理（fail-safe）', () => {
    expect(nextShieldHidden(false, [{ id: 'modal', fullscreen: true }], VIEW_RECT)).toBe(true)
    expect(nextShieldHidden(true, [{ id: 'modal', fullscreen: true }], VIEW_RECT)).toBe(true)
    expect(nextShieldHidden(false, [{ id: 'broken', fullscreen: false }], VIEW_RECT)).toBe(true)
    expect(nextShieldHidden(true, [{ id: 'broken', fullscreen: false }], VIEW_RECT)).toBe(true)
  })

  it('show 统一谓词真值表（§7.4 R3 收口）', () => {
    const base = { overlay: { open: true, content: 'browser' as const, sessionId: 'A' }, sessionId: 'A', hasError: false, shieldHidden: false }
    expect(computeShouldShow(base)).toBe(true)
    expect(computeShouldShow({ ...base, overlay: CLOSED_OVERLAY })).toBe(false)
    expect(computeShouldShow({ ...base, overlay: { open: true, content: 'workflow', sessionId: 'A' } })).toBe(false)
    expect(computeShouldShow({ ...base, sessionId: 'B' })).toBe(false) // 非浮层发起会话
    expect(computeShouldShow({ ...base, hasError: true })).toBe(false) // 错误态
    expect(computeShouldShow({ ...base, shieldHidden: true })).toBe(false) // 相交 shieldsView 面
  })

  it('浮层随行豁免谓词：仅「浮层开 ∧ 内容 browser」豁免', () => {
    expect(isOverlayBrowserActive({ open: true, content: 'browser', sessionId: 'A' })).toBe(true)
    expect(isOverlayBrowserActive({ open: true, content: 'workflow', sessionId: 'A' })).toBe(false)
    expect(isOverlayBrowserActive(CLOSED_OVERLAY)).toBe(false)
  })

  describe('IPC payload 解析（error envelope + 边界用例）', () => {
    it('overlay-state：合法形态归一（含关闭态归一）', () => {
      expect(parseOverlayDisplayState({ open: true, content: 'browser', sessionId: 'A' })).toEqual({ open: true, content: 'browser', sessionId: 'A' })
      expect(parseOverlayDisplayState({ open: false, content: 'browser', sessionId: 'A' })).toEqual(CLOSED_OVERLAY)
    })

    it('overlay-state：非法 payload 抛错（error envelope 带原因）', () => {
      expect(() => parseOverlayDisplayState(null)).toThrow(/payload must be an object/)
      expect(() => parseOverlayDisplayState({ open: 'yes' })).toThrow(/open must be a boolean/)
      expect(() => parseOverlayDisplayState({ open: true, content: 'drawer', sessionId: 'A' })).toThrow(/content must be/)
      expect(() => parseOverlayDisplayState({ open: true, content: 'browser', sessionId: '' })).toThrow(/sessionId must be a non-empty string/)
      expect(() => parseOverlayDisplayState({ open: true, content: 'browser' })).toThrow(/sessionId must be a non-empty string/)
    })

    it('shields：合法形态（fullscreen 无 rect / 非全屏带 rect）', () => {
      expect(parseShieldFacesPayload({ faces: [{ id: 'modal', fullscreen: true }] })).toEqual([{ id: 'modal', fullscreen: true }])
      expect(
        parseShieldFacesPayload({ faces: [{ id: 'toast', fullscreen: false, rect: { x: 1, y: 2, width: 3, height: 4 } }] }),
      ).toEqual([{ id: 'toast', fullscreen: false, rect: { x: 1, y: 2, width: 3, height: 4 } }])
    })

    it('shields：非法 payload 抛错（error envelope 带原因）', () => {
      expect(() => parseShieldFacesPayload({ faces: 'x' })).toThrow(/faces must be an array/)
      expect(() => parseShieldFacesPayload({ faces: [{ id: '', fullscreen: true }] })).toThrow(/id must be a non-empty string/)
      expect(() => parseShieldFacesPayload({ faces: [{ id: 'a', fullscreen: 'yes' }] })).toThrow(/fullscreen must be a boolean/)
      expect(() => parseShieldFacesPayload({ faces: [{ id: 'a', fullscreen: false, rect: { x: 0, y: 0, width: -1, height: 4 } }] })).toThrow(/rect must be/)
      expect(() => parseShieldFacesPayload({})).toThrow(/faces must be an array/)
    })
  })
})

// ── BrowserViewManager 组装（S9/S10 主进程侧断言）──────────────

type WcListener = (...args: unknown[]) => void

const hoisted = vi.hoisted(() => {
  const createdViews: Array<{
    setBounds: ReturnType<typeof vi.fn>
    wc: {
      listeners: Map<string, WcListener[]>
      destroyed: boolean
      navigationHistory: { canGoBack: () => boolean; canGoForward: () => boolean; goBack: () => void; goForward: () => void }
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- WebContentsView mock 构造器this 形态：vi.fn 集合已显式类型，仅构造器 this 别名豁免
  const WebContentsViewMock = function (this: any) {
    const listeners = new Map<string, WcListener[]>()
    const wc = {
      listeners,
      destroyed: false,
      navigationHistory: { canGoBack: () => false, canGoForward: () => false, goBack: () => {}, goForward: () => {} },
      loadURL: () => Promise.resolve(),
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
      setZoomFactor: () => {},
      getZoomFactor: () => 1,
      executeJavaScript: vi.fn(() => Promise.resolve(undefined)),
      setWindowOpenHandler: vi.fn(),
      session: { on: vi.fn() },
    }
    const setBounds = vi.fn()
    createdViews.push({ setBounds, wc })
    this.setBounds = setBounds
    this.getBounds = vi.fn(() => ({ x: 0, y: 0, width: 100, height: 100 }))
    this.webContents = wc
  }
  return { createdViews, WebContentsViewMock }
})

vi.mock('electron', () => ({
  WebContentsView: vi.fn(hoisted.WebContentsViewMock as never),
  shell: { openExternal: vi.fn(() => Promise.resolve()) },
}))

import { BrowserViewManager } from '../browser/browser-view-manager.js'

function makeWindowManager(windowId: string, win: object): IWindowManager {
  return { get: (id: string) => (id === windowId ? win : undefined) } as unknown as IWindowManager
}

function makeWindow() {
  return {
    isDestroyed: () => false,
    contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
    webContents: { send: vi.fn() },
  }
}

function lastBounds(view: (typeof hoisted.createdViews)[number]): unknown {
  return view.setBounds.mock.calls.at(-1)?.[0]
}

const HIDDEN = { x: 0, y: 0, width: 0, height: 0 }

describe('BrowserViewManager × 层级共存守卫（S9/S10 主进程侧断言）', () => {
  beforeEach(() => {
    hoisted.createdViews.length = 0
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'debug').mockImplementation(() => {})
  })

  /** 建 A 会话 view + 开浮层 browser + 推 rect（谓词为真、view 可见） */
  function setupVisibleA() {
    const win = makeWindow()
    const mgr = new BrowserViewManager(makeWindowManager('win-1', win))
    mgr.create('A', 'win-1')
    mgr.setOverlayState({ open: true, content: 'browser', sessionId: 'A' })
    mgr.setRect('A', VIEW_RECT)
    return { win, mgr, view: hoisted.createdViews[0] }
  }

  describe('S9：shieldsView 联动 + 双阈值滞回两半边', () => {
    it('from shown 半边：缓冲带内往返 → view 无显隐翻转；真重叠才隐藏；明确分离恢复', () => {
      const { win, mgr, view } = setupVisibleA()
      expect(lastBounds(view)).toEqual(VIEW_RECT)

      // 缓冲带（外扩相交 ∧ 原始不相交）→ 不隐藏（from shown 保持）
      mgr.setShieldsViewFaces([BAND_FACE])
      expect(lastBounds(view)).toEqual(VIEW_RECT)
      expect(win.contentView.removeChildView).not.toHaveBeenCalled()

      // 带内往返（rect 在带内换位置）→ 仍无翻转
      mgr.setShieldsViewFaces([{ ...BAND_FACE, rect: { x: 70, y: 200, width: 20, height: 20 } }])
      expect(lastBounds(view)).toEqual(VIEW_RECT)

      // 真重叠（原始矩形相交）→ 隐藏（keep-alive：removeChildView + HIDDEN_RECT）
      mgr.setShieldsViewFaces([OVERLAP_FACE])
      expect(lastBounds(view)).toEqual(HIDDEN)
      expect(win.contentView.removeChildView).toHaveBeenCalledTimes(1)

      // 面消失 → 恢复显示（重试成功/全关恢复同谓词，keep-alive 不丢页面状态）
      mgr.setShieldsViewFaces([])
      expect(lastBounds(view)).toEqual(VIEW_RECT)
    })

    it('from hidden 半边：相交隐藏后 rect 退到缓冲带 → 保持隐藏；明确分离才恢复（区分单阈值退化）', () => {
      const { mgr, view } = setupVisibleA()

      mgr.setShieldsViewFaces([OVERLAP_FACE])
      expect(lastBounds(view)).toEqual(HIDDEN)

      // 退到缓冲带（外扩仍相交、原始已不相交）→ 保持隐藏（单阈值化/退出矩形拿错会在此错误恢复）
      mgr.setShieldsViewFaces([BAND_FACE])
      expect(lastBounds(view)).toEqual(HIDDEN)

      // 明确分离（外扩矩形仍不相交）→ 恢复
      mgr.setShieldsViewFaces([FAR_FACE])
      expect(lastBounds(view)).toEqual(VIEW_RECT)
    })

    it('全屏阻塞面无条件隐藏；全关恢复（§5.1 规则 6② 两档）', () => {
      const { mgr, view } = setupVisibleA()

      // 全屏面与 view 矩形不相交也无条件隐藏
      mgr.setShieldsViewFaces([{ id: 'modal', fullscreen: true, rect: FAR_FACE.rect }])
      expect(lastBounds(view)).toEqual(HIDDEN)

      mgr.setShieldsViewFaces([])
      expect(lastBounds(view)).toEqual(VIEW_RECT)
    })
  })

  describe('S9/S10：错误态联动 + 两类占位区分', () => {
    it('did-fail-load → state.error + 隐藏 view；导航成功清空并恢复（§5.1 规则 6①）', () => {
      const { mgr, view } = setupVisibleA()
      const wc = view.wc

      wc.listeners.get('did-fail-load')![0](undefined, -105, 'ERR_NAME_NOT_RESOLVED', 'https://x')
      expect(mgr.getState('A')!.error).toEqual({ errorCode: -105, errorDescription: 'ERR_NAME_NOT_RESOLVED', validatedURL: 'https://x' })
      expect(lastBounds(view)).toEqual(HIDDEN)

      // 重试成功（导航成功）→ 错误态清空 + 谓词恢复显示
      wc.listeners.get('did-navigate')![0](undefined, 'https://ok.dev')
      expect(mgr.getState('A')!.error).toBeNull()
      expect(lastBounds(view)).toEqual(VIEW_RECT)
    })

    it('render-process-gone → state.processGone（「创建失败」占位族）+ 隐藏 view；导航成功恢复', () => {
      const { mgr, view } = setupVisibleA()
      const wc = view.wc

      wc.listeners.get('render-process-gone')![0](undefined, { reason: 'oom', exitCode: 1 })
      expect(mgr.getState('A')!.processGone).toEqual({ reason: 'oom' })
      expect(lastBounds(view)).toEqual(HIDDEN)

      wc.listeners.get('did-navigate')![0](undefined, 'https://ok.dev')
      expect(mgr.getState('A')!.processGone).toBeNull()
      expect(lastBounds(view)).toEqual(VIEW_RECT)
    })

    it('ERR_ABORTED(-3) 过滤不进错误态（重定向正常取消不闪隐）', () => {
      const { mgr, view } = setupVisibleA()
      view.wc.listeners.get('did-fail-load')![0](undefined, -3, 'ERR_ABORTED', 'https://x')
      expect(mgr.getState('A')!.error).toBeNull()
      expect(lastBounds(view)).toEqual(VIEW_RECT)
    })

    it('错误态期间 shieldsView 全关也不恢复（谓词 AND 语义，不各触发独立 show）', () => {
      const { mgr, view } = setupVisibleA()
      view.wc.listeners.get('render-process-gone')![0](undefined, { reason: 'crashed' })
      mgr.setShieldsViewFaces([])
      expect(lastBounds(view)).toEqual(HIDDEN)
    })
  })

  describe('S10：focus 收口 + 浮层随行豁免 + 无残影', () => {
    it('关浮层 → 切走 → 切回 → 无 view 复显（focus 收口，防残影经 focus sync 旁路复活）', () => {
      const { win, mgr, view } = setupVisibleA()

      // ③ 关浮层 → 隐藏（keep-alive）
      mgr.setOverlayState({ ...CLOSED_OVERLAY })
      expect(lastBounds(view)).toEqual(HIDDEN)

      const removeCount = win.contentView.removeChildView.mock.calls.length
      // 切走（focus B，池内无 B view）
      mgr.focus('B')
      // 切回（focus A）→ 只隐藏不显示（非「浮层开 ∧ 内容 browser」态）
      mgr.focus('A')
      expect(lastBounds(view)).toEqual(HIDDEN)
      expect(win.contentView.removeChildView.mock.calls.length).toBe(removeCount) // 无新增显隐动作 = 无复显
    })

    it('浮层开着切 session：换显豁免（浮层随行，view 保持发起会话的，视口不空白）', () => {
      const { win, mgr, view } = setupVisibleA()
      mgr.create('B', 'win-1')
      const viewB = hoisted.createdViews[1]

      mgr.focus('B')
      // A 的 view 保持显示（不隐藏、不换显到 B）
      expect(lastBounds(view)).toEqual(VIEW_RECT)
      expect(win.contentView.removeChildView).not.toHaveBeenCalled()
      expect(lastBounds(viewB)).toEqual(HIDDEN) // B 的 view 不复显
    })

    it('浮层内容 browser 换出（→ workflow）→ 隐藏 view；换回 → 恢复（§7.4 联动③）', () => {
      const { mgr, view } = setupVisibleA()

      mgr.setOverlayState({ open: true, content: 'workflow', sessionId: 'A' })
      expect(lastBounds(view)).toEqual(HIDDEN)

      mgr.setOverlayState({ open: true, content: 'browser', sessionId: 'A' })
      expect(lastBounds(view)).toEqual(VIEW_RECT)
    })

    it('show 请求收敛到统一谓词：浮层关态 show 不显示（禁止各触发独立 show）', () => {
      const win = makeWindow()
      const mgr = new BrowserViewManager(makeWindowManager('win-1', win))
      mgr.create('A', 'win-1')
      mgr.setRect('A', VIEW_RECT)

      mgr.show('A')
      expect(lastBounds(hoisted.createdViews[0])).toEqual(HIDDEN)

      mgr.setOverlayState({ open: true, content: 'browser', sessionId: 'A' })
      expect(lastBounds(hoisted.createdViews[0])).toEqual(VIEW_RECT)
    })

    it('浮层开但内容为 workflow 的换显场景：focus 换显只隐藏不显示（R4 对齐收口谓词）', () => {
      const { mgr, view } = setupVisibleA()
      mgr.create('B', 'win-1')
      const viewB = hoisted.createdViews[1]

      // 浮层内容 browser → workflow：A 的 view 隐藏（联动③）
      mgr.setOverlayState({ open: true, content: 'workflow', sessionId: 'A' })
      expect(lastBounds(view)).toEqual(HIDDEN)

      // 换显（focus B）：非「浮层开 ∧ 内容 browser」态只隐藏不显示——B 不复显、A 不复活
      mgr.focus('B')
      expect(lastBounds(viewB)).toEqual(HIDDEN)
      expect(lastBounds(view)).toEqual(HIDDEN)
    })
  })

  describe('S5 反向 + 级联：会话删除 browserDestroy', () => {
    it('销毁发起会话：view 池无残留 + 浮层态复位（级联关浮层）', () => {
      const { win, mgr, view } = setupVisibleA()

      mgr.destroy('A')
      expect(view.wc.destroyed).toBe(true) // webContents.close
      expect(win.contentView.removeChildView).toHaveBeenCalled()
      expect(mgr.getState('A')).toBeNull()

      // 浮层态已复位：重建 A 后 show 不复显（无浮层事实支撑）
      mgr.create('A', 'win-1')
      mgr.show('A')
      expect(lastBounds(hoisted.createdViews[1])).toEqual(HIDDEN)
    })

    it('反向断言：删非发起会话 → 浮层不动、发起会话 view 保持显示（防过宽清场）', () => {
      const { mgr, view } = setupVisibleA()
      mgr.create('B', 'win-1')
      const viewB = hoisted.createdViews[1]

      mgr.destroy('B')
      expect(viewB.wc.destroyed).toBe(true)
      expect(lastBounds(view)).toEqual(VIEW_RECT) // A 的 view 原样显示

      // 浮层事实仍在：hide/show 链照常（谓词为真）
      mgr.hide('A')
      mgr.show('A')
      expect(lastBounds(view)).toEqual(VIEW_RECT)
    })

    it('destroy 幂等：无 entry 走 console.warn 不抛错', () => {
      const { mgr } = setupVisibleA()
      mgr.destroy('ghost')
      expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('destroy: session not found'))
    })
  })
})
