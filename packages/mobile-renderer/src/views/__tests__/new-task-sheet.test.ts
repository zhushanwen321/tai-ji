// NewTaskSheet 创建流幂等键测试（remote-use U18：§2.3 A17 黏滞槽语义）。
//
// 验收条款 → 用例映射：
//   1. 单测：同意图重试复用同 uuid → A17 用例「提交失败后重试复用同一 clientUuid」
//   2. 单测：提交成功后重置        → A17 用例「提交成功后槽重置：未关窗口内再次提交携带新键」
//   3. 单测：关闭表单后重置        → A17 用例「关闭表单后槽重置：跨关闭不复用上一意图的键」
//
// mock 策略：仅 transport 出口（session.create / chat.submitDelivery / chat.streamSubscribe）
// 模块级 vi.mock 隔离 WS；NewTaskSheet → createMobileTask → createSessionFlow → useChat.send
// 全链真实——幂等键的观察边界 = session.create RPC 第 7 参（transport create 是 payload
// clientUuid 的唯一组装点），mock 组件层会把断言退化成「断言 mock 自身」
// （session-list.test.ts 同一立场）。
//
// 运行：cd packages/mobile-renderer && npx vitest run src/views/__tests__/new-task-sheet.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import type { VueWrapper } from '@vue/test-utils'
import type { SessionSummary } from '@taiji/shared'

const mocks = vi.hoisted(() => ({
  create: vi.fn<(...args: unknown[]) => Promise<SessionSummary>>(async () => ({}) as SessionSummary),
  submitDelivery: vi.fn<(...args: unknown[]) => Promise<undefined>>(async () => undefined),
  streamSubscribe: vi.fn<(sessionId: string, handler: unknown) => () => void>(() => vi.fn()),
}))

vi.mock('@taiji/core/transport/api/domains/session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@taiji/core/transport/api/domains/session')>()
  return { ...actual, create: mocks.create }
})
vi.mock('@taiji/core/transport/api/domains/chat', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@taiji/core/transport/api/domains/chat')>()
  return { ...actual, submitDelivery: mocks.submitDelivery, streamSubscribe: mocks.streamSubscribe }
})

import NewTaskSheet from '../NewTaskSheet.vue'
import { i18n } from '../../i18n'
import { sessionStore } from '../../shell/app-runtime'

/** RFC 4122 canonical 形态（randomUuid 两条实现路径——crypto.randomUUID 与 fallback 手拼——产出同形） */
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

function makeSummary(
  overrides: Partial<SessionSummary> & Pick<SessionSummary, 'id' | 'lastActiveAt'>,
): SessionSummary {
  return {
    label: `会话-${overrides.id}`,
    cwd: '/tmp/project',
    status: 'idle',
    modelId: 'test-model',
    tokenCount: 0,
    ...overrides,
  }
}

function mountSheet(): VueWrapper {
  return mount(NewTaskSheet, { props: { open: false }, global: { plugins: [i18n] } })
}

async function openSheet(wrapper: VueWrapper): Promise<void> {
  await wrapper.setProps({ open: true })
  await flushPromises()
}

async function fillAndSubmit(
  wrapper: VueWrapper,
  input = { cwd: '/tmp/project-a', message: 'first message' },
): Promise<void> {
  await wrapper.get('[data-testid="new-task-cwd"]').setValue(input.cwd)
  await wrapper.get('[data-testid="new-task-message"]').setValue(input.message)
  await wrapper.get('[data-testid="new-task-submit"]').trigger('click')
  await flushPromises()
}

/** 幂等键观察边界：session.create RPC 第 7 参（端口适配器逐参透传，位置恒定） */
function submittedClientUuids(): Array<string | undefined> {
  return mocks.create.mock.calls.map((call) => call[6] as string | undefined)
}

beforeEach(() => {
  i18n.global.locale.value = 'zh-CN'
  sessionStore.applySnapshot({ groups: [] })
  sessionStore.setActiveId(null)
  for (const fn of Object.values(mocks)) fn.mockClear()
})

describe('A17 创建流幂等键（per-open 黏滞槽）', () => {
  it('提交失败后重试复用同一 clientUuid（同意图重试不换键，禁 per-call 生成）', async () => {
    const wrapper = mountSheet()
    await openSheet(wrapper)

    mocks.create.mockRejectedValueOnce(new Error('RPC_TIMEOUT'))
    await fillAndSubmit(wrapper)
    expect(wrapper.get('[data-testid="new-task-error"]').text()).toContain('RPC_TIMEOUT')

    // 用户在失败后原样重试（弱网超时场景）：runtime 按 clientUuid 幂等返回已建 session，
    // 键更换即双建——重试路径不得重新生成
    await fillAndSubmit(wrapper)

    const uuids = submittedClientUuids()
    expect(uuids).toHaveLength(2)
    expect(uuids[0]).toMatch(UUID_SHAPE)
    expect(uuids[1]).toBe(uuids[0])
    wrapper.unmount()
  })

  it('提交成功后槽重置：表单未关窗口内的再次提交携带新键', async () => {
    const wrapper = mountSheet()
    await openSheet(wrapper)

    mocks.create.mockResolvedValueOnce(makeSummary({ id: 's-1', lastActiveAt: 1000 }))
    await fillAndSubmit(wrapper)
    expect(wrapper.emitted('created')).toHaveLength(1)

    // 父组件尚未响应 close 的窗口内再次提交 = 新意图，不得复用已消费的键
    mocks.create.mockResolvedValueOnce(makeSummary({ id: 's-2', lastActiveAt: 2000 }))
    await fillAndSubmit(wrapper)

    const uuids = submittedClientUuids()
    expect(uuids).toHaveLength(2)
    expect(uuids[0]).toMatch(UUID_SHAPE)
    expect(uuids[1]).toMatch(UUID_SHAPE)
    expect(uuids[1]).not.toBe(uuids[0])
    wrapper.unmount()
  })

  it('关闭表单后槽重置：跨关闭窗口的重试不复用上一意图的键', async () => {
    const wrapper = mountSheet()
    await openSheet(wrapper)

    mocks.create.mockRejectedValueOnce(new Error('RPC_TIMEOUT'))
    await fillAndSubmit(wrapper)
    const [failedUuid] = submittedClientUuids()
    expect(failedUuid).toMatch(UUID_SHAPE)

    // 关闭（放弃重试）→ 重新打开 = 新意图：失败意图保留的槽不得跨关闭存活
    await wrapper.setProps({ open: false })
    await flushPromises()
    await openSheet(wrapper)

    mocks.create.mockResolvedValueOnce(makeSummary({ id: 's-3', lastActiveAt: 3000 }))
    await fillAndSubmit(wrapper)

    const uuids = submittedClientUuids()
    expect(uuids).toHaveLength(2)
    expect(uuids[1]).toMatch(UUID_SHAPE)
    expect(uuids[1]).not.toBe(failedUuid)
    wrapper.unmount()
  })
})
