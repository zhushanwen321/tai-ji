/**
 * 状态机穷举（problem-solve-canvas U2 验收条款；判定权威 = canvasLifecycleMachine）。
 *
 * 权威 = 概念文档 §2.4：生命周期维度 5 态 × 5 态全组合穷举（含自转移与逆行）+
 * 根节点豁免（根不可搁置 / 否决）+ 派发维度正交性。
 * 合法转移 7 条：draft→under-review / draft→shelved / under-review→passed /
 * under-review→rejected / under-review→shelved / rejected→draft / shelved→draft。
 */
import { describe, expect, it } from 'vitest'
import type { CanvasNodeLifecycle } from '@zhushanwen/extension-protocol'
import { generateTableTests } from '@zhushanwen/state-machine/testing'
import { canvasLifecycleMachine, isCanvasDomainError } from '../canvas-domain.js'
import type { CanvasService } from '../canvas-service.js'
import { createCanvas, growCanvas, makeService, SID, SID_B } from './canvas-helpers.js'

const ALL_LIFECYCLES: readonly CanvasNodeLifecycle[] = ['draft', 'under-review', 'passed', 'rejected', 'shelved']

const LEGAL: ReadonlyArray<readonly [CanvasNodeLifecycle, CanvasNodeLifecycle]> = [
  ['draft', 'under-review'],
  ['draft', 'shelved'],
  ['under-review', 'passed'],
  ['under-review', 'rejected'],
  ['under-review', 'shelved'],
  ['rejected', 'draft'],
  ['shelved', 'draft'],
]

/**
 * 合法边查询（期望源 = 机器声明的表行静态派生，独立于 transition 判定路径——
 * 两侧不同源，穷举对拍才设防）。
 */
function isLegalTransition(from: CanvasNodeLifecycle, to: CanvasNodeLifecycle): boolean {
  return canvasLifecycleMachine.definition.transitions.some((row) => {
    const froms = Array.isArray(row.from) ? row.from : [row.from]
    return froms.includes(from) && row.to === to
  })
}

interface Scenario { // oe-exempt:20261015:framework:画布域类型契约（数据形状/端口/测试 harness，非抽象接口单实现）
  canvasId: string
  nodeIdByLifecycle: Map<CanvasNodeLifecycle, string>
}

/** 构造画布并把 5 个节点分别推进到 5 个生命周期态（穷举各 from 态的出发前置）。 */
function buildScenario(svc: CanvasService): Scenario {
  const c = growCanvas(svc, createCanvas(svc), { o1Dispatchable: true })
  const byLifecycle = new Map<CanvasNodeLifecycle, string>()
  byLifecycle.set('draft', c.o1)
  expect(svc.mutate({ action: 'patch', params: { canvasId: c.canvasId, nodeId: c.o2, criterias: ['c'], reason: '补判据' } }, 'user', SID).ok).toBe(true)
  expect(svc.mutate({ action: 'transition', params: { canvasId: c.canvasId, nodeId: c.o2, to: 'under-review', reason: '提案' } }, 'agent', SID).ok).toBe(true)
  byLifecycle.set('under-review', c.o2)
  expect(svc.mutate({ action: 'transition', params: { canvasId: c.canvasId, nodeId: c.q1, to: 'under-review', reason: '提案' } }, 'agent', SID).ok).toBe(true)
  expect(svc.mutate({ action: 'transition', params: { canvasId: c.canvasId, nodeId: c.q1, to: 'passed', reason: '过审' } }, 'user', SID).ok).toBe(true)
  byLifecycle.set('passed', c.q1)
  expect(svc.mutate({ action: 'grow', params: { canvasId: c.canvasId, batch: [
    { id: 'q-rej', type: 'question', content: '待否决', attachTo: c.rootId, edge: 'decompose' },
    { id: 'q-shl', type: 'question', content: '待搁置', attachTo: c.rootId, edge: 'decompose' },
  ], reason: '状态机场景' } }, 'agent', SID).ok).toBe(true)
  expect(svc.mutate({ action: 'transition', params: { canvasId: c.canvasId, nodeId: 'q-rej', to: 'under-review', reason: '提案' } }, 'agent', SID).ok).toBe(true)
  expect(svc.mutate({ action: 'transition', params: { canvasId: c.canvasId, nodeId: 'q-rej', to: 'rejected', rejection: { reason: '否决理由' }, reason: '否决' } }, 'user', SID).ok).toBe(true)
  byLifecycle.set('rejected', 'q-rej')
  expect(svc.mutate({ action: 'transition', params: { canvasId: c.canvasId, nodeId: 'q-shl', to: 'shelved', reason: '暂缓' } }, 'user', SID).ok).toBe(true)
  byLifecycle.set('shelved', 'q-shl')
  return { canvasId: c.canvasId, nodeIdByLifecycle: byLifecycle }
}

describe('机器声明（canvasLifecycleMachine）与合法集合一致', () => {
  it('表内恰 7 条合法转移，表外全部禁止（含 5 条自转移）', () => {
    const legalPairs = new Set(LEGAL.map(([f, t]) => `${f}->${t}`))
    let legalCount = 0
    for (const from of ALL_LIFECYCLES) {
      for (const to of ALL_LIFECYCLES) {
        const allowed = isLegalTransition(from, to)
        expect(allowed).toBe(legalPairs.has(`${from}->${to}`))
        if (allowed) legalCount += 1
      }
    }
    expect(legalCount).toBe(7)
    // 词表形状完整：5 态全在状态词表；passed 是唯一终态（无出边吸收）
    expect([...canvasLifecycleMachine.states].sort()).toEqual([...ALL_LIFECYCLES].sort())
    expect(canvasLifecycleMachine.terminalStates).toEqual(['passed'])
  })

  it('表外转移抛既有 CanvasDomainError（类型保形：isCanvasDomainError 命中 + 错误码 + recover 指引）', () => {
    let caught: unknown
    try {
      canvasLifecycleMachine.transition('rejected', 'passed')
    } catch (e) {
      caught = e
    }
    expect(isCanvasDomainError(caught), 'errorFactory 须构造 CanvasDomainError 实例（消费方 instanceof 分类依赖）').toBe(true)
    if (isCanvasDomainError(caught)) {
      expect(caught.detail.code).toBe('lifecycle_transition_illegal')
      expect(caught.detail.recover.length).toBeGreaterThan(0)
      expect(caught.detail.message).toContain('rejected')
      expect(caught.detail.message).toContain('passed')
    }
  })
})

// 基建穷举生成组（@zhushanwen/state-machine/testing）——5 态 × 5 事件全组合：
// 7 组合断言次态、18 组合断言表外 throw（含 passed 终态吸收）。
generateTableTests(canvasLifecycleMachine)

describe('经 mutate 的行为级穷举（25 组合全表，每组合独立画布）', () => {
  it('合法 7 条转移成功，落地 lifecycle 与 StateTransitioned 事件', () => {
    for (const [from, to] of LEGAL) {
      const h = makeService()
      try {
        const s = buildScenario(h.svc)
        const id = s.nodeIdByLifecycle.get(from) as string
        const reply = h.svc.mutate({
          action: 'transition',
          params: {
            canvasId: s.canvasId,
            nodeId: id,
            to,
            // 否决记录是 to='rejected' 的强制前置（契约与领域校验）——穷举该转移时补上
            rejection: to === 'rejected' ? { reason: `穷举否决 ${from}→${to}` } : undefined,
            reason: `穷举 ${from}→${to}`,
          },
        }, 'user', SID)
        expect(reply.ok, `${from}→${to} 应合法`).toBe(true)
        if (reply.ok) expect(reply.evType).toBe('StateTransitioned')
        const node = h.svc.readState(s.canvasId, SID).nodes.find((n) => n.id === id)
        expect(node?.lifecycle).toBe(to)
      } finally {
        h.dispose()
      }
    }
  })

  it('非法 18 条组合（含 5 条自转移）全部 lifecycle_transition_illegal 且带恢复动作', () => {
    for (const from of ALL_LIFECYCLES) {
      for (const to of ALL_LIFECYCLES) {
        if (isLegalTransition(from, to)) continue
        const h = makeService()
        try {
          const s = buildScenario(h.svc)
          const id = s.nodeIdByLifecycle.get(from) as string
          const reply = h.svc.mutate({ action: 'transition', params: { canvasId: s.canvasId, nodeId: id, to, reason: `穷举非法 ${from}→${to}` } }, 'user', SID)
          expect(reply.ok, `${from}→${to} 应非法`).toBe(false)
          if (!reply.ok) {
            expect(reply.error.code).toBe('lifecycle_transition_illegal')
            expect(reply.error.recover.length).toBeGreaterThan(0)
          }
        } finally {
          h.dispose()
        }
      }
    }
  })

  it('根节点豁免：根不可转 shelved / rejected（根豁免先于转移表）', () => {
    const h = makeService()
    try {
      const c = createCanvas(h.svc)
      for (const to of ['shelved', 'rejected'] as const) {
        const reply = h.svc.mutate({ action: 'transition', params: { canvasId: c.canvasId, nodeId: c.rootId, to, reason: '根搁置尝试' } }, 'user', SID)
        expect(reply.ok, `根→${to} 应被根豁免拦截`).toBe(false)
        if (!reply.ok) expect(reply.error.code).toBe('lifecycle_transition_illegal')
      }
      // 根可走表内合法路径：draft → under-review
      expect(h.svc.mutate({ action: 'transition', params: { canvasId: c.canvasId, nodeId: c.rootId, to: 'under-review', reason: '根提案' } }, 'agent', SID).ok).toBe(true)
    } finally {
      h.dispose()
    }
  })

  it('派发维度正交：dispatch 不改 lifecycle；dispatched 后 patch 无门槛（D8）', () => {
    const h = makeService()
    try {
      const c = growCanvas(h.svc, createCanvas(h.svc), { o1Dispatchable: true })
      expect(h.svc.mutate({ action: 'patch', params: { canvasId: c.canvasId, nodeId: c.o1, criterias: ['c'], reason: '判据' } }, 'user', SID).ok).toBe(true)
      expect(h.svc.mutate({ action: 'transition', params: { canvasId: c.canvasId, nodeId: c.o1, to: 'under-review', reason: '提案' } }, 'agent', SID).ok).toBe(true)
      expect(h.svc.mutate({ action: 'transition', params: { canvasId: c.canvasId, nodeId: c.o1, to: 'passed', reason: '过审' } }, 'user', SID).ok).toBe(true)
      expect(h.svc.mutate({ action: 'dispatch', params: { canvasId: c.canvasId, nodeId: c.o1, pointer: 'p1' } }, 'user', SID).ok).toBe(true)
      let node = h.svc.readState(c.canvasId, SID).nodes.find((n) => n.id === c.o1)
      expect(node?.lifecycle).toBe('passed')
      expect(node?.dispatch?.pointer).toBe('p1')
      expect(h.svc.mutate({ action: 'patch', params: { canvasId: c.canvasId, nodeId: c.o1, content: '修订', reason: '派发后修订' } }, 'user', SID).ok).toBe(true)
      node = h.svc.readState(c.canvasId, SID).nodes.find((n) => n.id === c.o1)
      expect(node?.dispatch?.pointer).toBe('p1')
      expect(node?.lifecycle).toBe('passed')
    } finally {
      h.dispose()
    }
  })
})
