/**
 * PendingTracker — 请求/回复登记表（D15/D25）。
 *
 * 收编 plugin-rpc-client / plugin-rpc-server / plugin-activator.pendingReplies
 * 三处同构的 `Map<K, { resolve, reject, timer }>` + setTimeout(reject) +
 * clearTimeout(on reply) + rejectAll(on dispose) 样板。
 *
 * 抽象边界（刻意收窄，不污染）：
 *   - 超时语义统一为 reject(timeoutError)：调用方在 register 时传入要 reject 的 Error，
 *     tracker 不关心 error 的形态（#2 带 .code、#3/#4 纯 Error，都由调用方构造）。
 *   - resolve 通道把原始值交给调用方：reply 是否算"成功"是领域逻辑，不由 tracker 判断。
 *     调用方在收到回复后，自己决定调 resolve(k, value) 还是 reject(k, err)。
 *   - 不支持 timeout-default、不支持注册副作用钩子：这些是 pendingPermissions /
 *     pendingUiRequests 的异类语义，它们各自保留，不入本抽象。
 */

export class PendingTracker<K extends string | number, T> {
  private pending = new Map<K, {
    resolve: (value: T) => void
    reject: (error: Error) => void
    timer: ReturnType<typeof setTimeout>
  }>()

  /** 当前登记的请求数量。 */
  get size(): number {
    return this.pending.size
  }

  /** 是否存在登记中的 key（handleResponse 的命中判断）。 */
  has(key: K): boolean {
    return this.pending.has(key)
  }

  /**
   * 登记一个 pending 请求，返回在回复到达或超时后被解析的 Promise。
   *
   * @param timeoutError 超时时要 reject 的 Error——由调用方构造，
   *   tracker 不关心其形态（纯 Error / Object.assign 带 code 均可）。
   */
  register(key: K, timeoutMs: number, timeoutError: Error): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(key)
        reject(timeoutError)
      }, timeoutMs)

      this.pending.set(key, { resolve, reject, timer })
    })
  }

  /**
   * 成功回复到达时调用：解析对应 Promise 并清理 timer。
   * @returns 是否命中（false 表示该 key 不在登记表中，调用方可据此区分"回复"与"主动请求"）。
   */
  resolve(key: K, value: T): boolean {
    const entry = this.pending.get(key)
    if (!entry) return false
    clearTimeout(entry.timer)
    this.pending.delete(key)
    entry.resolve(value)
    return true
  }

  /**
   * 失败回复到达时调用（如 JSON-RPC error 响应）：拒绝对应 Promise。
   * @returns 是否命中。
   */
  reject(key: K, error: Error): boolean {
    const entry = this.pending.get(key)
    if (!entry) return false
    clearTimeout(entry.timer)
    this.pending.delete(key)
    entry.reject(error)
    return true
  }

  /**
   * 拒绝所有登记中的请求（用于 dispose / 进程退出）。
   * 清理后 tracker 为空，可安全丢弃。
   */
  rejectAll(error: Error): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer)
      entry.reject(error)
    }
    this.pending.clear()
  }
}
