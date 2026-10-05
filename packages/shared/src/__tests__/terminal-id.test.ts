/**
 * 终端实例编号格式谓词单测（shared 单点 SSOT，terminal-multi-instance 设计 §0.5 P7）。
 *
 * 编号格式 `term:<sid>:<seq>` 的结构解析原三包各持一份（runtime terminal-service /
 * renderer terminal-instance-registry / core terminal-write-queue.removeSession），
 * 上移本单点后由编译期引用约束取代人肉对齐；本文件锁定谓词语义本身（含嵌套 sid 负例）。
 *
 * 运行：pnpm -C packages/shared test
 */
import { describe, it, expect } from 'vitest'
import {
  TERMINAL_ID_ROOT,
  terminalIdPrefixOf,
  isTerminalIdOfSession,
  sessionIdOfTerminalId,
  seqOfTerminalId,
} from '../terminal-id'

describe('terminalIdPrefixOf', () => {
  it('拼出 `term:<sid>:` 精确前缀（含尾冒号）', () => {
    expect(terminalIdPrefixOf('s1')).toBe('term:s1:')
    expect(TERMINAL_ID_ROOT).toBe('term:')
  })
})

describe('isTerminalIdOfSession（精确前缀口径）', () => {
  it('前缀命中 + 纯数字序号段 → true', () => {
    expect(isTerminalIdOfSession('term:s1:1', 's1')).toBe(true)
    expect(isTerminalIdOfSession('term:s1:42', 's1')).toBe(true)
  })

  it('负例：sid `a` 不误纳嵌套键 `term:a:1:1`（序号段 `1:1` 非纯数字，实属 sid `a:1`）', () => {
    expect(isTerminalIdOfSession('term:a:1:1', 'a')).toBe(false)
    // 嵌套键归属其真实会话
    expect(isTerminalIdOfSession('term:a:1:1', 'a:1')).toBe(true)
  })

  it('负例：他会话编号 / 非编号形态 / 空序号段', () => {
    expect(isTerminalIdOfSession('term:s2:1', 's1')).toBe(false)
    expect(isTerminalIdOfSession('term:s1:', 's1')).toBe(false)
    expect(isTerminalIdOfSession('term:s1:x', 's1')).toBe(false)
    expect(isTerminalIdOfSession('s1:1', 's1')).toBe(false)
  })
})

describe('sessionIdOfTerminalId / seqOfTerminalId', () => {
  it('合法编号解析出会话段与会话内序号', () => {
    expect(sessionIdOfTerminalId('term:s1:1')).toBe('s1')
    expect(seqOfTerminalId('term:s1:42')).toBe(42)
  })

  it('嵌套 sid 取最后一个冒号前余段（sid 域不含冒号，映射即 extract）', () => {
    expect(sessionIdOfTerminalId('term:a:1:1')).toBe('a:1')
    expect(seqOfTerminalId('term:a:1:1')).toBe(1)
  })

  it('非法编号返回 null / 0（显示名回退原始编号）', () => {
    expect(sessionIdOfTerminalId('s1:1')).toBeNull()
    expect(sessionIdOfTerminalId('term:')).toBeNull()
    expect(sessionIdOfTerminalId('term:s1:')).toBeNull()
    expect(sessionIdOfTerminalId('term:s1:x')).toBeNull()
    expect(seqOfTerminalId('s1:1')).toBe(0)
    expect(seqOfTerminalId('term:s1:x')).toBe(0)
  })
})
