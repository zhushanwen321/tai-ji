/**
 * CompanionBand 组件测试（W2 · T5，TC-1~TC-6 + editor 变体）。
 *
 * 覆盖用例（design-review TC-1~TC-6，IF3/ERR3 契约）：
 *  - TC-1 confirm 渲染 + 确认/取消回传（AC3）
 *  - TC-2 select 渲染选项 + 选中回传；未选确认禁用（AC3）
 *  - TC-3 input 渲染 + 文本回传（prefill 预填）；editor 变体（Textarea）
 *  - TC-4 askUser 渲染（AskUserForm）+ 单选提交回传（AC3）
 *  - TC-5 无请求自隐藏（根元素 v-if 隐藏）
 *  - TC-5b expired 撤窗（plugin:uiRequestExpired → 出队 → band 自隐藏，D2）
 *  - TC-6 未知 method 只读降级（ERR3，无按钮 + console.warn)
 *
 * Mock 策略：MockDialogRequestSource（onUiRequest/onUiTimeout/onUiRequestExpired vi.fn
 * 存 handler 供触发，同 W1 测试模式）+ MockTransport（sendPiResponse/sendPluginResponse vi.fn），
 * global.provide 注入 DIALOG_REQUEST_SOURCE_KEY / UI_RESPONSE_TRANSPORT_KEY。
 * 不 mock useSessionScopedState（Map 分区是 W1 已验对象，组件测试透传验证集成）。
 *
 * 运行：cd packages/ui && npx vitest run src/extension-host/
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { nextTick } from 'vue'
import { mount } from '@vue/test-utils'
import CompanionBand from '../CompanionBand.vue'
import {
  DIALOG_REQUEST_SOURCE_KEY,
  UI_RESPONSE_TRANSPORT_KEY,
  OVERLAY_LIFECYCLE_KEY,
} from '../companion-band-source'
import type { DialogRequest, DialogRequestSource, UiResponseTransport } from '../dialog-request-queue'
import type { OverlayLifecycleSource, OverlayState } from '../companion-band-source'

// ── Mocks ────────────────────────────────────────────────────────────

class MockDialogRequestSource implements DialogRequestSource {
  /** 每次 mount 注册订阅返回的退订函数（unmount 退订断言用，MF-5） */
  unsubs: Array<ReturnType<typeof vi.fn>> = []
  onUiRequest = vi.fn((handler: (req: DialogRequest) => void): (() => void) => {
    this.requestHandler = handler
    const unsub = vi.fn()
    this.unsubs.push(unsub)
    return unsub as unknown as () => void
  })
  onUiTimeout = vi.fn((handler: (e: { sessionId: string; requestId: string }) => void): (() => void) => {
    this.timeoutHandler = handler
    const unsub = vi.fn()
    this.unsubs.push(unsub)
    return unsub as unknown as () => void
  })
  onUiRequestExpired = vi.fn((handler: (e: { sessionId: string; requestId: string }) => void): (() => void) => {
    this.expiredHandler = handler
    const unsub = vi.fn()
    this.unsubs.push(unsub)
    return unsub as unknown as () => void
  })

  requestHandler: ((req: DialogRequest) => void) | null = null
  timeoutHandler: ((e: { sessionId: string; requestId: string }) => void) | null = null
  expiredHandler: ((e: { sessionId: string; requestId: string }) => void) | null = null

  triggerUiRequest(req: Partial<DialogRequest> & { requestId: string; sessionId: string }): void {
    this.requestHandler?.(makeRequest(req))
  }

  triggerExpired(sessionId: string, requestId: string): void {
    this.expiredHandler?.({ sessionId, requestId })
  }
}

function makeRequest(overrides: Partial<DialogRequest> & { requestId: string; sessionId: string }): DialogRequest {
  return {
    source: 'pi',
    method: 'confirm',
    receivedAt: Date.now(),
    ...overrides,
  }
}

function makeTransport(): UiResponseTransport {
  return {
    sendPiResponse: vi.fn(),
    sendPluginResponse: vi.fn(),
  }
}

function mountBand(sessionId = 'A', overlay?: OverlayLifecycleSource) {
  const source = new MockDialogRequestSource()
  const transport = makeTransport()
  const wrapper = mount(CompanionBand, {
    props: { sessionId },
    global: {
      provide: {
        [DIALOG_REQUEST_SOURCE_KEY as symbol]: source,
        [UI_RESPONSE_TRANSPORT_KEY as symbol]: transport,
        ...(overlay ? { [OVERLAY_LIFECYCLE_KEY as symbol]: overlay } : {}),
      },
    },
  })
  return { wrapper, source, transport }
}

/** OverlayLifecycle mock（结构兼容 OverlayLifecycleSource；transition 更新内部状态模拟状态机） */
class MockOverlayLifecycle {
  private state: OverlayState | undefined = undefined
  getState = vi.fn((_sid: string | undefined, _rid: string): OverlayState | undefined => this.state)
  transition = vi.fn((_sid: string | undefined, _rid: string, to: OverlayState): void => {
    this.state = to
  })
}

// ── Tests ────────────────────────────────────────────────────────────

describe('CompanionBand', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('TC-1 confirm 渲染 + 确认/取消回传（AC3）', async () => {
    const { wrapper, source, transport } = mountBand()
    source.triggerUiRequest({ sessionId: 'A', requestId: 'r1', method: 'confirm', title: '确认操作', message: '是否继续？' })
    await nextTick()

    // DOM：band + title + message + 确认/取消按钮
    expect(wrapper.find('[data-testid="companion-band"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="companion-band-title"]').text()).toContain('确认操作')
    expect(wrapper.find('[data-testid="companion-band-message"]').text()).toContain('是否继续？')
    expect(wrapper.find('[data-testid="companion-confirm-ok"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="companion-confirm-cancel"]').exists()).toBe(true)

    // 确认 → respond(true)
    await wrapper.find('[data-testid="companion-confirm-ok"]').trigger('click')
    expect(transport.sendPiResponse).toHaveBeenCalledWith('A', 'r1', 'confirm', true)

    // 取消 → respond(null)
    source.triggerUiRequest({ sessionId: 'A', requestId: 'r1b', method: 'confirm' })
    await nextTick()
    await wrapper.find('[data-testid="companion-confirm-cancel"]').trigger('click')
    expect(transport.sendPiResponse).toHaveBeenCalledWith('A', 'r1b', 'confirm', null)
  })

  it('TC-2 select 渲染选项 + 选中回传；未选确认禁用（AC3）', async () => {
    const { wrapper, source, transport } = mountBand()
    source.triggerUiRequest({
      sessionId: 'A',
      requestId: 'r2',
      method: 'select',
      options: [
        { label: 'A', value: 'opt-a' },
        { label: 'B', value: 'opt-b' },
      ],
    })
    await nextTick()

    // 选项 DOM（label 文本）
    const labels = wrapper.findAll('[data-testid="companion-select-option-label"]')
    expect(labels).toHaveLength(2)
    expect(labels[0]!.text()).toBe('A')
    expect(labels[1]!.text()).toBe('B')

    // 未选：确认禁用
    const okBtn = wrapper.find('[data-testid="companion-select-ok"]')
    expect(okBtn.attributes('disabled')).toBeDefined()

    // 选中 B → 确认启用 → 点确认 → respond(value)
    await wrapper.find('[data-testid="companion-select-option-opt-b"]').trigger('click')
    expect(okBtn.attributes('disabled')).toBeUndefined()
    await okBtn.trigger('click')
    expect(transport.sendPiResponse).toHaveBeenCalledWith('A', 'r2', 'select', 'opt-b')
  })

  it('TC-3 input 渲染 + 文本回传（prefill 预填）；editor 变体走 Textarea（AC3）', async () => {
    const { wrapper, source, transport } = mountBand()
    source.triggerUiRequest({ sessionId: 'A', requestId: 'r3', method: 'input', prefill: '默认值' })
    await nextTick()

    // Input DOM + prefill 预填
    const input = wrapper.find('[data-testid="companion-input"]')
    expect(input.exists()).toBe(true)
    expect((input.element as HTMLInputElement).value).toBe('默认值')

    // 输入文本 → 确认 → respond(value)
    await input.setValue('abc')
    await wrapper.find('[data-testid="companion-input-ok"]').trigger('click')
    expect(transport.sendPiResponse).toHaveBeenCalledWith('A', 'r3', 'input', 'abc')

    // editor 变体：Textarea 渲染 + 回传
    source.triggerUiRequest({ sessionId: 'A', requestId: 'r3e', method: 'editor' })
    await nextTick()
    const textarea = wrapper.find('[data-testid="companion-editor"]')
    expect(textarea.exists()).toBe(true)
    await textarea.setValue('multi\nline')
    await wrapper.find('[data-testid="companion-input-ok"]').trigger('click')
    expect(transport.sendPiResponse).toHaveBeenCalledWith('A', 'r3e', 'editor', 'multi\nline')
  })

  it('TC-4 askUser 渲染（AskUserForm）+ 单选提交回传（AC3）', async () => {
    const { wrapper, source, transport } = mountBand()
    source.triggerUiRequest({
      sessionId: 'A',
      requestId: 'r4',
      method: 'askUser',
      askUserQuestions: [{ header: 'db', question: '选库?', options: [{ label: 'PG' }] }],
    })
    await nextTick()

    // AskUserForm DOM
    expect(wrapper.find('[data-testid="ask-user-form"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="ask-user-option-PG"]').exists()).toBe(true)

    // 单选 → 提交 → respond(answersJson)
    await wrapper.find('[data-testid="ask-user-option-PG"]').trigger('click')
    await wrapper.find('[data-testid="ask-user-submit"]').trigger('click')
    expect(transport.sendPiResponse).toHaveBeenCalledWith('A', 'r4', 'askUser', '{"db":"PG"}')
  })

  it('TC-4b askUser Other 编码：主 key 过滤 OTHER_VALUE + 独立 __other key（对齐 answer-codec）', async () => {
    const { wrapper, source, transport } = mountBand()
    source.triggerUiRequest({
      sessionId: 'A',
      requestId: 'r4b',
      method: 'askUser',
      askUserQuestions: [
        {
          header: 'db',
          question: '选库?',
          multiSelect: true,
          allowOther: true,
          options: [{ label: 'PG' }, { label: 'MySQL' }],
        },
      ],
    })
    await nextTick()

    // 选中 PG + Other → Other 输入框展开
    await wrapper.find('[data-testid="ask-user-option-PG"]').trigger('click')
    await wrapper.find('[data-testid="ask-user-option-__other__"]').trigger('click')
    await nextTick()
    const otherInput = wrapper.find('[data-testid="ask-user-other-db"]')
    expect(otherInput.exists()).toBe(true)

    // 输入 Other 文本 → 提交
    await otherInput.setValue('自研库')
    await wrapper.find('[data-testid="ask-user-submit"]').trigger('click')

    // 主 key = JSON.stringify(['PG'])（不含 OTHER_VALUE 占位符）；Other 文本进独立 `db__other` key
    expect(transport.sendPiResponse).toHaveBeenCalledWith('A', 'r4b', 'askUser', '{"db":"[\\"PG\\"]","db__other":"自研库"}')
  })

  it('TC-5 无请求自隐藏（根元素 v-if 隐藏，不占位）（IF3）', async () => {
    const { wrapper } = mountBand()
    await nextTick()
    expect(wrapper.find('[data-testid="companion-band"]').exists()).toBe(false)
  })

  it('TC-5b expired 撤窗：plugin:uiRequestExpired 出队后 band 自隐藏（D2 取消非替答，无回传）', async () => {
    const { wrapper, source, transport } = mountBand()
    source.triggerUiRequest({ sessionId: 'A', requestId: 'r1', method: 'confirm', title: '确认操作' })
    await nextTick()
    expect(wrapper.find('[data-testid="companion-band"]').exists()).toBe(true)

    // dialog 到期撤窗：band 消失 + 不产生任何回传（插件侧已收 UI_TIMEOUT reject）
    source.triggerExpired('A', 'r1')
    await nextTick()
    expect(wrapper.find('[data-testid="companion-band"]').exists()).toBe(false)
    expect(transport.sendPiResponse).not.toHaveBeenCalled()
    expect(transport.sendPluginResponse).not.toHaveBeenCalled()
  })

  it('MF-5: unmount 后订阅退订生效（queue 在 setup 顶层创建，onScopeDispose 正常注册）', async () => {
    const { wrapper, source } = mountBand()
    await nextTick()
    // 队列创建时注册三个订阅（onUiRequest + onUiTimeout + onUiRequestExpired）
    expect(source.unsubs).toHaveLength(3)

    // 首次请求正常入队渲染
    source.triggerUiRequest({ sessionId: 'A', requestId: 'r1', method: 'confirm' })
    await nextTick()
    expect(wrapper.find('[data-testid="companion-band"]').exists()).toBe(true)

    wrapper.unmount()
    // scope dispose → 三个订阅均退订。MF-5 修复前 queue 在 computed getter 内创建，
    // onScopeDispose 注册静默失败（无 active effect scope），unmount 后 unsub 不会被调。
    expect(source.unsubs[0]).toHaveBeenCalledTimes(1)
    expect(source.unsubs[1]).toHaveBeenCalledTimes(1)
    expect(source.unsubs[2]).toHaveBeenCalledTimes(1)
  })

  it('TC-6 未知 method 只读降级：title/message 展示 + 无按钮 + console.warn（ERR3）', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { wrapper, source } = mountBand()
      source.triggerUiRequest({
        sessionId: 'A',
        requestId: 'r9',
        method: 'futureMethod',
        title: '未来方法',
        message: '只读信息',
      } as unknown as Partial<DialogRequest> & { requestId: string; sessionId: string })
      await nextTick()

      // band + title/message 只读展示
      expect(wrapper.find('[data-testid="companion-band"]').exists()).toBe(true)
      expect(wrapper.find('[data-testid="companion-band-title"]').text()).toContain('未来方法')
      expect(wrapper.find('[data-testid="companion-band-message"]').text()).toContain('只读信息')

      // 无任何交互按钮
      expect(wrapper.findAll('button')).toHaveLength(0)

      // console.warn 记录未知 method
      expect(warnSpy).toHaveBeenCalledWith('[CompanionBand] unknown dialog method:', 'futureMethod')
    } finally {
      warnSpy.mockRestore()
    }
  })
})

// ── OverlayLifecycle 契约（IF9 状态机，arch-fix-v2 闭环）──────────────
describe('CompanionBand × OverlayLifecycle 契约（IF9）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('minimize → transition(sessionId, requestId, "minimized") + UI 反映收起态', async () => {
    const overlay = new MockOverlayLifecycle()
    const { wrapper, source } = mountBand('A', overlay)
    source.triggerUiRequest({ sessionId: 'A', requestId: 'r1', method: 'confirm', title: '确认', message: '正文' })
    await nextTick()

    // 初始未收起（getState undefined）→ minimize 按钮可见、body 可见
    expect(wrapper.find('[data-testid="companion-minimize"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="companion-band-message"]').exists()).toBe(true)

    // 点击 minimize → transition('minimized') + 状态机更新 + refresh → UI 收起
    await wrapper.find('[data-testid="companion-minimize"]').trigger('click')
    expect(overlay.transition).toHaveBeenCalledWith('A', 'r1', 'minimized')
    expect(wrapper.find('[data-testid="companion-restore"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="companion-minimize"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="companion-band-message"]').exists()).toBe(false)
    // z-index 状态驱动 → 覆盖层（design-token）
    expect(wrapper.find('[data-testid="companion-band"]').attributes('style')).toContain('z-index: var(--z-overlay)')
  })

  it('restore → transition("restored") + body 重新可见', async () => {
    const overlay = new MockOverlayLifecycle()
    const { wrapper, source } = mountBand('A', overlay)
    source.triggerUiRequest({ sessionId: 'A', requestId: 'r2', method: 'confirm', title: '收起测', message: 'm' })
    await nextTick()
    // 先收起
    await wrapper.find('[data-testid="companion-minimize"]').trigger('click')
    expect(wrapper.find('[data-testid="companion-band-message"]').exists()).toBe(false)

    // restore → transition('restored') + body 重新可见（restored 低层 z-index）
    await wrapper.find('[data-testid="companion-restore"]').trigger('click')
    expect(overlay.transition).toHaveBeenCalledWith('A', 'r2', 'restored')
    expect(wrapper.find('[data-testid="companion-band-message"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="companion-minimize"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="companion-band"]').attributes('style')).toContain('z-index: var(--z-overlay)')
  })

  it('无 OverlayLifecycle inject：minimize 点击不崩（静默 no-op）', async () => {
    // mountBand 不传 overlay → OVERLAY_LIFECYCLE_KEY 未 provide → inject 默认 null
    const { wrapper, source } = mountBand('A')
    source.triggerUiRequest({ sessionId: 'A', requestId: 'r3', method: 'confirm', title: '无注入' })
    await nextTick()

    const minBtn = wrapper.find('[data-testid="companion-minimize"]')
    expect(minBtn.exists()).toBe(true)
    // 点击不抛错
    await expect(minBtn.trigger('click')).resolves.toBeUndefined()
    // band 仍渲染（未崩），无 z-index（undefined 状态 → 不设）
    const band = wrapper.find('[data-testid="companion-band"]')
    expect(band.exists()).toBe(true)
    expect(band.attributes('style')).toBeFalsy()
  })
})
