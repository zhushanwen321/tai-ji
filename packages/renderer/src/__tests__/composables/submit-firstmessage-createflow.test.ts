/**
 * TC-5：submitFirstMessage 改调 core createSessionFlow（C-W5-2 / FU-1）集成测试。
 *
 * 两分支断言：null→abort send / 非 null→create 快照化透传 + send(migratedSegments)。
 * （原第 3 用例「retry 分支」经审计为弱断言——仅复述用例 2 已建立的前置状态，retry
 * 路径本体未被驱动，已删；retry 语义由 flow-integration.test.ts「重试场景」用例承担。）
 *
 * U2b（D5 契约快照化）：thinkingLevel 经 create 入参 pendingThinkingLevel 一次到位，
 * 壳层 C-W4-3 setThinkingLevel 补 apply 已删（useModel().setThinkingLevel 恒不调）。
 * [U2d 后现状] 壳已注入 ports.launchConfig（preset store + settings 单例基座）——本
 * 测试 mock 面下 preset 列表空 + settings/KV 空，resolve 输入与空基座等价（model 终值
 * null、presetId null；thinking 落最高可用档 high），故终值断言不变。
 *
 * 另含（原独立文件 submit-firstmessage-pull.test.ts 并入，同 SUT 同 mock 骨架）：
 * wave:remove-bandaids 反转断言——submitFirstMessage 不再主动拉 subagent/workflow/
 * commands 列表（数据经 subscribe stateSnapshot / workflowUpdate 增量信号提供）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/composables/submit-firstmessage-createflow.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { textToSegments } from '@xyz-agent/shared'
import type { SessionSummary } from '@xyz-agent/shared'

// mock core.createSessionFlow（被测对象：壳改调此原语，断言调/不调 + 消费返回形状）
vi.mock('@xyz-agent/core', async (importActual) => {
  const actual = await importActual<typeof import('@xyz-agent/core')>()
  return {
    ...actual,
    createSessionFlow: vi.fn(),
  }
})

// session api 门面（createSessionFlow ctx.api 注入用，但壳内 buildSessionApiPort 代理这些）
vi.mock('@xyz-agent/core/transport/api/domains/session', () => ({
  create: vi.fn(),
  removeByCwd: vi.fn(),
  migrateImage: vi.fn(),
  writeSegments: vi.fn(),
  getCommands: vi.fn().mockResolvedValue({ commands: [] }),
  getSubagents: vi.fn().mockResolvedValue([]),
  getWorkflows: vi.fn().mockResolvedValue([]),
  getAgentCallHistory: vi.fn().mockResolvedValue([]),
}))
vi.mock('@/api', async (importActual) => {
  const actual = await importActual<typeof import('@/api')>()
  const session = await import('@xyz-agent/core/transport/api/domains/session')
  return { ...actual, session }
})
vi.mock('@xyz-agent/core/transport/api', () => ({
  on: vi.fn(() => () => {}),
  onGlobalType: vi.fn(() => () => {}),
  dispatchSession: vi.fn(),
}))
vi.mock('@xyz-agent/core/transport/api/domains/file', () => ({ tree: vi.fn().mockResolvedValue({}) }))
vi.mock('@xyz-agent/core/transport/api/domains/git', () => ({ status: vi.fn().mockResolvedValue({}) }))

// useChat：stub send/sendBash 为 spy，断言调/不调 + 参数
const sendMock = vi.fn().mockResolvedValue(undefined)
const sendBashMock = vi.fn().mockResolvedValue(undefined)
const setThinkingLevelMock = vi.fn().mockResolvedValue(undefined)
vi.mock('@/composables/features/chat/useChat', () => ({
  useChat: vi.fn(() => ({
    send: sendMock,
    sendBash: sendBashMock,
    disposeSession: vi.fn(),
    touchLru: vi.fn(),
    evictIfNeeded: vi.fn(),
  })),
  ensureStreamSubscription: vi.fn(),
}))
// useModel：setThinkingLevel spy（C-W4-3 留壳 apply）
vi.mock('@/composables/features/model/useModel', () => ({
  useModel: vi.fn(() => ({ switchModel: vi.fn().mockResolvedValue(undefined), setThinkingLevel: setThinkingLevelMock })),
}))
vi.mock('@/composables/features/file-tree/useFileTree', () => ({ useFileTree: vi.fn(() => ({ loadTree: vi.fn() })) }))

import { useNewTaskFlow, resetNewTaskFlow } from '@/composables/features/new-task/useNewTaskFlow'
import { createSessionFlow, transition, useNewTaskFlowController } from '@xyz-agent/core'
import { session as sessionApi } from '@/api'

function summary(over: Partial<SessionSummary> = {}): SessionSummary {
  return { id: 'ns', label: 'L', cwd: '/x', status: 'idle', lastActiveAt: 1, modelId: '', ...over }
}

beforeEach(() => {
  setActivePinia(createPinia())
  resetNewTaskFlow()
  vi.clearAllMocks()
})

describe('submitFirstMessage 改调 createSessionFlow（TC-5 / FU-1）', () => {
  it('null 分支（空 content guard）→ abort：不 create 不 send，直接 return', async () => {
    vi.mocked(createSessionFlow).mockResolvedValue(null)
    const flow = useNewTaskFlow()
    await flow.startFlow()
    // segments 非空但 createSessionFlow 返回 null（模拟 core guard 命中）
    await flow.submitFirstMessage(textToSegments('hi'))
    expect(createSessionFlow).toHaveBeenCalledTimes(1)
    expect(sendMock).not.toHaveBeenCalled()
    expect(setThinkingLevelMock).not.toHaveBeenCalled()
  })

  it('非 null 分支→ create 快照化透传 resolve 终值 + send(migratedSegments)', async () => {
    const migrated = [{ type: 'text' as const, text: 'hi' }]
    vi.mocked(createSessionFlow).mockResolvedValue({
      session: summary({ id: 'ns' }),
      migratedSegments: migrated,
    })
    const flow = useNewTaskFlow()
    await flow.startFlow()
    await flow.submitFirstMessage(textToSegments('hi'), 'high')
    expect(createSessionFlow).toHaveBeenCalledTimes(1)
    // [D5] thinkingLevel 经 create 入参一次到位（explicit authored 'high' → resolve 终值 'high'）；
    // U2d 已接 ports.launchConfig，本测试 mock 面下基座数据全空（preset 列表空 + settings
    // 空）→ model 全链空 null、presetId null。
    // mock 的是 core createSessionFlow(ctx, input) 原函数——终值断言定位第二参 input
    expect(createSessionFlow).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ pendingThinkingLevel: 'high', pendingModel: null, presetId: null }),
    )
    // [D5] C-W4-3 已删：post-create setThinkingLevel 补 apply 恒不调
    expect(setThinkingLevelMock).not.toHaveBeenCalled()
    // send 用 result.migratedSegments（createSessionFlow 返回的迁移后段）
    expect(sendMock).toHaveBeenCalledTimes(1)
    expect(sendMock).toHaveBeenCalledWith('ns', migrated)
  })

  it('retry 分支（currentSession 已绑定 + state 回 landing）→ 不调 createSessionFlow，直接 send', async () => {
    // 首次提交绑定 session（createSessionFlow 返回非 null）
    vi.mocked(createSessionFlow).mockResolvedValue({
      session: summary({ id: 'ns' }),
      migratedSegments: textToSegments('hi'),
    })
    const flow = useNewTaskFlow()
    await flow.startFlow()
    await flow.submitFirstMessage(textToSegments('hi')) // 首次→create+send
    expect(createSessionFlow).toHaveBeenCalledTimes(1)
    sendMock.mockClear()

    // 模拟 retry：send 失败后 state 回 landing（editAndResend 流程；completed 是终态无出口，
    // 测试内经 resetNewTaskFlow 回 idle 后重新 transition，等价于应用层重新 startFlow 的重建路径），
    // currentSession 仍绑定 → 再提交走 !currentSession 守卫的 else 分支（不 create 直接 send）。
    resetNewTaskFlow()
    const controller = useNewTaskFlowController()
    controller.bindCurrentSession(summary({ id: 'ns' }))
    transition('landing')
    await flow.submitFirstMessage(textToSegments('again'))
    expect(createSessionFlow).toHaveBeenCalledTimes(1)
    expect(sendMock).toHaveBeenCalledTimes(1)
    expect(sendMock).toHaveBeenCalledWith('ns', textToSegments('again'))
  })
})

describe('wave:remove-bandaids: submitFirstMessage 不再主动拉 subagent/workflow/commands（原 submit-firstmessage-pull.test.ts 并入）', () => {
  /** 预设 NewTaskFlow 到 landing 态并绑定 fake session（跳过 create 路径） */
  function setupLandingWithSession(): SessionSummary {
    const controller = useNewTaskFlowController()
    const fakeSession: SessionSummary = {
      id: 'sess-new-001',
      label: 'test',
      cwd: '/tmp',
      createdAt: '2026-07-15T10:00:00Z',
      lastActivity: '2026-07-15T10:00:00Z',
      piSessionFile: '',
    }
    transition('landing')
    controller.bindCurrentSession(fakeSession)
    return fakeSession
  }

  it('submitFirstMessage 不调 getSubagents（subagents 经 subscribe stateSnapshot 提供）', async () => {
    setupLandingWithSession()
    const flow = useNewTaskFlow()

    await flow.submitFirstMessage(textToSegments('hello'))

    expect(sessionApi.getSubagents).not.toHaveBeenCalled()
  })

  it('submitFirstMessage 不调 getWorkflows（workflows 经 streamRing workflowUpdate 增量信号→RPC 闭环）', async () => {
    setupLandingWithSession()
    const flow = useNewTaskFlow()

    await flow.submitFirstMessage(textToSegments('hello'))

    expect(sessionApi.getWorkflows).not.toHaveBeenCalled()
  })

  it('submitFirstMessage 不调 getCommands（commands 经 subscribe stateSnapshot 提供）', async () => {
    setupLandingWithSession()
    const flow = useNewTaskFlow()

    await flow.submitFirstMessage(textToSegments('hello'))

    expect(sessionApi.getCommands).not.toHaveBeenCalled()
  })
})
