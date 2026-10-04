// app-runtime —— 移动壳 core 业务域组装单例（remote-use D10「core 业务域全复用」行的壳侧落点）。
//
// 移动壳无 pinia 业务 store（桌面 renderer 的 useChatStore/useSessionStore 是 pinia 包装），
// 直接组装 core 纯 factory：createChatStore/createSessionStore/createUseChat/createUseSession/
// createSessionFlow。ChatApiPort/SessionApiPort 在壳层适配 core transport api domains
// （与桌面 useChat.ts 的 chatApiPort、api/session-api-port.ts 同构——端口注入模式：core 定义
// 接口、壳注入实现）。
//
// 平台差异（相对桌面组装）：
// - toast → console（移动壳 v1 无 toast 组件；core toast 契约 { error, warning } 的降级通道）
// - panel/navigation/hooks → no-op（移动壳无 panel/导航 store；SessionEntryPort 注释明示
//   headless/mobile 未接线环境零新增步骤执行完整链）
// - turn 展开 → 壳内 per-session Map 分区（ADR-0049 范式；桌面 useTurnExpansion 的 mobile 子集）
import type { Ref } from 'vue'
import {
  createChatStore,
  createSessionFlow,
  createSessionStore,
  createUseChat,
  createUseSession,
} from '@taiji/core'
import type {
  ChatApiPort,
  SessionApiPort,
  SessionStoreLike,
  UseChatDeps,
} from '@taiji/core'
import * as chatApi from '@taiji/core/transport/api/domains/chat'
import * as sessionApi from '@taiji/core/transport/api/domains/session'
import { onGlobalType } from '@taiji/core/transport/api'
import type { Segment, SessionSummary } from '@taiji/shared'
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
  create: (cwd, label, presetId, projectId, modelOverride, thinkingOverride) =>
    sessionApi.create(cwd, label, presetId, projectId, modelOverride, thinkingOverride),
  rename: (id, label) => sessionApi.rename(id, label),
  remove: (id) => sessionApi.remove(id),
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

function coreChannelDeps(): CoreChannelDeps {
  return {
    chatApi: chatApiPort,
    writeSegments: (payload) => sessionApi.writeSegments(payload),
    toast: { error: console.error, warning: console.warn },
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
})

// ── 新建任务（createSessionFlow 直组；手输路径是移动唯一形态）────────────────

export interface MobileNewTaskInput {
  /** 项目路径（表单手输，必填） */
  cwd: string
  /** 首条消息文本 */
  firstMessage: string
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
    { cwd, segments },
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
