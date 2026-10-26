import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { convergenceBlockers, dispatchableLeaves, findTrunkCycle, isQuestionReady, isRootReady, pathToRoot, subtreeOf, canvasLifecycleMachine, isCanvasDomainError } from '../canvas-domain.js'
import { renderPlanningDoc } from '../canvas-export.js'
import { CanvasService, unbindCanvasOnSessionDeleted, CANVAS_SNAPSHOT_INTERVAL } from '../canvas-service.js'
import { createCanvas, expectRejected, expectThrown, growCanvas, makeService, buildAllGreenCanvas, ServiceHandle, SID, SID_B, expectOk, runActionHappyPath, makeTmpCanvasDir, removeDir, buildConvergedCanvas } from './canvas-helpers.js'
import { getSessionCanvasesDir } from '@taiji/shared/paths'
import { ACTION_EVENT_MAP, CANVAS_ACTIONS, CANVAS_ACTOR_MATRIX, canvasError, type CanvasAction, type CanvasActor, type CanvasMutateReply, type CanvasState, type CanvasNodeLifecycle } from '@zhushanwen/extension-protocol'
import { generateTableTests } from '@zhushanwen/state-machine/testing'
import { readdirSync, existsSync, readFileSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'


/**
 * 本文件另为 canvas 域合并载体（cluster：mutate-matrix / ownership / persistence /
 * review-loop / state-machine 五文件折叠为分节，各节以基名 describe 包裹）。
 */
/**
 * 不变量 1-11 逐条正逆用例（problem-solve-canvas U2 验收条款）。
 *
 * 不变量权威 = 概念文档（.tmp/problem-solve-canvas.md）§2.5 聚合 1（画布）不变量清单；
 * 聚合 2（审查报告）不变量并入 review-append / review-resolve 用例。
 * MVP 边界：constrain / reference 边不在词表（不变量 6 退化为构造性满足，见对应用例）。
 */

describe('不变量 1：有且仅有一个根节点，类型 question，带完成判据与范围排除', () => {
  it('正例：create 后根三要素可见（用户可见断言：canvas.get 视图含 statement/criterias/scopeExclusions）', () => {
    const h: ServiceHandle = makeService()
    try {
      const c = createCanvas(h.svc, 'agent', '如何规划多引擎支持')
      const state = c.state()
      expect(state.root.statement).toBe('如何规划多引擎支持')
      expect(state.root.criterias.length).toBeGreaterThan(0)
      expect(state.root.scopeExclusions.length).toBeGreaterThan(0)
      const root = state.nodes.find((n) => n.id === state.root.nodeId)
      expect(root?.type).toBe('question')
      // 唯一根：root nodeId 精确命中一个节点
      expect(state.nodes.filter((n) => n.id === state.root.nodeId)).toHaveLength(1)
    } finally {
      h.dispose()
    }
  })

  it('逆例：完成判据为空数组 → create 拒绝（invalid_params）', () => {
    const h = makeService()
    try {
      const reply = h.svc.mutate({ action: 'create', params: { statement: 'X', criterias: [], scopeExclusions: [] } }, 'agent', SID)
      expectRejected(reply, 'invalid_params')
    } finally {
      h.dispose()
    }
  })

  it('逆例：statement 为空白 → create 拒绝', () => {
    const h = makeService()
    try {
      const reply = h.svc.mutate({ action: 'create', params: { statement: '   ', criterias: ['c'], scopeExclusions: [] } }, 'agent', SID)
      expectRejected(reply, 'invalid_params')
    } finally {
      h.dispose()
    }
  })
})

describe('不变量 2：主干图（decompose + resolve）无环', () => {
  it('正例：链式分解 root→q1→q2 成功且 isRootReady 可递归', () => {
    const h = makeService()
    try {
      const c = createCanvas(h.svc)
      const grow = h.svc.mutate({
        action: 'grow',
        params: {
          canvasId: c.canvasId,
          batch: [
            { id: 'q1', type: 'question', content: '子问题一', attachTo: c.rootId, edge: 'decompose' },
            { id: 'q2', type: 'question', content: '孙问题', attachTo: 'q1', edge: 'decompose' },
          ],
          reason: '两层分解',
        },
      }, 'agent', SID)
      expect(grow.ok).toBe(true)
      expect(h.svc.readState(c.canvasId, SID).edges).toHaveLength(2)
    } finally {
      h.dispose()
    }
  })

  it('逆例：同批同 id 分歧重声明（历史成环通道）= invalid_params upfront 拒绝，整批不落盘', () => {
    const h = makeService()
    try {
      const c = createCanvas(h.svc)
      // 每节点至多一条入边（边 id 确定性派生 e-<子id>，upsert 覆盖式重挂）。历史成环
      // 通道 = 同 id 节点的边被后继 item 覆盖重挂（x→y + y→x）——该通道
      // 在边覆盖前即被分歧判定拦截（invalid_params），cycle_detected 守卫退为结构性
      // 兜底（不可达；检测逻辑见下方 findTrunkCycle 纯函数用例）。
      const reply = h.svc.mutate({
        action: 'grow',
        params: {
          canvasId: c.canvasId,
          batch: [
            { id: 'x', type: 'question', content: 'x', attachTo: c.rootId, edge: 'decompose' },
            { id: 'y', type: 'question', content: 'y', attachTo: 'x', edge: 'decompose' },
            { id: 'x', type: 'question', content: 'x 重挂到 y 下', attachTo: 'y', edge: 'decompose' },
          ],
          reason: '构造环',
        },
      }, 'agent', SID)
      expectRejected(reply, 'invalid_params')
      if (!reply.ok) expect(reply.error.message).toContain('patch')
      // 原子事务：整批拒绝，x / y 均不得落盘
      const state = h.svc.readState(c.canvasId, SID)
      expect(state.nodes.find((n) => n.id === 'x')).toBeUndefined()
      expect(state.nodes.find((n) => n.id === 'y')).toBeUndefined()
      expect(state.edges.find((e) => e.id === 'e-x')).toBeUndefined()
    } finally {
      h.dispose()
    }
  })

  it('不变量 2 守卫（findTrunkCycle 纯函数）：合成环即定位环上节点，DAG 返回 null', () => {
    const h = makeService()
    try {
      const c = growCanvas(h.svc, createCanvas(h.svc))
      const state = structuredClone(c.state())
      expect(findTrunkCycle(state)).toBeNull()
      // 合成环：root→q1 已存在，补 q1→root 的 decompose 边（mutate 不可达——分歧判定拦截）
      state.edges.push({ id: 'e-synthetic-cycle', type: 'decompose', from: 'q1', to: state.root.nodeId })
      expect(findTrunkCycle(state)).toBe(state.root.nodeId)
      // 自环同样命中
      state.edges.pop()
      state.edges.push({ id: 'e-self-loop', type: 'decompose', from: 'q1', to: 'q1' })
      expect(findTrunkCycle(state)).toBe('q1')
    } finally {
      h.dispose()
    }
  })
})

describe('不变量 3：selected 至多一条；selected 变更产生方案选择事件并留对比理由', () => {
  it('正例：select 写入 selected 标记 + 对比理由 + OptionSelected 事件', () => {
    const h = makeService()
    try {
      const c = growCanvas(h.svc, createCanvas(h.svc))
      const reply = h.svc.mutate({ action: 'select', params: { canvasId: c.canvasId, questionId: c.q1, optionId: c.o1, reason: '演进性优先' } }, 'user', SID)
      expect(reply.ok).toBe(true)
      const o1 = c.state().nodes.find((n) => n.id === c.o1)
      expect(o1?.selected).toBe(true)
      expect(o1?.selectionReason).toBe('演进性优先')
      if (reply.ok) expect(reply.evType).toBe(ACTION_EVENT_MAP.select)
    } finally {
      h.dispose()
    }
  })

  it('逆例：已选定时再 select 另一候选（无 replace）→ selection_conflict', () => {
    const h = makeService()
    try {
      const c = growCanvas(h.svc, createCanvas(h.svc))
      expect(h.svc.mutate({ action: 'select', params: { canvasId: c.canvasId, questionId: c.q1, optionId: c.o1, reason: 'r' } }, 'user', SID).ok).toBe(true)
      const reply = h.svc.mutate({ action: 'select', params: { canvasId: c.canvasId, questionId: c.q1, optionId: c.o2, reason: 'r2' } }, 'user', SID)
      expectRejected(reply, 'selection_conflict')
    } finally {
      h.dispose()
    }
  })

  it('正例：replace 换选 = 同一调用事务内迁出旧 selected 再置新', () => {
    const h = makeService()
    try {
      const c = growCanvas(h.svc, createCanvas(h.svc))
      expect(h.svc.mutate({ action: 'select', params: { canvasId: c.canvasId, questionId: c.q1, optionId: c.o1, reason: 'r1' } }, 'user', SID).ok).toBe(true)
      const reply = h.svc.mutate({ action: 'select', params: { canvasId: c.canvasId, questionId: c.q1, optionId: c.o2, replace: { fromOptionId: c.o1 }, reason: '改选 o2：成本更低' } }, 'user', SID)
      expect(reply.ok).toBe(true)
      const state = c.state()
      expect(state.nodes.find((n) => n.id === c.o1)?.selected).toBe(false)
      expect(state.nodes.find((n) => n.id === c.o2)?.selected).toBe(true)
    } finally {
      h.dispose()
    }
  })

  it('逆例：replace.fromOptionId 与当前 selected 不符 → invalid_params', () => {
    const h = makeService()
    try {
      const c = growCanvas(h.svc, createCanvas(h.svc))
      expect(h.svc.mutate({ action: 'select', params: { canvasId: c.canvasId, questionId: c.q1, optionId: c.o1, reason: 'r1' } }, 'user', SID).ok).toBe(true)
      const reply = h.svc.mutate({ action: 'select', params: { canvasId: c.canvasId, questionId: c.q1, optionId: c.o2, replace: { fromOptionId: c.o2 }, reason: 'r' } }, 'user', SID)
      expectRejected(reply, 'invalid_params')
    } finally {
      h.dispose()
    }
  })

  it('逆例：option 与 question 无 resolve 边相连 → invalid_params', () => {
    const h = makeService()
    try {
      const c = createCanvas(h.svc)
      const reply = h.svc.mutate({ action: 'select', params: { canvasId: c.canvasId, questionId: c.rootId, optionId: 'ghost', reason: 'r' } }, 'user', SID)
      expectRejected(reply, 'node_not_found')
    } finally {
      h.dispose()
    }
  })
})

describe('不变量 3 转移侧：否决 / 搁置同步清除 selected（放弃该候选）', () => {
  it('否决当前选定方案 → selected 清除、该问题不再按 resolve 路径判就绪、导出不显「已选定」；重启重建后清除效果保持（直写 ≡ 重放）', () => {
    const h = makeService()
    try {
      const c = growCanvas(h.svc, createCanvas(h.svc))
      expect(h.svc.mutate({ action: 'select', params: { canvasId: c.canvasId, questionId: c.q1, optionId: c.o1, reason: '演进性优先' } }, 'user', SID).ok).toBe(true)
      expect(c.state().nodes.find((n) => n.id === c.o1)?.selected).toBe(true)
      // 否决链（draft → under-review → rejected，与不变量 4 用例同款合法转移）
      expect(h.svc.mutate({ action: 'transition', params: { canvasId: c.canvasId, nodeId: c.o1, to: 'under-review', reason: '提案' } }, 'agent', SID).ok).toBe(true)
      expect(h.svc.mutate({ action: 'transition', params: { canvasId: c.canvasId, nodeId: c.o1, to: 'rejected', rejection: { reason: '成本超预算' }, reason: '用户否决当前选定' } }, 'user', SID).ok).toBe(true)
      const state = c.state()
      const o1 = state.nodes.find((n) => n.id === c.o1)
      expect(o1?.selected).toBe(false)
      expect(o1?.selectionReason).toBeUndefined()
      // 就绪递归：q1 的选定已清除且无分解子问题 → 悬空不就绪（收敛门禁②拦截，不得以
      // 被否决方案继续按 resolve 路径判就绪）
      expect(isQuestionReady(state, c.q1)).toBe(false)
      // 导出渲染：否决行保留否决语义（理由可读），不渲染「已选定」
      const doc = renderPlanningDoc(state, new Date().toISOString())
      expect(doc).not.toContain('已选定')
      expect(doc).toContain('成本超预算')
      // 重启重建：清除效果随事件流还原（重放执行同一 applyTransition 同清除）
      const reborn = new CanvasService({ dataDir: h.dir, generateId: (): string => 'u' })
      try {
        expect(reborn.readState(c.canvasId, SID).nodes.find((n) => n.id === c.o1)?.selected).toBe(false)
      } finally {
        reborn.dispose()
      }
    } finally {
      h.dispose()
    }
  })

  it('搁置当前选定方案 → selected 同步清除（否决 / 搁置同款转移侧语义）', () => {
    const h = makeService()
    try {
      const c = growCanvas(h.svc, createCanvas(h.svc))
      expect(h.svc.mutate({ action: 'select', params: { canvasId: c.canvasId, questionId: c.q1, optionId: c.o1, reason: 'r1' } }, 'user', SID).ok).toBe(true)
      expect(h.svc.mutate({ action: 'transition', params: { canvasId: c.canvasId, nodeId: c.o1, to: 'shelved', reason: '暂缓该方案' } }, 'user', SID).ok).toBe(true)
      const o1 = c.state().nodes.find((n) => n.id === c.o1)
      expect(o1?.selected).toBe(false)
      expect(o1?.selectionReason).toBeUndefined()
    } finally {
      h.dispose()
    }
  })
})

describe('导出渲染 §3：方案选择段按 resolve 父问题去重', () => {
  it('一问题挂 ≥2 条 resolve 边（多候选比较）→ 导出仅一个「### 问题」段落，候选行各一条不重复', () => {
    const h = makeService()
    try {
      // growCanvas 标准形态：q1 挂 o1 / o2 两条 resolve 边（方案比较核心场景）
      const c = growCanvas(h.svc, createCanvas(h.svc))
      const doc = renderPlanningDoc(c.state(), new Date().toISOString())
      // 段落唯一：同父问题只产出一个段标题（修复前逐 resolve 边整段重复输出 2 次）
      const sectionHeadings = doc.split('\n').filter((l) => l.startsWith('### 问题 '))
      expect(sectionHeadings).toHaveLength(1)
      expect(sectionHeadings[0]).toContain(c.q1)
      // 候选行各一条：两个候选各恰好渲染一行「未选定」（修复前每候选随段落重复出现 2 次）
      const candidateLines = doc.split('\n').filter((l) => l.startsWith('- 未选定 '))
      expect(candidateLines).toHaveLength(2)
      expect(doc).toContain('(o1)')
      expect(doc).toContain('(o2)')
    } finally {
      h.dispose()
    }
  })
})

describe('不变量 4：rejected 节点不可删除、不可从 rejected 直接转 passed', () => {
  it('逆例：rejected → passed 表外转移 → lifecycle_transition_illegal', () => {
    const h = makeService()
    try {
      const c = growCanvas(h.svc, createCanvas(h.svc))
      expect(h.svc.mutate({ action: 'transition', params: { canvasId: c.canvasId, nodeId: c.o2, to: 'under-review', reason: '提案' } }, 'agent', SID).ok).toBe(true)
      expect(h.svc.mutate({ action: 'transition', params: { canvasId: c.canvasId, nodeId: c.o2, to: 'rejected', rejection: { reason: '成本不可接受' }, reason: '审查否决' } }, 'user', SID).ok).toBe(true)
      const reply = h.svc.mutate({ action: 'transition', params: { canvasId: c.canvasId, nodeId: c.o2, to: 'passed', reason: '越级转 passed' } }, 'user', SID)
      expectRejected(reply, 'lifecycle_transition_illegal')
    } finally {
      h.dispose()
    }
  })

  it('正例：rejected → draft 复活（留理由），否决记录灰显保留', () => {
    const h = makeService()
    try {
      const c = growCanvas(h.svc, createCanvas(h.svc))
      expect(h.svc.mutate({ action: 'transition', params: { canvasId: c.canvasId, nodeId: c.o2, to: 'under-review', reason: '提案' } }, 'agent', SID).ok).toBe(true)
      expect(h.svc.mutate({ action: 'transition', params: { canvasId: c.canvasId, nodeId: c.o2, to: 'rejected', rejection: { reason: '成本不可接受', reviveCondition: '成本下降 50%' }, reason: '审查否决' } }, 'user', SID).ok).toBe(true)
      const revive = h.svc.mutate({ action: 'transition', params: { canvasId: c.canvasId, nodeId: c.o2, to: 'draft', reason: '新证据：缓存方案使成本减半（用户裁决复活）' } }, 'user', SID)
      expect(revive.ok).toBe(true)
      const o2 = c.state().nodes.find((n) => n.id === c.o2)
      expect(o2?.lifecycle).toBe('draft')
      // 否决记录不可删除：复活后仍保留（防 agent 重复提出已否决项）
      expect(o2?.rejection?.reason).toBe('成本不可接受')
    } finally {
      h.dispose()
    }
  })

  it('构造性满足：「不可删除」由词表无删除动作保证（全部图变更经 16 action 词表）', () => {
    expect(CANVAS_ACTIONS.some((a) => a.includes('delete') || a.includes('remove'))).toBe(false)
  })
})

describe('不变量 5：fact 论据必须携带核实状态；未核实论据不得作为 passed 依据', () => {
  it('正例：已核实 fact 论据支撑 → passed 放行', () => {
    const h = makeService()
    try {
      const c = growCanvas(h.svc, createCanvas(h.svc), { o1Dispatchable: true })
      expect(h.svc.mutate({ action: 'patch', params: { canvasId: c.canvasId, nodeId: c.o1, criterias: ['覆盖率 ≥ 90%'], reason: '补判据' } }, 'user', SID).ok).toBe(true)
      expect(h.svc.mutate({
        action: 'grow',
        params: { canvasId: c.canvasId, batch: [{ id: 'arg1', type: 'argument', content: '基准测试显示内存占用减半', attachTo: c.o1, edge: 'argue', edgePolarity: 'support', materiality: 'fact', factVerified: true }], reason: '补支撑论据' },
      }, 'agent', SID).ok).toBe(true)
      expect(h.svc.mutate({ action: 'transition', params: { canvasId: c.canvasId, nodeId: c.o1, to: 'under-review', reason: '提案' } }, 'agent', SID).ok).toBe(true)
      const reply = h.svc.mutate({ action: 'transition', params: { canvasId: c.canvasId, nodeId: c.o1, to: 'passed', reason: '审查通过' } }, 'user', SID)
      expect(reply.ok).toBe(true)
    } finally {
      h.dispose()
    }
  })

  it('逆例：未核实 fact 论据支撑 → passed 拒绝（unverified_fact）', () => {
    const h = makeService()
    try {
      const c = growCanvas(h.svc, createCanvas(h.svc), { o1Dispatchable: true })
      expect(h.svc.mutate({ action: 'patch', params: { canvasId: c.canvasId, nodeId: c.o1, criterias: ['覆盖率 ≥ 90%'], reason: '补判据' } }, 'user', SID).ok).toBe(true)
      expect(h.svc.mutate({
        action: 'grow',
        params: { canvasId: c.canvasId, batch: [{ id: 'arg1', type: 'argument', content: '基准测试显示内存占用减半', attachTo: c.o1, edge: 'argue', edgePolarity: 'support', materiality: 'fact' }], reason: '补支撑论据（未核实）' },
      }, 'agent', SID).ok).toBe(true)
      expect(h.svc.mutate({ action: 'transition', params: { canvasId: c.canvasId, nodeId: c.o1, to: 'under-review', reason: '提案' } }, 'agent', SID).ok).toBe(true)
      const reply = h.svc.mutate({ action: 'transition', params: { canvasId: c.canvasId, nodeId: c.o1, to: 'passed', reason: '审查通过' } }, 'user', SID)
      expectRejected(reply, 'unverified_fact')
      // 恢复动作可操作：补核实后重试 → 放行
      expect(h.svc.mutate({ action: 'patch', params: { canvasId: c.canvasId, nodeId: 'arg1', factVerified: true, reason: '已复核基准数据' } }, 'agent', SID).ok).toBe(true)
      expect(h.svc.mutate({ action: 'transition', params: { canvasId: c.canvasId, nodeId: c.o1, to: 'passed', reason: '审查通过' } }, 'user', SID).ok).toBe(true)
    } finally {
      h.dispose()
    }
  })

  it('词表外极性/素材性 fail-fast（invalid_params）且整批不落盘：「Support」形态进不了图，伪 support 未核实 fact 无旁路通道', () => {
    const h = makeService()
    try {
      const c = growCanvas(h.svc, createCanvas(h.svc), { o1Dispatchable: true })
      // 'Support' 大小写漂移：修复前直接落盘 node.polarity='Support'，不匹配
      // argumentPolarity(...) === 'support' → unverified_fact 拦截面（下方逆例）对该节点失守；
      // 修复后 runtime 值域校验 fail-fast（契约守卫同口径，直调 service 通道兜底）。
      // as never = 故意注入契约类型词表外的值（测试运行时防线的必要形态）。
      const drifted = h.svc.mutate({
        action: 'grow',
        params: { canvasId: c.canvasId, batch: [{ id: 'arg-bad', type: 'argument', content: '基准测试显示内存占用减半', attachTo: c.o1, edge: 'argue', edgePolarity: 'Support', materiality: 'fact' }], reason: '补支撑论据' } as never,
      }, 'agent', SID)
      expectRejected(drifted, 'invalid_params')
      if (!drifted.ok) expect(drifted.error.message).toContain('support | object')
      // 素材性词表外值同口径拒绝
      const badMateriality = h.svc.mutate({
        action: 'grow',
        params: { canvasId: c.canvasId, batch: [{ id: 'arg-mat', type: 'argument', content: 'x', attachTo: c.o1, edge: 'argue', edgePolarity: 'support', materiality: 'Fact' }], reason: '补论据' } as never,
      }, 'agent', SID)
      expectRejected(badMateriality, 'invalid_params')
      if (!badMateriality.ok) expect(badMateriality.error.message).toContain('fact | claim')
      // 拒绝 = 无写入：伪极性 / 伪素材性节点均未落盘
      const state = c.state()
      expect(state.nodes.some((n) => n.id === 'arg-bad')).toBe(false)
      expect(state.nodes.some((n) => n.id === 'arg-mat')).toBe(false)
      // 拦截面完好对照：合法 'support' + 未核实 fact 仍被 unverified_fact 拦截
      expect(h.svc.mutate({
        action: 'grow',
        params: { canvasId: c.canvasId, batch: [{ id: 'arg1', type: 'argument', content: '基准测试显示内存占用减半', attachTo: c.o1, edge: 'argue', edgePolarity: 'support', materiality: 'fact' }], reason: '补支撑论据（未核实）' },
      }, 'agent', SID).ok).toBe(true)
      expect(h.svc.mutate({ action: 'patch', params: { canvasId: c.canvasId, nodeId: c.o1, criterias: ['覆盖率 ≥ 90%'], reason: '补判据' } }, 'user', SID).ok).toBe(true)
      expect(h.svc.mutate({ action: 'transition', params: { canvasId: c.canvasId, nodeId: c.o1, to: 'under-review', reason: '提案' } }, 'agent', SID).ok).toBe(true)
      expectRejected(h.svc.mutate({ action: 'transition', params: { canvasId: c.canvasId, nodeId: c.o1, to: 'passed', reason: '审查通过' } }, 'user', SID), 'unverified_fact')
    } finally {
      h.dispose()
    }
  })

  it('构造性满足前半句：grow 创建的 fact 论据恒携带核实状态（缺省 false = 已携带「未核实」）', () => {
    const h = makeService()
    try {
      const c = createCanvas(h.svc)
      expect(h.svc.mutate({
        action: 'grow',
        params: { canvasId: c.canvasId, batch: [{ id: 'a1', type: 'argument', content: 'x', attachTo: c.rootId, edge: 'argue', edgePolarity: 'object', materiality: 'fact' }], reason: 'r' },
      }, 'agent', SID).ok).toBe(true)
      const a1 = h.svc.readState(c.canvasId, SID).nodes.find((n) => n.id === 'a1')
      expect(a1?.materiality).toBe('fact')
      expect(a1?.factVerified).toBe(false)
      // claim 论据不带核实状态字段要求
      expect(h.svc.mutate({
        action: 'grow',
        params: { canvasId: c.canvasId, batch: [{ id: 'a2', type: 'argument', content: 'y', attachTo: c.rootId, edge: 'argue', edgePolarity: 'object' }], reason: 'r' },
      }, 'agent', SID).ok).toBe(true)
      const a2 = h.svc.readState(c.canvasId, SID).nodes.find((n) => n.id === 'a2')
      expect(a2?.materiality).toBe('claim')
      expect(a2?.factVerified).toBeUndefined()
    } finally {
      h.dispose()
    }
  })
})

describe('论据极性纪律：rebut 边必带极性（与 argue 同口径——工具面 edgePolarity REQUIRED 承诺的 runtime 执行点）', () => {
  it('rebut 缺极性 → invalid_params 且整批不落盘；带极性重试 → 落库', () => {
    const h = makeService()
    try {
      const c = growCanvas(h.svc, createCanvas(h.svc))
      // 被反驳目标：带极性的 argue 论据（argue 侧极性强制为既有口径）
      expect(h.svc.mutate({ action: 'grow', params: { canvasId: c.canvasId, batch: [{ id: 'a1', type: 'argument', content: '目标论据', attachTo: c.o1, edge: 'argue', edgePolarity: 'support' }], reason: '落支撑论据' } }, 'agent', SID).ok).toBe(true)
      // rebut 缺极性：拒绝（工具描述「REQUIRED when edge is argue/rebut」的 runtime 兑现）
      const rejected = h.svc.mutate({ action: 'grow', params: { canvasId: c.canvasId, batch: [{ id: 'a2', type: 'argument', content: '反驳论据', attachTo: 'a1', edge: 'rebut' }], reason: '反驳目标论据' } }, 'agent', SID)
      expectRejected(rejected, 'invalid_params')
      expect(c.state().nodes.some((n) => n.id === 'a2')).toBe(false)
      // 带极性重试：落库
      expect(h.svc.mutate({ action: 'grow', params: { canvasId: c.canvasId, batch: [{ id: 'a2', type: 'argument', content: '反驳论据', attachTo: 'a1', edge: 'rebut', edgePolarity: 'object' }], reason: '反驳目标论据' } }, 'agent', SID).ok).toBe(true)
      expect(c.state().nodes.some((n) => n.id === 'a2')).toBe(true)
    } finally {
      h.dispose()
    }
  })
})

describe('不变量 6：constrain 边目标必须是画布内存在的节点（MVP 构造性满足）', () => {
  it('构造性满足：constrain / reference 不在 MVP 边词表，契约守卫直接拒绝', async () => {
    const { isCanvasMarkerRequest } = await import('@zhushanwen/extension-protocol')
    const bad = {
      action: 'grow',
      params: {
        canvasId: 'c',
        batch: [{ id: 'x', type: 'constraint', content: 'c', attachTo: 'r', edge: 'decompose' }],
        reason: 'r',
      },
    }
    // 约束节点类型可入图（四类节点含 constraint），但 constrain 边类型不在词表——
    // 不变量 6 的「边」语义在 MVP 无构造通道，目标存在性校验随第二版边类型引入。
    expect(isCanvasMarkerRequest({ ...bad, params: { ...bad.params, batch: [{ id: 'x', type: 'question', content: 'c', attachTo: 'r', edge: 'constrain' }] } })).toBe(false)
    expect(isCanvasMarkerRequest({ ...bad, params: { ...bad.params, batch: [{ id: 'x', type: 'question', content: 'c', attachTo: 'r', edge: 'reference' }] } })).toBe(false)
  })
})

describe('不变量 7：执行叶子 passed 前判据必填；dispatched 前必须 passed', () => {
  it('逆例：无判据执行叶子 → passed 拒绝', () => {
    const h = makeService()
    try {
      const c = growCanvas(h.svc, createCanvas(h.svc), { o1Dispatchable: true })
      expect(h.svc.mutate({ action: 'transition', params: { canvasId: c.canvasId, nodeId: c.o1, to: 'under-review', reason: '提案' } }, 'agent', SID).ok).toBe(true)
      const reply = h.svc.mutate({ action: 'transition', params: { canvasId: c.canvasId, nodeId: c.o1, to: 'passed', reason: '跳过判据' } }, 'user', SID)
      expectRejected(reply, 'lifecycle_transition_illegal')
    } finally {
      h.dispose()
    }
  })

  it('逆例：未 passed → dispatch 拒绝（dispatch_blocked）', () => {
    const h = makeService()
    try {
      const c = growCanvas(h.svc, createCanvas(h.svc), { o1Dispatchable: true })
      const reply = h.svc.mutate({ action: 'dispatch', params: { canvasId: c.canvasId, nodeId: c.o1, pointer: 'docs/req-card.md' } }, 'user', SID)
      expectRejected(reply, 'dispatch_blocked')
    } finally {
      h.dispose()
    }
  })

  it('正例：passed + 判据 → dispatch 成功且下游指针可见（用户可见断言：readState 的 dispatch.pointer）', () => {
    const h = makeService()
    try {
      const c = growCanvas(h.svc, createCanvas(h.svc), { o1Dispatchable: true })
      expect(h.svc.mutate({ action: 'patch', params: { canvasId: c.canvasId, nodeId: c.o1, criterias: ['覆盖率 ≥ 90%'], reason: '补判据' } }, 'user', SID).ok).toBe(true)
      expect(h.svc.mutate({ action: 'transition', params: { canvasId: c.canvasId, nodeId: c.o1, to: 'under-review', reason: '提案' } }, 'agent', SID).ok).toBe(true)
      expect(h.svc.mutate({ action: 'transition', params: { canvasId: c.canvasId, nodeId: c.o1, to: 'passed', reason: '审查通过' } }, 'user', SID).ok).toBe(true)
      const reply = h.svc.mutate({ action: 'dispatch', params: { canvasId: c.canvasId, nodeId: c.o1, pointer: 'sessions/design-leaf-o1' } }, 'user', SID)
      expect(reply.ok).toBe(true)
      const leaf = c.state().nodes.find((n) => n.id === c.o1)
      expect(leaf?.dispatch?.pointer).toBe('sessions/design-leaf-o1')
    } finally {
      h.dispose()
    }
  })

  it('逆例：dispatch 非 dispatchable 的 option → dispatch_blocked', () => {
    const h = makeService()
    try {
      const c = growCanvas(h.svc, createCanvas(h.svc))
      const reply = h.svc.mutate({ action: 'dispatch', params: { canvasId: c.canvasId, nodeId: c.o2, pointer: 'x' } }, 'user', SID)
      expectRejected(reply, 'dispatch_blocked')
    } finally {
      h.dispose()
    }
  })

  it('逆例：pointer 空串（含纯空白）→ invalid_params 且 node.dispatch 不落（不变量 7：下游产物指针必填）', () => {
    const h = makeService()
    try {
      const c = growCanvas(h.svc, createCanvas(h.svc), { o1Dispatchable: true })
      expect(h.svc.mutate({ action: 'patch', params: { canvasId: c.canvasId, nodeId: c.o1, criterias: ['覆盖率 ≥ 90%'], reason: '补判据' } }, 'user', SID).ok).toBe(true)
      expect(h.svc.mutate({ action: 'transition', params: { canvasId: c.canvasId, nodeId: c.o1, to: 'under-review', reason: '提案' } }, 'agent', SID).ok).toBe(true)
      expect(h.svc.mutate({ action: 'transition', params: { canvasId: c.canvasId, nodeId: c.o1, to: 'passed', reason: '审查通过' } }, 'user', SID).ok).toBe(true)
      const reply = h.svc.mutate({ action: 'dispatch', params: { canvasId: c.canvasId, nodeId: c.o1, pointer: '   ' } }, 'user', SID)
      expectRejected(reply, 'invalid_params')
      if (!reply.ok) expect(reply.error.message).toContain('指针')
      // 拒绝 = 无写入：passed 执行叶子上不得留下空指针 dispatch
      expect(c.state().nodes.find((n) => n.id === c.o1)?.dispatch).toBeUndefined()
    } finally {
      h.dispose()
    }
  })
})

describe('不变量 8：评论初始待响应；留痕前不得转已响应（响应义务）', () => {
  it('正例：comment（user）→ pending；comment-respond（agent, adopted）→ responded + 留痕可见', () => {
    const h = makeService()
    try {
      const c = growCanvas(h.svc, createCanvas(h.svc))
      const added = h.svc.mutate({ action: 'comment', params: { canvasId: c.canvasId, anchorId: c.q1, text: '独立窗口会被挤占吗' } }, 'user', SID)
      expect(added.ok).toBe(true)
      const pending = c.state().comments[0]
      expect(pending?.status).toBe('pending')
      if (!added.ok) return
      const commentId = (c.state().comments[0] as { id: string }).id
      expect(commentId).toBeTruthy()
      const respond = h.svc.mutate({ action: 'comment-respond', params: { canvasId: c.canvasId, commentId, disposition: 'adopted', note: '采纳：补独立窗口候选 o3 并留对比' } }, 'agent', SID)
      expect(respond.ok).toBe(true)
      const responded = c.state().comments[0]
      expect(responded?.status).toBe('responded')
      expect(responded?.response?.disposition).toBe('adopted')
      expect(responded?.response?.note).toContain('采纳')
    } finally {
      h.dispose()
    }
  })

  it('逆例：重复响应已响应评论 → 拒绝', () => {
    const h = makeService()
    try {
      const c = createCanvas(h.svc)
      expect(h.svc.mutate({ action: 'comment', params: { canvasId: c.canvasId, anchorId: c.rootId, text: 'q' } }, 'user', SID).ok).toBe(true)
      const commentId = c.state().comments[0]!.id
      expect(h.svc.mutate({ action: 'comment-respond', params: { canvasId: c.canvasId, commentId, disposition: 'rebutted', note: '反驳理由：范围排除已含此项' } }, 'agent', SID).ok).toBe(true)
      const reply = h.svc.mutate({ action: 'comment-respond', params: { canvasId: c.canvasId, commentId, disposition: 'adopted', note: '再次响应' } }, 'agent', SID)
      expectRejected(reply, 'invalid_params')
    } finally {
      h.dispose()
    }
  })

  it('构造性满足：转已响应的唯一通道 comment-respond 强制 note 留痕（空 note 拒绝）', () => {
    const h = makeService()
    try {
      const c = createCanvas(h.svc)
      expect(h.svc.mutate({ action: 'comment', params: { canvasId: c.canvasId, anchorId: c.rootId, text: 'q' } }, 'user', SID).ok).toBe(true)
      const commentId = c.state().comments[0]!.id
      const reply = h.svc.mutate({ action: 'comment-respond', params: { canvasId: c.canvasId, commentId, disposition: 'adopted', note: '   ' } }, 'agent', SID)
      expectRejected(reply, 'invalid_params')
      expect(c.state().comments[0]?.status).toBe('pending')
    } finally {
      h.dispose()
    }
  })
})

describe('不变量 9（D9 传播）：用户改动后该节点到根路径进待重审集合', () => {
  it('正例：user patch → 上溯路径进 dirtyPaths（q1 → root）', () => {
    const h = makeService()
    try {
      const c = growCanvas(h.svc, createCanvas(h.svc))
      const reply = h.svc.mutate({ action: 'patch', params: { canvasId: c.canvasId, nodeId: c.q1, content: '引擎抽象层怎么设计（修订）', reason: '用户改述' } }, 'user', SID)
      expect(reply.ok).toBe(true)
      const dirty = c.state().dirtyPaths
      expect(dirty).toContain(c.q1)
      expect(dirty).toContain(c.rootId)
    } finally {
      h.dispose()
    }
  })

  it('逆例：agent patch 不触发待重审（D9 语义 = 用户改动；agent 修复走处置表）', () => {
    const h = makeService()
    try {
      const c = growCanvas(h.svc, createCanvas(h.svc))
      const reply = h.svc.mutate({ action: 'patch', params: { canvasId: c.canvasId, nodeId: c.q1, content: 'x', reason: 'agent 修复' } }, 'agent', SID)
      expect(reply.ok).toBe(true)
      expect(c.state().dirtyPaths).not.toContain(c.q1)
    } finally {
      h.dispose()
    }
  })

  it('正例：换选（select replace）→ 上溯路径 + 旧选中方案整个子树进待重审', () => {
    const h = makeService()
    try {
      const c = growCanvas(h.svc, createCanvas(h.svc))
      // 给 o1 长子问题 q3（o1 子树），选定 o1 后换选 o2
      expect(h.svc.mutate({
        action: 'grow',
        params: { canvasId: c.canvasId, batch: [{ id: 'q3', type: 'question', content: 'o1 下的执行子问题', attachTo: c.o1, edge: 'decompose' }], reason: '生长 o1 子树' },
      }, 'agent', SID).ok).toBe(true)
      expect(h.svc.mutate({ action: 'select', params: { canvasId: c.canvasId, questionId: c.q1, optionId: c.o1, reason: 'r1' } }, 'user', SID).ok).toBe(true)
      // 上一条 select 已 dirty；发起审查消费（清空）后再换选，隔离本轮断言
      expect(h.svc.mutate({ action: 'review-request', params: { canvasId: c.canvasId } }, 'agent', SID).ok).toBe(true)
      expect(c.state().dirtyPaths).toHaveLength(0)
      const reply = h.svc.mutate({ action: 'select', params: { canvasId: c.canvasId, questionId: c.q1, optionId: c.o2, replace: { fromOptionId: c.o1 }, reason: '换选 o2' } }, 'user', SID)
      expect(reply.ok).toBe(true)
      const dirty = c.state().dirtyPaths
      const expected = new Set([...pathToRoot(c.state(), c.q1), ...subtreeOf(c.state(), c.o1)])
      for (const id of expected) expect(dirty).toContain(id)
      expect(dirty).toContain(c.o1)
      expect(dirty).toContain('q3')
    } finally {
      h.dispose()
    }
  })

  it('正例：user comment（锚节点 / 锚边）→ 锚定目标上溯路径进待重审', () => {
    const h = makeService()
    try {
      const c = growCanvas(h.svc, createCanvas(h.svc))
      expect(h.svc.mutate({ action: 'comment', params: { canvasId: c.canvasId, anchorId: c.q1, text: '这里 MECE 吗' } }, 'user', SID).ok).toBe(true)
      expect(c.state().dirtyPaths).toContain(c.q1)
      // 锚边：decompose 边 id = e-<子节点id>（边 id 确定性派生自子节点）
      expect(h.svc.mutate({ action: 'review-request', params: { canvasId: c.canvasId } }, 'agent', SID).ok).toBe(true)
      expect(h.svc.mutate({ action: 'comment', params: { canvasId: c.canvasId, anchorId: `e-${c.q1}`, text: '这条分解边存疑' } }, 'user', SID).ok).toBe(true)
      expect(c.state().dirtyPaths).toContain(c.q1)
    } finally {
      h.dispose()
    }
  })
})

describe('不变量 10：收敛终态前置 = 待重审空 + must-fix 清零 + 执行叶子全 passed（三门禁）', () => {
  it('逆例群：各门禁缺口逐一 not_converged（含动态计数的恢复提示）', () => {
    const h = makeService()
    try {
      const c = growCanvas(h.svc, createCanvas(h.svc), { o1Dispatchable: true })
      // 缺口：无选定方案（就绪递归不成立）+ 无判据 + 叶子未 passed
      const r1 = h.svc.mutate({ action: 'converge-check', params: { canvasId: c.canvasId } }, 'user', SID)
      expectRejected(r1, 'not_converged')
      if (r1.ok) return
      expect(r1.error.message).toContain('就绪递归未成立')
      // 补齐选定 + 判据 + passed + 消费 dirty，但留下未处置 must-fix
      expect(h.svc.mutate({ action: 'select', params: { canvasId: c.canvasId, questionId: c.q1, optionId: c.o1, reason: 'r' } }, 'user', SID).ok).toBe(true)
      expect(h.svc.mutate({ action: 'patch', params: { canvasId: c.canvasId, nodeId: c.o1, criterias: ['c1'], reason: '判据' } }, 'user', SID).ok).toBe(true)
      expect(h.svc.mutate({ action: 'transition', params: { canvasId: c.canvasId, nodeId: c.o1, to: 'under-review', reason: '提案' } }, 'agent', SID).ok).toBe(true)
      expect(h.svc.mutate({ action: 'transition', params: { canvasId: c.canvasId, nodeId: c.o1, to: 'passed', reason: '过审' } }, 'user', SID).ok).toBe(true)
      expect(h.svc.mutate({ action: 'review-request', params: { canvasId: c.canvasId } }, 'agent', SID).ok).toBe(true)
      expect(h.svc.mutate({
        action: 'review-append',
        params: { canvasId: c.canvasId, round: 1, entries: [{ id: 'mf1', round: 1, dimension: 'completeness', severity: 'must-fix', targetId: c.q1, note: '缺一条分解分支' }] },
      }, 'review', SID).ok).toBe(true)
      const r2 = h.svc.mutate({ action: 'converge-check', params: { canvasId: c.canvasId } }, 'user', SID)
      expectRejected(r2, 'not_converged')
      if (!r2.ok) expect(r2.error.message).toContain('1 条 must-fix 未处置')
    } finally {
      h.dispose()
    }
  })

  it('逆例：无执行叶子（activeLeaves 空集断言）→ not_converged', () => {
    const h = makeService()
    try {
      const c = growCanvas(h.svc, createCanvas(h.svc))
      // o1 未标 dispatchable：即使 select + passed，也没有执行叶子
      expect(h.svc.mutate({ action: 'select', params: { canvasId: c.canvasId, questionId: c.q1, optionId: c.o1, reason: 'r' } }, 'user', SID).ok).toBe(true)
      expect(h.svc.mutate({ action: 'transition', params: { canvasId: c.canvasId, nodeId: c.o1, to: 'under-review', reason: '提案' } }, 'agent', SID).ok).toBe(true)
      expect(h.svc.mutate({ action: 'transition', params: { canvasId: c.canvasId, nodeId: c.o1, to: 'passed', reason: '过审' } }, 'user', SID).ok).toBe(true)
      expect(h.svc.mutate({ action: 'review-request', params: { canvasId: c.canvasId } }, 'agent', SID).ok).toBe(true)
      const reply = h.svc.mutate({ action: 'converge-check', params: { canvasId: c.canvasId } }, 'user', SID)
      expectRejected(reply, 'not_converged')
      if (!reply.ok) expect(reply.error.message).toContain('没有执行叶子')
    } finally {
      h.dispose()
    }
  })

  it('正例：三门禁全绿 → converged 终态 + 根判据确认（用户可见断言：converged/confirmed 可读）', () => {
    const h = makeService()
    try {
      const c = growCanvas(h.svc, createCanvas(h.svc), { o1Dispatchable: true })
      expect(h.svc.mutate({ action: 'select', params: { canvasId: c.canvasId, questionId: c.q1, optionId: c.o1, reason: 'r' } }, 'user', SID).ok).toBe(true)
      expect(h.svc.mutate({ action: 'patch', params: { canvasId: c.canvasId, nodeId: c.o1, criterias: ['c1'], reason: '判据' } }, 'user', SID).ok).toBe(true)
      expect(h.svc.mutate({ action: 'transition', params: { canvasId: c.canvasId, nodeId: c.o1, to: 'under-review', reason: '提案' } }, 'agent', SID).ok).toBe(true)
      expect(h.svc.mutate({ action: 'transition', params: { canvasId: c.canvasId, nodeId: c.o1, to: 'passed', reason: '过审' } }, 'user', SID).ok).toBe(true)
      expect(h.svc.mutate({ action: 'review-request', params: { canvasId: c.canvasId } }, 'agent', SID).ok).toBe(true)
      expect(convergenceBlockers(c.state())).toHaveLength(0)
      const reply = h.svc.mutate({ action: 'converge-check', params: { canvasId: c.canvasId } }, 'user', SID)
      expect(reply.ok).toBe(true)
      const state = c.state()
      expect(state.converged).toBe(true)
      expect(state.root.confirmed).toBe(true)
      expect(state.review?.status).toBe('converged')
    } finally {
      h.dispose()
    }
  })

  it('export 前置含收敛确认：三门禁全绿但未经 converge-check → not_converged（agent 代执行通道同口径）；确认后导出放行', () => {
    const h = makeService()
    try {
      const c = buildAllGreenCanvas(h.svc, createCanvas(h.svc))
      expect(convergenceBlockers(c.state())).toHaveLength(0)
      // 未经收敛确认：agent 通道导出同样拒绝——GUI 门禁①（root.confirmed）与 runtime 同一前置
      const beforeConfirm = h.svc.mutate({ action: 'export', params: { canvasId: c.canvasId, target: { target: 'planning-doc' } } }, 'agent', SID)
      expectRejected(beforeConfirm, 'not_converged')
      if (!beforeConfirm.ok) expect(beforeConfirm.error.message).toContain('收敛确认')
      // 收敛确认后导出放行
      expect(h.svc.mutate({ action: 'converge-check', params: { canvasId: c.canvasId } }, 'user', SID).ok).toBe(true)
      const afterConfirm = h.svc.mutate({ action: 'export', params: { canvasId: c.canvasId, target: { target: 'planning-doc' } } }, 'agent', SID)
      expect(afterConfirm.ok).toBe(true)
    } finally {
      h.dispose()
    }
  })

  it('辅助断言：isRootReady / dispatchableLeaves 与 blockers 清单的派生一致', () => {
    const h = makeService()
    try {
      const c = growCanvas(h.svc, createCanvas(h.svc), { o1Dispatchable: true })
      expect(isRootReady(c.state())).toBe(false)
      expect(dispatchableLeaves(c.state())).toHaveLength(1)
      expect(convergenceBlockers(c.state()).length).toBeGreaterThan(0)
    } finally {
      h.dispose()
    }
  })
})

describe('不变量 11：唯一入口（图元素增删改 / 状态转移 / 评价 / 派发均经 mutate）', () => {
  it('API 面快照：写入口唯一（mutate），其余公开方法 = 查询 / 绑定 / 生命周期；内部方法 = 落盘与重建编排', () => {
    const methods = Object.getOwnPropertyNames(CanvasService.prototype).sort()
    // 快照即守卫：新增公开方法（尤其第二个写入口）或内部方法时此处红，强制审视唯一入口纪律。
    expect(methods).toEqual([
      'assertCanvasIdFormat',
      'assertOwnership',
      'broadcast',
      'canvasDir',
      'constructor',
      'dispose',
      'eventsPath',
      'generateCanvasId',
      'getBoundSessions',
      'listCanvases',
      'loadAll',
      'loadCanvas',
      'mutate',
      'mutateCreate',
      'mutateTransform',
      'persistEvents',
      'readState',
      'replayEvent',
      'snapshotPath',
      'unbindSession',
      'withOwner',
      'writeExport',
      'writeSnapshot',
    ].sort())
  })

  it('聚合 2 不变量 1：review-append 引用不存在的图元素 id → entry_ref_missing', () => {
    const h = makeService()
    try {
      const c = createCanvas(h.svc)
      const reply = h.svc.mutate({
        action: 'review-append',
        params: { canvasId: c.canvasId, round: 1, entries: [{ id: 'e1', round: 1, dimension: 'support', severity: 'suggestion', targetId: 'ghost-node', note: 'x' }] },
      }, 'review', SID)
      expectRejected(reply, 'entry_ref_missing')
    } finally {
      h.dispose()
    }
  })

  it('聚合 2 first-writer-wins：已处置条目再 resolve → already_resolved 且错误含处置归属', () => {
    const h = makeService()
    try {
      const c = createCanvas(h.svc)
      expect(h.svc.mutate({
        action: 'review-append',
        params: { canvasId: c.canvasId, round: 1, entries: [{ id: 'e1', round: 1, dimension: 'depth', severity: 'must-fix', targetId: c.rootId, note: '根分支过浅' }] },
      }, 'review', SID).ok).toBe(true)
      expect(h.svc.mutate({ action: 'review-resolve', params: { canvasId: c.canvasId, entryId: 'e1', disposition: 'deferred', note: '登记后做' } }, 'agent', SID).ok).toBe(true)
      const reply = h.svc.mutate({ action: 'review-resolve', params: { canvasId: c.canvasId, entryId: 'e1', disposition: 'accepted', note: '改判尝试' } }, 'user', SID)
      expectRejected(reply, 'already_resolved')
      if (!reply.ok) expect(reply.error.message).toContain('agent')
      // 处置归属可读（GUI 呈现处置归属的契约数据）
      const entry = c.state().review?.entries.find((e) => e.id === 'e1')
      expect(entry?.resolution?.by).toBe('agent')
      expect(entry?.resolution?.disposition).toBe('deferred')
    } finally {
      h.dispose()
    }
  })
})

describe('canvasId 格式守卫（落盘寻址边界：生成形态即契约，`../` 等越界形态不入文件路径）', () => {
  it('越界 / 畸形形态全入口 invalid_params 拒绝，且不在 canvases 根产生任何目录', () => {
    const h = makeService()
    try {
      const evilIds = ['cvs-../../escape', 'cvs-/abs', 'cvs-', '../cvs-x', 'cvs-a/b', 'cvs-a..b']
      for (const id of evilIds) {
        // 查询入口（throw 形态）
        expectThrown(() => h.svc.readState(id, SID), 'invalid_params')
        // mutate 入口（reply 失败腿形态——领域拒绝不抛）
        expectRejected(h.svc.mutate({ action: 'patch', params: { canvasId: id, nodeId: 'n1', content: 'x', reason: 'r' } }, 'user', SID), 'invalid_params')
      }
      // 零文件系统泄漏：守卫先于一切落盘寻址
      expect(readdirSync(h.dir)).toEqual([])
    } finally {
      h.dispose()
    }
  })

  it('合法形态不误拦：格式合法但不存在的 id → canvas_not_found（守卫只拦格式）', () => {
    const h = makeService()
    try {
      expectThrown(() => h.svc.readState('cvs-doesnotexist', SID), 'canvas_not_found')
    } finally {
      h.dispose()
    }
  })
})

// ════════════════ 来源: canvas-mutate-matrix.test.ts ════════════════

describe('canvas-mutate-matrix', () => {
  const ALL_ACTIONS = Object.keys(CANVAS_ACTOR_MATRIX) as CanvasAction[]
  const ALL_ACTORS: readonly CanvasActor[] = ['user', 'agent', 'review']
  /** 矩阵 true 格的合法执行通道（read / list 走查询方法，不在 mutate 词表执行）。 */
  const HAPPY_PATH_ACTIONS = Object.keys(ACTION_EVENT_MAP) as (keyof typeof ACTION_EVENT_MAP)[]

  function eventsFilePath(dir: string, canvasId: string): string {
    return join(getSessionCanvasesDir(SID, dir), canvasId, 'events.jsonl')
  }

  function readEvents(dir: string, canvasId: string): Array<{ seq: number; eventId: string; type: string; action: string; actor: string }> {
    const file = eventsFilePath(dir, canvasId)
    if (!existsSync(file)) return []
    return readFileSync(file, 'utf-8').split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l) as { seq: number; eventId: string; type: string; action: string; actor: string })
  }

  describe('actor 权限矩阵执行（48 格全扫描）', () => {
    it('false 格：服务入口 fail-fast actor_not_allowed（矩阵校验先于寻址与领域应用）', () => {
      const h: ServiceHandle = makeService()
      try {
        for (const action of ALL_ACTIONS) {
          for (const actor of ALL_ACTORS) {
            if (CANVAS_ACTOR_MATRIX[action][actor]) continue
            const request = action === 'create'
              ? { action: 'create' as const, params: { statement: 'x', criterias: ['c'], scopeExclusions: [] } }
              : { action: action as Exclude<CanvasAction, 'create'>, params: { canvasId: 'nonexistent' } as never }
            const reply = h.svc.mutate(request, actor, SID)
            expect(reply.ok, `${action}×${actor} 应为 false 格`).toBe(false)
            if (!reply.ok) {
              expect(reply.error.code, `${action}×${actor} 应报 actor_not_allowed`).toBe('actor_not_allowed')
              expect(reply.error.recover.length).toBeGreaterThan(0)
            }
          }
        }
      } finally {
        h.dispose()
      }
    })

    it('true 格：合法场景执行成功（每格独立画布，read/list 走查询方法无 actor 门禁）', () => {
      for (const action of ALL_ACTIONS) {
        for (const actor of ALL_ACTORS) {
          if (!CANVAS_ACTOR_MATRIX[action][actor]) continue
          if (action === 'read' || action === 'list') {
            // 查询类：对全部 actor 开放 = 查询方法不设 actor 参数 / 无矩阵门禁；经 mutate 传入则
            // 被指向查询方法（invalid_params），不走矩阵拒绝。
            const h = makeService()
            try {
              const base = createCanvas(h.svc)
              const mutated = h.svc.mutate({ action, params: { canvasId: base.canvasId } as never }, actor, SID)
              expect(mutated.ok, `${action} 经 mutate 应被引导到查询通道`).toBe(false)
              if (!mutated.ok) expect(mutated.error.code).toBe('invalid_params')
              expect(h.svc.readState(base.canvasId, SID).canvasId).toBe(base.canvasId)
              expect(h.svc.listCanvases(SID).canvases.length).toBeGreaterThan(0)
            } finally {
              h.dispose()
            }
            continue
          }
          const h = makeService()
          try {
            const result = runActionHappyPath(h.svc, action as Parameters<typeof runActionHappyPath>[1], actor)
            expect(result.ok, `${action}×${actor} true 格应执行成功`).toBe(true)
          } finally {
            h.dispose()
          }
        }
      }
    })
  })

  describe('原子事务（批量 grow）', () => {
    it('批内任一条校验失败 = 整批拒绝：合法条目不得落盘、事件不得追加', () => {
      const h = makeService()
      try {
        const c = createCanvas(h.svc)
        const eventsBefore = readEvents(h.dir, c.canvasId).length
        const nodesBefore = c.state().nodes.length
        const reply = h.svc.mutate({
          action: 'grow',
          params: {
            canvasId: c.canvasId,
            batch: [
              { id: 'ok-node', type: 'question', content: '合法条目', attachTo: c.rootId, edge: 'decompose' },
              { id: 'bad-node', type: 'question', content: '挂到不存在的父节点', attachTo: 'ghost', edge: 'decompose' },
            ],
            reason: '原子事务断言',
          },
        }, 'agent', SID)
        expect(reply.ok).toBe(false)
        if (!reply.ok) expect(reply.error.code).toBe('node_not_found')
        const state = h.svc.readState(c.canvasId, SID)
        expect(state.nodes.find((n) => n.id === 'ok-node')).toBeUndefined()
        expect(state.nodes).toHaveLength(nodesBefore)
        expect(readEvents(h.dir, c.canvasId)).toHaveLength(eventsBefore)
      } finally {
        h.dispose()
      }
    })
  })

  describe('幂等 upsert（崩溃窗口重试安全）', () => {
    it('同 id grow 重放：节点 / 边不重复，createdAt 保留首次值，状态与单次写入全等', () => {
      const h = makeService()
      try {
        const c = createCanvas(h.svc)
        const item = { id: 'dup-1', type: 'option' as const, content: '候选 A', attachTo: c.rootId, edge: 'resolve' as const }
        const params = { canvasId: c.canvasId, batch: [item], reason: '首次写入' }
        expect(h.svc.mutate({ action: 'grow', params }, 'agent', SID).ok).toBe(true)
        const afterFirst = c.state()
        // 崩溃窗口重试：同 id 同内容再写一次
        expect(h.svc.mutate({ action: 'grow', params }, 'agent', SID).ok).toBe(true)
        const afterRetry = c.state()
        expect(afterRetry.nodes.filter((n) => n.id === 'dup-1')).toHaveLength(1)
        expect(afterRetry.edges.filter((e) => e.id === 'e-dup-1')).toHaveLength(1)
        expect(afterRetry.nodes.find((n) => n.id === 'dup-1')?.createdAt).toBe(afterFirst.nodes.find((n) => n.id === 'dup-1')?.createdAt)
        // 重试后领域内容与首次写入后全等（「无副作用」的强断言；updatedAt 是每次 mutate
        // 的合法时间戳推进，不在幂等语义内）
        const domainOf = (s: CanvasState): unknown => ({ root: s.root, nodes: s.nodes, edges: s.edges, comments: s.comments, dirtyPaths: s.dirtyPaths, review: s.review, converged: s.converged })
        expect(domainOf(afterRetry)).toEqual(domainOf(afterFirst))
      } finally {
        h.dispose()
      }
    })

    it('重试已被后续 mutate 修改过的节点：原样保留积累状态（selected / criterias / lifecycle 不丢失）', () => {
      const h = makeService()
      try {
        const g = growCanvas(h.svc, createCanvas(h.svc), { o1Dispatchable: true })
        // 后续 mutate 在 o1 上积累状态：选定 + 判据 + 生命周期推进
        expect(h.svc.mutate({ action: 'select', params: { canvasId: g.canvasId, questionId: g.q1, optionId: g.o1, reason: '长期演进性优先' } }, 'user', SID).ok).toBe(true)
        expect(h.svc.mutate({ action: 'patch', params: { canvasId: g.canvasId, nodeId: g.o1, criterias: ['抽象层单测覆盖率 ≥ 90%'], reason: '补判据' } }, 'user', SID).ok).toBe(true)
        expect(h.svc.mutate({ action: 'transition', params: { canvasId: g.canvasId, nodeId: g.o1, to: 'under-review', reason: '提案' } }, 'agent', SID).ok).toBe(true)
        const before = g.state()
        // 崩溃窗口重试：同 id 同内容整批重放
        const retry = h.svc.mutate({
          action: 'grow',
          params: {
            canvasId: g.canvasId,
            batch: [
              { id: 'q1', type: 'question', content: '引擎层抽象怎么设计', attachTo: g.rootId, edge: 'decompose' },
              { id: 'o1', type: 'option', content: '混合形态', attachTo: 'q1', edge: 'resolve', dispatchable: true },
              { id: 'o2', type: 'option', content: '单一形态', attachTo: 'q1', edge: 'resolve' },
            ],
            reason: '按 MECE 分解引擎层',
          },
        }, 'agent', SID)
        expect(retry.ok).toBe(true)
        const after = g.state()
        // 无重复节点 / 边
        expect(after.nodes.filter((n) => n.id === 'o1')).toHaveLength(1)
        expect(after.edges.filter((e) => e.id === 'e-o1')).toHaveLength(1)
        // 积累状态原样保留（旧实现以全新对象覆盖：selected / criterias / lifecycle 全部丢失）
        const o1 = after.nodes.find((n) => n.id === 'o1')
        expect(o1?.selected).toBe(true)
        expect(o1?.criterias).toEqual(['抽象层单测覆盖率 ≥ 90%'])
        expect(o1?.lifecycle).toBe('under-review')
        expect(o1?.selectionReason).toBe(before.nodes.find((n) => n.id === 'o1')?.selectionReason)
      } finally {
        h.dispose()
      }
    })

    it('重试声明分歧（同 id 不同内容）= fail-fast 拒绝：grow 是创建语义，修改已存在节点走 patch', () => {
      const h = makeService()
      try {
        const g = growCanvas(h.svc, createCanvas(h.svc))
        const reply = h.svc.mutate({
          action: 'grow',
          params: { canvasId: g.canvasId, batch: [{ id: 'q1', type: 'question', content: '改述后的子问题', attachTo: g.rootId, edge: 'decompose' }], reason: '重试' },
        }, 'agent', SID)
        expectRejected(reply, 'invalid_params')
        if (!reply.ok) {
          expect(reply.error.message).toContain('q1')
          expect(reply.error.message).toContain('patch')
        }
        // 原节点不被改写（拒绝即无写入）
        expect(g.state().nodes.find((n) => n.id === 'q1')?.content).toBe('引擎层抽象怎么设计')
      } finally {
        h.dispose()
      }
    })

    it('review-append 同 id 重放：条目不重复且已登记的处置记录保留', () => {
      const h = makeService()
      try {
        const c = createCanvas(h.svc)
        const append = { canvasId: c.canvasId, round: 1, entries: [{ id: 'ent-1', round: 1, dimension: 'depth' as const, severity: 'must-fix' as const, targetId: c.rootId, note: '过浅' }] }
        expect(h.svc.mutate({ action: 'review-append', params: append }, 'review', SID).ok).toBe(true)
        expect(h.svc.mutate({ action: 'review-resolve', params: { canvasId: c.canvasId, entryId: 'ent-1', disposition: 'accepted', note: '已补分支' } }, 'agent', SID).ok).toBe(true)
        // 崩溃窗口重试 append：覆盖条目字段但保留 resolution（first-writer-wins 不被重试冲掉）
        expect(h.svc.mutate({ action: 'review-append', params: append }, 'review', SID).ok).toBe(true)
        const entries = c.state().review?.entries ?? []
        expect(entries.filter((e) => e.id === 'ent-1')).toHaveLength(1)
        expect(entries[0]?.resolution?.by).toBe('agent')
        // 重试后 resolve 仍被 already_resolved 拦截
        const again = h.svc.mutate({ action: 'review-resolve', params: { canvasId: c.canvasId, entryId: 'ent-1', disposition: 'deferred', note: 'x' } }, 'user', SID)
        expect(again.ok).toBe(false)
        if (!again.ok) expect(again.error.code).toBe('already_resolved')
      } finally {
        h.dispose()
      }
    })
  })

  describe('reason 留痕纪律（契约「canvas_edit 族共享 reason 强制字段」的运行时落地）', () => {
    /**
     * 五个携带 reason 的 action（grow / patch / decide-direction / select / transition）各自的
     * 最小合法前置 + 空 reason 请求（actor 取权限矩阵合法格；空串与纯空白各覆盖）。
     * 返回 reply 与拒绝前的事件行数（断言「拒绝 = 无写入」）。
     */
    const emptyReasonCases: Array<{
      name: string
      run: (h: ServiceHandle) => { reply: CanvasMutateReply; canvasId: string; eventsBefore: number }
    }> = [
      {
        name: 'grow',
        run: (h) => {
          const c = createCanvas(h.svc)
          const eventsBefore = readEvents(h.dir, c.canvasId).length
          return {
            canvasId: c.canvasId,
            eventsBefore,
            reply: h.svc.mutate({ action: 'grow', params: { canvasId: c.canvasId, batch: [{ id: 'g1', type: 'question', content: '子问题', attachTo: c.rootId, edge: 'decompose' }], reason: '' } }, 'agent', SID),
          }
        },
      },
      {
        name: 'patch',
        run: (h) => {
          const c = createCanvas(h.svc)
          const eventsBefore = readEvents(h.dir, c.canvasId).length
          return {
            canvasId: c.canvasId,
            eventsBefore,
            reply: h.svc.mutate({ action: 'patch', params: { canvasId: c.canvasId, nodeId: c.rootId, content: '改述后的问题', reason: '   ' } }, 'user', SID),
          }
        },
      },
      {
        name: 'decide-direction',
        run: (h) => {
          const c = createCanvas(h.svc)
          const eventsBefore = readEvents(h.dir, c.canvasId).length
          return {
            canvasId: c.canvasId,
            eventsBefore,
            reply: h.svc.mutate({ action: 'decide-direction', params: { canvasId: c.canvasId, direction: 'top-down', reason: '' } }, 'user', SID),
          }
        },
      },
      {
        name: 'select',
        run: (h) => {
          const c = growCanvas(h.svc, createCanvas(h.svc))
          const eventsBefore = readEvents(h.dir, c.canvasId).length
          return {
            canvasId: c.canvasId,
            eventsBefore,
            reply: h.svc.mutate({ action: 'select', params: { canvasId: c.canvasId, questionId: c.q1, optionId: c.o1, reason: '  ' } }, 'user', SID),
          }
        },
      },
      {
        name: 'transition',
        run: (h) => {
          const c = createCanvas(h.svc)
          const eventsBefore = readEvents(h.dir, c.canvasId).length
          return {
            canvasId: c.canvasId,
            eventsBefore,
            reply: h.svc.mutate({ action: 'transition', params: { canvasId: c.canvasId, nodeId: c.rootId, to: 'under-review', reason: '' } }, 'user', SID),
          }
        },
      },
    ]

    it('空 reason（含纯空白）→ invalid_params 且不落任何写入（禁「已更新（内容）：」式残缺 summary 与空 why 留痕）', () => {
      for (const { name, run } of emptyReasonCases) {
        const h = makeService()
        try {
          const { reply, canvasId, eventsBefore } = run(h)
          expect(reply.ok, `${name} 空 reason 应被拒绝`).toBe(false)
          if (!reply.ok) {
            expect(reply.error.code, `${name} 应报 invalid_params`).toBe('invalid_params')
            expect(reply.error.message, `${name} 文案应说明留痕纪律`).toContain('留痕')
            expect(reply.error.recover.length, `${name} 恢复文案非空`).toBeGreaterThan(0)
          }
          // 拒绝 = 无写入：事件行数不变（draft 副本整体丢弃）
          expect(readEvents(h.dir, canvasId), `${name} 拒绝后不得追加事件`).toHaveLength(eventsBefore)
        } finally {
          h.dispose()
        }
      }
    })
  })

  describe('领域事件对账（ACTION_EVENT_MAP SSOT）', () => {
    it('每个 mutation action 成功执行至少产出一个事件，主事件类型 = ACTION_EVENT_MAP 映射', () => {
      for (const action of HAPPY_PATH_ACTIONS) {
        const h = makeService()
        try {
          const actor: CanvasActor = CANVAS_ACTOR_MATRIX[action].user ? 'user' : (CANVAS_ACTOR_MATRIX[action].agent ? 'agent' : 'review')
          const result = runActionHappyPath(h.svc, action, actor)
          const events = readEvents(h.dir, result.canvasId)
          const matched = events.filter((e) => e.type === ACTION_EVENT_MAP[action])
          expect(matched.length, `action「${action}」应产出主事件 ${ACTION_EVENT_MAP[action]}`).toBeGreaterThan(0)
          // who / when / what 留痕字段完备（events.jsonl = append-only 领域事件流）
          expect(matched[0]?.actor).toBeTruthy()
          expect(matched[0]?.eventId).toBe(String(matched[0]?.seq))
        } finally {
          h.dispose()
        }
      }
    })

    it('read / list 查询不产事件（append-only 日志体积不随读取次数增长）', () => {
      const h = makeService()
      try {
        const c = createCanvas(h.svc)
        const file = eventsFilePath(h.dir, c.canvasId)
        const before = readFileSync(file, 'utf-8').length
        h.svc.readState(c.canvasId, SID)
        h.svc.readState(c.canvasId, SID)
        h.svc.listCanvases(SID)
        expect(readFileSync(file, 'utf-8').length).toBe(before)
      } finally {
        h.dispose()
      }
    })

    it('附属事件随主事务落盘：user patch → DirtiedPathMarked；converge-check → ReviewConverged', () => {
      const h = makeService()
      try {
        const c = createCanvas(h.svc)
        expectOk(h.svc.mutate({ action: 'patch', params: { canvasId: c.canvasId, nodeId: c.rootId, content: '改述', reason: 'r' } }, 'user', SID))
        let events = readEvents(h.dir, c.canvasId)
        expect(events.filter((e) => e.type === 'DirtiedPathMarked')).toHaveLength(1)
        const g = growCanvas(h.svc, c, { o1Dispatchable: true })
        expectOk(h.svc.mutate({ action: 'select', params: { canvasId: g.canvasId, questionId: g.q1, optionId: g.o1, reason: 'r' } }, 'user', SID))
        expectOk(h.svc.mutate({ action: 'patch', params: { canvasId: g.canvasId, nodeId: g.o1, criterias: ['c'], reason: 'r' } }, 'user', SID))
        expectOk(h.svc.mutate({ action: 'transition', params: { canvasId: g.canvasId, nodeId: g.o1, to: 'under-review', reason: '提案' } }, 'agent', SID))
        expectOk(h.svc.mutate({ action: 'transition', params: { canvasId: g.canvasId, nodeId: g.o1, to: 'passed', reason: '过审' } }, 'user', SID))
        expectOk(h.svc.mutate({ action: 'review-request', params: { canvasId: g.canvasId } }, 'agent', SID))
        expectOk(h.svc.mutate({ action: 'converge-check', params: { canvasId: g.canvasId } }, 'user', SID))
        events = readEvents(h.dir, g.canvasId)
        expect(events.filter((e) => e.type === 'ReviewConverged')).toHaveLength(1)
        expect(events.filter((e) => e.type === 'ConvergenceChecked')).toHaveLength(1)
      } finally {
        h.dispose()
      }
    })

    it('reply 成功腿与广播同源同值（eventId / evType / summary 一致）', () => {
      const updates: Array<{ canvasId: string; evType: string; eventId: string; summary: string }> = []
      const h = makeService({ onUpdated: (u) => updates.push(u) })
      try {
        const c = createCanvas(h.svc)
        const reply = h.svc.mutate({ action: 'decide-direction', params: { canvasId: c.canvasId, direction: 'top-down', reason: 'r' } }, 'user', SID)
        expectOk(reply)
        expect(updates).toHaveLength(2) // create + decide-direction
        const last = updates[updates.length - 1]
        expect(reply.ok && reply.eventId).toBe(last?.eventId)
        expect(reply.ok && reply.evType).toBe(last?.evType)
        expect(reply.ok && reply.summary).toBe(last?.summary)
      } finally {
        h.dispose()
      }
    })

    it('mutate 收到查询类 action → invalid_params 引导到查询通道（不产事件）', () => {
      const h = makeService()
      try {
        const c = createCanvas(h.svc)
        const before = readEvents(h.dir, c.canvasId).length
        for (const action of ['read', 'list'] as const) {
          const reply = h.svc.mutate({ action, params: { canvasId: c.canvasId } as never }, 'user', SID)
          expect(reply.ok).toBe(false)
          if (!reply.ok) {
            expect(reply.error.code).toBe('invalid_params')
            expect(reply.error.recover).toBe(canvasError('invalid_params', '').recover)
          }
        }
        expect(readEvents(h.dir, c.canvasId)).toHaveLength(before)
      } finally {
        h.dispose()
      }
    })
  })
})

// ════════════════ 来源: canvas-ownership.test.ts ════════════════

describe('canvas-ownership', () => {
  describe('归属矩阵：跨会话拒绝（forbidden）', () => {
    it('B 会话 mutate A 的画布 → forbidden，恢复指引指回归属会话', () => {
      const h = makeService()
      try {
        const c = createCanvas(h.svc)
        const reply = h.svc.mutate({ action: 'patch', params: { canvasId: c.canvasId, nodeId: c.rootId, content: '越会话改写', reason: 'r' } }, 'user', SID_B)
        expectRejected(reply, 'forbidden')
        if (!reply.ok) {
          expect(reply.error.message).toContain(c.canvasId)
          expect(reply.error.message).toContain('归属会话')
          expect(reply.error.recover).toContain('归属会话')
        }
        // 拒绝后画布状态未被改动（写面零副作用）
        expect(c.state().root.statement).toBe('如何落地多引擎支持')
      } finally {
        h.dispose()
      }
    })

    it('B 会话 readState / enter（读全量）A 的画布 → forbidden（throw 形态）', () => {
      const h = makeService()
      try {
        const c = createCanvas(h.svc)
        expectThrown(() => h.svc.readState(c.canvasId, SID_B), 'forbidden')
      } finally {
        h.dispose()
      }
    })

    it('越权探测不泄漏存在性：未知 id 对任何会话都是 canvas_not_found（先存在性后归属的判定次序）', () => {
      const h = makeService()
      try {
        expectThrown(() => h.svc.readState('cvs-ghost', SID_B), 'canvas_not_found')
        expectRejected(h.svc.mutate({ action: 'patch', params: { canvasId: 'cvs-ghost', nodeId: 'n1', content: 'x', reason: 'r' } }, 'user', SID_B), 'canvas_not_found')
      } finally {
        h.dispose()
      }
    })

    it('非法 sessionId（路径穿越形态）create → invalid_params（树分区键同域校验先行）', () => {
      const h = makeService()
      try {
        expectRejected(h.svc.mutate({ action: 'create', params: { statement: 's', criterias: ['c'], scopeExclusions: [] } }, 'agent', '../evil'), 'invalid_params')
        // 零文件系统泄漏：非法分区键未触落盘
        expect(h.svc.listCanvases(SID).canvases).toHaveLength(0)
      } finally {
        h.dispose()
      }
    })
  })

  describe('归属矩阵：清单过滤与 1:N', () => {
    it('listCanvases(sid) 只返回归属该会话的画布（1:N 两张都在；B 清单为空）', () => {
      const h = makeService()
      try {
        const c1 = createCanvas(h.svc, 'agent', '画布一')
        const c2 = createCanvas(h.svc, 'agent', '画布二')
        const mine = h.svc.listCanvases(SID).canvases
        expect(mine.map((e) => e.canvasId).sort()).toEqual([c1.canvasId, c2.canvasId].sort())
        // 清单条目回显归属（CanvasListEntry.ownerSessionId）
        expect(mine.every((e) => e.ownerSessionId === SID)).toBe(true)
        // 跨会话清单为空（隔离：B 看不到 A 的任何画布）
        expect(h.svc.listCanvases(SID_B).canvases).toEqual([])
      } finally {
        h.dispose()
      }
    })

    it('多画布互不串分区：同会话两张画布各自独立落盘（1:N 由 canvasId 层承载）', () => {
      const h = makeService()
      try {
        const c1 = createCanvas(h.svc, 'agent', '画布一')
        const c2 = createCanvas(h.svc, 'agent', '画布二')
        growCanvas(h.svc, c1)
        expect(h.svc.readState(c1.canvasId, SID).nodes.length).toBeGreaterThan(1)
        expect(h.svc.readState(c2.canvasId, SID).nodes.length).toBe(1)
        expect(h.svc.readState(c1.canvasId, SID).name).toBe('画布一')
        expect(h.svc.readState(c2.canvasId, SID).name).toBe('画布二')
      } finally {
        h.dispose()
      }
    })
  })

  describe('归属矩阵：崩溃恢复回推（跨实例）', () => {
    it('runtime 重启后 owner 回推通道恢复、B 仍被拒（owner 持久在路径，重启不丢归属）', () => {
      const dir = makeTmpCanvasDir()
      const first = new CanvasService({ dataDir: dir })
      let canvasId = ''
      try {
        const c = createCanvas(first)
        canvasId = c.canvasId
      } finally {
        first.dispose()
      }
      // 模拟重启：新实例同树扫描重建
      const reborn = new CanvasService({ dataDir: dir })
      try {
        expect(reborn.getBoundSessions(canvasId)).toEqual([SID])
        expect(reborn.readState(canvasId, SID).canvasId).toBe(canvasId)
        // B 的写读在重启后依然被拒（归属随路径持久化，不随进程消亡）
        expectThrown(() => reborn.readState(canvasId, SID_B), 'forbidden')
        expectRejected(reborn.mutate({ action: 'patch', params: { canvasId, nodeId: reborn.readState(canvasId, SID).root.nodeId, content: 'x', reason: 'r' } }, 'user', SID_B), 'forbidden')
      } finally {
        reborn.dispose()
        removeDir(dir)
      }
    })
  })
})

// ════════════════ 来源: canvas-persistence.test.ts ════════════════

describe('canvas-persistence', () => {
  interface PersistedLine { // oe-exempt:20261015:framework:画布域类型契约（数据形状/端口/测试 harness，非抽象接口单实现）
    seq: number
    eventId: string
    type: string
    action: string
    actor: string
    at: string
    data: Record<string, unknown>
  }

  /** 画布域目录（D4 布局：`<dataDir>/ext-sessions/<SID>/canvases/`；断言经 shared SSOT 推导）。 */
  function canvasesRootOf(dir: string): string {
    return getSessionCanvasesDir(SID, dir)
  }

  function readLines(dir: string, canvasId: string): PersistedLine[] {
    return readFileSync(join(canvasesRootOf(dir), canvasId, 'events.jsonl'), 'utf-8')
      .split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l) as PersistedLine)
  }

  describe('快照 + 重放 ≡ 直写', () => {
    it('跨快照边界的事件流（> N 条）：新实例重建 ≡ 直写终态；删快照全量重放 ≡ 直写终态', () => {
      const h = makeService()
      try {
        const c = createCanvas(h.svc)
        // 累计跨过快照间隔的事件数（create 1 条 + 多轮 patch，每轮 patch(user) 产 2 条：附属 + 主）
        const rounds = Math.ceil((CANVAS_SNAPSHOT_INTERVAL + 7) / 2)
        for (let i = 0; i < rounds; i++) {
          expectOk(h.svc.mutate({ action: 'patch', params: { canvasId: c.canvasId, nodeId: c.rootId, content: `改述 v${i}`, reason: `第 ${i} 轮修订` } }, 'user', SID))
        }
        expect(c.state().dirtyPaths.length).toBeGreaterThan(0)
        const directWrite = h.svc.readState(c.canvasId, SID)
        expect(existsSync(join(canvasesRootOf(h.dir), c.canvasId, 'canvas.json'))).toBe(true)
        // 形状分叉守护：activeBindings（绑定徽标的 canvas.get 查询侧派生，transport 附加）
        // 不得进快照——绑定是 runtime 内存态，落盘会污染「快照可由事件流全量重放推导」
        // 的唯一权威承诺（CanvasState.activeBindings 契约注释）
        const snapState = (JSON.parse(readFileSync(join(canvasesRootOf(h.dir), c.canvasId, 'canvas.json'), 'utf-8')) as { state: Record<string, unknown> }).state
        expect(snapState).not.toHaveProperty('activeBindings')

        // 新实例（模拟 runtime 重启）从磁盘重建
        const reborn = new CanvasService({ dataDir: h.dir, generateId: (): string => 'replay-unused-id' })
        try {
          expect(reborn.readState(c.canvasId, SID)).toEqual(directWrite)
        } finally {
          reborn.dispose()
        }
        // 删除快照 → 全量重放路径（「一律以事件流为准」）
        rmSync(join(canvasesRootOf(h.dir), c.canvasId, 'canvas.json'))
        const fullReplay = new CanvasService({ dataDir: h.dir, generateId: (): string => 'replay-unused-id' })
        try {
          expect(fullReplay.readState(c.canvasId, SID)).toEqual(directWrite)
        } finally {
          fullReplay.dispose()
        }
      } finally {
        h.dispose()
      }
    })
  })

  describe('comment 事件重放 ≡ 直写（评论 id 随事件落盘按值恢复）', () => {
    it('含用户评论的画布重启重建（快照 + 增量重放 / 删快照全量重放）≡ 直写终态，评论 id 逐字还原', () => {
      const h = makeService()
      try {
        const c = createCanvas(h.svc)
        expectOk(h.svc.mutate({ action: 'comment', params: { canvasId: c.canvasId, anchorId: c.rootId, text: '根判据第二条可量化吗' } }, 'user', SID))
        const directWrite = h.svc.readState(c.canvasId, SID)
        expect(directWrite.comments).toHaveLength(1)
        // 新实例重建（模拟 runtime 重启）——comment 主事件不经附属事件过滤，重放必触
        // applyComment 的 id 生成点：按落盘 generated.commentId 恢复，不得触恒抛生成器
        const reborn = new CanvasService({ dataDir: h.dir, generateId: (): string => 'replay-unused-id' })
        try {
          const rebornState = reborn.readState(c.canvasId, SID)
          expect(rebornState).toEqual(directWrite)
          // 评论 id 逐字还原（`${anchorId}#c-<生成段>` 契约形态，非重造）
          expect(rebornState.comments[0]!.id).toBe(directWrite.comments[0]!.id)
        } finally {
          reborn.dispose()
        }
        // 删快照走全量重放分支（create + comment 未跨快照间隔，快照不存在为正常形态：
        // force 幂等删除——有则删、无则本用例等价于全量重放主链的重复验证）
        rmSync(join(canvasesRootOf(h.dir), c.canvasId, 'canvas.json'), { force: true })
        const fullReplay = new CanvasService({ dataDir: h.dir, generateId: (): string => 'replay-unused-id' })
        try {
          expect(fullReplay.readState(c.canvasId, SID)).toEqual(directWrite)
        } finally {
          fullReplay.dispose()
        }
      } finally {
        h.dispose()
      }
    })

    it('评论跨快照锚点两侧：锚点前评论由快照承载、锚点后评论走增量重放，重建 ≡ 直写', () => {
      const h = makeService()
      try {
        const c = createCanvas(h.svc)
        // 锚点前评论（快照将携带其状态，重放循环按 seq 跳过）
        expectOk(h.svc.mutate({ action: 'comment', params: { canvasId: c.canvasId, anchorId: c.rootId, text: '锚点前的议题' } }, 'user', SID))
        // 跨过快照间隔（每轮 user patch 产 2 条事件：附属 + 主）
        const rounds = Math.ceil((CANVAS_SNAPSHOT_INTERVAL + 3) / 2)
        for (let i = 0; i < rounds; i++) {
          expectOk(h.svc.mutate({ action: 'patch', params: { canvasId: c.canvasId, nodeId: c.rootId, content: `改述 v${i}`, reason: 'r' } }, 'user', SID))
        }
        // 锚点后评论（增量重放执行该 comment 行）
        expectOk(h.svc.mutate({ action: 'comment', params: { canvasId: c.canvasId, anchorId: c.rootId, text: '锚点后的议题' } }, 'user', SID))
        const directWrite = h.svc.readState(c.canvasId, SID)
        expect(directWrite.comments).toHaveLength(2)
        expect(existsSync(join(canvasesRootOf(h.dir), c.canvasId, 'canvas.json'))).toBe(true)
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

    it('comment 事件缺生成 id（事件流数据损坏）→ fail-fast 指向权威源，不静默另造 id', () => {
      const h = makeService()
      try {
        const c = createCanvas(h.svc)
        expectOk(h.svc.mutate({ action: 'comment', params: { canvasId: c.canvasId, anchorId: c.rootId, text: '议题' } }, 'user', SID))
        // 手工抹掉 comment 行的 generated（模拟损坏 / 非本服务产出的历史数据）
        const eventsFile = join(canvasesRootOf(h.dir), c.canvasId, 'events.jsonl')
        const stripped = readFileSync(eventsFile, 'utf-8')
          .split('\n').filter((l) => l.trim() !== '')
          .map((l) => {
            const ev = JSON.parse(l) as { action?: string; data: Record<string, unknown> }
            if (ev.action !== 'comment') return l
            const data = { ...ev.data }
            delete data.generated
            return JSON.stringify({ ...ev, data })
          })
        writeFileSync(eventsFile, `${stripped.join('\n')}\n`, 'utf-8')
        const reborn = new CanvasService({ dataDir: h.dir, generateId: (): string => 'u' })
        try {
          expectThrown(() => reborn.readState(c.canvasId, SID), 'invalid_params')
        } finally {
          reborn.dispose()
        }
      } finally {
        h.dispose()
      }
    })
  })

  describe('崩溃窗口截断重放一致性（锚点对齐守护用例）', () => {
    /** 构造带快照的画布：返回事件流全量行与快照文件路径。 */
    function buildEventStream(dir: string): { canvasId: string; lines: PersistedLine[]; total: number } {
      const svc = new CanvasService({ dataDir: dir, generateId: makeDeterministicId() })
      try {
        const c = createCanvas(svc)
        const rounds = Math.ceil((CANVAS_SNAPSHOT_INTERVAL + 13) / 2)
        for (let i = 0; i < rounds; i++) {
          expectOk(svc.mutate({ action: 'patch', params: { canvasId: c.canvasId, nodeId: c.rootId, content: `v${i}`, reason: 'r' } }, 'user', SID))
        }
        const lines = readLines(dir, c.canvasId)
        return { canvasId: c.canvasId, lines, total: lines.length }
      } finally {
        svc.dispose()
      }
    }

    function makeDeterministicId(): () => string {
      let i = 0
      return () => `d${++i}`
    }

    /** 在副本目录组装「崩溃窗口截断」现场：事件流前 k 行 + （若 k 覆盖到快照锚点）快照原样保留。 */
    function assembleTruncated(sourceDir: string, canvasId: string, lines: PersistedLine[], k: number, snapshotAnchor: number): string {
      const copy = mkdtempSync(join(tmpdir(), 'taiji-canvas-trunc-'))
      mkdirSync(join(canvasesRootOf(copy), canvasId), { recursive: true })
      writeFileSync(join(canvasesRootOf(copy), canvasId, 'events.jsonl'), lines.slice(0, k).map((l) => `${JSON.stringify(l)}\n`).join(''), 'utf-8')
      const snapSrc = join(canvasesRootOf(sourceDir), canvasId, 'canvas.json')
      if (k >= snapshotAnchor && existsSync(snapSrc)) copyFileSync(snapSrc, join(canvasesRootOf(copy), canvasId, 'canvas.json'))
      return copy
    }

    it('对多个截断点断言：锚点 ≤ 流末 eventId 且 重建 ≡ 截断流全量重放', () => {
      const src = makeTmpCanvasDir()
      try {
        const { canvasId, lines, total } = buildEventStream(src)
        const snapshotAnchor = Number((JSON.parse(readFileSync(join(canvasesRootOf(src), canvasId, 'canvas.json'), 'utf-8')) as { anchorEventId: string }).anchorEventId)
        // 锚点 = 首次跨过 N 倍数那批的流末 eventId（≥ N；锚点 ≤ 流末恒成立——快照永不超前）
        expect(snapshotAnchor).toBeGreaterThanOrEqual(CANVAS_SNAPSHOT_INTERVAL)
        expect(snapshotAnchor).toBeLessThanOrEqual(total)
        const truncationPoints = [10, CANVAS_SNAPSHOT_INTERVAL - 1, CANVAS_SNAPSHOT_INTERVAL, CANVAS_SNAPSHOT_INTERVAL + 7, total]
        for (const k of truncationPoints) {
          const copy = assembleTruncated(src, canvasId, lines, k, snapshotAnchor)
          try {
            const lastSeq = lines[k - 1]!.seq
            const snapPath = join(canvasesRootOf(copy), canvasId, 'canvas.json')
            if (k >= snapshotAnchor) {
              // 锚点对齐断言（唯一权威声明的守护断言）：快照锚点 ≤ 截断流末 eventId
              const anchor = Number((JSON.parse(readFileSync(snapPath, 'utf-8')) as { anchorEventId: string }).anchorEventId)
              expect(anchor, `截断点 ${k}：快照永不超前`).toBeLessThanOrEqual(lastSeq)
            }
            // 重建（快照 + 增量重放，快照存在时）
            const rebuilt = new CanvasService({ dataDir: copy, generateId: makeDeterministicId() })
            let rebuiltState
            try {
              rebuiltState = rebuilt.readState(canvasId, SID)
            } finally {
              rebuilt.dispose()
            }
            // 基准：截断流全量重放（删快照走「以事件流为准」路径）
            rmSync(snapPath, { force: true })
            const full = new CanvasService({ dataDir: copy, generateId: makeDeterministicId() })
            let fullState
            try {
              fullState = full.readState(canvasId, SID)
            } finally {
              full.dispose()
            }
            expect(rebuiltState, `截断点 ${k}：重建 ≡ 截断流全量重放`).toEqual(fullState)
            // 与直写前缀终态交叉核对：重建态的 updatedAt 事件序列与流一致（防两边同错）
            expect(rebuiltState.updatedAt).toBe(lines[k - 1]!.at)
          } finally {
            removeDir(copy)
          }
        }
      } finally {
        removeDir(src)
      }
    })

    it('快照滞后（事件已 append、快照未写——两写之间崩溃）：丢弃快照场景与增量重放场景皆 ≡ 直写', () => {
      const src = makeTmpCanvasDir()
      try {
        const svc = new CanvasService({ dataDir: src, generateId: ((): () => string => { let i = 0; return () => `d${++i}` })() })
        let canvasId: string
        try {
          const c = createCanvas(svc)
          canvasId = c.canvasId
          for (let i = 0; i < CANVAS_SNAPSHOT_INTERVAL / 2; i++) {
            expectOk(svc.mutate({ action: 'patch', params: { canvasId, nodeId: c.rootId, content: `v${i}`, reason: 'r' } }, 'user', SID))
          }
          // 恰在快照锚点：快照已写
          expectOk(svc.mutate({ action: 'patch', params: { canvasId, nodeId: c.rootId, content: 'final', reason: 'r' } }, 'user', SID))
        } finally {
          svc.dispose()
        }
        const directWrite = new CanvasService({ dataDir: src, generateId: ((): () => string => { let i = 0; return () => `x${++i}` })() })
        let expected
        try {
          expected = directWrite.readState(canvasId, SID)
        } finally {
          directWrite.dispose()
        }
        // 场景 A：快照仍在（滞后于流末）——增量重放收敛
        const withStaleSnap = new CanvasService({ dataDir: src, generateId: ((): () => string => { let i = 0; return () => `y${++i}` })() })
        try {
          expect(withStaleSnap.readState(canvasId, SID)).toEqual(expected)
        } finally {
          withStaleSnap.dispose()
        }
        // 场景 B：快照丢失（写失败 / 未及写）——全量重放收敛
        rmSync(join(canvasesRootOf(src), canvasId, 'canvas.json'))
        const noSnap = new CanvasService({ dataDir: src, generateId: ((): () => string => { let i = 0; return () => `z${++i}` })() })
        try {
          expect(noSnap.readState(canvasId, SID)).toEqual(expected)
        } finally {
          noSnap.dispose()
        }
      } finally {
        removeDir(src)
      }
    })

    it('锚点超前的快照（写入顺序违约的产物）被丢弃并全量重放——「一律以事件流为准」', () => {
      const h = makeService()
      try {
        const c = createCanvas(h.svc)
        const expected = h.svc.readState(c.canvasId, SID)
        // 手工构造超前快照：锚点 999 > 流末 1
        const snapPath = join(canvasesRootOf(h.dir), c.canvasId, 'canvas.json')
        writeFileSync(snapPath, JSON.stringify({ version: 1, anchorEventId: '999', state: { ...expected, converged: true, name: '被污染的快照' } }), 'utf-8')
        const reborn = new CanvasService({ dataDir: h.dir, generateId: (): string => 'u' })
        try {
          const state = reborn.readState(c.canvasId, SID)
          expect(state).toEqual(expected)
          expect(state.converged).toBe(false)
        } finally {
          reborn.dispose()
        }
      } finally {
        h.dispose()
      }
    })

    it('事件流行损坏 fail-fast（无更高权威可对，不静默跳过；启动扫描留痕不拖垮服务）', () => {
      const h = makeService()
      try {
        const c = createCanvas(h.svc)
        const eventsFile = join(canvasesRootOf(h.dir), c.canvasId, 'events.jsonl')
        writeFileSync(eventsFile, `${readFileSync(eventsFile, 'utf-8')}{broken-json\n`, 'utf-8')
        // 启动扫描：单画布损坏不拖垮服务（catch 留痕），但该画布读路径 fail-fast（指向权威源 events.jsonl）
        const reborn = new CanvasService({ dataDir: h.dir, generateId: (): string => 'u' })
        try {
          expect(() => reborn.readState(c.canvasId, SID)).toThrow(/行损坏/)
        } finally {
          reborn.dispose()
        }
      } finally {
        h.dispose()
      }
    })

    it('listCanvases 经重建恢复（冷启动托盘列表恢复——A5 场景的数据半边）', () => {
      const h = makeService()
      try {
        const c1 = createCanvas(h.svc, 'agent', '画布一')
        createCanvas(h.svc, 'agent', '画布二')
        const sortById = (l: { canvases: Array<{ canvasId: string }> }): Array<{ canvasId: string }> =>
          [...l.canvases].sort((a, b) => a.canvasId.localeCompare(b.canvasId))
        const listBefore = sortById(h.svc.listCanvases(SID))
        expect(listBefore).toHaveLength(2)
        const reborn = new CanvasService({ dataDir: h.dir, generateId: (): string => 'u' })
        try {
          expect(sortById(reborn.listCanvases(SID))).toEqual(listBefore)
          expect(reborn.readState(c1.canvasId, SID).name).toBe('画布一')
        } finally {
          reborn.dispose()
        }
      } finally {
        h.dispose()
      }
    })
  })

  describe('回推通道（owner 持久在落盘路径，D4 回推收窄）', () => {
    it('getBoundSessions = [owner]（回推对象即归属会话，创建即建立——无 enter 登记语义）', () => {
      const h = makeService()
      try {
        const c = createCanvas(h.svc)
        expect(h.svc.getBoundSessions(c.canvasId)).toEqual([SID])
      } finally {
        h.dispose()
      }
    })

    it('session 真删除摘内存经模块级分发（session-lifecycle delete 编排侧的调用目标）', () => {
      const h = makeService()
      try {
        const c1 = createCanvas(h.svc)
        const c2 = createCanvas(h.svc)
        unbindCanvasOnSessionDeleted(SID)
        // 摘内存 = 回推通道与读路径都不可达（磁盘树随 ext-sessions 整树回收归 u-deletion）
        expect(h.svc.getBoundSessions(c1.canvasId)).toEqual([])
        expect(h.svc.getBoundSessions(c2.canvasId)).toEqual([])
        expectThrown(() => h.svc.readState(c1.canvasId, SID), 'canvas_not_found')
        // 幂等：重复摘除无副作用
        unbindCanvasOnSessionDeleted(SID)
        expect(h.svc.getBoundSessions(c1.canvasId)).toEqual([])
      } finally {
        h.dispose()
      }
    })

    it('owner 持久在落盘路径：runtime 重启（新实例）后回推通道与归属校验即恢复（崩溃恢复回推语义）', () => {
      const h = makeService()
      try {
        const c = createCanvas(h.svc)
        const reborn = new CanvasService({ dataDir: h.dir, generateId: (): string => 'u' })
        try {
          expect(reborn.getBoundSessions(c.canvasId)).toEqual([SID])
          // owner 查询照常可达（重启不丢归属——路径即归属的构造性承载）
          expect(reborn.readState(c.canvasId, SID).canvasId).toBe(c.canvasId)
        } finally {
          reborn.dispose()
        }
      } finally {
        h.dispose()
      }
    })
  })

  describe('导出（exports/ 落盘 + 不变量 10 同校验）', () => {
    it('未收敛 export → not_converged 且无产物文件', () => {
      const h = makeService()
      try {
        const c = growCanvas(h.svc, createCanvas(h.svc))
        const reply = h.svc.mutate({ action: 'export', params: { canvasId: c.canvasId, target: { target: 'planning-doc' } } }, 'user', SID)
        expect(reply.ok).toBe(false)
        if (!reply.ok) {
          expect(reply.error.code).toBe('not_converged')
          expect(reply.error.recover).toContain('must-fix')
        }
        expect(existsSync(join(canvasesRootOf(h.dir), c.canvasId, 'exports'))).toBe(false)
      } finally {
        h.dispose()
      }
    })

    it('收敛后：方向规划文档落盘 exports/；需求卡五要素标题齐全；summary 含产物路径', () => {
      const h = makeService()
      try {
        const conv = buildConvergedCanvas(h.svc, createCanvas(h.svc))
        const doc = h.svc.mutate({ action: 'export', params: { canvasId: conv.canvasId, target: { target: 'planning-doc' } } }, 'user', SID)
        expectOk(doc)
        const card = h.svc.mutate({ action: 'export', params: { canvasId: conv.canvasId, target: { target: 'requirement-card', leafId: conv.leaf } } }, 'user', SID)
        expectOk(card)
        const exportsDir = join(canvasesRootOf(h.dir), conv.canvasId, 'exports')
        const files = readdirSync(exportsDir)
        expect(files.some((f) => f.startsWith('planning-doc-'))).toBe(true)
        expect(files.some((f) => f.startsWith(`requirement-card-${conv.leaf}-`))).toBe(true)
        const docContent = readFileSync(join(exportsDir, files.find((f) => f.startsWith('planning-doc-'))!), 'utf-8')
        expect(docContent).toContain('方向规划文档')
        expect(docContent).toContain('完成判据')
        expect(docContent).toContain('执行清单')
        const cardContent = readFileSync(join(exportsDir, files.find((f) => f.startsWith(`requirement-card-${conv.leaf}-`))!), 'utf-8')
        // 五要素：目标 / 上溯论证链 / 已排除方案及理由 / 关键论据引用 / 生效约束
        for (const section of ['1. 目标', '2. 上溯论证链', '3. 已排除方案及理由', '4. 关键论据引用', '5. 生效约束']) {
          expect(cardContent).toContain(section)
        }
        expect(doc.ok && doc.summary).toContain('exports/')
        // 导出是只读派生操作：画布状态不变（converged 保持、无图变更）
        expect(h.svc.readState(conv.canvasId, SID).converged).toBe(true)
      } finally {
        h.dispose()
      }
    })

    it('需求卡目标非执行叶子 → node_not_found', () => {
      const h = makeService()
      try {
        const conv = buildConvergedCanvas(h.svc, createCanvas(h.svc))
        const reply = h.svc.mutate({ action: 'export', params: { canvasId: conv.canvasId, target: { target: 'requirement-card', leafId: conv.q1 } } }, 'user', SID)
        expect(reply.ok).toBe(false)
        if (!reply.ok) expect(reply.error.code).toBe('node_not_found')
      } finally {
        h.dispose()
      }
    })
  })

  describe('子树读（readState subtree：节点 / 边 / 评论三维过滤）', () => {
    it('边锚评论随其所在边进入子树读（F1-12：锚点 = 节点 id 或边 id；两端点皆在子树内的边，其评论在）', () => {
      const h = makeService()
      try {
        const c = growCanvas(h.svc, createCanvas(h.svc))
        // argue 可指主干边（attachTo = 边 id）——grow 一条锚在 e-q1（root →(decompose) q1）上的反论据
        expectOk(h.svc.mutate({
          action: 'grow',
          params: { canvasId: c.canvasId, batch: [{ id: 'a1', type: 'argument', content: '该分解漏了迁移成本维度', attachTo: `e-${c.q1}`, edge: 'argue', edgePolarity: 'object' }], reason: '补反论据' },
        }, 'agent', SID))
        // 对该主干边评论（anchorId = 边 id——applyComment 合法允许）
        expectOk(h.svc.mutate({ action: 'comment', params: { canvasId: c.canvasId, anchorId: `e-${c.q1}`, text: '这条分解边存疑' } }, 'user', SID))
        // 子树读父节点 root（decompose 子树 = {root, q1}；边 e-q1 两端点皆在子树内 → 边与评论都应在）
        const sub = h.svc.readState(c.canvasId, SID, c.rootId)
        expect(sub.nodes.map((n) => n.id).sort()).toEqual([c.rootId, c.q1].sort())
        expect(sub.edges.map((e) => e.id)).toEqual([`e-${c.q1}`])
        expect(sub.comments.map((cm) => cm.anchorId)).toEqual([`e-${c.q1}`])
      } finally {
        h.dispose()
      }
    })

    it('逆例：锚点边跨越子树边界时评论不进入（端点在外 = 边本身已被过滤，评论与边同判据）', () => {
      const h = makeService()
      try {
        const c = growCanvas(h.svc, createCanvas(h.svc))
        // 评论锚在 resolve 边 e-o1（q1 → o1）：root 的 decompose 子树不含 o1，边与评论都不进
        expectOk(h.svc.mutate({ action: 'comment', params: { canvasId: c.canvasId, anchorId: 'e-o1', text: '这条 resolve 边对比充分吗' } }, 'user', SID))
        const sub = h.svc.readState(c.canvasId, SID, c.rootId)
        expect(sub.edges.map((e) => e.id)).not.toContain('e-o1')
        expect(sub.comments).toHaveLength(0)
      } finally {
        h.dispose()
      }
    })

    it('节点锚评论照常进入子树读（锚点在子树内的既有路径零回归）', () => {
      const h = makeService()
      try {
        const c = growCanvas(h.svc, createCanvas(h.svc))
        expectOk(h.svc.mutate({ action: 'comment', params: { canvasId: c.canvasId, anchorId: c.q1, text: '这里 MECE 吗' } }, 'user', SID))
        const sub = h.svc.readState(c.canvasId, SID, c.rootId)
        expect(sub.comments.map((cm) => cm.anchorId)).toEqual([c.q1])
      } finally {
        h.dispose()
      }
    })
  })
})

// ════════════════ 来源: canvas-review-loop.test.ts ════════════════

describe('canvas-review-loop', () => {
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

  describe('零发现轮（空 entries 写回也是审查结论——轮次推进与 max-rounds 预算不失灵）', () => {
    it('零发现写回（空 entries）→ lastRunRound 落聚合（无占位假条目污染 entries 消费方），再发起推进 R2', () => {
      const h = makeService()
      try {
        const c = growCanvas(h.svc, createCanvas(h.svc))
        expectOk(h.svc.mutate({ action: 'review-request', params: { canvasId: c.canvasId } }, 'agent', SID))
        expectOk(h.svc.mutate({ action: 'review-append', params: { canvasId: c.canvasId, round: 1, entries: [] } }, 'review', SID))
        expect(c.state().review?.entries).toHaveLength(0)
        expect(c.state().review?.lastRunRound).toBe(1)
        // 零发现轮完成 → 再发起推进 R2（修复前按条目存在判完成 → 卡死 R1、预算永不消耗）
        expectOk(h.svc.mutate({ action: 'review-request', params: { canvasId: c.canvasId } }, 'agent', SID))
        expect(c.state().review?.round).toBe(2)
        expect(c.state().review?.status).toBe('in-progress')
      } finally {
        h.dispose()
      }
    })

    it('连续零发现轮烧完预算 → 再发起触发 max-rounds 终态（停回保护对零发现形态生效）', () => {
      const h = makeService()
      try {
        const c = growCanvas(h.svc, createCanvas(h.svc))
        for (let round = 1; round <= 5; round++) {
          expectOk(h.svc.mutate({ action: 'review-request', params: { canvasId: c.canvasId } }, 'agent', SID))
          expect(c.state().review?.round).toBe(round)
          expectOk(h.svc.mutate({ action: 'review-append', params: { canvasId: c.canvasId, round, entries: [] } }, 'review', SID))
        }
        const reply = h.svc.mutate({ action: 'review-request', params: { canvasId: c.canvasId } }, 'agent', SID)
        expect(reply.ok).toBe(true)
        if (reply.ok) expect(reply.summary).toContain('停回')
        expect(c.state().review?.status).toBe('max-rounds')
        expect(c.state().review?.round).toBe(5)
        expect(c.state().review?.entries).toHaveLength(0)
        expect(readLines(h.dir, c.canvasId).map((l) => l.type)).toContain('ReviewMaxRoundsReached')
      } finally {
        h.dispose()
      }
    })

    it('直写 ≡ 重放：零发现轮的 lastRunRound 经 events.jsonl 重建一致，且重建侧完成判据照常推进轮次', () => {
      const h = makeService()
      try {
        const c = growCanvas(h.svc, createCanvas(h.svc))
        // 两轮零发现：R1 完成推进 R2、R2 完成待推进（直写态锚点）
        for (let round = 1; round <= 2; round++) {
          expectOk(h.svc.mutate({ action: 'review-request', params: { canvasId: c.canvasId } }, 'agent', SID))
          expectOk(h.svc.mutate({ action: 'review-append', params: { canvasId: c.canvasId, round, entries: [] } }, 'review', SID))
        }
        const directWrite: CanvasState = h.svc.readState(c.canvasId, SID)
        expect(directWrite.review?.round).toBe(2)
        expect(directWrite.review?.lastRunRound).toBe(2)
        const reborn = new CanvasService({ dataDir: h.dir, generateId: (): string => 'replay-unused-id' })
        try {
          expect(reborn.readState(c.canvasId, SID)).toEqual(directWrite)
          // 重放侧 lastRunRound 判据成立：重建后再发起 = 推进 R3（非卡死 R2）
          expectOk(reborn.mutate({ action: 'review-request', params: { canvasId: c.canvasId } }, 'agent', SID))
          expect(reborn.readState(c.canvasId, SID).review?.round).toBe(3)
        } finally {
          reborn.dispose()
        }
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
})

// ════════════════ 来源: canvas-state-machine.test.ts ════════════════

describe('canvas-state-machine', () => {
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
})
