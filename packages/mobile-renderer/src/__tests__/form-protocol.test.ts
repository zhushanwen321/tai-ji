// form-protocol 壳级收窄测试（shell/form-protocol.ts）。
//
// ui-form 线协议的编码契约断言已随纯逻辑单点迁移 @taiji/ui/form-protocol 契约测试
//（packages/ui/src/__tests__/form-protocol.test.ts）；本文件只锁移动壳特有的帧级消费面：
// - C4 富交互帧判定（form ∨ planReview 放行）
// - planReview 帧窄化与 selfReview 搬运
// - 问题集 / 草稿收窄检查（非法项过滤、形状检查失败 → null）
import { describe, expect, it } from 'vitest'
import type { ExtensionUIRequest } from '@taiji/core/transport/api/domains/extension'
import {
  formQuestionsOf,
  isPlanReviewFrame,
  isRichInteractionFrame,
  scheduleDraftOf,
} from '../shell/form-protocol'

function choiceReq(overrides: Partial<ExtensionUIRequest> = {}): ExtensionUIRequest {
  return {
    sessionId: 'sid-a',
    requestId: 'req-1',
    dialogKind: 'select',
    form: true,
    formQuestions: [
      { type: 'choice', question: '用哪个数据库？', options: [{ label: 'pg' }, { label: 'mysql' }] },
    ],
    ...overrides,
  }
}

describe('帧标记检查与字段收窄', () => {
  it('isRichInteractionFrame：form/planReview 放行；普通 dialog 帧拒绝；非对象安全 false', () => {
    expect(isRichInteractionFrame({ form: true })).toBe(true)
    expect(isRichInteractionFrame({ planReview: true })).toBe(true)
    expect(isRichInteractionFrame({ kind: 'select', options: ['a'] })).toBe(false)
    expect(isRichInteractionFrame(null)).toBe(false)
    expect(isRichInteractionFrame('form')).toBe(false)
  })

  it('isPlanReviewFrame 窄化 + selfReview 搬运；formQuestionsOf 过滤非法项；scheduleDraftOf 收窄', () => {
    const planFrame = { ...choiceReq(), planReview: true, selfReview: '自审结论' } as unknown as ExtensionUIRequest
    expect(isPlanReviewFrame(planFrame)).toBe(true)

    const mixed = choiceReq({
      formQuestions: [
        { type: 'choice', question: 'q1', options: [{ label: 'a' }] },
        { type: 'alien' },
        'not-an-object',
      ],
    })
    const qs = formQuestionsOf(mixed)
    expect(qs).toHaveLength(1)
    expect(formQuestionsOf({ ...choiceReq(), form: undefined })).toEqual([])

    const draft = { kind: 'once' as const, schedule: '30 14 2 10 *', prompt: 'p', models: ['m1'] }
    const draftReq = choiceReq({ scheduleCreate: true, scheduleDraft: draft })
    expect(scheduleDraftOf(draftReq)).not.toBeNull()
    expect(scheduleDraftOf(choiceReq({ scheduleCreate: true, scheduleDraft: { broken: true } }))).toBeNull()
    expect(scheduleDraftOf(choiceReq())).toBeNull()
  })
})
