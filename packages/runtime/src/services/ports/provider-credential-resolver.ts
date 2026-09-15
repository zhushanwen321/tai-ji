/**
 * Provider 凭据域 ports —— 「给我 providerId、还你生效凭据」的唯一读取入口（D3 收口）。
 *
 * 🔒 三层架构：services 定义 port，services/auth/provider-credential-resolver.ts 实现。
 * 背景：凭据读取历史上散落成 5 条互不知情的解析链（quota 私有三源链 / handleDiscoverModels
 * 只查 models.json / pi-provider-store 私有裸读 auth.json / AuthService 单源 / listProviders
 * 内联判定），本 port 是收口后的唯一通道，新场景不得再自建解析链。
 *
 * 消费方（后续迁移单元接线，迁移完成前不要提前改消费点）：
 * - 链 1 QuotaService.getCredential 的 auth.json / models.json 两段 → resolveProviderCredential
 * - 链 2 settings-message-handler 的 handleDiscoverModels 凭据回查 → resolveProviderCredential
 * - 链 3 infra/pi/pi-provider-store 的 catalog 凭据校验 → hasProviderCredential
 *   （infra 层只 `import type` 本接口，不 import 实现；注入通道见 D3「分层与注入设计」）
 * - 链 5 provider-config-helper.listProviders 的 apiKeySet 判定 → listCredentialBackedProviderIds
 *
 * 双形态存在的理由：listProviders / findValidDefaultModel 是**同步热路径**，若只有 async
 * 形态，调用方会继续内联同步拷贝（收口失效）；两形态在实现层共享同一份源优先级声明。
 * 本文件只放类型，不得 value import services/infra（C-comm-03）。
 */

export interface IProviderCredentialResolver {
  /**
   * 同步判该 provider 是否在任一凭据源中有条目（存在性判定，不解析明文）。
   * 供 setProvider 判定等同步上下文消费；批量场景用 listCredentialBackedProviderIds。
   */
  hasProviderCredential(providerId: string): boolean

  /**
   * 同步批量列出「有凭据」的 providerId 并集（两源各单次读，非 N+1 读盘）。
   * 供 listProviders 热路径消费（先例：provider-config-helper.ts:412 的 B3「消除 N+1 读盘」）。
   */
  listCredentialBackedProviderIds(): Set<string>

  /**
   * 解析 provider 的生效明文凭据，未命中返回 undefined。
   * 源优先级：auth.json（catalog 凭据所在）→ models.json providers[id].apiKey（custom 凭据所在）。
   */
  resolveProviderCredential(providerId: string): Promise<{ key: string; source: 'auth.json' | 'models.json' } | undefined>
}
