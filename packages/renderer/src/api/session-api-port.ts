/**
 * SessionApiPort 全量适配器单源（S4 A4）。
 *
 * 为什么抽：useNewTaskFlow（createSessionFlow ctx）与 useSidebar（createUseSession ctx）
 * 曾各持一份 8 方法代理适配器，逐字同构，仅 create 传参完整度分叉——useSidebar 版静默
 * 丢 projectId/modelOverride/thinkingOverride（其调用方无人传后三参，收敛后运行时等价），
 * 签名分叉本身是潜在不一致。useSidebar import useNewTaskFlow（前者组合后者），二者不能
 * 互相 import 单源，故放中立位置：api/ 目录，紧邻它代理的 domains 真源。
 *
 * createSessionFlow 运行时只调 create + migrateImage，但 SessionApiPort 类型要求全方法，
 * 故全量代理（零转换透传现 api 门面 + events）。
 */
import { session as sessionApi } from '@/api'
import * as events from '@taiji/core/transport/api'
import type { SessionApiPort } from '@taiji/core'

/**
 * 构建 SessionApiPort 适配（壳把现 api/domains/session + events 适配注入 core）。
 * core 定义端口接口、壳注入实现（与 PlatformPort 同模式）。
 */
export function buildSessionApiPort(): SessionApiPort {
  return {
    list: () => sessionApi.list(),
    switchSession: (id) => sessionApi.switchSession(id),
    create: (cwd, label, presetId, projectId, modelOverride, thinkingOverride) =>
      sessionApi.create(cwd, label, presetId, projectId, modelOverride, thinkingOverride),
    rename: (id, label) => sessionApi.rename(id, label),
    remove: (id) => sessionApi.remove(id),
    removeByCwd: (cwd) => sessionApi.removeByCwd(cwd),
    migrateImage: (p) => sessionApi.migrateImage(p),
    onConfigSessions: (handler) =>
      events.onGlobalType('config.sessions', (msg) => handler(msg.payload.groups)),
  }
}
