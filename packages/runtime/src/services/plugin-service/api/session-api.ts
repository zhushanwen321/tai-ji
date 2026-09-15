/**
 * Session API 模块
 *
 * 提供 Session 查询/操作的 RPC handler（主线程侧）和 Worker 侧代理对象。
 *
 * 主线程侧：registerSessionRpcHandlers() 在 PluginRpcServer 上注册
 *   plugin.sessions.list / get / getActive / sendMessage 四个查询方法，以及
 *   session 生命周期事件注册（SESSION_EVENT_METHODS，S3-W2）——Worker 侧
 *   onDidCreateSession/onDidDestroySession 的订阅经注册表（handlerId → workerId）
 *   定向投递回对应 Worker（rpcServer.notify 通道，非全局广播）。
 *
 * Worker 侧：createSessionApi() 返回代理对象，通过 RPC 转发到主线程。
 *   onDidCreateSession / onDidDestroySession 通过通知机制订阅 session 事件。
 */

import type { PluginRpcServer } from '../plugin-rpc-server.js'
import type { PluginRpcClient } from '../plugin-rpc-client.js'
import type { SessionInfo, Disposable } from '../plugin-types.js'
import type { IPluginServiceDeps } from '../plugin-types.js'
import type { SessionSummary } from '../../../../../shared/src/session.js'
import { registerHandler, dispatchHandler } from '../handler-registry.js'
import { toErrorMessage } from '../../../utils/errors.js'
import { asOptionalSafeKey, asSafeKey, asString } from '../validation.js'

/**
 * session 生命周期事件注册方法（冻结契约，集成 verify 逐字比对——一字不差）。
 * Worker 侧 createSessionApi 发送的 registerCreate/registerDestroy RPC 方法名。
 */
export const SESSION_EVENT_METHODS = ['plugin.sessions.registerCreate', 'plugin.sessions.registerDestroy'] as const

/** register 对应的注销方法（Disposable.dispose 时发送；非 SESSION_EVENT_METHODS 契约成员） */
const SESSION_EVENT_UNREGISTER_METHODS = {
  create: 'plugin.sessions.unregisterCreate',
  destroy: 'plugin.sessions.unregisterDestroy',
} as const

/** 主线程 → Worker 的定向投递通知方法名（与 createSessionApi 的 onNotification 对齐） */
const SESSION_EVENT_NOTIFY_METHODS = {
  create: 'plugin.sessions.didCreate',
  destroy: 'plugin.sessions.didDestroy',
} as const

/**
 * SessionSummary（session-service 域）→ SessionInfo（插件 SDK 契约面）。
 * 事件投递与 list/get 共用的字段映射单一真相。
 */
export function sessionInfoFromSummary(s: SessionSummary): SessionInfo {
  return {
    id: s.id,
    label: s.label,
    cwd: s.cwd,
    status: s.status,
    createdAt: 0,
    lastActiveAt: s.lastActiveAt,
  }
}

/**
 * session 事件注册表 + 定向投递器（S3-W2，主线程侧）。
 *
 * Worker 侧 onDidCreateSession 经 SESSION_EVENT_METHODS 注册 handlerId，
 * 本表按 handlerId 记录 { workerId, pluginId }；session 创建/销毁发生时
 * （session-service 生命周期钩子 → PluginService 转发），按注册表对每个
 * handlerId 定向 rpcServer.notify 到其所属 Worker——同一 trusted Worker 上
 * 多插件各自注册，Worker 侧 dispatchHandler 按 handlerId 命中各自 handler。
 *
 * 投递走 rpcServer 通道（resolveIdentity 同一 workerId↔port 映射）；
 * Worker 已死（crash/卸载后残留条目）时 notify 找不到 port 静默 no-op，
 * 运行期清理由 PluginService 的 crash/disable/uninstall 路径 clearForPlugin 完成。
 */
export class SessionEventDispatch {
  private readonly createHandlers = new Map<string, { workerId: string; pluginId: string }>()
  private readonly destroyHandlers = new Map<string, { workerId: string; pluginId: string }>()

  constructor(private readonly rpcServer: PluginRpcServer) {}

  /** 注册一个 handler 的投递目标（registerCreate/registerDestroy handler 调用） */
  register(kind: 'create' | 'destroy', handlerId: string, target: { workerId: string; pluginId: string }): void {
    const table = kind === 'create' ? this.createHandlers : this.destroyHandlers
    table.set(handlerId, target)
  }

  /** 注销（unregisterCreate/unregisterDestroy handler 调用；两表都试删，幂等） */
  unregister(handlerId: string): void {
    this.createHandlers.delete(handlerId)
    this.destroyHandlers.delete(handlerId)
  }

  /** 清理指定插件的全部注册条目（crash / disable / uninstall 对偶清理） */
  clearForPlugin(pluginId: string): void {
    for (const [handlerId, target] of this.createHandlers) {
      if (target.pluginId === pluginId) this.createHandlers.delete(handlerId)
    }
    for (const [handlerId, target] of this.destroyHandlers) {
      if (target.pluginId === pluginId) this.destroyHandlers.delete(handlerId)
    }
  }

  /** 清空全部注册表（runtime 关停） */
  clearAll(): void {
    this.createHandlers.clear()
    this.destroyHandlers.clear()
  }

  /** session 创建：向全部 create 订阅者定向投递 didCreate 通知 */
  didCreate(session: SessionInfo): void {
    for (const [handlerId, target] of this.createHandlers) {
      this.rpcServer.notify(target.workerId, SESSION_EVENT_NOTIFY_METHODS.create, { handlerId, session })
    }
  }

  /** session 销毁：向全部 destroy 订阅者定向投递 didDestroy 通知 */
  didDestroy(session: SessionInfo): void {
    for (const [handlerId, target] of this.destroyHandlers) {
      this.rpcServer.notify(target.workerId, SESSION_EVENT_NOTIFY_METHODS.destroy, { handlerId, session })
    }
  }

  /** 当前注册条目数（测试诊断用） */
  get size(): number {
    return this.createHandlers.size + this.destroyHandlers.size
  }
}

// eslint-disable-next-line no-magic-numbers -- 2 seconds TTL for active session cache
const ACTIVE_SESSION_CACHE_TTL_MS = 2 * 1000

/**
 * 活跃 session 解析器（P6 收口：消除 plugin-rpc-setup.ts 的模块级可变全局状态）。
 *
 * 此前 `_activeSessionCache` 是 plugin-rpc-setup.ts 的隐藏模块全局——跨 service
 * 实例共享、测试间泄漏、无法注入。现收口为可注入实例：每个 PluginService 持有
 * 自己的 resolver，缓存随实例生命周期生灭。
 *
 * 提供 TTL 缓存：命中时按缓存 sessionId 查 summary（避免全盘扫描），过期或失效
 * 则回退全盘扫描并刷新缓存。
 */
export class ActiveSessionResolver {
  private cache: { sessionId: string; ts: number } | null = null

  constructor(private readonly deps: IPluginServiceDeps) {}

  /** 清除缓存（测试在 beforeEach 调用以保证干净起点） */
  clear(): void {
    this.cache = null
  }

  /**
   * 查找当前活跃 session。返回 SessionSummary 或 undefined。
   * 命中 TTL 缓存时按缓存 id 查 summary；否则全盘扫描。
   */
  resolve(): SessionSummary | undefined {
    if (!this.deps.sessionService) return undefined
    const now = Date.now()
    if (this.cache && (now - this.cache.ts) < ACTIVE_SESSION_CACHE_TTL_MS) {
      // Cache hit — look up session summary by cached ID (no full disk scan)
      const summary = this.deps.sessionService.getSummary(this.cache.sessionId)
      if (summary) return summary
      // Cached session no longer valid — fall through to full scan
      this.cache = null
    }
    // Cache miss or expired — do the full scan
    const groups = this.deps.sessionService.listPersistedSessions()
    const active = groups.flatMap(g => g.sessions).find(s => s.status === 'active')
    if (active) {
      this.cache = { sessionId: active.id, ts: now }
    } else {
      this.cache = null
    }
    return active
  }
}

/** Session 服务依赖（主线程侧） */
export interface SessionHandlers {
  listSessions(): SessionInfo[] | Promise<SessionInfo[]>
  getSession(id: string): SessionInfo | undefined | Promise<SessionInfo | undefined>
  getActiveSession(): SessionInfo | undefined | Promise<SessionInfo | undefined>
  sendMessage(sessionId: string | undefined, role: string, content: string): Promise<void>
  /** session 事件注册表（S3-W2）：registerCreate/registerDestroy 的投递目标 */
  sessionEvents: SessionEventDispatch
}

export function registerSessionRpcHandlers(
  rpcServer: PluginRpcServer,
  deps: SessionHandlers,
): void {

  rpcServer.registerMethod('plugin.sessions.list', async (_params) => {
    return deps.listSessions()
  })

  rpcServer.registerMethod('plugin.sessions.get', async (params) => {
    // S3-W3 窄校验：sessionId 用于 sessionService 查询（磁盘扫描键），
    // 畸形即抛 INVALID_SESSION_ID
    const sessionId = asSafeKey(params.sessionId, 'sessionId')
    return deps.getSession(sessionId)
  })

  rpcServer.registerMethod('plugin.sessions.getActive', async (_params) => {
    return deps.getActiveSession()
  })

  rpcServer.registerMethod('plugin.sessions.sendMessage', async (params) => {
    // sessionId 可选（缺省 = 发给活跃 session）；present 即过白名单
    const sessionId = asOptionalSafeKey(params.sessionId, 'sessionId')
    const role = asString(params.role, 'role')
    const content = asString(params.content, 'content')
    await deps.sendMessage(sessionId, role, content)
  })

  // ── session 生命周期事件注册（S3-W2，SESSION_EVENT_METHODS）──────────
  // ctx.workerId 来自宿主消息回调闭包（不可伪造），注册表据此定向投递；
  // params.pluginId 经 dispatch 身份覆写后为通道真实归属（sandbox 场景）。
  // S3-W3：handlerId 过 asSafeKey（Worker 侧生成模式 `session_*_<pluginId>_<n>`
  // 均在白名单内），畸形注册不进注册表（防毒化投递目标）。
  rpcServer.registerMethod(SESSION_EVENT_METHODS[0], async (params, ctx) => {
    const handlerId = asSafeKey(params.handlerId, 'handlerId')
    deps.sessionEvents.register('create', handlerId, {
      workerId: ctx.workerId,
      pluginId: asString(params.pluginId, 'pluginId'),
    })
    return { registered: true }
  })

  rpcServer.registerMethod(SESSION_EVENT_METHODS[1], async (params, ctx) => {
    const handlerId = asSafeKey(params.handlerId, 'handlerId')
    deps.sessionEvents.register('destroy', handlerId, {
      workerId: ctx.workerId,
      pluginId: asString(params.pluginId, 'pluginId'),
    })
    return { registered: true }
  })

  rpcServer.registerMethod(SESSION_EVENT_UNREGISTER_METHODS.create, async (params) => {
    deps.sessionEvents.unregister(asSafeKey(params.handlerId, 'handlerId'))
    return { unregistered: true }
  })

  rpcServer.registerMethod(SESSION_EVENT_UNREGISTER_METHODS.destroy, async (params) => {
    deps.sessionEvents.unregister(asSafeKey(params.handlerId, 'handlerId'))
    return { unregistered: true }
  })
}

let sessionCounter = 0

export function createSessionApi(
  rpcClient: PluginRpcClient,
  pluginId: string,
): {
  list(): Promise<SessionInfo[]>
  get(id: string): Promise<SessionInfo | undefined>
  getActive(): Promise<SessionInfo | undefined>
  sendMessage(params: { sessionId?: string; role: 'user' | 'system'; content: string }): Promise<void>
  onDidCreateSession(handler: (session: SessionInfo) => void): Disposable
  onDidDestroySession(handler: (session: SessionInfo) => void): Disposable
} {
  const createHandlers = new Map<string, (session: SessionInfo) => void>()
  const destroyHandlers = new Map<string, (session: SessionInfo) => void>()

  // 监听主线程广播的 session 创建/销毁通知（C8: dispatchHandler 统一 onNotification 派发骨架）
  rpcClient.onNotification('plugin.sessions.didCreate', (params: unknown) => {
    const p = params as { handlerId: string; session: SessionInfo }
    dispatchHandler(createHandlers, p, h => h(p.session))
  })

  rpcClient.onNotification('plugin.sessions.didDestroy', (params: unknown) => {
    const p = params as { handlerId: string; session: SessionInfo }
    dispatchHandler(destroyHandlers, p, h => h(p.session))
  })

  return {
    list: () =>
      rpcClient.request('plugin.sessions.list', { pluginId }).then(v => (v as SessionInfo[]) ?? []),

    get: (id: string) =>
      rpcClient.request('plugin.sessions.get', { sessionId: id }).then(v => v as SessionInfo | undefined),

    getActive: () =>
      rpcClient.request('plugin.sessions.getActive', { pluginId }).then(v => v as SessionInfo | undefined),

    sendMessage: (params: { sessionId?: string; role: 'user' | 'system'; content: string }) =>
      rpcClient.request('plugin.sessions.sendMessage', { pluginId, ...params }).then(() => {}),

    onDidCreateSession: (handler: (session: SessionInfo) => void): Disposable => {
      const handlerId = `session_create_${pluginId}_${++sessionCounter}`
      // 注册失败不再静默吞（此前 .catch(() => {}) 掩盖方法未注册的死链路）——
      // 记日志保留排查线索；handler 本地照常注册（主线程不可达时通知不会到达）。
      rpcClient.request(SESSION_EVENT_METHODS[0], { pluginId, handlerId }).catch((e: unknown) => {
        console.error('[session-api] registerCreate failed:', toErrorMessage(e))
      })
      return registerHandler(createHandlers, handlerId, handler, () => {
        rpcClient.request(SESSION_EVENT_UNREGISTER_METHODS.create, { handlerId }).catch((e: unknown) => {
          console.error('[session-api] unregisterCreate failed:', toErrorMessage(e))
        })
      })
    },

    onDidDestroySession: (handler: (session: SessionInfo) => void): Disposable => {
      const handlerId = `session_destroy_${pluginId}_${++sessionCounter}`
      rpcClient.request(SESSION_EVENT_METHODS[1], { pluginId, handlerId }).catch((e: unknown) => {
        console.error('[session-api] registerDestroy failed:', toErrorMessage(e))
      })
      return registerHandler(destroyHandlers, handlerId, handler, () => {
        rpcClient.request(SESSION_EVENT_UNREGISTER_METHODS.destroy, { handlerId }).catch((e: unknown) => {
          console.error('[session-api] unregisterDestroy failed:', toErrorMessage(e))
        })
      })
    },
  }
}
