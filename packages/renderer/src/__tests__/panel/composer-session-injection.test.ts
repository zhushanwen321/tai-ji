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
// helper import 必须先于一切项目内模块（@/stores 等会在模块图加载期触发 @/api mock
// factory，factory 引用的 helper 绑定彼时必须已初始化，否则 TDZ——vi.mock hoisting 约束）
import {
  composerApiModule,
  composerChatModule,
  composerChatStoreModule,
  composerChildStubs,
  composerFlowModule,
} from '../helpers/composer-mount'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { defineComponent, nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'

// ── mock composable / api（防真依赖构造报错，工厂收编 helpers/composer-mount.ts；
//     @/stores/session 留本地——S2 需可变 active（vi.hoisted），helper 只有静态版）──
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
    props: { session: { id, label, cwd: '/p', lastActiveAt: 0 }, active: false, status: 'done' },
    global: { stubs: composerChildStubs },
  })
  mounted.push(wrapper)
  return wrapper
}


/** SessionItem 右键 → 「引用到输入区」点击驱动（S1-S3 共用交互样板单源）。 */
async function quoteViaContextMenu(label: string): Promise<void> {
  const item = mountSessionItem('s-ref', label)
  await item.find('.session-item').trigger('contextmenu')
  await nextTick()
  await nextTick()
  document.body
    .querySelector('[data-testid="session-quote-item"]')!
    .dispatchEvent(new MouseEvent('click', { bubbles: true }))
  await flushPromises()
}

describe('Composer session 引用注入（S1-S3 · spy 层链路）', () => {
  it('S1 sidebar 点击 → store → panel Composer watch 消费 insertSessionChip(refSessionId, label)', async () => {
    sessionState.active = { id: 's-cur', cwd: '/p' }
    mountComposer({ sessionId: 's-cur', variant: 'panel' })
    const store = composerInjectionStore

    // 首用例一次性异步初始化（mock RPC resolve 回写 ref）触发 Composer 重渲染；VTU 对显式组件
    // stub 每次 transform 生成新拷贝（稳定性靠 per-mount transform 缓存），同用例第二次 mount
    // （下方 SessionItem）重置缓存后，该重渲染会把 CommandPopover stub 换成新拷贝 → slot 里的
    // ComposerInput 实例替换（模板 ref 正确重绑到新实例，注入链路不受影响）。此处先把重建关在
    // 交互之前，断言改持重建后当前实例的 spy——断言语义不变：当前输入区收到 session chip。
    await flushPromises()
    const spy = inputSpies.at(-1)
    if (!spy) throw new Error('ComposerInput spy 未生成')

    await quoteViaContextMenu('被引用会话')

    expect(spy.insertSessionChip).toHaveBeenCalledOnce()
    expect(spy.insertSessionChip).toHaveBeenCalledWith('s-ref', '被引用会话')
    expect(spy.insertFileChip).not.toHaveBeenCalled()
    expect(store.pendingInjection.value).toBeNull()
  })

  it('S2 landing 态 → target=new → landing variant Composer 直接消费', async () => {
    sessionState.active = undefined
    const { spy } = mountComposer({ sessionId: null, variant: 'landing' })

    await quoteViaContextMenu('landing 引用')

    expect(spy.insertSessionChip).toHaveBeenCalledWith('s-ref', 'landing 引用')
    expect(composerInjectionStore.pendingInjection.value).toBeNull()
  })

  it('S3 session 注入消费后紧接 path 注入互不干扰（path 走 insertFileChip）', async () => {
    sessionState.active = { id: 's-cur', cwd: '/p' }
    const { spy } = mountComposer({ sessionId: 's-cur', variant: 'panel' })
    const store = composerInjectionStore

    await quoteViaContextMenu('会话 A')
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
