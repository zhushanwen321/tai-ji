/**
 * Composer bash 模式集成测试（composer-bash-execute W2）。
 *
 * 验证：
 * - T6: draft='!ls -la' Enter → sendBash('ls -la', false)，send 未被调
 * - T7: draft='!!git status' Enter → sendBash('git status', true)
 * - T8: draft='!' Enter → sendBash 未被调（空命令不提交，保持 bash 模式）
 * - T9: draft 从 'hello' 变 '!ls' → composer-box 获得 composer-bash-mode class
 *
 * 策略：
 * - 真 pinia + 真 chatStore（isActive 派生驱动 onSend 分流守卫）
 * - mock useChat（spy 化 send/sendBash/steer/abort...——composer-shell-mount 装配，
 *   断言引用 composer-mount 的 composerChatApiSpy 单例）
 * - mock ComposerInput（emit input 设 draft + emit keydown Enter 触发 onSend，getSegments 还原 text 段）
 * - 子组件 stub
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/panel/composer-bash-mode.test.ts
 */
import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import '../helpers/composer-shell-mount'
import { composerApiModule, composerChatApiSpy, makeTypeAndEnter, setupComposerBaseHarness } from '../helpers/composer-mount'

// ── api mock：本文件无 flush 链路消费，基础五组即可 ──
vi.mock('@/api', () => composerApiModule())

// ── ComposerInput mock（emit input 设 draft）+ 壳 stub + 逐用例重置（harness 一并装配）──
const { ComposerInputMock, otherStubs } = setupComposerBaseHarness()
const typeAndEnter = makeTypeAndEnter(ComposerInputMock)

import Composer from '@/components/panel/Composer.vue'

/** 全部用例挂 s1 面板态，签名收窄为实际消费面 */
function mountComposer() {
  return mount(Composer, { props: { sessionId: 's1' }, global: { stubs: otherStubs } })
}

describe('Composer bash 模式（! / !! 前缀分流）', () => {
  it('T6: draft="!ls -la" Enter → sendBash("ls -la", false)，send 未被调', async () => {
    const wrapper = mountComposer()
    await typeAndEnter(wrapper, '!ls -la')

    expect(composerChatApiSpy.sendBash).toHaveBeenCalledOnce()
    expect(composerChatApiSpy.sendBash).toHaveBeenCalledWith('s1', 'ls -la', false)
    // 普通发送未触发（bash 分流短路）
    expect(composerChatApiSpy.send).not.toHaveBeenCalled()
  })

  it('T7: draft="!!git status" Enter → sendBash("git status", true)（excludeFromContext）', async () => {
    const wrapper = mountComposer()
    await typeAndEnter(wrapper, '!!git status')

    expect(composerChatApiSpy.sendBash).toHaveBeenCalledOnce()
    expect(composerChatApiSpy.sendBash).toHaveBeenCalledWith('s1', 'git status', true)
  })

  it('T8: draft="!" Enter → sendBash 未被调（空命令不提交，保持 bash 模式）', async () => {
    const wrapper = mountComposer()
    await typeAndEnter(wrapper, '!')

    expect(composerChatApiSpy.sendBash).not.toHaveBeenCalled()
    expect(composerChatApiSpy.send).not.toHaveBeenCalled()
  })

  it('T9: draft 从 "hello" 变 "!ls" → composer-box 获得 composer-bash-mode class', async () => {
    const wrapper = mountComposer()
    const box = () => wrapper.find('[data-testid="composer-box"]')

    // 普通输入：无 bash class
    wrapper.findComponent(ComposerInputMock).vm.$emit('input', 'hello')
    await wrapper.vm.$nextTick()
    expect(box().classes()).not.toContain('composer-bash-mode')

    // bash 前缀：出现 composer-bash-mode
    wrapper.findComponent(ComposerInputMock).vm.$emit('input', '!ls')
    await wrapper.vm.$nextTick()
    expect(box().classes()).toContain('composer-bash-mode')
  })

  /**
   * [W6/S10 PR#116 review] trySendBash 失败时不恢复 draft（已知限制）。
   *
   * useChat.sendBash 内部已 try/catch + toast 且不重抛（与 send/abort/compact 对称），
   * 故 trySendBash 不再 try/catch + restoreInput。失败时草稿不恢复——错误已通过 toast 消化。
   * 本用例锁死该契约：sendBash resolve 后 clearInput 已执行（草稿清空），ComposerInput
   * 的 setText（restore 入口）未被调用。
   */
  it('W6: sendBash resolve 后 clearInput 已清空，setText（恢复入口）未被调', async () => {
    const wrapper = mountComposer()
    const input = wrapper.findComponent(ComposerInputMock)
    await typeAndEnter(wrapper, '!ls -la')

    expect(composerChatApiSpy.sendBash).toHaveBeenCalledOnce()
    expect(composerChatApiSpy.sendBash).toHaveBeenCalledWith('s1', 'ls -la', false)
    // clearInput 被调（乐观 UI：提交前已清空 draft）
    expect(input.vm.clear).toHaveBeenCalled()
    // setText 是 restoreInput 的底层入口（useComposerRestore.restoreInput → inputRef.setText），
    // sendBash resolve 路径下不应被调（无恢复语义）
    expect(input.vm.setText).not.toHaveBeenCalled()
  })
})
