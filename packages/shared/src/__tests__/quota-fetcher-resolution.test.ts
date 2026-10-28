/**
 * resolveQuotaFetcherId 单测（provider → quota fetcher id 两级解析单源）。
 *
 * 覆盖双实现归并前的两条消费链语义（renderer 自动续期目标解析 / runtime
 * QuotaService.getFetcherForProvider）：
 * - 手动 quota.fetcher 在册（hasFetcher）优先
 * - 手动缺席 / 不在册 → matchQuotaPreset 按 baseUrl/name 匹配 → preset.fetcher
 *   （在册与否不在本函数判定——消费方策略收尾）
 * - 两级都未命中 → undefined
 *
 * 运行：cd packages/shared && npx vitest run src/__tests__/quota-fetcher-resolution.test.ts
 */
import { describe, it, expect } from 'vitest'
import type { QuotaPreset } from '../quota-presets'
import { resolveQuotaFetcherId } from '../quota-refresh-targets'

/** 最小 preset 表（形参权威：函数只读本表，不回落编译期基线）。 */
const PRESETS: QuotaPreset[] = [
  {
    fetcher: 'mimo',
    label: 'MiMo',
    auth: ['cookie'],
    match: { namePattern: '\\bmimo\\b' },
  },
  {
    fetcher: 'zhipu',
    label: 'Zhipu',
    auth: ['api-key'],
    match: { baseUrlPattern: 'bigmodel.cn' },
  },
]

/** 在册判定桩：mimo / zhipu 在册，其余（含已下线形态）不在册。 */
const hasFetcher = (id: string): boolean => id === 'mimo' || id === 'zhipu'

describe('resolveQuotaFetcherId', () => {
  it('手动 quota.fetcher 在册 → 优先返回手动 id（baseUrl 命中其它 preset 也不改道）', () => {
    expect(
      resolveQuotaFetcherId(
        { baseUrl: 'https://bigmodel.cn/api', quota: { fetcher: 'mimo' } },
        PRESETS,
        hasFetcher,
      ),
    ).toBe('mimo')
  })

  it('手动 id 不在册 → 落到 preset 自动匹配（对齐 runtime「下线 fetcher 回退匹配链」行为）', () => {
    expect(
      resolveQuotaFetcherId(
        { baseUrl: 'https://bigmodel.cn/api', quota: { fetcher: 'delisted-fetcher' } },
        PRESETS,
        hasFetcher,
      ),
    ).toBe('zhipu')
  })

  it('手动缺席 → preset 匹配返回 preset.fetcher（不查在册——消费方策略收尾）', () => {
    expect(
      resolveQuotaFetcherId({ name: 'Xiaomi mimo proxy' }, PRESETS, hasFetcher),
    ).toBe('mimo')
    // preset 命中但 fetcher 不在册（如远程 preset 引用已下线 id）仍返回 id：
    // runtime 消费侧据此查注册表得 null = 显式失败，不落第三级兜底
    expect(
      resolveQuotaFetcherId(
        { name: 'legacy platform' },
        [{ fetcher: 'legacy', label: 'Legacy', auth: ['cookie'], match: { namePattern: 'legacy' } }],
        hasFetcher,
      ),
    ).toBe('legacy')
  })

  it('两级都未命中（无匹配 preset）→ undefined', () => {
    expect(
      resolveQuotaFetcherId({ baseUrl: 'https://unknown.example.com', name: 'unknown' }, PRESETS, hasFetcher),
    ).toBeUndefined()
  })

  it('baseUrl/name 双空 → undefined（matchQuotaPreset 空输入不匹配）', () => {
    expect(resolveQuotaFetcherId({}, PRESETS, hasFetcher)).toBeUndefined()
  })

  it('presets 形参权威：候选表为空 → 永不命中 preset 级', () => {
    expect(
      resolveQuotaFetcherId({ name: 'Xiaomi mimo proxy' }, [], hasFetcher),
    ).toBeUndefined()
  })
})
