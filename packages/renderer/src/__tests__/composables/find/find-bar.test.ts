/**
 * FindBar 渲染断言（find-in-surface 设计留档 §5 测试条款）。
 *
 * 三视角：使用者黑盒（输入/计数/导航按钮可见与可用性 DOM 断言）+ 观察者形态
 * （Esc 关闭 → 单例状态复位）。i18n / vue useI18n 由 vitest 全局 setup mock。
 * 运行：cd packages/renderer && npx vitest run src/__tests__/composables/find/
 */
import { enableAutoUnmount, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import FindBar from '@/components/find/FindBar.vue'
import { useFindInSurface } from '@/composables/features/find/useFindInSurface'

enableAutoUnmount(afterEach)

const find = useFindInSurface()

function mountBar(): ReturnType<typeof mount> {
  return mount(FindBar, { props: { surfaceKind: 'right-drawer' }, attachTo: document.body })
}

afterEach(() => {
  find.close()
  document.body.innerHTML = ''
})

describe('FindBar 渲染', () => {
  it('find 关着：不渲染（根 v-if = 开着且开着的是本表面）', () => {
    const wrapper = mountBar()
    expect(wrapper.find('[data-testid="find-bar"]').exists()).toBe(false)
  })

  it('开着：渲染输入框 + 0/0 计数 + 导航/关闭按钮（无命中时导航禁用）', async () => {
    const wrapper = mountBar()
    find.open('right-drawer')
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[data-testid="find-bar"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="find-bar-input"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="find-bar-count"]').text()).toBe('0/0')
    expect((wrapper.find('[data-testid="find-bar-prev"]').element as HTMLButtonElement).disabled).toBe(true)
    expect((wrapper.find('[data-testid="find-bar-next"]').element as HTMLButtonElement).disabled).toBe(true)
    expect(wrapper.find('[data-testid="find-bar-close"]').exists()).toBe(true)
  })

  it('输入即搜：v-model 写 query → 单例 search 流转出命中计数', async () => {
    const host = document.createElement('div')
    host.setAttribute('data-find-surface', 'right-drawer')
    host.innerHTML = '<p>foo bar</p>'
    document.body.appendChild(host)

    const wrapper = mountBar()
    find.open('right-drawer')
    await wrapper.vm.$nextTick()
    await wrapper.find('input').setValue('foo')
    expect(find.hitCount.value).toBe(1)
    expect(wrapper.find('[data-testid="find-bar-count"]').text()).toBe('1/1')
  })

  it('换表面：本实例因 kind 不匹配隐藏（防双实例同显），新 kind 实例可见', async () => {
    const wrapper = mountBar() // surfaceKind = right-drawer
    find.open('right-drawer')
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[data-testid="find-bar"]').exists()).toBe(true)

    find.open('overlay')
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[data-testid="find-bar"]').exists()).toBe(false)
  })

  it('输入框内按 Esc：关查找（组件内消费，stopPropagation 不冒泡到 window）', async () => {
    const wrapper = mountBar()
    find.open('right-drawer')
    await wrapper.vm.$nextTick()
    const esc = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
    let reachedWindow = false
    const winListener = (): void => { reachedWindow = true }
    window.addEventListener('keydown', winListener)
    try {
      await wrapper.find('input').element.dispatchEvent(esc)
      await wrapper.vm.$nextTick()
    } finally {
      window.removeEventListener('keydown', winListener)
    }
    expect(find.isOpen.value).toBe(false)
    expect(reachedWindow, 'Esc 不冒泡到 window（orchestrator 不会重复消费）').toBe(false)
  })
})
