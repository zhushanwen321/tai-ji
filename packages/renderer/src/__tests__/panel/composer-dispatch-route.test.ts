/**
 * Composer 统一发送分发器集成测试（session-occupancy u5b D6 六行表 → 投递所有权内核 u3b/D1 收敛）。
 *
 * [u3c 迁移] 原断言「按 D6 行分流到 steer API / defer 入队 / 直发」已随 D1 退役——lane 判定
 * （direct/steer/queued）收归 runtime 投递所有权内核，renderer 只提交不判定：六行占用形态
 * （turn 活跃 / compacting / bash / settling）Enter 一律走**统一提交**（useChat.send →
 * 乐观气泡 + delivery.submit），占用期不再有特殊路径（内核排队/入槽承接）。
 * 保留的 UI 预测面：Alt+⏎ 在 steer 路由行仍走 followUp（下一轮语义，composer-keydown 按
 * sendRoute 分流）——sendRoute 仍是发送位形态的数据源，不再是投递决策。
 *
 * 锁定：
 * - 行 3（generating + compacting）/ 行 2（dispatching）/ 行 4（settling）/ 行 6（bash 忙）
 *   Enter → deps.send 恰一次（steer/followUp 均不被调）
 * - 行 1（全 idle）Enter → deps.send（与占用期同路径）
 * - Alt+⏎：steer 路由行（turn 活跃）→ followUp；其余行 → send
 * - steer 路由行 + 空输入 → 不提交（分发器空输入守卫）
 *
 * 装配（真 pinia + 真 chatStore + mount Composer）：mock useChat / api（chat 组）/
 * useToast / ComposerInput + 壳 stub + 逐用例重置统一经 composer-queue-mount.ts 装配，
 * 断言引用 composerChatApiSpy 单例。
 *
 * occupancy 由 chat.setOccupancy 驱动（store 投影 = composer-shell sendRoute 的数据源）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/panel/composer-dispatch-route.test.ts
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import { textToSegments } from '@taiji/shared'
// harness 先于组件 import：'@/api' mock 工厂（composer-queue-mount 顶层注册）在其链上
// 执行，helper 绑定彼时须已初始化
import { composerChatApiSpy, setupComposerQueueHarness } from '../helpers/composer-queue-mount'
import { useChatStore } from '@/stores/chat'

const { ComposerInputMock, otherStubs } = setupComposerQueueHarness()

import Composer from '@/components/panel/Composer.vue'

function mountComposer(): ReturnType<typeof mount> {
  return mount(Composer, { props: { sessionId: 's1' }, global: { stubs: otherStubs } })
}

async function pressKey(wrapper: ReturnType<typeof mountComposer>, init: KeyboardEventInit): Promise<void> {
  wrapper.findComponent(ComposerInputMock).vm.$emit('keydown', new KeyboardEvent('keydown', { key: 'Enter', ...init }))
  await wrapper.vm.$nextTick()
  await wrapper.vm.$nextTick() // onSend 是 async，需 flush
}

/** 驱动 occupancy 投影（sessionPhase 数据源） */
function setPhase(turn: 'idle' | 'dispatching' | 'generating' | 'settling', compacting = false, bash = false): void {
  useChatStore().setOccupancy('s1', { turn, compacting, bash })
}

/** 制造本地 busy 视图（streaming 实体 → isActive=true）。真实时序下 turn 活跃（occupancy
 *  generating）必然伴随本地 turn 实体（turn 由本 renderer 的 send 发起）——行 2/3 用例
 *  须同步驱动本地视图，镜像真实投影时序。 */
function seedLocalBusy(sid = 's1'): void {
  useChatStore().applyMessageEvent(sid, {
    type: 'message.message_start',
    payload: { sessionId: sid, messageId: 'a1' },
  })
}

describe('Composer 统一发送分发器（占用形态全部收敛 deps.send，u3b/D1）', () => {
  it('行 3：generating + compacting（threshold）⏎ → 统一提交（不本地转 steer）', async () => {
    setPhase('generating', true)
    seedLocalBusy()
    const wrapper = mountComposer()
    wrapper.findComponent(ComposerInputMock).vm.$emit('input', '补充：别忘了加测试')
    await wrapper.vm.$nextTick()

    await pressKey(wrapper, {})

    // [D1] 占用期照常提交（内核判 lane），renderer 不再本地转 steer
    expect(composerChatApiSpy.send).toHaveBeenCalledTimes(1)
    expect(composerChatApiSpy.send).toHaveBeenCalledWith('s1', textToSegments('补充：别忘了加测试'))
    // 输入已清空（提交语义完成）
    expect(wrapper.findComponent(ComposerInputMock).vm.clear).toHaveBeenCalled()
  })

  it('行 2：dispatching ⏎ → 统一提交（turn 活跃不再本地转 steer）', async () => {
    setPhase('dispatching')
    seedLocalBusy()
    const wrapper = mountComposer()
    wrapper.findComponent(ComposerInputMock).vm.$emit('input', '追加')
    await wrapper.vm.$nextTick()

    await pressKey(wrapper, {})

    expect(composerChatApiSpy.send).toHaveBeenCalledTimes(1)
  })

  it('行 4：settling ⏎ → 统一提交（不再本地 defer 入队，内核 queued 承接）', async () => {
    setPhase('settling')
    const wrapper = mountComposer()
    wrapper.findComponent(ComposerInputMock).vm.$emit('input', 'settling 中发送')
    await wrapper.vm.$nextTick()

    await pressKey(wrapper, {})

    expect(composerChatApiSpy.send).toHaveBeenCalledWith('s1', textToSegments('settling 中发送'))
    expect(wrapper.findComponent(ComposerInputMock).vm.clear).toHaveBeenCalled()
  })

  it('行 6：bash=true 且 turn=idle ⏎ → 统一提交（占用期无特殊路径）', async () => {
    setPhase('idle', false, true)
    const wrapper = mountComposer()
    wrapper.findComponent(ComposerInputMock).vm.$emit('input', 'bash 忙时发送')
    await wrapper.vm.$nextTick()

    await pressKey(wrapper, {})

    expect(composerChatApiSpy.send).toHaveBeenCalledWith('s1', textToSegments('bash 忙时发送'))
    expect(wrapper.findComponent(ComposerInputMock).vm.clear).toHaveBeenCalled()
  })

  it('行 1：全 idle ⏎ → 统一提交（与占用期同路径）', async () => {
    setPhase('idle')
    const wrapper = mountComposer()
    wrapper.findComponent(ComposerInputMock).vm.$emit('input', '普通消息')
    await wrapper.vm.$nextTick()

    await pressKey(wrapper, {})

    expect(composerChatApiSpy.send).toHaveBeenCalledTimes(1)
    // useChat mock 的 send 签名 = (sid, segments)（底层 RPC 的 clientUuid 透传在 core 编排内）
    expect(composerChatApiSpy.send).toHaveBeenCalledWith('s1', textToSegments('普通消息'))
  })

  it('Alt+⏎ steer 路由行（generating）→ followUp（下一轮语义保留，非 steer）', async () => {
    setPhase('generating')
    seedLocalBusy()
    const wrapper = mountComposer()
    wrapper.findComponent(ComposerInputMock).vm.$emit('input', '下一轮再说')
    await wrapper.vm.$nextTick()

    await pressKey(wrapper, { altKey: true })

    expect(composerChatApiSpy.followUp).toHaveBeenCalledTimes(1)
    expect(composerChatApiSpy.send).not.toHaveBeenCalled()
  })

  it('Alt+⏎ non-steer 路由行（compacting）→ 统一提交（sendRoute 仅 UI 预测，非 followUp）', async () => {
    setPhase('idle', true)
    const wrapper = mountComposer()
    wrapper.findComponent(ComposerInputMock).vm.$emit('input', '压缩后发')
    await wrapper.vm.$nextTick()

    await pressKey(wrapper, { altKey: true })

    expect(composerChatApiSpy.followUp).not.toHaveBeenCalled()
    expect(composerChatApiSpy.send).toHaveBeenCalledWith('s1', textToSegments('压缩后发'))
  })

  it('steer 路由行 + 空输入 ⏎ → 不提交（分发器空输入守卫）', async () => {
    setPhase('generating')
    seedLocalBusy()
    const wrapper = mountComposer()
    await pressKey(wrapper, {})

    expect(composerChatApiSpy.send).not.toHaveBeenCalled()
  })
})
