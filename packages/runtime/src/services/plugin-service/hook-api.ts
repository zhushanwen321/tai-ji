/**
 * Hook API 模块
 *
 * 提供 Hook 注册的 RPC handler（主线程侧）和 Worker 侧代理对象。
 *
 * 主线程侧：registerHookRpcHandlers() 在 PluginRpcServer 上注册
 *   plugin.hooks.register / plugin.hooks.unregister 两个 RPC 方法。
 *
 * Worker 侧：createHookApi() 返回代理对象，提供 onBeforeSendMessage
 *   等 5 个方法，每个方法生成 handlerId、保存到本地 map、发 RPC 注册，
 *   并返回 Disposable。
 *
 * Worker 侧 hook 执行：主线程经 `plugin.hooks.invoke` 到达 Worker 有两腿（D2）：
 *   - request 腿（block/transform 类）：结果作为 RPC 响应原样回传主线程，
 *     executeHookRequest 是该 request 的执行入口（plugin-bootstrap.handleIncomingRequest
 *     调用，闭包 handlers Map 经 setHookExecutor 模块级胶水桥接）；
 *   - observe notification 腿（observe 类，D2-2）：无 id 通知，executeHookRequest
 *     执行后 fire-and-forget（不产生响应，零往返）。
 */

import type { PluginRpcServer } from './plugin-rpc-server.js'
import type { PluginRpcClient } from './plugin-rpc-client.js'
import type {
  HookEntry,
  PluginDescriptor,
  HookInterceptor,
  HookObserver,
  PiEventCallback,
  Disposable,
} from './plugin-types.js'
import { toErrorMessage } from '../../utils/errors.js'
import { registerHandler } from './handler-registry.js'
import { asSafeKey, asString } from './validation.js'

/** Hook 注册服务依赖（主线程侧） */
export interface HookService {
  /** hook 注册表，key 为 hookType，value 为该类型的所有注册条目 */
  hookRegistry: Map<string, HookEntry[]>
  /** 根据 pluginId 获取插件描述符（用于计算优先级） */
  getDescriptor(pluginId: string): PluginDescriptor | undefined
}

/** Worker 本地存储的 hook handler 包装 */
interface StoredHandler {
  /** 统一签名的调用函数 */
  invoke: (context: unknown) => Promise<unknown>
  /** 原始 handler 引用（用于 dispose 时清理） */
  original: HookInterceptor | HookObserver | PiEventCallback
}

// ── D2-1 request 直连桥接（plugin.hooks.invoke request/notification 分支） ──────────────

/**
 * 执行器返回的精确联合类型（P-6）。
 *
 * `{claimed: false}` = handlerId 不在该执行器的闭包 Map（NOT_CLAIMED 哨兵的对象化），
 * 交由下一个执行器认领（多插件共享 trusted Worker 场景）；`{claimed: true, value}` =
 * 认领并执行完成，value 为 handler 返回值（原样作为 RPC 响应回传）。
 * 不写成 `unknown | typeof NOT_CLAIMED`——TS 中 unknown 会吸收整个联合，类型层
 * 失去区分度，只能靠运行时哨兵比较。
 */
export type HookExecutorOutcome = { claimed: false } | { claimed: true; value: unknown }

/**
 * 按 handlerId 执行 hook handler 的执行器签名。
 *
 * createHookApi 把闭包 handlers Map 包装成执行器，经 setHookExecutor 注册到模块级胶水；
 * plugin-bootstrap 的 `plugin.hooks.invoke` request/observe notification 分支经
 * executeHookRequest 调用。多插件可共享同一个 trusted Worker（每插件一次 createHookApi
 * 调用、一份闭包 Map），handlerId 全局唯一（`hook_${pluginId}_${counter}`），逐执行器认领。
 */
type HookExecutor = (params: { handlerId: string; context: unknown }) => Promise<HookExecutorOutcome>

/** 模块级胶水：当前 Worker 内全部活跃 hook 执行器 */
const hookExecutors = new Set<HookExecutor>()

/** 注册 hook 执行器（createHookApi 调用；返回拆除函数，P-2：dispose 后从 Set 移除） */
export function setHookExecutor(executor: HookExecutor): () => void {
  hookExecutors.add(executor)
  return () => {
    hookExecutors.delete(executor)
  }
}

/** 模块级胶水：pluginId → 该插件全部本地 hook 资源的拆除函数（P-1，deactivate 时消费） */
const pluginHookDisposers = new Map<string, () => void>()

/**
 * 清理指定插件的 Worker 本地 hook 资源（P-1：禁用插件的 hook 不再执行）。
 *
 * plugin-bootstrap 的 'deactivate' 消息分支调用：清空该插件闭包 Map 中全部 handler
 * 并从 hookExecutors 摘除执行器（P-2：Set 只增不减的泄漏点）。与主线程侧
 * togglePlugin(false) 清 hookRegistry 对偶——两侧同时清，禁用插件的 handlerId
 * 既无注册条目也无本地 handler，任何迟到 invoke 都落到「未认领 → 放行」。
 */
export function disposePluginHooks(pluginId: string): void {
  const dispose = pluginHookDisposers.get(pluginId)
  if (!dispose) return
  pluginHookDisposers.delete(pluginId)
  dispose()
}

/**
 * `plugin.hooks.invoke` 的 Worker 侧执行入口（plugin-bootstrap.handleMessage 调用：
 * request 分支的结果作为 RPC 响应回传主线程；observe notification 分支 fire-and-forget）。
 *
 * 按 handlerId 查活跃执行器并调用 hook handler：
 * - handler 不存在（未注册 / 已 dispose）→ 全部执行器未认领，返回 `{proceed: true}` 放行，
 *   对齐主线程「Worker crashed → skip handler」的放行语义
 * - handler 抛错 → 向上抛，由 bootstrap 分支按「异常放行」兜底回 `{proceed: true}`
 */
export async function executeHookRequest(params: unknown): Promise<unknown> {
  const p = params as { handlerId?: unknown; context?: unknown }
  if (p && typeof p.handlerId === 'string') {
    for (const executor of hookExecutors) {
      const outcome = await executor({ handlerId: p.handlerId, context: p.context })
      if (outcome.claimed) return outcome.value
    }
  }
  return { proceed: true }
}

let hookCounter = 0

/**
 * 根据 PluginDescriptor 计算优先级。
 *
 * - built-in 插件: 0（最高优先级）
 * - trusted 外部插件: 100
 * - sandbox 插件: 200（最低优先级）
 */
const PRIORITY_BUILT_IN = 0
const PRIORITY_TRUSTED = 100
const PRIORITY_SANDBOX = 200

function computePriority(descriptor: PluginDescriptor): number {
  if (descriptor.source === 'built-in') return PRIORITY_BUILT_IN
  if (descriptor.trustLevel === 'trusted') return PRIORITY_TRUSTED
  return PRIORITY_SANDBOX
}

/**
 * 在 PluginRpcServer 上注册 hook 相关的 RPC handler。
 *
 * 注册的方法：
 * - `plugin.hooks.register` — 注册 hook handler，按 priority 排序存储
 * - `plugin.hooks.unregister` — 注销 hook handler（归属隔离：只删 pluginId 与
 *   请求一致的条目，D7 语义，见 handler 注释）
 */
export function registerHookRpcHandlers(
  rpcServer: PluginRpcServer,
  service: HookService,
): void {
  rpcServer.registerMethod('plugin.hooks.register', async (params) => {
    // S3-W3 窄校验：handlerId 形如 `hook_<pluginId>_<n>`（Worker 侧生成模式），
    // 与 pluginId 均在 asSafeKey 白名单内；hookType 是枚举词汇（onXxx），只需
    // 防「缺字段/错类型」（未知 hookType 注册后无触发点，不构成毒化）。
    const pluginId = asSafeKey(params.pluginId, 'pluginId')
    const hookType = asString(params.hookType, 'hookType')
    const handlerId = asSafeKey(params.handlerId, 'handlerId')

    // 获取插件描述符以计算优先级
    const descriptor = service.getDescriptor(pluginId)
    const priority = descriptor ? computePriority(descriptor) : PRIORITY_SANDBOX

    // 存储到 hookRegistry
    let entries = service.hookRegistry.get(hookType)
    if (!entries) {
      entries = []
      service.hookRegistry.set(hookType, entries)
    }
    entries.push({ pluginId, handlerId, priority })

    // 按 priority 排序（低数值先执行）
    entries.sort((a, b) => a.priority - b.priority)

    return { registered: true }
  })

  rpcServer.registerMethod('plugin.hooks.unregister', async (params) => {
    const handlerId = asSafeKey(params.handlerId, 'handlerId')
    const hookType = asString(params.hookType, 'hookType')
    // D7 归属隔离（对齐 commands/tools.unregister 语义）：pluginId 必填，且只删除
    // pluginId 与请求一致的条目。sandbox 通道 params.pluginId 已被 dispatch 覆写为
    // 通道身份（不可伪造）——插件 B 传他人 handlerId（'hook_A_1'）不命中 → no-op，
    // A 的注册不受影响。
    const pluginId = asSafeKey(params.pluginId, 'pluginId')

    const entries = service.hookRegistry.get(hookType)
    if (entries) {
      const idx = entries.findIndex(e => e.handlerId === handlerId && e.pluginId === pluginId)
      if (idx >= 0) {
        entries.splice(idx, 1)
      }
      if (entries.length === 0) {
        service.hookRegistry.delete(hookType)
      }
    }

    return { unregistered: true }
  })
}

/**
 * 创建 Worker 侧 Hook API 代理对象。
 *
 * 每个 onXxx 方法会：
 * 1. 生成唯一 handlerId
 * 2. 保存 handler 到 Worker 本地 map（handlerId → 包装后的 invoke 函数）
 * 3. 发 RPC 到主线程注册
 * 4. 返回 Disposable（取消注册时发 RPC 并清理本地 map）
 *
 * 同时把闭包 handlers Map 包装成执行器，经 setHookExecutor 注册到模块级胶水，
 * 供 plugin-bootstrap 的 `plugin.hooks.invoke` request 分支经 executeHookRequest
 * 调用（D2-1 request 直连；结果作为 RPC 响应回传，不再走独立的 result 回传 RPC）。
 */
export function createHookApi(
  rpcClient: PluginRpcClient,
  pluginId: string,
): {
  onBeforeSendMessage(handler: HookInterceptor): Promise<Disposable>
  onBeforeToolCall(handler: HookInterceptor): Promise<Disposable>
  onBeforeAgentStart(handler: HookInterceptor): Promise<Disposable>
  onAfterToolResult(handler: HookObserver): Promise<Disposable>
  onPiEvent(eventName: string, handler: PiEventCallback): Promise<Disposable>
} {
  const handlers = new Map<string, StoredHandler>()

  // 闭包 handlers Map → 模块级胶水桥接（plugin-bootstrap 的 request/notification 分支消费）。
  // 未认领返回 {claimed:false}，交由下一个执行器（多插件共享 trusted Worker 场景）。
  const removeExecutor = setHookExecutor(async ({ handlerId, context }) => {
    const stored = handlers.get(handlerId)
    if (!stored) return { claimed: false }
    return { claimed: true, value: await stored.invoke(context) }
  })

  // P-1/P-2：登记该插件全部本地 hook 资源的拆除函数（'deactivate' 消息经
  // disposePluginHooks 消费）——清空闭包 Map 并从 hookExecutors 摘除执行器。
  pluginHookDisposers.set(pluginId, () => {
    handlers.clear()
    removeExecutor()
  })

  /**
   * 注册一个 hook handler：先保存到本地 map，再发 RPC 到主线程（P-7：反转后的顺序
   * 消除竞态——主线程注册成功即可 invoke，本地 handler 必已就绪；RPC 失败则回滚本地
   * 注册并向上抛）。返回 Disposable 用于取消注册。
   */
  async function registerHook(
    hookType: string,
    handler: HookInterceptor | HookObserver | PiEventCallback,
    invoke: (context: unknown) => Promise<unknown>,
  ): Promise<Disposable> {
    const handlerId = `hook_${pluginId}_${++hookCounter}`

    const disposable = registerHandler(handlers, handlerId, { invoke, original: handler }, () => {
      rpcClient
        .request('plugin.hooks.unregister', { pluginId, hookType, handlerId })
        .catch((e: unknown) => {
          console.error('[hook-api] hook unregister failed:', toErrorMessage(e))
        })
    })

    try {
      await rpcClient.request('plugin.hooks.register', {
        pluginId,
        hookType,
        handlerId,
      })
    } catch (e: unknown) {
      // P-7 失败回滚：主线程无此注册条目，dispose 触发的 unregister RPC 对不存在的
      // handlerId 是 no-op（findIndex -1 跳过），无副作用
      disposable.dispose()
      throw e
    }

    return disposable
  }

  return {
    /**
     * 注册消息发送前拦截器。可阻止发送或修改消息内容。
     * handler 返回 InterceptorResult（proceed/reason/modifiedData）。
     */
    onBeforeSendMessage: (handler: HookInterceptor) =>
      registerHook('onBeforeSendMessage', handler, async (ctx) => handler(ctx as Parameters<HookInterceptor>[0])),

    /**
     * 注册工具调用前拦截器。可阻止调用或修改参数。
     */
    onBeforeToolCall: (handler: HookInterceptor) =>
      registerHook('onBeforeToolCall', handler, async (ctx) => handler(ctx as Parameters<HookInterceptor>[0])),

    /**
     * 注册 Agent 启动前拦截器。可阻止启动。
     */
    onBeforeAgentStart: (handler: HookInterceptor) =>
      registerHook('onBeforeAgentStart', handler, async (ctx) => handler(ctx as Parameters<HookInterceptor>[0])),

    /**
     * 注册工具结果后观察者。只能读取数据，不能阻止；可选返回
     * InterceptorResult.modifiedData 改写 output（D2-3 transform 语义，包装透传返回值）。
     */
    onAfterToolResult: (handler: HookObserver) =>
      registerHook('onAfterToolResult', handler, async (ctx) => {
        return await handler(ctx as Parameters<HookObserver>[0])
      }),

    /**
     * 注册 pi 事件观察者。
     *
     * D2-4：注册 key 统一为泛型 `'onPiEvent'`（不按事件名细分）——与调用侧
     * （event-interpreter / bridge-interop）的泛型调用对齐，事件名经 context 传给
     * handler，插件在 handler 内自行按事件名过滤。
     *
     * context 形状适配（三类调用方统一解析，Fix-2）：
     * - bridge 包装 / 标准 HookContext：`data: { eventName, data, ... }` ——事件名与
     *   负载嵌套在 ctx.data 内，payload 解包为内层 data
     * - 平铺变体：`{ eventName, data }` 直接在 ctx 顶层 ——payload 取顶层 data
     * - event-interpreter 平铺：`{ event, ...payload }` ——payload 为剥离 event/eventName
     *   元字段后的剩余字段（handler 的 data 不再混入 event 字段本身）
     *
     * eventName 解析优先级：实际收到的 `event` 字段 > 顶层 `eventName` > bridge 包装内
     * `data.eventName` > 注册时 eventName（最后兜底）。payload.data 存在但其内无
     * eventName 时不会覆盖实际收到的 event 字段（Fix-2 错报边界）。
     * handler 统一收到 `(eventName, data)`。
     */
    onPiEvent: (eventName: string, handler: PiEventCallback) =>
      registerHook(
        'onPiEvent',
        handler,
        async (ctx) => {
          const c = (ctx ?? {}) as {
            event?: unknown
            eventName?: unknown
            data?: { eventName?: unknown; data?: unknown }
          }
          const nested = c.data
          const resolvedEventName =
            (typeof c.event === 'string' ? c.event : undefined)
            ?? (typeof c.eventName === 'string' ? c.eventName : undefined)
            ?? (typeof nested?.eventName === 'string' ? nested.eventName : undefined)
            ?? eventName
          let payload: unknown
          if (typeof nested?.eventName === 'string') {
            // bridge 包装 {eventName, data, ...}：解包内层 data
            payload = nested.data !== undefined ? nested.data : nested
          } else if (typeof c.eventName === 'string' && c.data !== undefined) {
            // 平铺变体 {eventName, data}：取顶层 data
            payload = c.data
          } else {
            // event-interpreter 平铺 {event, ...payload}：剥离元字段后透传业务负载
            const { event: _event, eventName: _eventName, ...rest } = c as Record<string, unknown>
            payload = rest
          }
          await handler(resolvedEventName, payload)
          return undefined
        },
      ),
  }
}
