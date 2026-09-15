/**
 * Renderer 本地类型（非 shared 协议类型）。
 *
 * - NavEntry: 导航历史栈条目（D1 状态驱动路由）
 * - DerivedStatus: 已迁 @taiji/core/domain/chat/derive-status.ts（renderer-model M3），
 *   此处 re-export 转发保持消费方 import '@/types' 路径零改动。
 */
/** 导航历史栈条目（plan-frontend §4） */
export type NavEntry = {
  view: 'chat' | 'overview' | 'settings'
  sessionId?: string
  activeTab?: string
}

/** SessionStatus 前端派生状态：9 态扩展版（方案 C 优化版 v3 + working 后台任务态），定义见 core */
export type { DerivedStatus } from '@taiji/core'
