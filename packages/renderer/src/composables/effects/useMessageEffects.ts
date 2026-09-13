/**
 * useMessageEffects —— useConnection 的入站副作用回调实现（架构审计 §11.4）。
 *
 * core use-connection 是 headless（零 store / 零 DOM），入站消息的副作用回调
 * （session.exited / message.complete / session.subagents / session.subagentEntriesAppended /
 * session.workflowUpdate / subagent.stream_delta / 全局 error）与 runtime 崩溃清理
 * （finalizeAllStreaming / clearAllPending）统一归位到本层。
 *
 * 本文件是 renderer 层（可 import store），供 useConnection 装配点经
 * setConnectionPorts 注入 core（ConnectionPorts.effects / onRuntimeUnavailable）。
 *
 * 依赖方向：useMessageEffects → stores + useCompletionNotify + i18n + useToast。
 */
import i18n from '@/i18n'
import { useChatStore } from '@/stores/chat'
import { useSessionStore } from '@/stores/session'
import { usePanelStore } from '@/stores/panel'
import { useExtensionUIStore } from '@/stores/extension-ui'
import { useSubagentStore } from '@/stores/subagent'
import { useWorkflowStore } from '@/stores/workflow'
import { useToast } from '@/composables/useToast'
import { handleCompletion } from '@/composables/effects/useCompletionNotify'
import { consumeForcedExit } from '@/composables/effects/forced-exit-marks'
import { invalidateStreamSubscription, subscribeSession } from '@xyz-agent/core'
import type { InboundEffects } from '@xyz-agent/core'
import { resolveSubagentParentSessionId, subagentVirtualId } from '@xyz-agent/shared'
import type { PiEntry, PiToolCallEntryForm, ServerMessage, ServerMessageMap, SubagentRecord } from '@xyz-agent/shared'

const t = i18n.global.t

// ── [crash-resilience T4 回流修复] 恢复窗口编排（respawn 过渡态）──
//
// Gate B 实测缺陷（0/3 提示条）根因：pi 死亡 → runtime removeSessionEntry → bus.clearSession
// 清掉 renderer 订阅；自动恢复成功 publish session.restored 时 bus entry 内零订阅者（live 不达）；
// ring 回放需要 renderer 主动 subscribe，而 dead 终态页下唯一入口「重新打开」走 session.restore
// RPC，runtime lifecycle.restoreSession 对 existing session detach+destroy+removeSessionEntry
// 把含 restored 帧的 ring 整体清除 → 之后 selectSession 的 subscribe 拿到空 ring（回放也不达）。
// 两条通路在不改 runtime 的前提下结构性不可达。
//
// 修法（最小可靠形态）：exited（非强制）时进 respawnPending 过渡态 + 立即重发 subscribe
// 建立「恢复窗口订阅」——自动恢复路径 restored publish 前无清场（死亡时已清过一次），
// renderer 是恢复后新 bus entry 的订阅者 → restored live 送达，本回调链自收口。手动 restore
// 清场场景由 useSidebar.restoreSession 的本地 revive 兜底。

/** 恢复超时（无 restored/restoreFailed 到达即放弃等待，切回终态 dead 页）。30s：respawn
 *  实测 6s 级（5s 延迟 + spawn/attach），熔断最迟 ~10s 出结果，30s 覆盖两次重试仍有裕量。 */
const RESPAWN_PENDING_TIMEOUT_MS = 30_000

/** 恢复超时 timer（sessionId → handle，模块级非响应式——对齐 streamSubscriptions 范式）。
 *  到期回调先查 respawnPending 分区（restored/熔断已清则 no-op），session 删除场景下
 *  disposeSession 清了分区 → 到期 no-op，timer 单发自清（30s 有界，无泄漏面）。 */
// taste:allow-no-data-owner W24-EX-C（非 GUI 数据技术结构，已登记 §4 ⑧ 2026-09-12）：恢复超时 timer Map（30s 单发自清，无持久化）
const respawnTimeoutTimers = new Map<string, ReturnType<typeof setTimeout>>()

/** 清除恢复超时 timer（幂等）。 */
function clearRespawnTimeout(sessionId: string): void {
  const timer = respawnTimeoutTimers.get(sessionId)
  if (timer !== undefined) {
    clearTimeout(timer)
    respawnTimeoutTimers.delete(sessionId)
  }
}

/**
 * 处理 session.exited 事件（pi 进程异常退出）。
 *
 * 不能只依赖 session 通道的惰性订阅（ensureStreamSubscription 在首次 send 时建立）：
 * 进程可能在用户首次发消息前就死（如 extension 加载失败 exit(1)），此时无订阅者，
 * dispatchSession 会静默丢弃。因此 routeInbound 对 session.exited 做兜底处理，
 * 保证 markSessionError + markDead + invalidateStreamSubscription + toast 一定执行。
 *
 * [T4] 退出语义分流（wire 帧对意外/强制退出不可区分，靠 renderer 本地意图标记）：
 * - 用户强制退出（consumeForcedExit 命中）：runtime 构造性不 respawn → 维持既有终态行为。
 * - 意外退出：进 respawnPending 过渡态（panel 派生 isSessionRespawning 抑制 dead 终态页，
 *   对话流 + composer 保持可用，恢复窗口发消息经 runtime ensureActive join 送达），并
 *   立即重发 subscribe 建立恢复窗口订阅（见文件头注释——restored live 送达的唯一通路）。
 *   会话 status 仍置 dead（侧栏置灰准确），恢复成功经 revive 复位。
 *
 * invalidateStreamSubscription：失效本地流订阅标记（服务端订阅已随 bus.clearSession
 * 清除），respawn 后 ensureStreamSubscription 才会重挂 events handler + 重发 subscribe。
 */
function handleSessionExited(sessionId: string, payload: { code: number | null; reason: string }): void {
  useChatStore().markSessionError(sessionId, payload.reason)
  useSessionStore().markDead(sessionId)
  // 失效本地流订阅标记：服务端订阅已随 bus.clearSession 清除（pi 死亡），本地幂等标记
  // 不失效则 respawn 后 ensureStreamSubscription 被短路 → 新 turn 的 message.* 丢失
  //（UI 卡「进行中…」）。放 markDead 之后：错误消息/dead 态等 UI 反馈先落地
  invalidateStreamSubscription(sessionId)
  // D6b（integrity-hardening §3.6）：pi 死后清掉该 session 挂起的 ask-user / dialog 分区
  //（对齐 deleteSession 路径 core use-session cleanup hooks 的 extensionUIStore.clearSession 写法）。
  // 不清则切走再切回（restore 起新 pi）后旧请求重弹，作答发给新进程被静默丢弃（M8 幽灵弹窗）。
  useExtensionUIStore().clearSession(sessionId)
  // reason 可能含多行 stderr，toast 只取首行（完整内容在聊天流 error 消息里）
  const shortReason = payload.reason.split('\n')[0]
  useToast().error(t('connection.runtimeExited', { reason: shortReason }))

  const chatStore = useChatStore()
  if (consumeForcedExit(sessionId)) {
    // 用户强制退出：无自动恢复（runtime 不 respawn），终态 dead 页原样（清掉可能残留的
    // 过渡态——防御路径，正常时序强制退出前不会有 pending）
    clearRespawnTimeout(sessionId)
    chatStore.clearRespawnPending(sessionId)
    return
  }
  // 意外退出 → 过渡态 + 恢复窗口订阅。mark 幂等（连续 exited 不重置计时窗口）。
  chatStore.markRespawnPending(sessionId)
  if (!respawnTimeoutTimers.has(sessionId)) {
    respawnTimeoutTimers.set(
      sessionId,
      setTimeout(() => {
        respawnTimeoutTimers.delete(sessionId)
        // restored/熔断已收口则分区已清 → no-op；仍 pending = 恢复无响应（如 runtime 重启
        // 丢恢复承诺），超时切回终态 dead 页（保留「重新打开」出口）
        if (!chatStore.isRespawnPending(sessionId)) return
        chatStore.clearRespawnPending(sessionId)
      }, RESPAWN_PENDING_TIMEOUT_MS),
    )
  }
  // 恢复窗口订阅（fire-and-forget）：立即成为恢复后新 bus entry 的订阅者，restored /
  // restoreFailed / 恢复后首帧 live 可达。subscribeSession 失败内部 console.warn 且登记
  // subscribed=false 意图条目，WS 重连 resubscribeAll 兜底重发（链路自愈）。
  void subscribeSession(sessionId).catch((e) => {
    console.warn(`[useMessageEffects] respawn-window subscribe failed for session ${sessionId}:`, e)
  })
}

/**
 * [u8] 处理 session.restored（pi 崩溃自动恢复成功，crash-resilience D7 / T4）。
 *
 * 对话流插入恢复提示条（T4 文案：在途回合未保留、后台任务/子代理已终止不自动恢复、
 * 可继续发消息）+ 复位 dead 态标记 + 收口过渡态（respawnPending 清除 → panel 派生回
 * conversation，T4 提示条在对话流内呈现）。帧经恢复窗口订阅 live 到达（修法见文件头
 * 注释；WS 重连场景由 resubscribeAll 的 ring 回放兜底，同一本回调）。随后主动重发
 * subscribe（幂等，subscribed=true 短路）：既恢复 live 订阅（后续 message.* 不丢），
 * 也让后续重开/切换拿到完整回放。失败 console.warn 不标记（下次可重试）。
 */
function handleSessionRestored(sessionId: string, payload: { attempts: number }): void {
  console.debug(`[useMessageEffects] session ${sessionId} auto-restored after ${payload.attempts} attempt(s)`)
  clearRespawnTimeout(sessionId)
  const chatStore = useChatStore()
  chatStore.clearRespawnPending(sessionId)
  useSessionStore().revive(sessionId)
  chatStore.appendRespawnNotice(sessionId, 'restored', t('panel.message.respawnRestored'))
  void subscribeSession(sessionId).catch((e) => {
    console.warn(`[useMessageEffects] re-subscribe after restore failed for session ${sessionId}:`, e)
  })
}

/**
 * [u8] 处理 session.restoreFailed（自动恢复失败）。willRetry=false（连续 2 次熔断）→
 * 收口过渡态回终态 dead 页（保留「重新打开」出口）+ 对话流插入失败提示条（「引擎恢复
 * 失败，点此重试或新建会话」+ 重试按钮，RespawnNoticeBar——重开/重试后可见）；
 * willRetry=true 的中间失败不渲染不收口（重试由 runtime 自动续排，过渡态保持，
 * 避免提示条闪烁）。
 */
function handleSessionRestoreFailed(
  sessionId: string,
  payload: { attempts: number; willRetry: boolean; reason: string },
): void {
  if (payload.willRetry) {
    console.warn(`[useMessageEffects] auto restore failed (will retry) for session ${sessionId}:`, payload.reason)
    return
  }
  clearRespawnTimeout(sessionId)
  const chatStore = useChatStore()
  chatStore.clearRespawnPending(sessionId)
  chatStore.appendRespawnNotice(sessionId, 'restoreFailed', t('panel.message.respawnFailed'))
}

/**
 * 处理带 sessionId、未命中 pending 的 error envelope（D6b）。
 *
 * 典型场景：pi 死后残留弹窗的作答经 sendExtensionUIResponse 发出，runtime 侧「client
 * 不存在」回 error envelope（fire-and-forget 无 msg.id，不走 pending reject）——此前落
 * session 通道被静默丢弃，用户作答石沉大海。现复用 markSessionError（session 级错误
 * 统一入口：追加 error assistant 消息 + finalize）进消息流展示，并 toast 保证切走的
 * session 也可见。
 */
function handleSessionError(sessionId: string, payload: { code?: string; message?: string }): void {
  const text = t('connection.sessionRequestFailed', { message: payload.message ?? 'Unknown error' })
  useChatStore().markSessionError(sessionId, text)
  useToast().error(text)
}

/**
 * 处理 message.complete 事件（session 生成完成）。
 * 算 focusedSid（当前面板聚焦的 session）→ 交给 handleCompletion 链
 * （aborted 过滤 → [retry-sound] willRetry 中间失败静音 → background work 守卫 → 后台判定 →
 * 未读标记 → 提示音）。
 */
function handleMessageComplete(
  sessionId: string,
  payload: { sessionId?: string; stopReason?: string; willRetry?: boolean },
): void {
  const panelStore = usePanelStore()
  const focusedSid =
    panelStore.panels.find((p) => p.id === panelStore.activePanelId)?.sessionId ?? null
  handleCompletion(sessionId, payload.stopReason ?? 'stop', focusedSid, payload.willRetry)
}

/** 处理 session.subagents 事件（subagent 终态推送兜底，非活跃 session 也生效）。 */
function handleSubagents(sessionId: string, subagents: SubagentRecord[]): void {
  useSubagentStore().applyRecords(sessionId, subagents)
}

/**
 * 处理 session.subagentEntriesAppended 事件（E-4，relay tee 产出的 entry 帧兜底）。
 *
 * 帧先于 drawer 打开到达时也写分区（分区惰性创建，§6.1）——消费不依赖 drawer 生命周期，
 * virtualId 经 shared 工厂构造（INVAR-1.1），写入 chatStore 虚拟分区（store 不互 import：
 * 本层是既有跨 store 协调层，同 handleSessionExited 先例）。
 */
function handleSubagentEntries(
  sessionId: string,
  subagentId: string,
  entries: Array<PiEntry | PiToolCallEntryForm>,
): void {
  useChatStore().applySubagentEntries(subagentVirtualId(sessionId, subagentId), entries)
}

/** 处理 session.workflowUpdate 事件（workflow 增量信号兜底）。update 锚定 protocol SSOT（MF-4）。 */
function handleWorkflowUpdate(sessionId: string, update: ServerMessageMap['session.workflowUpdate']['update']): void {
  useWorkflowStore().triggerWorkflowReload(sessionId, update.status ?? 'unknown')
}

/**
 * [idle-refresh] 处理 subagent.stream_delta 帧（docs/design/timeout-streaming-ui-idle.md §5.1 D1 桥接）。
 *
 * sync subagent/workflow 编排期父 session 的 message.* 帧构造性为零（生产端不消费
 * onUpdate），子代理活跃信号走本帧旁路——core routeInbound FALLBACK 按 type 识别后
 * 经 InboundEffects 调用本回调。解析 payload.sessionId（shared 纯函数双形态归一：
 * relay tee 通道三段式虚拟 id `subagent:<mainSessionId>:<subagentId>` → 提取父 sid；
 * 旧 widget 通道主 sid 原样）后刷新父 session 的 streaming idle timer，防「子面板
 * 在打字、父气泡被判无进展」。sessionId 缺失（坏形状帧）no-op——解析是纯字符串
 * 函数无失败形态，无 id 即无可刷新目标。
 */
function handleSubagentStreamDelta(frame: ServerMessage): void {
  const sid = (frame.payload as { sessionId?: string } | null)?.sessionId
  if (typeof sid !== 'string' || !sid) return
  useChatStore().refreshStreamingTimer(resolveSubagentParentSessionId(sid))
}

/** 全局 error 兜底（无 sessionId 无 id 的 server-push error → toast 提示）。 */
function handleGlobalError(message: string): void {
  useToast().error(message)
}

/**
 * runtime 崩溃 / 重启用尽清理（T5）。
 *
 * runtime 崩溃 = pi 子进程没了 = 流不可能继续。重置 chat 活跃态 + 清理 extension UI
 * pending，避免 UI 卡「思考中」+ in-flight Promise 永挂（runtime 重启后是全新实例，
 * ask-user 的 Promise 永远不会被 resolve）。
 *
 * @param reason 'restart'（崩溃重启中）/ 'disconnect'（重启用尽，FinalizeReason）
 */
export function handleRuntimeUnavailable(reason: 'restart' | 'disconnect'): void {
  useChatStore().finalizeAllStreaming(reason)
  useExtensionUIStore().clearAllPending()
}

/**
 * 工厂：构建 InboundEffects 回调集（供 useConnection 装配点注入 core）。
 * 函数引用稳定（模块级定义），重复调用返回同一组行为。
 */
export function createInboundEffects(): InboundEffects {
  return {
    onSessionExited: handleSessionExited,
    onSessionRestored: handleSessionRestored,
    onSessionRestoreFailed: handleSessionRestoreFailed,
    onMessageComplete: handleMessageComplete,
    onSubagents: handleSubagents,
    onSubagentEntries: handleSubagentEntries,
    onSubagentStreamDelta: handleSubagentStreamDelta,
    onWorkflowUpdate: handleWorkflowUpdate,
    onGlobalError: handleGlobalError,
    onSessionError: handleSessionError,
  }
}
