/**
 * crash-forensics 台账挂点域（自 session-service.ts 行为保持抽取，max-lines 门禁）：
 * D3 checkpoint / D5 inflight-mirror 在 session 生命周期（attach / reclaim）上的挂点
 * + D1 crash 台账 detailDigest 格式化——三者同属 crash-forensics-and-watchdog §3.3
 * 台账设施族，不依赖 SessionService 其余状态，参数化后模块级化。
 *
 * Facade 保留一行调用（订阅注册时序契约不变：组装根内先 projection → records →
 * reconciler → 本域两订阅，见 session-service.ts assembleSubmodules 注释）。
 */
import type { IManagedSessionView } from './types.js'
import { getRuntimeCheckpointStore } from './runtime-checkpoint.js'
import { inflightMirror } from './inflight-mirror.js'

/**
 * attach 挂点的 session 元数据读面（组装根窄注入，同 TraceSync/records 的 deps 模式）：
 * 条目查询经 lifecycle（Map 所有者）只读面，活动时间戳取 pi client 空闲信号，
 * 查看时间戳取 Facade 的 per-sid 查看表。
 */
export interface CrashLedgerHooksDeps {
  getSession: (sessionId: string) => IManagedSessionView | undefined
  activityAt: (sessionId: string) => number | undefined
  viewedAt: (sessionId: string) => number | undefined
}

/**
 * D3 checkpoint（crash-forensics §3.3 D3，u4）attach / respawn 成功挂点：onSessionRegistered
 * 是 create / restore（含自动 respawn 与惰性恢复）/ fork 三入口的注册汇聚点（session-lifecycle
 * registerSession 在 sessions.set 之后同步直发），**一个挂点覆盖四类事件中的全部「附着」
 * 形态**——respawn 成功即 pi 重新附着，无需在 restore 链路另设挂点（单一收敛点 = 无双写）。
 * 元数据取既有读面：filePath/occupancy 来自 lifecycle 条目，lastActivityAt 取 pi client
 * 空闲信号（u1a，attach 瞬间读不到则用本模块时钟兜底），lastViewedAt 取 per-sid 查看表。
 * 台账/checkpoint 都是旁路设施，本订阅体自带异常隔离（异常不外抛——否则会打断
 * registerSession 主链，把旁路故障放大成创建/恢复失败）。
 *
 * D5 mirror 预置 0（crash-forensics §3.3 D5，偏差 #20 接线）：五 spawn 形态（新 session /
 * respawn / reattach / lazy restore / fork）的条目建立腿——与上一挂点同一 registerSession
 * 收敛面（fork 产生新 sessionId，同点覆盖），一挂点覆盖全部附着形态。presetZero = 新
 * reporting epoch（inFlight=0 + 清 hasEverReported，不触碰 injected——spawn 装配顺序
 * 无关，语义见 inflight-mirror.ts 文件头）。独立第二订阅而非并入 checkpoint 订阅体：
 * 两个旁路设施各自 best-effort 异常隔离，故障日志可归因、互不放大。
 */
export function registerCrashLedgerAttachHooks(
  lifecycle: { onSessionRegistered(handler: (sessionId: string) => void): void },
  deps: CrashLedgerHooksDeps,
): void {
  lifecycle.onSessionRegistered((sessionId) => {
    try {
      const session = deps.getSession(sessionId)
      const occupancy = session?.occupancy
      getRuntimeCheckpointStore().upsertSession({
        sessionId,
        filePath: session?.sessionFilePath ?? null,
        activityAt: deps.activityAt(sessionId),
        viewedAt: deps.viewedAt(sessionId),
        occupancy: occupancy && (occupancy.turn !== 'idle' || occupancy.compacting || occupancy.bash)
          ? 'occupied'
          : 'idle',
      })
    } catch (e: unknown) {
      // best-effort 降级：checkpoint 是崩溃恢复的旁路设施，写入异常绝不外抛——
      // 外抛会打断 registerSession 主链，把旁路故障放大成创建/恢复失败。
      console.error(`[session-service] checkpoint attach update failed (sessionId=${sessionId}):`, e)
    }
  })
  lifecycle.onSessionRegistered((sessionId) => {
    try {
      inflightMirror.presetZero(sessionId)
    } catch (e: unknown) {
      // best-effort 降级：mirror 是 errs 判别的旁路设施，预置异常绝不外抛——
      // 外抛会打断 registerSession 主链，把旁路故障放大成创建/恢复失败。
      console.error(`[session-service] mirror preset failed (sessionId=${sessionId}):`, e)
    }
  })
}

/**
 * reclaim 成功的台账摘除腿（D3 checkpoint + D5 mirror，u4/偏差 #20）：回收**不是销毁**
 * （removeSessionEntry 刻意不经此路径），但该 session 已摘出活跃 Map → 不再属
 * 「活跃 session 清单」，从两台账摘除条目（文件本身不删——删除属主在 main 退出链
 * 与 u5 reattach 编排）；mirror 恢复后经预置 0 重建（新 reporting epoch）。
 * 旁路设施各自 best-effort 异常隔离：摘除失败只降级日志，不影响回收主流程
 * （回收已完成的事实不变）。
 */
export function dropCrashLedgersOnReclaim(sessionId: string): void {
  try {
    getRuntimeCheckpointStore().removeSession(sessionId)
  } catch (e: unknown) {
    // best-effort 降级：摘除条目失败不影响回收主流程（回收已完成的事实不变）。
    console.error(`[session-service] checkpoint reclaim removal failed (sessionId=${sessionId}):`, e)
  }
  try {
    inflightMirror.dropSession(sessionId)
  } catch (e: unknown) {
    // best-effort 降级：摘除条目失败不影响回收主流程（回收已完成的事实不变）。
    console.error(`[session-service] mirror reclaim removal failed (sessionId=${sessionId}):`, e)
  }
}

/** 台账 detailDigest 内嵌上限（设计 D1：「末 10 行 stderr 摘要内嵌（≤2KB）」）。 */
const CRASH_DETAIL_DIGEST_MAX_CHARS = 2048

/**
 * crash 事件的 detailDigest：stderr 尾部摘要截断内嵌（取尾不取头——崩溃根因通常在输出末尾，
 * 与 rpc-client getStderrTail 的尾部形态同向）。stderr 为空（信号死亡无输出）时兜底一行
 * 退出形态描述——digest 恒非空，崩溃行的最小归因信息不因 stderr 缺失而全空。
 */
export function buildCrashDetailDigest(code: number | null, stderr: string | undefined): string {
  const tail = (stderr ?? '').trim()
  const digest = tail
    || (code === null
      ? 'process died by signal (no stderr captured)'
      : `process exited with code ${code} (no stderr captured)`)
  // 超限取尾部（保留最接近崩溃现场的输出），换行结构原样保留
  return digest.length > CRASH_DETAIL_DIGEST_MAX_CHARS
    ? digest.slice(-CRASH_DETAIL_DIGEST_MAX_CHARS)
    : digest
}
