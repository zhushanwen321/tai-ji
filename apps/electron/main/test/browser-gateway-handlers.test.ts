/**
 * browser IPC 契约单测（display-containers §7.4 错误通道 + 显示收口/转发键上报通道）。
 *
 * 覆盖：
 * 1. 'browser:create' 失败 reject（manager.create 抛出 → invoke rejection，renderer caller
 *    catch 落错误占位）——错误 envelope 带原因。
 * 2. 'browser:overlay-state' / 'browser:shields' / 'browser:forward-keys' 的通道接线 +
 *    非法 payload reject（error envelope）+ 合法 payload 路由到 manager / registry。
 *
 * Mock 策略：vi.mock('electron') 捕获 ipcMain.handle 到 Map（update-handlers.test.ts 同款）；
 * BrowserViewManager 以桩替换（只断言转发面，不重复 manager 语义——语义在 browser-display-gate.test.ts）。
 *
 * 运行：cd apps/electron/main && npx vitest run test/browser-gateway-handlers.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const handlers = new Map<string, (...args: unknown[]) => unknown>()

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(channel, fn)
    },
  },
}))

import { registerBrowserHandlers } from '../gateway/browser-handlers.js'
import type { BrowserViewManager } from '../browser/browser-view-manager.js'
import { forwardKeyRegistry } from '../browser/gateway/forward-keys.js'

function makeManagerStub() {
  return {
    create: vi.fn(),
    navigate: vi.fn(),
    hide: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
    goBack: vi.fn(),
    goForward: vi.fn(),
    setZoomFactor: vi.fn(),
    getZoomFactor: vi.fn(() => 1),
    getSelection: vi.fn(() => ({ text: '', url: '' })),
    destroy: vi.fn(),
    setRect: vi.fn(),
    setOverlayState: vi.fn(),
    setShieldsViewFaces: vi.fn(),
  } as unknown as BrowserViewManager & {
    create: ReturnType<typeof vi.fn>
    setOverlayState: ReturnType<typeof vi.fn>
    setShieldsViewFaces: ReturnType<typeof vi.fn>
    show: ReturnType<typeof vi.fn>
    focus: ReturnType<typeof vi.fn>
    destroy: ReturnType<typeof vi.fn>
  }
}

type ManagerStub = ReturnType<typeof makeManagerStub>

describe('browser IPC 契约（§7.4 错误通道 + 显示收口上报通道）', () => {
  let manager: ManagerStub

  beforeEach(() => {
    handlers.clear()
    manager = makeManagerStub()
    registerBrowserHandlers(manager, () => null)
    forwardKeyRegistry.set([])
  })

  it('注册全部 browser 通道（含显示收口 / 转发键三通道）', () => {
    for (const channel of [
      'browser:create',
      'browser:navigate',
      'browser:hide',
      'browser:show',
      'browser:focus',
      'browser:back',
      'browser:forward',
      'browser:set-zoom',
      'browser:get-zoom',
      'browser:get-selection',
      'browser:destroy',
      'browser:set-rect',
      'browser:overlay-state',
      'browser:shields',
      'browser:forward-keys',
    ]) {
      expect(handlers.has(channel), `${channel} 未注册`).toBe(true)
    }
  })

  it('browser:create：manager.create 抛出时 handler reject（错误 envelope 带原因）', async () => {
    manager.create.mockImplementation(() => {
      throw new Error('[browser-view] create failed: window not found windowId=w sessionId=s')
    })
    await expect(handlers.get('browser:create')!(null, { sessionId: 's', windowId: 'w' })).rejects.toThrow(
      /create failed: window not found/,
    )
    // 成功路径 resolve（undefined）
    manager.create.mockImplementation(() => {})
    await expect(handlers.get('browser:create')!(null, { sessionId: 's', windowId: 'w' })).resolves.toBeUndefined()
  })

  it('browser:overlay-state：合法 payload 路由 manager.setOverlayState；非法 reject', async () => {
    await handlers.get('browser:overlay-state')!(null, { open: true, content: 'browser', sessionId: 'A' })
    expect(manager.setOverlayState).toHaveBeenCalledWith({ open: true, content: 'browser', sessionId: 'A' })

    await expect(handlers.get('browser:overlay-state')!(null, { open: true, content: 'drawer', sessionId: 'A' })).rejects.toThrow(
      /content must be/,
    )
    await expect(handlers.get('browser:overlay-state')!(null, 'nope')).rejects.toThrow(/payload must be an object/)
  })

  it('browser:shields：合法 payload 路由 manager.setShieldsViewFaces；非法 reject', async () => {
    await handlers.get('browser:shields')!(null, { faces: [{ id: 'modal', fullscreen: true }] })
    expect(manager.setShieldsViewFaces).toHaveBeenCalledWith([{ id: 'modal', fullscreen: true }])

    await expect(handlers.get('browser:shields')!(null, { faces: 'x' })).rejects.toThrow(/faces must be an array/)
    await expect(handlers.get('browser:shields')!(null, { faces: [{ id: 'a', fullscreen: false, rect: { x: 0, y: 0, width: -1, height: 1 } }] })).rejects.toThrow(
      /rect must be/,
    )
  })

  it('browser:forward-keys：set 全量重报写 registry，返回 accepted/rejected 回执', async () => {
    const report = await handlers.get('browser:forward-keys')!(null, { set: ['mod+k', 'j'] })
    expect(report).toEqual({ accepted: ['mod+k'], rejected: ['j'] })
    expect(forwardKeyRegistry.list()).toEqual(['mod+k'])
  })

  it('browser:forward-keys：add/remove 增量；非法 payload reject（error envelope）', async () => {
    await handlers.get('browser:forward-keys')!(null, { set: ['mod+k'] })
    await handlers.get('browser:forward-keys')!(null, { add: ['mod+n'], remove: ['mod+k'] })
    expect(forwardKeyRegistry.list()).toEqual(['mod+n'])

    await expect(handlers.get('browser:forward-keys')!(null, {})).rejects.toThrow(/must carry set \/ add \/ remove/)
    await expect(handlers.get('browser:forward-keys')!(null, { set: ['mod+k'], add: ['mod+n'] })).rejects.toThrow(/cannot combine/)
    await expect(handlers.get('browser:forward-keys')!(null, { set: 'mod+k' })).rejects.toThrow(/set must be a string array/)
    await expect(handlers.get('browser:forward-keys')!(null, null)).rejects.toThrow(/payload must be an object/)
  })

  it('browser:show / browser:focus / browser:destroy 转发 manager（语义在 manager 内收口）', async () => {
    await handlers.get('browser:show')!(null, 'A')
    await handlers.get('browser:focus')!(null, 'A')
    await handlers.get('browser:destroy')!(null, 'A')
    expect(manager.show).toHaveBeenCalledWith('A')
    expect(manager.focus).toHaveBeenCalledWith('A')
    expect(manager.destroy).toHaveBeenCalledWith('A')
  })
})
