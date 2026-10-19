// @vitest-environment node

/**
 * 桌面壳 SessionApiPort 适配器透传单测（rest 传播形态守护）。
 *
 * 覆盖：
 * - create 7 参全透传：第 7 参 clientUuid（create 幂等键，core new-task-search/flow.ts 黏滞槽
 *   生成）原样到达 api 实现——守护的失败模式：适配器逐参罗列少列一参即被 TS 静默放行并吞掉，
 *   桌面新建任务超时重试失去幂等键、重复建 session
 * - create 缺省可选参（2 参调用）→ 不额外注入 undefined 占位，透传保持调用形态
 * - 同族代理方法（list/switchSession/rename/remove/removeByCwd/migrateImage）参数原样透传
 * - onConfigSessions 改编：handler 收 msg.payload.groups、订阅返回退订函数
 *
 * mock 策略：vi.mock('@/api') 只替换适配器实际消费的 session 门面（renderer 测试 env
 * 注入 VITE_MOCK=true，门面三元本就指向 core mock——直接换 spy 可捕获 create 调用，
 * 不依赖门面内部轨道选择）；events 桶同步替换，隔离 transport 链。
 *
 * 运行：pnpm -C packages/renderer run test -- src/__tests__/api/session-api-port.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('@/api', () => ({
  session: {
    list: vi.fn(),
    switchSession: vi.fn(),
    create: vi.fn(),
    rename: vi.fn(),
    remove: vi.fn(),
    removeByCwd: vi.fn(),
    migrateImage: vi.fn(),
  },
}))
vi.mock('@taiji/core/transport/api', () => ({
  onGlobalType: vi.fn(() => () => {}),
}))

import { session as sessionApi } from '@/api'
import * as events from '@taiji/core/transport/api'
import { buildSessionApiPort } from '@/api/session-api-port'
import type { SessionApiPort } from '@taiji/core'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('桌面壳 SessionApiPort 适配器透传（rest 传播形态）', () => {
  it('create 7 参全透传：第 7 参 clientUuid 原样到达 api 实现（幂等键通道）', async () => {
    const port: SessionApiPort = buildSessionApiPort()

    await port.create('/w', '任务', 'preset-1', 'proj-1', 'model-x', 'high', 'u-abc-123')

    expect(sessionApi.create).toHaveBeenCalledTimes(1)
    // toHaveBeenCalledWith 逐参比对：适配器若吞掉第 7 参（6 参旧形态），此处必红
    expect(sessionApi.create).toHaveBeenCalledWith(
      '/w', '任务', 'preset-1', 'proj-1', 'model-x', 'high', 'u-abc-123',
    )
  })

  it('create 缺省可选参（2 参调用）→ 调用形态原样透传，不注入 undefined 占位', async () => {
    const port: SessionApiPort = buildSessionApiPort()

    await port.create('/w', '任务')

    expect(sessionApi.create).toHaveBeenCalledTimes(1)
    expect(sessionApi.create).toHaveBeenCalledWith('/w', '任务')
  })

  it('同族代理方法参数原样透传（list/switchSession/rename/remove/removeByCwd/migrateImage）', async () => {
    const port: SessionApiPort = buildSessionApiPort()

    await port.list()
    await port.switchSession('s1')
    await port.rename('s1', '新名')
    await port.remove('s1')
    await port.removeByCwd('/w')
    await port.migrateImage({ fromPath: '/tmp/a.png', sessionId: 's1', fileName: 'a.png' })

    expect(sessionApi.list).toHaveBeenCalledTimes(1)
    expect(sessionApi.switchSession).toHaveBeenCalledWith('s1')
    expect(sessionApi.rename).toHaveBeenCalledWith('s1', '新名')
    expect(sessionApi.remove).toHaveBeenCalledWith('s1')
    expect(sessionApi.removeByCwd).toHaveBeenCalledWith('/w')
    expect(sessionApi.migrateImage).toHaveBeenCalledWith({
      fromPath: '/tmp/a.png', sessionId: 's1', fileName: 'a.png',
    })
  })

  it('onConfigSessions 改编：handler 收 msg.payload.groups，返回退订函数', () => {
    const port: SessionApiPort = buildSessionApiPort()
    const received: string[] = []

    const unsubscribe = port.onConfigSessions((groups) => {
      received.push(...groups.map((g) => g.cwd))
    })

    expect(events.onGlobalType).toHaveBeenCalledTimes(1)
    expect(events.onGlobalType).toHaveBeenCalledWith('config.sessions', expect.any(Function))
    const handler = vi.mocked(events.onGlobalType).mock.calls[0]![1]
    handler({ type: 'config.sessions', payload: { groups: [{ cwd: '/w', sessions: [] }] } })
    expect(received).toEqual(['/w'])
    expect(typeof unsubscribe).toBe('function')
  })
})
