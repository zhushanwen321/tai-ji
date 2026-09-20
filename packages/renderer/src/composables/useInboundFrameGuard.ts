/**
 * useInboundFrameGuard —— 入站超界帧守卫的 renderer 侧消费编排
 * （crash-forensics-and-watchdog §3.3 D8 终止阀的恢复触发器 + 台账上报 / u10a）。
 *
 * 职责（ws-client 守卫在 core 传输层，本 composable 是其 renderer 消费面）：
 * - **台账上报**：订阅 core ws-client 的 onInboundFrameDropped（每次超界帧丢弃触发），
 *   经既有 renderer-log IPC 通道带结构化标记（source='inbound-frame-dropped'）上报，
 *   main 侧 handler 识别后写崩溃台账 main.jsonl（不新建 IPC 通道，D1 矩阵）。
 * - **静态提示态**：valveTripped=true（同 session 连续 3 次丢帧，终止阀生效）时把该
 *   session 记入 trippedSessionIds——InboundFrameDroppedNotice 组件按此渲染会话级
 *   静态错误提示（复用 C-proc-12 熔断静态页「响亮降级 + 恢复指引」形态）。
 * - **恢复触发器（用户切走切回重试一次）**：watch panel focusedSessionId——用户切入
 *   终止阀生效中的 session 时调 core retryInboundDroppedSession 解除暂停，并经
 *   subscribeSession 重试一次订阅；未 tripped 的切换零动作。
 * - **[RD-1#7] session 销毁清理挂点**：registerSessionCleanup(clearTripped)——trippedSessionIds
 *   原先只在「切入且 retry 成功」时按 sid 删，session 删除/LRU 驱逐无回收路径，集合随
 *   session 增删无界增长（每 session 至多 1 条，有界但不可回收）。注册后 deleteSession →
 *   triggerSessionCleanups(sid) 统一回收；uninstall 时整体清空（teardown 语义）。
 *
 * 状态形态：模块级单例 ref（useCrashRecoveryNotice 同款邻域范式）——状态源在 core
 * ws-client（模块级单例），本 composable 只是其 renderer 投影 + 编排，非 per-instance
 * 数据（ADR-0049 Map 分区范式不适用，投影集合本身按 sessionId 寻址）。
 *
 * 安装：installInboundFrameGuard()（幂等），App 装配层调用；自身零抛错路径全部
 * fire-and-forget——守卫消费面不得成为新崩溃源（D2 降级契约同款）。
 */
import { ref, watch } from 'vue'
import type { InboundFrameDroppedInfo } from '@taiji/core'
import { onInboundFrameDropped, retryInboundDroppedSession, subscribeSession } from '@taiji/core'
import { reportRendererLog } from '../lib/ipc'
import { usePanelStore } from '../stores/panel'
import { registerSessionCleanup } from '@/composables/useSessionScopedState'

/** 终止阀生效中的 session 集合（只读投影；InboundFrameDroppedNotice / 面板消费）。 */
// taste:allow-no-data-owner W24-EX-B（模块级单例 UI 瞬态，已登记）：终止阀 tripped 集合投影（状态源 = core ws-client 模块级单例；登记见 docs/architecture/data-source-registry.md §4 ⑧）
const trippedSessionIds = ref<ReadonlySet<string>>(new Set())

let installed = false
let unlistenFrameDropped: (() => void) | null = null
let stopFocusWatch: (() => void) | null = null
let unregisterSessionCleanup: (() => void) | null = null

/**
 * 安装守卫消费编排（幂等）：丢帧上报 + 静态提示态 + 切走切回重试订阅。
 * App 装配层（pinia 激活后）调用一次。
 */
export function installInboundFrameGuard(): void {
  if (installed) return
  installed = true

  // 1. 每次超界帧丢弃 → 结构化标记上报（台账行）；trip 帧同时置静态提示态。
  unlistenFrameDropped = onInboundFrameDropped((info) => {
    reportInboundFrameDropped(info)
    if (info.valveTripped && info.sessionId !== null) {
      markTripped(info.sessionId)
    }
  })

  // 2. 恢复触发器：用户切入终止阀生效中的 session → 解除暂停 + 重试一次订阅。
  //    prev 存在且 ≠ cur 判定「切入」动作（覆盖「切走再切回」字面场景；trip 后首次进入
  //    该 session 亦触发——恢复触发器语义 = 可判定的用户动作，从宽不失真）。未解除
  //    （retry 返回 false，非 tripped 态残留防御）不动订阅。
  const panel = usePanelStore()
  stopFocusWatch = watch(
    () => panel.focusedSessionId,
    (cur, prev) => {
      if (!cur || cur === prev) return
      if (!trippedSessionIds.value.has(cur)) return
      if (!retryInboundDroppedSession(cur)) return
      clearTripped(cur)
      // 重试订阅 fire-and-forget：失败由 subscribeSession 内部 console.warn 消化
      // （下次切入可再试；阀已解除，失败态可自愈重试）
      void subscribeSession(cur)
    },
  )

  // 3. [RD-1#7] session 销毁清理挂点：useSidebar.deleteSession → triggerSessionCleanups(sid)
  //    → clearTripped(sid)。不注册则 trippedSessionIds 只增不清（集合无界增长），且已删
  //    session 的静态提示态永不消失。返回的反注册函数在 uninstall 时调用（配对）。
  unregisterSessionCleanup = registerSessionCleanup(clearTripped)
}

/** 卸载编排（App teardown 配对；测试隔离用）。 */
export function uninstallInboundFrameGuard(): void {
  unlistenFrameDropped?.()
  unlistenFrameDropped = null
  stopFocusWatch?.()
  stopFocusWatch = null
  // [RD-1#7] 反注册 session cleanup + 清空投影集合：卸载即全量解绑，残留的 tripped 态
  // 会在重新 install 后（HMR / 测试）表现为「未丢帧却显示静态提示」的假阳性。
  unregisterSessionCleanup?.()
  unregisterSessionCleanup = null
  trippedSessionIds.value = new Set()
  installed = false
}

/** 终止阀投影：指定 session 是否处于静态提示态。 */
export function isInboundSessionTripped(sessionId: string): boolean {
  return trippedSessionIds.value.has(sessionId)
}

/** 终止阀生效 session 集合（只读 ref，提示组件消费）。 */
export function useInboundFrameGuardState(): { trippedSessionIds: typeof trippedSessionIds } {
  return { trippedSessionIds }
}

/** 上报一条入站丢帧（结构化标记经既有 renderer-log 通道；自身零抛错）。 */
function reportInboundFrameDropped(info: InboundFrameDroppedInfo): void {
  try {
    const sizeUnit = info.kind === 'text' ? 'code units' : 'bytes'
    reportRendererLog({
      source: 'inbound-frame-dropped',
      // 尺寸上下文内嵌 message（台账 detailDigest 消费；无独立 IPC 字段，通道面最小）
      message: `inbound frame dropped: ${info.frameSize} ${sizeUnit} exceeded size limit` +
        ` (session streak ${info.sessionDropCount}${info.valveTripped ? ', valve tripped' : ''})`,
      timestamp: Date.now(),
      ...(info.sessionId !== null ? { sessionId: info.sessionId } : {}),
    })
  // eslint-disable-next-line taste/no-silent-catch -- 上报组装异常静默：守卫消费面不得成为新崩溃源（D2 降级契约）
  } catch {
    // no-op
  }
}

function markTripped(sessionId: string): void {
  const next = new Set(trippedSessionIds.value)
  next.add(sessionId)
  trippedSessionIds.value = next
}

function clearTripped(sessionId: string): void {
  const next = new Set(trippedSessionIds.value)
  next.delete(sessionId)
  trippedSessionIds.value = next
}

/** 测试钩子：清空模块级状态（对齐 _resetCrashRecoveryNoticeForTest 模式；自足拆监听）。 */
export function _resetInboundFrameGuardForTest(): void {
  unlistenFrameDropped?.()
  stopFocusWatch?.()
  // [RD-1#7] 与 uninstall 对齐：反注册 session cleanup（否则下一例 install 时会重复注册）
  unregisterSessionCleanup?.()
  unregisterSessionCleanup = null
  trippedSessionIds.value = new Set()
  installed = false
  unlistenFrameDropped = null
  stopFocusWatch = null
}
