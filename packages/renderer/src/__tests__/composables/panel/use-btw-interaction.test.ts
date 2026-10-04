/**
 * useBtwInteraction 表单归一化纯函数群直测（test-coverage MF-3 补防线）。
 *
 * 六个纯函数（toScheduleDraft / toBarQuestionKind / toBarQuestionBase / toBarOptions /
 * toBarQuestion / questionsOf）经模块 __testing 后门直测——非法项剔除策略与 runtime 侧
 * isFormQuestion 逐项过滤同策略（对齐声明见源文件 :111 注释），此前双侧均无 renderer
 * 侧回归防线。行为面（formQuestions 请求 → BtwPanel 降档 DOM）归
 * src/__tests__/panel/btw-panel.test.ts 的内联确认条用例。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/composables/panel/use-btw-interaction.test.ts
 */
import { describe, it, expect } from 'vitest'
import { __testing } from '@/composables/panel/useBtwInteraction'
import type { ExtensionUIRequest } from '@taiji/core/transport/api/domains/extension'

const { toScheduleDraft, toBarQuestionKind, toBarQuestionBase, toBarOptions, toBarQuestion, questionsOf } = __testing

/** ExtensionUIRequest 最小合法骨架（questionsOf 形参；其余用例直接喂 unknown） */
function formReq(overrides: Partial<ExtensionUIRequest>): ExtensionUIRequest {
  return { sessionId: 'btw:pi-1', requestId: 'r1', method: 'select', ...overrides }
}

describe('toScheduleDraft（schedule 草稿形状守卫）', () => {
  it('合法 once 草稿：必填三字段透传，可选字段缺省即省略（无 undefined 键）', () => {
    expect(toScheduleDraft({ kind: 'once', schedule: '2026-09-24T09:00', prompt: '跑巡检' }))
      .toEqual({ kind: 'once', schedule: '2026-09-24T09:00', prompt: '跑巡检' })
  })

  it('合法 recurring 草稿：model/name/expires 可选字段按类型守卫透传', () => {
    expect(
      toScheduleDraft({
        kind: 'recurring',
        schedule: '0 9 * * *',
        prompt: 'p',
        model: 'prov/m',
        name: '日常',
        expires: '2026-12-31',
      }),
    ).toEqual({
      kind: 'recurring',
      schedule: '0 9 * * *',
      prompt: 'p',
      model: 'prov/m',
      name: '日常',
      expires: '2026-12-31',
    })
  })

  it('非对象（string/number/null/undefined）→ null', () => {
    expect(toScheduleDraft('once')).toBeNull()
    expect(toScheduleDraft(42)).toBeNull()
    expect(toScheduleDraft(null)).toBeNull()
    expect(toScheduleDraft(undefined)).toBeNull()
  })

  it('kind 越界 → null；schedule/prompt 非字符串 → null', () => {
    expect(toScheduleDraft({ kind: 'daily', schedule: '0 9 * * *', prompt: 'p' })).toBeNull()
    expect(toScheduleDraft({ kind: 'once', schedule: 9, prompt: 'p' })).toBeNull()
    expect(toScheduleDraft({ kind: 'once', schedule: '0 9 * * *', prompt: null })).toBeNull()
  })

  it('可选字段类型不符（model 非字符串）→ 该字段剔除，不伪造', () => {
    expect(toScheduleDraft({ kind: 'once', schedule: 's', prompt: 'p', model: 1 }))
      .toEqual({ kind: 'once', schedule: 's', prompt: 'p' })
  })
})

describe('toBarQuestionKind（choice/text/schedule 闭集收窄）', () => {
  it('三个合法值原样放行', () => {
    expect(toBarQuestionKind('choice')).toBe('choice')
    expect(toBarQuestionKind('text')).toBe('text')
    expect(toBarQuestionKind('schedule')).toBe('schedule')
  })

  it('闭集外（未知类型/undefined/大小写不符）→ null', () => {
    expect(toBarQuestionKind('boolean')).toBeNull()
    expect(toBarQuestionKind(undefined)).toBeNull()
    expect(toBarQuestionKind('Choice')).toBeNull()
  })
})

describe('toBarQuestionBase（header/question 双守卫基底）', () => {
  it('双有 → 透传；仅 question → header 省略；仅 header → question 落空串', () => {
    expect(toBarQuestionBase({ header: 'H', question: 'Q' }, 'text'))
      .toEqual({ type: 'text', header: 'H', question: 'Q' })
    expect(toBarQuestionBase({ question: 'Q' }, 'text')).toEqual({ type: 'text', question: 'Q' })
    expect(toBarQuestionBase({ header: 'H' }, 'choice')).toEqual({ type: 'choice', header: 'H', question: '' })
  })

  it('header/question 双缺 → null（非法项，空串键不可答）', () => {
    expect(toBarQuestionBase({}, 'text')).toBeNull()
  })
})

describe('toBarOptions（choice 选项数组归一）', () => {
  it('合法数组：label 保留 + description 类型守卫可选透传', () => {
    expect(
      toBarOptions([
        { label: 'A' },
        { label: 'B', description: '更快' },
        { label: 'C', description: 42 },
      ]),
    ).toEqual([{ label: 'A' }, { label: 'B', description: '更快' }, { label: 'C' }])
  })

  it('非数组 → 空数组（题保留，仅选项降级为空）', () => {
    expect(toBarOptions(undefined)).toEqual([])
    expect(toBarOptions('A')).toEqual([])
  })

  it('非法项剔除：非对象项 / 缺 label 项不进结果', () => {
    expect(
      toBarOptions([
        'raw-string',
        null,
        42,
        { description: '无 label' },
        { label: '有效' },
      ]),
    ).toEqual([{ label: '有效' }])
  })
})

describe('toBarQuestion（formQuestions 逐项归一）', () => {
  it('choice 题：options 归一 + multi 显式 true + allowOther 缺省 true / 显式 false', () => {
    expect(
      toBarQuestion({
        type: 'choice',
        header: '模型',
        question: '选哪个',
        options: [{ label: 'A' }, { noLabel: true }, 'junk'],
        multi: true,
      }),
    ).toEqual({
      type: 'choice',
      header: '模型',
      question: '选哪个',
      options: [{ label: 'A' }],
      multi: true,
      allowOther: true,
    })
    expect(
      toBarQuestion({ type: 'choice', question: 'Q', options: [], allowOther: false }),
    ).toMatchObject({ allowOther: false })
  })

  it('text 题：无 options/multi/allowOther 键（降档单行输入即可答）', () => {
    expect(toBarQuestion({ type: 'text', question: '说明', options: [{ label: 'X' }] }))
      .toEqual({ type: 'text', question: '说明' })
  })

  it('schedule 题：initial 有效透传；无效（缺字段）→ initial 键省略', () => {
    expect(
      toBarQuestion({ type: 'schedule', question: '排程', initial: { kind: 'once', schedule: 's', prompt: 'p' } }),
    ).toEqual({
      type: 'schedule',
      question: '排程',
      initial: { kind: 'once', schedule: 's', prompt: 'p' },
    })
    expect(toBarQuestion({ type: 'schedule', question: '排程', initial: { kind: 'daily' } }))
      .toEqual({ type: 'schedule', question: '排程' })
  })

  it('非法项 → null：非对象 / type 越界 / header+question 双缺', () => {
    expect(toBarQuestion('junk')).toBeNull()
    expect(toBarQuestion(null)).toBeNull()
    expect(toBarQuestion({ type: 'boolean', question: 'Q' })).toBeNull()
    expect(toBarQuestion({ type: 'text', header: undefined, question: '' })).toBeNull()
  })
})

describe('questionsOf（questions 源优先 + legacy 包装）', () => {
  it('formQuestions 源：合法项保留、非法项剔除（与 runtime isFormQuestion 同策略）', () => {
    const qs = questionsOf(
      formReq({
        form: true,
        formQuestions: [
          { type: 'choice', question: '选哪个', options: [{ label: 'A' }, 'junk'] },
          { type: 'boolean', question: '越界类型' },
          { type: 'text' }, // header/question 双缺
          'raw-junk',
          { type: 'text', question: '说明' },
        ],
      }),
    )
    expect(qs).toHaveLength(2)
    expect(qs[0]).toMatchObject({ type: 'choice', question: '选哪个', options: [{ label: 'A' }] })
    expect(qs[1]).toEqual({ type: 'text', question: '说明' })
  })

  it('questions 优先级：formQuestions 有合法项时忽略 legacy scheduleCreate/scheduleDraft', () => {
    const qs = questionsOf(
      formReq({
        form: true,
        formQuestions: [{ type: 'text', question: 'Q' }],
        scheduleCreate: true,
        scheduleDraft: { kind: 'once', schedule: 's', prompt: 'p' },
      }),
    )
    expect(qs).toEqual([{ type: 'text', question: 'Q' }])
  })

  it('legacy scheduleCreate 源：合法 draft → 包装单 schedule 问（question 空串 + initial 预填）', () => {
    expect(
      questionsOf(
        formReq({
          form: true,
          scheduleCreate: true,
          scheduleDraft: { kind: 'recurring', schedule: '0 9 * * *', prompt: 'p', model: 'm' },
        }),
      ),
    ).toEqual([
      { type: 'schedule', question: '', initial: { kind: 'recurring', schedule: '0 9 * * *', prompt: 'p', model: 'm' } },
    ])
  })

  it('formQuestions 全非法 → 回退 legacy 源；scheduleCreate 缺省 / draft 无效 → 空集', () => {
    // 全非法 questions 落空后 legacy 兜底接管
    expect(
      questionsOf(
        formReq({
          form: true,
          formQuestions: [{ type: 'boolean' }, 'junk'],
          scheduleCreate: true,
          scheduleDraft: { kind: 'once', schedule: 's', prompt: 'p' },
        }),
      ),
    ).toEqual([{ type: 'schedule', question: '', initial: { kind: 'once', schedule: 's', prompt: 'p' } }])
    // scheduleCreate 未置位 → 不包装
    expect(
      questionsOf(formReq({ form: true, scheduleDraft: { kind: 'once', schedule: 's', prompt: 'p' } })),
    ).toEqual([])
    // scheduleCreate 置位但 draft 无效 → 不包装
    expect(questionsOf(formReq({ form: true, scheduleCreate: true, scheduleDraft: { kind: 'daily' } }))).toEqual([])
    // 无任何源
    expect(questionsOf(formReq({ form: true }))).toEqual([])
  })
})
