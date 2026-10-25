// Composer v2 发送幂等两口径 + 会话草稿三条边界 + 中断动作通知测试
//（remote-use-mobile-v2 §7.1 / §6.20 / 验收条款 4-5）。
//
// 锁定四件事：
//   ① 幂等口径一（未送达重发）：send false 后内容未变再点发送 → 复用同一 clientUuid
//     （runtime 按 clientUuid 幂等，防已受理回执丢失双投）；修改内容 → 新键（新意图）
//   ② 幂等口径二边界：送达成功后记录清空 → 下次发送恒新键（两口径不混用——重试走
//     editAndResend 独立通路，不经本组件）
//   ③ 草稿三条边界（载体 = sessions-runtime 草稿表）：输入即写 / 切会话保留且切回恢复 /
//     发送成功摘除条目
//   ④ 中断成功插动作通知（§6.20「已中断本轮生成」——经 appendActionNotice → core
//     appendSystemNotice，v2 为其首个生产消费方）
//
// mock 策略（对齐 v1 mobile-composer.test 先例）：app-runtime 部分模块级 mock 隔离 core
// WS；ComposerInput 真实挂载（DOM 注入 input 事件驱动 hasInput 与草稿写入，使用者视角
// DOM 断言）。
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { resetChatModuleStateForTest } from '@taiji/core'
import Composer from '../Composer.vue'
import { i18n } from '../../i18n'
import { draftOf, resetSessionsRuntimeForTesting, setDraft } from '../../shell/sessions-runtime'
import { chatStore, composerInjectionStore } from '../../shell/app-runtime'

const { sendMock, abortMock, chatIsActiveRef } = vi.hoisted(() => ({
  sendMock: vi.fn<(sid: string, segments: unknown[], options?: { clientUuid?: string }) => Promise<boolean>>(),
  abortMock: vi.fn<(sid: string) => Promise<void>>(),
  chatIsActiveRef: { value: false },
}))

// chatStore 保留真实实例（appendActionNotice 闭包直引真 store——mock 对象替换拦不到闭包；
// 通知断言 = 真实分区尾部 system 行，恰是验收条款语义「插入会话分区」）。仅派生输入
// （isActive/sessionPhase）注入假值驱动停止/发送分支。
vi.mock('../../shell/app-runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../shell/app-runtime')>()
  return {
    ...actual,
    chatStore: {
      ...actual.chatStore,
      // occupancy 派生（D5 停止键分支）：isActive 可切——发送分支 / 停止分支两态驱动
      isActive: () => chatIsActiveRef.value,
      sessionPhase: () => ({ turn: 'idle', compacting: false, bash: 'off', handoff: 'off' }),
    },
    useChatInstance: {
      ...actual.useChatInstance,
      send: sendMock,
      abort: abortMock,
    },
  }
})

const SID = 'sid-composer'

function mountComposer(sessionId = SID) {
  return mount(Composer, {
    props: { sessionId },
    global: { plugins: [i18n] },
  })
}

/** 输入注入（对齐 v1 mobile-composer.test writeDraft）：innerHTML 直写 + 原生 input 事件
 *  派发——@input 驱动 hasInput 与草稿写入，发送钮 !hasInput 时 disabled。 */
function writeDraft(wrapper: ReturnType<typeof mountComposer>, text: string): void {
  const el = wrapper.get('[role="textbox"]').element as HTMLDivElement
  el.innerHTML = text
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

function readDraft(wrapper: ReturnType<typeof mountComposer>): string {
  return (wrapper.get('[role="textbox"]').element as HTMLDivElement).innerHTML
}

function sendButton(wrapper: ReturnType<typeof mountComposer>) {
  return wrapper.get('[data-testid="mobile-composer-send"]')
}

function tOf(key: string): string {
  return (i18n.global.t as (key: string) => string)(key)
}

beforeEach(() => {
  resetSessionsRuntimeForTesting()
  resetChatModuleStateForTest()
  // 真实 chat 分区清退（通知断言消费真实分区——跨用例残留会串行）
  chatStore.disposeSession(SID)
  sendMock.mockReset()
  sendMock.mockResolvedValue(true)
  abortMock.mockReset()
  abortMock.mockResolvedValue(undefined)
  chatIsActiveRef.value = false
  composerInjectionStore.clearInjection()
})

describe('发送幂等两口径（§7.1 / 验收条款 5）', () => {
  it('口径一：发送失败（false）后内容未变再点发送 → 复用同一 clientUuid（防已受理回执丢失双投）', async () => {
    sendMock.mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    const wrapper = mountComposer()

    writeDraft(wrapper, '弱网消息')
    await flushPromises()
    await sendButton(wrapper).trigger('click')
    await flushPromises()

    expect(sendMock).toHaveBeenCalledTimes(1)
    const firstCall = sendMock.mock.calls[0]!
    const firstUuid = (firstCall[2] as { clientUuid?: string } | undefined)?.clientUuid
    expect(firstUuid).toMatch(/^u-[0-9a-fA-F-]{36}$/)
    // 失败：草稿回填（setSegments 通路——DOM 恢复）+ 错误行可见
    expect(readDraft(wrapper)).toContain('弱网消息')
    expect(wrapper.find('[data-testid="mobile-composer-send-error"]').exists()).toBe(true)

    // 内容未变直接再点发送 = 未送达重发 → 同一 uuid
    await sendButton(wrapper).trigger('click')
    await flushPromises()
    expect(sendMock).toHaveBeenCalledTimes(2)
    const secondUuid = (sendMock.mock.calls[1]![2] as { clientUuid?: string } | undefined)?.clientUuid
    expect(secondUuid).toBe(firstUuid)
    wrapper.unmount()
  })

  it('口径边界：失败后修改内容再发送 → 新 clientUuid（新投递意图，两口径不混用）', async () => {
    sendMock.mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    const wrapper = mountComposer()

    writeDraft(wrapper, '原始内容')
    await flushPromises()
    await sendButton(wrapper).trigger('click')
    await flushPromises()
    const firstUuid = (sendMock.mock.calls[0]![2] as { clientUuid?: string } | undefined)?.clientUuid

    writeDraft(wrapper, '修改过的内容')
    await flushPromises()
    await sendButton(wrapper).trigger('click')
    await flushPromises()
    const secondUuid = (sendMock.mock.calls[1]![2] as { clientUuid?: string } | undefined)?.clientUuid
    expect(secondUuid).toBeDefined()
    expect(secondUuid).not.toBe(firstUuid)
    wrapper.unmount()
  })

  it('口径收口：送达成功后记录清空 → 再发新消息恒新键（不复用历史 uuid）', async () => {
    const wrapper = mountComposer()

    writeDraft(wrapper, '第一条')
    await flushPromises()
    await sendButton(wrapper).trigger('click')
    await flushPromises()
    const firstUuid = (sendMock.mock.calls[0]![2] as { clientUuid?: string } | undefined)?.clientUuid

    writeDraft(wrapper, '第二条')
    await flushPromises()
    await sendButton(wrapper).trigger('click')
    await flushPromises()
    const secondUuid = (sendMock.mock.calls[1]![2] as { clientUuid?: string } | undefined)?.clientUuid
    expect(secondUuid).toBeDefined()
    expect(secondUuid).not.toBe(firstUuid)
    wrapper.unmount()
  })

  it('每次注入的 uuid 形态 = u-<uuid36>（core 标记正则兼容面——clientUuid ↔ userEntryId 映射契约）', async () => {
    const wrapper = mountComposer()
    writeDraft(wrapper, '形态检查')
    await flushPromises()
    await sendButton(wrapper).trigger('click')
    await flushPromises()
    const uuid = (sendMock.mock.calls[0]![2] as { clientUuid?: string } | undefined)?.clientUuid
    expect(uuid).toMatch(/^u-[0-9a-fA-F-]{36}$/)
    wrapper.unmount()
  })
})

describe('会话草稿三条边界（§7.1 / 验收条款 5；载体 = sessions-runtime 草稿表）', () => {
  it('边界一（输入即写）：输入内容即时落草稿表——断线/Sheet 开关不触分区（内存 Map 生命周期 = 会话期间）', async () => {
    const wrapper = mountComposer()
    writeDraft(wrapper, '正在输入的草稿')
    await flushPromises()
    expect(draftOf(SID)).toBe('正在输入的草稿')
    wrapper.unmount()
  })

  it('边界二（切会话保留且切回恢复）：切走旧草稿保留，切回输入框恢复（组件级恢复，不经 runtime）', async () => {
    const wrapper = mountComposer('sid-a')
    writeDraft(wrapper, 'A 会话草稿')
    await flushPromises()
    expect(draftOf('sid-a')).toBe('A 会话草稿')

    await wrapper.setProps({ sessionId: 'sid-b' })
    await flushPromises()
    // 旧会话草稿保留（切走不清）
    expect(draftOf('sid-a')).toBe('A 会话草稿')
    // B 会话无草稿 → 输入框空
    expect(readDraft(wrapper)).toBe('')

    // B 会话写草稿 → 切回 A → A 草稿恢复进输入框
    writeDraft(wrapper, 'B 会话草稿')
    await flushPromises()
    await wrapper.setProps({ sessionId: 'sid-a' })
    await flushPromises()
    expect(readDraft(wrapper)).toContain('A 会话草稿')
    wrapper.unmount()
  })

  it('边界三（发送成功摘除）：clear 通路 → 草稿表条目摘除（空串不存值）；失败保留', async () => {
    const wrapper = mountComposer()
    writeDraft(wrapper, '待发送内容')
    await flushPromises()
    expect(draftOf(SID)).toBe('待发送内容')

    await sendButton(wrapper).trigger('click')
    await flushPromises()
    expect(draftOf(SID)).toBe('')
    wrapper.unmount()
  })

  it('预置草稿（他处写入）→ 挂载即恢复进输入框（重开聊天页草稿不丢——跨 Sheet 开关边界）', () => {
    setDraft(SID, '预置的草稿')
    const wrapper = mountComposer()
    expect(readDraft(wrapper)).toContain('预置的草稿')
    wrapper.unmount()
  })
})

describe('中断动作通知（§6.20 / 验收条款 4：appendSystemNotice 接线）', () => {
  it('停止成功（abort 回执成立）→ 「已中断本轮生成」经 appendActionNotice 插入会话分区（真实 store 尾部 system 行——appendSystemNotice 首个生产消费链路）', async () => {
    chatIsActiveRef.value = true
    const wrapper = mountComposer()
    await flushPromises()

    // 无内容 + 会话占用 → 停止按钮（D5 形态）
    await wrapper.get('[data-testid="mobile-composer-stop"]').trigger('click')
    await flushPromises()

    expect(abortMock).toHaveBeenCalledTimes(1)
    expect(abortMock).toHaveBeenCalledWith(SID)
    const msgs = chatStore.getMessages(SID)
    const last = msgs[msgs.length - 1]
    expect(last?.role).toBe('system')
    expect(String(last?.content)).toBe(tOf('mobile.notices.turnAborted'))
    wrapper.unmount()
  })

  it('abort RPC 失败 → 不插通知（动作回执未成立不造假事实——分区无 system 行）', async () => {
    chatIsActiveRef.value = true
    abortMock.mockRejectedValue(new Error('rpc lost'))
    const wrapper = mountComposer()
    await flushPromises()

    await wrapper.get('[data-testid="mobile-composer-stop"]').trigger('click')
    await flushPromises()
    expect(chatStore.getMessages(SID)).toHaveLength(0)
    wrapper.unmount()
  })
})
