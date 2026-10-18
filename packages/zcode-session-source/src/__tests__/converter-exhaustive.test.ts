import { describe, expect, it, vi } from 'vitest'

import type { ZcodeMessageInput } from '../converter.ts'

// 防御 throw 分支（convertMessageByPolicy default）覆盖：该分支是「分类器返回契约外值
// 时 fail-fast」的穷尽性守卫——TS 类型系统拦截静态路径，唯一触发方式 = 分类器 mock
// 返回 PROJECTION_POLICIES ∪ 'unclassified' 闭集之外的值。契约：分类器词表扩员而分派
// 未同步时，转换必须显式炸出而非静默丢弃消息。
vi.mock('../projection.ts', () => ({
  classifyMessage: () => '__bogus_policy__',
}))

const { convertZcodeTranscript } = await import('../converter.ts')

const SESSION_INPUT = Object.freeze({
  id: 'sess_0198test-0000-0000-0000-00000000000a',
  title: 'T',
  timeCreated: Date.parse('2026-01-02T03:04:05.000Z'),
})

const MESSAGE: ZcodeMessageInput = {
  id: 'm-1',
  data: { role: 'user', time: { created: 1000 } },
  parts: [{ type: 'text', text: 'hello' }],
}

describe('convertMessageByPolicy 穷尽性守卫（分类器契约外返回值）', () => {
  it('分类器返回契约外策略时 fail-fast 抛出，不静默产出 entry', () => {
    expect(() => convertZcodeTranscript([MESSAGE], SESSION_INPUT)).toThrow(/未处理的派生视图策略/)
  })
})
