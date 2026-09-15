/**
 * subagent-frame.test.ts —— resolveSubagentParentSessionId 双形态解析锁定。
 *
 * 桥接背景（docs/design/timeout-streaming-ui-idle.md §5.1 D1）：subagent.stream_delta
 * 旁路帧的 payload.sessionId 有两形态（relay tee 通道 = 三段式虚拟分区 id；旧 widget
 * 通道 = 主 session id），idle timer 桥接需归一为父 session id。
 *
 * 覆盖：
 * - 虚拟 id 三段式 → 提取 mainSessionId（tee 通道形态）
 * - 主 sid 原样返回（旧 widget 通道形态）
 * - 非 subagent 虚拟形态不误判（agentcall: 前缀 / 旧两段式残留 / 空串）
 * - 纯函数零失败模式：任何字符串输入都有确定输出、不抛错
 */
import { describe, it, expect } from 'vitest'
import { resolveSubagentParentSessionId } from '../subagent-frame'
import { subagentVirtualId, agentCallVirtualId } from '../virtual-session-id'

describe('resolveSubagentParentSessionId — 虚拟 id 形态（relay tee 通道）', () => {
  it('三段式虚拟 id 提取第二段 mainSessionId', () => {
    expect(resolveSubagentParentSessionId(subagentVirtualId('main-1', 'bg-1'))).toBe('main-1')
  })

  it('mainSessionId 自身含冒号形态时按首个冒号切分（工厂契约：恰好 2 冒号 3 段）', () => {
    // subagentVirtualId 工厂不禁止 mainSid 含冒号；extractMainSessionId 以首个冒号为界，
    // 本用例锁定该切分语义（与 evictSessionWithVirtual 前缀清理同一函数）。
    expect(resolveSubagentParentSessionId('subagent:main:x:bg-1')).toBe('main')
  })
})

describe('resolveSubagentParentSessionId — 主 sid 形态（旧 widget 通道）', () => {
  it('主 session id 原样返回（不提取不包装）', () => {
    expect(resolveSubagentParentSessionId('main-raw-sid')).toBe('main-raw-sid')
  })

  it('pi uuid 形态主 sid 原样返回', () => {
    const sid = '0195c9d4-7f2a-7cc0-9a5e-3b8f1d2c4a6b'
    expect(resolveSubagentParentSessionId(sid)).toBe(sid)
  })
})

describe('resolveSubagentParentSessionId — 非 subagent 虚拟形态不误判', () => {
  it('agentcall: 前缀（两段式另一命名空间）原样返回', () => {
    const id = agentCallVirtualId('ac-session')
    expect(resolveSubagentParentSessionId(id)).toBe(id)
  })

  it('旧两段式残留（subagent:foo，缺第三段）原样返回——isSubagentVirtualId 三段结构校验排除', () => {
    expect(resolveSubagentParentSessionId('subagent:foo')).toBe('subagent:foo')
  })

  it('mainSessionId 段为空的畸形 id（subagent::bg）原样返回', () => {
    expect(resolveSubagentParentSessionId('subagent::bg')).toBe('subagent::bg')
  })

  it('subId 段为空的畸形 id（subagent:main:）原样返回', () => {
    expect(resolveSubagentParentSessionId('subagent:main:')).toBe('subagent:main:')
  })

  it('空串原样返回（零失败模式：无抛错无分支爆炸）', () => {
    expect(resolveSubagentParentSessionId('')).toBe('')
  })
})
