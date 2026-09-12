/**
 * WidgetArea.test.ts —— D 方案单行状态带 + 详情浮层单测（原 M17 多卡面板形态重写）。
 *
 * 形态：widget 区 = 单行 pill（每 widget 一个 seg：状态点 + 标题 + 进度计数 + 第一个
 * running 条目的活动项预览），点击经 reka Popover 弹完整列表浮层（teleport 到 body）。
 *
 * 覆盖：
 *  - TC1 冒烟：pill 渲染 + seg 含 meta 标题/进度计数
 *  - TC2 活动项预览：list-tree 有 running 条目 → pill 显示该条 label
 *  - TC2b 无 running 条目 → 无活动项预览
 *  - TC3 多 widget：两 seg 并列
 *  - TC4 清除语义：mock 容器清空 → 同实例 computed 重算 → 整体零 DOM（无残留空容器）
 *  - TC5 无数据隐藏 + 无 provide 环境兜底（inject(key, null) 不崩，ES1）
 *  - TC6 空 guiTree 条目过滤（guiTree=[] 不出 seg，ES4 异常 payload 防护）
 *  - TC9 meta：标题 meta.title 优先于 viewId；running 状态点 bg-accent
 *  - TC10 progress.label 覆盖计数文本；failed 状态点 bg-danger
 *  - TC11 无 meta（v1 旧 extension）→ seg fallback viewId 标题，无计数
 *  - TC12 点击 pill → body 内浮层渲染完整 guiTree（含 select-text 可复制）；再点收起
 *
 * mock 模式对齐 ViewHost.test.ts：global.provide 注入 VIEW_HOST_SOURCE_KEY + reactive
 * 容器（Map mutate 触发 WidgetArea entries computed 重算，C1 契约）。i18n 对齐
 * Turn.test.ts：vi.mock('vue-i18n') 注入 useI18n，无需 createI18n plugin。
 * reka PopoverContent teleport 到 body：浮层断言在 document.body 内做。
 *
 * 运行：cd packages/ui && npx vitest run src/features/chat/__tests__/WidgetArea.test.ts
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick, reactive } from 'vue'
import type { GuiComponent } from '@xyz-agent/extension-protocol'
import WidgetArea from '../WidgetArea.vue'
import {
  VIEW_HOST_SOURCE_KEY,
  type ViewHostSource,
  type ViewCacheEntry,
} from '../../../extension-host'

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string) => (key === 'panel.widget.details' ? '详情' : key),
  }),
}))

const SESSION = 's1'

function makeEntry(viewId: string, guiTree: GuiComponent[], meta?: ViewCacheEntry['meta']): ViewCacheEntry {
  return { viewId, pluginId: 'p1', guiTree, updatedAt: 123, ...(meta ? { meta } : {}) }
}

/**
 * 响应式 mock source：getViewIds/getView 读同一 reactive Map（对齐 ViewHost.test.ts
 * R2 的壳层响应式桥模拟）。store.views 的 get/set/delete/keys 迭代均被 Vue 追踪，
 * TC4 清除场景改 Map 即触发组件重算。
 */
function makeSource(initial: Record<string, ViewCacheEntry>) {
  const store = reactive({ views: new Map<string, ViewCacheEntry>(Object.entries(initial)) })
  const source: ViewHostSource = {
    getViewIds: vi.fn((sessionId: string) =>
      sessionId === SESSION ? [...store.views.keys()] : [],
    ),
    getView: vi.fn(
      (sessionId: string, viewId: string) =>
        sessionId === SESSION ? store.views.get(viewId) : undefined,
    ),
  }
  return { store, source }
}

function mountArea(source: ViewHostSource, sessionId: string = SESSION) {
  return mount(WidgetArea, {
    props: { sessionId },
    attachTo: document.body,
    global: { provide: { [VIEW_HOST_SOURCE_KEY as symbol]: source } },
  })
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('WidgetArea（D 方案：单行状态带 + 详情浮层）', () => {
  it('TC1 冒烟：pill 渲染，seg 含 meta 标题 + 进度计数', async () => {
    const { source } = makeSource({
      todo: makeEntry(
        'todo',
        [{ type: 'ansi-text', props: { lines: ['body line'] } }],
        { title: 'Todo', status: 'running', progress: { current: 1, total: 3 } },
      ),
    })
    const wrapper = mountArea(source)
    await nextTick()

    const area = wrapper.find('[data-testid="widget-area"]')
    expect(area.exists()).toBe(true)
    const pill = wrapper.find('[data-testid="widget-pill"]')
    expect(pill.exists()).toBe(true)
    const seg = wrapper.find('[data-testid="widget-pill-seg"]')
    expect(seg.exists()).toBe(true)
    expect(seg.text()).toContain('Todo')
    expect(seg.text()).toContain('1/3')
    // 收起态：完整列表内容不在 pill 内（body line 只在浮层中出现）
    expect(pill.text()).not.toContain('body line')
  })

  it('TC2 活动项预览：list-tree 有 running 条目 → pill 显示该条 label', async () => {
    const { source } = makeSource({
      goal: makeEntry('goal', [
        {
          type: 'list-tree',
          props: {
            items: [
              { label: 'task-a', status: 'running' },
              { label: 'task-b', status: 'done' },
            ],
          },
        },
      ]),
    })
    const wrapper = mountArea(source)
    await nextTick()

    const active = wrapper.find('[data-testid="widget-pill-active"]')
    expect(active.exists()).toBe(true)
    expect(active.text()).toBe('task-a')
  })

  it('TC2b 无 running 条目（全 done/pending）→ 不渲染活动项预览', async () => {
    const { source } = makeSource({
      goal: makeEntry('goal', [
        { type: 'list-tree', props: { items: [{ label: 'task-b', status: 'done' }] } },
      ]),
    })
    const wrapper = mountArea(source)
    await nextTick()

    expect(wrapper.find('[data-testid="widget-pill-active"]').exists()).toBe(false)
  })

  it('TC3 多 widget：两 seg 并列（todo + goal）', async () => {
    const { source } = makeSource({
      todo: makeEntry('todo', [{ type: 'ansi-text', props: { lines: ['todo line'] } }]),
      goal: makeEntry('goal', [{ type: 'ansi-text', props: { lines: ['goal line'] } }]),
    })
    const wrapper = mountArea(source)
    await nextTick()

    const segs = wrapper.findAll('[data-testid="widget-pill-seg"]')
    expect(segs).toHaveLength(2)
    expect(segs[0].text()).toContain('todo')
    expect(segs[1].text()).toContain('goal')
  })

  it('TC4 清除语义：mock 容器清空 → 同实例重算 → widget-area 整体消失', async () => {
    const { store, source } = makeSource({
      todo: makeEntry('todo', [{ type: 'ansi-text', props: { lines: ['todo line'] } }]),
    })
    const wrapper = mountArea(source)
    await nextTick()
    expect(wrapper.find('[data-testid="widget-area"]').exists()).toBe(true)

    // 清除（gui:null 语义 → store 层条目消失）：改 reactive Map 触发 computed 重算
    store.views.delete('todo')
    await nextTick()

    // 无数据整体隐藏，无残留空容器
    expect(wrapper.find('[data-testid="widget-area"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="widget-pill"]').exists()).toBe(false)
  })

  it('TC5① 无数据（getViewIds 空数组）→ 不渲染 widget-area', async () => {
    const { source } = makeSource({})
    const wrapper = mountArea(source)
    await nextTick()

    expect(wrapper.find('[data-testid="widget-area"]').exists()).toBe(false)
  })

  it('TC5② 无 provide（无注入 source）→ 静默空态不抛错', () => {
    // 不 provide VIEW_HOST_SOURCE_KEY 直接 mount：inject(key, null) 兜底（ES1）
    const wrapper = mount(WidgetArea, { props: { sessionId: SESSION } })
    expect(wrapper.find('[data-testid="widget-area"]').exists()).toBe(false)
  })

  it('TC6 空 guiTree 条目过滤：guiTree=[] 不出 seg', async () => {
    const { source } = makeSource({
      a: makeEntry('a', []),
      b: makeEntry('b', [{ type: 'ansi-text', props: { lines: ['b line'] } }]),
    })
    const wrapper = mountArea(source)
    await nextTick()

    // 只渲染 b 一个 seg（a 的空 guiTree 被过滤）
    const segs = wrapper.findAll('[data-testid="widget-pill-seg"]')
    expect(segs).toHaveLength(1)
    expect(segs[0].text()).toContain('b')
    expect(wrapper.find('[data-testid="widget-pill"]').text()).not.toContain('a')
  })

  // ── meta 渲染（v1.1 meta head 契约在 pill seg 上的投影）──

  it('TC9 标题用 meta.title（优先于 viewId）+ running 状态点 bg-accent', async () => {
    const { source } = makeSource({
      todo: makeEntry(
        'todo',
        [{ type: 'list-tree', props: { numbered: true, items: [{ label: 'a', depth: 0 }] } }],
        { title: 'Todo', status: 'running', progress: { current: 1, total: 3 } },
      ),
    })
    const wrapper = mountArea(source)
    await nextTick()

    const seg = wrapper.find('[data-testid="widget-pill-seg"]')
    expect(seg.text()).toContain('Todo')
    const dot = wrapper.find('[data-testid="widget-pill-dot"]')
    expect(dot.classes()).toContain('bg-accent')
  })

  it('TC10 progress.label 覆盖计数文本；failed 状态点 bg-danger', async () => {
    const { source } = makeSource({
      goal: makeEntry(
        'goal',
        [{ type: 'ansi-text', props: { lines: ['x'] } }],
        { title: 'fix-auth', status: 'failed', progress: { current: 95, total: 100, label: '95%' } },
      ),
    })
    const wrapper = mountArea(source)
    await nextTick()

    const seg = wrapper.find('[data-testid="widget-pill-seg"]')
    expect(seg.text()).toContain('95%')
    expect(seg.text()).toContain('fix-auth')
    expect(wrapper.find('[data-testid="widget-pill-dot"]').classes()).toContain('bg-danger')
  })

  it('TC11 无 meta（v1 旧 extension）→ seg fallback viewId 标题，无计数', async () => {
    const { source } = makeSource({
      legacy: makeEntry('legacy', [{ type: 'ansi-text', props: { lines: ['x'] } }]),
    })
    const wrapper = mountArea(source)
    await nextTick()

    const seg = wrapper.find('[data-testid="widget-pill-seg"]')
    expect(seg.text()).toContain('legacy')
    expect(wrapper.find('[data-testid="widget-pill-progress"]').exists()).toBe(false)
    // 无 meta → 状态点 idle 弱点降级
    expect(wrapper.find('[data-testid="widget-pill-dot"]').classes()).toContain('bg-neutral-dim')
  })

  // ── 详情浮层（reka Popover，teleport 到 body）──

  it('TC12 点击 pill → body 内浮层渲染完整 guiTree + select-text；再点收起', async () => {
    const { source } = makeSource({
      todo: makeEntry('todo', [{ type: 'ansi-text', props: { lines: ['todo body line'] } }]),
    })
    const wrapper = mountArea(source)
    await nextTick()

    // 初始收起：body 无浮层
    expect(document.body.querySelector('[data-testid="widget-popover"]')).toBeNull()

    // 点击 pill → PopoverContent teleport 到 body
    const pill = wrapper.find('[data-testid="widget-pill"]')
    await pill.trigger('click')
    await nextTick()
    await nextTick()

    const popover = document.body.querySelector('[data-testid="widget-popover"]')
    expect(popover).not.toBeNull()
    // 完整列表内容 + 可选中复制（全局 user-select:none 下的显式恢复）
    expect(popover!.textContent).toContain('todo body line')
    expect(popover!.querySelector('[data-testid="widget-popover-card"]')).not.toBeNull()
    expect(popover!.classList.contains('select-text')).toBe(true)

    // 再点 pill → 收起（浮层从 body 移除）
    await pill.trigger('click')
    await nextTick()
    await nextTick()
    expect(document.body.querySelector('[data-testid="widget-popover"]')).toBeNull()

    wrapper.unmount()
  })
})
