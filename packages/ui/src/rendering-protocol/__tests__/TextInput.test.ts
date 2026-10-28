/**
 * TextInput 原语单测（provider-plugin-access D8）。
 *
 * 独立成文件的原因：本节原属 primitives.test.ts 机械合并产物；该合并文件已登记
 * domain-map.json 挂载排除（shell 域，默认档不跑），TextInput 的行为用例随之在
 * 默认档（含 pr-cr-fix 覆盖率门禁）零执行——组件源码新增行零覆盖。拆回独立文件
 * （文件名沿用合并前源文件名），落回默认档执行；归属不变（shell 域 tests glob
 * `packages/ui/src/rendering-protocol/__tests__/**` 覆盖）。
 *
 * 覆盖：
 * - 喂树渲染：容器 / label / 输入框 testid / placeholder / 可交互
 * - multiline=true 切 Textarea 原语
 * - 初始 value 受控渲染（插件推树携带）
 * - 输入 → 出口收到 (componentId, 'change', 新值)；本地镜像即时反映
 * - 插件回推新树 → 输入框值跟随（S7）
 * - 出口缺位降级：禁用 + warn 一次（Actionbar 出声范式）
 */
import { mount } from '@vue/test-utils'
import type { GuiComponent, GuiComponentProps } from '@zhushanwen/extension-protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import GuiComponentRenderer from '../GuiComponentRenderer.vue'
import TextInput from '../primitives/TextInput.vue'
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

  it('multiline 输入：Textarea 值变更同走 change 回传契约（v-model 回写路径）', async () => {
    const sender = makeSender()
    const wrapper = mountViaRenderer({ id: 'notes', multiline: true, value: '' }, sender)

    await wrapper.find('textarea').setValue('多行内容')

    expect(sender.send).toHaveBeenCalledTimes(1)
    expect(sender.send).toHaveBeenCalledWith('notes', 'change', '多行内容')
    expect((wrapper.find('textarea').element as HTMLTextAreaElement).value).toBe('多行内容')
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
