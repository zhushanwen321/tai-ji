/**
 * parentSession 溯源解析单测（design §3.4 SESSION 行 / §3.1 样例 5）。
 *
 * 两形态样本锚定 core fixture：
 *  - 文件路径形态：`/Users/dev/work/demo/older-session.jsonl`（trace-rows.test.ts real session）
 *  - sessionId fallback 形态：`s-fork-src`（trace-rows.test.ts real-fork-header）
 * 真实 pi 文件名 `<ISO>_<sessionId>.jsonl` 的 basename 提取兜底也在覆盖内。
 *
 * 运行：cd packages/core && npx vitest run src/domain/session-trace/__tests__/parent-session.test.ts
 */
import { describe, expect, it } from 'vitest'
import {
  extractSessionIdFromTraceFilePath,
  isTraceParentSessionPath,
  resolveTraceParentSession,
} from '../parent-session'
import type { TraceParentSessionCandidate } from '../parent-session'

/** sidebar 列表形态样本（id + sessionFile，sessionFile 可缺省）。 */
const SESSIONS: TraceParentSessionCandidate[] = [
  { id: '019977ab-1111-7000-8000-abc000000001', sessionFile: '/root/dirA/2026-08-20T09-41-02_019977ab-1111-7000-8000-abc000000001.jsonl' },
  { id: 's-fork-src', sessionFile: undefined },
  { id: 'older-session-id', sessionFile: '/Users/dev/work/demo/older-session.jsonl' },
]

describe('isTraceParentSessionPath', () => {
  it('文件路径形态（绝对/相对/反斜杠/.jsonl 后缀）判 true', () => {
    expect(isTraceParentSessionPath('/Users/dev/work/demo/older-session.jsonl')).toBe(true)
    expect(isTraceParentSessionPath('dir/sub/x.jsonl')).toBe(true)
    expect(isTraceParentSessionPath('C:\\Users\\dev\\x.jsonl')).toBe(true)
    expect(isTraceParentSessionPath('bare.jsonl')).toBe(true)
  })

  it('sessionId 形态判 false', () => {
    expect(isTraceParentSessionPath('s-fork-src')).toBe(false)
    expect(isTraceParentSessionPath('019977ab-1111-7000-8000-abc000000001')).toBe(false)
  })
})

describe('extractSessionIdFromTraceFilePath', () => {
  it('pi 标准文件名 <ISO>_<sessionId>.jsonl 提取 sessionId 尾段', () => {
    expect(
      extractSessionIdFromTraceFilePath('/root/dirA/2026-08-20T09-41-02_019977ab-1111-7000-8000-abc000000001.jsonl'),
    ).toBe('019977ab-1111-7000-8000-abc000000001')
  })

  it('无 <ts>_ 前缀的裸 <sessionId>.jsonl 整段即 id', () => {
    expect(extractSessionIdFromTraceFilePath('/Users/dev/work/demo/older-session.jsonl')).toBe('older-session')
  })

  it('空 basename / 仅 .jsonl 返回 null', () => {
    expect(extractSessionIdFromTraceFilePath('')).toBeNull()
    expect(extractSessionIdFromTraceFilePath('/.jsonl')).toBeNull()
  })
})

describe('resolveTraceParentSession', () => {
  it('路径形态：sessionFile 精确匹配命中（fixture real session 样本）', () => {
    const hit = resolveTraceParentSession('/Users/dev/work/demo/older-session.jsonl', SESSIONS)
    expect(hit?.id).toBe('older-session-id')
  })

  it('sessionId fallback 形态：id 精确匹配命中（fixture real-fork-header 样本）', () => {
    const hit = resolveTraceParentSession('s-fork-src', SESSIONS)
    expect(hit?.id).toBe('s-fork-src')
  })

  it('路径形态漂移（sessionFile 缺省/过期）时 basename 提取 sessionId 兜底命中', () => {
    // 列表里该 session 无 sessionFile（延迟写入窗口），路径形态 ref 走第 3 段提取兜底
    const drifted = resolveTraceParentSession(
      '/root/dirA/2026-08-20T09-41-02_019977ab-1111-7000-8000-abc000000001.jsonl',
      [{ id: '019977ab-1111-7000-8000-abc000000001' }],
    )
    expect(drifted?.id).toBe('019977ab-1111-7000-8000-abc000000001')
  })

  it('uuid ref 与 id 匹配（路径判定不误伤纯 uuid）', () => {
    const hit = resolveTraceParentSession('019977ab-1111-7000-8000-abc000000001', SESSIONS)
    expect(hit?.id).toBe('019977ab-1111-7000-8000-abc000000001')
  })

  it('全部未命中返回 null（目标 session 已删除）', () => {
    expect(resolveTraceParentSession('/gone/x.jsonl', SESSIONS)).toBeNull()
    expect(resolveTraceParentSession('no-such-id', SESSIONS)).toBeNull()
  })

  it('空列表返回 null', () => {
    expect(resolveTraceParentSession('s-fork-src', [])).toBeNull()
  })
})
