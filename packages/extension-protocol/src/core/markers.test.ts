/**
 * markers.test.ts — core marker 常量契约校验
 *
 * marker 是跨层魔法字符串（extension 写入 select title ↔ runtime event-adapter 检测），
 * 值漂移 = 路由静默失效（双端各自编译通过但互相对不上）。本测试锁定值形态：
 * NUL 前缀 + TAIJI_ 命名空间 + 冒号结尾（与 GUI_WIDGET_MARKER 同族形态）。
 */
import { describe, it, expect } from 'vitest'
import { GUI_WIDGET_MARKER, PLAN_REVIEW_MARKER } from './markers'
import type { PlanDocMeta, PlanReviewRequest, PlanReviewResponse } from './types'

describe('core markers', () => {
  it('PLAN_REVIEW_MARKER 与 GUI_WIDGET_MARKER 同族形态（NUL 前缀 + 冒号结尾）', () => {
    expect(PLAN_REVIEW_MARKER).toBe('\x00TAIJI_PLAN_REVIEW:')
    expect(PLAN_REVIEW_MARKER.startsWith('\x00')).toBe(true)
    expect(PLAN_REVIEW_MARKER.endsWith(':')).toBe(true)
  })

  it('plan 审阅 payload/decision 类型可赋值（判别联合收窄编译断言）', () => {
    // 运行期仅验证类型导入存在与字面量可构造；形状精确性由消费侧（extension/
    // runtime/前端）与 shared 契约测试（plan-protocol.test.ts）共同守卫
    const request: PlanReviewRequest = {
      docs: [{ fileName: 'design.md', absPath: '/tmp/design.md', sourceSkill: 'tech-design', version: 1 }],
    }
    const responses: PlanReviewResponse[] = [
      { decision: 'approve' },
      { decision: 'revise', comments: [{ quote: '划选段落', comment: '这里要补充权衡' }] },
      { decision: 'explain', comments: [{ quote: 'q', comment: '解释一下' }] },
    ]
    expect(request.docs[0]?.sourceSkill).toBe('tech-design')
    expect(responses).toHaveLength(3)
    const meta: PlanDocMeta = { fileName: 'a.md', absPath: '/a.md', sourceSkill: '', version: 1 }
    expect(meta.version).toBe(1)
  })
})
