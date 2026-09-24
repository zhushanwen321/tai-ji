/**
 * QuotaConfigureModule —— 「Coding Plan 额度查询」配置 deep module 的对外契约。
 *
 * [C1 架构收拢] 原 QuotaConfigureState 是 27 成员扁平接口，被逐名镜像 4 跳
 * （core 契约 → ui NOOP_FACTORY 逐名镜像 → ProviderEditBody 28 名解构 → CodingPlanSection
 * 23 props / 7 emits）：interface 与 implementation 同宽，加一个字段要改 5 处。
 * 现契约收窄为消费方（CodingPlanSection）的真实消费面 —— 3 个状态透镜 + 3 个写动作；
 * 规则（类型切换清凭证草稿、齐备性判定、失败原因归一、provider 凭据警示分档）全部
 * 内化为 implementation，UI 只做布局与 i18n 映射。
 *
 * 注入 seam（typed InjectionKey，见 ui/features/settings/injection-keys.ts）：
 * renderer 壳 provide `QuotaConfigureFactory`（本契约的实现工厂）→ ProviderEditBody
 * 按当前 provider 物化实例并 provide `QUOTA_CONFIGURE_MODULE_KEY` → CodingPlanSection
 * 跨过该 seam 直接持有实例。
 *
 * 行为契约（coding-plan-quota-config-ux §7.1/§7.2，收拢前后不变）：
 * - 类型 / 凭证 / Workspace 是草稿，经 saveAndTest 一次点击提交（D2/D5）；
 *   开关退化为纯配置位、即时落盘（D4）
 * - 密文字段（cookie / 专属 Key）取「草稿 ∨ 已保存」并集，明文 Workspace 只看草稿（D13）
 * - readiness 是「保存并测试」按钮禁用状态的唯一依据，也是字段徽标 / 提示的唯一真相源（D1）
 * - cookie 输入去掩码：草稿只放用户真实输入，保存成功后清空（D7）
 * - 凭证来源显式化（D3）：UI 显示的选择与 runtime 使用的凭证由同一份持久化数据驱动
 */
import type { Ref } from 'vue'
import type {
  NormalizedQuotaRow,
  ProviderInfo,
  QuotaCredentialSource,
  QuotaPreset,
} from '@taiji/shared'
import type { Translate } from './provider-edit-types'

/** 测试查询状态 */
export type QuotaTestStatus = 'idle' | 'loading' | 'success' | 'error'

/**
 * 齐备性缺口项（UI 据此渲染字段级徽标 / 提示）。四态显式命名：
 * - 'type'      : 尚未选择查询类型（或草稿类型不在 QUOTA_PRESETS）—— UI 走 D8 的
 *                 「只渲染下拉 + 一句说明」，不渲染按钮，故该值**不配 i18n 文案**，
 *                 只用于让契约自解释。
 * - 'cookie' / 'apiKey' / 'workspace' : 已选类型下的具体缺口，各配一条 i18n 提示。
 */
export type ReadinessMissing = 'type' | 'cookie' | 'apiKey' | 'workspace'

/** 类型下拉项（QUOTA_PRESETS 映射） */
export interface QuotaFetcherOption {
  value: string
  label: string
}

/**
 * 齐备性派生量（D1）——「保存并测试」按钮禁用状态的唯一依据（ready）+ 字段徽标 / 提示的
 * 唯一真相源（missing）。missing 顺序 = 判定项构造序（凭证档在前、workspace 在后）：
 * 凭证类字段取「草稿 ∨ ¬类型已变 ∧ 已保存」并集，workspace 只看草稿（D13）。
 */
export interface QuotaReadiness {
  ready: boolean
  missing: ReadinessMissing[]
}

/**
 * 「用 Provider 凭据」来源提示的语义分档（D3 + §7.4）：i18n 文案在 ui 侧映射。
 * providerOauth / providerApiKey 区分 Provider 侧凭据形态（OAuth 已登录 vs API Key）。
 */
export type QuotaSourceHint = 'exclusive' | 'providerOauth' | 'providerApiKey'

/**
 * Provider 凭据警示分档（§7.4 跨区块时序）：
 * - 'pendingSave' : provider 表单草稿已填 Key 但未保存 provider（runtime 读不到），
 *                   文案须指引「先保存 provider 配置」
 * - 'missing'     : provider 侧确实无可用凭据
 * - null          : 不警示（有凭据 / 已改用专属 Key）
 */
export type QuotaProviderWarning = 'pendingSave' | 'missing'

/**
 * 失败原因归一（A2-4 reason × cookie 形态）。i18n 文案与恢复指引在 ui 侧按
 * (kind, cookieAuth) 映射；'generic' = 无专属恢复指引（transport 抛错 / 未分类 reason），
 * UI 回退 message 或通用文案。
 */
export type QuotaFailureKind =
  | 'unauthorized'
  | 'network'
  | 'no-subscription'
  | 'parse'
  | 'not-configured'
  | 'no-credential'
  | 'generic'

/** 归一后的失败态 */
export interface QuotaFailure {
  kind: QuotaFailureKind
  /** cookie 类形态（恢复指引文案分叉 + 「更新 Cookie」入口同源） */
  cookieAuth: boolean
  /** kind==='generic' 时的兜底消息（如 transport 抛错 message）；可为空串 */
  message: string
}

/**
 * 输入草稿（v-model 直绑，「保存并测试」一次提交）。
 * 类型草稿不在其中 —— 它有写入规则（同值短路 / 真变清凭证草稿），写入必须经 selectType。
 */
export interface QuotaDraftInput {
  /** cookie 输入草稿（cookie 类 provider 专用）。D7 去掩码：永远只放用户真实输入，
   *  保存成功后清空；「已配置」由 readiness 驱动独立标记 */
  cookie: string
  /** 专属 API Key 输入草稿（api-key 类）。密文不回显：保存时只在草稿非空才传，
   *  空 = 未填新值（来源选择由 credentialSource 显式表达，D3） */
  apiKey: string
  /** 凭证来源选择（D3，api-key 类专用；cookie 类不适用）。切换只改这一个字段、
   *  不删专属 Key 文件（可逆） */
  credentialSource: QuotaCredentialSource
  /** Workspace 地址输入草稿（资源维度 fetcher 如 opencode-go）。D13：明文回显、
   *  判定只看草稿（屏幕即真相）；接受完整 URL 或裸 wrk_ id，保存时归一化 */
  workspace: string
}

/** 展示派生面（只读；全部由 module 派生，UI 只做 i18n 映射与布局） */
export interface QuotaSectionView {
  /** 类型选择区（D5/D8） */
  type: {
    /** 类型草稿（未选择 = undefined）；写入走 selectType */
    selected: string | undefined
    options: readonly QuotaFetcherOption[]
    /** D8 分层判据：类型未定（草稿空 ∨ 草稿类型不在 QUOTA_PRESETS）→ 只渲染下拉 + 说明 */
    undetermined: boolean
  }
  /** 启用位（D4 纯配置位；写入走 setEnabled） */
  enabled: boolean
  /** 是否正在保存 / 查询配置（按钮禁用 + 进行中间文案） */
  configuring: boolean
  /** 配置类错误文案（D9 统一 i18n 出口） */
  configureError: string
  /** 齐备性（D1）：按钮门控 + 字段徽标 / 提示同源 */
  readiness: QuotaReadiness
  /** 凭证区（D3/D7/§7.4） */
  credential: {
    /** 输入形态：cookie 类 → cookie 输入框；否则 → 来源分段 + 专属 Key */
    form: 'cookie' | 'apiKey'
    /** 专属 Key 对当前 fetcher 是否适用（§7 残留 11）：false → 来源分段与专属 Key 块不渲染 */
    exclusiveApplicable: boolean
    /** Provider 侧是否有可用凭据（「用 Provider 凭据」分段项可点性） */
    providerAvailable: boolean
    /** 来源提示分档（D3 + §7.4：Provider 侧 OAuth / API Key 文案分叉） */
    sourceHint: QuotaSourceHint
    /** Provider 凭据警示分档（null = 不渲染） */
    providerWarning: QuotaProviderWarning | null
  }
  /** workspace 地址区 */
  workspace: {
    /** 当前 fetcher 是否需要 workspace 配置（QuotaPreset.requiresWorkspace；false = 隐藏输入框） */
    required: boolean
  }
  /** 帮助链接（基于当前选中 fetcher；null = 不渲染） */
  help: { url: string; text: string } | null
}

/** 测试结果面（只读） */
export interface QuotaTestView {
  status: QuotaTestStatus
  /** 额度数据（成功行；失败态下旧缓存保留在此，经「查看上次成功数据」展开） */
  row: NormalizedQuotaRow | null
  /** 最近一次成功查询时间戳（ms） */
  lastFetchAt: number | null
  /** 归一后的失败态（null = 无失败） */
  failure: QuotaFailure | null
}

/**
 * module 工厂输入（业务输入归 ProviderEditBody 按当前编辑体装配；t 由壳层统一注入）。
 * providerApiKeyDraft 是 **carry-in 槽位**：「Provider 凭据已填但未保存」（§7.4）的判定
 * 需要 provider 表单草稿，而表单归 useProviderEdit（U5 领地）——由编辑体把草稿 ref 传进来，
 * module 不自造该值。判定式（排除清除哨兵）在 module 内。
 */
export interface QuotaConfigureInputs {
  /** i18n 翻译函数（TC4 注入，与 provider-edit 五模块 deps.t 同范式；失败文案渲染唯一出口） */
  t: Translate
  /** 当前编辑 provider 的已保存快照（草稿回填与「∨ 已保存」并集读它） */
  provider: Ref<ProviderInfo | null>
  /** 自动匹配的 QuotaPreset（matchQuotaPreset 命中；类型草稿默认值来源） */
  preset: Ref<QuotaPreset | undefined>
  /** Provider 侧 OAuth 登录态（来源提示分档：OAuth / API Key） */
  providerOauthPresent: Ref<boolean>
  /** provider 表单 API Key 草稿（含「清除」哨兵语义） */
  providerApiKeyDraft: Ref<string>
}

/**
 * 壳层工厂入参：业务输入之外，t 由壳层包装函数统一注入（useSettingsShell provide
 * `(inputs) => useQuotaConfigure({ ...inputs, t: i18n.global.t })`），ProviderEditBody
 * 物化点保持纯业务输入、不感知 i18n 装配。
 */
export type QuotaConfigureFactoryInputs = Omit<QuotaConfigureInputs, 't'>

/** QuotaConfigure module 实现工厂（renderer useQuotaConfigure；壳层包装注入 t） */
export type QuotaConfigureFactory = (inputs: QuotaConfigureFactoryInputs) => QuotaConfigureModule

/**
 * QuotaConfigure module 对外契约 —— CodingPlanSection 的全部消费面。
 *
 * 测试面即本接口（interface is the test surface）：模块行为（readiness 矩阵 /
 * payload 构造 / 失败归一 / 各类守卫）只经本接口打点，不窥内部 ref。
 */
export interface QuotaConfigureModule {
  /** 输入草稿（v-model 直绑） */
  readonly draft: Ref<QuotaDraftInput>
  /** 展示派生面 */
  readonly view: Ref<QuotaSectionView>
  /** 测试结果面 */
  readonly test: Ref<QuotaTestView>
  /**
   * 写入类型草稿（D5 守卫落在值上）：非字符串守卫（reka Select 的宽联合 payload）、
   * 同值短路（同值选中不得清掉用户未提交的输入）、类型**真变**清凭证草稿
   * （cookie / 专属 Key；Workspace 草稿不清）
   */
  selectType(value: unknown): void
  /**
   * 拨动启用状态（D4）：纯配置位——只写 enabled 一个字段（其余参数一律缺省 = 不变），
   * 乐观更新 + 失败回滚，无查询副作用。setEnabled(false) 同步失效 renderer quotaStore
   * 与 runtime lastFailure（§7.1 副作用表）
   */
  setEnabled(next: boolean): Promise<void>
  /**
   * 保存并测试（D2）：先把草稿落盘（quota.configure），成功后再触发查询（quota.refresh）。
   * 类型发生变更时清该 provider 的 QuotaCache 条目（§7.1 副作用表）
   */
  saveAndTest(): Promise<void>
}
