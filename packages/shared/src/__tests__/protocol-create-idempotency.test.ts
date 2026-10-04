/**
 * session.create clientUuid payload 契约测试（发现 B，create 幂等化）。
 *
 * 锁定共享类型 ClientMessageMap['session.create'] 的 clientUuid 可选幂等键（与调用方的
 * 接口约定字段名，勿改名）：同 uuid 的 create 重复到达（backstop 超时/WS 断连后网络重试）
 * → runtime 返回已建 session 不重复 spawn/建号；省略 = 旧行为（每次独立创建，向后兼容）。
 * 与 message.send 的 clientUuid（u-<uuid> 形态约定）是互不相干的幂等键空间。
 *
 * 运行：cd packages/shared && npx vitest run src/__tests__/protocol-create-idempotency.test.ts
 */
import { describe, it, expect } from 'vitest'
import type { ClientMessageMap } from '../protocol'
import type { ThinkingLevel } from '../pi-preset'

type SessionCreatePayload = ClientMessageMap['session.create']

describe('session.create clientUuid payload 契约（发现 B）', () => {
  it('TC1: clientUuid 可选——省略合法（向后兼容，缺省行为与旧版一致）', () => {
    const payload: SessionCreatePayload = { cwd: '/w', label: 'L' }
    expect(payload.clientUuid).toBeUndefined()
  })

  it('TC2: clientUuid:string 同型赋值合法 + 与既有字段共存（编译期锁定字段名/类型）', () => {
    const payload: SessionCreatePayload = { cwd: '/w', clientUuid: 'u-create-1' }
    expect(payload.clientUuid).toBe('u-create-1')

    const level: ThinkingLevel = 'high'
    const full: SessionCreatePayload = {
      cwd: '/w',
      label: 'L',
      hidden: false,
      presetId: 'preset-1',
      projectId: 'proj-1',
      modelOverride: 'prov/model',
      thinkingOverride: level,
      clientUuid: 'u-create-2',
    }
    expect(full.clientUuid).toBe('u-create-2')
  })
})
