/**
 * handingOff 瞬时态子域（fast-handoff）—— 从 chat store 抽取的内聚模块。
 *
 * 本模块是 chat store 的一个子关注点：追踪「正在交接」的 session 集合（per-session 隔离），
 * 镜像 compactingSessions 的 Set 模式。
 *
 * 设计选择（工厂模块，对齐 chat-changeset.ts）：
 * 采用「工厂模块」而非 defineStore——工厂闭包内聚更干净。
 * chat store 经 createHandoffController() 组合后原样透出公共 API，行为零变化。
 *
 * [ADR-0122] 无墙钟兜底 timer：复位完全依赖事件（session.handoffComplete / handoffAborted
 * 广播、RPC reject catch、abort 编排）。广播丢失（断连窗口）时源 session 卡「正在交接」=
 * 悬挂显式可见，不自愈不补偿；用户出口 = composer stop 按钮（abortHandoff 乐观清态）/ 重试。
 */
import { ref } from 'vue'
import type { Ref } from 'vue'

/** handingOff 控制器（chat store 经 createHandoffController() 组合）。 */
export interface HandoffController {
  /** 正在交接的 session 集合（fast-handoff：session.handoff 触发 → session.handoffComplete 复位） */
  handingOffSessions: Ref<Set<string>>
  /** 指定 session 是否正在交接（镜像 isCompacting，per-session 隔离） */
  isHandingOff: (sessionId: string) => boolean
  /**
   * 设置交接态（useHandoffActions.handoff 触发→true / session.handoffComplete 广播、
   * handoffAborted 广播或 RPC reject catch→false）。
   * 不可变 set 保证响应性，镜像 occupancy 投影的不可变写（[u5b] setCompacting 退役后仍成立的响应性范式）。
   */
  setHandingOff: (sessionId: string, value: boolean) => void
}

/**
 * 构造 handingOff 控制器（chat store 在 setup 内调用一次）。
 *
 * 返回的控制器内部创建 handingOffSessions ref，闭包封装全部逻辑。
 * chat store 把返回的成员原样挂到 store 的 return 上，公共 API 与原内联实现完全一致。
 */
export function createHandoffController(): HandoffController {
  /**
   * 正在交接的 session 集合（fast-handoff：session.handoff 触发 → session.handoffComplete 复位）。
   * 镜像 compactingSessions，per-session 隔离。驱动 MessageStream 末尾「正在交接…」瞬时提示。
   * 复位经 effect 层 useHandoffEffect 订阅 session.handoffComplete 广播（不在 useChat switch）。
   */
  const handingOffSessions = ref<Set<string>>(new Set())

  function isHandingOff(sessionId: string): boolean {
    return handingOffSessions.value.has(sessionId)
  }

  function setHandingOff(sessionId: string, value: boolean): void {
    const next = new Set(handingOffSessions.value)
    if (value) next.add(sessionId)
    else next.delete(sessionId)
    handingOffSessions.value = next
  }

  return {
    handingOffSessions,
    isHandingOff,
    setHandingOff,
  }
}
