/**
 * overlay-lifecycle.ts —— OverlayLifecycle（IF9）。
 *
 * companion overlay 状态机：per-session + per-requestId 双键分区（createSessionScopedMap），
 * expanded → minimized(badge) → restored。窗口化是 renderer 能力，plugin 只 await 结果
 * 不感知状态（§6.4）。
 *
 * 契约（IF9 + clarify Q2 裁决）：
 * - ui-request 到达自动建分区（expanded 初始态，已存在不覆盖）
 * - transition 非法迁移（如 restored → expanded 未定义）no-op 不抛错
 * - sessionId 缺失 → '__global__' 保留键分区（GLOBAL_OVERLAY_KEY 导出供壳层 s4 消费）
 * - session-destroyed → cleanup（ERR4）；__global__ 分区不受 session-destroyed 影响
 *   （由壳层 dispose 时整体 cleanup）
 */
import type { InternalEventBus } from './internal-event-bus'
import type { SessionScopedMap } from './utils/session-scoped-map'

export type OverlayState = 'expanded' | 'minimized' | 'restored'

/** 无 sessionId 的 ui-request 分区保留键（clarify Q2，供壳层 s4 消费）。 */
export const GLOBAL_OVERLAY_KEY = '__global__'

/** 合法迁移表：expanded→minimized→restored；同态迁移（如 expanded→expanded）幂等。 */
const VALID_TRANSITIONS: Record<OverlayState, Set<OverlayState>> = {
  expanded: new Set(['minimized', 'expanded']),
  minimized: new Set(['restored', 'minimized']),
  restored: new Set(['restored']),
}

export interface OverlayLifecycleDeps {
  bus: InternalEventBus
  /** 分区值类型：requestId → OverlayState（per-session 分区） */
  sessionScoped: SessionScopedMap<Map<string, OverlayState>>
}

export class OverlayLifecycle {
  private unsubscribe: (() => void)[] = []

  constructor(private deps: OverlayLifecycleDeps) {}

  /** 订阅 ui-request（自动建分区）+ session-destroyed（cleanup）。返回取消订阅函数。 */
  subscribe(): () => void {
    if (this.unsubscribe.length > 0) return this.dispose.bind(this)
    this.unsubscribe.push(this.deps.bus.on('ui-request', (e) => {
      const key = e.sessionId ?? GLOBAL_OVERLAY_KEY
      const partition = this.deps.sessionScoped.getOrDefault(key)
      if (!partition.has(e.request.requestId)) {
        partition.set(e.request.requestId, 'expanded')
      }
    }))
    this.unsubscribe.push(this.deps.bus.on('session-destroyed', (e) => {
      this.deps.sessionScoped.cleanup(e.sessionId)
    }))
    return this.dispose.bind(this)
  }

  /**
   * 状态迁移：非法迁移（restored→expanded 未定义）no-op 不抛错（IF9 契约）。
   * sessionId 缺失 → '__global__' 分区（clarify Q2）。
   */
  transition(sessionId: string | undefined, requestId: string, to: OverlayState): void {
    const key = sessionId ?? GLOBAL_OVERLAY_KEY
    const partition = this.deps.sessionScoped.getOrDefault(key)
    const current = partition.get(requestId)
    // 无当前状态（分区未建）→ 视为 expanded 起点；非法迁移 no-op
    if (current !== undefined && !VALID_TRANSITIONS[current].has(to)) return
    partition.set(requestId, to)
  }

  /** 查 overlay 状态：分区或 requestId 不存在返回 undefined。 */
  getState(sessionId: string | undefined, requestId: string): OverlayState | undefined {
    const key = sessionId ?? GLOBAL_OVERLAY_KEY
    return this.deps.sessionScoped.get(key)?.get(requestId)
  }

  /** 取消全部订阅（幂等）。 */
  dispose(): void {
    for (const unsub of this.unsubscribe) unsub()
    this.unsubscribe = []
  }
}
