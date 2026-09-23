/**
 * TraceRowItem.suffix 输出锚定（round3 review S1 / mutation M3）。
 *
 * suffix computed 是 metrics 头号靶子（CRAP 63.6 / cognitive 22，全 PR 最高）：
 * trace-view + trace-i18n 34 例只覆盖了执行（95% 行覆盖），未锚定输出——
 * mutation M3 实证删掉 ASSISTANT `thinking×N/tool×N/text×N` 后仍全绿。
 * 本文件直接 mount TraceRowItem，对每个 kind 的 suffix 输出做参数化精确断言：
 * 突变删除任一 kind 的输出（或拼接符 / 条件）时对应断言必红。
 *
 * 现仅 `exit 1`、`ok` 两输出被既有测试锁（trace-view.test.ts），其余分支
 * （ASSISTANT 计数 / BASH cancelled·truncated·notInContextBash / TOOL error /
 * COMPACTED hook / 空输出不渲染 span）全部由本文件补齐。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/panel/session-trace/trace-row-item.test.ts
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import TraceRowItem from '@/components/panel/trace/TraceRowItem.vue'
import type { TraceRow, TraceRowMeta, TraceRowKind } from '@taiji/core/domain/session-trace'

/** 构造最小合法 TraceRow（suffix 只消费 kind + meta，其余字段给中性默认值）。 */
function makeRow(kind: TraceRowKind, meta: TraceRowMeta): TraceRow {
  return {
    key: `k-${kind}`,
    seq: 1,
    kind,
    inContext: true,
    shadowed: false,
    headline: 'demo headline',
    meta,
    source: 'jsonl',
  }
}

function mountRow(row: TraceRow) {
  return mount(TraceRowItem, { props: { row, selected: false } })
}

/** 取 suffix span 文本（空输出时 span 不渲染 → 返回 undefined）。
 *  testid 用 trace-suffix 前缀——避开 trace-view.test.ts findRows 的
 *  `[data-testid^="trace-row-"]` 行选择器（trace-row-* 是行 div 专属命名空间）。 */
function suffixOf(wrapper: ReturnType<typeof mountRow>): string | undefined {
  const span = wrapper.find('[data-testid="trace-suffix"]')
  return span.exists() ? span.text() : undefined
}

describe('TraceRowItem.suffix kind 特化输出锚定（round3 S1 / mutation M3）', () => {
  describe('ASSISTANT：block 计数（thinking×N tool×N text×N，空格拼接、真值才加）', () => {
    it('三计数齐备 → thinking×2 tool×1 text×3', () => {
      const w = mountRow(makeRow('ASSISTANT', { thinkingBlocks: 2, toolCalls: 1, textBlocks: 3 }))
      expect(suffixOf(w)).toBe('thinking×2 tool×1 text×3')
      w.unmount()
    })

    it('仅 toolCalls → tool×1（条件 push：零值/缺省计数不产段）', () => {
      const w = mountRow(makeRow('ASSISTANT', { thinkingBlocks: 0, toolCalls: 1 }))
      expect(suffixOf(w)).toBe('tool×1')
      w.unmount()
    })

    it('全零/空 meta → 无 suffix span（空输出不渲染）', () => {
      const w = mountRow(makeRow('ASSISTANT', { thinkingBlocks: 0, toolCalls: 0, textBlocks: 0 }))
      expect(suffixOf(w)).toBeUndefined()
      w.unmount()
    })
  })

  describe('BASH：exit code + 状态标记（" · " 拼接）', () => {
    it('exitCode + cancelled + truncated + excludeFromContext → 四段全序', () => {
      const w = mountRow(makeRow('BASH', { exitCode: 1, cancelled: true, truncated: true, excludeFromContext: true }))
      // notInContextBash 走 t()（zh-CN 全局 setup：'不进上下文'）
      expect(suffixOf(w)).toBe('exit 1 · cancelled · truncated · 不进上下文')
      w.unmount()
    })

    it('仅 exitCode=0 → exit 0（成功码也透出）', () => {
      const w = mountRow(makeRow('BASH', { exitCode: 0 }))
      expect(suffixOf(w)).toBe('exit 0')
      w.unmount()
    })

    it('无 exitCode 只有 cancelled → cancelled（exitCode undefined 不产段）', () => {
      const w = mountRow(makeRow('BASH', { cancelled: true }))
      expect(suffixOf(w)).toBe('cancelled')
      w.unmount()
    })

    it('空 meta → 无 suffix span', () => {
      const w = mountRow(makeRow('BASH', {}))
      expect(suffixOf(w)).toBeUndefined()
      w.unmount()
    })
  })

  describe('TOOL：三态结果标记', () => {
    it('isError:true → error', () => {
      const w = mountRow(makeRow('TOOL', { isError: true }))
      expect(suffixOf(w)).toBe('error')
      w.unmount()
    })

    it('isError:false → ok', () => {
      const w = mountRow(makeRow('TOOL', { isError: false }))
      expect(suffixOf(w)).toBe('ok')
      w.unmount()
    })

    it('isError 缺省 → 无 suffix span（未知态不猜测）', () => {
      const w = mountRow(makeRow('TOOL', {}))
      expect(suffixOf(w)).toBeUndefined()
      w.unmount()
    })
  })

  describe('COMPACTED：hook 来源标记', () => {
    it('fromHook:true → hook', () => {
      const w = mountRow(makeRow('COMPACTED', { fromHook: true }))
      expect(suffixOf(w)).toBe('hook')
      w.unmount()
    })

    it('fromHook 缺省 → 无 suffix span', () => {
      const w = mountRow(makeRow('COMPACTED', {}))
      expect(suffixOf(w)).toBeUndefined()
      w.unmount()
    })
  })

  it('其余 kind（USER/SESSION/SYSTEM/NOTICE/BRANCH/LIFECYCLE/DATA/BOUNDARY）→ 无 suffix span', () => {
    const kinds = ['USER', 'SESSION', 'SYSTEM', 'NOTICE', 'BRANCH', 'LIFECYCLE', 'DATA', 'BOUNDARY'] as const
    for (const kind of kinds) {
      const w = mountRow(makeRow(kind, { exitCode: 9, isError: true, fromHook: true }))
      expect(suffixOf(w), `kind ${kind} 不应有 suffix`).toBeUndefined()
      w.unmount()
    }
  })
})

describe('TraceRowItem MALFORMED 行号未知降级（RD-2#6：不伪装「第 0 行」）', () => {
  /** 行 div（模板前导注释使组件成 fragment 根，attributes 须落在行元素上取） */
  function rowElOf(w: ReturnType<typeof mountRow>) {
    return w.find('[data-testid^="trace-row-"]')
  }

  it('无 lineNumber（makeRow 本就缺省）→ 行文案「行号未知」，hover 提示不含「第 0 行」假行号', () => {
    const w = mountRow(makeRow('MALFORMED', {}))
    expect(w.text()).toContain('无法解析的 entry（行号未知）')
    expect(w.text()).not.toContain('第 0 行')
    const title = rowElOf(w).attributes('title')
    expect(title).toContain('行号未知')
    expect(title).not.toContain('第 0 行')
    w.unmount()
  })

  it('有 lineNumber（回归锚）→ 行文案与 hover 提示带真实行号', () => {
    const w = mountRow({ ...makeRow('MALFORMED', {}), lineNumber: 7 })
    expect(w.text()).toContain('第 7 行')
    expect(rowElOf(w).attributes('title')).toContain('第 7 行')
    w.unmount()
  })
})
