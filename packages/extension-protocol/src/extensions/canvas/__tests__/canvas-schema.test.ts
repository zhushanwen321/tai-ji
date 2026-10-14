import { describe, it, expect } from 'vitest'
import { CANVAS_MARKER, CANVAS_ACTIONS, CANVAS_MARKER_ACTIONS } from '../marker'
import { isCanvasMarkerRequest } from '../actions'
import type {
  CanvasMarkerRequest,
  CanvasMutateRequest,
  CanvasMutateReply,
  CanvasListReply,
} from '../actions'
import type {
  CanvasState,
  CanvasListEntry,
  ReviewReport,
  CanvasEventType,
} from '../state'
import { ACTION_EVENT_MAP, CANVAS_EVENT_TYPES } from '../state'
import { CANVAS_ERROR_CODES, CANVAS_ERROR_RECOVERY } from '../errors'

/**
 * U1 契约验收 ①：schema 往返。
 *
 * 形状即契约：extension / runtime / renderer 三侧按此序列化（wire JSON 与
 * canvas.json 落盘共用形状）——本组测试锁定「可实例化 + JSON 往返无损」；
 * 时间字段一律 ISO string（无 Date），往返全等是构造性要求。
 */
describe('U1 schema 往返：CanvasState 全量快照', () => {
  /** 全字段实例（覆盖每个 per-type 可选字段——schema 完备性锚）。 */
  const fullState: CanvasState = {
    canvasId: 'cv-01',
    name: '多引擎支持怎么落地',
    root: {
      nodeId: 'n-root',
      statement: 'taiji 多引擎支持怎么落地',
      criterias: ['每个执行叶子可独立进入 tech-design-wf T1'],
      scopeExclusions: ['引擎运行时稳定性问题'],
      confirmed: true,
    },
    direction: { direction: 'top-down', reason: '目标清晰', decidedAt: '2026-10-14T00:00:00.000Z' },
    nodes: [
      {
        id: 'n-root',
        type: 'question',
        content: '根问题',
        lifecycle: 'under-review',
        createdAt: '2026-10-14T00:00:00.000Z',
      },
      {
        id: 'o1',
        type: 'option',
        content: '混合形态',
        lifecycle: 'passed',
        selected: true,
        selectionReason: '长期成本最优',
        dispatchable: true,
        criterias: ['需求卡可导出'],
        dispatch: { pointer: 'docs/design/xxx.md', dispatchedAt: '2026-10-14T01:00:00.000Z' },
        createdAt: '2026-10-14T00:10:00.000Z',
      },
      {
        id: 'o2',
        type: 'option',
        content: '单引擎扩展',
        lifecycle: 'rejected',
        rejection: { reason: '成本高', reviveCondition: '混合形态被否决时' },
        createdAt: '2026-10-14T00:11:00.000Z',
      },
      {
        id: 'a1',
        type: 'argument',
        content: '已有两引擎并存先例',
        lifecycle: 'passed',
        polarity: 'support',
        materiality: 'fact',
        factVerified: true,
        createdAt: '2026-10-14T00:12:00.000Z',
      },
      {
        id: 'c1',
        type: 'constraint',
        content: '不引入原生模块',
        lifecycle: 'draft',
        createdAt: '2026-10-14T00:13:00.000Z',
      },
    ],
    edges: [
      { id: 'e1', type: 'decompose', from: 'n-root', to: 'o1' },
      {
        id: 'e2',
        type: 'resolve',
        from: 'n-root',
        to: 'o2',
        support: { rating: 'gap', gaps: ['缺迁移方案'], round: 1 },
      },
      { id: 'e3', type: 'argue', from: 'a1', to: 'e1', polarity: 'support' },
    ],
    comments: [
      {
        id: 'cm1',
        anchorId: 'o1',
        text: '独立窗口会被挤占吗',
        status: 'responded',
        response: { disposition: 'adopted', note: '补浮层形态候选' },
        createdAt: '2026-10-14T00:20:00.000Z',
      },
    ],
    dirtyPaths: ['o1', 'n-root'],
    review: null,
    converged: false,
    createdAt: '2026-10-14T00:00:00.000Z',
    updatedAt: '2026-10-14T01:00:00.000Z',
  }

  it('U1 全字段 CanvasState 可实例化且 JSON 往返无损', () => {
    const round = JSON.parse(JSON.stringify(fullState)) as CanvasState
    expect(round).toEqual(fullState)
  })

  it('U1 review 聚合（ReviewReport 全字段）可实例化且 JSON 往返无损', () => {
    const report: ReviewReport = {
      status: 'max-rounds',
      round: 3,
      maxRounds: 3,
      entries: [
        {
          id: 're1',
          round: 1,
          dimension: 'completeness',
          severity: 'must-fix',
          targetId: 'o2',
          note: '缺迁移方案',
          resolution: { disposition: 'accepted', by: 'agent', note: '已补 patch' },
        },
        {
          id: 're2',
          round: 1,
          dimension: 'depth',
          severity: 'suggestion',
          targetId: 'e1',
          note: '分支过浅',
        },
      ],
      stopNote: '连续两轮未清零',
      recoverHint: '扩大审查范围或修改判据后重新发起',
    }
    expect(JSON.parse(JSON.stringify(report))).toEqual(report)
  })

  it('U1 canvas.list 条目（阶段徽标派生输入三字段齐备）且 JSON 往返无损', () => {
    const entry: CanvasListEntry = {
      canvasId: 'cv-01',
      name: '多引擎支持',
      statement: '怎么落地',
      converged: false,
      openMustFix: 2,
      reviewStatus: 'in-progress',
    }
    const reply: CanvasListReply = { canvases: [entry] }
    expect(JSON.parse(JSON.stringify(reply))).toEqual(reply)
  })
})

describe('U1 schema 往返：mutate 两态信封与事件回执', () => {
  it('U1 成功腿（事件回执）evType 取自领域事件词表且 JSON 往返无损', () => {
    const ok: CanvasMutateReply = {
      ok: true,
      eventId: 'ev-1',
      evType: 'OptionSelected',
      summary: '选定混合形态，理由留痕',
    }
    expect(CANVAS_EVENT_TYPES).toContain(ok.evType)
    expect(JSON.parse(JSON.stringify(ok))).toEqual(ok)
  })

  it('U1 失败腿（结构化错误）每码附恢复指引且 JSON 往返无损', () => {
    const fail: CanvasMutateReply = {
      ok: false,
      error: {
        code: 'selection_conflict',
        message: '该问题已有选定方案',
        recover: CANVAS_ERROR_RECOVERY.selection_conflict,
      },
    }
    expect(fail.ok).toBe(false)
    expect(JSON.parse(JSON.stringify(fail))).toEqual(fail)
  })

  it('U1 错误码词表与恢复文案表键集全等、文案非空（每码一句恢复指引）', () => {
    expect(Object.keys(CANVAS_ERROR_RECOVERY).sort()).toEqual([...CANVAS_ERROR_CODES].sort())
    for (const code of CANVAS_ERROR_CODES) {
      expect(CANVAS_ERROR_RECOVERY[code].length).toBeGreaterThan(0)
    }
  })

  it('U1 广播 payload 形状四字段齐备（canvasId/evType/eventId/summary）', () => {
    // shared ServerMessageMapBase['canvas.updated'] 的形状引用（shared type-only 直引
    // 本包导出——此处按同构字面量锁定词表消费面；形状 SSOT 漂移由 shared 侧 tsc 红）
    const broadcast: { canvasId: string; evType: CanvasEventType; eventId: string; summary: string } = {
      canvasId: 'cv-01',
      evType: 'CanvasCreated',
      eventId: 'ev-0',
      summary: '画布已创建',
    }
    expect(Object.keys(broadcast).sort()).toEqual(['canvasId', 'evType', 'eventId', 'summary'])
  })
})

describe('U1 schema 往返：mutate 请求判别联合（16 action 全量构造）', () => {
  /** 16 action 的合法请求样例（params SSOT 每成员至少一条可实例化路径）。 */
  const requests: CanvasMutateRequest[] = [
    { action: 'create', params: { statement: 's', criterias: ['c'], scopeExclusions: ['x'] } },
    {
      action: 'grow',
      params: {
        canvasId: 'cv',
        reason: 'MECE 分解',
        batch: [{ id: 'n1', type: 'question', content: 'q1', attachTo: 'n-root', edge: 'decompose' }],
      },
    },
    { action: 'patch', params: { canvasId: 'cv', nodeId: 'n1', content: 'q1*', reason: '表述修正' } },
    { action: 'decide-direction', params: { canvasId: 'cv', direction: 'top-down', reason: '目标清晰' } },
    {
      action: 'select',
      params: { canvasId: 'cv', questionId: 'q1', optionId: 'o1', replace: { fromOptionId: 'o0' }, reason: '成本最优' },
    },
    {
      action: 'transition',
      params: { canvasId: 'cv', nodeId: 'o2', to: 'rejected', rejection: { reason: '成本高' }, reason: '审查否决' },
    },
    { action: 'comment', params: { canvasId: 'cv', anchorId: 'o1', text: '会被挤占吗' } },
    {
      action: 'comment-respond',
      params: { canvasId: 'cv', commentId: 'cm1', disposition: 'adopted', note: '补候选' },
    },
    { action: 'review-request', params: { canvasId: 'cv' } },
    {
      action: 'review-append',
      params: {
        canvasId: 'cv',
        round: 1,
        entries: [{ id: 're1', round: 1, dimension: 'completeness', severity: 'must-fix', targetId: 'o2', note: '缺迁移' }],
      },
    },
    { action: 'review-resolve', params: { canvasId: 'cv', entryId: 're1', disposition: 'accepted', note: '已补' } },
    { action: 'converge-check', params: { canvasId: 'cv' } },
    { action: 'export', params: { canvasId: 'cv', target: { target: 'planning-doc' } } },
    { action: 'export', params: { canvasId: 'cv', target: { target: 'requirement-card', leafId: 'o1' } } },
    { action: 'dispatch', params: { canvasId: 'cv', nodeId: 'o1', pointer: 'docs/design/x.md' } },
    { action: 'read', params: { canvasId: 'cv' } },
    { action: 'list', params: {} },
  ]

  it('U1 CANVAS_MARKER 精确值 NUL 前缀且与既有 marker 不冲突', () => {
    expect(CANVAS_MARKER).toBe('\x00TAIJI_CANVAS')
    expect(CANVAS_MARKER.charCodeAt(0)).toBe(0)
  })

  it('U1 marker 词表 = 16 mutate action + enter（17 值）', () => {
    expect(CANVAS_MARKER_ACTIONS).toHaveLength(17)
    expect(CANVAS_MARKER_ACTIONS.filter((a) => a !== 'enter')).toHaveLength(16)
  })

  it('U1 16 个 action 的判别联合请求全部可实例化（params 不含 action 字段）', () => {
    const actions = new Set(requests.map((r) => r.action))
    expect(actions.size).toBe(CANVAS_ACTIONS.length)
    for (const req of requests) {
      expect(req.params).not.toHaveProperty('action')
    }
  })

  it('U1 每个请求 JSON 往返无损（wire 序列化契约）', () => {
    for (const req of requests) {
      expect(JSON.parse(JSON.stringify(req))).toEqual(req)
    }
  })
})

describe('U1 运行时守卫：marker 请求信任边界', () => {
  const valid: CanvasMarkerRequest[] = [
    { action: 'enter', params: { canvasId: 'cv' } },
    { action: 'create', params: { statement: 's', criterias: ['c'], scopeExclusions: ['x'] } },
    { action: 'list', params: {} },
    { action: 'read', params: { canvasId: 'cv', subtree: 'n1' } },
  ]

  it('U1 合法 marker 请求（含 enter）通过守卫', () => {
    for (const req of valid) expect(isCanvasMarkerRequest(req)).toBe(true)
  })

  it('U1 畸形请求全部拒绝（非对象 / 数组 / 词表外 action / 缺必填 / enter 夹带第二键）', () => {
    const malformed: unknown[] = [
      null,
      42,
      'create',
      [],
      { action: 'nope', params: {} },
      { action: 'create', params: { criterias: ['c'], scopeExclusions: [] } }, // 缺 statement
      { action: 'create', params: { statement: 's', criterias: 'c', scopeExclusions: [] } }, // criterias 非数组
      { action: 'grow', params: { canvasId: 'cv', reason: 'r', batch: [{ type: 'question' }] } }, // 条目缺 id/content/attachTo/edge
      { action: 'select', params: { canvasId: 'cv', questionId: 'q', optionId: 'o' } }, // 缺 reason
      { action: 'transition', params: { canvasId: 'cv', nodeId: 'n', to: 'done', reason: 'r' } }, // to 词表外
      { action: 'enter', params: { canvasId: 'cv', extra: 1 } }, // enter 封闭单键
      { action: 'export', params: { canvasId: 'cv', target: { target: 'requirement-card' } } }, // 缺 leafId
    ]
    for (const m of malformed) expect(isCanvasMarkerRequest(m)).toBe(false)
  })
})
