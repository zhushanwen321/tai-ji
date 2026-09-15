/**
 * useComposerSubmit 单元测试（[D2] onSteer 消费 steer boolean 契约为主）。
 *
 * 被测对象：domain/composer/dispatch/submit.ts —— onSteer / onFollowUp / submit / onAbort。
 *
 * [D2] useChat.steer 错误策略改「catch + toast + return false」后不抛错，submit() 的
 * catch → restoreInput → rethrow 对 onSteer 成为 dead path——onSteer 分支内直接消费
 * boolean，失败 restoreSegments 恢复完整草稿（text + chips，与 send.ts routeSteer 同款）。
 * 本文件锁定该行为；onFollowUp 继续走 submit 的 sender 包装（followUp 内部 catch 不抛，
 * rethrow 契约保持给真实 throw 的 sender）。
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

function setup(over: Partial<{ hasInput: boolean; isActive: boolean; steerReturn: boolean }> = {}) {
  const ctrl = {
    hasInput: true,
    isActive: true,
    steerReturn: true,
    ...over,
  }
  const spies = {
    getSegments: vi.fn((): Segment[] => SEGMENTS),
    clearInput: vi.fn(() => {}),
    restoreInput: vi.fn((_text: string) => {}),
    restoreSegments: vi.fn((_segments: Segment[]) => {}),
    steer: vi.fn(async (_sid: string, _segments: Segment[]) => ctrl.steerReturn),
    followUp: vi.fn(async (_sid: string, _segments: Segment[]) => {}),
    abort: vi.fn(async (_sid: string) => {}),
  }
  const submit = useComposerSubmit({
    hasInput: computed(() => ctrl.hasInput),
    isActive: computed(() => ctrl.isActive),
    draft: ref('补充说明'),
    inputRef: ref({ getSegments: spies.getSegments }),
    sessionIdRef: computed(() => 's1'),
    clearInput: spies.clearInput,
    restoreInput: spies.restoreInput,
    restoreSegments: spies.restoreSegments,
    steer: spies.steer,
    followUp: spies.followUp,
    abort: spies.abort,
  })
  return { submit, spies, ctrl }
}

describe('onSteer — [D2] 消费 steer boolean 契约', () => {
  it('steer 返回 true → 正常投递：clearInput 一次、不恢复草稿', async () => {
    const { submit, spies } = setup({ steerReturn: true })
    await submit.onSteer()
    expect(spies.steer).toHaveBeenCalledWith('s1', SEGMENTS)
    expect(spies.clearInput).toHaveBeenCalledTimes(1)
    expect(spies.restoreSegments).not.toHaveBeenCalled()
    expect(spies.restoreInput).not.toHaveBeenCalled()
  })

  it('steer 返回 false（RPC 失败，WS 断连）→ restoreSegments(SEGMENTS) 恢复完整草稿', async () => {
    const { submit, spies } = setup({ steerReturn: false })
    await submit.onSteer()
    expect(spies.steer).toHaveBeenCalledTimes(1)
    expect(spies.clearInput).toHaveBeenCalledTimes(1)
    // 快照 segments 完整回滚（text + chips——restoreSegments 恢复输入文本并重插 chip）
    expect(spies.restoreSegments).toHaveBeenCalledWith(SEGMENTS)
  })

  it('segments 先快照后 clearInput（清空 DOM 前提取，同 onSend 快照范式）', async () => {
    const { submit, spies } = setup({ steerReturn: true })
    await submit.onSteer()
    expect(spies.getSegments.mock.invocationCallOrder[0]).toBeLessThan(
      spies.clearInput.mock.invocationCallOrder[0]!,
    )
  })

  it('无输入（hasInput=false）→ 不触发 steer', async () => {
    const { submit, spies } = setup({ hasInput: false })
    await submit.onSteer()
    expect(spies.steer).not.toHaveBeenCalled()
    expect(spies.clearInput).not.toHaveBeenCalled()
  })

  it('非活跃态（isActive=false）→ 不触发 steer', async () => {
    const { submit, spies } = setup({ isActive: false })
    await submit.onSteer()
    expect(spies.steer).not.toHaveBeenCalled()
    expect(spies.clearInput).not.toHaveBeenCalled()
  })
})

describe('onFollowUp / submit — 既有契约不受 D2 影响', () => {
  it('onFollowUp → followUp(sid, segments) + clearInput，成功不恢复', async () => {
    const { submit, spies } = setup()
    await submit.onFollowUp()
    expect(spies.followUp).toHaveBeenCalledWith('s1', SEGMENTS)
    expect(spies.clearInput).toHaveBeenCalledTimes(1)
    expect(spies.restoreInput).not.toHaveBeenCalled()
  })

  it('submit：sender 抛错 → restoreInput(text) + rethrow（followUp 通道既有契约保持）', async () => {
    const { submit, spies } = setup()
    await expect(
      submit.submit('草稿文本', () => {
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
    expect(spies.restoreInput).toHaveBeenCalledWith('草稿文本')
  })
})
