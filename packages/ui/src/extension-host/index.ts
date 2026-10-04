/**
 * ui 包 extension-host 层导出面（W4 · T4 + W3 · T2/T3 + W2 · T6）。
 *
 * 导出 PluginSettingsPage（插件管理页，IF7）+ 其数据源接口 + StatusBar/ViewHost
 * （W3：AC5 状态栏 + AC9 view 渲染侧，C3/C4 契约）及其注入接口 +
 * CompanionBand/PermissionRequestDialog（W2：AC3 渲染侧 + AC4 权限回路）及其注入契约。
 * 真实数据源实现由壳（P5）provide（接 runtime config.plugins 订阅 + S2
 * status-bar-controller/view-host-store/contribution-registry + message-bus-bridge
 * / runtime WS 通道），本包只定义契约与组件本体。
 * 壳特有装配（bus 来源选择 / provide 时机）留在各壳，本包另提供双壳（桌面 renderer /
 * 移动 mobile-renderer）逐字节共享的纯翻译件（shell-adapters：WS source 适配 +
 * CompanionBand source/transport 工厂；permission-request-controller：权限审批编排
 * 状态机 factory，两壳薄接线消费）。
 */
export { default as PluginSettingsPage } from './PluginSettingsPage.vue'
export {
  PluginSettingsDataSourceKey,
  type PluginSettingsDataSource,
  type ContributionInfo,
} from './plugin-settings-data-source'
export { default as StatusBar } from './StatusBar.vue'
export {
  STATUS_BAR_SOURCE_KEY,
  type StatusBarSource,
  type StatusBarEntry,
} from './status-bar-source'
export { default as ViewHost } from './ViewHost.vue'
export {
  VIEW_HOST_SOURCE_KEY,
  type ViewHostSource,
  type ViewCacheEntry,
} from './view-host-source'
export { default as CompanionBand } from './CompanionBand.vue'
export {
  DIALOG_REQUEST_SOURCE_KEY,
  UI_RESPONSE_TRANSPORT_KEY,
  OVERLAY_LIFECYCLE_KEY,
  type DialogRequest,
  type DialogRequestOption,
  type DialogRequestSource,
  type UiResponseTransport,
  type OverlayLifecycleSource,
  type OverlayState,
} from './companion-band-source'
export { default as PermissionRequestDialog } from './PermissionRequestDialog.vue'
export {
  PERMISSION_TRANSPORT_KEY,
  type PermissionTransport,
} from './permission-transport'
export {
  createPermissionRequestController,
  type PermissionRequestController,
  type PermissionRequestState,
} from './permission-request-controller'
export { default as L2TabBar } from './L2TabBar.vue'
export type { L2TabItem } from './l2-tab-item'
export { default as PluginViewContainer } from './PluginViewContainer.vue'
export {
  VIEWS_SOURCE_KEY,
  type PluginViewsSource,
  type PluginViewSummary,
} from './views-source'
export {
  convertToDialogRequest,
  createCompanionDialogAdapters,
  createUiResponseTransport,
  createWsPluginMessageSource,
  type CompanionDialogAdapters,
  type CompanionDialogAdaptersOptions,
  type CompanionDialogAdaptersTesting,
} from './shell-adapters'
