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
    if (actor !== 'user') {
      fail('review_max_rounds', `审查已达轮次上限（${draft.review.maxRounds} 轮）停回中，agent 不得自主继续：由用户升级裁决后在画布重新发起`)
    }
    draft.review.round += 1
    draft.review.status = 'in-progress'
    draft.review.stopNote = undefined
    draft.review.recoverHint = undefined
    events.push({ type: 'ReviewEscalated', action: 'review-request', actor, at, data: { canvasId: draft.canvasId, round: draft.review.round } })
  } else if (draft.review.round >= draft.review.maxRounds) {
    // 达轮次上限（设计 §3.1 失败路径② + 聚合 2 不变量 2）：置终态 max-rounds + 停回说明
    // 与恢复动作建议，ReviewMaxRoundsReached 留痕；不进入新一轮（round 不动、dirtyPaths
    // 不清——本轮未开始，待重审路径保留到升级放行时随发起消费）。
    draft.review.status = 'max-rounds'
    draft.review.stopNote = `审查已达轮次上限（${draft.review.maxRounds} 轮）未收敛，停回用户裁决`
    draft.review.recoverHint = '升级裁决（扩大审查范围或修改完成判据）后重新发起审查（画布「发起审查」入口，用户操作）'
    draft.updatedAt = at
    events.push({ type: 'ReviewMaxRoundsReached', action: 'review-request', actor, at, data: { canvasId: draft.canvasId, round: draft.review.round, maxRounds: draft.review.maxRounds } })
    events.push(eventOf('review-request', actor, at, eventData({ ...params })))
    return `审查已达轮次上限（${draft.review.maxRounds} 轮）：已置终态 max-rounds 停回用户——${draft.review.recoverHint}`
  } else {
    draft.review.round += 1
    draft.review.status = 'in-progress'
  }
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
  }
  const knownIds = new Set<string>([...draft.nodes.map((n) => n.id), ...draft.edges.map((e) => e.id), ...draft.comments.map((c) => c.id)])
  for (const entry of params.entries) {
    // 聚合 2 不变量 1：条目引用的图元素 id 必须存在于画布。
    if (!knownIds.has(entry.targetId)) fail('entry_ref_missing', `报告条目「${entry.id}」引用的图元素「${entry.targetId}」不存在`)
  }
  // 支撑度写回前置校验（概念 §2.4「边的缺陷经支撑度表达」的唯一写入通道——审查结论
  // 随条目落 edge.support）：评价目标必须是主干边（裁决点 R3：论证边不评级）；
  // gap 必附缺口清单（「有缺口附清单」词条语义，与契约守卫同规则——重放 / WS 直连
  // 不经 marker 守卫，runtime 是唯一防线）。
  for (const entry of params.entries) {
    if (entry.supportRating === undefined) continue
    const edge = edgeOf(draft, entry.targetId)
    if (!edge || !isTrunkEdge(edge)) {
      fail('invalid_params', `支撑度评价目标「${entry.targetId}」不是主干边（decompose/resolve）——论证边不评级（裁决点 R3），条目「${entry.id}」去掉 supportRating 后重试`)
    }
    if (entry.supportRating === 'gap' && (!entry.supportGaps || entry.supportGaps.length === 0)) {
      fail('invalid_params', `条目「${entry.id}」支撑度评价为 gap 但未附缺口清单（supportGaps 至少一条）——「有缺口附清单」`)
    }
  }
  for (const entry of params.entries) {
    const existing = draft.review.entries.find((e) => e.id === entry.id)
    const merged = { ...entry, resolution: existing?.resolution }
    if (existing) {
      // 幂等 upsert（同 grow：重试覆盖字段、保留已登记的处置记录）。
      draft.review.entries[draft.review.entries.indexOf(existing)] = merged
    } else {
      draft.review.entries.push(merged)
    }
    if (entry.supportRating !== undefined) {
      const edge = edgeOf(draft, entry.targetId)
      if (edge) edge.support = { rating: entry.supportRating, ...(entry.supportGaps ? { gaps: [...entry.supportGaps] } : {}), round: params.round }
    }
  }
  draft.updatedAt = at
  events.push(eventOf('review-append', actor, at, eventData({ ...params })))
  return `审查报告 R${params.round} 写回 ${params.entries.length} 条条目`
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
