/**
 * review-contract.test.ts — plan 审阅回传值域契约测试（D3①⑤ / D9③ 边界谱）。
 *
 * 覆盖义务（U1 验收③ + 契约测试边界要求）：
 * - dismiss 样本必测（D3 主干——漏守即 F1 循环复活）。
 * - error envelope 三态判别（ok / unknown-decision / malformed）——降级双分源语义相反：
 *   未知 decision → 版本不匹配指引（不引导重挂）；malformed → 垃圾数据（E5，提示重挂）。
 * - boundary 帧：空载荷 / 非法形态 / 超限（selfReview 4KB 写侧单点截断，码点界安全）/
 *   未知 decision 值域降级——不只测 happy-path。
 */
import { describe, it, expect } from 'vitest'
import type { PlanReviewRequest, PlanReviewResponse } from '../../core/types'
import {
  PLAN_SELF_REVIEW_MAX_BYTES,
  isPlanReviewRequest,
  isPlanReviewResponse,
  parsePlanReviewResponse,
  truncateSelfReview,
} from './review-contract'

describe('编译期契约样本（判别联合加员可赋值）', () => {
  it('dismiss 样本（D3 加员）/ approve / revise 三员均可构造 PlanReviewResponse', () => {
    const dismiss: PlanReviewResponse = { decision: 'dismiss' }
    const approve: PlanReviewResponse = { decision: 'approve' }
    const revise: PlanReviewResponse = { decision: 'revise', comments: [{ quote: 'a', comment: 'b' }] }
    expect([dismiss, approve, revise].map((r) => r.decision)).toEqual(['dismiss', 'approve', 'revise'])
  })

  it('selfReview 在 request 上是 optional 兼容契约（旧形态无 / 新形态带）', () => {
    const legacy: PlanReviewRequest = { docs: [] }
    const current: PlanReviewRequest = { docs: [], selfReview: '已核对需求全覆盖' }
    expect(legacy.selfReview).toBeUndefined()
    expect(current.selfReview).toBe('已核对需求全覆盖')
  })
})

describe('dismiss 样本（D3 主干，必测）', () => {
  it('parse({ decision: dismiss }) → ok envelope，归一化回传', () => {
    const envelope = parsePlanReviewResponse({ decision: 'dismiss' })
    expect(envelope).toEqual({ ok: true, response: { decision: 'dismiss' } })
  })

  it('isPlanReviewResponse 对 dismiss 为 true（值域守卫含 dismiss 员）', () => {
    expect(isPlanReviewResponse({ decision: 'dismiss' })).toBe(true)
  })

  it('dismiss 不可混带评论（多余键剥除，结构上不可混带）', () => {
    const envelope = parsePlanReviewResponse({ decision: 'dismiss', comments: [{ quote: 'x', comment: 'y' }] })
    expect(envelope).toEqual({ ok: true, response: { decision: 'dismiss' } })
    if (envelope.ok) {
      expect('comments' in envelope.response).toBe(false)
    }
  })

  it('dismiss 样本经 respond 通道回传形态（JSON 字符串载体 parse 后同判——P-2 任意字符串载荷）', () => {
    const envelope = parsePlanReviewResponse(JSON.parse(JSON.stringify({ decision: 'dismiss' })) as unknown)
    expect(envelope).toEqual({ ok: true, response: { decision: 'dismiss' } })
  })
})

describe('error envelope 三态判别（降级双分源，D3①）', () => {
  it('未知 decision 值域降级：code=unknown-decision 且保留原值（版本不匹配指引，不引导重挂）', () => {
    for (const decision of ['shelve', 'DISMISS', 'hold', 'reject']) {
      const envelope = parsePlanReviewResponse({ decision })
      expect(envelope).toEqual({ ok: false, code: 'unknown-decision', decision })
      // 与 malformed 可判别分离——两类降级文案语义相反
      expect(envelope.ok === false && envelope.code).toBe('unknown-decision')
    }
  })

  it('malformed：空载荷 / 非对象 / 缺 decision / decision 非 string（E5 垃圾数据判据）', () => {
    const malformedInputs: unknown[] = [
      undefined,
      null,
      '',
      42,
      [],
      {},
      { decision: 3 },
      { decision: null },
      { decision: { name: 'dismiss' } },
    ]
    for (const input of malformedInputs) {
      expect(parsePlanReviewResponse(input)).toEqual({ ok: false, code: 'malformed' })
      expect(isPlanReviewResponse(input)).toBe(false)
    }
  })
})

describe('非法形态（形状不合法 → malformed，不 throw）', () => {
  it('revise 缺 comments / comments 非数组 / 元素形状不合法', () => {
    const badRevise: unknown[] = [
      { decision: 'revise' },
      { decision: 'revise', comments: 'not-an-array' },
      { decision: 'revise', comments: [{}] },
      { decision: 'revise', comments: [{ quote: 1, comment: 'x' }] },
      { decision: 'revise', comments: [{ quote: 'x' }] },
      { decision: 'revise', comments: [{ quote: 'x', comment: null }] },
      { decision: 'revise', comments: ['x'] },
    ]
    for (const input of badRevise) {
      expect(parsePlanReviewResponse(input)).toEqual({ ok: false, code: 'malformed' })
    }
  })

  it('revise 合法形态归一化（多余键剥除）', () => {
    const envelope = parsePlanReviewResponse({
      decision: 'revise',
      comments: [{ quote: '划选段落', comment: '补充权衡', evil: 'x' }],
      evil: true,
    })
    expect(envelope).toEqual({
      ok: true,
      response: { decision: 'revise', comments: [{ quote: '划选段落', comment: '补充权衡' }] },
    })
  })

  it('approve 合法形态归一化（不可混带评论）', () => {
    const envelope = parsePlanReviewResponse({ decision: 'approve', comments: [{ quote: 'x', comment: 'y' }] })
    expect(envelope).toEqual({ ok: true, response: { decision: 'approve' } })
    expect(isPlanReviewResponse({ decision: 'approve' })).toBe(true)
  })
})

describe('超限：selfReview 4KB 写侧单点截断（D9③ / R3）', () => {
  it('上限契约值 = 4096 字节', () => {
    expect(PLAN_SELF_REVIEW_MAX_BYTES).toBe(4096)
  })

  it('预算内原样返回（含恰好等于上限的边界格）', () => {
    expect(truncateSelfReview('')).toBe('')
    const exact = 'a'.repeat(PLAN_SELF_REVIEW_MAX_BYTES)
    expect(truncateSelfReview(exact)).toBe(exact)
    expect(truncateSelfReview('短文本')).toBe('短文本')
  })

  it('超限截断到 ≤4096 字节且不多截（前缀保真）', () => {
    const over = 'x'.repeat(PLAN_SELF_REVIEW_MAX_BYTES + 100)
    const truncated = truncateSelfReview(over)
    expect(truncated.length).toBe(PLAN_SELF_REVIEW_MAX_BYTES)
    expect(over.startsWith(truncated)).toBe(true)
  })

  it('多字节安全：CJK / emoji 不截半个码点（decode 无替换字符）', () => {
    const cjk = '审'.repeat(2000) // 3 字节 × 2000 = 6000 字节
    const truncated = truncateSelfReview(cjk)
    expect([...truncated].length * 3).toBeLessThanOrEqual(PLAN_SELF_REVIEW_MAX_BYTES)
    expect([...truncated].length).toBe(1365) // floor(4096 / 3) 个完整码点
    const emoji = '🙂'.repeat(2000) // 4 字节 × 2000
    const emojiTruncated = truncateSelfReview(emoji)
    expect([...emojiTruncated].length * 4).toBeLessThanOrEqual(PLAN_SELF_REVIEW_MAX_BYTES)
    expect(emojiTruncated.includes('\ufffd')).toBe(false)
  })

  it('request 守卫不二次截断（有界性由写侧单点保证）：超长 selfReview 帧通过守卫', () => {
    const request = { docs: [], selfReview: 'y'.repeat(PLAN_SELF_REVIEW_MAX_BYTES + 1) }
    expect(isPlanReviewRequest(request)).toBe(true)
    // 写侧接线后帧内值恒为截断产物——契约等价式：truncate 幂等且有界
    const once = truncateSelfReview(request.selfReview)
    expect(truncateSelfReview(once)).toBe(once)
    expect(once.length).toBe(PLAN_SELF_REVIEW_MAX_BYTES)
  })
})

describe('boundary 帧：PlanReviewRequest 入站守卫（空载荷 / 非法形态）', () => {
  it('合法形态：docs 逐项形状 + selfReview 可选', () => {
    const request = {
      docs: [{ fileName: 'plan.md', absPath: '/tmp/plans/auth/plan.md', sourceSkill: 'tech-design', version: 2 }],
      selfReview: '已核对 3 条需求全覆盖',
    }
    expect(isPlanReviewRequest(request)).toBe(true)
    expect(isPlanReviewRequest({ docs: [] })).toBe(true)
  })

  it('空载荷：undefined / null / 非对象 / 缺 docs', () => {
    for (const input of [undefined, null, '', 7, [], {}, { docs: undefined }]) {
      expect(isPlanReviewRequest(input)).toBe(false)
    }
  })

  it('非法形态：docs 非数组 / 元素形状不合法 / selfReview 非 string', () => {
    const bad: unknown[] = [
      { docs: 'not-array' },
      { docs: [{}] },
      { docs: [{ fileName: 'a', absPath: 'b', sourceSkill: 'c', version: '1' }] },
      { docs: [{ fileName: 'a', absPath: 'b', sourceSkill: 'c' }] },
      { docs: [null] },
      { docs: [], selfReview: 42 },
      { docs: [], selfReview: { text: 'x' } },
    ]
    for (const input of bad) {
      expect(isPlanReviewRequest(input)).toBe(false)
    }
  })
})
