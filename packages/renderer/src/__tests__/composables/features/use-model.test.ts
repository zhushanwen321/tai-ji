/**
 * useModel 回执消费测试（U6/C-pi-13，pi-boundary-reliability D3②）。
 *
 * 锁定（事故 B 根因 ③ + 事故 A 形态——「无受理确认 + 乐观写」的闭合）：
 * - thinkingLevel 显示值 = reply 回执的生效值（pi 钳制时 ≠ 请求值，如 mimo 族 max → high），
 *   第一毫秒起就是真值——不存在 30s 后「自己变回去」；
 * - modelId 显示值 = reply 回执的生效值（pi pattern 引擎静默换模时生效 ≠ 请求）；
 * - RPC 失败不写 store（显示保持旧真值，无乐观写路径）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/composables/features/use-model.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const mocks = vi.hoisted(() => ({
  setThinkingLevel: vi.fn(),
  switchModel: vi.fn(),
}))

vi.mock('@taiji/core/transport/api/domains/session', () => ({
  setThinkingLevel: mocks.setThinkingLevel,
}))
vi.mock('@taiji/core/transport/api/domains/model', () => ({
  switchModel: mocks.switchModel,
  onModels: vi.fn(() => () => {}),
  listModels: vi.fn(),
}))

// 门面重定向（api index → domains，与 submit-firstmessage-pull.test.ts 同款）
vi.mock('@/api', async (importActual) => {
  const actual = await importActual<typeof import('@/api')>()
  const session = await import('@taiji/core/transport/api/domains/session')
  const model = await import('@taiji/core/transport/api/domains/model')
  return { ...actual, session, model }
})

import { useModel } from '@/composables/features/model/useModel'
import { useSessionStore } from '@/stores/session'
import type { SessionSummary } from '@taiji/shared'

const { setThinkingLevel: setThinkingLevelMock, switchModel: switchModelMock } = mocks

/** 播种一个 session 列表条目（applySnapshot 单字段形式要求目标已存在） */
function seedSession(id: string, overrides: Partial<SessionSummary> = {}): void {
  const sessionStore = useSessionStore()
  const base: SessionSummary = {
    id,
    label: id,
    cwd: '/tmp',
    status: 'idle',
    modelId: 'p/m',
    createdAt: Date.now(),
    lastActiveAt: Date.now(),
    tokenCount: 0,
    ...overrides,
  }
  sessionStore.applySnapshot({ groups: [{ id: 'g1', label: 'G1', sessions: [base] }] })
}

describe('useModel.setThinkingLevel 回执消费（U6 弃乐观写）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    setThinkingLevelMock.mockReset()
    switchModelMock.mockReset()
  })

  it('请求 max 被 pi 钳制为 high → sessionStore.thinkingLevel 写回执生效值 high（非请求值）', async () => {
    const sessionStore = useSessionStore()
    seedSession('s1')
    sessionStore.applySnapshot('s1', { modelId: 'p/mimo', thinkingLevel: 'medium' })
    setThinkingLevelMock.mockResolvedValue({ sessionId: 's1', level: 'high' })

    const { setThinkingLevel } = useModel()
    await setThinkingLevel('s1', 'max')

    expect(setThinkingLevelMock).toHaveBeenCalledWith('s1', 'max')
    // 核心断言：显示值 = 回执生效值（pi get_state 读回），不是乐观写的请求值 max
    expect(sessionStore.list.find((s) => s.id === 's1')?.thinkingLevel).toBe('high')
  })

  it('生效值与请求值一致 → 写请求值（回执与请求同值的常态路径）', async () => {
    const sessionStore = useSessionStore()
    seedSession('s1')
    sessionStore.applySnapshot('s1', { modelId: 'p/m', thinkingLevel: 'off' })
    setThinkingLevelMock.mockResolvedValue({ sessionId: 's1', level: 'high' })

    const { setThinkingLevel } = useModel()
    await setThinkingLevel('s1', 'high')

    expect(sessionStore.list.find((s) => s.id === 's1')?.thinkingLevel).toBe('high')
  })

  it('RPC 失败 → store 不写（显示保持旧真值，无乐观写路径）', async () => {
    const sessionStore = useSessionStore()
    seedSession('s1')
    sessionStore.applySnapshot('s1', { modelId: 'p/m', thinkingLevel: 'low' })
    setThinkingLevelMock.mockRejectedValue(new Error('rpc failed'))

    const { setThinkingLevel } = useModel()
    await expect(setThinkingLevel('s1', 'max')).rejects.toThrow('rpc failed')

    // 失败不落显示态：保持旧值 low，绝不出现请求值 max 的假显示
    expect(sessionStore.list.find((s) => s.id === 's1')?.thinkingLevel).toBe('low')
  })
})

describe('useModel.switchModel 回执消费（U6/C-pi-13 弃乐观写）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    setThinkingLevelMock.mockReset()
    switchModelMock.mockReset()
  })

  it('pi pattern 换模（reply 生效值 ≠ 请求值）→ modelId 写回执生效值，非请求值乐观写', async () => {
    const sessionStore = useSessionStore()
    seedSession('s1')
    sessionStore.applySnapshot('s1', { modelId: 'p/old' })
    // runtime set→get_state 读回：请求 glm-5.3，pi 实际切到同族 glm-5.3-air（事故 A 形态）
    switchModelMock.mockResolvedValue({ sessionId: 's1', provider: 'p', modelId: 'glm-5.3-air' })

    const { switchModel } = useModel()
    await switchModel('s1', 'p', 'glm-5.3')

    expect(switchModelMock).toHaveBeenCalledWith('s1', 'p', 'glm-5.3')
    // 核心断言：显示值 = 回执生效值（runtime get_state 读回），不是请求值 glm-5.3
    expect(sessionStore.list.find((s) => s.id === 's1')?.modelId).toBe('p/glm-5.3-air')
  })

  it('生效值与请求值一致 → 写请求复合串（常态路径）', async () => {
    const sessionStore = useSessionStore()
    seedSession('s1')
    sessionStore.applySnapshot('s1', { modelId: 'p/old' })
    switchModelMock.mockResolvedValue({ sessionId: 's1', provider: 'p', modelId: 'new' })

    const { switchModel } = useModel()
    await switchModel('s1', 'p', 'new')

    expect(sessionStore.list.find((s) => s.id === 's1')?.modelId).toBe('p/new')
  })

  it('RPC 失败 → store 不写（显示保持旧真值，无乐观写路径）', async () => {
    const sessionStore = useSessionStore()
    seedSession('s1')
    sessionStore.applySnapshot('s1', { modelId: 'p/old' })
    switchModelMock.mockRejectedValue(new Error('rpc failed'))

    const { switchModel } = useModel()
    await expect(switchModel('s1', 'p', 'new')).rejects.toThrow('rpc failed')

    expect(sessionStore.list.find((s) => s.id === 's1')?.modelId).toBe('p/old')
  })
})
