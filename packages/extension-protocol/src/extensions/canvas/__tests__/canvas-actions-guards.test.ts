// canvas 契约守卫分派全量测试（problem-solve-canvas U1）。
//
// 覆盖语义：
// 1. isCanvasMarkerRequest 17 action 全量分派（MARKER_PARAMS_GUARDS 查表全键触达——
//    per-action 守卫经 marker 通道真实入口走一遍，schema.test.ts 的 valid 样例只覆盖
//    enter/create/list/read 四键）。
// 2. per-action 守卫的可选字段分支（patch 全可选字段在/缺省、select replace、
//    transition rejection、read subtree 词表内外）。
// 3. 支撑度子守卫语义锁（isReviewSupportShape / isReviewSupportSemantics 经
//    review-append 输入面：rating 词表 / gaps 类型 / 「有缺口附清单」组合规则）。
// 4. canvasError 恢复指引缺省回填（每码必有 recover——构造性保证的输入侧锁）。
import { describe, it, expect } from 'vitest'
import {
  isCanvasMarkerRequest,
  isCanvasPatchParams,
  isCanvasSelectParams,
  isCanvasTransitionParams,
  isCanvasExportParams,
  isCanvasReadParams,
  isCanvasEnterParams,
  isArgumentMateriality,
  isArgumentPolarity,
} from '../actions'
import { CANVAS_ERROR_CODES, CANVAS_ERROR_RECOVERY, canvasError } from '../errors'

const cv = 'cv-01'

/** 17 marker action 的合法请求样例（params 与 canvas-schema.test.ts 的 SSOT 样例同构）。 */
const allActionsValid: Array<[string, Record<string, unknown>]> = [
  ['create', { statement: 's', criterias: ['c'], scopeExclusions: ['x'] }],
  ['grow', { canvasId: cv, reason: 'MECE 分解', batch: [{ id: 'n1', type: 'question', content: 'q1', attachTo: 'root', edge: 'decompose' }] }],
  ['patch', { canvasId: cv, nodeId: 'n1', content: 'q1*', reason: '表述修正' }],
  ['decide-direction', { canvasId: cv, direction: 'top-down', reason: '目标清晰' }],
  ['select', { canvasId: cv, questionId: 'q1', optionId: 'o1', replace: { fromOptionId: 'o0' }, reason: '成本最优' }],
  ['transition', { canvasId: cv, nodeId: 'o2', to: 'rejected', rejection: { reason: '成本高', reviveCondition: '混合形态被否' }, reason: '审查否决' }],
  ['comment', { canvasId: cv, anchorId: 'o1', text: '会被挤占吗' }],
  ['comment-respond', { canvasId: cv, commentId: 'cm1', disposition: 'adopted', note: '补候选' }],
  ['review-request', { canvasId: cv, scope: 'o1 子树' }],
  ['review-append', { canvasId: cv, round: 1, entries: [{ id: 're1', round: 1, dimension: 'completeness', severity: 'must-fix', targetId: 'o2', note: '缺迁移' }] }],
  ['review-resolve', { canvasId: cv, entryId: 're1', disposition: 'accepted', note: '已补' }],
  ['converge-check', { canvasId: cv }],
  ['export', { canvasId: cv, target: { target: 'planning-doc' } }],
  ['dispatch', { canvasId: cv, nodeId: 'o1', pointer: 'docs/design/x.md' }],
  ['read', { canvasId: cv, subtree: 'n1' }],
  ['list', {}],
  ['enter', { canvasId: cv }],
]

describe('marker 分派全量（17 action 查表守卫）', () => {
  it('每个 marker action 携合法 params 通过 isCanvasMarkerRequest', () => {
    for (const [action, params] of allActionsValid) {
      expect(isCanvasMarkerRequest({ action, params }), `action=${action}`).toBe(true)
    }
  })

  it('per-action params 畸形逐键拒绝（分派到对应守卫后负分支收口）', () => {
    const malformed: Array<[string, Record<string, unknown>]> = [
      ['grow', { canvasId: cv, reason: 'r', batch: 'not-array' }],
      ['patch', { canvasId: cv, nodeId: 'n1', criterias: 'not-array', reason: 'r' }],
      ['decide-direction', { canvasId: cv, direction: 'sideways', reason: 'r' }],
      ['select', { canvasId: cv, questionId: 'q', optionId: 'o', replace: {}, reason: 'r' }],
      ['transition', { canvasId: cv, nodeId: 'n', to: 'rejected', rejection: { reviveCondition: 42 }, reason: 'r' }],
      ['comment', { canvasId: cv, anchorId: 'o1' }],
      ['comment-respond', { canvasId: cv, commentId: 'cm1', disposition: 'maybe', note: 'n' }],
      ['review-request', { canvasId: cv, scope: 42 }],
      ['review-resolve', { canvasId: cv, entryId: 're1', disposition: 'accepted' }],
      ['export', { canvasId: cv, target: 'planning-doc' }],
      ['dispatch', { canvasId: cv, nodeId: 'o1' }],
      ['read', { canvasId: cv, subtree: 42 }],
      ['enter', { canvasId: 42 }],
    ]
    for (const [action, params] of malformed) {
      expect(isCanvasMarkerRequest({ action, params }), `action=${action}`).toBe(false)
    }
  })
})

describe('per-action 守卫可选字段分支', () => {
  it('patch：全可选字段齐备通过；字段类型不符拒绝；全缺省（仅必填）通过', () => {
    expect(isCanvasPatchParams({ canvasId: cv, nodeId: 'n1', content: 'c', criterias: ['a'], dispatchable: true, factVerified: false, reason: 'r' })).toBe(true)
    expect(isCanvasPatchParams({ canvasId: cv, nodeId: 'n1', dispatchable: 1, reason: 'r' })).toBe(false)
    expect(isCanvasPatchParams({ canvasId: cv, nodeId: 'n1', factVerified: 'yes', reason: 'r' })).toBe(false)
    expect(isCanvasPatchParams({ canvasId: cv, nodeId: 'n1', reason: 'r' })).toBe(true)
  })

  it('select：replace 附 fromOptionId 通过；replace 非 Record 拒绝', () => {
    expect(isCanvasSelectParams({ canvasId: cv, questionId: 'q', optionId: 'o', replace: { fromOptionId: 'o0' }, reason: 'r' })).toBe(true)
    expect(isCanvasSelectParams({ canvasId: cv, questionId: 'q', optionId: 'o', replace: 'o0', reason: 'r' })).toBe(false)
  })

  it('transition：rejected 附完整否决记录（含复活条件）通过；reviveCondition 非串拒绝', () => {
    expect(isCanvasTransitionParams({ canvasId: cv, nodeId: 'n', to: 'rejected', rejection: { reason: '成本高', reviveCondition: '另案被否' }, reason: 'r' })).toBe(true)
    expect(isCanvasTransitionParams({ canvasId: cv, nodeId: 'n', to: 'rejected', rejection: { reason: '成本高' }, reason: 'r' })).toBe(true)
    expect(isCanvasTransitionParams({ canvasId: cv, nodeId: 'n', to: 'rejected', rejection: { reviveCondition: 42 }, reason: 'r' })).toBe(false)
  })

  it('export：requirement-card 带 leafId 通过；planning-doc 无需 leafId；target 非 Record 拒绝', () => {
    expect(isCanvasExportParams({ canvasId: cv, target: { target: 'requirement-card', leafId: 'o1' } })).toBe(true)
    expect(isCanvasExportParams({ canvasId: cv, target: { target: 'planning-doc' } })).toBe(true)
    expect(isCanvasExportParams({ canvasId: cv, target: { target: 'requirement-card' } })).toBe(false)
    expect(isCanvasExportParams({ canvasId: cv, target: 42 })).toBe(false)
  })

  it('read：subtree 可缺省；enter 封闭单键（缺键 / 多键 / 值非串均拒绝）', () => {
    expect(isCanvasReadParams({ canvasId: cv })).toBe(true)
    expect(isCanvasReadParams({ canvasId: cv, subtree: 'n1' })).toBe(true)
    expect(isCanvasEnterParams({})).toBe(false)
    expect(isCanvasEnterParams({ canvasId: cv, other: 1 })).toBe(false)
  })

  it('材料性 / 极性守卫：词表内收窄、词表外拒绝', () => {
    expect(isArgumentMateriality('fact')).toBe(true)
    expect(isArgumentMateriality('opinion')).toBe(false)
    expect(isArgumentPolarity('support')).toBe(true)
    expect(isArgumentPolarity('neutral')).toBe(false)
  })
})

describe('review-append 支撑度子守卫（shape × semantics 组合面）', () => {
  const entry = (over: Record<string, unknown>): unknown => ({
    id: 're1',
    round: 1,
    dimension: 'support',
    severity: 'must-fix',
    targetId: 'e-o1',
    note: '悬空断言',
    ...over,
  })
  const request = (entries: unknown[]): unknown => ({ action: 'review-append', params: { canvasId: cv, round: 1, entries } })

  it('rating 缺省 + gaps 缺省：通过（无评价的纯缺陷条目）', () => {
    expect(isCanvasMarkerRequest(request([entry({})]))).toBe(true)
  })

  it('gaps 为 null / 非数组：shape 拒绝（类型面）', () => {
    expect(isCanvasMarkerRequest(request([entry({ supportRating: 'gap', supportGaps: null })]))).toBe(false)
    expect(isCanvasMarkerRequest(request([entry({ supportRating: 'gap', supportGaps: '缺性能' })]))).toBe(false)
  })

  it('gaps 非空数组 + rating=gap：通过（「有缺口附清单」正例——多条清单）', () => {
    expect(isCanvasMarkerRequest(request([entry({ supportRating: 'gap', supportGaps: ['缺性能论据', '缺成本论据'] })]))).toBe(true)
  })
})

describe('canvasError 恢复指引缺省回填', () => {
  it('每码构造结果 recover 取词表模板（结构化错误 → 恢复动作闭环）', () => {
    for (const code of CANVAS_ERROR_CODES) {
      const err = canvasError(code, '测试消息')
      expect(err.recover).toBe(CANVAS_ERROR_RECOVERY[code])
      expect(err.recover.length).toBeGreaterThan(0)
    }
  })
})
