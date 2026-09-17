/**
 * Composer session 引用注入消费侧测试（四符号体系 §3.1.2 侧边栏直引，U2d）。
 *
 * 覆盖：
 *  - S1 链路（panel）：真实 SessionItem 点击「引用到输入区」→ composerInjectionStore 写入
 *    → 真实 Composer 的 useComposerInjection watch 消费 → ComposerInput.insertSessionChip
 *    收到 (refSessionId, label) + pendingInjection 清空（mock ComposerInput spy 层）
 *  - S2 链路（landing）：无活跃 session → target=new → landing variant Composer 直接消费
 *  - S3 与 path 注入互不干扰：session 注入消费清空后，紧接 path 注入仍走 insertFileChip，
 *    insertSessionChip 不再被调
 *  - S4 真实 chip DOM（用户可见）：真实 ui ComposerInput 调 expose 的 insertSessionChip
 *    → 输入区出现 .mention-session chip（dataset.chipSessionId/chipLabel + label 文本）
 *
 * mock 集同 composer-file-injection.test.ts（真 pinia + 真 composerInjectionStore 单例通道，
 * mock useChat/useNewTaskFlow/api/其余 store；ComposerInput spy 层 + importActual real 层）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/panel/composer-session-injection.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { defineComponent } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import {
  composerChatModule,
  composerFlowModule,
  composerApiModule,
  composerChatStoreModule,
  composerChildStubs,
} from '../helpers/composer-mount'

// ── mock composable / api / store（公共骨架收敛到 helpers/composer-mount.ts 单源；
//    sessionStore 因需可变 active 保留本地 vi.hoisted 形态）──
vi.mock('@/composables/features/chat/useChat', () => composerChatModule())
vi.mock('@/composables/features/new-task/useNewTaskFlow', () => composerFlowModule())
vi.mock('@/api', () => composerApiModule())
vi.mock('@/stores/chat', () => composerChatStoreModule())
// sessionStore mock：SessionItem（写入侧目标路由）与 Composer 壳 getActiveSessionId 共用
const sessionState = vi.hoisted(() => ({
  active: undefined as { id: string; cwd: string } | undefined,
}))
vi.mock('@/stores/session', () => ({
  useSessionStore: () => ({ active: sessionState.active, list: [], applySnapshot: vi.fn() }),
}))

// ── ComposerInput mock：defineExpose 暴露 insertSessionChip/insertFileChip spy（S1-S3 层）──
// importOriginal 保留其余 export（ComposerInputDepsKey 等，Composer.vue provide 需要）
interface InputSpy {
  insertSessionChip: ReturnType<typeof vi.fn>
  insertFileChip: ReturnType<typeof vi.fn>
}
let inputSpies: InputSpy[] = []
vi.mock('@taiji/ui/features/composer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@taiji/ui/features/composer')>()
  return {
    ...actual,
    ComposerInput: defineComponent({
      name: 'ComposerInput',
      emits: ['input', 'keydown', 'slash-trigger', 'file-trigger'],
      setup() {
        const insertSessionChip = vi.fn()
        const insertFileChip = vi.fn()
        const spy = { insertSessionChip, insertFileChip }
        inputSpies.push(spy)
        return { insertSessionChip, insertFileChip, focus: vi.fn() }
      },
      template: '<div data-testid="composer-input" />',
    }),
  }
})

import Composer from '@/components/panel/Composer.vue'
import SessionItem from '@/components/sidebar/SessionItem.vue'
import { composerInjectionStore } from '@/composables/panel/composer-injection-store'

beforeEach(() => {
  setActivePinia(createPinia())
  localStorage.removeItem('taiji:session-markers')
  inputSpies = []
  composerInjectionStore.clearInjection()
})

// 模块级单例 store 的 watch 随组件存活——跨用例必须卸载，防前一用例 Composer 误消费
const mounted: Array<{ unmount: () => void }> = []
afterEach(() => {
  mounted.splice(0).forEach((w) => w.unmount())
  document.body.innerHTML = ''
})

function mountComposer(props: { sessionId: string | null; variant?: 'panel' | 'landing' }) {
  const wrapper = mount(Composer, { props, global: { stubs: composerChildStubs } })
  mounted.push(wrapper)
  const spy = inputSpies.at(-1)
  if (!spy) throw new Error('ComposerInput spy 未生成')
  return { wrapper, spy }
}

function mountSessionItem(id: string, label: string) {
  const wrapper = mount(SessionItem, {
    attachTo: document.body,
    props: { session: { id, label, cwd: '/p', lastActiveAt: 0 }, active: false, status: 'done' as never },
    global: { stubs: composerChildStubs },
  })
  mounted.push(wrapper)
  return wrapper
}

describe('Composer session 引用注入（S1-S3 · spy 层链路）', () => {
  it('S1 sidebar 点击 → store → panel Composer watch 消费 insertSessionChip(refSessionId, label)', async () => {
    sessionState.active = { id: 's-cur', cwd: '/p' }
    const { spy } = mountComposer({ sessionId: 's-cur', variant: 'panel' })
    const store = composerInjectionStore

    const item = mountSessionItem('s-ref', '被引用会话')
    await item.find('[data-testid="quote-to-composer-btn"]').trigger('click')
    await flushPromises()

    expect(spy.insertSessionChip).toHaveBeenCalledOnce()
    expect(spy.insertSessionChip).toHaveBeenCalledWith('s-ref', '被引用会话')
    expect(spy.insertFileChip).not.toHaveBeenCalled()
    expect(store.pendingInjection.value).toBeNull()
  })

  it('S2 landing 态 → target=new → landing variant Composer 直接消费', async () => {
    sessionState.active = undefined
    const { spy } = mountComposer({ sessionId: null, variant: 'landing' })

    const item = mountSessionItem('s-ref', 'landing 引用')
    await item.find('[data-testid="quote-to-composer-btn"]').trigger('click')
    await flushPromises()

    expect(spy.insertSessionChip).toHaveBeenCalledWith('s-ref', 'landing 引用')
    expect(composerInjectionStore.pendingInjection.value).toBeNull()
  })

  it('S3 session 注入消费后紧接 path 注入互不干扰（path 走 insertFileChip）', async () => {
    sessionState.active = { id: 's-cur', cwd: '/p' }
    const { spy } = mountComposer({ sessionId: 's-cur', variant: 'panel' })
    const store = composerInjectionStore

    const item = mountSessionItem('s-ref', '会话 A')
    await item.find('[data-testid="quote-to-composer-btn"]').trigger('click')
    await flushPromises()
    expect(spy.insertSessionChip).toHaveBeenCalledOnce()
    expect(store.pendingInjection.value).toBeNull()

    // session 注入已消费清空，紧接 drawer 形态的 path 注入应正常走 file chip
    store.requestInjection({ target: 'current', path: 'a.ts', sessionId: 's-cur' })
    await flushPromises()
    expect(spy.insertFileChip).toHaveBeenCalledWith('a.ts', undefined)
    expect(spy.insertSessionChip).toHaveBeenCalledOnce() // 未被 path 注入再次触发
    expect(store.pendingInjection.value).toBeNull()
  })
})

describe('Composer session 引用注入（S4 · 真实 chip DOM）', () => {
  it('真实 ComposerInput insertSessionChip → .mention-session chip（dataset + 可见 label）', async () => {
    // ComposerInput 被文件级 vi.mock，用 importActual 取真实组件（含 expose 与 deps token）
    const actual = await vi.importActual<typeof import('@taiji/ui/features/composer')>(
      '@taiji/ui/features/composer',
    )
    const wrapper: VueWrapper = mount(actual.ComposerInput, {
      attachTo: document.body,
      props: { placeholder: 'test' },
      global: {
        provide: {
          [actual.ComposerInputDepsKey as symbol]: {
            pasteImage: vi.fn(),
            renderIcon: () => false,
            t: (key: string) => key,
          },
        },
      },
    })
    mounted.push(wrapper)

    // 消费端（injection.ts）调用的同一 expose 方法
    const vm = wrapper.vm as InstanceType<typeof actual.ComposerInput> & {
      insertSessionChip: (sessionId: string, label: string) => void
    }
    vm.insertSessionChip('019e-abc-123', 'fix-com 设计讨论')

    const chip = wrapper.element.querySelector('.mention-session')
    expect(chip).toBeTruthy()
    expect(chip!.dataset.chipType).toBe('session')
    expect(chip!.dataset.chipSessionId).toBe('019e-abc-123')
    expect(chip!.dataset.chipLabel).toBe('fix-com 设计讨论')
    // 用户可见文本：chip-label 显示人可读 label（非 uuid）
    expect(chip!.textContent).toContain('fix-com 设计讨论')
  })
})
