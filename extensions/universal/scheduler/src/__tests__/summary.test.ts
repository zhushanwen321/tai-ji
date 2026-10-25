import type { Theme } from '@earendil-works/pi-coding-agent'
import { describe, expect, it } from 'vitest'

import {
  buildScheduleControlSummary,
  buildScheduleSummary,
  withScheduleSummary,
  type ScheduleControlParamsT,
  type ScheduleParamsT,
} from '../tool.js'
import { renderScheduleToolResult } from '../render-result.js'

function toolResult(details: unknown, text = 'body'): { content: { type: 'text'; text: string }[]; details: unknown } {
  return { content: [{ type: 'text', text }], details }
}

// ── buildScheduleSummary ─────────────────────────────

describe('buildScheduleSummary', () => {
  const createParams: ScheduleParamsT = { prompt: 'standup', schedule: '5m', name: 'Standup reminder' }

  it('创建成功 → Scheduled "<name>" · <schedule>（interval 规格化文案，en-US）', () => {
    const r = toolResult({
      task: { name: 'Standup reminder', kind: 'recurring', schedule: { mode: 'interval', intervalMs: 300000 } },
      nextRuns: [],
    })
    expect(buildScheduleSummary(createParams, r)).toBe('Scheduled "Standup reminder" · every 5m')
  })

  it('cron 规格 → 原样表达式', () => {
    const r = toolResult({
      task: { name: 'Nightly', kind: 'recurring', schedule: { mode: 'cron', cronExpression: '*/10 * * * *' } },
      nextRuns: [],
    })
    expect(buildScheduleSummary(createParams, r)).toBe('Scheduled "Nightly" · */10 * * * *')
  })

  it('取消态 → Cancelled', () => {
    expect(buildScheduleSummary(createParams, toolResult({ cancelled: true }))).toBe('Cancelled')
  })

  it('details 形态漂移（无 task）→ 降级 Scheduled 不抛错', () => {
    expect(buildScheduleSummary(createParams, toolResult({}))).toBe('Scheduled')
  })

  it('task.schedule 非法形态 → 回落 params.schedule 原文', () => {
    const r = toolResult({ task: { name: 'Odd', schedule: { mode: 'bogus' } } })
    expect(buildScheduleSummary(createParams, r)).toBe('Scheduled "Odd" · 5m')
  })

  it('name / schedule 含换行 → 摘要归一单行（S-1）', () => {
    const r = toolResult({ task: { name: 'Multi\nline', schedule: { mode: 'bogus' } } })
    expect(buildScheduleSummary({ ...createParams, schedule: '5m\nextra' }, r)).toBe(
      'Scheduled "Multi line" · 5m extra',
    )
  })
})

// ── buildScheduleControlSummary ──────────────────────

describe('buildScheduleControlSummary', () => {
  it('list → Listed N tasks', () => {
    const params: ScheduleControlParamsT = { action: 'list' }
    expect(buildScheduleControlSummary(params, toolResult({ tasks: [{}, {}] }))).toBe('Listed 2 tasks')
    expect(buildScheduleControlSummary(params, toolResult({ tasks: [] }))).toBe('Listed 0 tasks')
  })

  it('toggle enabled=false → Paused；enabled=true → Resumed', () => {
    expect(
      buildScheduleControlSummary({ action: 'toggle', id: 'ab12cd34', enabled: false }, toolResult({})),
    ).toBe('Paused task ab12cd34')
    expect(
      buildScheduleControlSummary({ action: 'toggle', id: 'ab12cd34', enabled: true }, toolResult({})),
    ).toBe('Resumed task ab12cd34')
  })

  it('delete / run → 动作 + id', () => {
    expect(buildScheduleControlSummary({ action: 'delete', id: 'ab12cd34' }, toolResult({}))).toBe(
      'Deleted task ab12cd34',
    )
    expect(buildScheduleControlSummary({ action: 'run', id: 'ab12cd34' }, toolResult({}))).toBe(
      'Ran task ab12cd34 now',
    )
  })
})

// ── withScheduleSummary ──────────────────────────────

describe('withScheduleSummary', () => {
  it('details 追加 summary，现有字段保留', () => {
    const r = toolResult({ tasks: [{}] })
    const out = withScheduleSummary(r, 'Listed 1 tasks')
    expect(out.details).toEqual({ tasks: [{}], summary: 'Listed 1 tasks' })
  })

  it('非对象 details → 防御替换为 { summary }', () => {
    const r = toolResult('legacy-string')
    const out = withScheduleSummary(r, 'Done')
    expect(out.details).toEqual({ summary: 'Done' })
  })
})

// ── renderScheduleToolResult（TUI renderResult）──────

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
  return renderScheduleToolResult(result, { expanded }, mockTheme)
    .render(400)
    .map((line) => line.trimEnd())
    .join('\n')
}

describe('renderScheduleToolResult', () => {
  it('折叠态 → details.summary 一行', () => {
    const r = withScheduleSummary(toolResult({ tasks: [{}] }, 'multi\nline'), 'Listed 1 tasks')
    expect(renderedText(r, false)).toBe('Listed 1 tasks')
  })

  it('展开态 → content 纯文本', () => {
    const r = toolResult({}, 'line1\nline2')
    expect(renderedText(r, true)).toBe('line1\nline2')
  })

  it('无 summary（旧 entry）→ 折叠态回退 content 首行', () => {
    const r = toolResult({}, 'Header\nbody')
    expect(renderedText(r, false)).toBe('Header')
  })
})
