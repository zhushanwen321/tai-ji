/**
 * useExtensionHostBridge —— ExtensionHost renderer 接线（audit §12.1，P5 wiring）。
 *
 * 职责：打通 plugin panels 渲染链路最后一公里——
 * - 把 renderer 的 WS 消息流（plugin:* 下行广播）适配成 PluginMessageSource
 *   （@taiji/ui/extension-host shell-adapters 共享件，双壳逐字节同源；
 *   core/extension-host/plugin-message-source.ts 注释明确「壳把 transport 层适配成 source 注入」）
 * - 创建 InternalEventBus + MessageBusBridge（归一 plugin:* → bus 事件）
 * - 创建 ViewHostStore（消费 bus，ui 组件数据源）
 * - 注入 MountPointRegistry/ContributionRegistry 到 core bootstrap（setExtensionRegistries；
 *   注册触发收敛为 bootstrap 第 4/5 步——App.vue onMounted 编排，本模块不再自行触发）
 * - app.provide ViewHost 的 inject key
 *
 * 消息流：WS 下行 → route-inbound（events 正规通道）→ 本适配器 →
 * MessageBusBridge → bus 'extension-widget' → ViewHostStore → <ViewHost> getView。
 * （ADR-0060：数据源从 raw-message-tap 旁路改为 events 双订阅——详见 shell-adapters.ts。）
 *
 * OverlayLifecycle（IF9）装配：订阅同一 bus 的 ui-request 事件，per-session/per-requestId
 * 维护 overlay 状态机（expanded→minimized→restored）+ session-destroyed cleanup。状态机就绪
 * 供 CompanionBand 后续多 overlay z-index 编排（当前 CompanionBand 单 dialog 队首渲染，
 * z-index 消费依赖多 overlay 渲染能力，见 02-extension-host-wiring.md）。
 *
 * CompanionBand（plugin:uiRequest dialog）接线：createCompanionDialogAdapters 共享工厂
 * （C4 四键排除 + 壳层能力回调注入，见 shell-adapters.ts）
 * 经 DIALOG_REQUEST_SOURCE_KEY/UI_RESPONSE_TRANSPORT_KEY 注入。
 *
 * plugin-header-action-modal-points（u4b）接线：HeaderActionStore（#42 徽标镜像）+
 * headerAction 声明镜像（响应式，E2 清理/重放后刷新）+ E2 触发链
 *（plugin:statusChange/plugin:crashed → 容器清理 + 命令注销）+
 * ACTION_EXECUTOR_KEY / HEADER_ACTIONS_SOURCE_KEY 两个 provide。
 */
import type { App, InjectionKey } from 'vue'
import { reactive, shallowReactive, shallowRef, watch } from 'vue'
import {
  ContributionRegistry,
  createSessionScopedMap,
  createSessionScopedMapFrom,
  HeaderActionStore,
  InternalEventBus,
  MessageBusBridge,
  MountPointRegistry,
  setExtensionRegistries,
  setPluginListSource,
  NotificationHostController,
  ViewHostStore,
  OverlayLifecycle,
  ActivationManager,
  CommandRegistry,
  ContainerNavigationExecutor,
  type ActivationTrigger,
  type CommandExecutor,
  type ContributionRecord,
  type HeaderActionEntry,
  type OverlayState,
  type SessionScopedMap,
  type ViewCacheEntry,
} from '@taiji/core'
import { openDrawerTab, getBoundSessionId, ensureBuiltinsAssembled } from '@taiji/core/domain/drawer'
import type { ContentSlotDeclaration, PluginDescriptorLike } from '@taiji/core'
import { contentSlotRegistry, HOST_PLUGIN_ID } from '@taiji/core'
import { openOverlayContent } from '@taiji/core/domain/overlay'
import { getState as getWsState, send } from '@taiji/core/transport/ws-client'
import {
  createCompanionDialogAdapters,
  createWsPluginMessageSource,
  DIALOG_REQUEST_SOURCE_KEY,
  PluginSettingsDataSourceKey,
  UI_RESPONSE_TRANSPORT_KEY,
  VIEW_HOST_SOURCE_KEY,
  VIEWS_SOURCE_KEY,
  OVERLAY_LIFECYCLE_KEY,
  type ContributionInfo,
} from '@taiji/ui/extension-host'
import { ACTION_EXECUTOR_KEY, CONTAINER_NAVIGATION_KEY } from '@taiji/ui/rendering-protocol'
import { SLASH_COMMAND_SOURCE_KEY } from '@/components/panel/command-popover-source'
import { onPlugins, getPluginUiSnapshot } from '@taiji/core/transport/api/domains/plugin'
import type { PluginContributesView, PluginInfo, PluginUiSnapshotPayload, PluginViewScope } from '@taiji/shared'
import { createNotifyToastHandler } from './notify-toast'
import { notifyUiResponseNotDelivered } from './ui-response-feedback'
import { useChatStore } from '@/stores/chat'
import { useCommandStore } from '@/composables/features/command/useCommandStore'

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
 * unregistered-mount-point 告警去重集合（容器扩展点统一 §6.14 失败降级三件套）。
 *
 * 模块级 = 进程级持存：跨容器实例与跨会话生效，插件重新启用后不清空——routeAll 每次
 * loadExternal 后重跑，同一无效声明会在每次 config.plugins 广播时重复 emit（7 处触发点），
 * 无去重则告警刷屏。键 = pluginId::contributionId::失败种类（§6.14 统一口径）。
 * 登记处 = docs/architecture/data-source-registry.md #84（与 failure-degradation.ts warnedKeys
 * 同条两载体，本条为 renderer 桥侧载体②）。
 */
const unregisteredMountPointWarned = new Set<string>() // @data-owner #84

/**
 * 差集收敛清理（订阅职责④）的去抖窗：矛盾帧（active 事件重放后尾随的 enabled=false
 * 过期列表帧）是相邻 WS 消息、毫秒级间隔，300ms 合并窗足够取到末帧权威；重连收敛
 * 延迟同量级，对容器位列表不可感知。
 */
const RECONCILE_EXTERNAL_SLOTS_DEBOUNCE_MS = 300

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
 * mountPoints.sync 上报的 connected 重放器（MF-1 R2 修复；R2-2 习语合流）。
 *
 * 不能在 initExtensionHostBridge 时立即 send：main.ts 模块体同步执行先于 app.mount，WS 唯一
 * 连接入口在 App.vue onMounted（异步建连），send 时 readyState 必非 OPEN → core ws-client
 * 非 OPEN 时 return false 静默丢弃（W4 fast-fail 契约，无缓冲队列）→ runtime mountPoints 恒 []。
 * 改为 watch connectionState：每次进入 connected（首次建连 + runtime 重启重连）补发；
 * runtime syncMountPoints 为 overwrite 语义（DM3），重复发送幂等。
 *
 * watcher 生命周期随 init dispose-and-rebuild（对齐 usePermissionRequest 习语）：返回 stop
 * 句柄由 __testing.lastInitHandles.dispose 统一回收，重复 init 先 stop 旧 watcher 再挂新。
 * [HISTORICAL] 旧实现的模块级布尔检查使 watcher 永久闭包绑定第一次 init 的 registry 实例
 * ——重复 init 后 setExtensionRegistries 已把 core 单例换新实例，注册进新实例、上报旧实例快照。
 */
function ensureMountPointsSync(mountPoints: MountPointRegistry): () => void {
  const sendSync = (): void => {
    send({ type: 'plugin.mountPoints.sync', payload: { mountPoints: mountPoints.list() } })
  }
  // immediate：init 时若已 connected（防御）立即发送；否则等待首次建连 / 重连进入 connected
  return watch(getWsState(), (s) => {
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
 * 幂等（registerFromContribution 同 id 覆盖），重连/重跑无害。watcher 生命周期随 init
 * dispose-and-rebuild（同 ensureMountPointsSync）。
 */
function ensureCommandDeclarationsSync(
  contributions: ContributionRegistry,
  commandRegistry: CommandRegistry,
): () => void {
  return watch(getWsState(), (s) => {
    if (s !== 'connected') return
    for (const c of contributions.getContributions()) {
      if (c.type === 'command' || c.type === 'slashCommand') commandRegistry.registerFromContribution(c)
    }
  }, { immediate: true })
}

/**
 * 插件 UI 快照条目 → bus 帧回放（ADR-0097 拉为主的三路同函数原则：快照回放与实时推送
 * 喂同一 store 订阅路径——条目按实时帧形状逐条 emit，窄化 / (scope, id) 分区写入 /
 * `[null]` 清除语义全部由既有订阅端承担，零新写入口、零语义复制）。
 * 视图条目归属二选一透传（U2）：sessionId（会话域）或 mountId（全局域）——ViewHostStore
 * 按 scope 形态落分区，generation 全量替换代际随帧透传。
 */
export function applyUiSnapshot(bus: InternalEventBus, snap: PluginUiSnapshotPayload): void {
  for (const payload of snap.headerActions) {
    bus.emit({ kind: 'plugin:headerActionUpdate', headerAction: payload })
  }
  for (const item of snap.views) {
    bus.emit({
      kind: 'extension-widget',
      ...(item.sessionId !== undefined ? { sessionId: item.sessionId } : { mountId: item.mountId }),
      widget: {
        viewId: item.viewId,
        pluginId: item.pluginId,
        guiTree: item.guiTree,
        ...(item.generation !== undefined ? { generation: item.generation } : {}),
      },
    })
  }
}

/**
 * 插件 UI 快照 connected 重放器（ADR-0097「拉为主、推补充」收敛通道；模式对齐
 * ensureMountPointsSync 同款 connected watcher）。
 *
 * plugin:headerActionUpdate / plugin:viewUpdate 是 transient 推送（不入 ring、无重放），
 * renderer 首屏 / 重载 / runtime 重启重连后状态由本重放器经 plugin.ui.snapshot 全量拉取
 * 恢复——「按钮显隐与 badge 与刷新前一致」（验收基准 3）。拉取失败（断连瞬间 reject）不
 * 中断：warn 后等下一次 connected 边沿重试（watch 对每次进入 connected 都触发）。
 */
function ensurePluginUiSnapshot(bus: InternalEventBus): () => void {
  return watch(getWsState(), (s) => {
    if (s !== 'connected') return
    getPluginUiSnapshot().then(
      (snap) => applyUiSnapshot(bus, snap),
      (e) => console.warn('[extension-host] plugin.ui.snapshot fetch failed:', e),
    )
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

/**
 * 插件 view 声明 → 容器位声明（容器扩展点统一 §6.1，清理与重放接线 U12/W-C-9）。
 *
 * 字段映射：label ← title（声明结构必填，插件文案自带原文 §6.16④）；renderer 恒为
 * kind:'view'（插件声明走推树通道，ViewHost 按 (sessionId, viewId) 消费；kind:'host' 的
 * 白名单命中形态只由宿主内置项使用，插件 view 声明没有 host 组件字段，无从命中）。
 * placement 是开放字符串（挂载点注册制）：不在此过滤位置族——注册表 loadExternal 内做
 * placement 词表校验（未知族判 unavailable + warnOnce，§5.4 判定表），桥内重复判定是第二份
 * 检查无增益。校验（§6.12 id / §6.9 上限 / §6.1 白名单 / placement 词表）统一在注册表做——
 * 桥内零校验逻辑，双注册表同一权威。
 */
function toContentSlotDeclaration(pluginId: string, v: PluginContributesView): ContentSlotDeclaration {
  return {
    id: v.id,
    placement: v.placement,
    label: v.title,
    ...(v.icon !== undefined ? { icon: v.icon } : {}),
    ...(v.order !== undefined ? { order: v.order } : {}),
    ...(v.emptyState !== undefined ? { emptyState: v.emptyState } : {}),
    scope: v.scope ?? 'session',
    pluginId,
    renderer: { kind: 'view', viewId: v.view ?? v.id },
  }
}

/**
 * 插件容器位声明的注册表操作（灌入/清理/重放共用同一入口）。
 *
 * 单一写路径：四个容器的派生视图同源于 core 模块级单例 contentSlotRegistry（§6.1 一份
 * 注册表；侧栏/设置页经 lib/content-slots 的 getContentSlotRegistry 访问同一实例，抽屉经
 * domain/drawer/content-slots 消费同一实例）——灌入与清理各只有这一个写点，无双权威、
 * 无成对写。
 */
function loadExternalContentSlots(descriptor: PluginDescriptorLike): void {
  const declarations = (descriptor.contributes?.views ?? []).map((v) =>
    toContentSlotDeclaration(descriptor.pluginId, v),
  )
  contentSlotRegistry.loadExternal(descriptor.pluginId, declarations)
}

function clearContentSlots(pluginId: string): void {
  contentSlotRegistry.clearForPlugin(pluginId)
}

// ── u4b（plugin-header-action-modal-points AP-1）渲染宿主的数据源契约 ──
//
// key 定义在本模块（对齐 SLASH_COMMAND_SOURCE_KEY 的「壳内定义、壳 provide、组件 inject」
// 先例），组件侧只认 key 不认实现；单测经 global.provide 注入 mock 源。

/** E13 命令可用性三态（HeaderActionsHost 灰置状态机的判定输入）。 */
export type HeaderActionCommandAvailability = 'registered' | 'unregistered' | 'unknown'

/** HeaderActionsHost 数据源（声明镜像 + per-session 运行时镜像 + E13/E3 执行侧）。 */
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

/** 可见声明形状（isVisibleHeaderAction type predicate 的收窄产物：headerAction 段非空）。
 * 导出义务：公开签名（type predicate）引用的类型必须可导入，否则 private-type-leaks 检查
 * 报泄漏。 */
export type VisibleHeaderActionRecord = ContributionRecord & {
  headerAction: NonNullable<ContributionRecord['headerAction']>
}

/**
 * headerAction 可见性谓词（单点）：声明缺省 / 运行时 hidden=true /
 * （依赖运行时推送的入口）未推送 且（无 activation 且）无 commandId 者不可见；
 * E13/E3 簿记只影响 disabled/tooltip 不影响可见性。
 *
 * 「未推送 = 不可见」fail-safe 的适用边界（容器扩展点统一 §6.3 连带明确）：该反转只约束
 * 依赖运行时推送的入口（scheduler-overlay 兼容值是徽标入口，任务计数经运行时推送）；
 * 结构化 activation（HeaderActionActivation 联合）是声明即存在的静态入口，自带可见性
 * 依据——要求它先推一次 updateHeaderAction 才可见是无意义仪式。两类的 hidden=true
 * 运行时开关一视同仁（显式推送过 hidden 即隐藏）。
 *
 * 缺省语义反转（ADR-0097 拉为主改造，2026-10-21 用户裁决）：runtimeState === undefined
 * （插件从未对该会话推送）= 不可见——「无任务不显示」契约的 fail-safe 形态。旧语义
 * 「未推送 = 显示」把未知态乐观渲染成有入口，是「无任务会话按钮常驻 + 空面板」缺陷的
 * 根因之一；反转后按钮只在插件明确声明存在（静态声明或有推送记录且非 hidden）时渲染。
 * 数据到达由 connected 边沿的 plugin.ui.snapshot 快照拉取保证（ensurePluginUiSnapshot），
 * 推送丢失不再导致该反转产生「有任务也漏显示」的常态。
 *
 * 消费点：HeaderActionsHost 的按钮渲染过滤（toHeaderActionButton 返回 null 的唯一判定源，
 * 用户直接可见的正确性权威侧）与 hasVisibleHeaderActions（托盘聚合面板段「有可见按钮才
 * 出段」+ 左簇密度 absent 判据）——可见性条件增删只改本函数，渲染与聚合判定构造性一致。
 */
export function isVisibleHeaderAction(
  decl: ContributionRecord,
  runtimeState: HeaderActionEntry | undefined,
): decl is VisibleHeaderActionRecord {
  const ha = decl.headerAction
  if (!ha) return false
  // 运行时 hidden 开关对两类入口一视同仁：显式推送过 hidden 即隐藏
  if (runtimeState?.hidden === true) return false
  // 结构化 activation = 声明即存在的静态入口（命令链或容器导航），不依赖运行时推送
  if (ha.activation !== undefined && ha.activation !== 'scheduler-overlay') return true
  // 徽标入口（scheduler-overlay 兼容值）与纯命令链入口依赖运行时状态推送：
  // 插件从未推送 = 该入口未被插件声明存在（fail-safe：未知态不渲染）
  if (runtimeState === undefined) return false
  return !!ha.activation || !!ha.commandId
}

/**
 * 「当前 session 下是否存在至少一个可见 headerAction 按钮」判定（composer 左簇密度聚合用：
 * L2 起左簇聚合时 headerAction 入口从左簇摘除、改在托盘聚合面板首段渲染——聚合面板段的
 * 发丝分隔线需要「有可见按钮才出段」的同源判定，见 ComposerTray）。可见性条件单点 =
 * isVisibleHeaderAction（与按钮渲染过滤同调），无独立判定副本。
 */
export function hasVisibleHeaderActions(source: HeaderActionsSource, sessionId: string): boolean {
  return [...source.getDeclarations()].some((decl) =>
    isVisibleHeaderAction(decl, source.getRuntimeState(sessionId, decl.contributionId)),
  )
}

/**
 * E13 判定的最小读侧（会话命令分区；结构契约而非 pinia store 全型——纯函数直测
 * 只需 getCommands，test-coverage SG-2 补防线时提出）。
 */
export interface CommandPartitionReader {
  getCommands(sessionId: string): Array<{ name: string }>
}

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
export function resolveHeaderActionAvailability(
  commandStore: CommandPartitionReader,
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
 *   void 后（生产调用方 main.ts 恒丢弃返回值），测试 afterEach dispose 与注册注入用例
 *   （contributions）取内部实例的唯一通道。dispose 回收本次装配（重复 init 前置调用 /
 *   测试 afterEach，幂等）：取消职责④在途去抖 timer + stop 各 connected 重放器 watcher +
 *   dispose bridge（防 bus 事件翻倍，项目规则#2；bus 上其余 controller 订阅随 app 生命
 *   周期存活，不在回收逻辑）。
 */
export const __testing = {
  lastInitHandles: null as null | {
    bridge: MessageBusBridge
    contributions: ContributionRegistry
    dispose: () => void
  },
}

/**
 * 装配 ExtensionHost bridge（main.ts 挂载前调用一次，app.provide 全局注入）。
 *
 * 生产语义返回 void：唯一调用方 main.ts 恒单语句调用、丢弃返回值（audit 清理点#9，
 * 原 9 字段返回对象系「供调试与后续接线」的未兑现赌注）。测试需要的内部句柄经
 * `__testing.lastInitHandles` 取（仅 bridge / contributions / dispose 有测试消费）。
 * 重复 init 幂等：dispose-and-rebuild（对齐 usePermissionRequest 习语）——先经
 * lastInitHandles.dispose 回收上一次装配的重放器 watcher 与 bridge 订阅再重建。
 */
export function initExtensionHostBridge(app: App): void {
  // 幂等：重复初始化先回收上一次装配（HMR/测试场景防 watcher 闭包绑定旧 registry 实例
  // 上报过期快照 + bridge 订阅翻倍，项目规则#2）
  __testing.lastInitHandles?.dispose()
  const bus = getExtensionBus() // IF1：复用模块级惰性单例（不再局部 new）
  const source = createWsPluginMessageSource()
  // bridge 构造即订阅 source（source.subscribe → handleMessage → bus.emit）
  const bridge = new MessageBusBridge({ source, bus })
  // MF-4 响应式桥（R2 补齐）：core store 是 headless 纯 Map 容器（刻意零 Vue 依赖），事件到达
  // mutate 纯 Map 不被 Vue computed 追踪 → ViewHost 永不重渲染。壳层两层 reactive 化：
  // ①外层 partitions 容器 reactive（createReactiveSessionScopedMap——分区后建也触发重算，
  //   修复「computed 首次求值短路 → 永久 stale」）；②分区值由 init 工厂返回 reactive 容器
  // （get/set 走 reactive proxy）。ViewHost.vue computed 的 getView/getItems 调用点即被追踪
  // （core 代码零改动）。
  const viewHostStore = new ViewHostStore({
    bus,
    sessionScoped: createReactiveSessionScopedMap(() => reactive(new Map<string, ViewCacheEntry>())),
  })
  viewHostStore.subscribe()
  const mountPoints = new MountPointRegistry()
  const contributions = new ContributionRegistry(bus)
  setExtensionRegistries({ mountPoints, contributions })
  // 声明通路订阅源（容器扩展点统一 §6.2）：config.plugins 订阅原语注入 bootstrap
  //（scanContributions 内建订阅——每次广播重跑 loadExternal + routeAll）。core bootstrap
  // 对 transport api 域保持 import 零依赖，订阅原语由壳装配注入（与 setExtensionRegistries
  // 同范式）；onPlugins 即 core transport api 的 config.plugins global 通道订阅。
  // 桥内包装单帧四职责（W-C-9 清理与重放接线，单订阅零双挂）：
  // ① 快照维护：最近一帧全量列表存 lastPluginListSnapshot——handlePluginBack 的 external
  //    重放数据源（重放信任 active 事件、不看快照 enabled 位：statusChange(active) 先于
  //    下一帧 config.plugins 到达，此刻快照可能仍是禁用帧，enabled 位过期不采信）；
  // ② 容器位灌入：启用插件的 view 声明转 ContentSlotDeclaration 注入注册表（幂等）——
  //    插件容器位的出现通路（handlePluginGone 清理 / handlePluginBack 重放与它成对）；
  // ③ 启用位过滤后喂 bootstrap：togglePlugin 成功/失败都广播全量列表（plugin-service
  //    broadcastPluginList，禁用插件的 contributes 被无条件透传），不过滤则「禁用 → E2 触发链
  //    清理 → toggle 广播帧 loadExternal 复活」先后必然发生（statusChange 先于列表帧），
  //    handlePluginGone 的清理被同一次用户操作撤回（E2 语义失效）。过滤在喂入侧单点生效，
  //    禁用插件的声明复活在 ContributionRegistry 与容器位注册表两条通路同时被堵；
  // ④ 差集收敛清理：② 只灌不清，清理唯一依赖 E2 触发链的 statusChange 广播
  //    （handlePluginGone）——WS 断连窗口内 runtime 侧完成插件禁用/卸载时该广播丢失，
  //    重连 initial-state 全量帧只重灌 enabled 项，禁用/缺席插件的旧声明残留容器位注册表
  //    （点击导航失败 warn 或打开过期视图）。每帧去抖计算注册表 external 分区 pluginId
  //    集合与末帧 enabled 集合的差集，对差集调 clearForPlugin——重连全量帧天然成为收敛点。
  //    去抖容忍 ① 所述乱序（active 事件重放后可能尾随 enabled=false 的过期列表帧）：
  //    末帧权威，相邻矛盾帧不在中间态上执行清理，避免误清刚启用插件。
  let lastPluginListSnapshot: PluginInfo[] = []
  // ④ 的去抖 timer 句柄：随 dispose 取消（teardown 后迟发清理会误清下一次装配灌入的声明）
  let reconcileExternalSlotsTimer: ReturnType<typeof setTimeout> | undefined
  setPluginListSource((handler) => onPlugins((plugins) => {
    lastPluginListSnapshot = plugins
    for (const p of plugins) {
      if (p.enabled === false) continue
      loadExternalContentSlots(p)
    }
    handler(plugins.filter((p) => p.enabled !== false))
    // ④ 差集收敛清理（每帧重调度，闭包捕获本帧 enabled 集 → 末帧权威）
    if (reconcileExternalSlotsTimer !== undefined) clearTimeout(reconcileExternalSlotsTimer)
    reconcileExternalSlotsTimer = setTimeout(() => {
      reconcileExternalSlotsTimer = undefined
      const enabledIds = new Set(
        plugins.filter((p) => p.enabled !== false).map((p) => p.pluginId),
      )
      const registeredIds = new Set(
        contentSlotRegistry.listEntries()
          .map((entry) => entry.declaration.pluginId)
          .filter((pluginId) => pluginId !== HOST_PLUGIN_ID),
      )
      for (const pluginId of registeredIds) {
        if (!enabledIds.has(pluginId)) clearContentSlots(pluginId)
      }
    }, RECONCILE_EXTERNAL_SLOTS_DEBOUNCE_MS)
  }))
  // 仅注入注册表：注册触发收敛为 bootstrap 第 4/5 步（App.vue onMounted 编排，u6 去重）——
  // 本装配点不再自行 registerMountPoints/scanContributions。

  // W3 slash 收编（D1 归一）：CommandRegistry 实例化（与 ViewHostStore 并列，03 文档 D3-3）。
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
  const stopCommandDeclarationsSync = ensureCommandDeclarationsSync(contributions, commandRegistry)
  // CommandPopover 数据源：resolveSlashCommands 合并源（registry 声明 ∪ commandStore pi 真源）。
  // 壳提供真实 registry 实现，组件注入（单测 global.provide mock）。
  app.provide(SLASH_COMMAND_SOURCE_KEY, {
    resolveSlashCommands: (piCommands) => commandRegistry.resolveSlashCommands(piCommands),
  })
  // MF-3：把挂载点整表上报 runtime（AC10）——插件 views.listMountPoints() 依赖此中继查询，
  // 不上报则恒返回 []（registerMountPoints 内部同步注册，list() 已含全部挂载点）。
  // MF-1（R2）：发送时点见 ensureMountPointsSync——init 时 WS 未建连，send 必被静默丢弃。
  const stopMountPointsSync = ensureMountPointsSync(mountPoints)
  // 插件 UI 快照 connected 重放器（ADR-0097）：headerAction/视图状态在首屏/重载/重连后
  // 由全量拉取恢复；实时推送仍承担运行中的即时性（失效提示）。
  const stopPluginUiSnapshotSync = ensurePluginUiSnapshot(bus)

  // unregistered-mount-point 订阅（容器扩展点统一 §7.2/§5.5——此前该事件零订阅）：
  // routeAll 对未注册挂载点的 emit 在此出声（失败路径第一行告警的现成 sink），按 §6.14
  // 去重键 warn 一次；插件管理页的逐贡献置灰由 toContributionInfos 承载（M16 既有）。
  const stopUnregisteredMountPointWarn = bus.on('unregistered-mount-point', (e) => {
    const key = `${e.pluginId}::${e.contributionId}::unregistered-mount-point`
    if (unregisteredMountPointWarned.has(key)) return
    unregisteredMountPointWarned.add(key)
    console.warn(
      `[extension-host] 贡献 ${e.pluginId}/${e.contributionId} 引用未注册挂载点 '${e.expectedMountPoint}'，已置灰——插件作者修正清单 placement 为已注册位置后恢复`,
    )
  })

  // ui 组件数据源（ViewHost 经 inject 取，壳 provide 真实实现；形状对齐 IF10 + U2）。
  // 会话域三法 = 托盘 widget 区既有消费面（sessionId 形态，壳内适配为 session scope）；
  // scope 联合两法 = ViewHost scope prop 消费面（全局域 Provider 页挂载位走此路径）。
  app.provide(VIEW_HOST_SOURCE_KEY, {
    getView: (sessionId, viewId) => viewHostStore.getView({ kind: 'session', sessionId }, viewId),
    // widget 视图消费方（Composer 托盘 widget 区）：枚举该 session 全部缓存 viewId（纯透传 core store）
    getViewIds: (sessionId: string) => viewHostStore.getViewIds({ kind: 'session', sessionId }),
    // 分区缺失自举补拉（ADR-0097 事件边沿拉）：ViewHost 挂载发现分区无内容时按
    // (sessionId, viewId) 过滤拉取（幂等读，无节流；断连 reject 静默 warn，实时帧或
    // 下次 connected 全量拉取收敛）
    refreshView: (sessionId: string, viewId: string) => {
      getPluginUiSnapshot({ sessionId, viewId }).then(
        (snap) => applyUiSnapshot(bus, snap),
        (e) => console.warn('[extension-host] plugin.ui.snapshot refreshView failed:', e),
      )
    },
    // U2 scope 联合消费面：全局域读 + 补拉（分区键 global:<mountId>:<pluginId>，
    // 过滤参数带插件维度）；会话域与上方三法同分区
    getViewInScope: (scope, viewId) => viewHostStore.getView(scope, viewId),
    refreshViewInScope: (scope: PluginViewScope, viewId: string) => {
      const filter = scope.kind === 'session'
        ? { sessionId: scope.sessionId, viewId }
        : { mountId: scope.mountId, pluginId: scope.pluginId, viewId }
      getPluginUiSnapshot(filter).then(
        (snap) => applyUiSnapshot(bus, snap),
        (e) => console.warn('[extension-host] plugin.ui.snapshot refreshViewInScope failed:', e),
      )
    },
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
          pluginId: c.pluginId,
        }))
      return staticViews
    },
  })
  // L2 原生视图路由表与 L2 tab badge 源已随「后台命令」native 视图退役
  // （composer-task-tray D10：托盘承接后台命令观察范围；PluginViewContainer 的
  // 同名分支同批删除）。plugin sidebar view 机制本身保留——
  // 上方 VIEWS_SOURCE_KEY + ViewHost 原路径即其消费方。
  // PluginSettingsPage 数据源（M16）：onPlugins 委托 api 域
  // （config.plugins 广播订阅），getContributions 委托 ContributionRegistry + MountPointRegistry
  // （toContributionInfos：未注册挂载点 → 置灰 + 原因，场景 E AC3）。
  app.provide(PluginSettingsDataSourceKey, {
    onPlugins,
    getContributions: (pluginId) =>
      toContributionInfos(contributions.getContributions({ pluginId }), mountPoints),
  })
  // CompanionBand 数据源：共享工厂（bus 'ui-request' 适配 + 回传双通道，FR2/FR7）。
  // C4 四键排除（form ∨ legacy askUser ∨ scheduleCreate ∨ planReview——form 类与审批请求
  // 各归 FormOverlay / PlanReviewBar，CompanionBand 只收简单 dialog）；requestIdSessions
  // 反查表生命周期（G1）由 factory 单点持有，泄漏语义文档见 shell-adapters.ts（双壳共同
  // 持有的同一不变量）。壳层能力回调：clearPendingSend 通路级收尾锚点（ADR-0073 D4a，
  // chatStore 现取——对齐 useExtensionUI 模块级回调先例，回调执行时 pinia 必已 active）+
  // 未送达壳层 toast（M1 环 3，队列 headless 无 UI，可见反馈归壳层）。
  const companionDialog = createCompanionDialogAdapters(bus, {
    onPiResponseSettled: (sessionId) => useChatStore().clearPendingSend(sessionId),
    notifyNotDelivered: (sessionId) => notifyUiResponseNotDelivered(sessionId),
  })
  app.provide(DIALOG_REQUEST_SOURCE_KEY, companionDialog.source)
  app.provide(UI_RESPONSE_TRANSPORT_KEY, companionDialog.transport)

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

  // headerAction 声明镜像：ContributionRegistry 是 headless 非响应 Map（组件 computed 无法
  // 追踪 clearForPlugin/registerBuiltin 的原地变化），shallowRef 整表替换供组件响应式消费。
  const headerActionDeclarations = shallowRef<ContributionRecord[]>([])
  const refreshHeaderActionDeclarations = (): void => {
    headerActionDeclarations.value = contributions.getContributions({ type: 'headerAction' })
  }
  refreshHeaderActionDeclarations()
  // 注册同步时机与 ensureCommandDeclarationsSync 同款（connected 后 bootstrap step5 声明已就绪）
  const stopHeaderActionsSync = watch(getWsState(), (s) => {
    if (s === 'connected') refreshHeaderActionDeclarations()
  }, { immediate: true })

  // E2 触发链：runtime plugin:statusChange / plugin:crashed 广播 → bus 事件 → 清理容器 +
  // 注销该插件命令（ContributionRegistry 无按插件枚举，先查后清）；disabled→active 重启用
  // 走静态表重放 + external 声明快照重放（W-C-9：重放数据源 = 桥内 config.plugins 订阅处
  // 维护的最近一帧快照——不再依赖下一次广播自然重放，禁用→启用即刻恢复）。
  const handlePluginGone = (pluginId: string): void => {
    const commandIds = contributions
      .getContributions({ pluginId })
      .filter((c) => c.type === 'command' || c.type === 'slashCommand')
      .map((c) => c.contributionId)
    contributions.clearForPlugin(pluginId)
    for (const id of commandIds) commandRegistry.unregisterCommand(id)
    headerActionStore.clearForPlugin(pluginId)
    // 容器位注册表同链清理（W-C-9）：不清则禁用后派生视图仍含该插件容器位（抽屉/侧栏/
    // 设置页四处；浮层插件内容不进标签条，构造性不受影响）。注册表内建 host 保护
    //（taiji-host 内置项不受影响），幂等；四容器同源单实例，本清理即全容器生效。
    clearContentSlots(pluginId)
    refreshHeaderActionDeclarations()
  }
  const handlePluginBack = (pluginId: string): void => {
    contributions.registerBuiltin()
    // external 声明快照重放（W-C-9）：从最近一帧 config.plugins 快照取该插件 descriptor
    // 重放（loadExternal 覆盖粒度幂等；ContributionRegistry 与容器位注册表同源重放）。
    // 快照缺失（安装后首帧未达即崩溃恢复等时序窗口）→ 跳过重放，等下一次 config.plugins
    // 广播自然重放（debug 出声不 warn——广播必然到达，非失败路径）。
    const descriptor = lastPluginListSnapshot.find((p) => p.pluginId === pluginId)
    if (descriptor !== undefined) {
      contributions.loadExternal([descriptor])
      loadExternalContentSlots(descriptor)
    } else {
      console.debug(`[extension-host] ${pluginId}: 快照无该插件 descriptor，external 声明待下一次 config.plugins 广播重放`)
    }
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

  // action-bar 执行器（AP-3）：ui 侧 ACTION_EXECUTOR_KEY（跨包 symbol 同一实例），
  // 实现 = core CommandRegistry.execute 包装（结构兼容 ui 最小接口，无 ui→core 依赖边）。
  app.provide(ACTION_EXECUTOR_KEY, {
    execute: (id, args) => {
      void commandRegistry.execute(id, args as Record<string, unknown> | undefined)
    },
  })
  // 容器导航执行器（容器扩展点统一 §6.4）：core 执行器装配后直接 provide（与 ui
  // CONTAINER_NAVIGATION_KEY 接口结构同构，零适配）。校验逻辑（全局 id 解析/族匹配/
  // 可打开性/params 标量/会话优先级）全在 core 执行器（container-navigation.test.ts 承载）；
  // 壳层装配两个端口的真实实现：
  // - lookup：容器位注册表（core 单例 contentSlotRegistry）的真实查询——resolveTargets 投影
  //   注册表 findById（全局 id 空间解析，§6.12）；查询前确保抽屉内置声明在册（内置装配
  //   既有触发点在抽屉首渲，导航点击可能先于首渲）。hasData 的按族数据事实查询（view 类
  //   = ViewHostStore 分区读）待声明面出现 openableWithoutData=false 成员时随端口扩形落地：
  //   现声明面无 false 成员（内置项恒 true、插件清单声明无该字段缺省 true），本端口仅
  //   false 声明可达——保守判无数据，不打开空容器（§5.4 行 7，warn 出声可诊断），不谎报。
  // - sink.openDrawerTab：接 core drawer coordination openDrawerTab（瞬时参数 + 开合态一次
  //   写入）。RightDrawerTab 已去枚举（开放 string，types.ts），目标存在性/族匹配已由执行器
  //   对注册表校验先行（§6.4 先校验后动作），tabId 直接透传。sessionId 形参为浮层级联
  //   （§6.8）保留统一签名：drawer 选中态分区键走 bindDrawerSessionId 绑定的焦点会话
  //   （ADR-0053 单例抽屉语义），本分支不消费。
  // - sink.openOverlayContent：接 core overlay 协调函数 openOverlayContent（内置 scheduler
  //   走既有组装，其余按声明 id 走 §6.8 plugin 载体；core 形参序 (contentId, sessionId)）。
  const containerNavigationExecutor = new ContainerNavigationExecutor({
    lookup: {
      resolveTargets: (tabId) => {
        ensureBuiltinsAssembled()
        return contentSlotRegistry.findById(tabId).map((d) => ({
          id: d.id,
          placement: d.placement,
          pluginId: d.pluginId,
          scope: d.scope,
          openableWithoutData: d.openableWithoutData ?? true,
        }))
      },
      hasData: () => false,
    },
    sink: {
      openDrawerTab: (_sessionId, tabId, params) => openDrawerTab(tabId, params),
      openOverlayContent: (sessionId, contentId) => openOverlayContent(contentId, sessionId),
    },
    // 焦点会话复用 drawer 域绑定（useSideDrawer 模块加载时绑到 panel store 的 focusedSessionId）
    getBoundSessionId,
  })
  app.provide(CONTAINER_NAVIGATION_KEY, containerNavigationExecutor)
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

  __testing.lastInitHandles = {
    bridge,
    contributions,
    // 回收本次装配（init 开头前置调用 / 测试 afterEach；watch stop 与 bridge.dispose 均幂等）
    dispose: () => {
      // 职责④在途去抖 timer 取消（teardown 后迟发清理会误清下一次装配灌入的声明）
      if (reconcileExternalSlotsTimer !== undefined) {
        clearTimeout(reconcileExternalSlotsTimer)
        reconcileExternalSlotsTimer = undefined
      }
      stopMountPointsSync()
      stopCommandDeclarationsSync()
      stopHeaderActionsSync()
      stopPluginUiSnapshotSync()
      stopUnregisteredMountPointWarn()
      bridge.dispose()
    },
  }
}
