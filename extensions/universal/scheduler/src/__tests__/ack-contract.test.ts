// ack 契约面测试（dev-flow u-foundation 单元）。
//
// 本单元只交付「依赖反转契约面」，不含 ack 业务逻辑，故测试只证明三件事：
//   1. SchedulerBackend 扩面（registerProvider/unregisterProvider/getEntries/isIdle/
//      getCurrentModel）后可被纯对象夹具实现 —— 类型闭合（satisfies 编译期 + 运行期断言）；
//   2. PiSchedulerBackend 对 pi / ctx 的转发与归一语义（含 Iterable 归一、缺字段兜底）；
//   3. ack 契约常量值锚定（防后续单元依赖字符串时不发现改动）。
//
// 不 mock pi：夹具是手写最小假对象；本套件零 FS，不触碰任何真实数据目录。

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { describe, expect, it } from 'vitest'

import { PiSchedulerBackend } from '../backend.js'
import type { SchedulerBackend, SchedulerBackendCtx } from '../backend.js'
import type { SchedulerEntryLike } from '../replay.js'
import {
  ACK_CUSTOM_TYPE,
  ACK_CUSTOM_TYPE_PREFIX,
  type AckAvailability,
  type AckFailureKind,
  type AckState,
  type SchedulerCurrentModel,
  type SchedulerProviderOverride,
} from '../types.js'

// ── 1. 扩面可被纯对象夹具实现（类型闭合）──

/**
 * 纯对象夹具：只实现既有 4 方法 + 本次新增 5 方法。
 * `satisfies SchedulerBackend` 是契约闭合的编译期证据——接口少一个方法或签名不匹配即红。
 */
function createFixtureBackend(): SchedulerBackend {
  const entries: SchedulerEntryLike[] = [{ type: 'custom', customType: 'fixture', data: {} }]
  const providers = new Map<string, SchedulerProviderOverride>()
  const model: SchedulerCurrentModel = { provider: 'prov', api: 'anthropic-messages', id: 'model-x' }
  return {
    async sendMessage() {},
    appendEntry() {},
    getSessionFile() {
      return '/fixture/session.json'
    },
    now() {
      return 42
    },
    registerProvider(providerId, config) {
      providers.set(providerId, config)
    },
    unregisterProvider(providerId) {
      providers.delete(providerId)
    },
    getEntries() {
      return entries
    },
    isIdle() {
      return true
    },
    getCurrentModel() {
      return model
    },
  } satisfies SchedulerBackend
}

describe('SchedulerBackend ack 扩面（纯对象夹具）', () => {
  it('夹具实现既有 + 新增全部方法且类型闭合', () => {
    const backend = createFixtureBackend()

    expect(backend.getEntries()).toHaveLength(1)
    expect(backend.isIdle()).toBe(true)
    expect(backend.getCurrentModel()).toEqual({ provider: 'prov', api: 'anthropic-messages', id: 'model-x' })
    expect(backend.now()).toBe(42)
    expect(backend.getSessionFile()).toBe('/fixture/session.json')

    // 新面可调用（夹具不抛）：覆写注册/注销是 ack 编排的基础面。
    backend.registerProvider('prov', { api: 'openai-completions' })
    backend.unregisterProvider('prov')
  })
})

// ── 2. PiSchedulerBackend 转发 / 归一 / 兜底 ──

/** 最小假 pi 的记录面。 */
interface FakePi {
  pi: Pick<
    ExtensionAPI,
    'sendMessage' | 'appendEntry' | 'registerProvider' | 'unregisterProvider'
  >
  providerCalls: [unknown, unknown][]
  unregisterCalls: unknown[]
}

/**
 * 最小假 pi（不 mock 框架）：只实现 backend 转发所需的 4 面。
 * registerProvider 用 `unknown` 形参 + 可选第二参以兼容 ExtensionAPI 的双重载
 * （(provider: Provider) 与 (name: string, config: ProviderConfig)）——两形参版本无法匹配
 * 单参重载（TS：target signature provides too few arguments），实参仅做记录不做类型消费。
 */
function createFakePi(): FakePi {
  const providerCalls: [unknown, unknown][] = []
  const unregisterCalls: unknown[] = []
  return {
    pi: {
      sendMessage: async () => {},
      appendEntry: () => {},
      registerProvider: (provider: unknown, config?: unknown) => {
        providerCalls.push([provider, config])
      },
      unregisterProvider: (providerId: unknown) => {
        unregisterCalls.push(providerId)
      },
    },
    providerCalls,
    unregisterCalls,
  }
}

describe('PiSchedulerBackend ack 扩面转发', () => {
  it('registerProvider 转发 pi 并零转换透传 (providerId, config)', () => {
    const { pi, providerCalls } = createFakePi()
    const ctx: SchedulerBackendCtx = {
      sessionManager: {
        getEntries: () => [],
        getSessionFile: () => '/s.json',
      },
    }
    const backend = new PiSchedulerBackend(ctx, pi)
    const config: SchedulerProviderOverride = { api: 'anthropic-messages' }

    backend.registerProvider('prov', config)

    expect(providerCalls).toHaveLength(1)
    expect(providerCalls[0]).toEqual(['prov', config])
    // 同一引用透传（无拷贝/重建），保证 streamSimple 等函数字段身份不变。
    expect(providerCalls[0]![1]).toBe(config)
  })

  it('unregisterProvider 转发 pi', () => {
    const { pi, unregisterCalls } = createFakePi()
    const ctx: SchedulerBackendCtx = {
      sessionManager: {
        getEntries: () => [],
        getSessionFile: () => '/s.json',
      },
    }
    const backend = new PiSchedulerBackend(ctx, pi)

    backend.unregisterProvider('prov')

    expect(unregisterCalls).toEqual(['prov'])
  })

  it('getEntries 将 Iterable（Set）输入归一为数组', () => {
    const { pi } = createFakePi()
    const first: SchedulerEntryLike = { type: 'custom', customType: 'a' }
    const second: SchedulerEntryLike = { type: 'message' }
    const ctx: SchedulerBackendCtx = {
      sessionManager: {
        getEntries: () => new Set([first, second]),
        getSessionFile: () => '/s.json',
      },
    }
    const backend = new PiSchedulerBackend(ctx, pi)

    const entries = backend.getEntries()

    expect(Array.isArray(entries)).toBe(true)
    expect(entries).toEqual([first, second])
  })

  it('getEntries 对数组输入原样返回（不复制）', () => {
    const { pi } = createFakePi()
    const entries: SchedulerEntryLike[] = [{ type: 'custom', customType: 'a' }]
    const ctx: SchedulerBackendCtx = {
      sessionManager: {
        getEntries: () => entries,
        getSessionFile: () => '/s.json',
      },
    }
    const backend = new PiSchedulerBackend(ctx, pi)

    expect(backend.getEntries()).toBe(entries)
  })

  it('getSessionFile / isIdle / getCurrentModel 透传 ctx（实时读，非快照）', () => {
    const { pi } = createFakePi()
    const model: SchedulerCurrentModel = { provider: 'prov', api: 'openai-completions', id: 'm-1' }
    let idle = true
    const ctx: SchedulerBackendCtx = {
      sessionManager: {
        getEntries: () => [],
        getSessionFile: () => '/pass.json',
      },
      isIdle: () => idle,
      model,
    }
    const backend = new PiSchedulerBackend(ctx, pi)

    expect(backend.getSessionFile()).toBe('/pass.json')
    expect(backend.isIdle()).toBe(true)
    // 每次调用都读 ctx 实时值（不是构造期快照）——ack 编排依赖的是调用时刻的空闲状态。
    idle = false
    expect(backend.isIdle()).toBe(false)
    expect(backend.getCurrentModel()).toBe(model)
  })

  it('ctx 缺 isIdle / model 时兜底：isIdle=false（fail-safe）、getCurrentModel=undefined', () => {
    const { pi } = createFakePi()
    const ctx: SchedulerBackendCtx = {
      sessionManager: {
        getEntries: () => [],
        getSessionFile: () => undefined,
      },
    }
    const backend = new PiSchedulerBackend(ctx, pi)

    // 缺 isIdle：保守视作「有轮在跑」⇒ ack 不介入（确定性方向 = 不打扰）。
    expect(backend.isIdle()).toBe(false)
    expect(backend.getCurrentModel()).toBeUndefined()
    expect(backend.getSessionFile()).toBeUndefined()
  })
})

// ── 3. ack 契约常量 / 类型锚定 ──

describe('ack 契约常量与类型', () => {
  it('ACK_CUSTOM_TYPE / ACK_CUSTOM_TYPE_PREFIX 值锚定且前缀关系成立', () => {
    expect(ACK_CUSTOM_TYPE).toBe('pi-scheduler-ack:ack')
    expect(ACK_CUSTOM_TYPE_PREFIX).toBe('pi-scheduler-ack:')
    // 武装判别用前缀 startsWith、写入/精确匹配用全串——两者必须同源。
    expect(ACK_CUSTOM_TYPE.startsWith(ACK_CUSTOM_TYPE_PREFIX)).toBe(true)
  })

  it('AckAvailability / AckFailureKind / AckState 判别值可构造', () => {
    const unavailable: AckAvailability[] = [
      { available: false, reason: 'no-base' },
      { available: false, reason: 'toggle-disabled' },
      { available: false, reason: 'check-failed' },
    ]
    expect(unavailable.map(a => (a.available ? 'available' : a.reason))).toEqual([
      'no-base',
      'toggle-disabled',
      'check-failed',
    ])
    expect<AckAvailability>({ available: true }).toEqual({ available: true })

    const failures: AckFailureKind[] = [
      'e1-register',
      'e2-not-hit',
      'e3-no-turn',
      'e4-provider-error',
      'e5-interrupted',
      'e6-unregister',
      'e8-no-base',
      'e8b-hybrid',
    ]
    expect(failures).toHaveLength(8)

    const state: AckState = {
      pending: { taskId: 't1', sentAt: 123 },
      window: { registered: false },
      ackTurnStarted: false,
      writeCheckTimer: null,
    }
    expect(state.pending?.taskId).toBe('t1')
    expect(state.window).toEqual({ registered: false })
  })
})
