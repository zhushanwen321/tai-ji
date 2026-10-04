import { describe, it, expect } from 'vitest'
import {
  getAskUserAnswer,
  getAskUserOther,
  isAskUserQuestion,
  ASK_USER_MARKER,
  type AskUserQuestion,
} from '../../index'

// ── ask-user 解码契约（askUserInteract 已随统一表单协议退役——GUI 提问走 ui-form
//    模块 uiFormInteract；本文件覆盖保留物：marker 常量 + answers 解码 helper + 守卫）──

describe('ASK_USER_MARKER（legacy 帧识别，随 D7 窗口末清理）', () => {
  it('U4: 常量值正确（NUL 前缀）', () => {
    expect(ASK_USER_MARKER).toBe('\x00TAIJI_ASK_USER')
    expect(ASK_USER_MARKER.startsWith('\x00')).toBe(true)
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
