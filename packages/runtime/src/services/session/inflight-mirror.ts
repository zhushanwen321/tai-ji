/**
 * inflight-mirror — subagent 在途上报的 runtime 侧只读镜像（u7b）。
 *
 * 设计权威源：docs/design/crash-forensics-and-watchdog.md §3.3 D5「缺席与丢失的语义收敛」①-⑤。
 * 生产侧契约（u7a，packages/extension-protocol/src/extensions/subagent-inflight/）：pi 进程内
 * subagent-workflow 壳层经既有 select 通道推送在途帧（title = SUBAGENT_INFLIGHT_MARKER），
 * 每帧携带该 session 的**绝对计数**（非增量——单帧丢失由后续帧覆盖纠正，不累积误差）。
 *
 * 消费侧：event-adapter marker 路由分支（合法帧 → applyReport + ack；绝不广播前端）。
 *
 * 条目语义（errs 判别的前提，D5 ④；2026-09-13 oe-audit 修订：原「旧版 extension
 * 组合」立论被同 bundle 发布 + pi 随 runtime 退出销毁两条事实证伪，errs 兜底对象
 * 收敛为 reporter/select 通道结构性故障——builtin extension 与 runtime 同包同版本，
 * 版本错配组合在发布拓扑里不可达）：
 * - `injected`：该 session 实际注入了 subagent-workflow（spawn 执行者 u4/u5 按 getExtensionPaths
 *   结果调 setInjected）。未注入 ⇒ 无 pi 引擎 subagent 能力 ⇒ 判「无在途」（正确语义而非 errs）——
 *   禁用态全局快照判「无在途」会误杀 mid-session 禁用窗口内仍活着的 extension。
 * - `hasEverReported`：**当前 reporting epoch**（本次 pi 进程生命期）内是否收到过任何合法上报
 *   （含初始 count=0）。「已注入且曾收到上报」→ 按 inFlight 判；「已注入但从未收到」（reporter
 *   放弃 / 通道结构性故障 / 真缺席）→ errs 推迟（镜像计数取 null + reason=absent-report，
 *   事件发射语义在 u7c）。
 * - `inFlight`：最近一帧的绝对计数；无条目 = 未知（消费方按「无在途」判，见 query 注释）。
 *
 * 生命周期对账（D5 ③：镜像挂 session 生命周期，消灭 stale-high 永久残留）：
 * - 条目建立的完整事件集 = 初始上报到达 ∪ 五形态 spawn 预置 0（新 session / respawn / reattach /
 *   lazy restore / fork）——收敛为 registerSession 单挂点调用 presetZero（u4/u5 接线，
 *   见 session-service.ts「一挂点覆盖全部附着形态」）。
 * - 预置/对账重置同时清 `hasEverReported`：重置后的 pi 进程 = 新 reporting epoch，旧 epoch 的
 *   「曾上报」不可继承——继承会让 respawn 后的通道结构性故障形态永久绕过 errs 判别（漏推迟、
 *   在途被杀，D5 ⑤ 偏低方向）；清空方向 errs-safe（最坏进 errs 推迟，30min 有界）。
 * - `injected` 只由 setInjected 写（presetZero 不触碰）——spawn 装配顺序无关，防
 *   「先预设后注入」被预设抹掉的 footgun。
 * - 删除 = dropSession（session 删除/回收摘除时调用）。
 */

import type { SubagentInFlightReport } from '@xyz-agent/extension-protocol'

/** errs 判别形态（D5 ④）：已注入且从未收到上报 → 'absent-report'；其余 → null。 */
export type InFlightErrsShape = 'absent-report' | null

/** 单个 session 的在途镜像条目（快照形态——query 返回副本，外部不可改内部态）。 */
export interface InFlightMirrorEntry {
  /** 该 session 是否实际注入了 subagent-workflow（setInjected 唯一写方）。 */
  injected: boolean
  /** 本 reporting epoch 是否收到过任何合法上报（含初始 count=0）。 */
  hasEverReported: boolean
  /** 最近一帧绝对计数（当前非 idle 句柄数）。 */
  inFlight: number
}

export interface InFlightMirror {
  /** 声明该 session 的 extension 注入态（spawn 时刻由 u4/u5 按实际注入列表调用；唯一写方）。 */
  setInjected(sessionId: string, injected: boolean): void
  /**
   * spawn 形态预置 0（条目建立腿之一）：新建或重置该 session 条目为 inFlight=0、
   * hasEverReported=false。调用方 = u4/u5（新 session / respawn / reattach / lazy restore / fork，
   * 收敛为 registerSession 单挂点）。
   */
  presetZero(sessionId: string): void
  /** session 终结：删条目（session 删除 / 回收摘除；与生命周期同删）。 */
  dropSession(sessionId: string): void
  /** 绝对计数帧到达：整值覆盖 + 标记已上报（本 epoch）。 */
  applyReport(sessionId: string, report: SubagentInFlightReport): void
  /** 查询快照副本；无条目（既未注入也从未上报）→ undefined（消费方按「无在途」判，非 errs）。 */
  query(sessionId: string): InFlightMirrorEntry | undefined
  /** errs 判别（D5 ④）：injected && !hasEverReported → 'absent-report'，否则 null。 */
  errsShape(sessionId: string): InFlightErrsShape
}

export function createInFlightMirror(): InFlightMirror {
  const entries = new Map<string, InFlightMirrorEntry>()

  function ensureEntry(sessionId: string): InFlightMirrorEntry {
    let entry = entries.get(sessionId)
    if (!entry) {
      entry = { injected: false, hasEverReported: false, inFlight: 0 }
      entries.set(sessionId, entry)
    }
    return entry
  }

  /**
   * 新 reporting epoch 的条目态：置 0 + 清「曾上报」。
   * injected 不动（只归 setInjected 管，见文件头 footgun 说明）。
   */
  function startNewEpoch(sessionId: string): void {
    const entry = ensureEntry(sessionId)
    entry.inFlight = 0
    entry.hasEverReported = false
  }

  return {
    setInjected(sessionId, injected) {
      ensureEntry(sessionId).injected = injected
    },

    presetZero(sessionId) {
      startNewEpoch(sessionId)
    },

    dropSession(sessionId) {
      entries.delete(sessionId)
    },

    applyReport(sessionId, report) {
      const entry = ensureEntry(sessionId)
      entry.inFlight = report.inFlight
      entry.hasEverReported = true
    },

    query(sessionId) {
      const entry = entries.get(sessionId)
      return entry ? { ...entry } : undefined
    },

    errsShape(sessionId) {
      const entry = entries.get(sessionId)
      return entry && entry.injected && !entry.hasEverReported ? 'absent-report' : null
    },
  }
}

/**
 * runtime 进程级单例（对齐 crash-journal 的单例形态）：event-adapter marker 路由写、
 * u7c 滚动重启判定读、u4/u5 生命周期写——同一进程内单点状态。
 */
export const inflightMirror = createInFlightMirror()
