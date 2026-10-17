/**
 * CanvasService —— 画布状态唯一权威（problem-solve-canvas U2 领域核心落位）。
 *
 * 设计锚点：.tmp/tech-design/problem-solve-canvas.md §3.1(1) + §5-U2；
 * session-store-layout-inversion D4（画布布局与归属）：落盘 =
 * `<dataDir>/ext-sessions/<ownerSessionId>/canvases/<canvasId>/`（归属即路径，1:N——
 * 一个 session 可有多张画布），跨会话访问按归属校验结构化拒绝（forbidden）。
 *
 * 职责与边界：
 * - mutate 唯一入口：actor 权限矩阵校验（契约 isActionAllowed，表外组合 fail-fast）+
 *   归属校验（非 owner → forbidden）+ 领域应用（canvas-domain.ts 同步纯函数）——
 *   「校验 + 内存应用」在同一同步段内完成（零 await），落盘与广播后置；批量 grow 的
 *   原子事务由 domain 副本应用承载。
 * - 落盘：<root>/<ownerSessionId>/canvases/<canvasId>/ 下 events.jsonl（唯一持久权威，
 *   append-only 领域事件流，内容与格式不随布局反转变化只挪位置）+ canvas.json（加速
 *   快照，atomicWrite）+ exports/（导出产物）。写入顺序 = 先 append 事件、后写快照——
 *   快照允许滞后、永不超前（锚点 eventId ≤ 流末 eventId）；快照时机 = 每 N 条事件后
 *   （N = SNAPSHOT_INTERVAL，初值 50，纯落盘策略参数）。
 * - 重建：启动扫描 session 树全量加载（owner 从树内目录名推导——路径即归属）；单画布 =
 *   快照 + 增量事件重放（live 与重放共用 domain apply 函数，直写 ≡ 重放构造性成立）。
 *   快照损坏 / 锚点超前（写入顺序违约的产物）一律丢弃快照、从事件流头全量重放——
 *   「一律以事件流为准」；事件流行损坏 = 无更高权威，fail-fast 暴露（不静默跳过造成
 *   状态丢失）。
 * - 归属：ownerSessionId 持久在落盘路径（树内一级分区），内存态只持反查索引
 *   （canvasId → owner）。会话删除 → 画布整树随 ext-sessions 树回收（u-deletion 整树
 *   软删自动覆盖），内存镜像由分发入口摘除。
 * - 回推通道：owner 即回推对象（owner 活跃 = 现成 client 存活时回推，崩溃恢复回推语义
 *   保留——owner 在落盘路径持久化，runtime 重启后重建索引，owner session 重开即恢复
 *   回推）。旧「enter 登记绑定」的多对多 Map 已随归属唯一化退役。
 * - 广播：mutate 成功后同步回调 onUpdated（U3 接 broker 全局广播；reply 成功腿与广播
 *   同源同值——同一事件回执），payload 携带归属 sessionId。回推派发（client.prompt）
 *   不在本单元（U3 transport）。
 */
import { existsSync, mkdirSync, appendFileSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  ACTION_EVENT_MAP,
  canvasError,
  isActionAllowed,
  type CanvasActor,
  type CanvasCreateParams,
  type CanvasEventType,
  type CanvasExportParams,
  type CanvasListEntry,
  type CanvasListReply,
  type CanvasMutateReply,
  type CanvasMutateRequest,
  type CanvasState,
  type CanvasReadReply,
} from '@zhushanwen/extension-protocol'
import { getDataDir, getSessionCanvasesDir, getSessionStoreDir, isPiSessionId } from '@taiji/shared/paths'
import { randomUuid } from '@taiji/core/utils/random-uuid'
import { atomicWrite } from '../../utils/fs-utils.js'
import {
  CanvasDomainError,
  applyCreate,
  applyMutation,
  isCanvasDomainError,
  replayIdGenerator,
  subtreeOf,
  type CanvasDomainState,
  type CanvasEventBody,
  type CanvasTransformRequest,
  type GeneratedIds,
  type IdGenerator,
  COMMENT_ID_SEPARATOR,
} from './canvas-domain.js'
import { renderPlanningDoc, renderRequirementCard } from './canvas-export.js'

/** 快照间隔（每 N 条事件后写一次加速快照；设计初值 50，纯落盘策略参数，非功能预算）。 */
export const CANVAS_SNAPSHOT_INTERVAL = 50

/** canvasId 后缀长度（D7「短随机 id」：8 hex = 32bit 随机空间，MVP 低频产物量级）。 */
const CANVAS_ID_SUFFIX_LEN = 8

/**
 * canvasId 生成形态即契约（generateCanvasId 产 `cvs-<随机段>`，随机段为字母数字与
 * 连字符）。全部外部入口（mutate / readState / ownerOf）在字符串触达落盘路径前统一
 * 校验——`../` 等寻址越界形态在此拦截（renderer / LLM 经 WS RPC 与 marker 双通道传入
 * 可控字符串，C-comm-16 同族纪律）。
 */
const CANVAS_ID_PATTERN = /^cvs-[A-Za-z0-9-]+$/

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
  /** 画布归属会话 id（广播 payload 携带——消费方按归属过滤，D4 隔离）。 */
  ownerSessionId: string
  /** 主事件类型（封闭词表 CanvasEventType——renderer 按事件类型分流的键；收紧为词表
   * 联合后成员资格由 TS 构造性保证，消费侧无需再做成员资格守卫，M1-1）。 */
  evType: CanvasEventType
  eventId: string
  summary: string
}

export interface CanvasServiceDeps { // oe-exempt:20261015:framework:画布域类型契约（数据形状/端口/测试 harness，非抽象接口单实现）
  /**
   * 数据根目录（ext-sessions 树由 getSessionCanvasesDir(owner, dataDir) 推导——
   * `<dataDir>/ext-sessions/<ownerSessionId>/canvases/`）。测试注入 mkdtemp 自建自删；
   * 缺省按 getDataDir() 推导。
   */
  dataDir?: string
  /** mutate 成功后的全局广播回调（U3 接 broker；本服务保证同步调用、成功腿同源同值）。 */
  onUpdated?: (update: CanvasUpdatedBroadcast) => void
  /** 领域 id 生成（canvasId / rootNodeId / commentId）。测试注入确定性序列；缺省 randomUuid。 */
  generateId?: () => string
}

export class CanvasService {
  private readonly dataDir: string
  private readonly onUpdated: ((update: CanvasUpdatedBroadcast) => void) | undefined
  private readonly newId: () => string
  /** 内存态权威镜像（canvasId → 状态）；重建源 = events.jsonl。 */
  private readonly states = new Map<string, CanvasState>()
  /** 归属反查索引（canvasId → ownerSessionId）：owner 权威在落盘路径（树内一级分区），
   * 本索引 = 启动扫描 / create 登记的内存镜像，归属校验与清单过滤的查询面。 */
  private readonly owners = new Map<string, string>()
  /** per-canvas 事件流末序号（append 编号基準）。 */
  private readonly lastSeq = new Map<string, number>()

  constructor(deps: CanvasServiceDeps = {}) {
    this.dataDir = deps.dataDir ?? getDataDir()
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
   * canvasId 格式守卫（生成形态即契约：generateCanvasId 产 `cvs-<随机段>`，随机段为
   * 字母数字与连字符）。全部外部入口（mutate / readState / loadCanvas）统一调用：
   * 不匹配 = 非本服务产出的 id，直拼落盘路径可越出 canvases 根寻址（`../` 形态，
   * renderer / LLM 经 WS RPC 与 marker 双通道可控字符串）——fail-fast invalid_params，
   * 文案指向合法 id 的获取通道。
   */
  private assertCanvasIdFormat(canvasId: string): void {
    if (!CANVAS_ID_PATTERN.test(canvasId)) {
      throw new CanvasDomainError(canvasError('invalid_params', `canvasId「${canvasId}」格式非法（合法形态 cvs-<id>）：使用 canvas_list / canvas.list 返回的 canvasId`))
    }
  }

  /**
   * 归属校验（D4 隔离核心）：画布 owner ≠ 请求会话 → forbidden 结构化拒绝，文案带
   * 恢复指引（切换到归属会话）。owner 权威 = 落盘路径（树内一级分区），请求会话 =
   * 通道层注入的 sessionId（marker = 发起 pi 进程；WS = payload 必填字段）。
   */
  private assertOwnership(canvasId: string, sessionId: string): void {
    const owner = this.owners.get(canvasId)
    if (owner !== sessionId) {
      throw new CanvasDomainError(canvasError('forbidden', `画布「${canvasId}」不属于当前会话${owner !== undefined ? `（归属：${owner}）` : ''}，请让用户切换到归属会话后重试`))
    }
  }

  /**
   * 聚合根唯一写入入口。同步方法（同步段纪律：矩阵校验 + 归属校验 + 领域应用 + 落盘 +
   * 广播全在同步段内，零 await——「单进程串行化」由单线程同步执行构造性保证）。
   * sessionId = 请求会话（归属写面：create 落 owner、transform 校验归属）。
   * 领域拒绝（不变量 / 状态机 / 矩阵 / 寻址 / 归属）→ reply 失败腿；基础设施失败
   * （磁盘 IO）→ throw。
   */
  mutate(request: CanvasMutateRequest, actor: CanvasActor, sessionId: string): CanvasMutateResult {
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
      return this.mutateCreate(request.params, actor, sessionId)
    }
    // TS 判别联合收窄：排除 read / list / create 后 = CanvasTransformRequest（13 个 action）。
    return this.mutateTransform(request, actor, sessionId)
  }

  private mutateCreate(params: CanvasCreateParams, actor: CanvasActor, ownerSessionId: string): CanvasMutateResult {
    // owner 落盘路径分区键：非法 id（含路径分隔符等）在推导函数同域校验前先在此
    // fail-fast（错误面在画布域词表内，不漏底成裸 Error）。
    if (!isPiSessionId(ownerSessionId)) {
      return { ok: false, error: canvasError('invalid_params', `sessionId「${ownerSessionId}」格式非法：画布归属会话 id 须为合法 pi session id`) }
    }
    const at = new Date().toISOString()
    const ids = { canvasId: this.generateCanvasId(ownerSessionId), rootNodeId: this.newId() }
    let applied
    try {
      applied = applyCreate(params, actor, at, ids)
    } catch (e: unknown) {
      if (isCanvasDomainError(e)) return { ok: false, error: e.detail }
      throw e
    }
    const canvasId = applied.state.canvasId
    this.owners.set(canvasId, ownerSessionId)
    mkdirSync(this.canvasDir(ownerSessionId, canvasId), { recursive: true })
    const persisted = this.persistEvents(ownerSessionId, canvasId, this.withOwner(applied.state, ownerSessionId), applied.events, 0)
    this.states.set(canvasId, persisted.state)
    this.lastSeq.set(canvasId, persisted.seqEnd)
    this.broadcast(canvasId, ownerSessionId, applied.evType, persisted.mainEventId, applied.summary)
    return { ok: true, eventId: persisted.mainEventId, evType: applied.evType, summary: applied.summary, canvasId }
  }

  private mutateTransform(request: CanvasTransformRequest, actor: CanvasActor, sessionId: string): CanvasMutateResult {
    const canvasId = request.params.canvasId
    // 领域拒绝 → reply 失败腿（mutate 纪律，文件头）：格式不合法的 id 不触落盘寻址。
    if (!CANVAS_ID_PATTERN.test(canvasId)) {
      return { ok: false, error: canvasError('invalid_params', `canvasId「${canvasId}」格式非法（合法形态 cvs-<id>）：使用 canvas_list / canvas.list 返回的 canvasId`) }
    }
    // 归属校验先行于存在性（跨会话探测画布 id 只得 forbidden……且未知 id 一律
    // canvas_not_found：画布集合 = loadAll 启动扫描建立的索引，运行期无懒加载——
    // 新布局下单画布定位必须经 owner 路径分区，索引 miss = 不在树内）。
    if (!this.owners.has(canvasId)) {
      return { ok: false, error: canvasError('canvas_not_found', `画布「${canvasId}」不存在`) }
    }
    try {
      this.assertOwnership(canvasId, sessionId)
    } catch (e: unknown) {
      if (isCanvasDomainError(e)) return { ok: false, error: e.detail }
      throw e
    }
    const owner = this.owners.get(canvasId) as string
    // owner 在册：内存镜像优先，miss（loadAll 损败 / 磁盘被外部清理）经 loadCanvas 以
    // 事件流为准重建（重建失败抛错上抛——基础设施失败语义不变）。
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
      exportPath = this.writeExport(owner, applied.state, request.params, at)
    }
    const startSeq = this.lastSeq.get(canvasId) ?? 0
    const persisted = this.persistEvents(owner, canvasId, this.withOwner(applied.state, owner), applied.events, startSeq)
    this.states.set(canvasId, persisted.state)
    this.lastSeq.set(canvasId, persisted.seqEnd)
    const summary = exportPath ? `${applied.summary}（产物：${exportPath}）` : applied.summary
    this.broadcast(canvasId, owner, applied.evType, persisted.mainEventId, summary)
    return { ok: true, eventId: persisted.mainEventId, evType: applied.evType, summary, canvasId }
  }

  // ── 查询（read / list：不产事件、不在对账范围）───────────────

  /**
   * 画布全量只读视图（归属校验 + 返回深拷贝——内存权威不被调用方引用污染）。
   * sessionId = 请求会话：非 owner → forbidden（跨会话读拒绝，文案带恢复指引）。
   */
  readState(canvasId: string, sessionId: string, subtree?: string): CanvasReadReply {
    this.assertCanvasIdFormat(canvasId)
    // 画布集合 = loadAll 启动扫描建立的索引（新布局下单画布定位必须经 owner 路径分区，
    // 索引 miss = 不在树内，运行期无懒加载语义）。
    if (!this.owners.has(canvasId)) throw new CanvasDomainError(canvasError('canvas_not_found', `画布「${canvasId}」不存在`))
    this.assertOwnership(canvasId, sessionId)
    // owner 在册：内存镜像优先，miss（loadAll 损败 / 磁盘被外部清理）经 loadCanvas 以
    // 事件流为准重建（重建失败抛错上抛——基础设施失败语义不变）。
    const state = this.states.get(canvasId) ?? this.loadCanvas(canvasId)
    if (!state) throw new CanvasDomainError(canvasError('canvas_not_found', `画布「${canvasId}」不存在`))
    if (!subtree) return structuredClone(state)
    if (!state.nodes.some((n) => n.id === subtree)) {
      throw new CanvasDomainError(canvasError('node_not_found', `子树根「${subtree}」不存在：先取全量后核对节点 id`))
    }
    const ids = subtreeOf(state, subtree)
    const inSubtreeEdges = state.edges.filter((e) => ids.has(e.from) && ids.has(e.to))
    const subtreeEdgeIds = new Set(inSubtreeEdges.map((e) => e.id))
    const filtered: CanvasState = {
      ...structuredClone(state),
      nodes: state.nodes.filter((n) => ids.has(n.id)),
      edges: inSubtreeEdges,
      // 评论锚点 = 节点 id 或边 id（applyComment 两者皆合法）：锚子树内节点，或锚两端点
      // 都在子树内的边（与上行边过滤同判据——边在则其上的评论在；只按节点 id 过滤会把
      // 边锚评论静默丢弃，出现「边在、其上的用户评论不在」，F1-12）。子树边 id 预筛为
      // Set：评论过滤 O(评论数) 而非 O(评论数 × 边数)（N9——500 节点量级 subtree 读
      // 的热路径，A6b 基线未覆盖 subtree 计时，先消嵌套扫描）。
      comments: state.comments.filter((c) => ids.has(c.anchorId) || subtreeEdgeIds.has(c.anchorId)),
    }
    return filtered
  }

  /** 画布清单（按归属会话过滤：只返回 owner = sessionId 的画布，D4 裁决 3）。 */
  listCanvases(sessionId: string): CanvasListReply {
    const canvases: CanvasListEntry[] = []
    for (const [canvasId, owner] of this.owners) {
      if (owner !== sessionId) continue
      const s = this.states.get(canvasId)
      if (!s) continue
      canvases.push({
        canvasId: s.canvasId,
        ownerSessionId: owner,
        name: s.name,
        statement: s.root.statement,
        converged: s.converged,
        openMustFix: (s.review?.entries ?? []).filter((e) => e.severity === 'must-fix' && !e.resolution).length,
        reviewStatus: s.review?.status ?? null,
      })
    }
    return { canvases }
  }

  // ── 归属与回推通道（owner 即回推对象；生命周期见类头注释）──────

  /** 该画布的回推对象清单 = [归属会话]（owner 持久在落盘路径，重启后索引重建即恢复——
   * 崩溃恢复回推语义的载体）。画布不存在 = 空清单（无回推对象）。 */
  getBoundSessions(canvasId: string): string[] {
    const owner = this.owners.get(canvasId)
    return owner !== undefined ? [owner] : []
  }

  /** session 真删除的内存镜像摘除（session-lifecycle delete 编排侧调用；pi 崩溃 / restore
   * 不经此——owner 在路径持久化，session 重开即恢复回推）。磁盘树随 ext-sessions 整树
   * 回收（u-deletion），本方法只摘内存态。 */
  unbindSession(sessionId: string): void {
    for (const [canvasId, owner] of this.owners) {
      if (owner !== sessionId) continue
      this.owners.delete(canvasId)
      this.states.delete(canvasId)
      this.lastSeq.delete(canvasId)
    }
  }

  // ── 落盘与重建（布局 = <root>/<ownerSessionId>/canvases/<canvasId>/）──

  private canvasDir(ownerSessionId: string, canvasId: string): string {
    return join(getSessionCanvasesDir(ownerSessionId, this.dataDir), canvasId)
  }

  private eventsPath(ownerSessionId: string, canvasId: string): string {
    return join(this.canvasDir(ownerSessionId, canvasId), 'events.jsonl')
  }

  private snapshotPath(ownerSessionId: string, canvasId: string): string {
    return join(this.canvasDir(ownerSessionId, canvasId), 'canvas.json')
  }

  /** state 填充归属字段（ownerSessionId 由服务层从落盘路径推导注入——事件流不承载归属；
   * 领域态 → CanvasState 的唯一收口）。 */
  private withOwner(state: CanvasDomainState, ownerSessionId: string): CanvasState {
    return { ...state, ownerSessionId }
  }

  /** append 事件（唯一权威写入），恰满 N 条时随后写加速快照——先事件后快照的顺序在
   * 本方法体内固定（快照 state = 恰应用完本批事件的状态，锚点 = 流末 eventId）。 */
  private persistEvents(ownerSessionId: string, canvasId: string, state: CanvasState, events: CanvasEventBody[], startSeq: number): { mainEventId: string; seqEnd: number; state: CanvasState } {
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
      mkdirSync(this.canvasDir(ownerSessionId, canvasId), { recursive: true })
      appendFileSync(this.eventsPath(ownerSessionId, canvasId), lines.join(''), 'utf-8')
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
      this.writeSnapshot(ownerSessionId, canvasId, state, String(seqEnd))
    }
    return { mainEventId, seqEnd, state }
  }

  /** 加速快照（atomicWrite）；state 必须是恰应用完流末事件的状态（锚点对齐的写入侧保证）。 */
  private writeSnapshot(ownerSessionId: string, canvasId: string, state: CanvasState, anchorEventId: string): void {
    const snapshot: CanvasSnapshotFile = { version: 1, anchorEventId, state }
    try {
      atomicWrite(this.snapshotPath(ownerSessionId, canvasId), JSON.stringify(snapshot), `canvas-snap-${canvasId}`)
    } catch (e: unknown) {
      // best-effort 降级：快照是加速缓存非权威，写入失败不阻断 mutate 主链——
      // 恢复路径 = 下次重建自动走全量重放（「一律以事件流为准」），此处仅留痕。
      console.error(`[canvas-service] canvas.json 快照写入失败（canvasId=${canvasId}，重建将全量重放事件流）：`, e)
    }
  }

  /** 单画布重建：快照（可信时）+ 增量事件重放；快照损坏 / 锚点超前一律丢弃走全量重放。
   * owner 从 owners 索引取（索引由 loadAll 扫树登记，本方法只服务重建路径——运行期
   * 索引 miss = 画布不在树内，返回 undefined）。 */
  private loadCanvas(canvasId: string): CanvasState | undefined {
    // 纵深守卫（mutate/readState 入口已拦）：loadAll 扫描目录名的直接通道
    // ——磁盘上的非法目录名（手工放置）在此 fail-fast，由 loadAll 捕获留痕不拖垮启动。
    this.assertCanvasIdFormat(canvasId)
    const owner = this.owners.get(canvasId)
    if (owner === undefined) return undefined
    const eventsFile = this.eventsPath(owner, canvasId)
    if (!existsSync(eventsFile)) return undefined
    // 事件流单次读入（同步段内无并发写，快照锚点校验与重放共用同一份行集——拆两处
    // readFileSync + split 是纯重复计算）。
    const lines = readFileSync(eventsFile, 'utf-8').split('\n').filter((l) => l.trim() !== '')
    let state: CanvasDomainState | undefined
    let anchorSeq = 0
    const snapFile = this.snapshotPath(owner, canvasId)
    if (existsSync(snapFile)) {
      try {
        const snap = JSON.parse(readFileSync(snapFile, 'utf-8')) as CanvasSnapshotFile
        const parsedAnchor = Number(snap.anchorEventId)
        const lastSeqInFile = lines.length > 0 ? (JSON.parse(lines[lines.length - 1] as string) as CanvasPersistedEvent).seq : 0
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
    const owned = this.withOwner(state, owner)
    this.states.set(canvasId, owned)
    this.lastSeq.set(canvasId, lastSeq)
    return owned
  }

  /** 重放单条事件（与 live 共用 domain apply——直写 ≡ 重放的构造点）。 */
  private replayEvent(canvasId: string, prev: CanvasDomainState | undefined, ev: CanvasPersistedEvent): CanvasDomainState {
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
    // comment 评论 id 随事件落盘（applyComment 产 generated.commentId，完整形态
    // `${anchorId}${COMMENT_ID_SEPARATOR}<生成段>`）——与 create 分支同款按落盘值
    // 恢复：生成器返回落盘 id 的生成段，applyComment 的拼接还原原评论 id（直写 ≡
    // 重放）。生成段 = runtime id（randomUuid / 测试序列，不含分隔符），lastIndexOf
    // 恒定位 applyComment 写入的分隔符。缺落盘 id / 分隔符缺失 = 事件流数据损坏
    // fail-fast——静默另造 id 会使重放状态与直写不一致（等价性违约）。
    let idGen: IdGenerator = replayIdGenerator
    if (ev.action === 'comment') {
      const commentId = generated.commentId
      const sep = commentId !== undefined ? commentId.lastIndexOf(COMMENT_ID_SEPARATOR) : -1
      if (commentId === undefined || sep < 0 || sep + COMMENT_ID_SEPARATOR.length >= commentId.length) {
        throw new CanvasDomainError(canvasError('invalid_params', `comment 事件缺生成 id（generated.commentId，canvasId=${canvasId} seq=${ev.seq}）——事件流数据损坏：以 events.jsonl 为准检查该行`))
      }
      const generatedSegment = commentId.slice(sep + COMMENT_ID_SEPARATOR.length)
      idGen = { next: (): string => generatedSegment }
    }
    const applied = applyMutation(prev, { action: ev.action, params: ev.data } as never, ev.actor, ev.at, idGen)
    return applied.state
  }

  /**
   * 启动扫描：遍历 ext-sessions 树内各 session 分区的 canvases/ 域，从目录名推导 owner
   * 登记索引后逐画布重建（路径即归属——树的分区键就是归属权威，事件流 / 快照不承载）。
   * 非合法 sessionId 形态的一级目录跳过（树内遍历规约，isPiSessionId 结构性拦截手工
   * 放置的非会话目录）；单画布损坏不拖垮服务启动（其余画布照常服务），错误留痕指向
   * 权威源。
   */
  private loadAll(): void {
    const storeRoot = getSessionStoreDir(this.dataDir)
    if (!existsSync(storeRoot)) return
    for (const sidEntry of readdirSync(storeRoot, { withFileTypes: true })) {
      if (!sidEntry.isDirectory() || !isPiSessionId(sidEntry.name)) continue
      const canvasesDir = getSessionCanvasesDir(sidEntry.name, this.dataDir)
      if (!existsSync(canvasesDir)) continue
      for (const entry of readdirSync(canvasesDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        if (!CANVAS_ID_PATTERN.test(entry.name)) continue
        this.owners.set(entry.name, sidEntry.name)
        try {
          this.loadCanvas(entry.name)
        } catch (e: unknown) {
          // 单画布损坏不拖垮服务启动（其余画布照常服务）；错误留痕指向权威源。
          console.error(`[canvas-service] 画布「${entry.name}」重建失败（以 events.jsonl 为准检查数据）：`, e)
        }
      }
    }
  }

  private generateCanvasId(ownerSessionId: string): string {
    for (;;) {
      const id = `cvs-${this.newId().slice(0, CANVAS_ID_SUFFIX_LEN)}`
      if (!existsSync(this.canvasDir(ownerSessionId, id))) return id
    }
  }

  private writeExport(ownerSessionId: string, state: CanvasDomainState, params: CanvasExportParams, at: string): string {
    const exportsDir = join(this.canvasDir(ownerSessionId, state.canvasId), 'exports')
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

  private broadcast(canvasId: string, ownerSessionId: string, evType: CanvasEventType, eventId: string, summary: string): void {
    // 同步回调（U3 接 broker.broadcast）；回调异常不阻断 mutate 主链（广播是失效提示，
    // 丢失由下次拉取收敛——ADR-0097 拉为主）。
    try {
      this.onUpdated?.({ canvasId, ownerSessionId, evType, eventId, summary })
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
 * session 真删除的画布内存镜像摘除分发入口（session-lifecycle.ts delete 编排侧调用——
 * 主会话自身、btw 线直删分支、主删级联逐线三处；不挂 removeSessionEntry 汇聚点，该点
 * 同时收 pi 崩溃 / forceQuit / restore 清场三条存活路径）。磁盘树随 ext-sessions 整树
 * 回收（u-deletion 整树软删），此处只摘内存态。
 */
export function unbindCanvasOnSessionDeleted(sessionId: string): void {
  for (const svc of activeServices) {
    svc.unbindSession(sessionId)
  }
}
