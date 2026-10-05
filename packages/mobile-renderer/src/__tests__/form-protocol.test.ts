// form-protocol 纯逻辑契约测试（shell/form-protocol.ts）。
//
// 锁定对象 = ui-form 线协议的移动侧编码契约（桌面 FormOverlay.onSubmit 是同契约的既有实现，
// 双端一致性由本文件 + 桌面 form 测试族双锁定；单源化路径登记见 form-protocol.ts 文件头）：
// - 问题 key fallback（header ?? question）、Other 占位符过滤、多选 JSON 序列化、
//   `${key}__other` 键位规则（text 题不写主 key）
// - Submit 门判定（choice / Other 需文本 / text / schedule 委托）
// - schedule 草稿回显 = 桌面 ScheduleForm 打开即确认路径的字节等价物
//     （once 折叠往返 / recurring 原文 + expires 缺省 / model 预选 / prompt 必填门）
// - C4 富交互帧判定与问题集 / 草稿收窄守卫
import { describe, expect, it } from 'vitest'
import type { ExtensionUIRequest } from '@taiji/core/transport/api/domains/extension'
import {
  OTHER_VALUE,
  draftToScheduleFormResult,
  encodeFormAnswers,
  formQuestionsOf,
  initialQuestionState,
  isPlanReviewFrame,
  isQuestionAnswered,
  isRichInteractionFrame,
  isScheduleEchoReady,
  questionKey,
  scheduleDraftOf,
  scheduleEchoResult,
  type QuestionState,
} from '../shell/form-protocol'

function choiceReq(overrides: Partial<ExtensionUIRequest> = {}): ExtensionUIRequest {
  return {
    sessionId: 'sid-a',
    requestId: 'req-1',
    dialogKind: 'select',
    form: true,
    formQuestions: [
      { type: 'choice', question: '用哪个数据库？', options: [{ label: 'pg' }, { label: 'mysql' }] },
    ],
    ...overrides,
  }
}

function stateOf(selectedValues: string[], otherText = ''): QuestionState {
  return { selectedValues, otherText }
}

describe('问题 key 与已答判定', () => {
  it('questionKey：header 缺省回落 question 全文（协议 fallback 规则）', () => {
    expect(questionKey({ type: 'text', question: 'q1' })).toBe('q1')
    expect(questionKey({ type: 'text', header: 'h', question: 'q1' })).toBe('h')
  })

  it('choice：普通选项选中 ≥1 即已答；Other 选中无文本不算（另有其他选中则算）', () => {
    const q = { type: 'choice' as const, question: 'q', options: [{ label: 'a' }, { label: 'b' }] }
    expect(isQuestionAnswered(q, stateOf([]), true)).toBe(false)
    expect(isQuestionAnswered(q, stateOf(['a']), true)).toBe(true)
    expect(isQuestionAnswered(q, stateOf([OTHER_VALUE]), true)).toBe(false)
    expect(isQuestionAnswered(q, stateOf([OTHER_VALUE, 'a']), true)).toBe(true)
  })

  it('text / 空 options 退化 choice：非空文本即已答；schedule 委托 ready 入参', () => {
    const text = { type: 'text' as const, question: 'q' }
    expect(isQuestionAnswered(text, initialQuestionState(), true)).toBe(false)
    expect(isQuestionAnswered(text, stateOf([], '答案'), true)).toBe(true)
    const degenerate = { type: 'choice' as const, question: 'q', options: [] }
    expect(isQuestionAnswered(degenerate, stateOf([], '自由文本'), true)).toBe(true)
    const schedule = { type: 'schedule' as const, question: 'q' }
    expect(isQuestionAnswered(schedule, undefined, false)).toBe(false)
    expect(isQuestionAnswered(schedule, undefined, true)).toBe(true)
  })
})

describe('FormAnswers envelope 编码（桌面 FormOverlay.onSubmit 同契约）', () => {
  const single = { type: 'choice' as const, header: 'db', question: '用哪个数据库？', options: [{ label: 'pg' }, { label: 'mysql' }] }
  const multi = { type: 'choice' as const, header: 'feat', question: '要哪些功能？', multi: true, options: [{ label: 'a' }, { label: 'b' }, { label: 'c' }] }
  const text = { type: 'text' as const, header: 'note', question: '补充说明？' }

  it('单选 = label；多选 = JSON.stringify(label[])；Other 过滤占位符', () => {
    const answers = encodeFormAnswers(
      [single, multi],
      { db: stateOf(['pg']), feat: stateOf(['a', OTHER_VALUE, 'c']) },
      () => null,
    )
    expect(answers).toEqual({ db: 'pg', feat: JSON.stringify(['a', 'c']) })
  })

  it('Other 自由文本写 `${key}__other` 独立键；text 题答案只写 __other 不写主 key', () => {
    expect(encodeFormAnswers(
      [single, text],
      { db: stateOf([OTHER_VALUE], '自定义'), note: stateOf([], '备注内容') },
      () => null,
    )).toEqual({ db__other: '自定义', note__other: '备注内容' })
  })

  it('schedule 题经 scheduleValue 取回显 JSON 写主 key；不可构造返回 null 中止整表', () => {
    const schedule = { type: 'schedule' as const, question: '什么时候跑？', initial: undefined }
    expect(encodeFormAnswers([schedule], {}, () => null)).toBeNull()
    expect(encodeFormAnswers([schedule], {}, () => '{"action":"create"}')).toEqual({
      [schedule.question]: '{"action":"create"}',
    })
  })

  it('无状态的问题跳过（不伪造空答案键）', () => {
    expect(encodeFormAnswers([single], {}, () => null)).toEqual({})
  })
})

describe('schedule 草稿回显（桌面 ScheduleForm 打开即确认路径等价）', () => {
  const baseDraft = {
    kind: 'once' as const,
    schedule: '30 14 2 10 *',
    prompt: '跑每日备份',
    models: ['m1', 'm2'],
  }

  it('once：草稿 cron 经 onceCronToDate 还原再 dateToOnceCron 折叠（往返稳定）', () => {
    const result = draftToScheduleFormResult(baseDraft)
    expect(result).not.toBeNull()
    expect(result!.action).toBe('create')
    expect(result!.kind).toBe('once')
    expect(result!.schedule).toBe(baseDraft.schedule) // 未过时刻往返字节稳定
    expect(result!.prompt).toBe('跑每日备份')
    expect(result!.name).toBeUndefined()
    expect(result!.expires).toBeUndefined() // once 不携带 expires
  })

  it('recurring：schedule 原样（trim）；expires 缺省 7d、显式 30d/never 保留；model 缺省剔除', () => {
    const result = draftToScheduleFormResult({
      ...baseDraft,
      kind: 'recurring',
      schedule: '  */5 * * * *  ',
      expires: '7d',
      model: '不在候选列表的模型',
    })
    expect(result).toEqual({
      action: 'create',
      kind: 'recurring',
      schedule: '*/5 * * * *',
      model: 'm1', // 预选回落候选首项（桌面 initModelSelection 同式）
      prompt: '跑每日备份',
      expires: '7d',
    })
    expect(draftToScheduleFormResult({ ...baseDraft, kind: 'recurring', expires: 'never' })!.expires).toBe('never')
    expect(draftToScheduleFormResult({ ...baseDraft, kind: 'recurring', expires: '30d' })!.expires).toBe('30d')
  })

  it('model 预选：draft.model 优先 → 会话当前模型 → 候选首项；空候选缺省', () => {
    expect(draftToScheduleFormResult({ ...baseDraft, model: 'm2' })!.model).toBe('m2')
    expect(draftToScheduleFormResult({ ...baseDraft, currentModel: 'm2' })!.model).toBe('m2')
    expect(draftToScheduleFormResult({ ...baseDraft, models: [] })!.model).toBeUndefined()
  })

  it('prompt 空 → null（桌面 canSubmit 同判）；once cron 非 5 段一次性形态 → null；name trim 空剔除', () => {
    expect(draftToScheduleFormResult({ ...baseDraft, prompt: '   ' })).toBeNull()
    expect(draftToScheduleFormResult({ ...baseDraft, schedule: '*/5 * * * *' })).toBeNull()
    expect(draftToScheduleFormResult({ ...baseDraft, name: '  ' })!.name).toBeUndefined()
  })

  it('schedule 题无 initial → 回显不可构造（仅可取消）；有 initial 委托 draft 回显', () => {
    expect(isScheduleEchoReady({ type: 'schedule', question: 'q' })).toBe(false)
    expect(scheduleEchoResult({ type: 'schedule', question: 'q' })).toBeNull()
    expect(isScheduleEchoReady({ type: 'schedule', question: 'q', initial: baseDraft })).toBe(true)
    expect(scheduleEchoResult({ type: 'schedule', question: 'q', initial: baseDraft })).toEqual(
      draftToScheduleFormResult(baseDraft),
    )
  })
})

describe('帧标记守卫与字段收窄', () => {
  it('isRichInteractionFrame：form/planReview 放行；普通 dialog 帧拒绝；非对象安全 false', () => {
    expect(isRichInteractionFrame({ form: true })).toBe(true)
    expect(isRichInteractionFrame({ planReview: true })).toBe(true)
    expect(isRichInteractionFrame({ kind: 'select', options: ['a'] })).toBe(false)
    expect(isRichInteractionFrame(null)).toBe(false)
    expect(isRichInteractionFrame('form')).toBe(false)
  })

  it('isPlanReviewFrame 窄化 + selfReview 搬运；formQuestionsOf 过滤非法项；scheduleDraftOf 收窄', () => {
    const planFrame = { ...choiceReq(), planReview: true, selfReview: '自审结论' } as unknown as ExtensionUIRequest
    expect(isPlanReviewFrame(planFrame)).toBe(true)

    const mixed = choiceReq({
      formQuestions: [
        { type: 'choice', question: 'q1', options: [{ label: 'a' }] },
        { type: 'alien' },
        'not-an-object',
      ],
    })
    const qs = formQuestionsOf(mixed)
    expect(qs).toHaveLength(1)
    expect(formQuestionsOf({ ...choiceReq(), form: undefined })).toEqual([])

    const draft = { kind: 'once' as const, schedule: '30 14 2 10 *', prompt: 'p', models: ['m1'] }
    const draftReq = choiceReq({ scheduleCreate: true, scheduleDraft: draft })
    expect(scheduleDraftOf(draftReq)).not.toBeNull()
    expect(scheduleDraftOf(choiceReq({ scheduleCreate: true, scheduleDraft: { broken: true } }))).toBeNull()
    expect(scheduleDraftOf(choiceReq())).toBeNull()
  })
})
