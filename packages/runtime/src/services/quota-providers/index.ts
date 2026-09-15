/**
 * Quota provider fetcher 注册表。
 *
 * QUOTA_FETCHERS: Map<fetcherId, ProviderQuotaFetcher>
 * 5 个内置 provider fetcher，为后续 plugin 化铺路。
 */

import type { ProviderQuotaFetcher } from '@taiji/shared'
import { zhipuFetcher } from './zhipu.js'
import { kimiFetcher } from './kimi.js'
import { minimaxFetcher } from './minimax.js'
import { mimoFetcher } from './mimo.js'
import { opencodeFetcher } from './opencode.js'

/** 内置 fetcher 注册表。key = fetcher id（匹配 QuotaPreset.fetcher）。 */
export const QUOTA_FETCHERS: Map<string, ProviderQuotaFetcher> = new Map([
  [zhipuFetcher.id, zhipuFetcher],
  [kimiFetcher.id, kimiFetcher],
  [minimaxFetcher.id, minimaxFetcher],
  [mimoFetcher.id, mimoFetcher],
  [opencodeFetcher.id, opencodeFetcher],
])
