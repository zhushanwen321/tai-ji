/**
 * terminal-instance-registry 参数顺序口径测试（跨包同名函数防错序）。
 *
 * 背景（D2 一致性审查第 2 轮）：renderer 侧 `isTerminalIdOfSession(terminalId, sessionId)`
 * 与 runtime 侧同名函数（terminal-service.ts）顺序一致，两包无编译期约束、两参数同为
 * string——传反不报错、静默恒 false（实例被误判为他会话/非成员）。本用例把顺序口径钉成
 * 可测断言：正序命中、反序必不命中；并复核精确前缀负例（sid 含冒号不误纳）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/terminal/terminal-instance-registry.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest'
import {
  activeTerminalIdOf,
  isTerminalIdOfSession,
  registerInstance,
  sessionIdOfTerminalId,
  unregisterInstance,
  __resetTerminalInstanceRegistryForTest,
} from '@/composables/features/terminal/terminal-instance-registry'

describe('isTerminalIdOfSession 参数顺序口径（terminalId 在前、sessionId 在后）', () => {
  it('REG-1: 正序 (terminalId, sessionId) 归属命中；反序必不命中（防跨包错序静默恒 false）', () => {
    const terminalId = 'term:session-a:2'
    const sessionId = 'session-a'
    expect(isTerminalIdOfSession(terminalId, sessionId)).toBe(true)
    // 反序：terminalId 当会话、sessionId 当编号 → 前缀不可能命中
    expect(isTerminalIdOfSession(sessionId, terminalId)).toBe(false)
    // 与编号解析器自洽：解析出的会话段正是归属会话
    expect(sessionIdOfTerminalId(terminalId)).toBe(sessionId)
  })

  it('REG-2: 精确前缀（序号段须纯数字）——sid 含冒号不误纳他人实例', () => {
    expect(isTerminalIdOfSession('term:a:1:1', 'a')).toBe(false)
    expect(isTerminalIdOfSession('term:a:1:1', 'a:1')).toBe(true)
  })
})

describe('registerInstance 的 active 落位语义（对账/恢复 vs 用户显式新建）', () => {
  beforeEach(() => {
    __resetTerminalInstanceRegistryForTest()
  })

  it('REG-3: 仅会话首个实例自动成 active；后续注册不抢 active（对账批量注册不跳到最后一条目）', () => {
    registerInstance('term:s:1', true)
    expect(activeTerminalIdOf('s')).toBe('term:s:1')

    registerInstance('term:s:2', true)
    registerInstance('term:s:3', true)
    // 对账路径（terminal.list 批量注册）不抢 active：用户已选中的 / 首个实例保持
    expect(activeTerminalIdOf('s')).toBe('term:s:1')
  })

  it('REG-4: 唯一 active 实例被回收后 active 回空；此后注册才重新落位（首个实例语义）', () => {
    registerInstance('term:s:1', true)
    unregisterInstance('term:s:1')
    expect(activeTerminalIdOf('s')).toBeNull()
    registerInstance('term:s:2', true)
    expect(activeTerminalIdOf('s')).toBe('term:s:2')
  })
})
