import { describe, expect, it } from 'vitest'
import { defineStateMachine } from './define'
import { IllegalTransitionError } from './illegal'

/** 覆盖多形态的样例机器（throw 族）：数组 from / null 消亡行 / terminalOutcome
 * 两种来源 / guard 互补二支 / 表外组合。 */
const throwMachine = defineStateMachine<'staging' | 'archived' | 'restoring', 'compress_done' | 'unarchive' | 'restore_done' | 'purge', { fast?: boolean }>(
  {
    name: 'throw-machine',
    states: { staging: {}, archived: {}, restoring: {} },
    initial: 'staging',
    events: { compress_done: {}, unarchive: {}, restore_done: {}, purge: {} },
    transitions: [
      {
        from: 'staging',
        on: 'compress_done',
        to: 'archived',
        outputs: ['rewriteLedger', 'broadcastCount'],
      },
      { from: ['staging', 'archived'], on: 'unarchive', to: 'restoring', outputs: ['markRestoring'] },
      { from: 'restoring', on: 'restore_done', to: null },
      { from: 'restoring', on: 'purge', to: null, outputs: ['trashMain'] },
      {
        from: 'staging',
        on: 'purge',
        to: 'archived',
        terminalOutcome: 'cancelled',
        guard: (ctx) => ctx?.fast === true,
      },
      { from: 'staging', on: 'purge', to: 'restoring', guard: (ctx) => ctx?.fast !== true },
    ],
    errorPolicy: 'throw',
  },
)

describe('transition 纯函数内核', () => {
  it('合法行返回次态与 planned（outputs 行声明序）', () => {
    const r = throwMachine.transition('staging', 'compress_done')
    expect(r).toEqual({
      ok: true,
      state: 'archived',
      planned: { outputs: ['rewriteLedger', 'broadcastCount'] },
    })
  })

  it('无 outputs 的行 planned 为空名单', () => {
    const r = throwMachine.transition('restoring', 'restore_done')
    expect(r.state).toBeNull()
    expect(r.planned.outputs).toEqual([])
  })

  it('from 数组行对每个成员态命中', () => {
    expect(throwMachine.transition('staging', 'unarchive').state).toBe('restoring')
    expect(throwMachine.transition('archived', 'unarchive').state).toBe('restoring')
  })

  it('to: null 实体消亡——state === null 且 planned 只含行级 outputs', () => {
    const r = throwMachine.transition('restoring', 'purge')
    expect(r.state).toBeNull()
    expect(r.planned.outputs).toEqual(['trashMain'])
  })

  it('terminalOutcome 字面量行返回固定终局值', () => {
    const r = throwMachine.transition('staging', 'purge', { fast: true })
    expect(r.state).toBe('archived')
    expect(r.terminalOutcome).toBe('cancelled')
  })

  it('guard 互补二支按 ctx 单命中（run 二支形态直译）', () => {
    expect(throwMachine.transition('staging', 'purge', { fast: true }).state).toBe('archived')
    expect(throwMachine.transition('staging', 'purge', { fast: false }).state).toBe('restoring')
    // undefined ctx 取支由 guard 自行决定：fast !== true 支
    expect(throwMachine.transition('staging', 'purge').state).toBe('restoring')
  })

  it('guard 全不命中 → 表外处置（同 errorPolicy）', () => {
    const m = defineStateMachine({
      name: 'no-hit',
      states: { a: {}, b: {} },
      initial: 'a',
      events: { e: {} },
      transitions: [
        { from: 'a', on: 'e', to: 'b', guard: () => false },
        { from: 'a', on: 'e', to: 'b', guard: () => false },
      ],
      errorPolicy: 'throw',
    })
    expect(() => m.transition('a', 'e')).toThrow(IllegalTransitionError)
  })

  it('guard 多命中 → 转移表不变量破坏 throw（非 errorPolicy 可配）', () => {
    const m = defineStateMachine({
      name: 'multi-hit',
      states: { a: {}, b: {}, c: {} },
      initial: 'a',
      events: { e: {} },
      transitions: [
        { from: 'a', on: 'e', to: 'b', guard: () => true },
        { from: 'a', on: 'e', to: 'c', guard: () => true },
      ],
      errorPolicy: 'result',
    })
    expect(() => m.transition('a', 'e')).toThrow(/不变量破坏.*命中 2 条规则/)
  })

  it('事件对象形态 { type } 与字符串事件名等价触发', () => {
    expect(throwMachine.transition('staging', { type: 'compress_done' }).state).toBe('archived')
  })

  it('guard 收到 (ctx, event) 双参——event 为调用方原始事件值', () => {
    let seenEvent: unknown = 'unset'
    const m = defineStateMachine<'a' | 'b', 'e'>({
      name: 'guard-args',
      states: { a: {}, b: {} },
      initial: 'a',
      events: { e: {} },
      transitions: [
        {
          from: 'a',
          on: 'e',
          to: 'b',
          guard: (_ctx, event) => {
            seenEvent = event
            return true
          },
        },
      ],
      errorPolicy: 'throw',
    })
    m.transition('a', { type: 'e', payload: 42 })
    expect(seenEvent).toEqual({ type: 'e', payload: 42 })
  })
})

describe('errorPolicy: throw 表外处置', () => {
  it('默认抛 IllegalTransitionError，消息含当前态/事件/该态合法事件清单', () => {
    let caught: unknown
    try {
      throwMachine.transition('archived', 'compress_done')
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(IllegalTransitionError)
    const err = caught as IllegalTransitionError
    expect(err.name).toBe('IllegalTransitionError')
    expect(err.from).toBe('archived')
    expect(err.on).toBe('compress_done')
    expect(err.message).toContain('[throw-machine]')
    expect(err.message).toContain('该态合法事件：unarchive')
  })

  it('词表外 state 输入按表外处置拒绝，detail 指向 coerceState 归化', () => {
    expect(() => throwMachine.transition('garbage-from-disk' as 'staging', 'compress_done')).toThrow(
      /state 不在状态词表内.*coerceState/,
    )
  })

  it('errorFactory 保形既有错误类型（instanceof 分类分支仍命中）', () => {
    class ArchiveDomainError extends Error {
      constructor(readonly code: string) {
        super(`archive domain error: ${code}`)
      }
    }
    const m = defineStateMachine({
      name: 'custom-error',
      states: { a: {}, b: {} },
      initial: 'a',
      events: { e: {} },
      transitions: [{ from: 'a', on: 'e', to: 'b' }],
      errorPolicy: 'throw',
      errorFactory: (info) => new ArchiveDomainError(`illegal:${info.from}:${info.on}`),
    })
    expect(() => m.transition('b', 'e')).toThrow(ArchiveDomainError)
    try {
      m.transition('b', 'e')
    } catch (e) {
      expect(e).toBeInstanceOf(ArchiveDomainError)
      expect((e as ArchiveDomainError).code).toBe('illegal:b:e')
    }
  })
})

describe('errorPolicy: result 表外处置（plan「不炸 turn」契约）', () => {
  const resultMachine = defineStateMachine({
    name: 'result-machine',
    states: { planning: {}, reviewing: {} },
    initial: 'planning',
    events: { submit: {}, dismiss: {} },
    transitions: [
      { from: 'planning', on: 'submit', to: 'reviewing' },
      { from: 'reviewing', on: 'dismiss', to: 'planning' },
    ],
    errorPolicy: 'result',
  })

  it('表外返回精确 { ok: false, reason } 形态，不携带次态键', () => {
    expect(resultMachine.transition('reviewing', 'submit')).toEqual({
      ok: false,
      reason: 'illegal-transition',
    })
    expect('state' in (resultMachine.transition('reviewing', 'submit') as object)).toBe(false)
  })

  it('合法行照常返回 ok: true（result 机器只有表外走拒绝分支）', () => {
    expect(resultMachine.transition('planning', 'submit')).toEqual({
      ok: true,
      state: 'reviewing',
      planned: { outputs: [] },
    })
  })

  it('词表外 state 输入同样返回 ok: false（磁盘坏值不炸调用方）', () => {
    expect(resultMachine.transition('garbage' as 'planning', 'submit')).toEqual({
      ok: false,
      reason: 'illegal-transition',
    })
  })
})

describe('terminalOutcome fromEvent 载荷来源', () => {
  const settleMachine = defineStateMachine<'running' | 'terminal', 'run-settled'>({
    name: 'outcome-machine',
    states: { running: {}, terminal: { terminal: true } },
    initial: 'running',
    events: { 'run-settled': {} },
    transitions: [
      {
        from: 'running',
        on: 'run-settled',
        to: 'terminal',
        terminalOutcome: { fromEvent: 'outcome' },
        outputs: ['journal-append'],
      },
    ],
    errorPolicy: 'throw',
  })

  it('从事件载荷字段取终局值（run 域 run-settled 直译）', () => {
    const r = settleMachine.transition('running', { type: 'run-settled', outcome: 'completed' })
    expect(r.state).toBe('terminal')
    expect(r.terminalOutcome).toBe('completed')
  })

  it('纯事件名触发 fromEvent 行 → 转移表不变量破坏 throw（fail-fast 指向修表/改传事件对象）', () => {
    expect(() => settleMachine.transition('running', 'run-settled')).toThrow(
      /terminalOutcome\.fromEvent='outcome' 但触发事件是纯事件名/,
    )
  })

  it('事件载荷缺失 fromEvent 指向的字段 → 不变量破坏 throw', () => {
    expect(() => settleMachine.transition('running', { type: 'run-settled' })).toThrow(
      /事件载荷缺失 terminalOutcome\.fromEvent 指向的字段 'outcome'/,
    )
  })
})
