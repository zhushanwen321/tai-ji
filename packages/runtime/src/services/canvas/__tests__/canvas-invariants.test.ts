/**
 * 不变量 1-11 逐条正逆用例（problem-solve-canvas U2 验收条款）。
 *
 * 不变量权威 = 概念文档（.tmp/problem-solve-canvas.md）§2.5 聚合 1（画布）不变量清单；
 * 聚合 2（审查报告）不变量并入 review-append / review-resolve 用例。
 * MVP 边界：constrain / reference 边不在词表（不变量 6 退化为构造性满足，见对应用例）。
 */
import { describe, expect, it } from 'vitest'
import { readdirSync } from 'node:fs'
import { ACTION_EVENT_MAP, CANVAS_ACTIONS } from '@zhushanwen/extension-protocol'
import { convergenceBlockers, dispatchableLeaves, findTrunkCycle, isQuestionReady, isRootReady, pathToRoot, subtreeOf } from '../canvas-domain.js'
import { renderPlanningDoc } from '../canvas-export.js'
import { CanvasService } from '../canvas-service.js'
import { createCanvas, expectRejected, expectThrown, growCanvas, makeService, buildAllGreenCanvas, type ServiceHandle } from './canvas-helpers.js'

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
      const reply = h.svc.mutate({ action: 'create', params: { statement: 'X', criterias: [], scopeExclusions: [] } }, 'agent')
      expectRejected(reply, 'invalid_params')
    } finally {
      h.dispose()
    }
  })

  it('逆例：statement 为空白 → create 拒绝', () => {
    const h = makeService()
    try {
      const reply = h.svc.mutate({ action: 'create', params: { statement: '   ', criterias: ['c'], scopeExclusions: [] } }, 'agent')
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
      }, 'agent')
      expect(grow.ok).toBe(true)
      expect(h.svc.readState(c.canvasId).edges).toHaveLength(2)
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
      }, 'agent')
      expectRejected(reply, 'invalid_params')
      if (!reply.ok) expect(reply.error.message).toContain('patch')
      // 原子事务：整批拒绝，x / y 均不得落盘
      const state = h.svc.readState(c.canvasId)
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
      const reply = h.svc.mutate({ action: 'select', params: { canvasId: c.canvasId, questionId: c.q1, optionId: c.o1, reason: '演进性优先' } }, 'user')
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
      expect(h.svc.mutate({ action: 'select', params: { canvasId: c.canvasId, questionId: c.q1, optionId: c.o1, reason: 'r' } }, 'user').ok).toBe(true)
      const reply = h.svc.mutate({ action: 'select', params: { canvasId: c.canvasId, questionId: c.q1, optionId: c.o2, reason: 'r2' } }, 'user')
      expectRejected(reply, 'selection_conflict')
    } finally {
      h.dispose()
    }
  })

  it('正例：replace 换选 = 同一调用事务内迁出旧 selected 再置新', () => {
    const h = makeService()
    try {
      const c = growCanvas(h.svc, createCanvas(h.svc))
      expect(h.svc.mutate({ action: 'select', params: { canvasId: c.canvasId, questionId: c.q1, optionId: c.o1, reason: 'r1' } }, 'user').ok).toBe(true)
      const reply = h.svc.mutate({ action: 'select', params: { canvasId: c.canvasId, questionId: c.q1, optionId: c.o2, replace: { fromOptionId: c.o1 }, reason: '改选 o2：成本更低' } }, 'user')
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
      expect(h.svc.mutate({ action: 'select', params: { canvasId: c.canvasId, questionId: c.q1, optionId: c.o1, reason: 'r1' } }, 'user').ok).toBe(true)
      const reply = h.svc.mutate({ action: 'select', params: { canvasId: c.canvasId, questionId: c.q1, optionId: c.o2, replace: { fromOptionId: c.o2 }, reason: 'r' } }, 'user')
      expectRejected(reply, 'invalid_params')
    } finally {
      h.dispose()
    }
  })

  it('逆例：option 与 question 无 resolve 边相连 → invalid_params', () => {
    const h = makeService()
    try {
      const c = createCanvas(h.svc)
      const reply = h.svc.mutate({ action: 'select', params: { canvasId: c.canvasId, questionId: c.rootId, optionId: 'ghost', reason: 'r' } }, 'user')
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
      expect(h.svc.mutate({ action: 'select', params: { canvasId: c.canvasId, questionId: c.q1, optionId: c.o1, reason: '演进性优先' } }, 'user').ok).toBe(true)
      expect(c.state().nodes.find((n) => n.id === c.o1)?.selected).toBe(true)
      // 否决链（draft → under-review → rejected，与不变量 4 用例同款合法转移）
      expect(h.svc.mutate({ action: 'transition', params: { canvasId: c.canvasId, nodeId: c.o1, to: 'under-review', reason: '提案' } }, 'agent').ok).toBe(true)
      expect(h.svc.mutate({ action: 'transition', params: { canvasId: c.canvasId, nodeId: c.o1, to: 'rejected', rejection: { reason: '成本超预算' }, reason: '用户否决当前选定' } }, 'user').ok).toBe(true)
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
      const reborn = new CanvasService({ canvasesDir: h.dir, generateId: (): string => 'u' })
      try {
        expect(reborn.readState(c.canvasId).nodes.find((n) => n.id === c.o1)?.selected).toBe(false)
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
      expect(h.svc.mutate({ action: 'select', params: { canvasId: c.canvasId, questionId: c.q1, optionId: c.o1, reason: 'r1' } }, 'user').ok).toBe(true)
      expect(h.svc.mutate({ action: 'transition', params: { canvasId: c.canvasId, nodeId: c.o1, to: 'shelved', reason: '暂缓该方案' } }, 'user').ok).toBe(true)
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
      expect(h.svc.mutate({ action: 'transition', params: { canvasId: c.canvasId, nodeId: c.o2, to: 'under-review', reason: '提案' } }, 'agent').ok).toBe(true)
      expect(h.svc.mutate({ action: 'transition', params: { canvasId: c.canvasId, nodeId: c.o2, to: 'rejected', rejection: { reason: '成本不可接受' }, reason: '审查否决' } }, 'user').ok).toBe(true)
      const reply = h.svc.mutate({ action: 'transition', params: { canvasId: c.canvasId, nodeId: c.o2, to: 'passed', reason: '越级转 passed' } }, 'user')
      expectRejected(reply, 'lifecycle_transition_illegal')
    } finally {
      h.dispose()
    }
  })

  it('正例：rejected → draft 复活（留理由），否决记录灰显保留', () => {
    const h = makeService()
    try {
      const c = growCanvas(h.svc, createCanvas(h.svc))
      expect(h.svc.mutate({ action: 'transition', params: { canvasId: c.canvasId, nodeId: c.o2, to: 'under-review', reason: '提案' } }, 'agent').ok).toBe(true)
      expect(h.svc.mutate({ action: 'transition', params: { canvasId: c.canvasId, nodeId: c.o2, to: 'rejected', rejection: { reason: '成本不可接受', reviveCondition: '成本下降 50%' }, reason: '审查否决' } }, 'user').ok).toBe(true)
      const revive = h.svc.mutate({ action: 'transition', params: { canvasId: c.canvasId, nodeId: c.o2, to: 'draft', reason: '新证据：缓存方案使成本减半（用户裁决复活）' } }, 'user')
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
      expect(h.svc.mutate({ action: 'patch', params: { canvasId: c.canvasId, nodeId: c.o1, criterias: ['覆盖率 ≥ 90%'], reason: '补判据' } }, 'user').ok).toBe(true)
      expect(h.svc.mutate({
        action: 'grow',
        params: { canvasId: c.canvasId, batch: [{ id: 'arg1', type: 'argument', content: '基准测试显示内存占用减半', attachTo: c.o1, edge: 'argue', edgePolarity: 'support', materiality: 'fact', factVerified: true }], reason: '补支撑论据' },
      }, 'agent').ok).toBe(true)
      expect(h.svc.mutate({ action: 'transition', params: { canvasId: c.canvasId, nodeId: c.o1, to: 'under-review', reason: '提案' } }, 'agent').ok).toBe(true)
      const reply = h.svc.mutate({ action: 'transition', params: { canvasId: c.canvasId, nodeId: c.o1, to: 'passed', reason: '审查通过' } }, 'user')
      expect(reply.ok).toBe(true)
    } finally {
      h.dispose()
    }
  })

  it('逆例：未核实 fact 论据支撑 → passed 拒绝（unverified_fact）', () => {
    const h = makeService()
    try {
      const c = growCanvas(h.svc, createCanvas(h.svc), { o1Dispatchable: true })
      expect(h.svc.mutate({ action: 'patch', params: { canvasId: c.canvasId, nodeId: c.o1, criterias: ['覆盖率 ≥ 90%'], reason: '补判据' } }, 'user').ok).toBe(true)
      expect(h.svc.mutate({
        action: 'grow',
        params: { canvasId: c.canvasId, batch: [{ id: 'arg1', type: 'argument', content: '基准测试显示内存占用减半', attachTo: c.o1, edge: 'argue', edgePolarity: 'support', materiality: 'fact' }], reason: '补支撑论据（未核实）' },
      }, 'agent').ok).toBe(true)
      expect(h.svc.mutate({ action: 'transition', params: { canvasId: c.canvasId, nodeId: c.o1, to: 'under-review', reason: '提案' } }, 'agent').ok).toBe(true)
      const reply = h.svc.mutate({ action: 'transition', params: { canvasId: c.canvasId, nodeId: c.o1, to: 'passed', reason: '审查通过' } }, 'user')
      expectRejected(reply, 'unverified_fact')
      // 恢复动作可操作：补核实后重试 → 放行
      expect(h.svc.mutate({ action: 'patch', params: { canvasId: c.canvasId, nodeId: 'arg1', factVerified: true, reason: '已复核基准数据' } }, 'agent').ok).toBe(true)
      expect(h.svc.mutate({ action: 'transition', params: { canvasId: c.canvasId, nodeId: c.o1, to: 'passed', reason: '审查通过' } }, 'user').ok).toBe(true)
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
      }, 'agent')
      expectRejected(drifted, 'invalid_params')
      if (!drifted.ok) expect(drifted.error.message).toContain('support | object')
      // 素材性词表外值同口径拒绝
      const badMateriality = h.svc.mutate({
        action: 'grow',
        params: { canvasId: c.canvasId, batch: [{ id: 'arg-mat', type: 'argument', content: 'x', attachTo: c.o1, edge: 'argue', edgePolarity: 'support', materiality: 'Fact' }], reason: '补论据' } as never,
      }, 'agent')
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
      }, 'agent').ok).toBe(true)
      expect(h.svc.mutate({ action: 'patch', params: { canvasId: c.canvasId, nodeId: c.o1, criterias: ['覆盖率 ≥ 90%'], reason: '补判据' } }, 'user').ok).toBe(true)
      expect(h.svc.mutate({ action: 'transition', params: { canvasId: c.canvasId, nodeId: c.o1, to: 'under-review', reason: '提案' } }, 'agent').ok).toBe(true)
      expectRejected(h.svc.mutate({ action: 'transition', params: { canvasId: c.canvasId, nodeId: c.o1, to: 'passed', reason: '审查通过' } }, 'user'), 'unverified_fact')
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
      }, 'agent').ok).toBe(true)
      const a1 = h.svc.readState(c.canvasId).nodes.find((n) => n.id === 'a1')
      expect(a1?.materiality).toBe('fact')
      expect(a1?.factVerified).toBe(false)
      // claim 论据不带核实状态字段要求
      expect(h.svc.mutate({
        action: 'grow',
        params: { canvasId: c.canvasId, batch: [{ id: 'a2', type: 'argument', content: 'y', attachTo: c.rootId, edge: 'argue', edgePolarity: 'object' }], reason: 'r' },
      }, 'agent').ok).toBe(true)
      const a2 = h.svc.readState(c.canvasId).nodes.find((n) => n.id === 'a2')
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
      expect(h.svc.mutate({ action: 'grow', params: { canvasId: c.canvasId, batch: [{ id: 'a1', type: 'argument', content: '目标论据', attachTo: c.o1, edge: 'argue', edgePolarity: 'support' }], reason: '落支撑论据' } }, 'agent').ok).toBe(true)
      // rebut 缺极性：拒绝（工具描述「REQUIRED when edge is argue/rebut」的 runtime 兑现）
      const rejected = h.svc.mutate({ action: 'grow', params: { canvasId: c.canvasId, batch: [{ id: 'a2', type: 'argument', content: '反驳论据', attachTo: 'a1', edge: 'rebut' }], reason: '反驳目标论据' } }, 'agent')
      expectRejected(rejected, 'invalid_params')
      expect(c.state().nodes.some((n) => n.id === 'a2')).toBe(false)
      // 带极性重试：落库
      expect(h.svc.mutate({ action: 'grow', params: { canvasId: c.canvasId, batch: [{ id: 'a2', type: 'argument', content: '反驳论据', attachTo: 'a1', edge: 'rebut', edgePolarity: 'object' }], reason: '反驳目标论据' } }, 'agent').ok).toBe(true)
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
      expect(h.svc.mutate({ action: 'transition', params: { canvasId: c.canvasId, nodeId: c.o1, to: 'under-review', reason: '提案' } }, 'agent').ok).toBe(true)
      const reply = h.svc.mutate({ action: 'transition', params: { canvasId: c.canvasId, nodeId: c.o1, to: 'passed', reason: '跳过判据' } }, 'user')
      expectRejected(reply, 'lifecycle_transition_illegal')
    } finally {
      h.dispose()
    }
  })

  it('逆例：未 passed → dispatch 拒绝（dispatch_blocked）', () => {
    const h = makeService()
    try {
      const c = growCanvas(h.svc, createCanvas(h.svc), { o1Dispatchable: true })
      const reply = h.svc.mutate({ action: 'dispatch', params: { canvasId: c.canvasId, nodeId: c.o1, pointer: 'docs/req-card.md' } }, 'user')
      expectRejected(reply, 'dispatch_blocked')
    } finally {
      h.dispose()
    }
  })

  it('正例：passed + 判据 → dispatch 成功且下游指针可见（用户可见断言：readState 的 dispatch.pointer）', () => {
    const h = makeService()
    try {
      const c = growCanvas(h.svc, createCanvas(h.svc), { o1Dispatchable: true })
      expect(h.svc.mutate({ action: 'patch', params: { canvasId: c.canvasId, nodeId: c.o1, criterias: ['覆盖率 ≥ 90%'], reason: '补判据' } }, 'user').ok).toBe(true)
      expect(h.svc.mutate({ action: 'transition', params: { canvasId: c.canvasId, nodeId: c.o1, to: 'under-review', reason: '提案' } }, 'agent').ok).toBe(true)
      expect(h.svc.mutate({ action: 'transition', params: { canvasId: c.canvasId, nodeId: c.o1, to: 'passed', reason: '审查通过' } }, 'user').ok).toBe(true)
      const reply = h.svc.mutate({ action: 'dispatch', params: { canvasId: c.canvasId, nodeId: c.o1, pointer: 'sessions/design-leaf-o1' } }, 'user')
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
      const reply = h.svc.mutate({ action: 'dispatch', params: { canvasId: c.canvasId, nodeId: c.o2, pointer: 'x' } }, 'user')
      expectRejected(reply, 'dispatch_blocked')
    } finally {
      h.dispose()
    }
  })

  it('逆例：pointer 空串（含纯空白）→ invalid_params 且 node.dispatch 不落（不变量 7：下游产物指针必填）', () => {
    const h = makeService()
    try {
      const c = growCanvas(h.svc, createCanvas(h.svc), { o1Dispatchable: true })
      expect(h.svc.mutate({ action: 'patch', params: { canvasId: c.canvasId, nodeId: c.o1, criterias: ['覆盖率 ≥ 90%'], reason: '补判据' } }, 'user').ok).toBe(true)
      expect(h.svc.mutate({ action: 'transition', params: { canvasId: c.canvasId, nodeId: c.o1, to: 'under-review', reason: '提案' } }, 'agent').ok).toBe(true)
      expect(h.svc.mutate({ action: 'transition', params: { canvasId: c.canvasId, nodeId: c.o1, to: 'passed', reason: '审查通过' } }, 'user').ok).toBe(true)
      const reply = h.svc.mutate({ action: 'dispatch', params: { canvasId: c.canvasId, nodeId: c.o1, pointer: '   ' } }, 'user')
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
      const added = h.svc.mutate({ action: 'comment', params: { canvasId: c.canvasId, anchorId: c.q1, text: '独立窗口会被挤占吗' } }, 'user')
      expect(added.ok).toBe(true)
      const pending = c.state().comments[0]
      expect(pending?.status).toBe('pending')
      if (!added.ok) return
      const commentId = (c.state().comments[0] as { id: string }).id
      expect(commentId).toBeTruthy()
      const respond = h.svc.mutate({ action: 'comment-respond', params: { canvasId: c.canvasId, commentId, disposition: 'adopted', note: '采纳：补独立窗口候选 o3 并留对比' } }, 'agent')
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
      expect(h.svc.mutate({ action: 'comment', params: { canvasId: c.canvasId, anchorId: c.rootId, text: 'q' } }, 'user').ok).toBe(true)
      const commentId = c.state().comments[0]!.id
      expect(h.svc.mutate({ action: 'comment-respond', params: { canvasId: c.canvasId, commentId, disposition: 'rebutted', note: '反驳理由：范围排除已含此项' } }, 'agent').ok).toBe(true)
      const reply = h.svc.mutate({ action: 'comment-respond', params: { canvasId: c.canvasId, commentId, disposition: 'adopted', note: '再次响应' } }, 'agent')
      expectRejected(reply, 'invalid_params')
    } finally {
      h.dispose()
    }
  })

  it('构造性满足：转已响应的唯一通道 comment-respond 强制 note 留痕（空 note 拒绝）', () => {
    const h = makeService()
    try {
      const c = createCanvas(h.svc)
      expect(h.svc.mutate({ action: 'comment', params: { canvasId: c.canvasId, anchorId: c.rootId, text: 'q' } }, 'user').ok).toBe(true)
      const commentId = c.state().comments[0]!.id
      const reply = h.svc.mutate({ action: 'comment-respond', params: { canvasId: c.canvasId, commentId, disposition: 'adopted', note: '   ' } }, 'agent')
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
      const reply = h.svc.mutate({ action: 'patch', params: { canvasId: c.canvasId, nodeId: c.q1, content: '引擎抽象层怎么设计（修订）', reason: '用户改述' } }, 'user')
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
      const reply = h.svc.mutate({ action: 'patch', params: { canvasId: c.canvasId, nodeId: c.q1, content: 'x', reason: 'agent 修复' } }, 'agent')
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
      }, 'agent').ok).toBe(true)
      expect(h.svc.mutate({ action: 'select', params: { canvasId: c.canvasId, questionId: c.q1, optionId: c.o1, reason: 'r1' } }, 'user').ok).toBe(true)
      // 上一条 select 已 dirty；发起审查消费（清空）后再换选，隔离本轮断言
      expect(h.svc.mutate({ action: 'review-request', params: { canvasId: c.canvasId } }, 'agent').ok).toBe(true)
      expect(c.state().dirtyPaths).toHaveLength(0)
      const reply = h.svc.mutate({ action: 'select', params: { canvasId: c.canvasId, questionId: c.q1, optionId: c.o2, replace: { fromOptionId: c.o1 }, reason: '换选 o2' } }, 'user')
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
      expect(h.svc.mutate({ action: 'comment', params: { canvasId: c.canvasId, anchorId: c.q1, text: '这里 MECE 吗' } }, 'user').ok).toBe(true)
      expect(c.state().dirtyPaths).toContain(c.q1)
      // 锚边：decompose 边 id = e-<子节点id>（边 id 确定性派生自子节点）
      expect(h.svc.mutate({ action: 'review-request', params: { canvasId: c.canvasId } }, 'agent').ok).toBe(true)
      expect(h.svc.mutate({ action: 'comment', params: { canvasId: c.canvasId, anchorId: `e-${c.q1}`, text: '这条分解边存疑' } }, 'user').ok).toBe(true)
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
      const r1 = h.svc.mutate({ action: 'converge-check', params: { canvasId: c.canvasId } }, 'user')
      expectRejected(r1, 'not_converged')
      if (r1.ok) return
      expect(r1.error.message).toContain('就绪递归未成立')
      // 补齐选定 + 判据 + passed + 消费 dirty，但留下未处置 must-fix
      expect(h.svc.mutate({ action: 'select', params: { canvasId: c.canvasId, questionId: c.q1, optionId: c.o1, reason: 'r' } }, 'user').ok).toBe(true)
      expect(h.svc.mutate({ action: 'patch', params: { canvasId: c.canvasId, nodeId: c.o1, criterias: ['c1'], reason: '判据' } }, 'user').ok).toBe(true)
      expect(h.svc.mutate({ action: 'transition', params: { canvasId: c.canvasId, nodeId: c.o1, to: 'under-review', reason: '提案' } }, 'agent').ok).toBe(true)
      expect(h.svc.mutate({ action: 'transition', params: { canvasId: c.canvasId, nodeId: c.o1, to: 'passed', reason: '过审' } }, 'user').ok).toBe(true)
      expect(h.svc.mutate({ action: 'review-request', params: { canvasId: c.canvasId } }, 'agent').ok).toBe(true)
      expect(h.svc.mutate({
        action: 'review-append',
        params: { canvasId: c.canvasId, round: 1, entries: [{ id: 'mf1', round: 1, dimension: 'completeness', severity: 'must-fix', targetId: c.q1, note: '缺一条分解分支' }] },
      }, 'review').ok).toBe(true)
      const r2 = h.svc.mutate({ action: 'converge-check', params: { canvasId: c.canvasId } }, 'user')
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
      expect(h.svc.mutate({ action: 'select', params: { canvasId: c.canvasId, questionId: c.q1, optionId: c.o1, reason: 'r' } }, 'user').ok).toBe(true)
      expect(h.svc.mutate({ action: 'transition', params: { canvasId: c.canvasId, nodeId: c.o1, to: 'under-review', reason: '提案' } }, 'agent').ok).toBe(true)
      expect(h.svc.mutate({ action: 'transition', params: { canvasId: c.canvasId, nodeId: c.o1, to: 'passed', reason: '过审' } }, 'user').ok).toBe(true)
      expect(h.svc.mutate({ action: 'review-request', params: { canvasId: c.canvasId } }, 'agent').ok).toBe(true)
      const reply = h.svc.mutate({ action: 'converge-check', params: { canvasId: c.canvasId } }, 'user')
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
      expect(h.svc.mutate({ action: 'select', params: { canvasId: c.canvasId, questionId: c.q1, optionId: c.o1, reason: 'r' } }, 'user').ok).toBe(true)
      expect(h.svc.mutate({ action: 'patch', params: { canvasId: c.canvasId, nodeId: c.o1, criterias: ['c1'], reason: '判据' } }, 'user').ok).toBe(true)
      expect(h.svc.mutate({ action: 'transition', params: { canvasId: c.canvasId, nodeId: c.o1, to: 'under-review', reason: '提案' } }, 'agent').ok).toBe(true)
      expect(h.svc.mutate({ action: 'transition', params: { canvasId: c.canvasId, nodeId: c.o1, to: 'passed', reason: '过审' } }, 'user').ok).toBe(true)
      expect(h.svc.mutate({ action: 'review-request', params: { canvasId: c.canvasId } }, 'agent').ok).toBe(true)
      expect(convergenceBlockers(c.state())).toHaveLength(0)
      const reply = h.svc.mutate({ action: 'converge-check', params: { canvasId: c.canvasId } }, 'user')
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
      const beforeConfirm = h.svc.mutate({ action: 'export', params: { canvasId: c.canvasId, target: { target: 'planning-doc' } } }, 'agent')
      expectRejected(beforeConfirm, 'not_converged')
      if (!beforeConfirm.ok) expect(beforeConfirm.error.message).toContain('收敛确认')
      // 收敛确认后导出放行
      expect(h.svc.mutate({ action: 'converge-check', params: { canvasId: c.canvasId } }, 'user').ok).toBe(true)
      const afterConfirm = h.svc.mutate({ action: 'export', params: { canvasId: c.canvasId, target: { target: 'planning-doc' } } }, 'agent')
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
      'broadcast',
      'bindSession',
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
      }, 'review')
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
      }, 'review').ok).toBe(true)
      expect(h.svc.mutate({ action: 'review-resolve', params: { canvasId: c.canvasId, entryId: 'e1', disposition: 'deferred', note: '登记后做' } }, 'agent').ok).toBe(true)
      const reply = h.svc.mutate({ action: 'review-resolve', params: { canvasId: c.canvasId, entryId: 'e1', disposition: 'accepted', note: '改判尝试' } }, 'user')
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
        expectThrown(() => h.svc.readState(id), 'invalid_params')
        // mutate 入口（reply 失败腿形态——领域拒绝不抛）
        expectRejected(h.svc.mutate({ action: 'patch', params: { canvasId: id, nodeId: 'n1', content: 'x', reason: 'r' } }, 'user'), 'invalid_params')
        // 绑定入口（throw 形态）
        expectThrown(() => h.svc.bindSession('sess-a', id), 'invalid_params')
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
      expectThrown(() => h.svc.readState('cvs-doesnotexist'), 'canvas_not_found')
    } finally {
      h.dispose()
    }
  })
})
