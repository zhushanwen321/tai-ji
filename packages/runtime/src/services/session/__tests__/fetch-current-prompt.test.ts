/**
 * fetchCurrentSystemPrompt runtime 链路测试（session-trace design §3.1 失败路径 / D2）。
 *
 * 覆盖：
 * - 非活跃 session（无 pi 进程）→ throw code=session_not_active
 * - busy 预检（isGenerating/isCompacting）→ throw code=session_busy
 * - 成功路径：prompt 发 /__taiji_get_system_prompt__ → 轮询 get_entries(since=基线) 命中
 *   taiji:current-system-prompt custom entry → 返回 fullText/charCount/fetchedAt +
 *   traceLeafCache 基线滚动 + bus.publish session.traceEntryAppended（DATA 行留痕）
 * - 轮询超时（命令未产出 entry）→ throw code=fetch_current_prompt_timeout
 * - WS handler：reply session.currentSystemPrompt（含 sessionId，规则 7）/ 错误 sendError code
 *
 * SessionService 装配（makeSessionStore / makeSessionServiceEnv）收敛
 * __tests__/helpers/session-service-test-env.ts。
 *
 * 运行：cd packages/runtime && npx vitest run fetch-current-prompt
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { SessionMessageHandler } from '../../../transport/session-message-handler.js'
import type { ServerMessage } from '@taiji/shared'

import { makeSessionServiceEnv } from './helpers/session-service-test-env.js'

const SID = 'sid-fetch-prompt'

/** 轮询超时用例：get_entries 全量/增量恒空（命令未产出 entry）。 */
function mockGetEntriesAlwaysEmpty(client: ReturnType<typeof makeSessionServiceEnv>['client']): void {
  client.getEntries.mockImplementation(async (since?: string) =>
    since === undefined
      ? { data: { entries: [], leafId: 'leaf0' } }
      : { data: { entries: [], leafId: 'leaf0' } })
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('fetchCurrentSystemPrompt（常驻扩展现取通道）', () => {
  it('非活跃 session（无 pi 进程）→ throw code=session_not_active', async () => {
    const { svc } = makeSessionServiceEnv({ active: false, sid: SID })
    await expect(svc.fetchCurrentSystemPrompt(SID)).rejects.toMatchObject({ code: 'session_not_active' })
  })

  it('busy 预检：isGenerating → throw code=session_busy（命令会排队，预检拒绝更诚实）', async () => {
    const { svc, busyReady } = makeSessionServiceEnv({ busy: true, sid: SID })
    await busyReady
    await expect(svc.fetchCurrentSystemPrompt(SID)).rejects.toMatchObject({ code: 'session_busy' })
  })

  it('成功路径：发命令 → 轮询 since 命中 custom entry → 返回值 + 基线滚动 + 台账增量广播', async () => {
    const { svc, client, publishSpy, promptCalls, sinceBaselineRef } = makeSessionServiceEnv({ active: true, sid: SID })
    const result = await svc.fetchCurrentSystemPrompt(SID)
    // 命令发出（双下划线内部命令，不经 LLM）
    expect(promptCalls).toEqual(['/__taiji_get_system_prompt__'])
    // 增量轮询以全量建的基线为 since
    expect(sinceBaselineRef()).toBe('leaf0')
    // 返回值 = entry data 提取
    expect(result).toEqual({
      sessionId: SID,
      fullText: 'PROMPT-BODY',
      charCount: 11,
      fetchedAt: '2026-08-20T10:00:00.000Z',
    })
    // 台账增量：traceEntryAppended 广播（含 sessionId，规则 7）带现取 entry
    const push = publishSpy.mock.calls.find(([, m]) => (m as ServerMessage).type === 'session.traceEntryAppended')
    expect(push).toBeDefined()
    const payload = (push?.[1] as { payload: { sessionId: string; entries: unknown[]; leafId: string | null } }).payload
    expect(payload.sessionId).toBe(SID)
    expect(payload.leafId).toBe('leaf1')
    expect((payload.entries[0] as { customType?: string }).customType).toBe('taiji:current-system-prompt')
    // 基线滚动：后续 trace 增量从 leaf1 起（第二次 since）
    expect(client.getEntries).toHaveBeenCalledWith('leaf0')
  })

  it('轮询超时（命令未产出 entry）→ throw code=fetch_current_prompt_timeout', async () => {
    vi.useFakeTimers()
    const { svc, client } = makeSessionServiceEnv({ active: true, sid: SID })
    // 增量恒空（命令未产出）
    mockGetEntriesAlwaysEmpty(client)
    const pending = svc.fetchCurrentSystemPrompt(SID)
    // 先 attach rejection 断言再推进 timer（否则 rejection 发生时无 handler，报 unhandled）
    const expectation = expect(pending).rejects.toMatchObject({ code: 'fetch_current_prompt_timeout' })
    await vi.advanceTimersByTimeAsync(8500)
    await expectation
  })
})

describe('session.fetchCurrentSystemPrompt WS handler', () => {
  it('reply session.currentSystemPrompt（含 sessionId）；非活跃 → sendError code=session_not_active', async () => {
    const { svc } = makeSessionServiceEnv({ active: true, sid: SID })
    const replies: { type: string; payload: Record<string, unknown> }[] = []
    const errors: { code: string }[] = []
    const handler = new SessionMessageHandler({
      send: vi.fn(),
      reply: vi.fn((_ws: unknown, _id: string | undefined, type: string, payload: Record<string, unknown>) => {
        replies.push({ type, payload })
      }),
      sendError: vi.fn((_ws: unknown, code: string) => {
        errors.push({ code })
      }),
      sessionService: svc,
    } as unknown as ConstructorParameters<typeof SessionMessageHandler>[0])
    const WS = { readyState: 1, send: vi.fn() } as never

    await handler.handleSessionMessage({ type: 'session.fetchCurrentSystemPrompt', id: 'm1', payload: { sessionId: SID } } as never, WS)
    expect(replies[0]?.type).toBe('session.currentSystemPrompt')
    expect(replies[0]?.payload.sessionId).toBe(SID)
    expect(replies[0]?.payload.fullText).toBe('PROMPT-BODY')

    const { svc: deadSvc } = makeSessionServiceEnv({ active: false, sid: SID })
    const handler2 = new SessionMessageHandler({
      send: vi.fn(),
      reply: vi.fn(),
      sendError: vi.fn((_ws: unknown, code: string) => {
        errors.push({ code })
      }),
      sessionService: deadSvc,
    } as unknown as ConstructorParameters<typeof SessionMessageHandler>[0])
    await handler2.handleSessionMessage({ type: 'session.fetchCurrentSystemPrompt', id: 'm2', payload: { sessionId: SID } } as never, WS)
    expect(errors.map((e) => e.code)).toContain('session_not_active')
  })
})
