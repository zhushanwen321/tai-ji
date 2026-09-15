/**
 * Coding Plan 额度查询 — Provider 预设配置。
 *
 * SSOT：5 个内置 provider 的 fetcher 映射、认证方式、自动关联规则。
 * 设计文档：docs/architecture/v3-specs/coding-plan-quota/design.md §2.2.1
 */

import type { QuotaAuthKind } from './quota-types'

/** 单个 provider 的额度查询预设。 */
export interface QuotaPreset {
  /** 匹配 ProviderQuotaFetcher.id（fetcher 注册表的 key）。 */
  fetcher: string
  /** 显示名（如 '智谱 GLM Coding Plan'）。 */
  label: string
  /**
   * 认证方式能力声明（与 fetcher.auth 对齐，按优先级排序）：决定 UI 渲染哪种凭证输入、
   * QuotaService 按数组序解析凭证。kimi-coding 声明 ['api-key','oauth']
   * （usages API 与 oauth 同域同 Bearer）。
   */
  auth: readonly QuotaAuthKind[]
  /** Provider 自动关联规则：判断某个 ProviderInfo 是否命中此预设。 */
  match: {
    /** 按 baseUrl 域名匹配（如 'bigmodel.cn'）。归一化大小写后 baseUrl 包含此字符串即命中。 */
    baseUrlPattern?: string
    /** 按 provider name 关键字匹配（不区分大小写，支持 | 分隔多个关键字、词边界 \b 等正则语法）。 */
    namePattern?: string
  }
  /** 帮助页面 URL（UI 上显示「如何获取凭证」链接）。 */
  helpUrl?: string
  /** 帮助说明文案。 */
  helpText?: string
  /**
   * 资源维度 fetcher 标记（D1-1，timeout-audit-hygiene-batch）：true = 查询需要
   * workspace 配置（Settings 显示 Workspace 地址输入框；未配置时查询报 not_configured）。
   * 账号维度 fetcher（凭证即决定账号）省略/false。
   */
  requiresWorkspace?: boolean
}

/** 内置 5 个 provider 预设（SSOT）。 */
export const QUOTA_PRESETS: QuotaPreset[] = [
  {
    fetcher: 'zhipu',
    label: '智谱 GLM Coding Plan',
    auth: ['api-key'],
    match: {
      // [HISTORICAL] namePattern 用词边界收紧：避免 'zai' 这类短 token 作为子串误匹配
      // 到用户自建 provider（如 'lazyai' / 'mozaitest'）。matchQuotaPreset 用正则 test，
      // 不加词边界时 \bzai\b 之外的 'zai' 也会命中。词边界确保只匹配独立 token。
      baseUrlPattern: 'bigmodel.cn',
      namePattern: 'zhipu|glm|\\bzai\\b',
    },
    helpUrl: 'https://bigmodel.cn/usercenter/glm-coding/usage',
    helpText: '在 bigmodel.cn 控制台 → API Keys 页面获取',
  },
  {
    fetcher: 'kimi-coding',
    label: 'Kimi Coding Plan',
    auth: ['api-key', 'oauth'],
    match: {
      baseUrlPattern: 'kimi.com',
      namePattern: '\\bkimi\\b',
    },
    helpUrl: 'https://platform.moonshot.cn/',
    helpText: '在 Kimi 开放平台 → API Key 管理页面获取',
  },
  {
    fetcher: 'minimax',
    label: 'MiniMax Coding Plan',
    auth: ['api-key'],
    match: {
      baseUrlPattern: 'minimaxi.com',
      namePattern: '\\bminimax\\b',
    },
    helpUrl: 'https://platform.minimaxi.com/',
    helpText: '在 MiniMax 开放平台 → 账户管理获取',
  },
  {
    fetcher: 'mimo',
    label: '小米 MiMo Coding Plan',
    auth: ['cookie'],
    match: {
      baseUrlPattern: 'xiaomimimo.com',
      namePattern: '\\bmimo\\b',
    },
    helpUrl: 'https://platform.xiaomimimo.com/',
    helpText: '登录 platform.xiaomimimo.com 后，从浏览器 DevTools → Application → Cookies 复制完整 cookie 字符串',
  },
  {
    fetcher: 'opencode-go',
    label: 'opencode.go',
    auth: ['cookie'],
    match: {
      namePattern: '\\bopencode\\b',
    },
    // 资源维度：额度挂在具体 workspace 下（同一 cookie 可有多个 workspace），必须用户配置
    requiresWorkspace: true,
    helpUrl: 'https://opencode.ai/',
    helpText: '登录 opencode.ai 后，从浏览器 DevTools → Application → Cookies 复制完整 cookie 字符串',
  },
]

/**
 * 根据 provider 的 baseUrl 和 name 匹配内置预设。
 *
 * @param provider - 提供 baseUrl 和/或 name 的对象（来自 ProviderInfo）。
 * @returns 匹配到的 QuotaPreset，或 undefined（无匹配）。
 */
export function matchQuotaPreset(provider: {
  baseUrl?: string
  name?: string
}): QuotaPreset | undefined {
  const { baseUrl, name } = provider
  if (!baseUrl && !name) return undefined

  const normalizedBaseUrl = baseUrl?.toLowerCase() ?? ''
  const normalizedName = name?.toLowerCase() ?? ''

  for (const preset of QUOTA_PRESETS) {
    const { baseUrlPattern, namePattern } = preset.match

    // baseUrl 匹配：归一化大小写后判断包含（pattern 自身也归一化，避免 'BigModel.CN' 漏配）
    if (baseUrlPattern && normalizedBaseUrl.includes(baseUrlPattern.toLowerCase())) {
      return preset
    }

    // name 匹配：支持 | 分隔的多关键字正则（含词边界等高级语法）
    if (namePattern && normalizedName) {
      const regex = new RegExp(namePattern, 'i')
      if (regex.test(normalizedName)) {
        return preset
      }
    }
  }

  return undefined
}
