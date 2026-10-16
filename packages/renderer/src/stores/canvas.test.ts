/**
 * canvas store 单元测试（problem-solve-canvas §3.1(3) U5 验收：分区与拉取收敛 +
 * 自动唤起判定纯函数）。
 *
 * 覆盖：
 * - 分区：loadCanvas 成功落分区（canvasOf 可读）；失败落 loadError 且不清既有 state。
 * - 拉取收敛（rev 守卫）：同画布连续拉取，在途旧 reply 晚返回不倒拨新状态；
 *   清单同款（listCanvases 全局 rev）。
 * - 关闭标记：markClosedByUser / isClosedByUser（幂等；未打标为 false）。
 * - shouldAutoOpenCanvas 真值表：边界②（关闭过不唤起）、边界③（其他 overlay 打开不抢）、
 *   桥未装配 fail-safe 不唤起、canvas kind 不属「其他 overlay」、overlay 关闭可唤起。
 *
 * 驱动方式：command 以 vi.mock 注入替身（renderer 测试无真实 WS；受控 promise 驱动
 * reply 返回顺序）。运行：cd packages/renderer && npx vitest run src/stores/canvas.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { CanvasState } from '@zhushanwen/extension-protocol'
import {
  shouldAutoOpenCanvas,
  useCanvasStore,
  type CanvasOverlaySnapshot,
} from './canvas'

vi.mock('@taiji/core/transport/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@taiji/core/transport/api')>()
  return { ...actual, command: vi.fn() }
})

const commandMock = vi.mocked(await import('@taiji/core/transport/api').then((m) => m.command))

/** 最小合法 CanvasState fixture（U1 契约形状）。 */
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

function overlaySnap(partial: Partial<CanvasOverlaySnapshot>): CanvasOverlaySnapshot {
  return { isOpen: false, kind: null, canvasId: null, ...partial }
}

describe('canvas store（分区与拉取收敛）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    commandMock.mockReset()
  })

  it('loadCanvas 成功落分区：canvasOf 可读全量视图，loadError 保持 null', async () => {
    const store = useCanvasStore()
    commandMock.mockResolvedValue(canvasState('cvs-1'))
    await store.loadCanvas('cvs-1')
    expect(commandMock).toHaveBeenCalledWith('canvas.get', { canvasId: 'cvs-1' }, expect.any(Number))
    expect(store.canvasOf('cvs-1')?.name).toBe('画布 cvs-1')
    expect(store.loadErrorOf('cvs-1')).toBeNull()
  })

  it('未拉取的画布 canvasOf 为 null（分区缺席非错误）', () => {
    const store = useCanvasStore()
    expect(store.canvasOf('cvs-none')).toBeNull()
    expect(store.loadErrorOf('cvs-none')).toBeNull()
  })

  it('拉取收敛：同画布第二次拉取后，先发在途的旧 reply 晚返回不倒拨（rev 守卫丢弃）', async () => {
    const store = useCanvasStore()
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
    const store = useCanvasStore()
    commandMock.mockResolvedValueOnce(canvasState('cvs-1'))
    await store.loadCanvas('cvs-1')
    commandMock.mockRejectedValueOnce(new Error('transport unavailable'))
    await store.loadCanvas('cvs-1')
    expect(store.canvasOf('cvs-1')?.name).toBe('画布 cvs-1')
    expect(store.loadErrorOf('cvs-1')).toContain('transport unavailable')
  })

  it('canvasId 空串 no-op（不发起 RPC）', async () => {
    const store = useCanvasStore()
    await store.loadCanvas('')
    expect(commandMock).not.toHaveBeenCalled()
  })

  it('listCanvases 成功：清单写入 + 错误复位', async () => {
    const store = useCanvasStore()
    commandMock.mockResolvedValue({ canvases: [{ canvasId: 'cvs-1', name: 'n', statement: 's', converged: false, openMustFix: 0, reviewStatus: null }] })
    await store.listCanvases()
    expect(commandMock).toHaveBeenCalledWith('canvas.list', {}, expect.any(Number))
    expect(store.list).toHaveLength(1)
    expect(store.listError).toBeNull()
  })

  it('清单收敛：在途旧清单 reply 晚返回不倒拨新清单（rev 守卫）', async () => {
    const store = useCanvasStore()
    let resolveFirst!: (v: { canvases: [] }) => void
    let resolveSecond!: (v: { canvases: [] }) => void
    commandMock.mockImplementationOnce(() => new Promise((r) => { resolveFirst = r }))
    commandMock.mockImplementationOnce(() => new Promise((r) => { resolveSecond = r }))
    const first = store.listCanvases()
    const second = store.listCanvases()
    resolveSecond({ canvases: [{ canvasId: 'cvs-2', name: 'n2', statement: 's2', converged: false, openMustFix: 0, reviewStatus: null }] })
    await second
    resolveFirst({ canvases: [] })
    await first
    expect(store.list).toHaveLength(1)
    expect(store.list[0]?.canvasId).toBe('cvs-2')
  })

  it('listCanvases 失败：listError 落错误且旧清单不清', async () => {
    const store = useCanvasStore()
    commandMock.mockResolvedValueOnce({ canvases: [{ canvasId: 'cvs-1', name: 'n', statement: 's', converged: false, openMustFix: 0, reviewStatus: null }] })
    await store.listCanvases()
    commandMock.mockRejectedValueOnce(new Error('channel down'))
    await store.listCanvases()
    expect(store.listError).toContain('channel down')
    expect(store.list).toHaveLength(1)
  })
})

describe('canvas store（关闭标记）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    commandMock.mockReset()
  })

  it('markClosedByUser 幂等打标；未打标画布 isClosedByUser 为 false', () => {
    const store = useCanvasStore()
    expect(store.isClosedByUser('cvs-1')).toBe(false)
    store.markClosedByUser('cvs-1')
    store.markClosedByUser('cvs-1')
    expect(store.isClosedByUser('cvs-1')).toBe(true)
    expect(store.isClosedByUser('cvs-2')).toBe(false)
  })

  it('空 canvasId 打标 no-op（防御）', () => {
    const store = useCanvasStore()
    store.markClosedByUser('')
    expect(store.isClosedByUser('')).toBe(false)
  })
})

describe('shouldAutoOpenCanvas（自动唤起判定②③，①由 evType 分流结构性成立）', () => {
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
        overlay: overlaySnap({ isOpen: true, kind: 'canvas', canvasId: 'cvs-other' }),
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
