import { describe, it, expect } from 'vitest'
import { SESSION_MANAGER_MARKER } from './marker'
import { ASK_USER_MARKER } from '../ask-user/marker'
import { GUI_WIDGET_MARKER } from '../../core/markers'
import type {
  SessionManagerAction,
  SessionManagerParams,
  SessionManagerCreateParams,
  SessionManagerSendParams,
  SessionManagerHistoryParams,
  SessionManagerStatusParams,
  SessionManagerListParams,
  SessionManagerAbortParams,
  SessionManagerCreateResult,
  SessionManagerSendResult,
  SessionManagerHistoryResult,
  SessionManagerStatusResult,
  SessionManagerListResult,
  SessionManagerSessionSummary,
  SessionManagerAbortResult,
  SessionManagerErrorResult,
} from './types'

/**
 * U1-A2: marker 精确值 \x00XYZ_SESSION_MANAGER + 嵌套请求契约（{action, params}）类型覆盖
 *
 * 形状是 SSOT 契约：extension 与 runtime 两侧都按此序列化/解析
 * （u9 曾发生扁平/嵌套契约漂移 Blocker——此层形状测试在漂移时早炸）。
 */
describe('U1-A2 marker 精确值 + 类型覆盖', () => {
  it('U1-A2 SESSION_MANAGER_MARKER 精确值为 \\x00XYZ_SESSION_MANAGER', () => {
    expect(SESSION_MANAGER_MARKER).toBe('\x00XYZ_SESSION_MANAGER')
  })

  it('U1-A2 SESSION_MANAGER_MARKER 以 NUL 字符开头', () => {
    expect(SESSION_MANAGER_MARKER.charCodeAt(0)).toBe(0)
  })

  it('U1-A2 SESSION_MANAGER_MARKER 不等于 ASK_USER_MARKER', () => {
    expect(SESSION_MANAGER_MARKER).not.toBe(ASK_USER_MARKER)
  })

  it('U1-A2 SESSION_MANAGER_MARKER 不等于 GUI_WIDGET_MARKER', () => {
    expect(SESSION_MANAGER_MARKER).not.toBe(GUI_WIDGET_MARKER)
  })

  it('U1-A2 SessionManagerAction 包含全部 6 个 action', () => {
    const actions: SessionManagerAction[] = [
      'create',
      'send',
      'history',
      'status',
      'list',
      'abort',
    ]
    expect(actions).toHaveLength(6)
  })

  it('U1-A2 请求为嵌套形状：{action, params}（params 不携带 action 字段）', () => {
    // 内联形状（与 extension 手拼 JSON 同构）——纸面统一请求类型已删，契约由各 params 类型 + 此形状断言锁定
    const requests: { action: SessionManagerAction; params: SessionManagerParams[SessionManagerAction] }[] = [
      { action: 'create', params: { label: 'l', prompt: 'p' } },
      { action: 'send', params: { sessionId: 's', prompt: 'c' } },
      { action: 'history', params: { sessionId: 's' } },
      { action: 'status', params: { sessionId: 's' } },
      { action: 'list', params: {} },
      { action: 'abort', params: { sessionId: 's' } },
    ]
    expect(requests).toHaveLength(6)
    for (const req of requests) {
      expect(req.params).not.toHaveProperty('action')
    }
  })
})

describe('U1-A2 各 action 请求 params 类型结构（嵌套契约）', () => {
  it('U1-A2 SessionManagerCreateParams：cwd/label/prompt 全可选', () => {
    const req: SessionManagerCreateParams = {
      cwd: '/tmp/x',
      label: 'test',
      prompt: 'do something',
    }
    const empty: SessionManagerCreateParams = {}
    expect(req.prompt).toBe('do something')
    expect(empty.label).toBeUndefined()
  })

  it('U1-A2 SessionManagerSendParams 必含 sessionId/prompt', () => {
    const req: SessionManagerSendParams = {
      sessionId: 'abc',
      prompt: 'hello',
    }
    expect(req.sessionId).toBe('abc')
  })

  it('U1-A2 SessionManagerHistoryParams 必含 sessionId，tailTurns 可选', () => {
    const req: SessionManagerHistoryParams = {
      sessionId: 'abc',
    }
    expect(req.tailTurns).toBeUndefined()
  })

  it('U1-A2 SessionManagerStatusParams 必含 sessionId', () => {
    const req: SessionManagerStatusParams = { sessionId: 'abc' }
    expect(req.sessionId).toBe('abc')
  })

  it('U1-A2 SessionManagerListParams：空参数（过滤由 handler 固化）', () => {
    const empty: SessionManagerListParams = {}
    expect(empty).toEqual({})
  })

  it('U1-A2 SessionManagerAbortParams 必含 sessionId', () => {
    const req: SessionManagerAbortParams = { sessionId: 'abc' }
    expect(req.sessionId).toBe('abc')
  })
})

describe('U1-A2 各 action 结果类型结构', () => {
  it('U1-A2 SessionManagerCreateResult 必含 sessionId/status，modelId 可选', () => {
    const res: SessionManagerCreateResult = {
      sessionId: 'abc',
      status: 'created',
    }
    const withModel: SessionManagerCreateResult = {
      sessionId: 'abc',
      status: 'created',
      modelId: 'p/m',
    }
    expect(res.status).toBe('created')
    expect(withModel.modelId).toBe('p/m')
  })

  it('U1-A2 SessionManagerSendResult 必含 queued: true', () => {
    const res: SessionManagerSendResult = { queued: true }
    expect(res.queued).toBe(true)
  })

  it('U1-A2 SessionManagerHistoryResult 必含 messages/truncated', () => {
    const res: SessionManagerHistoryResult = {
      messages: [{ role: 'user', content: 'hi' }],
      truncated: false,
    }
    expect(res.messages).toHaveLength(1)
  })

  it('U1-A2 SessionManagerStatusResult：status 字符串 + modelId 可选', () => {
    const active: SessionManagerStatusResult = { status: 'active', modelId: 'p/m' }
    const idle: SessionManagerStatusResult = { status: 'idle' }
    expect(active.status).toBe('active')
    expect(idle.modelId).toBeUndefined()
  })

  it('U1-A2 SessionManagerListResult sessions 摘要含 spawnSource/parentAgentSessionId', () => {
    const res: SessionManagerListResult = {
      sessions: [
        {
          id: 'abc',
          label: 'l',
          cwd: '/tmp',
          status: 'idle',
          spawnSource: 'agent',
          parentAgentSessionId: 'parent',
        } satisfies SessionManagerSessionSummary,
      ],
    }
    expect(res.sessions[0].spawnSource).toBe('agent')
  })

  it('U1-A2 SessionManagerAbortResult 必含 success', () => {
    const res: SessionManagerAbortResult = { success: true }
    expect(res.success).toBe(true)
  })

  it('U1-A2 SessionManagerErrorResult 必含 error，sessionId 和 hint 可选', () => {
    const err: SessionManagerErrorResult = { error: 'failed' }
    expect(err.error).toBe('failed')
    expect(err.hint).toBeUndefined()
    expect(err.sessionId).toBeUndefined()

    const errWithHint: SessionManagerErrorResult = {
      error: 'prompt failed',
      hint: 'use send_to_session',
      sessionId: 'abc',
    }
    expect(errWithHint.hint).toBe('use send_to_session')
  })
})
