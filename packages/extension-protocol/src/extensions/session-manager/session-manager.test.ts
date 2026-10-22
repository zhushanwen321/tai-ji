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
  SessionManagerDeleteParams,
  SessionManagerArchiveParams,
  SessionManagerWatchParams,
  SessionManagerCreateResult,
  SessionManagerSendResult,
  SessionManagerHistoryResult,
  SessionManagerStatusResult,
  SessionManagerListResult,
  SessionManagerSessionSummary,
  SessionManagerAbortResult,
  SessionManagerDeleteResult,
  SessionManagerArchiveResult,
  SessionManagerErrorResult,
} from './types'
import {
  isSessionManagerDeleteParams,
  isSessionManagerArchiveParams,
} from './types'

/**
 * U1-A2: marker 精确值 \x00TAIJI_SESSION_MANAGER + 嵌套请求契约（{action, params}）类型覆盖
 *
 * 形状是 SSOT 契约：extension 与 runtime 两侧都按此序列化/解析
 * （u9 曾发生扁平/嵌套契约漂移 Blocker——此层形状测试在漂移时早炸）。
 */
describe('U1-A2 marker 精确值 + 类型覆盖', () => {
  it('U1-A2 SESSION_MANAGER_MARKER 精确值为 \\x00TAIJI_SESSION_MANAGER', () => {
    expect(SESSION_MANAGER_MARKER).toBe('\x00TAIJI_SESSION_MANAGER')
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

  it('U1-A2 SessionManagerAction 包含全部 9 个 action（含 notify-once watch + delete/archive）', () => {
    const actions: SessionManagerAction[] = [
      'create',
      'send',
      'history',
      'status',
      'list',
      'abort',
      'delete',
      'archive',
      'watch',
    ]
    expect(actions).toHaveLength(9)
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
      { action: 'delete', params: { sessionId: 's' } },
      { action: 'archive', params: { sessionId: 's' } },
      { action: 'watch', params: { notifyId: 'sm-123e4567-e89b-12d3-a456-426614174000' } },
    ]
    expect(requests).toHaveLength(9)
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

  it('U1-A2 SessionManagerDeleteParams 必含 sessionId（与 abort 同形态）', () => {
    const req: SessionManagerDeleteParams = { sessionId: 'abc' }
    expect(req.sessionId).toBe('abc')
  })

  it('U1-A2 SessionManagerArchiveParams 必含 sessionId（与 abort 同形态）', () => {
    const req: SessionManagerArchiveParams = { sessionId: 'abc' }
    expect(req.sessionId).toBe('abc')
  })

  it('U1-A2 SessionManagerWatchParams：封闭单键 notifyId（parentSid 协议范围不定义）', () => {
    const req: SessionManagerWatchParams = { notifyId: 'sm-123e4567-e89b-12d3-a456-426614174000' }
    expect(req.notifyId).toContain('sm-')
    // 单键寻址：类型范围无任何第二字段可声明（parentSid 由 runtime 取连接身份）
    const keys = Object.keys(req)
    expect(keys).toEqual(['notifyId'])
  })
})

describe('U1-A2 各 action 结果类型结构', () => {
  it('U1-A2 SessionManagerCreateResult：sessionId/status + willNotify + lifetimeNotifyId', () => {
    // notify-once D6 注入后必红适配：willNotify/lifetimeNotifyId 为必填 additive 字段
    const res: SessionManagerCreateResult = {
      sessionId: 'abc',
      status: 'created',
      willNotify: true,
      lifetimeNotifyId: 'sm-123e4567-e89b-12d3-a456-426614174000',
    }
    const withModel: SessionManagerCreateResult = {
      sessionId: 'abc',
      status: 'created',
      modelId: 'p/m',
      // create 无 prompt → 完成通知不 arm，但 lifetime（死亡通知）键恒在——两键正交
      willNotify: false,
      lifetimeNotifyId: 'sm-123e4567-e89b-12d3-a456-426614174001',
    }
    expect(res.status).toBe('created')
    expect(withModel.modelId).toBe('p/m')
    expect(withModel.willNotify).toBe(false)
    expect(withModel.lifetimeNotifyId).toContain('sm-')
    // wire 往返（handler respond 经 select 通道）
    expect(JSON.parse(JSON.stringify(res))).toEqual(res)
  })

  it('U1-A2 SessionManagerSendResult 必含 queued: true + willNotify', () => {
    const res: SessionManagerSendResult = { queued: true, willNotify: true }
    expect(res.queued).toBe(true)
    expect(res.willNotify).toBe(true)
  })

  it('U1-A2 SessionManagerHistoryResult 必含 messages/truncated', () => {
    const res: SessionManagerHistoryResult = {
      messages: [{ role: 'user', content: 'hi' }],
      truncated: false,
    }
    expect(res.messages).toHaveLength(1)
  })

  it('U1-A2 SessionManagerStatusResult：status + modelId 可选 + undeliveredResults 事实计数', () => {
    const active: SessionManagerStatusResult = { status: 'active', modelId: 'p/m', undeliveredResults: 0 }
    const idle: SessionManagerStatusResult = { status: 'idle', undeliveredResults: 2 }
    expect(active.status).toBe('active')
    expect(idle.modelId).toBeUndefined()
    // 事实计数（非警示布尔）：可为 0，无清除语义
    expect(active.undeliveredResults).toBe(0)
    expect(idle.undeliveredResults).toBe(2)
  })

  it('U1-A2 SessionManagerListResult sessions 摘要 + undeliveredResults', () => {
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
      undeliveredResults: 1,
    }
    expect(res.sessions[0].spawnSource).toBe('agent')
    expect(res.undeliveredResults).toBe(1)
  })

  it('U1-A2 SessionManagerAbortResult 必含 success', () => {
    const res: SessionManagerAbortResult = { success: true }
    expect(res.success).toBe(true)
  })

  it('U1-A2 SessionManagerDeleteResult：{sessionId, deleted:true}（设计 §3.1 交互样例字段名）', () => {
    const res: SessionManagerDeleteResult = { deleted: true, sessionId: 'abc' }
    expect(res.deleted).toBe(true)
    expect(res.sessionId).toBe('abc')
    // wire 往返（handler respond 经 select 通道）
    expect(JSON.parse(JSON.stringify(res))).toEqual(res)
  })

  it('U1-A2 SessionManagerArchiveResult：{sessionId, archived:true}（设计 §3.1 交互样例字段名）', () => {
    const res: SessionManagerArchiveResult = { archived: true, sessionId: 'abc' }
    expect(res.archived).toBe(true)
    expect(res.sessionId).toBe('abc')
    // wire 往返（handler respond 经 select 通道）
    expect(JSON.parse(JSON.stringify(res))).toEqual(res)
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

/**
 * session-manager-archive-delete U2：delete/archive params 检查（同 abort 的
 * isSessionIdParams 形态——信任边界入站校验，非法 params 走 error envelope）。
 * 畸形矩阵与 abort 检查现状形态对齐：isRecord 只排数组、必填字段类型检查、
 * 多余字段放行（同 status/abort——仅 watch 是封闭单键）。
 */
describe('U2 delete/archive params 检查（isSessionIdParams 同形态）', () => {
  it('happy-path：{sessionId: string} 通过', () => {
    expect(isSessionManagerDeleteParams({ sessionId: 'child-1' })).toBe(true)
    expect(isSessionManagerArchiveParams({ sessionId: 'child-1' })).toBe(true)
  })

  it('boundary：非对象 / 数组 / null / undefined 拒绝', () => {
    expect(isSessionManagerDeleteParams(null)).toBe(false)
    expect(isSessionManagerDeleteParams(undefined)).toBe(false)
    expect(isSessionManagerDeleteParams('child-1')).toBe(false)
    expect(isSessionManagerDeleteParams(42)).toBe(false)
    expect(isSessionManagerDeleteParams([{ sessionId: 'child-1' }])).toBe(false)
    expect(isSessionManagerArchiveParams(null)).toBe(false)
    expect(isSessionManagerArchiveParams(undefined)).toBe(false)
    expect(isSessionManagerArchiveParams('child-1')).toBe(false)
    expect(isSessionManagerArchiveParams(42)).toBe(false)
    expect(isSessionManagerArchiveParams([{ sessionId: 'child-1' }])).toBe(false)
  })

  it('boundary：缺 sessionId / sessionId 非 string 拒绝', () => {
    expect(isSessionManagerDeleteParams({})).toBe(false)
    expect(isSessionManagerDeleteParams({ session_id: 'child-1' })).toBe(false)
    expect(isSessionManagerDeleteParams({ sessionId: 42 })).toBe(false)
    expect(isSessionManagerArchiveParams({})).toBe(false)
    expect(isSessionManagerArchiveParams({ session_id: 'child-1' })).toBe(false)
    expect(isSessionManagerArchiveParams({ sessionId: { id: 'x' } })).toBe(false)
  })

  it('多余字段放行（对齐 abort 检查现状形态：仅 watch 是封闭单键）', () => {
    expect(isSessionManagerDeleteParams({ sessionId: 'child-1', extra: 'x' })).toBe(true)
    expect(isSessionManagerArchiveParams({ sessionId: 'child-1', extra: 'x' })).toBe(true)
  })
})
