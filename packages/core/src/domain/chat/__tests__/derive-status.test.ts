/**
 * deriveStatus 纯函数 9 态 parity 单测（renderer-model M3 搬迁锁定）。
 *
 * 搬迁前（renderer composables/logic/sessionStatus.ts）行为由
 * renderer 测试锁定（derive-status-meta / derive-status-ask-user / session-status-icons /
 * toolcall-anchor / useBackgroundWork / useSessionStreamSync-boundary）。本文件在 core 侧
 * 复刻全 9 态矩阵 + metaStatus 兜底 + ask-user 分支，防搬迁漂移（P-derive-parity 单测部分）。
 *
 * 运行：cd packages/core && npx vitest run src/domain/chat/__tests__/derive-status.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { effectScope } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { createChatStore } from '../store'
import type { ChatStoreInstance } from '../store'
import { deriveStatus } from '../derive-status'
import type { Message, ServerMessage } from '@taiji/shared'

/** 构造独立 store 实例（effectScope 包裹 onScopeDispose 注册 + 测试隔离）。返回 store + dispose。 */
function makeStore(): { store: ChatStoreInstance; dispose: () => void } {
  const scope = effectScope(true)
  const store = scope.run(() => createChatStore())!
  return { store, dispose: () => scope.stop() }
}

/** 构造 complete assistant 消息 */
function assistantMsg(id: string, overrides: Partial<Message> = {}): Message {
  return { id, role: 'assistant', content: 'ok', status: 'complete', timestamp: 1, ...overrides }
}

describe('deriveStatus 9 态 parity（M3 搬迁）', () => {
  let sut: { store: ChatStoreInstance; dispose: () => void }

  beforeEach(() => {
    vi.useFakeTimers()
    setActivePinia(createPinia())
    sut = makeStore()
  })

  afterEach(() => {
    sut.dispose()
    vi.useRealTimers()
  })

  it('未 hydrate + 非活跃 → done（兜底）', () => {
    expect(sut.store.getMessages('s1')).toHaveLength(0)
    expect(deriveStatus('s1', sut.store, false)).toBe('done')
  })

  it('isActive=true（pendingSend 空窗）→ pending', () => {
    sut.store.addPendingSend('s1')
    expect(sut.store.isActive('s1')).toBe(true)
    expect(deriveStatus('s1', sut.store, true)).toBe('pending')
  })

  it('streaming（message_start → isGenerating）→ streaming', () => {
    sut.store.applyMessageEvent('s1', {
      type: 'message.message_start',
      payload: { sessionId: 's1', messageId: 'a1' },
    } as ServerMessage)
    expect(sut.store.isGenerating('s1')).toBe(true)
    expect(deriveStatus('s1', sut.store, true)).toBe('streaming')
  })

  it('末条 assistant status=streaming → streaming（不依赖 isGenerating）', () => {
    sut.store.hydrate('s1', [assistantMsg('m1', { status: 'streaming' })])
    expect(deriveStatus('s1', sut.store, false)).toBe('streaming')
  })

  it('isCompacting=true → compacting', () => {
    sut.store.setOccupancy('s1', { turn: 'idle', compacting: true, bash: false })
    expect(deriveStatus('s1', sut.store, false, true)).toBe('compacting')
  })

  it('hasBackgroundWork=true → working（主 turn 结束，background 仍在跑）', () => {
    sut.store.hydrate('s1', [assistantMsg('m1')])
    expect(deriveStatus('s1', sut.store, false, false, true)).toBe('working')
  })

  it('末条 assistant toolCall running → waiting（最优先）', () => {
    sut.store.hydrate('s1', [
      assistantMsg('m1', {
        status: 'streaming',
        toolCalls: [{ id: 't1', toolName: 'bash', input: {}, status: 'running', startTime: 0 }],
      }),
    ])
    expect(deriveStatus('s1', sut.store, false)).toBe('waiting')
  })

  it('hasFormOverlayPending=true → waiting（与 toolCall 并列最优先）', () => {
    // 未 hydrate + 非活跃 → 单独看兜底 done；富交互表单 pending 应改判 waiting
    expect(deriveStatus('s1', sut.store, false, false, false, undefined, true)).toBe('waiting')
  })

  it('hasFormOverlayPending 默认 false：不传第 7 参行为不变', () => {
    expect(deriveStatus('s1', sut.store, false)).toBe('done')
    expect(deriveStatus('s1', sut.store, false, false, false, undefined, false)).toBe('done')
  })

  it('末条 assistant status=error → error', () => {
    sut.store.hydrate('s1', [assistantMsg('m1', { status: 'error' })])
    expect(deriveStatus('s1', sut.store, false)).toBe('error')
  })

  it('末条 assistant isInterrupted → stopped', () => {
    sut.store.hydrate('s1', [assistantMsg('m1', { isInterrupted: true })])
    expect(deriveStatus('s1', sut.store, false)).toBe('stopped')
  })

  it('末条 assistant complete → done', () => {
    sut.store.hydrate('s1', [assistantMsg('m1')])
    expect(deriveStatus('s1', sut.store, false)).toBe('done')
  })
})

describe('deriveStatus metaStatus 兜底（W6，未 hydrate）', () => {
  let sut: { store: ChatStoreInstance; dispose: () => void }

  beforeEach(() => {
    vi.useFakeTimers()
    setActivePinia(createPinia())
    sut = makeStore()
  })

  afterEach(() => {
    sut.dispose()
    vi.useRealTimers()
  })

  it('未 hydrate + metaStatus=error → error', () => {
    expect(deriveStatus('s1', sut.store, false, false, false, 'error')).toBe('error')
  })

  it('未 hydrate + metaStatus=stopped → stopped', () => {
    expect(deriveStatus('s1', sut.store, false, false, false, 'stopped')).toBe('stopped')
  })

  it('未 hydrate + metaStatus=done → done', () => {
    expect(deriveStatus('s1', sut.store, false, false, false, 'done')).toBe('done')
  })

  it('未 hydrate + metaStatus=idle（历史 session）→ 兜底 done', () => {
    expect(deriveStatus('s1', sut.store, false, false, false, 'idle')).toBe('done')
  })

  it('未 hydrate + 无 metaStatus → 兜底 done', () => {
    expect(deriveStatus('s1', sut.store, false, false, false)).toBe('done')
  })

  it('已 hydrate 不受 metaStatus 干扰（末条 error 优先）', () => {
    sut.store.hydrate('s1', [assistantMsg('m1', { status: 'error' })])
    expect(deriveStatus('s1', sut.store, false, false, false, 'done')).toBe('error')
  })
})

describe('deriveStatus 优先级回归（retrying > compacting > streaming）', () => {
  let sut: { store: ChatStoreInstance; dispose: () => void }

  beforeEach(() => {
    vi.useFakeTimers()
    setActivePinia(createPinia())
    sut = makeStore()
  })

  afterEach(() => {
    sut.dispose()
    vi.useRealTimers()
  })

  it('retryStates 存在 → retrying（高于 streaming）', () => {
    sut.store.applyMessageEvent('s1', {
      type: 'message.message_start',
      payload: { sessionId: 's1', messageId: 'a1' },
    } as ServerMessage)
    // 注入 retry 状态（经 store 公开 API 不可直接写，这里走 deriveStatus 的 getRetryState
    // 结构接口——用 spy 验证 retrying 分支优先于 streaming）
    const withRetry = {
      ...sut.store,
      getRetryState: () => ({ attempt: 1, inProgress: true }),
    }
    expect(deriveStatus('s1', withRetry, true)).toBe('retrying')
  })
})
