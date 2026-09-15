/**
 * QuotaConfigure 状态契约 —— renderer useQuotaConfigure 返回态与 ui 注入 key 的共享 SSOT。
 *
 * [BL round1 monorepo S] 原 ui injection-keys 逐字段手工镜像 renderer UseQuotaConfigureReturn
 * （398 行 × 2 处重复）：provide 接线的 structural typing 只能 catch 字段缺失，接口本体
 * 漂移（一侧改字段语义）编译器不守护 → 契约提升到 core，renderer 真实返回类型从本类型
 * 派生（UseQuotaConfigureReturn = QuotaConfigureState），ui injection-keys import 本类型，
 * 双侧同一类型消除镜像。
 *
 * 放置：core/domain/settings（core 已依赖 vue + shared；renderer/ui 均依赖 core，
 * 对齐 core domain 类型放置惯例）。
 *
 * 契约 v2（coding-plan-quota-config-ux §7.1）：类型/凭证/Workspace 改为草稿模型，由
 * 「保存并测试」一次点击提交（D2/D5）；开关退化为纯配置位（D4）；凭证来源显式化并持久化
 * （D3）；cookie 输入去掩码（D7）；新增齐备性派生量 readiness（D1）。旧动作成员
 * selectFetcher / toggleEnabled / saveCookie / saveApiKey / saveWorkspace / testQuery 与
 * 合并态标记 apiKeyConfigured 移除，消费方按 §7.1 两表切换。
 */
import type { Ref } from 'vue'
import type {
  NormalizedQuotaRow,
  QuotaAuthKind,
  QuotaCredentialSource,
  QuotaFetchFailureReason,
} from '@taiji/shared'

/** 测试查询状态 */
export type QuotaTestStatus = 'idle' | 'loading' | 'success' | 'error'

/**
 * 齐备性缺口项（UI 据此渲染字段级提示）。四态显式命名：
 * - 'type'      : 尚未选择查询类型 —— UI 走 D8 的「只渲染下拉 + 一句说明」，不渲染按钮，
 *                 故该值**不配 i18n 文案**，只用于让契约自解释（避免消费方把它误读为
 *                 「齐备但不可点」或渲染出「参数齐全后可点」这类空提示）。
 * - 'cookie' / 'apiKey' / 'workspace' : 已选类型下的具体缺口，各配一条 i18n 提示。
 */
export type ReadinessMissing = 'type' | 'cookie' | 'apiKey' | 'workspace'

/** QuotaConfigure 返回态（renderer 实现见 useQuotaConfigure composable） */
export interface QuotaConfigureState {
  /**
   * 类型草稿（未选择 = undefined）。D5：不再即时落盘，写入即改草稿，经 saveAndTest
   * 一次性提交；类型真正变更时清凭证草稿（Cookie / 专属 Key，Workspace 不清）
   */
  fetcherId: Ref<string | undefined>
  /** 下拉框选项列表（QUOTA_PRESETS 映射） */
  fetcherOptions: Array<{ value: string; label: string }>
  /**
   * 是否启用额度查询（Switch 双向绑定）。D4：纯配置位——唯一语义是「要不要在对话框
   * 容量浮层里展示」，拨动经 setEnabled 即时落盘，不进入草稿、无网络副作用
   */
  enabled: Ref<boolean>
  /**
   * cookie 输入草稿（cookie 类 provider 专用）。D7 去掩码：永远只放用户真实输入，
   * 保存成功后清空；「已配置」由消费方读 provider.quota.cookieSet 渲染独立标记
   */
  cookieInput: Ref<string>
  /**
   * 专属 API Key 输入草稿（api-key 类）。密文不回显：保存时只在草稿非空才传，
   * 空 = 未填新值（来源选择由 credentialSource 显式表达，不再是「留空 = 复用
   * provider.apiKey」的隐式约定，D3）
   */
  apiKeyInput: Ref<string>
  /**
   * 凭证来源选择（D3，api-key 类专用；cookie 类不适用）。UI 显示的选择与 runtime
   * 使用的凭证由同一份持久化数据驱动；切换只改这一个字段、不删专属 Key 文件（可逆）
   */
  credentialSource: Ref<QuotaCredentialSource>
  /** Provider 侧是否有可用凭据（决定「用 Provider 凭据」分段项是否可点） */
  providerCredentialAvailable: Ref<boolean>
  /** 专属 Key 是否已保存（D3：单独表达，不再与 provider 侧合并） */
  quotaApiKeyConfigured: Ref<boolean>
  /** Provider 侧凭据「已填但未保存」（用于文案区分，见设计 §7.4） */
  providerCredentialPendingSave: Ref<boolean>
  /**
   * Workspace 地址输入草稿（资源维度 fetcher 如 opencode）。D13：明文回显、判定只看
   * 草稿（屏幕即真相）；接受完整 URL 或裸 wrk_ id，保存时归一化为规范 URL
   */
  workspaceInput: Ref<string>
  /** 是否已配置 workspace（provider.quota.workspace 非空） */
  workspaceConfigured: Ref<boolean>
  /** 当前 fetcher 是否需要 workspace 配置（QuotaPreset.requiresWorkspace；false = 隐藏输入框） */
  needsWorkspace: Ref<boolean>
  /**
   * 齐备性派生量（D1）——「保存并测试」按钮禁用状态的唯一依据。判定规则见设计 §7.2：
   * 凭证类字段取「草稿 ∨ 已保存」并集并按凭证归属过滤，workspace 只看草稿
   */
  readiness: Ref<{ ready: boolean; missing: ReadinessMissing[] }>
  /** 测试查询状态 */
  testStatus: Ref<QuotaTestStatus>
  /** 测试查询错误信息（testStatus='error' 且无 reason 时有值） */
  testError: Ref<string>
  /** 最近一次成功查询的额度数据（失败态下旧缓存保留在此，经「查看上次成功数据」展开） */
  quotaData: Ref<NormalizedQuotaRow | null>
  /** 最后成功查询时间戳（ms） */
  lastFetchAt: Ref<number | null>
  /** 当前选中 fetcher 是否为 cookie 类认证（源实现为 computed，类型兼容 Ref） */
  isCookieAuth: Ref<boolean>
  /** 当前选中 fetcher 的凭证能力声明（B-3：凭证态按 fetcher.auth 渲染；源实现为 computed） */
  authKinds: Ref<readonly QuotaAuthKind[]>
  /** 最近一次查询失败原因（A2-4 reason 透传；null = 无失败） */
  testFailReason: Ref<QuotaFetchFailureReason | null>
  /** 帮助链接（基于当前选中 fetcher；源实现为 computed） */
  helpUrl: Ref<string | undefined>
  /** 帮助文案（基于当前选中 fetcher；源实现为 computed） */
  helpText: Ref<string | undefined>
  /** 是否正在保存配置 */
  configuring: Ref<boolean>
  /** 保存配置错误 */
  configureError: Ref<string>
  /**
   * 切换启用状态（D4）：只写 enabled 一个字段（其余参数一律缺省 = 不变），无网络副作用。
   * setEnabled(false) 同步失效 renderer quotaStore 与 runtime lastFailure（§7.1 副作用表）
   */
  setEnabled: (v: boolean) => Promise<void>
  /**
   * 保存并测试（D2）：先把草稿落盘（quota.configure），成功后再触发查询（quota.refresh）。
   * 类型发生变更时 runtime 清该 provider 的 QuotaCache 条目，renderer quotaStore 同步失效
   * （§7.1 副作用表）
   */
  saveAndTest: () => Promise<void>
  /** 重置状态（provider 切换时调用） */
  reset: () => void
}
