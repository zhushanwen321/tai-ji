/**
 * useComposerForkMode 单元测试。
 *
 * 被测对象：domain/composer/dispatch/fork-mode.ts（D8 泛化后 = createStagingMode 的 fork
 * 配置 + 薄包装）。行为骨架已由 staging-mode.test.ts 覆盖，本测试锁 fork 特有契约：
 * - enterForkMode 记录 { srcSessionId, fromMessageId } 来源并透传给 forkSessionAsk
 * - handleForkSend 空文本也发送（allowsEmptySend=true，空 content 退化为纯 fork）
 * - fork 无 isInProgress/abort（B 阶段缺省），signal 命中本 session 触发 enter
 * - 公开返回面 9 项形状（forkMode/forkModeRef/enter/exit/boxClass/placeholder/esc/send/asStagingAction）
 *
 * 范式参照 handoff-mode.test.ts：直接 import composable（不 mount），全 deps mock，
 * effectScope 包裹（watch 需 active scope）。
 *
 * 运行：cd packages/core && npx vitest run src/domain/composer/dispatch/fork-mode.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { computed, effectScope, nextTick, ref, type Ref } from 'vue'
import type { KeyboardEventLike } from '../types'
import { useComposerForkMode } from './fork-mode'

function makeDeps() {
  return {
    inputRef: ref<{ focus?: () => void } | null>(null),
    setSending: vi.fn(),
    clearInput: vi.fn(),
    restoreInput: vi.fn(),
    enterStagingMode: vi.fn(),
    exitStagingMode: vi.fn(),
    getStagingConfig: vi.fn(() => ({}) as never),
    t: vi.fn((key: string) => key),
    forkChipIcon: {} as never,
    forkSessionAsk: vi.fn(() => Promise.resolve()),
    toastError: vi.fn(),
    forkEnterSignal: ref<{ srcSessionId: string; fromMessageId: string } | null>(null),
  }
}

function setup(sessionIdValue: string | null = 's1') {
  const sessionIdSource = ref<string | null>(sessionIdValue)
  const sessionId = computed(() => sessionIdSource.value)
  const deps = makeDeps()
  const scope = effectScope()
  const api = scope.run(() =>
    useComposerForkMode(
      sessionId,
      deps as unknown as Parameters<typeof useComposerForkMode>[1],
    ),
  )!
  return { sessionIdSource, deps, scope, api }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('useComposerForkMode 公开返回面', () => {
  it('enterForkMode：mode 置 true + 记录来源 + 进入暂存态 + 聚焦', () => {
    const { deps, api } = setup()
    const focusSpy = vi.fn()
    deps.inputRef.value = { focus: focusSpy }

    api.enterForkMode('src-1', 'msg-9')

    expect(api.forkMode.value).toBe(true)
    expect(api.forkModeRef.value).toBe(true)
    expect(deps.enterStagingMode).toHaveBeenCalledTimes(1)
    expect(focusSpy).toHaveBeenCalledTimes(1)
    expect(api.forkBoxClass.value).toContain('fork-mode')
    expect(api.forkPlaceholder.value).toBe('panel.composer.forkHint')
  })

  it('exitForkMode：复位 + 退出暂存态 + 派生视图复位', () => {
    const { deps, api } = setup()
    api.enterForkMode('src-1', 'msg-9')
    api.exitForkMode()
    expect(api.forkMode.value).toBe(false)
    expect(deps.exitStagingMode).toHaveBeenCalledTimes(1)
    expect(api.forkBoxClass.value).toBe('')
    expect(api.forkPlaceholder.value).toBeNull()
  })

  it('handleForkEsc：fork 模式 Escape 消费（清空 + 退出），非 fork 不消费', () => {
    const { deps, api } = setup()
    const esc: KeyboardEventLike = { code: 'Escape', key: 'Escape', preventDefault: vi.fn() }
    expect(api.handleForkEsc(esc)).toBe(false)
    api.enterForkMode('src-1', 'msg-9')
    expect(api.handleForkEsc(esc)).toBe(true)
    expect(deps.clearInput).toHaveBeenCalledTimes(1)
    expect(api.forkMode.value).toBe(false)
  })

  it('handleForkSend：调 forkSessionAsk(src, fromMessageId, text, staging) 并退出', async () => {
    const { deps, api } = setup()
    api.enterForkMode('src-1', 'msg-9')

    const consumed = await api.handleForkSend('分支问题')
    expect(consumed).toBe(true)
    expect(deps.forkSessionAsk).toHaveBeenCalledWith('src-1', 'msg-9', '分支问题', expect.anything())
    expect(deps.setSending).toHaveBeenCalledWith(true)
    expect(deps.clearInput).toHaveBeenCalledTimes(1)
    expect(api.forkMode.value).toBe(false)
  })

  it('handleForkSend 空文本也消费（allowsEmptySend：纯 fork 不发首条 user）', async () => {
    const { deps, api } = setup()
    api.enterForkMode('src-1', 'msg-9')

    expect(await api.handleForkSend('')).toBe(true)
    expect(deps.forkSessionAsk).toHaveBeenCalledWith('src-1', 'msg-9', '', expect.anything())
  })

  it('handleForkSend 非 fork 模式不消费（返回 false 零副作用）', async () => {
    const { deps, api } = setup()
    expect(await api.handleForkSend('x')).toBe(false)
    expect(deps.forkSessionAsk).not.toHaveBeenCalled()
  })

  it('handleForkSend 失败：restoreInput + toastError + 退出暂存态', async () => {
    const { deps, api } = setup()
    ;(deps.forkSessionAsk as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('boom'))
    api.enterForkMode('src-1', 'msg-9')

    expect(await api.handleForkSend('文本')).toBe(true)
    expect(deps.restoreInput).toHaveBeenCalledWith('文本')
    expect(deps.toastError).toHaveBeenCalledWith('panel.panel.sendFailed')
    expect(deps.exitStagingMode).toHaveBeenCalled()
  })

  it('forkEnterSignal 命中本 session 才触发 enter（跨组件通道守卫）', async () => {
    const { deps, api } = setup('s1')
    deps.forkEnterSignal.value = { srcSessionId: 'other', fromMessageId: 'm' }
    await nextTick()
    expect(api.forkMode.value).toBe(false)

    deps.forkEnterSignal.value = { srcSessionId: 's1', fromMessageId: 'm' }
    await nextTick()
    expect(api.forkMode.value).toBe(true)
  })

  it('asStagingAction：type=fork + isActive 派生 + 无 abort（B 阶段缺省）', () => {
    const { api } = setup()
    const action = api.asStagingAction()
    expect(action.type).toBe('fork')
    expect(action.isActive.value).toBe(false)
    api.enterForkMode('src-1', 'msg-9')
    expect(action.isActive.value).toBe(true)
    expect(action.isInProgress.value ?? false).toBe(false)
    expect(action.abort).toBeUndefined()
  })
})
