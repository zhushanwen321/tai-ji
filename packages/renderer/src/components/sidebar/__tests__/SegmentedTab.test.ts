/**
 * SegmentedTab 派生标签条测试（容器扩展点统一 §6.1 / U8 验收①）。
 *
 * 三视角（TEST-STRATEGY §3）：
 * - 观察者：内置三 tab 渲染（role=tab + 中文 label 用户可见断言）；
 * - 使用者：点击切 tab（emit 值 = 注册表条目 id）+ 方向键环形切换；
 * - 构建者：插件声明 sidebar.tab 注入后标签条出现插件项（§6.16④ label 原文），
 *   数据源 = 容器位注册表派生（lib/content-slots）。
 *
 * 运行：cd packages/renderer && npx vitest run src/components/sidebar/__tests__/SegmentedTab.test.ts
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import SegmentedTab from '@/components/sidebar/SegmentedTab.vue'
import { __resetContentSlotsForTesting, getContentSlotRegistry } from '@/lib/content-slots'
import { SIDEBAR_TAB_FILES, SIDEBAR_TAB_PLUGINS, SIDEBAR_TAB_SESSIONS } from '@/stores/sidebar'

function mountTab(modelValue = SIDEBAR_TAB_SESSIONS): ReturnType<typeof mount> {
  return mount(SegmentedTab, {
    props: { modelValue, sessionCount: 0, fileCount: 0 },
  })
}

function tabButtons(wrapper: ReturnType<typeof mount>): ReturnType<typeof wrapper.findAll> {
  return wrapper.findAll('[role="tab"]')
}

beforeEach(() => {
  __resetContentSlotsForTesting()
})

afterEach(() => {
  __resetContentSlotsForTesting()
})

describe('SegmentedTab 内置三项（注册表初始项派生）', () => {
  it('渲染三个内置 tab，label = i18n 中文（用户可见 DOM 断言）', () => {
    const wrapper = mountTab()
    const tabs = tabButtons(wrapper)
    expect(tabs).toHaveLength(3)
    expect(tabs.map((t) => t.text())).toEqual(['会话', '文件', '插件'])
    // tablist 容器语义保留
    expect(wrapper.find('[role="tablist"]').exists()).toBe(true)
    wrapper.unmount()
  })

  it('选中态 aria-selected 跟随 modelValue（值 = 注册表条目 id）', () => {
    const wrapper = mountTab(SIDEBAR_TAB_FILES)
    const tabs = tabButtons(wrapper)
    expect(tabs[0]!.attributes('aria-selected')).toBe('false')
    expect(tabs[1]!.attributes('aria-selected')).toBe('true')
    wrapper.unmount()
  })

  it('点击 tab emit update:modelValue = 注册表 id（ui. 命名空间键）', async () => {
    const wrapper = mountTab()
    await tabButtons(wrapper)[2]!.trigger('click')
    expect(wrapper.emitted('update:modelValue')?.[0]).toEqual([SIDEBAR_TAB_PLUGINS])
    wrapper.unmount()
  })

  it('方向键环形切换（ArrowDown 下一个、末尾回环首）', async () => {
    const wrapper = mountTab(SIDEBAR_TAB_PLUGINS)
    const tablist = wrapper.find('[role="tablist"]')
    await tablist.trigger('keydown', { key: 'ArrowDown' })
    expect(wrapper.emitted('update:modelValue')?.[0]).toEqual([SIDEBAR_TAB_SESSIONS])
    await tablist.trigger('keydown', { key: 'ArrowUp' })
    expect(wrapper.emitted('update:modelValue')?.[1]).toEqual([SIDEBAR_TAB_FILES])
    wrapper.unmount()
  })
})

describe('SegmentedTab 插件声明项并入标签条（§6.1 派生语义）', () => {
  it('loadExternal 注入 sidebar.tab 声明后标签条出现插件项，label = 声明原文', async () => {
    const wrapper = mountTab()
    expect(tabButtons(wrapper)).toHaveLength(3)

    getContentSlotRegistry().loadExternal('todo', [
      {
        id: 'todo.tasks',
        placement: 'sidebar.tab',
        label: '我的任务',
        scope: 'session',
        pluginId: 'todo',
        renderer: { kind: 'view', viewId: 'todo.tasks' },
      },
    ])
    await nextTick()

    const tabs = tabButtons(wrapper)
    expect(tabs).toHaveLength(4)
    expect(tabs[3]!.text()).toBe('我的任务')
    await tabs[3]!.trigger('click')
    expect(wrapper.emitted('update:modelValue')?.[0]).toEqual(['todo.tasks'])
    wrapper.unmount()
  })

  it('clearForPlugin 后插件项消失、内置三项保留（声明清理跟随派生）', async () => {
    const registry = getContentSlotRegistry()
    registry.loadExternal('todo', [
      {
        id: 'todo.tasks',
        placement: 'sidebar.tab',
        label: '我的任务',
        scope: 'session',
        pluginId: 'todo',
        renderer: { kind: 'view', viewId: 'todo.tasks' },
      },
    ])
    const wrapper = mountTab()
    await nextTick()
    expect(tabButtons(wrapper)).toHaveLength(4)

    registry.clearForPlugin('todo')
    await nextTick()
    expect(tabButtons(wrapper)).toHaveLength(3)
    wrapper.unmount()
  })
})
