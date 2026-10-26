/**
 * quota-providers 注册表层单测（index.ts）：
 *
 * 1. isQuotaFetchersRemoteConfig —— 远程 quota-fetchers 域 guard。fetchers 段逐元素全字段
 *    校验（isDeclarativeFetcherConfig）；presets 段逐元素 QuotaPreset 形状校验（isQuotaPreset）。
 *    畸形 preset 元素（如缺 match）若放行，会经 listQuotaPresets 下发前端 / 进入匹配链，
 *    matchQuotaPreset 对缺 match 元素解构即 TypeError（额度 label / 自动开启判定渲染期抛错）。
 * 2. listQuotaPresets 合并视图链路：guard 拒绝 → 整体拒用回退基线 QUOTA_PRESETS（不部分
 *    采纳，remote-config fail-safe 链语义）；guard 通过 → 远程 presets 整体替换基线。
 *
 * loadRemoteConfig 以 vi.mock 注入远程 payload（纯缓存读侧无网络；cacheSnapshots 模块级
 * 状态不参与——本文件只经 guard/payload 通道驱动）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const remoteState = vi.hoisted(() => ({ payload: undefined as unknown }))

// 相对测试文件（src/services/quota-providers/__tests__/）解析到 src/services/remote-config/，
// 与 index.ts 的 import spec（'../remote-config/remote-config-fetch.js'）同一模块实例。
vi.mock('../../remote-config/remote-config-fetch.js', () => ({
  loadRemoteConfig: vi.fn((_domain: string, guard: (v: unknown) => boolean) =>
    remoteState.payload !== undefined && guard(remoteState.payload) ? remoteState.payload : undefined),
}))

import { isQuotaFetchersRemoteConfig, listQuotaPresets } from '../index.js'
import { isQuotaPreset, QUOTA_PRESETS, type QuotaPreset } from '@taiji/shared'

/** 合法 fetcher 配置 fixture（基线 zhipu 条目等价形态，过 isDeclarativeFetcherConfig）。 */
const VALID_FETCHER = {
  label: 'Z.ai',
  auth: ['api-key'],
  credential: 'raw',
  requests: [{ name: 'main', url: 'https://bigmodel.cn/api/monitor/usage/quota/limit' }],
  bodyCode: { path: 'success', success: true, else: 'no-subscription' },
  requires: ['data'],
  windows: [{ slot: 'fiveHour', pct: { path: 'data.limits[type=TOKENS_LIMIT].percentage', via: 'direct' } }],
}

/** 合法 preset 元素 fixture（QUOTA_PRESETS[0] 等价最小形态）。 */
function validPreset(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    fetcher: 'zhipu',
    label: '智谱 GLM Coding Plan',
    auth: ['api-key'],
    match: { baseUrlPattern: 'bigmodel.cn', namePattern: 'zhipu' },
    ...overrides,
  }
}

function remoteConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { version: 1, presets: [validPreset()], ...overrides }
}

/** 合法 QuotaPreset（validPreset 的类型化视图，供远程 payload 构造）。 */
const VALID_PRESET = validPreset() as unknown as QuotaPreset

beforeEach(() => {
  remoteState.payload = undefined
})

describe('isQuotaPreset（QuotaPreset wire 形状守卫）', () => {
  it('合法 preset（含未知扩展字段）放行', () => {
    expect(isQuotaPreset(validPreset({ futureField: { nested: true } }))).toBe(true)
  })

  it.each([
    ['非对象', 'x'],
    ['数组', [validPreset()]],
    ['null', null],
    ['fetcher 缺失', { label: 'L', auth: ['api-key'], match: {} }],
    ['fetcher 空串', validPreset({ fetcher: '' })],
    ['fetcher 非字符串', validPreset({ fetcher: 42 })],
    ['label 缺失', { fetcher: 'f', auth: ['api-key'], match: {} }],
    ['label 非字符串', validPreset({ label: 42 })],
    ['auth 缺失', { fetcher: 'f', label: 'L', match: {} }],
    ['auth 非数组', validPreset({ auth: 'api-key' })],
    ['auth 元素非字符串', validPreset({ auth: ['api-key', 42] })],
    ['match 缺失（matchQuotaPreset 解构即 TypeError 的形态）', { fetcher: 'f', label: 'L', auth: ['api-key'] }],
    ['match 非对象', validPreset({ match: 'bigmodel.cn' })],
    ['match 为数组', validPreset({ match: ['bigmodel.cn'] })],
    ['baseUrlPattern 非字符串', validPreset({ match: { baseUrlPattern: 42 } })],
    ['namePattern 非字符串', validPreset({ match: { namePattern: 42 } })],
    ['helpUrl 类型漂移', validPreset({ helpUrl: 42 })],
    ['helpText 类型漂移', validPreset({ helpText: 42 })],
    ['params 类型漂移（非数组）', validPreset({ params: 'workspaceUrl' })],
    ['params 元素畸形（缺 key）', validPreset({ params: [{ label: 'L' }] })],
    ['params 元素 key 空串', validPreset({ params: [{ key: '' }] })],
    ['params normalize 非法值', validPreset({ params: [{ key: 'x', normalize: 'bogus' }] })],
    ['params key 重复', validPreset({ params: [{ key: 'x' }, { key: 'x' }] })],
  ])('%s → false', (_name, v) => {
    expect(isQuotaPreset(v)).toBe(false)
  })

  it('match 仅含 namePattern（baseUrlPattern 合法缺省）放行', () => {
    expect(isQuotaPreset(validPreset({ match: { namePattern: '\\bopencode\\b' } }))).toBe(true)
  })
})

describe('isQuotaFetchersRemoteConfig（远程域 guard）', () => {
  it('version 1 + 合法 presets → true', () => {
    expect(isQuotaFetchersRemoteConfig(remoteConfig())).toBe(true)
  })

  it('presets 缺省（undefined）→ true（fetchers 单段覆盖合法）', () => {
    expect(isQuotaFetchersRemoteConfig({ version: 1, fetchers: { zhipu: VALID_FETCHER } })).toBe(true)
  })

  it('presets 非数组 → false', () => {
    expect(isQuotaFetchersRemoteConfig(remoteConfig({ presets: validPreset() }))).toBe(false)
  })

  it('presets 元素畸形（缺 match）→ false（整体拒用，不部分采纳）', () => {
    expect(
      isQuotaFetchersRemoteConfig(remoteConfig({ presets: [VALID_PRESET, { fetcher: 'f', label: 'L', auth: ['api-key'] }] })),
    ).toBe(false)
  })

  it('fetchers 段元素畸形 → false（既有强度保持，与 presets 同强度）', () => {
    expect(isQuotaFetchersRemoteConfig(remoteConfig({ fetchers: { bad: { label: 'x' } } }))).toBe(false)
  })

  it('version 非 1 / 非对象 → false', () => {
    expect(isQuotaFetchersRemoteConfig({ version: 2 })).toBe(false)
    expect(isQuotaFetchersRemoteConfig('x')).toBe(false)
    expect(isQuotaFetchersRemoteConfig(null)).toBe(false)
  })
})

describe('listQuotaPresets 合并视图（guard 拒绝 → 基线兜底链路）', () => {
  it('无远程覆盖（payload undefined）→ 基线 QUOTA_PRESETS', () => {
    expect(listQuotaPresets()).toBe(QUOTA_PRESETS)
  })

  it('远程 payload 被 guard 拒绝（preset 元素缺 match）→ 整体拒用回退基线 QUOTA_PRESETS', () => {
    // 混入一条畸形元素（缺 match）：若 guard 放行，前端/匹配链解构该元素即 TypeError
    remoteState.payload = remoteConfig({ presets: [{ fetcher: 'f', label: 'L', auth: ['api-key'] }] })
    expect(listQuotaPresets()).toBe(QUOTA_PRESETS)
  })

  it('远程 presets 合法 → 整体替换基线（远程表权威）', () => {
    const remotePresets = [
      validPreset({ fetcher: 'remote-only-fetcher', label: 'Remote Plan', match: { namePattern: '\\bremoteplan\\b' } }),
    ] as unknown as QuotaPreset[]
    remoteState.payload = remoteConfig({ presets: remotePresets })

    const presets = listQuotaPresets()
    expect(presets).toEqual(remotePresets)
    expect(presets).not.toBe(QUOTA_PRESETS)
  })
})
