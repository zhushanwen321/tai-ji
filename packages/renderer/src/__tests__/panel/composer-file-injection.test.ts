/**
 * Composer file 注入集成测试（W2, U6-U9/R1/R3）。
 *
 * 验证 useComposerInjection 的 watch 消费行为：
 *  - U6 target=current 按 sessionId 匹配消费（insertFileChip 调用 + pendingInjection 清空）
 *  - U7 target=current sessionId 不匹配不消费（不误清，留给目标 composer）
 *  - U8 target=new 仅 landing composer（variant=landing）消费
 *  - U9 target=new 不被 session composer（variant=panel）消费
 *  - R1 端到端：store 写入 → Composer 真实消费 → DOM 真实 chip（real 层）
 *  - R3 target=new 真实路由 landing composer 消费（real 层，不依赖 sessionId 匹配）
 *
 * 策略同 composer-slash-injection.test.ts：真 pinia + 真 composerInjectionStore，
 * mock 其余 store/composable/api，ComposerInput stub 暴露 insertFileChip spy。
 * R1/R3 用真实 ComposerInput（验证真实 DOM chip）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { defineComponent } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import {
  composerChatModule,
  composerFlowModule,
  composerApiModule,
  composerChatStoreModule,
  composerSessionStoreModule,
  composerChildStubs,
} from '../helpers/composer-mount'

// ── mock composable / api / store（公共骨架收敛到 helpers/composer-mount.ts 单源；
//    W4 currentCwd 真 ref 修复单点落在 helper）──
vi.mock('@/composables/features/chat/useChat', () => composerChatModule())
vi.mock('@/composables/features/new-task/useNewTaskFlow', () => composerFlowModule())
vi.mock('@/api', () => composerApiModule())
vi.mock('@/stores/chat', () => composerChatStoreModule())
vi.mock('@/stores/session', () => composerSessionStoreModule())

// ── ComposerInput mock：defineExpose 暴露 insertFileChip spy（U6-U9 mock 层）──
let composerInputSpies: Array<{ insertFileChip: ReturnType<typeof vi.fn> }> = []
// W4：ComposerInput 迁 ui 包（@taiji/ui/features/composer），mock 目标改 ui 包路径
vi.mock('@taiji/ui/features/composer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@taiji/ui/features/composer')>()
  return {
    ...actual,
    ComposerInput: defineComponent({
    name: 'ComposerInput',
    emits: ['input', 'keydown', 'slash-trigger', 'file-trigger'],
    setup() {
      const insertFileChip = vi.fn()
      const spy = { insertFileChip }
      composerInputSpies.push(spy)
      return { insertFileChip, focus: vi.fn() }
    },
    template: '<div data-testid="composer-input" />',
    }),
  }
})

import Composer from '@/components/panel/Composer.vue'
import { composerInjectionStore } from '@/composables/panel/composer-injection-store'

beforeEach(() => {
  setActivePinia(createPinia())
  composerInputSpies = []
  // W4：store 改为模块级单例（composer-injection-store.ts），跨用例需显式清槽
  // （原 pinia wrapper 每次 setActivePinia 重建实例，单例没有该语义）
  composerInjectionStore.clearInjection()
})

// W4：模块级单例 store 的 watch 随组件存活——跨用例必须卸载组件，
// 否则前一用例的 Composer watch 会消费后一用例的注入请求（U6b 0 次调用根因）
const mountedWrappers: Array<{ unmount: () => void }> = []
afterEach(() => {
  mountedWrappers.splice(0).forEach((w) => w.unmount())
})

/** mount Composer（mock ComposerInput），返回 wrapper + insertFileChip spy */
function mountComposer(props: { sessionId: string | null; variant?: 'panel' | 'landing' }) {
  const wrapper = mount(Composer, { props, global: { stubs: composerChildStubs } })
  mountedWrappers.push(wrapper)
  const spy = composerInputSpies.at(-1)?.insertFileChip
  if (!spy) throw new Error('ComposerInput spy 未生成')
  return { wrapper, spy }
}

describe('Composer file 注入 watch（W2）', () => {
  it('U6 target=current 按 sessionId 匹配消费 + 清空 pendingInjection', async () => {
    const { spy: insertSpy } = mountComposer({ sessionId: 's1', variant: 'panel' })
    const store = composerInjectionStore
    store.requestInjection({ target: 'current', path: 'foo.ts', sessionId: 's1' })
    await flushPromises()

    expect(insertSpy).toHaveBeenCalledOnce()
    expect(insertSpy).toHaveBeenCalledWith('foo.ts', undefined)
    expect(store.pendingInjection.value).toBeNull()
  })

  it('U6b target=current 带 lineRange 透传给 insertFileChip', async () => {
    const { spy: insertSpy } = mountComposer({ sessionId: 's1', variant: 'panel' })
    const store = composerInjectionStore
    store.requestInjection({
      target: 'current',
      path: 'foo.ts',
      lineStart: 10,
      lineEnd: 20,
      sessionId: 's1',
    })
    await flushPromises()

    expect(insertSpy).toHaveBeenCalledWith('foo.ts', [10, 20])
  })

  it('U7 target=current sessionId 不匹配不消费不误清', async () => {
    const { spy: insertSpy } = mountComposer({ sessionId: 's1', variant: 'panel' })
    const store = composerInjectionStore
    store.requestInjection({ target: 'current', path: 'foo.ts', sessionId: 's2' })
    await flushPromises()

    expect(insertSpy).not.toHaveBeenCalled()
    // pendingInjection 仍在（留给 s2 composer）
    expect(store.pendingInjection.value).not.toBeNull()
  })

  it('U8 target=new 仅 landing composer（variant=landing）消费', async () => {
    const { spy: insertSpy } = mountComposer({ sessionId: null, variant: 'landing' })
    const store = composerInjectionStore
    store.requestInjection({ target: 'new', path: 'foo.ts', sessionId: 's1' })
    await flushPromises()

    expect(insertSpy).toHaveBeenCalledOnce()
    expect(insertSpy).toHaveBeenCalledWith('foo.ts', undefined)
  })

  it('U9 target=new 不被 session composer（variant=panel）消费', async () => {
    const { spy: insertSpy } = mountComposer({ sessionId: 's1', variant: 'panel' })
    const store = composerInjectionStore
    store.requestInjection({ target: 'new', path: 'foo.ts', sessionId: 's1' })
    await flushPromises()

    // session composer 触发 startFlow + routeToLanding，但自身不注入
    expect(insertSpy).not.toHaveBeenCalled()
  })
})
