/**
 * pi-scheduler e2e 驱动器判定器纯函数族单测（scripts/lib/scheduler-e2e-judgers.cjs）。
 *
 * 判定器自错（协议形状判定漂移 / 分支回归）= e2e 假绿 / 假红不可辨，故对判定面
 * 直接锁定：ScheduleDraft 形状守卫（与 extension-protocol scheduler-create
 * helpers.ts 的 isScheduleDraft 同步契约）、请求帧提取、契约校验、JSONL 解析
 * 容错、entry 分布摘要。场景编排（runS*）与 pi 进程交互保持 e2e 实跑覆盖，
 * 不在本文件范围。
 */
import { describe, it, expect } from 'vitest'
import {
  checkScheduleFormDraftContract,
  describeEntryTypeCounts,
  getScheduleQuestionFromRequest,
  isScheduleDraftShape,
  parseJsonlEntries,
} from '../lib/scheduler-e2e-judgers.cjs'

/** 合法 ScheduleDraft 基形（once 全字段；各用例在此上变异）。 */
const VALID_DRAFT = Object.freeze({
  kind: 'once',
  schedule: 'in 1 hour',
  prompt: 'check the deploy',
  models: ['faux/faux-1'],
  name: 'my-task',
  expires: 'in 2 hours',
  currentModel: 'faux/faux-1',
})

/** 构造统一表单 schedule 请求帧（checkScheduleFormDraftContract 的输入形态）。 */
const formRequest = (initial, questionType = 'schedule') => [
  {
    id: 'req-1',
    options: [JSON.stringify({ formQuestions: [{ type: questionType, question: 'q', initial }], allowCancel: true })],
  },
]

// ---------- isScheduleDraftShape ----------

describe('isScheduleDraftShape 合法 draft', () => {
  it('once 全字段合法', () => {
    expect(isScheduleDraftShape({ ...VALID_DRAFT })).toBe(true)
  })

  it('recurring 最小集（可选字段缺席）合法', () => {
    expect(
      isScheduleDraftShape({ kind: 'recurring', schedule: '1h', prompt: 'p', models: [] }),
    ).toBe(true)
  })

  it('models 空数组合法（every 对空集恒真）', () => {
    expect(isScheduleDraftShape({ ...VALID_DRAFT, models: [] })).toBe(true)
  })
})

describe('isScheduleDraftShape 缺字段', () => {
  it.each([
    ['缺 kind', { schedule: 's', prompt: 'p', models: [] }],
    ['缺 schedule', { kind: 'once', prompt: 'p', models: [] }],
    ['缺 prompt', { kind: 'once', schedule: 's', models: [] }],
    ['缺 models', { kind: 'once', schedule: 's', prompt: 'p' }],
  ])('%s → false', (_name, draft) => {
    expect(isScheduleDraftShape(draft)).toBe(false)
  })
})

describe('isScheduleDraftShape 越界值', () => {
  it.each([
    ['kind 非法枚举', { ...VALID_DRAFT, kind: 'daily' }],
    ['kind null', { ...VALID_DRAFT, kind: null }],
    ['schedule 非字符串', { ...VALID_DRAFT, schedule: 60 }],
    ['prompt 非字符串', { ...VALID_DRAFT, prompt: { text: 'p' } }],
    ['models 非数组', { ...VALID_DRAFT, models: 'faux/faux-1' }],
    ['models 含非字符串项', { ...VALID_DRAFT, models: ['faux/faux-1', 42] }],
    ['可选字段 name 数字', { ...VALID_DRAFT, name: 123 }],
    ['可选字段 expires null（非 undefined 也非 string）', { ...VALID_DRAFT, expires: null }],
    ['可选字段 currentModel 布尔', { ...VALID_DRAFT, currentModel: true }],
  ])('%s → false', (_name, draft) => {
    expect(isScheduleDraftShape(draft)).toBe(false)
  })

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['字符串', 'draft'],
    ['数字', 42],
    ['数组（排除数组形态）', [VALID_DRAFT]],
  ])('非普通对象输入 %s → false', (_name, value) => {
    expect(isScheduleDraftShape(value)).toBe(false)
  })
})

// ---------- getScheduleQuestionFromRequest ----------

describe('getScheduleQuestionFromRequest', () => {
  const QUESTION = { type: 'schedule', question: 'Configure the schedule', initial: VALID_DRAFT }

  it('合法帧：options[0] payload 的 formQuestions[0] 为 schedule 问题 → 原样返回该问题', () => {
    const req = { options: [JSON.stringify({ formQuestions: [QUESTION], allowCancel: true })] }
    expect(getScheduleQuestionFromRequest(req)).toEqual(QUESTION)
  })

  it.each([
    ['formQuestions[0] 非 schedule 类型', { options: [JSON.stringify({ formQuestions: [{ type: 'input', question: 'q' }] })] }],
    ['payload 无 formQuestions', { options: [JSON.stringify({ allowCancel: true })] }],
    ['options[0] 非法 JSON', { options: ['{not-json'] }],
    ['options 空数组', { options: [] }],
    ['缺 options', {}],
    ['request 为 null', null],
  ])('%s → null（调用方挂起暴露协议故障）', (_name, req) => {
    expect(getScheduleQuestionFromRequest(req)).toBeNull()
  })
})

// ---------- checkScheduleFormDraftContract ----------

describe('checkScheduleFormDraftContract', () => {
  it('契约成立：initial 合法且匹配 expected 全字段 → ok + draft 回传 + desc 诊断', () => {
    const r = checkScheduleFormDraftContract(formRequest(VALID_DRAFT), {
      schedule: VALID_DRAFT.schedule,
      prompt: VALID_DRAFT.prompt,
      kind: 'once',
    })
    expect(r.ok).toBe(true)
    expect(r.draft).toEqual(VALID_DRAFT)
    expect(r.desc).toContain('kind=once')
    expect(r.desc).toContain(`schedule=${VALID_DRAFT.schedule}`)
  })

  it('不传 expected 时只校验形状', () => {
    expect(checkScheduleFormDraftContract(formRequest(VALID_DRAFT)).ok).toBe(true)
  })

  it('expected.schedule 不匹配 → false（预填值漂移判定）', () => {
    const r = checkScheduleFormDraftContract(formRequest(VALID_DRAFT), { schedule: 'in 2 hours' })
    expect(r.ok).toBe(false)
    expect(r.draft).toEqual(VALID_DRAFT)
  })

  it.each([
    ['空 reqs', [], '(none)'],
    ['options 空', [{ id: 'r', options: [] }], '(none)'],
  ])('%s → ok:false + desc (none) + draft null', (_name, reqs, desc) => {
    const r = checkScheduleFormDraftContract(reqs)
    expect(r).toEqual({ ok: false, desc, draft: null })
  })

  it('问题非 schedule 类型 → ok:false + desc (none)', () => {
    const r = checkScheduleFormDraftContract(formRequest(VALID_DRAFT, 'input'))
    expect(r.ok).toBe(false)
    expect(r.desc).toBe('(none)')
    expect(r.draft).toBeNull()
  })

  it('initial 非法形状：ok:false，desc 有诊断且 draft 原样回传（回传条件=普通对象，调用方以 ok 为准）', () => {
    const bad = { kind: 'daily', schedule: 's', prompt: 'p', models: [] }
    const r = checkScheduleFormDraftContract(formRequest(bad))
    expect(r.ok).toBe(false)
    expect(r.desc).toContain('kind=daily')
    expect(r.draft).toEqual(bad)
  })

  it('initial 非对象（缺 initial）→ desc (none) + draft null', () => {
    const req = [{ id: 'r', options: [JSON.stringify({ formQuestions: [{ type: 'schedule', question: 'q' }] })] }]
    const r = checkScheduleFormDraftContract(req)
    expect(r.ok).toBe(false)
    expect(r.desc).toBe('(none)')
    expect(r.draft).toBeNull()
  })
})

// ---------- parseJsonlEntries（readJsonlEntries 的判定核心） ----------

describe('parseJsonlEntries 畸形 JSONL 容错', () => {
  it('合法行保序解析', () => {
    const raw = [
      JSON.stringify({ type: 'message', i: 1 }),
      JSON.stringify({ type: 'custom', i: 2 }),
    ].join('\n')
    expect(parseJsonlEntries(raw)).toEqual([{ type: 'message', i: 1 }, { type: 'custom', i: 2 }])
  })

  it('畸形行（banner / 半行）跳过，合法行保留', () => {
    const raw = [
      '# pi session banner',
      JSON.stringify({ type: 'a' }),
      '{"type":"brok',
      JSON.stringify({ type: 'b' }),
    ].join('\n')
    expect(parseJsonlEntries(raw)).toEqual([{ type: 'a' }, { type: 'b' }])
  })

  it('空行与纯空白行跳过', () => {
    const raw = ['', JSON.stringify({ type: 'a' }), '   ', JSON.stringify({ type: 'b' }), ''].join('\n')
    expect(parseJsonlEntries(raw)).toEqual([{ type: 'a' }, { type: 'b' }])
  })

  it('全畸形输入 → 空数组（会话未落盘/纯 banner 形态）', () => {
    expect(parseJsonlEntries('garbage\n{bad\n')).toEqual([])
    expect(parseJsonlEntries('')).toEqual([])
  })
})

// ---------- describeEntryTypeCounts ----------

describe('describeEntryTypeCounts', () => {
  it('按类型计数并合并同类型', () => {
    const entries = [
      { type: 'message' },
      { type: 'custom' },
      { type: 'message' },
    ]
    expect(describeEntryTypeCounts(entries)).toBe('message:2,custom:1')
  })

  it.each([
    ['空数组', [], '(empty)'],
    ['undefined', undefined, '(empty)'],
  ])('%s → (empty)', (_name, entries, expected) => {
    expect(describeEntryTypeCounts(entries)).toBe(expected)
  })

  it('type 非字符串的 entry 归 ?（畸形行可辨）', () => {
    expect(describeEntryTypeCounts([{ type: 42 }, null, { type: 'x' }])).toBe('?:2,x:1')
  })
})
