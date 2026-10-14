/**
 * canvas 用户操作链单测（problem-solve-canvas §3.1(3) U7）——对话框规格与 mutate
 * 请求构造（纯函数；params 形状对 U1 契约的落点断言）。
 *
 * 覆盖：select（选定/换选 replace 迁移语义 + questionId 反查单处解析）/ reject
 * （transition + rejection 记录）/ transition / comment / patch（内容与判据多行解析）/
 * review-resolve / dispatch / decide-direction。
 *
 * 运行：cd packages/renderer && npx vitest run src/components/canvas/canvas-ops.test.ts
 */
import { describe, expect, it } from 'vitest'
import type { CanvasState } from '@zhushanwen/extension-protocol'
import { buildMutateRequest, opSpecOf } from './canvas-ops'

function makeState(overrides: Partial<CanvasState> = {}): CanvasState {
  return {
    canvasId: 'cvs-1',
    name: '测试画布',
    root: { nodeId: 'root', statement: '根问题', criterias: ['判据一'], scopeExclusions: [] },
    direction: null,
    nodes: [
      { id: 'root', type: 'question', content: '根问题', lifecycle: 'draft', createdAt: 'T0' },
      { id: 'q2', type: 'question', content: '子问题', lifecycle: 'draft', createdAt: 'T0' },
      { id: 'o1', type: 'option', content: '方案一', lifecycle: 'draft', createdAt: 'T0' },
      { id: 'o2', type: 'option', content: '方案二', lifecycle: 'draft', createdAt: 'T0' },
    ],
    edges: [
      { id: 'ed-1', type: 'decompose', from: 'root', to: 'q2' },
      { id: 'er-1', type: 'resolve', from: 'q2', to: 'o1' },
      { id: 'er-2', type: 'resolve', from: 'q2', to: 'o2' },
    ],
    comments: [],
    dirtyPaths: [],
    review: null,
    converged: false,
    createdAt: 'T0',
    updatedAt: 'T0',
    ...overrides,
  }
}

describe('opSpecOf（对话框规格）', () => {
  it('select：questionId 单处反查；无旧选定 → 普通选定标题', () => {
    const spec = opSpecOf('select', { state: makeState(), nodeId: 'o1' })
    expect(spec.questionId).toBe('q2')
    expect(spec.replacedOptionId).toBeUndefined()
    expect(spec.titleKey).toBe('panel.canvas.op.selectTitle')
  })

  it('select：已有旧选定 → 换选标题 + replace 上下文', () => {
    const replaced = opSpecOf('select', {
      state: makeState({
        nodes: makeState().nodes.map((n) => (n.id === 'o2' ? { ...n, selected: true } : n)),
      }),
      nodeId: 'o1',
    })
    expect(replaced.replacedOptionId).toBe('o2')
    expect(replaced.titleKey).toBe('panel.canvas.op.selectReplaceTitle')
  })

  it('reject：理由必填 + 复活条件可选', () => {
    const spec = opSpecOf('reject', { state: makeState(), nodeId: 'o1' })
    expect(spec.fields.map((f) => f.key)).toEqual(['reason', 'reviveCondition'])
    expect(spec.fields[0]!.required).toBe(true)
    expect(spec.fields[1]!.required).toBeFalsy()
  })

  it('resolve：处置三选一 + 说明必填，entryId 透传', () => {
    const spec = opSpecOf('resolve', { state: makeState(), entryId: 'e1' })
    expect(spec.entryId).toBe('e1')
    const disposition = spec.fields.find((f) => f.key === 'disposition')
    expect(disposition?.options?.map((o) => o.value)).toEqual(['accepted', 'deferred', 'rejected'])
  })
})

describe('buildMutateRequest（params 形状 = U1 契约）', () => {
  it('select 无旧选定：不带 replace', () => {
    const spec = opSpecOf('select', { state: makeState(), nodeId: 'o1' })
    const req = buildMutateRequest('cvs-1', spec, { reason: '对比后选一' })
    expect(req).toEqual({
      action: 'select',
      params: { canvasId: 'cvs-1', questionId: 'q2', optionId: 'o1', reason: '对比后选一' },
    })
  })

  it('select 换选：携带 replace.fromOptionId（不变量 3 迁移语义）', () => {
    const spec = opSpecOf('select', {
      state: makeState({
        nodes: makeState().nodes.map((n) => (n.id === 'o2' ? { ...n, selected: true } : n)),
      }),
      nodeId: 'o1',
    })
    const req = buildMutateRequest('cvs-1', spec, { reason: '换选理由' })
    expect(req.action === 'select' && req.params.replace).toEqual({ fromOptionId: 'o2' })
  })

  it('reject：transition + rejection 记录（可选复活条件仅在填写时携带）', () => {
    const spec = opSpecOf('reject', { state: makeState(), nodeId: 'o1' })
    const req = buildMutateRequest('cvs-1', spec, { reason: '成本不成立', reviveCondition: '预算变化' })
    expect(req).toEqual({
      action: 'transition',
      params: {
        canvasId: 'cvs-1',
        nodeId: 'o1',
        to: 'rejected',
        rejection: { reason: '成本不成立', reviveCondition: '预算变化' },
        reason: '成本不成立',
      },
    })
    const noRevive = buildMutateRequest('cvs-1', spec, { reason: '否' })
    expect(noRevive.action === 'transition' && noRevive.params.rejection).toEqual({ reason: '否' })
  })

  it('comment：锚定 = 目标节点', () => {
    const spec = opSpecOf('comment', { state: makeState(), nodeId: 'o2' })
    const req = buildMutateRequest('cvs-1', spec, { text: '会挤占吗' })
    expect(req).toEqual({ action: 'comment', params: { canvasId: 'cvs-1', anchorId: 'o2', text: '会挤占吗' } })
  })

  it('edit-criterias：多行原文解析为清单（trim + 去空行）', () => {
    const spec = opSpecOf('edit-criterias', { state: makeState(), nodeId: 'o1' })
    const req = buildMutateRequest('cvs-1', spec, { criterias: ' 判据A \n\n判据B', reason: '补判据' })
    expect(req.action === 'patch' && req.params.criterias).toEqual(['判据A', '判据B'])
    expect(req.action === 'patch' && req.params.reason).toBe('补判据')
  })

  it('resolve / dispatch / decide-direction 形状', () => {
    const resolve = buildMutateRequest(
      'cvs-1',
      opSpecOf('resolve', { state: makeState(), entryId: 'e1' }),
      { disposition: 'rejected', note: '不成立' },
    )
    expect(resolve).toEqual({
      action: 'review-resolve',
      params: { canvasId: 'cvs-1', entryId: 'e1', disposition: 'rejected', note: '不成立' },
    })
    const dispatch = buildMutateRequest(
      'cvs-1',
      opSpecOf('dispatch', { state: makeState(), nodeId: 'o1' }),
      { pointer: 'docs/req-card.md' },
    )
    expect(dispatch).toEqual({
      action: 'dispatch',
      params: { canvasId: 'cvs-1', nodeId: 'o1', pointer: 'docs/req-card.md' },
    })
    const direction = buildMutateRequest(
      'cvs-1',
      opSpecOf('decide-direction', { state: makeState() }),
      { direction: 'bottom-up', reason: '素材已齐' },
    )
    expect(direction).toEqual({
      action: 'decide-direction',
      params: { canvasId: 'cvs-1', direction: 'bottom-up', reason: '素材已齐' },
    })
  })
})
