/**
 * settings 域入口 —— @taiji/core 的 settings 域（p3-strangler-domains W1/W2）。
 *
 * 承接架构文档 §10.2（旧层 → core/domain/* 映射）：renderer stores/settings.ts +
 * composables/features/useSettings.ts + useProviderEdit.ts 迁移为纯 factory/模块级单例；
 * IF1 SettingsTransport（TC1 后端通道）；IF3 system-storage（KVStorage 持久化）。
 * renderer 旧实现保留至消费方全部迁移后删除（strangler 逐域绞杀，W4）。
 *
 * [C4] use-provider-edit 拆分为 3 组 module + 纯 reconcile 核后，导出面归位各 module 文件
 * （types / reconcile / models / form / discover），facade 只保留装配入口。
 */
export * from './types'
export * from './transport'
export * from './compat-fields'
export * from './system-storage'
export * from './quota-configure-module'
export * from './settings-store'
export * from './settings-lifecycle'
export * from './provider-edit-types'
export * from './provider-edit-reconcile'
export * from './provider-edit-models'
export * from './provider-edit-form'
export * from './provider-edit-discover'
export * from './use-provider-edit'
