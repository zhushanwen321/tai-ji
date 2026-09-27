// ui-form.test.ts — 统一提问表单协议：类型双路径（payload 构造 / answers 解析）/
// TUI 抛错契约 / uiFormInteract 四态折叠 / echo 检测 / isFormQuestion 与 isFormAnswers 守卫。
// 经 barrel（../../../index）导入：单测同时锚定新增导出面。

import { describe, it, expect, vi } from 'vitest'
import {
  UI_FORM_MARKER,
  uiFormInteract,
  isFormQuestion,
  isFormAnswers,
  type GuiContext,
  type FormQuestion,
  type ScheduleDraft,
} from '../../index'

type SelectImpl = (
  marker: string,
  options: string[],
  opts?: { signal?: AbortSignal; timeout?: number },
) => Promise<string | undefined>

/** mock ctx：select 实现由用例注入（缺省 resolve undefined） */
function makeCtx(impl?: SelectImpl): { ctx: GuiContext; selectMock: ReturnType<typeof vi.fn> } {
  const selectMock = vi.fn(impl ?? (async () => undefined))
  const ctx: GuiContext = { mode: 'rpc', hasUI: true, ui: { select: selectMock } }
  return { ctx, selectMock }
}

const draft: ScheduleDraft = {
  kind: 'once',
  schedule: '0 9 19 9 *',
  prompt: '总结昨天的工作进展',
  models: ['deepseek-flash'],
  currentModel: 'mimo-v2.5-pro',
}

describe('uiFormInteract：类型双路径（payload 构造 / answers 解析）', () => {
  it('choice 路径：payload 携带 formQuestions（multi/allowOther 透传），回传单选 label', async () => {
    const answers = { db: 'postgres' }
    const { ctx, selectMock } = makeCtx(async () => JSON.stringify(answers))
    const questions: FormQuestion[] = [{
      type: 'choice',
      header: 'db',
      question: '选哪个数据库?',
      options: [{ label: 'postgres' }, { label: 'mysql', description: '备选' }],
      multi: false,
      allowOther: false,
    }]

    const result = await uiFormInteract(ctx, questions)

    expect(result).toEqual({ ok: true, answers })
    const [marker, options] = selectMock.mock.calls[0] as [string, string[]]
    expect(marker).toBe(UI_FORM_MARKER)
    expect(options).toHaveLength(1)
    const payload = JSON.parse(options[0])
    expect(payload.formQuestions).toEqual(questions)
    expect(payload.allowCancel).toBe(true)
  })

  it('choice 多选 answers（JSON.stringify(labels[]) 形态）原样透传', async () => {
    const answers = { lang: '["ts","py"]', lang__other: '还想用 go' }
    const { ctx } = makeCtx(async () => JSON.stringify(answers))
    const questions: FormQuestion[] = [{
      type: 'choice', header: 'lang', question: '用哪些语言?', multi: true, options: [{ label: 'ts' }],
    }]

    const result = await uiFormInteract(ctx, questions)

    expect(result).toEqual({ ok: true, answers })
  })

  it('text 路径：答案键位 `${key}__other`（逐字继承纯 other 形态）透传', async () => {
    const answers = { '自由描述?__other': '用户输入的自由文本' }
    const { ctx, selectMock } = makeCtx(async () => JSON.stringify(answers))
    const questions: FormQuestion[] = [{ type: 'text', header: '自由描述', question: '自由描述?' }]

    const result = await uiFormInteract(ctx, questions)

    expect(result).toEqual({ ok: true, answers })
    // 发送侧 text 无 options 字段——与 choice 形态区分的判别依据
    const payload = JSON.parse((selectMock.mock.calls[0] as [string, string[]])[1][0])
    expect(payload.formQuestions[0]).toEqual({ type: 'text', header: '自由描述', question: '自由描述?' })
  })

  it('schedule 路径：initial 草稿进 payload，回传 JSON.stringify(ScheduleFormResult)', async () => {
    const formResult = { action: 'create', kind: 'once', schedule: '0 9 21 9 *', prompt: '用户调整后' }
    const answers = { 任务确认: JSON.stringify(formResult) }
    const { ctx, selectMock } = makeCtx(async () => JSON.stringify(answers))
    const questions: FormQuestion[] = [{ type: 'schedule', question: '任务确认', initial: draft }]

    const result = await uiFormInteract(ctx, questions)

    expect(result).toEqual({ ok: true, answers })
    const payload = JSON.parse((selectMock.mock.calls[0] as [string, string[]])[1][0])
    expect(payload.formQuestions).toEqual([{ type: 'schedule', question: '任务确认', initial: draft }])
    // 消费端取值即 parse 回 FormResult（answers 值域契约）
    if (result.ok) {
      expect(JSON.parse(result.answers['任务确认'])).toEqual(formResult)
    }
  })

  it('header 缺省：answers key fallback 到 question 全文（与 askUserKey 同规则）', async () => {
    const questionText = '部署前需要确认环境吗?'
    const answers = { [questionText]: 'yes' }
    const { ctx } = makeCtx(async () => JSON.stringify(answers))
    const questions: FormQuestion[] = [{ type: 'choice', question: questionText, options: [{ label: 'yes' }] }]

    const result = await uiFormInteract(ctx, questions)

    expect(result).toEqual({ ok: true, answers })
  })

  it('allowCancel 显式 false 进 payload；signal 透传 select', async () => {
    const signal = new AbortController().signal
    const { ctx, selectMock } = makeCtx(async () => JSON.stringify({}))

    await uiFormInteract(ctx, [{ type: 'text', question: 'q' }], { allowCancel: false, signal })

    const [marker, options, opts] = selectMock.mock.calls[0] as [string, string[], { signal?: AbortSignal }]
    expect(marker).toBe(UI_FORM_MARKER)
    expect(JSON.parse(options[0]).allowCancel).toBe(false)
    expect(opts.signal).toBe(signal)
  })

  it('空 questions → {ok:true, answers:{}}，不触达通道（与 askUserInteract 先例一致）', async () => {
    const { ctx, selectMock } = makeCtx()

    const result = await uiFormInteract(ctx, [])

    expect(result).toEqual({ ok: true, answers: {} })
    expect(selectMock).not.toHaveBeenCalled()
  })

  it('UI_FORM_MARKER 常量值正确（NUL 前缀，对齐 ask-user marker 家族）', () => {
    expect(UI_FORM_MARKER).toBe('\x00TAIJI_UI_FORM')
    expect(UI_FORM_MARKER.startsWith('\x00')).toBe(true)
  })
})

describe('uiFormInteract：TUI 抛错契约', () => {
  it('TUI 模式 → throw（extension 须自行渲染，返回失败态会与用户取消混淆）', async () => {
    const ctx: GuiContext = { mode: 'tui', hasUI: true }
    await expect(
      uiFormInteract(ctx, [{ type: 'text', question: 'q' }]),
    ).rejects.toThrow(/only available in RPC mode/)
  })

  it('RPC 但 ui.select 缺席 → throw（同一门控，恢复动作同指自有渲染）', async () => {
    const ctx: GuiContext = { mode: 'rpc', hasUI: true }
    await expect(
      uiFormInteract(ctx, [{ type: 'text', question: 'q' }]),
    ).rejects.toThrow(/only available in RPC mode/)
  })
})

describe('uiFormInteract：四态折叠', () => {
  it('回包 undefined + signal 已 abort → cancelled', async () => {
    const controller = new AbortController()
    controller.abort()
    const { ctx } = makeCtx(async () => undefined)

    const result = await uiFormInteract(ctx, [{ type: 'text', question: 'q' }], { signal: controller.signal })

    expect(result).toEqual({ ok: false, reason: 'cancelled' })
  })

  it('回包 undefined 无 signal → timeout（仅由未 abort 的 undefined resolve 产生）', async () => {
    const { ctx } = makeCtx(async () => undefined)

    const result = await uiFormInteract(ctx, [{ type: 'text', question: 'q' }])

    expect(result).toEqual({ ok: false, reason: 'timeout' })
  })

  it('select throw → channel-error + log 留痕', async () => {
    const log = vi.fn()
    const { ctx } = makeCtx(async () => {
      throw new Error('channel closed')
    })

    const result = await uiFormInteract(ctx, [{ type: 'text', question: 'q' }], { log })

    expect(result).toEqual({ ok: false, reason: 'channel-error' })
    expect(log).toHaveBeenCalledTimes(1)
  })

  it('非 JSON 回包 → non-json（callMarkerRpc 层检测）', async () => {
    const log = vi.fn()
    const { ctx } = makeCtx(async () => 'plain text response')

    const result = await uiFormInteract(ctx, [{ type: 'text', question: 'q' }], { log })

    expect(result).toEqual({ ok: false, reason: 'non-json' })
  })

  it.each([
    ['数组形态', '["a"]'],
    ['值域非 string（数字）', '{"db":123}'],
    ['嵌套对象值', '{"db":{"a":"b"}}'],
    ['null', 'null'],
  ])('JSON 合法但非 FormAnswers 形状 → non-json（协议版本错配同折叠）：%s', async (_label, raw) => {
    const log = vi.fn()
    const { ctx } = makeCtx(async () => raw)

    const result = await uiFormInteract(ctx, [{ type: 'text', question: 'q' }], { log })

    expect(result).toEqual({ ok: false, reason: 'non-json' })
    expect(log).toHaveBeenCalledWith(
      'ui-form response is not a FormAnswers record',
      expect.objectContaining({ responseHead: expect.any(String) }),
    )
  })
})

describe('uiFormInteract：echo 检测', () => {
  it('收包 === 发送 payload（旧宿主降级 band 点选回显）→ channel-error + 升级指引', async () => {
    const log = vi.fn()
    // 旧 taiji 不识别 UI_FORM_MARKER：form 帧降级普通 select，单选项 = payload 自身
    const { ctx } = makeCtx(async (_marker, options) => options[0])

    const result = await uiFormInteract(ctx, [{ type: 'choice', header: 'db', question: 'q', options: [{ label: 'pg' }] }], { log })

    expect(result).toEqual({
      ok: false,
      reason: 'channel-error',
      message: 'taiji host too old for form protocol — upgrade taiji or pin extension version',
    })
    expect(log).toHaveBeenCalledWith(
      'ui-form response echoed the request payload (host does not understand UI_FORM_MARKER)',
      expect.objectContaining({ responseHead: expect.any(String) }),
    )
  })

  it('收包 ≠ payload（正常 answers 回传）→ 不触发 echo，正常解析', async () => {
    const answers = { db: 'pg' }
    const { ctx } = makeCtx(async () => JSON.stringify(answers))

    const result = await uiFormInteract(ctx, [{ type: 'choice', header: 'db', question: 'q', options: [{ label: 'pg' }] }])

    expect(result).toEqual({ ok: true, answers })
  })

  it('回传是合法 JSON 但与 payload 不同 → 走形状守卫而非 echo（逐字节相等才命中）', async () => {
    // 非 FormAnswers 形状的 JSON 回包：不是 echo，按 non-json 折叠（区分两类故障）
    const { ctx } = makeCtx(async () => JSON.stringify({ formQuestions: [{ type: 'text', question: 'q' }] }))

    const result = await uiFormInteract(ctx, [{ type: 'choice', header: 'x', question: 'q', options: [{ label: 'a' }] }])

    expect(result).toEqual({ ok: false, reason: 'non-json' })
  })
})

describe('uiFormInteract：发送侧守卫失败策略', () => {
  it('含不合法项 → 抛错并指明索引，不触达通道（调用方编码 bug，fail-fast）', async () => {
    const { ctx, selectMock } = makeCtx(async () => JSON.stringify({}))
    const bad = { type: 'choice', question: '缺 options' } as unknown as FormQuestion

    await expect(
      uiFormInteract(ctx, [{ type: 'text', question: 'q' }, bad]),
    ).rejects.toThrow(/form\[1\] is not a valid FormQuestion/)

    expect(selectMock).not.toHaveBeenCalled()
  })

  it('不合法项抛错先于 TUI 门（数据契约尽早暴露）', async () => {
    const ctx: GuiContext = { mode: 'tui', hasUI: true }
    const bad = { type: 'unknown', question: 'q' } as unknown as FormQuestion

    await expect(
      uiFormInteract(ctx, [bad]),
    ).rejects.toThrow(/form\[0\] is not a valid FormQuestion/)
  })
})

describe('isFormQuestion 类型守卫', () => {
  it('三类型最小合法形态 → true', () => {
    expect(isFormQuestion({ type: 'choice', question: 'q?', options: [{ label: 'a' }] })).toBe(true)
    expect(isFormQuestion({ type: 'text', question: 'q?' })).toBe(true)
    expect(isFormQuestion({ type: 'schedule', question: 'q?' })).toBe(true)
  })

  it('三类型全字段形态 → true', () => {
    expect(isFormQuestion({
      type: 'choice', header: 'h', question: 'q?', context: 'c',
      options: [{ label: 'a', description: 'd' }], multi: true, allowOther: false,
    })).toBe(true)
    expect(isFormQuestion({ type: 'text', header: 'h', question: 'q?', context: 'c' })).toBe(true)
    expect(isFormQuestion({ type: 'schedule', header: 'h', question: 'q?', context: 'c', initial: draft })).toBe(true)
  })

  it.each([
    ['choice 缺 options', { type: 'choice', question: 'q?' }],
    ['choice options 非数组', { type: 'choice', question: 'q?', options: 'not-array' }],
    ['choice 选项缺 label', { type: 'choice', question: 'q?', options: [{ description: 'd' }] }],
    ['choice label 非 string', { type: 'choice', question: 'q?', options: [{ label: 1 }] }],
    ['choice description 非 string', { type: 'choice', question: 'q?', options: [{ label: 'a', description: 1 }] }],
    ['choice multi 非 boolean', { type: 'choice', question: 'q?', options: [], multi: 'yes' }],
    ['choice allowOther 非 boolean', { type: 'choice', question: 'q?', options: [], allowOther: 1 }],
    ['schedule initial 非法草稿', { type: 'schedule', question: 'q?', initial: { kind: 'once' } }],
    ['type 未知值', { type: 'datetime', question: 'q?' }],
    ['缺 type', { question: 'q?' }],
    ['缺 question', { type: 'text' }],
    ['question 非 string', { type: 'text', question: 123 }],
    ['header 非 string', { type: 'text', question: 'q?', header: 1 }],
    ['context 非 string', { type: 'text', question: 'q?', context: 1 }],
  ])('不合法形态 → false：%s', (_label, value) => {
    expect(isFormQuestion(value)).toBe(false)
  })

  it('未知附加字段 → true（白名单校验，多余字段忽略）', () => {
    expect(isFormQuestion({ type: 'text', question: 'q?', unknownFutureField: true })).toBe(true)
    // 其他分支的声明字段对本分支也是「未知附加字段」——忽略不拒（isScheduleDraft 同语义）
    expect(isFormQuestion({ type: 'text', question: 'q?', options: [{ label: 'a' }] })).toBe(true)
  })

  it('null / undefined / 非对象 / 数组 → false', () => {
    expect(isFormQuestion(null)).toBe(false)
    expect(isFormQuestion(undefined)).toBe(false)
    expect(isFormQuestion('text')).toBe(false)
    expect(isFormQuestion([{ type: 'text', question: 'q?' }])).toBe(false)
  })

  it('空 options 的 choice 形状合法（守卫只管形状，语义完备性归调用方/渲染器）', () => {
    expect(isFormQuestion({ type: 'choice', question: 'q?', options: [] })).toBe(true)
  })
})

describe('isFormAnswers 形状守卫', () => {
  it('合法 answers（含 __other 键与 JSON 序列化多选值）→ true', () => {
    expect(isFormAnswers({ db: 'pg', 'db__other': '理由', lang: '["ts","py"]' })).toBe(true)
  })

  it('空对象 → true（用户 Submit 空表单语义）', () => {
    expect(isFormAnswers({})).toBe(true)
  })

  it.each([
    ['值域非 string', { db: 123 }],
    ['数组', ['pg']],
    ['null', null],
    ['字符串', 'pg'],
  ])('不合法形态 → false：%s', (_label, value) => {
    expect(isFormAnswers(value)).toBe(false)
  })
})
