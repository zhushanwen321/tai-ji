/**
 * 审查循环轮次语义与终态、支撑度写回。
 * - 轮次口径（一轮 = 一循环）：发起 → reviewer 报告写回（review-append）→ 处置为
 *   一轮；当前轮无报告条目时再发起 = 同一轮重发（GUI 双跳：user 发起 → 回推 →
 *   agent run 再发起），round 不动、不消耗 maxRounds 预算。
 * - 设计 §3.1 失败路径②：审查达轮次上限（完成的循环数用尽预算）→ 终态 max-rounds +
 *   停回说明 + ReviewMaxRoundsReached 留痕 → 用户升级裁决放行恰一轮（round+1 且
 *   maxRounds 同步抬升 + ReviewEscalated 留痕，放行后即回 in-progress）——升级后的
 *   轮次可被 agent run 的 review-request 正常开始；agent 停回后再发起 =
 *   review_max_rounds 拒绝（错误 → 恢复动作闭环）。
 * - 概念 §2.4「边的缺陷经支撑度表达」：review-append 条目附带支撑度评价落 edge.support
 *   （主干边限定——裁决点 R3；gap 附清单——「有缺口附清单」词条）。
 * - 直写 ≡ 重放：轮次推进 / 终态 / 升级 / 支撑度均经 events.jsonl 主事件确定性重放
 *   （附属事件 ReviewMaxRoundsReached / ReviewEscalated 不参与重放，重放由
 *   review-request / review-append 主事件分支承载）。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CanvasService } from '../canvas-service.js'
import { createCanvas, expectOk, expectRejected, growCanvas, makeService, SID, SID_B } from './canvas-helpers.js'
import { getSessionCanvasesDir } from '@taiji/shared/paths'
import type { CanvasState } from '@zhushanwen/extension-protocol'

interface PersistedLine { // oe-exempt:20261015:framework:画布域类型契约（数据形状/端口/测试 harness，非抽象接口单实现）
  seq: number
  eventId: string
  type: string
  action: string
  actor: string
  at: string
  data: Record<string, unknown>
}

function readLines(dir: string, canvasId: string): PersistedLine[] {
  return readFileSync(join(getSessionCanvasesDir(SID, dir), canvasId, 'events.jsonl'), 'utf-8')
    .split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l) as PersistedLine)
}

/** 完成一轮：发起（round = 当前轮）+ 报告写回（当前轮有条目 = 轮次完成判据）。 */
function completeRound(svc: CanvasService, canvasId: string, targetId: string): void {
  expectOk(svc.mutate({ action: 'review-request', params: { canvasId } }, 'agent', SID))
  const review = svc.readState(canvasId, SID).review
  expect(review).toBeDefined()
  if (!review) throw new Error('review 聚合缺失：review-request 未生效')
  const round = review.round
  expectOk(svc.mutate({
    action: 'review-append',
    params: { canvasId, round, entries: [{ id: `re-r${round}`, round, dimension: 'completeness', severity: 'must-fix', targetId, note: `R${round} 报告条目` }] },
  }, 'review', SID))
}

/** 推进到审查轮次上限：完成 5 轮循环（发起 + 报告写回各 5 次）→ round = maxRounds = 5。 */
function exhaustRounds(svc: CanvasService, canvasId: string, targetId: string): void {
  for (let i = 0; i < 5; i++) {
    completeRound(svc, canvasId, targetId)
  }
}

describe('轮次口径（一轮 = 一循环：GUI 双跳 / 重发不虚增轮次）', () => {
  it('当前轮无报告条目时再发起 = 同一轮重发（round 不动，不消耗预算）——GUI 链路 user 发起 + agent run 两跳计一轮', () => {
    const h = makeService()
    try {
      const c = growCanvas(h.svc, createCanvas(h.svc))
      // GUI 双跳：user 发起（WS mutate）→ 回推 → agent run 再发起（marker mutate）
      expectOk(h.svc.mutate({ action: 'review-request', params: { canvasId: c.canvasId } }, 'user', SID))
      expect(c.state().review?.round).toBe(1)
      expectOk(h.svc.mutate({ action: 'review-request', params: { canvasId: c.canvasId } }, 'agent', SID))
      expect(c.state().review?.round).toBe(1)
      // R1 报告写回后，下一次发起才推进 R2
      expectOk(h.svc.mutate({
        action: 'review-append',
        params: { canvasId: c.canvasId, round: 1, entries: [{ id: 're-r1', round: 1, dimension: 'completeness', severity: 'must-fix', targetId: c.q1, note: 'R1 报告' }] },
      }, 'review', SID))
      expectOk(h.svc.mutate({ action: 'review-request', params: { canvasId: c.canvasId } }, 'agent', SID))
      expect(c.state().review?.round).toBe(2)
    } finally {
      h.dispose()
    }
  })
})

describe('轮次口径确定性（聚合 2「当前轮已有报告条目 = 轮次完成」：review-append 必须写回当前轮）', () => {
  it('已有审查聚合时 params.round 与当前轮不符 → invalid_params（恢复文案含当前轮次号）且条目不落；当前轮写回放行', () => {
    const h = makeService()
    try {
      const c = growCanvas(h.svc, createCanvas(h.svc))
      // 完成 R1（发起 + 报告写回）→ 再次发起推进到 R2（当前轮 = R2）
      expectOk(h.svc.mutate({ action: 'review-request', params: { canvasId: c.canvasId } }, 'agent', SID))
      expectOk(h.svc.mutate({
        action: 'review-append',
        params: { canvasId: c.canvasId, round: 1, entries: [{ id: 're-r1', round: 1, dimension: 'completeness', severity: 'must-fix', targetId: c.q1, note: 'R1 报告' }] },
      }, 'review', SID))
      expectOk(h.svc.mutate({ action: 'review-request', params: { canvasId: c.canvasId } }, 'agent', SID))
      expect(c.state().review?.round).toBe(2)
      // R2 进行中携带 R1 轮次写回 → 拒绝（roundHasReport / maxRounds 预算的完成判定须确定性）
      const reply = h.svc.mutate({
        action: 'review-append',
        params: { canvasId: c.canvasId, round: 1, entries: [{ id: 're-late', round: 1, dimension: 'completeness', severity: 'suggestion', targetId: c.q1, note: '迟到的 R1 条目' }] },
      }, 'review', SID)
      expectRejected(reply, 'invalid_params')
      if (!reply.ok) expect(reply.error.message).toContain('R2')
      // 拒绝 = 无写入：R1 条目仍在、迟到条目未落
      expect(c.state().review?.entries.map((e) => e.id)).toEqual(['re-r1'])
      // 当前轮（R2）写回放行
      expectOk(h.svc.mutate({
        action: 'review-append',
        params: { canvasId: c.canvasId, round: 2, entries: [{ id: 're-r2', round: 2, dimension: 'completeness', severity: 'suggestion', targetId: c.q1, note: 'R2 报告' }] },
      }, 'review', SID))
      expect(c.state().review?.entries.map((e) => e.id)).toEqual(['re-r1', 're-r2'])
    } finally {
      h.dispose()
    }
  })
})

describe('审查终态 max-rounds（设计 §3.1 失败路径②：置终态 + 停回说明 + 留痕）', () => {
  it('达上限再发起 = 合法终态转移（非校验失败）：status=max-rounds + stopNote/recoverHint + ReviewMaxRoundsReached 事件 + round 不动 + dirtyPaths 不清（本轮未开始）', () => {
    const h = makeService()
    try {
      const c = growCanvas(h.svc, createCanvas(h.svc))
      exhaustRounds(h.svc, c.canvasId, c.q1)
      expect(c.state().review?.status).toBe('in-progress')
      // 用户改动造待重审（达上限分支不得消费——审查没有开始）
      expectOk(h.svc.mutate({ action: 'patch', params: { canvasId: c.canvasId, nodeId: c.q1, content: '补丁后表述', reason: '修订' } }, 'user', SID))
      expect(c.state().dirtyPaths.length).toBeGreaterThan(0)
      const reply = h.svc.mutate({ action: 'review-request', params: { canvasId: c.canvasId } }, 'agent', SID)
      expect(reply.ok).toBe(true)
      if (reply.ok) expect(reply.summary).toContain('停回')
      const review = c.state().review
      expect(review?.status).toBe('max-rounds')
      expect(review?.round).toBe(5)
      expect(review?.stopNote).toContain('轮次上限')
      expect(review?.stopNote).toContain('停回')
      expect(review?.recoverHint).toContain('升级裁决')
      expect(c.state().dirtyPaths.length).toBeGreaterThan(0)
      expect(readLines(h.dir, c.canvasId).map((l) => l.type)).toContain('ReviewMaxRoundsReached')
    } finally {
      h.dispose()
    }
  })

  it('停回后 agent 再发起 → review_max_rounds 拒绝（恢复文案指向用户升级裁决——错误 → 恢复动作闭环）', () => {
    const h = makeService()
    try {
      const c = growCanvas(h.svc, createCanvas(h.svc))
      exhaustRounds(h.svc, c.canvasId, c.q1)
      expectOk(h.svc.mutate({ action: 'review-request', params: { canvasId: c.canvasId } }, 'agent', SID))
      const reply = h.svc.mutate({ action: 'review-request', params: { canvasId: c.canvasId } }, 'agent', SID)
      expectRejected(reply, 'review_max_rounds')
      if (!reply.ok) expect(reply.error.message).toContain('agent 不得自主继续')
      expect(c.state().review?.status).toBe('max-rounds')
    } finally {
      h.dispose()
    }
  })

  it('停回后 user 再发起 = 升级裁决 → 放行 R6（maxRounds 同步抬升）+ ReviewEscalated 留痕 + 停回说明清除 + 待重审随发起消费；升级后 agent run 的 review-request 可正常开始（同一轮重发不触发上限）', () => {
    const h = makeService()
    try {
      const c = growCanvas(h.svc, createCanvas(h.svc))
      exhaustRounds(h.svc, c.canvasId, c.q1)
      expectOk(h.svc.mutate({ action: 'review-request', params: { canvasId: c.canvasId } }, 'agent', SID))
      expect(c.state().review?.status).toBe('max-rounds')
      const reply = h.svc.mutate({ action: 'review-request', params: { canvasId: c.canvasId, scope: '升级裁决：聚焦换选风险' } }, 'user', SID)
      expect(reply.ok).toBe(true)
      const review = c.state().review
      expect(review?.status).toBe('in-progress')
      expect(review?.round).toBe(6)
      expect(review?.maxRounds).toBe(6)
      expect(review?.stopNote).toBeUndefined()
      expect(review?.recoverHint).toBeUndefined()
      expect(c.state().dirtyPaths).toHaveLength(0)
      expect(readLines(h.dir, c.canvasId).map((l) => l.type)).toContain('ReviewEscalated')
      // 升级轮可执行：GUI 链路回推后 agent run 的 review-request（R6 尚无报告条目 =
      // 同一轮重发）不再被 max-rounds 拦截，reviewer 可派发
      const agentRun = h.svc.mutate({ action: 'review-request', params: { canvasId: c.canvasId } }, 'agent', SID)
      expect(agentRun.ok).toBe(true)
      expect(c.state().review?.round).toBe(6)
      expect(c.state().review?.status).toBe('in-progress')
    } finally {
      h.dispose()
    }
  })

  it('升级后再达上限 → 可再次停回（升级裁决无预算上限——每次升级恰放行一轮，轮次上限是引擎参数，用户裁决优先）', () => {
    const h = makeService()
    try {
      const c = growCanvas(h.svc, createCanvas(h.svc))
      exhaustRounds(h.svc, c.canvasId, c.q1)
      expectOk(h.svc.mutate({ action: 'review-request', params: { canvasId: c.canvasId } }, 'agent', SID))
      expectOk(h.svc.mutate({ action: 'review-request', params: { canvasId: c.canvasId } }, 'user', SID))
      expect(c.state().review?.round).toBe(6)
      // R6 报告写回（轮次完成）后，再发起立即再停回
      expectOk(h.svc.mutate({
        action: 'review-append',
        params: { canvasId: c.canvasId, round: 6, entries: [{ id: 're-r6', round: 6, dimension: 'completeness', severity: 'must-fix', targetId: c.q1, note: 'R6 报告' }] },
      }, 'review', SID))
      expectOk(h.svc.mutate({ action: 'review-request', params: { canvasId: c.canvasId } }, 'user', SID))
      expect(c.state().review?.status).toBe('max-rounds')
      expect(c.state().review?.round).toBe(6)
    } finally {
      h.dispose()
    }
  })

  it('直写 ≡ 重放：max-rounds 停回 + 升级链经 events.jsonl 重建后 review 终态字段一致', () => {
    const h = makeService()
    try {
      const c = growCanvas(h.svc, createCanvas(h.svc))
      exhaustRounds(h.svc, c.canvasId, c.q1)
      expectOk(h.svc.mutate({ action: 'review-request', params: { canvasId: c.canvasId } }, 'agent', SID))
      expectOk(h.svc.mutate({ action: 'review-request', params: { canvasId: c.canvasId } }, 'user', SID))
      expectOk(h.svc.mutate({ action: 'review-request', params: { canvasId: c.canvasId } }, 'agent', SID))
      const directWrite = h.svc.readState(c.canvasId, SID)
      expect(directWrite.review?.status).toBe('in-progress')
      expect(directWrite.review?.round).toBe(6)
      expect(directWrite.review?.maxRounds).toBe(6)
      const reborn = new CanvasService({ dataDir: h.dir, generateId: (): string => 'replay-unused-id' })
      try {
        expect(reborn.readState(c.canvasId, SID)).toEqual(directWrite)
      } finally {
        reborn.dispose()
      }
    } finally {
      h.dispose()
    }
  })
})

describe('条目身份 = (round, id) 二元组（跨轮同 id 碰撞不覆盖历史条目——收敛门禁③不被旁路）', () => {
  /** R1 前置：must-fix 条目 rv-1 写回并处置（登记 resolution）→ 再发起推进 R2。 */
  function advanceToR2WithResolvedR1(
    h: ReturnType<typeof makeService>,
    canvasId: string,
    targetId: string,
  ): void {
    expectOk(h.svc.mutate({ action: 'review-request', params: { canvasId } }, 'agent', SID))
    expectOk(h.svc.mutate({
      action: 'review-append',
      params: { canvasId, round: 1, entries: [{ id: 'rv-1', round: 1, dimension: 'completeness', severity: 'must-fix', targetId, note: 'R1 缺口' }] },
    }, 'review', SID))
    expectOk(h.svc.mutate({ action: 'review-resolve', params: { canvasId, entryId: 'rv-1', disposition: 'accepted', note: '已修' } }, 'agent', SID))
    expectOk(h.svc.mutate({ action: 'review-request', params: { canvasId } }, 'agent', SID))
  }

  it('R2 写回与 R1 条目同 id（reviewer rv-<序号> 惯性）→ invalid_params（错误文案指引换 id）；R1 条目内容与处置记录原样保留，无部分写入', () => {
    const h = makeService()
    try {
      const c = growCanvas(h.svc, createCanvas(h.svc))
      advanceToR2WithResolvedR1(h, c.canvasId, c.q1)
      expect(c.state().review?.round).toBe(2)
      const reply = h.svc.mutate({
        action: 'review-append',
        params: { canvasId: c.canvasId, round: 2, entries: [{ id: 'rv-1', round: 2, dimension: 'support', severity: 'must-fix', targetId: c.q1, note: 'R2 新缺口' }] },
      }, 'review', SID)
      expectRejected(reply, 'invalid_params')
      if (!reply.ok) expect(reply.error.message).toContain('rv-1')
      // R1 条目不被覆盖：轮次 / 原文 / 分级 / 处置记录全部原样——R2 新 must-fix 不得
      // 未处置即继承已处置态（继承会让 must-fix 清零门禁被错误满足）
      const entries = c.state().review?.entries ?? []
      expect(entries).toHaveLength(1)
      expect(entries[0]?.round).toBe(1)
      expect(entries[0]?.note).toBe('R1 缺口')
      expect(entries[0]?.severity).toBe('must-fix')
      expect(entries[0]?.resolution).toEqual({ disposition: 'accepted', by: 'agent', note: '已修' })
    } finally {
      h.dispose()
    }
  })

  it('条目 round 与报告轮次不一致 → invalid_params（直连调用方伪造异轮 round 借同轮幂等语义改写历史条目的路径同拦——runtime 唯一防线）', () => {
    const h = makeService()
    try {
      const c = growCanvas(h.svc, createCanvas(h.svc))
      advanceToR2WithResolvedR1(h, c.canvasId, c.q1)
      // R2 批次夹带自称 R1 的条目（round 伪造成 1 = 与历史条目同 (round, id)）→ 拒绝
      const reply = h.svc.mutate({
        action: 'review-append',
        params: { canvasId: c.canvasId, round: 2, entries: [{ id: 'rv-1', round: 1, dimension: 'support', severity: 'must-fix', targetId: c.q1, note: '冒充 R1 改写' }] },
      }, 'review', SID)
      expectRejected(reply, 'invalid_params')
      const entries = c.state().review?.entries ?? []
      expect(entries).toHaveLength(1)
      expect(entries[0]?.note).toBe('R1 缺口')
      expect(entries[0]?.resolution).toEqual({ disposition: 'accepted', by: 'agent', note: '已修' })
    } finally {
      h.dispose()
    }
  })

  it('同批两条同 (round, id) 条目（异 note）→ invalid_params 整批不落盘；跨调用重试同 (round, id) 仍幂等覆盖（崩溃重试合法路径不受影响）', () => {
    const h = makeService()
    try {
      const c = growCanvas(h.svc, createCanvas(h.svc))
      expectOk(h.svc.mutate({ action: 'review-request', params: { canvasId: c.canvasId } }, 'agent', SID))
      // 同批两条同 id 条目（异 note）：last-wins upsert 会静默合并丢一条发现（可能为
      // must-fix），收敛门禁③按残缺条目集判定——必须 upfront 整批拒绝
      const reply = h.svc.mutate({
        action: 'review-append',
        params: {
          canvasId: c.canvasId,
          round: 1,
          entries: [
            { id: 'rv-1', round: 1, dimension: 'completeness', severity: 'must-fix', targetId: c.q1, note: '缺口 A' },
            { id: 'rv-1', round: 1, dimension: 'support', severity: 'suggestion', targetId: c.o1, note: '缺口 B' },
          ],
        },
      }, 'review', SID)
      expectRejected(reply, 'invalid_params')
      if (!reply.ok) expect(reply.error.message).toContain('rv-1')
      // 整批不落盘：两条均未落
      expect(c.state().review?.entries ?? []).toHaveLength(0)
      // 跨调用重试批与已落库条目同 (round, id) = 幂等 upsert（崩溃重试合法路径），不拦
      expectOk(h.svc.mutate({
        action: 'review-append',
        params: { canvasId: c.canvasId, round: 1, entries: [{ id: 'rv-1', round: 1, dimension: 'completeness', severity: 'must-fix', targetId: c.q1, note: '缺口 A 修订' }] },
      }, 'review', SID))
      expect(c.state().review?.entries).toHaveLength(1)
      expect(c.state().review?.entries[0]?.note).toBe('缺口 A 修订')
    } finally {
      h.dispose()
    }
  })

  it('直写 ≡ 重放：R1 与 R2 条目异 id 共存经 events.jsonl 重建后一致（跨轮条目累积是设计内形态）', () => {
    const h = makeService()
    try {
      const c = growCanvas(h.svc, createCanvas(h.svc))
      advanceToR2WithResolvedR1(h, c.canvasId, c.q1)
      expectOk(h.svc.mutate({
        action: 'review-append',
        params: { canvasId: c.canvasId, round: 2, entries: [{ id: 'rv-r2-1', round: 2, dimension: 'support', severity: 'must-fix', targetId: c.q1, note: 'R2 新缺口' }] },
      }, 'review', SID))
      const directWrite: CanvasState = h.svc.readState(c.canvasId, SID)
      expect(directWrite.review?.entries.map((e) => `${e.round}:${e.id}`)).toEqual(['1:rv-1', '2:rv-r2-1'])
      const reborn = new CanvasService({ dataDir: h.dir, generateId: (): string => 'replay-unused-id' })
      try {
        expect(reborn.readState(c.canvasId, SID)).toEqual(directWrite)
      } finally {
        reborn.dispose()
      }
    } finally {
      h.dispose()
    }
  })
})

describe('支撑度写回（概念 §2.4：边的缺陷经支撑度表达——review-append 附带评价）', () => {
  /** 标准形态：growCanvas 的边 id 确定性派生（e-<子节点 id>）；e-o1 = q1 →(resolve) o1 主干边。 */
  const TRUNK_EDGE = 'e-o1'

  function appendEntry(
    svc: CanvasService,
    canvasId: string,
    entry: Record<string, unknown>,
  ): ReturnType<CanvasService['mutate']> {
    return svc.mutate({
      action: 'review-append',
      params: { canvasId, round: 2, entries: [{ id: 're1', round: 2, dimension: 'support', severity: 'must-fix', targetId: TRUNK_EDGE, note: '悬空断言', ...entry }] },
    }, 'review', SID)
  }

  it('主干边 gap 评价（附清单）→ edge.support 落 rating/gaps/round（round 按报告轮次溯源）', () => {
    const h = makeService()
    try {
      const c = growCanvas(h.svc, createCanvas(h.svc))
      const reply = appendEntry(h.svc, c.canvasId, { supportRating: 'gap', supportGaps: ['缺性能基准论据', '缺迁移成本论据'] })
      expect(reply.ok).toBe(true)
      const edge = c.state().edges.find((e) => e.id === TRUNK_EDGE)
      expect(edge?.support).toEqual({ rating: 'gap', gaps: ['缺性能基准论据', '缺迁移成本论据'], round: 2 })
      // 报告条目留输入原文（评价结果在边上，条目承载过程——图与报告分界）
      expect(c.state().review?.entries[0]?.supportRating).toBe('gap')
    } finally {
      h.dispose()
    }
  })

  it('主干边 sufficient / invalid 评价（无清单）→ edge.support 落 rating + round', () => {
    const h = makeService()
    try {
      const c = growCanvas(h.svc, createCanvas(h.svc))
      expect(appendEntry(h.svc, c.canvasId, { id: 're1', supportRating: 'sufficient' }).ok).toBe(true)
      expect(c.state().edges.find((e) => e.id === TRUNK_EDGE)?.support).toEqual({ rating: 'sufficient', round: 2 })
      expect(appendEntry(h.svc, c.canvasId, { id: 're1', supportRating: 'invalid' }).ok).toBe(true)
      expect(c.state().edges.find((e) => e.id === TRUNK_EDGE)?.support).toEqual({ rating: 'invalid', round: 2 })
    } finally {
      h.dispose()
    }
  })

  it('非主干边携带评价 → invalid_params（论证边不评级——裁决点 R3）', () => {
    const h = makeService()
    try {
      const c = growCanvas(h.svc, createCanvas(h.svc))
      // argue 边：argument 节点 a1 → o1（边 id = e-a1）
      expectOk(h.svc.mutate({
        action: 'grow',
        params: { canvasId: c.canvasId, batch: [{ id: 'a1', type: 'argument', content: '成本主张', attachTo: c.o1, edge: 'argue', edgePolarity: 'object' }], reason: '补反论据' },
      }, 'agent', SID))
      expectRejected(appendEntry(h.svc, c.canvasId, { targetId: 'e-a1', supportRating: 'gap', supportGaps: ['g'] }), 'invalid_params')
    } finally {
      h.dispose()
    }
  })

  it('节点 id 携带评价 → invalid_params（支撑度只评价主干边）', () => {
    const h = makeService()
    try {
      const c = growCanvas(h.svc, createCanvas(h.svc))
      expectRejected(appendEntry(h.svc, c.canvasId, { targetId: c.q1, supportRating: 'sufficient' }), 'invalid_params')
    } finally {
      h.dispose()
    }
  })

  it('gap 未附清单 → invalid_params（「有缺口附清单」词条语义；重放 / WS 直连不经 marker 守卫，runtime 是唯一防线）', () => {
    const h = makeService()
    try {
      const c = growCanvas(h.svc, createCanvas(h.svc))
      expectRejected(appendEntry(h.svc, c.canvasId, { supportRating: 'gap' }), 'invalid_params')
      expectRejected(appendEntry(h.svc, c.canvasId, { supportRating: 'gap', supportGaps: [] }), 'invalid_params')
      // 拒绝 = 整批无部分写入（原子事务）：边与条目均未落
      expect(c.state().edges.find((e) => e.id === TRUNK_EDGE)?.support).toBeUndefined()
      expect(c.state().review?.entries ?? []).toHaveLength(0)
    } finally {
      h.dispose()
    }
  })

  it('sufficient / invalid 夹带清单 → invalid_params（契约守卫反向规则的 runtime 同款防线：WS 直连不经 marker 守卫）', () => {
    const h = makeService()
    try {
      const c = growCanvas(h.svc, createCanvas(h.svc))
      expectRejected(appendEntry(h.svc, c.canvasId, { supportRating: 'sufficient', supportGaps: ['多余清单'] }), 'invalid_params')
      expectRejected(appendEntry(h.svc, c.canvasId, { supportRating: 'invalid', supportGaps: ['多余清单'] }), 'invalid_params')
      // 拒绝 = 无写入：非 gap 评价不得把清单落上边
      expect(c.state().edges.find((e) => e.id === TRUNK_EDGE)?.support).toBeUndefined()
      expect(c.state().review?.entries ?? []).toHaveLength(0)
    } finally {
      h.dispose()
    }
  })

  it('不带评价的条目 → 边 support 不动（既有路径零回归）', () => {
    const h = makeService()
    try {
      const c = growCanvas(h.svc, createCanvas(h.svc))
      expect(appendEntry(h.svc, c.canvasId, {}).ok).toBe(true)
      expect(c.state().edges.find((e) => e.id === TRUNK_EDGE)?.support).toBeUndefined()
      expect(c.state().review?.entries).toHaveLength(1)
    } finally {
      h.dispose()
    }
  })

  it('直写 ≡ 重放：支撑度经 review-append 事件重放恢复（round 溯源保持）', () => {
    const h = makeService()
    try {
      const c = growCanvas(h.svc, createCanvas(h.svc))
      expect(appendEntry(h.svc, c.canvasId, { supportRating: 'gap', supportGaps: ['缺论据'] }).ok).toBe(true)
      const directWrite: CanvasState = h.svc.readState(c.canvasId, SID)
      const reborn = new CanvasService({ dataDir: h.dir, generateId: (): string => 'replay-unused-id' })
      try {
        const replayed = reborn.readState(c.canvasId, SID)
        expect(replayed.edges.find((e) => e.id === TRUNK_EDGE)?.support).toEqual({ rating: 'gap', gaps: ['缺论据'], round: 2 })
        expect(replayed).toEqual(directWrite)
      } finally {
        reborn.dispose()
      }
    } finally {
      h.dispose()
    }
  })
})
