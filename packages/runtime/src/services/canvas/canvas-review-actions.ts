/**
 * 审查聚合动作（problem-solve-canvas U2）——review-request / review-append /
 * review-resolve 三 action 的状态应用（聚合 2：ReviewReport）。
 *
 * 从 canvas-actions.ts 拆出（审查终态 + 支撑度写回补全后超 500 行红线）：applyByAction
 * 主分发仍在 canvas-actions.ts，本文件只承载审查域规则。依赖单向：
 * foundation ← 本文件 ← canvas-actions.ts ← canvas-domain.ts。
 *
 * 机制锚点：设计 §3.1 失败路径②（达轮次上限 → 终态 max-rounds + 停回说明 →
 * 用户升级裁决后可再发起）+ 概念 §2.4（边的缺陷经支撑度表达——review-append 条目
 * 附带评价落 edge.support）+ §2.5 聚合 2 不变量（条目 id 存在 / 终态附停回说明 /
 * 审查与修复分离）。
 */
import type { CanvasActionParams, CanvasActor, CanvasState } from '@zhushanwen/extension-protocol'
import { edgeOf, eventData, eventOf, fail, isTrunkEdge, truncate, type CanvasEventBody } from './canvas-foundation.js'

/** 审查循环轮次上限（审查引擎参数，对齐 review-fix-loop 的 maxRounds；非画布生长预算）。 */
export const DEFAULT_REVIEW_MAX_ROUNDS = 5

/** 轮次完成判据（一轮 = 一循环：发起 → reviewer 报告写回 → 处置）：当前轮已有报告
 * 条目 = 已完成。尚无条目 = 本轮未完成——再发起是同一轮的重发（GUI 双跳的第二跳：
 * user 发起 → 回推 → agent run 再发起），不推进轮次、不消耗轮次预算（maxRounds 按
 * 完成的审查循环计数——设计 §3.1:173 GUI 链路一次循环计一轮，R1 全面审语义由此保持）。 */
function roundHasReport(review: NonNullable<CanvasState['review']>): boolean {
  return review.entries.some((e) => e.round === review.round)
}

export function applyReviewRequest(
  draft: CanvasState,
  params: CanvasActionParams['review-request'],
  actor: CanvasActor,
  at: string,
  events: CanvasEventBody[],
): string {
  if (!draft.review) {
    draft.review = { status: 'in-progress', round: 1, maxRounds: DEFAULT_REVIEW_MAX_ROUNDS, entries: [] }
  } else if (draft.review.status === 'max-rounds') {
    // 停回终态下的再发起 = 升级裁决通道（设计 §3.1 失败路径②「用户升级裁决后可再发起」）：
    // 仅 user 放行——达上限后继续审查是用户裁决；agent 再发起 = review_max_rounds 拒绝，
    // 恢复文案指向 GUI 重新发起（错误 → 恢复动作闭环）。ReviewEscalated 留痕（概念 §2.6）。
    // 轮次预算随放行同步抬升（maxRounds = round）：只 round+1 不抬预算会使
    // round > maxRounds 恒成立，升级后的一切 review-request 立即再置 max-rounds
    // ——升级轮永远无法实际执行。每次升级裁决恰放行一轮（用户裁决优先于引擎参数）。
    if (actor !== 'user') {
      fail('review_max_rounds', `审查已达轮次上限（${draft.review.maxRounds} 轮）停回中，agent 不得自主继续：由用户升级裁决后在画布重新发起`)
    }
    draft.review.round += 1
    draft.review.maxRounds = draft.review.round
    draft.review.status = 'in-progress'
    draft.review.stopNote = undefined
    draft.review.recoverHint = undefined
    events.push({ type: 'ReviewEscalated', action: 'review-request', actor, at, data: { canvasId: draft.canvasId, round: draft.review.round, maxRounds: draft.review.maxRounds } })
  } else if (roundHasReport(draft.review) && draft.review.round >= draft.review.maxRounds) {
    // 达轮次上限（设计 §3.1 失败路径② + 聚合 2 不变量 2）：上一轮已完成（有报告）且
    // 轮次预算用尽 → 置终态 max-rounds + 停回说明与恢复动作建议，ReviewMaxRoundsReached
    // 留痕；不进入新一轮（round 不动、dirtyPaths 不清——本轮未开始，待重审路径保留到
    // 升级放行时随发起消费）。
    draft.review.status = 'max-rounds'
    draft.review.stopNote = `审查已达轮次上限（${draft.review.maxRounds} 轮）未收敛，停回用户裁决`
    draft.review.recoverHint = '升级裁决（扩大审查范围或修改完成判据）后重新发起审查（画布「发起审查」入口，用户操作）'
    draft.updatedAt = at
    events.push({ type: 'ReviewMaxRoundsReached', action: 'review-request', actor, at, data: { canvasId: draft.canvasId, round: draft.review.round, maxRounds: draft.review.maxRounds } })
    events.push(eventOf('review-request', actor, at, eventData({ ...params })))
    return `审查已达轮次上限（${draft.review.maxRounds} 轮）：已置终态 max-rounds 停回用户——${draft.review.recoverHint}`
  } else if (roundHasReport(draft.review)) {
    // 上一轮已完成 → 推进新一轮。
    draft.review.round += 1
    draft.review.status = 'in-progress'
  }
  // 其余情形：当前轮尚无报告条目 → 同一轮再发起（重发 / GUI 双跳的第二跳），round
  // 不动。
  // 发起审查 = 当前全部待重审路径进入本轮审查范围（概念 §5.2「下轮审查优先覆盖待重审
  // 路径」的消费点）：集合清空。这是待重审集合的唯一清除通道——没有它，收敛门禁③
  // 「待重审空」不可达（词表无 clear-dirty action，属设计内语义而非新增动作）。
  draft.dirtyPaths = []
  draft.updatedAt = at
  events.push(eventOf('review-request', actor, at, eventData({ ...params })))
  return `审查已发起（R${draft.review.round}${params.scope ? `，范围：${truncate(params.scope)}` : '，全面审'}）`
}

export function applyReviewAppend(
  draft: CanvasState,
  params: CanvasActionParams['review-append'],
  actor: CanvasActor,
  at: string,
  events: CanvasEventBody[],
): string {
  if (!draft.review) {
    draft.review = { status: 'in-progress', round: params.round, maxRounds: DEFAULT_REVIEW_MAX_ROUNDS, entries: [] }
  } else if (params.round !== draft.review.round) {
    // 轮次口径确定性（聚合 2「当前轮已有报告条目 = 轮次完成」）：写回必须落在当前轮——
    // reviewer 自带 round 与当前轮不一致时轮次完成判定失去确定性（roundHasReport 按
    // entry.round === review.round 判完成，maxRounds 预算按完成的循环计数）。无 review
    // 时按 params.round 建聚合不变（首轮直写路径）。重放与 live 同一校验（直写 ≡ 重放）。
    fail('invalid_params', `报告轮次（R${params.round}）与当前审查轮次（R${draft.review.round}）不一致：review-append 必须写回当前轮——先 canvas_read 核对审查聚合轮次`)
  }
  // 校验三段先行（引用完整性 → 条目身份 → 支撑度规则），全过才落聚合（任一失败 fail-fast 无部分写入）。
  validateEntryRefs(draft, params.entries)
  validateEntryIds(draft, params)
  validateSupportRatings(draft, params.entries)
  upsertReviewEntries(draft, params)
  draft.updatedAt = at
  events.push(eventOf('review-append', actor, at, eventData({ ...params })))
  return `审查报告 R${params.round} 写回 ${params.entries.length} 条条目`
}

/** 聚合 2 不变量 1：条目引用的图元素 id 必须存在于画布（节点 / 边 / 评论三类 id 全集）。 */
function validateEntryRefs(draft: CanvasState, entries: CanvasActionParams['review-append']['entries']): void {
  const knownIds = new Set<string>([...draft.nodes.map((n) => n.id), ...draft.edges.map((e) => e.id), ...draft.comments.map((c) => c.id)])
  for (const entry of entries) {
    if (!knownIds.has(entry.targetId)) fail('entry_ref_missing', `报告条目「${entry.id}」引用的图元素「${entry.targetId}」不存在`)
  }
}

/** 条目身份校验（聚合 2 唯一防线——重放 / WS 直连不经 marker 守卫）：
 * ① 单条 round 必须与报告轮次一致（marker 注入路径恒同轮，直连调用方声明不一致 = 非法
 * 输入——放行会借「同轮同 id 幂等覆盖」语义伪造异轮改写）；② 条目身份 = (round, id)
 * 二元组，同 id 异轮 = 跨轮撞号拒绝——全局按 id upsert 时 R2 复审同序号条目（reviewer
 * 按 rv-<序号> 生成 id 的惯性）会静默覆盖 R1 条目并继承其处置记录，R2 新 must-fix 未
 * 处置即显示已处置，收敛门禁③（must-fix 清零）被旁路。同轮同 id 不拦（崩溃重试幂等
 * upsert，见 upsertReviewEntries）。 */
function validateEntryIds(draft: CanvasState, params: CanvasActionParams['review-append']): void {
  const review = draft.review
  if (!review) return
  for (const entry of params.entries) {
    if (entry.round !== params.round) {
      fail('invalid_params', `报告条目「${entry.id}」的轮次（R${entry.round}）与报告轮次（R${params.round}）不一致：条目 round 必须等于报告轮次，修正后重试`)
    }
    const existing = review.entries.find((e) => e.id === entry.id && e.round !== entry.round)
    if (existing) {
      fail('invalid_params', `报告条目 id「${entry.id}」已被 R${existing.round} 条目占用（条目身份 = 轮次 + id，跨轮不得复用）：R${entry.round} 条目换 id（如 rv-r${entry.round}-<序号>）后重试`)
    }
  }
}

/** 支撑度写回前置校验（概念 §2.4「边的缺陷经支撑度表达」的唯一写入通道——审查结论
 * 随条目落 edge.support）：评价目标必须是主干边（裁决点 R3：论证边不评级）；
 * gap 必附缺口清单、sufficient/invalid 不得夹带清单（「有缺口附清单」词条语义，
 * 与契约守卫同规则双向——重放 / WS 直连不经 marker 守卫，runtime 是唯一防线）。 */
function validateSupportRatings(draft: CanvasState, entries: CanvasActionParams['review-append']['entries']): void {
  for (const entry of entries) {
    if (entry.supportRating === undefined) continue
    const edge = edgeOf(draft, entry.targetId)
    if (!edge || !isTrunkEdge(edge)) {
      fail('invalid_params', `支撑度评价目标「${entry.targetId}」不是主干边（decompose/resolve）——论证边不评级（裁决点 R3），条目「${entry.id}」去掉 supportRating 后重试`)
    }
    if (entry.supportRating === 'gap' && (!entry.supportGaps || entry.supportGaps.length === 0)) {
      fail('invalid_params', `条目「${entry.id}」支撑度评价为 gap 但未附缺口清单（supportGaps 至少一条）——「有缺口附清单」`)
    }
    if (entry.supportGaps !== undefined && entry.supportRating !== 'gap') {
      fail('invalid_params', `条目「${entry.id}」支撑度评价为「${entry.supportRating}」不得夹带缺口清单（supportGaps 仅 gap 评价携带：sufficient/invalid 不带）`)
    }
  }
}

/** 条目落聚合 + 评价写回 edge.support。幂等 upsert（同 grow：重试覆盖字段、保留已
 * 登记的处置记录）。条目身份 = (round, id) 二元组——仅同轮同 id 覆盖（崩溃重试幂
 * 等）；跨轮同 id 已被 validateEntryIds 前置拒绝，此处查找不会命中异轮条目。review
 * 聚合由调用方（applyReviewAppend 首分支）保证已初始化——本地 guard 仅为类型收窄
 * （收窄不跨函数边界），运行时不可达。 */
function upsertReviewEntries(draft: CanvasState, params: CanvasActionParams['review-append']): void {
  const review = draft.review
  if (!review) return
  for (const entry of params.entries) {
    const existing = review.entries.find((e) => e.id === entry.id && e.round === entry.round)
    const merged = { ...entry, resolution: existing?.resolution }
    if (existing) {
      review.entries[review.entries.indexOf(existing)] = merged
    } else {
      review.entries.push(merged)
    }
    if (entry.supportRating !== undefined) {
      const edge = edgeOf(draft, entry.targetId)
      if (edge) edge.support = { rating: entry.supportRating, ...(entry.supportGaps ? { gaps: [...entry.supportGaps] } : {}), round: params.round }
    }
  }
}

const RESOLUTION_NOTE_MAX = 20

/** 处置链责任方（设计 §3.1(1)）：主 agent = 执行侧；user = 复核与直接处置；first-writer-wins。 */
export function applyReviewResolve(
  draft: CanvasState,
  params: CanvasActionParams['review-resolve'],
  actor: CanvasActor,
  at: string,
  events: CanvasEventBody[],
): string {
  const entry = draft.review?.entries.find((e) => e.id === params.entryId)
  if (!entry) fail('entry_ref_missing', `报告条目「${params.entryId}」不存在：先 canvas_read 取当前审查报告`)
  if (entry.resolution) {
    fail('already_resolved', `该条目已由 ${entry.resolution.by === 'user' ? '用户' : 'agent'} 处置（${entry.resolution.disposition}）——first-writer-wins，改判走下一轮审查复审`)
  }
  entry.resolution = { disposition: params.disposition, by: actor === 'user' ? 'user' : 'agent', note: params.note }
  draft.updatedAt = at
  events.push(eventOf('review-resolve', actor, at, eventData({ ...params })))
  return `条目「${truncate(entry.note, RESOLUTION_NOTE_MAX)}」已处置（${params.disposition}）：${truncate(params.note)}`
}
