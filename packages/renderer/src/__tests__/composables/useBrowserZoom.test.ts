/**
 * useBrowserZoom 单测（缩放管理）。
 *
 * 覆盖：
 * - 初始 zoomFactor = 1.0
 * - zoomIn / zoomOut 按 ZOOM_STEP(0.1) 增减
 * - zoomReset 回到 1.0
 * - setZoomFromRemote（主进程 autoFit 回推）：仅更新本地 ref，不调 browserSetZoom（避免循环）
 * - 范围钳制 ZOOM_MIN(0.25) ~ ZOOM_MAX(5.0)
 * - sessionId 变化时从主进程读回 zoom（watch immediate）
 *
 * Mock 策略：vi.mock('@/lib/ipc') 桩 browserGetZoom / browserSetZoom，
 * 避免 renderer 测试环境无 preload（window.electronAPI undefined）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/composables/useBrowserZoom.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { ref } from 'vue'

// vi.mock 被 hoist，factory 内不能引用顶层变量，用 vi.hoisted 拿稳定引用
const hoisted = vi.hoisted(() => ({
  browserGetZoom: vi.fn(() => Promise.resolve(1)),
  browserSetZoom: vi.fn(() => Promise.resolve()),
}))

vi.mock('@/lib/ipc', () => ({
  browserGetZoom: hoisted.browserGetZoom,
  browserSetZoom: hoisted.browserSetZoom,
}))

import { useBrowserZoom } from '@/composables/features/browser/useBrowserZoom'

describe('useBrowserZoom', () => {
  beforeEach(() => {
    hoisted.browserGetZoom.mockClear()
    hoisted.browserSetZoom.mockClear()
    hoisted.browserGetZoom.mockResolvedValue(1)
  })

  it('初始 zoomFactor = 1.0（ZOOM_DEFAULT）', async () => {
    const { zoomFactor } = useBrowserZoom(ref('sess-1'))
    // watch immediate 会调 browserGetZoom，flush 后可能更新。先验初始值。
    expect(zoomFactor.value).toBe(1.0)
  })

  it('zoomIn 按 ZOOM_STEP(0.1) 增加并调 browserSetZoom', () => {
    const { zoomFactor, zoomIn } = useBrowserZoom(ref('sess-1'))
    const before = zoomFactor.value
    zoomIn()
    expect(zoomFactor.value).toBe(before + 0.1)
    expect(hoisted.browserSetZoom).toHaveBeenCalledWith('sess-1', zoomFactor.value)
  })

  it('zoomOut 按 ZOOM_STEP(0.1) 减少并调 browserSetZoom', () => {
    const { zoomFactor, zoomOut } = useBrowserZoom(ref('sess-1'))
    const before = zoomFactor.value
    zoomOut()
    expect(zoomFactor.value).toBe(before - 0.1)
    expect(hoisted.browserSetZoom).toHaveBeenCalledWith('sess-1', zoomFactor.value)
  })

  it('zoomReset 回到 1.0 并调 browserSetZoom', () => {
    const { zoomFactor, zoomIn, zoomReset } = useBrowserZoom(ref('sess-1'))
    zoomIn()
    zoomIn()
    expect(zoomFactor.value).toBeGreaterThan(1.0)
    zoomReset()
    expect(zoomFactor.value).toBe(1.0)
    expect(hoisted.browserSetZoom).toHaveBeenLastCalledWith('sess-1', 1.0)
  })

  it('zoomOut 不低于 ZOOM_MIN(0.25)', () => {
    const { zoomFactor, zoomOut } = useBrowserZoom(ref('sess-1'))
    // 连续缩 20 次，应被钳制在 0.25
    for (let i = 0; i < 20; i++) zoomOut()
    expect(zoomFactor.value).toBe(0.25)
  })

  it('zoomIn 不超过 ZOOM_MAX(5.0)', () => {
    const { zoomFactor, zoomIn } = useBrowserZoom(ref('sess-1'))
    // 连续放大 50 次，应被钳制在 5.0
    for (let i = 0; i < 50; i++) zoomIn()
    expect(zoomFactor.value).toBe(5.0)
  })

  it('setZoomFromRemote：更新本地 ref 但不调 browserSetZoom（避免循环）', () => {
    const { zoomFactor, setZoomFromRemote } = useBrowserZoom(ref('sess-1'))
    hoisted.browserSetZoom.mockClear()
    // 模拟主进程 autoFit 回推 0.75（百度在窄 panel 里）
    setZoomFromRemote(0.75)
    expect(zoomFactor.value).toBe(0.75)
    // 关键：不调 browserSetZoom（否则 renderer→主进程→renderer 死循环）
    expect(hoisted.browserSetZoom).not.toHaveBeenCalled()
  })

  it('setZoomFromRemote 也钳制到 ZOOM_MIN~ZOOM_MAX', () => {
    const { zoomFactor, setZoomFromRemote } = useBrowserZoom(ref('sess-1'))
    setZoomFromRemote(0.1)
    expect(zoomFactor.value).toBe(0.25)
    setZoomFromRemote(10)
    expect(zoomFactor.value).toBe(5.0)
  })

  it('setZoomFromRemote 后用户 zoomIn 在新基准上递增', () => {
    const { zoomFactor, setZoomFromRemote, zoomIn } = useBrowserZoom(ref('sess-1'))
    // autoFit 缩到 0.75，用户在此基础上放大
    setZoomFromRemote(0.75)
    zoomIn()
    expect(zoomFactor.value).toBe(0.85) // 0.75 + 0.1
  })

  it('sessionId 变化时 watch 触发 browserGetZoom 读回主进程 zoom', async () => {
    hoisted.browserGetZoom.mockResolvedValue(0.6)
    const sid = ref('sess-1')
    const { zoomFactor } = useBrowserZoom(sid)
    await Promise.resolve()
    // 初始 immediate watch 已读 sess-1 的 zoom
    expect(hoisted.browserGetZoom).toHaveBeenCalledWith('sess-1')

    // 切 session
    sid.value = 'sess-2'
    await Promise.resolve()
    await Promise.resolve()
    expect(hoisted.browserGetZoom).toHaveBeenCalledWith('sess-2')
    expect(zoomFactor.value).toBe(0.6)
  })

  it('onZoomKeydown：Cmd+= / Cmd+- / Cmd+0 触发对应缩放，其他键不消费', () => {
    const { zoomFactor, onZoomKeydown } = useBrowserZoom(ref('sess-1'))
    const before = zoomFactor.value

    // 非 Cmd 组合 → 不消费
    expect(onZoomKeydown({ metaKey: false, ctrlKey: false, key: '=', preventDefault: () => {} } as KeyboardEvent)).toBe(false)
    expect(zoomFactor.value).toBe(before)

    // Cmd+= → zoomIn（消费）
    const e1 = { metaKey: true, ctrlKey: false, key: '=', preventDefault: vi.fn() } as unknown as KeyboardEvent
    expect(onZoomKeydown(e1)).toBe(true)
    expect(e1.preventDefault).toHaveBeenCalled()
    expect(zoomFactor.value).toBe(before + 0.1)

    // Cmd+- → zoomOut（消费）
    const before2 = zoomFactor.value
    const e2 = { metaKey: true, ctrlKey: false, key: '-', preventDefault: vi.fn() } as unknown as KeyboardEvent
    expect(onZoomKeydown(e2)).toBe(true)
    expect(zoomFactor.value).toBe(before2 - 0.1)

    // Cmd+0 → zoomReset（消费）
    const e3 = { metaKey: true, ctrlKey: false, key: '0', preventDefault: vi.fn() } as unknown as KeyboardEvent
    expect(onZoomKeydown(e3)).toBe(true)
    expect(zoomFactor.value).toBe(1.0)
  })
})
