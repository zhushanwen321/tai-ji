/**
 * Coding Plan 额度查询 — 共享类型定义。
 *
 * 设计文档：docs/architecture/v3-specs/coding-plan-quota/design.md
 * HANDOFF：.taiji-harness/coding-plan-quota/HANDOFF.md
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

/** 额度百分比展示保留的小数位（2026-10-20 裁决：两位）。 */
export const QUOTA_PCT_DECIMALS = 2

/**
 * 额度百分比 → 展示文本（只产出数值本体，`%` 由调用方拼）。
 *
 * 存在理由（SSOT）：pct 是 fetcher 派生值的连续量（`used/limit` 除法、`percent01to100` 乘法），
 * 直接插值会暴露浮点尾数——实测 `2.9499999999999997` 撑爆 32px 数字列并溢出行宽。
 * 两个消费面（指标聚合页 ContextCapacityCard / 设置页 QuotaWindowList）必须同一口径，
 * 否则同一窗口在两处显示不同数字。
 *
 * 定点兜底而非四舍五入后插值：`toFixed` 二进制舍入在白噪声上稳定（0.005 边界不追求
 * 数学精确），且 `Number(...)` 归一后再插值可丢掉 `2.95` 与 `2.9500000001` 的尾零差异。
 * 非有限值（NaN/±Infinity）→ `'--'`，与 resetSec 缺省占位一致（不渲染 `NaN%`）。
 */
export function formatQuotaPct(pct: number): string {
  if (!Number.isFinite(pct)) return '--'
  return String(Number(pct.toFixed(QUOTA_PCT_DECIMALS)))
}

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
 * credential-unavailable（RT-7#7）：凭证文件读盘/锁失败（IO 层异常）——与 no-credential
 * （确实没有凭证）分流：报「读取失败」而非误导用户去填一个其实已存在的 Key，
 * 恢复指引指向检查文件/锁（message 带具体路径）。
 * credential-unsupported（RT-7#4）：凭据条目存在但形态不支持解析（`!` command 前缀 /
 * 环境变量引用未定义）——resolver 返回 unsupported 判别结构，查询在发请求前拦截。
 * cookie-invalid-format（2026-10-18）：cookie 类 fetcher 的凭证归一化后为空（粘贴内容不含
 * 任何 `name=value` 对）——与 unauthorized（服务端拒绝）分流：前者根本没发出 HTTP 请求，
 * 恢复动作是「换正确的复制路径重贴」，不是「重新登录」。
 */
export type QuotaFetchFailureReason =
  | 'unauthorized'
  | 'network'
  | 'no-subscription'
  | 'parse'
  | 'not_configured'
  | 'no-credential'
  | 'credential-unavailable'
  | 'credential-unsupported'
  | 'cookie-invalid-format'

/**
 * 归一化用户粘贴 cookie 的分隔空白伪影（`k = v ;  k2 = v2` → `k=v; k2=v2`），并剥掉可选的
 * `Cookie:` 请求头名（帮助文案让用户从 DevTools 请求头整串复制，可能连头名一起粘贴——
 * 不剥会把 `cookie: a=1` 当 cookie 名发送，服务端 401 后误报「凭证可能已失效」）。
 * 只做空白修剪：键值对内值的引号原样保留（`k="v"` 是浏览器线上传输形态，动了反而破坏鉴权）。
 * 归一化后为空（无任何 k=v 对）返回空串。
 *
 * 唯一实现（SSOT，2026-10-18 自 runtime 迁入 shared）：runtime fetcher 据此判
 * `cookie-invalid-format`，renderer 保存前用同一函数做格式校验——两端不得各写一份。
 */
export function normalizeCookieHeader(raw: string): string {
  return raw
    .replace(/^\s*cookie\s*:/i, '')
    .split(';')
    .map((pair) => {
      const eq = pair.indexOf('=')
      if (eq < 0) return ''
      const name = pair.slice(0, eq).trim()
      const value = pair.slice(eq + 1).trim()
      return name ? `${name}=${value}` : ''
    })
    .filter((pair) => pair !== '')
    .join('; ')
}

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
 * （kimi/mimo/minimax/zhipu）忽略该参数，零改动范围。
 */
export interface QuotaFetcherConfig {
  /**
   * 资源维度 fetcher（opencode / opendesign）的 workspace 归一化地址（经
   * normalizeQuotaWorkspaceUrl 产出的规范 URL）。缺失 = 未配置，资源维度 fetcher
   * 返回 not_configured（不发请求）。
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
   * @param config per-provider 只读配置（D1-2，可选）：资源维度 fetcher（opencode / opendesign）从中取
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

// ── workspace 输入归一化（P1-1，timeout-audit-hygiene-batch D1-1）──
//
// 归一化规则按 fetcher 分流（资源维度 fetcher 各家的 workspace 形态与额度 URL 不同）：
// opencode（缺省，向后兼容）与 opendesign 两族。

/** opencode 额度页规范前缀：`<BASE>/workspace/<wrk_id>/go`。 */
const OPENCODE_BASE = 'https://opencode.ai'

/**
 * workspace id 形态：`wrk_` 前缀 + 字母数字（opencode id 均此形态，如
 * `wrk_xxx...`——任何具体 id 都不得硬编码，D1-4）。
 */
const WORKSPACE_ID_RE = /^wrk_[A-Za-z0-9]+$/
/** URL pathname 中的 workspace 段提取（/workspace/wrk_xxx/... 或以 wrk_xxx 结尾）。 */
const WORKSPACE_PATH_RE = /\/workspace\/(wrk_[A-Za-z0-9]+)(?:\/|$)/

/** OpenDesign 额度 API 基址：`<BASE>/api/v1/workspaces/<workspaceId>/billing/coding-plan-usage`。 */
const OPENDESIGN_API_BASE = 'https://amr-api.open-design.ai'
/** OpenDesign workspace id 形态：纯小写字母数字（2026-10-18 实测 24 字符，边界放宽到 6-64 容错）。 */
const OPENDESIGN_WORKSPACE_ID_RE = /^[a-z0-9]{6,64}$/
/** OpenDesign URL pathname 中的 workspace 段提取（/api/v1/workspaces/<id>/...）。 */
const OPENDESIGN_WORKSPACE_PATH_RE = /\/api\/v1\/workspaces\/([a-z0-9]{6,64})(?:\/|$)/

/** workspace 地址归一化结果：ok=true 带规范 URL；ok=false 带面向用户的报错文案。 */
export type QuotaWorkspaceNormalizeResult =
  | { ok: true; url: string }
  | { ok: false; error: string }

/**
 * workspace 输入归一化（P1-1）：完整 URL 与裸 id 两种输入均可解析为该 fetcher 的规范
 * 额度查询 URL。规则按 fetcherId 分流；缺省/未知 fetcher 走 opencode 规则（历史调用方
 * 兼容——最早只支持 opencode，其余 fetcher 均为账号维度无 workspace）。
 *
 * 归一化产物是规范 URL 而非裸 id（D1-2 config 字段名 workspaceUrl 名副其实）。
 *
 * hostname 白名单是安全必要而非格式洁癖：fetchQuota 携带用户 cookie 请求归一化产物——
 * 放行任意域等于把 cookie 泄露给第三方域。
 *
 * @param input 用户输入（完整 URL 或裸 id；空串/空白由调用方按「清除/未填」语义处理，
 *   本函数对空输入返回 error）
 * @param fetcherId 目标 fetcher（匹配 QuotaPreset.fetcher；缺省按 opencode 规则）
 */
export function normalizeQuotaWorkspaceUrl(input: string, fetcherId?: string): QuotaWorkspaceNormalizeResult {
  const trimmed = input.trim()
  if (!trimmed) {
    return { ok: false, error: 'workspace url is empty' }
  }
  return fetcherId === 'opendesign'
    ? normalizeOpendesignWorkspace(trimmed)
    : normalizeOpencodeWorkspace(trimmed)
}

/** opencode workspace 归一化：裸 `wrk_` id / 完整 opencode.ai URL → 规范额度页 URL。 */
function normalizeOpencodeWorkspace(trimmed: string): QuotaWorkspaceNormalizeResult {
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

/** OpenDesign workspace 归一化：裸 workspace id / 完整 amr-api URL → 规范额度查询 URL。 */
function normalizeOpendesignWorkspace(trimmed: string): QuotaWorkspaceNormalizeResult {
  // 形态 1：裸 workspace id → 直接拼规范 URL
  if (OPENDESIGN_WORKSPACE_ID_RE.test(trimmed)) {
    return { ok: true, url: opendesignUsageUrl(trimmed) }
  }

  // 形态 2：完整 URL → 校验域 + 提取 workspace id + 重构规范 URL
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return {
      ok: false,
      error: `invalid workspace: not a URL or workspace id. Expected a bare workspace id or like ${OPENDESIGN_API_BASE}/api/v1/workspaces/<id>/billing/coding-plan-usage`,
    }
  }

  if (parsed.hostname !== 'amr-api.open-design.ai') {
    return {
      ok: false,
      error: `invalid workspace url: expected host amr-api.open-design.ai, got "${parsed.hostname}" (your cookie is only sent to amr-api.open-design.ai)`,
    }
  }

  const id = parsed.pathname.match(OPENDESIGN_WORKSPACE_PATH_RE)?.[1]
  if (!id) {
    return {
      ok: false,
      error: `invalid workspace url: no workspace id found in path "${parsed.pathname}". Expected like ${OPENDESIGN_API_BASE}/api/v1/workspaces/<id>/billing/coding-plan-usage`,
    }
  }

  return { ok: true, url: opendesignUsageUrl(id) }
}

function opendesignUsageUrl(id: string): string {
  return `${OPENDESIGN_API_BASE}/api/v1/workspaces/${id}/billing/coding-plan-usage`
}

/**
 * 从已配置的 workspace 地址提取 workspace id（读侧反提取——opencode fetcher 请求
 * console API 时以 id 作 `x-org-id` header）。
 *
 * 写侧产物是规范 URL（normalizeQuotaWorkspaceUrl → `/workspace/<id>/go`）；本函数同时
 * 容忍裸 `wrk_` id 与其他路径形态（读侧不做二次归一化，存量数据形态不保证）。提取不到
 * 返回 null，调用方按配置不可用处理（恢复指引指向重填配置）。
 */
export function extractQuotaWorkspaceId(workspaceUrl: string): string | null {
  const trimmed = workspaceUrl.trim()
  if (WORKSPACE_ID_RE.test(trimmed)) return trimmed
  return trimmed.match(/wrk_[A-Za-z0-9]+/)?.[0] ?? null
}
