/**
 * actor 权限矩阵执行 + 原子事务 + 幂等 upsert + 领域事件对账（problem-solve-canvas U2）。
 *
 * - 矩阵执行：CANVAS_ACTOR_MATRIX 全 48 格扫描——false 格 fail-fast（actor_not_allowed）、
 *   true 格合法场景执行成功（表外组合在服务入口被拦，对齐「单一词表防两个入口各自发明语义」）。
 * - 原子事务：grow 批内任一校验失败 = 整批拒绝、无部分写入。
 * - 幂等 upsert：grow/patch 节点 id 由 agent 侧生成，写入按 id upsert——崩溃窗口重试不产生
 *   重复节点（apply-then-respond 契约的重试安全半边）。
 * - 事件对账：ACTION_EVENT_MAP 每个 mutation action 至少产出一个事件（主事件映射对账
 *   SSOT）；read / list 为查询类不产事件、不在对账范围。
 */
import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ACTION_EVENT_MAP, CANVAS_ACTOR_MATRIX, canvasError } from '@zhushanwen/extension-protocol'
import type { CanvasAction, CanvasActor, CanvasMutateReply, CanvasState } from '@zhushanwen/extension-protocol'
import { CanvasService } from '../canvas-service.js'
import { createCanvas, expectOk, expectRejected, growCanvas, makeService, runActionHappyPath, type ServiceHandle } from './canvas-helpers.js'

const ALL_ACTIONS = Object.keys(CANVAS_ACTOR_MATRIX) as CanvasAction[]
const ALL_ACTORS: readonly CanvasActor[] = ['user', 'agent', 'review']
/** 矩阵 true 格的合法执行通道（read / list 走查询方法，不在 mutate 词表执行）。 */
const HAPPY_PATH_ACTIONS = Object.keys(ACTION_EVENT_MAP) as (keyof typeof ACTION_EVENT_MAP)[]

function eventsFilePath(dir: string, canvasId: string): string {
  return join(dir, canvasId, 'events.jsonl')
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
          const reply = h.svc.mutate(request, actor)
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
            const mutated = h.svc.mutate({ action, params: { canvasId: base.canvasId } as never }, actor)
            expect(mutated.ok, `${action} 经 mutate 应被引导到查询通道`).toBe(false)
            if (!mutated.ok) expect(mutated.error.code).toBe('invalid_params')
            expect(h.svc.readState(base.canvasId).canvasId).toBe(base.canvasId)
            expect(h.svc.listCanvases().canvases.length).toBeGreaterThan(0)
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
      }, 'agent')
      expect(reply.ok).toBe(false)
      if (!reply.ok) expect(reply.error.code).toBe('node_not_found')
      const state = h.svc.readState(c.canvasId)
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
      expect(h.svc.mutate({ action: 'grow', params }, 'agent').ok).toBe(true)
      const afterFirst = c.state()
      // 崩溃窗口重试：同 id 同内容再写一次
      expect(h.svc.mutate({ action: 'grow', params }, 'agent').ok).toBe(true)
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
      expect(h.svc.mutate({ action: 'select', params: { canvasId: g.canvasId, questionId: g.q1, optionId: g.o1, reason: '长期演进性优先' } }, 'user').ok).toBe(true)
      expect(h.svc.mutate({ action: 'patch', params: { canvasId: g.canvasId, nodeId: g.o1, criterias: ['抽象层单测覆盖率 ≥ 90%'], reason: '补判据' } }, 'user').ok).toBe(true)
      expect(h.svc.mutate({ action: 'transition', params: { canvasId: g.canvasId, nodeId: g.o1, to: 'under-review', reason: '提案' } }, 'agent').ok).toBe(true)
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
      }, 'agent')
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
      }, 'agent')
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
      expect(h.svc.mutate({ action: 'review-append', params: append }, 'review').ok).toBe(true)
      expect(h.svc.mutate({ action: 'review-resolve', params: { canvasId: c.canvasId, entryId: 'ent-1', disposition: 'accepted', note: '已补分支' } }, 'agent').ok).toBe(true)
      // 崩溃窗口重试 append：覆盖条目字段但保留 resolution（first-writer-wins 不被重试冲掉）
      expect(h.svc.mutate({ action: 'review-append', params: append }, 'review').ok).toBe(true)
      const entries = c.state().review?.entries ?? []
      expect(entries.filter((e) => e.id === 'ent-1')).toHaveLength(1)
      expect(entries[0]?.resolution?.by).toBe('agent')
      // 重试后 resolve 仍被 already_resolved 拦截
      const again = h.svc.mutate({ action: 'review-resolve', params: { canvasId: c.canvasId, entryId: 'ent-1', disposition: 'deferred', note: 'x' } }, 'user')
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
          reply: h.svc.mutate({ action: 'grow', params: { canvasId: c.canvasId, batch: [{ id: 'g1', type: 'question', content: '子问题', attachTo: c.rootId, edge: 'decompose' }], reason: '' } }, 'agent'),
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
          reply: h.svc.mutate({ action: 'patch', params: { canvasId: c.canvasId, nodeId: c.rootId, content: '改述后的问题', reason: '   ' } }, 'user'),
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
          reply: h.svc.mutate({ action: 'decide-direction', params: { canvasId: c.canvasId, direction: 'top-down', reason: '' } }, 'user'),
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
          reply: h.svc.mutate({ action: 'select', params: { canvasId: c.canvasId, questionId: c.q1, optionId: c.o1, reason: '  ' } }, 'user'),
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
          reply: h.svc.mutate({ action: 'transition', params: { canvasId: c.canvasId, nodeId: c.rootId, to: 'under-review', reason: '' } }, 'user'),
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
      h.svc.readState(c.canvasId)
      h.svc.readState(c.canvasId)
      h.svc.listCanvases()
      expect(readFileSync(file, 'utf-8').length).toBe(before)
    } finally {
      h.dispose()
    }
  })

  it('附属事件随主事务落盘：user patch → DirtiedPathMarked；converge-check → ReviewConverged', () => {
    const h = makeService()
    try {
      const c = createCanvas(h.svc)
      expectOk(h.svc.mutate({ action: 'patch', params: { canvasId: c.canvasId, nodeId: c.rootId, content: '改述', reason: 'r' } }, 'user'))
      let events = readEvents(h.dir, c.canvasId)
      expect(events.filter((e) => e.type === 'DirtiedPathMarked')).toHaveLength(1)
      const g = growCanvas(h.svc, c, { o1Dispatchable: true })
      expectOk(h.svc.mutate({ action: 'select', params: { canvasId: g.canvasId, questionId: g.q1, optionId: g.o1, reason: 'r' } }, 'user'))
      expectOk(h.svc.mutate({ action: 'patch', params: { canvasId: g.canvasId, nodeId: g.o1, criterias: ['c'], reason: 'r' } }, 'user'))
      expectOk(h.svc.mutate({ action: 'transition', params: { canvasId: g.canvasId, nodeId: g.o1, to: 'under-review', reason: '提案' } }, 'agent'))
      expectOk(h.svc.mutate({ action: 'transition', params: { canvasId: g.canvasId, nodeId: g.o1, to: 'passed', reason: '过审' } }, 'user'))
      expectOk(h.svc.mutate({ action: 'review-request', params: { canvasId: g.canvasId } }, 'agent'))
      expectOk(h.svc.mutate({ action: 'converge-check', params: { canvasId: g.canvasId } }, 'user'))
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
      const reply = h.svc.mutate({ action: 'decide-direction', params: { canvasId: c.canvasId, direction: 'top-down', reason: 'r' } }, 'user')
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
        const reply = h.svc.mutate({ action, params: { canvasId: c.canvasId } as never }, 'user')
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
