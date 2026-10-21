import { describe, expect, it } from 'vitest'
import { defineStateMachine } from './define'

const machine = defineStateMachine<'staging' | 'archived' | 'restoring', 'done'>({
  name: 'coerce-machine',
  states: { staging: {}, archived: {}, restoring: {} },
  initial: 'staging',
  events: { done: {} },
  transitions: [{ from: 'staging', on: 'done', to: 'archived' }],
  errorPolicy: 'throw',
})

describe('coerceState 词表外输入防护（V10）', () => {
  it('词表内合法值原样返回', () => {
    expect(machine.coerceState('staging')).toBe('staging')
    expect(machine.coerceState('archived')).toBe('archived')
    expect(machine.coerceState('restoring')).toBe('restoring')
  })

  it('词表外坏值一律返回 null', () => {
    expect(machine.coerceState('Archived')).toBeNull()
    expect(machine.coerceState('staging ')).toBeNull()
    expect(machine.coerceState('unknown-state')).toBeNull()
    expect(machine.coerceState('')).toBeNull()
  })

  it('原型链键返回 null（枚举 includes 白名单判定，非裸对象查表——吸收 plan 先例）', () => {
    expect(machine.coerceState('__proto__')).toBeNull()
    expect(machine.coerceState('constructor')).toBeNull()
    expect(machine.coerceState('toString')).toBeNull()
    expect(machine.coerceState('valueOf')).toBeNull()
    expect(machine.coerceState('hasOwnProperty')).toBeNull()
  })

  it('非字符串输入返回 null', () => {
    expect(machine.coerceState(0)).toBeNull()
    expect(machine.coerceState(null)).toBeNull()
    expect(machine.coerceState(undefined)).toBeNull()
    expect(machine.coerceState(true)).toBeNull()
    expect(machine.coerceState({ lifecycle: 'staging' })).toBeNull()
    expect(machine.coerceState(['staging'])).toBeNull()
  })
})
