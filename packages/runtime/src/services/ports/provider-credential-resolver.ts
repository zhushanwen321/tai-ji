/**
 * Provider 凭据域 ports —— 「给我 providerId、还你生效凭据」的唯一读取入口（D3 收敛）。
 *
 * 🔒 三层架构：services 定义 port，services/auth/provider-credential-resolver.ts 实现。
 * 背景：凭据读取历史上散落成 5 条互不知情的解析链（quota 私有三源链 / handleDiscoverModels
 * 只查 models.json / pi-provider-store 私有裸读 auth.json / AuthService 单源 / listProviders
 * 内联判定），本 port 是收敛后的唯一通道，新场景不得再自建解析链。
 *
 * 消费方（后续迁移单元接线，迁移完成前不要提前改消费点）：
 * - 链 1 QuotaService.getCredential 的 auth.json / models.json 两段 → resolveProviderCredential
 * - 链 2 settings-message-handler 的 handleDiscoverModels 凭据回查 → resolveProviderCredential
 * - 链 3 infra/pi/pi-provider-store 的 catalog 凭据校验 → hasProviderCredential
 *   （infra 层只 `import type` 本接口，不 import 实现；注入通道见 D3「分层与注入设计」）
 * - 链 5 provider-config-helper.listProviders 的 apiKeySet 判定 → listCredentialBackedProviderIds
 * - 链 6 zcode provider 镜像同步（zcode-provider-sync.ts，含启动同步与变更镜像两触发面）
 *   → resolveProviderCredential（副本条目凭据映射）+ resolveProviderBaseUrl + listCredentialBackedProviderIds
 *
 * 双形态存在的理由：listProviders / findValidDefaultModel 是**同步热路径**，若只有 async
 * 形态，调用方会继续内联同步拷贝（收敛失效）；两形态在实现层共享同一份源优先级声明。
 * 本文件只放类型，不得 value import services/infra（C-comm-03）。
 */

/**
 * resolveProviderCredential 的不支持形态标记（RT-7#4，D 类拦截信号）：
 * - 'command'：配置值是 `!` 前缀 command 形态（本模块不执行 shell）
 * - 'unresolved-env'：配置值引用了未定义的环境变量（pi 同语义：整值不可用）
 *
 * 命中即「凭据条目存在但无法解析成明文 key」——消费方必须报「该凭据形态暂不支持」类
 * 错误且**禁止把标记当 key 下发外部请求**（原样串作 Bearer 会以畸形凭据打外部 API）。
 */
export type UnsupportedCredentialForm = 'command' | 'unresolved-env'

/**
 * 凭据形态（凭据域事实判别，消费方据此决定「能否当静态 key 下发外部通道」）：
 * - 'api_key'：auth.json 的 api_key 条目 / models.json 的 apiKey——静态密钥，可复制给
 *   外部通道（如 zcode provider 副本）。
 * - 'oauth'：auth.json 的 oauth 条目——短时 access token（由 pi 侧自动 refresh），
 *   **禁止**当静态 api-key 复制给外部服务：token 过期即 401，且副本明文残留 token
 *   （退出登录后仍留在副本里）。消费方须按此判别做「不支持该形态」分流（MF-2）。
 */
export type ProviderCredentialKind = 'api_key' | 'oauth'

/** resolveProviderCredential 的成功形态（明文 key + 命中源 + 凭据形态判别）。 */
export type ResolvedProviderCredential =
  | { key: string; source: 'auth.json' | 'models.json'; kind: ProviderCredentialKind }
  | { unsupported: UnsupportedCredentialForm }

export interface IProviderCredentialResolver {
  /**
   * 同步判该 provider 是否在任一凭据源中有条目（存在性判定，不解析明文）。
   * 供 setProvider 判定等同步上下文消费；批量场景用 listCredentialBackedProviderIds。
   */
  hasProviderCredential(providerId: string): boolean

  /**
   * 同步批量列出「有凭据」的 providerId 并集（两源各单次读，非 N+1 读盘）。
   * 供 listProviders 热路径消费（先例：provider-config-helper.ts:412 的 B3「消除 N+1 读盘」）；
   * zcode provider 镜像同步（zcode-provider-sync.ts）也按本方法圈定「可映射进副本」的
   * provider 集合（文件头消费方清单链 6）。
   */
  listCredentialBackedProviderIds(): Set<string>

  /**
   * 解析 provider 的生效明文凭据。
   * 源优先级：auth.json（catalog 凭据所在）→ models.json providers[id].apiKey（custom 凭据所在）。
   * - 命中高优先源但形态不支持（command / unresolved-env）→ 返回 { unsupported } 判别
   *   结构，**不降级**读低优先源（显式配置错误被低优先源静默掩盖比报错更糟）。
   * - 全源未命中 → undefined（无凭据）。
   * - kind 恒填：auth.json 的 oauth 条目 → 'oauth'（短时 token，不可当静态 key 下发），
   *   其余（auth.json api_key / models.json apiKey）→ 'api_key'。
   */
  resolveProviderCredential(providerId: string): Promise<ResolvedProviderCredential | undefined>

  /**
   * 回显用 api_key **原值**读取（设置页眼睛按钮，协议 config.revealProviderApiKey）。
   *
   * 与 resolveProviderCredential 的差异（有意收窄，不是第二套解析链——源优先级仍由
   * 实现层的 sources 数组单点声明）：
   * - **只返回 api_key 形态**：auth.json 的 oauth 凭据一律判定不可回显并**停止向低优先源
   *   回落**（resolveProviderCredential 会返回 oauth 的 access，消费方不可把它用于回显——
   *   OAuth token 永不出协议；回落显示低优先源的历史残留值会误导用户）；
   * - **原值不展开**：`$ENV_VAR` / `!command` 等配置串原样返回（回显语义 = 「用户所存值」，
   *   展开会显示 env 的实际 secret、command 也无法在不执行 shell 的前提下求值）；
   * - 全源未命中 → undefined。
   */
  resolveProviderApiKeyRaw(
    providerId: string,
  ): Promise<{ apiKey: string; source: 'auth.json' | 'models.json' } | undefined>

  /**
   * 解析 provider 实际生效的 baseUrl（同步；两级数据源，对齐 pi 实际生效解析序
   * provider-composer 的 `config.baseUrl ?? model.baseUrl` 覆盖式网关语义——pi 行为锚点：
   * @earendil-works/pi-coding-agent@1.0.0 dist/core/provider-composer.js
   * `baseUrl: config.oauth === "radius" ? model.baseUrl : (config.baseUrl ?? model.baseUrl)`；
   * radius-oauth 例外分支读 model.baseUrl 而非 config.baseUrl，联动 provider 均非 radius
   * oauth，现行为不受影响）：
   * ① models.json providers[id].baseUrl（provider 级网关值）——该键经 pi-provider-store
   *    启动归一化（stripCatalogProviderLevelKeys）后仅在用户显式配网关（extras.gatewayBaseUrl
   *    标记）时保留，故此级读到的必是用户网关实际值；未配网关的内置 provider 此级无值。
   * ② 第一级无值时回退内置 catalog（generated/builtin-providers.json）该 provider 的
   *    provider 级 baseUrl——未配网关的内置 provider，此值即 pi 实际生效值。
   * ③ 两级皆无值 → undefined（消费方按「无生效 baseUrl」处置，不猜测默认值）。
   *
   * 与凭据方法同源收敛的理由：消费方（如 TTS 供应商联动的 baseUrl 预填）需要的是
   * 「provider 实际生效值」，port 文件头已明令新场景不得再自建解析链。
   */
  resolveProviderBaseUrl(providerId: string): string | undefined
}
