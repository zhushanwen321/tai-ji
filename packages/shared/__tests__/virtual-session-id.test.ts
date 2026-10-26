/**
 * virtual-session-id.test.ts — 虚拟 session ID 工厂契约测试（btw-question M1-a）
 *
 * 覆盖验收条款：
 * - INVAR-1.1 强制化：isSubagentVirtualId 结构校验恰好 2 冒号 3 段非空；
 *   负例 `subagent:btw:<y>:<s>`（3 冒号 4 段）必拒（S-R4-2 生产方误接线形态）
 * - 生产方值域断言：subagentVirtualId 中段禁冒号 / 各段非空（fail-fast throw）
 * - agent call 两段式回归（既有消费契约不破坏）+ 两家族构造性互斥
 * - W4a：btw 两段式第三家族已退役（工厂删除，`btw:` 形态按未知冒号形态拒收）
 *
 * 运行：cd packages/shared && npx tsc --noEmit && npx vitest run
 */
import { describe, it, expect } from 'vitest'
import {
  SUBAGENT_PREFIX,
  subagentVirtualId,
  isSubagentVirtualId,
  extractSubagentId,
  extractMainSessionId,
  AGENTCALL_PREFIX,
  agentCallVirtualId,
  isAgentCallVirtualId,
  extractAgentCallSessionId,
} from '../src/virtual-session-id'

describe('subagent 三段式：工厂正向契约（INVAR-1.1 正面）', () => {
  it('前缀常量为 subagent:', () => {
    expect(SUBAGENT_PREFIX).toBe('subagent:')
  })

  it('工厂产出精确键形态 subagent:<mainSid>:<subId>', () => {
    expect(subagentVirtualId('sess-1', 'sub-a')).toBe('subagent:sess-1:sub-a')
  })

  it('工厂产物恒过结构校验（生产 ≡ 校验补全）', () => {
    for (const [main, sub] of [
      ['s0', 'sa1'],
      ['20260922120000_ab12', 'sa-uuid-v4'],
      ['a-b_c.8hex', 'x'],
    ] as const) {
      expect(isSubagentVirtualId(subagentVirtualId(main, sub))).toBe(true)
    }
  })

  it('extract 消费契约不变（DR9：extractSubagentId 第三段 / extractMainSessionId 第二段）', () => {
    const vid = subagentVirtualId('sess-1', 'sub-a')
    expect(extractSubagentId(vid)).toBe('sub-a')
    expect(extractMainSessionId(vid)).toBe('sess-1')
  })

  it('三段结构校验正例：合法键判 true', () => {
    expect(isSubagentVirtualId('subagent:sess-1:sub-a')).toBe(true)
    expect(isSubagentVirtualId('subagent:B:s1')).toBe(true)
  })
})

describe('subagent 三段式：结构校验强制化（恰好 2 冒号 3 段，负例必拒）', () => {
  it('S-R4-2 负例：subagent:btw:<y>:<s> 形态必拒（>2 冒号 / 4 段）', () => {
    // 生产方误接线：含冒号的字符串（旧 btw vid 形态 / 任意冒号键）被当 mainSessionId
    // 传入工厂时拼出的四段键。旧实现按首个冒号切分会通过并静默解析 mainSid="btw"。
    expect(isSubagentVirtualId('subagent:btw:20260922120000_ab12:sa-uuid')).toBe(false)
    expect(isSubagentVirtualId('subagent:btw:y:s')).toBe(false)
    // 泛化四段形态同拒
    expect(isSubagentVirtualId('subagent:a:b:c')).toBe(false)
  })

  it('旧两段式残留与残缺形态必拒', () => {
    expect(isSubagentVirtualId('subagent:foo')).toBe(false)
    expect(isSubagentVirtualId('subagent:')).toBe(false)
    expect(isSubagentVirtualId('subagent::b')).toBe(false) // 中段空
    expect(isSubagentVirtualId('subagent:a:')).toBe(false) // 第三段空
    expect(isSubagentVirtualId('subagent:a:b:')).toBe(false) // 尾段空
  })

  it('非 subagent 前缀字符串必拒', () => {
    expect(isSubagentVirtualId('')).toBe(false)
    expect(isSubagentVirtualId('sess-1')).toBe(false)
    expect(isSubagentVirtualId('subagent')).toBe(false) // 无冒号
    expect(isSubagentVirtualId('agentcall:x')).toBe(false)
    expect(isSubagentVirtualId('btw:line-1')).toBe(false)
  })
})

describe('subagent 三段式：生产方值域断言（fail-fast，S-R4-2 防误接线）', () => {
  it('中段传含冒号键（旧 btw vid 形态 / agentcall 键）必 throw（禁冒号）', () => {
    expect(() => subagentVirtualId('btw:20260922120000_ab12', 'sa-1')).toThrow(/禁冒号/)
    expect(() => subagentVirtualId('agentcall:acs-1', 'sa-1')).toThrow(/禁冒号/)
    // 结构性拦截兜底：即便有人绕过工厂手拼，键也必被结构校验拒收（双重防线）
    expect(isSubagentVirtualId('subagent:btw:20260922120000_ab12:sa-1')).toBe(false)
  })

  it('中段含冒号（其余误传形态）必 throw', () => {
    expect(() => subagentVirtualId('a:b', 's')).toThrow(/中段/)
    expect(() => subagentVirtualId('agentcall:acs-1', 's')).toThrow(/中段/)
  })

  it('中段为空必 throw', () => {
    expect(() => subagentVirtualId('', 's')).toThrow(/中段/)
  })

  it('第三段为空或含冒号必 throw', () => {
    expect(() => subagentVirtualId('main-1', '')).toThrow(/第三段/)
    expect(() => subagentVirtualId('main-1', 'a:b')).toThrow(/第三段/)
  })

  it('合法值域不 throw 且产物过结构校验', () => {
    expect(() => subagentVirtualId('main-1', 'rec-1')).not.toThrow()
    expect(isSubagentVirtualId(subagentVirtualId('main-1', 'rec-1'))).toBe(true)
  })
})

describe('W4a：btw 两段式第三家族退役（工厂删除，btw: 形态不再被解析）', () => {
  it('btw: 键不是合法 subagent/agentcall 虚拟键（按普通带冒号字符串拒收）', () => {
    expect(isSubagentVirtualId('btw:line-1')).toBe(false)
    expect(isAgentCallVirtualId('btw:line-1')).toBe(false)
    // 两家族构造性互斥（命名空间分离零冲突）
    const subVid = subagentVirtualId('s1', 'c1')
    const acVid = agentCallVirtualId('acs-1')
    expect(isAgentCallVirtualId(subVid)).toBe(false)
    expect(isSubagentVirtualId(acVid)).toBe(false)
  })
})

describe('agent call 两段式：回归（既有消费契约不变）', () => {
  it('前缀常量 / 工厂形态 / 结构判定 / 提取', () => {
    expect(AGENTCALL_PREFIX).toBe('agentcall:')
    expect(agentCallVirtualId('acs-1')).toBe('agentcall:acs-1')
    expect(isAgentCallVirtualId('agentcall:acs-1')).toBe(true)
    expect(extractAgentCallSessionId('agentcall:acs-1')).toBe('acs-1')
    expect(isAgentCallVirtualId('sess-1')).toBe(false)
  })
})
