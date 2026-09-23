// ack 合成流 + 可用性判据测试（dev-flow u-ack-provider 单元）。
//
// 本单元只交付三件事的纯函数面：
//   1. buildAckStreamSimple —— 零 token 合成流（字段 = 会话真实模型 / usage 全 0 /
//      aborted 走 error 终止 / onCalled 返回前同步自撤）；
//   2. computeAckAvailability —— 预计算 + fail-closed 的可用性判据（内置含 radius）；
//   3. loadModelsJsonProviderIds —— models.json 的 provider id 集合解析。
//
// 注册/注销/单窗口令牌（ackWindow）与编排属 u-ack-turn，不在本套件范围。
// 本套件只用 tmpdir 临时文件，不触碰任何真实数据目录。

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Api, AssistantMessage, Context, Model } from '@earendil-works/pi-ai'
import { describe, expect, it, vi } from 'vitest'

import {
  buildAckStreamSimple,
  computeAckAvailability,
  loadModelsJsonProviderIds,
  type AckStreamDeps,
} from '../ack-provider.js'
import type { SchedulerCurrentModel, SchedulerProviderOverride } from '../types.js'

// ── 夹具 ──

/** 会话当前模型（deps.model）：三字段直接落到合成消息上。 */
const SESSION_MODEL: SchedulerCurrentModel = {
  provider: 'anthropic',
  api: 'anthropic-messages',
  id: 'claude-x',
}

/** 传给 streamSimple 的实参模型（工厂忽略它——字段来源是 deps.model，不是实参）。 */
const CALL_MODEL: Model<Api> = {
  id: 'call-model',
  name: 'call-model',
  api: 'anthropic-messages',
  provider: 'anthropic',
  baseUrl: 'https://example.invalid',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1000,
  maxTokens: 100,
}

const CALL_CONTEXT: Context = { messages: [] }

/**
 * 取非可选形态的 streamSimple：`SchedulerProviderOverride['streamSimple']` 是可选联合，
 * 调用前用运行时 guard 收窄（不用 as 断言绕过类型检查）。
 */
function requireStreamFn(
  deps: AckStreamDeps,
): NonNullable<SchedulerProviderOverride['streamSimple']> {
  const fn = buildAckStreamSimple(deps)
  if (!fn) throw new Error('buildAckStreamSimple 未返回 streamSimple')
  return fn
}

// ── 1. 合成流字段逐项 ──

describe('buildAckStreamSimple 合成消息字段', () => {
  it('provider/model/api 等于会话模型；usage 全 0；stopReason=aborted；正文=传入 text', async () => {
    const text = '已创建任务 t1'
    const stream = requireStreamFn({ model: SESSION_MODEL, text })(CALL_MODEL, CALL_CONTEXT)

    const final: AssistantMessage = await stream.result()

    // I5：合成行字段必须等于会话真实模型，否则 pi 恢复时静默换模型。
    expect(final.role).toBe('assistant')
    expect(final.provider).toBe(SESSION_MODEL.provider)
    expect(final.model).toBe(SESSION_MODEL.id)
    expect(final.api).toBe(SESSION_MODEL.api)
    expect(final.stopReason).toBe('aborted')
    expect(typeof final.timestamp).toBe('number')

    // usage 全 0（含 cost）：非 0 会污染 taiji 的 context 统计。
    expect(final.usage.totalTokens).toBe(0)
    expect(final.usage.input).toBe(0)
    expect(final.usage.output).toBe(0)
    expect(final.usage.cacheRead).toBe(0)
    expect(final.usage.cacheWrite).toBe(0)
    expect(final.usage.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 })

    expect(final.content).toEqual([{ type: 'text', text }])
  })
})

// ── 2. 事件序 ──

describe('buildAckStreamSimple 事件序', () => {
  it('start → text_start → text_delta → text_end → error(aborted)，且 end(final)', async () => {
    const text = 'ack text'
    const stream = requireStreamFn({ model: SESSION_MODEL, text })(CALL_MODEL, CALL_CONTEXT)

    // 工厂返回时不阻塞（推送在 queueMicrotask 内），故可在返回后立刻挂 spy 观察全序。
    const pushSpy = vi.spyOn(stream, 'push')
    const final = await stream.result()

    expect(pushSpy.mock.calls.map(call => call[0].type)).toEqual([
      'start',
      'text_start',
      'text_delta',
      'text_end',
      'error',
    ])

    const delta = pushSpy.mock.calls[2]![0]
    if (delta.type !== 'text_delta') throw new Error('第 3 个事件应为 text_delta')
    expect(delta.delta).toBe(text)
    expect(delta.contentIndex).toBe(0)

    const end = pushSpy.mock.calls[3]![0]
    if (end.type !== 'text_end') throw new Error('第 4 个事件应为 text_end')
    expect(end.content).toBe(text)

    // aborted 必须走 error 终止：pi-ai 的 done.reason 枚举不含 aborted。
    const last = pushSpy.mock.calls.at(-1)![0]
    if (last.type !== 'error') throw new Error('末事件应为 error')
    expect(last.reason).toBe('aborted')
    expect(last.error.stopReason).toBe('aborted')

    // result() 由 error 事件 resolve（非空最终消息）。
    expect(final.stopReason).toBe('aborted')
  })
})

// ── 3. one-shot 自撤钩子的调用时机 ──

describe('buildAckStreamSimple onCalled 时机', () => {
  it('在 streamSimple 返回前同步调用，且恰好一次', () => {
    const order: string[] = []
    const deps: AckStreamDeps = {
      model: SESSION_MODEL,
      text: 'x',
      onCalled: () => order.push('called'),
    }
    const fn = requireStreamFn(deps)

    fn(CALL_MODEL, CALL_CONTEXT)
    order.push('after-return')

    // 'called' 必须早于返回点（编排层要在真实模型请求发生前注销覆写）。
    expect(order).toEqual(['called', 'after-return'])
    expect(order.filter(entry => entry === 'called')).toHaveLength(1)
  })
})

// ── 4. 可用性判据四分支 + fail-closed ──

describe('computeAckAvailability', () => {
  it('isToggleDisabled 为真 ⇒ toggle-disabled（优先于任何 provider 判据）', async () => {
    const result = await computeAckAvailability({
      providerId: 'anthropic',
      isToggleDisabled: () => true,
    })

    expect(result).toEqual({ available: false, reason: 'toggle-disabled' })
  })

  it('native 重载在场 ⇒ no-base（先于 builtin/models.json 的 available 短路）', async () => {
    // 关键回归组合：builtin ∩ native——native 检查若放在 builtin 判定之后会被
    // available 短路掉，覆写照样顶掉第三方 native 注册（registerProvider 即删 native
    // 层且 unregister 不恢复）。
    const builtinHit = await computeAckAvailability({
      providerId: 'anthropic',
      isToggleDisabled: () => false,
      hasRegisteredNativeOverride: (id) => id === 'anthropic',
    })
    expect(builtinHit).toEqual({ available: false, reason: 'no-base' })

    const modelsJsonHit = await computeAckAvailability({
      providerId: 'acme-custom',
      isToggleDisabled: () => false,
      loadModelsJsonProviderIds: async () => new Set(['acme-custom']),
      hasRegisteredNativeOverride: (id) => id === 'acme-custom',
    })
    expect(modelsJsonHit).toEqual({ available: false, reason: 'no-base' })

    // toggle-disabled 仍优先于 native 判据。
    const toggled = await computeAckAvailability({
      providerId: 'anthropic',
      isToggleDisabled: () => true,
      hasRegisteredNativeOverride: () => true,
    })
    expect(toggled).toEqual({ available: false, reason: 'toggle-disabled' })
  })

  it('内置 provider 命中 ⇒ available（含动态 provider radius）', async () => {
    const anthropic = await computeAckAvailability({
      providerId: 'anthropic',
      isToggleDisabled: () => false,
    })
    expect(anthropic).toEqual({ available: true })

    // radius 只在 builtinProviders() 里（getBuiltinProviders() 缺它）——
    // 本断言是「必须用 builtinProviders()」的回归证据。
    const radius = await computeAckAvailability({
      providerId: 'radius',
      isToggleDisabled: () => false,
    })
    expect(radius).toEqual({ available: true })
  })

  it('models.json 命中（注入 loader）⇒ available', async () => {
    const result = await computeAckAvailability({
      providerId: 'acme-custom',
      isToggleDisabled: () => false,
      loadModelsJsonProviderIds: async () => new Set(['acme-custom']),
    })

    expect(result).toEqual({ available: true })
  })

  it('两处皆否 ⇒ no-base', async () => {
    const result = await computeAckAvailability({
      providerId: 'unknown-provider',
      isToggleDisabled: () => false,
      loadBuiltinProviderIds: async () => new Set(['anthropic']),
      loadModelsJsonProviderIds: async () => new Set(['other']),
    })

    expect(result).toEqual({ available: false, reason: 'no-base' })
  })

  it('loader 抛错 ⇒ check-failed（不抛出、不炸扩展加载）', async () => {
    const result = await computeAckAvailability({
      providerId: 'unknown-provider',
      isToggleDisabled: () => false,
      loadBuiltinProviderIds: async () => {
        throw new Error('subpath import failed')
      },
    })

    expect(result).toEqual({ available: false, reason: 'check-failed' })
  })

  it('models.json JSON 非法 ⇒ check-failed（经默认 loader 真实读取路径）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sched-ack-bad-'))
    try {
      const badPath = join(dir, 'models.json')
      writeFileSync(badPath, '{ not json')

      const result = await computeAckAvailability({
        providerId: 'unknown-provider',
        isToggleDisabled: () => false,
        loadBuiltinProviderIds: async () => new Set(),
        loadModelsJsonProviderIds: () => loadModelsJsonProviderIds(badPath),
      })

      expect(result).toEqual({ available: false, reason: 'check-failed' })
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
    }
  })
})

// ── 5. loadModelsJsonProviderIds 解析 ──

describe('loadModelsJsonProviderIds', () => {
  it('解析 providers 键集合；缺文件 ⇒ 空集合；providers 缺失 ⇒ 空集合', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sched-ack-models-'))
    try {
      const validPath = join(dir, 'models.json')
      writeFileSync(
        validPath,
        JSON.stringify({ providers: { acme: { api: 'openai-completions' }, beta: {} } }),
      )
      const ids = await loadModelsJsonProviderIds(validPath)
      expect([...ids].sort()).toEqual(['acme', 'beta'])

      // 文件不存在 = 未配置自定义 provider 的正常形态（非失败）。
      const missing = await loadModelsJsonProviderIds(join(dir, 'missing.json'))
      expect(missing.size).toBe(0)

      const noProvidersPath = join(dir, 'no-providers.json')
      writeFileSync(noProvidersPath, JSON.stringify({ version: 1 }))
      const noProviders = await loadModelsJsonProviderIds(noProvidersPath)
      expect(noProviders.size).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
    }
  })
})
