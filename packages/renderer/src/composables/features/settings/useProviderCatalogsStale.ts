/**
 * useProviderCatalogsStale —— 远程模型目录「可能过期」标记（RD-4#10，自 ProviderPage 拆出）。
 *
 * 离线/部分失败时模型目录列表会陈旧，而原实现 `config.refreshProviderCatalogs().catch(()=>{})`
 * 是红线 1 形态（静默吞噬）——用户看到的是「能用的旧列表」，无从知道目录已不可信。
 *
 * 判据（协议侧已就位，无需改 core）：
 * - `config.providerCatalogsRefreshed` 回包 `failed[]` 非空 → 有供应商目录刷新失败 → 陈旧
 * - transport 层 reject（超时/断连）→ 整体没刷成 → 陈旧
 *
 * 审查 E 订正：renderer 无 provider store、`store.setCatalogStale` 不存在，故用本 composable
 * 的本地 ref 落地（消费方 = Picker 头部的「目录可能过期」提示）。
 */
import { ref } from 'vue'
import { config } from '@/api'

export function useProviderCatalogsStale() {
  const catalogsStale = ref(false)

  /** 按需刷新远程模型目录并据结果置陈旧标记；不抛错（页面不因目录刷新失败而阻断）。 */
  async function refreshCatalogs(): Promise<void> {
    try {
      const res = await config.refreshProviderCatalogs()
      if (res.failed.length > 0) catalogsStale.value = true
    } catch (e: unknown) {
      console.warn('[ProviderPage] refreshProviderCatalogs failed:', e)
      catalogsStale.value = true
    }
  }

  return { catalogsStale, refreshCatalogs }
}
