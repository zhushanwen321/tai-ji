/**
 * settings 组件注入 key（W3 · C-W3-2 决议）。
 *
 * ui 包零 renderer import 铁律：ProviderEditModal 消费的 renderer 侧 useQuotaConfigure /
 * useToast 经 provide/inject 注入，ui 只持有类型别名 + inject helper（缺失 noop fallback +
 * dev console.warn，保证组件不因注入缺失崩溃）。SourceImportSection 的 detectSources 不走
 * 注入：SettingsTransport seam 已有该方法，组件直接 getSettingsTransport()（ui→core 合法
 * 依赖方向，[C3] 走 seam）。
 *
 * 注入方向：renderer 壳（ProviderPage/SettingsResourcePage 等）→ provide 真实实现；
 * ui 组件 → inject 取用。与 core 的 TC4 t 注入模式一致（依赖经边界注入，不越界 import）。
 *
 * 类型来源：QuotaPreset / ProviderInfo 来自 @taiji/shared（ui 已依赖）；
 * QuotaConfigureModule / QuotaConfigureFactory 契约来自 @taiji/core（[C1] deep module
 * 契约 SSOT——原 QuotaConfigureState 27 成员扁平契约 + NOOP_FACTORY 逐名镜像已收拢，
 * 见 core quota-configure-module.ts 文件头注释）。
 */
import { inject } from 'vue'
import type { ComputedRef, InjectionKey } from 'vue'
import type { ProviderEditModelsModule, QuotaConfigureFactory, QuotaConfigureModule } from '@taiji/core'

// 契约 SSOT re-export（消费方 CodingPlanSection / ModelListSection / settings barrel 经本模块取类型）
export type { ProviderEditModelsModule, QuotaConfigureFactory, QuotaConfigureModule }

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

// ── ② Quota Configure deep module（C1 收拢）──
/**
 * seam 两段（typed InjectionKey，零 renderer import）：
 * - renderer 壳（ProviderPage / useSettingsShell）provide `QuotaConfigureFactory`
 *   （module 实现工厂，入参见 core QuotaConfigureInputs）
 * - ProviderEditBody 按当前编辑体物化实例并 provide `QUOTA_CONFIGURE_MODULE_KEY`，
 *   CodingPlanSection 跨过该 seam 直接持有实例（原 23 props / 7 emits / 28 名解构管道已删）
 *
 * DI 失败语义（与 ①③ 的 noop fallback 刻意不同——额度配置没有「无状态可用」的降级形态）：
 * - 工厂缺失（壳未接线）→ 返回 undefined，ProviderEditBody 不渲染 CodingPlanSection（v-if）
 * - module 缺失（CodingPlanSection 脱离 ProviderEditBody 单独渲染）→ 抛错：空壳渲染会把
 *   接线错误伪装成「功能正常但没数据」，loud fail 才能让漏接在测试/开发期立刻可见
 */
export const QUOTA_CONFIGURE_FACTORY_KEY: InjectionKey<QuotaConfigureFactory> =
  Symbol('quotaConfigureFactory')

export function useQuotaConfigureFactory(): QuotaConfigureFactory | undefined {
  const v = inject(QUOTA_CONFIGURE_FACTORY_KEY, null)
  if (!v && import.meta.env?.dev) {
    console.warn('[ui/settings] QUOTA_CONFIGURE_FACTORY_KEY not provided; CodingPlanSection will not render')
  }
  return v ?? undefined
}

export const QUOTA_CONFIGURE_MODULE_KEY: InjectionKey<QuotaConfigureModule> =
  Symbol('quotaConfigureModule')

export function useQuotaConfigureModule(): QuotaConfigureModule {
  const v = inject(QUOTA_CONFIGURE_MODULE_KEY, null)
  if (!v) {
    throw new Error('[ui/settings] QUOTA_CONFIGURE_MODULE_KEY not provided; CodingPlanSection must render under ProviderEditBody')
  }
  return v
}

// ── ③ 目录选择 dialog（§3 双方式添加：Electron showOpenDialog 经 renderer provide）──
// ui 包零 renderer import：LoadPaths 的「选择目录」按钮调此注入函数打开 OS 目录选择器。
// renderer 壳（SettingsResourcePage）provide 真实实现（window.electronAPI.chooseDirectory）。
// 缺失时返回 undefined——LoadPaths 据此把「选择目录」按钮置 disabled（UI 完整，IPC 接线由后续 wave）。
export type ChooseDirectoryFn = () => Promise<string | null>

export const SETTINGS_CHOOSE_DIRECTORY_KEY: InjectionKey<ChooseDirectoryFn> =
  Symbol('settingsChooseDirectory')

export function useChooseDirectory(): ChooseDirectoryFn | undefined {
  return inject(SETTINGS_CHOOSE_DIRECTORY_KEY, undefined)
}

// ── ④ 模型清单 CRUD module（C4：原 provide('modelListDeps') 字符串 key + 非空断言的无型缝）──
/**
 * ModelListSection 的注入面 = core 模型 CRUD module（ProviderEditModelsModule）+ providerApi
 * 派生（compat 字段集判定的 provider 级回退，ProviderEditBody 按当前编辑体装配）。
 * 原 11 成员逐名 provide 收编为「整 module 实例 + 1 个派生位」——与 ② QuotaConfigure seam
 * 同范式（跨 seam 直接持有 module 实例）。
 */
export interface ModelListDeps extends ProviderEditModelsModule {
  /** provider 级 api（model 级 api 缺失时的回退，用于 compat 字段集判断） */
  providerApi: ComputedRef<string | undefined>
}

export const MODEL_LIST_DEPS_KEY: InjectionKey<ModelListDeps> = Symbol('modelListDeps')

// DI 失败语义（与 ② module 缺失同裁决）：ModelListSection 脱离 ProviderEditBody 单独渲染是
// 接线错误——抛错 loud fail，禁止空壳渲染把漏接伪装成「功能正常但没数据」。
export function useModelListDeps(): ModelListDeps {
  const v = inject(MODEL_LIST_DEPS_KEY, null)
  if (!v) {
    throw new Error('[ui/settings] MODEL_LIST_DEPS_KEY not provided; ModelListSection must render under ProviderEditBody')
  }
  return v
}
