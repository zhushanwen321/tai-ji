/**
 * vid RPC 门单测 —— gateVidRpcSessionId（RPC command 入口统一拦截虚拟会话 id）。
 *
 * 覆盖三类行为：真实 id 零干预直通、可解析查询类自动解析为归属真实会话、
 * 未登记方法 / 不可解析归属 fail-fast 拒绝（专用错误码 + 可操作消息）。
 * 契约 SSOT 见 ../vid-rpc-gate.ts 模块头；解析规则本体（resolveVirtualSessionId）
 * 另有 virtual-session-id.test.ts 覆盖。
 */
import { describe, it, expect, afterEach } from 'vitest'
import {
  gateVidRpcSessionId,
  registerVidOwnerResolver,
  VidRpcRejectedError,
  VID_RPC_REJECTED_CODE,
  __clearVidOwnerResolverForTest,
} from '../vid-rpc-gate'
import { subagentVirtualId, agentCallVirtualId } from '../virtual-session-id'

afterEach(() => {
  __clearVidOwnerResolverForTest()
})

describe('gateVidRpcSessionId — 非 vid 直通（门对正常路径零干预）', () => {
  it('真实 session id 原样返回（含已登记与未登记方法）', () => {
    expect(gateVidRpcSessionId('session.getCommands', 'sess-abc')).toBe('sess-abc')
    expect(gateVidRpcSessionId('session.switch', 'sess-abc')).toBe('sess-abc')
  })

  it('非 string（undefined / 对象）原样返回（无 sessionId 字段的 payload 不受门影响）', () => {
    expect(gateVidRpcSessionId('file.search.cwd', undefined)).toBeUndefined()
    expect(gateVidRpcSessionId('session.list', 42 as unknown)).toBe(42)
  })

  it('带冒号但非 vid 形态（如 terminal 实例 id / 旧两段残留）不拦——门只认合法 vid 结构', () => {
    expect(gateVidRpcSessionId('session.getCommands', 'term:sess-1:2')).toBe('term:sess-1:2')
    expect(gateVidRpcSessionId('session.getCommands', 'subagent:foo')).toBe('subagent:foo')
  })
})

describe('gateVidRpcSessionId — 可解析查询类（VID_RESOLVABLE_RPC）', () => {
  it('subagent 三段式 vid 解析为中段 mainSid（`#` 候选 / `/` 命令 / git / 文件树等场景）', () => {
    const vid = subagentVirtualId('main-1', 'sa-04bf')
    expect(gateVidRpcSessionId('file.search', vid)).toBe('main-1')
    expect(gateVidRpcSessionId('session.getCommands', vid)).toBe('main-1')
    expect(gateVidRpcSessionId('session.getSubagents', vid)).toBe('main-1')
    expect(gateVidRpcSessionId('git.status', vid)).toBe('main-1')
  })

  it('agentcall 两段式 vid：owner 反查命中 → owner', () => {
    registerVidOwnerResolver((v) => (v === agentCallVirtualId('acs-9') ? 'main-2' : undefined))
    expect(gateVidRpcSessionId('file.search', agentCallVirtualId('acs-9'))).toBe('main-2')
  })

  it('agentcall vid 无 owner 反查（未注册 / 未命中）→ unresolvable 拒绝', () => {
    const vid = agentCallVirtualId('acs-404')
    try {
      gateVidRpcSessionId('file.search', vid)
      expect.unreachable('agentcall 无归属必须拒绝')
    } catch (e) {
      expect(e).toBeInstanceOf(VidRpcRejectedError)
      expect((e as VidRpcRejectedError).message).toContain('registerVidOwnerResolver')
    }
  })
})

describe('gateVidRpcSessionId — 未登记方法 fail-fast 拒绝', () => {
  it('动作/历史/生命周期类收到 vid → 专用错误码 + 消息含方法名与恢复指引', () => {
    const vid = subagentVirtualId('main-1', 'sa-04bf')
    for (const method of ['session.revokeMessage', 'delivery.submit', 'session.history']) {
      try {
        gateVidRpcSessionId(method, vid)
        expect.unreachable(`${method} 收 vid 必须拒绝`)
      } catch (e) {
        expect(e).toBeInstanceOf(VidRpcRejectedError)
        const err = e as VidRpcRejectedError
        expect(err.code).toBe(VID_RPC_REJECTED_CODE)
        expect(err.message).toContain(method)
        expect(err.message).toContain(vid)
        expect(err.message).toContain('VID_RESOLVABLE_RPC')
      }
    }
  })
})
