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
 * AP-4 读面（plugin headerAction/modal 点位 U2）：readEntries（live only 条目镜像，
 *   customType 服务端过滤 + sinceEntryId 游标增量）/ getCommands（纯查询直连 client，
 *   不经 sessionService 的 markDirty 语义）/ registerEntryInvalidation /
 *   unregisterEntryInvalidation（转调 EntryInvalidationDispatch 订阅注册表，u2c 产出）。
 *   依赖经 SessionHandlers.sessionRead 可选注入——runtime 装配侧（plugin-rpc-setup）
 *   未接线时读方法抛 SESSION_READ_NOT_WIRED（装配缺陷显式报错，不伪装成会话状态）。
 *
 * Worker 侧：createSessionApi() 返回代理对象，通过 RPC 转发到主线程。
 *   onDidCreateSession / onDidDestroySession / onEntriesInvalidated 通过通知机制订阅。
 */

import type { PluginRpcServer } from '../plugin-rpc-server.js'
import type { PluginRpcClient } from '../plugin-rpc-client.js'
import type { SessionInfo, Disposable } from '../plugin-types.js'
import type { IPluginServiceDeps } from '../plugin-types.js'
import type { SessionSummary } from '../../../../../shared/src/session.js'
import type { IProcessManager, IPiEngine } from '../../ports/pi-engine.js'
import type { EntryInvalidationDispatch } from '../plugin-entry-invalidation-dispatch.js'
import { ENTRY_INVALIDATION_NOTIFY_METHOD } from '../plugin-entry-invalidation-dispatch.js'
import { registerHandler, dispatchHandler } from '../handler-registry.js'
import { errorWithCode, toErrorMessage } from '../../../utils/errors.js'
import { asOptionalSafeKey, asOptionalString, asSafeKey, asString } from '../validation.js'

/**
 * AP-4 读面 RPC 方法（U2）。读数据两方法 + entry 失效订阅注册族（对齐
 * SESSION_EVENT_METHODS 注册族模式；entriesInvalidated 是 server→Worker notify、
 * 不进本表，方法名由 EntryInvalidationDispatch 的 ENTRY_INVALIDATION_NOTIFY_METHOD 承载）。
 * 方法名全集登记于 packages/shared/src/plugin-permission-map.ts 的 PLUGIN_RPC_METHODS。
 */
export const SESSION_READ_METHODS = {
  readEntries: 'plugin.sessions.readEntries',
  getCommands: 'plugin.sessions.getCommands',
  registerEntryInvalidation: 'plugin.sessions.registerEntryInvalidation',
  unregisterEntryInvalidation: 'plugin.sessions.unregisterEntryInvalidation',
} as const

/**
 * 目标会话无活跃 pi 进程（E4）——readEntries/getCommands 的 live only 前提不满足，
 * 或 registerEntryInvalidation 的 sessionId 不在当前会话列表。插件据此分两态处理
 * （恢复中重试 / 终态文案），不与装配缺陷（SESSION_READ_NOT_WIRED）混用。
 */
export const SESSION_NOT_ACTIVE = 'SESSION_NOT_ACTIVE'

/** runtime 装配未提供 SessionHandlers.sessionRead 时的结构化错误码（装配缺陷，重试无意义）。 */
export const SESSION_READ_NOT_WIRED = 'SESSION_READ_NOT_WIRED'

/**
 * get_entries RPC 响应的域内收窄（session-records.ts EntriesSinceResult 同款先例）：
 * pi 侧 data 已由 sendCommand 归一（data ?? payload），entries 零字段消费、leafId 可空。
 */
type EntriesSinceResult = { data?: { entries?: unknown[]; leafId?: string | null } }

/** readEntries 投影条目：含 type/customType——共享折叠器 replayFoldEntries 的首道守卫依赖这两个字段，剥掉即强迫折叠器分叉。data 原样透传（域语义插件解）。 */
export interface PluginSessionEntry {
  id: string
  timestamp: string
  type: 'custom'
  customType: string
  data: unknown
}

/** readEntries 回包信封：sessionFile 供 fork 继承场景按 ownerSessionFile 剔非 owner 条目；leafEntryId = 下次调用的 sinceEntryId。 */
export interface PluginSessionEntries {
  sessionFile?: string
  entries: PluginSessionEntry[]
  leafEntryId?: string
}

/**
 * AP-4 读面的 runtime 侧依赖（单一注入点）。由 runtime 装配（plugin-rpc-setup 的
 * registerSessionRpcHandlers 实参）提供；缺失时读方法抛 SESSION_READ_NOT_WIRED。
 */
export interface SessionReadDeps {
  /** live 进程解析（readEntries/getCommands 的 client 来源；存在且未 exited 才读——读不 spawn 进程）。 */
  pm: IProcessManager
  /** sessionFile 解析（readEntries 信封字段，SessionSummary 同源）。 */
  getSessionSummary(sessionId: string): Pick<SessionSummary, 'sessionFile'> | undefined
  /** entry 失效订阅注册表（u2c 产出；register 用其 sessionExists 校验语义）。 */
  entryInvalidation: EntryInvalidationDispatch
}

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
  /**
   * activate 订阅表（plugin-header-action-modal-points AP-4 会话激活订阅）。u5a relay 闭环
   * 的最小接口（裁决范围）：仅「表 + didActivate 投递方法」落本类——register 的 kind 联合
   * 放宽 / unregister 对本表的覆盖 / SESSION_EVENT_UNREGISTER_METHODS +
   * SESSION_EVENT_NOTIFY_METHODS 两个常量 map 扩容 / clearForPlugin + clearAll 对本表的
   * 覆盖，归 u5b 六点扩表（session-api sendMessage/activate 段）。u5b 落地前本表恒空
   * （registerActivate RPC handler 不存在），didActivate 为空表遍历 = no-op。
   */
  private readonly activateHandlers = new Map<string, { workerId: string; pluginId: string }>()

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

  /**
   * session 激活：向全部 activate 订阅者定向投递 didActivate 通知（u5a relay ③ 消费侧：
   * PluginService 经 sessionService.onSessionActivated 回调转发）。方法名字面量暂内联——
   * u5b 六点扩表时并入 SESSION_EVENT_NOTIFY_METHODS（常量 map 归 u5b 领地）。
   */
  didActivate(session: SessionInfo): void {
    for (const [handlerId, target] of this.activateHandlers) {
      this.rpcServer.notify(target.workerId, 'plugin.sessions.didActivate', { handlerId, session })
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
  /**
   * AP-4 读面依赖（U2）。可选：runtime 装配侧接线后读方法可用；缺失时读方法抛
   * SESSION_READ_NOT_WIRED（装配缺陷显式报错，不伪装成 SESSION_NOT_ACTIVE——
   * 两者恢复动作不同，前者修装配、后者等会话恢复/走会话列表核验）。
   */
  sessionRead?: SessionReadDeps
}

/** 读方法共用的装配缺口错误：指向恢复动作（接线），不与插件可自愈的会话状态混淆。 */
function throwSessionReadNotWired(method: string): never {
  throw errorWithCode(
    `${method} is not available: the runtime assembly did not provide session read deps `
    + `(process manager / session summary / entry invalidation registry). `
    + `This is a host-side wiring gap, not a session state problem — retrying will not help.`,
    SESSION_READ_NOT_WIRED,
  )
}

/**
 * pi entry → 插件投影条目的收窄守卫：非对象 / 非 custom / customType 不匹配 /
 * id-timestamp 非 string（畸形条目）一律丢弃。新建投影对象而非透传原 entry——
 * 回包只含五个契约字段（最小暴露面），多余字段（parentId 等树结构）不出 runtime。
 */
function toPluginSessionEntry(raw: unknown, customType: string): PluginSessionEntry | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const e = raw as Record<string, unknown>
  if (e.type !== 'custom' || e.customType !== customType) return undefined
  if (typeof e.id !== 'string' || typeof e.timestamp !== 'string') return undefined
  return { id: e.id, timestamp: e.timestamp, type: 'custom', customType: e.customType, data: e.data }
}

/**
 * live only 的 client 解析：pm 已接线且进程存活才返回 client；否则抛 SESSION_NOT_ACTIVE。
 * 读不调 ensureActive、不做磁盘折叠——一次 modal 打开不该 spawn 进程（AP-4 读路径单分支）。
 */
function resolveLiveClient(read: SessionReadDeps, sessionId: string): { ok: true; client: IPiEngine } | { ok: false } {
  const client = read.pm.getClient(sessionId)
  if (!client || client.exited) return { ok: false }
  return { ok: true, client }
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

  // ── AP-4 读面（U2，SESSION_READ_METHODS）──────────────────
  // customType 由请求参数服务端过滤：回包只含请求方指定域的条目（最小暴露面与
  // 权限模型一致）；域字符串由调用方声明、runtime 不硬编码任何域（通用数据面）。
  rpcServer.registerMethod(SESSION_READ_METHODS.readEntries, async (params) => {
    const sessionId = asSafeKey(params.sessionId, 'sessionId')
    // customType 形如 'pi-scheduler:task'（含冒号），走 asString 不走 SAFE_KEY 白名单
    const customType = asString(params.customType, 'customType')
    const sinceEntryId = asOptionalString(params.sinceEntryId, 'sinceEntryId')
    const read = deps.sessionRead
    if (!read) throwSessionReadNotWired(SESSION_READ_METHODS.readEntries)
    const resolved = resolveLiveClient(read, sessionId)
    if (!resolved.ok) {
      throw errorWithCode(
        `session '${sessionId}' has no active pi process (not attached or already exited). `
        + `Check sessions.get()/list() status: recovering sessions may become readable on retry; `
        + `dead sessions will not.`,
        SESSION_NOT_ACTIVE,
      )
    }
    const raw = await resolved.client.getEntries(sinceEntryId) as EntriesSinceResult
    const entries: PluginSessionEntry[] = []
    for (const rawEntry of raw.data?.entries ?? []) {
      const projected = toPluginSessionEntry(rawEntry, customType)
      if (projected) entries.push(projected)
    }
    const leafId = raw.data?.leafId
    return {
      sessionFile: read.getSessionSummary(sessionId)?.sessionFile,
      entries,
      ...(leafId !== undefined && leafId !== null ? { leafEntryId: leafId } : {}),
    }
  })

  // 纯查询直连 client.getCommands：不经 sessionService.getCommands——那条路径带
  // markDirty 语义（查询即失效 → commands 快照防抖重拉），插件面状态查询不应触发
  // 宿主缓存失效（设计 §3.4「getCommands 降级为状态查询」的纯查询落点）。
  rpcServer.registerMethod(SESSION_READ_METHODS.getCommands, async (params) => {
    const sessionId = asSafeKey(params.sessionId, 'sessionId')
    const read = deps.sessionRead
    if (!read) throwSessionReadNotWired(SESSION_READ_METHODS.getCommands)
    const resolved = resolveLiveClient(read, sessionId)
    if (!resolved.ok) {
      throw errorWithCode(
        `session '${sessionId}' has no active pi process (not attached or already exited). `
        + `Command availability cannot be determined until the session is restored.`,
        SESSION_NOT_ACTIVE,
      )
    }
    // 投影收窄到插件契约三字段：sourceInfo（SKILL/extension 文件路径等宿主内部元信息）不出面
    const commands = await resolved.client.getCommands()
    return commands.map(c => ({ name: c.name, description: c.description, source: c.source }))
  })

  // entry 失效订阅注册族：对齐 SESSION_EVENT_METHODS 注册族形态（ctx.workerId 来自
  // 宿主消息回调闭包不可伪造；handlerId 过 asSafeKey 防毒化投递目标；pluginId 经
  // dispatch 身份覆写为通道真实归属）。拒绝回执 = sessionId 不在当前会话列表
  // （EntryInvalidationDispatch.register 的 sessionExists 校验语义，防无界注册表）。
  rpcServer.registerMethod(SESSION_READ_METHODS.registerEntryInvalidation, async (params, ctx) => {
    const sessionId = asSafeKey(params.sessionId, 'sessionId')
    const customType = asString(params.customType, 'customType')
    const handlerId = asSafeKey(params.handlerId, 'handlerId')
    const read = deps.sessionRead
    if (!read) throwSessionReadNotWired(SESSION_READ_METHODS.registerEntryInvalidation)
    const accepted = read.entryInvalidation.register(handlerId, {
      workerId: ctx.workerId,
      pluginId: asString(params.pluginId, 'pluginId'),
      sessionId,
      customType,
    })
    if (!accepted) {
      throw errorWithCode(
        `session '${sessionId}' not found in the current session list. `
        + `Pick the sessionId from sessions.list() and register again.`,
        SESSION_NOT_ACTIVE,
      )
    }
    return { registered: true }
  })

  rpcServer.registerMethod(SESSION_READ_METHODS.unregisterEntryInvalidation, async (params) => {
    const handlerId = asSafeKey(params.handlerId, 'handlerId')
    const read = deps.sessionRead
    if (!read) throwSessionReadNotWired(SESSION_READ_METHODS.unregisterEntryInvalidation)
    read.entryInvalidation.unregister(handlerId)
    return { unregistered: true }
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
  /** AP-4 条目镜像：live only 读 + customType 服务端过滤 + sinceEntryId 增量（无 client 抛 SESSION_NOT_ACTIVE）。 */
  readEntries(sessionId: string, opts: { customType: string; sinceEntryId?: string }): Promise<PluginSessionEntries>
  /** AP-4 状态查询：投影收窄到 {name, description?, source}，会话未激活抛 SESSION_NOT_ACTIVE。 */
  getCommands(sessionId: string): Promise<Array<{ name: string; description?: string; source: string }>>
  onDidCreateSession(handler: (session: SessionInfo) => void): Disposable
  onDidDestroySession(handler: (session: SessionInfo) => void): Disposable
  /**
   * AP-4 entry 失效订阅：失效信号无 payload（事件只做失效，插件收信号后 readEntries 重拉）。
   * 回调参数化 (sessionId, customType) 便于同一 handler 绑定多订阅/自检命中的会话。
   */
  onEntriesInvalidated(
    sessionId: string,
    customType: string,
    handler: (sessionId: string, customType: string) => void,
  ): Disposable
} {
  const createHandlers = new Map<string, (session: SessionInfo) => void>()
  const destroyHandlers = new Map<string, (session: SessionInfo) => void>()
  const invalidateHandlers = new Map<string, (sessionId: string, customType: string) => void>()

  // 监听主线程广播的 session 创建/销毁通知（C8: dispatchHandler 统一 onNotification 派发骨架）
  rpcClient.onNotification('plugin.sessions.didCreate', (params: unknown) => {
    const p = params as { handlerId: string; session: SessionInfo }
    dispatchHandler(createHandlers, p, h => h(p.session))
  })

  rpcClient.onNotification('plugin.sessions.didDestroy', (params: unknown) => {
    const p = params as { handlerId: string; session: SessionInfo }
    dispatchHandler(destroyHandlers, p, h => h(p.session))
  })

  // entry 失效定向通知（ENTRY_INVALIDATION_NOTIFY_METHOD，u2c 派发侧经 PluginService 到达）
  rpcClient.onNotification(ENTRY_INVALIDATION_NOTIFY_METHOD, (params: unknown) => {
    const p = params as { handlerId: string; sessionId: string; customType: string }
    dispatchHandler(invalidateHandlers, p, h => h(p.sessionId, p.customType))
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

    readEntries: (sessionId: string, opts: { customType: string; sinceEntryId?: string }) =>
      rpcClient
        .request(SESSION_READ_METHODS.readEntries, { pluginId, sessionId, ...opts })
        .then(v => v as PluginSessionEntries),

    getCommands: (sessionId: string) =>
      rpcClient
        .request(SESSION_READ_METHODS.getCommands, { pluginId, sessionId })
        .then(v => (v as Array<{ name: string; description?: string; source: string }>) ?? []),

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

    onEntriesInvalidated: (
      sessionId: string,
      customType: string,
      handler: (sessionId: string, customType: string) => void,
    ): Disposable => {
      const handlerId = `entry_invalidate_${pluginId}_${++sessionCounter}`
      // 注册失败不再静默吞（onDidCreateSession 同款处置）：sessionId 不在当前会话列表时
      // 主线程拒绝（SESSION_NOT_ACTIVE 回执），记日志保留排查线索；handler 本地照常注册。
      rpcClient
        .request(SESSION_READ_METHODS.registerEntryInvalidation, { pluginId, sessionId, customType, handlerId })
        .catch((e: unknown) => {
          console.error('[session-api] registerEntryInvalidation failed:', toErrorMessage(e))
        })
      return registerHandler(invalidateHandlers, handlerId, handler, () => {
        rpcClient.request(SESSION_READ_METHODS.unregisterEntryInvalidation, { handlerId }).catch((e: unknown) => {
          console.error('[session-api] unregisterEntryInvalidation failed:', toErrorMessage(e))
        })
      })
    },
  }
}
