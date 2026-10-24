import { PluginPermissionChecker as PermissionChecker } from './plugin-permission.js'
import type { PluginDescriptor, ToolEntry, HookEntry, HookContext, HookResult, IPluginServiceDeps } from './plugin-types.js'
import type { PluginInfo, PluginUiSnapshotPayload, PluginListAvailableReply, PluginCatalogReply } from '@taiji/shared'
import type { IPluginService, ISessionService } from '../../interfaces.js'
import type { IMessageBroker } from '../../interfaces.js'
import type { ServerMessageMap, ServerMessageType } from '@taiji/shared'
import { PluginRegistry } from './plugin-registry.js'
import { PluginStorage } from './plugin-storage.js'
import { SessionDataStore } from './session-data-store.js'
import { PluginRpcServer } from './plugin-rpc-server.js'
import { PluginHost } from './plugin-host.js'
import { PluginActivator } from './plugin-activator.js'
import { registerAllRpcMethods } from './plugin-rpc-setup.js'
import { PluginCatalogService, installedVersionsFromDescriptors } from './plugin-catalog.js'
import { bootstrapPluginService } from './plugin-lifecycle.js'
import { ActiveSessionResolver, SessionEventDispatch, sessionInfoFromSummary } from './api/session-api.js'
import type { CommandRegistration } from './api/commands-api.js'
import { EntryInvalidationDispatch, ENTRY_INVALIDATION_NOTIFY_METHOD } from './plugin-entry-invalidation-dispatch.js'
import { PluginUiSnapshotStore } from './plugin-ui-snapshot-store.js'
import type { UiSnapshotFilter } from './plugin-ui-snapshot-store.js'
import { executeCommand as executePluginCommand, invokeMethod as invokePluginMethod, deliverInvokeResult as deliverPluginInvokeResult } from './api/commands-executor.js'
import type { CommandExecutorDeps } from './api/commands-executor.js'
import type { InstallResult, PreparedPluginInstall } from '../ports/plugin-installer.js'
import { InstalledStore } from './installed-store.js'
import { NAMESPACE_MISMATCH, validateNamespaceBinding } from '@taiji/shared/plugin-namespace'
import { errorWithCode } from '../../utils/errors.js'
import { toConfigKey, fromConfigKey, isConfigKey } from './api/config-api.js'
import { HookPipeline, OBSERVE_HOOK_TYPES } from './hook-pipeline.js'
import { UiRequestQueue } from './ui-request-queue.js'
import { PermissionStorage } from './plugin-permission-storage.js'
import { EXTERNAL_PLUGIN_ENABLED, EXTERNAL_PLUGIN_DISABLED, EXTERNAL_PLUGIN_DISABLED_MESSAGE } from './plugin-security.js'
import { resolveEsmLoaderExecArgv } from './plugin-esm-execargv.js'
import { toPluginInfos } from './plugin-info-mapper.js'
import { removePluginHookEntries, removePluginToolEntries, removePluginCommandEntries } from './plugin-contributions.js'
import { broadcastOrBrokerWith, publishViewUpdateTo, createUiRequestBroadcastFn } from './plugin-broadcast.js'
import type { PluginBroadcastDeps, ViewUpdateBroadcastPayload } from './plugin-broadcast.js'
import { shutdownPluginCollaborators } from './plugin-shutdown.js'
import { join, dirname, sep } from 'node:path'
import { readFile } from 'node:fs/promises'
import { createPluginEventIdGenerator, deliverUiEventToPlugin, openUrlInSystemBrowser } from './plugin-host-actions.js'
import { toErrorMessage } from '../../utils/errors.js'
import { pluginToggleFailedError, pluginUninstallPartialError, removePluginDiskFiles } from './api/lifecycle-errors.js'
import { readEnvPermissionTimeoutMs } from './plugin-env-timeout.js'
import { PendingTracker } from '../../utils/async/pending-tracker.js'
// type-only：IMessageBus 不反向依赖 plugin-service，无运行时环（与 message-dispatcher 同款约束）
// wave:perf-w09（接口收敛）：依赖 publish 抽象而非 MessageBus 具体类
import type { IMessageBus } from '../message-bus/message-bus.js'

// （BC）findTsxImportArg / resolveEsmLoaderExecArgv 原从本文件导出（实现迁至
// plugin-esm-execargv.ts，max-lines 拆分），re-export 保持既有导入路径稳定
export { findTsxImportArg, resolveEsmLoaderExecArgv } from './plugin-esm-execargv.js'

/** preparePluginInstall 失败错误码（非命名空间类准备失败的统一 code；命名空间类用 NAMESPACE_MISMATCH） */
export const PLUGIN_PREPARE_FAILED = 'PLUGIN_PREPARE_FAILED'

/**
 * 两段式安装第一段（prepare）的回包：确认卡知情面（S27）。
 * manifest 声明的 capabilities/readPaths/permissions 全量透传（展示物 = 暂存解压物
 * 内 manifest，同源）；未声明 namespace 时为 undefined（非 provider 插件常态）。
 */
export interface PluginInstallPreview {
  /** 安全化目录名（@scope/pkg → scope__pkg），= 安装后 registry pluginId 与 installed.json key */
  pluginId: string
  packageName: string
  version: string
  capabilities: string[]
  readPaths: string[]
  permissions: string[]
  namespace?: string
}

/**
 * PluginService — 纯门面 + 初始化编排（ADR-0012/0013/0014/0023/0001）。
 *
 * 5 个原交职责已下沉到内聚模块，本类仅保留：
 *  (a) initialize 编排（9 步生命周期装配）；
 *  (b) 协作者装配（registry/storage/rpcServer/host/activator/...）；
 *  (c) 薄门面方法：委托 HookPipeline / UiRequestQueue
 *      （命令执行发送段在 api/commands-executor.ts，协议映射在
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

  /** UI 请求串行队列（独立状态机，广播交由注入回调） */
  readonly uiRequestQueue: UiRequestQueue

  /** SessionData 内存缓存 + flush + 持久化编排 */
  private readonly sessionDataStore: SessionDataStore

  /** 注入的外部依赖 */
  private deps: IPluginServiceDeps

  /**
   * providerEntries port 是否已接线（组合根装配自检消费）：port 缺省时卸载编排静默
   * 跳过 models.json 条目清理（cleanupProviderEntriesFor 的 warn 降级分支），孤儿的
   * apiKey 条目残留只有在生产装配路径才可能发生——测试轨显式注入 port 不会暴露漏接，
   * 组合根构造后经本探测 fail-fast（provider-plugin-access U7/S14）。
   */
  get hasProviderEntries(): boolean {
    return this.deps.providerEntries !== undefined
  }

  /**
   * piExtensionInstaller port 是否已接线（组合根装配自检消费，与 hasProviderEntries
   * 同构）：port 缺省时双产物条目只装插件侧（installPiExtensionMember 的 warn 降级
   * 分支），pi 扩展成员缺失只有在生产装配路径才可见——对话时报「模型不存在」而非
   * 安装时失败。组合根构造后经本探测 fail-fast（provider-plugin-access U7/S23）。
   */
  get hasPiExtensionInstaller(): boolean {
    return this.deps.piExtensionInstaller !== undefined
  }

  /** taiji 配置根（~/.taiji/），plugin/session-data 持久化根。组合根注入。 */
  private readonly configDir: string

  /**
   * 安装登记（<pluginsDir>/installed.json，U4）：只记 installedAt，版本与命名空间
   * 不落盘（D11——版本唯一事实 = 包内 package.json，命名空间 = 包名纯函数推导）。
   */
  private readonly installedStore: InstalledStore

  /**
   * 安装/卸载串行锁（U4）：promise 链互斥，同一时刻仅一个安装或卸载编排执行。
   * 锁语义（ADR-0122 保留白名单）——前序失败不断链（吞 reject 保队列活性）。
   */
  private installQueue: Promise<unknown> = Promise.resolve()

  /** prepare 完成、等待确认停点的安装（pluginId → prepare 产物），confirm/cancel 消费 */
  private readonly pendingPrepares = new Map<string, { prepared: PreparedPluginInstall; preview: PluginInstallPreview }>()

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

  /** Entry 失效信号订阅注册表（AP-4，U2）：(sessionId, customType) 分桶，notifyEntryInvalidation 派发 */
  private readonly entryInvalidationDispatch: EntryInvalidationDispatch

  /** 挂载点集合（renderer 经 plugin.mountPoints.sync 上报，views.listMountPoints 中继查询，AC10） */
  private mountPoints: string[] = []

  /**
   * 插件 UI 快照存储（ADR-0097 拉为主）：两条 transient 推送链（headerAction 出线 /
   * views.update）的校验出口处写入最新值，plugin.ui.snapshot 拉取 RPC 读出——renderer
   * 重载/重连后由此收敛。清理随会话销毁与插件生命周期链（crash/disable/uninstall/enable）。
   */
  readonly uiSnapshotStore = new PluginUiSnapshotStore()

  /**
   * 插件清单 service（provider-plugin-access U5/F3）：RPC 通路（plugin.listAvailable /
   * plugin.catalog）的 runtime 侧装配——清单加载与本地安装状态比对的编排入口在本类
   * 构造时自建（registry 端口注入，installedVersions 比对基准 = descriptor.version，
   * D11 版本唯一事实）。
   */
  private readonly catalogService = new PluginCatalogService({
    getInstalledVersions: async () => installedVersionsFromDescriptors(this.registry.getAllDescriptors()),
  })

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
    // configDir 注入：plugin 切片经此拿配置根（~/.taiji/），不再直连 infra（design.md
    // T5 切片自治）。生产由 index.ts 注入；缺省回退 process.cwd() 仅供单测。
    const configDir = this.deps.configDir ?? process.cwd()
    this.configDir = configDir
    const pluginsDir = join(configDir, 'plugins')
    this.installedStore = new InstalledStore(pluginsDir)
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

    // Entry 失效信号订阅注册表（AP-4，U2）。存在性谓词取 listPersistedSessions（侧边栏
    // 会话列表同一权威源）——getSummary 只查内存 lifecycle 表，会误拒「存在但未加载」的
    // 历史会话。deps.sessionService 后置绑定，谓词调用时求值（activeSessionResolver 同模式）。
    this.entryInvalidationDispatch = new EntryInvalidationDispatch({
      sessionExists: (sessionId) =>
        this.deps.sessionService?.listPersistedSessions().flatMap(g => g.sessions).some(s => s.id === sessionId) ?? false,
    })

    // Hook 管道：持有共享 hookRegistry（rpc-setup 注册侧与本类消费侧同一实例），
    // 复用 host / rpcServer 引用。
    this.hookPipeline = new HookPipeline({
      hookRegistry: new Map<string, HookEntry[]>(),
      host: this.host,
      rpcServer: this.rpcServer,
    })

    // UI 请求队列：广播回调装配迁 plugin-broadcast.ts（u5a max-lines 回落拆分，行为保持——
    // MF-2 活跃 sessionId 注入 / 撤窗直发 global / bus 定向与回退双路径的决策注释随迁彼处）。
    // 动态状态经闭包注入（调用时求值）：activeSessionResolver / messageBus（晚期注入）/
    // broadcastOrBroker（动态读 broadcastFn 与 broker）。
    this.uiRequestQueue = new UiRequestQueue(createUiRequestBroadcastFn({
      resolveActiveSessionId: () => this.activeSessionResolver.resolve()?.id,
      getMessageBus: () => this.messageBus,
      broadcastOrBroker: (type, id, payload) => this.broadcastOrBroker(type, id, payload),
    }))

    this.activator = new PluginActivator({
      permissionChecker: this.permissionChecker,
      onPermissionRequest: (payload) =>
        this.broadcastOrBroker('plugin:permissionRequest', `perm_${payload.pluginId}`, payload),
      // 审批等待到期取消（timeout-plugin-service D3）：广播供前端撤回无人应答的
      // 审批弹窗（迟到批准对已删 pending noop 幂等；旧版前端未消费此帧无异常，P-11）。
      onPermissionRequestExpired: (payload) =>
        this.broadcastOrBroker('plugin:permissionRequestExpired', `permExpired_${payload.pluginId}`, payload),
      // 审批终局（remote-use-mobile S5-V3）：任一端批准/拒绝后广播，其余连接端按
      // requestId 撤回同一审批的弹窗（activator 保证同一 requestId 至多广播一次）。
      onPermissionRequestResolved: (payload) =>
        this.broadcastOrBroker('plugin:permissionRequestResolved', `permResolved_${payload.pluginId}`, payload),
      // permissionTimeoutMs 转正（D3）：env 逃生门接线，undefined（缺失/非法已 warn）
      // 由 Activator 构造函数回落 PERMISSION_TIMEOUT_MS。
      permissionTimeoutMs: readEnvPermissionTimeoutMs(),
    })
  }

  /** 广播出口共享依赖快照（动态读 messageBus 晚期注入 / deps.broadcastFn，调用时求值）。 */
  private get broadcastDeps(): PluginBroadcastDeps {
    return {
      broadcastFn: this.deps.broadcastFn,
      broker: this.broker,
      getMessageBus: () => this.messageBus,
    }
  }

  /** 广播优先走 broadcastFn，否则回退 broker.broadcast（实现迁 plugin-broadcast.ts，行为保持）。
   *  type/payload 经 ServerMessageMap 泛型关联（MF-2-4：构造点契约校验，免 as 断言）。 */
  private broadcastOrBroker<T extends ServerMessageType>(type: T, id: string, payload: ServerMessageMap[T]): void {
    broadcastOrBrokerWith(this.broadcastDeps, type, id, payload)
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

  /** 读插件 UI 快照（plugin.ui.snapshot handler 消费；filter 语义见 PluginUiSnapshotStore.snapshot） */
  getUiSnapshot(filter?: UiSnapshotFilter): PluginUiSnapshotPayload {
    return this.uiSnapshotStore.snapshot(filter)
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
   * handleViewUpdate 构造 payload 后经此发布）。实现迁 plugin-broadcast.ts
   * （u5a max-lines 回落拆分，行为保持）：bus 已装配 → publish 定向（transient 类），
   * 未装配（测试构造）→ 回退全局广播。
   */
  publishViewUpdate(payload: ViewUpdateBroadcastPayload): void {
    publishViewUpdateTo(this.broadcastDeps, payload, () => this.nextViewUpdateId())
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

    // 9 步顺序启动装配委托 plugin-lifecycle（god-orchestrator 收尾）。
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

    // 启动清扫（U4，恢复类，无定时器）：上次进程死在安装提交/取消周期中的暂存与
    // 替换位残留，按「正常暂存删、替换位恢复优先」收敛（实现归 installer port——
    // .staging 目录布局知识在 infra adapter，service 只编排）。
    try {
      await this.deps.pluginInstaller?.sweepStaging()
    } catch (err: unknown) {
      // 降级策略：清扫是恢复类收尾（残留下次启动幂等重扫），失败不阻断插件服务启动
      console.warn('[plugin-service] staging sweep on boot failed:', toErrorMessage(err))
    }

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
      // D6/W4 贡献清理：崩溃插件的 hook/tool/command 贡献不残留——对齐
      // togglePlugin(false) 的清理集（仍可被路由的 tool/command
      // 都指向已死 Worker，调用必超时）。重新启用由用户在管理界面显式触发（ADR-0122：
      // 原自动 rebuild 重激活链已退役）。
      for (const pluginId of pluginIds) {
        this.removeHookEntriesFor(pluginId)
        this.removeToolEntriesFor(pluginId)
        this.removeCommandEntriesFor(pluginId)
        this.sessionEventDispatch.clearForPlugin(pluginId)
        this.entryInvalidationDispatch.clearForPlugin(pluginId)
        // UI 快照同清理（对齐 toggle/uninstall 的贡献清理集）：崩溃插件的
        // headerAction/视图快照不再出现在拉取回包（renderer 侧另有 clearForPlugin 帧链）
        this.uiSnapshotStore.clearForPlugin(pluginId)
      }
      for (const pluginId of pluginIds) {
        this.broker.broadcast({
          type: 'plugin:crashed',
          id: `crash_${pluginId}_${Date.now()}`,
          payload: { pluginId, workerId, error },
        })
      }
    })
    this.host.setReplyCallback((msg) => {
      this.activator.handleWorkerReply(msg as import('./plugin-types.js').WorkerToHostMessage)
    })
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
        // AP-4（U2）：设计 §3.4 钦定与 didDestroy 同址（回调体内链式追加）；sessionId 维度
        // 清理 owner，缺此路则长会话反复建删时订阅条目单调累积。setOnSessionDestroyed
        // 为追加式回调列表（D6a），不挤占既有投递。
        this.entryInvalidationDispatch.clearForSession(summary.id)
        // 插件 UI 快照同址清理（ADR-0097）：会话销毁后快照条目即失效（插件侧镜像也随
        // onDidDestroySession 拆除），残留会以幽灵按钮/陈旧树出现在下次快照拉取
        this.uiSnapshotStore.clearForSession(summary.id)
      })
      // AP-4 会话激活 relay ③（u5a）：session.switch 成功（含自动 restore）→ transport 层
      // notifySessionActivated（relay ①②）流经本回调 → 激活订阅注册表定向投递 didActivate
      // （sessionInfoFromSummary 转换照 didCreate 先例）。onSessionActivated 为追加式回调
      // 列表（禁 setOnSessionCreated 式单槽），与既有 didCreate/didDestroy 接线互不挤占；
      // u5b 落地 registerActivate 前 SessionEventDispatch.activateHandlers 恒空，投递 no-op。
      this.deps.sessionService.onSessionActivated(summary => {
        this.sessionEventDispatch.didActivate(sessionInfoFromSummary(summary))
      })
    }
  }

  /**
   * Entry 失效信号派发（AP-4，U2）：组合根 onRecordEntriesInvalidated 两路注入的 plugin 路径
   * （session 路径 = invalidateRecordEntries，record 三族早退门保留）。按 (sessionId,
   * customType) 双匹配命中订阅注册表，命中者经 rpcServer.notify 定向投递（server→Worker
   * notify 非 WS 帧，与 didCreate/didDestroy 同族；Worker 已死时静默 no-op 既有口径）；
   * 无订阅者零开销（零 notify）。
   */
  notifyEntryInvalidation(sessionId: string, customType: string): void {
    for (const { workerId, handlerId } of this.entryInvalidationDispatch.dispatch(sessionId, customType)) {
      this.rpcServer.notify(workerId, ENTRY_INVALIDATION_NOTIFY_METHOD, { handlerId, sessionId, customType })
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
        // 启用前清掉该插件的旧 UI 快照（禁用期间残留的 headerAction/视图条目若在插件
        // 重新激活、重推前被拉取，会以陈旧态呈现；激活后插件重推即收敛）
        this.uiSnapshotStore.clearForPlugin(pluginId)
        // 启用：只激活目标插件（非全部）
        await this.activator.activatePlugin(pluginId, { type: 'onStartupFinished' }, this.host)
        // 激活成功后，对外部插件启动热重载监听
        this.watchExternalIfActive(descriptor)
        // E2 修复：enable 路径补 plugin:statusChange 广播（此前全仓唯一 producer 在 external
        // 热重载回调，toggle 路径无广播 → renderer E2 触发链无触发源，重启用不恢复顶栏按钮）。
        // newStatus 按激活终态派生（对齐 hot-reload producer 的 getState 判定；激活未达
        // ACTIVE 不产虚假 active 帧致 renderer 重放声明）。payload 键集逐字对齐
        // StatusChangeCallback 契约（pluginId/oldStatus/newStatus），信封与 crashed 路径同款
        //（broker.broadcast 三键 type/id/payload，id 前缀按源命名：crash_/watch_/toggle_）。
        if (this.activator.getState(pluginId) === 'ACTIVE') {
          this.broker.broadcast({
            type: 'plugin:statusChange',
            id: `toggle_${pluginId}_${Date.now()}`,
            payload: { pluginId, oldStatus: 'inactive', newStatus: 'active' },
          })
        }
      } else {
        // 禁用
        await this.activator.deactivatePlugin(pluginId, this.host)
        this.activator.stopWatching(pluginId) // 停止热重载监听
        this.removeHookEntriesFor(pluginId) // P-1：清 hook 注册，禁用插件的 hook 不再执行
        // Fix-7：禁用插件的工具/命令同步清注册——与 P-1 的 hook 清理对称，否则禁用插件的
        // 工具仍可被执行路由、命令 invoke 仍发向该插件（worker 已 deactivate，必超时）
        this.removeToolEntriesFor(pluginId)
        this.removeCommandEntriesFor(pluginId)
        // S3-W2：session 事件注册表同步清理（禁用插件的 didCreate/didDestroy 订阅不再投递）
        this.sessionEventDispatch.clearForPlugin(pluginId)
        this.entryInvalidationDispatch.clearForPlugin(pluginId)
        // UI 快照同步清理（禁用插件的 headerAction/视图条目不再出现在拉取回包）
        this.uiSnapshotStore.clearForPlugin(pluginId)
        // E2 修复：disable 路径补 plugin:statusChange 广播——renderer E2 触发链
        //（plugin-status-change{inactive} → handlePluginGone：三容器清理 + 命令注销 +
        // 顶栏按钮/modal 收起）此前无触发源，禁用后按钮残留。deactivatePlugin 抛错走
        // catch 不广播（虚假 inactive 帧会清掉仍在运行的插件的 renderer 镜像）；
        // 正常返回（含对未装载插件重入禁用）终态必为 UNLOADED，'inactive' 恒为真。
        // payload/信封与 enable 路径及 hot-reload producer 同形状。
        this.broker.broadcast({
          type: 'plugin:statusChange',
          id: `toggle_${pluginId}_${Date.now()}`,
          payload: { pluginId, oldStatus: 'active', newStatus: 'inactive' },
        })
      }
     
    } catch (err: unknown) {
      // RT-6#6：旧状「只 log 仍回 config.plugins 成功形状」——用户开关回弹、全程无错误/指引
      // （假成功观感，B 类吞噬）。现在先广播最新列表（保留原「允许前端回滚 UI」的意图），
      // 再抛带 code 的领域错误；transport server.ts 全局 catch 透传 .code 成 error 信封
      // （L4 增强，与 ExtensionInstallError 透传范式同通路），前端拿到可行动的失败反馈。
      console.error(`[plugin-service] togglePlugin(${pluginId}, ${enabled}) failed:`, toErrorMessage(err))
      this.broadcastPluginList()
      throw pluginToggleFailedError(pluginId, enabled, err)
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
    // 安装/卸载串行锁（U4）：与安装编排互斥，避免半卸载态撞上半安装态
    return this.withInstallLock(async () => {
      // descriptor 先取（removeDescriptor 之前）：pluginPath 供磁盘删除、source 供
      // builtin 判定
      const descriptor = this.registry.getDescriptor(pluginId)
      // RT-6#6：磁盘删除失败的事故记录——盘上残留意味着重启后 scan 会把插件扫回来
      // （用户视角 = 卸载无效/复活）。内存清理仍必须完成（Fix-5），但失败要在收尾时抛出。
      let onDiskRemovalError: string | undefined

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

      // U4 卸载清理编排：manifest 声明 namespace 的插件（provider 插件），按命名空间
      // 前缀扫描 models.json 派生待清理条目集 → 逐条 providers.delete。放在磁盘删除
      // 之前——namespace 事实源 = 插件目录内 package.json，删盘后无从推导。
      await this.cleanupProviderEntriesFor(descriptor)

      // U4 双产物卸载编排（provider-plugin-access D6/S23：完整移除 = 条目 + 插件 +
      // pi 扩展）：plugin-wool-<family> 形态包名的插件连带卸载 pi 扩展成员
      // （pi-wool-<family>）。同样放在磁盘删除之前——包名事实源 = 插件目录内
      // package.json。失败降级 warn 不阻断插件侧清理（镜像上方 deactivate 失败继续
      // 清理的卸载语义），残留可到扩展管理页手动移除。
      await this.uninstallPiExtensionMemberFor(descriptor)

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
          // RT-6#6：best-effort 删除——失败不阻断内存清理（Fix-5），但把原因交还调用方，
          // 由下方收尾抛出（「卸载重启后复活」不得静默假成功）。
          // 删除靶 = 插件目录（descriptor.pluginPath 是入口文件形态，按文件删会留下
          // 含 package.json 的目录残壳，重启后被 scan 扫回复活）；目录按 main 相对
          // 路径后缀截取（main 可带子目录段，如 dist/index.js——dirname 只剥一层会错删）
          onDiskRemovalError = await removePluginDiskFiles(installer, pluginId, this.pluginDirOf(descriptor))
        } else {
          console.warn(`[plugin-service] no pluginInstaller configured; on-disk removal skipped for ${pluginId}`)
        }
      }

      // U4：安装登记同步清理（installed.json 条目随卸载移除）。降级策略：登记缺失
      // 无碍安装判定（目录 + package.json 才是事实源），失败 warn 留痕不阻断卸载
      await this.installedStore.recordUninstalled(pluginId).catch((err: unknown) => {
        console.warn(`[plugin-service] failed to remove installed.json entry for ${pluginId}:`, toErrorMessage(err))
      })

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
      this.entryInvalidationDispatch.clearForPlugin(pluginId)
      this.uiSnapshotStore.clearForPlugin(pluginId)

      this.broadcastPluginList()
      // RT-6#6：内存清理与回滚广播已全部完成，此刻才把磁盘删除失败抛给调用方——
      // 「只 log 不回错」会让卸载在重启后静默复活。code 供 transport 全局 catch 透传。
      if (onDiskRemovalError !== undefined) throw pluginUninstallPartialError(pluginId, onDiskRemovalError)
      return this.getDiscoveredPlugins()
    })
  }

  /**
   * 插件目录推导：descriptor.pluginPath = 入口文件绝对路径（= resolve(插件目录, main)），
   * 按 main 相对路径后缀截取还原目录（main 带子目录段时 dirname 只剥一层不够）；
   * 后缀不匹配（异常 descriptor）回退 dirname。uninstall 删盘与卸载期 manifest
   * 读取共用此推导。
   */
  private pluginDirOf(descriptor: PluginDescriptor): string {
    const { pluginPath, main } = descriptor
    if (main.length > 0 && pluginPath.endsWith(main)) {
      const dir = pluginPath.slice(0, pluginPath.length - main.length)
      return dir.endsWith(sep) ? dir.slice(0, -sep.length) : dir
    }
    return dirname(pluginPath)
  }

  /**
   * U4 卸载清理编排：按命名空间前缀扫描派生待清理 provider 条目集 → 逐条 delete。
   *
   * 事实源链：插件目录内 package.json 的 taijiPlugin.namespace 声明 = 包名推导值
   * （安装期绑定校验保证一致，此处复跑校验防手工放置的坏包按错误声明误删）→
   * 命名空间前缀规则（providerId === ns || providerId.startsWith(ns + '-')，与
   * providers.write 的写入校验同规则）扫 models.json 全部条目派生清理集。可派生
   * 状态不落第二份（ADR-0122）——无「pluginId → providerId 集合」持久化登记。
   *
   * 逐条 best-effort：单条删除失败 warn 留痕继续（镜像 deactivate 失败继续清理的
   * 既有卸载语义——条目残留可在重装/重卸时收敛，插件目录拆除不等它）。deps 未接
   * providerEntries port 时整段跳过（warn 一次）。
   */
  private async cleanupProviderEntriesFor(descriptor: PluginDescriptor | undefined): Promise<void> {
    if (!descriptor) return
    const store = this.deps.providerEntries
    if (!store) {
      console.warn(`[plugin-service] no providerEntries configured; provider cleanup skipped for ${descriptor.pluginId}`)
      return
    }
    const ns = await this.readManifestNamespace(descriptor)
    if (!ns) return
    const allIds = await store.listIds()
    const targets = allIds.filter(id => id === ns || id.startsWith(ns + '-'))
    for (const providerId of targets) {
      try {
        await store.delete(providerId)
      } catch (err: unknown) {
        // best-effort 降级：单条清理失败 warn 留痕继续，条目残留可在重装/重卸时收敛（插件目录拆除不等它）
        console.warn(`[plugin-service] provider entry cleanup failed for '${providerId}' (ns=${ns}):`, toErrorMessage(err))
      }
    }
  }

  /**
   * 从插件目录 package.json 读命名空间（卸载期唯一可用事实源——ns 不落盘，D11）。
   * manifest 未声明 namespace（非 provider 插件）、声明与包名推导不一致（手工放置
   * 的坏包，不按错误声明清理）、目录/文件不可读（返回 undefined + warn）时返回
   * undefined，调用方跳过清理。
   */
  private async readManifestNamespace(descriptor: PluginDescriptor): Promise<string | undefined> {
    const pluginDir = this.pluginDirOf(descriptor)
    let raw: string
    try {
      raw = await readFile(join(pluginDir, 'package.json'), 'utf-8')
    } catch {
      console.warn(`[plugin-service] cannot read package.json for ${descriptor.pluginId}; provider cleanup skipped`)
      return undefined
    }
    let pkg: { name?: unknown; taijiPlugin?: { namespace?: unknown } }
    try {
      pkg = JSON.parse(raw) as { name?: unknown; taijiPlugin?: { namespace?: unknown } }
    } catch {
      console.warn(`[plugin-service] cannot parse package.json for ${descriptor.pluginId}; provider cleanup skipped`)
      return undefined
    }
    const declared = pkg.taijiPlugin?.namespace
    if (typeof declared !== 'string' || declared.trim().length === 0) return undefined
    if (typeof pkg.name !== 'string') return undefined
    const binding = validateNamespaceBinding(pkg.name, declared)
    if (!binding.ok) {
      console.warn(
        `[plugin-service] namespace binding mismatch for ${descriptor.pluginId} ` +
          `(declared "${declared}", derived "${binding.derived}"); provider cleanup skipped`,
      )
      return undefined
    }
    return binding.namespace
  }

  /**
   * U4 双产物卸载编排的扩展侧接线：读插件目录 package.json 取包名 → piExtensionInstaller
   * 端口卸载（家族推导在端口实现内，plugin-service 不持 wool 域知识——与 installForCatalogEntry
   * 同构的卸载侧）。三类跳过/降级：端口未接线（测试与联调环境常态，warn 留痕）、
   * 包名读不出（目录/文件不可读或包名缺失，warn 留痕——磁盘异常态，扩展残留可在
   * 扩展管理页手动移除）、端口卸载失败（warn 留痕不阻断——镜像 deactivate 失败继续
   * 清理的卸载语义，插件目录拆除不等扩展侧）。非羊毛插件经端口 no-op（家族推导
   * miss = 无扩展成员可卸），无感知。
   */
  private async uninstallPiExtensionMemberFor(descriptor: PluginDescriptor | undefined): Promise<void> {
    if (!descriptor) return
    const installer = this.deps.piExtensionInstaller
    if (!installer) {
      console.warn(`[plugin-service] no piExtensionInstaller configured; pi extension member uninstall skipped for ${descriptor.pluginId}`)
      return
    }
    let packageName: string | undefined
    try {
      const raw = await readFile(join(this.pluginDirOf(descriptor), 'package.json'), 'utf-8')
      const pkg = JSON.parse(raw) as { name?: unknown }
      if (typeof pkg.name === 'string' && pkg.name.length > 0) packageName = pkg.name
    } catch {
      console.warn(`[plugin-service] cannot read package.json for ${descriptor.pluginId}; pi extension member uninstall skipped`)
      return
    }
    if (packageName === undefined) return
    try {
      await installer.uninstallForCatalogEntry(packageName)
    } catch (err: unknown) {
      // best-effort 降级：端口卸载失败 warn 留痕不阻断（插件目录拆除不等扩展侧，残留可在扩展管理页手动移除）
      console.warn(`[plugin-service] pi extension member uninstall failed for ${packageName}:`, toErrorMessage(err))
    }
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
   * togglePlugin(false) 与 uninstallPlugin 共用——禁用插件的工具从工具注册表移除后
   * 不再被任何执行路由命中（实现迁至 plugin-contributions.ts）。
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
    // 时 no-op（resolvePermissionApproval 内部检查）。
    this.activator.resolvePermissionApproval(pluginId, true)

    // activatePlugin 真幂等（in-flight 重入返回同一 promise）：
    // - 挂起中的激活刚被唤醒、仍在 ACTIVATING → 此处 await 与它同步完成（毫秒级）；
    // - 已 ACTIVE → no-op；
    // - UNLOADED（等待早已超时回落 / 从未激活）→ 权限已 grant，新起激活不再挂起。
    await this.activator.activatePlugin(pluginId, { type: 'onStartupFinished' }, this.host)
    this.watchExternalIfActive(descriptor)
    // approve 触发 activate（status 真实变化）→ 广播列表刷新（reply 是 pong ack；deny/revoke 不改 PluginInfo 字段，不广播）
    this.broadcastPluginList()
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
   * 拒绝插件本次权限申请（不回收已授权限）。对齐 WS 命令 plugin.denyPermissions。
   * 与 revokePermissions（撤销全部已授权限并持久化，基线协议范围保留）的语义分界：
   * deny 只 resolve 挂起中的审批等待（无 pending 幂等 no-op），已授权限与持久化不动。
   */
  async denyPermissions(pluginId: string): Promise<void> {
    if (!this.registry.getDescriptor(pluginId)) throw new Error(`Plugin not found: ${pluginId}`)
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
  /**
   * commands-executor 依赖装配（executeCommand / invokePlugin 共用同一执行链状态：
   * registry / worker 宿主 / RPC 通道 / 命令注册表 / pending 登记表）。
   */
  private commandExecutorDeps(): CommandExecutorDeps {
    return {
      registry: this.registry,
      host: this.host,
      rpcServer: this.rpcServer,
      commandRegistry: this.commandRegistry,
      commandInvokes: this.commandInvokes,
    }
  }

  async executeCommand(pluginId: string, commandId: string, args?: Record<string, unknown>): Promise<unknown> {
    return executePluginCommand(
      // RT-6#7：命令下发后广播 started（在途反馈，填上长命令 30min 兜底窗口的零反馈缺口）
      { ...this.commandExecutorDeps(), broadcast: this.broadcastOrBroker.bind(this) },
      pluginId,
      commandId,
      args,
    )
  }

  /**
   * 调用插件注册的业务方法（provider-plugin-access D9，plugin.invoke）：与
   * executeCommand 共用 commands-executor 执行链（invokeMethod，kind='method'——
   * 不广播 started，界面代码调用持有 pending promise 自行等待）。
   */
  async invokePlugin(pluginId: string, method: string, params?: Record<string, unknown>): Promise<unknown> {
    return invokePluginMethod(this.commandExecutorDeps(), pluginId, method, params)
  }

  /**
   * 投递输入组件值回传（provider-plugin-access D8，plugin.uiEvent）：查插件 Worker
   * 后经 PLUGIN_UI_EVENT_NOTIFY 单向通知下发（fire-and-forget）。实现与降级出声在
   * plugin-host-actions（facade 只留接口门面与依赖装配）。
   */
  async deliverPluginUiEvent(pluginId: string, viewId: string, componentId: string, event: string, value: unknown): Promise<void> {
    deliverUiEventToPlugin(
      {
        getDescriptor: (id) => this.registry.getDescriptor(id),
        getWorkerHandle: (id) => this.host.getWorkerHandle(id),
        notify: (workerId, method, params) => this.rpcServer.notify(workerId, method, params),
      },
      pluginId,
      viewId,
      componentId,
      event,
      value,
    )
  }

  /** 清单可安装视图（provider-plugin-access U5，plugin.listAvailable 的 runtime 侧）。 */
  async listAvailablePlugins(): Promise<PluginListAvailableReply> {
    const { reply } = await this.catalogService.listAvailable()
    return reply
  }

  /** 清单原始目录条目（provider-plugin-access U5，plugin.catalog 的 runtime 侧）。 */
  async getPluginCatalog(): Promise<PluginCatalogReply> {
    const { reply } = await this.catalogService.catalog()
    return reply
  }

  /** plugin:event 广播 id 单调计数（碰撞面见 createPluginEventIdGenerator） */
  private readonly nextPluginEventId = createPluginEventIdGenerator()

  async getPluginConfig(pluginId: string, key?: string): Promise<unknown> {
    if (key === undefined || key === '__all__') {
      // Return all config（key 前缀约定委托 config-api，P7 收尾）
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
      deps: this.deps,
      handleUiRequest: (method, params, pluginId) => this.uiRequestQueue.handleRequest(method, params, pluginId),
      cancelUiRequest: (requestId) => this.uiRequestQueue.cancelRequest(requestId),
      getDescriptor: (pluginId) => this.registry.getDescriptor(pluginId),
      sessionDataStore: this.sessionDataStore,
      activeSessionResolver: this.activeSessionResolver,
      commandRegistry: this.commandRegistry,
      sessionEvents: this.sessionEventDispatch,
      // [u5b] sessionRead 装配（u2d 移交）与 E10 判定的装配缝：失效订阅表与
      // notifyEntryInvalidation 派发共享同一实例；pending 表直读（pendingUiRequests
      // 是 UiRequestQueue 公开字段，无新增队列面）。
      entryInvalidation: this.entryInvalidationDispatch,
      deliverInvokeResult: (handlerId, payload, sourceWorkerId) =>
        deliverPluginInvokeResult(
          { commandRegistry: this.commandRegistry, commandInvokes: this.commandInvokes },
          handlerId,
          payload,
          sourceWorkerId,
        ),
      mountPoints: this.mountPoints,
      uiSnapshotStore: this.uiSnapshotStore,
      publishViewUpdate: (payload) => this.publishViewUpdate(payload),
      // provider-plugin-access D9：plugin.event 广播出线（id 单调计数）+ openUrl 系统浏览器出口
      broadcastPluginEvent: (payload) => this.broadcastOrBroker('plugin:event', this.nextPluginEventId(), payload),
      openExternal: openUrlInSystemBrowser,
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

  /**
   * pi 侧事件向插件钩子的投递入口（pi1-disposition-chat-flow D7② 挂点迁移 + 断链修复）：
   * 内部事件经本方法以泛型 'onPiEvent' 键派发——与 hook-api 注册点的
   * 泛型键形状对齐（hook-api 以 'onPiEvent' 为键写入 hookRegistry），修复原
   * handleBridgeEvent「分发键 = 原始事件名」的注册/分发键错位断链。
   *
   * context 形态与 event-interpreter 的既有调用完全同构：平铺 { event: <事件名>,
   * ...payload }（ExecuteHookFn 的 context 参数是宽松 Record）——hook-api onPiEvent
   * 适配层走「event-interpreter 平铺」分支：payload = 剥离 event 元字段后的剩余字段，
   * 插件侧 handler 收到的第二参即业务载荷本身（平铺形状，hook-api 解包）。
   *
   * fire-and-forget：observe 快捷路径（executeHooks → notifyObservers），不等待不回包。
   */
  notifyPiEvent(eventName: string, payload: Record<string, unknown>, _sessionId: string): void {
    // 平铺形态经 ExecuteHookFn（宽松 Record）注入时已是设计内输入；直调本类方法时对齐
    // event-interpreter 生产形态（HookContext 严格注解为历史形态，cast 与组合根注入同口径）。
    this.executeHooks('onPiEvent', { event: eventName, ...payload } as unknown as HookContext).catch((err: unknown) => {
      console.error('[plugin-service] notifyPiEvent error:', err)
    })
  }

  /**
   * 安装/卸载串行锁执行体（U4）：安装（直通/prepare/confirm/cancel）与卸载互斥，
   * 同一时刻仅一个执行。前序失败不断链——队列槽吞 reject 保后续编排活性。
   */
  private withInstallLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.installQueue.then(fn, fn)
    this.installQueue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  /**
   * 直通安装（旧通道，WS plugin.install 消费）：prepare → commit 段一次走完，无
   * 确认停点。两段式入口（确认停点对接 Provider 页确认卡，S27）走 preparePluginInstall
   * / confirmPluginInstall；两条通道共用同一提交与回滚编排（commitAndActivate）。
   */
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
    return this.withInstallLock(async () => {
      const prep = await installer.prepareInstall(packageSpecifier)
      if (!prep.success || !prep.prepared) {
        return { success: false, error: prep.error ?? 'Plugin prepare failed' }
      }
      return this.commitAndActivate(prep.prepared)
    })
  }

  /**
   * 两段式安装第一段（U4）：下载校验解压至暂存，返回确认卡知情面后停在确认停点。
   * 未确认不发生安装落盘（正式目录未触及）；失败抛带 code 领域错误（transport 全局
   * catch 透传 code——NAMESPACE_MISMATCH 对齐 S22 前端提示）。
   */
  async preparePluginInstall(packageSpecifier: string): Promise<PluginInstallPreview> {
    if (!EXTERNAL_PLUGIN_ENABLED) {
      throw errorWithCode(EXTERNAL_PLUGIN_DISABLED_MESSAGE, EXTERNAL_PLUGIN_DISABLED)
    }
    const installer = this.deps.pluginInstaller
    if (!installer) {
      throw errorWithCode('Plugin installer not configured (pluginInstaller deps missing)', PLUGIN_PREPARE_FAILED)
    }
    return this.withInstallLock(async () => {
      const prep = await installer.prepareInstall(packageSpecifier)
      if (!prep.success || !prep.prepared) {
        // 命名空间绑定失败（adapter 错误文案以 NAMESPACE_MISMATCH 起头）单独透传
        // code——S22 前端据此提示「命名空间与包名不匹配」，其余归准备失败
        const code = prep.error?.startsWith(NAMESPACE_MISMATCH) ? NAMESPACE_MISMATCH : PLUGIN_PREPARE_FAILED
        throw errorWithCode(prep.error ?? 'Plugin prepare failed', code)
      }
      const prepared = prep.prepared
      const preview: PluginInstallPreview = {
        pluginId: prepared.dirName,
        packageName: prepared.packageName,
        version: prepared.version,
        capabilities: prepared.capabilities,
        readPaths: prepared.readPaths,
        permissions: prepared.permissions,
        ...(prepared.namespace !== undefined ? { namespace: prepared.namespace } : {}),
      }
      // 同插件重复 prepare 覆盖登记（adapter 幂等清旧暂存后重下，登记取最新）
      this.pendingPrepares.set(preview.pluginId, { prepared, preview })
      return preview
    })
  }

  /**
   * 两段式安装第二段（确认停点之后）：暂存单步 rename 换入 → 扫描 → 激活 → 安装
   * 登记（installed.json）→ 广播 → pi 扩展成员安装（双产物条目，U7/D6）。激活失败
   * 自动回滚（S18：正式目录/暂存/installed.json/注册表/列表五处无残留；更新场景旧
   * 版本幸存）；扩展成员安装失败整体报失败（插件已落盘事实保留，重试安装幂等自愈）。
   */
  async confirmPluginInstall(pluginId: string): Promise<InstallResult> {
    return this.withInstallLock(async () => {
      const pending = this.pendingPrepares.get(pluginId)
      if (!pending) {
        return {
          success: false,
          error: `No prepared install found for '${pluginId}' — call preparePluginInstall first`,
        }
      }
      const result = await this.commitAndActivate(pending.prepared)
      if (!result.success) return result
      this.pendingPrepares.delete(pluginId)
      const extensionResult = await this.installPiExtensionMember(pending.preview)
      return extensionResult ?? result
    })
  }

  /**
   * pi 扩展成员安装（provider-plugin-access U7/D6 双产物安装编排的接线）：按清单条目
   * 判定双产物——条目携带 piExtensionVersion（guard 契约：仅双产物条目携带）→ 调端口
   * 安装，失败整体报失败（fail-fast：静默成功 = 对话链在很远的下游报「模型不存在」，
   * 排障成本远高于此刻失败）。三类跳过（不误伤单产物插件）：端口未配置（测试/联调，
   * warn 留痕）、清单不可得（fail-safe 链尾 config undefined——无法判定双产物 ≠ 必为
   * 双产物，跳过 + warn；清单恢复后重试安装自愈）、条目无 piExtensionVersion（单产物）。
   */
  private async installPiExtensionMember(preview: PluginInstallPreview): Promise<InstallResult | undefined> {
    const installer = this.deps.piExtensionInstaller
    if (!installer) {
      console.warn(`[plugin-service] no piExtensionInstaller configured; pi extension member skipped for ${preview.packageName}`)
      return undefined
    }
    const load = await this.catalogService.load()
    const entry = load.config?.plugins.find((p) => p.packageName === preview.packageName)
    if (!entry) {
      console.warn(`[plugin-service] catalog has no entry for ${preview.packageName}; pi extension member skipped`)
      return undefined
    }
    if (entry.piExtensionVersion === undefined) {
      return undefined
    }
    try {
      await installer.installForCatalogEntry({ packageName: entry.packageName, piExtensionVersion: entry.piExtensionVersion })
      return undefined
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      console.warn(`[plugin-service] pi extension member install failed for ${entry.packageName}:`, detail)
      return {
        success: false,
        error: `插件已安装，但配套 pi 扩展成员安装失败：${detail}。请重试安装（幂等覆盖；扩展侧恢复后即自愈）`,
      }
    }
  }

  /** 两段式安装取消：清暂存与 pending 登记（用户取消路径，S27「未确认不落盘」）。 */
  async cancelPluginInstall(pluginId: string): Promise<void> {
    await this.withInstallLock(async () => {
      const pending = this.pendingPrepares.get(pluginId)
      this.pendingPrepares.delete(pluginId)
      if (!pending) return
      await this.deps.pluginInstaller?.uninstall(pluginId, pending.prepared.stagingPath).catch((err: unknown) => {
        console.warn(`[plugin-service] failed to clean staging for cancelled install ${pluginId}:`, toErrorMessage(err))
      })
    })
  }

  /**
   * 提交段编排（直通与 confirm 共用）：commit 换入 → reload 注册表 → 激活 →
   * installed.json 登记 → 广播。激活失败回滚：删刚换入目录（更新场景旧版本由
   * rollbackInstall 恢复）+ 重扫注册表 + 移除 activator 侧残留描述符。
   *
   * 激活成败判定用 getState 终态（activatePlugin 吞错不抛——doActivatePlugin 全部
   * 失败路径 settleActivationFailure 后正常 resolve），非 ACTIVE 即失败。
   */
  private async commitAndActivate(prepared: PreparedPluginInstall): Promise<InstallResult> {
    const installer = this.deps.pluginInstaller
    if (!installer) {
      return { success: false, error: 'Plugin installer not configured (pluginInstaller deps missing)' }
    }
    const commit = await installer.commitInstall(prepared)
    if (!commit.success) return commit

    await this.registry.reload()
    this.activator.registerDescriptors(this.registry.getAllDescriptors())

    await this.activator.activatePlugin(prepared.dirName, { type: 'onStartupFinished' }, this.host)
    const state = this.activator.getState(prepared.dirName)
    const descriptor = this.registry.getDescriptor(prepared.dirName)
    if (state !== 'ACTIVE' || !descriptor) {
      console.warn(
        `[plugin-service] plugin ${prepared.dirName} installed but activation failed (state=${state ?? 'UNKNOWN'}, ` +
          `descriptor=${descriptor ? 'found' : 'missing'}) — rolling back`,
      )
      await installer.rollbackInstall(prepared)
      await this.registry.reload()
      this.activator.removeDescriptor(prepared.dirName)
      this.broadcastPluginList()
      return {
        success: false,
        error: `Plugin '${prepared.dirName}' installed but failed to activate (state=${state ?? 'UNKNOWN'}) — installation rolled back`,
      }
    }

    // 安装登记（best-effort）：目录与激活已成功 = 安装事实成立，登记只承载
    // installedAt 展示——写失败 warn 留痕不让安装整体报失败（报失败会与已落盘
    // 事实分裂；镜像卸载侧 recordUninstalled 的 catch 对称）
    await this.installedStore.recordInstalled(prepared.dirName).catch((err: unknown) => {
      console.warn(`[plugin-service] failed to write installed.json entry for ${prepared.dirName}:`, toErrorMessage(err))
    })
    // 激活成功收尾：清理更新场景遗留的旧版本替换位（best-effort，残留由启动清扫收敛）
    await installer.discardReplaced(prepared)
    this.broadcastPluginList()
    return { success: true, pluginId: prepared.dirName, path: commit.path }
  }

  /** 将所有 dirty sessionData 批量 flush（由定时器调用） */
  async flushSessionData(): Promise<void> {
    this.sessionDataStore.flushAll()
  }

  /** flush 指定 session 的 dirty 数据（deactivate/关闭时调用） */
  async flushSessionDataForSession(sessionId: string): Promise<void> {
    this.sessionDataStore.flushSession(sessionId)
  }

  // [B5 触发点收窄 2026-09-15] 原 clearSessionData facade 已删：全仓零调用点（真删除链
  // 经模块级 clearRemovedSessionData 分发，session-lifecycle.ts delete 直调；生存路径
  // exit/forceQuit/restore 清场不清插件数据）。IPluginService 同名条目同批删除。

  /** 处理前端返回的 UI 响应（供 server.ts 调用）。委托 UiRequestQueue。 */
  handleUiResponse(requestId: string, result: unknown): void {
    this.uiRequestQueue.handleResponse(requestId, result)
  }

  private broadcastPluginList(): void {
    this.broker.broadcast({
      type: 'config.plugins',
      id: `plugins_${Date.now()}`,
      payload: { plugins: this.getDiscoveredPlugins() },
    })
  }

}
