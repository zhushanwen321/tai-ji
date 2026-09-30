/**
 * reattach 投递对账触发（A5/V5 缺口修复；u4 追加项，协调者派发）。
 *
 * 问题（无提交活动 ⇒ 无人对账）：
 * - `session-delivery-registry.reconcile(sessionId, trigger)` 首行即 `runtimes.get(sessionId)`
 *   短路——**无内核运行时即 no-op**；
 * - 内核运行时的创建点只有提交类入口（`submit` / `getOrCreateDelivery`）与 transport 装配
 *   （`session_manager send` 等）——runtime 滚动重启（exit 86）后若 renderer 只重连 + resync、
 *   用户不发新消息，就没有任何提交活动 ⇒ 不会创建运行时 ⇒ 对账链（clear_queue 收养 /
 *   transcript 重建 / resync 判重）全部不成立：pi 槽位滞留文本不会被收养重建，
 *   `delivery.resync` 也因无运行时读不到 transcript（返回空判重集）。
 *
 * 修法（本模块）：reattach 恢复路径的 restore 包装——**先建运行时、再触发对账**，实现为
 * 一次性动作（restore 每 session 一次），不引入常驻轮询。挂点 = 组合根
 * `runStartupReattach({ restore: createReattachRestore({...}) })`（index.ts）。
 *
 * 顺序硬约束（两条）：
 * 1. `ensureDeliveryRuntime` 必须先于 `reconcile`——reconcile 无运行时即 no-op（见上）；
 * 2. 对账的 client 解析（'pi-restored' 触发点）走 `ensureActive`（幂等读取，不新建进程）：
 *    本包装在 `restore` 成功之后执行，pi 已附着——不额外拉起被 idle 回收的 session。
 *
 * 触发点语义：`'pi-restored'`（registry 的 ReconcileTrigger）——transcript 标记扫描 +
 * clear_queue 三分处置（自有条目重投 / 带标记无记录重建 / 无标记外来文本收养）在
 * reattach 后的唯一正确触发面。刻意不在每次 session attach 上触发（`getOrCreateDelivery`
 * 会挂 watchdog/settled 订阅，常驻面扩张非本缺口所需；lazy 激活路径的提交类入口已自建运行时）。
 */
export interface ReattachDeliveryTriggerDeps {
  /** 恢复执行（生产 = sessionService.restoreSession；失败语义由调用方承载）。 */
  restore(sessionId: string): Promise<unknown>
  /** 建/取该 session 的投递内核运行时（生产 = registry.getOrCreateDelivery）。 */
  ensureDeliveryRuntime(sessionId: string): void
  /** 对账触发（生产 = registry.reconcile(sessionId, 'pi-restored')）。 */
  reconcile(sessionId: string): Promise<void>
  /** 留痕（对账异步入链失败的告警出口；生产 = 组合根 console.warn）。 */
  log?(message: string): void
}

/**
 * 构造 reattach restore 包装（`runStartupReattach` 的 deps.restore）。
 *
 * 对账刻意 fire-and-forget：restore 的契约是「恢复该 session」（编排按并发 2 分批、逐
 * session 容错），对账是恢复后的收尾（槽位收养/重建）——其失败不得记为 restore 失败
 * （否则编排会按 restore-failed 跳过该 session，把「有滞留可收养」误判成「恢复失败」）。
 * registry.reconcile 内部自兜错（clear_queue 失败本轮放弃、下轮触发点重试），本包装的
 * catch 只兜「调用本身抛错」的防御性形态。
 */
export function createReattachRestore(
  deps: ReattachDeliveryTriggerDeps,
): (sessionId: string) => Promise<unknown> {
  return async (sessionId: string): Promise<unknown> => {
    const result = await deps.restore(sessionId)
    deps.ensureDeliveryRuntime(sessionId)
    void deps.reconcile(sessionId).catch((e: unknown) => {
      const message = e instanceof Error ? e.message : String(e)
      deps.log?.(`post-reattach reconcile failed (retry at next trigger), sid=${sessionId}: ${message}`)
    })
    return result
  }
}
