// 移动壳 UI 主体测试（remote-use U1.4c 新增面）：
//   - ChatViewDeps provide 后 ChatView 子树（含 Turn）渲染无 inject 抛错（组件挂载测试）
//   - copyLabel 注入：代码块复制按钮 title 来自 ui locale composable 域（i18n 单源）
//   - renderMermaid 占位降级返回 {svg} 结构（remote-use-mobile D7（移动壳 v1 功能集裁定）mermaid 图表行）
import { describe, expect, it, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { resetChatModuleStateForTest } from '@taiji/core'
import MobileMessageStream from '../views/MobileMessageStream.vue'
import { chatStore } from '../shell/app-runtime'
import { renderMermaidPlaceholder } from '../shell/mermaid-placeholder'
import { i18n } from '../i18n'

const SID = 'sid-ui-test'

function mountStream(sessionId: string) {
  return mount(MobileMessageStream, {
    props: { sessionId },
    global: { plugins: [i18n] },
  })
}

describe('ChatViewDeps provide 完整性（全部必需字段由 MobileMessageStream provide）', () => {
  beforeEach(() => {
    resetChatModuleStateForTest()
    chatStore.disposeSession(SID)
  })

  it('provide 后 ChatView 子树渲染无 inject 抛错（含 Turn 渲染）', async () => {
    chatStore.appendUser(SID, [{ type: 'text', text: 'hello mobile' }])
    const wrapper = mountStream(SID)
    await flushPromises()
    // inject 缺失时 useChatViewDeps() 在 setup 期直接抛错——mount 成功 + 子树锚点在 DOM 即证明 provide 完整
    expect(wrapper.find('[data-testid="chat-view"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('hello mobile')
    wrapper.unmount()
  })

  it('copyLabel 注入：代码块复制按钮 title 来自 ui locale composable.copyLabel（i18n 单源）', async () => {
    const copyLabel = i18n.global.t('composable.copyLabel')
    chatStore.appendUser(SID, [{ type: 'text', text: '```js\nconst a = 1\n```' }])
    const wrapper = mountStream(SID)
    // 渲染链含 shiki 高亮（异步 chunk），轮询等复制按钮（title bake 进代码块 HTML）出现
    await vi.waitFor(() => {
      expect(wrapper.html()).toContain(`title="${copyLabel}"`)
    })
    wrapper.unmount()
  })
})

describe('renderMermaid 占位降级（ChatViewDeps 分派④）', () => {
  it('返回 {svg} 结构，svg 含 i18n 文案「图表在桌面查看」', async () => {
    const result = await renderMermaidPlaceholder('图表在桌面查看')
    expect(typeof result.svg).toBe('string')
    expect(result.svg).toContain('<svg')
    expect(result.svg).toContain('图表在桌面查看')
  })
})
