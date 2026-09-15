/**
 * settings 组件注入 key（W3 · C-W3-2 决议）。
 *
 * ui 包零 renderer import 铁律：ProviderEditModal/SourceImportSection 消费的 renderer 侧
 * useQuotaConfigure / useToast / config(@/api) 经 provide/inject 注入，ui 只持有类型别名 +
 * inject helper（缺失 noop fallback + dev console.warn，保证组件不因注入缺失崩溃）。
 *
 * 注入方向：renderer 壳（ProviderPage/SettingsResourcePage 等）→ provide 真实实现；
 * ui 组件 → inject 取用。与 core 的 TC4 t 注入模式一致（依赖经边界注入，不越界 import）。
 *
 * 类型来源：QuotaPreset / ProviderInfo 来自 @taiji/shared（ui 已依赖）；
 * QuotaConfigureState / QuotaTestStatus 来自 @taiji/core（[BL round1 monorepo S]
 * 契约 SSOT——原为本地逐字段镜像 renderer UseQuotaConfigureReturn，提升 core 后
 * renderer 真实返回类型亦从 core 契约派生，双侧同一类型消除镜像漂移）。
 */
import { inject, ref } from 'vue'
import type { ComputedRef, InjectionKey, Ref } from 'vue'
import type { ProviderInfo, NormalizedQuotaRow, QuotaPreset, QuotaAuthKind, QuotaCredentialSource, QuotaFetchFailureReason } from '@taiji/shared'
import type { QuotaConfigureState, QuotaTestStatus, ReadinessMissing } from '@taiji/core'

// 状态契约 SSOT re-export（消费方 CodingPlanSection / settings barrel 经本模块取类型）
export type { QuotaConfigureState, QuotaTestStatus, ReadinessMissing }

// ── ① Toast ──

export interface SettingsToast {
  error: (message: string) => void
  info: (message: string) => void
  warning: (message: string) => void
}

const NOOP_TOAST: SettingsToast = {
  error: () => {},
  info: () => {},
  warning: () => {},
}

export const SETTINGS_TOAST_KEY: InjectionKey<SettingsToast> = Symbol('settingsToast')

export function useSettingsToast(): SettingsToast {
  const v = inject(SETTINGS_TOAST_KEY, null)
  if (!v && import.meta.env?.dev) {
    console.warn('[ui/settings] SETTINGS_TOAST_KEY not provided; using noop fallback')
  }
  return v ?? NOOP_TOAST
}

// ── ② Quota Configure 工厂 ──

/** 工厂签名：(preset, providerRef) => QuotaConfigureState。与 renderer useQuotaConfigure 同构
 *  （返回态契约 QuotaConfigureState 的 SSOT 在 @taiji/core，见文件头注释）。 */
export type UseQuotaConfigureFactory = (
  preset: Ref<QuotaPreset | undefined>,
  providerRef: Ref<ProviderInfo | null>,
) => QuotaConfigureState

function noopAsync(): Promise<void> {
  return Promise.resolve()
}

// 契约 v2（coding-plan-quota-config-ux §7.1）：草稿模型 + readiness/credentialSource，
// 旧动作成员（selectFetcher/save*/testQuery/toggleEnabled）与 apiKeyConfigured 已移除
const NOOP_FACTORY: UseQuotaConfigureFactory = () => ({
  fetcherId: ref<string | undefined>(undefined),
  fetcherOptions: [],
  enabled: ref(false),
  cookieInput: ref(''),
  apiKeyInput: ref(''),
  credentialSource: ref<QuotaCredentialSource>('provider'),
  providerCredentialAvailable: ref(false),
  quotaApiKeyConfigured: ref(false),
  providerCredentialPendingSave: ref(false),
  workspaceInput: ref(''),
  workspaceConfigured: ref(false),
  needsWorkspace: ref(false),
  readiness: ref({ ready: false, missing: [] as ReadinessMissing[] }),
  testStatus: ref<QuotaTestStatus>('idle'),
  testError: ref(''),
  quotaData: ref<NormalizedQuotaRow | null>(null),
  lastFetchAt: ref<number | null>(null),
  isCookieAuth: ref(false),
  authKinds: ref<readonly QuotaAuthKind[]>([]),
  testFailReason: ref<QuotaFetchFailureReason | null>(null),
  helpUrl: ref<string | undefined>(undefined),
  helpText: ref<string | undefined>(undefined),
  configuring: ref(false),
  configureError: ref(''),
  setEnabled: noopAsync,
  saveAndTest: noopAsync,
  reset: () => {},
})

export const USE_QUOTA_CONFIGURE_KEY: InjectionKey<UseQuotaConfigureFactory> = Symbol('useQuotaConfigure')

export function useQuotaConfigureFactory(): UseQuotaConfigureFactory {
  const v = inject(USE_QUOTA_CONFIGURE_KEY, null)
  if (!v && import.meta.env?.dev) {
    console.warn('[ui/settings] USE_QUOTA_CONFIGURE_KEY not provided; using noop fallback')
  }
  return v ?? NOOP_FACTORY
}

// ── ③ Config API（@/api 的 detectSources 等）──

export interface SettingsConfigApi {
  /** 检测 source（provider/agent）目录下可导入的源。对齐 @/api config.detectSources。 */
  detectSources: () => Promise<unknown[]>
}

const NOOP_CONFIG_API: SettingsConfigApi = {
  detectSources: async () => [],
}

export const SETTINGS_CONFIG_API_KEY: InjectionKey<SettingsConfigApi> = Symbol('settingsConfigApi')

export function useSettingsConfigApi(): SettingsConfigApi {
  const v = inject(SETTINGS_CONFIG_API_KEY, null)
  if (!v && import.meta.env?.dev) {
    console.warn('[ui/settings] SETTINGS_CONFIG_API_KEY not provided; using noop fallback')
  }
  return v ?? NOOP_CONFIG_API
}

// ── ④ 目录选择 dialog（§3 双方式添加：Electron showOpenDialog 经 renderer provide）──
// ui 包零 renderer import：LoadPaths 的「选择目录」按钮调此注入函数打开 OS 目录选择器。
// renderer 壳（SettingsResourcePage）provide 真实实现（window.electronAPI.chooseDirectory）。
// 缺失时返回 undefined——LoadPaths 据此把「选择目录」按钮置 disabled（UI 完整，IPC 接线由后续 wave）。
export type ChooseDirectoryFn = () => Promise<string | null>

export const SETTINGS_CHOOSE_DIRECTORY_KEY: InjectionKey<ChooseDirectoryFn> =
  Symbol('settingsChooseDirectory')

export function useChooseDirectory(): ChooseDirectoryFn | undefined {
  return inject(SETTINGS_CHOOSE_DIRECTORY_KEY, undefined)
}

// ComputedRef 未在本文件直接使用（类型来自 vue 顶层 import），保留 import 供未来扩展。
export type { ComputedRef }
