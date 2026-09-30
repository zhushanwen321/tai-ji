/**
 * mock 订阅工厂 —— 从 mock/index.ts 抽出（通用，无 mock 业务依赖）。
 *
 * 注册后微任务触发一次初始值（模拟 sendInitialState）；请求型 mock 直接返 fixture 深拷贝，
 * 不走本工厂。broadcast 模拟 runtime 广播状态变更。
 */

/** 订阅者回调类型 */
export type GlobalHandler<T> = (data: T) => void

/** mock 订阅工厂：注册即微任务触发初始值（模拟连接后推送；避免同步触发时组件未挂载完） */
export function makeMockSubscription<T>(initial: () => T) {
  const handlers = new Set<GlobalHandler<T>>()
  return {
    subscribe(handler: GlobalHandler<T>): () => void {
      handlers.add(handler)
      queueMicrotask(() => handler(initial()))
      return () => {
        handlers.delete(handler)
      }
    },
    /** 向所有订阅者推送新值（模拟 runtime 广播状态变更）。单 handler 异常隔离（对齐 real
     *  events.ts safeForEach 语义 + mock emit 同批）：一个订阅者抛错不中断其余订阅者，
     *  也不穿透调用方 await 的 mock 动作。 */
    broadcast(value: T): void {
      for (const h of handlers) {
        try {
          h(value)
        } catch (e) {
          // 隔离降级：留痕后继续遍历（辅助分发通道，单订阅者故障不炸整个 mock 动作）
          console.error('[mock] subscription handler threw, continuing broadcast:', e)
        }
      }
    },
    /** 取当前初始值快照（供 mock 动作读最新态） */
    snapshot(): T {
      return initial()
    },
  }
}
