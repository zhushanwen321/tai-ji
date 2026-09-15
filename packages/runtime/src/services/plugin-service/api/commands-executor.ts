/**
 * Commands 执行发送段闭环（S3-W1）——executeCommand / deliverInvokeResult 的实现，
 * 从 plugin-service.ts 迁出（max-lines 拆分）。命令注册表与 pending 登记表仍归
 * PluginService 持有（rpc-setup 注册侧与测试直查共享同一 Map），经 deps 注入。
 */

import type { PluginRegistry } from '../plugin-registry.js'
import type { PluginHost } from '../plugin-host.js'
import type { PluginRpcServer } from '../plugin-rpc-server.js'
import type { CommandRegistration } from './commands-api.js'
import { COMMAND_RPC_METHODS, commandCompositeKey } from './commands-api.js'
// D4（timeout-plugin-service）：命令执行是任务级（用户点击触发的插件业务代码），
// 执行超时取值链复用 D1 工具执行的 resolveToolTimeoutMs（声明优先 / opt-out /
// 非法回落 DEFAULT_TOOL_EXECUTE_TIMEOUT_MS 30min / clamp），不另设命令专属常量。
// formatDurationMs / isDeclaredTimeoutActive 同源自 D1（impl-plan §5 假差异收敛：
// busy 提示文案与 declared 判定统一走 bridge-interop 单一权威，本地复制已删）。
import { formatDurationMs, isDeclaredTimeoutActive, resolveToolTimeoutMs } from '../bridge-interop.js'
import { toErrorMessage } from '../../../utils/errors.js'
import { PendingTracker } from '../../../utils/async/pending-tracker.js'

/**
 * 命令执行开始时间（错误规格表「命令执行中重复触发」行的 busy 提示「已等待时长」
 * 用，30min 默认窗口放大了重复触发的等待面）：tracker 实例 → handlerId → register
 * 时刻。keyed by tracker 实例防多 PluginService 实例（测试多实例）同 handlerId 串扰；
 * 条目在 deliverInvokeResult 投递时清理，超时路径残留至同 handlerId 重注册覆盖
 * （残留量级 = 超时未回传的命令数，可忽略）。
 */
const commandStartTimes = new WeakMap<PendingTracker<string, unknown>, Map<string, number>>()

/** 命令执行协作者（PluginService 持有的注册表/pending 登记表 + 三个协作对象） */
export interface CommandExecutorDeps {
  registry: Pick<PluginRegistry, 'getDescriptor'>
  host: Pick<PluginHost, 'getWorkerHandle'>
  rpcServer: Pick<PluginRpcServer, 'notify'>
  /** 命令注册表（复合键 `pluginId:commandId` → CommandRegistration，D7 隔离） */
  commandRegistry: Map<string, CommandRegistration>
  /** 命令执行 pending 登记表（handlerId → 结果 promise，超时兜底 reject） */
  commandInvokes: PendingTracker<string, unknown>
}

/**
 * 执行插件注册的命令（S3-W1 发送段闭环）。
 *
 * 链路：复合键查 registry → rpcServer.notify 向 Worker 发 plugin.commands.invoke
 * （handler 驻留 Worker，方法名 COMMAND_RPC_METHODS.invoke 统一 SSOT）→ Worker
 * 执行 handler 后经 plugin.commands.invoke.result 回传结果/错误 → deliverInvokeResult
 * resolve/reject 对应 pending（超时取值链见下，默认 30min）。
 *
 * 执行超时取值链（timeout-plugin-service D4，同工具 D1）：命令定义级
 * `registration.timeoutMs` 声明（合法正数优先）→ `<=0`/`Infinity` 显式 opt-out
 * （timer 域上界近似）→ 非法/缺省回落 DEFAULT_TOOL_EXECUTE_TIMEOUT_MS → clamp。
 *
 * 前端消费契约（useExtensionHostBridge commandExecutor）：payload 携带分离的
 * pluginId + commandId，本方法组复合键 `${pluginId}:${commandId}` 查表——
 * 命令表按插件隔离（B 无法覆盖/注销 A 的同名命令）。
 */
export async function executeCommand(
  deps: CommandExecutorDeps,
  pluginId: string,
  commandId: string,
  args?: Record<string, unknown>,
): Promise<unknown> {
  const descriptor = deps.registry.getDescriptor(pluginId)
  if (!descriptor) throw new Error(`Plugin not found: ${pluginId}`)

  const compositeKey = commandCompositeKey(pluginId, commandId)
  const registration = deps.commandRegistry.get(compositeKey)
  if (!registration) throw new Error(`Command not found: ${compositeKey}`)

  const handle = deps.host.getWorkerHandle(pluginId)
  if (!handle) throw new Error(`Plugin worker not available: ${pluginId}`)

  // D4 取值链：声明 timeoutMs（合法正数）优先，否则默认兜底；<=0/Infinity opt-out。
  // 注册入口已窄校验（INVALID_TIMEOUT_MS），脏值防御由 resolveToolTimeoutMs 全分支兜住
  const declared = registration.timeoutMs
  const timeoutMs = resolveToolTimeoutMs(declared)
  const declaredActive = isDeclaredTimeoutActive(declared)

  // 并发守卫：同 handlerId 二次执行会覆盖 pending 登记表条目（旧 promise 永挂），
  // 显式拒绝并发（用户双击同一命令的第二次触发立即失败优于静默挂死）。错误规格表
  // 「命令执行中重复触发」行：30min 默认窗口放大了重复触发的等待面，busy 提示
  // 含已等待时长与出路（现状无取消通道——诚实告知等当前执行结束/超时后再试）。
  if (deps.commandInvokes.has(registration.handlerId)) {
    const startedAt = commandStartTimes.get(deps.commandInvokes)?.get(registration.handlerId)
    const waited = startedAt !== undefined ? formatDurationMs(Date.now() - startedAt) : 'unknown'
    throw new Error(
      `Command already executing: ${compositeKey} (already running for ${waited}; ` +
        `no cancel channel yet — wait for it to finish or time out after ` +
        `${formatDurationMs(timeoutMs)} before retrying)`,
    )
  }

  // 顺序约束：先登记 pending、立即发 notify、最后才 await——notify 必须在函数体
  // 挂起等待 result 之前发出（await 放前面会挂住函数体，通知永远发不出）。
  let startTimes = commandStartTimes.get(deps.commandInvokes)
  if (!startTimes) {
    startTimes = new Map()
    commandStartTimes.set(deps.commandInvokes, startTimes)
  }
  startTimes.set(registration.handlerId, Date.now())
  const result = deps.commandInvokes.register(
    registration.handlerId,
    timeoutMs,
    Object.assign(
      new Error(
        `Command '${compositeKey}' timed out after ${formatDurationMs(timeoutMs)} ` +
          `(${declaredActive ? 'declared' : 'default'}; plugin handler may still be running). ` +
          `Plugin authors: pass timeoutMs in the command definition to extend or opt out (<=0 = no limit).`,
      ),
      { code: -32000 },
    ),
  )
  deps.rpcServer.notify(
    handle.workerId,
    COMMAND_RPC_METHODS.invoke,
    { handlerId: registration.handlerId, args: args ?? {} },
  )
  return result
}

/**
 * Worker 经 plugin.commands.invoke.result 回传的执行结果（commands 域 RPC
 * handler 调用）。error 非空 = handler 抛错，reject 对应 pending。
 *
 * 归属校验（D2 回传段）：handlerId 必须属于来源通道——查注册表找该 handlerId
 * 的 registration，registration.workerId（register 时从 ctx 捕获）不等于
 * sourceWorkerId 即拒绝投递（warn 落日志，pending 留给自身超时）。否则恶意/
 * 失控 Worker 可伪造他人 handlerId 的 result/error，resolve/reject 其他插件
 * 的命令 pending。registration 不存在（执行中被注销/禁用清理）同样 fail-closed
 * 拒绝——归属无从比对即不放行。
 *
 * 查表方式：registry 键是复合键 `pluginId:commandId` 而非 handlerId，此处直接
 * 遍历 values 找 handlerId 匹配。不建 handlerId 反查表的原因：反查表需在
 * register/unregister handler、removeCommandEntriesFor 及一切直接 set/delete
 * registry 的路径同步维护，多一处数据源多一处漂移出安全漏洞的机会；命令注册
 * 量级（单插件个位数 × 插件数十）下每次回传遍历 O(n) 为微秒级，且仅在命令
 * 执行回传时发生。单一数据源（registry 本身）无一致性风险。
 */
export function deliverInvokeResult(
  deps: Pick<CommandExecutorDeps, 'commandRegistry' | 'commandInvokes'>,
  handlerId: string,
  payload: { result?: unknown; error?: unknown },
  sourceWorkerId: string,
): void {
  let registration: CommandRegistration | undefined
  for (const reg of deps.commandRegistry.values()) {
    if (reg.handlerId === handlerId) {
      registration = reg
      break
    }
  }

  if (!registration) {
    console.warn(
      `[plugin-service] invoke result dropped: no registration for handlerId='${handlerId}' ` +
        `(command unregistered or plugin cleaned up?) sourceWorker=${sourceWorkerId}; ` +
        `pending (if any) left to its own timeout`,
    )
    return
  }
  if (registration.workerId !== sourceWorkerId) {
    console.warn(
      `[plugin-service] invoke result dropped: handlerId='${handlerId}' belongs to ` +
        `worker='${registration.workerId}' but result arrived from worker='${sourceWorkerId}' ` +
        `(possible forgery); pending left to its own timeout`,
    )
    return
  }

  // busy 提示的开始时间条目投递即清理（归属校验失败路径不删——pending 仍挂在等
  // 超时，busy 文案的已等待时长须继续可用；超时路径残留由同 handlerId 重注册覆盖）
  commandStartTimes.get(deps.commandInvokes)?.delete(handlerId)

  if (payload.error !== undefined) {
    deps.commandInvokes.reject(
      handlerId,
      new Error(`Command handler error: ${toErrorMessage(payload.error)}`),
    )
    return
  }
  deps.commandInvokes.resolve(handlerId, payload.result)
}
