import type { Theme } from '@earendil-works/pi-coding-agent'
import { describe, expect, it } from 'vitest'

import type { SessionReadParams, ToolResult } from '../tool-handler.js'
import { buildSessionReadSummary, withResultSummary } from '../summary.js'
import { renderSessionReadResult } from '../tui/tool-render.js'

// ---- fixtures ----

function params(overrides: Partial<SessionReadParams> & { action: SessionReadParams['action'] }): SessionReadParams {
  return overrides as SessionReadParams
}

function toolResult(details: unknown, text = 'body text'): ToolResult {
  return { content: [{ type: 'text', text }], details }
}

// ---- buildSessionReadSummary ----

describe('buildSessionReadSummary', () => {
  it('find → Found N sessions matching "<query>"（截断带后缀）', () => {
    const r = toolResult({ matches: [{}, {}, {}], truncated: false })
    expect(buildSessionReadSummary(params({ action: 'find', query: 'login' }), r)).toBe(
      'Found 3 sessions matching "login"',
    )
    const truncated = toolResult({ matches: [{}], truncated: true })
    expect(buildSessionReadSummary(params({ action: 'find', query: 'login' }), truncated)).toBe(
      'Found 1 sessions matching "login" (truncated)',
    )
  })

  it('find 零匹配 → No sessions matching', () => {
    const r = toolResult({ matches: [], truncated: false })
    expect(buildSessionReadSummary(params({ action: 'find', query: 'gone' }), r)).toBe(
      'No sessions matching "gone"',
    )
  })

  it('ambiguous（任意 action 的多匹配消歧）→ N candidates', () => {
    const r = toolResult({ ambiguous: true, candidates: [{}, {}] })
    expect(buildSessionReadSummary(params({ action: 'outline', session: 'e6c9' }), r)).toBe(
      'Ambiguous session "e6c9": 2 candidates',
    )
  })

  it('family flat → N relations（parents/forks/subagents/workflows 合计）', () => {
    const family = {
      root: { sessionId: 's1' },
      parents: [{}],
      forks: [{}, {}],
      subagents: [{}],
      workflows: [],
    }
    const r = toolResult(family)
    expect(buildSessionReadSummary(params({ action: 'family', session: 's1' }), r)).toBe(
      'Family of session s1: 4 relations',
    )
  })

  it('family recursive（details.tree）→ Execution tree', () => {
    const r = toolResult({ tree: { root: {} } })
    expect(buildSessionReadSummary(params({ action: 'family', session: 's1', recursive: true }), r)).toBe(
      'Execution tree of session s1',
    )
  })

  it('outline → N turns（stats.totalTurns）', () => {
    const r = toolResult({ turns: [], lines: [], stats: { totalTurns: 32, totalEntries: 90, totalBytes: 1, parsedBytes: 1, skippedLines: 0 }, tokenEstimate: 1 })
    expect(buildSessionReadSummary(params({ action: 'outline', session: 's1' }), r)).toBe(
      'Outline of session s1 · 32 turns',
    )
  })

  it('expand → T 序号补零 + N entries', () => {
    const r = toolResult({ turn: { index: 13 }, entries: [{}, {}, {}, {}] })
    expect(buildSessionReadSummary(params({ action: 'expand', session: 's1', turn: 'T013' }), r)).toBe(
      'Expanded turn T013 · 4 entries',
    )
  })

  it('detail → turns 范围标签 + N entries', () => {
    const r = toolResult({ turns: 'T013-T015', entries: [{}, {}, {}] })
    expect(buildSessionReadSummary(params({ action: 'detail', session: 's1', turns: 'T013-T015' }), r)).toBe(
      'Read turns T013-T015 · 3 entries',
    )
  })

  it('search → Found N hits / No hits', () => {
    const r = toolResult({ hits: [{}, {}], truncated: false })
    expect(buildSessionReadSummary(params({ action: 'search', session: 's1', pattern: 'fix' }), r)).toBe(
      'Found 2 hits for "fix"',
    )
    const empty = toolResult({ hits: [], truncated: false })
    expect(buildSessionReadSummary(params({ action: 'search', session: 's1', pattern: 'fix' }), empty)).toBe(
      'No hits for "fix"',
    )
  })

  it('export → format + sizeBytes', () => {
    const r = toolResult({ path: '/tmp/x.md', sizeBytes: 2048 })
    expect(buildSessionReadSummary(params({ action: 'export', session: 's1' }), r)).toBe(
      'Exported outline view · 2048 bytes',
    )
    expect(buildSessionReadSummary(params({ action: 'export', session: 's1', format: 'full' }), r)).toBe(
      'Exported full view · 2048 bytes',
    )
  })

  it('extract → count / 零匹配 / 截断 showing', () => {
    const r = toolResult({ what: 'user-messages', count: 26, shown: 26, truncated: false, items: [] })
    expect(buildSessionReadSummary(params({ action: 'extract', session: 's1', what: 'user-messages' }), r)).toBe(
      'Extracted 26 user-messages',
    )
    const empty = toolResult({ what: 'commands', count: 0, shown: 0, truncated: false, items: [] })
    expect(buildSessionReadSummary(params({ action: 'extract', session: 's1', what: 'commands' }), empty)).toBe(
      'No commands found',
    )
    const clipped = toolResult({ what: 'files', count: 500, shown: 120, truncated: true, items: [] })
    expect(buildSessionReadSummary(params({ action: 'extract', session: 's1', what: 'files' }), clipped)).toBe(
      'Extracted 500 files (showing 120)',
    )
  })

  it('workflow → runs 计数 / 空 / skipped 后缀', () => {
    expect(buildSessionReadSummary(params({ action: 'workflow', session: 's1' }), toolResult({ runs: [{}, {}], runIds: ['a', 'b'] }))).toBe(
      'Found 2 workflow runs',
    )
    expect(buildSessionReadSummary(params({ action: 'workflow', session: 's1' }), toolResult({ runs: [], runIds: [] }))).toBe(
      'No workflow runs',
    )
    expect(
      buildSessionReadSummary(
        params({ action: 'workflow', session: 's1' }),
        toolResult({ runs: [{}], runIds: ['a'], skippedRuns: [{ runId: 'b', stateFile: 'x', reason: 'snapshot-unreadable' }] }),
      ),
    ).toBe('Found 1 workflow runs · 1 skipped')
  })

  it('result 单条 → session + totalChars（截断后缀）', () => {
    const r = toolResult({ session: 'sa-abc', sessionId: 'uuid', sessionFile: '/x', totalChars: 8000, truncated: true, text: '...' })
    expect(buildSessionReadSummary(params({ action: 'result', session: 'sa-abc' }), r)).toBe(
      'Read final result of sa-abc · 8000 chars (truncated)',
    )
  })

  it('result 批量 → count + items 形态识别', () => {
    const r = toolResult({ count: 3, items: [{}, {}, {}] })
    expect(buildSessionReadSummary(params({ action: 'result', session: 'a,b,c' }), r)).toBe(
      'Read 3 final results',
    )
  })

  it('doctor → roots 计数', () => {
    const r = toolResult({ environment: {}, roots: [{ kind: 'default' }, { kind: 'legacy' }] })
    expect(buildSessionReadSummary(params({ action: 'doctor' }), r)).toBe(
      'Doctor: 2 roots checked',
    )
  })

  it('details 形态漂移（空对象）→ 各 action 兜底不抛错', () => {
    const empty = toolResult({})
    expect(buildSessionReadSummary(params({ action: 'outline', session: 's1' }), empty)).toBe(
      'Outline of session s1',
    )
    expect(buildSessionReadSummary(params({ action: 'workflow', session: 's1' }), empty)).toBe(
      'No workflow runs',
    )
    expect(buildSessionReadSummary(params({ action: 'doctor' }), empty)).toBe('Doctor check completed')
    expect(buildSessionReadSummary(params({ action: 'extract', what: 'files' }), empty)).toBe('No files found')
  })
})

// ---- withResultSummary ----

describe('withResultSummary', () => {
  it('details 追加 summary，现有字段保留', () => {
    const r = toolResult({ hits: [{}], truncated: false })
    const out = withResultSummary(params({ action: 'search', pattern: 'fix' }), r)
    expect(out.details).toEqual({ hits: [{}], truncated: false, summary: 'Found 1 hits for "fix"' })
  })
})

// ---- renderSessionReadResult（TUI renderResult）----

const mockTheme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  italic: (text: string) => text,
  underline: (text: string) => text,
  inverse: (text: string) => text,
  strikethrough: (text: string) => text,
  getFgAnsi: (_color: string) => '',
  getBgAnsi: (_color: string) => '',
  getColorMode: () => 'truecolor' as const,
  getThinkingBorderColor: () => (text: string) => text,
  getBashModeBorderColor: () => (text: string) => text,
} as unknown as Theme

function renderedText(result: unknown, expanded: boolean): string {
  return renderSessionReadResult(result, { expanded }, mockTheme)
    .render(400)
    .map((line) => line.trimEnd())
    .join('\n')
}

describe('renderSessionReadResult', () => {
  it('折叠态 → details.summary 一行', () => {
    const r = toolResult({ matches: [], truncated: false }, 'multi\nline\nbody')
    const withSummary = withResultSummary(params({ action: 'find', query: 'login' }), r)
    expect(renderedText(withSummary, false)).toBe('No sessions matching "login"')
  })

  it('展开态 → content 纯文本（多行完整）', () => {
    const r = toolResult({ matches: [] }, 'line1\nline2')
    expect(renderedText(r, true)).toBe('line1\nline2')
  })

  it('无 summary（旧 entry）→ 折叠态回退 content 首行', () => {
    const r = toolResult({}, 'Header line\ndetail body')
    expect(renderedText(r, false)).toBe('Header line')
  })
})
