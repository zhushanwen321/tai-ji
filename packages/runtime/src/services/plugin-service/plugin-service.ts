import { PluginPermissionChecker as PermissionChecker } from './plugin-permission.js'
import type { PluginDescriptor, ToolEntry, HookEntry, HookContext, HookResult, BridgeToolExecuteRequest, BridgeToolExecuteResponse, BridgeInterceptResponse, BridgeSyncPayload, ToolRegistration, IPluginServiceDeps } from './plugin-types.js'
import type { StatusBarItem, PluginInfo } from '@xyz-agent/shared'
import type { IPluginService, ISessionService } from '../../interfaces.js'
import type { IMessageBroker } from '../../interfaces.js'
import type { ServerMessage } from '@xyz-agent/shared'
import { PluginRegistry } from './plugin-registry.js'
import { PluginStorage } from './plugin-storage.js'
import { SessionDataStore } from './session-data-store.js'
import { PluginRpcServer } from './plugin-rpc-server.js'
import { PluginHost } from './plugin-host.js'
import { PluginActivator, PERMISSION_TIMEOUT_MS } from './plugin-activator.js'
import { registerAllRpcMethods } from './plugin-rpc-setup.js'
import { bootstrapPluginService } from './plugin-lifecycle.js'
import { ActiveSessionResolver, SessionEventDispatch, sessionInfoFromSummary } from './api/session-api.js'
import type { CommandRegistration } from './api/commands-api.js'
import { executeCommand as executePluginCommand, deliverInvokeResult as deliverPluginInvokeResult } from './api/commands-executor.js'
import type { InstallResult } from '../ports/plugin-installer.js'
import { handleBridgeToolExecute, handleBridgeEvent, handleBridgeIntercept, BridgeToolCache, PI_HOOK_EVENT_MAP } from './bridge-interop.js'
import { toConfigKey, fromConfigKey, isConfigKey } from './api/config-api.js'
import { HookPipeline, OBSERVE_HOOK_TYPES } from './hook-pipeline.js'
import { UiRequestQueue } from './ui-request-queue.js'
import { StatusBarRegistry } from './status-bar-registry.js'
import { PermissionStorage } from './plugin-permission-storage.js'
import { EXTERNAL_PLUGIN_ENABLED, EXTERNAL_PLUGIN_DISABLED_MESSAGE } from './plugin-security.js'
import { resolveEsmLoaderExecArgv } from './plugin-esm-execargv.js'
import { toPluginInfos } from './plugin-info-mapper.js'
import { removePluginHookEntries, removePluginToolEntries, removePluginCommandEntries } from './plugin-contributions.js'
import { shutdownPluginCollaborators } from './plugin-shutdown.js'
import { join } from 'node:path'
import { toErrorMessage } from '../../utils/errors.js'
import { PendingTracker } from '../../utils/async/pending-tracker.js'
// type-only：IMessageBus 不反向依赖 plugin-service，无运行时环（与 message-dispatcher 同款约束）
// wave:perf-w09（接口收敛）：依赖 publish 抽象而非 MessageBus 具体类
import type { IMessageBus } from '../message-bus/message-bus.js'

/**
 * XYZ_PLUGIN_PERMISSION_TIMEOUT_MS 读取（timeout-plugin-service D3）：权限审批
 * 等待的全局逃生门。合法正数生效；缺失/非法 warn 回落 undefined → Activator 构造
 * 函数落 PERMISSION_TIMEOUT_MS（回落权威单一在构造函数，此处只解析 env）。
 *
 * 形态对齐 subagent-core lifecycle-manager getEnvIdleTimeoutMs 先例：「以为设了
 * 超长等待、实际回落默认」的静默语义漂移不可见，非法必须 warn 留痕。
 *
 * §11 检查点结论（C-proc-09 核对）：runtime 进程自读 env，不进任何白名单——
 * 入站方向 ENV_WHITELIST_PREFIXES（shared/constants.ts）已含裸 'XYZ_' 前缀天然
 * 放行；出站方向 runtime 不向子进程注入此变量（消费点仅 runtime 自身），且
 * SPAWN_ENV_FORWARD_REFERENCE 为纯文档性登记不参与过滤（runtime 自身行为开关
 * 不登记，XYZ_LOG_LEVEL 族 U0-② 同款结论）。
 */
function readEnvPermissionTimeoutMs(): number | undefined {
  const raw = process.env.XYZ_PLUGIN_PERMISSION_TIMEOUT_MS
  if (!raw) return undefined
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.warn(
      `[plugin-service] XYZ_PLUGIN_PERMISSION_TIMEOUT_MS="${raw}" is invalid (expected a positive millisecond number) — falling back to default ${PERMISSION_TIMEOUT_MS}ms (30min); set a plain ms value (e.g. 1800000) to override`,
    )
    return undefined
  }
  return parsed
}

// （BC）findTsxImportArg / resolveEsmLoaderExecArgv 原从本文件导出（实现迁至
// plugin-esm-execargv.ts，max-lines 拆分），re-export 保持既有导入路径稳定
export { findTsxImportArg, resolveEsmLoaderExecArgv } from './plugin-esm-execargv.js'

/**
 * PluginService — 纯门面 + 初始化编排（ADR-0012/0013/0014/0023/0001）。
 *
 * 5 个原交职责已下沉到内聚模块，本类仅保留：
 *  (a) initialize 编排（9 步生命周期装配）；
 *  (b) 协作者装配（registry/storage/rpcServer/host/activator/...）；
 *  (c) 薄门面方法：委托 HookPipeline / UiRequestQueue / StatusBarRegistry /
 *      bridge-interop（命令执行发送段在 api/commands-executor.ts，协议映射在
 *      plugin-info-mapper.ts，贡献清理在 plugin-contributions.ts）。
 */
export class PluginService implements IPluginService {
  /** 插件注册表（与 host/rpcServer/activator 同为协作者装配位，公开供测试直注 descriptor） */
  readonly registry: PluginRegistry
  private storage: PluginStorage
  rpcServer: PluginRpcServer
  host: PluginHost
  /** 激活状态机（与 host/rpcServer 同为协作者装配位，公开供编排层与测试直查状态） */
  readonly activator: PluginActivator
  private broker: IMessageBroker
  private initialized = false

  /** Tool 注册表，key 为 toolKey（`${pluginId}:${name}`） */
  private toolRegistry = new Map<string, ToolEntry>()

  /** Hook 执行管道（持有 hookRegistry、共享 host/rpcServer 引用） */
  readonly hookPipeline: HookPipeline

  /** Status bar 注册表（持有 items，广播交由注入回调） */
  readonly statusBarRegistry: StatusBarRegistry

  /** UI 请求串行队列（独立状态机，广播交由注入回调） */
  readonly uiRequestQueue: UiRequestQueue

  /** SessionData 内存缓存 + flush + 持久化编排 */
  private readonly sessionDataStore: SessionDataStore

  /** 注入的外部依赖 */
  private deps: IPluginServiceDeps

  /** xyz-agent 配置根（~/.xyz-agent/），plugin/session-data 持久化根。组合根注入。 */
  private readonly configDir: string

  /** bridge 工具 schema 缓存 + sync 负载塑形（P5：职责收口到 bridge-interop） */
  private readonly bridgeToolCache = new BridgeToolCache()

  private permissionChecker: PermissionChecker

  /** 活跃 session 解析器（P6：取代 plugin-rpc-setup 模块级全局缓存，随实例生命周期） */
  private readonly activeSessionResolver: ActiveSessionResolver

  /**
   * 命令注册表（复合键 `pluginId:commandId` → CommandRegistration，D7 隔离），
   * commands 域 RPC handler 共享（IF2 DM1）。
   */
  private readonly commandRegistry = new Map<string, CommandRegistration>()

  /**
   * 命令执行 pending 登记表（S3-W1 发送段闭环）：executeCommand 发
   * plugin.commands.invoke 通知后按 handlerId 等待 Worker 经
   * plugin.commands.invoke.result 回传的结果/错误；超时兜底 reject。
   */
  private readonly commandInvokes = new PendingTracker<string, unknown>()

  /** session 生命周期事件注册表（S3-W2）：handlerId → workerId 定向投递 */
  private readonly sessionEventDispatch: SessionEventDispatch

  /** 挂载点集合（renderer 经 plugin.mountPoints.sync 上报，views.listMountPoints 中继查询，AC10） */
  private mountPoints: string[] = []

  /**
   * IMessageBus（wave:perf-w08，02 文档 D1-1）：plugin 的 session 级广播接 bus 定向发布。
   * 经 setMessageBus 后置注入（与 SessionService.setMessageBus 同模式）。wave:perf-w09
   * 接口收敛后 wire 归组合根（index.ts，pluginService 构造后直调）。未注入时回退全局广播。
   */
  private messageBus: IMessageBus | null = null

  constructor(registry: PluginRegistry, broker: IMessageBroker, deps?: IPluginServiceDeps) {
    this.registry = registry
    this.broker = broker
    this.deps = deps ?? {}
    // configDir 注入：plugin 切片经此拿配置根（~/.xyz-agent/），不再直连 infra（design.md
    // T5 切片自治）。生产由 index.ts 注入；缺省回退 process.cwd() 仅供单测。
    const configDir = this.deps.configDir ?? process.cwd()
    this.configDir = configDir
    const pluginsDir = join(configDir, 'plugins')
    this.storage = new PluginStorage()
    this.rpcServer = new PluginRpcServer()
    // sandbox 子进程 ESM loader 经 execArgv --import 注入（重构 3：消除 ESM 绕过）。
    // MF-1：loader 缺失时 resolveEsmLoaderExecArgv 返回 undefined → 不传 execArgv 选项 →
    // PluginHostProcess.execArgv 默认 [] → sandbox fork 边界 fail-closed throw（见
    // plugin-host-process.ts createProcess 的 SANDBOX_LOADER_MISSING 断言）。runtime 不崩。
    const esmExecArgv = resolveEsmLoaderExecArgv()
    this.host = new PluginHost(
      this.rpcServer,
      esmExecArgv ? { execArgv: esmExecArgv } : undefined,
    )
    this.sessionDataStore = new SessionDataStore(configDir, undefined, undefined, this.deps.trashFile)
    this.permissionChecker = new PermissionChecker(registry, new PermissionStorage(pluginsDir))

    // 活跃 session 解析器：持有同一 deps 引用（setSessionService 后续 mutate 可见）
    this.activeSessionResolver = new ActiveSessionResolver(this.deps)

    // session 事件注册表：复用同一 rpcServer（workerId↔port 映射 + notify 通道）
    this.sessionEventDispatch = new SessionEventDispatch(this.rpcServer)

    // Hook 管道：持有共享 hookRegistry（rpc-setup 注册侧与本类消费侧同一实例），
    // 复用 host / rpcServer 引用。
    this.hookPipeline = new HookPipeline({
      hookRegistry: new Map<string, HookEntry[]>(),
      host: this.host,
      rpcServer: this.rpcServer,
    })

    // UI 请求队列：广播走 broadcastFn（优先）或 broker.broadcast（回退），与原实现一致。
    // MF-2：广播 payload 注入当前活跃 sessionId（与 views.update 同源，ActiveSessionResolver 求值时点）——
    // 前端 DialogRequestQueue/useExtensionUI 均按 sessionId 分区消费，无 sid 的 uiRequest 会被双消费方
    // 丢弃（C2 守卫），plugin dialog 永不弹出。resolve 时点求值：同一会话串行队列内 resolve 稳定。
    // wave:perf-w08（02 文档 D1-1）：sid 为 string 且 bus 已装配 → bus.publish(sid) 定向发布
    // （plugin:uiRequest 归 stream 类，分配 seq + 入 ring 可回放），不再 broadcast；
    // sid undefined（无活跃 session 的弹窗仍须必达全部连接）或 bus 未装配 → 保持全局广播。
    this.uiRequestQueue = new UiRequestQueue((type, payload) => {
      // 撤窗广播不走 session 级 bus（D2 收尾修正，与 D3 permissionRequestExpired 直发
      // 形态对称）：bus.publish(sid) 落 session 级帧 onGlobal 永不可达 → 撤窗生产常态
      // 失效。直发 global 通道；payload 注入活跃 sessionId（协议可选字段，S1：renderer
      // 重启后 requestId 反查 Map 为空致过期弹窗残留——renderer 以 requestId 反查 Map 为主（MF-4），
      // payload sid 仅作 renderer 重启后 Map 为空的兜底）。
      if (type === 'plugin:uiRequestExpired') {
        const sid = this.activeSessionResolver.resolve()?.id
        this.broadcastOrBroker(type, `ui_${payload.requestId}`, { ...payload, sessionId: sid })
        return
      }
      const active = this.activeSessionResolver.resolve()
      const sid = active?.id
      const fullPayload = { ...payload, sessionId: sid }
      if (sid !== undefined && this.messageBus) {
        // m2：'plugin:uiRequest' 已收录 ServerMessageMap 具名条目（requestId 必带 + 索引签名
        // 透传 dialog 字段），UiBroadcastFn payload 同步收紧——免 as ServerMessage 断言，
        // payload 形状漂移在编译期被 shared 契约拦截。
        this.messageBus.publish(sid, {
          type,
          id: `ui_${payload.requestId}`,
          payload: fullPayload,
        })
        return
      }
      this.broadcastOrBroker(type, `ui_${payload.requestId}`, fullPayload)
    })

    // Status bar 注册表：广播保持 `plugin:statusBarUpdate` 契约（ADR-0015）。
    this.statusBarRegistry = new StatusBarRegistry((payload) => this.broker.broadcast({
      type: 'plugin:statusBarUpdate', id: `sb_${Date.now()}`, payload,
    } as ServerMessage))

    this.activator = new PluginActivator({
      permissionChecker: this.permissionChecker,
      onPermissionRequest: (payload) =>
        this.broadcastOrBroker('plugin:permissionRequest', `perm_${payload.pluginId}`, payload),
      // 审批等待到期取消（timeout-plugin-service D3）：广播供前端撤回无人应答的
      // 审批弹窗（迟到批准对已删 pending noop 幂等；旧版前端未消费此帧无异常，P-11）。
      onPermissionRequestExpired: (payload) =>
        this.broadcastOrBroker('plugin:permissionRequestExpired', `permExpired_${payload.pluginId}`, payload),
      // permissionTimeoutMs 转正（D3）：env 逃生门接线，undefined（缺失/非法已 warn）
      // 由 Activator 构造函数回落 PERMISSION_TIMEOUT_MS。
      permissionTimeoutMs: readEnvPermissionTimeoutMs(),
    })
  }

  /** 广播优先走 broadcastFn，否则回退 broker.broadcast（广播契约不变） */
  private broadcastOrBroker(type: string, id: string, payload: unknown): void {
    if (this.deps.broadcastFn) {
      this.deps.broadcastFn(type, payload)
    } else {
      this.broker.broadcast({ type, id, payload } as ServerMessage)
    }
  }

  /**
   * 覆盖式写入挂载点集合（DM3 全量镜像，不合并）。
   * renderer 壳在注册/注销挂载点后经 plugin.mountPoints.sync WS 上报整表。
   * 注意：必须原地清空重填（length=0 + push）而非整体替换引用——
   * registerRpcMethods 已把 this.mountPoints 的引用透传给 ctx → registerViewRpcHandlers，
   * 替换引用会让 RPC handler 读到旧数组（AC10 中继失效）。
   */
  syncMountPoints(mountPoints: string[]): void {
    this.mountPoints.length = 0
    this.mountPoints.push(...mountPoints)
  }

  /** Wire sessionService after construction (breaks circular dependency at creation time) */
  setSessionService(sessionService: ISessionService): void {
    this.deps.sessionService = sessionService
  }

  /**
   * Wire IMessageBus（02 文档 D1-1）：plugin 的 session 级广播点（plugin:viewUpdate /
   * plugin:uiRequest）接 bus 定向发布。wave:perf-w09 接口收敛：wire 归组合根
   *（index.ts 在 pluginService 构造后直调，不再经 server.setServices 中转）。
   * 未注入时广播点回退全局广播（broker.broadcast 兜底，消息不丢）。
   */
  setMessageBus(bus: IMessageBus): void {
    this.messageBus = bus
  }

  /**
   * views.update 的广播出口（wave:perf-w08，02 文档 D1-1；rpc-setup 的
   * handleViewUpdate 构造 payload 后经此发布）。
   *
   * payload.sessionId 由调用方保证存在（rpc-setup ES2：无活跃 session 已提前丢弃）。
   * bus 已装配 → publish 定向（plugin:viewUpdate 归 transient 类：高频 UI 流，不占
   * seq、不入 ring，直传订阅者——丢失可接受，ExtensionHost 不靠 ring 回放重建状态），
   **不再 broadcast**；bus 未装配（测试构造）→ 回退全局广播，保持消息不丢。
   */
  publishViewUpdate(payload: {
    sessionId: string
    viewId: string
    pluginId: string
    guiTree: import('@xyz-agent/extension-protocol').GuiComponent[]
    updatedAt: number
  }): void {
    if (this.messageBus) {
      // m2/m3：'plugin:viewUpdate' 已是 ServerMessageMap 精确条目（payload 形状一致），
      // 免 as ServerMessage 断言；push id 改单调计数（Date.now() 同毫秒多视图更新会碰撞，
      // 前端按 id 去重/追踪场景下碰撞导致更新被误判重复）。
      this.messageBus.publish(payload.sessionId, {
        type: 'plugin:viewUpdate',
        id: this.nextViewUpdateId(),
        payload,
      })
      return
    }
    this.broadcastOrBroker('plugin:viewUpdate', this.nextViewUpdateId(), payload)
  }

  /**
   * viewUpdate push id 单调计数（m3，对齐 broker.nextPushId 语义）。
   * `vu_${Date.now()}` 在同一毫秒内多次 views.update（批量刷新多视图）会产出相同 id。
   */
  private viewUpdateIdCounter = 0
  private nextViewUpdateId(): string {
    this.viewUpdateIdCounter += 1
    return `vu_${this.viewUpdateIdCounter}`
  }

  async initialize(): Promise<void> {
    if (this.initialized) return

    // Worker 回调（crash/rebuilt/reply）紧耦合多个私有协作者（activator/broker/
    // registry/host），搬出会引入更宽的注入缝，故作为委托缝留在本类（P4 PARTIAL）。
    this.registerWorkerCallbacks()

    // 9 步顺序启动装配委托 plugin-lifecycle（god-orchestrator 收口）。
    await bootstrapPluginService({
      registry: this.registry,
      storage: this.storage,
      rpcServer: this.rpcServer,
      host: this.host,
      activator: this.activator,
      permissionChecker: this.permissionChecker,
      sessionDataStore: this.sessionDataStore,
      configDir: this.configDir,
      registerRpcMethods: () => this.registerRpcMethods(),
      broadcastPluginList: () => this.broadcastPluginList(),
      watchExternalIfActive: (desc) => this.watchExternalIfActive(desc),
      registerSendMessageHook: () => this.registerSendMessageHook(),
    })

    this.initialized = true
  }

  /**
   * 注册 Worker 生命周期回调（crash / rebuilt / reply）。
   *
   * P4：这三个回调紧耦合 activator.markCrashed、broker.broadcast、
   * registry.getDescriptor、host.loadPlugin、activator.activatePlugin 等
   * 私有协作者，搬出 plugin-service 会引入更宽的注入缝，故作为委托缝留在本类。
   */
  private registerWorkerCallbacks(): void {
    // 4. Worker crash callback
    this.host.setCrashCallback((workerId, pluginIds, error) => {
      for (const pluginId of pluginIds) {
        this.activator.markCrashed(pluginId)
      }
      // D6/W4 贡献清理：崩溃插件的 statusBar/hook/tool/command 贡献不残留——对齐
      // togglePlugin(false) 的清理集（僵尸 statusbar 条目/仍可被路由的 tool/command
      // 都指向已死 Worker，调用必超时）。rebuild 成功后 onRebuilt 重激活会重新注册。
      for (const pluginId of pluginIds) {
        this.statusBarRegistry.clearForPlugin(pluginId)
        this.removeHookEntriesFor(pluginId)
        this.removeToolEntriesFor(pluginId)
        this.removeCommandEntriesFor(pluginId)
        this.sessionEventDispatch.clearForPlugin(pluginId)
      }
      void this.syncToolsToBridge().catch((err: unknown) => {
        console.error('[plugin-service] syncToolsToBridge after crash failed:', toErrorMessage(err))
      })
      for (const pluginId of pluginIds) {
        this.broker.broadcast({
          type: 'plugin:crashed',
          id: `crash_${pluginId}_${Date.now()}`,
          payload: { pluginId, workerId, error },
        })
      }
      // Trusted Worker 崩溃后通过 rebuildWorker 自动重建
    })

    // 4a. Worker 重建后的重新加载回调
    this.host.setRebuiltCallback((newWorkerId, pluginIds) => {
      this.handleWorkerRebuilt(newWorkerId, pluginIds)
    })

    // 4b. Worker 生命周期回复回调（activated/deactivated/error）
    this.host.setReplyCallback((msg) => {
      this.activator.handleWorkerReply(msg as import('./plugin-types.js').WorkerToHostMessage)
    })
  }

  /**
   * Worker 重建后的重载编排（rebuild 回调实现，D6/W3）。
   *
   * 只重激活当前状态为 CRASHED 的插件：冷却窗口内用户 disable（UNLOADED）或
   * uninstall（状态已移除）的插件跳过——rebuild 无条件重激活会复活用户明确
   * 关闭的插件（幽灵激活）。单插件重载失败只记日志，不影响同 Worker 其他插件。
   */
  handleWorkerRebuilt(newWorkerId: string, pluginIds: string[]): void {
    for (const pluginId of pluginIds) {
      const state = this.activator.getState(pluginId)
      if (state !== 'CRASHED') {
        console.log(`[plugin-service] skip reload after rebuild: ${pluginId} state=${state ?? 'REMOVED'}（非 CRASHED，用户已 disable/uninstall）`)
        continue
      }
      try {
        const descriptor = this.registry.getDescriptor(pluginId)
        if (descriptor) {
          this.host.loadPlugin(newWorkerId, pluginId, descriptor.pluginPath, 'trusted').then(() => {
            // Re-activate the plugin after loading
            return this.activator.activatePlugin(pluginId, { type: 'onStartupFinished' }, this.host)
          }).catch((err: unknown) => {
            console.error(`[plugin-service] failed to reload plugin ${pluginId}:`, err)
          })
        }
      // eslint-disable-next-line taste/no-silent-catch -- worker reload: error logged, other plugins unaffected
      } catch (err: unknown) {
        console.error(`[plugin-service] failed to reload plugin ${pluginId}:`, err)
      }
    }
  }

  /**
   * 由 initialize() 调用，确保 session 创建时 hook 已就绪。
   */
  private registerSendMessageHook(): void {
    if (this.deps?.sessionService) {
      this.deps.sessionService.setSendMessageHook(async (sessionId, content) => {
        const result = await this.executeHooks('onBeforeSendMessage', {
          sessionId,
          content,
          pluginId: '',
          hookType: 'onBeforeSendMessage' as import('./plugin-types.js').HookType,
          data: { content },
          timestamp: Date.now(),
        })
        if (result.blocked) return { blocked: true, reason: result.reason }
        // transform 语义消费侧（01 文档 §3.1 第 4 步）：拦截器经 modifiedData 改写的
        // {content} 由 HookPipeline 映射为 transformedData（D2-3），此处透传给
        // message-dispatcher 作为实际发送内容（demo 插件 !important → IMPORTANT 即此链路）
        const modifiedContent = (result.transformedData as { content?: unknown } | undefined)?.content
        if (typeof modifiedContent === 'string') {
          return { blocked: false, modifiedContent }
        }
        return null
      })
      // S3-W2：session 生命周期事件接线——session-service 的创建/销毁回调（其内部
      // 收敛点 notifySessionCreated / removeSessionEntry）转发到注册表，按 handlerId
      // 记录的 workerId 定向投递 plugin.sessions.didCreate/didDestroy 到对应 Worker。
      //
      // B5 摘碑双路径①（memory-leak-remediation §3.2-B5，R4）：链式追加在既有回调体内
      // （setOnSessionCreated 是单槽回调——二次调用会覆盖，丢 didCreate 投递，禁止）；
      // notifySessionCreated 三收敛点（session-lifecycle create/restore/fork，主线程同步
      // 动作，不依赖经 worker 的异步链）都会流经本回调，覆盖废纸篓还原→打开等同 id
      // 复活路径——复活后迟到/新写恢复，clearSession 的 tombstone 摘除。
      this.deps.sessionService.setOnSessionCreated(summary => {
        this.sessionDataStore.reviveSession(summary.id)
        this.sessionEventDispatch.didCreate(sessionInfoFromSummary(summary))
      })
      this.deps.sessionService.setOnSessionDestroyed(summary => {
        this.sessionEventDispatch.didDestroy(sessionInfoFromSummary(summary))
      })
    }
  }

  getDiscoveredPlugins(): PluginInfo[] {
    // 协议映射（PluginDescriptor → PluginInfo）实现迁至 plugin-info-mapper.ts
    return toPluginInfos(this.registry.getAllDescriptors())
  }

  async togglePlugin(pluginId: string, enabled: boolean): Promise<PluginInfo[]> {
    const descriptor = this.registry.getDescriptor(pluginId)
    if (!descriptor) throw new Error(`Plugin not found: ${pluginId}`)

    try {
      if (enabled) {
        // 启用：只激活目标插件（非全部）
        await this.activator.activatePlugin(pluginId, { type: 'onStartupFinished' }, this.host)
        // 激活成功后，对外部插件启动热重载监听
        this.watchExternalIfActive(descriptor)
      } else {
        // 禁用
        await this.activator.deactivatePlugin(pluginId, this.host)
        this.activator.stopWatching(pluginId) // 停止热重载监听
        this.statusBarRegistry.clearForPlugin(pluginId) // 清理 status bar items
        this.removeHookEntriesFor(pluginId) // P-1：清 hook 注册，禁用插件的 hook 不再执行
        // Fix-7：禁用插件的工具/命令同步清注册——与 P-1 的 hook 清理对称，否则禁用插件的
        // 工具仍可被 bridge 调用、命令 invoke 仍发向该插件（worker 已 deactivate，必超时）
        this.removeToolEntriesFor(pluginId)
        this.removeCommandEntriesFor(pluginId)
        // S3-W2：session 事件注册表同步清理（禁用插件的 didCreate/didDestroy 订阅不再投递）
        this.sessionEventDispatch.clearForPlugin(pluginId)
        await this.syncToolsToBridge()
      }
     
    } catch (err: unknown) {
      console.error(`[plugin-service] togglePlugin(${pluginId}, ${enabled}) failed:`, toErrorMessage(err))
      // 激活/停用失败仍然返回当前插件列表（允许前端回滚 UI）
    }

    this.broadcastPluginList()
    return this.getDiscoveredPlugins()
  }

  /** external 且已 ACTIVE 的插件启动 hot-reload 监听（重复逻辑统一） */
  private watchExternalIfActive(descriptor: PluginDescriptor): void {
    if (descriptor.source !== 'external' || this.activator.getState(descriptor.pluginId) !== 'ACTIVE') return
    this.activator.watchAndReload(descriptor.pluginId, descriptor.pluginPath, descriptor.source, this.host, (payload) => {
      this.broker.broadcast({ type: 'plugin:statusChange', id: `watch_${payload.pluginId}_${Date.now()}`, payload })
    })
  }

  async uninstallPlugin(pluginId: string): Promise<PluginInfo[]> {
    // descriptor 先取（removeDescriptor 之前）：pluginPath 供磁盘删除、source 供
    // builtin 判定
    const descriptor = this.registry.getDescriptor(pluginId)

    // 停用插件。Fix-5：deactivate 失败不阻断后续清理——注册表/工具/hook/命令清理是
    // uninstall 的核心语义，Worker 侧 deactivate 抛错（如超时）时仍必须完成本地拆除
    try {
      await this.activator.deactivatePlugin(pluginId, this.host)
    } catch (err: unknown) {
      // best-effort 降级（Fix-5）：deactivate 失败不阻断清理——uninstall 的注册表/工具/
      // hook/命令拆除必须完成（Worker 已 deactivate 抛超时等错误时仍要拆本地状态）
      console.error(`[plugin-service] deactivate during uninstall failed (continuing cleanup) for ${pluginId}:`, toErrorMessage(err))
    }

    // F2-①：停该插件的 fs.watch 热重载监听（toggle(false) 有 stopWatching，uninstall
    // 此前缺失——目录删除后残留 watcher 持续触发 reload 事件）
    this.activator.stopWatching(pluginId)

    // F2-③：sandbox 子进程真杀。deactivate 只 postMessage 不 terminate（fork 宿主的
    // 进程复用设计），但 uninstall 后插件目录即删，复用无意义且泄漏进程。
    // terminateProcess 内置 SIGTERM→2s→SIGKILL 升级链。trusted Worker 共享
    //（≤10 插件/线程），terminate 会误杀同 worker 其他插件，跳过。未激活/无进程
    // 时 getWorkerHandle 返回 undefined，天然 no-op。
    const handle = this.host.getWorkerHandle(pluginId)
    if (handle && handle.workerId.startsWith('sandbox-')) {
      await this.host.terminateWorker(handle.workerId).catch((err: unknown) => {
        console.error(`[plugin-service] terminate sandbox process during uninstall failed for ${pluginId}:`, toErrorMessage(err))
      })
    }

    // F2-②：删除磁盘插件目录（此前缺失 → 重启后 registry.scan() 把插件扫回来）。
    // 仅 external 插件删盘——builtin（resources/plugins，随应用分发）删盘会破坏安装
    // 产物。删除失败记日志不中断内存清理：磁盘残留重启后被 scan 扫回、可重试；
    // 内存清理（下方 registry/activator/工具/hook 拆除）是 uninstall 的核心语义。
    if (descriptor && descriptor.source === 'external') {
      const installer = this.deps.pluginInstaller
      if (installer) {
        try {
          await installer.uninstall(pluginId, descriptor.pluginPath)
        } catch (err: unknown) {
          // best-effort 降级：磁盘删除失败不阻断后续内存清理（registry/activator/贡献
          // 拆除是 uninstall 的核心语义）——残留目录重启后被 scan 扫回、可重试
          console.error(`[plugin-service] on-disk removal during uninstall failed (continuing in-memory cleanup) for ${pluginId}:`, toErrorMessage(err))
        }
      } else {
        console.warn(`[plugin-service] no pluginInstaller configured; on-disk removal skipped for ${pluginId}`)
      }
    }

    // 从注册表中移除
    this.registry.removeDescriptor(pluginId)

    // F2-④：清理 activator 侧描述符/状态/eventMap（此前缺失 → 幽灵重激活：
    // activationEvent 下次触发时 eventMap 仍命中已卸载插件）
    this.activator.removeDescriptor(pluginId)

    // 清理工具和 hook 注册
    this.removeToolEntriesFor(pluginId)
    this.removeHookEntriesFor(pluginId)
    // 清理命令注册表（插件卸载后残留命令会导致 invoke 通知发向已死 worker）
    this.removeCommandEntriesFor(pluginId)
    // S3-W2：session 事件注册表同步清理（卸载插件的订阅不再投递）
    this.sessionEventDispatch.clearForPlugin(pluginId)

    // 清理 status bar items
    this.statusBarRegistry.clearForPlugin(pluginId)

    await this.syncToolsToBridge()
    this.broadcastPluginList()
    return this.getDiscoveredPlugins()
  }

  /**
   * 清理指定插件的全部 hook 注册条目（P-1：togglePlugin(false) 与 uninstallPlugin 共用）。
   *
   * 实现在 plugin-contributions.ts（max-lines 拆分迁出）；
   * Worker 侧对偶清理在 plugin-bootstrap 的 'deactivate' 分支（disposePluginHooks）。
   */
  private removeHookEntriesFor(pluginId: string): void {
    removePluginHookEntries(this.hookPipeline.registry, pluginId)
  }

  /**
   * 清理指定插件的全部工具注册条目（Fix-7：与 removeHookEntriesFor 同模式）。
   *
   * togglePlugin(false) 与 uninstallPlugin 共用——禁用插件的工具不再出现在 bridge
   * schema 同步（syncToolsToBridge）与 bridge 执行路由中（实现迁至
   * plugin-contributions.ts）。
   */
  private removeToolEntriesFor(pluginId: string): void {
    removePluginToolEntries(this.toolRegistry, pluginId)
  }

  /**
   * 清理指定插件的全部命令注册条目（Fix-7：与 removeHookEntriesFor 同模式）。
   * 禁用/卸载后 command invoke 不再投递给该插件（实现迁至 plugin-contributions.ts）。
   */
  private removeCommandEntriesFor(pluginId: string): void {
    removePluginCommandEntries(this.commandRegistry, pluginId)
  }

  async approvePermissions(pluginId: string, permissions: string[]): Promise<void> {
    const descriptor = this.registry.getDescriptor(pluginId)
    if (!descriptor) throw new Error(`Plugin not found: ${pluginId}`)

    // Update descriptor permissions
    descriptor.permissions = [...new Set([...descriptor.permissions, ...permissions])]
    // Update permission checker's granted map
    this.permissionChecker.grant(pluginId, permissions)
    await this.permissionChecker.save()

    // 唤醒正挂在权限审批等待的那次激活（若有）：只 grant 不 resolve pending 的话，
    // 挂起中的激活（boot/handleEvent 里 await 着）要干等 30s 超时才回落。无 pending
    // 时 no-op（resolvePermissionApproval 内部守卫）。
    this.activator.resolvePermissionApproval(pluginId, true)

    // activatePlugin 真幂等（in-flight 重入返回同一 promise）：
    // - 挂起中的激活刚被唤醒、仍在 ACTIVATING → 此处 await 与它同步完成（毫秒级）；
    // - 已 ACTIVE → no-op；
    // - UNLOADED（等待早已超时回落 / 从未激活）→ 权限已 grant，新起激活不再挂起。
    await this.activator.activatePlugin(pluginId, { type: 'onStartupFinished' }, this.host)
    this.watchExternalIfActive(descriptor)
  }

  async revokePermissions(pluginId: string): Promise<void> {
    const descriptor = this.registry.getDescriptor(pluginId)
    if (!descriptor) throw new Error(`Plugin not found: ${pluginId}`)

    descriptor.permissions = []
    this.permissionChecker.revoke(pluginId)
    await this.permissionChecker.save()

    // 拒绝语义：该插件正挂在权限审批等待时唤醒为「拒绝」——挂起中的激活走既有
    // 失败路径（UNLOADED、不分配 Worker），而非干等 30s 超时。无 pending 时 no-op
    // （仅撤销已授权限，不主动停用已激活插件）。
    this.activator.resolvePermissionApproval(pluginId, false)
  }

  /**
   * 执行插件注册的命令（S3-W1 发送段闭环）。
   *
   * 实现在 api/commands-executor.ts（max-lines 拆分迁出，行为不变）：复合键查
   * registry → rpcServer.notify 向 Worker 发 plugin.commands.invoke → Worker 执行
   * handler 后经 plugin.commands.invoke.result 回传结果/错误 → deliverInvokeResult
   * resolve/reject 对应 pending（超时取值链见 api/commands-executor.ts，D4：命令
   * 定义 timeoutMs 声明优先，默认 DEFAULT_TOOL_EXECUTE_TIMEOUT_MS 30min）。命令表按插件
   * 隔离（B 无法覆盖/注销 A 的同名命令）。
   */
  async executeCommand(pluginId: string, commandId: string, args?: Record<string, unknown>): Promise<unknown> {
    return executePluginCommand(
      {
        registry: this.registry,
        host: this.host,
        rpcServer: this.rpcServer,
        commandRegistry: this.commandRegistry,
        commandInvokes: this.commandInvokes,
      },
      pluginId,
      commandId,
      args,
    )
  }

  async getPluginConfig(pluginId: string, key?: string): Promise<unknown> {
    if (key === undefined || key === '__all__') {
      // Return all config（key 前缀约定委托 config-api，P7 收口）
      const allKeys = this.storage.keys(pluginId)
      const configKeys = allKeys.filter(isConfigKey)
      const result: Record<string, unknown> = {}
      for (const configKey of configKeys) {
        result[fromConfigKey(configKey)] = this.storage.get(pluginId, configKey)
      }
      return result
    }
    return this.storage.get(pluginId, toConfigKey(key))
  }

  async setPluginConfig(pluginId: string, key: string, value: unknown): Promise<void> {
    this.storage.set(pluginId, toConfigKey(key), value)
  }

  /**
   * 关停链实现迁至 plugin-shutdown.ts（max-lines 拆分，行为与顺序不变——
   * D6/W4 关停顺序的决策注释随代码迁移）。
   */
  async shutdown(): Promise<void> {
    if (!this.initialized) return
    this.initialized = false
    await shutdownPluginCollaborators({
      host: this.host,
      activator: this.activator,
      sessionDataStore: this.sessionDataStore,
      storage: this.storage,
      rpcServer: this.rpcServer,
      statusBarRegistry: this.statusBarRegistry,
      commandInvokes: this.commandInvokes,
      sessionEventDispatch: this.sessionEventDispatch,
    })
  }

  private registerRpcMethods(): void {
    registerAllRpcMethods({
      rpcServer: this.rpcServer,
      storage: this.storage,
      toolRegistry: this.toolRegistry,
      hookRegistry: this.hookPipeline.registry,
      statusBarItems: this.statusBarRegistry.items,
      deps: this.deps,
      broadcastStatusBarItems: () => this.statusBarRegistry.broadcastAll(),
      handleUiRequest: (method, params, pluginId) => this.uiRequestQueue.handleRequest(method, params, pluginId),
      cancelUiRequest: (requestId) => this.uiRequestQueue.cancelRequest(requestId),
      syncToolsToBridge: () => this.syncToolsToBridge(),
      getDescriptor: (pluginId) => this.registry.getDescriptor(pluginId),
      sessionDataStore: this.sessionDataStore,
      activeSessionResolver: this.activeSessionResolver,
      commandRegistry: this.commandRegistry,
      sessionEvents: this.sessionEventDispatch,
      deliverInvokeResult: (handlerId, payload, sourceWorkerId) =>
        deliverPluginInvokeResult(
          { commandRegistry: this.commandRegistry, commandInvokes: this.commandInvokes },
          handlerId,
          payload,
          sourceWorkerId,
        ),
      mountPoints: this.mountPoints,
      publishViewUpdate: (payload) => this.publishViewUpdate(payload),
    })
  }

  /**
   * 执行 hookType 的钩子管道。
   *
   * observe 类 hookType（OBSERVE_HOOK_TYPES，D2-2）走零往返快捷路径：notifyObservers
   * 经 rpcServer.notify 派发后立即返回（无 pending/超时定时器/响应等待）；block/transform
   * 类委托 HookPipeline.execute（排序/串行/5s 超时/block/transform）。
   */
  async executeHooks(hookType: string, context: HookContext): Promise<HookResult> {
    if (OBSERVE_HOOK_TYPES.has(hookType)) {
      this.hookPipeline.notifyObservers(hookType, context)
      return { blocked: false }
    }
    return this.hookPipeline.execute(hookType, context)
  }

  /** 同步 toolRegistry schema 到 bridge 轮询缓存（委托 bridge-interop） */
  async syncToolsToBridge(): Promise<void> {
    this.bridgeToolCache.syncFrom(this.toolRegistry)
  }

  /** 获取 bridge 轮询缓存的工具 schema（委托 bridge-interop） */
  getToolSchemas(): ToolRegistration[] {
    return this.bridgeToolCache.getSchemas()
  }

  /**
   * 构造 bridge:sync 同步负载（工具 schema 塑形下沉 bridge-interop，transport 只 reply）。
   */
  getBridgeSyncPayload(): BridgeSyncPayload {
    return this.bridgeToolCache.getSyncPayload()
  }

  /**
   * 处理 bridge 发起的工具执行请求（ADR-0012 契约不变）。委托 bridge-interop。
   * 传 bridgeToolCache 的 name 索引（微项 7：O(1) 路由；索引随 syncToolsToBridge 刷新）。
   */
  async handleBridgeToolExecute(request: BridgeToolExecuteRequest): Promise<BridgeToolExecuteResponse> {
    return handleBridgeToolExecute(request, this.toolRegistry, this.host, this.rpcServer, this.bridgeToolCache)
  }

  handleBridgeEvent(eventName: string, data: unknown, sessionId: string): void {
    handleBridgeEvent(eventName, data, sessionId, (hookType, context) => this.executeHooks(hookType, context))
  }

  /**
   * 处理 bridge 拦截请求。
   *
   * 按 PI_HOOK_EVENT_MAP 判定（D4）：无映射条目 → 空响应（ERR2）；kind=observe →
   * 转 handleBridgeEvent 观察链路（fire-and-forget，不 block）；kind=intercept →
   * 委托 bridge-interop 拦截链路（block/injectedMessages 生效）。判定下沉到 service，
   * transport 不再做事件名白名单过滤。
   */
  async handleBridgeIntercept(eventName: string, data: unknown, sessionId: string): Promise<BridgeInterceptResponse> {
    const mapping = PI_HOOK_EVENT_MAP[eventName]
    if (!mapping) {
      return { injectedMessages: [] }
    }
    if (mapping.kind === 'observe') {
      // 纯观察事件：走 fire-and-forget 观察链路，不阻塞
      this.handleBridgeEvent(eventName, data, sessionId)
      return { injectedMessages: [] }
    }
    return handleBridgeIntercept(eventName, data, sessionId, (hookType, context) => this.executeHooks(hookType, context))
  }

  async installPlugin(packageSpecifier: string): Promise<InstallResult> {
    // external 安装硬锁（§6.6 排期硬锁）：sandbox 真隔离闭环已落地、
    // EXTERNAL_PLUGIN_ENABLED=true 后放行安装；开关回退 false 时短路在 installer port
    // 之前（fail-closed）。builtin 不经此入口（TC4），无需 source 判定。
    if (!EXTERNAL_PLUGIN_ENABLED) {
      return { success: false, error: EXTERNAL_PLUGIN_DISABLED_MESSAGE }
    }
    const installer = this.deps.pluginInstaller
    if (!installer) {
      return { success: false, error: 'Plugin installer not configured (pluginInstaller deps missing)' }
    }
    const result = await installer.install(packageSpecifier)
    if (result.success && result.pluginId) {
      // Re-scan registry to pick up the new plugin
      await this.registry.reload()
      // Re-register descriptors with activator
      const descriptors = this.registry.getAllDescriptors()
      this.activator.registerDescriptors(descriptors)
      this.broadcastPluginList()
    }
    return result
  }

  /** 将所有 dirty sessionData 批量 flush（由定时器调用） */
  async flushSessionData(): Promise<void> {
    this.sessionDataStore.flushAll()
  }

  /** flush 指定 session 的 dirty 数据（deactivate/关闭时调用） */
  async flushSessionDataForSession(sessionId: string): Promise<void> {
    this.sessionDataStore.flushSession(sessionId)
  }

  /**
   * 清理指定 session 的数据缓存、dirty 跟踪和 size 记录（B5 接入删除链后为 async：
   * 磁盘删除走 trash 软删除，与 session 本体持久性对齐）。trash 失败向上传播
   * （调用方 void…catch(warn) best-effort 消费）；主要消费路径 = SessionService
   * .removeSessionEntry 尾段经 clearRemovedSessionData 分发（见 session-data-store.ts）。
   */
  async clearSessionData(sessionId: string): Promise<void> {
    await this.sessionDataStore.clearSession(sessionId)
  }

  /** 处理前端返回的 UI 响应（供 server.ts 调用）。委托 UiRequestQueue。 */
  handleUiResponse(requestId: string, result: unknown): void {
    this.uiRequestQueue.handleResponse(requestId, result)
  }

  private broadcastPluginList(): void {
    const plugins = this.getDiscoveredPlugins()
    this.broker.broadcast({
      type: 'config.plugins',
      id: `plugins_${Date.now()}`,
      payload: { plugins },
    })
  }

  /** Get all current status bar items */
  getStatusBarItems(): StatusBarItem[] {
    return this.statusBarRegistry.getItems()
  }
}
