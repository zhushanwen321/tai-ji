/**
 * Coding Plan 额度查询 — 共享类型定义。
 *
 * 设计文档：docs/architecture/v3-specs/coding-plan-quota/design.md
 * HANDOFF：.xyz-harness/coding-plan-quota/HANDOFF.md
 */

/** 单个时间窗口的额度（5h 滚动 / 本周 / 本月三窗口之一）。 */
export interface QuotaWindow {
  /** 已用百分比 0-100。null = 无限/未订阅（前端整行隐藏）。 */
  pct: number | null
  /**
   * 已用绝对量（次数或 token 数）。optional 向后兼容：平台 API 未提供总量字段的
   * fetcher（zhipu/minimax 待实测）维持不输出，旧缓存/旧 fetcher 输出仍合法（D5）。
   */
  used?: number | null
  /** 总量。optional 同 used。 */
  limit?: number | null
  /** 平台计费单位。optional 同 used。 */
  unit?: 'requests' | 'tokens' | 'credits' | null
  /** 剩余秒数。null = 无重置信息（前端显示 --）。 */
  resetSec: number | null
}

/** 三窗口：[5h 滚动, 本周, 本月]。 */
export type QuotaWins = [QuotaWindow, QuotaWindow, QuotaWindow]

/** 归一化额度行（fetcher 统一输出格式）。 */
export interface NormalizedQuotaRow {
  /** Provider 显示名（如 '智谱 GLM Coding Plan'）。 */
  label: string
  /** 三窗口额度数据。 */
  wins: QuotaWins
}

/** fetcher 接受的凭证形态（能力声明数组的元素 / fetchQuota 的 kind 参数）。 */
export type QuotaAuthKind = 'api-key' | 'oauth' | 'cookie'

/**
 * 查询失败原因（可区分——null-only 接口下 401/网络/无订阅三者不可分辨）。
 * not_configured：必填查询配置缺失（timeout-audit-hygiene-batch D1-3）——如 opencode
 * 未配置 workspace。不发任何 HTTP 请求，恢复指引指向「去 Settings 配置」而非检查凭证。
 * no-credential：凭证链解析不到任何凭证（D6，coding-plan-quota-config-ux §6.7）——runtime
 * 显式报失败而非静默返回缓存，恢复指引指向「填专属 Key 或改用 Provider 凭据」。
 */
export type QuotaFetchFailureReason =
  | 'unauthorized'
  | 'network'
  | 'no-subscription'
  | 'parse'
  | 'not_configured'
  | 'no-credential'

/**
 * 单次额度查询结果：成功带数据，失败带可区分 reason（不 throw）。
 * unauthorized：HTTP 401/403 或 cookie 过期（原 isCredentialValid 语义）——
 * 凭证可能过期，恢复指引见 D6（发起一次对话触发刷新后重试，runtime 不自行 refresh）。
 */
export type QuotaFetchOutcome =
  | { ok: true; data: NormalizedQuotaRow }
  | { ok: false; reason: QuotaFetchFailureReason }

/**
 * per-provider 只读查询配置（D1-2，timeout-audit-hygiene-batch）：QuotaService 从
 * providers.json 读出后经 fetchQuota 第三参数注入。可选签名——账号维度 fetcher
 * （kimi/mimo/minimax/zhipu）忽略该参数，零改动面。
 */
export interface QuotaFetcherConfig {
  /**
   * 资源维度 fetcher（opencode）的 workspace 归一化地址（经 normalizeQuotaWorkspaceUrl
   * 产出的规范 URL）。缺失 = 未配置，资源维度 fetcher 返回 not_configured（不发请求）。
   */
  workspaceUrl?: string
}

/** Provider 额度查询 fetcher 接口（可插拔，为 Phase 2 plugin 化铺路）。 */
export interface ProviderQuotaFetcher {
  /** fetcher 标识（匹配 QuotaPreset.fetcher）。 */
  readonly id: string
  /**
   * 能力声明：该套餐额度 API 接受的凭证形态，按优先级排序。
   * QuotaService 按数组序解析凭证（每形态固定来源链），首个拿到凭证的形态即生效，
   * 并以该形态作为 kind 传给 fetchQuota。
   */
  readonly auth: readonly QuotaAuthKind[]
  /**
   * 查询额度。
   * @param credential 由 QuotaService 注入：api-key/oauth 类传 key/token 字符串，cookie 类传 cookie 字符串。
   * @param kind 凭证形态（= 命中的 auth 数组元素），fetcher 可区分凭证语义
   *   （如个别平台 oauth 与 api key 请求头不同）。
   * @param config per-provider 只读配置（D1-2，可选）：资源维度 fetcher（opencode）从中取
   *   workspaceUrl；账号维度 fetcher 忽略。
   * @returns QuotaFetchOutcome。失败不 throw，reason 可区分。
   */
  fetchQuota(credential: string, kind: QuotaAuthKind, config?: QuotaFetcherConfig): Promise<QuotaFetchOutcome>
}

// ── 凭证来源解析与 configure payload（D3/§7.1，coding-plan-quota-config-ux）──

/** 额度查询的凭证来源（D3）。provider = 复用 provider 自己的凭据；exclusive = 只用额度专属 Key。 */
export type QuotaCredentialSource = 'provider' | 'exclusive'

/**
 * 解析有效凭证来源 —— UI 与 runtime 必须调用同一个函数，否则两端推断可以背离（D3）。
 * 未显式设置时按既存标记推断：有专属 Key 视为 exclusive（兼容历史数据），否则 provider。
 *
 * 仅服务读侧（组装 ProviderInfo.quota 与 fetch 时解析）。写侧（persistQuotaConfig）走
 * 键缺省 = 继承既存的继承链，禁止用本函数补默认值。注意本函数是**显式值优先**（见实现），
 * 所以写侧补默认的危害不是「覆盖显式值」，而是把**未设置的字段物化成推断值**：setEnabled
 * 式缺省 payload 会在磁盘写入用户从未选择过的来源（违反 D4「开关只写 enabled」与
 * 「键缺省 = 继承既存」），且此后该 provider 不再跟随推断——专属 Key 被清后 apiKeySet 变
 * false，读侧本应回落 provider，冻结的显式值会让查询走向 no-credential（§7.3 改动 6 的反例）。
 */
export function resolveQuotaCredentialSource(
  quota: { credentialSource?: QuotaCredentialSource; apiKeySet?: boolean } | undefined,
): QuotaCredentialSource {
  return quota?.credentialSource ?? (quota?.apiKeySet ? 'exclusive' : 'provider')
}

/**
 * 额度专属 Key 对该凭证形态是否适用 —— UI（分段控件与齐备性判定）与 runtime
 * （resolveCredential 的 exclusive 收窄）必须调用同一个函数，否则两端判据可以背离
 * （coding-plan-quota-config-ux §7 残留 11）：UI 显示「用专属 Key」而 runtime 忽略该选择。
 * 判据 = auth 声明里含 'api-key'；auth 为 undefined / 不含 api-key（如纯 oauth、纯 cookie）→ false。
 */
export function supportsExclusiveCredential(auth: readonly QuotaAuthKind[] | undefined): boolean {
  return auth?.includes('api-key') ?? false
}

/**
 * quota.configure 的完整 payload —— protocol、core domain、mock、QuotaService 四处共用
 * 同一类型（§7.1 契约收敛：6 位置参数中 4 个同构 string | undefined 互相错位编译器不报错，
 * 单对象透传让后续加字段零改动、漏切调用方必编译错）。
 *
 * 各可选字段缺省 = 不变（persist 继承链）；credentialSource 切换只改这一个字段、
 * 不删专属 Key 文件（D3 可逆性）；cookie 空串 = 清除（既有 wire 语义，保留给直接调用方）。
 */
export interface QuotaConfigurePayload {
  providerId: string
  enabled: boolean
  fetcher?: string
  credentialSource?: QuotaCredentialSource
  cookie?: string
  apiKey?: string
  workspace?: string
}

// ── opencode workspace URL 归一化（P1-1，timeout-audit-hygiene-batch D1-1）──

/** opencode 额度页规范前缀：`<BASE>/workspace/<wrk_id>/go`。 */
const OPENCODE_BASE = 'https://opencode.ai'

/**
 * workspace id 形态：`wrk_` 前缀 + 字母数字（opencode id 均此形态，如
 * `wrk_xxx...`——任何具体 id 都不得硬编码，D1-4）。
 */
const WORKSPACE_ID_RE = /^wrk_[A-Za-z0-9]+$/
/** URL pathname 中的 workspace 段提取（/workspace/wrk_xxx/... 或以 wrk_xxx 结尾）。 */
const WORKSPACE_PATH_RE = /\/workspace\/(wrk_[A-Za-z0-9]+)(?:\/|$)/

/** workspace 地址归一化结果：ok=true 带规范 URL；ok=false 带面向用户的报错文案。 */
export type QuotaWorkspaceNormalizeResult =
  | { ok: true; url: string }
  | { ok: false; error: string }

/**
 * opencode workspace 输入归一化（P1-1）：完整 URL 与裸 `wrk_` id 两种输入均可解析为
 * 规范额度页 URL `<OPENCODE_BASE>/workspace/<id>/go`。
 *
 * 归一化产物是规范 URL 而非裸 id（D1-2 config 字段名 workspaceUrl 名副其实）：
 * URL 中的尾路径差异（/go、/usage 等）统一收敛为 /go 额度页。
 *
 * hostname 必须是 opencode.ai（fetchQuota 携带用户 cookie 请求该 URL——放行任意域
 * 等于把 cookie 泄露给第三方域，域名校验是安全必要而非格式洁癖）。
 *
 * @param input 用户输入（完整 URL 或裸 wrk_ id；空串/空白由调用方按「清除/未填」语义处理，
 *   本函数对空输入返回 error）
 */
export function normalizeQuotaWorkspaceUrl(input: string): QuotaWorkspaceNormalizeResult {
  const trimmed = input.trim()
  if (!trimmed) {
    return { ok: false, error: 'workspace url is empty' }
  }

  // 形态 1：裸 wrk_ id → 直接拼规范 URL
  if (WORKSPACE_ID_RE.test(trimmed)) {
    return { ok: true, url: `${OPENCODE_BASE}/workspace/${trimmed}/go` }
  }

  // 形态 2：完整 URL → 校验域 + 提取 workspace id + 重构规范 URL
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return {
      ok: false,
      error: `invalid workspace url: not a URL or wrk_ id. Expected like ${OPENCODE_BASE}/workspace/wrk_xxx/go or a bare wrk_ id`,
    }
  }

  if (parsed.hostname !== 'opencode.ai') {
    return {
      ok: false,
      error: `invalid workspace url: expected host opencode.ai, got "${parsed.hostname}" (your cookie is only sent to opencode.ai)`,
    }
  }

  const id = parsed.pathname.match(WORKSPACE_PATH_RE)?.[1]
  if (!id) {
    return {
      ok: false,
      error: `invalid workspace url: no wrk_ id found in path "${parsed.pathname}". Expected like ${OPENCODE_BASE}/workspace/wrk_xxx/go`,
    }
  }

  return { ok: true, url: `${OPENCODE_BASE}/workspace/${id}/go` }
}
