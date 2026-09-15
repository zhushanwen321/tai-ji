/**
 * useSessionScopedState —— re-export 兼容层（迁移过渡期）。
 *
 * W1 迁移后 @taiji/core/foundation/use-session-scoped-state 是 SSOT（ADR-0049），
 * 本文件仅为兼容旧调用方（~10 处 import '@/composables/useSessionScopedState'）的
 * re-export，不持有任何逻辑。旧 Composer 删除后本文件可移除，调用方改 import core。
 *
 * 注意：re-export 保证单 registry 实例（sessionCleanupRegistry 在 core 包内单例），
 * 禁止改为复制实现——双份 registry 会导致 triggerSessionCleanups 调不到 renderer
 * 侧注册的 cleanup（useSidebar.deleteSession 编排失效）。
 */
export * from '@taiji/core/foundation/use-session-scoped-state'
