/**
 * folded-notice 纯函数测试：四个类型映射表全成员断言 + foldedStatusText 全分支。
 * 数据行形态锚定 core deriveFoldedNoticeRows（notify-summary.ts FoldedNoticeRow）。
 *
 * 运行：cd packages/ui && npx vitest run src/features/chat/__tests__/folded-notice.test.ts
 */
import { describe, it, expect } from 'vitest'
import type { Component } from 'vue'
import {
  FOLDED_TYPE_ICON,
  FOLDED_TYPE_LABEL_KEY,
  FOLDED_TYPE_WORD_KEY,
  FOLDED_TYPE_DESC_KEY,
  foldedStatusText,
} from '../folded-notice'
import type { FoldedNoticeRow, FoldedNoticeType } from '@taiji/core/domain/chat'

/** i18n stub：返回键名本身，断言「走了哪个键」不依赖真实词表 */
const t = (key: string, _named?: Record<string, unknown>): string => key

const TYPES: FoldedNoticeType[] = ['bash', 'subagent', 'workflow', 'managed']

/** 最小合法 FoldedNoticeRow：显式传 outcome / exitCode / endReason 的用例按参数覆盖 */
function row(overrides: Partial<FoldedNoticeRow> = {}): FoldedNoticeRow {
  return {
    type: 'bash',
    summary: '',
    fullText: '',
    outcome: 'neutral',
    id: 'id-1',
    ...overrides,
  }
}

// ── 四个映射表 · 键集合完备 + 逐成员值 ────────────────────────────────────────────

describe('FOLDED_TYPE_ICON', () => {
  it('四类型键集合完备且成员值正确', () => {
    expect(Object.keys(FOLDED_TYPE_ICON).sort()).toEqual([...TYPES].sort())
    const expected: Record<FoldedNoticeType, Component> = {
      bash: FOLDED_TYPE_ICON.bash,
      subagent: FOLDED_TYPE_ICON.subagent,
      workflow: FOLDED_TYPE_ICON.workflow,
      managed: FOLDED_TYPE_ICON.managed,
    }
    // 逐成员与源表同引用（表是唯一映射点，断言守住每个键不被误改/误删）
    expect(FOLDED_TYPE_ICON).toEqual(expected)
    // 图标组件四类型互不相同（bash 终端 / subagent 机器人 / workflow 流程 / managed 层叠）
    expect(new Set(Object.values(FOLDED_TYPE_ICON)).size).toBe(4)
  })
})

describe('FOLDED_TYPE_LABEL_KEY', () => {
  it('四类型键集合完备且成员值正确', () => {
    expect(Object.keys(FOLDED_TYPE_LABEL_KEY).sort()).toEqual([...TYPES].sort())
    expect(FOLDED_TYPE_LABEL_KEY.bash).toBe('panel.message.noticeFoldedBash')
    expect(FOLDED_TYPE_LABEL_KEY.subagent).toBe('panel.message.noticeFoldedSubagent')
    expect(FOLDED_TYPE_LABEL_KEY.workflow).toBe('panel.message.noticeFoldedWorkflow')
    expect(FOLDED_TYPE_LABEL_KEY.managed).toBe('panel.message.noticeFoldedManagedSession')
  })
})

describe('FOLDED_TYPE_WORD_KEY', () => {
  it('四类型键集合完备且成员值正确', () => {
    expect(Object.keys(FOLDED_TYPE_WORD_KEY).sort()).toEqual([...TYPES].sort())
    expect(FOLDED_TYPE_WORD_KEY.bash).toBe('panel.message.noticeTypeBash')
    expect(FOLDED_TYPE_WORD_KEY.subagent).toBe('panel.message.noticeTypeSubagent')
    expect(FOLDED_TYPE_WORD_KEY.workflow).toBe('panel.message.noticeTypeWorkflow')
    expect(FOLDED_TYPE_WORD_KEY.managed).toBe('panel.message.noticeTypeManagedSession')
  })
})

describe('FOLDED_TYPE_DESC_KEY', () => {
  it('四类型键集合完备且成员值正确', () => {
    expect(Object.keys(FOLDED_TYPE_DESC_KEY).sort()).toEqual([...TYPES].sort())
    expect(FOLDED_TYPE_DESC_KEY.bash).toBe('panel.message.noticeTypeDescBash')
    expect(FOLDED_TYPE_DESC_KEY.subagent).toBe('panel.message.noticeTypeDescSubagent')
    expect(FOLDED_TYPE_DESC_KEY.workflow).toBe('panel.message.noticeTypeDescWorkflow')
    expect(FOLDED_TYPE_DESC_KEY.managed).toBe('panel.message.noticeTypeDescManagedSession')
  })
})

// ── foldedStatusText · bash 分支（§3.4：显 exit N 字面量 / 超时词 / 中性不显）──────

describe('foldedStatusText · bash', () => {
  it('endReason=timeout → 超时词键（timeout 优先于 outcome 字面量）', () => {
    const text = foldedStatusText(
      row({ type: 'bash', endReason: 'timeout', outcome: 'neutral', exitCode: null }),
      t,
    )
    expect(text).toBe('panel.message.noticeStatusTimeout')
  })

  it('outcome=success → exit 0 字面量（不走 i18n）', () => {
    const text = foldedStatusText(row({ type: 'bash', outcome: 'success', exitCode: 0 }), t)
    expect(text).toBe('exit 0')
  })

  it('outcome=failed → exit <code> 字面量', () => {
    const text = foldedStatusText(row({ type: 'bash', outcome: 'failed', exitCode: 127 }), t)
    expect(text).toBe('exit 127')
  })

  it('中性（outcome=neutral 且 endReason 缺失）→ 空串，不冒充成败', () => {
    const text = foldedStatusText(row({ type: 'bash', outcome: 'neutral' }), t)
    expect(text).toBe('')
  })
})

// ── foldedStatusText · 非 bash 三类型 × 三态（全走 t() 键）────────────────────────

describe('foldedStatusText · subagent / workflow / managed', () => {
  const nonBashTypes: FoldedNoticeType[] = ['subagent', 'workflow', 'managed']

  it.each(nonBashTypes)('%s: outcome=success → noticeStatusSuccess 键', (type) => {
    const text = foldedStatusText(row({ type, outcome: 'success' }), t)
    expect(text).toBe('panel.message.noticeStatusSuccess')
  })

  it.each(nonBashTypes)('%s: outcome=failed → noticeStatusFailed 键', (type) => {
    const text = foldedStatusText(row({ type, outcome: 'failed' }), t)
    expect(text).toBe('panel.message.noticeStatusFailed')
  })

  it.each(nonBashTypes)('%s: outcome=neutral → noticeStatusNeutral 键', (type) => {
    const text = foldedStatusText(row({ type, outcome: 'neutral' }), t)
    expect(text).toBe('panel.message.noticeStatusNeutral')
  })
})
