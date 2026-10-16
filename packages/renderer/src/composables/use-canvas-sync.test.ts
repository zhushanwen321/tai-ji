/**
 * use-canvas-sync 单元测试（problem-solve-canvas §3.1(3) U5 验收：自动唤起三边界 +
 * canvas.updated 分流 + 订阅生命周期）。
 *
 * 覆盖：
 * - 首拉：首个消费者订阅即 canvas.list 一次。
 * - 唤起正向：CanvasCreated + 未打标 + 无其他 overlay → 桥 openCanvas 被调 + 数据/清单照常拉取。
 * - 边界①（仅创建触发）：其余 evType 只失效重拉，不唤起。
 * - 边界②：关闭标记在案的画布 CanvasCreated 不唤起（数据/清单照常刷新）。
 * - 边界③：其他 overlay（workflow）打开时不唤起（托盘徽标提示 = 清单刷新承载）；
 *   canvas kind 打开时换内容唤起。
 * - 关闭打标 watch：canvas 内容浮层被关闭 → 打标记 → 该画布不再自动唤起。
 * - refCount：多消费者共享单条物理订阅（一次广播只触发一轮拉取）；全部卸载后退订。
 *
 * 驱动方式：dispatchGlobal（core events 层真实现）喂广播帧；command 以 vi.mock 注入
 * 替身；桥注册 mock（openCanvas vi.fn + snapshot 读真 ref，供打标 watch 建立响应依赖）。
 * 运行：cd packages/renderer && npx vitest run src/composables/use-canvas-sync.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { nextTick, ref } from 'vue'
import { effectScope } from 'vue'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { dispatchGlobal } from '@taiji/core/transport/api'
import type { CanvasState, CanvasEventType, ServerMessage } from '@taiji/shared'
import {
  registerCanvasOverlayBridge,
  useCanvasSync,
  _resetCanvasSyncForTest,
} from './use-canvas-sync'
import { useCanvasStore, type CanvasOverlaySnapshot } from '@/stores/canvas'

vi.mock('@taiji/core/transport/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@taiji/core/transport/api')>()
  return { ...actual, command: vi.fn() }
})

const commandMock = vi.mocked(await import('@taiji/core/transport/api').then((m) => m.command))

/** 最小合法 CanvasState fixture。 */
function canvasState(id: string, name = `画布 ${id}`): CanvasState {
  return {
    canvasId: id,
    name,
    root: { nodeId: 'n-root', statement: `${name} 根问题`, criterias: ['判据一'], scopeExclusions: [] },
    direction: null,
    nodes: [],
    edges: [],
    comments: [],
    dirtyPaths: [],
    review: null,
    converged: false,
    createdAt: '2026-10-14T00:00:00.000Z',
    updatedAt: '2026-10-14T00:00:00.000Z',
  }
}

const listReply = (ids: string[]) => ({
  canvases: ids.map((canvasId) => ({ canvasId, name: canvasId, statement: 's', converged: false, openMustFix: 0, reviewStatus: null })),
})

/** 桥替身：snapshot 读真 ref（打标 watch 的响应依赖源），openCanvas 记录调用。 */
const overlaySnap = ref<CanvasOverlaySnapshot>({ isOpen: false, kind: null, canvasId: null })
const openCanvasMock = vi.fn()

function setupBridge(): void {
  registerCanvasOverlayBridge({
    openCanvas: openCanvasMock,
    snapshot: () => overlaySnap.value,
  })
}

/** 构造 canvas.updated 全局广播帧并分发。 */
function broadcast(canvasId: string, evType: CanvasEventType): void {
  dispatchGlobal({
    type: 'canvas.updated',
    payload: { canvasId, evType, eventId: 'ev-1', summary: '' },
  } as ServerMessage<'canvas.updated'>)
}

describe('useCanvasSync（自动唤起三边界 + 分流）', () => {
  beforeEach(() => {
    _resetCanvasSyncForTest()
    setActivePinia(createPinia())
    commandMock.mockReset()
    openCanvasMock.mockReset()
    overlaySnap.value = { isOpen: false, kind: null, canvasId: null }
    setupBridge()
    commandMock.mockImplementation(async (_type, payload) => {
      const p = payload as { canvasId?: string }
      return p?.canvasId ? canvasState(p.canvasId) : listReply(['cvs-1'])
    })
  })

  it('首拉：首个消费者订阅即 canvas.list 一次（托盘列表数据源）', async () => {
    const scope = effectScope()
    scope.run(() => useCanvasSync())
    await flushPromises()
    expect(commandMock).toHaveBeenCalledTimes(1)
    expect(commandMock).toHaveBeenCalledWith('canvas.list', {}, expect.any(Number))
    scope.stop()
  })

  it('唤起正向：CanvasCreated + 未打标 + overlay 关 → openCanvas 调用 + 画布与清单照常拉取', async () => {
    const scope = effectScope()
    scope.run(() => useCanvasSync())
    await flushPromises()
    commandMock.mockClear()
    broadcast('cvs-1', 'CanvasCreated')
    await flushPromises()
    expect(openCanvasMock).toHaveBeenCalledTimes(1)
    expect(openCanvasMock).toHaveBeenCalledWith('cvs-1')
    expect(commandMock).toHaveBeenCalledWith('canvas.get', { canvasId: 'cvs-1' }, expect.any(Number))
    expect(commandMock).toHaveBeenCalledWith('canvas.list', {}, expect.any(Number))
    const store = useCanvasStore()
    expect(store.canvasOf('cvs-1')?.name).toBe('画布 cvs-1')
    expect(store.list.map((c) => c.canvasId)).toContain('cvs-1')
    scope.stop()
  })

  it('边界①（仅创建触发）：其余 evType 只失效重拉画布与清单，不唤起', async () => {
    const scope = effectScope()
    scope.run(() => useCanvasSync())
    await flushPromises()
    commandMock.mockClear()
    broadcast('cvs-1', 'NodeModified')
    await flushPromises()
    expect(openCanvasMock).not.toHaveBeenCalled()
    expect(commandMock).toHaveBeenCalledWith('canvas.get', { canvasId: 'cvs-1' }, expect.any(Number))
    expect(commandMock).toHaveBeenCalledWith('canvas.list', {}, expect.any(Number))
    scope.stop()
  })

  it('边界②：用户关闭标记在案的画布 CanvasCreated 不唤起，数据与清单照常刷新', async () => {
    const store = useCanvasStore()
    store.markClosedByUser('cvs-1')
    const scope = effectScope()
    scope.run(() => useCanvasSync())
    await flushPromises()
    commandMock.mockClear()
    broadcast('cvs-1', 'CanvasCreated')
    await flushPromises()
    expect(openCanvasMock).not.toHaveBeenCalled()
    expect(store.canvasOf('cvs-1')).not.toBeNull()
    expect(store.list.map((c) => c.canvasId)).toContain('cvs-1')
    scope.stop()
  })

  it('边界③：其他 overlay（workflow）打开时不唤起，清单仍刷新（托盘徽标提示的数据源）', async () => {
    overlaySnap.value = { isOpen: true, kind: 'workflow', canvasId: null }
    const scope = effectScope()
    scope.run(() => useCanvasSync())
    await flushPromises()
    commandMock.mockClear()
    broadcast('cvs-1', 'CanvasCreated')
    await flushPromises()
    expect(openCanvasMock).not.toHaveBeenCalled()
    expect(commandMock).toHaveBeenCalledWith('canvas.get', { canvasId: 'cvs-1' }, expect.any(Number))
    expect(store_listHasCanvas('cvs-1')).toBe(true)
    scope.stop()
  })

  it('边界③补：当前 overlay 即 canvas tab（另一画布）→ 换内容唤起', async () => {
    overlaySnap.value = { isOpen: true, kind: 'canvas', canvasId: 'cvs-0' }
    const scope = effectScope()
    scope.run(() => useCanvasSync())
    await flushPromises()
    commandMock.mockClear()
    broadcast('cvs-1', 'CanvasCreated')
    await flushPromises()
    expect(openCanvasMock).toHaveBeenCalledWith('cvs-1')
    scope.stop()
  })

  it('桥未装配（未注册）→ 唤起通道缺失不抢屏，数据链路不受影响', async () => {
    registerCanvasOverlayBridge(null)
    const scope = effectScope()
    scope.run(() => useCanvasSync())
    await flushPromises()
    commandMock.mockClear()
    broadcast('cvs-1', 'CanvasCreated')
    await flushPromises()
    expect(openCanvasMock).not.toHaveBeenCalled()
    expect(commandMock).toHaveBeenCalledWith('canvas.get', { canvasId: 'cvs-1' }, expect.any(Number))
    scope.stop()
  })
})

describe('useCanvasSync（关闭打标 watch）', () => {
  beforeEach(() => {
    _resetCanvasSyncForTest()
    setActivePinia(createPinia())
    commandMock.mockReset()
    openCanvasMock.mockReset()
    overlaySnap.value = { isOpen: false, kind: null, canvasId: null }
    setupBridge()
    commandMock.mockResolvedValue(listReply([]))
  })

  it('canvas 内容浮层被关闭 → 打标记；该画布此后 CanvasCreated 不再唤起', async () => {
    overlaySnap.value = { isOpen: true, kind: 'canvas', canvasId: 'cvs-1' }
    const scope = effectScope()
    scope.run(() => useCanvasSync())
    await nextTick()
    // 关闭 overlay（isOpen false 且内容复位——core closeOverlay 复位不变量）
    overlaySnap.value = { isOpen: false, kind: null, canvasId: null }
    await nextTick()
    const store = useCanvasStore()
    expect(store.isClosedByUser('cvs-1')).toBe(true)
    // 打标后创建广播不再唤起
    commandMock.mockImplementation(async (_type, payload) => {
      const p = payload as { canvasId?: string }
      return p?.canvasId ? canvasState(p.canvasId) : listReply(['cvs-1'])
    })
    broadcast('cvs-1', 'CanvasCreated')
    await flushPromises()
    expect(openCanvasMock).not.toHaveBeenCalled()
    scope.stop()
  })

  it('换内容（canvas → workflow 打开）不打标——设计只认「主动关闭」', async () => {
    overlaySnap.value = { isOpen: true, kind: 'canvas', canvasId: 'cvs-1' }
    const scope = effectScope()
    scope.run(() => useCanvasSync())
    await nextTick()
    overlaySnap.value = { isOpen: true, kind: 'workflow', canvasId: null }
    await nextTick()
    expect(useCanvasStore().isClosedByUser('cvs-1')).toBe(false)
    scope.stop()
  })

  it('非 canvas 内容的浮层关闭不打标（prev 非 canvas 段）', async () => {
    overlaySnap.value = { isOpen: true, kind: 'workflow', canvasId: null }
    const scope = effectScope()
    scope.run(() => useCanvasSync())
    await nextTick()
    overlaySnap.value = { isOpen: false, kind: null, canvasId: null }
    await nextTick()
    expect(useCanvasStore().isClosedByUser('cvs-1')).toBe(false)
    scope.stop()
  })
})

describe('useCanvasSync（订阅生命周期 refCount）', () => {
  beforeEach(() => {
    _resetCanvasSyncForTest()
    setActivePinia(createPinia())
    commandMock.mockReset()
    openCanvasMock.mockReset()
    overlaySnap.value = { isOpen: false, kind: null, canvasId: null }
    setupBridge()
    commandMock.mockResolvedValue(listReply([]))
  })

  it('多消费者共享单条物理订阅：一次广播只触发一轮拉取与一次唤起判定', async () => {
    const scope1 = effectScope()
    scope1.run(() => useCanvasSync())
    const scope2 = effectScope()
    scope2.run(() => useCanvasSync())
    await flushPromises()
    commandMock.mockClear()
    broadcast('cvs-1', 'CanvasCreated')
    await flushPromises()
    const getCalls = commandMock.mock.calls.filter((c) => c[0] === 'canvas.get')
    expect(getCalls).toHaveLength(1)
    expect(openCanvasMock).toHaveBeenCalledTimes(1)
    scope1.stop()
    scope2.stop()
  })

  it('全部消费者卸载后退订：后续广播不再触发拉取', async () => {
    const scope = effectScope()
    scope.run(() => useCanvasSync())
    await flushPromises()
    scope.stop()
    commandMock.mockClear()
    broadcast('cvs-1', 'NodeModified')
    await flushPromises()
    expect(commandMock).not.toHaveBeenCalled()
  })
})

/** 清单含指定画布的断言辅助（消费 store 响应式列表）。 */
function store_listHasCanvas(canvasId: string): boolean {
  return useCanvasStore().list.some((c) => c.canvasId === canvasId)
}
