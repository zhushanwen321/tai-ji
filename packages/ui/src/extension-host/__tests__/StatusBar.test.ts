/**
 * StatusBar 组件测试（W3 · T4 TC-1~TC-5 + A4 对齐适配）。
 *
 * 覆盖用例（design-review TC-1~TC-5，C3 契约 + A4 对齐）：
 *  - TC-1 两 scope 渲染：per-session 在前 + global 在后，A4 排序（left/right 两段，
 *    段内 priority 降序），alignment=right 项右推（AC5）
 *  - A4-1 容器视觉：26px 高 bg-elevated text-xs + 溢出横向滚动
 *  - A4-2 状态点五色：ok=success / warn=warn / danger=danger / neutral=neutral-ico /
 *    plugin-src=accent（spec §2 A4）
 *  - A4-3 无 status 项不渲染状态点
 *  - A4-4/5 段内 priority 降序（大→左/前）
 *  - TC-2 无状态项自隐藏：text 空串项不渲染
 *  - TC-3 全空自隐藏：两 scope 均无渲染项时根元素 v-if 隐藏
 *  - TC-4 commandId 项点击触发 onCommand（注入 executor）
 *  - TC-5 无 commandId 项点击无副作用
 *
 * 运行：cd packages/ui && npx vitest run src/extension-host/
 */
import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import StatusBar from '../StatusBar.vue'
import { STATUS_BAR_SOURCE_KEY, type StatusBarSource, type StatusBarEntry } from '../status-bar-source'

const SESSION = 's1'

/** per-session 2 项 + global 1 项（TC-1 数据）：A(left,ok) B(right,commandId) + G(left) */
function makeItems(): {
  perSession: StatusBarEntry[]
  global: StatusBarEntry[]
} {
  return {
    perSession: [
      { id: 'p1-a', pluginId: 'p1', text: 'A', alignment: 'left', priority: 0, status: 'ok' },
      { id: 'p1-b', pluginId: 'p1', text: 'B', alignment: 'right', priority: 1, commandId: 'cmd-b', status: 'warn' },
    ],
    global: [{ id: 'g1', pluginId: 'p2', text: 'G', alignment: 'left', priority: 0 }],
  }
}

/** mock StatusBarSource：getItems 按 scope/sessionId 查表 */
function makeSource(overrides?: Partial<StatusBarSource>) {
  const items = makeItems()
  const source: StatusBarSource = {
    getItems: vi.fn((scope: 'per-session' | 'global', sessionId?: string) => {
      if (scope === 'per-session') return items.perSession
      return items.global
    }),
    ...overrides,
  }
  return { source, items }
}

function mountBar(source: StatusBarSource, onCommand?: (commandId: string) => void, sessionId: string | null = SESSION) {
  return mount(StatusBar, {
    props: { sessionId, onCommand },
    global: {
      provide: { [STATUS_BAR_SOURCE_KEY as symbol]: source },
    },
  })
}

describe('StatusBar', () => {
  it('TC-1 两 scope 渲染 + A4 排序：left 段在前 right 段在后，段内 priority 降序（AC5）', async () => {
    const { source } = makeSource()
    const wrapper = mountBar(source)
    await wrapper.vm.$nextTick()

    // 根元素存在 + 3 项
    expect(wrapper.find('[data-testid="status-bar"]').exists()).toBe(true)
    const items = wrapper.findAll('[data-testid="status-bar-item"]')
    expect(items).toHaveLength(3)

    // A4 排序：left 段（A → G，同 priority 保持合并顺序 per-session 前）→ right 段（B）
    expect(items[0]!.text()).toBe('A')
    expect(items[1]!.text()).toBe('G')
    expect(items[2]!.text()).toBe('B')

    // per-session scope 用当前 sessionId 查询
    expect(source.getItems).toHaveBeenCalledWith('per-session', SESSION)
    expect(source.getItems).toHaveBeenCalledWith('global')

    // alignment=right 的项带右推 class
    expect(items[2]!.classes()).toContain('ml-auto')
    expect(items[0]!.classes()).not.toContain('ml-auto')
    expect(items[1]!.classes()).not.toContain('ml-auto')
  })

  it('A4-1 容器视觉：26px 高 bg-elevated text-xs + 溢出横向滚动', async () => {
    const { source } = makeSource()
    const wrapper = mountBar(source)
    await wrapper.vm.$nextTick()

    const bar = wrapper.find('[data-testid="status-bar"]')
    expect(bar.classes()).toContain('h-[26px]')
    expect(bar.classes()).toContain('bg-elevated')
    expect(bar.classes()).toContain('text-xs')
    // 溢出：容器横向滚动（overflow-x-auto）
    expect(bar.classes()).toContain('overflow-x-auto')
  })

  it('A4-2 状态点五色：ok/warn/danger/neutral/plugin-src → success/warn/danger/neutral-ico/accent', async () => {
    const five: StatusBarEntry[] = [
      { id: 'd-ok', pluginId: 'p', text: 'ok', alignment: 'left', priority: 4, status: 'ok' },
      { id: 'd-warn', pluginId: 'p', text: 'warn', alignment: 'left', priority: 3, status: 'warn' },
      { id: 'd-danger', pluginId: 'p', text: 'danger', alignment: 'left', priority: 2, status: 'danger' },
      { id: 'd-neutral', pluginId: 'p', text: 'neutral', alignment: 'left', priority: 1, status: 'neutral' },
      { id: 'd-src', pluginId: 'p', text: 'src', alignment: 'left', priority: 0, status: 'plugin-src' },
    ]
    const { source } = makeSource({ getItems: (scope: 'per-session' | 'global') => (scope === 'per-session' ? five : []) })
    const wrapper = mountBar(source)
    await wrapper.vm.$nextTick()

    const dots = wrapper.findAll('[data-testid="status-bar-dot"]')
    expect(dots).toHaveLength(5)
    expect(dots[0]!.classes()).toContain('bg-success')
    expect(dots[1]!.classes()).toContain('bg-warn')
    expect(dots[2]!.classes()).toContain('bg-danger')
    expect(dots[3]!.classes()).toContain('bg-neutral-ico')
    expect(dots[4]!.classes()).toContain('bg-accent')
    // 7px 状态点
    expect(dots[0]!.classes()).toContain('size-[7px]')
    expect(dots[0]!.classes()).toContain('rounded-full')
  })

  it('A4-3 无 status 的项不渲染状态点', async () => {
    const { source } = makeSource()
    const wrapper = mountBar(source)
    await wrapper.vm.$nextTick()

    // A(ok) B(warn) 有点，G(无 status) 无点
    const items = wrapper.findAll('[data-testid="status-bar-item"]')
    expect(items[0]!.find('[data-testid="status-bar-dot"]').exists()).toBe(true)
    expect(items[1]!.find('[data-testid="status-bar-dot"]').exists()).toBe(false)
    expect(items[2]!.find('[data-testid="status-bar-dot"]').exists()).toBe(true)
  })

  it('A4-4 left 段 priority 降序：大 priority 在前（左）', async () => {
    const items: StatusBarEntry[] = [
      { id: 'low', pluginId: 'p', text: 'low', alignment: 'left', priority: 0 },
      { id: 'high', pluginId: 'p', text: 'high', alignment: 'left', priority: 10 },
      { id: 'mid', pluginId: 'p', text: 'mid', alignment: 'left', priority: 5 },
    ]
    const { source } = makeSource({ getItems: (scope: 'per-session' | 'global') => (scope === 'per-session' ? items : []) })
    const wrapper = mountBar(source)
    await wrapper.vm.$nextTick()

    const rendered = wrapper.findAll('[data-testid="status-bar-item"]')
    expect(rendered.map((n) => n.text())).toEqual(['high', 'mid', 'low'])
  })

  it('A4-5 right 段 priority 降序：大 priority 在段前', async () => {
    const items: StatusBarEntry[] = [
      { id: 'r-low', pluginId: 'p', text: 'r-low', alignment: 'right', priority: 1 },
      { id: 'r-high', pluginId: 'p', text: 'r-high', alignment: 'right', priority: 9 },
    ]
    const { source } = makeSource({ getItems: (scope: 'per-session' | 'global') => (scope === 'per-session' ? items : []) })
    const wrapper = mountBar(source)
    await wrapper.vm.$nextTick()

    const rendered = wrapper.findAll('[data-testid="status-bar-item"]')
    expect(rendered.map((n) => n.text())).toEqual(['r-high', 'r-low'])
    // right 段整体右推
    expect(rendered[0]!.classes()).toContain('ml-auto')
  })

  it('TC-2 无状态项自隐藏：text 空串项不渲染', async () => {
    const { source } = makeSource({
      getItems: (scope: 'per-session' | 'global') => {
        if (scope === 'per-session') {
          return [
            { id: 'empty', pluginId: 'p1', text: '', alignment: 'left', priority: 0 },
            { id: 'blank', pluginId: 'p1', text: '   ', alignment: 'left', priority: 0 },
            { id: 'ok', pluginId: 'p1', text: 'OK', alignment: 'left', priority: 0 },
          ]
        }
        return []
      },
    })
    const wrapper = mountBar(source)
    await wrapper.vm.$nextTick()

    const items = wrapper.findAll('[data-testid="status-bar-item"]')
    expect(items).toHaveLength(1)
    expect(items[0]!.text()).toBe('OK')
  })

  it('TC-3 全空自隐藏：两 scope 均无渲染项时根元素 v-if 隐藏', async () => {
    const { source } = makeSource({
      getItems: () => [],
    })
    const wrapper = mountBar(source)
    await wrapper.vm.$nextTick()

    expect(wrapper.find('[data-testid="status-bar"]').exists()).toBe(false)
  })

  it('TC-4 commandId 项点击触发 onCommand（注入 executor）', async () => {
    const { source } = makeSource()
    const onCommand = vi.fn()
    const wrapper = mountBar(source, onCommand)
    await wrapper.vm.$nextTick()

    const items = wrapper.findAll('[data-testid="status-bar-item"]')
    await items[2]!.trigger('click') // B 项 commandId='cmd-b'

    expect(onCommand).toHaveBeenCalledTimes(1)
    expect(onCommand).toHaveBeenCalledWith('cmd-b')
  })

  it('TC-5 无 commandId 项点击无副作用', async () => {
    const { source } = makeSource()
    const onCommand = vi.fn()
    const wrapper = mountBar(source, onCommand)
    await wrapper.vm.$nextTick()

    const items = wrapper.findAll('[data-testid="status-bar-item"]')
    await items[0]!.trigger('click') // A 项无 commandId
    await items[1]!.trigger('click') // G 项无 commandId

    expect(onCommand).not.toHaveBeenCalled()
  })

  it('R3 无注入 source 时静默空态不崩', () => {
    const wrapper = mount(StatusBar, { props: { sessionId: SESSION } })
    expect(wrapper.find('[data-testid="status-bar"]').exists()).toBe(false)
  })
})
