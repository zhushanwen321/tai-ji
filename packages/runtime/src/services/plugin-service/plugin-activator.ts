/**
 * 插件懒激活状态机
 *
 * 维护 activationEvent → pluginId 映射，在外部事件触发时
 * 按需激活匹配的插件。激活流程：assignWorker → loadPlugin → activate 消息。
 *
 * 消息回复通过 handleWorkerReply() 路由：PluginHost 收到 Worker 消息后
 * 调用本方法，Activator 解析 pending promises 完成异步等待。
 */

import type {
  ActivationEvent,
  PluginState,
  PluginDescriptor,
  PluginSource,
  PluginPermission,
  Disposable,
  WorkerToHostMessage,
} from './plugin-types.js'
import {
  topologicalSort,
  detectCycle,
  findMissingDependencies,
} from './plugin-deps.js'
import { PluginHotReloader, type HotReloadHooks, type StatusChangeCallback } from './plugin-hot-reload.js'
// §6.6 硬锁常量（w1 落地）：external 插件安装/激活总开关。
// sandbox 真隔离闭环已落地，EXTERNAL_PLUGIN_ENABLED 已翻转为 true。
// 联动契约见 plugin-security.ts —— 任一 sandbox 环节回退时须同步改回 false。
import { EXTERNAL_PLUGIN_ENABLED } from './plugin-security.js'
// 本地类型别名：方法签名 host: PluginHost 用（re-export 不进本地作用域，需单独 import）
import type { PluginHostContract as PluginHost } from './plugin-host.js'

// re-export：既有调用方（plugin-service.ts、测试）从 plugin-activator.js 导入
// StatusChangeCallback，保持该导出以维持 NON-BREAKING。上方 import 仅供本文件
// 方法签名本地使用。
export type { StatusChangeCallback } from './plugin-hot-reload.js'

// P8 收口：PluginHost 契约已迁移到供应商 plugin-host.ts（PluginHostContract）。
// 此处 re-export 为 `PluginHost` 之名，保持所有既有导入（plugin-host.ts 本身、
// 5 个测试文件 import `PluginHost as ActivatorHost`）不破坏（NON-BREAKING）。
export type { PluginHostContract as PluginHost } from './plugin-host.js'

const DEACTIVATE_TIMEOUT_MS = 5_000
const ACTIVATE_TIMEOUT_MS = 30_000
// 权限审批等待默认值（timeout-plugin-service D3）：审批对象是「等一个不在场的人」，
// 量级按本仓「等人工」裁决值 30min（dialog-queue DEFAULT_DIALOG_TIMEOUT_MS 同源），
// 不再是 30s 判拒。全局逃生门 = env TAIJI_PLUGIN_PERMISSION_TIMEOUT_MS（生产装配点
// plugin-service.ts 接线解析，缺失/非法回落本常量——回落权威单一在此）。
export const PERMISSION_TIMEOUT_MS = 1_800_000

interface PendingReply {
  resolve: (success: boolean) => void
  timer: ReturnType<typeof setTimeout>
}

interface PluginContextState {
  subscriptions: Disposable[]
}

/** PermissionChecker 最小接口——Activator 只调用 getUnapproved */
export interface PermissionCheckerLike {
  getUnapproved(pluginId: string, permissions: PluginPermission[]): PluginPermission[]
}

/** Activator 构造函数选项 */
export interface ActivatorOptions {
  permissionChecker?: PermissionCheckerLike
  onPermissionRequest?: (payload: { pluginId: string; permissions: PluginPermission[] }) => void
  /**
   * 权限审批等待到期取消回调（timeout-plugin-service D3）。生产装配点注入
   * `plugin:permissionRequestExpired` 广播（前端撤回无人应答的审批弹窗）；
   * 未注入时到期取消只落日志与状态，无广播（单测/内嵌场景）。
   */
  onPermissionRequestExpired?: (payload: { pluginId: string }) => void
  /**
   * 覆盖权限审批超时（ms）。timeout-plugin-service D3 转正：生产装配点经
   * TAIJI_PLUGIN_PERMISSION_TIMEOUT_MS env 接线（合法正数生效，缺失/非法 warn 回落
   * PERMISSION_TIMEOUT_MS）；测试可直接传小值加速。
   */
  permissionTimeoutMs?: number
  /**
   * 覆盖 activate 生命周期握手超时（ms）。timeout-plugin-service D4：activate 是
   * 控制面单请求（默认 30s 保持不动），本参数是逃生门——重初始化插件的 onActivate
   * 做重活（拉配置、建连接、预热缓存）时可放宽（对齐 fork 版 plugin-host-process
   * 构造器 loadTimeoutMs 先例；契约要求 onActivate 保持轻量，重活应移到首个工具
   * 调用或命令 handler）。测试可传小值加速超时路径。
   */
  activateTimeoutMs?: number
}

interface PendingPermission {
  /** 结局三态：true=批准 / false=显式拒绝或挂起期清理唤醒 / 'timeout'=等待到期（D3 取消语义） */
  resolve: (outcome: boolean | 'timeout') => void
  timer: ReturnType<typeof setTimeout>
}

export class PluginActivator {
  private pluginStates = new Map<string, PluginState>()
  private eventMap = new Map<string, string[]>() // eventPattern → pluginIds
  private contexts = new Map<string, PluginContextState>()
  private descriptors = new Map<string, PluginDescriptor>()
  /**
   * 进行中的生命周期回复等待。key 为复合键 `${pluginId}:${op}`（op ∈
   * 'activate' | 'deactivate'，D6 并发模型）：同一插件 activate/deactivate 并发
   * 在飞时两个 entry 互不覆盖，activated/deactivated 回复按 (pluginId, replyType)
   * 精确匹配到各自 op 的 entry。旧 pluginId 单键实现 Map.set 互相覆盖 + 旧 entry
   * 的超时 timer 到点无条件 delete 新 entry，是回复错配（activated 回复被
   * deactivate 的 entry 消费）、假超时、宿主/Worker 幽灵态的根源。
   */
  private pendingReplies = new Map<string, PendingReply>()
  /**
   * 取消标志（D6 并发守卫）：ACTIVATING 期间收到 deactivate 请求的插件集合，
   * 由 doActivatePlugin 的 finally 消费（成功 → 立即反卷真实 deactivate；否则 →
   * 终一化 UNLOADED）。
   * 选「取消标志」而非「排队」的理由：排队需要 per-plugin 队列 + 消费循环 +
   * 顺序保证三件套；取消标志只需一个 Set + 激活终态路径上的一处消费点，且能
   * 复用既有 activationInFlight 幂等基建（本分支 await in-flight promise，
   * deactivatePlugin 返回时停用语义已收敛），语义等价、状态更少、可直接单测
   * （LC-C1）。
   */
  private deactivateRequested = new Set<string>()
  /**
   * 进行中的激活 promise（pluginId → in-flight activatePlugin）。
   * 幂等守卫的支撑状态：重入 activatePlugin 返回同一 promise 而非静默丢弃，
   * 使「批准权限后 re-activate」能 await 到挂起中那次激活的完成。
   */
  private activationInFlight = new Map<string, Promise<void>>()

  /** 权限检查（可选） */
  private permissionChecker?: PermissionCheckerLike
  private onPermissionRequest?: (payload: { pluginId: string; permissions: PluginPermission[] }) => void
  private onPermissionRequestExpired?: (payload: { pluginId: string }) => void
  private permissionTimeoutMs: number
  /** activate 生命周期握手超时（D4：默认 ACTIVATE_TIMEOUT_MS 30s 不动，构造选项可覆盖） */
  private activateTimeoutMs: number
  /** 待审批的权限请求 */
  private pendingPermissions = new Map<string, PendingPermission>()

  /** Hot-reload 子系统（fs.watch + debounce + reload fan-out），自包含状态 */
  private hotReloader = new PluginHotReloader()

  constructor(options?: ActivatorOptions) {
    this.permissionChecker = options?.permissionChecker
    this.onPermissionRequest = options?.onPermissionRequest
    this.onPermissionRequestExpired = options?.onPermissionRequestExpired
    this.permissionTimeoutMs = options?.permissionTimeoutMs ?? PERMISSION_TIMEOUT_MS
    // 对齐 U7 形态（plugin-host.ts 构造器 loadTimeoutMs ?? LOAD_PLUGIN_TIMEOUT_MS）：
    // 生产装配不传 → 默认 30s 不动；仅测试/重初始化插件场景传覆盖值。
    this.activateTimeoutMs = options?.activateTimeoutMs ?? ACTIVATE_TIMEOUT_MS
  }

  /** 注册插件描述符，构建 activationEvent 索引 */
  registerDescriptors(descriptors: PluginDescriptor[]): void {
    for (const desc of descriptors) {
      this.descriptors.set(desc.pluginId, desc)
      this.pluginStates.set(desc.pluginId, desc.status)

      for (const eventPattern of desc.activationEvents) {
        const existing = this.eventMap.get(eventPattern)
        if (existing) {
          if (!existing.includes(desc.pluginId)) {
            existing.push(desc.pluginId)
          }
        } else {
          this.eventMap.set(eventPattern, [desc.pluginId])
        }
      }
    }
  }

  /**
   * 处理外部事件，匹配并激活对应插件。
   *
   * 匹配规则：
   * - 'onSlashCommand:xxx' → 精确匹配 event.command
   * - 'onStartupFinished' → 精确匹配
   * - 其他事件模式 → 精确匹配 event.type
   */
  async handleEvent(
    event: ActivationEvent,
    host: PluginHost,
  ): Promise<void> {
    const candidates = this.resolveCandidates(event)
    const tasks = candidates
      .filter(pid => {
        const state = this.pluginStates.get(pid)
        return state !== 'ACTIVE' && state !== 'ACTIVATING'
      })
      .map(pid => this.activatePlugin(pid, event, host))
    await Promise.allSettled(tasks)
  }

  /**
   * 激活单个插件。
   *
   * 流程：ACTIVATING → assignWorker → loadPlugin → postMessage('activate') → 等待回复
   *
   * 幂等语义（真幂等，非 no-op）：已激活跳过；激活中返回**同一 in-flight promise**——
   * 重入调用方（如 PluginService.approvePermissions 在批准唤醒后）await 到的是挂起中
   * 那次激活的完成，而非被静默丢弃。旧实现 `ACTIVATING → return` 会吞掉重入调用，
   * 配合「批准只 grant 不 resolve pending」形成权限审批唤醒断链（批准后仍干等 30s）。
   */
  async activatePlugin(
    pluginId: string,
    event: ActivationEvent,
    host: PluginHost,
  ): Promise<void> {
    const descriptor = this.descriptors.get(pluginId)
    if (!descriptor) return

    // §6.6 硬锁（IF3，激活侧）：external 来源 + 开关 false → 跳过激活。
    // 与 w1 安装锁（installPlugin）组成「新装不进 + 已装不跑」双 guard。
    // 锁在权限检查之前（ES2）。sandbox 真隔离闭环已落地、开关 true 后此 guard 放行；
    // 开关回退 false 时重新生效。
    if (descriptor.source === 'external' && !EXTERNAL_PLUGIN_ENABLED) {
      console.warn(`[plugin-activator] skipping ${pluginId}: external plugin activation locked (sandbox isolation not yet implemented)`)
      this.setState(pluginId, 'UNLOADED')
      return
    }

    // 幂等：激活中 → 返回同一 in-flight promise；已激活 → 跳过
    const inFlight = this.activationInFlight.get(pluginId)
    if (inFlight) return inFlight
    const currentState = this.pluginStates.get(pluginId)
    if (currentState === 'ACTIVE') return

    // 版本不兼容的插件不能激活
    if (currentState === 'DEPS_MISSING') {
      console.warn(`[plugin-activator] skipping ${pluginId}: incompatible version`)
      return
    }

    const task = this.doActivatePlugin(pluginId, event, host, descriptor)
    this.activationInFlight.set(pluginId, task)
    try {
      await task
    } finally {
      this.activationInFlight.delete(pluginId)
    }
  }

  /** activatePlugin 的实际激活流程（守卫全过后执行；拆出以支持 in-flight 注册）。 */
  private async doActivatePlugin(
    pluginId: string,
    event: ActivationEvent,
    host: PluginHost,
    descriptor: PluginDescriptor,
  ): Promise<void> {
    this.pluginStates.set(pluginId, 'ACTIVATING')

    try {
      // 0. 权限检查（在分配 Worker 之前）：false = 激活作废（拒绝/到期/等待期状态被
      // 外部改写），helper 内已终一化状态并发出对应广播/侧写
      if (!(await this.gateOnPermissionApproval(pluginId, descriptor))) return

      // 1. 分配 Worker（sandbox 传 pluginDir：fork 子进程 env 注入 TAIJI_PLUGIN_SANDBOX_DIR，
      // ESM loader initialize() 在进程启动时读此 env 做路径边界判定）
      const workerId = await host.assignWorker(pluginId, descriptor.trustLevel, descriptor.pluginPath)

      // 2. 加载插件模块到 Worker（pluginId 显式传：loadedModules 分区键）
      await host.loadPlugin(workerId, pluginId, descriptor.pluginPath)

      // 3. 发送 activate 消息并等待 Worker 回复
      const handle = host.getWorkerHandle(pluginId)
      if (!handle) {
        this.settleActivationFailure(pluginId)
        return
      }

      const success = await this.sendAndWaitReply(
        handle,
        { type: 'activate', pluginId, pluginDir: descriptor.pluginPath, event },
        pluginId,
        'activate',
        this.activateTimeoutMs,
      )

      if (success) {
        this.contexts.set(pluginId, { subscriptions: [] })
        this.setState(pluginId, 'ACTIVE')
      } else {
        this.settleActivationFailure(pluginId)
      }
    } catch (err: unknown) {
      console.error(`[plugin-activator] failed to activate ${pluginId}:`, err)
      this.settleActivationFailure(pluginId)
    } finally {
      // D6 取消标志消费（finally 覆盖全部出口：成功 / 异常 / 审批作废与权限拒绝
      // 的早退 return），语义见 consumeDeactivateRequest。
      await this.consumeDeactivateRequest(pluginId, host)
    }
  }

  /**
   * 激活流程阶段 0：权限门（在分配 Worker 之前）。
   * 返回 false = 本次激活作废（审批被拒 / 等待到期取消 / 等待期状态被外部改写），
   * 调用方直接 return（状态终一化与 expired 广播在此完成）；true = 通过（含无需
   * 审批场景），继续 assignWorker。
   */
  private async gateOnPermissionApproval(
    pluginId: string,
    descriptor: PluginDescriptor,
  ): Promise<boolean> {
    if (!this.permissionChecker || descriptor.permissions.length === 0) return true
    const unapproved = this.permissionChecker.getUnapproved(pluginId, descriptor.permissions)
    if (unapproved.length === 0) return true

    // 先注册 pending promise，再通知外部（避免回调中立即 resolve 时竞态）
    const approvalPromise = this.waitForPermissionApproval(pluginId)
    this.onPermissionRequest?.({ pluginId, permissions: unapproved })
    // 等待审批结果（true=批准 / false=拒绝或挂起期清理唤醒 / 'timeout'=等待到期）
    const approval = await approvalPromise
    // 等待期间状态被外部改写（deactivate/disable → DEACTIVATING/UNLOADED、
    // uninstall removeDescriptor → 已删除、crash → CRASHED）→ 本次激活作废：
    // 继续走 assignWorker 会把已停用/已卸载的插件拉回 ACTIVE（approve → 快速
    // disable 竞态）。removeDescriptor 场景下此处同时防住「卸载后幽灵 setState
    // 复活」（状态已从 Map 删除，!== ACTIVATING 提前 return，不再回写）。
    // 注意此检查必须先于 'timeout' 分流：作废的激活连 expired 广播也不发
    //（广播语义 = 「审批弹窗确实在等人且已到期撤回」，作废路径的 pending 已被
    // 消费/清理，弹窗命运归接管方）。
    if (this.pluginStates.get(pluginId) !== 'ACTIVATING') return false
    if (approval === 'timeout') {
      // 审批等待到期（timeout-plugin-service D3）：取消而非判拒——「没人答」
      // 不记录成「用户拒绝了插件」（权限存储不受影响，重触发激活时同一批权限
      // 重新弹审批）。置 UNLOADED（未装载态，状态机允许后续 activation event
      // 重触发激活）；expired 广播供前端撤回无人应答的弹窗（迟到批准对已删
      // pending noop 幂等，resolvePermissionApproval miss 不炸）。
      console.warn(
        `[plugin-activator] permission approval for ${pluginId} timed out after ${this.permissionTimeoutMs}ms — activation cancelled (plugin left UNLOADED, not rejected). ` +
          `Recovery: re-trigger the activation event to approve again; tune the wait via env TAIJI_PLUGIN_PERMISSION_TIMEOUT_MS (ms).`,
      )
      this.onPermissionRequestExpired?.({ pluginId })
      this.setState(pluginId, 'UNLOADED')
      return false
    }
    if (!approval) {
      this.setState(pluginId, 'UNLOADED')
      return false
    }
    return true
  }

  /**
   * D6 取消标志消费（doActivatePlugin 的 finally 出口）：激活期间收到过
   * deactivatePlugin 请求时——
   * - 成功 → 立即反卷真实 deactivate：此时插件在 Worker 内确实 active，必须
   *   发 deactivate 消息清理 hooks/subscriptions，只改状态会留下 Worker 侧幽灵激活
   * - 未成功（作废/失败/拒绝）→ 状态仍处中间态（DEACTIVATING）时终一化 UNLOADED；
   *   已是稳定态（UNLOADED）不重复写。removeDescriptor 已删状态时严禁回写
   *  （卸载后幽灵 setState 复活，见 gateOnPermissionApproval 早退检查注释）。
   */
  private async consumeDeactivateRequest(pluginId: string, host: PluginHost): Promise<void> {
    if (!this.deactivateRequested.delete(pluginId)) return
    if (this.pluginStates.get(pluginId) === 'ACTIVE') {
      await this.deactivatePlugin(pluginId, host)
      return
    }
    const s = this.pluginStates.get(pluginId)
    if (s === 'DEACTIVATING' || s === 'ACTIVATING') {
      this.setState(pluginId, 'UNLOADED')
    }
  }

  /**
   * 停用单个插件。
   *
   * 流程：DEACTIVATING → postMessage('deactivate') → 等待回复或超时 → dispose subscriptions
   */
  async deactivatePlugin(pluginId: string, host: PluginHost): Promise<void> {
    const currentState = this.pluginStates.get(pluginId)
    if (!currentState || currentState === 'UNLOADED' || currentState === 'DEACTIVATING') return

    // 该插件正挂在权限审批等待（ACTIVATING 中）→ 唤醒为「拒绝」：不 resolve 的话
    // 挂起中的激活要干等 30s 超时；且若等待期间用户批准（resolvePermissionApproval
    // (pluginId, true)），醒来的激活会绕过本次停用把插件拉回 ACTIVE。此处
    // resolve(false) + doActivatePlugin 醒来后的 ACTIVATING 状态检查双保险收敛到停用
    // 语义。（对非 ACTIVATING 态是 no-op：pending approval 只在 ACTIVATING 期间存在，
    // 但 CRASHED 等边缘态下残留的 pending 也在此一并清理。）
    this.resolvePermissionApproval(pluginId, false)

    // D6 并发守卫：ACTIVATING 中不直接走停用主流程——① 激活早期（assignWorker/
    // loadPlugin 未完成）getWorkerHandle 可能拿不到句柄，主流程会「假成功」停用而
    // 激活继续跑完把插件拉回 ACTIVE（幽灵复活）；② 直接发 deactivate 会与 activate
    // 消息并发在飞，正是旧单键 pendingReplies 回复错配的触发场景。处理：设取消标志
    // （由 doActivatePlugin 的 finally 消费：成功 → 立即反卷真实 deactivate；否则 →
    // 终一化 UNLOADED），状态改写 DEACTIVATING 使审批醒来的激活经 ACTIVATING 状态
    // 检查作废，最后 await in-flight 激活尝试——deactivatePlugin 返回时停用语义已
    // 收敛（最坏等待 ACTIVATE_TIMEOUT_MS，激活不完成就无法安全停用，代价可接受）。
    if (currentState === 'ACTIVATING') {
      this.deactivateRequested.add(pluginId)
      this.pluginStates.set(pluginId, 'DEACTIVATING')
      const inFlight = this.activationInFlight.get(pluginId)
      if (inFlight) await inFlight
      return
    }

    this.pluginStates.set(pluginId, 'DEACTIVATING')

    const handle = host.getWorkerHandle(pluginId)
    if (handle) {
      await this.sendAndWaitReply(
        handle,
        { type: 'deactivate', pluginId },
        pluginId,
        'deactivate',
        DEACTIVATE_TIMEOUT_MS,
      )
    }

    // dispose subscriptions
    this.disposeContext(pluginId)
    this.setState(pluginId, 'UNLOADED')
  }

  /** 停用所有已激活的插件 */
  async deactivateAll(host: PluginHost): Promise<void> {
    const activeIds = this.getActivePlugins()
    await Promise.allSettled(activeIds.map(pid => this.deactivatePlugin(pid, host)))
  }

  getActivePlugins(): string[] {
    const result: string[] = []
    for (const [pid, state] of this.pluginStates) {
      if (state === 'ACTIVE') result.push(pid)
    }
    return result
  }

  /**
   * 移除插件在 activator 侧的全部状态（F2-④，uninstall 用）。
   *
   * descriptors/pluginStates/eventMap 残留会导致「幽灵重激活」：插件已从 registry
   * 移除，但下一次 activationEvent 触发时 eventMap 仍命中并 re-activate（loadPlugin
   * 读已删除的 pluginPath 报错）。pendingReplies/pendingPermissions 一并清理并
   * resolve(false)，防 in-flight 回复悬挂到已卸载插件的 pending entry。
   *
   * activationInFlight 无需显式清理：被 resolve(false) 唤醒的挂起激活经
   * doActivatePlugin 的 ACTIVATING 状态检查提前 return，外层 activatePlugin 的
   * finally 随之移除 entry（自然收敛，不悬挂）。
   */
  removeDescriptor(pluginId: string): void {
    this.descriptors.delete(pluginId)
    this.pluginStates.delete(pluginId)
    this.contexts.delete(pluginId)
    for (const [pattern, ids] of this.eventMap) {
      const filtered = ids.filter(id => id !== pluginId)
      if (filtered.length === 0) {
        this.eventMap.delete(pattern)
      } else {
        this.eventMap.set(pattern, filtered)
      }
    }
    const pendingPermission = this.pendingPermissions.get(pluginId)
    if (pendingPermission) {
      clearTimeout(pendingPermission.timer)
      pendingPermission.resolve(false)
      this.pendingPermissions.delete(pluginId)
    }
    // D6 复合键：activate/deactivate 两个 op 的 pending entry 都要清理（并发开关
    // 在飞时卸载，任一残留都会悬挂到已卸载插件的回复匹配上）
    for (const op of ['activate', 'deactivate'] as const) {
      const pendingReply = this.pendingReplies.get(`${pluginId}:${op}`)
      if (pendingReply) {
        clearTimeout(pendingReply.timer)
        pendingReply.resolve(false)
        this.pendingReplies.delete(`${pluginId}:${op}`)
      }
    }
  }

  getState(pluginId: string): PluginState | undefined {
    return this.pluginStates.get(pluginId)
  }

  /** 将插件状态标记为 CRASHED（由 PluginService crash callback 调用） */
  markCrashed(pluginId: string): void {
    this.setState(pluginId, 'CRASHED')
  }

  /**
   * 等待权限审批结果。
   * 结局三态（timeout-plugin-service D3）：true=批准 / false=显式拒绝或挂起期清理
   * 唤醒 / 'timeout'=等待到期——超时与拒绝可区分，上游据此走取消分支（撤窗广播 +
   * UNLOADED 可重触发）而非判拒。
   */
  private waitForPermissionApproval(pluginId: string): Promise<boolean | 'timeout'> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingPermissions.delete(pluginId)
        resolve('timeout')
      }, this.permissionTimeoutMs)

      this.pendingPermissions.set(pluginId, { resolve, timer })
    })
  }

  /**
   * 外部调用以解决权限审批请求。
   * @param pluginId 插件 ID
   * @param approved true 通过，false 拒绝
   */
  resolvePermissionApproval(pluginId: string, approved: boolean): void {
    const pending = this.pendingPermissions.get(pluginId)
    if (!pending) {
      // miss noop 维持（幂等安全）：到期取消 / 挂起期清理后迟到的审批响应在此吞掉，
      // 不炸。debug 留痕供「用户点了批准但插件没装上」类问题归因（前端撤窗缺位时
      // 旧版前端仍可能派发迟到批准，D3 已知限制）。
      console.debug(
        `[plugin-activator] resolvePermissionApproval(${pluginId}, ${approved}) miss — no pending approval (already settled or cleaned up); late response ignored`,
      )
      return
    }

    clearTimeout(pending.timer)
    this.pendingPermissions.delete(pluginId)
    pending.resolve(approved)
  }

  /**
   * PluginHost 在收到 Worker 消息时调用，解析 pending promises。
   *
   * 处理 activated / deactivated / error 三种回复类型。D6 复合键精确匹配：
   * activated/deactivated 回复各自找对应 op（'activate'/'deactivate'）的 entry——
   * activate 与 deactivate 并发在飞时（如 DEACTIVATING 态重入激活），回复不再
   * 张冠李戴到另一 op 的 pending（旧单键实现 activated 回复会 resolve 掉
   * deactivate 的等待、反之亦然，引发假超时与 Worker/宿主幽灵态）。
   */
  handleWorkerReply(msg: WorkerToHostMessage): void {
    if (!('pluginId' in msg) || typeof msg.pluginId !== 'string') return

    if (msg.type === 'activated' || msg.type === 'deactivated') {
      const key = `${msg.pluginId}:${msg.type === 'activated' ? 'activate' : 'deactivate'}`
      const pending = this.pendingReplies.get(key)
      if (!pending) return
      clearTimeout(pending.timer)
      this.pendingReplies.delete(key)
      pending.resolve(true)
      return
    }

    if (msg.type === 'error') {
      // error 回复不带 op 维度（plugin-bootstrap 的 activate/deactivate 失败路径都发
      // 同型 {type:'error', pluginId, error}，见其 post 调用），无法精确归属——把该
      // 插件全部在飞 entry resolve(false)：activate/deactivate 两 op 的失败终态都收敛
      // UNLOADED，fail-fast 优于各自挂到超时。activate/deactivate 各自至多一个在飞
      // entry（pendingReplies 以 `${pluginId}:${op}` 复合键存取，Map 键唯一，不依赖
      // DEACTIVATING 入口守卫——DEACTIVATING 态重入激活时 activate 消息按 Worker IPC
      // FIFO 排队于 deactivate 之后，回复按复合键精确归属，无错配面），不存在误伤面。
      for (const op of ['activate', 'deactivate'] as const) {
        const key = `${msg.pluginId}:${op}`
        const pending = this.pendingReplies.get(key)
        if (!pending) continue
        clearTimeout(pending.timer)
        this.pendingReplies.delete(key)
        pending.resolve(false)
      }
    }
  }

  // ── Dependency Management ────────────────────────────────────────
  //
  // 图算法（topologicalSort / detectCycle / findMissingDependencies）已抽到
  // ./plugin-deps.ts 作为纯函数，可独立单测。下方方法保留为薄封装，维持
  // 既有 `activator.topologicalSort(...)` 调用契约（NON-BREAKING）。

  /**
   * 对插件列表进行拓扑排序（Kahn's algorithm）。
   * 纯算法委托给 plugin-deps.ts 的 topologicalSort。
   */
  topologicalSort(descriptors: PluginDescriptor[]): PluginDescriptor[] {
    return topologicalSort(descriptors)
  }

  /**
   * 检测插件依赖图中的循环依赖。
   * 纯算法委托给 plugin-deps.ts 的 detectCycle。
   */
  detectCycle(descriptors: PluginDescriptor[]): string[] | null {
    return detectCycle(descriptors)
  }

  /**
   * 按依赖顺序激活插件列表。
   *
   * 流程：
   * 1. 检查缺失依赖（extensionDependencies 引用了不存在的插件）
   * 2. 检测循环依赖
   * 3. 拓扑排序
   * 4. 按序逐个激活
   *
   * 图算法（步骤 1-3）调用 ./plugin-deps.ts 的纯函数；步骤 4 的激活
   * 依赖实例状态（descriptors / pluginStates），故保留在 activator 内。
   *
   * @param descriptors - 待激活的插件列表
   * @param host - PluginHost 实例
   * @throws 当存在缺失依赖或循环依赖时抛出 Error
   */
  async activateWithDeps(
    descriptors: PluginDescriptor[],
    host: PluginHost,
  ): Promise<void> {
    // 0. 注册描述符到内部状态（使激活流程能找到插件）
    this.registerDescriptors(descriptors)

    // 1. 检查缺失依赖（纯函数）
    const missingDeps = findMissingDependencies(descriptors)
    if (missingDeps.length > 0) {
      throw new Error(`Missing plugin dependencies: ${missingDeps.join(', ')}`)
    }

    // 2. 检测循环依赖（纯函数）
    const cycled = detectCycle(descriptors)
    if (cycled) {
      throw new Error(`Circular dependencies detected: ${cycled.join(' -> ')}`)
    }

    // 3. 拓扑排序 + 顺序激活
    const sorted = topologicalSort(descriptors)

    for (const desc of sorted) {
      await this.activatePlugin(desc.pluginId, { type: 'onStartupFinished' }, host)
    }
  }

  // ── Hot Reload ────────────────────────────────────────────────────
  //
  // fs.watch + debounce + reload fan-out 已抽到 ./plugin-hot-reload.ts 的
  // PluginHotReloader（自包含 watchers / timers 状态）。下方方法保留为薄封装，
  // 维持既有 `activator.watchAndReload(...)` / `performReload` / `stopWatching`
  // / `stopAllWatchers` 调用契约（NON-BREAKING）。

  /**
   * 构造热重载 hooks：把 PluginHotReloader 需要的能力桥接到本 activator
   * 的实例方法（deactivate / activate / 强杀 / 状态查询与设置）。
   */
  private buildHotReloadHooks(host: PluginHost): HotReloadHooks {
    return {
      deactivate: (pluginId) => this.deactivatePlugin(pluginId, host),
      activate: (pluginId) => this.activatePlugin(pluginId, { type: 'onStartupFinished' }, host),
      forceTerminate: async (pluginId) => {
        const handle = host.getWorkerHandle(pluginId)
        if (handle) await host.terminateWorker(handle.workerId)
      },
      disposeContext: (pluginId) => this.disposeContext(pluginId),
      setState: (pluginId, state) => this.pluginStates.set(pluginId, state),
      getState: (pluginId) => this.pluginStates.get(pluginId),
    }
  }

  /**
   * Watch an external plugin's directory for changes and auto-reload.
   * Built-in plugins (source === 'built-in') are excluded.
   */
  watchAndReload(
    pluginId: string,
    pluginPath: string,
    source: PluginSource,
    host: PluginHost,
    onStatusChange: StatusChangeCallback,
  ): void {
    this.hotReloader.watchAndReload(
      pluginId,
      pluginPath,
      source,
      this.buildHotReloadHooks(host),
      onStatusChange,
    )
  }

  /**
   * Perform a hot reload: deactivate → activate → broadcast status change.
   */
  async performReload(
    pluginId: string,
    host: PluginHost,
    onStatusChange: StatusChangeCallback,
  ): Promise<void> {
    await this.hotReloader.performReload(
      pluginId,
      this.buildHotReloadHooks(host),
      onStatusChange,
    )
  }

  /** Stop watching a specific plugin */
  stopWatching(pluginId: string): void {
    this.hotReloader.stopWatching(pluginId)
  }

  /** Stop all watchers (used during shutdown) */
  stopAllWatchers(): void {
    this.hotReloader.stopAllWatchers()
  }

  // ── Private helpers ─────────────────────────────────────────────

  /**
   * 稳定态状态回写：pluginStates 与 descriptor.status 同步。
   *
   * activator.descriptors 与 registry cache 持有同一 descriptor 对象引用，
   * PluginService.toPluginInfo 经 descriptor.status 映射 PluginInfo.status——
   * 只写 pluginStates 不回写 descriptor 会导致 toggle/激活后 UI 状态恒为
   * discovered（存量缺口：激活链路从未回写）。仅稳定态（ACTIVE/UNLOADED/
   * CRASHED）回写，ACTIVATING/DEACTIVATING 中间态不落 descriptor，避免 UI 闪烁。
   */
  private setState(pluginId: string, state: PluginState): void {
    this.pluginStates.set(pluginId, state)
    const descriptor = this.descriptors.get(pluginId)
    if (descriptor) descriptor.status = state
  }

  /**
   * 激活失败终态写点（V6② crash 连坐守护）。
   *
   * 激活在飞期间同宿主 load 超时 / Worker crash 链（plugin-host handleWorkerCrash →
   * PluginService crash callback → markCrashed）已把本插件置 CRASHED 时，激活自身的
   * 失败终态不得覆盖为 UNLOADED——handleWorkerRebuilt 只重载 CRASHED 态插件，覆盖会让
   * 被连坐插件在 rebuild 后被跳过（Gate B V6② 实测：同宿主正常插件未自动重载，需手动
   * toggle 恢复）。UNLOADED 的合法语义（首次安装锁 / 权限被拒 / 审批等待超时取消 /
   * 无 crash 参与的激活握手失败）不受影响：仅当状态已被 crash 链接管（CRASHED）时让位。
   * 权限等待路径不经此守卫：其作废检查（state !== 'ACTIVATING' 提前 return）已天然
   * 保留 CRASHED。
   */
  private settleActivationFailure(pluginId: string): void {
    if (this.pluginStates.get(pluginId) === 'CRASHED') return
    this.setState(pluginId, 'UNLOADED')
  }

  /** 根据 ActivationEvent 解析匹配的 pluginId 列表 */
  private resolveCandidates(event: ActivationEvent): string[] {
    const matched = new Set<string>()

    // 精确匹配事件类型（如 onStartupFinished）
    const byType = this.eventMap.get(event.type)
    if (byType) {
      for (const pid of byType) matched.add(pid)
    }

    // onSlashCommand:xxx 精确匹配 command
    if (event.type === 'onSlashCommand' && event.command) {
      const byCommand = this.eventMap.get(`onSlashCommand:${event.command}`)
      if (byCommand) {
        for (const pid of byCommand) matched.add(pid)
      }
    }

    return [...matched]
  }

  /**
   * 发送消息并注册 pending promise，等待 handleWorkerReply() 解析。
   * op 参与复合键（`${pluginId}:${op}`，D6 并发模型），超时自动 resolve(false)。
   */
  private sendAndWaitReply(
    handle: { workerId: string; postMessage(message: unknown): void },
    message: unknown,
    pluginId: string,
    op: 'activate' | 'deactivate',
    timeoutMs: number,
  ): Promise<boolean> {
    return new Promise((resolve) => {
      const key = `${pluginId}:${op}`
      const timer = setTimeout(() => {
        // 超时只清理自己注册的 entry（复合键 + timer 身份比对：并发重入同 op 时
        // 旧 timer 不误删新 entry——旧实现无条件 delete 是回复错配的帮凶）
        if (this.pendingReplies.get(key)?.timer === timer) {
          this.pendingReplies.delete(key)
        }
        // D4 错误规格（activate 超时行）：UNLOADED 保持 + 消息提示 activateTimeoutMs
        // 覆盖通道。只 activate 打——deactivate 超时是 D6 登记不动项（本地清理
        // 兜底已安全，维持静默 resolve(false)）。迟到的 activated 回复经 pending
        // miss noop（handleWorkerReply 守卫），不炸。
        if (op === 'activate') {
          console.warn(
            `[plugin-activator] activate reply for ${pluginId} timed out after ${timeoutMs}ms — ` +
              `plugin left UNLOADED (pass activateTimeoutMs option to extend; ` +
              `onActivate should stay lightweight — move heavy initialization to the first tool/command)`,
          )
        }
        resolve(false)
      }, timeoutMs)

      this.pendingReplies.set(key, { resolve, timer })
      handle.postMessage(message)
    })
  }

  /** dispose 插件的 subscriptions 并清理 context */
  private disposeContext(pluginId: string): void {
    const ctx = this.contexts.get(pluginId)
    if (ctx) {
      for (const sub of ctx.subscriptions) {
        // eslint-disable-next-line taste/no-silent-catch -- best-effort dispose, caller cannot recover
        try { sub.dispose() } catch (e: unknown) { console.debug('[plugin-activator] dispose subscription failed:', e) }
      }
      this.contexts.delete(pluginId)
    }
  }
}
