/**
 * handingOff 瞬时态子域（fast-handoff）—— 从 chat store 抽取的内聚模块。
 *
 * 本模块是 chat store 的一个子关注点：追踪「正在交接」的 session 集合（per-session 隔离），
 * 镜像 compactingSessions 的 Set 模式，并封装 C2+M1 超时兜底 timer。
 *
 * 设计选择（工厂模块，对齐 chat-changeset.ts）：
 * 采用「工厂模块」而非 defineStore——setHandingOff 内部含 per-session timer，
 * 若拆成独立 store 会引入跨 store timer 协调复杂度，工厂闭包内聚更干净。
 * chat store 经 createHandoffController() 组合后原样透出公共 API，行为零变化。
 */
import { ref } from 'vue'
import type { Ref } from 'vue'

/**
 * handingOff 超时兜底阈值（C2+M1）：handoff 成功后复位完全依赖 session.handoffComplete 广播，
 * 若广播丢失（HMR/App 重挂/时序竞态/断连窗口），源 session 会永久卡「正在交接」。
 *
 * 取 700_000（11min40s）：兜底需晚于 RPC 超时（session.ts HANDOFF_RPC_TIMEOUT_MS=660_000）才复位——
 * 否则用户在 RPC 超时后/兜底复位后重试 handoff，会撞 runtime runHandoff 仍在跑（runtime HANDOFF_TIMEOUT_MS
 * 最长 600s）的 already in progress。故兜底 = RPC 超时 660s + 40s 缓冲，保证 runtime 早已 reject/resolve
 * 后兜底才复位，避免重试竞态。超时后清 handingOff（UI「正在交接…」块消失，用户可重新点 handoff）。
 * store 不直接 toast（关注点分离）。
 */
const HANDING_OFF_TIMEOUT_MS = 700_000

/** handingOff 控制器（chat store 经 createHandoffController() 组合）。 */
export interface HandoffController {
  /** 正在交接的 session 集合（fast-handoff：session.handoff 触发 → session.handoffComplete 复位） */
  handingOffSessions: Ref<Set<string>>
  /** 指定 session 是否正在交接（镜像 isCompacting，per-session 隔离） */
  isHandingOff: (sessionId: string) => boolean
  /**
   * 设置交接态（useHandoffActions.handoff 触发→true / session.handoffComplete 广播或 abort→false）。
   * 不可变 set 保证响应性，镜像 occupancy 投影的不可变写（[u5b] setCompacting 退役后仍成立的响应性范式）。
   *
   * [C2+M1] 超时兜底：value=true 时启动 handingOffTimer（对称 pendingSendTimers），
   * 超时后清 handingOff——防 session.handoffComplete 广播丢失致源 session 永久卡「正在交接」。
   * value=false 时清 timer。store 不 toast（关注点分离）。
   */
  setHandingOff: (sessionId: string, value: boolean) => void
  /** 取消 handingOff 超时兜底 timer（setHandingOff(false) / disposeSession / store dispose 调） */
  clearHandingOffTimer: (sessionId: string) => void
  /** 清全部 timer（store onScopeDispose 调，HMR/$dispose/测试 teardown 避免回调操作废弃 ref） */
  clearAllTimers: () => void
}

/**
 * 构造 handingOff 控制器（chat store 在 setup 内调用一次）。
 *
 * 返回的控制器内部创建 handingOffSessions ref + per-session timer Map，闭包封装全部逻辑。
 * chat store 把返回的成员原样挂到 store 的 return 上，公共 API 与原内联实现完全一致。
 */
export function createHandoffController(): HandoffController {
  /**
   * 正在交接的 session 集合（fast-handoff：session.handoff 触发 → session.handoffComplete 复位）。
   * 镜像 compactingSessions，per-session 隔离。驱动 MessageStream 末尾「正在交接…」瞬时提示。
   * 复位经 effect 层 useHandoffEffect 订阅 session.handoffComplete 广播（不在 useChat switch）。
   */
  const handingOffSessions = ref<Set<string>>(new Set())
  /**
   * handingOff 超时兜底 timer（C2+M1，按 sessionId 隔离，对称 pendingSendTimers）。
   *
   * [ADR-0049 例外] 本 Map 不套 useSessionScopedState。判据：createHandoffController() factory
   * 由 createChatStore（renderer defineStore('chat') 包装，Pinia 按 id 缓存——见 renderer
   * stores/chat.ts）在 setup 内调用一次（store.ts），factory body 全应用只执行一次，本 Map
   * 实质单例。factory 体内非 Vue setup 上下文、无 sidRef: Ref<string|null>；Map 存的是 timer
   * handle（ReturnType<typeof setTimeout>，非 reactive 业务状态）。useSessionScopedState 是
   * setup-scoped 工厂（要求 sidRef + reactive 容器契约），factory 体内不适用——强套需把 factory
   * 改造成 setup composable（破坏 Pinia store 单例语义：每次 useStore() 重新执行会重建 Map
   * 丢失单例）+ reactive 容器语义错位（timer handle 不是响应式状态）。与 lru/coordination/
   * panel-orchestration 同属 ADR-0049 例外（单例性来源不同：那几处是模块级 ES module 单例，
   * 本处是 Pinia defineStore factory 单例）。session 销毁清理：clearHandingOffTimer(sid)
   * （per-session）/ clearAllTimers()（全量）由 createChatStore onScopeDispose 编排调用
   * （store.ts）；测试隔离：factory 模式 per-instance（测试直接调 createHandoffController()
   * 构造新实例）。
   */
  const handingOffTimers = new Map<string, ReturnType<typeof setTimeout>>()

  function isHandingOff(sessionId: string): boolean {
    return handingOffSessions.value.has(sessionId)
  }

  function setHandingOff(sessionId: string, value: boolean): void {
    const next = new Set(handingOffSessions.value)
    if (value) next.add(sessionId)
    else next.delete(sessionId)
    handingOffSessions.value = next
    if (value) {
      // 启动超时兜底 timer（对称 addPendingSend 的 pendingSendTimer 模式）
      clearHandingOffTimer(sessionId)
      handingOffTimers.set(sessionId, setTimeout(() => {
        handingOffTimers.delete(sessionId)
        // 超时未收到 handoffComplete → 清 handingOff（clearHandingOffTimer 是幂等的，timer 已从 Map 移除）
        setHandingOff(sessionId, false)
      }, HANDING_OFF_TIMEOUT_MS))
    } else {
      clearHandingOffTimer(sessionId)
    }
  }

  function clearHandingOffTimer(sessionId: string): void {
    const timer = handingOffTimers.get(sessionId)
    if (timer) {
      clearTimeout(timer)
      handingOffTimers.delete(sessionId)
    }
  }

  function clearAllTimers(): void {
    for (const timer of handingOffTimers.values()) clearTimeout(timer)
    handingOffTimers.clear()
  }

  return {
    handingOffSessions,
    isHandingOff,
    setHandingOff,
    clearHandingOffTimer,
    clearAllTimers,
  }
}
