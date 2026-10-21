import { describe, expect, it } from 'vitest'
import { defineStateMachine } from './define'
import type { StateMachineDefinition } from './types'

/** 词表外字面量绕过类型层的测试形态：断言成词表内成员、运行时传越界值。 */
const asState = (v: string) => v as 'staging'
const asEvent = (v: string) => v as 'compress_done'

function baseDefinition(): StateMachineDefinition<
  'staging' | 'archived' | 'restoring',
  'compress_done' | 'revive'
> & { errorPolicy: 'throw' } {
  return {
    name: 'self-check-machine',
    states: { staging: {}, archived: { terminal: true }, restoring: {} },
    initial: 'staging',
    events: { compress_done: {}, revive: {} },
    transitions: [{ from: 'staging', on: 'compress_done', to: 'archived' }],
    errorPolicy: 'throw',
  }
}

describe('defineStateMachine 定义期自检（V2）', () => {
  it('合法声明定义成功，词表/terminal 集正确', () => {
    const machine = defineStateMachine(baseDefinition())
    expect(machine.name).toBe('self-check-machine')
    expect(machine.states).toEqual(['staging', 'archived', 'restoring'])
    expect(machine.events).toEqual(['compress_done', 'revive'])
    expect(machine.terminalStates).toEqual(['archived'])
  })

  it('from 不在状态词表内 → 定义时 throw，消息指出具体行', () => {
    const def = baseDefinition()
    def.transitions = [{ from: asState('bogus'), on: 'compress_done', to: 'archived' }]
    expect(() => defineStateMachine(def)).toThrow(/第 0 行 from 'bogus' 不在状态词表 \[staging, archived, restoring\] 内/)
  })

  it('from 数组内含词表外成员 → 定义时 throw', () => {
    const def = baseDefinition()
    def.transitions = [{ from: ['staging', asState('nope')], on: 'compress_done', to: 'archived' }]
    expect(() => defineStateMachine(def)).toThrow(/from 'nope' 不在状态词表/)
  })

  it('to 不在状态词表内 → 定义时 throw', () => {
    const def = baseDefinition()
    def.transitions = [{ from: 'staging', on: 'compress_done', to: asState('bogus') }]
    expect(() => defineStateMachine(def)).toThrow(/第 0 行 to 'bogus' 不在状态词表/)
  })

  it('to: null 是合法实体消亡行，不触发词表自检', () => {
    const def = baseDefinition()
    def.transitions = [{ from: 'staging', on: 'compress_done', to: null }]
    expect(() => defineStateMachine(def)).not.toThrow()
  })

  it('on 不在事件词表内 → 定义时 throw', () => {
    const def = baseDefinition()
    def.transitions = [{ from: 'staging', on: asEvent('unknown_evt'), to: 'archived' }]
    expect(() => defineStateMachine(def)).toThrow(/第 0 行 on 'unknown_evt' 不在事件词表 \[compress_done, revive\] 内/)
  })

  it('同 (from, on) 两行且其中一行无 guard → 定义时 throw（无 guard 垫底行恒命中）', () => {
    const def = baseDefinition()
    def.transitions = [
      { from: 'staging', on: 'compress_done', to: 'restoring', guard: () => true },
      { from: 'staging', on: 'compress_done', to: 'archived' },
    ]
    expect(() => defineStateMachine(def)).toThrow(
      /\(from=staging, on=compress_done\) 存在 2 行，其中第 1 行无 guard/,
    )
  })

  it('from 数组与单态行构成同 (from, on) 组且组内混入无 guard 行 → 定义时 throw', () => {
    const def = baseDefinition()
    def.transitions = [
      { from: ['staging', 'restoring'], on: 'compress_done', to: 'archived' },
      { from: 'staging', on: 'compress_done', to: 'restoring', guard: () => true },
    ]
    expect(() => defineStateMachine(def)).toThrow(/\(from=staging, on=compress_done\) 存在 2 行，其中第 0 行无 guard/)
  })

  it('同 (from, on) 多行全部带 guard → 定义成功（互斥性运行时才可判，非定义期错误）', () => {
    const def = baseDefinition()
    def.transitions = [
      { from: 'staging', on: 'compress_done', to: 'archived', guard: (ctx?: { go?: boolean }) => ctx?.go === true },
      { from: 'staging', on: 'compress_done', to: 'restoring', guard: (ctx?: { go?: boolean }) => ctx?.go !== true },
    ]
    expect(() => defineStateMachine(def)).not.toThrow()
  })

  it('terminal 态带出边不设自检限制（plan 可重启终态形态，V2 钦点）', () => {
    const def = baseDefinition()
    def.events = { compress_done: {}, revive: {} }
    def.transitions = [
      { from: 'staging', on: 'compress_done', to: 'archived' },
      { from: 'archived', on: 'revive', to: 'staging' },
    ]
    expect(() => defineStateMachine(def)).not.toThrow()
    const machine = defineStateMachine(def)
    expect(machine.terminalStates).toEqual(['archived'])
  })
})
