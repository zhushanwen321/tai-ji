/**
 * Commands API 模块
 *
 * 提供命令注册的 RPC handler（主线程侧）和 Worker 侧代理对象。
 *
 * 主线程侧：registerCommandRpcHandlers() 在 PluginRpcServer 上注册
 *   plugin.commands.register / plugin.commands.unregister /
 *   plugin.commands.invoke.result 三个 RPC 方法。
 *   register 把 CommandRegistration 存入 registry（复合键 `pluginId:commandId`
 *   → registration，D7 隔离语义：插件 B 无法覆盖或注销插件 A 的同名命令），
 *   并调用 broadcastRegistered 下行广播 plugin:commandRegistered。
 *
 * Worker 侧：createCommandsApi() 返回代理对象，提供 register/unregister。
 *   handler 驻留 Worker 本地（TC1 VSCode 模式）：register 只经 RPC 传命令元数据，
 *   执行时主线程经 plugin.commands.invoke 通知回调 Worker 本地 handler。
 *   Worker 监听 invoke 通知，dispatchHandler 命中本地 handler，结果/错误经
 *   plugin.commands.invoke.result RPC 回传主线程（主线程 executeCommand 的
 *   pending 等待由该回传 resolve/reject）。
 *
 * 方法名 SSOT（D7）：本域全部方法名收敛到 COMMAND_RPC_METHODS 常量——
 * 此前主线程 executeCommand 硬编码 'plugin.command.execute'（单数 command），
 * 与 Worker 侧 'plugin.commands.invoke'（复数 commands）漂移导致动态命令
 * 从未真正可执行；常量化后此类漂移在编译期不可再现。
 */

import type { PluginRpcServer } from '../plugin-rpc-server.js'
import type { PluginRpcClient } from '../plugin-rpc-client.js'
import type { Disposable } from '../plugin-types.js'
import { registerHandler, dispatchHandler } from '../handler-registry.js'
import { toErrorMessage, errorWithCode } from '../../../utils/errors.js'
import { asOptionalString, asRecord, asSafeKey, asString } from '../validation.js'

/**
 * 命令域 RPC 方法名常量（D7 方法名 SSOT）。
 * 主线程 ↔ Worker 两侧引用同一常量，禁止再出现裸字符串方法名。
 */
export const COMMAND_RPC_METHODS = {
  register: 'plugin.commands.register',
  unregister: 'plugin.commands.unregister',
  /** 主线程 → Worker：命令执行（通知形态，结果经 invokeResult 回传闭环） */
  invoke: 'plugin.commands.invoke',
  /** Worker → 主线程：invoke 结果/错误回传 */
  invokeResult: 'plugin.commands.invoke.result',
} as const

/**
 * 命令注册表复合键：`${pluginId}:${commandId}`（D7）。
 *
 * 全局命名空间的裸 commandId 允许插件互相覆盖/注销他人命令；复合键后
 * 注册表按插件隔离——注销/覆盖只作用于自身前缀。commandId 含 ':' 会被
 * register 拒绝（防复合键注入歧义）。
 */
export function commandCompositeKey(pluginId: string, commandId: string): string {
  return `${pluginId}:${commandId}`
}

/** 命令声明元数据（与 Phase2AgentAPI['commands'].register 参数对齐，IF1） */
export interface CommandDescriptor {
  id: string
  title?: string
  category?: string
  keybinding?: string
  when?: string
  /**
   * 命令执行超时声明（毫秒，timeout-plugin-service D4，取值链同工具 D1）：
   * - >0 — 该命令单次执行的时间上界；
   * - <=0 或 Infinity — 显式 opt-out（不限时，以 timer 域上界近似）；
   * - 非法值（非 number / NaN）— 注册入口 fail-fast（INVALID_TIMEOUT_MS），
   *   运行时脏值由 resolveToolTimeoutMs 回落默认兜底；
   * - 缺省 — 回落 DEFAULT_TOOL_EXECUTE_TIMEOUT_MS（30min，bridge-interop）。
   */
  timeoutMs?: number
}

/**
 * 运行时命令注册表条目（DM1）。
 * handlerRef 语义：handlerId 是 Worker 本地 handler 引用（invoke 回调用），
 * pluginId 定位 Worker，与 s2 IF6 CommandRecord.handlerRef 对齐（仅契约对齐，不依赖 s2 代码）。
 * registry 的 key 是复合键 `pluginId:commandId`（commandCompositeKey），非裸 commandId。
 *
 * workerId：注册通道归属（register 时从 RpcDispatchContext 捕获，来源宿主闭包
 * 不可伪造）。invoke.result 回传按它做归属校验（D2 回传段）：来源通道不是注册
 * 通道的回传一律拒绝投递——否则恶意/失控 Worker 可伪造他人 handlerId 的
 * result/error，resolve/reject 其他插件的命令 pending。
 */
export interface CommandRegistration {
  commandId: string
  pluginId: string
  handlerId: string
  /** 注册通道归属（ctx.workerId，register 时捕获）——回传归属校验的比对基准 */
  workerId: string
  title?: string
  category?: string
  keybinding?: string
  when?: string
  /** 命令执行超时声明（原样存储 CommandDescriptor.timeoutMs，executeCommand 取值链消费，D4） */
  timeoutMs?: number
  registeredAt: number
}

/** 命令注册服务依赖（主线程侧） */
export interface CommandService {
  /** 命令注册表，key 为复合键 `pluginId:commandId`（commandCompositeKey） */
  registry: Map<string, CommandRegistration>
  /** register 后下行广播 plugin:commandRegistered（payload 为 CommandRegistration） */
  broadcastRegistered: (reg: CommandRegistration) => void
/**
   * Worker 经 plugin.commands.invoke.result 回传的执行结果（S3-W1 发送段闭环）。
   * error 非空 = handler 抛错（reject 对应 pending），否则 resolve result。
   * sourceWorkerId 是回传消息的来源通道（dispatch ctx 捕获，不可伪造），
   * 实现方须按注册表做归属校验后投递（D2 回传段）。
   */
  deliverInvokeResult: (
    handlerId: string,
    payload: { result?: unknown; error?: unknown },
    sourceWorkerId: string,
  ) => void
}

/**
 * 在 PluginRpcServer 上注册命令相关的 RPC handler。
 *
 * 注册的方法（COMMAND_RPC_METHODS）：
 * - `plugin.commands.register` — 注册命令（命令元数据 + handlerId 引用，复合键隔离）
 * - `plugin.commands.unregister` — 注销命令（幂等：不存在时 no-op，ES1；复合键只删自身前缀）
 * - `plugin.commands.invoke.result` — Worker 执行结果回传（resolve/reject executeCommand pending）
 */
export function registerCommandRpcHandlers(
  rpcServer: PluginRpcServer,
  service: CommandService,
): void {
  rpcServer.registerMethod(COMMAND_RPC_METHODS.register, async (params, ctx) => {
    // S3-W3 窄校验（fail-fast，畸形不建注册表条目不广播）：
    // pluginId/command.id/handlerId 过 asSafeKey（白名单含 1-128 上限，
    // 语法上排除路径分隔符与复合键注入字符）；可选元数据字段 present
    // 但类型错即拒。
    const pluginId = asSafeKey(params.pluginId, 'pluginId')
    const command = asRecord(params.command, 'command')
    // 复合键完整性：commandId 含 ':' 会与 `pluginId:commandId` 键格式歧义
    // （恶意插件可用它伪造他人前缀的键）。先于 asSafeKey 检查并保留原始
    // 文案（message 前缀 'INVALID_COMMAND_ID:' 是 S3-W1 冻结用例断言的
    // 可观测契约）。
    if (typeof command.id === 'string' && command.id.includes(':')) {
      throw errorWithCode(
        `INVALID_COMMAND_ID: command id must not contain ':' (got '${command.id}')`,
        'INVALID_COMMAND_ID',
      )
    }
    const commandId = asSafeKey(command.id, 'commandId')
    const handlerId = asSafeKey(params.handlerId, 'handlerId')
    const title = asOptionalString(command.title, 'title')
    const category = asOptionalString(command.category, 'category')
    const keybinding = asOptionalString(command.keybinding, 'keybinding')
    const when = asOptionalString(command.when, 'when')
    // D4 声明通道窄校验（对齐 tool-api 的 INVALID_TIMEOUT_MS 形态）：timeoutMs 可选，
    // present 即必须 number 且非 NaN——脏值 fail-fast 拒注册；0 / 负数 / Infinity 是
    // 合法声明（显式 opt-out，运行时语义归 bridge-interop resolveToolTimeoutMs），
    // 原样透传存储。
    const declaredTimeoutMs = command.timeoutMs
    if (
      declaredTimeoutMs !== undefined &&
      (typeof declaredTimeoutMs !== 'number' || Number.isNaN(declaredTimeoutMs))
    ) {
      throw errorWithCode(
        `Invalid timeoutMs: expected a number (milliseconds; <=0 or Infinity = no limit) ` +
          `but received ${typeof declaredTimeoutMs === 'number' ? 'NaN' : typeof declaredTimeoutMs}.`,
        'INVALID_TIMEOUT_MS',
      )
    }
    const timeoutMs = typeof declaredTimeoutMs === 'number' ? declaredTimeoutMs : undefined

    const registration: CommandRegistration = {
      commandId,
      pluginId,
      handlerId,
      // D2 回传归属：注册通道从 dispatch ctx 捕获（宿主闭包来源，插件不可
      // 自报），invoke.result 回传据此校验来源通道一致才投递 pending。
      workerId: ctx.workerId,
      ...(title !== undefined ? { title } : {}),
      ...(category !== undefined ? { category } : {}),
      ...(keybinding !== undefined ? { keybinding } : {}),
      ...(when !== undefined ? { when } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      registeredAt: Date.now(),
    }

    service.registry.set(commandCompositeKey(pluginId, commandId), registration)
    service.broadcastRegistered(registration)

    return { registered: true }
  })

  rpcServer.registerMethod(COMMAND_RPC_METHODS.unregister, async (params) => {
    const pluginId = asSafeKey(params.pluginId, 'pluginId')
    const commandId = asSafeKey(params.commandId, 'commandId')

    // ES1 + 复合键隔离：只删 `${自身pluginId}:${commandId}`——插件 B 传
    // commandId='A:x' 时键为 'B:A:x'（不存在）→ no-op，A:x 不受影响。
    // （asSafeKey 已排除 ':'，注入形态在入口即被 INVALID_COMMAND_ID 拒绝。）
    service.registry.delete(commandCompositeKey(pluginId, commandId))

    return { unregistered: true }
  })

  rpcServer.registerMethod(COMMAND_RPC_METHODS.invokeResult, async (params, ctx) => {
    const handlerId = asString(params.handlerId, 'handlerId')
    const payload: { result?: unknown; error?: unknown } = params.error !== undefined
      ? { error: params.error }
      : { result: params.result }
    // D2 回传归属：来源通道（ctx.workerId，宿主闭包捕获不可伪造）随回传下传，
    // 由 deliverInvokeResult 比对注册表归属后决定是否投递 pending。
    service.deliverInvokeResult(handlerId, payload, ctx.workerId)
    return { delivered: true }
  })
}

/** Worker 本地存储的命令 handler 包装 */
interface StoredCommand {
  commandId: string
  handler: (args?: unknown) => unknown | Promise<unknown>
}

let commandCounter = 0

/**
 * 创建 Worker 侧 Commands API 代理对象。
 *
 * register() 会：
 * 1. 生成唯一 handlerId（`cmd_${pluginId}_${递增}`，hook-api 同款计数模式）
 * 2. 保存 handler 到 Worker 本地 map（handlerId → { commandId, handler }）
 * 3. 发 RPC plugin.commands.register 到主线程（只传元数据 + handlerId）
 * 4. 返回 Disposable（dispose 时发 RPC 注销并清理本地 map）
 *
 * 同时注册 `plugin.commands.invoke` 通知处理器（TC1 handler 驻留 Worker，
 * 主线程 executeCommand 的发送段即 rpcServer.notify 此方法）：
 * - 收到通知后 dispatchHandler 从本地 map 查找 handler
 * - 调用 handler(args)
 * - 结果**或错误**通过 `plugin.commands.invoke.result` RPC 返回主线程——
 *   错误也回传（否则主线程 executeCommand 只能等 10s 超时才能感知失败）
 */
export function createCommandsApi(
  rpcClient: PluginRpcClient,
  pluginId: string,
): {
  register(
    command: CommandDescriptor,
    handler: (args?: unknown) => unknown | Promise<unknown>,
  ): Promise<Disposable>
  unregister(commandId: string): Promise<void>
} {
  // handlerId → StoredCommand（dispatchHandler 按 handlerId 查 map）
  const handlers = new Map<string, StoredCommand>()

  // 注册 invoke 通知处理器（主线程回调 Worker 中的 command handler）
  rpcClient.onNotification(COMMAND_RPC_METHODS.invoke, (params: unknown) => {
    const p = params as { handlerId: string; args?: unknown }
    dispatchHandler(handlers, p, stored => {
      Promise.resolve(stored.handler(p.args))
        .then((result) => {
          rpcClient
            .request(COMMAND_RPC_METHODS.invokeResult, {
              handlerId: p.handlerId,
              result,
            })
            .catch((e: unknown) => {
              console.error('[commands-api] invoke result delivery failed:', toErrorMessage(e))
            })
        })
        .catch((e: unknown) => {
          // handler 抛错也回传：主线程 pending 以错误 reject（不等超时）
          rpcClient
            .request(COMMAND_RPC_METHODS.invokeResult, {
              handlerId: p.handlerId,
              error: toErrorMessage(e),
            })
            .catch((deliveryErr: unknown) => {
              console.error('[commands-api] invoke error delivery failed:', toErrorMessage(deliveryErr))
            })
        })
    })
  })

  return {
    register: async (command, handler) => {
      const handlerId = `cmd_${pluginId}_${++commandCounter}`

      await rpcClient.request(COMMAND_RPC_METHODS.register, {
        pluginId,
        command,
        handlerId,
      })

      return registerHandler(handlers, handlerId, { commandId: command.id, handler }, () => {
        rpcClient
          .request(COMMAND_RPC_METHODS.unregister, { pluginId, commandId: command.id })
          .catch((e: unknown) => {
            console.error('[commands-api] command unregister failed:', toErrorMessage(e))
          })
      })
    },

    unregister: async (commandId) => {
      // 从本地 map 移除该 commandId 的 handler（幂等）
      for (const [handlerId, stored] of handlers) {
        if (stored.commandId === commandId) {
          handlers.delete(handlerId)
          break
        }
      }
      await rpcClient.request(COMMAND_RPC_METHODS.unregister, { pluginId, commandId })
    },
  }
}
