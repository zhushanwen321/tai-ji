/**
 * useInboundFrameGuard 单测（crash-forensics-and-watchdog §3.3 D8 / §4 A6 renderer 半边）。
 *
 * 覆盖（core ws-client 守卫在 core 已有 11 用例；本文件只验 renderer 消费编排）：
 * - 台账上报：每次丢帧（含无法归因形态）经既有 renderer-log 通道带结构化标记上报，
 *   否则 A6 的台账 ×4 计数语义在 renderer 侧断链
 * - 静态提示态投影：valveTripped → 该 session 置位；其余 session 不连坐
 * - 恢复触发器：用户切走再切回 tripped session → 解除暂停 + 重试订阅恰好一次；
 *   非 tripped 切换 / 原地不动（cur===prev）零动作；首次进入 tripped session 亦触发
 *   （从宽语义，见 composable 注释）；retry 返回 false（非 tripped 残留防御）不重试订阅
 * - install 幂等 / uninstall 解绑（teardown 配对）
 *
 * mock 策略：partial mock '@taiji/core'（onInboundFrameDropped 捕获回调 +
 * retryInboundDroppedSession/subscribeSession 调用断言）+ '@/lib/ipc'（reportRendererLog）；
 * 真实 Pinia（panel store 的 focusedSessionId 是 watch 数据源）。
 *
 * 运行：cd packages/renderer && npx vitest run src/composables/__tests__/useInboundFrameGuard.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import type { InboundFrameDroppedInfo } from '@taiji/core'
import { ROOT_PANEL_ID, usePanelStore } from '@/stores/panel'
import {
  installInboundFrameGuard,
  uninstallInboundFrameGuard,
  isInboundSessionTripped,
  _resetInboundFrameGuardForTest,
} from '../useInboundFrameGuard'

const coreMock = vi.hoisted(() => ({
  onInboundFrameDropped: vi.fn(),
  retryInboundDroppedSession: vi.fn(),
  subscribeSession: vi.fn(),
}))
const reportMock = vi.hoisted(() => vi.fn())

vi.mock('@taiji/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@taiji/core')>()),
  onInboundFrameDropped: coreMock.onInboundFrameDropped,
  retryInboundDroppedSession: coreMock.retryInboundDroppedSession,
  subscribeSession: coreMock.subscribeSession,
}))

vi.mock('@/lib/ipc', () => ({ reportRendererLog: reportMock }))

/** 捕获 core 侧注册的丢帧回调（install 时绑定，卸载后置 null）。 */
let dropCallback: ((info: InboundFrameDroppedInfo) => void) | null = null

function makeDrop(overrides: Partial<InboundFrameDroppedInfo> = {}): InboundFrameDroppedInfo {
  return {
    sessionId: 's1',
    frameSize: 42_000_001,
    kind: 'text',
    valveTripped: false,
    sessionDropCount: 1,
    ...overrides,
  }
}

describe('useInboundFrameGuard 入站守卫 renderer 消费编排（D8 / A6）', () => {
  let panel: ReturnType<typeof usePanelStore>

  /** 模拟 core 侧处理完一帧后的回调通知（valveTripped 由 core 判定）。 */
  function fireDrop(overrides: Partial<InboundFrameDroppedInfo> = {}): void {
    expect(dropCallback, 'installInboundFrameGuard 应先绑定 onInboundFrameDropped').toBeTypeOf('function')
    dropCallback?.(makeDrop(overrides))
  }

  beforeEach(() => {
    _resetInboundFrameGuardForTest()
    dropCallback = null
    coreMock.onInboundFrameDropped.mockReset()
    coreMock.retryInboundDroppedSession.mockReset().mockReturnValue(false)
    coreMock.subscribeSession.mockReset().mockResolvedValue(undefined)
    reportMock.mockReset()
    coreMock.onInboundFrameDropped.mockImplementation((cb: (info: InboundFrameDroppedInfo) => void) => {
      dropCallback = cb
      return () => {
        if (dropCallback === cb) dropCallback = null
      }
    })
    setActivePinia(createPinia())
    panel = usePanelStore()
  })

  afterEach(() => {
    _resetInboundFrameGuardForTest()
  })

  it('每次丢帧都上报（含无法归因形态）——A6 台账 ×4 计数的 renderer 侧源头', () => {
    installInboundFrameGuard()

    // 4 次丢弃：1-3 为同 session 连续（第 3 次 trip），第 4 次继续上报
    for (let i = 1; i <= 4; i++) {
      fireDrop({ sessionDropCount: i, valveTripped: i === 3 })
    }
    // 无法归因（binary 帧 / 头部无锚）：仍然上报（sessionId 字段省略，不落 null）
    fireDrop({ sessionId: null, kind: 'binary', frameSize: 9_000_000, sessionDropCount: 0 })

    expect(reportMock).toHaveBeenCalledTimes(5)
    expect(reportMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        source: 'inbound-frame-dropped',
        sessionId: 's1',
        message: expect.stringContaining('42000001 code units'),
      }),
    )
    const unattributed = reportMock.mock.calls[4][0] as { sessionId?: string; message: string }
    expect(unattributed.sessionId).toBeUndefined()
    expect(unattributed.message).toContain('9000000 bytes')
  })

  it('valveTripped 才置静态提示态，且单 session 作用域（其余 session 不连坐）', () => {
    installInboundFrameGuard()

    fireDrop({ sessionDropCount: 1, valveTripped: false })
    expect(isInboundSessionTripped('s1')).toBe(false) // 未到阈值：无提示

    fireDrop({ sessionId: 's1', sessionDropCount: 3, valveTripped: true })
    expect(isInboundSessionTripped('s1')).toBe(true)
    expect(isInboundSessionTripped('s2')).toBe(false) // 不连坐

    // 无法归因的 trip（sessionId=null，真实形态不会发生）不产生任何 session 提示态
    fireDrop({ sessionId: null, sessionDropCount: 0, valveTripped: true })
    expect(isInboundSessionTripped('s1')).toBe(true)
  })

  it('切走再切回 tripped session → 解除暂停 + 重试订阅恰好一次，提示态清除', async () => {
    installInboundFrameGuard()
    coreMock.retryInboundDroppedSession.mockReturnValue(true)
    panel.loadSession(ROOT_PANEL_ID, 's1') // 用户正停在 s1
    await nextTick()

    fireDrop({ sessionDropCount: 3, valveTripped: true }) // s1 触发终止阀（切焦点才触发恢复）
    expect(isInboundSessionTripped('s1')).toBe(true)
    expect(coreMock.retryInboundDroppedSession).not.toHaveBeenCalled()

    panel.loadSession(ROOT_PANEL_ID, 's2') // 切走（非 tripped：零动作）
    await nextTick()
    expect(coreMock.retryInboundDroppedSession).not.toHaveBeenCalled()
    expect(coreMock.subscribeSession).not.toHaveBeenCalled()

    panel.loadSession(ROOT_PANEL_ID, 's1') // 切回（恢复触发器命中）
    await nextTick()
    expect(coreMock.retryInboundDroppedSession).toHaveBeenCalledTimes(1)
    expect(coreMock.retryInboundDroppedSession).toHaveBeenCalledWith('s1')
    expect(coreMock.subscribeSession).toHaveBeenCalledTimes(1) // 重试订阅一次
    expect(coreMock.subscribeSession).toHaveBeenCalledWith('s1')
    expect(isInboundSessionTripped('s1')).toBe(false) // 提示态随恢复动作清除

    // 原地不动（cur === prev）不重复触发
    panel.loadSession(ROOT_PANEL_ID, 's1')
    await nextTick()
    expect(coreMock.subscribeSession).toHaveBeenCalledTimes(1)
  })

  it('trip 后首次进入该 session 亦触发一次（从宽语义）', async () => {
    installInboundFrameGuard()
    coreMock.retryInboundDroppedSession.mockReturnValue(true)
    fireDrop({ sessionDropCount: 3, valveTripped: true })

    panel.loadSession(ROOT_PANEL_ID, 's1') // null → s1 = 切入动作
    await nextTick()
    expect(coreMock.retryInboundDroppedSession).toHaveBeenCalledWith('s1')
    expect(coreMock.subscribeSession).toHaveBeenCalledWith('s1')
    expect(isInboundSessionTripped('s1')).toBe(false)
  })

  it('retry 返回 false（core 侧非 tripped 残留防御）→ 不重试订阅、提示态保留，下次用户动作可再试', async () => {
    installInboundFrameGuard()
    panel.loadSession(ROOT_PANEL_ID, 's1')
    await nextTick()
    fireDrop({ sessionDropCount: 3, valveTripped: true })

    coreMock.retryInboundDroppedSession.mockReturnValue(false) // 例：core 阀门已因其他路径归零
    panel.loadSession(ROOT_PANEL_ID, 's2')
    await nextTick()
    panel.loadSession(ROOT_PANEL_ID, 's1')
    await nextTick()

    expect(coreMock.retryInboundDroppedSession).toHaveBeenCalledWith('s1')
    expect(coreMock.subscribeSession).not.toHaveBeenCalled() // 未解除：不发重试订阅
    expect(isInboundSessionTripped('s1')).toBe(true) // 提示态保留

    // 恢复动作未被这次失败烧掉：下一次切换重试成功即清除
    coreMock.retryInboundDroppedSession.mockReturnValue(true)
    panel.loadSession(ROOT_PANEL_ID, 's2')
    await nextTick()
    panel.loadSession(ROOT_PANEL_ID, 's1')
    await nextTick()
    expect(coreMock.subscribeSession).toHaveBeenCalledTimes(1)
    expect(isInboundSessionTripped('s1')).toBe(false)
  })

  it('install 幂等；uninstall 解绑 core 监听与 focus watch（teardown 配对）', async () => {
    installInboundFrameGuard()
    installInboundFrameGuard()
    expect(coreMock.onInboundFrameDropped).toHaveBeenCalledTimes(1) // 幂等：只注册一次

    uninstallInboundFrameGuard()
    expect(dropCallback).toBeNull() // core 侧监听已解绑
    panel.loadSession(ROOT_PANEL_ID, 's1')
    await nextTick()
    expect(coreMock.retryInboundDroppedSession).not.toHaveBeenCalled() // watch 已停
    // 重新安装仍可用（幂等标志复位）
    installInboundFrameGuard()
    expect(coreMock.onInboundFrameDropped).toHaveBeenCalledTimes(2)
  })
})
