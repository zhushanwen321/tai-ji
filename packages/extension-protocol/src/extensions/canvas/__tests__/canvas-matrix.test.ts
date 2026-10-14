import { describe, it, expect } from 'vitest'
import { CANVAS_ACTIONS } from '../marker'
import { CANVAS_ACTOR_MATRIX, isActionAllowed } from '../matrix'
import type { CanvasActor, CanvasAction } from '../actions'

/**
 * U1 契约验收 ②：权限矩阵表外组合穷举为非法。
 *
 * 期望表逐格抄自设计文档 §3.1(1) 权限矩阵（权威源），不引用实现派生——
 * 实现与设计漂移时此处早炸。穷举 16 action × 3 actor = 48 格：
 * 合法格 isActionAllowed 必须 true，表外格（同 action 下其余 actor）必须 false。
 */
const EXPECTED_MATRIX: Record<CanvasAction, Record<CanvasActor, boolean>> = {
  create: { user: true, agent: true, review: false },
  grow: { user: false, agent: true, review: false },
  patch: { user: true, agent: true, review: false },
  'decide-direction': { user: true, agent: false, review: false },
  select: { user: true, agent: true, review: false },
  transition: { user: true, agent: true, review: false },
  comment: { user: true, agent: false, review: false },
  'comment-respond': { user: false, agent: true, review: false },
  'review-request': { user: true, agent: true, review: false },
  'review-append': { user: false, agent: false, review: true },
  'review-resolve': { user: true, agent: true, review: false },
  'converge-check': { user: true, agent: false, review: false },
  export: { user: true, agent: true, review: false },
  dispatch: { user: true, agent: false, review: false },
  read: { user: true, agent: true, review: true },
  list: { user: true, agent: true, review: true },
}

const ACTORS: CanvasActor[] = ['user', 'agent', 'review']

describe('U1 权限矩阵：逐格对齐设计 §3.1(1)', () => {
  it('U1 矩阵行键与 16 action 词表全等（无缺行、无多行）', () => {
    expect(Object.keys(CANVAS_ACTOR_MATRIX).sort()).toEqual([...CANVAS_ACTIONS].sort())
  })

  it('U1 全 48 格逐格断言（期望表 = 设计矩阵，非实现派生）', () => {
    for (const action of CANVAS_ACTIONS) {
      for (const actor of ACTORS) {
        expect(CANVAS_ACTOR_MATRIX[action][actor], `${action} × ${actor}`).toBe(
          EXPECTED_MATRIX[action][actor],
        )
      }
    }
  })

  it('U1 isActionAllowed 与矩阵全格一致', () => {
    for (const action of CANVAS_ACTIONS) {
      for (const actor of ACTORS) {
        expect(isActionAllowed(action, actor)).toBe(EXPECTED_MATRIX[action][actor])
      }
    }
  })

  it('U1 表外组合穷举为非法：非查询 action 的非授权 actor 全部拒绝', () => {
    for (const action of CANVAS_ACTIONS) {
      const denied = ACTORS.filter((actor) => !EXPECTED_MATRIX[action][actor])
      for (const actor of denied) {
        expect(isActionAllowed(action, actor), `${action} × ${actor} 应为表外拒绝`).toBe(false)
      }
    }
  })

  it('U1 查询类（read/list）全 actor 开放、其余 14 action 各有至少一个表外组合', () => {
    for (const action of CANVAS_ACTIONS) {
      const denied = ACTORS.filter((actor) => !EXPECTED_MATRIX[action][actor])
      if (action === 'read' || action === 'list') {
        expect(denied, `${action} 查询类应全开放`).toHaveLength(0)
      } else {
        expect(denied.length, `${action} 应有表外组合`).toBeGreaterThan(0)
      }
    }
  })

  it('U1 用户裁决性动作仅 user（decide-direction/comment/converge-check/dispatch）', () => {
    const userOnly: CanvasAction[] = ['decide-direction', 'comment', 'converge-check', 'dispatch']
    for (const action of userOnly) {
      expect(isActionAllowed(action, 'user')).toBe(true)
      expect(isActionAllowed(action, 'agent')).toBe(false)
      expect(isActionAllowed(action, 'review')).toBe(false)
    }
  })

  it('U1 review-append 仅 review（报告写回专属通道）', () => {
    expect(isActionAllowed('review-append', 'review')).toBe(true)
    expect(isActionAllowed('review-append', 'user')).toBe(false)
    expect(isActionAllowed('review-append', 'agent')).toBe(false)
  })

  it('U1 read / list 全 actor 开放（查询类）', () => {
    for (const action of ['read', 'list'] as const) {
      for (const actor of ACTORS) {
        expect(isActionAllowed(action, actor)).toBe(true)
      }
    }
  })

  it('U1 select 的 agent 格放行（语义约束落 prompt 指引层，runtime 按通道放行）', () => {
    expect(isActionAllowed('select', 'agent')).toBe(true)
  })
})
