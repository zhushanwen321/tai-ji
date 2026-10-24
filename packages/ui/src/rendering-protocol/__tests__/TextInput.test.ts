/**
 * TextInput 组件测试（provider-plugin-access D8：GuiComponent 协议输入原语）。
 *
 * 覆盖：喂树渲染（用户可见 DOM 断言：label / placeholder / testid）；输入经
 * UI_EVENT_SENDER_KEY 注入的出口收到 (componentId, 'change', value)——uiEvent 值
 * 回传往返的渲染侧（runtime 投递侧由 plugin-ui-event-channel.test.ts 承载）；
 * multiline 切 Textarea；本地镜像即时反映不丢字 + 插件回推新树（props.value 变化）
 * 输入值跟随（S7「插件推新树；输入状态保持」）；出口缺位禁用 + warn（Actionbar
 * 降级出声范式）。喂树用例经 GuiComponentRenderer 挂载（= 应用路径：core 白名单
 * 透传 → BUILTIN_MAP 路由 → 本组件）。
 *
 * 运行：cd packages/ui && npx vitest run src/rendering-protocol/__tests__/TextInput.test.ts
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import type { GuiComponent, GuiComponentProps } from '@zhushanwen/extension-protocol'
import TextInput from '../primitives/TextInput.vue'
import GuiComponentRenderer from '../GuiComponentRenderer.vue'
import { UI_EVENT_SENDER_KEY, type UiEventSender } from '../primitives/ui-event-sender-key'

type TextInputProps = GuiComponentProps['text-input']

type SendFn = (componentId: string, event: string, value: unknown) => void

const makeSender = (): { send: ReturnType<typeof vi.fn<SendFn>> } & UiEventSender => ({
  send: vi.fn<SendFn>(),
})

// console.warn spy 跨用例复位（Actionbar.test.ts 同款纪律）
afterEach(() => {
  vi.restoreAllMocks()
})

/** 应用路径喂树：GuiComponentRenderer 挂载（壳层 provide 出口，同 renderer 组合形态） */
const mountViaRenderer = (props: TextInputProps, sender: UiEventSender | undefined) =>
  mount(GuiComponentRenderer, {
    props: {
      component: { type: 'text-input', props } satisfies GuiComponent<'text-input'>,
    },
    global: {
      provide: sender === undefined
        ? {}
        : { [UI_EVENT_SENDER_KEY as symbol]: sender },
    },
  })

describe('TextInput 渲染（D8）', () => {
  it('喂树渲染：容器 + label + 输入框 testid + placeholder 可见（用户可见 DOM 断言）', () => {
    const sender = makeSender()
    const wrapper = mountViaRenderer(
      { id: 'pat', label: '访问令牌', placeholder: '粘贴 PAT', value: '' },
      sender,
    )
    expect(wrapper.find('[data-testid="gui-text-input"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="gui-text-input-field-pat"]').exists()).toBe(true)
    expect(wrapper.find('label').text()).toBe('访问令牌')
    expect(wrapper.find('input').attributes('placeholder')).toBe('粘贴 PAT')
    // 无会话归属场景（Provider 页挂载位）结构面完整：输入框可交互
    expect(wrapper.find('input').attributes('disabled')).toBeUndefined()
  })

  it('multiline=true 切 Textarea 原语（no-native-html：经 @taiji/ui 组件）', () => {
    const sender = makeSender()
    const wrapper = mountViaRenderer({ id: 'notes', multiline: true, value: '' }, sender)
    expect(wrapper.find('textarea').exists()).toBe(true)
    expect(wrapper.find('input').exists()).toBe(false)
  })

  it('初始 value 受控渲染（插件推树携带）', () => {
    const sender = makeSender()
    const wrapper = mountViaRenderer({ id: 'pat', value: 'seed-token' }, sender)
    expect((wrapper.find('input').element as HTMLInputElement).value).toBe('seed-token')
  })
})

describe('TextInput 值回传（uiEvent 渲染侧）', () => {
  it('输入 → 出口收到 (componentId, "change", 新值)；本地镜像即时反映（不丢字）', async () => {
    const sender = makeSender()
    const wrapper = mountViaRenderer({ id: 'pat', value: '' }, sender)

    await wrapper.find('input').setValue('abc')

    expect(sender.send).toHaveBeenCalledTimes(1)
    expect(sender.send).toHaveBeenCalledWith('pat', 'change', 'abc')
    expect((wrapper.find('input').element as HTMLInputElement).value).toBe('abc')
  })

  it('插件回推新树（props.value 变化）→ 输入框值跟随（S7：插件推新树；输入状态保持）', async () => {
    const sender = makeSender()
    const wrapper = mount(GuiComponentRenderer, {
      props: {
        component: { type: 'text-input', props: { id: 'pat', value: '' } } satisfies GuiComponent<'text-input'>,
      },
      global: { provide: { [UI_EVENT_SENDER_KEY as symbol]: sender } },
    })

    await wrapper.find('input').setValue('typed')
    expect(sender.send).toHaveBeenCalledWith('pat', 'change', 'typed')

    // 插件回推：带新 value 的树替换（generation 全量替换语义下的 props 更新）
    await wrapper.setProps({
      component: { type: 'text-input', props: { id: 'pat', value: 'typed' } } satisfies GuiComponent<'text-input'>,
    })
    expect((wrapper.find('input').element as HTMLInputElement).value).toBe('typed')
  })
})

describe('TextInput 出口缺位降级（Actionbar 出声范式）', () => {
  it('UI_EVENT_SENDER_KEY 未注入 → 输入框禁用 + warn 一次', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const wrapper = mountViaRenderer({ id: 'pat', value: '' }, undefined)

    expect(wrapper.find('input').attributes('disabled')).toBeDefined()
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('UI_EVENT_SENDER_KEY'))
  })
})
