/**
 * internal-event-bus.ts —— InternalEventBus（IF2/TC4）。
 *
 * core 内建轻量同步 typed emitter：MessageBusBridge 是 plugin 系与 extension 系消息的唯一 emitter，
 * 消费端（StatusBarController/ViewHostStore/OverlayLifecycle 等）on 订阅，emit 后 handler 同步立即执行。
 *
 * 契约（IF2）：
 * - typed：消费端 on(kind, handler) 编译期类型安全（无 any 断言）
 * - 同步派发（非异步队列）
 * - on 返回 unsubscribe；模块 unmount/session cleanup 时调 unsubscribe 防泄漏（项目规则#2）
 * - handler 抛错不静默吞（上抛，项目规则「失败要出声」）
 */
import type { InternalEvent } from './types'

type Handler<E extends InternalEvent> = (e: E) => void

export class InternalEventBus {
  private handlers = new Map<InternalEvent['kind'], Set<Handler<InternalEvent>>>()

  /**
   * 订阅指定 kind 的事件。返回 unsubscribe：调用后该 handler 不再收到该 kind 的事件。
   * 重复订阅同一 handler 会被去重（Set 语义）。
   */
  on<K extends InternalEvent['kind']>(
    kind: K,
    handler: (e: Extract<InternalEvent, { kind: K }>) => void,
  ): () => void {
    let set = this.handlers.get(kind)
    if (!set) {
      set = new Set()
      this.handlers.set(kind, set)
    }
    set.add(handler as Handler<InternalEvent>)
    return () => {
      set!.delete(handler as Handler<InternalEvent>)
    }
  }

  /** 同步派发：emit 后所有订阅该 kind 的 handler 立即执行（按订阅顺序）。handler 抛错上抛。 */
  emit(e: InternalEvent): void {
    const set = this.handlers.get(e.kind)
    if (!set || set.size === 0) return
    for (const handler of set) {
      handler(e)
    }
  }
}
