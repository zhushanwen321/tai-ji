// @vitest-environment node

/**
 * useMessageEffects 测试（架构审计 §11.4 + remote-use D5 接线）。
 *
 * [remote-use D5] exited/restored/restoreFailed 的 core 最小语义归 core
 * createLifecycleEffects factory 单一归属（factory 自身行为在
 * core/src/domain/chat/__tests__/lifecycle-effects.test.ts 全覆盖）；本文件锁定：
 * - 桌面壳扩展四项接线：① extensionUIStore.clearSession（D6b/M8 清挂起弹窗分区）
 *   ② toast（首行 reason）③ 强杀分流（consumeForcedExit 命中 → 不进恢复窗口不建订阅）
 *   ④ respawn 过渡态及其回收（markRespawnPending / 30s timer / restored·熔断收口）
 * - factory 原语透传：exited → markSessionDead 序列入参；restored/restoreFailed 回调转发
 * - 恢复窗口订阅经 factory（subscribe RPC 经 setSubscriptionPorts 捕获，壳不直调 subscribeSession）
 * - 非 lifecycle 回调：onMessageComplete → focusedSid + handleCompletion；onSubagents →
 *   applyRecords；onSubagentEntries → applySubagentEntries（E-4 虚拟分区）；onGlobalError /
 *   onSessionError → toast；handleRuntimeUnavailable → finalizeAllStreaming + clearAllPending
 *
 * 运行：cd packages/renderer && npx vitest run src/composables/effects/__tests__/useMessageEffects.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { PiEntry, ServerMessageMap, SubagentRecord } from '@taiji/shared'
import { isSubagentVirtualId, extractBtwPiSessionId, extractMainSessionId } from '@taiji/shared'
import { isVirtualKeyOf, setSubscriptionPorts, resetSubscriptionStates, resetChatModuleStateForTest } from '@taiji/core'

const storeMocks = vi.hoisted(() => ({
  markSessionError: vi.fn(),
  finalizeAllStreaming: vi.fn(),
  applySubagentEntries: vi.fn(),
  markDead: vi.fn(),
  revive: vi.fn(),
  clearAllPending: vi.fn(),
  clearSession: vi.fn(),
  applyRecords: vi.fn(),
  triggerWorkflowReload: vi.fn(),
  // [T4] respawn 过渡态分区动作（handleSessionExited/Restored/RestoreFailed 消费）
  markRespawnPending: vi.fn(),
  clearRespawnPending: vi.fn(),
  isRespawnPending: vi.fn(),
  appendRespawnNotice: vi.fn(),
  // panel store 最小形状（panels 可整体替换模拟聚焦 session 变化）
  panels: [] as Array<{ id: string; sessionId: string | null }>,
  activePanelId: 'root-panel',
  toastError: vi.fn(),
  handleCompletion: vi.fn(),
}))

vi.mock('@/stores/chat', () => ({
  useChatStore: () => ({
    markSessionError: storeMocks.markSessionError,
    finalizeAllStreaming: storeMocks.finalizeAllStreaming,
    applySubagentEntries: storeMocks.applySubagentEntries,
    markRespawnPending: storeMocks.markRespawnPending,
    clearRespawnPending: storeMocks.clearRespawnPending,
    isRespawnPending: storeMocks.isRespawnPending,
    appendRespawnNotice: storeMocks.appendRespawnNotice,
  }),
}))
vi.mock('@/stores/session', () => ({
  useSessionStore: () => ({ markDead: storeMocks.markDead, revive: storeMocks.revive }),
}))
vi.mock('@/stores/panel', () => ({
  usePanelStore: () => ({ panels: storeMocks.panels, activePanelId: storeMocks.activePanelId }),
}))
vi.mock('@/stores/extension-ui', () => ({
  useExtensionUIStore: () => ({ clearAllPending: storeMocks.clearAllPending, clearSession: storeMocks.clearSession }),
}))
vi.mock('@/stores/subagent', () => ({
  useSubagentStore: () => ({ applyRecords: storeMocks.applyRecords }),
}))
vi.mock('@/stores/workflow', () => ({
  useWorkflowStore: () => ({ triggerWorkflowReload: storeMocks.triggerWorkflowReload }),
}))
vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ error: storeMocks.toastError }),
}))
vi.mock('@/composables/effects/useCompletionNotify', () => ({
  handleCompletion: storeMocks.handleCompletion,
}))

import { createInboundEffects, handleRuntimeUnavailable } from '../useMessageEffects'
import { markForcedExit, resetForcedExitMarks } from '../forced-exit-marks'

const effects = createInboundEffects()

/** subscribe RPC spy（factory 恢复窗口订阅经 setSubscriptionPorts 捕获——core 真链路，
 *  不 mock @taiji/core：factory 行为归 core 单测，本层只验证「订阅经 factory 建立」接线）。 */
const subscribeRpc = vi.fn().mockResolvedValue({ snapshot: [], stateSnapshot: [], lastSeq: 0 })

/** exited 后等恢复窗口订阅（fire-and-forget async）的同步段执行到 RPC 发出。 */
const flushSubscribes = async (): Promise<void> => {
  for (const r of subscribeRpc.mock.results) {
    await Promise.race([Promise.resolve(r.value).catch(() => {}), Promise.resolve()])
  }
  await Promise.resolve()
}

describe('createInboundEffects（§11.4 InboundEffects 接线）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    storeMocks.panels = []
    storeMocks.activePanelId = 'root-panel'
    storeMocks.isRespawnPending.mockReturnValue(false)
    resetChatModuleStateForTest()
    resetSubscriptionStates()
    resetForcedExitMarks()
    setSubscriptionPorts({ subscribe: subscribeRpc, replay: vi.fn() })
  })

  afterEach(() => {
    resetChatModuleStateForTest()
    resetSubscriptionStates()
    resetForcedExitMarks()
  })

  it('onSessionExited → markSessionError + markDead + clearSession（D6b 清挂起弹窗分区） + toast（reason 只取首行）', () => {
    effects.onSessionExited!('s1', { code: 1, reason: 'Session process exited (code: 1)\n\nError: ext load failed' })

    expect(storeMocks.markSessionError).toHaveBeenCalledWith('s1', 'Session process exited (code: 1)\n\nError: ext load failed')
    expect(storeMocks.markDead).toHaveBeenCalledWith('s1')
    // D6b：pi 死后清该 session 的 ask-user / dialog pending 分区（对齐 deleteSession 路径）
    expect(storeMocks.clearSession).toHaveBeenCalledWith('s1')
    expect(storeMocks.toastError).toHaveBeenCalledTimes(1)
    const msg = storeMocks.toastError.mock.calls[0]![0] as string
    // toast 含首行 reason + i18n 文案（zh-CN 默认 locale）
    expect(msg).toContain('Session process exited')
    expect(msg).not.toContain('ext load failed')
  })

  it('[D5 接线] 意外退出 → 经 factory 建立恢复窗口订阅（subscribe RPC 发出，壳不直调 subscribeSession）', async () => {
    effects.onSessionExited!('s1', { code: 1, reason: 'crashed' })

    expect(subscribeRpc).toHaveBeenCalledTimes(1)
    expect(subscribeRpc).toHaveBeenCalledWith('s1', undefined)
    await flushSubscribes()
  })

  it('[D5 接线] 强杀分流（壳扩展③）：consumeForcedExit 命中 → 不进过渡态、不建恢复窗口订阅', async () => {
    markForcedExit('s1')

    effects.onSessionExited!('s1', { code: 1, reason: 'force quit' })

    expect(storeMocks.markRespawnPending).not.toHaveBeenCalled()
    expect(subscribeRpc).not.toHaveBeenCalled()
    // 终态防御路径：清掉可能残留的过渡态
    expect(storeMocks.clearRespawnPending).toHaveBeenCalledWith('s1')
    // markSessionDead 序列与壳扩展①② 照常（core 序列在分流之前）
    expect(storeMocks.markSessionError).toHaveBeenCalledWith('s1', 'force quit')
    expect(storeMocks.clearSession).toHaveBeenCalledWith('s1')
    expect(storeMocks.toastError).toHaveBeenCalledTimes(1)
  })

  it('[D5 接线] 意外退出 → 进 respawnPending 过渡态（壳扩展④），30s 无收口事件则超时回收', () => {
    vi.useFakeTimers()
    try {
      storeMocks.isRespawnPending.mockReturnValue(true)
      effects.onSessionExited!('s1', { code: 1, reason: 'crashed' })

      expect(storeMocks.markRespawnPending).toHaveBeenCalledWith('s1')
      expect(storeMocks.clearRespawnPending).not.toHaveBeenCalled()

      vi.advanceTimersByTime(30_000)

      // 仍 pending → 超时切回终态 dead 页（保留「重新打开」出口）
      expect(storeMocks.clearRespawnPending).toHaveBeenCalledWith('s1')
    } finally {
      vi.useRealTimers()
    }
  })

  it('[D5 接线] 连续 exited 不重置计时窗口（幂等：仅挂一个 30s timer，首个到期回收）', () => {
    vi.useFakeTimers()
    try {
      storeMocks.isRespawnPending.mockReturnValue(true)
      effects.onSessionExited!('s1', { code: 1, reason: 'crashed' })
      effects.onSessionExited!('s1', { code: 1, reason: 'crashed again' })

      vi.advanceTimersByTime(30_000)

      // 第二次 exited 未另挂 timer → 只有首窗口到期的一次回收
      expect(storeMocks.clearRespawnPending).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('onSessionRestored → 收口过渡态（clearRespawnPending）+ core 序列经 factory（revive + restored 提示条 + 重订阅）', async () => {
    effects.onSessionRestored!('s1', { attempts: 2 })

    // 壳扩展④回收
    expect(storeMocks.clearRespawnPending).toHaveBeenCalledWith('s1')
    // core 序列透传（revive + 提示条文案由 factory 内部消费 i18n 注入值）
    expect(storeMocks.revive).toHaveBeenCalledWith('s1')
    expect(storeMocks.appendRespawnNotice).toHaveBeenCalledWith('s1', 'restored', expect.any(String))
    // 重订阅（恢复 live 订阅 + 完整回放）
    expect(subscribeRpc).toHaveBeenCalledTimes(1)
    await flushSubscribes()
  })

  it('onSessionRestoreFailed → willRetry=true 中间失败：不收口过渡态、无提示条', () => {
    effects.onSessionRestoreFailed!('s1', { attempts: 1, willRetry: true, reason: 'attach failed' })

    expect(storeMocks.clearRespawnPending).not.toHaveBeenCalled()
    expect(storeMocks.appendRespawnNotice).not.toHaveBeenCalled()
  })

  it('onSessionRestoreFailed → willRetry=false 熔断：恢复失败提示条（restoreFailed 形态）+ 收口过渡态', () => {
    effects.onSessionRestoreFailed!('s1', { attempts: 2, willRetry: false, reason: 'attach hard-fail' })

    expect(storeMocks.appendRespawnNotice).toHaveBeenCalledWith('s1', 'restoreFailed', expect.any(String))
    expect(storeMocks.clearRespawnPending).toHaveBeenCalledWith('s1')
  })

  it('onMessageComplete → 从 panel store 算 focusedSid 传给 handleCompletion（stop 直传）', () => {
    storeMocks.panels = [{ id: 'root-panel', sessionId: 's-focus' }]

    effects.onMessageComplete!('s-bg', { stopReason: 'stop' })

    // [retry-sound] 第 4 参 willRetry 透传（payload 缺省 → undefined）
    expect(storeMocks.handleCompletion).toHaveBeenCalledWith('s-bg', 'stop', 's-focus', undefined)
  })

  it('onMessageComplete → stopReason 缺省按 "stop"（兼容无 stopReason 的 complete）', () => {
    storeMocks.panels = [{ id: 'root-panel', sessionId: 's-focus' }]

    effects.onMessageComplete!('s-bg', {})

    expect(storeMocks.handleCompletion).toHaveBeenCalledWith('s-bg', 'stop', 's-focus', undefined)
  })

  it('onMessageComplete → 面板无匹配 session 时 focusedSid 为 null（未知面板结构兜底）', () => {
    storeMocks.panels = [{ id: 'other-panel', sessionId: 's-x' }]

    effects.onMessageComplete!('s-bg', { stopReason: 'error', willRetry: true })

    // [retry-sound] willRetry 透传第 4 参（中间失败静音判据）
    expect(storeMocks.handleCompletion).toHaveBeenCalledWith('s-bg', 'error', null, true)
  })

  it('onSubagents → applyRecords(sid, list)', () => {
    const records: SubagentRecord[] = [{ id: 'sa-1', status: 'done' }] as SubagentRecord[]

    effects.onSubagents!('s1', records)

    expect(storeMocks.applyRecords).toHaveBeenCalledWith('s1', records)
  })

  it('onSubagentEntries → chatStore.applySubagentEntries(virtualId, entries)（E-4：虚拟 id 经 shared 工厂三段式构造）', () => {
    const entries: PiEntry[] = [
      {
        type: 'message',
        parentId: null,
        timestamp: '2026-08-25T00:00:00.000Z',
        message: { role: 'user', content: [{ type: 'text', text: '分析这个仓库' }], timestamp: 1000 },
      },
    ]

    effects.onSubagentEntries!('s-main', 'rec-9', entries)

    expect(storeMocks.applySubagentEntries).toHaveBeenCalledWith('subagent:s-main:rec-9', entries)
  })

  it('onWorkflowUpdate → triggerWorkflowReload(sid)；update.status 不再透传（500ms 盲等重试删除，待裁决项 5）', () => {
    effects.onWorkflowUpdate!('s1', { runId: 'wf-1', status: 'running' })
    expect(storeMocks.triggerWorkflowReload).toHaveBeenCalledWith('s1')

    storeMocks.triggerWorkflowReload.mockClear()
    // status 缺省的坏形状同样只透传 sid（信号到达即拉一次，无 status 消费场景）
    effects.onWorkflowUpdate!('s1', { runId: 'wf-1' } as ServerMessageMap['session.workflowUpdate']['update'])
    expect(storeMocks.triggerWorkflowReload).toHaveBeenCalledWith('s1')
  })

  it('onGlobalError → toast.error(message)', () => {
    effects.onGlobalError!('config load failed')

    expect(storeMocks.toastError).toHaveBeenCalledWith('config load failed')
  })

  it('onSessionError → markSessionError（i18n 前缀 + runtime message）+ toast（D6b：残留弹窗作答失败可见）', () => {
    effects.onSessionError!('s1', { code: 'handler_error', message: 'No active session for extension response: s1' })

    // zh-CN 默认 locale：i18n 前缀 + 透传 runtime message
    expect(storeMocks.markSessionError).toHaveBeenCalledWith('s1', '会话请求失败：No active session for extension response: s1')
    expect(storeMocks.toastError).toHaveBeenCalledWith('会话请求失败：No active session for extension response: s1')
  })
})

describe('handleRuntimeUnavailable（T5 runtime 崩溃清理接线）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("reason='restart' → finalizeAllStreaming('restart') + clearAllPending", () => {
    handleRuntimeUnavailable('restart')

    expect(storeMocks.finalizeAllStreaming).toHaveBeenCalledWith('restart')
    expect(storeMocks.clearAllPending).toHaveBeenCalledTimes(1)
  })

  it("reason='disconnect' → finalizeAllStreaming('disconnect') + clearAllPending", () => {
    handleRuntimeUnavailable('disconnect')

    expect(storeMocks.finalizeAllStreaming).toHaveBeenCalledWith('disconnect')
    expect(storeMocks.clearAllPending).toHaveBeenCalledTimes(1)
  })
})

describe('[B1 / btw-question D9③] 生产半边：onSubagentEntries 对 btw 线 vid 的键中段翻译', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  const entries: PiEntry[] = [
    {
      type: 'message',
      parentId: null,
      timestamp: '2026-09-22T00:00:00.000Z',
      message: { role: 'assistant', content: [{ type: 'text', text: 'line derived' }], timestamp: 1 },
    },
  ]

  it('① 线 vid 输入 → subagent:<线piSid>:<s> 三段键（不 throw）+ ② 命中 M4-a 清理前缀谓词（闭环）', () => {
    const vid = 'btw:line-fx-b1'
    expect(() => effects.onSubagentEntries!(vid, 'rec-b1', entries)).not.toThrow()

    const key = 'subagent:line-fx-b1:rec-b1'
    expect(storeMocks.applySubagentEntries).toHaveBeenCalledWith(key, entries)
    expect(isSubagentVirtualId(key)).toBe(true)
    expect(extractMainSessionId(key)).toBe('line-fx-b1') // 中段 = 线 piSessionId（M1-a 约定）
    // ② 清理闭环：该键命中 disposeBtwLinePartitions 使用的同一前缀谓词
    //（isVirtualKeyOf(key, owner) —— owner = extractBtwPiSessionId(vid)）
    expect(isVirtualKeyOf(key, extractBtwPiSessionId(vid))).toBe(true)
  })

  it('③ 非 btw 输入零变化回归（直译不翻译）', () => {
    effects.onSubagentEntries!('s-plain', 'rec-9', entries)
    expect(storeMocks.applySubagentEntries).toHaveBeenCalledWith('subagent:s-plain:rec-9', entries)
  })
})
