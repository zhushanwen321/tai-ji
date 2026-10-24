/**
 * Plugin RPC 方法注册
 *
 * 从 PluginService.registerRpcMethods() 提取，注册所有 plugin RPC handler。
 * 包含：tool、hook、storage、notify、session、config、sessionData、ui、agent、workspace。
 */

import type { ProviderId, PluginViewScope, ViewSnapshotItem, PluginEventPayload } from '@taiji/shared'
import type { PluginRpcServer } from './plugin-rpc-server.js'
import type { PluginStorage } from './plugin-storage.js'
import type { IPluginServiceDeps } from './plugin-types.js'
import type { SessionDataStore } from './session-data-store.js'
import { registerToolRpcHandlers } from './tool-api.js'
import { registerHookRpcHandlers } from './hook-api.js'
import { registerSessionRpcHandlers, ActiveSessionResolver, sessionInfoFromSummary, type SessionEventDispatch } from './api/session-api.js'
import type { EntryInvalidationDispatch } from './plugin-entry-invalidation-dispatch.js'
import { wireRuntimeUiExits } from './api/ui-api.js'
import { registerConfigRpcHandlers, toConfigKey, fromConfigKey, isConfigKey } from './api/config-api.js'
import { registerStorageRpcHandlers, storageHandlersFrom } from './api/storage-api.js'
import { registerNotifyRpcHandler, notifyHandlersFrom, broadcastPluginNotification, NotifyRateLimiter } from './api/notify-api.js'
import { registerSessionDataRpcHandlers } from './api/session-data-api.js'
import { registerUiRpcHandlers } from './api/ui-api.js'
import type { UiRequestMeta } from './api/ui-api.js'
import { registerAgentRpcHandlers } from './api/agent-api.js'
import { registerWorkspaceRpcHandlers } from './api/workspace-api.js'
import { registerCommandRpcHandlers } from './api/commands-api.js'
import type { CommandRegistration } from './api/commands-api.js'
import { registerViewRpcHandlers } from './api/views-api.js'
import { asBoundedString, asString } from './validation.js'
import { errorWithCode } from '../../utils/errors.js'
import type { PluginUiSnapshotStore } from './plugin-ui-snapshot-store.js'
import type { GuiComponent } from '@zhushanwen/extension-protocol'
import type { ToolEntry } from './plugin-types.js'

const MAX_FIND_FILES_RESULTS = 1000
/** MAX_FIND_FILES_RESULTS 导出供测试断言上限语义（T10：SUT 改上限时测试同步红）。 */
export { MAX_FIND_FILES_RESULTS }
const MIN_MODEL_PARTS = 2

/**
 * workspace.findFiles 核心（源码简化 T10 从内联 handler 闭包提取为可直测纯函数）：
 * fast-glob 按 pattern 搜 cwd 下文件，忽略 node_modules/.git，返回绝对路径，
 * 截断到 MAX_FIND_FILES_RESULTS（DoS 兜底）。任何错误（glob 非法 pattern 等）
 * 吞噬为空数组——handler 侧不向插件暴露 fs 异常细节。
 * 导出供 plugin-findfiles.test.ts 直测（此前内联闭包不可直测，测试被迫本地复制实现）。
 */
export async function findFiles(pattern: string, cwd: string): Promise<string[]> {
  try {
    const fastGlob = (await import('fast-glob')).default
    const entries = await fastGlob(pattern, {
      cwd,
      ignore: ['**/node_modules/**', '**/.git/**'],
      absolute: true,
    }) as string[]
    return entries.slice(0, MAX_FIND_FILES_RESULTS)
  } catch {
    return []
  }
}

/**
 * 向后兼容的 test helper（P6 后为 no-op）。
 *
 * 活跃 session 缓存已从模块级全局状态收尾为 `ActiveSessionResolver` 实例（每个
 * PluginService 持有自己的 resolver，缓存随实例生灭）。测试每个 beforeEach 创建
 * 新 service，resolver 天然干净，故此 helper 不再需要真正清理——保留导出仅为不破坏
 * 既有测试 import（plugin-agent-real.test.ts）。
 */
export function clearActiveSessionCache(): void {
  /* no-op: cache is now per-resolver-instance, see ActiveSessionResolver */
}

// Re-export：测试与外部仍可拿到 resolver 类型
export { ActiveSessionResolver }

export interface RpcSetupContext {
  rpcServer: PluginRpcServer
  storage: PluginStorage
  toolRegistry: Map<string, ToolEntry>
  hookRegistry: Map<string, import('./plugin-types.js').HookEntry[]>
  deps: IPluginServiceDeps
  handleUiRequest: (method: string, params: Record<string, unknown>, pluginId: string) => Promise<unknown>
  /**
   * UI 请求到期取消（timeout-plugin-service D2）：Worker 侧语义 timer 到期后经
   * plugin.ui.uiRequestExpired notification 到达，委托 UiRequestQueue.cancelRequest
   * （删 pending/排队项 + 撤窗广播 + 放行串行队列）。
   */
  cancelUiRequest: (requestId: string) => void
  getDescriptor: (pluginId: string) => import('./plugin-types.js').PluginDescriptor | undefined
  sessionDataStore: SessionDataStore
  /** 活跃 session 解析器（P6：替代模块级全局 _activeSessionCache） */
  activeSessionResolver: ActiveSessionResolver
  /** 命令注册表（复合键 `pluginId:commandId` → CommandRegistration），PluginService 实例字段注入 */
  commandRegistry: Map<string, CommandRegistration>
  /** session 事件注册表（S3-W2）：registerCreate/registerDestroy 的定向投递通道 */
  sessionEvents: SessionEventDispatch
  /**
   * Entry 失效订阅注册表（AP-4，u2c 产出）。sessionRead 装配（u2d 移交 u5b 接线）：
   * 与 SessionHandlers.sessionRead 共享同一实例——registerEntryInvalidation 写入的条目
   * 由 PluginService.notifyEntryInvalidation 派发。
   */
  entryInvalidation: EntryInvalidationDispatch
  /** 挂载点集合（renderer 经 plugin.mountPoints.sync 上报的副本，AC10） */
  mountPoints: string[]
  /**
   * 插件 UI 快照存储（ADR-0097 拉为主）：headerAction 广播出线与 handleViewUpdate 的
   * 校验出口处写入最新值，plugin.ui.snapshot 拉取 handler 读出。写入先于广播——广播
   * 丢弃（broadcastFn 缺失）时快照仍反映插件最新声明，下次拉取可收敛。
   */
  uiSnapshotStore: PluginUiSnapshotStore
  /** Worker invoke.result 回传的 pending resolve/reject（S3-W1，PluginService 私有）；sourceWorkerId 为回传来源通道（D2 回传归属校验） */
  deliverInvokeResult: (handlerId: string, payload: { result?: unknown; error?: unknown }, sourceWorkerId: string) => void
  /**
   * views.update 的广播出口（wave:perf-w08，02 文档 D1-1）：PluginService 实现的
   * bus 定向发布（transient）/ 全局广播兜底分流，见 publishViewUpdate 实现。
   */
  publishViewUpdate: PluginServiceLike['publishViewUpdate']
  /**
   * plugin:event 广播出线（provider-plugin-access D9）：plugin.event Worker RPC
   * handler 校验后的业务事件经此广播给 renderer（broadcastOrBroker 强类型出口）。
   */
  broadcastPluginEvent: (payload: PluginEventPayload) => void
  /**
   * 系统级 URL 唤起出口（provider-plugin-access D9，plugin.ui.openUrl）：scheme
   * 白名单校验通过后由宿主打开（生产 = 系统浏览器 spawn，装配侧注入）。缺省
   * undefined = 出口未装配——校验仍生效（拒绝路径成立），放行路径回执
   * { opened:false } 并 warn（装配缺陷可见，不假成功——B-F2 同款纪律）。
   */
  openExternal?: (url: string) => void
}

/** 仅用于 RpcSetupContext.publishViewUpdate 的类型（避免 rpc-setup 反向 import plugin-service 成环）。
 *  payload = shared ViewSnapshotItem（scope 二选一 + generation，U2 单一来源）。 */
interface PluginServiceLike {
  publishViewUpdate(payload: ViewSnapshotItem): void
}

// ── provider-plugin-access D9 / D8：plugin:event 上报、plugin.uiEvent 投递、openUrl ──

/**
 * 插件业务事件上报的 Worker RPC 方法名（D9）：插件 → 宿主 notify（无回包），
 * 宿主校验后广播 'plugin:event' 帧。命名与 protocol.ts PluginEventPayload 注释
 * （u-foundation SSOT）一致。
 */
export const PLUGIN_EVENT_RPC_METHOD = 'plugin.event'

/**
 * renderer uiEvent 值回传投递给插件 Worker 的通知方法名（D8）：宿主 → Worker 单向
 * notify（fire-and-forget——输入值变更即发，插件侧始终持有最新值；单条丢失由下一条
 * 变更自然覆盖）。Worker 侧监听点归插件 agentAPI 接线（plugin-bootstrap 域）。
 */
export const PLUGIN_UI_EVENT_NOTIFY = 'plugin.ui.event'

/** openUrl scheme 白名单（D9）：仅 http(s)。file:// 与自定义 scheme 直接拒绝。 */
const OPEN_URL_ALLOWED_PROTOCOLS: ReadonlySet<string> = new Set(['http:', 'https:'])

/**
 * openUrl scheme 白名单判定（D9 / S28）：URL 解析归一化后与白名单比对
 * （`new URL(url).protocol`），不做字符串前缀匹配——`javascript:`、大小写、
 * 空白变体由解析器归一拦截（WHATWG URL 剥离前后空白与内部 tab/换行后解析
 * scheme，scheme 统一小写；`file:` / `javascript:` 等不在白名单即拒绝，
 * 不可解析（相对地址 / 纯文本）同样拒绝）。
 */
export function isAllowedOpenUrl(url: string): boolean {
  try {
    return OPEN_URL_ALLOWED_PROTOCOLS.has(new URL(url).protocol)
  } catch {
    return false
  }
}

/** plugin.event 上报的 channel 长度上限（自命开放字符串，防超长入广播帧；帧大小兜底另有 broker 出站守卫） */
const PLUGIN_EVENT_CHANNEL_MAX_BYTES = 256

/**
 * 注册 plugin.event RPC handler（D9：插件 → renderer 的业务事件上报）。
 *
 * pluginId 归属取通道身份优先（ctx.identity.pluginId——宿主注册时闭包捕获不可伪造，
 * sandbox 通道必有），trusted 共享 Worker 无唯一归属时回落 params.pluginId（trusted
 * 插件间互不设防是既有设计语义）。channel/payload 窄校验后经广播出线转发，handler
 * 本体不解释业务语义（payload unknown 透传，消费方自定）。
 */
export function registerPluginEventRpcHandler(
  rpcServer: PluginRpcServer,
  deps: { broadcast: (payload: PluginEventPayload) => void },
): void {
  rpcServer.registerMethod(PLUGIN_EVENT_RPC_METHOD, async (params, ctx) => {
    const pluginId = ctx.identity?.pluginId ?? asString(params.pluginId, 'pluginId')
    const channel = asBoundedString(params.channel, 'channel', PLUGIN_EVENT_CHANNEL_MAX_BYTES)
    deps.broadcast({ pluginId, channel, payload: params.payload })
    return { forwarded: true }
  })
}

/**
 * 注册 plugin.ui.openUrl RPC handler（D9：插件 → 宿主的授权页打开服务调用，
 * 与 plugin.storage.* 同类——宿主公共服务，不经 capabilities 词表逐项声明）。
 *
 * 校验：url 过 isAllowedOpenUrl（http(s) 白名单）——`file://` / `javascript:` 及
 * 大小写空白变体在入口拒绝（INVALID_URL_SCHEME，S28 ②③「宿主侧拒绝、无浮层唤起」
 * 在本层结构性成立）。放行路径交 deps.openExternal 出口；出口未装配时回执
 * { opened:false } + warn（装配缺陷可见）。放行不鉴定 URL 内容安全性——scheme
 * 白名单是本调用点的全部风险收敛面（D9），302 重定向由浏览器侧处置（S28 ④ 边界）。
 */
export function registerOpenUrlRpcHandler(
  rpcServer: PluginRpcServer,
  deps: { openExternal?: (url: string) => void },
): void {
  rpcServer.registerMethod('plugin.ui.openUrl', async (params) => {
    const url = asString(params.url, 'url')
    if (!isAllowedOpenUrl(url)) {
      throw errorWithCode(
        `INVALID_URL_SCHEME: plugin.ui.openUrl only allows http(s) URLs (got a non-allowlisted ` +
          `or unparseable URL). file:// and custom schemes are rejected by design — ` +
          `floating-layer file rendering and system handler invocation are real attack surface.`,
        'INVALID_URL_SCHEME',
      )
    }
    if (!deps.openExternal) {
      console.warn(
        '[plugin-rpc-setup] plugin.ui.openUrl passed scheme check but no openExternal exit wired — ' +
          'URL not opened. Recovery: wire openExternal into registerAllRpcMethods deps.',
      )
      return { opened: false }
    }
    deps.openExternal(url)
    return { opened: true }
  })
}

export function registerAllRpcMethods(ctx: RpcSetupContext): void {
  const { rpcServer, storage, toolRegistry, hookRegistry, deps } = ctx

  // S3-W4：每插件 notify 令牌桶——plugin.notify 与 plugin.ui.notify 两入口共享
  // 同一实例（同一插件的配额跨入口合并计费），默认 20 条/s（shared SSOT）。
  const notifyLimiter = new NotifyRateLimiter()

  // ── plugin headerAction 广播出线装配（AP-1，u5b）──────────────────────────
  // ui-api 的出线是模块级单例，广播经此注入：全局广播走 broadcastFn（broker.broadcast
  // 同语义回退由 broadcastFn 装配方承担——本层无 broker 引用）。广播帧
  //（plugin:headerActionUpdate）不经 message-bus publish，结构性不入 ring（transient）。
  wireRuntimeUiExits({
    // broadcast 回传是否真正发出（false = broadcastFn 缺失 warn 丢弃）——
    // ui-api 据此拒绝「假成功」回执（B-F2：updateHeaderAction 回 {updated:false}），
    // 装配缺陷不再被包装成插件侧的成功。
    broadcastHeaderActionUpdate: (payload) => {
      // 快照写入先于广播且无条件（ADR-0097）：广播被丢弃（broadcastFn 缺失）时快照
      // 仍反映插件最新声明，renderer 下次 plugin.ui.snapshot 拉取可收敛
      ctx.uiSnapshotStore.setHeaderAction(payload)
      if (deps.broadcastFn) {
        deps.broadcastFn('plugin:headerActionUpdate', payload)
        return true
      }
      console.warn('[plugin-rpc-setup] plugin:headerActionUpdate broadcast dropped: no broadcastFn configured')
      return false
    },
  })

  // Tool RPC handlers
  registerToolRpcHandlers(rpcServer, {
    toolRegistry,
  })

  // Hook RPC handlers
  registerHookRpcHandlers(rpcServer, {
    hookRegistry,
    getDescriptor: ctx.getDescriptor,
  })

  // Storage RPC handlers — P6 收尾到 api/storage-api.ts（与其它域一致）
  registerStorageRpcHandlers(rpcServer, storageHandlersFrom(storage))

  // Notify RPC handler — P6 收尾到 api/notify-api.ts（fire-and-forget via broadcastFn）
  registerNotifyRpcHandler(rpcServer, { ...notifyHandlersFrom(deps.broadcastFn), limiter: notifyLimiter })

  // ── Sessions RPC handlers ────────────────────────────────
  registerSessionRpcHandlers(rpcServer, {
    listSessions: () => {
      if (!deps.sessionService) return []
      const groups = deps.sessionService.listPersistedSessions()
      return groups.flatMap(g => g.sessions.map(sessionInfoFromSummary))
    },
    getSession: (id: string) => {
      if (!deps.sessionService) return undefined
      const s = deps.sessionService.getSummary(id)
      return s ? sessionInfoFromSummary(s) : undefined
    },
    getActiveSession: () => {
      const active = ctx.activeSessionResolver.resolve()
      return active ? sessionInfoFromSummary(active) : undefined
    },
    // [D6/u5b] 插件写路径透传（替换既有静默 no-op）：sessionId 必填校验在 session-api
    // handler 层（asSafeKey → INVALID_SESSION_ID）；requireCommand 透传给 dispatcher 的
    // 原子校验（restore 后、busy 预检前，E14 防漏进模型）。回执 {blocked, reason?} 由
    // handler 层映射为 {accepted, reason}。role 在插件契约范围保留（AP-4），runtime 管道
    // 仅支持 user prompt 语义（既有行为——旧实现同样丢弃 role）。
    sendMessage: async (sessionId: string, _role: string, content: string, requireCommand?: string) => {
      if (!deps.sessionService) {
        // B-F4：装配缺口必须出声（失败要出声）——宿主零日志时插件侧只会看到笼统的
        // {blocked, reason:'error'}，无从分辨「会话问题」与「宿主没装配 sessionService」。
        console.error(
          `[plugin-rpc-setup] sendMessage deps.sessionService missing — host-side wiring gap `
          + `(session='${sessionId}'); reporting {blocked:true, reason:'error'} to the plugin. `
          + `Recovery: wire sessionService into PluginService deps.`,
        )
        return { blocked: true, reason: 'error' as const }
      }
      return deps.sessionService.sendMessage(sessionId, content, undefined, undefined, requireCommand)
    },
    // S3-W2：session 生命周期事件注册表（registerCreate/registerDestroy 方法在此注册）
    sessionEvents: ctx.sessionEvents,
    // [u2d 移交 / u5b 接线] AP-4 读侧依赖：live client 经 sessionService.getRpcClient
    // （= pm.getClient 同源），sessionFile 经 getSummary，失效订阅表与
    // PluginService.notifyEntryInvalidation 派发共享同一实例——SESSION_READ_NOT_WIRED 装配缺口消除。
    sessionRead: {
      pm: { getClient: (sessionId: string) => deps.sessionService?.getRpcClient(sessionId) },
      getSessionSummary: (sessionId: string) => deps.sessionService?.getSummary(sessionId),
      entryInvalidation: ctx.entryInvalidation,
    },
  })

  // ── Config RPC handlers ──────────────────────────────────
  // key 前缀约定委托 config-api（P7 收尾），与 plugin-service.ts 共用单一真相源。
  registerConfigRpcHandlers(rpcServer, {
    get: async (pluginId: string, key: string) => {
      return storage.get(pluginId, toConfigKey(key))
    },
    getAll: async (pluginId: string) => {
      const allKeys = storage.keys(pluginId)
      const configKeys = allKeys.filter(isConfigKey)
      const result: Record<string, unknown> = {}
      for (const key of configKeys) {
        result[fromConfigKey(key)] = storage.get(pluginId, key)
      }
      return result
    },
    set: async (pluginId: string, key: string, value: unknown) => {
      storage.set(pluginId, toConfigKey(key), value)
    },
  })

  // ── SessionData RPC handlers ─────────────────────────────
  registerSessionDataRpcHandlers(rpcServer, {
    get: (sessionId, key) => ctx.sessionDataStore.get(sessionId, key),
    set: (sessionId, key, value) => ctx.sessionDataStore.set(sessionId, key, value),
    delete: (sessionId, key) => ctx.sessionDataStore.delete(sessionId, key),
    keys: (sessionId) => ctx.sessionDataStore.keys(sessionId),
  })

  // ── UI RPC handlers ─────────────────────────────────────
  registerUiRpcHandlers(rpcServer, {
    // S3-W4：与 plugin.notify 共享同一令牌桶（limiter 上注入，见 registerAllRpcMethods 顶部）
    limiter: notifyLimiter,
    // meta（D2）：Worker 侧生成的 requestId + effective 超时随 params 透传 UiRequestQueue
    //（queue 尊重来方 requestId，cancel 通知按它匹配；timeoutMs 供防泄漏兜底取值）
    showSelect: (title: string, options: string[], pluginId: string, meta?: UiRequestMeta) =>
      ctx.handleUiRequest('select', { title, options, ...(meta ?? {}) }, pluginId) as Promise<string | undefined>,
    showConfirm: (title: string, message: string, pluginId: string, meta?: UiRequestMeta) =>
      ctx.handleUiRequest('confirm', { title, message, ...(meta ?? {}) }, pluginId) as Promise<boolean>,
    showInput: (title: string, _defaultValue: string | undefined, pluginId: string, meta?: UiRequestMeta) =>
      ctx.handleUiRequest('input', { title, ...(meta ?? {}) }, pluginId) as Promise<string | undefined>,
    // D2 到期取消：Worker 侧 UI_TIMEOUT reject 同刻的 cancel notification → queue 删项/撤窗/放行
    onUiRequestExpired: (requestId: string) => ctx.cancelUiRequest(requestId),
    notify: async (pluginId: string, level: string, message: string) => {
      // Notify via broadcastFn —— 委托 notify-api 的单一广播真相源（P1 去重）
      // 文案与重构前逐字一致（commit 8dd3034f 父版本）
      if (!broadcastPluginNotification(deps.broadcastFn, pluginId, level, message)) {
        console.warn('[plugin-rpc-setup] ui-api notify dropped: no broadcastFn configured')
      }
    },
  })

  // ── Agent RPC handlers ──────────────────────────────────
  registerAgentRpcHandlers(rpcServer, {
    getModel: () => {
      if (!deps.sessionService) return ''
      const active = ctx.activeSessionResolver.resolve()
      return active?.modelId ?? ''
    },
    setModel: async (model: string) => {
      // U6 回执普查：返回 get_state 读回的生效模型复合串（pi pattern 换模时 ≠ 请求值）；
      // 无 sessionService / 无活跃 session / 非法复合串的降级路径返回空串。
      if (!deps.sessionService) return ''
      const active = ctx.activeSessionResolver.resolve()
      if (!active) return ''
      const parts = model.split('/')
      if (parts.length < MIN_MODEL_PARTS) return ''
      // 复合串切分边界（design D5）：parts[0] 是 provider id，从插件传入的 "providerId/modelId" 切出
      const provider = parts[0] as ProviderId
      const modelId = parts.slice(1).join('/')
      // Unified entry: persist + broadcast included（返回生效模型，session-service 读回）
      if (deps.modelService) {
        return await deps.modelService.switchModel(active.id, provider, modelId)
      }
      // Fallback: session-only (no persist/broadcast)
      return await deps.sessionService.switchModel(active.id, provider, modelId)
    },
    getThinkingLevel: () => {
      if (!deps.sessionService) return 'off'
      const active = ctx.activeSessionResolver.resolve()
      return active?.thinkingLevel ?? 'off'
    },
    setThinkingLevel: async (level: string) => {
      // U6 回执普查：返回 pi 钳制后的生效档（两条路径均 set→get_state→effective）；
      // 降级路径返回空串。
      if (!deps.sessionService) return ''
      const active = ctx.activeSessionResolver.resolve()
      if (!active) return ''
      if (deps.modelService) {
        return await deps.modelService.setThinkingLevel(active.id, level)
      }
      return await deps.sessionService.setThinkingLevel(active.id, level)
    },
    getActiveTools: () => {
      return Array.from(toolRegistry.values()).map(e => e.schema.name)
    },
  })

  // ── Commands RPC handlers ────────────────────────────────
  // 主线程侧命令注册表（register 建复合键 `pluginId:commandId` + 下行广播
  // plugin:commandRegistered）。Worker 侧 invoke 监听在 createCommandsApi，
  // 主线程发送段（executeCommand 查表 → rpcServer.notify 发 plugin.commands.invoke
  // → invoke.result 回传 resolve pending）在 PluginService.executeCommand（S3-W1）。
  registerCommandRpcHandlers(rpcServer, {
    registry: ctx.commandRegistry,
    broadcastRegistered: (reg) => {
      if (deps.broadcastFn) {
        deps.broadcastFn('plugin:commandRegistered', reg)
      } else {
        console.warn('[plugin-rpc-setup] commands.register broadcast dropped: no broadcastFn configured')
      }
    },
    deliverInvokeResult: (handlerId, payload, sourceWorkerId) =>
      ctx.deliverInvokeResult(handlerId, payload, sourceWorkerId),
  })

  // ── Plugin event / openUrl RPC handlers（provider-plugin-access D9）──────
  // plugin.event（插件 → renderer 业务事件上报）：校验后经 ctx.broadcastPluginEvent
  // 出线广播 'plugin:event' 帧（首个消费方 = 凭据状态上报，D5——宿主只转发不解释）。
  registerPluginEventRpcHandler(rpcServer, {
    broadcast: (payload) => ctx.broadcastPluginEvent(payload),
  })
  // plugin.ui.openUrl（插件 → 宿主授权页打开）：http(s) scheme 白名单校验后交
  // openExternal 出口（生产 = 系统浏览器；装配缺失回执 {opened:false} 可见降级）。
  registerOpenUrlRpcHandler(rpcServer, {
    openExternal: ctx.openExternal,
  })

  // ── Views RPC handlers ───────────────────────────────────
  // views.update → handleViewUpdate（U2 归属二选一：会话域 { sessionId } 定向投递 /
  // 全局域 { mountId, pluginId } 全局广播——校验在 views-api resolveViewScope，
  // 都缺或都给 → INVALID_VIEW_SCOPE）。
  // listMountPoints → 读挂载点集合副本（AC10：sync 注入→查询一致）。
  // wave:perf-w08（02 文档 D1-1，R-06）：广播出口为 ctx.publishViewUpdate——
  // bus 已装配时按 sessionId 定向 publish（transient），全局域走全局广播（分流见
  // publishViewUpdateTo）。快照写入与广播同源：setView 返回带 generation 的存储条目，
  // 广播帧与快照条目携带同一代际（U2 全量替换）。
  registerViewRpcHandlers(rpcServer, {
    mountPoints: ctx.mountPoints,
    handleViewUpdate: (pluginId: string, viewId: string, guiTree: GuiComponent[], scope: PluginViewScope) => {
      const updatedAt = Date.now()
      // 快照写入与广播同源（ADR-0097）：[null] 树 = 清除分区（渲染端 ViewHostStore
      // consumeWidget 清除语义的同构镜像，见 PluginUiSnapshotStore.setView）；返回
      // undefined（清除 / 归属畸形防御丢弃）时不广播——无内容可推。
      const stored = ctx.uiSnapshotStore.setView({
        ...(scope.kind === 'session' ? { sessionId: scope.sessionId } : { mountId: scope.mountId }),
        viewId,
        pluginId,
        guiTree,
        updatedAt,
        generation: 0,
      })
      if (stored !== undefined) {
        ctx.publishViewUpdate(stored)
      }
    },
  })

  // ── Workspace RPC handlers ──────────────────────────────
  registerWorkspaceRpcHandlers(rpcServer, {
    getRootPath: () => process.cwd(),
    getName: () => {
      const cwd = process.cwd()
      return cwd.split(/[/\\]/).pop() ?? ''
    },
    findFiles: (pattern: string) => findFiles(pattern, process.cwd()),
  })
}
