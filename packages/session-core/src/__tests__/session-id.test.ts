import { describe, expect, it } from 'vitest'

import { sessionIdFromFileName } from '../session-id.js'

describe('sessionIdFromFileName', () => {
  it('不变量：<timestamp>_<sessionId>.jsonl 取最后一个 _ 之后的尾段', () => {
    expect(sessionIdFromFileName('2026-09-20T12-00-00-000Z_abc12345-6789-4def.jsonl')).toBe('abc12345-6789-4def')
  })

  it('多个下划线时取最后一段（sessionId 含下划线的归一化前形态不误切）', () => {
    expect(sessionIdFromFileName('ts_a_b_c.jsonl')).toBe('c')
  })

  it('无下划线：返回剥后缀全串（uuid 直接作文件名的形态）', () => {
    expect(sessionIdFromFileName('abc12345-def6.jsonl')).toBe('abc12345-def6')
  })

  it('提取不出非空段返回 undefined（空文件名 / 仅后缀 / 尾段为空）', () => {
    expect(sessionIdFromFileName('')).toBeUndefined()
    expect(sessionIdFromFileName('.jsonl')).toBeUndefined()
    expect(sessionIdFromFileName('ts_.jsonl')).toBeUndefined()
  })

  it('剥 .jsonl 及其后任意内容（含 query 形态容错，对齐既有 extractSessionIdFromFilename 语义）', () => {
    expect(sessionIdFromFileName('ts_abc.jsonl.bak')).toBe('abc')
  })
})
