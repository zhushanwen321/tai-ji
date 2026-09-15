/**
 * Plugin API 表面冻结（AC12 运行时侧，DM1）。
 *
 * 独立模块的原因：plugin-bootstrap.ts 是 Worker 入口，Vite transform 后
 * exports 丢失（plugin-bootstrap-tool-execute.test.ts 注释记录的既有坑），
 * vitest 无法 import 其导出。freeze 逻辑抽到本模块后单测可直接 import。
 */

import type { Phase2AgentAPI } from './plugin-types.js'

/**
 * 递归冻结 plugin API 表面。
 *
 * freeze 范围 = stable 层：顶层（不可增删属性）+ storage（含 global/workspace
 * 二级）/notify/sessions/events/tools/hooks/config/sessionData/ui/agent/workspace
 * 各子对象。commands/views（proposed 演进面，D3）仅由顶层 freeze 锁住引用，
 * 不递归冻结其内部。子对象内的方法本身是函数引用，函数对象不 freeze
 * （调用行为不受影响）。subscriptions 不在 api 对象内（createPluginContext
 * 构造），天然不冻（DM1）。
 */
export function freezeApiSurface(api: Phase2AgentAPI): Phase2AgentAPI {
  // 二级：storage.global / storage.workspace
  Object.freeze(api.storage.global)
  Object.freeze(api.storage.workspace)
  // 一级：stable 层子对象
  Object.freeze(api.storage)
  Object.freeze(api.notify)
  Object.freeze(api.sessions)
  Object.freeze(api.events)
  Object.freeze(api.tools)
  Object.freeze(api.hooks)
  Object.freeze(api.config)
  Object.freeze(api.sessionData)
  Object.freeze(api.ui)
  Object.freeze(api.agent)
  Object.freeze(api.workspace)
  // 顶层
  return Object.freeze(api)
}
