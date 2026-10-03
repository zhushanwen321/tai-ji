/**
 * resolveVirtualSessionId 单测 —— 虚拟 id → 底层真实 session id 解析（跨层 SSOT）。
 *
 * 背景：runtime file.search 等服务只登记真实 pi session，vid 直传必 session_not_found
 * （fileSearch vid 修复，方案 A）。本函数是「vid 只做前端路由 key」契约的解析收口，
 * 三族虚拟 id（subagent 三段式 / agentcall 两段式 / btw 两段式）规则见函数体注释。
 */
import { describe, it, expect } from 'vitest'
import {
  resolveVirtualSessionId,
  subagentVirtualId,
  btwVirtualId,
  agentCallVirtualId,
} from '../virtual-session-id'

describe('resolveVirtualSessionId — 真实 id 直通', () => {
  it('无冒号的真实 session id 原样返回（数据链对真实 id 零影响）', () => {
    expect(resolveVirtualSessionId('sess-abc-123')).toBe('sess-abc-123')
  })
})

describe('resolveVirtualSessionId — subagent 三段式（自带归属命名空间）', () => {
  it('提取中段 mainSid；ownerSessionId 传入也不消费（vid 内归属优先）', () => {
    const vid = subagentVirtualId('main-1', 'sub-1')
    expect(resolveVirtualSessionId(vid)).toBe('main-1')
    expect(resolveVirtualSessionId(vid, 'other-owner')).toBe('main-1')
  })

  it('非法两段形态（subagent:foo 残留）→ undefined（fail-safe，不外传残键）', () => {
    expect(resolveVirtualSessionId('subagent:foo')).toBeUndefined()
  })
})

describe('resolveVirtualSessionId — btw 两段式（映射即 extract）', () => {
  it('提取内嵌线 pi session id（线自身是真实 session，runtime hidden 注册）', () => {
    const vid = btwVirtualId('pi-line-9')
    expect(resolveVirtualSessionId(vid)).toBe('pi-line-9')
  })
})

describe('resolveVirtualSessionId — agentcall 两段式（无归属命名空间，依赖挂载链）', () => {
  it('有 ownerSessionId → 返回 owner（acsId 不在 runtime session 注册表，不可作解析结果）', () => {
    const vid = agentCallVirtualId('sa-5264')
    expect(resolveVirtualSessionId(vid, 'main-1')).toBe('main-1')
  })

  it('无 ownerSessionId → undefined（调用方跳过 RPC，白名单降级空集）', () => {
    expect(resolveVirtualSessionId(agentCallVirtualId('sa-5264'))).toBeUndefined()
  })

  it('ownerSessionId 空串 → undefined（不回落到空串真 id）', () => {
    expect(resolveVirtualSessionId(agentCallVirtualId('sa-5264'), '')).toBeUndefined()
  })
})

describe('resolveVirtualSessionId — 未知冒号形态', () => {
  it('未知前缀带冒号 → undefined（fail-safe：不把未知 vid 传给 runtime RPC）', () => {
    expect(resolveVirtualSessionId('weird:a:b')).toBeUndefined()
    expect(resolveVirtualSessionId(':')).toBeUndefined()
  })
})
