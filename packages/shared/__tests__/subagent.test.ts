import { describe, it, expect } from 'vitest'
import { deriveClosedDisplay } from '../src/subagent'

// normalizeSubagentStatus 的测试随函数下沉至 packages/runtime/test/subagent-status.test.ts；
// 本文件只测留在 shared 的展示派生（renderer BgNotifyCard / SubagentList 消费）。
describe('deriveClosedDisplay（closed 统一终态的展示派生，v4 B-1）', () => {
  it('closedReason=cancelled → cancelled', () => {
    expect(deriveClosedDisplay({ closedReason: 'cancelled' })).toBe('cancelled')
  })

  it('cancelled + error → cancelled（取消优先，error 不参与——对齐 TUI cancelled 分支先于 error 检查）', () => {
    expect(deriveClosedDisplay({ closedReason: 'cancelled', error: 'aborted' })).toBe('cancelled')
  })

  it('closedReason=gc + error → failed（gc 失败终态，真实失败）', () => {
    expect(deriveClosedDisplay({ closedReason: 'gc', error: 'Model timeout' })).toBe('failed')
  })

  it('closedReason 缺失 + error → failed（legacy 兜底 gc，对齐 extension 侧 closedReason ?? "gc"）', () => {
    expect(deriveClosedDisplay({ error: 'boom' })).toBe('failed')
  })

  it('分歧输入回归：parent-*/user-close 级联关闭 + 合成 error → done（非 failed）', () => {
    // disposeAllRecords 级联关闭合成 error: "closed due to parent-fork/parent-new" 等，
    // 是正常关闭语义而非 subagent 自身失败——与 extension TUI/LLM 文案一致判 finished。
    // 旧规则（error 有值即 failed）会把正常级联关闭显示为失败，此用例锁定不回退。
    expect(deriveClosedDisplay({ closedReason: 'parent-fork', error: 'closed due to parent-fork' })).toBe('done')
    expect(deriveClosedDisplay({ closedReason: 'parent-new', error: 'closed due to parent-new' })).toBe('done')
    expect(deriveClosedDisplay({ closedReason: 'parent-shutdown', error: 'closed due to parent-shutdown' })).toBe('done')
    expect(deriveClosedDisplay({ closedReason: 'user-close', error: 'closed due to user-close' })).toBe('done')
  })

  it('其余 closed → done（自然完成 / parent-* / user-close / gc 无 error / 无任何字段）', () => {
    expect(deriveClosedDisplay({ closedReason: 'gc' })).toBe('done')
    expect(deriveClosedDisplay({ closedReason: 'parent-fork' })).toBe('done')
    expect(deriveClosedDisplay({ closedReason: 'parent-new' })).toBe('done')
    expect(deriveClosedDisplay({ closedReason: 'user-close' })).toBe('done')
    expect(deriveClosedDisplay({ closedReason: 'parent-shutdown' })).toBe('done')
    expect(deriveClosedDisplay({})).toBe('done')
  })
})
