/**
 * ClaimLedger —— session-manager 通知债权纯状态机（notify-once 设计 U2；D1/D2/D4/D5/D7）。
 *
 * 职责边界：
 * - **零 I/O 纯状态机**：不发日志、不执行 respond、不碰文件系统；一切方法返回「素材/信号」，
 *   由 u-bridge（组合根桥接层）负责实际 respond、warn 落盘与协议词形组装。
 *   无内部定时器（TTL 清扫 setInterval 已随 ADR-0122 防御机制清查退役）。
 * - **架构约束（并行度复审 F3 裁定，L0 grep 锚）**：本模块禁 import 扩展协议包——内部态
 *   与 outcome 快照 runtime 自持（词汇 = session_end outcome 等 runtime 既有词形）；
 *   state→协议 reason/payload 的词形映射归 u-bridge（协议 SSOT 由桥接与扩展双侧 import 承载）。
 * - **顺序不变量（设计 D2）**：arm/disarm/兑现/respond 转移在 runtime 单线程事件循环内顺序执行。
 * - **调用序约定**：session 删除汇聚点必须先 `onSessionDeath(...)` 取 respond 素材、后
 *   `clearSession(sessionId)`（反序会使死亡批量查无记录）；shutdown warn 在 `dispose()` 前读 `count()`。
 *
 * 状态机（设计 D2 表；「删除」= 记录移除）：
 * ```
 *   ——arm——▶ armed ──markInjected（受理回执）──▶ injected ──settle(kind=claim)──▶ fulfilled{outcomeSnapshot}
 *   armed ──disarmDeliveryFailed（投递失败腿）──▶ 删除（静默：无 respond、无 undelivered 计数）
 *   未终结 claim ──abortClaims（handleAbort 入口同步抹除）──▶ aborted ──onRespond(true)──▶ 删除
 *   未终结 ──orphanByParent（父死亡批量）/ onRespond(false)（respond 失败）──▶ orphaned（吸收态）
 *   armed·injected·fulfilled ──onSessionDeath（delete/forceQuit 汇聚点，先于杀进程）──▶ 删除
 *   orphaned 记录滞留至 clearSession（session 删除 / shutdown）；TTL 达限自动回收已退役。
 * ```
 *
 * 关键语义裁决（实施期落点，均从设计条文推导）：
 * - **lifetime 记录豁免 settle 与 TTL 悬挂扫描**：kind=lifetime 只随 session 生灭（D5：
 *   「claim 随单笔请求生灭、lifetime 随 session 生灭」；A4：lifetime 仅在死亡时发声）——
 *   settle 只兑现 kind=claim；lifetime 的 armed/injected 是健康稳态（等待终局死亡），
 *   若按「armed/injected 悬挂」扫描会在 TTL 后把全部存活 session 的终身 watch 销成孤儿，
 *   构造性破坏裁决2。lifetime 可被 orphan/死亡/clear 终结，其 orphaned 照常进 TTL 回收。
 * - **死亡批量即时删除**（设计 D2 死亡行新态=「删除」，无中间态）：respond 素材随返回值带出；
 *   其 respond 失败时记录已不在册，`onRespond` 记 absent 空转——残留 register 由收口腿
 *   （D7③）清理，与附录 C-9 口径一致。其余 respond（settle/catch-up/abort/late-watch）
 *   走统一回收：`onRespond(true)` → 删除；`onRespond(false)` → orphaned + 计数（触发器①）。
 * - **TTL 三类扫描**（设计 D7/D2 行）：① kind=claim 的 armed/injected 悬挂；② fulfilled-no-watch；
 *   ③ orphaned 达 TTL 回收（≥ 下界窗口保证杀父重启后收口腿拿得到精确 orphaned 应答）。
 *   扫描转移时 watch 已挂 → 返回 `respondOrphaned` 信号（调用方须同步 respond，防孤儿 promise）。
 *   aborted 不入扫描（bridge 契约：每条 respond 素材必回一次 onRespond；session 删除兜底清理）。
 * - **undeliveredResults**：每次转入 orphaned（任一触发器）+1，按被管理子会话 sessionId 分桶，
 *   事实计数随记录回收不回退；`clearSession` 随 session 消亡一并清零。
 * - **seq 计数器**：settleSeq/deathSeq per-session 递增，仅在批次非空时递增（seq 即批次身份，
 *   空批不产 respond 不占号）；sessionId 不复用 + 空批不产号 ⇒ clearSession 清零安全。
 */

/** TTL 下界 = 10min（设计审查条款：≥10min——保证杀父重启窗口内 orphaned 记录仍在、收口腿拿得到精确应答）。 */

// ─── 词表（runtime 自持，非协议词形）────────────────────────────────────────

/** claim 记录状态（设计 D2 状态机）。orphaned 为吸收态：进入后仅可被删除，不可再转移。 */
export type ClaimState = 'armed' | 'injected' | 'fulfilled' | 'orphaned' | 'aborted'

/** 记录种类：claim = 单笔请求债权（create+prompt / send）；lifetime = 每 session 一条的终身死亡通知载体。 */
export type ClaimKind = 'claim' | 'lifetime'

/** session_end 终态原始 outcome（词形 = completion-backflow 既有 getSessionOutcome 口径；映射归 bridge）。 */
export type SettleOutcome = 'done' | 'error' | 'stopped' | null

/** 死亡事件成因（事件词形；bridge 映射为 respond reason 时产出对应词）。 */
export type DeathCause = 'exit' | 'delete'

/** 兑现快照（D4：outcome + settleSeq + fulfills N 快照入记录；catch-up 响应用）。 */
export interface OutcomeSnapshot {
  outcome: SettleOutcome
  /** 本批次的 per-session 递增序号（批身份，D3 合并判据） */
  settleSeq: number
  /** 本批次兑现的债权笔数（fulfills N） */
  fulfills: number
}

/** 对外只读记录视图（快照拷贝，防调用方改写内部态）。 */
export interface ClaimView {
  parentSid: string
  notifyId: string
  kind: ClaimKind
  sessionId: string
  state: ClaimState
  watchId?: string
  outcomeSnapshot?: OutcomeSnapshot
}

// ─── respond 素材（bridge 消费后做词形映射）─────────────────────────────────

/**
 * respond 载荷素材：discriminated by `type`。bridge 按 type/state 映射协议 reason
 * （settled→outcome 映射、aborted→cancelled、death→exited/deleted、orphaned→orphaned）。
 */
export type RespondPayload =
  | { type: 'settled'; outcome: SettleOutcome; settleSeq: number; fulfills: number }
  | { type: 'aborted' }
  | { type: 'death'; cause: DeathCause; deathSeq: number; fulfills: number }
  | { type: 'orphaned' }

/** 一条待 respond：watch 已挂（单键寻址，bridge 以 watchId 回包）。 */
export interface RespondTarget {
  parentSid: string
  notifyId: string
  watchId: string
  sessionId: string
  kind: ClaimKind
  payload: RespondPayload
}

/** arm 结果：同键（parentSid, notifyId）重复 arm 拒绝（幂等不变量的执行点，D2）。 */
export type ArmResult = { ok: true } | { ok: false; reason: 'duplicate' }

/**
 * watch 开表路由（D2 watch 行）：
 * - `fail-closed`：查无 claim → bridge 立即 respond 结束语（防长挂 select 泄漏）
 * - `wait`：未兑现 → 挂等；单 watch 槽，新 watch 覆盖旧（被覆盖的旧 watch 永不 respond，
 *   悬 promise 已知无害——P1 fire-and-forget），`coveredWatchId` 供观测/测试
 * - `respond`：已兑现（catch-up 快照）或已终结 → 立即 respond 素材；记录保留至 onRespond
 */
export type WatchRouting =
  | { action: 'fail-closed' }
  | { action: 'wait'; coveredWatchId?: string }
  | { action: 'respond'; target: RespondTarget }

/** settle 批次结果（D4 兑现锚）。 */
export interface SettleBatch {
  /** 本批 seq（无兑现时 = 计数器现值，未递增） */
  settleSeq: number
  /** 本批兑现的记录（kind=claim、state 由 injected 转移；含无 watch 的 fulfilled-no-watch） */
  fulfilled: ClaimView[]
  /** 其中 watch 已挂者 → respond 素材 */
  targets: RespondTarget[]
}

/** 死亡批量结果（D5 收口：同 deathSeq 同批终结）。 */
export interface DeathBatch {
  deathSeq: number
  /** 本批终结的 kind=claim 笔数（D6：fulfills N = 同 deathSeq 的 claim 数） */
  fulfills: number
  /** 本批终结的全部记录（claim + lifetime，含无 watch 者——已即时删除，此处为快照） */
  terminated: ClaimView[]
  /** 其中 watch 已挂者 → respond 素材 */
  targets: RespondTarget[]
}

/** 主 abort 结果（D2/D4：入口同步抹除该 child 全部 claim；lifetime 不受 abort 影响）。 */
export interface AbortBatch {
  /** 受影响的全部 claim（含当场删除的无 watch 记录——快照） */
  aborted: ClaimView[]
  /** watch 已挂者 → respond 素材（bridge 映射 aborted → 结束语）；无 watch 者当场删除 */
  targets: RespondTarget[]
}

/** 父死亡批量转移结果（D7 触发器②：只 warn 不 respond——父进程已死，respond 无意义）。 */
export interface OrphanBatch {
  /** 转入 orphaned 的记录（view 含 watchId 供 warn 素材：notifyId/sessionId/reason） */
  orphaned: ClaimView[]
}

/** TTL 清扫结果（D7 回收策略）。 */
export interface SweepResult {
  /** 本轮转入 orphaned 的记录（无 watch：仅状态转移 + 计数） */
  orphaned: ClaimView[]
  /** 其中 watch 已挂者 → 调用方须同步 respond 结束语（extension 按 D3 例外1 静默收口） */
  respondOrphaned: RespondTarget[]
  /** orphaned 达 TTL 回收删除的记录数 */
  purged: number
}

/** onRespond 回执处置（供 bridge 观测/测试断言）。 */
export type RespondDisposition = 'deleted' | 'orphaned' | 'absent' | 'noop'

// ─── 工厂 ──────────────────────────────────────────────────────────────────

export interface ClaimLedgerDeps {
  /** 时钟注入（纯度：测试手动推进；缺省 Date.now）。 */
  now?: () => number
}

export interface ClaimLedger {
  /** 受理点建债（send/create 至多各一笔 + create 自动 lifetime 一笔）。同键重复 → 拒绝。 */
  arm(p: { parentSid: string; notifyId: string; kind: ClaimKind; sessionId: string }): ArmResult
  /** 受理回执（send 路径 = delivery onSettled('delivered') 经 envelope meta；create 路径 = sendDirect 受理）。 */
  markInjected(parentSid: string, notifyId: string): boolean
  /** 投递失败腿（sendChecked reject / sendDirect throw）：armed → 静默删除（E7：零通知零计数）。 */
  disarmDeliveryFailed(parentSid: string, notifyId: string): boolean
  /** watch 开表（单键寻址 (parentSid, notifyId)；单 watch 槽覆盖语义见 WatchRouting）。 */
  openWatch(parentSid: string, notifyId: string, watchId: string): WatchRouting
  /**
   * agent_settled 兑现（D4 锚：injected 的 kind=claim 全部兑现；armed 不动、lifetime 不动）。
   * outcome = session_end 原始词形（bridge 读取后传入）。
   */
  settle(sessionId: string, outcome: SettleOutcome): SettleBatch
  /** 主 abort（handleAbort 入口**同步**调用，先于 await abort——防 settled('stopped') 抢先兑现）。只清 kind=claim。 */
  abortClaims(sessionId: string): AbortBatch
  /**
   * 终局死亡（delete/forceQuit 汇聚点，先于杀进程；exit = 非 respawn 链进程死亡）。
   * armed/injected/fulfilled 全种类即时删除并返回 respond 素材（同 deathSeq）；orphaned/aborted
   * 为终结态不参与（clearSession / TTL 兜底）。respawn 链静默 = bridge 不调用本方法。
   */
  onSessionDeath(sessionId: string, cause: DeathCause): DeathBatch
  /** 父死亡批量转移（D7 触发器②）：该父全部未终结记录 → orphaned + 计数，返回 warn 素材（不 respond）。 */
  orphanByParent(parentSid: string): OrphanBatch
  /**
   * respond 结果回执（D7 触发器①；bridge 从 sendExtensionUiResponse boolean 传导）。
   * 每条 RespondTarget / WatchRouting.respond 必回一次：true → 删除；false → orphaned + 计数
   * （已 orphaned 则空转——吸收态不双计）；记录已不在册（死亡批量已删）→ absent 空转。
   */
  onRespond(parentSid: string, notifyId: string, ok: boolean): RespondDisposition
  /** session 删除清理（清该 session 作为子会话的全部记录 + seq/undelivered 计数器）。 */
  clearSession(sessionId: string): number
  /** 查记录（catch-up 布尔式入口：getClaim(...)?.state === 'fulfilled'）。 */
  getClaim(parentSid: string, notifyId: string): ClaimView | undefined
  /** 在册记录总数（D7b：runtime 退出时非零 → bridge warn 含计数）。 */
  count(): number
  /** 未送达结果事实计数（D6 undeliveredResults，按被管理子会话分桶）。 */
  undeliveredCount(sessionId: string): number
  /** 停清扫定时器（不丢记录——shutdown warn 顺序见文件头）。 */
  dispose(): void
}

interface ClaimRecord {
  parentSid: string
  notifyId: string
  kind: ClaimKind
  sessionId: string
  state: ClaimState
  watchId?: string
  outcomeSnapshot?: OutcomeSnapshot
  /** 进入当前 state 的时刻（TTL 判据） */
  stateSince: number
}

const keyOf = (parentSid: string, notifyId: string): string => `${parentSid}\u0000${notifyId}`

export function createClaimLedger(deps: ClaimLedgerDeps = {}): ClaimLedger {
  const now = deps.now ?? (() => Date.now())

  const records = new Map<string, ClaimRecord>()
  const bySession = new Map<string, Set<string>>()
  const byParent = new Map<string, Set<string>>()
  const settleSeqBySession = new Map<string, number>()
  const deathSeqBySession = new Map<string, number>()
  const undeliveredBySession = new Map<string, number>()

  // ─── 索引维护 ────────────────────────────────────────────────────────────

  function link(r: ClaimRecord): void {
    const key = keyOf(r.parentSid, r.notifyId)
    let s = bySession.get(r.sessionId)
    if (!s) bySession.set(r.sessionId, (s = new Set()))
    s.add(key)
    let p = byParent.get(r.parentSid)
    if (!p) byParent.set(r.parentSid, (p = new Set()))
    p.add(key)
  }

  function unlink(r: ClaimRecord): void {
    const key = keyOf(r.parentSid, r.notifyId)
    records.delete(key)
    const s = bySession.get(r.sessionId)
    s?.delete(key)
    if (s && s.size === 0) bySession.delete(r.sessionId)
    const p = byParent.get(r.parentSid)
    p?.delete(key)
    if (p && p.size === 0) byParent.delete(r.parentSid)
  }

  function getRecord(parentSid: string, notifyId: string): ClaimRecord | undefined {
    return records.get(keyOf(parentSid, notifyId))
  }

  function view(r: ClaimRecord): ClaimView {
    return {
      parentSid: r.parentSid,
      notifyId: r.notifyId,
      kind: r.kind,
      sessionId: r.sessionId,
      state: r.state,
      ...(r.watchId !== undefined ? { watchId: r.watchId } : {}),
      ...(r.outcomeSnapshot !== undefined ? { outcomeSnapshot: r.outcomeSnapshot } : {}),
    }
  }

  /** 单条 respond 素材组装（watchId 由调用方给——openWatch/abort/sweep 的挂表时点不同）。 */
  function targetOf(r: ClaimRecord, watchId: string, payload: RespondPayload): RespondTarget {
    return {
      parentSid: r.parentSid,
      notifyId: r.notifyId,
      watchId,
      sessionId: r.sessionId,
      kind: r.kind,
      payload,
    }
  }

  function targetsOf(rs: ClaimRecord[], payload: RespondPayload): RespondTarget[] {
    const out: RespondTarget[] = []
    for (const r of rs) {
      if (r.watchId === undefined) continue
      out.push(targetOf(r, r.watchId, payload))
    }
    return out
  }

  function transition(r: ClaimRecord, state: ClaimState): void {
    r.state = state
    r.stateSince = now()
  }

  /** 转入 orphaned（吸收态）：计数 +1（唯一入 edge，任一触发器共用——防双计）。 */
  function orphan(r: ClaimRecord): void {
    transition(r, 'orphaned')
    undeliveredBySession.set(r.sessionId, (undeliveredBySession.get(r.sessionId) ?? 0) + 1)
  }

  function recordsOfSession(sessionId: string): ClaimRecord[] {
    const keys = bySession.get(sessionId)
    if (!keys) return []
    const out: ClaimRecord[] = []
    for (const key of keys) {
      const r = records.get(key)
      if (r) out.push(r)
    }
    return out
  }

  /** 未终结态（可被死亡/父亡/清扫继续处理的活跃态）。orphaned（吸收）/aborted（已终结）不算。 */
  const isLive = (r: ClaimRecord): boolean =>
    r.state === 'armed' || r.state === 'injected' || r.state === 'fulfilled'

  // ─── arm / 受理回执 / 投递失败腿 ────────────────────────────────────────

  function arm(p: { parentSid: string; notifyId: string; kind: ClaimKind; sessionId: string }): ArmResult {
    const key = keyOf(p.parentSid, p.notifyId)
    if (records.has(key)) return { ok: false, reason: 'duplicate' }
    const r: ClaimRecord = {
      parentSid: p.parentSid,
      notifyId: p.notifyId,
      kind: p.kind,
      sessionId: p.sessionId,
      state: 'armed',
      stateSince: now(),
    }
    records.set(key, r)
    link(r)
    return { ok: true }
  }

  function markInjected(parentSid: string, notifyId: string): boolean {
    const r = getRecord(parentSid, notifyId)
    if (!r || r.state !== 'armed') return false
    transition(r, 'injected')
    return true
  }

  function disarmDeliveryFailed(parentSid: string, notifyId: string): boolean {
    const r = getRecord(parentSid, notifyId)
    if (!r || r.state !== 'armed') return false // 投递失败腿只作用于 armed（D2 表）
    unlink(r)
    return true
  }

  // ─── watch 开表 ─────────────────────────────────────────────────────────

  function openWatch(parentSid: string, notifyId: string, watchId: string): WatchRouting {
    const r = getRecord(parentSid, notifyId)
    if (!r) return { action: 'fail-closed' } // 查无 claim → bridge 立即结束应答（快路径）
    const covered = r.watchId !== undefined && r.watchId !== watchId ? r.watchId : undefined
    r.watchId = watchId // 单 watch 槽：新覆盖旧
    switch (r.state) {
      case 'armed':
      case 'injected':
        return covered !== undefined ? { action: 'wait', coveredWatchId: covered } : { action: 'wait' }
      case 'fulfilled': {
        const snap = r.outcomeSnapshot
        const payload: RespondPayload = snap
          ? { type: 'settled', outcome: snap.outcome, settleSeq: snap.settleSeq, fulfills: snap.fulfills }
          : { type: 'settled', outcome: null, settleSeq: 0, fulfills: 0 }
        return { action: 'respond', target: targetOf(r, watchId, payload) }
      }
      case 'aborted':
        return { action: 'respond', target: targetOf(r, watchId, { type: 'aborted' }) }
      case 'orphaned':
        return { action: 'respond', target: targetOf(r, watchId, { type: 'orphaned' }) }
    }
  }

  // ─── settle 兑现（D4）───────────────────────────────────────────────────

  function settle(sessionId: string, outcome: SettleOutcome): SettleBatch {
    const candidates = recordsOfSession(sessionId).filter(
      (r) => r.state === 'injected' && r.kind === 'claim',
    )
    const current = settleSeqBySession.get(sessionId) ?? 0
    if (candidates.length === 0) {
      return { settleSeq: current, fulfilled: [], targets: [] } // 无债权 settle 零兑现（B 族不变量）
    }
    const settleSeq = current + 1
    settleSeqBySession.set(sessionId, settleSeq)
    const snapshot: OutcomeSnapshot = { outcome, settleSeq, fulfills: candidates.length }
    for (const r of candidates) {
      transition(r, 'fulfilled')
      r.outcomeSnapshot = snapshot
    }
    const payload: RespondPayload = { type: 'settled', outcome, settleSeq, fulfills: candidates.length }
    return {
      settleSeq,
      fulfilled: candidates.map(view),
      targets: targetsOf(candidates, payload),
    }
  }

  // ─── 主 abort（D2/D4 入口同步抹除）─────────────────────────────────────

  function abortClaims(sessionId: string): AbortBatch {
    // 只清 kind=claim（D1 债权定义）；lifetime 随 session 生灭，abort 不触碰（裁决2 载体）
    const candidates = recordsOfSession(sessionId).filter((r) => r.kind === 'claim' && isLive(r))
    const aborted: ClaimView[] = []
    const targets: RespondTarget[] = []
    for (const r of candidates) {
      aborted.push(view(r))
      if (r.watchId !== undefined) {
        transition(r, 'aborted') // 保留至 onRespond：已终结态对迟到 watch 仍可应答、且不可被 settle 兑现
        targets.push(targetOf(r, r.watchId, { type: 'aborted' }))
      } else {
        unlink(r) // 无 watch = 无应答对象 → 静默销账当场删除
      }
    }
    return { aborted, targets }
  }

  // ─── 终局死亡（D5 汇聚点）──────────────────────────────────────────────

  function onSessionDeath(sessionId: string, cause: DeathCause): DeathBatch {
    const candidates = recordsOfSession(sessionId).filter(isLive) // orphaned/aborted 为终结态不参与
    const current = deathSeqBySession.get(sessionId) ?? 0
    if (candidates.length === 0) {
      return { deathSeq: current, fulfills: 0, terminated: [], targets: [] }
    }
    const deathSeq = current + 1
    deathSeqBySession.set(sessionId, deathSeq)
    const fulfills = candidates.filter((r) => r.kind === 'claim').length
    const payload: RespondPayload = { type: 'death', cause, deathSeq, fulfills }
    const targets = targetsOf(candidates, payload)
    const terminated = candidates.map(view)
    for (const r of candidates) unlink(r) // 即时删除（设计 D2 死亡行新态=「删除」）
    return { deathSeq, fulfills, terminated, targets }
  }

  // ─── 父死亡批量转移（D7 触发器②）───────────────────────────────────────

  function orphanByParent(parentSid: string): OrphanBatch {
    const keys = byParent.get(parentSid)
    if (!keys) return { orphaned: [] }
    const orphaned: ClaimView[] = []
    for (const key of [...keys]) {
      const r = records.get(key)
      if (!r || !isLive(r)) continue
      orphan(r)
      orphaned.push(view(r)) // view 含 watchId：warn 素材（notifyId/sessionId），不 respond——父进程已死
    }
    return { orphaned }
  }

  // ─── respond 回执（D7 触发器①）─────────────────────────────────────────

  function onRespond(parentSid: string, notifyId: string, ok: boolean): RespondDisposition {
    const r = getRecord(parentSid, notifyId)
    if (!r) return 'absent' // 死亡批量已删 / 已回收：无册可转（残留清理由收口腿兜底，C-9）
    if (ok) {
      unlink(r) // respond 成功即删记录（D7 回收策略）
      return 'deleted'
    }
    if (r.state === 'orphaned') return 'noop' // 吸收态：不转移、不双计
    orphan(r)
    return 'orphaned'
  }

  // ─── 查询 / 清理 / 生命周期 ────────────────────────────────────────────

  function clearSession(sessionId: string): number {
    const removed = recordsOfSession(sessionId)
    for (const r of removed) unlink(r)
    bySession.delete(sessionId)
    settleSeqBySession.delete(sessionId)
    deathSeqBySession.delete(sessionId)
    undeliveredBySession.delete(sessionId)
    return removed.length
  }

  function getClaim(parentSid: string, notifyId: string): ClaimView | undefined {
    const r = getRecord(parentSid, notifyId)
    return r ? view(r) : undefined
  }

  return {
    arm,
    markInjected,
    disarmDeliveryFailed,
    openWatch,
    settle,
    abortClaims,
    onSessionDeath,
    orphanByParent,
    onRespond,
    clearSession,
    getClaim,
    count: () => records.size,
    undeliveredCount: (sessionId) => undeliveredBySession.get(sessionId) ?? 0,
    dispose: () => {},
  }
}
