// @vitest-environment node

/**
 * useChat.sendBash / abortBash 单测（composer-bash-execute W2 + timeout-slow-flow-wallclock ①b）。
 *
 * 验证：
 * - T4: sendBash('s1','git status',false) → chatApi.bash 透传（sid, command, excludeFromContext）
 * - T5: chatApi.bash reject 且合成终态已收（executingBash 为空）→ toast 抑制 + sendBash resolve
 *       （①b timeout-slow-flow-wallclock D2/r4 极性：气泡终态是权威呈现面，不再弹「失败」toast）
 * - T5b: chatApi.bash reject 且终态未到（executingBash 非空 = env backstop 先到形态）→
 *       toastError 被调（toast 是唯一提示）+ sendBash resolve
 * - T6: abortBash 透传参数给 chatApi.abortBash
 *
 * 策略：mock @/api（vi.hoisted 捕获 streamSubscribe handler，向其注入 bashStart/bashResult
 * ServerMessage 构造 executingBash 置/清形态）+ 真 pinia + 真 chatStore。对齐
 * src/__tests__/useChat.test.ts 的 holder/emit 惯例与 core useChat.test.ts 的 ①b 三形态。
 * 每个测试用唯一 sid：executingBash 是 bash-effects 模块级 Map，resetChatModuleState 不清它。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/composables/useChat-bash.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { ServerMessage } from '@taiji/shared'

// ── api mock（holder 捕获 streamSubscribe 的 handler，注入 bash 帧用）──
const apiMock = vi.hoisted(() => {
  const holder: { handler: ((msg: ServerMessage) => void) | null } = { handler: null }
  return {
    holder,
    bash: vi.fn(() => Promise.resolve()),
    abortBash: vi.fn(() => Promise.resolve()),
    streamSubscribe: vi.fn((_sid: string, handler: (msg: ServerMessage) => void) => {
      holder.handler = handler
      return () => {
        holder.handler = null
      }
    }),
  }
})

vi.mock('@/api', () => ({ project: { load: vi.fn().mockResolvedValue({ projects: [], activeProjectId: '' }), save: vi.fn().mockResolvedValue(undefined) },
  chat: {
    bash: apiMock.bash,
    abortBash: apiMock.abortBash,
    streamSubscribe: apiMock.streamSubscribe,
  },
  // w5：useChat 薄包装 import session.writeSegments（写 segments sidecar），测试 mock 补全
  session: {
    writeSegments: vi.fn().mockResolvedValue(undefined),
  },
}))

// ── useToast mock：捕获 error 调用 ──
const toastError = vi.hoisted(() => vi.fn())
vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ error: toastError }),
}))

import { useChat, resetChatModuleState } from '@/composables/features/chat/useChat'

beforeEach(() => {
  setActivePinia(createPinia())
  resetChatModuleState()
  vi.clearAllMocks()
  apiMock.holder.handler = null
})

/** 向被测 useChat 订阅的 handler 注入一条 ServerMessage */
function emit(msg: ServerMessage): void {
  if (apiMock.holder.handler) apiMock.holder.handler(msg)
}

/** bashStart 帧（bash-effects executingBash 置位） */
function emitBashStart(sid: string, command: string): void {
  emit({ type: 'message.bashStart', payload: { sessionId: sid, command, excludeFromContext: false, timestamp: 1724000000000 } })
}

/** bashResult 真实终态帧（abortBash 兜底终态已独立为 message.bashAborted 帧，msg-pipeline-debloat D4-3） */
function emitBashResult(sid: string, command: string, output: string): void {
  emit({
    type: 'message.bashResult',
    payload: { sessionId: sid, command, output, exitCode: null, cancelled: false, truncated: false, excludeFromContext: false, timestamp: 1724000000001 },
  })
}

describe('useChat.sendBash / abortBash', () => {
  it('T4: sendBash 透传参数给 chatApi.bash（含 excludeFromContext）', async () => {
    const { sendBash } = useChat()
    await sendBash('s1', 'git status', false)

    expect(apiMock.bash).toHaveBeenCalledOnce()
    expect(apiMock.bash).toHaveBeenCalledWith('s1', 'git status', false)
    // 失败时才 toast，成功路径不调
    expect(toastError).not.toHaveBeenCalled()
  })

  it('T5: error envelope 携带分类码 message_blocked（bash handler blocked 失败，错误气泡已广播）→ toast 抑制 + sendBash resolve', async () => {
    // D4-2 分类码路由：bash reject 携带 runtime 分类码 'message_blocked'（错误气泡呈现
    // 已由 runtime 编排），再弹「失败」toast 冗余且误导 → 抑制。
    let rejectBash: (e: unknown) => void = () => {}
    apiMock.bash.mockImplementation(() => new Promise((_resolve, reject) => { rejectBash = reject }))
    const { sendBash } = useChat()

    const sending = sendBash('s-term', 'sleep 3700', false)
    emitBashStart('s-term', 'sleep 3700')
    emitBashResult('s-term', 'sleep 3700', '命令执行超过 1 小时，已停止等待——命令可能仍在后台运行。……')
    rejectBash(Object.assign(new Error('Bash execution failed'), { code: 'message_blocked' }))
    await expect(sending).resolves.toBe(false) // 不 throw（错误已消化，与 send/abort 同策略）；[R2-A5] 失败返回 false

    expect(apiMock.bash).toHaveBeenCalledOnce()
    expect(toastError).not.toHaveBeenCalled()
  })

  it('T5b: pending 超时 reject（机械码 timeout = runtime 呈现未发生）→ toastError 被调', async () => {
    // env 逃生门形态：renderer backstop（3660s）先于 runtime 3600s 判死，气泡无终态，
    // toast 是唯一提示（D5 不变量收窄的已知接受行为）→ 不抑制。
    let rejectBash: (e: unknown) => void = () => {}
    apiMock.bash.mockImplementation(() => new Promise((_resolve, reject) => { rejectBash = reject }))
    const { sendBash } = useChat()

    const sending = sendBash('s-inflight', 'sleep 3700', false)
    emitBashStart('s-inflight', 'sleep 3700')
    rejectBash(Object.assign(new Error('request timeout after 3660000ms'), { code: 'timeout' }))
    await expect(sending).resolves.toBe(false)

    expect(apiMock.bash).toHaveBeenCalledOnce()
    expect(toastError).toHaveBeenCalledOnce()
    // 收尾：bashAborted 帧（abortBash 兜底终态独立帧，msg-pipeline-debloat D4-3）清 executingBash，
    // 防 bash-effects 模块级 Map 残留泄漏到后续用例（resetChatModuleState 不清该 Map）
    emit({ type: 'message.bashAborted', payload: { sessionId: 's-inflight', timestamp: 1724000000002 } })
  })

  it('T6: abortBash 透传参数给 chatApi.abortBash', async () => {
    const { abortBash } = useChat()
    await abortBash('s1')

    expect(apiMock.abortBash).toHaveBeenCalledOnce()
    expect(apiMock.abortBash).toHaveBeenCalledWith('s1')
  })
})
