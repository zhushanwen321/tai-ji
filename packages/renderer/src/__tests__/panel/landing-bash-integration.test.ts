/**
 * Landing 态 bash 首发的 mount 级集成测试（composer-bash-execute PR#116 review gap1）。
 *
 * 背景：
 * 审查明确警告「曾发生 77 单测 + 24 集成全绿但 Landing 态无 composer 输入区事故」。
 * use-new-task-flow.test.ts:228-265 的 landing 首发测试只断言 chatBash 被调（内部断言），
 * 未 mount 任何组件验证用户可见行为——同类风险点。本组补这条缺口。
 *
 * 入口选择：
 * 完整 Landing.vue 依赖大量 store/provider（DirSelectPopover / BranchSelectPopover /
 * CreateBranchModal / CreateWorktreeModal / useNewTaskFlow 内部 startFlow 副作用），
 * mount 成本与 noise 高。审查允许「退一步用 Composer variant=landing 并在注释说明理由」。
 * Composer.vue 的 onSend 是 landing 态 bash 首发的真分流入口（variant==='landing' 分支
 * 调 composerBash.extractBashCommand + flow.submitFirstMessage(segments, level, bashCommand)），
 * mount Composer variant=landing 即覆盖事故风险点（composer 输入区是否存在 + bash 视觉反馈
 * + 首发分流）。
 *
 * 验证（mount 真实 Composer.vue + stub 子组件 + mock useChat/useNewTaskFlow）：
 * - G1-T1: composer 输入区存在于 DOM（防「无 composer 输入区」事故重演）
 * - G1-T2: 输入 `!ls` 后 composer-box 切到 bash 模式（composer-bash-mode class）
 * - G1-T3: 回车后 submitFirstMessage 收到 bashCommand（{command:'ls', excludeFromContext:false}）
 * - G1-T4: 回车后 useChat.send 未被调（bash 不走 LLM turn）
 *
 * 策略：
 * - 真 pinia + 真 chatStore（isActive 派生驱动 onSend 分流守卫）
 * - mock useChat（spy 化 send/sendBash/abort...）
 * - mock useNewTaskFlow（spy 化 submitFirstMessage，捕获 bashCommand 第三参数）
 * - mock ComposerInput（emit input 设 draft + emit keydown Enter 触发 onSend，getSegments 还原 text 段）
 * - 子组件 stub
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/panel/landing-bash-integration.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
// 必须置于 Composer import 之前：@/api 的 vi.mock 工厂执行期解引用 helper 导出，
// Composer 导入链触发工厂时 helper 模块必须已初始化（同 mode-declaration-row 先例）。
import { composerApiModule, composerSessionStoreModule, makeComposerChatApiMock, makeComposerInputMock, composerChildStubs, resetComposerMountState } from '@/__tests__/helpers/composer-mount'
import { mount } from '@vue/test-utils'
import { defineComponent, ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parse as parseSfc, compileTemplate } from '@vue/compiler-sfc'
import { parse as parseTemplate, NodeTypes, type TemplateChildNode } from '@vue/compiler-dom'

// ── mock useChat（spy 化 send / sendBash，landing 首发不应触发它们；字面量换共享 helper 工厂）──
const chatApiMock = makeComposerChatApiMock()
vi.mock('@/composables/features/chat/useChat', () => ({
  useChat: () => chatApiMock,
}))

// ── mock useNewTaskFlow：spy 化 submitFirstMessage，捕获 landing 首发的 bashCommand ──
const flowMock = {
  submitFirstMessage: vi.fn(() => Promise.resolve()),
  currentModel: { value: null },
  setPendingModel: vi.fn(),
  currentCwd: ref(null),
  // landing 态 launchConfigView 解析消费（model-thinking 单一解析层输入）
  pendingPreset: ref(null),
}
vi.mock('@/composables/features/new-task/useNewTaskFlow', () => ({
  useNewTaskFlow: () => flowMock,
  resetNewTaskFlow: vi.fn(),
}))
vi.mock('@/api', () => composerApiModule())
vi.mock('@/stores/session', () => composerSessionStoreModule())

// ── ComposerInput mock + 兄弟组件 stub（单源 helpers/composer-mount.ts）──
// lastInputText 跟踪最近一次 input 文本，getSegments 还原 text 段（Composer landing 分支取 segments）
const { lastInputText, ComposerInputMock } = makeComposerInputMock()
const otherStubs = { ComposerInput: ComposerInputMock, ...composerChildStubs }

import Composer from '@/components/panel/Composer.vue'

beforeEach(() => resetComposerMountState(lastInputText))

function mountLandingComposer() {
  // landing 态：sessionId 传 null（首次启动延迟 create，与 Landing.vue 的 composerSid 真实态一致）
  return mount(Composer, { props: { sessionId: null, variant: 'landing' }, global: { stubs: otherStubs } })
}

/** 模拟用户输入文本（驱动 draft + isBashMode 派生） */
async function typeText(wrapper: ReturnType<typeof mountLandingComposer>, text: string): Promise<void> {
  wrapper.findComponent(ComposerInputMock).vm.$emit('input', text)
  await wrapper.vm.$nextTick()
}

/** 模拟用户回车（触发 onSend → landing 分流） */
async function pressEnter(wrapper: ReturnType<typeof mountLandingComposer>): Promise<void> {
  wrapper.findComponent(ComposerInputMock).vm.$emit('keydown', new KeyboardEvent('keydown', { key: 'Enter' }))
  await wrapper.vm.$nextTick()
  await wrapper.vm.$nextTick() // onSend 是 async，需 flush
}

describe('Landing 态 bash 首发的 mount 级集成（PR#116 review gap1）', () => {
  it('G1-T1: composer 输入区存在于 DOM（防「无 composer 输入区」事故重演）', () => {
    const wrapper = mountLandingComposer()
    // composer-box 容器存在
    expect(wrapper.find('[data-testid="composer-box"]').exists()).toBe(true)
    // composer 输入区存在（事故复现点：曾全绿但此处 DOM 缺失）
    expect(wrapper.find('[data-testid="composer-input"]').exists()).toBe(true)
  })

  it('G1-T2: 输入 !ls 后 composer-box 切到 bash 模式（composer-bash-mode class，视觉反馈）', async () => {
    const wrapper = mountLandingComposer()
    const box = () => wrapper.find('[data-testid="composer-box"]')

    // 普通输入：无 bash class
    await typeText(wrapper, 'hello')
    expect(box().classes()).not.toContain('composer-bash-mode')

    // bash 前缀：composer-box 获得 composer-bash-mode class（用户可见的 bash 模式视觉反馈）
    await typeText(wrapper, '!ls')
    expect(box().classes()).toContain('composer-bash-mode')
  })

  it('G1-T3+T4: !ls + 回车 → submitFirstMessage 收到 bashCommand({command:"ls", excludeFromContext:false})，send 未被调', async () => {
    const wrapper = mountLandingComposer()
    await typeText(wrapper, '!ls')
    await pressEnter(wrapper)

    // landing 态首发分流：submitFirstMessage 第三参数是 bashCommand（landing 分支提取 ! 前缀）
    expect(flowMock.submitFirstMessage).toHaveBeenCalledOnce()
    const callArgs = flowMock.submitFirstMessage.mock.calls[0]!
    // 第三参数（index 2）= { command, excludeFromContext }
    const bashCommand = callArgs[2] as { command: string; excludeFromContext: boolean } | undefined
    expect(bashCommand).toBeDefined()
    expect(bashCommand!.command).toBe('ls')
    expect(bashCommand!.excludeFromContext).toBe(false)
    // 关键：landing bash 首发不走 chat.send（bash 不走 LLM turn）
    expect(chatApiMock.send).not.toHaveBeenCalled()
    // sendBash 也不在此路径直接调（landing 经 submitFirstMessage → controller 调 sendBash，本测试 mock 了 flow）
    expect(chatApiMock.sendBash).not.toHaveBeenCalled()
  })

  it('G1-T5: !!pwd + 回车 → submitFirstMessage 收到 bashCommand({command:"pwd", excludeFromContext:true})', async () => {
    const wrapper = mountLandingComposer()
    await typeText(wrapper, '!!pwd')
    await pressEnter(wrapper)

    expect(flowMock.submitFirstMessage).toHaveBeenCalledOnce()
    const callArgs = flowMock.submitFirstMessage.mock.calls[0]!
    const bashCommand = callArgs[2] as { command: string; excludeFromContext: boolean } | undefined
    expect(bashCommand).toBeDefined()
    expect(bashCommand!.command).toBe('pwd')
    // !! 双感叹号 → excludeFromContext=true
    expect(bashCommand!.excludeFromContext).toBe(true)
    expect(chatApiMock.send).not.toHaveBeenCalled()
  })

  it('G1-T6: 普通文本 hello + 回车 → submitFirstMessage 第三参数 undefined（非 bash 走普通首发）', async () => {
    const wrapper = mountLandingComposer()
    await typeText(wrapper, 'hello')
    await pressEnter(wrapper)

    expect(flowMock.submitFirstMessage).toHaveBeenCalledOnce()
    const callArgs = flowMock.submitFirstMessage.mock.calls[0]!
    // 普通首发：第三参数（bashCommand）为 undefined
    expect(callArgs[2]).toBeUndefined()
    expect(chatApiMock.send).not.toHaveBeenCalled() // landing 经 submitFirstMessage 发，不直接调 send
  })

  /**
   * G1-T7: landing 态 bash 首发失败回滚路径（gap4）。
   *
   * Composer.vue onSend landing 分支：submitFirstMessage reject 时 catch restoreSegments
   * + toastError。本用例验证失败时 setText（restoreInput/restoreSegments 底层入口）被调，
   * 即输入被恢复（与 panel 态 trySendBash 不恢复的 W6 已知限制对比，landing 态有恢复语义）。
   */
  it('G1-T7: landing bash 首发 submitFirstMessage reject → restoreSegments 恢复输入（setText 被调）', async () => {
    flowMock.submitFirstMessage.mockRejectedValueOnce(new Error('network down'))
    const wrapper = mountLandingComposer()
    const input = wrapper.findComponent(ComposerInputMock)
    await typeText(wrapper, '!ls')
    await pressEnter(wrapper)
    // 等 reject + catch 落地
    await wrapper.vm.$nextTick()
    await wrapper.vm.$nextTick()

    expect(flowMock.submitFirstMessage).toHaveBeenCalledOnce()
    // 失败回滚：restoreSegments → inputRef.setText 被调（恢复 !ls 文本）
    expect(input.vm.setText).toHaveBeenCalled()
  })
})

/**
 * Landing.vue 模板尾部守卫（branch-review dmg-r1-1 回归）。
 *
 * 事故形态：CreateWorktreeModal 自闭合 `/>` 与 v-show 包裹层 `</div>` 之间混入
 * 字面反斜杠 + 空白——非空白常驻文本节点（condense 空白模式不剥除），在 landing
 * 内容态（composer 卡片下方）渲染用户可见的游离 `\` 字符。
 *
 * 守卫形态：@vue/compiler-sfc 提取模板块后用 @vue/compiler-dom 的 parse（纯解析、
 * 无 transform——文本节点保持原始 TEXT 形态；compileTemplate 产出的 transform 后
 * AST 会把独立文本包进 TEXT_CALL，采不到）深度遍历，断言所有常驻 text 节点不含
 * 字面反斜杠。插值/指令表达式内的合法转义不在 text 节点列，不受本守卫影响。
 */
describe('Landing.vue 模板尾部守卫（防游离反斜杠文本节点复发）', () => {
  it('模板可编译且所有常驻文本节点不含字面反斜杠', () => {
    const filename = resolve(__dirname, '../../components/new-task/Landing.vue')
    const source = readFileSync(filename, 'utf-8')
    const { descriptor, errors } = parseSfc(source, { filename })
    expect(errors).toEqual([])

    const template = descriptor.template
    expect(template).toBeDefined()

    // 模板可编译（语法损坏时文本遍历失去意义，先行把关）
    const compiled = compileTemplate({
      source: template!.content,
      filename,
      id: 'landing-template-guard',
    })
    expect(compiled.errors).toEqual([])

    // 解析层 AST：收集所有常驻 text 节点（元素/for 子树直下 + v-if 各分支）
    const ast = parseTemplate(template!.content, { comments: true })
    const texts: string[] = []
    const walk = (nodes: readonly TemplateChildNode[]): void => {
      for (const node of nodes) {
        if (node.type === NodeTypes.TEXT) {
          texts.push(node.content)
        } else if (node.type === NodeTypes.IF) {
          for (const branch of node.branches) walk(branch.children)
        } else if ('children' in node && Array.isArray(node.children)) {
          walk(node.children as readonly TemplateChildNode[])
        }
      }
    }
    walk(ast.children)

    const offenders = texts.filter((t) => t.includes('\\'))
    expect(offenders).toEqual([])
  })
})
