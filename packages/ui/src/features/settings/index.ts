/**
 * ui 包 settings 表单组件 barrel（W3 · p3-strangler-domains::settings）。
 *
 * 从 renderer components/settings/ 迁入 11 个表单组件 + apply-system-to-dom 纯函数 + 注入 key。
 * 消费方（renderer 壳 ProviderPage 等）经 '@taiji/ui/features/settings' 子路径 import 组件，
 * 并 provide 注入 key（toast/quota），ui 组件 inject 取用，零 renderer import；SourceImportSection
 * 的 detectSources 不走注入，直接取 SettingsTransport seam（见 SourceImportSection.vue）。
 *
 * 详细迁移决策见 wave w3-ui-settings-components 的 clarify/design-review。
 * 目录分层（slice ui-settings-dirs）：组件按域归 provider/coding-plan/compat/common，
 * apply-system-to-dom.ts + injection-keys.ts 留顶层（跨域共享非组件文件）。
 */
export { default as CompatField } from './compat/CompatField.vue'
export { default as CompatEditor } from './compat/CompatEditor.vue'
export { default as CodingPlanSection } from './coding-plan/CodingPlanSection.vue'
export { default as GroupCard } from './common/GroupCard.vue'
export { default as LoadPaths } from './common/LoadPaths.vue'
export { default as ModelListSection } from './common/ModelListSection.vue'
export { default as PresetModeSection } from './coding-plan/PresetModeSection.vue'
export { default as ProviderEditBody } from './provider/ProviderEditBody.vue'
export { default as ProviderImportMenu } from './provider/ProviderImportMenu.vue'
export { default as ProviderImportPreviewDialog } from './provider/ProviderImportPreviewDialog.vue'
export { default as OAuthDialog } from './provider/OAuthDialog.vue'
export { default as ProviderTemplatePicker } from './provider/ProviderTemplatePicker.vue'
export { default as ProviderQuickSetup } from './provider/ProviderQuickSetup.vue'
export { default as SoundPreviewButton } from './common/SoundPreviewButton.vue'
export { default as ScopedModelSection } from './common/ScopedModelSection.vue'
export type { ScopedRenderItem, SelectableModel } from './common/scoped-model-types'
export { default as SourceImportSection } from './common/SourceImportSection.vue'

export {
  applySystemToDom,
  resolveTheme,
  type ApplySystemToDomDeps,
} from './apply-system-to-dom'

export {
  SETTINGS_TOAST_KEY,
  QUOTA_CONFIGURE_FACTORY_KEY,
  QUOTA_CONFIGURE_MODULE_KEY,
  SETTINGS_CHOOSE_DIRECTORY_KEY,
  useSettingsToast,
  useQuotaConfigureFactory,
  useQuotaConfigureModule,
  useChooseDirectory,
  type SettingsToast,
  type QuotaConfigureFactory,
  type QuotaConfigureModule,
  type ChooseDirectoryFn,
} from './injection-keys'
