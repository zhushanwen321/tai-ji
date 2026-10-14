/**
 * CanvasService —— 画布状态唯一权威（problem-solve-canvas U2 领域核心落位）。
 *
 * 设计锚点：.tmp/tech-design/problem-solve-canvas.md §3.1(1)（方案 A：runtime CanvasService
 * 唯一权威；D4 全局广播；D7 落盘布局；D9 待重审传播）+ §5-U2。
 *
 * 职责与边界：
 * - mutate 唯一入口：actor 权限矩阵校验（契约 isActionAllowed，表外组合 fail-fast）+
 *   领域应用（canvas-domain.ts 同步纯函数）——「校验 + 内存应用」在同一同步段内完成
 *   （零 await），落盘与广播后置；批量 grow 的原子事务由 domain 副本应用承载。
 * - 落盘：<canvasesDir>/<canvasId>/ 下 events.jsonl（唯一持久权威，append-only 领域
 *   事件流）+ canvas.json（加速快照，atomicWrite）+ exports/（导出产物）。写入顺序 =
 *   先 append 事件、后写快照——快照允许滞后、永不超前（锚点 eventId ≤ 流末 eventId）；
 *   快照时机 = 每 N 条事件后（N = SNAPSHOT_INTERVAL，初值 50，纯落盘策略参数）。
 * - 重建：启动扫描全量加载；单画布 = 快照 + 增量事件重放（live 与重放共用 domain
 *   apply 函数，直写 ≡ 重放构造性成立）。快照损坏 / 锚点超前（写入顺序违约的产物）
 *   一律丢弃快照、从事件流头全量重放——「一律以事件流为准」；事件流行损坏 = 无更高
 *   权威，fail-fast 暴露（不静默跳过造成状态丢失）。
 * - 绑定记录：runtime 内存 Map（enter 成功登记 sessionId ↔ canvasId）；解绑 = 仅 session
 *   真删除（session-lifecycle.ts delete 编排侧经模块级分发函数调用——不挂
 *   removeSessionEntry 汇聚点）；runtime 重启 = 绑定全清（随进程消亡）。
 * - 广播：mutate 成功后同步回调 onUpdated（U3 接 broker 全局广播；reply 成功腿与广播
 *   同源同值——同一事件回执）。回推派发（client.prompt）不在本单元（U3 transport）。
 */
import { existsSync, mkdirSync, appendFileSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  ACTION_EVENT_MAP,
  canvasError,
  isActionAllowed,
  type CanvasActor,
  type CanvasCreateParams,
  type CanvasExportParams,
  type CanvasListEntry,
  type CanvasListReply,
  type CanvasMutateReply,
  type CanvasMutateRequest,
  type CanvasState,
  type CanvasReadReply,
} from '@zhushanwen/extension-protocol'
import { randomUuid } from '@taiji/core/utils/random-uuid'
import { getDataDir } from '@taiji/shared/paths'
import { atomicWrite } from '../../utils/fs-utils.js'
import {
  CanvasDomainError,
  applyCreate,
  applyMutation,
  isCanvasDomainError,
  replayIdGenerator,
  subtreeOf,
  type CanvasEventBody,
  type CanvasTransformRequest,
  type GeneratedIds,
} from './canvas-domain.js'
import { renderPlanningDoc, renderRequirementCard } from './canvas-export.js'

/** 快照间隔（每 N 条事件后写一次加速快照；设计初值 50，纯落盘策略参数，非功能预算）。 */
export const CANVAS_SNAPSHOT_INTERVAL = 50

/** canvasId 后缀长度（D7「短随机 id」：8 hex = 32bit 随机空间，MVP 低频产物量级）。 */
const CANVAS_ID_SUFFIX_LEN = 8

/** 落盘事件行形状（events.jsonl 每行一个 JSON；seq 从 1 起 per-canvas 单调，eventId = String(seq)）。 */
export interface CanvasPersistedEvent extends CanvasEventBody { // oe-exempt:20261015:framework:画布域类型契约（数据形状/端口/测试 harness，非抽象接口单实现）
  seq: number
  eventId: string
}

/** canvas.json 文件形状（加速快照 + 锚点；锚点 eventId ≤ 事件流末条 eventId——永不超前）。 */
export interface CanvasSnapshotFile { // oe-exempt:20261015:framework:画布域类型契约（数据形状/端口/测试 harness，非抽象接口单实现）
  version: 1
  anchorEventId: string
  state: CanvasState
}

/** mutate 服务层结果：协议 reply + canvasId（create 成功时必有——marker 通道 create 登记
 * 绑定的寻址通道；序列化到 WS reply 时由调用方携带协议类型 CanvasMutateReply，本字段
 * 是服务层附加通道，不进 wire 契约）。 */
export type CanvasMutateResult = CanvasMutateReply & { canvasId?: string }

export interface CanvasUpdatedBroadcast { // oe-exempt:20261015:framework:画布域类型契约（数据形状/端口/测试 harness，非抽象接口单实现）
  canvasId: string
  evType: string
  eventId: string
  summary: string
}

export interface CanvasServiceDeps { // oe-exempt:20261015:framework:画布域类型契约（数据形状/端口/测试 harness，非抽象接口单实现）
  /** canvases 根目录（<dataDir>/canvases）。测试注入 mkdtemp 自建自删；缺省按 dataDir 推导。 */
  canvasesDir?: string
  /** mutate 成功后的全局广播回调（U3 接 broker；本服务保证同步调用、成功腿同源同值）。 */
  onUpdated?: (update: CanvasUpdatedBroadcast) => void
  /** 领域 id 生成（canvasId / rootNodeId / commentId）。测试注入确定性序列；缺省 randomUuid。 */
  generateId?: () => string
}

export class CanvasService {
  private readonly canvasesDir: string
  private readonly onUpdated: ((update: CanvasUpdatedBroadcast) => void) | undefined
  private readonly newId: () => string
  /** 内存态权威镜像（canvasId → 状态）；重建源 = events.jsonl。 */
  private readonly states = new Map<string, CanvasState>()
  /** per-canvas 事件流末序号（append 编号基準）。 */
  private readonly lastSeq = new Map<string, number>()
  /** 绑定记录（内存）：canvasId → sessionIds 与反向索引。runtime 重启 = 随进程清空。 */
  private readonly bindings = new Map<string, Set<string>>()
  private readonly sessionBindings = new Map<string, Set<string>>()

  constructor(deps: CanvasServiceDeps = {}) {
    this.canvasesDir = deps.canvasesDir ?? join(getDataDir(), 'canvases')
    this.onUpdated = deps.onUpdated
    this.newId = deps.generateId ?? ((): string => randomUuid())
    // 模块级解绑分发登记（B5 clearRemovedSessionData 同款形态——session-lifecycle 与本
    // 服务互不构造依赖，组合根 wiring 不在本单元领地）。dispose 摘除（测试多实例）。
    activeServices.add(this)
    this.loadAll()
  }

  dispose(): void {
    activeServices.delete(this)
  }

  // ── mutate 唯一入口 ──────────────────────────────────────────

  /**
   * 聚合根唯一写入入口。同步方法（同步段纪律：矩阵校验 + 领域应用 + 落盘 + 广播全在
   * 同步段内，零 await——「单进程串行化」由单线程同步执行构造性保证）。
   * 领域拒绝（不变量 / 状态机 / 矩阵 / 寻址）→ reply 失败腿；基础设施失败（磁盘 IO）→ throw。
   */
  mutate(request: CanvasMutateRequest, actor: CanvasActor): CanvasMutateResult {
    if (request.action === 'read' || request.action === 'list') {
      return {
        ok: false,
        error: canvasError('invalid_params', `「${request.action}」是查询类 action，不产事件不走 mutate：用 readState / listCanvases（WS 侧 canvas.get / canvas.list）`),
      }
    }
    if (!isActionAllowed(request.action, actor)) {
      return {
        ok: false,
        error: canvasError('actor_not_allowed', `操作方「${actor}」无「${request.action}」权限（per-action × actor 矩阵表外组合）`),
      }
    }
    if (request.action === 'create') {
      return this.mutateCreate(request.params, actor)
    }
    // TS 判别联合收窄：排除 read / list / create 后 = CanvasTransformRequest（13 个 action）。
    return this.mutateTransform(request, actor)
  }

  private mutateCreate(params: CanvasCreateParams, actor: CanvasActor): CanvasMutateResult {
    const at = new Date().toISOString()
    const ids = { canvasId: this.generateCanvasId(), rootNodeId: this.newId() }
    let applied
    try {
      applied = applyCreate(params, actor, at, ids)
    } catch (e: unknown) {
      if (isCanvasDomainError(e)) return { ok: false, error: e.detail }
      throw e
    }
    const canvasId = applied.state.canvasId
    mkdirSync(this.canvasDir(canvasId), { recursive: true })
    const persisted = this.persistEvents(canvasId, applied.state, applied.events, 0)
    this.states.set(canvasId, applied.state)
    this.lastSeq.set(canvasId, persisted.seqEnd)
    this.broadcast(canvasId, applied.evType, persisted.mainEventId, applied.summary)
    return { ok: true, eventId: persisted.mainEventId, evType: applied.evType, summary: applied.summary, canvasId }
  }

  private mutateTransform(request: CanvasTransformRequest, actor: CanvasActor): CanvasMutateResult {
    const canvasId = request.params.canvasId
    const prev = this.states.get(canvasId) ?? this.loadCanvas(canvasId)
    if (!prev) {
      return { ok: false, error: canvasError('canvas_not_found', `画布「${canvasId}」不存在`) }
    }
    const at = new Date().toISOString()
    let applied
    try {
      applied = applyMutation(prev, request, actor, at, { next: (): string => this.newId() })
    } catch (e: unknown) {
      if (isCanvasDomainError(e)) return { ok: false, error: e.detail }
      throw e
    }
    // 导出产物落盘（副作用先行：失败即整体失败，事件未落、内存未提交——无部分写入）。
    let exportPath: string | undefined
    if (request.action === 'export') {
      exportPath = this.writeExport(applied.state, request.params, at)
    }
    const startSeq = this.lastSeq.get(canvasId) ?? 0
    const persisted = this.persistEvents(canvasId, applied.state, applied.events, startSeq)
    this.states.set(canvasId, applied.state)
    this.lastSeq.set(canvasId, persisted.seqEnd)
    const summary = exportPath ? `${applied.summary}（产物：${exportPath}）` : applied.summary
    this.broadcast(canvasId, applied.evType, persisted.mainEventId, summary)
    return { ok: true, eventId: persisted.mainEventId, evType: applied.evType, summary, canvasId }
  }

  // ── 查询（read / list：不产事件、不在对账范围）───────────────

  /** 画布全量只读视图（返回深拷贝——内存权威不被调用方引用污染）。 */
  readState(canvasId: string, subtree?: string): CanvasReadReply {
    const state = this.states.get(canvasId) ?? this.loadCanvas(canvasId)
    if (!state) throw new CanvasDomainError(canvasError('canvas_not_found', `画布「${canvasId}」不存在`))
    if (!subtree) return structuredClone(state)
    if (!state.nodes.some((n) => n.id === subtree)) {
      throw new CanvasDomainError(canvasError('node_not_found', `子树根「${subtree}」不存在：先取全量后核对节点 id`))
    }
    const ids = subtreeOf(state, subtree)
    const filtered: CanvasState = {
      ...structuredClone(state),
      nodes: state.nodes.filter((n) => ids.has(n.id)),
      edges: state.edges.filter((e) => ids.has(e.from) && ids.has(e.to)),
      comments: state.comments.filter((c) => ids.has(c.anchorId)),
    }
    return filtered
  }

  listCanvases(): CanvasListReply {
    const canvases: CanvasListEntry[] = [...this.states.values()].map((s) => ({
      canvasId: s.canvasId,
      name: s.name,
      statement: s.root.statement,
      converged: s.converged,
      openMustFix: (s.review?.entries ?? []).filter((e) => e.severity === 'must-fix' && !e.resolution).length,
      reviewStatus: s.review?.status ?? null,
    }))
    return { canvases }
  }

  // ── 绑定记录（内存 Map；生命周期见类头注释）──────────────────

  /** enter 成功登记（幂等：重复 enter 同画布无副作用）。 */
  bindSession(sessionId: string, canvasId: string): void {
    if (!this.states.has(canvasId) && !this.loadCanvas(canvasId)) {
      throw new CanvasDomainError(canvasError('canvas_not_found', `绑定目标画布「${canvasId}」不存在`))
    }
    const set = this.bindings.get(canvasId) ?? new Set<string>()
    set.add(sessionId)
    this.bindings.set(canvasId, set)
    const reverse = this.sessionBindings.get(sessionId) ?? new Set<string>()
    reverse.add(canvasId)
    this.sessionBindings.set(sessionId, reverse)
  }

  /** session 真删除解绑（session-lifecycle delete 编排侧调用；pi 崩溃 / restore 不经此——
   * 绑定不随 pi 进程死亡解绑，崩溃后 session 重开即恢复回推）。 */
  unbindSession(sessionId: string): void {
    for (const canvasId of this.sessionBindings.get(sessionId) ?? []) {
      const set = this.bindings.get(canvasId)
      if (!set) continue
      set.delete(sessionId)
      if (set.size === 0) this.bindings.delete(canvasId)
    }
    this.sessionBindings.delete(sessionId)
  }

  /** 该画布的绑定 session 清单（活跃交集 = 本清单 ∩ 存活 session，交集计算归回推派发方 U3）。 */
  getBoundSessions(canvasId: string): string[] {
    return [...(this.bindings.get(canvasId) ?? [])]
  }

  // ── 落盘与重建 ──────────────────────────────────────────────

  private canvasDir(canvasId: string): string {
    return join(this.canvasesDir, canvasId)
  }

  private eventsPath(canvasId: string): string {
    return join(this.canvasDir(canvasId), 'events.jsonl')
  }

  private snapshotPath(canvasId: string): string {
    return join(this.canvasDir(canvasId), 'canvas.json')
  }

  /** append 事件（唯一权威写入），恰满 N 条时随后写加速快照——先事件后快照的顺序在
   * 本方法体内固定（快照 state = 恰应用完本批事件的状态，锚点 = 流末 eventId）。 */
  private persistEvents(canvasId: string, state: CanvasState, events: CanvasEventBody[], startSeq: number): { mainEventId: string; seqEnd: number } {
    const lines: string[] = []
    let seq = startSeq
    let mainEventId = ''
    for (const body of events) {
      seq += 1
      const eventId = String(seq)
      if (mainEventId === '') mainEventId = eventId
      lines.push(`${JSON.stringify({ seq, eventId, ...body } satisfies CanvasPersistedEvent)}\n`)
    }
    try {
      mkdirSync(this.canvasDir(canvasId), { recursive: true })
      appendFileSync(this.eventsPath(canvasId), lines.join(''), 'utf-8')
    } catch (e: unknown) {
      // 权威写入失败：内存不得超前磁盘——摘除内存镜像（下次查询从磁盘重载），错误上抛。
      this.states.delete(canvasId)
      this.lastSeq.delete(canvasId)
      console.error(`[canvas-service] events.jsonl append 失败（canvasId=${canvasId}），内存镜像已摘除以对齐磁盘权威：`, e)
      throw e
    }
    const seqEnd = seq
    // 快照触发 = 本批 append 跨过了 N 的倍数（按批末 seq 判 `seqEnd % N === 0` 会在
    // 单批多条事件时恒错过倍数点——一次 mutate 产附属 + 主两条事件，批末 seq 恒奇偶
    // 固定）。锚点取批末 eventId：快照覆盖到当前流末，锚点 ≤ 流末恒成立（永不超前）。
    if (Math.floor(seqEnd / CANVAS_SNAPSHOT_INTERVAL) > Math.floor(startSeq / CANVAS_SNAPSHOT_INTERVAL)) {
      this.writeSnapshot(canvasId, state, String(seqEnd))
    }
    return { mainEventId, seqEnd }
  }

  /** 加速快照（atomicWrite）；state 必须是恰应用完流末事件的状态（锚点对齐的写入侧保证）。 */
  private writeSnapshot(canvasId: string, state: CanvasState, anchorEventId: string): void {
    const snapshot: CanvasSnapshotFile = { version: 1, anchorEventId, state }
    try {
      atomicWrite(this.snapshotPath(canvasId), JSON.stringify(snapshot), `canvas-snap-${canvasId}`)
    } catch (e: unknown) {
      // best-effort 降级：快照是加速缓存非权威，写入失败不阻断 mutate 主链——
      // 恢复路径 = 下次重建自动走全量重放（「一律以事件流为准」），此处仅留痕。
      console.error(`[canvas-service] canvas.json 快照写入失败（canvasId=${canvasId}，重建将全量重放事件流）：`, e)
    }
  }

  /** 单画布重建：快照（可信时）+ 增量事件重放；快照损坏 / 锚点超前一律丢弃走全量重放。 */
  private loadCanvas(canvasId: string): CanvasState | undefined {
    const eventsFile = this.eventsPath(canvasId)
    if (!existsSync(eventsFile)) return undefined
    let state: CanvasState | undefined
    let anchorSeq = 0
    const snapFile = this.snapshotPath(canvasId)
    if (existsSync(snapFile)) {
      try {
        const snap = JSON.parse(readFileSync(snapFile, 'utf-8')) as CanvasSnapshotFile
        const parsedAnchor = Number(snap.anchorEventId)
        const rawLines = readFileSync(eventsFile, 'utf-8').split('\n').filter((l) => l.trim() !== '')
        const lastSeqInFile = rawLines.length > 0 ? (JSON.parse(rawLines[rawLines.length - 1] as string) as CanvasPersistedEvent).seq : 0
        if (snap.version === 1 && snap.state && Number.isFinite(parsedAnchor) && parsedAnchor <= lastSeqInFile) {
          state = snap.state
          anchorSeq = parsedAnchor
        } else {
          // 锚点超前 = 快照超前于事件流（写入顺序违约的产物）——「一律以事件流为准」，丢弃快照。
          console.error(`[canvas-service] 快照不可信（canvasId=${canvasId}，anchor=${snap.anchorEventId}，流末=${lastSeqInFile}），丢弃快照全量重放`)
        }
      } catch (e: unknown) {
        // best-effort 降级：快照损坏即视为无快照，恢复路径 = 事件流全量重放（「一律以
        // 事件流为准」，事件流是更高权威），不阻断重建，此处仅留痕。
        console.error(`[canvas-service] 快照读取失败（canvasId=${canvasId}），丢弃快照全量重放：`, e)
      }
    }
    const lines = readFileSync(eventsFile, 'utf-8').split('\n').filter((l) => l.trim() !== '')
    let lastSeq = anchorSeq
    for (const line of lines) {
      let ev: CanvasPersistedEvent
      try {
        ev = JSON.parse(line) as CanvasPersistedEvent
      } catch (e: unknown) {
        // 事件流是唯一权威：行损坏无更高权威可对——fail-fast 暴露，不静默跳过（跳过 = 状态丢失）。
        throw new Error(`[canvas-service] events.jsonl 行损坏（canvasId=${canvasId}）：${String(e)}`)
      }
      lastSeq = Math.max(lastSeq, ev.seq)
      if (ev.seq <= anchorSeq) continue
      // 附属事件（DirtiedPathMarked / ReviewConverged 等：type 与 ACTION_EVENT_MAP[action]
      // 映射不一致）不参与重放——其状态变更已由触发它的主事件 apply 承载，重放会以残缺
      // params 二次应用（如 patch 无 nodeId）。
      if (ACTION_EVENT_MAP[ev.action as keyof typeof ACTION_EVENT_MAP] !== ev.type) continue
      state = this.replayEvent(canvasId, state, ev)
    }
    if (!state) {
      throw new Error(`[canvas-service] 事件流为空且无可信快照（canvasId=${canvasId}）——画布数据损坏`)
    }
    this.states.set(canvasId, state)
    this.lastSeq.set(canvasId, lastSeq)
    return state
  }

  /** 重放单条事件（与 live 共用 domain apply——直写 ≡ 重放的构造点）。 */
  private replayEvent(canvasId: string, prev: CanvasState | undefined, ev: CanvasPersistedEvent): CanvasState {
    const generated: GeneratedIds = (ev.data.generated ?? {}) as GeneratedIds
    if (ev.action === 'create') {
      if (!generated.canvasId || !generated.rootNodeId) {
        throw new CanvasDomainError(canvasError('invalid_params', `create 事件缺生成 id（canvasId=${canvasId} seq=${ev.seq}）——事件流数据损坏`))
      }
      return applyCreate(ev.data as unknown as CanvasCreateParams, ev.actor, ev.at, {
        canvasId: generated.canvasId,
        rootNodeId: generated.rootNodeId,
      }).state
    }
    if (!prev) {
      throw new Error(`[canvas-service] 事件流首条非 create（canvasId=${canvasId} seq=${ev.seq}）——画布数据损坏`)
    }
    const applied = applyMutation(prev, { action: ev.action, params: ev.data } as never, ev.actor, ev.at, replayIdGenerator)
    return applied.state
  }

  private loadAll(): void {
    if (!existsSync(this.canvasesDir)) return
    for (const entry of readdirSync(this.canvasesDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      try {
        this.loadCanvas(entry.name)
      } catch (e: unknown) {
        // 单画布损坏不拖垮服务启动（其余画布照常服务）；错误留痕指向权威源。
        console.error(`[canvas-service] 画布「${entry.name}」重建失败（以 events.jsonl 为准检查数据）：`, e)
      }
    }
  }

  private generateCanvasId(): string {
    for (;;) {
      const id = `cvs-${this.newId().slice(0, CANVAS_ID_SUFFIX_LEN)}`
      if (!existsSync(this.canvasDir(id))) return id
    }
  }

  private writeExport(state: CanvasState, params: CanvasExportParams, at: string): string {
    const exportsDir = join(this.canvasDir(state.canvasId), 'exports')
    mkdirSync(exportsDir, { recursive: true })
    const stamp = at.replace(/[:.]/g, '-')
    const fileName = params.target.target === 'planning-doc'
      ? `planning-doc-${stamp}.md`
      : `requirement-card-${params.target.leafId}-${stamp}.md`
    const content = params.target.target === 'planning-doc'
      ? renderPlanningDoc(state, at)
      : renderRequirementCard(state, params.target.leafId, at)
    writeFileSync(join(exportsDir, fileName), content, 'utf-8')
    return `exports/${fileName}`
  }

  private broadcast(canvasId: string, evType: string, eventId: string, summary: string): void {
    // 同步回调（U3 接 broker.broadcast）；回调异常不阻断 mutate 主链（广播是失效提示，
    // 丢失由下次拉取收敛——ADR-0097 拉为主）。
    try {
      this.onUpdated?.({ canvasId, evType, eventId, summary })
    } catch (e: unknown) {
      // best-effort 降级：广播是失效提示，回调异常不阻断 mutate 主链（数据已落盘权威），
      // 丢失由消费方下次拉取收敛（ADR-0097 拉为主），此处仅留痕。
      console.error(`[canvas-service] onUpdated 广播回调异常（canvasId=${canvasId}）：`, e)
    }
  }
}

/** 模块级分发登记（B5 activeStores 同款）：生产恒单实例；测试多实例各自 dispose 摘除。 */
const activeServices = new Set<CanvasService>()

/**
 * session 真删除的画布解绑分发入口（session-lifecycle.ts delete 编排侧调用——不挂
 * removeSessionEntry 汇聚点，该点同时收 pi 崩溃 / forceQuit / restore 清场三条存活路径）。
 */
export function unbindCanvasOnSessionDeleted(sessionId: string): void {
  for (const svc of activeServices) {
    svc.unbindSession(sessionId)
  }
}
