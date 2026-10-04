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
//   呈现通道，remote-use A7/U14——revoke/stop/bash/compact 等 RPC 失败面对用户可见）
// - panel/navigation/hooks → no-op（移动壳无 panel/导航 store；SessionEntryPort 全成员
//   可选缺省 no-op、链零新增步骤可跑，sessionEntry 订阅/LRU 步已接线——remote-use D2）
// - turn 展开 → 壳内 per-session Map 分区（ADR-0049 范式；桌面 useTurnExpansion 的 mobile 子集）
import type { Ref } from 'vue'
import {
  createChatStore,
  createSessionFlow,
  createSessionStore,
  createUseChat,
  createUseSession,
  ensureStreamSubscription,
  evictLruWithUnsubscribe,
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
import { onGlobalType } from '@taiji/core/transport/api'
import { registerSessionCleanup } from '@taiji/core/foundation/use-session-scoped-state'
import { createComposerInjectionStore } from '@taiji/core/domain/composer/context'
import { showErrorBar } from './error-bar'
import type { DeliveryCancelReply, Segment, SessionSummary } from '@taiji/shared'
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
  // 撤回在途条目（delivery.cancel RPC，内核 D6 统一入口的在途路由腿）
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
  // [remote-use A3/U12] dead 会话显式重开 RPC 透传（session.restore）——恢复三步编排原语之一
  restoreSession: (id) => sessionApi.restoreSession(id),
  removeByCwd: (cwd) => sessionApi.removeByCwd(cwd),
  migrateImage: (p) => sessionApi.migrateImage(p),
  onConfigSessions: (handler) =>
    onGlobalType('config.sessions', (msg) => handler(msg.payload.groups)),
}

// ── store / composable 单例（模块级；移动壳单实例应用）──────────────────

const chatStore = createChatStore()
const sessionStore = createSessionStore()

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
  }
}

const useChatInstance = createUseChat(buildUseChatDeps())

// ── turn 展开状态（桌面 useTurnExpansion 的 mobile 子集，per-session Map 分区）──────

/** per-session turn 展开分区：turnKey 展开集合（isTakeover/setTakeover 是 optional 字段，
 *  移动壳按 D10 不 provide，分区无接管态） */
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
    collapse: (turnKey: string): void => {
      turnExpansionMap.get(sessionId.value)?.delete(turnKey)
    },
  }
}

// ── createUseSession（session 列表编排；panel/navigation/hooks 未接线面 no-op）────────

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
    reconcileHistory: (sid, messages, window) => chatStore.reconcileHistory(sid, messages, window),
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
  },
  // D2/U5：sessionEntry 端口束注入——切入链 12 步的订阅/LRU 步在移动壳生效（对齐桌面）
  sessionEntry,
})

// ── 新建任务（createSessionFlow 直组；手输路径是移动唯一形态）────────────────

export interface MobileNewTaskInput {
  /** 项目路径（表单手输，必填） */
  cwd: string
  /** 首条消息文本 */
  firstMessage: string
  /**
   * 创建幂等键（remote-use A17/U18，per-open 黏滞槽）：同一「新建任务」意图的失败重试
   * 复用同键，runtime 按 clientUuid 幂等返回已建 session（弱网超时重试不双建）。生成与
   * 重置（提交成功/关闭）由表单层按意图生命周期负责——本函数只透传 createSessionFlow。
   */
  clientUuid?: string
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
    { cwd, segments, clientUuid: input.clientUuid },
  )
  if (!result) return null
  sessionStore.setActiveId(result.session.id)
  // 首条消息发送失败不回滚创建（session 已存在）；用户已切入聊天视图可重发
  try {
    await useChatInstance.send(result.session.id, result.migratedSegments)
  } catch (e) {
    // 降级策略：session 创建已成功，发送失败仅记录（乐观气泡由 core send 编排回滚），
    // 不上抛——上抛会让表单误报「创建失败」，而实际失败面只是首条消息投递
    console.error('[mobile-task] first message send failed:', e)
  }
  return result.session
}

// ── 导出（组件层消费面）──────────────────────────────────────────────
// 仅暴露组件/测试实际消费的符号；useSessionInstance 与两个 api 端口是文件内组装细节，
// 去 export 防「导出面 = API 面」的假象（外部断链由本文件 import 图自证）。

export { chatStore, sessionStore, useChatInstance }

/**
 * 队列条目取消（remote-use D7/U10）：delivery.cancel RPC 透传（本文件 chatApiPort
 * 已接线的同一出口，QueueStrip 组件消费面）——内核收回-重投/不可撤判定全在 runtime
 * 单点，壳只透传 reply。
 */
export function cancelDelivery(sessionId: string, clientUuid: string): Promise<DeliveryCancelReply> {
  return chatApiPort.cancelDelivery(sessionId, clientUuid)
}

/**
 * 取消全文回输入框的一次性注入通道（remote-use D7/U10，core composer injection factory
 * 平台无关单例——桌面 renderer composer-injection-store 同范式）：QueueStrip（写入侧，
 * 取消应答全文）与 MobileComposer（消费侧，insertTextAtCursor 光标插入）跨组件树共享。
 * 通道 text 单值语义（无 segments 承载位）：移动壳产不出 chip（无 slash 浮层/file 注入源/
 * 图片粘贴降级文本），cancel reply segments 的 chip 恢复面在移动壳为零，零丢失。
 */
export const composerInjectionStore = createComposerInjectionStore()

/**
 * 测试后门命名空间（生产代码禁止消费，对齐 companion-bridge __testing 先例）：
 * 装配检查的断言入口——sessionEntry 端口束注入面（三成员非 no-op + 缺省成员无键，
 * D2/U5 装配断言；U21 装配检查 helper 双壳测试将复用同一出口）。
 */
export const __testing = {
  sessionEntry,
  /** toast 通道装配断言出口（U14/A7：core 两处注入的 toast = 错误条通道，非 console） */
  errorBarToast,
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
 * ③ revive（dead→idle 统一收口；非 dead 真态不被本地覆盖——core store.revive guard）。
 */
export async function restoreSession(id: string): Promise<void> {
  // 本文件构造 sessionApiPort 时必含 restoreSession 成员（上方实现对象字面量），构造性非空
  await sessionApiPort.restoreSession!(id)
  try {
    await selectSession(id)
  } catch (e) {
    // 降级策略（对齐桌面 useSidebar.restoreSession 同分支）：切入失败不阻断 revive、
    // 不重抛——restore 成功后 revive 是 UI 死态清除，与切入成败解耦；一次性编排失败
    // 用 console 留痕，不占用 core toast 通道的错误条单槽（错误条留给 core 失败面文案）
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
