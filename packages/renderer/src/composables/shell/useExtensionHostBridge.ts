/**
 * useExtensionHostBridge —— ExtensionHost renderer 接线（audit §12.1，P5 wiring）。
 *
 * 职责：打通 plugin panels 渲染链路最后一公里——
 * - 把 renderer 的 WS 消息流（plugin:* 下行广播）适配成 PluginMessageSource
 *   （core/extension-host/plugin-message-source.ts 注释明确「壳把 transport 层适配成 source 注入」）
 * - 创建 InternalEventBus + MessageBusBridge（归一 plugin:* → bus 事件）
 * - 创建 ViewHostStore + StatusBarController（消费 bus，ui 组件数据源）
 * - 注入 MountPointRegistry/ContributionRegistry 到 core bootstrap（setExtensionRegistries；
 *   注册触发收敛为 bootstrap 第 4/5 步——App.vue onMounted 编排，本模块不再自行触发）
 * - app.provide ViewHost/StatusBar 的 inject key
 *
 * 消息流：WS 下行 → route-inbound（events 正规通道）→ 本适配器 →
 * MessageBusBridge → bus 'extension-widget' → ViewHostStore → <ViewHost> getView。
 * （ADR-0060：数据源从 raw-message-tap 旁路改为 events 双订阅——onGlobal 收无 sid 的 plugin:*，
 * onCrossSession 收带 sid 的 extension:*。route-inbound 成为消息分发单一真相源。）
 *
 * OverlayLifecycle（IF9）装配：订阅同一 bus 的 ui-request 事件，per-session/per-requestId
 * 维护 overlay 状态机（expanded→minimized→restored）+ session-destroyed cleanup。状态机就绪
 * 供 CompanionBand 后续多 overlay z-index 编排（当前 CompanionBand 单 dialog 队首渲染，
 * z-index 消费依赖多 overlay 渲染能力，见 02-extension-host-wiring.md）。
 *
 * CompanionBand（plugin:uiRequest dialog）接线：createDialogRequestSource/createUiResponseTransport
 * 适配（见 extension-host-dialog.ts）经 DIALOG_REQUEST_SOURCE_KEY/UI_RESPONSE_TRANSPORT_KEY 注入。
 *
 * plugin-header-action-modal-points（u4b）接线：HeaderActionStore（#42 徽标镜像）+
 * plugin-modal-slot 帧订阅（#43 槽镜像）+ headerAction 声明镜像（响应式，E2 清理/重放后
 * 刷新）+ E2 触发链（plugin:statusChange/plugin:crashed → 三容器清理 + 命令注销）+
 * ACTION_EXECUTOR_KEY / HEADER_ACTIONS_SOURCE_KEY / PLUGIN_MODAL_SOURCE_KEY 三个 provide。
 */
import type { App, InjectionKey } from 'vue'
import { reactive, shallowReactive, shallowRef, watch } from 'vue'
import {
  ContributionRegistry,
  createSessionScopedMap,
  createSessionScopedMapFrom,
  EXTENSION_BRIDGE_TYPES,
  HeaderActionStore,
  InternalEventBus,
  MessageBusBridge,
  MountPointRegistry,
  setExtensionRegistries,
  StatusBarController,
  NotificationHostController,
  ViewHostStore,
  OverlayLifecycle,
  ActivationManager,
  CommandRegistry,
  clearPluginModalForPlugin,
  subscribePluginModalSlot,
  type ActivationTrigger,
  type CommandExecutor,
  type ContributionRecord,
  type HeaderActionEntry,
  type OverlayState,
  type IncomingPluginMessage,
  type PluginMessageSource,
  type SessionScopedMap,
  type ViewCacheEntry,
  type StatusBarSessionState,
} from '@taiji/core'
import { getState as getWsState, send } from '@taiji/core/transport/ws-client'
import {
  DIALOG_REQUEST_SOURCE_KEY,
  PluginSettingsDataSourceKey,
  STATUS_BAR_SOURCE_KEY,
  UI_RESPONSE_TRANSPORT_KEY,
  VIEW_HOST_SOURCE_KEY,
  VIEWS_SOURCE_KEY,
  OVERLAY_LIFECYCLE_KEY,
  type ContributionInfo,
} from '@taiji/ui/extension-host'
import { ACTION_EXECUTOR_KEY } from '@taiji/ui/rendering-protocol'
import { SLASH_COMMAND_SOURCE_KEY } from '@/components/panel/command-popover-source'
import { createDialogRequestSource, createUiResponseTransport } from './extension-host-dialog'
import type { ServerMessage } from '@taiji/shared'
import { onCrossSession, onGlobal } from '@taiji/core/transport/api'
import { onPlugins } from '@taiji/core/transport/api/domains/plugin'
import { createNotifyToastHandler } from './notify-toast'
import { useCommandStore } from '@/composables/features/command/useCommandStore'

/** 把 renderer 的 WS 消息流（events 通道的 plugin:/extension: 下行）适配成 PluginMessageSource。 */

/**
 * extension:* 下行进 bridge 的精确白名单——core 导出 SSOT（D10②，派生自
 * message-bus-bridge.ts EXTENSION_HANDLERS 的 keys），本文件 import 同一份。
 * plugin:* 前缀全放行，extension:* 只放行白名单内 type——其余（如 extension.error）
 * 由 source filter 静默丢弃，不进 bridge（source 职责边界）。
 */

/**
 * 过滤条件：plugin:* 前缀 OR EXTENSION_BRIDGE_TYPES 精确白名单。
 *
 * ADR-0060：数据源从 raw-message-tap 旁路改为 events 正规双订阅（route-inbound 单一真相源）：
 * - onGlobal：收无 sid 的 plugin:*（statusBarUpdate/notification/uiRequest 等走 global 通道）
 * - onCrossSession：收带 sid 的 extension:*（widget/widgetGui/status/notify/ui_request
 *   + plugin:uiRequest/plugin:viewUpdate，route-inbound 声明式条目 crossSession 字段分发，
 *   全局单例消费者 ExtensionHost 接收）
 * 经 source filter 后消息集合与旧 raw-tap 全量订阅等价（plugin:* 无 sid + extension.* 带 sid）。
 */
export function createWsPluginMessageSource(): PluginMessageSource {
  return {
    subscribe(handler: (msg: IncomingPluginMessage) => void): () => void {
      // 适配 raw ServerMessage → IncomingPluginMessage（source filter：plugin:* 前缀 OR 白名单 type）
      const adapt = (msg: ServerMessage): void => {
        if (
          typeof msg.type === 'string' &&
          (msg.type.startsWith('plugin:') || EXTENSION_BRIDGE_TYPES.includes(msg.type))
        ) {
          const payload = (msg.payload ?? {}) as { sessionId?: string }
          handler({
            type: msg.type,
            sessionId: typeof payload.sessionId === 'string' ? payload.sessionId : undefined,
            payload: msg.payload,
          })
        }
      }
      const offGlobal = onGlobal(adapt)
      const offCrossSession = onCrossSession(adapt)
      return () => {
        offGlobal()
        offCrossSession()
      }
    },
  }
}

/**
 * 模块级共享 bus（IF1，slice companion-band-mount TC1）：惰性单例。
 * 首次调用 new InternalEventBus() 缓存，后续返回同一实例。
 * initExtensionHostBridge 与 useExtensionUI（ui-request 订阅）以及 sibling slice
 * （bridge-ui-request-wiring 的 DialogRequestSource 适配）共享同一实例——
 * 若各自 new，消息流分裂（bridge 的事件进不了消费方的 bus）。
 */
let sharedBus: InternalEventBus | null = null
export function getExtensionBus(): InternalEventBus {
  if (!sharedBus) sharedBus = new InternalEventBus()
  return sharedBus
}

/**
 * 壳层响应式 SessionScopedMap（MF-2 R2 修复，ADR-0049 范式的响应式版）。
 *
 * core 的 createSessionScopedMap 是 headless 纯 Map（刻意零 Vue 依赖）：外层 partitions 是
 * 普通 Map，computed 读路径 `get(sid)?.get(vid)` 在分区尚不存在时短路 undefined、零依赖建立，
 * 之后首个 viewUpdate 惰性建分区 + set 不触发 → 值永久 stale（panel.header 常挂组件时序直接命中）。
 * 实现复用 core 的接口骨架 createSessionScopedMapFrom（store 参数化形态）：外层传
 * shallowReactive Map，get/set 被 Vue 追踪：分区后建 → SET/ITERATE trigger → computed 重算。
 * 分区值仍由 init 工厂返回 reactive 容器（in-place mutate 走 proxy set trap）——故外层用
 * shallowReactive（值已是 reactive，避免 reactive(Map) 的 deep unwrap 类型噪音与二次包装）。
 */
function createReactiveSessionScopedMap<T>(init: () => T): SessionScopedMap<T> {
  return createSessionScopedMapFrom(shallowReactive(new Map<string, T>()), init)
}

/**
 * mountPoints.sync 上报的模块级单例注册（MF-1 R2 修复）。
 *
 * 不能在 initExtensionHostBridge 时立即 send：main.ts 模块体同步执行先于 app.mount，WS 唯一
 * 连接入口在 App.vue onMounted（异步建连），send 时 readyState 必非 OPEN → core ws-client
 * 非 OPEN 时 return false 静默丢弃（W4 fast-fail 契约，无缓冲队列）→ runtime mountPoints 恒 []。
 * 改为 watch connectionState：每次进入 connected（首次建连 + runtime 重启重连）补发；
 * runtime syncMountPoints 为 overwrite 语义（DM3），重复发送幂等。模块级守卫防重复注册
 * （HMR / 测试多次 init 只挂一个 watcher，避免重复发送）。
 */
let mountPointsSyncWatchRegistered = false
function ensureMountPointsSync(mountPoints: MountPointRegistry): void {
  if (mountPointsSyncWatchRegistered) return
  mountPointsSyncWatchRegistered = true
  const sendSync = (): void => {
    send({ type: 'plugin.mountPoints.sync', payload: { mountPoints: mountPoints.list() } })
  }
  // immediate：init 时若已 connected（防御）立即发送；否则等待首次建连 / 重连进入 connected
  watch(getWsState(), (s) => {
    if (s === 'connected') sendSync()
  }, { immediate: true })
}

/**
 * builtin command/slashCommand 声明 → CommandRegistry 同步（§11-5 自查修正，u6）。
 *
 * 原在装配期同步循环执行（依赖旧装配顺序：bridge 内 scanContributions 先行、registerBuiltin
 * 已填充 contributions）。注册收敛 bootstrap 第 5 步（App.vue onMounted）后，装配期（main.ts
 * mount 前）contributions 尚空——装配期快照会永久丢失 builtin 声明（goal/todo 的 slash
 * description 元数据）。改挂 watch(connected) 重放：bootstrap step5 由 await 链微任务接续，
 * 结构性先于 connected（真实分支 connected 需 WS onopen + auth 宏任务；mock 分支 200ms
 * setTimeout），connected 后声明必已就绪；消费点 CommandPopover 为用户交互，远晚于 connected。
 * 幂等（registerFromContribution 同 id 覆盖），重连/重跑无害。模块级守卫对齐
 * ensureMountPointsSync（HMR / 测试多次 init 只挂一个 watcher）。
 */
let commandDeclarationsSyncWatchRegistered = false
function ensureCommandDeclarationsSync(
  contributions: ContributionRegistry,
  commandRegistry: CommandRegistry,
): void {
  if (commandDeclarationsSyncWatchRegistered) return
  commandDeclarationsSyncWatchRegistered = true
  watch(getWsState(), (s) => {
    if (s !== 'connected') return
    for (const c of contributions.getContributions()) {
      if (c.type === 'command' || c.type === 'slashCommand') commandRegistry.registerFromContribution(c)
    }
  }, { immediate: true })
}

/**
 * 挂载点注册态 → ContributionInfo 映射（M16，PluginSettingsPage 数据源）。
 *
 * available = 挂载点已注册（MountPointRegistry SSOT）；未注册 → available=false + reason
 * （置灰 + 原因，场景 E AC3）。纯函数便于单测（TC2）。
 */
export function toContributionInfos(
  records: ContributionRecord[],
  mountPoints: MountPointRegistry,
): ContributionInfo[] {
  return records.map((c) => ({
    id: c.contributionId,
    type: c.type,
    available: mountPoints.has(c.placement),
    reason: mountPoints.has(c.placement) ? undefined : `挂载点 ${c.placement} 未注册`,
  }))
}

// ── u4b（plugin-header-action-modal-points AP-1/AP-2）两个渲染宿主的数据源契约 ──
//
// key 定义在本模块（对齐 SLASH_COMMAND_SOURCE_KEY 的「壳内定义、壳 provide、组件 inject」
// 先例），组件侧只认 key 不认实现；单测经 global.provide 注入 mock 源。

/** E13 命令可用性三态（HeaderActionsHost 灰置状态机的判定输入）。 */
export type HeaderActionCommandAvailability = 'registered' | 'unregistered' | 'unknown'

/** HeaderActionsHost 数据源（声明镜像 + per-session 运行时镜像 + E13/E3 执行面）。 */
export interface HeaderActionsSource {
  /** headerAction 型声明（panel.header 挂载点）。响应式镜像：注册同步 / E2 清理与重放后刷新。 */
  getDeclarations(): ContributionRecord[]
  /** per-session 运行时状态镜像（#42；reactive 分区读，未收到帧返回 undefined）。 */
  getRuntimeState(sessionId: string, headerActionId: string): HeaderActionEntry | undefined
  /** E13 三态判定（实现见 resolveHeaderActionAvailability）。 */
  resolveCommandAvailability(sessionId: string, commandId: string): HeaderActionCommandAvailability
  /** E3 点击执行：返回 false = 命令缺失（CommandRegistry 已 emit error，禁静默 no-op）。 */
  executeCommand(commandId: string): boolean
}

export const HEADER_ACTIONS_SOURCE_KEY: InjectionKey<HeaderActionsSource> = Symbol('header-actions-source')

/** plugin.dismissModal 关闭原因闭集（core types 同构别名，组件签名可读性） */
export type PluginModalDismissReason =
  | 'dismissed'
  | 'session-switched'
  | 'host-overlay'
  | 'replaced'
  | 'plugin-gone'

/** PluginModalHost 数据源（声明侧元数据 fallback：E1 降级链 declaration 段）+
 *  C→S dismissModal 上报（经本 bridge 门面发出——D3/R4 WS send 统一门面，组件禁直调
 *  ws-client，check_no_direct_ws_send.py 白名单只有 bridge/dialog/singleton 三文件）。 */
export interface PluginModalSource {
  getDeclaration(
    pluginId: string,
    modalId: string,
  ): { title?: string; width?: 'sm' | 'md' | 'lg' } | undefined
  /** 上报 C→S plugin.dismissModal（runtime 校验 (pluginId, modalId, epoch) 三元组后广播 closed + notify 插件；接收侧归 u5b）。 */
  dismiss(pluginId: string, modalId: string, epoch: number, reason: PluginModalDismissReason): void
}

export const PLUGIN_MODAL_SOURCE_KEY: InjectionKey<PluginModalSource> = Symbol('plugin-modal-source')

/**
 * E13 判定（bridge 真实实现，双源 OR）：
 * ① 会话命令分区（commandStore，pi getCommands 消费产物）含同名命令 → registered；
 * ② CommandRegistry（plugin 命令注册表，builtin 声明经 ensureCommandDeclarationsSync 注册）
 *    含该命令 → registered——scheduler-manager.open 的主命中路径（其命令名非 pi slash 命令）；
 * ③ 会话分区非空但两源皆无 → unregistered（E2 禁用清理 CommandRegistry 后灰置的主路径）；
 * ④ 分区为空 → unknown（无法区分「未拉取/恢复窗口」与「空命令表」的保守判定——
 *    组件侧保持上次值、首次缺省可点，失败由 E14 写路径兜底不拦入口）。
 * 已知近似：真「空命令表」会话被判 unknown 而非 unregistered（登记 u4b deviations）。
 */
function resolveHeaderActionAvailability(
  commandStore: ReturnType<typeof useCommandStore>,
  commandRegistry: CommandRegistry,
  sessionId: string,
  commandId: string,
): HeaderActionCommandAvailability {
  const commands = commandStore.getCommands(sessionId)
  if (commands.some((c) => c.name === commandId)) return 'registered'
  if (commandRegistry.get(commandId)) return 'registered'
  if (commands.length > 0) return 'unregistered'
  return 'unknown'
}

/**
 * 测试后门命名空间（生产代码禁止消费，与生产 import 面物理分离，audit 清理点#9 归整）。
 * - lastInitHandles：最近一次 initExtensionHostBridge 装配的测试所需句柄快照——init 返回
 *   void 后（生产调用方 main.ts 恒丢弃返回值），测试 afterEach dispose（bridge）与注册
 *   注入用例（contributions）取内部实例的唯一通道。仅存测试实际消费的两字段。
 */
export const __testing = {
  lastInitHandles: null as null | { bridge: MessageBusBridge; contributions: ContributionRegistry },
}

/**
 * 装配 ExtensionHost bridge（main.ts 挂载前调用一次，app.provide 全局注入）。
 *
 * 生产语义返回 void：唯一调用方 main.ts 恒单语句调用、丢弃返回值（audit 清理点#9，
 * 原 9 字段返回对象系「供调试与后续接线」的未兑现赌注）。测试需要的内部句柄经
 * `__testing.lastInitHandles` 取（仅 bridge / contributions 两字段有测试消费）。
 */
export function initExtensionHostBridge(app: App): void {
  const bus = getExtensionBus() // IF1：复用模块级惰性单例（不再局部 new）
  const source = createWsPluginMessageSource()
  // bridge 构造即订阅 source（source.subscribe → handleMessage → bus.emit）
  const bridge = new MessageBusBridge({ source, bus })
  // MF-4 响应式桥（R2 补齐）：core store 是 headless 纯 Map 容器（刻意零 Vue 依赖），事件到达
  // mutate 纯 Map 不被 Vue computed 追踪 → ViewHost/StatusBar 永不重渲染。壳层两层 reactive 化：
  // ①外层 partitions 容器 reactive（createReactiveSessionScopedMap——分区后建也触发重算，
  //   修复「computed 首次求值短路 → 永久 stale」）；②分区值由 init 工厂返回 reactive 容器
  // （get/set 走 reactive proxy）。ViewHost.vue computed 的 getView/getItems 调用面即被追踪
  // （core 代码零改动）。
  const viewHostStore = new ViewHostStore({
    bus,
    sessionScoped: createReactiveSessionScopedMap(() => reactive(new Map<string, ViewCacheEntry>())),
  })
  viewHostStore.subscribe()
  const statusBarController = new StatusBarController({
    bus,
    // 分区值须满足 StatusBarSessionState 全字段（setEntries 必填，items/setEntries 后续 update push）
    sessionScoped: createReactiveSessionScopedMap(() => reactive<StatusBarSessionState>({ items: [], setEntries: [] })),
  })
  statusBarController.subscribe()
  const mountPoints = new MountPointRegistry()
  const contributions = new ContributionRegistry(bus)
  setExtensionRegistries({ mountPoints, contributions })
  // 仅注入注册表：注册触发收敛为 bootstrap 第 4/5 步（App.vue onMounted 编排，u6 去重）——
  // 本装配点不再自行 registerMountPoints/scanContributions。

  // W3 slash 收编（D1 归一）：CommandRegistry 实例化（与 ViewHostStore/StatusBarController 并列，03 文档 D3-3）。
  // ActivationManager 的 trigger 适配为 no-op——runtime 暂无激活 RPC 通道（plugin-message-handler 无
  // triggerActivation case），builtin/声明型无 activationEvents 时 ensureActivated 短路，行为等价。
  const activationManager = new ActivationManager({
    trigger: { ensureActivated: async () => {} } satisfies ActivationTrigger,
  })
  // CommandExecutor 适配 = runtime plugin.executeCommand RPC（通道名已核实 plugin-message-handler.ts:50）。
  // 惰性调用：execute 时才发 WS；commandId = registry 记录 id，pluginId 经闭包查 registry（CommandExecutor
  // 接口签名只有 id——壳层补查）。未注册命令 no-op（CommandRegistry.execute 已先发 ERR6 error 事件）。
  // 契约（S3-W1 命令链复合键）：payload 携带分离的 pluginId + commandId，runtime 侧按
  // `pluginId:commandId` 复合键查注册表——命令表按插件隔离，插件 B 无法覆盖/注销插件 A 的同名命令。
  const commandExecutor: CommandExecutor = {
    execute: async (id, args) => {
      const cmd = commandRegistry.get(id)
      if (!cmd) return
      send({
        type: 'plugin.executeCommand',
        payload: { pluginId: cmd.pluginId, commandId: id, args: args as Record<string, unknown> | undefined },
      })
    },
  }
  // execute 闭包引用 commandRegistry，最早调用时序在本行创建 registry 实例之后，const 无 TDZ 风险
  const commandRegistry = new CommandRegistry({ bus, activationManager, executor: commandExecutor })
  // builtin command + slashCommand 声明同步进 CommandRegistry（收编后是 slash 命令统一消费源，
  // 03 文档 D3-1：声明提供 description 元数据，执行仍走 pi）。装配期 contributions 尚空
  // （注册已收敛 bootstrap 第 5 步），改 connected 后重放同步（见 ensureCommandDeclarationsSync 注释）。
  ensureCommandDeclarationsSync(contributions, commandRegistry)
  // CommandPopover 数据源：resolveSlashCommands 合并源（registry 声明 ∪ commandStore pi 真源）。
  // 壳提供真实 registry 实现，组件注入（单测 global.provide mock）。
  app.provide(SLASH_COMMAND_SOURCE_KEY, {
    resolveSlashCommands: (piCommands) => commandRegistry.resolveSlashCommands(piCommands),
  })
  // MF-3：把挂载点整表上报 runtime（AC10）——插件 views.listMountPoints() 依赖此中继查询，
  // 不上报则恒返回 []（registerMountPoints 内部同步注册，list() 已含全部挂载点）。
  // MF-1（R2）：发送时点见 ensureMountPointsSync——init 时 WS 未建连，send 必被静默丢弃。
  ensureMountPointsSync(mountPoints)

  // ui 组件数据源（ViewHost/StatusBar 经 inject 取，壳 provide 真实实现；形状对齐 IF10/IF5）
  app.provide(VIEW_HOST_SOURCE_KEY, {
    getView: (sessionId, viewId) => viewHostStore.getView(sessionId, viewId),
    // widget 视图消费面（Composer 托盘 widget 区）：枚举该 session 全部缓存 viewId（纯透传 core store）
    getViewIds: (sessionId: string) => viewHostStore.getViewIds(sessionId),
  })
  // L2 二级 tab 数据源（PluginViewContainer 经 inject 取；纯静态声明——sidebar.tab 视图贡献清单，
  // widget 推送经 Composer 托盘 widget 区承接、不进 sidebar，M17 wave2 D5）。
  // 不裸委托 getViewsByPlacement——它缺 pluginId，builtin 判定（tasks 不可关闭）需要
  // pluginId，故从 getContributions 直接映射（design-review 已确认此设计）。
  // icon 当前无图标源，透传 undefined（PluginViewContainer 以统一 default icon 兜底）。
  app.provide(VIEWS_SOURCE_KEY, {
    getViews: (_sessionId: string) => {
      // per-session 形参保留接口兼容（ui 契约 IF5）：纯静态声明，当前实现忽略
      const staticViews = contributions
        .getContributions({ type: 'view' })
        .filter((c) => c.placement === 'sidebar.tab')
        .map((c) => ({
          viewId: c.contributionId,
          title: c.view?.title ?? c.contributionId,
          icon: undefined,
          initialVisibility: c.view?.initialVisibility ?? 'hidden',
          pluginId: c.pluginId,
        }))
      return staticViews
    },
  })
  // L2 原生视图路由表与 L2 tab badge 源已随「后台命令」native 视图退役
  // （composer-task-tray D10：托盘承接后台命令观察面；PluginViewContainer 的
  // 同名分支同批删除）。plugin sidebar view 机制本身保留——
  // 上方 VIEWS_SOURCE_KEY + ViewHost 原路径即其消费面。
  app.provide(STATUS_BAR_SOURCE_KEY, {
    // 两 scope 重载（ui 契约）：直接委托 StatusBarController（签名对齐 IF8）。
    // MF-2（R2）：global scope 经 controller 的 sessionScoped 保留分区（GLOBAL_SCOPE_KEY）存储，
    // 壳注入 reactive 分区容器 → getItems 返回的 items 数组本身 reactive，computed 追踪有效
    // （旧实现 reactive() 包装 controller 私有 raw 数组，replaceAllWith 原地 mutate 不经 proxy
    // set trap → global 状态栏永不更新）。
    getItems: (scope: 'global' | 'per-session', sessionId?: string) => {
      if (scope === 'global') return statusBarController.getItems('global')
      // sessionId 可能 undefined：controller 实现签名内部 `sessionId ?? GLOBAL_STATUS_KEY` 兜底
      // （重载签名要求 string，受控断言仅类型擦除，运行时 undefined 走兜底分区）
      return statusBarController.getItems('per-session', sessionId as string)
    },
  })
  // PluginSettingsPage 数据源（M16）：onPlugins 委托 api 域
  // （config.plugins 广播订阅），getContributions 委托 ContributionRegistry + MountPointRegistry
  // （toContributionInfos：未注册挂载点 → 置灰 + 原因，场景 E AC3）。
  app.provide(PluginSettingsDataSourceKey, {
    onPlugins,
    getContributions: (pluginId) =>
      toContributionInfos(contributions.getContributions({ pluginId }), mountPoints),
  })
  // CompanionBand 数据源：bus 'ui-request' 适配（无 sid 跳过 / C4 分流：form ∨ legacy
  // askUser ∨ scheduleCreate ∨ planReview 四键排除——form 类与审批请求各归 FormOverlay /
  // PlanReviewBar，CompanionBand 只收简单 dialog）+ 回传双通道（FR2/FR7）
  app.provide(DIALOG_REQUEST_SOURCE_KEY, createDialogRequestSource(bus))
  app.provide(UI_RESPONSE_TRANSPORT_KEY, createUiResponseTransport())

  // OverlayLifecycle（IF9，audit §12.1 接线闭环）：订阅同一 bus 的 ui-request → 自动建 per-session
  // per-requestId 分区（expanded 初始态）+ session-destroyed cleanup（ERR4）。bus 亶久持有 listener
  // 闭包（闭包捕获 deps.sessionScoped），实例即便不被外部引用也不会被 GC 丢失订阅。subscribe 返回
  // dispose，正常应用生命周期不调（跟随 app 存活）。CompanionBand 多 overlay z-index 消费待后续。
  const overlayLifecycle = new OverlayLifecycle({
    bus,
    sessionScoped: createSessionScopedMap(() => new Map<string, OverlayState>()),
  })
  overlayLifecycle.subscribe()
  // OverlayLifecycle（IF9 状态机）provide 给 CompanionBand 消费（arch-fix-v2 闭环）：
  // minimize/restore → transition 驱动状态机迁移；getState 派生 z-index。实例结构兼容
  // ui 包 OverlayLifecycleSource 接口（getState/transition 签名一致，结构型适配无需手写包装）。
  app.provide(OVERLAY_LIFECYCLE_KEY, overlayLifecycle)

  // NotificationHostController（DM3 消费端补齐）：订阅同一 bus 的 6 类通知/生命周期事件。
  // toast 经 deps 注入——core 零 UI 依赖，壳用 useToast（模块级单例，命令式 API）实现 showToast。
  // level 映射 + 前台/后台过滤 + 定位行组装（sessionLabel + sessionId 双透传，定位行点击跳转）
  // 统一在 createNotifyToastHandler（notify-toast.ts，装配测试共用）；store 惰性解析：bridge
  // 装配先于 app.use(createPinia)，回调触发时 pinia 已激活。
  const notificationController = new NotificationHostController({
    bus,
    deps: {
      showToast: createNotifyToastHandler(),
      log: console.warn,
    },
  })
  notificationController.subscribe()

  // ── u4b（AP-1/AP-2）渲染宿主接线 ────────────────────────────────

  // HeaderActionStore（#42 徽标镜像）：reactive 分区（对齐 ViewHostStore 响应式桥两层
  // reactive 化范式，MF-4）+ bus 帧订阅自驱动（plugin:headerActionUpdate 写入 /
  // session-destroyed 清理）。声明处 @data-owner #42。
  const headerActionStore = new HeaderActionStore({
    bus,
    sessionScoped: createReactiveSessionScopedMap(() => reactive(new Map<string, HeaderActionEntry>())),
  })
  headerActionStore.subscribe()
  // plugin-modal-slot 帧订阅（#43）：plugin:modalState → 槽镜像（open/closed 仲裁在 core 单模块）。
  // 幂等（模块级守卫），重复 init 不翻倍。
  subscribePluginModalSlot(bus)

  // headerAction 声明镜像：ContributionRegistry 是 headless 非响应 Map（组件 computed 无法
  // 追踪 clearForPlugin/registerBuiltin 的原地变化），shallowRef 整表替换供组件响应式消费。
  const headerActionDeclarations = shallowRef<ContributionRecord[]>([])
  const refreshHeaderActionDeclarations = (): void => {
    headerActionDeclarations.value = contributions.getContributions({ type: 'headerAction' })
  }
  refreshHeaderActionDeclarations()
  // 注册同步时机与 ensureCommandDeclarationsSync 同款（connected 后 bootstrap step5 声明已就绪）
  watch(getWsState(), (s) => {
    if (s === 'connected') refreshHeaderActionDeclarations()
  }, { immediate: true })

  // E2 触发链：runtime plugin:statusChange / plugin:crashed 广播 → bus 事件 → 清理三容器 +
  // 注销该插件命令（ContributionRegistry 无按插件枚举，先查后清）；disabled→active 重启用走
  // 静态表重放（registerBuiltin + 命令声明重放；external 声明表壳侧无镜像，重放归 s3 透传）。
  const handlePluginGone = (pluginId: string): void => {
    const commandIds = contributions
      .getContributions({ pluginId })
      .filter((c) => c.type === 'command' || c.type === 'slashCommand')
      .map((c) => c.contributionId)
    contributions.clearForPlugin(pluginId)
    for (const id of commandIds) commandRegistry.unregisterCommand(id)
    headerActionStore.clearForPlugin(pluginId)
    clearPluginModalForPlugin(pluginId)
    refreshHeaderActionDeclarations()
  }
  const handlePluginBack = (pluginId: string): void => {
    contributions.registerBuiltin()
    for (const c of contributions.getContributions({ pluginId })) {
      if (c.type === 'command' || c.type === 'slashCommand') commandRegistry.registerFromContribution(c)
    }
    refreshHeaderActionDeclarations()
  }
  bus.on('plugin-status-change', (e) => {
    // inactive=禁用 / crashed=崩溃 → 清理（E2）；loaded/active=装载/启用 → 静态表重放；
    // discovered 是发现态（未装载），不动作。
    if (e.status === 'inactive' || e.status === 'crashed') handlePluginGone(e.pluginId)
    else if (e.status === 'active' || e.status === 'loaded') handlePluginBack(e.pluginId)
  })
  bus.on('plugin-crashed', (e) => handlePluginGone(e.pluginId))
  // AP-2 开帧残留治理：closed 帧到达时清该 (sessionId, viewId) 的 ViewHostStore 分区——
  // 重开首帧为空白而非上次残留树（宁缺勿错；插件契约 = showModal 后立即 views.update）。
  bus.on('plugin:modalState', (e) => {
    const f = e.modalState
    if (f.state === 'closed') viewHostStore.invalidate(f.sessionId, `modal-${f.pluginId}-${f.modalId}`)
  })

  // action-bar 执行器（AP-3）：ui 侧 ACTION_EXECUTOR_KEY（跨包 symbol 同一实例），
  // 实现 = core CommandRegistry.execute 包装（结构兼容 ui 最小接口，无 ui→core 依赖边）。
  app.provide(ACTION_EXECUTOR_KEY, {
    execute: (id, args) => {
      void commandRegistry.execute(id, args as Record<string, unknown> | undefined)
    },
  })
  // HeaderActionsHost 数据源（声明镜像 + 运行时镜像 + E13/E3 面）
  const commandStore = useCommandStore()
  app.provide(HEADER_ACTIONS_SOURCE_KEY, {
    getDeclarations: () => headerActionDeclarations.value,
    getRuntimeState: (sessionId, headerActionId) => headerActionStore.get(sessionId, headerActionId),
    resolveCommandAvailability: (sessionId, commandId) =>
      resolveHeaderActionAvailability(commandStore, commandRegistry, sessionId, commandId),
    executeCommand: (commandId) => {
      // E3：缺失命令也走 execute（内部 emit ERR6 error 出声），返回 false 供组件本地置灰
      const missing = !commandRegistry.get(commandId)
      void commandRegistry.execute(commandId)
      return !missing
    },
  })
  // PluginModalHost 数据源（声明侧元数据 fallback；E1 降级链的 declaration 段）
  // + dismissModal 出站（D3 门面：renderer WS send 白名单仅 bridge/dialog/singleton）
  app.provide(PLUGIN_MODAL_SOURCE_KEY, {
    getDeclaration: (pluginId, modalId) => {
      const c = contributions
        .getContributions({ type: 'modal' })
        .find((r) => r.pluginId === pluginId && r.contributionId === modalId)
      return c?.modal ? { title: c.modal.title, width: c.modal.width } : undefined
    },
    dismiss: (pluginId, modalId, epoch, reason) => {
      // 帧类型与 payload 形状由 shared protocol.ts ClientMessageMap['plugin.dismissModal']
      // 直接校验（u5b 已落地，无受控断言）
      send({ type: 'plugin.dismissModal', payload: { pluginId, modalId, epoch, reason } })
    },
  })

  __testing.lastInitHandles = { bridge, contributions }
}
