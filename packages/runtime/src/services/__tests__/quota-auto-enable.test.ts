/**
 * quota-auto-enable 匹配链权威单测（行为锁，防复发）：
 *
 * 自动开启判定链（matchAutoEnablePreset / autoEnableQuotaDisplayOnCreate）必须读
 * listQuotaPresets()「基线 ⊕ 远程」合并视图——与 quota-service 查询链 / 前端展示链同一
 * 权威。曾因 matchQuotaPreset 缺省参数（静默回落编译期基线）漏迁移合并视图：远程 presets
 * 下发后查询链已切新规则、自动开启判定链仍读旧基线，两条匹配链权威分裂。
 *
 * 锁法：mock listQuotaPresets 返回**仅远程下发**的 preset（其 namePattern 对基线表不可
 * 命中）——若实现漏传 presets（回落基线），命中失败、断言红。契约面（presets 形参必填、
 * matchQuotaPreset 无缺省）另由 TS 编译期强制。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const remotePresets = vi.hoisted(() => ({ list: [] as unknown[] }))

vi.mock('../quota-providers/index.js', () => ({
  listQuotaPresets: vi.fn(() => remotePresets.list),
}))

import { autoEnableQuotaDisplayOnCreate, matchAutoEnablePreset } from '../quota-auto-enable.js'
import { QUOTA_PRESETS, type QuotaPreset } from '@taiji/shared'
import type { ProviderExtras } from '../provider-extras-store.js'

/** 仅远程下发的 preset：namePattern 对基线 QUOTA_PRESETS 全表不命中（漏传 presets 的实现必红）。 */
const REMOTE_ONLY_PRESET: QuotaPreset = {
  fetcher: 'remote-only-fetcher',
  label: 'Remote Only Plan',
  auth: ['api-key'],
  match: { namePattern: '\\bremoteonlyplan\\b' },
}

/** extras 写通道 fake（对齐 provider-importer.test.ts fakeExtrasStore：记录 (id, fn) 可断言写参）。 */
function fakeStore(current: ProviderExtras | undefined = undefined) {
  const modify = vi.fn(async (
    _providerId: string,
    fn: (c: ProviderExtras | undefined) => ProviderExtras,
  ) => fn(current))
  return { modify }
}

beforeEach(() => {
  remotePresets.list = []
})

describe('matchAutoEnablePreset 读 presets 合并视图（与查询/展示链同一权威）', () => {
  it('远程 presets 下发（基线不可见的 namePattern）→ 命中远程 preset（漏传 presets 回落基线的实现必红）', () => {
    remotePresets.list = [REMOTE_ONLY_PRESET]

    const preset = matchAutoEnablePreset(
      { name: 'My RemoteOnlyPlan Service' },
      'plaintext',
      remotePresets.list as readonly QuotaPreset[],
    )

    expect(preset).toEqual(REMOTE_ONLY_PRESET)
  })

  it('同一 provider 在编译期基线下不命中（证明上面的命中来自注入的合并视图，非基线巧合）', () => {
    expect(matchAutoEnablePreset({ name: 'My RemoteOnlyPlan Service' }, 'plaintext', QUOTA_PRESETS)).toBeUndefined()
  })

  it('presets 空数组（远端与基线皆不可用）→ undefined（不自动开启）', () => {
    expect(matchAutoEnablePreset({ name: 'kimi' }, 'plaintext', [])).toBeUndefined()
  })

  it('非 plaintext 凭证形态先行短路（presets 命中也不开启）', () => {
    remotePresets.list = [REMOTE_ONLY_PRESET]
    expect(
      matchAutoEnablePreset({ name: 'My RemoteOnlyPlan Service' }, 'env', remotePresets.list as readonly QuotaPreset[]),
    ).toBeUndefined()
  })
})

describe('autoEnableQuotaDisplayOnCreate 端到端（内部经 listQuotaPresets 取合并视图）', () => {
  it('远程 preset 命中 + 明文凭证 → 落盘 { enabled: true, fetcher: 远程 fetcher }', async () => {
    remotePresets.list = [REMOTE_ONLY_PRESET]
    const store = fakeStore()

    const wrote = await autoEnableQuotaDisplayOnCreate(
      store,
      'my-remote-provider',
      { name: 'My RemoteOnlyPlan Service' },
      true,
    )

    expect(wrote).toBe(true)
    expect(store.modify).toHaveBeenCalledTimes(1)
    const written = store.modify.mock.calls[0][1](undefined)
    expect(written.quota).toEqual({ enabled: true, fetcher: 'remote-only-fetcher' })
  })

  it('合并视图无命中 → 不写 extras（返回 false）', async () => {
    remotePresets.list = [REMOTE_ONLY_PRESET]
    const store = fakeStore()

    const wrote = await autoEnableQuotaDisplayOnCreate(store, 'p1', { baseUrl: 'https://example.com' }, true)

    expect(wrote).toBe(false)
    expect(store.modify).not.toHaveBeenCalled()
  })

  it('无远程覆盖（listQuotaPresets 回落基线 QUOTA_PRESETS）→ 基线命中语义保持（kimi baseUrl）', async () => {
    remotePresets.list = QUOTA_PRESETS
    const store = fakeStore()

    const wrote = await autoEnableQuotaDisplayOnCreate(
      store,
      'kimi-main',
      { baseUrl: 'https://api.kimi.com/coding' },
      true,
    )

    expect(wrote).toBe(true)
    const written = store.modify.mock.calls[0][1](undefined)
    expect(written.quota).toEqual({ enabled: true, fetcher: 'kimi-coding' })
  })
})
