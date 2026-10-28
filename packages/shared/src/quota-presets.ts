/**
 * Coding Plan 额度查询 — Provider 预设配置。
 *
 * SSOT：内置 provider 的 fetcher 映射、认证方式、自动关联规则。
 * 设计文档：docs/architecture/v3-specs/coding-plan-quota/design.md §2.2.1
 */

import type { QuotaAuthKind, QuotaParamNormalize } from './quota-types'

/**
 * 用户维度隔离参数规格（2026-10 泛化，原 requiresWorkspace 单布尔）：不同账号/工作区
 * 的额度归属不同，preset 逐参数声明输入形态；QuotaService 按 spec 归一化持久化，
 * declarative-engine 经 headerFroms 注入请求头，UI 按 spec 渲染输入框。
 */
export interface QuotaParamSpec {
  /** 参数键（持久化 extras.quota.params 的键 + 引擎 headerFroms.key 的引用）。 */
  key: string
  /** UI 标签（缺省 = key 原样显示）。 */
  label?: string
  /** 输入框占位提示。 */
  placeholder?: string
  /** 输入框下方说明（去哪取这个值）。 */
  helpText?: string
  /** 是否必填（缺省 true）：false = 可选参数，不阻塞 readiness。 */
  required?: boolean
  /** 归一化分流键（缺省 raw 透传）。hostname 白名单安全边界见 normalizeQuotaParamValue。 */
  normalize?: QuotaParamNormalize
}

/** 单个 provider 的额度查询预设。 */
export interface QuotaPreset {
  /** 匹配 ProviderQuotaFetcher.id（fetcher 注册表的 key）。 */
  fetcher: string
  /** 显示名（如 'Zhipu Coding Plan'）。 */
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
   * 用户维度隔离参数规格（2026-10 泛化，原 requiresWorkspace）：声明该 fetcher 需要
   * 用户逐个账号/工作区配置的参数（Settings 渲染输入框；未配置时查询报 not_configured）。
   * 账号维度 fetcher（凭证即账号）省略/空数组。
   */
  params?: readonly QuotaParamSpec[]
}

/**
 * 内置 5 个 provider 预设（基线数据源——remote-config 域 2 上线后，运行时权威 =
 * runtime「基线 ⊕ 远程 configs/remote/quota-fetchers.json presets 整体替换」合并视图
 * （quota-providers/index.ts listQuotaPresets）；本常量仅作拉取失败/无远程覆盖时的
 * 编译期兜底与类型形状定义，不再直接作为运行时匹配数据源。
 */
export const QUOTA_PRESETS: QuotaPreset[] = [
  {
    fetcher: 'zhipu',
    label: 'Zhipu Coding Plan',
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
    label: 'MiMo',
    auth: ['cookie'],
    match: {
      baseUrlPattern: 'xiaomimimo.com',
      namePattern: '\\bmimo\\b',
    },
    helpUrl: 'https://platform.xiaomimimo.com/',
    helpText: '登录 platform.xiaomimimo.com 后，在 DevTools → Network 选中任一请求 → 请求头里的 Cookie 整串复制（形如 name=value; name2=value2）',
  },
  {
    fetcher: 'opencode-go',
    label: 'OpenCode Go',
    auth: ['cookie'],
    match: {
      namePattern: '\\bopencode\\b',
    },
    // 资源维度：额度挂在具体 workspace 下（同一 cookie 可有多个 workspace），必须用户配置
    params: [
      {
        key: 'workspaceUrl',
        label: 'Workspace 地址',
        normalize: 'opencode-workspace',
        helpText: '打开 opencode.ai 控制台进入你的 workspace，从浏览器地址栏复制页面 URL（形如 https://opencode.ai/workspace/wrk_xxx/go）',
      },
    ],
    helpUrl: 'https://opencode.ai/',
    helpText: '登录 opencode.ai 后，在 DevTools → Network 选中任一请求 → 请求头里的 Cookie 整串复制（形如 name=value; name2=value2）',
  },
  {
    fetcher: 'stepfun',
    label: 'StepFun Step Plan',
    auth: ['cookie'],
    match: {
      baseUrlPattern: 'stepfun.com',
      namePattern: '\\bstepfun\\b|阶跃',
    },
    helpUrl: 'https://platform.stepfun.com/account-overview',
    helpText: '登录 platform.stepfun.com 后，在 DevTools → Network 选中任一请求 → 请求头里的 Cookie 整串复制（形如 name=value; name2=value2；套餐额度查询只认浏览器 Cookie，API Key 不被接受）',
  },
  {
    fetcher: 'opendesign',
    label: 'OpenDesign Coding Plan',
    auth: ['cookie'],
    match: {
      baseUrlPattern: 'open-design.ai',
      namePattern: '\\bopendesign\\b',
    },
    // 资源维度：额度挂在具体 workspace 下（2026-10-18 实测：额度查询 API 只认
    // better-auth 会话 cookie，provider 的 sk-amr API Key 不被接受；workspace 由
    // URL 路径决定，x-vela-workspace-id 请求头非必需）
    params: [
      {
        key: 'workspaceUrl',
        label: 'Workspace 地址',
        normalize: 'opendesign-workspace',
        helpText: '在浏览器 DevTools 的 Network 面板找任意 amr-api 请求，复制其 URL 中的 workspace id（形如 amr-api.open-design.ai/api/v1/workspaces/<id>/billing/coding-plan-usage）',
      },
    ],
    helpUrl: 'https://open-design.ai/',
    helpText: '登录 open-design.ai 后，在浏览器 DevTools 的 Network 面板找任意 amr-api 请求，复制其 Cookie 与 x-vela-workspace-id（workspace id）',
  },
]

/** 非数组、非 null 的对象（wire 形状守卫共用）。 */
function isPlainRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** 可选字段校验：缺省放行（远程向后兼容），提供则必须是指定基元类型。 */
function isOptionalField(record: Record<string, unknown>, key: string, type: 'string' | 'boolean'): boolean {
  const value = record[key]
  return value === undefined || typeof value === type
}

/** param spec 元素校验（key 必填非空串；可选字符串字段提供即校验；normalize 封闭词表）。 */
const PARAM_NORMALIZE_KINDS: readonly string[] = ['opencode-workspace', 'opendesign-workspace', 'raw']

function isQuotaParamSpec(v: unknown): boolean {
  if (!isPlainRecord(v)) return false
  if (typeof v['key'] !== 'string' || v['key'] === '') return false
  // 可选字段统一走 isOptionalField（缺省放行 / 提供即校验，与 match/顶层同口径）
  if (!isOptionalField(v, 'label', 'string')) return false
  if (!isOptionalField(v, 'placeholder', 'string')) return false
  if (!isOptionalField(v, 'helpText', 'string')) return false
  if (!isOptionalField(v, 'required', 'boolean')) return false
  return v['normalize'] === undefined || (typeof v['normalize'] === 'string' && PARAM_NORMALIZE_KINDS.includes(v['normalize']))
}

/** params 段校验：数组 + 元素逐个过 spec guard + key 唯一（重复键会让持久化 Map 互相覆盖）。 */
function isParamsValid(v: unknown): boolean {
  if (v === undefined) return true
  if (!Array.isArray(v)) return false
  const specs = v as unknown[]
  if (!specs.every(isQuotaParamSpec)) return false
  const keys = specs.map((s) => (s as { key: string }).key)
  return new Set(keys).size === keys.length
}

/**
 * QuotaPreset wire 形状守卫（remote-config presets 段元素校验用）。
 *
 * 必填字段（fetcher/label/auth/match）缺失或类型漂移即拒——匹配链对 match 解构、
 * QuotaService 按 auth 数组序解析凭证、UI 渲染 label/helpUrl，畸形元素漏到消费侧
 * 会在运行期抛 TypeError。可选字段（helpUrl/helpText/params）提供即校验；未知字段放行
 * （远程向后兼容扩展不被旧版本整体拒用）。auth 元素只校验 string 不锁
 * 'api-key'|'oauth'|'cookie' 值域：新形态由旧版本 auth 数组判定与凭证解析链自然降级，
 * 不因单个未知值拒用整个 presets 表。
 */
export function isQuotaPreset(v: unknown): v is QuotaPreset {
  if (!isPlainRecord(v)) return false
  if (typeof v['fetcher'] !== 'string' || v['fetcher'] === '') return false
  if (typeof v['label'] !== 'string') return false
  if (!Array.isArray(v['auth']) || !v['auth'].every((k) => typeof k === 'string')) return false
  const match = v['match']
  if (!isPlainRecord(match)) return false
  return (
    isOptionalField(match, 'baseUrlPattern', 'string') &&
    isOptionalField(match, 'namePattern', 'string') &&
    isOptionalField(v, 'helpUrl', 'string') &&
    isOptionalField(v, 'helpText', 'string') &&
    isParamsValid(v['params'])
  )
}

/**
 * 读取侧空态回落：presets 合并视图尚未下发时取编译期基线。
 *
 * 判据取「空态」而非 nullish：settings-store 的 quotaPresets 初值是 `[]`（非 undefined），
 * `??` 只覆盖 undefined——空数组会原样穿过回落表达式，额度类型下拉与 matchedPreset 在
 * RPC 未回包 / 拉取失败 / mock 层时永久为空（C-proc-21：用户可见的辅助能力失败必须有
 * 可见反馈，禁静默空值）。空态在读取侧与「权威显式下发空表」不可区分，统一回落基线
 * （基线即无远程覆盖时的合并视图原形，见 QUOTA_PRESETS 注释）。
 *
 * 与 runtime listQuotaPresets()（远程 presets ?? 基线）同口径：runtime 侧恒非空，
 * 前端读取侧经本函数补齐同一判据，展示链与匹配链读同一权威。
 */
export function resolveQuotaPresets(presets: readonly QuotaPreset[] | undefined): readonly QuotaPreset[] {
  return presets?.length ? presets : QUOTA_PRESETS
}

/**
 * 根据 provider 的 baseUrl 和 name 匹配预设。
 *
 * @param provider - 提供 baseUrl 和/或 name 的对象（来自 ProviderInfo）。
 * @param presets - 候选预设集（必填，无缺省）：调用方显式决定权威来源——runtime 侧传
 *   listQuotaPresets()「基线 ⊕ 远程」合并视图 / 前端传 RPC config.listQuotaPresets
 *   下发数组。契约必填化（原缺省回落编译期基线）堵「漏传静默读基线」通道：远程 presets
 *   下发后匹配链与自动开启判定链必须与展示链读同一权威。
 * @returns 匹配到的 QuotaPreset，或 undefined（无匹配）。
 */
export function matchQuotaPreset(
  provider: {
    baseUrl?: string
    name?: string
  },
  presets: readonly QuotaPreset[],
): QuotaPreset | undefined {
  const { baseUrl, name } = provider
  if (!baseUrl && !name) return undefined

  const normalizedBaseUrl = baseUrl?.toLowerCase() ?? ''
  const normalizedName = name?.toLowerCase() ?? ''

  for (const preset of presets) {
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
