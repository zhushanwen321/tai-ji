/**
 * canvas 单测共享设施：tmp 目录（自建自删，fs-guard 白名单内）、确定性 id 序列、
 * 画布构造 helper（各阶段形态的画布推进）。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect } from 'vitest'
import { CanvasService } from '../canvas-service.js'
import { isCanvasDomainError } from '../canvas-domain.js'
import type { CanvasMutateReply, CanvasState } from '@zhushanwen/extension-protocol'

export function makeTmpCanvasDir(): string {
  return mkdtempSync(join(tmpdir(), 'taiji-canvas-test-'))
}

export function removeDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
}

/** 确定性 id 序列（n1, n2, ...）——canvasId 随之为 cvs-n1 形态，重放断言可复核。 */
export function makeSeqIdGen(): () => string {
  let i = 0
  return () => `n${++i}`
}

export interface ServiceHandle { // oe-exempt:20261015:framework:画布域类型契约（数据形状/端口/测试 harness，非抽象接口单实现）
  svc: CanvasService
  dir: string
  dispose: () => void
}

export function makeService(opts?: { onUpdated?: (u: { canvasId: string; evType: string; eventId: string; summary: string }) => void }): ServiceHandle {
  const dir = makeTmpCanvasDir()
  const svc = new CanvasService({ canvasesDir: dir, generateId: makeSeqIdGen(), onUpdated: opts?.onUpdated })
  return { svc, dir, dispose: (): void => { svc.dispose(); removeDir(dir) } }
}

export interface TestCanvas { // oe-exempt:20261015:framework:画布域类型契约（数据形状/端口/测试 harness，非抽象接口单实现）
  canvasId: string
  rootId: string
  state: () => CanvasState
}

/** 最小画布：根三要素。 */
export function createCanvas(svc: CanvasService, actor: 'user' | 'agent' = 'agent', statement = '如何落地多引擎支持'): TestCanvas {
  const reply = svc.mutate({ action: 'create', params: { statement, criterias: ['四引擎全部可用且互切无感'], scopeExclusions: ['不做引擎自研'] } }, actor)
  if (!reply.ok) throw new Error(`create 失败：${JSON.stringify(reply.error)}`)
  const canvasId = reply.canvasId as string
  return { canvasId, rootId: svc.readState(canvasId).root.nodeId, state: () => svc.readState(canvasId) }
}

export interface GrownCanvas extends TestCanvas { // oe-exempt:20261015:framework:画布域类型契约（数据形状/端口/测试 harness，非抽象接口单实现）
  q1: string
  o1: string
  o2: string
}

/** 标准生长画布：root →(decompose) q1 →(resolve) {o1, o2}（o1 为后续 select/审查的目标）。 */
export function growCanvas(svc: CanvasService, base: TestCanvas, opts?: { o1Dispatchable?: boolean }): GrownCanvas {
  const q1 = 'q1'
  const o1 = 'o1'
  const o2 = 'o2'
  const grow = svc.mutate({
    action: 'grow',
    params: {
      canvasId: base.canvasId,
      batch: [
        { id: q1, type: 'question', content: '引擎层抽象怎么设计', attachTo: base.rootId, edge: 'decompose' },
        { id: o1, type: 'option', content: '混合形态', attachTo: q1, edge: 'resolve', dispatchable: opts?.o1Dispatchable },
        { id: o2, type: 'option', content: '单一形态', attachTo: q1, edge: 'resolve' },
      ],
      reason: '按 MECE 分解引擎层',
    },
  }, 'agent')
  if (!grow.ok) throw new Error(`grow 失败：${JSON.stringify(grow.error)}`)
  return { ...base, q1, o1, o2 }
}

export interface ConvergedCanvas extends GrownCanvas { // oe-exempt:20261015:framework:画布域类型契约（数据形状/端口/测试 harness，非抽象接口单实现）
  leaf: string
}

/** 推进到「三门禁全绿但未收敛」的画布（converge-check / export 门禁测试的前置形态）。 */
export function buildAllGreenCanvas(svc: CanvasService, base: TestCanvas): ConvergedCanvas {
  const g = growCanvas(svc, base, { o1Dispatchable: true })
  const select = svc.mutate({ action: 'select', params: { canvasId: g.canvasId, questionId: g.q1, optionId: g.o1, reason: '长期演进性优于单形态的短期实现速度' } }, 'user')
  if (!select.ok) throw new Error(`select 失败：${JSON.stringify(select.error)}`)
  const patch = svc.mutate({ action: 'patch', params: { canvasId: g.canvasId, nodeId: g.o1, criterias: ['抽象层单测覆盖率 ≥ 90%'], reason: '补执行叶子判据' } }, 'user')
  if (!patch.ok) throw new Error(`patch 失败：${JSON.stringify(patch.error)}`)
  const propose = svc.mutate({ action: 'transition', params: { canvasId: g.canvasId, nodeId: g.o1, to: 'under-review', reason: '提案进入审查' } }, 'agent')
  if (!propose.ok) throw new Error(`transition(under-review) 失败：${JSON.stringify(propose.error)}`)
  const transition = svc.mutate({ action: 'transition', params: { canvasId: g.canvasId, nodeId: g.o1, to: 'passed', reason: '审查通过：判据齐备且支撑论据已核实' } }, 'user')
  if (!transition.ok) throw new Error(`transition 失败：${JSON.stringify(transition.error)}`)
  // 发起审查（agent）——同时消费清空 select/patch 产生的待重审路径。
  const review = svc.mutate({ action: 'review-request', params: { canvasId: g.canvasId } }, 'agent')
  if (!review.ok) throw new Error(`review-request 失败：${JSON.stringify(review.error)}`)
  return { ...g, leaf: g.o1 }
}

/** 推进到收敛终态的画布（converge-check 成功路径的完整前置链）。 */
export function buildConvergedCanvas(svc: CanvasService, base: TestCanvas): ConvergedCanvas {
  const green = buildAllGreenCanvas(svc, base)
  const converge = svc.mutate({ action: 'converge-check', params: { canvasId: green.canvasId } }, 'user')
  if (!converge.ok) throw new Error(`converge-check 失败：${JSON.stringify(converge.error)}`)
  return green
}

/**
 * per-action 合法执行场景（矩阵 true 格与事件对账共用）：独立推进画布到该 action 的
 * 最小合法前置，以指定 actor 执行并期待 ok。返回 reply（含 canvasId / evType）。
 */
export function runActionHappyPath(
  svc: CanvasService,
  action: 'create' | 'grow' | 'patch' | 'decide-direction' | 'select' | 'transition' | 'comment' | 'comment-respond' | 'review-request' | 'review-append' | 'review-resolve' | 'converge-check' | 'export' | 'dispatch',
  actor: 'user' | 'agent' | 'review',
): { ok: true; canvasId: string; evType: string; eventId: string; summary: string } {
  const base = createCanvas(svc)
  const exec = (reply: ReturnType<CanvasService['mutate']>): { ok: true; canvasId: string; evType: string; eventId: string; summary: string } => {
    if (!reply.ok) throw new Error(`runActionHappyPath(${action}/${actor}) 失败：${JSON.stringify(reply.error)}`)
    return { ...reply, canvasId: reply.canvasId as string }
  }
  switch (action) {
    case 'create':
      return exec(svc.mutate({ action: 'create', params: { statement: '独立画布', criterias: ['c1'], scopeExclusions: [] } }, actor as 'user' | 'agent'))
    case 'grow':
      return exec(svc.mutate({ action: 'grow', params: { canvasId: base.canvasId, batch: [{ id: 'g1', type: 'question', content: 'g', attachTo: base.rootId, edge: 'decompose' }], reason: 'r' } }, actor as 'agent'))
    case 'patch':
      return exec(svc.mutate({ action: 'patch', params: { canvasId: base.canvasId, nodeId: base.rootId, content: '改述后的问题', reason: 'r' } }, actor as 'user' | 'agent'))
    case 'decide-direction':
      return exec(svc.mutate({ action: 'decide-direction', params: { canvasId: base.canvasId, direction: 'top-down', reason: '目标清晰' } }, actor as 'user'))
    case 'select': {
      const g = growCanvas(svc, base)
      return exec(svc.mutate({ action: 'select', params: { canvasId: g.canvasId, questionId: g.q1, optionId: g.o1, reason: 'r' } }, actor as 'user' | 'agent'))
    }
    case 'transition':
      return exec(svc.mutate({ action: 'transition', params: { canvasId: base.canvasId, nodeId: base.rootId, to: 'under-review', reason: '提案' } }, actor as 'user' | 'agent'))
    case 'comment':
      return exec(svc.mutate({ action: 'comment', params: { canvasId: base.canvasId, anchorId: base.rootId, text: '议题' } }, actor as 'user'))
    case 'comment-respond': {
      expectOk(svc.mutate({ action: 'comment', params: { canvasId: base.canvasId, anchorId: base.rootId, text: '议题' } }, 'user'))
      const commentId = svc.readState(base.canvasId).comments[0]!.id
      return exec(svc.mutate({ action: 'comment-respond', params: { canvasId: base.canvasId, commentId, disposition: 'adopted', note: '落实说明' } }, actor as 'agent'))
    }
    case 'review-request':
      return exec(svc.mutate({ action: 'review-request', params: { canvasId: base.canvasId } }, actor as 'user' | 'agent'))
    case 'review-append':
      return exec(svc.mutate({ action: 'review-append', params: { canvasId: base.canvasId, round: 1, entries: [{ id: 'e1', round: 1, dimension: 'completeness', severity: 'must-fix', targetId: base.rootId, note: '缺口' }] } }, actor as 'review'))
    case 'review-resolve': {
      expectOk(svc.mutate({ action: 'review-append', params: { canvasId: base.canvasId, round: 1, entries: [{ id: 'e1', round: 1, dimension: 'completeness', severity: 'must-fix', targetId: base.rootId, note: '缺口' }] } }, 'review'))
      return exec(svc.mutate({ action: 'review-resolve', params: { canvasId: base.canvasId, entryId: 'e1', disposition: 'accepted', note: '已修复' } }, actor as 'user' | 'agent'))
    }
    case 'converge-check': {
      const green = buildAllGreenCanvas(svc, base)
      return exec(svc.mutate({ action: 'converge-check', params: { canvasId: green.canvasId } }, actor as 'user'))
    }
    case 'export': {
      const conv = buildConvergedCanvas(svc, base)
      return exec(svc.mutate({ action: 'export', params: { canvasId: conv.canvasId, target: { target: 'planning-doc' } } }, actor as 'user' | 'agent'))
    }
    case 'dispatch': {
      const conv = buildConvergedCanvas(svc, base)
      return exec(svc.mutate({ action: 'dispatch', params: { canvasId: conv.canvasId, nodeId: conv.leaf, pointer: 'downstream/design' } }, actor as 'user'))
    }
  }
}

export function expectOk(reply: ReturnType<CanvasService['mutate']>): void {
  if (!reply.ok) throw new Error(`前置动作失败：${JSON.stringify(reply.error)}`)
}

/** 领域拒绝断言：期待 mutate 返回指定错误码的失败腿。 */
export function expectRejected(reply: CanvasMutateReply, code: string): void {
  expect(reply.ok).toBe(false)
  if (reply.ok) return
  expect(reply.error.code).toBe(code)
  // 恢复动作文案非空（分级错误处理契约：错误 → 恢复动作闭环）
  expect(reply.error.recover.length).toBeGreaterThan(0)
}

/** 领域拒绝断言（throw 形态——readState 等查询方法）。 */
export function expectThrown(fn: () => unknown, code: string): void {
  try {
    fn()
  } catch (e: unknown) {
    if (isCanvasDomainError(e)) {
      expect(e.detail.code).toBe(code)
      return
    }
    throw e
  }
  throw new Error(`期待抛出 ${code}，但未抛错`)
}
