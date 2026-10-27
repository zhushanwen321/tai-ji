/**
 * canvas store 单元测试（problem-solve-canvas §3.1(3) U5 验收：分区与拉取收敛 +
 * 自动唤起判定纯函数；session-store-layout-inversion D4：per-session Map 分区）。
 *
 * 覆盖：
 * - 分区（ADR-0049 useSessionScopedState）：loadCanvas / listCanvases 写「当前会话」
 *   分区（RPC payload 带归属 sessionId）；实例以各自 sidRef 读各自分区，跨会话互不可见。
 * - 拉取收敛（rev 守卫）：同画布连续拉取，在途旧 reply 晚返回不倒拨新状态；清单同款。
 * - 会话删除分区清理：cleanup 挂 triggerSessionCleanups（工厂注册），删除后分区读为空。
 * - 关闭标记：markCanvasClosedByUser（落指定会话分区）/ isClosedByUser（当前分区）。
 * - shouldAutoOpenCanvas 真值表：边界②（关闭过不唤起）、边界③（其他 overlay 打开不抢）、
 *   桥未装配 fail-safe 不唤起、canvas kind 不属「其他 overlay」、overlay 关闭可唤起。
 *
 * 驱动方式：command 以 vi.mock 注入替身（renderer 测试无真实 WS；受控 promise 驱动
 * reply 返回顺序）。运行：cd packages/renderer && npx vitest run src/stores/canvas.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ref } from 'vue'
import type { CanvasState } from '@zhushanwen/extension-protocol'
import { triggerSessionCleanups } from '@taiji/core/foundation/use-session-scoped-state'
import {
  _resetCanvasStoreForTest,
  isCanvasClosedByUser,
  markCanvasClosedByUser,
  refreshCanvasFor,
  shouldAutoOpenCanvas,
  useCanvasStore,
  type CanvasOverlaySnapshot,
} from './canvas'

vi.mock('@taiji/core/transport/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@taiji/core/transport/api')>()
  return { ...actual, command: vi.fn() }
})

const commandMock = vi.mocked(await import('@taiji/core/transport/api').then((m) => m.command))

const SID = 'sid-a'
const SID_B = 'sid-b'

/** 最小合法 CanvasState fixture（U1 契约形状；ownerSessionId = D4 归属字段）。 */
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

function listEntry(canvasId: string, ownerSessionId = SID) {
  return { canvasId, ownerSessionId, name: canvasId, statement: 's', converged: false, openMustFix: 0, reviewStatus: null }
}

function overlaySnap(partial: Partial<CanvasOverlaySnapshot>): CanvasOverlaySnapshot {
  return { isOpen: false, kind: null, canvasId: null, sessionId: null, ...partial }
}

describe('canvas store（per-session 分区与拉取收敛）', () => {
  beforeEach(() => {
    _resetCanvasStoreForTest()
    commandMock.mockReset()
  })

  it('loadCanvas 成功落分区：RPC 带归属 sessionId；canvasOf 可读全量视图', async () => {
    const store = useCanvasStore(ref(SID))
    commandMock.mockResolvedValue(canvasState('cvs-1'))
    await store.loadCanvas('cvs-1')
    expect(commandMock).toHaveBeenCalledWith('canvas.get', { canvasId: 'cvs-1', sessionId: SID }, expect.any(Number))
    expect(store.canvasOf('cvs-1')?.name).toBe('画布 cvs-1')
    expect(store.loadErrorOf('cvs-1')).toBeNull()
  })

  it('分区隔离：实例 A 与实例 B 各读各的分区，B 看不到 A 拉取的画布', async () => {
    const storeA = useCanvasStore(ref(SID))
    const storeB = useCanvasStore(ref(SID_B))
    commandMock.mockResolvedValue(canvasState('cvs-1'))
    await storeA.loadCanvas('cvs-1')
    expect(storeA.canvasOf('cvs-1')?.name).toBe('画布 cvs-1')
    expect(storeB.canvasOf('cvs-1')).toBeNull()
  })

  it('未拉取的画布 canvasOf 为 null（分区缺席非错误）；null sid 实例读空且不发 RPC', async () => {
    const store = useCanvasStore(ref<string | null>(null))
    expect(store.canvasOf('cvs-none')).toBeNull()
    expect(store.loadErrorOf('cvs-none')).toBeNull()
    await store.loadCanvas('cvs-none')
    await store.listCanvases()
    expect(commandMock).not.toHaveBeenCalled()
  })

  it('拉取收敛：同画布第二次拉取后，先发在途的旧 reply 晚返回不倒拨（rev 守卫丢弃）', async () => {
    const store = useCanvasStore(ref(SID))
    let resolveFirst!: (v: CanvasState) => void
    let resolveSecond!: (v: CanvasState) => void
    commandMock.mockImplementationOnce(
      () => new Promise<CanvasState>((r) => { resolveFirst = r }),
    )
    commandMock.mockImplementationOnce(
      () => new Promise<CanvasState>((r) => { resolveSecond = r }),
    )
    const first = store.loadCanvas('cvs-1')
    const second = store.loadCanvas('cvs-1') // 失效重拉（模拟 canvas.updated 触发）
    resolveSecond(canvasState('cvs-1', '新名'))
    await second
    resolveFirst(canvasState('cvs-1', '旧名'))
    await first
    expect(store.canvasOf('cvs-1')?.name).toBe('新名')
  })

  it('loadCanvas 失败：loadError 落分区且不清既有 state', async () => {
    const store = useCanvasStore(ref(SID))
    commandMock.mockResolvedValueOnce(canvasState('cvs-1'))
    await store.loadCanvas('cvs-1')
    commandMock.mockRejectedValueOnce(new Error('transport unavailable'))
    await store.loadCanvas('cvs-1')
    expect(store.canvasOf('cvs-1')?.name).toBe('画布 cvs-1')
    expect(store.loadErrorOf('cvs-1')).toContain('transport unavailable')
  })

  it('canvasId 空串 no-op（不发起 RPC）', async () => {
    const store = useCanvasStore(ref(SID))
    await store.loadCanvas('')
    expect(commandMock).not.toHaveBeenCalled()
  })

  it('listCanvases 成功：清单写入 + 错误复位（payload 带归属 sessionId）', async () => {
    const store = useCanvasStore(ref(SID))
    commandMock.mockResolvedValue({ canvases: [listEntry('cvs-1')] })
    await store.listCanvases()
    expect(commandMock).toHaveBeenCalledWith('canvas.list', { sessionId: SID }, expect.any(Number))
    expect(store.list.value).toHaveLength(1)
    expect(store.listError.value).toBeNull()
  })

  it('清单收敛：在途旧清单 reply 晚返回不倒拨新清单（rev 守卫）', async () => {
    const store = useCanvasStore(ref(SID))
    let resolveFirst!: (v: { canvases: unknown[] }) => void
    let resolveSecond!: (v: { canvases: unknown[] }) => void
    commandMock.mockImplementationOnce(() => new Promise((r) => { resolveFirst = r }))
    commandMock.mockImplementationOnce(() => new Promise((r) => { resolveSecond = r }))
    const first = store.listCanvases()
    const second = store.listCanvases()
    resolveSecond({ canvases: [listEntry('cvs-2')] })
    await second
    resolveFirst({ canvases: [] })
    await first
    expect(store.list.value).toHaveLength(1)
    expect(store.list.value[0]?.canvasId).toBe('cvs-2')
  })

  it('listCanvases 失败：listError 落错误且旧清单不清', async () => {
    const store = useCanvasStore(ref(SID))
    commandMock.mockResolvedValueOnce({ canvases: [listEntry('cvs-1')] })
    await store.listCanvases()
    commandMock.mockRejectedValueOnce(new Error('channel down'))
    await store.listCanvases()
    expect(store.listError.value).toContain('channel down')
    expect(store.list.value).toHaveLength(1)
  })

  it('refreshFor 写「目标会话」分区（广播失效重拉的 updateFor 语义）：不依赖实例 sidRef 当前值', async () => {
    useCanvasStore(ref(SID))
    commandMock.mockResolvedValue({ canvases: [listEntry('cvs-1', SID_B)] })
    refreshCanvasFor(SID_B, null)
    await vi.waitFor(() => expect(commandMock).toHaveBeenCalledWith('canvas.list', { sessionId: SID_B }, expect.any(Number)), { interval: 1 })
    const storeB = useCanvasStore(ref(SID_B))
    expect(storeB.list.value.map((c) => c.canvasId)).toEqual(['cvs-1'])
  })

  it('会话删除分区清理：triggerSessionCleanups 后分区读为空（ADR-0049 工厂注册）', async () => {
    const store = useCanvasStore(ref(SID))
    commandMock.mockResolvedValue({ canvases: [listEntry('cvs-1')] })
    await store.listCanvases()
    expect(store.list.value).toHaveLength(1)
    triggerSessionCleanups(SID)
    expect(store.list.value).toEqual([])
  })
})

describe('canvas store（关闭标记，落指定会话分区）', () => {
  beforeEach(() => {
    _resetCanvasStoreForTest()
    commandMock.mockReset()
  })

  it('markCanvasClosedByUser 幂等打标到目标分区；isCanvasClosedByUser 按分区查询', () => {
    expect(isCanvasClosedByUser(SID, 'cvs-1')).toBe(false)
    markCanvasClosedByUser(SID, 'cvs-1')
    markCanvasClosedByUser(SID, 'cvs-1')
    expect(isCanvasClosedByUser(SID, 'cvs-1')).toBe(true)
    expect(isCanvasClosedByUser(SID, 'cvs-2')).toBe(false)
    // 跨分区不可见（B 分区未打标）
    expect(isCanvasClosedByUser(SID_B, 'cvs-1')).toBe(false)
  })

  it('空 canvasId / 空 sid 打标 no-op（防御）', () => {
    markCanvasClosedByUser(SID, '')
    markCanvasClosedByUser(null, 'cvs-1')
    expect(isCanvasClosedByUser(SID, '')).toBe(false)
    expect(isCanvasClosedByUser(null, 'cvs-1')).toBe(false)
  })

  it('实例视图 isClosedByUser 读当前绑定分区', () => {
    const store = useCanvasStore(ref(SID))
    markCanvasClosedByUser(SID, 'cvs-1')
    expect(store.isClosedByUser('cvs-1')).toBe(true)
  })
})

describe('shouldAutoOpenCanvas（自动唤起判定②③，①由 evType/会话分流结构性成立）', () => {
  it('边界②：用户关闭过该画布 → 不唤起（即便 overlay 关闭态）', () => {
    expect(shouldAutoOpenCanvas({ closedByUser: true, overlay: overlaySnap({}) })).toBe(false)
  })

  it('边界③：其他 overlay 打开（workflow/browser/scheduler）→ 不抢焦点', () => {
    for (const kind of ['workflow', 'browser', 'scheduler'] as const) {
      expect(
        shouldAutoOpenCanvas({ closedByUser: false, overlay: overlaySnap({ isOpen: true, kind }) }),
      ).toBe(false)
    }
  })

  it('当前 overlay 即 canvas tab 不属「其他 overlay」→ 换内容唤起', () => {
    expect(
      shouldAutoOpenCanvas({
        closedByUser: false,
        overlay: overlaySnap({ isOpen: true, kind: 'canvas', canvasId: 'cvs-other', sessionId: SID }),
      }),
    ).toBe(true)
  })

  it('overlay 未打开 → 唤起', () => {
    expect(shouldAutoOpenCanvas({ closedByUser: false, overlay: overlaySnap({}) })).toBe(true)
  })

  it('fail-safe：桥未装配（overlay 快照 null）→ 不唤起', () => {
    expect(shouldAutoOpenCanvas({ closedByUser: false, overlay: null })).toBe(false)
  })
})
