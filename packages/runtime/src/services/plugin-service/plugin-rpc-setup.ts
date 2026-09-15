/**
 * Plugin RPC 方法注册
 *
 * 从 PluginService.registerRpcMethods() 提取，注册所有 plugin RPC handler。
 * 包含：tool、hook、storage、notify、session、config、sessionData、ui、agent、workspace。
 */

import type { StatusBarItem, ProviderId } from '@xyz-agent/shared'
import type { PluginRpcServer } from './plugin-rpc-server.js'
import type { PluginStorage } from './plugin-storage.js'
import type { StatusBarItemOptions, IPluginServiceDeps } from './plugin-types.js'
import type { SessionDataStore } from './session-data-store.js'
import { registerToolRpcHandlers } from './tool-api.js'
import { registerHookRpcHandlers } from './hook-api.js'
import { registerSessionRpcHandlers, ActiveSessionResolver, sessionInfoFromSummary, type SessionEventDispatch } from './api/session-api.js'
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
import type { GuiComponent } from '@xyz-agent/extension-protocol'
import type { ToolEntry } from './plugin-types.js'

const MAX_FIND_FILES_RESULTS = 1000
/** MAX_FIND_FILES_RESULTS 导出供测试断言上限语义（T10：SUT 改上限时测试同步红）。 */
export { MAX_FIND_FILES_RESULTS }
const DEFAULT_STATUS_BAR_PRIORITY = 100
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
 * 活跃 session 缓存已从模块级全局状态收口为 `ActiveSessionResolver` 实例（每个
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
  statusBarItems: Map<string, StatusBarItem>
  deps: IPluginServiceDeps
  broadcastStatusBarItems: () => void
  handleUiRequest: (method: string, params: Record<string, unknown>, pluginId: string) => Promise<unknown>
  /**
   * UI 请求到期取消（timeout-plugin-service D2）：Worker 侧语义 timer 到期后经
   * plugin.ui.uiRequestExpired notification 到达，委托 UiRequestQueue.cancelRequest
   * （删 pending/排队项 + 撤窗广播 + 放行串行队列）。
   */
  cancelUiRequest: (requestId: string) => void
  syncToolsToBridge: () => Promise<void>
  getDescriptor: (pluginId: string) => import('./plugin-types.js').PluginDescriptor | undefined
  sessionDataStore: SessionDataStore
  /** 活跃 session 解析器（P6：替代模块级全局 _activeSessionCache） */
  activeSessionResolver: ActiveSessionResolver
  /** 命令注册表（复合键 `pluginId:commandId` → CommandRegistration），PluginService 实例字段注入 */
  commandRegistry: Map<string, CommandRegistration>
  /** session 事件注册表（S3-W2）：registerCreate/registerDestroy 的定向投递通道 */
  sessionEvents: SessionEventDispatch
  /** 挂载点集合（renderer 经 plugin.mountPoints.sync 上报的副本，AC10） */
  mountPoints: string[]
  /** Worker invoke.result 回传的 pending resolve/reject（S3-W1，PluginService 私有）；sourceWorkerId 为回传来源通道（D2 回传归属校验） */
  deliverInvokeResult: (handlerId: string, payload: { result?: unknown; error?: unknown }, sourceWorkerId: string) => void
  /**
   * views.update 的广播出口（wave:perf-w08，02 文档 D1-1）：PluginService 实现的
   * bus 定向发布（transient）/ 全局广播兜底分流，见 publishViewUpdate 实现。
   */
  publishViewUpdate: PluginServiceLike['publishViewUpdate']
}

/** 仅用于 RpcSetupContext.publishViewUpdate 的类型（避免 rpc-setup 反向 import plugin-service 成环） */
interface PluginServiceLike {
  publishViewUpdate(payload: {
    sessionId: string
    viewId: string
    pluginId: string
    guiTree: GuiComponent[]
    updatedAt: number
  }): void
}

export function registerAllRpcMethods(ctx: RpcSetupContext): void {
  const { rpcServer, storage, toolRegistry, hookRegistry, statusBarItems, deps } = ctx

  // S3-W4：每插件 notify 令牌桶——plugin.notify 与 plugin.ui.notify 两入口共享
  // 同一实例（同一插件的配额跨入口合并计费），默认 20 条/s（shared SSOT）。
  const notifyLimiter = new NotifyRateLimiter()

  // Tool RPC handlers
  registerToolRpcHandlers(rpcServer, {
    toolRegistry,
    syncToolsToBridge: ctx.syncToolsToBridge,
  })

  // Hook RPC handlers
  registerHookRpcHandlers(rpcServer, {
    hookRegistry,
    getDescriptor: ctx.getDescriptor,
  })

  // Storage RPC handlers — P6 收口到 api/storage-api.ts（与其它域一致）
  registerStorageRpcHandlers(rpcServer, storageHandlersFrom(storage))

  // Notify RPC handler — P6 收口到 api/notify-api.ts（fire-and-forget via broadcastFn）
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
    sendMessage: async (sessionId: string | undefined, _role: string, content: string) => {
      if (!deps.sessionService || !sessionId) return
      await deps.sessionService.sendMessage(sessionId, content)
    },
    // S3-W2：session 生命周期事件注册表（registerCreate/registerDestroy 方法在此注册）
    sessionEvents: ctx.sessionEvents,
  })

  // ── Config RPC handlers ──────────────────────────────────
  // key 前缀约定委托 config-api（P7 收口），与 plugin-service.ts 共用单一真相源。
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
    updateStatusBarItem: async (pluginId: string, id: string, text: string, options?: StatusBarItemOptions) => {
      const itemKey = `${pluginId}:${id}`
      // Empty text = remove item
      if (text === '') {
        statusBarItems.delete(itemKey)
      } else {
        const item: StatusBarItem = {
          id,
          pluginId,
          text,
          tooltip: options?.tooltip,
          commandId: options?.commandId,
          priority: options?.priority ?? DEFAULT_STATUS_BAR_PRIORITY,
          scope: options?.scope ?? 'global',
          sessionId: options?.sessionId,
        }
        statusBarItems.set(itemKey, item)
      }
      ctx.broadcastStatusBarItems()
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

  // ── Views RPC handlers ───────────────────────────────────
  // views.update → handleViewUpdate（ES2：无活跃 session 丢弃广播 + warning）；
  // listMountPoints → 读挂载点集合副本（AC10：sync 注入→查询一致）。
  // wave:perf-w08（02 文档 D1-1，R-06）：广播出口改 ctx.publishViewUpdate——
  // bus 已装配时按 payload.sessionId 定向 publish（plugin:viewUpdate 归 transient 类，
  // 不占 seq 不入 ring），不再全局 broadcast。
  registerViewRpcHandlers(rpcServer, {
    mountPoints: ctx.mountPoints,
    handleViewUpdate: (pluginId: string, viewId: string, guiTree: GuiComponent[]) => {
      const active = ctx.activeSessionResolver.resolve()
      if (!active) {
        // ES2: 无活跃 session 时丢弃广播 + warning（含 pluginId+viewId）
        console.warn(`[plugin-rpc-setup] views.update dropped: no active session (plugin=${pluginId}, view=${viewId})`)
        return
      }
      ctx.publishViewUpdate({
        sessionId: active.id,
        viewId,
        pluginId,
        guiTree,
        updatedAt: Date.now(),
      })
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
