/**
 * W9: stripSessionEndEntries 单测——剔除 JSONL 中的 session_end 行。
 *
 * 背景：B7 sidecar 方案下 runtime 不再往 JSONL 写 session_end，但历史 session（迁移前）
 * JSONL 仍可能含 `type:"session_end"` 行。[W1 语义变更：直附着正式文件] 现调用点 =
 * restoreSession F3 归一化（一次性原地 rename-over，见 containsSessionEndLine 判定）；
 * strip 动机（restore-fork-attach-fix §2.3 复核）= 防 pi _buildIndex 树索引污染
 * （legacy 行无 id → leafId=undefined → parentId 断链 → 历史不进 LLM 上下文），
 * 非防 pi 报错。
 *
 * 运行：cd packages/runtime && npx vitest run test/session-lifecycle-strip-session-end.test.ts
 */
import { describe, it, expect } from 'vitest'
// stripSessionEndEntries 自 session-lifecycle 迁出（max-lines 行数合规），权威源在 restore-seeding。
import { stripSessionEndEntries } from '../src/services/session/restore-seeding.js'

describe('W9: stripSessionEndEntries', () => {
  it('剔除含 "type":"session_end" 的行，保留其他行（双引号 JSON.stringify 格式）', () => {
    const input = [
      JSON.stringify({ type: 'session', id: 's1', cwd: '/x', timestamp: '2026-01-01T00:00:00.000Z' }),
      JSON.stringify({ type: 'message', id: 'm1', message: { role: 'user', content: 'hi' }, timestamp: '2026-01-01T00:00:01.000Z' }),
      JSON.stringify({ type: 'session_end', outcome: 'done', reason: 'end_turn', timestamp: '2026-01-01T00:00:02.000Z' }),
      JSON.stringify({ type: 'message', id: 'm2', message: { role: 'assistant', content: 'bye' }, timestamp: '2026-01-01T00:00:03.000Z' }),
    ].join('\n') + '\n'

    const result = stripSessionEndEntries(input)
    const lines = result.split('\n').filter((l) => l !== '')
    expect(lines).toHaveLength(3)
    // session_end 行被剔除
    expect(lines.find((l) => l.includes('session_end'))).toBeUndefined()
    // 其他行保留（含 type）
    expect(JSON.parse(lines[0]).type).toBe('session')
    expect(JSON.parse(lines[1]).type).toBe('message')
    expect(JSON.parse(lines[1]).id).toBe('m1')
    expect(JSON.parse(lines[2]).type).toBe('message')
    expect(JSON.parse(lines[2]).id).toBe('m2')
    // 末尾保留换行（pi _persist 期望每行 \n 结尾）
    expect(result.endsWith('\n')).toBe(true)
  })

  it('容忍 "type": "session_end" 带空格变体', () => {
    const input = [
      '{"type": "session", "id": "s1"}',
      '{"type": "session_end", "outcome": "stopped"}',
      '{"type": "message", "id": "m1"}',
    ].join('\n') + '\n'

    const result = stripSessionEndEntries(input)
    const lines = result.split('\n').filter((l) => l !== '')
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain('"session"')
    expect(lines[1]).toContain('"message"')
  })

  it('容忍单引号变体（手写或非 JSON.stringify 来源）', () => {
    const input = [
      "{'type':'session','id':'s1'}",
      "{'type':'session_end','outcome':'done'}",
      "{'type':'message','id':'m1'}",
    ].join('\n') + '\n'

    const result = stripSessionEndEntries(input)
    const lines = result.split('\n').filter((l) => l !== '')
    expect(lines).toHaveLength(2)
    expect(lines.find((l) => l.includes('session_end'))).toBeUndefined()
  })

  it('无 session_end 行时原样返回（含末尾换行）', () => {
    const input = [
      '{"type":"session","id":"s1"}',
      '{"type":"message","id":"m1"}',
    ].join('\n') + '\n'

    const result = stripSessionEndEntries(input)
    // 内容等价（剔除空串后再 join 等价于原行集 + 末尾 \n）
    expect(result.split('\n').filter((l) => l !== '')).toEqual([
      '{"type":"session","id":"s1"}',
      '{"type":"message","id":"m1"}',
    ])
    expect(result.endsWith('\n')).toBe(true)
  })

  it('多行 session_end 全部剔除（容错：异常多次写入场景）', () => {
    const input = [
      '{"type":"session","id":"s1"}',
      '{"type":"session_end","outcome":"done"}',
      '{"type":"session_end","outcome":"stopped"}',
      '{"type":"session_end","outcome":"error"}',
      '{"type":"message","id":"m1"}',
    ].join('\n') + '\n'

    const result = stripSessionEndEntries(input)
    const lines = result.split('\n').filter((l) => l !== '')
    expect(lines).toHaveLength(2)
    expect(lines.filter((l) => l.includes('session_end'))).toHaveLength(0)
  })

  it('只含 session_end 的文件 → 返回空串（不残留换行）', () => {
    const input = '{"type":"session_end","outcome":"done"}\n'
    const result = stripSessionEndEntries(input)
    expect(result).toBe('')
  })

  it('空串输入 → 返回空串', () => {
    expect(stripSessionEndEntries('')).toBe('')
  })

  it('不误剔除 type 含 session_end 子串但非完整 type 字段（如 "type":"message_session_end_xxx"）', () => {
    // 正则要求完整 "type":"session_end"，故 message_session_end_xxx 不应被剔除
    const input = [
      '{"type":"session","id":"s1"}',
      '{"type":"message_session_end_xxx","id":"weird"}',
    ].join('\n') + '\n'

    const result = stripSessionEndEntries(input)
    const lines = result.split('\n').filter((l) => l !== '')
    expect(lines).toHaveLength(2)
    expect(lines[1]).toContain('message_session_end_xxx')
  })

  it('保留 session_end 行内其他字段不会污染判断（outcome/reason 含 session_end 字样也按整行剔除）', () => {
    const input = [
      '{"type":"session","id":"s1"}',
      '{"type":"session_end","outcome":"done","reason":"contained session_end in reason"}',
    ].join('\n') + '\n'

    const result = stripSessionEndEntries(input)
    const lines = result.split('\n').filter((l) => l !== '')
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('"session"')
  })
})
