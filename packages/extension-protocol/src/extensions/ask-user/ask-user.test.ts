import { describe, it, expect } from 'vitest'
import {
  askUserInteract,
  getAskUserAnswer,
  getAskUserOther,
  isAskUserQuestion,
  ASK_USER_MARKER,
  type GuiContext,
  type AskUserQuestion,
} from '../../index'

// ── 富交互：askUserInteract + 解析 helper + marker（U1-U5）──

/** 构造带 mock select 的 RPC ctx */
function makeRpcCtx(selectImpl: (header: string, options: string[]) => Promise<string | undefined>): GuiContext {
  return {
    mode: 'rpc',
    hasUI: true,
    ui: {
      select: (header: string, options: string[]) => selectImpl(header, options),
    },
  }
}

describe('askUserInteract', () => {
  it('U1: RPC 模式 select 返回 JSON string → 解析出 answers', async () => {
    const mockAnswers = { db: 'postgres' }
    const ctx = makeRpcCtx(async (_header, _options) => JSON.stringify(mockAnswers))

    const questions: AskUserQuestion[] = [
      { header: 'db', question: '选哪个数据库?', options: [{ label: 'Postgres' }] },
    ]
    const result = await askUserInteract(ctx, questions)

    expect(result).toEqual(mockAnswers)
  })

  it('U1: select 收到 title=marker + options[0]=JSON payload', async () => {
    let capturedHeader: string | undefined
    let capturedOptions: string[] | undefined
    const ctx = makeRpcCtx(async (header, options) => {
      capturedHeader = header
      capturedOptions = options
      return JSON.stringify({})
    })

    const questions: AskUserQuestion[] = [
      { header: 'lang', question: 'q', options: [{ label: 'TS' }] },
    ]
    await askUserInteract(ctx, questions, { allowCancel: false })

    expect(capturedHeader).toBe(ASK_USER_MARKER)
    expect(capturedOptions).toHaveLength(1)
    const payload = JSON.parse(capturedOptions![0])
    expect(payload.questions).toEqual(questions)
    expect(payload.allowCancel).toBe(false)
  })

  it('U2: select 返回 undefined（用户取消/超时）→ null', async () => {
    const ctx = makeRpcCtx(async () => undefined)
    const result = await askUserInteract(ctx, [{ header: 'x', question: 'q' }])
    expect(result).toBeNull()
  })

  it('U3: select 返回非法 JSON → null（视为取消）', async () => {
    const ctx = makeRpcCtx(async () => 'not-json{')
    const result = await askUserInteract(ctx, [{ header: 'x', question: 'q' }])
    expect(result).toBeNull()
  })

  it('U4: ASK_USER_MARKER 常量值正确（NUL 前缀）', () => {
    expect(ASK_USER_MARKER).toBe('\x00TAIJI_ASK_USER')
    expect(ASK_USER_MARKER.startsWith('\x00')).toBe(true)
  })

  it('U4: TUI 模式抛错（不返回 null 避免与取消混淆）', async () => {
    const ctx: GuiContext = { mode: 'tui', hasUI: true }
    await expect(
      askUserInteract(ctx, [{ header: 'x', question: 'q' }]),
    ).rejects.toThrow('only available in RPC mode')
  })

  it('U4: 空 questions 返回 {}（不报错）', async () => {
    const ctx: GuiContext = { mode: 'rpc', hasUI: true }
    const result = await askUserInteract(ctx, [])
    expect(result).toEqual({})
  })
})

describe('getAskUserAnswer / getAskUserOther', () => {
  it('U5: 单选——返回 string value', () => {
    const q: AskUserQuestion = { header: 'db', question: 'q', options: [{ label: 'PG' }] }
    const answers = { db: 'pg' }
    expect(getAskUserAnswer(answers, q)).toBe('pg')
  })

  it('U5: 多选——JSON.parse 返回 string[]', () => {
    const q: AskUserQuestion = { header: 'lang', question: 'q', multiSelect: true, options: [] }
    const answers = { lang: '["ts","py"]' }
    expect(getAskUserAnswer(answers, q)).toEqual(['ts', 'py'])
  })

  it('U5: 多选 JSON.parse 失败 → 降级返回 [raw]', () => {
    const q: AskUserQuestion = { header: 'lang', question: 'q', multiSelect: true }
    const answers = { lang: 'not-json' }
    expect(getAskUserAnswer(answers, q)).toEqual(['not-json'])
  })

  it('U5: header 缺失时用 question 文本做 key', () => {
    const q: AskUserQuestion = { question: '选哪个?' }
    const answers = { '选哪个?': 'val' }
    expect(getAskUserAnswer(answers, q)).toBe('val')
  })

  it('U5: answers 无对应 key → undefined', () => {
    const q: AskUserQuestion = { header: 'x', question: 'q' }
    expect(getAskUserAnswer({}, q)).toBeUndefined()
  })

  it('U5: getAskUserOther 提取 Other 自由文本', () => {
    const q: AskUserQuestion = { header: 'db', question: 'q' }
    const answers = { db: 'pg', 'db__other': '自定义理由' }
    expect(getAskUserOther(answers, q)).toBe('自定义理由')
  })

  it('U5: Other 缺失 → undefined', () => {
    const q: AskUserQuestion = { header: 'db', question: 'q' }
    expect(getAskUserOther({ db: 'pg' }, q)).toBeUndefined()
  })

  it('U5: 多选 JSON.parse 成功但非数组 → 降级返回 [raw]', () => {
    const q: AskUserQuestion = { header: 'x', question: 'q', multiSelect: true }
    // 合法 JSON 但不是数组（如纯字符串）
    const answers = { x: '"just-a-string"' }
    expect(getAskUserAnswer(answers, q)).toEqual(['"just-a-string"'])
  })
})

describe('isAskUserQuestion 类型守卫', () => {
  it('合法 AskUserQuestion → true', () => {
    expect(isAskUserQuestion({ question: 'q?' })).toBe(true)
    expect(isAskUserQuestion({ header: 'h', question: 'q?', options: [] })).toBe(true)
    expect(isAskUserQuestion({ question: 'q?', multiSelect: true, allowOther: false })).toBe(true)
  })

  it('缺 question 必填字段 → false', () => {
    expect(isAskUserQuestion({ header: 'h' })).toBe(false)
    expect(isAskUserQuestion({ options: [] })).toBe(false)
  })

  it('question 非 string → false', () => {
    expect(isAskUserQuestion({ question: 123 })).toBe(false)
  })

  it('null / 非对象 → false', () => {
    expect(isAskUserQuestion(null)).toBe(false)
    expect(isAskUserQuestion(undefined)).toBe(false)
    expect(isAskUserQuestion('string')).toBe(false)
    expect(isAskUserQuestion([])).toBe(false)
  })

  it('options 非数组 → false', () => {
    expect(isAskUserQuestion({ question: 'q?', options: 'not-array' })).toBe(false)
  })
})
