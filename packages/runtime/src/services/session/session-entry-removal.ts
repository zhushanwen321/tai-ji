/**
 * SessionEntryRemovalOrchestrator — session 销毁收敛链编排（「唯一完成入口」的编排段）。
 *
 * ★★★ removeSessionEntry 顺序约束 SSOT 在此（r2-23 收敛文档收口，T8 有限拆分 2026-09）★★★
 *
 * 全 runtime 全部 session 删除路径的「完成」语义都汇聚于 SessionService.removeSessionEntry
 * → 本编排器，四路覆盖：① lifecycle.delete 主动删；② onSessionExit pi 进程异常退出；
 * ③ dispatcher.forceQuit 用户强杀；④ restoreSession 清场（clearExistingSessionForRestore）。
 * 「销毁完成」的步骤序列即约束本体，体内顺序是行为等价的一部分（勿调换）：
 *
 *   1. crash journal `deleted` 台账行（D1：唯一挂点，不能挂 onSessionExit 链——主动删
 *      先删进程表，exit handler 反查无条目静默返回，挂错点事件永不产生）
 *   2. checkpoint 摘条目（D3 detach；destroyAll/shutdown 刻意不经本链，checkpoint 原样
 *      保留 = 下次 unclean 启动的恢复依据）
 *   3. inflight mirror 摘条目（D5，与 2 同点位）
 *   4. userStopped 收敛环定时器清理（只停环不清标记——forceQuit 尾步经过本链，标记须
 *      存活到后续 restore）
 *   5. 缓存 destroyedSummary（插件 didDestroy 需要；删后 Map 查不到）
 *   6. sessions Map 条目删除（销毁 9 步第 ② 步，所有者 lifecycle 执行）
 *   7. respawn.cancel（取消 pending 自动恢复 timer，只清 timer 不清熔断计数）
 *   8. lastViewedAt 条目清理（R4）
 *   9. onSessionDelete 扇出（R3：清 ReloadOrchestrator.pendingReload 残留）
 *   10. onSessionDestroyedHandlers 扇出（S3-W2/D6a 回调列表，含插件 didDestroy 投递——
 *       fire-and-forget 语义由各 handler 自持）
 *   11. 后台任务收殓（fire-and-forget）+ watched 退订（D8③）
 *   12. 四域 onSessionDisposed（historyReader → traceSync → projection → records，停
 *       各域定时器/基线；顺序无相互依赖，维持迁移前书写序）
 *   13. MessageBus.clearSession（ring buffer + 订阅者集合清理；幂等）
 *
 * 与 lifecycle.delete 的 B5 段（plugin sessionData：tombstone → dropPartition → trash，
 * 见 session-data-store.ts clearRemovedSessionData）的跨文件顺序约束：**B5 段在
 * removeSessionEntry 完整跑完之后**（didDestroy 先行——插件 worker 迟到的 set/delete
 * 由 SessionDataStore tombstone 丢弃；设计 memory-leak-remediation §3.2-B5）。
 * [B5 禁止挂回] 本链四路中三路是 session **存活**路径（pi 崩溃 respawn 复活同 id /
 * forceQuit restore 重开 / restore 清场摘碑复活），无条件清理插件数据会把存活 session
 * 的数据 tombstone+trash——插件数据清理只属 lifecycle.delete 真删除路径，禁止挂回本链。
 *
 * 组装形态（T8 有限拆分，行为保持抽取）：deps 窄注入与 traceSync/records 同款——session
 * 定位/条目删除经 lifecycle（Map 所有者）、晚期注入状态（messageBus / onSessionDelete /
 * onSessionDestroyedHandlers）经闭包每次调用动态读（setter 注入语义与原 Facade 字段直读
 * 逐字等价）；crash journal / checkpoint / inflight mirror / userStopped gate / 后台任务
 * reaper 为模块单例，直接 import（测试 vi.mock 按模块路径拦截，与消费方所在文件无关）。
 */
import type { SessionSummary } from '@xyz-agent/shared'
// D1 台账（crash-forensics §3.3 D1）：deleted 事件唯一挂点 = 本链第 1 步。
import { getCrashJournal } from '../../infra/crash-journal.js'
// D3 checkpoint（crash-forensics §3.3 D3，u4）：detach 挂点 = 本链第 2 步。
import { getRuntimeCheckpointStore } from './runtime-checkpoint.js'
// D5 在途镜像（crash-forensics §3.3 D5）：detach 同点位摘除 = 本链第 3 步。
import { inflightMirror } from './inflight-mirror.js'
// userStopped 收敛环（session-dead-structural-fixes D4）：只停环不清标记（第 4 步）。
import { userStoppedGate } from './event-interpreter.js'
// 收殓下沉触发面 A（file-lock-unification-and-reaper-sink §3.3）：孤儿后台任务收殓（第 11 步）。
import { reapSessionBackgroundTasks } from './background-task-reaper.js'
import { getPiAgentDir } from '../../infra/pi/pi-paths.js'
import type { IManagedSessionView } from './types.js'

/**
 * 销毁收敛链的窄依赖面：即「销毁一个 session 必须通知/清理的全部合作方」清单——
 * 接口成员本身就是销毁扇出面的显式登记（新增销毁侧合作方 = 新增一个成员 + 序列一步）。
 * 晚期注入状态一律经闭包动态读，禁止构造期拷贝引用（setMessageBus/setOnSessionDelete
 * 等 setter 晚于编排器组装）。
 */
export interface SessionEntryRemovalDeps {
  /** lifecycle（sessions Map 所有者）只读定位（destroyedSummary 缓存用）。 */
  getSession: (sessionId: string) => IManagedSessionView | undefined
  /** 销毁 9 步第 ② 步：Map 条目删除（所有者执行，纯删除不发事件）。 */
  removeEntry: (sessionId: string) => void
  /** summary 投影（Facade 共享 helper，销毁通知富化用）。 */
  toSummary: (session: IManagedSessionView) => SessionSummary
  /** u8：取消 pending 自动恢复 timer（只清 timer 不清熔断计数，理由见 pi-respawn.cancel）。 */
  cancelRespawn: (sessionId: string) => void
  /** R4：lastViewedAt 条目清理（回收态不经本链，见 Facade.clearSessionViewed）。 */
  clearSessionViewed: (sessionId: string) => void
  /** R3：onSessionDelete 扇出（晚期 setter 注入，动态读）。 */
  fireOnSessionDelete: (sessionId: string) => void
  /** S3-W2/D6a：销毁回调列表（含插件 didDestroy；晚期追加式注册，动态读）。 */
  getOnSessionDestroyedHandlers: () => ReadonlyArray<(summary: SessionSummary) => void>
  /** D8③：后台任务 watched 集合退订。 */
  unwatchBackgroundTasks: (sessionId: string) => void
  /** wave:perf-w20：历史重建缓存 + lastLeafId 清理（historyReader.onSessionDisposed）。 */
  disposeHistoryReader: (sessionId: string) => void
  /** session-trace（A33）：trace 增量腿基线与串行链清理。 */
  disposeTraceSync: (sessionId: string) => void
  /** W7/W8/W12：per-session 实例组销毁 + state_changed diff 基线清理。 */
  disposeProjection: (sessionId: string) => void
  /** W18：record entry 派生缓存销毁（停防抖定时器）。 */
  disposeRecords: (sessionId: string) => void
  /** wave:runtime-wiring（GAP1）：MessageBus 该 session 状态清理（幂等，未注入时 no-op）。 */
  clearMessageBusSession: (sessionId: string) => void
}

export class SessionEntryRemovalOrchestrator {
  constructor(private readonly deps: SessionEntryRemovalDeps) {}

  /**
   * 销毁收敛链本体：四路删除路径的唯一完成入口（覆盖面与顺序约束见文件头 SSOT 段）。
   * 步骤序列 = 迁移前 SessionService.removeSessionEntry 体内顺序逐字保持。
   */
  remove(sessionId: string): void {
    // ── 第 1-4 步：「该 session 已不存在」的旁路设施摘除（台账/checkpoint/mirror/收敛环）──
    // D1 台账（crash-forensics §3.3 D1 写入点矩阵 deleted 行）：deleted 事件唯一挂点 = 本
    // 汇聚链（lifecycle.delete 主动删与 onSessionExit 异常退收殓的公共收口，注释自述即此
    // 语义）。不能挂 onSessionExit 链：用户主动删走 destroySession 先删进程表 → exit handler
    // 反查无条目静默返回，不经该链，挂错点事件永不产生（抑制语义，设计 D1 deleted 行）。
    getCrashJournal().append({ layer: 'pi', event: 'deleted', sessionId })
    // D3 checkpoint（u4）detach 挂点（紧接上条台账行）：本汇聚链是「该 session 已不存在」
    // 的精确时点（主动删 / 进程退出 / forceQuit / restore 清场全覆盖），从活跃清单摘除
    // 条目。pi 意外崩死也走本点（先摘后 respawn 成功再经 onSessionRegistered 重新加入，
    // 5s 窗口内 runtime 自身再崩则该 session 不在 checkpoint——设计 D3「respawn pending
    // 状态不进 checkpoint」的落地形态，errs 方向 = 漏恢复退化 lazy，已登记）。
    // 注意：destroyAll（shutdown）刻意不经本点（lifecycle.clear 直调）——进程将亡时
    // checkpoint 必须保留原样：它正是下次 unclean 启动的恢复依据（契约 1 runtime 任何
    // 退出路径不删文件）。
    try {
      getRuntimeCheckpointStore().removeSession(sessionId)
    } catch (e: unknown) {
      // best-effort 降级：旁路设施故障不得打断销毁收敛链（销毁已完成的事实不变）。
      console.error(`[session-service] checkpoint detach removal failed (sessionId=${sessionId}):`, e)
    }
    // D5 mirror（偏差 #20 接线）：detach 同点位摘除条目——「该 session 已不存在」的精确
    // 时点与 checkpoint 同语义（主动删 / 进程退出 / forceQuit / restore 清场全覆盖）。
    // pi 崩死路径先摘、respawn 成功经 onSessionRegistered 预置重建（新 reporting epoch）。
    try {
      inflightMirror.dropSession(sessionId)
    } catch (e: unknown) {
      // best-effort 降级：旁路设施故障不得打断销毁收敛链（销毁已完成的事实不变）。
      console.error(`[session-service] mirror detach removal failed (sessionId=${sessionId}):`, e)
    }
    // D4：收敛环定时器清理（所有删除路径汇聚点：主动删 / 进程退出 / forceQuit / restore
    // 清场）。只停环不清标记——forceQuit（K1/K2）尾步经过本汇聚链，标记必须存活到后续
    // restore（标记宿主独立于 ManagedSession 生命周期的原因，见 session-service.ts 模块级
    // Map 注释）；delete 路径的标记清理由 lifecycle.delete 显式调 gate.disposeForDelete。
    userStoppedGate.disposeForEntryRemoval(sessionId)

    // ── 第 5-9 步：Map 条目删除与删除回调扇出 ──
    // S3-W2：删除前缓存 summary（插件 didDestroy 通知需要 SessionInfo；删除后 Map 查不到）。
    // Map 无条目（防御路径）时构造最小形状——id 之外的字段无从得知，宁发少知不发错。
    const session = this.deps.getSession(sessionId)
    const destroyedSummary: SessionSummary = session
      ? this.deps.toSummary(session)
      : { id: sessionId, label: sessionId, cwd: '', status: 'dead', lastActiveAt: 0, modelId: '', tokenCount: 0 }
    // 销毁 9 步的第 ② 步（设计 D2②）：委托 lifecycle 删 Map 条目——所有者执行，纯删除
    // 不发事件（其余步骤编排权在本编排器，体内顺序 = 迁移前行为等价的一部分）。
    this.deps.removeEntry(sessionId)
    // u8（crash-resilience D7-② 取消语义）：本汇聚链是「该 session 已不存在」的精确时点
    // ——取消 pending 自动恢复 timer（5s 窗口内用户删除 session，若不取消，timer 触发会
    // 为已删 session spawn pi 再附着失败，空转 spawn+kill）。只清 timer 不清失败计数
    //（本汇聚链被 restoreSession 清场复用，清计数会破坏熔断——理由见 pi-respawn.cancel）。
    // 覆盖面：主动删 / onSessionExit 进程退出（先 cancel 后 schedule，顺序安全）/ forceQuit
    // / restore 清场全部删除路径。
    this.deps.cancelRespawn(sessionId)
    // R4（idle-pi-reclamation D2 #6）：真删除是 lastViewedAt 条目的清理挂点——本汇聚链是
    // 「该 session 已不存在」的精确时点（与 respawn.cancel 同因同挂点）。回收态不清
    // （reclaimManagedSession 不经本汇聚链，回收态保留条目是 D2 #6 设计意图）。
    this.deps.clearSessionViewed(sessionId)
    // R3：所有删除路径（lifecycle.delete 主动删 + onSessionExit 进程异常退）汇聚于此，
    // 触发 onSessionDelete 清 ReloadOrchestrator.pendingReload 残留。
    this.deps.fireOnSessionDelete(sessionId)

    // ── 第 10-11 步：销毁通知扇出与后台任务收殓 ──
    // S3-W2 + D6a：同一汇聚点触发回调列表（插件 didDestroy 投递 + 挂起 UI 请求清理等）。
    // 逐个 try/catch 隔离：单 handler 异常不阻塞删除主流程，也不阻断列表内其余 handler。
    for (const handler of this.deps.getOnSessionDestroyedHandlers()) {
      try {
        handler(destroyedSummary)
      // eslint-disable-next-line taste/no-silent-catch -- best-effort 降级：销毁回调异常不外抛（删除主流程优先），仅落日志供排查
      } catch (e: unknown) {
        console.error(`[session-service] onSessionDestroyed listener error (sessionId=${sessionId}):`, e)
      }
    }
    // 收殓下沉触发面 A（D2，设计 docs/architecture/file-lock-unification-and-reaper-sink.md
    // §3.3 挂点论证）：本汇聚链是「该 session 的 pi 确认死亡」的精确时点（主动删 /
    // onSessionExit 进程退出 / forceQuit 编排 / restore 清场全部经此），覆盖面大于
    // pm.onSessionExit（后者只覆盖进程退出）。fire-and-forget：void + catch warn，
    // 入口内部 setImmediate 延后同步处置（含 spawnSync ps），不阻塞销毁收敛链。
    // registry 不存在（该 session 从未跑过后台任务）时为静默 no-op。
    void reapSessionBackgroundTasks(getPiAgentDir(), sessionId).catch((e: unknown) => {
      console.warn(`[session-service] background task reap failed (sessionId=${sessionId}):`, e)
    })
    // background-task-sidebar D8③（u-runtime-rpc③）：watched 集合退订——session 销毁后
    // 该 sid 的 registry 不再参与 mtime 轮询/变更检测。与 reapSessionBackgroundTasks 同挂
    // 本汇聚链（主动删 / 进程退出 / forceQuit / restore 清场全覆盖，D8④ runtime 侧腿）。
    this.deps.unwatchBackgroundTasks(sessionId)

    // ── 第 12-13 步：per-session 域状态销毁与 MessageBus 分区清理 ──
    // wave:perf-w20（D6-1）：session 删除 / pi 进程退出时清历史重建缓存 + lastLeafId
    // ——真删除后缓存必须清，清理行为本身正确。但「pi 进程退出后缓存基线（lastLeafId）
    // 必不再与新进程的 entry 集合对应、保留只会走 "Entry not found" fallback」的因果断言
    // 已被实测推翻；[B8 更新] 空闲回收（reclaimManagedSession）仍不经本汇聚链（回收≠
    // 销毁），但其历史缓存条目改由回收编排驱逐（ReclaimSessionDeps.
    // evictHistoryRebuildCache → evictHistoryRebuildCache，§3.3-B8 候选 C），P7 实测的
    // 「回收→恢复零重建」路径被显式放弃（证据：packages/runtime/src/__tests__/services/
    // idle-pi-reclaim-integration.test.ts 阶段 4）。S6 起清理随域迁入 historyReader
    //（onSessionDisposed 直调形态，traceSync/projection 同款）。
    this.deps.disposeHistoryReader(sessionId)
    // session-trace（A33）：同汇聚点清 trace 增量腿基线与串行链（与 historyCache 同因——
    // 基线跨进程存活无意义；链已 settled，删 Map 条目只释放槽位）。S4：清理随域迁入
    // TraceSync（各域 onSessionDisposed 直调形态）。
    this.deps.disposeTraceSync(sessionId)
    // W7/W8 + W12：销毁 per-session 实例组与 state_changed diff 基线（与 historyCache.delete
    // 同汇聚点——主动删 + 进程退出）。dispose 停防抖/退避/周期兜底全部定时器。S5 起清理
    // 随域迁入 projection（onSessionDisposed 直调形态，traceSync 同款）。
    this.deps.disposeProjection(sessionId)
    // W18：销毁 record entry 派生缓存（同汇聚点）。停防抖定时器（在途 inflight 的拉取
    // 完成后 applyRecordEntries 的 hasSession 守卫拦住发布，不复活已清 bus 条目）。S6 起
    // 清理随域迁入 records（onSessionDisposed 直调形态，traceSync/projection 同款）。
    this.deps.disposeRecords(sessionId)
    // wave:runtime-wiring（GAP1 决策）：session 销毁时清理 MessageBus 的该 session 状态
    // （ring buffer + state snapshot + 订阅者集合 + 反查表）。幂等（ES1：session 不存在 no-op）。
    // 不在 pi flush / turn 结束时清理——ring 容量 1000 会自然 FIFO 淘汰旧 turn delta，
    // turn 边界清理是阶段 2 的精细化策略（届时评估）。
    this.deps.clearMessageBusSession(sessionId)
    // [B5 触发面收窄 2026-09-15] plugin sessionData 清理（tombstone + trash + 分区摘除）
    // 的历史挂点在本尾段，已迁出至 lifecycle.delete 真删除路径（session-lifecycle.ts delete
    // 内 B5 注释）。迁出理由与跨文件顺序约束见文件头 SSOT 段「B5 禁止挂回」。
  }
}
