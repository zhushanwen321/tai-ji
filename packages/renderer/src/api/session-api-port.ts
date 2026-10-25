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
 *
 * 代理一律取 rest 传播形态（`(...args: Parameters<SessionApiPort['x']>) => api.x(...args)`），
 * 不逐参罗列：TS 对「少参 lambda 赋多参签名」静默放行，逐参罗列在端口加参后会把新参
 * 静默吞掉（create 第 7 参 clientUuid 是幂等键，被吞即桌面新建超时重试重复建 session，
 * 与移动壳行为分叉）；rest 传播让端口签名成为唯一参数来源，加参零改动即透传。
 * onConfigSessions 是唯一非透传成员（改编 msg.payload.groups 给 handler），同取 rest 形态
 * 保持全文件单一形态，args[0] 即 handler。
 *
 * [W2 权威拉取与冷读] getState 是第二个非透传成员：该 RPC 经 request helper 的 command
 * 直发，不经 @/api 的 session 域代理。原因是它只有一个消费方（createUseSession 的拉取
 * 对账），而 @/api 的 session 域在 mock 模式整体替换为 core mock 实现——给域加一个成员
 * 会强制 mock 同步实现一个「无 runtime 可读」的空壳。直发下 mock 模式 ws 未连，
 * command 立即以 notDelivered reject，由 core 侧静默降级承接（行为 mock 层不在 W2
 * 影响面内）。先例 = useGenStats / stores/canvas 的 command 直发。
 */
import { session as sessionApi } from '@/api'
import * as events from '@taiji/core/transport/api'
import { command, RPC_BACKSTOP_TIMEOUT_MS } from '@taiji/core/transport/api'
import type { SessionApiPort } from '@taiji/core'

/**
 * 构建 SessionApiPort 适配（壳把现 api/domains/session + events 适配注入 core）。
 * core 定义端口接口、壳注入实现（与 PlatformPort 同模式）。
 */
export function buildSessionApiPort(): SessionApiPort {
  return {
    list: (...args: Parameters<SessionApiPort['list']>) => sessionApi.list(...args),
    switchSession: (...args: Parameters<SessionApiPort['switchSession']>) =>
      sessionApi.switchSession(...args),
    create: (...args: Parameters<SessionApiPort['create']>) => sessionApi.create(...args),
    rename: (...args: Parameters<SessionApiPort['rename']>) => sessionApi.rename(...args),
    remove: (...args: Parameters<SessionApiPort['remove']>) => sessionApi.remove(...args),
    archive: (...args: Parameters<SessionApiPort['archive']>) => sessionApi.archive(...args),
    removeByCwd: (...args: Parameters<SessionApiPort['removeByCwd']>) =>
      sessionApi.removeByCwd(...args),
    migrateImage: (...args: Parameters<SessionApiPort['migrateImage']>) =>
      sessionApi.migrateImage(...args),
    onConfigSessions: (...args: Parameters<SessionApiPort['onConfigSessions']>) =>
      events.onGlobalType('config.sessions', (msg) => args[0](msg.payload.groups)),
    // [W2] session.getState 直发（不经 session 域代理，理由见文件头）。reply 与 request
    // 同名、payload 消费型；会话不存在 = SESSION_NOT_FOUND reject（core 侧显式未知）。
    getState: (id: string) =>
      command('session.getState', { sessionId: id }, RPC_BACKSTOP_TIMEOUT_MS),
  }
}
