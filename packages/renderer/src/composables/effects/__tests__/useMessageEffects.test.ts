/**
 * useMessageEffects 测试（架构审计 §11.4）。
 *
 * core use-connection 是 headless（零 store），副作用回调实现归位 renderer 本层。
 * 本测试锁定 InboundEffects 回调的 store/toast 接线 + runtime 清理回调：
 * - onSessionExited → markSessionError + markDead + clearSession（D6b 清挂起弹窗分区）+ toast（首行 reason）
 * - onMessageComplete → 算 focusedSid + handleCompletion（aborted 过滤链在
 *   useCompletionNotify.test.ts 覆盖，本层只验证接线）
 * - onSubagents → applyRecords；onWorkflowUpdate → triggerWorkflowReload
 * - onSubagentEntries → chatStore.applySubagentEntries（虚拟分区 id 经 shared 工厂构造，
 *   E-4 relay tee entry 帧兜底接线）
 * - onSubagentStreamDelta → chatStore.refreshStreamingTimer(父sid)（[idle-refresh]
 *   timeout-streaming-ui-idle.md §5.1 D1 桥接：双形态解析 + 坏形状 no-op）
 * - onGlobalError → toast
 * - onSessionError → markSessionError + toast（D6b：带 sid error envelope 兜底展示）
 * - handleRuntimeUnavailable → finalizeAllStreaming + clearAllPending（T5）
 *
 * 运行：cd packages/renderer && npx vitest run src/composables/effects/__tests__/useMessageEffects.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { PiEntry, ServerMessage, ServerMessageMap, SubagentRecord } from '@xyz-agent/shared'

const storeMocks = vi.hoisted(() => ({
  markSessionError: vi.fn(),
  finalizeAllStreaming: vi.fn(),
  applySubagentEntries: vi.fn(),
  refreshStreamingTimer: vi.fn(),
  markDead: vi.fn(),
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
    refreshStreamingTimer: storeMocks.refreshStreamingTimer,
    markRespawnPending: storeMocks.markRespawnPending,
    clearRespawnPending: storeMocks.clearRespawnPending,
    isRespawnPending: storeMocks.isRespawnPending,
    appendRespawnNotice: storeMocks.appendRespawnNotice,
  }),
}))
vi.mock('@/stores/session', () => ({
  useSessionStore: () => ({ markDead: storeMocks.markDead }),
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

const effects = createInboundEffects()

describe('createInboundEffects（§11.4 InboundEffects 接线）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    storeMocks.panels = []
    storeMocks.activePanelId = 'root-panel'
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

  it('onSubagentStreamDelta → refreshStreamingTimer(父sid)（[idle-refresh] tee 通道虚拟 id 三段式解析）', () => {
    effects.onSubagentStreamDelta!({
      type: 'subagent.stream_delta',
      payload: { sessionId: 'subagent:s-main:bg-1', recordId: 'bg-1', lines: ['partial'] },
    } as unknown as ServerMessage)

    // 虚拟 id 解析出父 session id 后刷新（编排期父气泡 idle 计时得以续命）
    expect(storeMocks.refreshStreamingTimer).toHaveBeenCalledTimes(1)
    expect(storeMocks.refreshStreamingTimer).toHaveBeenCalledWith('s-main')
  })

  it('onSubagentStreamDelta → 旧 widget 通道主 sid 原样刷新（双形态兼容）', () => {
    effects.onSubagentStreamDelta!({
      type: 'subagent.stream_delta',
      payload: { sessionId: 's-main-raw', recordId: 'bg-1', lines: ['partial'] },
    } as unknown as ServerMessage)

    expect(storeMocks.refreshStreamingTimer).toHaveBeenCalledWith('s-main-raw')
  })

  it('onSubagentStreamDelta → payload.sessionId 缺失 no-op（坏形状帧防御，纯函数解析无失败形态）', () => {
    effects.onSubagentStreamDelta!({
      type: 'subagent.stream_delta',
      payload: { recordId: 'bg-1', lines: ['partial'] },
    } as unknown as ServerMessage)
    effects.onSubagentStreamDelta!({
      type: 'subagent.stream_delta',
      payload: null,
    } as unknown as ServerMessage)

    expect(storeMocks.refreshStreamingTimer).not.toHaveBeenCalled()
  })

  it('onWorkflowUpdate → triggerWorkflowReload(sid, status)；status 缺省按 "unknown"（防御运行时坏形状）', () => {
    effects.onWorkflowUpdate!('s1', { runId: 'wf-1', status: 'running' })
    expect(storeMocks.triggerWorkflowReload).toHaveBeenCalledWith('s1', 'running')

    storeMocks.triggerWorkflowReload.mockClear()
    // protocol SSOT 声明 status 必填，但运行时不可信——缺 status 时兜底 'unknown'（显式 cast 模拟坏形状）
    effects.onWorkflowUpdate!('s1', { runId: 'wf-1' } as ServerMessageMap['session.workflowUpdate']['update'])
    expect(storeMocks.triggerWorkflowReload).toHaveBeenCalledWith('s1', 'unknown')
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
