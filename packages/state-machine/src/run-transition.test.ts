import { describe, expect, it } from 'vitest'
import { defineStateMachine } from './define'
import { IllegalTransitionError } from './illegal'
import { MissingActionError, runTransition } from './run-transition'
import type { ActionContext } from './run-transition'

/** 归档单元形态样例机器（V8 场景载体）：planned 三项的转移 + 带动作的消亡行。 */
const archiveMachine = defineStateMachine<
  'staging' | 'archived' | 'restoring',
  'compress_done' | 'restore_done',
  { fast?: boolean }
>({
  name: 'arch-shell',
  states: { staging: {}, archived: {}, restoring: {} },
  initial: 'staging',
  events: { compress_done: {}, restore_done: {} },
  transitions: [
    {
      from: 'staging',
      on: 'compress_done',
      to: 'archived',
      outputs: ['rewriteLedger', 'broadcastCount', 'touchStamp'],
    },
    { from: 'restoring', on: 'restore_done', to: null, outputs: ['cleanup'] },
  ],
  errorPolicy: 'throw',
})

const resultMachine = defineStateMachine({
  name: 'result-shell',
  states: { planning: {}, reviewing: {} },
  initial: 'planning',
  events: { submit: {}, dismiss: {} },
  transitions: [
    { from: 'planning', on: 'submit', to: 'reviewing', outputs: ['persist'] },
    { from: 'reviewing', on: 'dismiss', to: 'planning' },
  ],
  errorPolicy: 'result',
})

describe('runTransition 成功路径', () => {
  it('全部动作成功 → { ok: true, state }（无 planned 等多余成员），按 outputs 行声明序执行', () => {
    const calls: string[] = []
    const r = runTransition(archiveMachine, 'staging', 'compress_done', {
      actions: {
        rewriteLedger: () => {
          calls.push('rewriteLedger')
        },
        broadcastCount: () => {
          calls.push('broadcastCount')
        },
        touchStamp: () => {
          calls.push('touchStamp')
        },
      },
    })
    expect(r).toEqual({ ok: true, state: 'archived' })
    expect(calls).toEqual(['rewriteLedger', 'broadcastCount', 'touchStamp'])
  })

  it('执行上下文 c 成员恰为 { machine, event, from, to }——不透传 ctx/实体字段', () => {
    const seen: ActionContext<'staging' | 'archived' | 'restoring', 'compress_done' | 'restore_done'>[] = []
    runTransition(archiveMachine, 'staging', { type: 'compress_done', size: 42 }, {
      ctx: { fast: true }, // ctx 喂 guard 裁决，但不得泄漏进 c
      actions: {
        rewriteLedger: (c) => {
          seen.push(c)
        },
        broadcastCount: () => {},
        touchStamp: () => {},
      },
    })
    expect(seen).toEqual([
      {
        machine: 'arch-shell',
        event: { type: 'compress_done', size: 42 },
        from: 'staging',
        to: 'archived',
      },
    ])
  })

  it('消亡行（to: null）成功 → state 为 null，c.to 同为 null', () => {
    const seen: (ActionContext<'staging' | 'archived' | 'restoring', 'compress_done' | 'restore_done'> | undefined)[] = []
    const r = runTransition(archiveMachine, 'restoring', 'restore_done', {
      actions: {
        cleanup: (c) => {
          seen[0] = c
        },
      },
    })
    expect(r).toEqual({ ok: true, state: null })
    expect(seen[0]?.to).toBeNull()
    expect(seen[0]?.from).toBe('restoring')
  })

  it('无 outputs 的转移可缺省 actions（options 整体缺省）→ 直接 ok:true', () => {
    const r = runTransition(resultMachine, 'reviewing', 'dismiss')
    expect(r).toEqual({ ok: true, state: 'planning' })
  })

  it('options.ctx 透传 guard 裁决（分支选择生效，且不进动作上下文）', () => {
    const guardMachine = defineStateMachine<'a' | 'b' | 'c', 'e', { fast?: boolean }>({
      name: 'guard-shell',
      states: { a: {}, b: {}, c: {} },
      initial: 'a',
      events: { e: {} },
      transitions: [
        { from: 'a', on: 'e', to: 'b', guard: (ctx) => ctx?.fast === true, outputs: ['act'] },
        { from: 'a', on: 'e', to: 'c', guard: (ctx) => ctx?.fast !== true, outputs: ['act'] },
      ],
      errorPolicy: 'throw',
    })
    const fast = runTransition(guardMachine, 'a', 'e', { ctx: { fast: true }, actions: { act: () => {} } })
    expect(fast).toEqual({ ok: true, state: 'b' })
    const slow = runTransition(guardMachine, 'a', 'e', { ctx: { fast: false }, actions: { act: () => {} } })
    expect(slow).toEqual({ ok: true, state: 'c' })
  })
})

describe('runTransition 事务性（V8）', () => {
  it('第二项抛错 → 首项已执行、后续项不执行、上抛第一个错误、次态不应用（宿主当前态不变）', () => {
    const calls: string[] = []
    const boom = new Error('broadcast failed')
    const never = new Error('must-not-execute')
    // 外壳无状态槽：次态应用 = 宿主成功后写回——失败路径宿主不写回，当前态不变
    let current: string = 'staging'
    let caught: unknown = 'no-throw'
    try {
      const r = runTransition(archiveMachine, 'staging', 'compress_done', {
        actions: {
          rewriteLedger: () => {
            calls.push('rewriteLedger')
          },
          broadcastCount: () => {
            throw boom
          },
          touchStamp: () => {
            throw never
          },
        },
      })
      current = r.state ?? '<消亡>'
    } catch (e) {
      caught = e
    }
    expect(caught).toBe(boom) // 第一个错误（第二项的），非第三项的
    expect(calls).toEqual(['rewriteLedger']) // 首项已执行、第三项未执行
    expect(current).toBe('staging') // 次态未应用、当前态不变
  })
})

describe('runTransition missing-action（V9）', () => {
  it('outputs 引用未注入动作 → 立即抛 MissingActionError，任何 planned 项不执行', () => {
    const calls: string[] = []
    let caught: unknown = 'no-throw'
    try {
      runTransition(archiveMachine, 'staging', 'compress_done', {
        actions: {
          // rewriteLedger 已注入：预检在执行前失败，它也必须零执行
          rewriteLedger: () => {
            calls.push('rewriteLedger')
          },
          // broadcastCount / touchStamp 未注入
        },
      })
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(MissingActionError)
    const err = caught as MissingActionError
    expect(err.machine).toBe('arch-shell')
    expect(err.action).toBe('broadcastCount')
    expect(err.available).toEqual(['rewriteLedger'])
    expect(err.message).toContain('动作未注入[arch-shell]')
    expect(err.message).toContain("'broadcastCount'")
    expect(calls).toEqual([]) // 零 planned 执行
  })

  it('原型链键名（toString 等）不误判为已注入——hasOwnProperty 判定', () => {
    const protoMachine = defineStateMachine<'a' | 'b', 'e'>({
      name: 'proto-shell',
      states: { a: {}, b: {} },
      initial: 'a',
      events: { e: {} },
      transitions: [{ from: 'a', on: 'e', to: 'b', outputs: ['toString'] }],
      errorPolicy: 'throw',
    })
    expect(() => runTransition(protoMachine, 'a', 'e', {})).toThrow(MissingActionError)
  })
})

describe('runTransition 表外处置透传', () => {
  it('throw 机器表外 → 内核 IllegalTransitionError 原样上抛（外壳不吞不包装）', () => {
    expect(() => runTransition(archiveMachine, 'archived', 'compress_done', {})).toThrow(
      IllegalTransitionError,
    )
  })

  it('result 机器表外 → 透传 { ok: false, reason }，不抛、零 planned 执行', () => {
    const calls: string[] = []
    const r = runTransition(resultMachine, 'reviewing', 'submit', {
      actions: {
        persist: () => {
          calls.push('persist')
        },
      },
    })
    expect(r).toEqual({ ok: false, reason: 'illegal-transition' })
    expect(calls).toEqual([])
  })

  it('result 机器合法行照常走事务执行 → ok:true', () => {
    const calls: string[] = []
    const r = runTransition(resultMachine, 'planning', 'submit', {
      actions: {
        persist: () => {
          calls.push('persist')
        },
      },
    })
    expect(r).toEqual({ ok: true, state: 'reviewing' })
    expect(calls).toEqual(['persist'])
  })
})

describe('runTransition 同步外壳契约', () => {
  it('动作返回 Promise → fail-fast throw，后续 planned 项不执行', () => {
    const calls: string[] = []
    let caught: unknown = 'no-throw'
    try {
      runTransition(archiveMachine, 'staging', 'compress_done', {
        actions: {
          rewriteLedger: () => {
            calls.push('rewriteLedger')
            return Promise.resolve('async-副作用')
          },
          broadcastCount: () => {
            calls.push('broadcastCount')
          },
          touchStamp: () => {},
        },
      })
    } catch (e) {
      caught = e
    }
    expect((caught as Error).message).toMatch(/同步事务外壳/)
    expect(calls).toEqual(['rewriteLedger']) // 异步动作本身已执行，后续项被中止
  })
})
