/**
 * extension-host —— ExtensionHost 基建与注册中心（W1 barrel，W2/W3/W4 增量）。
 *
 * 已交付模块：types/InternalEventBus/createSessionScopedMap/MountPointRegistry/
 * ContributionRegistry/builtinContributions/PluginMessageSource+MockMessageSource（W1）+
 * MessageBusBridge（W2）+ CommandRegistry/ActivationManager（W3）+ StatusBarController/
 * OverlayLifecycle/ViewHostStore（W4 消费端）。AC7 边界（消费端不 import domain/stores）
 * 由 scripts/verify-extension-host-boundaries.mjs 静态检查强制。
 */
export * from './types'
export { InternalEventBus } from './internal-event-bus'
export { createSessionScopedMap } from './utils/session-scoped-map'
export type { SessionScopedMap } from './utils/session-scoped-map'
export { MountPointRegistry } from './mount-point-registry'
export type { MountPointHost } from './mount-point-registry'
export { ContributionRegistry } from './contribution-registry'
export { builtinContributions } from './builtin-contributions'
export { MockMessageSource } from './plugin-message-source'
export type { PluginMessageSource, IncomingPluginMessage } from './plugin-message-source'
export { MessageBusBridge, EXTENSION_BRIDGE_TYPES } from './message-bus-bridge'
export { ActivationManager } from './activation-manager'
export type { ActivationEvent, ActivationTrigger, ActivationManagerDeps } from './activation-manager'
export { CommandRegistry } from './command-registry'
export type { CommandRecord, CommandExecutor, CommandRegistryDeps, SlashCommandLike, ResolvedSlashCommand } from './command-registry'
export { StatusBarController } from './status-bar-controller'
export type { StatusBarSessionState, StatusBarControllerDeps } from './status-bar-controller'
export { NotificationHostController } from './notification-host-controller'
export type { NotificationHostControllerDeps } from './notification-host-controller'
export { OverlayLifecycle, GLOBAL_OVERLAY_KEY } from './overlay-lifecycle'
export type { OverlayState, OverlayLifecycleDeps } from './overlay-lifecycle'
export { ViewHostStore } from './view-host-store'
export type { ViewCacheEntry, ViewHostStoreDeps } from './view-host-store'
