/**
 * formatShortSessionFile 纯函数单测。
 *
 * 测什么 bug：pi session 文件命名是 `<ISO_timestamp>_<uuidv7>.jsonl`，
 * 展示需取 uuidv7 前 8 位（对齐 coding-agent SDK 示例 slice(0,8)）。
 * 防的 bug：
 * - 正则解析失败时兜底（不能崩，不能返回空）
 * - 前 8 位 vs 后 8 位的混淆（uuidv7 前缀含时间戳，前 8 位才有语义）
 * - 无扩展名 / 路径含特殊字符等边界
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/panel/session-file-format.test.ts
 */
import { describe, it, expect } from 'vitest'
import { formatShortSessionFile } from '@/composables/logic/session-file-format'

describe('formatShortSessionFile', () => {
  it('U1: 标准格式取 uuidv7 前 8 位', () => {
    const path =
      '/Users/u/.taiji/agent/sessions/cwd-hash/2026-07-09T11-16-46-632Z_019f4698-2fa8-791c-858f-d02ba39d9676.jsonl'
    expect(formatShortSessionFile(path)).toBe('019f4698.jsonl')
  })

  it('U2: 仅文件名（无目录前缀）也能解析', () => {
    expect(formatShortSessionFile('2026-07-09T08-00-16-918Z_019f45e4-4a16-7584-aa4e-1a1e69383a47.jsonl')).toBe(
      '019f45e4.jsonl',
    )
  })

  it('U3: 空字符串兜底返回占位符', () => {
    expect(formatShortSessionFile('')).toBe('')
  })

  it('U4: 无下划线分隔的兜底——取 basename 去扩展名后前 8 位', () => {
    // 非 pi 标准命名（如用户自定义），退化为 basename 前 8 位
    expect(formatShortSessionFile('/some/path/abcdefgh1234.jsonl')).toBe('abcdefgh.jsonl')
  })

  it('U5: 路径含多个下划线只匹配最后一个 _xxx.jsonl', () => {
    // cwd hash 目录名含下划线，不能误匹配目录段
    const path =
      '/Users/u/.taiji/agent/sessions/--Users-u-Code-proj_workspace--/2026-07-09T11-16-46-632Z_019f4698-2fa8-791c.jsonl'
    expect(formatShortSessionFile(path)).toBe('019f4698.jsonl')
  })
})
