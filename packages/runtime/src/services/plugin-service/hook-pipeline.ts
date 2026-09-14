/**
 * Hook 执行管道（HookPipeline）
 *
 * 从 PluginService 抽出的正交职责：hook 排序 / 串行执行 / 5s 超时 / block 语义 /
 * content transform。
 *
 * 设计要点（ADR-0012 契约不变）：
 * - 持有 hookRegistry 引用（与 rpc-setup 注册侧、本类消费侧共享同一 Map 实例，
 *   保证注册与执行看到同一份状态）。
 * - 持有 host / rpcServer 引用用于实际派发到 Worker。
 * - 行为与原 PluginService.executeHooks 一致：按 priority 升序串行执行，
 *   proceed === false 终止链路（block），modifiedData 透传（transform），
 *   每个 handler 超时 5s、超时/异常视为放行，Worker crashed 跳过该 handler。
 * - D2-3 映射层：Worker 响应（InterceptorResult）到 HookResult 的字段映射在此收口
 *   （modifiedData → transformedData），消费侧（event-interpreter 等）读 transformedData。
 * - 注入透传（git `7a3797d0b` 版 plugin-intercept-injection §3.3-D2/D5，文档已退役于
 *   `fadd8b8b4`）：注入形状守卫在本层逐插件
 *   执行（本层是唯一持有 pluginId 的位置）；injectedMessages 跨插件累积拼接（非覆盖），
 *   消费方为 handleBridgeIntercept 的注入映射（bridge-interop.ts）。
 */

import type { HookEntry, HookContext, HookResult } from './plugin-types.js'
import type { PluginHost } from './plugin-host.js'
import type { PluginRpcServer } from './plugin-rpc-server.js'
import { toErrorMessage } from '../../utils/errors.js'

/** 每个 hook handler 的执行超时（ms） */
const HOOK_HANDLER_TIMEOUT_MS = 5_000

/** describeShape 的 warn 摘要截断上限（chars）：防超大条目刷日志 */
const WARN_SUMMARY_MAX_CHARS = 80

/**
 * observe 类 hookType 集合（D2-2）：fire-and-forget 语义，经 notifyObservers 以
 * rpcServer.notify 零往返派发（无 pending 登记、无超时定时器、不等响应）。
 * block/transform 类不在集合内，走 execute 的 request 腿（同步拿结果）。
 */
export const OBSERVE_HOOK_TYPES: ReadonlySet<string> = new Set(['onPiEvent'])

/**
 * 唯一消费注入的 hookType（设计 §3.3-D1 契约边界）：injectedMessages 仅
 * onBeforeAgentStart（bridge intercept 链路）被消费；其余 intercept hookType
 * 返回非空注入类型合法但无运行时效果，本层忽略 + warn 留痕（D5 行 3）。
 */
const INJECTION_CONSUMING_HOOK_TYPE = 'onBeforeAgentStart'

/** HookPipeline 所需的派发依赖（最小接口，便于单测 mock） */
export interface HookPipelineDeps {
  /** 共享的 hook 注册表（注册侧与本类消费侧同一实例） */
  hookRegistry: Map<string, HookEntry[]>
  /** Worker host，用于查询插件所在 Worker handle */
  host: PluginHost
  /** RPC server，用于向 Worker 派发 hook 调用 */
  rpcServer: PluginRpcServer
}

export class HookPipeline {
  private readonly hookRegistry: Map<string, HookEntry[]>
  private readonly host: PluginHost
  private readonly rpcServer: PluginRpcServer

  constructor(deps: HookPipelineDeps) {
    this.hookRegistry = deps.hookRegistry
    this.host = deps.host
    this.rpcServer = deps.rpcServer
  }

  /** 暴露共享注册表引用（rpc-setup 注册侧、uninstallPlugin 清理侧使用） */
  get registry(): Map<string, HookEntry[]> {
    return this.hookRegistry
  }

  /**
   * 执行指定 hookType 的钩子管道（request 腿：block/transform 类）。
   *
   * 从 hookRegistry 获取 handlers 后串行执行——entries 在注册时已按 priority 升序
   * 保序（hook-api.ts registerHookRpcHandlers 的 entries.sort，D2-5：执行侧不再重复
   * 排序；unregister 的 splice 与卸载清理的 filter 均保序）。
   * 支持 block（proceed === false 终止链路）和 content transform（modifiedData 传递）。
   * 每个 handler 超时 5s，超时/异常视为放行。Worker crashed → skip 该 handler。
   *
   * @param hookType - hook 类型（如 'onBeforeSendMessage'）
   * @param context - Hook 执行上下文（会被 transform 修改）
   * @returns HookResult
   */
  async execute(hookType: string, context: HookContext): Promise<HookResult> {
    const entries = this.hookRegistry.get(hookType)
    if (!entries || entries.length === 0) return { blocked: false }

    // D2-3 映射层：Worker 响应 {proceed, reason, modifiedData} → HookResult
    // {blocked, blockedBy, reason, transformedData}。transformedData 取链上最后一个
    // 非 undefined 的 modifiedData（与下游 handler 间 context.data 的传递终值一致）。
    let transformedData: unknown

    // 注入累积（设计 §3.3-D2）：与 transformedData 的「链上最后一个」覆盖语义显式
    // 分叉——合法条目按 priority 执行序累积拼接，不被后续插件整体覆盖。
    const injectedMessages: string[] = []

    // 串行执行：await 每个 handler，支持 transform 和 block
    for (const entry of entries) {
      const handle = this.host.getWorkerHandle(entry.pluginId)
      if (!handle) continue // Worker crashed → skip

      try {
        const result = await this.rpcServer.invoke(
          handle.workerId,
          'plugin.hooks.invoke',
          {
            handlerId: entry.handlerId,
            hookType,
            context,
          },
          HOOK_HANDLER_TIMEOUT_MS, // 每个 handler 超时
        ) as Record<string, unknown>

        // 统一处理序（设计 §3.3-D2）：① 注入形状校验（合法条目 push 进累积）→
        // ② block 判定 → ③ transform。各步判定收口在模块私有 helper，顺序由
        // execute 主循环保证（校验先于 block 判定——block 插件的畸形注入照样
        // warn，block 插件自身的合法注入进累积并随 blocked 回包透传，阻止与
        // 留言互不吞没）。
        applyInjectionCollection(result, hookType, entry, injectedMessages)

        // 检查是否被阻止
        const blocked = buildBlockedResult(result, entry, injectedMessages)
        if (blocked) return blocked

        // 检查是否需要转换内容
        const modifiedData = extractModifiedData(result)
        if (modifiedData !== undefined) {
          context = {
            ...context,
            data: modifiedData,
          }
          transformedData = modifiedData
        }

      } catch (err: unknown) {
        // 超时或错误 → 视为放行（不阻止链路）
        console.warn(
          `[plugin-service] hook handler ${entry.handlerId} failed/timed out:`,
          toErrorMessage(err),
        )
      }
    }

    // 成功回包：transformedData（覆盖语义）与 injectedMessages（累积语义）可并存，
    // 各自仅在非空时携带键（无注入回包形状与既有行为一致——G4 不倒退）
    const finalResult: HookResult = { blocked: false }
    if (transformedData !== undefined) finalResult.transformedData = transformedData
    if (injectedMessages.length > 0) finalResult.injectedMessages = injectedMessages
    return finalResult
  }

  /**
   * observe 类 hook 的零往返派发（D2-2）：对每个注册 handler 发无 id 通知后立即返回。
   *
   * 与 execute 的差异：rpcServer.notify（无 pending 登记、无超时定时器、不等响应），
   * Worker 侧 handleMessage 的 notification 分支执行 handler 后丢弃结果（fire-and-forget）。
   * Worker crashed → skip 该 handler（与 execute 语义一致）。entries 注册时已按
   * priority 保序（D2-5），postMessage FIFO 保证到达顺序。
   */
  notifyObservers(hookType: string, context: HookContext): void {
    const entries = this.hookRegistry.get(hookType)
    if (!entries || entries.length === 0) return

    for (const entry of entries) {
      const handle = this.host.getWorkerHandle(entry.pluginId)
      if (!handle) continue // Worker crashed → skip
      this.rpcServer.notify(handle.workerId, 'plugin.hooks.invoke', {
        handlerId: entry.handlerId,
        hookType,
        context,
      })
    }
  }
}

/**
 * execute 单 handler 结果的注入步（设计 §3.3-D2 处理序 ①）：
 * 消费型 hookType 逐条目形状校验并累积；非消费型返回非空注入 → 误用整体
 * 忽略 + warn（D5 行 3；不做形状校验——畸形叠加是双重 warn 无意义，设计 r3 INFO）。
 */
function applyInjectionCollection(
  result: Record<string, unknown>,
  hookType: string,
  entry: HookEntry,
  injectedMessages: string[],
): void {
  if (!(result && typeof result === 'object' && result.injectedMessages !== undefined)) return
  if (hookType === INJECTION_CONSUMING_HOOK_TYPE) {
    collectInjectedMessages(result.injectedMessages, entry.pluginId, injectedMessages)
  } else if (hasNonEmptyInjection(result.injectedMessages)) {
    console.warn(
      `[plugin-service] ignoring injectedMessages from plugin ${entry.pluginId}: ` +
      `hookType ${hookType} does not consume injected messages (only ${INJECTION_CONSUMING_HOOK_TYPE} does)`,
    )
  }
}

/**
 * execute 单 handler 结果的 block 步（设计 §3.3-D2 处理序 ②）：proceed === false 时
 * 构造 blocked 回包，否则返回 undefined（放行）。
 * block 前已累积的注入（含 block 插件自身合法注入，push 在 block 判定之前完成）随
 * blocked 回包透传（设计 §3.3-D2 block 交互定案）；空累积不带键，保持既有 block 回包形状。
 */
function buildBlockedResult(
  result: Record<string, unknown>,
  entry: HookEntry,
  injectedMessages: string[],
): HookResult | undefined {
  if (!(result && typeof result === 'object' && 'proceed' in result && result.proceed === false)) {
    return undefined
  }
  const blocked: HookResult = {
    blocked: true,
    reason: (result.reason as string) ?? `Blocked by plugin ${entry.pluginId}`,
    blockedBy: entry.pluginId,
  }
  if (injectedMessages.length > 0) blocked.injectedMessages = injectedMessages
  return blocked
}

/**
 * execute 单 handler 结果的 transform 步（设计 §3.3-D2 处理序 ③）：提取链上
 * modifiedData（undefined = 无转换）。返回值语义 = 原判定
 * `'modifiedData' in result && result.modifiedData !== undefined`。
 */
function extractModifiedData(result: Record<string, unknown>): unknown {
  if (result && typeof result === 'object' && 'modifiedData' in result && result.modifiedData !== undefined) {
    return result.modifiedData
  }
  return undefined
}

/**
 * 逐条目形状校验并把合法条目 push 进累积数组（设计 §3.3-D2/D5 行 1/2）。
 *
 * 非数组整体丢弃 + warn（含 pluginId；Array.isArray 判定在 push 之前——字符串值
 * 不会被 spread 拆条）；数组内非 string 条目丢弃该条 + warn（含 pluginId + 条目序号），
 * 合法条目照常累积（G3：丢弃 + 留痕，不炸 turn）。
 */
function collectInjectedMessages(value: unknown, pluginId: string, collected: string[]): void {
  if (!Array.isArray(value)) {
    console.warn(
      `[plugin-service] drop malformed injectedMessages from plugin ${pluginId}: ` +
      `expected array, got ${describeShape(value)}`,
    )
    return
  }
  value.forEach((item, index) => {
    if (typeof item !== 'string') {
      console.warn(
        `[plugin-service] drop malformed injectedMessages entry ${index} from plugin ${pluginId}: ` +
        `not a string (${describeShape(item)})`,
      )
      return
    }
    collected.push(item)
  })
}

/** 误用判定的「非空注入」：空数组等价无注入（D5 行「空数组」格，无日志）；null 静默忽略 */
function hasNonEmptyInjection(value: unknown): boolean {
  return Array.isArray(value) ? value.length > 0 : value !== null
}

/** 收到的形状摘要（warn 日志用）：string 原样、其余 JSON 化；截断防超大条目刷日志 */
function describeShape(value: unknown): string {
  let text: string
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value) ?? String(value)
  } catch {
    text = String(value) // 循环引用等 JSON 序列化失败 → 兜底
  }
  return text.length > WARN_SUMMARY_MAX_CHARS
    ? `${text.slice(0, WARN_SUMMARY_MAX_CHARS)}…`
    : text
}
