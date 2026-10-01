/**
 * useComposerSubmit 单元测试。
 *
 * 被测对象：domain/composer/dispatch/submit.ts —— onFollowUp / onAbort。
 *
 * [退役] onSteer 与 submit() 包装已随 message.steer 协议腿退役同批删除（过度设计审计
 * 候选 8，msg-pipeline-debloat D6-3）：onSteer 的 boolean 契约用例与 submit() 的
 * catch → restoreInput 用例随被测符号一并移除，onFollowUp 契约保持。
 *
 * 运行：cd packages/core && npx vitest run src/domain/composer/dispatch/submit.test.ts
 */
import { describe, it, expect, vi } from 'vitest'
import { computed, ref } from 'vue'
import { useComposerSubmit } from './submit'
import type { Segment } from '@taiji/shared'

const SEGMENTS: Segment[] = [
  { type: 'text', text: '补充说明' },
  { type: 'skill', name: 'code-review' },
] as unknown as Segment[]

function setup(over: Partial<{ hasInput: boolean; followUpReturn: boolean }> = {}) {
  const ctrl = {
    hasInput: true,
    followUpReturn: true,
    ...over,
  }
  const spies = {
    getSegments: vi.fn((): Segment[] => SEGMENTS),
    clearInput: vi.fn(() => {}),
    restoreSegments: vi.fn((_segments: Segment[]) => {}),
    followUp: vi.fn(async (_sid: string, _segments: Segment[]) => ctrl.followUpReturn),
    abort: vi.fn(async (_sid: string) => {}),
  }
  const submit = useComposerSubmit({
    hasInput: computed(() => ctrl.hasInput),
    inputRef: ref({ getSegments: spies.getSegments }),
    sessionIdRef: computed(() => 's1'),
    clearInput: spies.clearInput,
    restoreSegments: spies.restoreSegments,
    followUp: spies.followUp,
    abort: spies.abort,
  })
  return { submit, spies, ctrl }
}

describe('onFollowUp — 失败信号消费契约', () => {
  it('onFollowUp → followUp(sid, segments) + clearInput，成功不恢复', async () => {
    const { submit, spies } = setup()
    await submit.onFollowUp()
    expect(spies.followUp).toHaveBeenCalledWith('s1', SEGMENTS)
    expect(spies.clearInput).toHaveBeenCalledTimes(1)
    expect(spies.restoreSegments).not.toHaveBeenCalled()
  })

  it('followUp 返回 false（RPC 失败）→ restoreSegments(SEGMENTS) 恢复完整草稿', async () => {
    const { submit, spies } = setup({ followUpReturn: false })
    await submit.onFollowUp()
    expect(spies.followUp).toHaveBeenCalledTimes(1)
    expect(spies.clearInput).toHaveBeenCalledTimes(1)
    // 快照 segments 完整回滚（text + chips——restoreSegments 恢复输入文本并重插 chip）
    expect(spies.restoreSegments).toHaveBeenCalledWith(SEGMENTS)
  })

  it('segments 先快照后 clearInput（清空 DOM 前提取，同 onSend 快照范式）', async () => {
    const { submit, spies } = setup()
    await submit.onFollowUp()
    expect(spies.getSegments.mock.invocationCallOrder[0]).toBeLessThan(
      spies.clearInput.mock.invocationCallOrder[0]!,
    )
  })

  it('无输入（hasInput=false）→ 不触发 followUp', async () => {
    const { submit, spies } = setup({ hasInput: false })
    await submit.onFollowUp()
    expect(spies.followUp).not.toHaveBeenCalled()
    expect(spies.clearInput).not.toHaveBeenCalled()
  })
})

describe('onAbort', () => {
  it('onAbort → abort(sessionId)', async () => {
    const { submit, spies } = setup()
    await submit.onAbort()
    expect(spies.abort).toHaveBeenCalledWith('s1')
  })
})
