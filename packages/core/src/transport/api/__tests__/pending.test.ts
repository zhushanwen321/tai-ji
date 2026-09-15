/**
 * pending.resolveEnvelope —— 入站 pending 分流出口单测（R2/ES1）。
 *
 * 覆盖 error envelope 展开（message/code 默认值、details.detail string→cwd、
 * object→Object.assign）+ 普通 resolve + id 不存在 no-op。
 * 语义迁移自 core route-inbound 旧内联实现（route-inbound.test.ts ① 用例断言语义，
 * 委托化后细节断言落在本文件）。
 */
import { describe, it, expect } from 'vitest'
import { createCommandId, register, resolveEnvelope, RPC_BACKSTOP_TIMEOUT_MS } from '../pending'
import type { ServerMessage } from '@taiji/shared'

/** 构造 pending 分流入站消息（payload 用 as 断言对齐 ServerMessage 联合 payload） */
function envelopeMsg(type: string, id: string, payload: Record<string, unknown>): ServerMessage {
  return { type: type as ServerMessage['type'], id, payload } as ServerMessage
}

describe('pending.resolveEnvelope — error envelope 展开 + 普通 resolve（R2/ES1）', () => {
  it('非 error → resolve(id, payload)', async () => {
    const id = createCommandId()
    const p = register<{ sessionId: string; messages: unknown[] }>(id, RPC_BACKSTOP_TIMEOUT_MS)
    resolveEnvelope(envelopeMsg('session.getHistory', id, { sessionId: 's1', messages: [] }))
    await expect(p).resolves.toEqual({ sessionId: 's1', messages: [] })
  })

  it('error 空 payload → reject Error(message=request failed, code=unknown)', async () => {
    const id = createCommandId()
    const p = register(id, RPC_BACKSTOP_TIMEOUT_MS)
    resolveEnvelope(envelopeMsg('error', id, {}))
    await expect(p).rejects.toMatchObject({ message: 'request failed', code: 'unknown' })
  })

  it('error details.detail string → Error.cwd + code 透传（WORKTREE_EXISTS 场景）', async () => {
    const id = createCommandId()
    const p = register(id, RPC_BACKSTOP_TIMEOUT_MS)
    resolveEnvelope(
      envelopeMsg('error', id, { code: 'WORKTREE_EXISTS', message: 'exists', details: { detail: '/path/cwd' } }),
    )
    await expect(p).rejects.toMatchObject({ message: 'exists', code: 'WORKTREE_EXISTS', cwd: '/path/cwd' })
  })

  it('error details.detail object → Object.assign 展开 + code 透传（SETUP_FAILED 场景）', async () => {
    const id = createCommandId()
    const p = register(id, RPC_BACKSTOP_TIMEOUT_MS)
    resolveEnvelope(
      envelopeMsg('error', id, {
        code: 'SETUP_FAILED',
        message: 'setup',
        details: { detail: { exitCode: 1, stderr: 'boom' } },
      }),
    )
    await expect(p).rejects.toMatchObject({ code: 'SETUP_FAILED', exitCode: 1, stderr: 'boom' })
  })

  it('id 不存在 → no-op 不抛错（复用 resolve/reject 内部防御，调用方已 has() 判定）', async () => {
    expect(() => resolveEnvelope(envelopeMsg('error', 'ghost', {}))).not.toThrow()
    expect(() => resolveEnvelope(envelopeMsg('session.getHistory', 'ghost', {}))).not.toThrow()
  })
})
