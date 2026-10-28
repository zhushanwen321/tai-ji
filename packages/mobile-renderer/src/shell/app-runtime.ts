// app-runtime —— 移动壳 core 业务域组装单例（remote-use D10「core 业务域全复用」行的壳侧落点）。
//
// 移动壳无 pinia 业务 store（桌面 renderer 的 useChatStore/useSessionStore 是 pinia 包装），
// 直接组装 core 纯 factory：createChatStore/createSessionStore/createUseChat/createUseSession/
// createSessionFlow。ChatApiPort/SessionApiPort 在壳层适配 core transport api domains
// （与桌面 useChat.ts 的 chatApiPort、api/session-api-port.ts 同构——端口注入模式：core 定义
// 接口、壳注入实现）。
//
// 平台差异（相对桌面组装）：
// - toast → 全局错误条（./error-bar 单槽单例；core toast 契约 { error, warning } 的移动
//   呈现通道，remote-use A7/U14——revoke/stop/bash/compact 等 RPC 失败情形对用户可见）
// - panel/navigation/hooks → no-op（移动壳无 panel/导航 store；SessionEntryPort 全成员
//   可选缺省 no-op、链零新增步骤可跑，sessionEntry 订阅/LRU 步已接线——remote-use D2）
// - turn 展开 → 壳内 per-session Map 分区（ADR-0049 范式；桌面 useTurnExpansion 的 mobile 子集）
import { reactive, ref, type Ref } from 'vue'
import {
  createChatStore,
  createSessionFlow,
  createSessionLiveState,
  createSessionStore,
  createUseChat,
  createUseSession,
  ensureStreamSubscription,
  evictLruWithUnsubscribe,
  getPlatform,
} from '@taiji/core'
import type {
  ChatApiPort,
  EnsureStreamSubDeps,
  SessionApiPort,
  SessionEntryPort,
  SessionStoreLike,
  UseChatDeps,
} from '@taiji/core'
import * as chatApi from '@taiji/core/transport/api/domains/chat'
import * as sessionApi from '@taiji/core/transport/api/domains/session'
import * as modelApi from '@taiji/core/transport/api/domains/model'
import * as projectApi from '@taiji/core/transport/api/domains/project'
import { command, onGlobalType, RPC_BACKSTOP_TIMEOUT_MS } from '@taiji/core/transport/api'
import { registerSessionCleanup } from '@taiji/core/foundation/use-session-scoped-state'
import { createComposerInjectionStore } from '@taiji/core/domain/composer/context'
// 队列编辑锚定判定（chat-flow-consistency D6：单锚定不变式 core 下沉，桌面 composer-shell 同源）
import { clearQueueEdit, startQueueEdit, type QueueEditAnchorPartition, type QueueEditStartOutcome } from '@taiji/core/domain/composer'
import { showErrorBar } from './error-bar'
import type { DeliveryCancelReply, DeliveryEditReply, DeliveryPeekReply, DeliveryResyncReply, ModelInfo, ProjectStoreState, ProviderId, Segment, SessionSummary, SubagentRecord } from '@taiji/shared'
import { normalizeContent } from '@taiji/shared'
import { i18n } from '../i18n'

// vue-i18n 的 t 复杂重载收窄为 (key, params?) => string（对齐 renderer useChat.ts tFn 形态）
const t = i18n.global.t as (key: string, params?: Record<string, unknown>) => string

// ── 端口适配（core transport api → ChatApiPort/SessionApiPort）──────────

/** ChatApiPort 实现：方法引用稳定（模块级函数），组装一次复用 */
const chatApiPort: ChatApiPort = {
  // 端口适配：ChatApiPort.send 无 images 概念（web 移动壳无 Cmd+V 富呈现落盘通路），
  // options.clientUuid（session-occupancy D2）经第 4 参透传（对齐桌面 chatApiPort 形态）
  send: (sid, text, options) => chatApi.send(sid, text, undefined, options),
  // [投递所有权内核 u3b] 统一提交入口（delivery.submit）：lane（direct/steer/queued）由
  // runtime 内核判定——壳只提交不判定。旧 steer/followUp 客户端封装随 u3b 退役，busy/
  // compacting 期提交由内核排队承接（原本地 defer 队列 flush 的「首条 send 其余 steer」
  // 语义由内核 lane 判定同义接管）。
  submitDelivery: (sid, content, clientUuid, images, segments) =>
    chatApi.submitDelivery(sid, content, clientUuid, images, segments),
  // `@` 定向消息分流实现在 session 域（session.subagentAction RPC），经端口暴露给发送链路
  subagentAction: (sid, action, params) => sessionApi.subagentAction(sid, action, params),
  // 撤回已送达消息（session.revokeMessage RPC，消息撤回 D2）：实现在 session 域，
  // 经端口暴露给 useChat.revokeMessage 的已送达分支（与 subagentAction 的跨域暴露同理）
  revokeMessage: (sid, targetId) => sessionApi.revokeMessage(sid, targetId),
  // 撤回在途条目（delivery.cancel RPC，内核 D6 统一入口的在途路由路径）
  cancelDelivery: (sid, clientUuid) => chatApi.cancelDelivery(sid, clientUuid),
  abort: chatApi.abort,
  compact: chatApi.compact,
  bash: chatApi.bash,
  abortBash: chatApi.abortBash,
  getHistory: chatApi.getHistory,
  streamSubscribe: chatApi.streamSubscribe,
}

/** SessionApiPort 实现（对齐桌面 api/session-api-port.ts 的全量代理形态） */
const sessionApiPort: SessionApiPort = {
  list: () => sessionApi.list(),
  switchSession: (id) => sessionApi.switchSession(id),
  // 第 7 参 clientUuid = create 幂等键透传（remote-use A17/U18：per-open 黏滞槽，
  // 生成/重置在 NewTaskSheet，本端口只逐参透传——此前缺参致移动创建流无幂等键）
  create: (cwd, label, presetId, projectId, modelOverride, thinkingOverride, clientUuid) =>
    sessionApi.create(cwd, label, presetId, projectId, modelOverride, thinkingOverride, clientUuid),
  rename: (id, label) => sessionApi.rename(id, label),
  remove: (id) => sessionApi.remove(id),
  // [u-renderer-entry] 归档 RPC 透传（SessionApiPort 必选成员；移动壳无归档 UI 入口，
  // 端口形状对齐——createUseSession.archiveSession 编排可用）
  archive: (id) => sessionApi.archive(id),
  // [remote-use A3/U12] dead 会话显式重开 RPC 透传（session.restore）——恢复三步编排原语之一
  restoreSession: (id) => sessionApi.restoreSession(id),
  removeByCwd: (cwd) => sessionApi.removeByCwd(cwd),
  migrateImage: (p) => sessionApi.migrateImage(p),
  onConfigSessions: (handler) =>
    onGlobalType('config.sessions', (msg) => handler(msg.payload.groups)),
  // [W2 权威拉取与冷读] session.getState 直发（对齐桌面 api/session-api-port.ts:51-54：
  // 不经 session 域代理，经 command 原语直发）。移动壳缺此成员时 core use-session 的
  // refreshLiveState 首行门控 `if (!liveState || !getState) return` 恒命中，三时机拉取
  // 整体跳过，而状态层唯一写入方是 useChat 的 liveState dep（冷会话无 state_changed 帧，
  // registerReplicatedStates 只在 onSessionRegistered 调）——模型/思考档标签恒空。
  // reply 与 request 同名、payload 消费型；会话不存在 = SESSION_NOT_FOUND reject
  // （core 侧显式未知保持，不回退其他会话的值）。
  getState: (id: string) =>
    command('session.getState', { sessionId: id }, RPC_BACKSTOP_TIMEOUT_MS),
}

// ── store / composable 单例（模块级；移动壳单实例应用）──────────────────

const chatStore = createChatStore()
const sessionStore = createSessionStore()
// [W1 会话架构四层分离] 会话运行时状态层（core 纯 factory，与 createSessionStore 同位置组装）：
// modelId / thinkingLevel 的唯一权威落点——按会话 id 寄存，与列表成员资格无关。
const liveStateStore = createSessionLiveState()

// [投递所有权内核 u3b] 原本地 compact defer 队列（CompactQueueLike 内存实现 + flush 逐条
// 提交）已随 core defer 队列状态机整体退役：UseChatDeps 不再有 getCompactQueue 成员，
// useChat 编排不再 enqueue/flush，busy/compacting 期提交统一经 delivery.submit 由 runtime
// 内核排队（lane 判定 + 逐条投递 + 断连 resync 对账全在内核侧）——壳侧再持队列即无人
// 触发的死代码，静默积压反成新风险。

/** 提交链路共享的通道 deps 基座（buildUseChatDeps spread 后补专属字段） */
type CoreChannelDeps = Pick<UseChatDeps, 'chatApi' | 'writeSegments' | 'toast' | 't'>

// core toast 通道的移动呈现（remote-use A7/U14 接线）：单点定义、两处注入共用
// （coreChannelDeps 与 subDeps 引同一对象，防 toast 通道漂移回 console）。error/warning
// 同入错误条单槽（移动壳无分级 toast 组件，可见性优先；core 传入文案已经 deps.t 翻译，
// 直入错误条无需二次处理）。
const errorBarToast: UseChatDeps['toast'] = { error: showErrorBar, warning: showErrorBar }

function coreChannelDeps(): CoreChannelDeps {
  return {
    chatApi: chatApiPort,
    writeSegments: (payload) => sessionApi.writeSegments(payload),
    toast: errorBarToast,
    t,
  }
}

/** createUseChat 实例（UseChatDeps 全量注入；对齐桌面薄包装的 deps 面） */
function buildUseChatDeps(): UseChatDeps {
  return {
    ...coreChannelDeps(),
    getChatStore: () => chatStore,
    getSessionStore: () => sessionStore as SessionStoreLike,
    getLiveStateStore: () => liveStateStore,
  }
}

const useChatInstance = createUseChat(buildUseChatDeps())

// ── turn 展开状态（桌面 useTurnExpansion 的 mobile 子集，per-session Map 分区）──────

/** per-session turn 展开分区：turnKey 展开集合（isTakeover/setTakeover 是 optional 字段，
 *  移动壳按 D10 不 provide，分区无接管态）。
 *  登记表主表 #54（声明处 @data-owner #54）——纯本地 UI 交互态（无 runtime 权威），
 *  写口 toggle 封闭于 createTurnExpansion，清理挂 registerSessionCleanup。
 *  [remote-use C3] collapse 写口已退役删除（会话结束 collapse 接线退役、ChatViewDeps.collapse
 *  成员已删，手动展开清除仅两路径——grep 零调用方核实后删除）。
 */
// @data-owner #54 —— 主表 #54 mobile 壳 turn 展开分区
const turnExpansionMap = new Map<string, Set<string>>()

// [remote-use A15/U12] turn 展开分区挂 session 销毁注册表（registerSessionCleanup——
// useSessionScopedState 模块级 registry，triggerSessionCleanups 遍历；形态与桌面
// turn-expansion store 同构：自管 Map 分区 + 显式注册删除路径清理）。消费点 = 删除编排
// （deleteSession → core cleanupSessionState → triggerSessionCleanups）；exited 分通道重置
// （resetCompanionChannelsForExitedSession）不触本表——turnExpansion 非请求态，不进 exited
// 编排（设计 D5 去留表）。桌面同样只在删除路径清（A15 残留登记口径）。
registerSessionCleanup((sid) => {
  turnExpansionMap.delete(sid)
})

/** turn 展开派生面（MobileMessageStream 按 sessionId 分区消费） */
export function createTurnExpansion(sessionId: Ref<string>) {
  return {
    isExpanded: (turnKey: string): boolean => turnExpansionMap.get(sessionId.value)?.has(turnKey) ?? false,
    toggle: (turnKey: string): void => {
      let p = turnExpansionMap.get(sessionId.value)
      if (!p) {
        p = new Set()
        turnExpansionMap.set(sessionId.value, p)
      }
      if (p.has(turnKey)) p.delete(turnKey)
      else p.add(turnKey)
    },
  }
}

// ── createUseSession（session 列表编排；panel/navigation/hooks 未接线点 no-op）────────

const noop = (): void => {}

// ── sessionEntry 端口束（remote-use D2/U5）：切入链流订阅/LRU 步接线 ──
// 对齐桌面 useSidebar 的 sessionEntry 注入形态（S1/S7 修复主体）：此前移动壳不注入
// sessionEntry，切入链步 5 订阅静默退化为 no-op——只看不发无 live 订阅（症状②），
// touchRecency/evictLru 同缺（症状连带：消息分区内存无界）。
// - ensureStreamSubscription：core 模块级原语 4 参形态（桌面经 renderer 薄包装 3 参，
//   移动壳无包装层，deps 就地构造——chatApi/toast/t 与 coreChannelDeps 同源）
// - touchRecency：chat store LRU 透传（一行接线，D2 采用段口径）
// - evictLru：core 驱逐+退订复合入口（evictIfNeeded + invalidateStreamSubscription +
//   session.unsubscribe RPC），双壳共接防分叉；unsubscribe 通道注入 transport session 域
// - cancelActiveFlow/preloadFileTree/clearUnread 不注入——缺省 no-op（use-session 链内
//   ?? noop 解析）：移动壳无 new-task flow 活跃取消面 / 文件树 / 未读体系（未读属 W4）
const subDeps: EnsureStreamSubDeps = {
  chatApi: chatApiPort,
  liveState: liveStateStore,
  toast: errorBarToast,
  t,
}

const sessionEntry: SessionEntryPort = {
  ensureStreamSubscription: (sid) =>
    ensureStreamSubscription(sid, chatStore, sessionStore as SessionStoreLike, subDeps),
  touchRecency: (sid) => chatStore.touchLru(sid),
  evictLru: () => evictLruWithUnsubscribe(chatStore, { unsubscribe: sessionApi.unsubscribe }),
}

const useSessionInstance = createUseSession({
  store: sessionStore,
  api: sessionApiPort,
  panel: {
    focusedSessionId: () => sessionStore.activeId.value,
    activePanelId: () => null,
    findPanelBySession: () => null,
    loadSession: noop,
    openPanel: noop,
  },
  navigation: { push: noop },
  chat: {
    getHistory: (sid) => chatApiPort.getHistory(sid),
    isHydrated: (sid) => chatStore.isHydrated(sid),
    hydrate: (sid, messages) => chatStore.hydrate(sid, messages),
    reconcileHistory: (sid, messages, window) => {
      // [chat-flow-consistency C4 两段式契约] 磁盘重载基线接管点清 turn 展开分区（移动壳
      // turnExpansionMap 同构桌面 turn-expansion store 的重置侧）：本映射是切入链全部
      // history 写入通路的单点，未 hydrate（首次切入 / LRU 驱逐后切回）= 走盘重载形态，
      // 重载换 id 空间，显式清替代静默键失配；已 hydrate（驻留期切回 reconcile 刷新）不清，
      // 展开保持。门与 store.reconcileHistory 内部的 hydrate 分支同源。
      if (!chatStore.isHydrated(sid)) turnExpansionMap.delete(sid)
      chatStore.reconcileHistory(sid, messages, window)
    },
    clearHistoryError: (sid) => chatStore.clearHistoryError(sid),
    markHistoryFailed: (sid) => chatStore.markHistoryFailed(sid),
  },
  // 移动壳无 panel/subagent/workflow 等跨 store 清理面；chat 分区清理照常（内存治理同语义）
  hooks: {
    clearFileTree: noop,
    clearSubagent: noop,
    clearWorkflow: noop,
    clearExtensionUI: noop,
    clearExtensionHost: noop,
    evictChat: (sid) => chatStore.evictSessionWithVirtual(sid),
    evictVirtualKeys: noop,
    clearAgentCallMapping: noop,
    disposeChat: (sid) => useChatInstance.disposeSession(sid),
    invalidateStatus: noop,
    browserDestroy: noop,
    // [W1 会话架构四层分离] 状态层条目显式清退（只挂真删除；归档不挂——同 core 契约）
    clearLiveState: (sid) => liveStateStore.removeLiveState(sid),
  },
  // D2/U5：sessionEntry 端口束注入——切入链 12 步的订阅/LRU 步在移动壳生效（对齐桌面）
  sessionEntry,
  // [W2 权威拉取与冷读] 状态层：session.getState reply 的唯一落点（与状态消息 /
  // 操作回执共用 applyLiveState 这一个 reducer，设计 §7 验收项 8）。缺省不注入时
  // refreshLiveState 整体跳过（缓存缺失门控拉取不生效），与上方 sessionApiPort.getState
  // 成对缺失——冷会话模型/思考档标签恒空（对齐桌面 useSidebar 注入形态）。
  liveState: liveStateStore,
})

// ── 新建任务（createSessionFlow 直组；v2 §6.12 项目 chip 主路径 + 手输兜底）────────

export interface MobileNewTaskInput {
  /** 项目路径（表单手输或项目 chip cwd 派生，必填） */
  cwd: string
  /** 首条消息文本 */
  firstMessage: string
  /**
   * 创建幂等键（remote-use A17/U18，per-open 黏滞槽）：同一「新建任务」意图的失败重试
   * 复用同键，runtime 按 clientUuid 幂等返回已建 session（弱网超时重试不双建）。生成与
   * 重置（提交成功/关闭）由表单层按意图生命周期负责——本函数只透传 createSessionFlow。
   */
  clientUuid?: string
  /**
   * 归属 project id（remote-use-mobile-v2 §6.12 NewTaskSheet 项目 chip 选中透传；
   * 缺省 = 未归类走默认项目兜底，与手输路径同语义）。
   */
  projectId?: string
}

/**
 * 新建任务并发布首条消息（createSessionFlow 接线）：
 * 创建（含 appendSession）→ 激活为新当前 session → core useChat.send 发首条消息
 * （乐观气泡由 send 编排内置）。返回新 session（guard 命中未创建时 null）。
 */
export async function createMobileTask(input: MobileNewTaskInput): Promise<SessionSummary | null> {
  const cwd = input.cwd.trim()
  const text = input.firstMessage.trim()
  if (cwd === '' || text === '') return null
  const segments: Segment[] = [{ type: 'text', text }]
  const result = await createSessionFlow(
    {
      store: sessionStore,
      api: sessionApiPort,
      // 移动壳表单 cwd 手输必填，defaultCwd 不参与兜底（空串触发 INV-7/E7 降级提示）
      defaultCwd: '',
      onCwdFallback: (reqCwd, actualCwd) => {
        console.warn(`[mobile-task] cwd fallback: requested="${reqCwd}" actual="${actualCwd}"`)
      },
    },
    {
      cwd,
      segments,
      clientUuid: input.clientUuid,
      // §6.12 项目 chip 选中归属（D14 创建时归属语义；缺省 undefined = 默认项目兜底）
      projectId: input.projectId,
    },
  )
  if (!result) return null
  sessionStore.setActiveId(result.session.id)
  // 首条消息发送失败不回滚创建（session 已存在）；用户已切入聊天视图可重发
  try {
    await useChatInstance.send(result.session.id, result.migratedSegments)
  } catch (e) {
    // 降级策略：session 创建已成功，发送失败仅记录（乐观气泡由 core send 编排回滚），
    // 不上抛——上抛会让表单误报「创建失败」，而实际失败情形只是首条消息投递
    console.error('[mobile-task] first message send failed:', e)
  }
  return result.session
}

// ── 导出（组件层消费方）──────────────────────────────────────────────
// 仅暴露组件/测试实际消费的符号；useSessionInstance 与两个 api 端口是文件内组装细节，
// 去 export 防「导出清单 = 公开 API」的假象（外部断链由本文件 import 图自证）。

export { chatStore, liveStateStore, sessionStore, useChatInstance }

/**
 * 流订阅全套重建原语的壳侧绑定（ensureStreamSubscription 的 4 参形态收窄为 1 参）：
 * 消费方 = bootstrap 的 lifecycleEffects.ensureStream 注入（session.exited 恢复窗口——
 * events handler 重挂 + bus 订阅一步完成，A5 缺陷修复）。与 sessionEntry 同源同参
 * （deps 就地 const，非公开 API 面）。
 */
export function ensureStreamFor(sid: string): void {
  ensureStreamSubscription(sid, chatStore, sessionStore as SessionStoreLike, subDeps)
}

/**
 * 会话运行时状态读口（[W1] 状态层薄壳的移动形态）：
 * `modelId` / `thinkingLevel` 读状态层，缓存缺失返回 undefined（显式未知——视图显示
 * 显式未知占位，不回退列表种子字段/其他会话的值）。
 */
export function liveStateOf(id: string): { modelId?: string; thinkingLevel?: string } | undefined {
  return liveStateStore.liveStateOf(id)
}

/**
 * 队列条目取消（remote-use D7/U10）：delivery.cancel RPC 透传（本文件 chatApiPort
 * 已接线的同一出口，QueueStrip 组件消费方）——内核收回-重投/不可撤判定全在 runtime
 * 单点，壳只透传 reply。
 */
export function cancelDelivery(sessionId: string, clientUuid: string): Promise<DeliveryCancelReply> {
  return chatApiPort.cancelDelivery(sessionId, clientUuid)
}

/**
 * 条目全文取回（chat-flow-consistency D6）：✎ 编辑预填只读通道（QueueStrip 消费）。
 * 直调 core transport chat 域（chatApiPort 无 peek/edit 成员——端口面不扩，移动壳直引
 * 与 cancelDelivery 透传形态平行）。
 */
export function peekDelivery(sessionId: string, clientUuid: string): Promise<DeliveryPeekReply> {
  return chatApi.peekDelivery(sessionId, clientUuid)
}

/** 原位编辑（chat-flow-consistency D6）：发送侧替换条目内容且排队位置保持不变（Composer 消费）。 */
export function editDelivery(
  sessionId: string,
  clientUuid: string,
  content: string,
  segments?: Segment[],
): Promise<DeliveryEditReply> {
  return chatApi.editDelivery(sessionId, clientUuid, content, segments)
}

/**
 * 取消全文回输入框的一次性注入通道（remote-use D7/U10，core composer injection factory
 * 平台无关单例——桌面 renderer composer-injection-store 同范式）：QueueStrip（写入侧，
 * 取消应答全文）与 Composer（消费侧，insertTextAtCursor 光标插入）跨组件树共享。
 * 通道 text 单值语义（无 segments 承载位）：移动壳产不出 chip（无 slash 浮层/file 注入源/
 * 图片粘贴降级文本），cancel reply segments 的 chip 恢复面在移动壳为零，零丢失。
 */
export const composerInjectionStore = createComposerInjectionStore()

// ── 队列编辑锚定（chat-flow-consistency D6 移动壳最小形态）────────────────────────
// 锚定 = 队列条目 ✎ 编辑时草稿记住来源条目 id，发送走 delivery.edit 原位替换。分区实现
// 沿 turnExpansionMap 同款（模块级 Map + registerSessionCleanup——桌面是 useSessionScopedState
// 分区，平台差异在容器、判定逻辑 core queue-edit-anchor 双壳同源）。会话删除随 cleanup 清理
//（Q4 裁决 1：锚定随草稿分区存活，切走留在分区、切回恢复）。
// 登记条目 #79（data-source-registry §1）：会话队列编辑锚定分区（合并时与 dev 侧既有
// #76 会话运行时状态层撞号，registry 侧本条已改号 #79，代码注解随行）
// @data-owner #79
const queueEditAnchorMap = new Map<string, QueueEditAnchorPartition>()

registerSessionCleanup((sid) => {
  queueEditAnchorMap.delete(sid)
})

function anchorPartitionOf(sid: string): QueueEditAnchorPartition {
  let p = queueEditAnchorMap.get(sid)
  if (!p) {
    // 分区对象必须 reactive（桌面 useQueueEditAnchor 的 anchorState 同款）：QueueStrip 的
    // 编辑提示条 computed（queueEditAnchorOf 消费）与离场自动解除 watch 依赖 clientUuid
    // 读写的响应式追踪——普通对象下锚定写入不触发重渲染/重算，提示条永不显示、离场
    // 解除失效（编辑态对用户不可见 = D6 契约在移动壳失效）。
    p = reactive<QueueEditAnchorPartition>({ clientUuid: null })
    queueEditAnchorMap.set(sid, p)
  }
  return p
}

/** ✎ 编辑登记（单锚定不变式：started / already-editing-same / conflict——Q4 三裁决）。 */
export function beginQueueEdit(sid: string, clientUuid: string): QueueEditStartOutcome {
  return startQueueEdit(anchorPartitionOf(sid), clientUuid)
}

/** 解除锚定（放弃编辑 / 发送完成 / 条目离场共用）。 */
export function clearQueueEditFor(sid: string): void {
  clearQueueEdit(anchorPartitionOf(sid))
}

/** 当前锚定的条目 id（null = 非编辑态；Composer 发送分流读口）。 */
export function queueEditAnchorOf(sid: string): string | null {
  return anchorPartitionOf(sid).clientUuid
}

/**
 * 测试后门命名空间（生产代码禁止消费，对齐 companion-bridge __testing 先例）：
 * 装配检查的断言入口——sessionEntry 端口束注入点（三成员非 no-op + 缺省成员无键，
 * D2/U5 装配断言；U21 装配检查 helper 双壳测试将复用同一出口）。
 */
export const __testing = {
  sessionEntry,
  /** toast 通道装配断言出口（U14/A7：core 两处注入的 toast = 错误条通道，非 console） */
  errorBarToast,
  /** SessionApiPort 装配断言出口（[u-renderer-entry] 归档 RPC 透传等端口成员形状锁定） */
  sessionApiPort,
}

/** 当前激活 session（响应式） */
export const activeSessionId = sessionStore.activeId

/** session 列表扁平视图（响应式派生，列表页消费） */
export const sessionList = sessionStore.list

/** 载入 session 分组列表（App 挂载 / 列表页刷新入口；错误态落 store.listLoadError） */
export function loadSessions(): Promise<void> {
  return useSessionInstance.loadSessions()
}

/** 切换当前 session（useSession 12 步切入链 headless 形态：switch → hydrate → 激活） */
export function selectSession(id: string): Promise<void> {
  return useSessionInstance.selectSession(id)
}

/**
 * 重命名 session（remote-use A4/U12）：core renameSession（rename RPC + applySnapshot
 * 乐观更新，权威经 config.sessions 广播回流）。
 */
export function renameSession(id: string, label: string): Promise<void> {
  return useSessionInstance.renameSession(id, label)
}

/**
 * 删除 session 编排（remote-use A4/U12）：core deleteSession = 销毁唯一编排点——
 * remove RPC → cleanupSessionState（跨 store 分区释放）→ triggerSessionCleanups
 * （销毁语义：dialog 工厂实例 cleanup + form/turnExpansion 注册项一次全清，对齐桌面
 * useSidebar.deleteSession）。与 exited 分通道重置（resetCompanionChannelsForExitedSession，
 * 重置语义）的语义分界见设计 D5「exited 清理与拦截解绑」段：删除 = 会话永久消失，
 * deletedSids 迟到写拦截是防御目标；exited = 会话恢复期新请求合法，清理与拦截解绑。
 */
export function deleteSession(id: string): Promise<void> {
  return useSessionInstance.deleteSession(id)
}

/**
 * dead 会话恢复三步编排（remote-use A3/U12，与桌面 useSidebar.restoreSession 同构——
 * 三步均为既有原语，编排短小不上收 core）：
 * ① restore RPC（session.restore 显式重新 spawn pi；失败上抛由调用方呈现）；
 * ② 12 步切入链（失败不阻断 revive：restore 成功 = runtime 侧 spawn+attach 已完成，
 *   revive 是 UI 死态清除，与切入成败解耦——不 revive 会留「进程已恢复、列表仍置灰」
 *   半完成窗口；降级出声对齐桌面 restoreSession 的 catch 分支）；
 * ③ revive（dead→idle 统一收尾；非 dead 真态不被本地覆盖——core store.revive guard）。
 */
export async function restoreSession(id: string): Promise<void> {
  // 本文件构造 sessionApiPort 时必含 restoreSession 成员（上方实现对象字面量），构造性非空
  await sessionApiPort.restoreSession!(id)
  try {
    await selectSession(id)
  } catch (e) {
    // 降级策略（对齐桌面 useSidebar.restoreSession 同分支）：切入失败不阻断 revive、
    // 不重抛——restore 成功后 revive 是 UI 死态清除，与切入成败解耦；一次性编排失败
    // 用 console 留痕，不占用 core toast 通道的错误条单槽（错误条留给 core 失败情形文案）
    console.warn(`[app-runtime.restoreSession] selectSession(${id}) failed after restore:`, e)
  }
  sessionStore.revive(id)
}

/**
 * 重连对账出口（remote-use U9 / A6）：connected 边沿对当前已 hydrate 会话经 core 统一
 * 编排入口刷新历史（getHistory + reconcileFromReply——historyWindowFromReply 窗口归一 +
 * persistImagesNewestFirst 图片落盘随行，与切入链步 9 已 hydrate 分支同一入口）。
 * 未 hydrate 会话 no-op（首次回填属切入链职责）。禁壳内直调 chat 端口裸 reconcileHistory：
 * 窗口参数丢致 A2 已加载更早历史被基线清掉 + toolResult 图片不落盘（U9 归并依据①②）。
 */
export function refreshHistory(id: string): Promise<void> {
  return useSessionInstance.refreshHistory(id)
}

// ── 偏好读写接线段（u-shell-skeleton；§6.16 键盘 / §6.17 偏好持久化）────────────────
// 偏好持久化 = localStorage（键 taiji.mobile.prefs 单 JSON 键），读写经既有 PlatformPort.storage
// 端口（测试注入内存实现）；应用 = 根节点 data-theme / data-font-size 槽位（tokens.css 与
// ui 包 mobile-tokens.css 双槽位均已定义），切换即时生效不重挂载。错误处理契约（§7.4）：
// 偏好属辅助功能——读写失败静默回默认（platform 未注入 / storage 抛 / JSON 坏 / 形状不对）。

/** 移动壳用户偏好（§6.17：主题深/浅 + 字号三档；键域封闭，新增偏好项先扩此表） */
export interface MobilePrefs {
  theme: 'dark' | 'light'
  fontSize: 'small' | 'medium' | 'large'
}

/** 偏好在 PlatformPort.storage 的持久键（单 JSON 键；登记 = data-source-registry 主表
 *  #80 mobile 壳用户偏好） */
export const MOBILE_PREFS_STORAGE_KEY = 'taiji.mobile.prefs'

export const DEFAULT_MOBILE_PREFS: MobilePrefs = { theme: 'dark', fontSize: 'medium' }

/** 存储值形状守卫：字段级校验（不认识的值落默认），坏形状整体回默认 */
function isMobilePrefsShape(value: unknown): value is MobilePrefs {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return (
    (v.theme === 'dark' || v.theme === 'light') &&
    (v.fontSize === 'small' || v.fontSize === 'medium' || v.fontSize === 'large')
  )
}

/** 读偏好（容错回默认）：platform 未注入 / storage 抛 / JSON 坏 / 形状不对 → DEFAULT_MOBILE_PREFS */
export async function loadMobilePrefs(): Promise<MobilePrefs> {
  try {
    const raw = await getPlatform().storage.get(MOBILE_PREFS_STORAGE_KEY)
    if (raw === null) return { ...DEFAULT_MOBILE_PREFS }
    const parsed: unknown = JSON.parse(raw)
    return isMobilePrefsShape(parsed) ? parsed : { ...DEFAULT_MOBILE_PREFS }
  } catch (e) {
    // 降级策略（best-effort 读取）：偏好属辅助功能，读写失败静默回默认（§7.4 错误处理
    // 契约——接入点降级不许辅助故障拖垮核心）；warn 留排障依据，不向上传播。
    console.warn('[app-runtime] loadMobilePrefs failed, falling back to defaults:', e)
    return { ...DEFAULT_MOBILE_PREFS }
  }
}

/**
 * 合并写偏好：读当前（容错）→ 浅合并 → storage.set。写失败降级 warn 不上抛（对齐
 * LocalStorageKV 降级语义——Safari 隐私模式等受限环境偏好本轮内存生效，刷新后回默认）。
 * 返回合并后的值（调用方据此驱动 UI 态，不依赖 storage 落盘成功）。
 */
export async function saveMobilePrefs(patch: Partial<MobilePrefs>): Promise<MobilePrefs> {
  const current = await loadMobilePrefs()
  const merged: MobilePrefs = { ...current, ...patch }
  try {
    await getPlatform().storage.set(MOBILE_PREFS_STORAGE_KEY, JSON.stringify(merged))
  } catch (e) {
    // 降级策略（best-effort 持久化，对齐 LocalStorageKV 降级语义）：Safari 隐私模式等受限
    // 环境写失败不向上传播——本轮内存生效（返回值驱动 UI），刷新后回默认；warn 留排障依据。
    console.warn('[app-runtime] saveMobilePrefs persist skipped:', e)
  }
  return merged
}

/** 偏好应用到文档根节点（data-theme / data-font-size 槽位；即时生效不重挂载） */
export function applyMobilePrefs(prefs: MobilePrefs): void {
  document.documentElement.dataset.theme = prefs.theme
  document.documentElement.dataset.fontSize = prefs.fontSize
}

/**
 * 连接信息客户端派生——网络形态判定（§6.11）：hostname 落 Tailscale 网段（100.64/10，
 * 即 100.64.0.0 – 100.127.255.255）→ 'tailscale'，否则 'lan'。与桌面 enumerateLanAddresses
 * 同口径的判定子集：域名形态（MagicDNS 名）不在网段判定内，归 'lan'（诚实缺省——
 * 判不了的形态不假装判得出）。
 */
/** Tailscale 网段（100.64.0.0/10）第二八位组边界：100.64 – 100.127 */
const TAILSCALE_SECOND_OCTET_MIN = 64
const TAILSCALE_SECOND_OCTET_MAX = 127

export function networkKindFromHost(hostname: string): 'tailscale' | 'lan' {
  const match = /^100\.(\d+)\.\d+\.\d+$/.exec(hostname)
  if (match !== null) {
    const second = Number(match[1])
    if (second >= TAILSCALE_SECOND_OCTET_MIN && second <= TAILSCALE_SECOND_OCTET_MAX) return 'tailscale'
  }
  return 'lan'
}

// taste:allow-no-data-owner W24-EX-B（模块级单例 UI 瞬态）：最近一次连接建立时刻（§6.11
// 设置页「已连接时长」的客户端派生源；null = 尚无 connected 边沿）
export const connectedSince = ref<number | null>(null)

/** connected 边沿记录（App.vue watch isConnected 消费；每次重连重算——显示本次连接会话时长） */
export function markConnectedNow(): void {
  connectedSince.value = Date.now()
}

// ── W3 并行单元契约锚段（u-shell-skeleton 立契；u-sessions / u-chat / u-sheets 各填各段，
//    不触他人段——impl-plan §3 D0 偏差同款分段纪律）────────────────────────────
//
// [u-sessions] 未读 diff 段 + 分组谓词段（已落位）：抽在 ./sessions-runtime 独立模块
//   （本文件 W3 三单元并行后超 eslint max-lines 预算，会话域接线拆出；消费方直接
//   import 该模块，不经本文件中转）。依赖本文件既有导出：activeSessionId / deleteSession。
//
// [u-chat] activeSessionId 段：契约 = 本文件既有导出 activeSessionId（sessionStore.activeId，
//   响应式 Ref）。ChatScreen 消费此读口，壳层不做第二份「当前会话」定义。
//
// [u-chat] 计时通知段：回合计时（§6.21 客户端派生——本回合 message_start 本地时刻起算，
//   「已观察」措辞）与动作通知（§6.20 经 core chatStore 既有 appendSystemNotice 插入）。
//   依赖本文件既有导出：chatStore / useChatInstance。
//
// [u-sheets] Sheet 挂载契约：activeSheet / openSheet / closeSheet（./sheet-manager），
//   companion-bridge 三通道呈现出口（FormSheet/PermissionSheet）打开走 openSheet，
//   Sheet 内关闭动作走 closeSheet；Sheet 生命周期联动（路由离开 chat 等）在消费方事件点
//   调 closeSheet()，manager 不反向 watch。

// ── [u-chat] 计时通知段（remote-use-mobile-v2 §6.20 动作通知 / §6.14 重试重报透传）──────
// 依赖本文件既有导出：chatStore（appendSystemNotice 消费）/ useChatInstance。u-shell-skeleton
// 契约锚段的落位单元；组件层不直调 chatStore.appendSystemNotice（ops 面收拢装配层——组件
// 禁触 chat store ops 是 no-chat-ops-in-components 规则的既有边界）。

/**
 * 动作通知插入（§6.20：spec 9.4 七类动作通知的壳层唯一接线点）——经 core chatStore 既有
 * appendSystemNotice（store.ts:1098，v2 为其首个生产消费方）把 system 提示行追加进该会话
 * 消息分区尾部。持久性边界（§6.20 采用段）：内存态——会话期间不消失（分区不清）、断线重连
 * 保留；刷新/重开该会话后不在（历史来自 runtime 重拉，本地插入行不进 pi JSONL）。
 * 文案经 i18n（mobile.notices.*），渲染 = ui SystemNotice 既有 system 行形态（壳零新渲染路径）。
 *
 * 触发点分布（六类通知、五处触发点已接线，均在本端动作回执成功点调用）：中断生成
 * Composer（turnAborted）/ 重试本轮 ChatScreen 出错条（turnRetried）/ 提交回答与允许/
 * 拒绝 App.vue（answerSubmitted + permissionApproved/permissionDenied，审批 pending 翻
 * false 的本端动作回执）/ 停止子代理 SubagentSheet（subagentStopped）。会话重新打开不经本出口——走 core
 * appendRespawnNotice 既有路径（lifecycle-effects.ts appendNotice → deps.chat.
 * appendRespawnNotice，respawn 收尾消费），与本出口平行的同族插入路径。
 */
export function appendActionNotice(sessionId: string, text: string): void {
  chatStore.appendSystemNotice(sessionId, text)
}

/**
 * 队列条目失败重报（§6.22 failed 重试，QueueStrip v2 消费方）：delivery.resync RPC 透传
 * （core transport chat 域既有封装；clientUuid 幂等去重在 runtime 单点，壳只透传）。
 */
export function resyncDelivery(sessionId: string, clientUuids: string[]): Promise<DeliveryResyncReply> {
  return chatApi.resyncDelivery(sessionId, clientUuids)
}

// ── [u-sheets] Sheet 域 RPC 透传段（remote-use-mobile-v2 §6.5/§6.10/§6.12；组件层不直连
//    transport，经本段出口消费——与 cancelDelivery/peekDelivery 透传形态平行）──────────

/**
 * project 清单拉取（§6.12 NewTaskSheet 项目 chip 主路径数据源；V-2 结论：project.load
 * reply = ProjectStoreState）。RPC 失败上抛由调用方降级手输兜底（§6.12 降级链）。
 */
export function fetchProjects(): Promise<ProjectStoreState> {
  return projectApi.load()
}

/**
 * 会话模型清单订阅（§7.2 ModelSheet：onModels 广播订阅）+ 主动拉兜底（listModels，
 * 订阅注册时序竞态的请求-响应兜底）。当前会话权威值经 liveStateOf 读口 + 切入链
 * getState 拉取（既有），本段不另立读法。
 */
export function subscribeModels(handler: (models: ModelInfo[]) => void): () => void {
  return modelApi.onModels(handler)
}

export function fetchModels(): Promise<ModelInfo[]> {
  return modelApi.listModels()
}

/**
 * 会话级模型切换（§7.2 F9）：回执 = pi 生效值（静默换模防线），调用方以回执值写显示态
 * （禁请求值乐观写——runtime switchModel 契约）。
 */
export function switchSessionModel(
  sessionId: string,
  provider: string,
  modelId: string,
): Promise<{ sessionId: string; provider: string; modelId: string }> {
  // provider 串来源 = ModelInfo.provider（runtime 聚合清单原值透传，非用户输入——
  // branded ProviderId 的构造信任点在 runtime 侧清单）
  return modelApi.switchModel(sessionId, provider as ProviderId, modelId)
}

/**
 * 会话思考档设置（§7.2）：回执 level = runtime set→get_state 读回的生效档（pi 钳制时
 * ≠ 请求值），调用方以回执值写显示态。
 */
export function setSessionThinkingLevel(
  sessionId: string,
  level: string,
): Promise<{ sessionId: string; level: string }> {
  return sessionApi.setThinkingLevel(sessionId, level)
}

/** 扩展命令清单拉取（§6.13 CommandSheet：切会话后主动拉，broadcast 时序竞争规则的主动拉取模式） */
export function fetchSessionCommands(sessionId: string): Promise<Array<{ name: string; description?: string; source: string }>> {
  return sessionApi.getCommands(sessionId).then((r) => r.commands)
}

/** 子代理清单拉取（§6.10/§7.2 SubagentSheet 列表态；found=false = 会话不在册，调用方保留既有数据） */
export function fetchSubagents(sessionId: string): Promise<{ subagents: SubagentRecord[]; oversize?: boolean; found?: boolean }> {
  return sessionApi.getSubagents(sessionId)
}

/** 子代理最近执行历史（§6.10 详情执行记录 = 历史消息派生，不新增 steps 概念）；content
 * 经 normalizeContent 归一纯文本（Message.content 是 string | Segment[] 联合，Sheet 步骤
 * 列表只消费文本 + 状态） */
export function fetchSubagentHistory(sessionId: string, subagentId: string): Promise<MobileSubagentHistoryMessage[]> {
  return sessionApi.getSubagentHistory(sessionId, subagentId).then((messages) =>
    messages.map((m) => ({
      id: m.id,
      role: m.role,
      text: normalizeContent(m.content),
      status: m.status,
    })),
  )
}

/** 子代理停止（§6.10：subagentAction cancel；收敛消费 session.subagents 快照由调用方重拉） */
export function stopSubagent(sessionId: string, subagentId: string): Promise<void> {
  return sessionApi.subagentAction(sessionId, 'cancel', { subagentId })
}

/** 详情执行记录的消息窄化面（role + 文本 + 状态；FormSheet 族外的 Sheet 渲染消费子集） */
export interface MobileSubagentHistoryMessage {
  id: string
  role: string
  text: string
  status: string
}
