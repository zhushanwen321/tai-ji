/**
 * sessionApi.create cwd 透传契约单测（#1，T1.1 配套 api 层片段）。
 *
 * 覆盖：
 * - create(cwd) → WS payload 含 cwd 字段（AC-1.1）
 * - create() 无参 → payload 不含 cwd 字段（runtime 回退 process.cwd()，AC-1.2 回归）
 * - create(cwd, label) → label 透传
 *
 * mock 策略：mock core ws-client（捕获 send payload）+ core pending 源文件相对路径
 * （返回可控 id/Promise），验证 session.create 消息 payload 形状。不 mock @/api
 * （直接测 domains/session 真实实现）。request 已下沉 core（tc u1），mock 目标须与
 * core 内相对 import 同一模块 ID 才能拦截。
 *
 * 运行：pnpm --filter @taiji/frontend run test -- src/__tests__/new-task/session-api.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { SessionSummary } from '@taiji/shared'

// 捕获 transport.send 收到的消息（含 payload 形状）
// （send 返回 true = 消息已送出，符合 transport.send 的 boolean 契约：
// request.command 对 send false 会走 fast-fail reject）
const transportMock = vi.hoisted(() => {
  const sent: Array<{ type: string; id: string; payload: Record<string, unknown> }> = []
  return {
    sent,
    send: vi.fn((msg: { type: string; id: string; payload: Record<string, unknown> }): boolean => {
      sent.push(msg)
      return true
    }),
  }
})

vi.mock('@taiji/core/transport/ws-client', () => ({ send: transportMock.send }))
vi.mock('../../../../core/src/transport/api/pending', () => ({
  RPC_BACKSTOP_TIMEOUT_MS: 65_000,
  createCommandId: vi.fn(() => 'pid-1'),
  register: vi.fn(() =>
    Promise.resolve({ session: { id: 's1', cwd: '/x', status: 'idle' } as SessionSummary }),
  ),
  reject: vi.fn(),
}))

import { create } from '@taiji/core/transport/api/domains/session'

beforeEach(() => {
  transportMock.sent.length = 0
  transportMock.send.mockClear()
})

describe('sessionApi.create cwd 透传', () => {
  it('create(cwd) → payload 含 cwd 字段（AC-1.1）', async () => {
    await create('/repo')
    expect(transportMock.send).toHaveBeenCalledTimes(1)
    const msg = transportMock.sent[0]
    expect(msg.type).toBe('session.create')
    expect(msg.payload).toHaveProperty('cwd', '/repo')
  })

  it('create() 无参 → payload 不含 cwd 字段（AC-1.2 回归，runtime 回退）', async () => {
    await create()
    const msg = transportMock.sent[0]
    expect(msg.payload).not.toHaveProperty('cwd')
  })

  it('create(cwd, label) → label 透传，cwd 透传', async () => {
    await create('/repo', 'my-label')
    const msg = transportMock.sent[0]
    expect(msg.payload).toHaveProperty('cwd', '/repo')
    expect(msg.payload).toHaveProperty('label', 'my-label')
  })

  it('create() 无参 → label 也不强制写入（undefined 不写入键）', async () => {
    await create()
    const msg = transportMock.sent[0]
    // label 为 undefined 时同样不写入 payload 键，保持 payload 干净
    expect(msg.payload).not.toHaveProperty('label')
  })

  it('解包 reply envelope .session 返回 SessionSummary', async () => {
    const result = await create('/repo')
    expect(result).toMatchObject({ id: 's1', cwd: '/x', status: 'idle' })
  })
})
