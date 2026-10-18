/**
 * use-canvas-sync 单元测试（problem-solve-canvas §3.1(3) U5 验收：自动唤起边界 +
 * canvas.updated 分流 + 订阅生命周期；session-store-layout-inversion D4：per-session
 * 分流 + 仅归属会话唤起）。
 *
 * 覆盖：
 * - 首拉：消费面挂载即 canvas.list 一次（本会话清单）。
 * - 唤起正向：CanvasCreated + 归属会话匹配 + 未打标 + 无其他 overlay → 桥 openCanvas 被调
 *   （载荷带归属 sessionId）+ 数据/清单照常拉取（refreshFor 写「消息所属会话」分区）。
 * - 会话判定：非归属会话的 CanvasCreated 不唤起本实例（A 建画布不抢 B 的前台）。
 * - 边界①（仅创建触发）：其余 evType 只失效重拉画布与清单，不唤起。
 * - 边界②：关闭标记在案的画布 CanvasCreated 不唤起（数据/清单照常刷新）。
 * - 边界③：其他 overlay（workflow）打开时不唤起（托盘徽标提示 = 清单刷新承载）；
 *   canvas kind 打开时换内容唤起。
 * - 关闭打标 watch：canvas 内容浮层被关闭 → 打标记（落 overlay 归属会话分区）→ 该画布
 *   不再自动唤起。
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
import { dispatchGlobal } from '@taiji/core/transport/api'
import type { CanvasState, CanvasEventType, ServerMessage } from '@taiji/shared'
import {
  registerCanvasOverlayBridge,
  useCanvasSync,
  _resetCanvasSyncForTest,
} from './use-canvas-sync'
import { _resetCanvasStoreForTest, isCanvasClosedByUser, type CanvasOverlaySnapshot } from '@/stores/canvas'

vi.mock('@taiji/core/transport/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@taiji/core/transport/api')>()
  return { ...actual, command: vi.fn() }
})

const commandMock = vi.mocked(await import('@taiji/core/transport/api').then((m) => m.command))

const SID = 'sid-a'
const SID_B = 'sid-b'

/** 最小合法 CanvasState fixture。 */
function canvasState(id: string, name = `画布 ${id}`, ownerSessionId = SID): CanvasState {
  return {
    canvasId: id,
    ownerSessionId,
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
  canvases: ids.map((canvasId) => ({ canvasId, ownerSessionId: SID, name: canvasId, statement: 's', converged: false, openMustFix: 0, reviewStatus: null })),
})

/** 桥替身：snapshot 读真 ref（打标 watch 的响应依赖源），openCanvas 记录调用。 */
const overlaySnap = ref<CanvasOverlaySnapshot>({ isOpen: false, kind: null, canvasId: null, sessionId: null })
const openCanvasMock = vi.fn()

function setupBridge(): void {
  registerCanvasOverlayBridge({
    openCanvas: openCanvasMock,
    snapshot: () => overlaySnap.value,
  })
}

/** 构造 canvas.updated 全局广播帧并分发（payload 带归属 sessionId）。 */
function broadcast(canvasId: string, evType: CanvasEventType, sessionId = SID): void {
  dispatchGlobal({
    type: 'canvas.updated',
    payload: { canvasId, sessionId, evType, eventId: 'ev-1', summary: '' },
  } as ServerMessage<'canvas.updated'>)
}

describe('useCanvasSync（自动唤起边界 + per-session 分流）', () => {
  beforeEach(() => {
    _resetCanvasSyncForTest()
    _resetCanvasStoreForTest()
    commandMock.mockReset()
    openCanvasMock.mockReset()
    overlaySnap.value = { isOpen: false, kind: null, canvasId: null, sessionId: null }
    setupBridge()
    commandMock.mockImplementation(async (_type, payload) => {
      const p = payload as { canvasId?: string }
      return p?.canvasId ? canvasState(p.canvasId) : listReply(['cvs-1'])
    })
  })

  it('首拉：消费面挂载即 canvas.list 一次（本会话清单，payload 带归属 sessionId）', async () => {
    const scope = effectScope()
    scope.run(() => useCanvasSync(ref(SID)))
    await flushPromises()
    expect(commandMock).toHaveBeenCalledTimes(1)
    expect(commandMock).toHaveBeenCalledWith('canvas.list', { sessionId: SID }, expect.any(Number))
    scope.stop()
  })

  it('唤起正向：归属会话 CanvasCreated + 未打标 + overlay 关 → openCanvas 调用（载荷带 sid）+ 画布与清单照常拉取', async () => {
    const scope = effectScope()
    scope.run(() => useCanvasSync(ref(SID)))
    await flushPromises()
    commandMock.mockClear()
    broadcast('cvs-1', 'CanvasCreated')
    await flushPromises()
    expect(openCanvasMock).toHaveBeenCalledTimes(1)
    expect(openCanvasMock).toHaveBeenCalledWith('cvs-1', SID)
    expect(commandMock).toHaveBeenCalledWith('canvas.get', { canvasId: 'cvs-1', sessionId: SID }, expect.any(Number))
    expect(commandMock).toHaveBeenCalledWith('canvas.list', { sessionId: SID }, expect.any(Number))
    scope.stop()
  })

  it('会话判定：非归属会话的 CanvasCreated 不唤起本实例（A 建画布不抢 B 前台），数据仍按归属分区拉取', async () => {
    const scopeB = effectScope()
    scopeB.run(() => useCanvasSync(ref(SID_B)))
    await flushPromises()
    commandMock.mockClear()
    broadcast('cvs-1', 'CanvasCreated', SID) // A 会话建画布
    await flushPromises()
    expect(openCanvasMock).not.toHaveBeenCalled()
    // 失效重拉写「消息所属会话」（A）分区——B 实例不发 canvas.get
    expect(commandMock).toHaveBeenCalledWith('canvas.get', { canvasId: 'cvs-1', sessionId: SID }, expect.any(Number))
    expect(commandMock).not.toHaveBeenCalledWith('canvas.get', { canvasId: 'cvs-1', sessionId: SID_B }, expect.any(Number))
    scopeB.stop()
  })

  it('边界①（仅创建触发）：其余 evType 只失效重拉画布与清单，不唤起', async () => {
    const scope = effectScope()
    scope.run(() => useCanvasSync(ref(SID)))
    await flushPromises()
    commandMock.mockClear()
    broadcast('cvs-1', 'NodeModified')
    await flushPromises()
    expect(openCanvasMock).not.toHaveBeenCalled()
    expect(commandMock).toHaveBeenCalledWith('canvas.get', { canvasId: 'cvs-1', sessionId: SID }, expect.any(Number))
    expect(commandMock).toHaveBeenCalledWith('canvas.list', { sessionId: SID }, expect.any(Number))
    scope.stop()
  })

  it('边界②：用户关闭标记在案的画布 CanvasCreated 不唤起，数据与清单照常刷新', async () => {
    const scope = effectScope()
    scope.run(() => useCanvasSync(ref(SID)))
    await flushPromises()
    // 经桥模拟：canvas overlay 开着（归属 SID 的 cvs-1）→ 关闭 → 打标
    overlaySnap.value = { isOpen: true, kind: 'canvas', canvasId: 'cvs-1', sessionId: SID }
    await nextTick()
    overlaySnap.value = { isOpen: false, kind: null, canvasId: null, sessionId: null }
    await nextTick()
    commandMock.mockClear()
    broadcast('cvs-1', 'CanvasCreated')
    await flushPromises()
    expect(openCanvasMock).not.toHaveBeenCalled()
    expect(commandMock).toHaveBeenCalledWith('canvas.get', { canvasId: 'cvs-1', sessionId: SID }, expect.any(Number))
    scope.stop()
  })

  it('边界③：其他 overlay（workflow）打开时不唤起，清单仍刷新（托盘徽标提示的数据源）', async () => {
    overlaySnap.value = { isOpen: true, kind: 'workflow', canvasId: null, sessionId: null }
    const scope = effectScope()
    scope.run(() => useCanvasSync(ref(SID)))
    await flushPromises()
    commandMock.mockClear()
    broadcast('cvs-1', 'CanvasCreated')
    await flushPromises()
    expect(openCanvasMock).not.toHaveBeenCalled()
    expect(commandMock).toHaveBeenCalledWith('canvas.get', { canvasId: 'cvs-1', sessionId: SID }, expect.any(Number))
    scope.stop()
  })

  it('边界③补：当前 overlay 即 canvas tab（另一画布）→ 换内容唤起', async () => {
    overlaySnap.value = { isOpen: true, kind: 'canvas', canvasId: 'cvs-0', sessionId: SID }
    const scope = effectScope()
    scope.run(() => useCanvasSync(ref(SID)))
    await flushPromises()
    commandMock.mockClear()
    broadcast('cvs-1', 'CanvasCreated')
    await flushPromises()
    expect(openCanvasMock).toHaveBeenCalledWith('cvs-1', SID)
    scope.stop()
  })

  it('桥未装配（未注册）→ 唤起通道缺失不抢屏，数据链路不受影响', async () => {
    registerCanvasOverlayBridge(null)
    const scope = effectScope()
    scope.run(() => useCanvasSync(ref(SID)))
    await flushPromises()
    commandMock.mockClear()
    broadcast('cvs-1', 'CanvasCreated')
    await flushPromises()
    expect(openCanvasMock).not.toHaveBeenCalled()
    expect(commandMock).toHaveBeenCalledWith('canvas.get', { canvasId: 'cvs-1', sessionId: SID }, expect.any(Number))
    scope.stop()
  })
})

describe('useCanvasSync（关闭打标 watch：落 overlay 归属会话分区）', () => {
  beforeEach(() => {
    _resetCanvasSyncForTest()
    _resetCanvasStoreForTest()
    commandMock.mockReset()
    openCanvasMock.mockReset()
    overlaySnap.value = { isOpen: false, kind: null, canvasId: null, sessionId: null }
    setupBridge()
    commandMock.mockResolvedValue(listReply([]))
  })

  it('canvas 内容浮层被关闭 → 打标记（归属会话分区）；该画布此后 CanvasCreated 不再唤起', async () => {
    overlaySnap.value = { isOpen: true, kind: 'canvas', canvasId: 'cvs-1', sessionId: SID }
    const scope = effectScope()
    scope.run(() => useCanvasSync(ref(SID)))
    await nextTick()
    // 关闭 overlay（isOpen false 且内容复位——core closeOverlay 复位不变量）
    overlaySnap.value = { isOpen: false, kind: null, canvasId: null, sessionId: null }
    await nextTick()
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
    overlaySnap.value = { isOpen: true, kind: 'canvas', canvasId: 'cvs-1', sessionId: SID }
    const scope = effectScope()
    scope.run(() => useCanvasSync(ref(SID)))
    await nextTick()
    overlaySnap.value = { isOpen: true, kind: 'workflow', canvasId: null, sessionId: null }
    await nextTick()
    // 换内容不触发关闭打标（isCanvasClosedByUser 查归属分区——与唤起判定②同源）
    expect(isCanvasClosedByUser(SID, 'cvs-1')).toBe(false)
    scope.stop()
  })

  it('非 canvas 内容的浮层关闭不打标（prev 非 canvas 段）', async () => {
    overlaySnap.value = { isOpen: true, kind: 'workflow', canvasId: null, sessionId: null }
    const scope = effectScope()
    scope.run(() => useCanvasSync(ref(SID)))
    await nextTick()
    overlaySnap.value = { isOpen: false, kind: null, canvasId: null, sessionId: null }
    await nextTick()
    commandMock.mockImplementation(async (_type, payload) => {
      const p = payload as { canvasId?: string }
      return p?.canvasId ? canvasState(p.canvasId) : listReply(['cvs-1'])
    })
    broadcast('cvs-1', 'CanvasCreated')
    await flushPromises()
    expect(openCanvasMock).toHaveBeenCalledWith('cvs-1', SID)
    scope.stop()
  })
})

describe('useCanvasSync（订阅生命周期 refCount）', () => {
  beforeEach(() => {
    _resetCanvasSyncForTest()
    _resetCanvasStoreForTest()
    commandMock.mockReset()
    openCanvasMock.mockReset()
    overlaySnap.value = { isOpen: false, kind: null, canvasId: null, sessionId: null }
    setupBridge()
    commandMock.mockResolvedValue(listReply([]))
  })

  it('多消费者共享单条物理订阅：一次广播只触发一轮拉取与一次唤起判定', async () => {
    const scope1 = effectScope()
    scope1.run(() => useCanvasSync(ref(SID)))
    const scope2 = effectScope()
    scope2.run(() => useCanvasSync(ref(SID)))
    await flushPromises()
    commandMock.mockClear()
    broadcast('cvs-1', 'CanvasCreated')
    await flushPromises()
    const getCalls = commandMock.mock.calls.filter((c) => c[0] === 'canvas.get')
    expect(getCalls).toHaveLength(1)
    // 两实例都注册唤起判定，但 openCanvas 动作幂等（同画布同会话换内容单例语义）——
    // 广播处理对每实例各判一次，桥被调两次是 listener 分发的预期形态；此处锁定「拉取一轮」。
    expect(openCanvasMock).toHaveBeenCalledWith('cvs-1', SID)
    scope1.stop()
    scope2.stop()
  })

  it('全部消费者卸载后退订：后续广播不再触发拉取', async () => {
    const scope = effectScope()
    scope.run(() => useCanvasSync(ref(SID)))
    await flushPromises()
    scope.stop()
    commandMock.mockClear()
    broadcast('cvs-1', 'NodeModified')
    await flushPromises()
    expect(commandMock).not.toHaveBeenCalled()
  })
})
