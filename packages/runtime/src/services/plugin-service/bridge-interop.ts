/**
 * Bridge interop — pi ↔ plugin adapter
 *
 * 统一持有所有 bridge 塑形逻辑：工具 schema 缓存 + 同步负载构造（P5 收口）
 * + tool 执行 + event/intercept 处理。plugin-service 只做薄门面委托，
 * transport（bridge-handler）只 reply 本模块产出的负载。
 *
 * 拆分前这些职责分散在 plugin-service.ts（syncToolsToBridge /
 * getBridgeSyncPayload）与 bridge-interop.ts（execute/event/intercept），
 * 现统一在此——pi↔plugin 适配器单一文件。
 */

import type { HookContext, HookResult, BridgeToolExecuteRequest, BridgeToolExecuteResponse, BridgeInterceptResponse, BridgeSyncPayload, HookType, ToolEntry, ToolRegistration } from './plugin-types.js'
import type { PluginHost } from './plugin-host.js'
import type { PluginRpcServer } from './plugin-rpc-server.js'
import { toErrorMessage } from '../../utils/errors.js'

/**
 * 工具执行默认超时（D1：任务级防挂死兜底，docs/design/timeout-plugin-service-granularity.md §6.1）。
 *
 * 旧值 30s 固定墙钟误杀长工具（失败模式 A）；新默认可被 ToolRegistration.timeoutMs
 * 声明覆盖（声明通道 U2 落地），声明 <=0 / Infinity 显式 opt-out（见 resolveToolTimeoutMs）。
 * 30min 与本仓既有裁决同值：subagent-core dialog-queue DEFAULT_DIALOG_TIMEOUT_MS、
 * session-runner SPAWN_WATCHDOG_FLOOR_MS。
 */
export const DEFAULT_TOOL_EXECUTE_TIMEOUT_MS = 1_800_000

/**
 * Node setTimeout delay 安全上限（2^31-1）：超域 delay 会被 Node 塌缩为 1ms 立即
 * 触发（语义反转：刚发起就超时）。权威源 @zhushanwen/subagent-core/shared/timer-delay.ts
 * （dialog-queue 同款 clamp 惯例）——runtime 尚无该符号的 import 先例，本地同值定义
 * （平台常量无漂移面），避免首创跨包深路径耦合。
 */
const MAX_TIMER_DELAY_MS = 2_147_483_647

/**
 * declared 是否为参与取值的合法正数声明（合法域判定的单一权威源）：
 * finite 且 > 0 才生效——NaN / ±Infinity / undefined / 运行时脏值均不算合法声明。
 * 导出供 commands-executor（D4）复用，消除 declaredActive 内联复制的假差异。
 */
export function isDeclaredTimeoutActive(declared: number | undefined): declared is number {
  return typeof declared === 'number' && Number.isFinite(declared) && declared > 0
}

/**
 * 解析工具执行的有效超时（对齐 dialog-queue resolveDialogTimeoutMs 形态，D1 取值链）：
 * 1. 合法正数声明优先，clamp 到 MAX_TIMER_DELAY_MS（超域值经 Node setTimeout 会塌缩
 *    1ms 反转为立即超时，clamp 是「近乎不限时」意图在 timer 域内的安全近似）；
 * 2. declared <= 0 或 Infinity 视为显式 opt-out（不限时）——invoke 的 timeoutMs 必传
 *    （plugin-rpc-server.ts，不注册 timer 需改其签名），故以 clamp 上界 2^31-1 近似
 *    「不限时」（约 24.8 天，实际等价于不设防挂死兜底）；
 * 3. 非法值（undefined / NaN / 非数值）回落 DEFAULT_TOOL_EXECUTE_TIMEOUT_MS——不因
 *    脏参数拆掉防挂死兜底。
 */
export function resolveToolTimeoutMs(declared?: number): number {
  if (isDeclaredTimeoutActive(declared)) {
    return Math.min(declared, MAX_TIMER_DELAY_MS)
  }
  if (typeof declared !== 'number' || Number.isNaN(declared)) {
    return DEFAULT_TOOL_EXECUTE_TIMEOUT_MS
  }
  return MAX_TIMER_DELAY_MS
}

/** 时长文案换算基数（命名常量惯例对齐 subagent-core dialog-queue / session-runner） */
const MS_PER_SECOND = 1_000
const SECONDS_PER_MINUTE = 60
const MS_PER_MINUTE = SECONDS_PER_MINUTE * MS_PER_SECOND

/** 毫秒时长 → 诚实可读文案（整分/整秒/毫秒，不四舍五入以免低报等待时长）。
 * 导出供 commands-executor（D4 busy 提示）复用，消除本地复制的假差异（输出格式 SSOT）。 */
export function formatDurationMs(ms: number): string {
  if (ms % MS_PER_MINUTE === 0) return `${ms / MS_PER_MINUTE}min`
  if (ms % MS_PER_SECOND === 0) return `${ms / MS_PER_SECOND}s`
  return `${ms}ms`
}

/**
 * pi 事件 → plugin HookType 翻译映射表（IF1，D4）。
 *
 * pi 侧 bridge extension（extensions/taiji/plugin-bridge/src/index.ts 的 pi.on 注册段，
 * select+BRIDGE_MARKER 通道）转发的事件名是 snake_case（before_agent_start），而插件
 * HookRegistry 按 camelCase HookType（onBeforeAgentStart/onPiEvent/onAfterToolResult）
 * 注册——不经翻译永远匹配不上。
 *
 * kind 语义：
 * - 'intercept'：可拦截事件，经 handleBridgeIntercept 链路，block/injectedMessages 生效
 * - 'observe'：纯观察事件，经 handleBridgeEvent 链路 → observe 快捷路径 notify（D2-2，零往返）
 *
 * 映射分流（D2-2 逐类定案，R-01）：
 * - observe 组 7 项挂泛型 `onPiEvent`——唯一可注册的 observe 通道（事件名随 context
 *   传给 handler，插件自滤），随 observe 快捷路径走 rpcServer.notify
 * - tool_call/tool_result 两项保持 `onAfterToolResult` + request 腿——该 hookType 的
 *   transform 语义（改写 output）需要同步回传，必须走 invoke；其 observe 需求由同事件
 *   的 onPiEvent 通知覆盖（event-interpreter 在 tool 事件点已有 onPiEvent 调用）
 *
 * 未在表中的事件名不翻译（返回空响应，保持 pi 协议兼容，ERR2）。
 */
export const PI_HOOK_EVENT_MAP: Record<string, { hookType: HookType; kind: 'intercept' | 'observe' }> = {
  before_agent_start: { hookType: 'onBeforeAgentStart', kind: 'intercept' },
  tool_call: { hookType: 'onAfterToolResult', kind: 'observe' },
  tool_result: { hookType: 'onAfterToolResult', kind: 'observe' },
  agent_start: { hookType: 'onPiEvent', kind: 'observe' },
  agent_end: { hookType: 'onPiEvent', kind: 'observe' },
  message_end: { hookType: 'onPiEvent', kind: 'observe' },
  turn_end: { hookType: 'onPiEvent', kind: 'observe' },
  session_start: { hookType: 'onPiEvent', kind: 'observe' },
  session_compact: { hookType: 'onPiEvent', kind: 'observe' },
  session_tree: { hookType: 'onPiEvent', kind: 'observe' },
}

/**
 * 工具 schema 缓存 + bridge:sync 负载塑形 + 按 name 执行路由索引（P5 从 plugin-service.ts 收口到此）。
 *
 * 持有 bridge 轮询缓存（`bridgeToolSchemas`）与 name → ToolEntry 索引（微项 7：
 * handleBridgeToolExecute 的 O(1) 路由），并把 ToolRegistration[] 塑形成
 * {name,description,parameters} 数组——这是插件域能力塑形，归 adapter 而非 transport。
 * transport 只 reply `getSyncPayload()` 的返回值。
 *
 * 索引与 registry 的同步约定：所有 toolRegistry 写点（plugin.tools.register/unregister
 * RPC handler、uninstallPlugin）之后都调 syncToolsToBridge() 刷新本缓存；索引 miss 时
 * handleBridgeToolExecute 回退线性扫 registry（防御未 sync 的写入），正确性不依赖
 * sync 时机。
 */
export class BridgeToolCache {
  private schemas: ToolRegistration[] = []
  private entriesByName = new Map<string, ToolEntry>()

  /** 同步 toolRegistry schema 到 bridge 轮询缓存 + name 执行路由索引 */
  syncFrom(toolRegistry: Map<string, ToolEntry>): void {
    const entries = Array.from(toolRegistry.values())
    this.schemas = entries.map(e => e.schema)
    this.entriesByName = new Map(entries.map(e => [e.schema.name, e]))
  }

  /** 获取 bridge 轮询缓存的工具 schema */
  getSchemas(): ToolRegistration[] {
    return this.schemas
  }

  /** 按工具 name 查执行路由条目（微项 7：O(1)） */
  getEntryByName(name: string): ToolEntry | undefined {
    return this.entriesByName.get(name)
  }

  /**
   * 构造 bridge:sync 同步负载（plugin 工具 schema 塑形）。
   * pi 侧命令发现不走本协议（另走 getCommands 通路）。
   */
  getSyncPayload(): BridgeSyncPayload {
    const tools = this.schemas.map(s => ({ name: s.name, description: s.description, parameters: s.parameters }))
    return { tools, success: true }
  }
}

export async function handleBridgeToolExecute(
  request: BridgeToolExecuteRequest,
  toolRegistry: Map<string, ToolEntry>,
  host: PluginHost,
  rpcServer: PluginRpcServer,
  toolNameIndex?: { getEntryByName(name: string): ToolEntry | undefined },
): Promise<BridgeToolExecuteResponse> {
  // 微项 7：name 索引 Map.get O(1) 命中；miss（索引未刷新/未注入）回退线性扫，语义等价
  const entry = toolNameIndex?.getEntryByName(request.toolName)
    ?? Array.from(toolRegistry.values()).find(e => e.schema.name === request.toolName)
  if (!entry) {
    return { content: `Tool not found: ${request.toolName}`, isError: true }
  }

  const handle = host.getWorkerHandle(entry.pluginId)
  if (!handle) {
    return { content: 'Plugin worker crashed', isError: true }
  }

  // D1 取值链：声明 timeoutMs（合法正数）优先，否则默认兜底；<=0/Infinity opt-out。
  // 注册入口已窄校验（U2），脏值防御由 resolveToolTimeoutMs 全分支兜住
  const declared = entry.schema.timeoutMs
  const timeoutMs = resolveToolTimeoutMs(declared)

  try {
    const result = await rpcServer.invoke(
      handle.workerId,
      'plugin.tool.execute',
      {
        pluginId: entry.pluginId,
        toolName: request.toolName,
        arguments: request.parameters,
        sessionId: request.sessionId,
        toolCallId: request.toolCallId,
      },
      timeoutMs,
    )
    return result as BridgeToolExecuteResponse
  } catch (err: unknown) {
    if (err instanceof Error && err.message.includes('RPC timeout')) {
      // 超时错误诚实化（设计 §5.2 文案）：等了多久 / 默认还是声明值 / handler 仍在跑
      // 结果将丢弃 / 插件作者如何调整。迟到回包经 PendingTracker miss 静默丢弃，不炸。
      const source = isDeclaredTimeoutActive(declared) ? 'declared' : 'default'
      return {
        content:
          `Plugin tool '${request.toolName}' timed out after ${formatDurationMs(timeoutMs)} ` +
          `(${source}; plugin handler may still be running, its result will be discarded). ` +
          `Plugin authors: pass timeoutMs in registerTool() to extend or opt out (<=0 = no limit).`,
        isError: true,
      }
    }
    const msg = toErrorMessage(err)
    return { content: `Plugin tool execution failed: ${msg}`, isError: true }
  }
}

export function handleBridgeEvent(
  eventName: string,
  data: unknown,
  sessionId: string,
  executeHooks: (hookType: string, context: HookContext) => Promise<HookResult>,
): void {
  const mapping = PI_HOOK_EVENT_MAP[eventName]
  // 有映射条目用翻译后 hookType（camelCase 才能命中 HookRegistry）；
  // 无映射条目（如 plugin:statusSetUpdate 等非 pi 事件）保持原 eventName，兼容既有行为。
  const hookType = mapping ? mapping.hookType : (eventName as HookType)
  const context: HookContext = {
    pluginId: '',
    hookType,
    data: { eventName, data, sessionId },
    timestamp: Date.now(),
  }
  executeHooks(hookType, context).catch((err: unknown) => {
    console.error(`[plugin-service] handleBridgeEvent error:`, err)
  })
}

export async function handleBridgeIntercept(
  eventName: string,
  data: unknown,
  sessionId: string,
  executeHooks: (hookType: string, context: HookContext) => Promise<HookResult>,
): Promise<BridgeInterceptResponse> {
  const mapping = PI_HOOK_EVENT_MAP[eventName]
  // 未在映射表中的事件名不翻译、不拦截（ERR2：返回空响应，保持 pi 协议兼容）
  if (!mapping) {
    return { injectedMessages: [] }
  }

  const context: HookContext = {
    pluginId: '',
    hookType: mapping.hookType,
    data: { eventName, data, sessionId },
    timestamp: Date.now(),
  }

  const hookResult = await executeHooks(mapping.hookType, context)

  // 纯映射（决策原文见 git `7a3797d0b` 版 plugin-intercept-injection §D3；文档已退役于
  // `fadd8b8b4`）：注入形状守卫职责在管线层逐插件执行（§D2 同源），此处输入恒为管线
  // 产出的合法 string[]——无校验无日志职责。
  // 每条 string 包一层 {content}，对齐 pi 侧 bridge extension 的 isInjectedMessage 守卫
  // 形态（extensions/taiji/plugin-bridge/src/index.ts:90，要求对象含 content 键，
  // string 条目会被无留痕过滤）。协议层类型 injectedMessages: unknown[] 不收紧（D3 定案）。
  const injectedMessages = (hookResult.injectedMessages ?? []).map(content => ({ content }))

  if (hookResult.blocked) {
    // blocked 透传管线累积注入（git `7a3797d0b` 版 plugin-intercept-injection §D2 block
    // 交互定案 + §D3；文档已退役于 `fadd8b8b4`）：校验先于
    // block 判定，block 插件自身合法注入已进累积——pi 侧对该组合「blocked 只 log、
    // 注入照常评估」（plugin result 契约无 block 槽位，turn 照常进行；plugin-bridge
    // :450-457），阻止后续插件与向 LLM 留言互不吞没。
    return { blocked: true, reason: hookResult.reason ?? `Blocked by ${hookResult.blockedBy}`, injectedMessages }
  }

  return { injectedMessages }
}
