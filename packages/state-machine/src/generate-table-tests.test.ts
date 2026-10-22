import { describe, expect, it } from 'vitest'
import { defineStateMachine } from './define'
import { generateTableTests } from './testing'

/**
 * 生成器自身的行为验证（D5）：组合覆盖数 / 期望分布 / ctx 采样注入 / fromEvent
 * 哨兵来源断言。generateTableTests 必须在收集阶段（模块顶层）调用——describe/it
 * 不能在测试回调内注册；下方各机器的穷举组在模块顶层生成并注册，断言用例只
 * 消费返回的 cases 数组，穷举 it 断言（次态、planned、表外行为、不变量）随
 * 本文件执行，红即生成器或被测机器的表级问题。
 */

// ── 覆盖机器（throw 族）：数组 from / null 消亡行 / terminalOutcome 字面量 /
//    guard 互补 / terminal 无出边吸收态 ──

const coverageMachine = defineStateMachine<
  'staging' | 'archived' | 'restoring' | 'dead',
  'compress_done' | 'unarchive' | 'restore_done' | 'purge',
  { fast?: boolean }
>({
  name: 'coverage',
  states: { staging: {}, archived: {}, restoring: {}, dead: { terminal: true } },
  initial: 'staging',
  events: { compress_done: {}, unarchive: {}, restore_done: {}, purge: {} },
  transitions: [
    { from: 'staging', on: 'compress_done', to: 'archived', outputs: ['rewriteLedger', 'broadcastCount'] },
    { from: ['staging', 'archived'], on: 'unarchive', to: 'restoring', outputs: ['markRestoring'] },
    { from: 'restoring', on: 'restore_done', to: null },
    { from: 'restoring', on: 'purge', to: null, outputs: ['trashMain'] },
    { from: 'staging', on: 'purge', to: 'archived', terminalOutcome: 'cancelled', guard: (ctx) => ctx?.fast === true },
    { from: 'staging', on: 'purge', to: 'restoring', guard: (ctx) => ctx?.fast !== true },
  ],
  errorPolicy: 'throw',
})

const coverageCases = generateTableTests(coverageMachine)

// ── fromEvent 终局载荷来源（哨兵注入断言在生成器内部） ──

const outcomeMachine = defineStateMachine<'running' | 'terminal', 'run-settled'>({
  name: 'outcome',
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

const outcomeCases = generateTableTests(outcomeMachine)

// ── result 族机器的表外断言形态 ──

const resultMachine = defineStateMachine({
  name: 'result-coverage',
  states: { planning: {}, reviewing: {} },
  initial: 'planning',
  events: { submit: {}, dismiss: {} },
  transitions: [
    { from: 'planning', on: 'submit', to: 'reviewing' },
    { from: 'reviewing', on: 'dismiss', to: 'planning' },
  ],
  errorPolicy: 'result',
})

const resultCases = generateTableTests(resultMachine)

// ── ctx 采样注入位（D5：guard 行为组合骨架） ──

const sampledCases = generateTableTests(coverageMachine, {
  describeName: '状态机表穷举：coverage × ctx 采样',
  ctxSamples: [{ fast: true }, { fast: false }],
})

// ── 多命中组合暴露表 bug（guard 互斥性破坏 → invariant-broken 期望） ──

const brokenMachine = defineStateMachine({
  name: 'broken',
  states: { a: {}, b: {} },
  initial: 'a',
  events: { e: {} },
  transitions: [
    { from: 'a', on: 'e', to: 'b', guard: () => true },
    { from: 'a', on: 'e', to: 'b', guard: () => true },
  ],
  errorPolicy: 'throw',
})

const brokenCases = generateTableTests(brokenMachine)

describe('generateTableTests 组合覆盖', () => {
  it('全状态 × 全事件生成完整组合（4 × 4 = 16），期望分布与表一致', () => {
    expect(coverageCases).toHaveLength(16)
    expect(coverageCases.filter((c) => c.expectation === 'transition')).toHaveLength(6)
    expect(coverageCases.filter((c) => c.expectation === 'rejected')).toHaveLength(10)
    expect(coverageCases.filter((c) => c.expectation === 'invariant-broken')).toHaveLength(0)
    // terminal 无出边态（dead）全部事件被拒（run 吸收形态）
    for (const c of coverageCases.filter((c) => c.state === 'dead')) {
      expect(c.expectation).toBe('rejected')
    }
  })
})

describe('generateTableTests fromEvent 行', () => {
  it('fromEvent 组合生成且命中行按 transition 期望走', () => {
    expect(outcomeCases).toHaveLength(2)
    expect(outcomeCases.find((c) => c.state === 'running')?.expectation).toBe('transition')
    expect(outcomeCases.find((c) => c.state === 'terminal')?.expectation).toBe('rejected')
  })
})

describe('generateTableTests result 族', () => {
  it('表外组合按 rejected 期望生成（断言形态在生成器内部走 ok:false 分支）', () => {
    expect(resultCases).toHaveLength(4)
    expect(resultCases.filter((c) => c.expectation === 'transition')).toHaveLength(2)
    expect(resultCases.filter((c) => c.expectation === 'rejected')).toHaveLength(2)
  })
})

describe('generateTableTests ctxSamples', () => {
  it('每个采样生成一组组合（4 × 4 × 2 = 32），互补 guard 在采样上各自单命中', () => {
    expect(sampledCases).toHaveLength(32)
    const purgeCases = sampledCases.filter((c) => c.state === 'staging' && c.event === 'purge')
    expect(purgeCases).toHaveLength(2)
    // fast:true 落 terminalOutcome 支、fast:false 落互补支——两采样都单命中（transition）
    expect(purgeCases.every((c) => c.expectation === 'transition')).toBe(true)
    expect(sampledCases.filter((c) => c.expectation === 'invariant-broken')).toHaveLength(0)
  })
})

describe('generateTableTests 多命中暴露', () => {
  it('guard 全真二行的组合生成 invariant-broken 期望（断言走 throw 不变量分支）', () => {
    expect(brokenCases.find((c) => c.state === 'a')?.expectation).toBe('invariant-broken')
    expect(brokenCases.find((c) => c.state === 'b')?.expectation).toBe('rejected')
  })
})
