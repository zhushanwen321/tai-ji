/**
 * LocalHandlerRegistry — Worker 侧 handler-id → handler 的本地 Map 管理（C7/C8）。
 *
 * 收编散落在 createSessionApi / createHookApi 的重复骨架：
 * - 「handlerId → handler」本地 Map（C8 onNotification dispatch：收通知 → 查 map → 调 handler）
 * - 「注册 handler + 返回 Disposable，dispose 时删 map + 发 RPC 注销」（C7 Disposable 注册）
 *
 * 之前每个 api 文件手写 Map + onNotification + { dispose: () => { map.delete(); rpc.request(unregister) } }，
 * 逐文件复制。现在统一到这里：调用方提供 handlerId 生成器 + RPC 注销方法名即可。
 *
 * 不动 register/create 对偶骨架本身（既有 D5：那是 ports-and-adapters 的有意 seam），
 * 只收编骨架内的 Map + Disposable 样板。
 */

/**
 * 注册一个 handler 到本地 Map，返回 Disposable。
 *
 * @param map       本地 handler Map（handlerId → handler）
 * @param handlerId 调用方生成的唯一 id
 * @param handler   要存储的 handler
 * @param onDispose dispose 时执行的清理（通常是发 RPC 注销）；异步错误由调用方在闭包内处理
 * @returns Disposable：dispose 时从 map 删 handler 并执行 onDispose
 */
export function registerHandler<T>(
  map: Map<string, T>,
  handlerId: string,
  handler: T,
  onDispose?: () => void,
): { dispose: () => void } {
  map.set(handlerId, handler)
  return {
    dispose: () => {
      map.delete(handlerId)
      onDispose?.()
    },
  }
}

/**
 * 从通知参数中查 map 并派发给 handler（C8 onNotification dispatch 骨架）。
 *
 * 收编 createSessionApi/createHookApi 里重复的：
 * ```ts
 * onNotification(method, (params) => {
 *   const p = params as { handlerId: string; ... }
 *   const handler = map.get(p.handlerId)
 *   if (handler) handler(p.xxx)
 * })
 * ```
 *
 * @param map         本地 handler Map
 * @param params      通知 payload（须含 handlerId）
 * @param invoke      从 payload 提取参数并调用 handler
 * @returns true 命中并调用，false 未命中（handler 不存在）
 */
export function dispatchHandler<T>(
  map: Map<string, T>,
  params: { handlerId: string },
  invoke: (handler: T) => void,
): boolean {
  const handler = map.get(params.handlerId)
  if (!handler) return false
  invoke(handler)
  return true
}
