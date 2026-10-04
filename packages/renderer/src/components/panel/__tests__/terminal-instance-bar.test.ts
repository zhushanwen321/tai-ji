/**
 * TerminalInstanceBar 组件测试（terminal-multi-instance u3-bar，设计 §3.1 / §3.3「切换条交互」）。
 *
 * 三视角（docs/TEST-STRATEGY.md §3）各至少一条：
 * - 构建者白盒：props（instances / activeTerminalId）→ DOM 条目数与选中态 data-active；
 * - 使用者黑盒：点击条目 / 「+」/ 关闭按钮 → 事件与 DOM 变化（用户可见）；
 * - 观察者形态：emit 载荷（select/close 的 terminalId 参数）+ 最后实例禁用态的负向断言。
 *
 * 覆盖任务书 5 类断言：默认单实例渲染 / 多实例切换 / 非最后实例关闭 emit /
 * 最后实例关闭按钮 disabled 且点击不 emit / 空态占位渲染且「+」可点。
 *
 * 运行：cd packages/renderer && npx vitest run src/components/panel/__tests__/terminal-instance-bar.test.ts
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import TerminalInstanceBar, {
  type TerminalInstanceBarItem,
} from '@/components/panel/TerminalInstanceBar.vue'

function inst(terminalId: string, seq: number, alive = true): TerminalInstanceBarItem {
  return { terminalId, seq, alive }
}

const SINGLE = [inst('term:s1:1', 1)]
const DOUBLE = [inst('term:s1:1', 1), inst('term:s1:2', 2)]

describe('TerminalInstanceBar 实例切换条（u3-bar）', () => {
  it('默认单实例：显示「终端 1」、「+」常驻、唯一实例的关闭按钮为禁用态', () => {
    const wrapper = mount(TerminalInstanceBar, {
      props: { instances: SINGLE, activeTerminalId: 'term:s1:1' },
    })

    // 观察者/使用者可见：条目名（seq 派生，非组件自分配）+ 常驻「+」
    const items = wrapper.findAll('[data-testid="terminal-instance-item"]')
    expect(items).toHaveLength(1)
    expect(items[0].text()).toContain('终端 1')
    expect(wrapper.find('[data-testid="terminal-instance-create"]').exists()).toBe(true)
    // 空态占位不出现
    expect(wrapper.find('[data-testid="terminal-instance-empty"]').exists()).toBe(false)

    // 最后实例保护：关闭按钮存在但 disabled（设计 §3.1 UI 供养规则）
    const close = wrapper.find('[data-testid="terminal-instance-close"]')
    expect(close.exists()).toBe(true)
    expect(close.attributes('disabled')).toBeDefined()
  })

  it('多实例切换：点击第二条 emit select(terminalId)，选中态随 activeTerminalId 迁移', async () => {
    const wrapper = mount(TerminalInstanceBar, {
      props: { instances: DOUBLE, activeTerminalId: 'term:s1:1' },
    })

    const items = wrapper.findAll('[data-testid="terminal-instance-item"]')
    expect(items).toHaveLength(2)
    expect(items[0].text()).toContain('终端 1')
    expect(items[1].text()).toContain('终端 2')
    // 当前激活条目有可见选中态标记（观察者：data-active）
    expect(items[0].attributes('data-active')).toBe('true')
    expect(items[1].attributes('data-active')).toBe('false')

    await items[1].trigger('click')

    // emit 载荷：terminalId 参数正确（不是序号、不是会话 id）
    const selectEvents = wrapper.emitted('select')
    expect(selectEvents).toHaveLength(1)
    expect(selectEvents?.[0]).toEqual(['term:s1:2'])
  })

  it('非最后实例：点击悬停关闭按钮 emit close(terminalId)，不误发 select', async () => {
    const wrapper = mount(TerminalInstanceBar, {
      props: { instances: DOUBLE, activeTerminalId: 'term:s1:1' },
    })

    const closes = wrapper.findAll('[data-testid="terminal-instance-close"]')
    expect(closes).toHaveLength(2)
    // 非最后实例按钮可用（未 disabled），用户可见可交互
    expect(closes[0].attributes('disabled')).toBeUndefined()

    await closes[0].trigger('click')

    const closeEvents = wrapper.emitted('close')
    expect(closeEvents).toHaveLength(1)
    expect(closeEvents?.[0]).toEqual(['term:s1:1'])
    // 关闭是条目内定点手势，不冒泡成切换
    expect(wrapper.emitted('select')).toBeUndefined()
  })

  it('最后实例负向断言：关闭按钮 disabled 且点击不 emit close', async () => {
    const wrapper = mount(TerminalInstanceBar, {
      props: { instances: SINGLE, activeTerminalId: 'term:s1:1' },
    })

    const close = wrapper.find('[data-testid="terminal-instance-close"]')
    expect(close.attributes('disabled')).toBeDefined()

    // 合成点击（disabled 元素在部分环境下仍可派发事件）→ 组件内守卫必须拦住 emit
    await close.trigger('click')
    expect(wrapper.emitted('close')).toBeUndefined()
  })

  it('空态：实例数为 0 时显示占位提示，条目消失，「+」仍可点 emit create', async () => {
    const wrapper = mount(TerminalInstanceBar, {
      props: { instances: [], activeTerminalId: null },
    })

    // 用户可见占位（唯一实例自然退出即归零，空态是合法状态）
    expect(wrapper.find('[data-testid="terminal-instance-empty"]').text()).toContain('暂无终端实例')
    expect(wrapper.findAll('[data-testid="terminal-instance-item"]')).toHaveLength(0)

    // 「+」常驻可用 → create（空态是恢复入口）
    const create = wrapper.find('[data-testid="terminal-instance-create"]')
    expect(create.exists()).toBe(true)
    await create.trigger('click')
    expect(wrapper.emitted('create')).toHaveLength(1)
  })

  it('非空态「+」同样常驻：emit create 无参数', async () => {
    const wrapper = mount(TerminalInstanceBar, {
      props: { instances: DOUBLE, activeTerminalId: 'term:s1:2' },
    })

    await wrapper.find('[data-testid="terminal-instance-create"]').trigger('click')
    const events = wrapper.emitted('create')
    expect(events).toHaveLength(1)
    expect(events?.[0]).toEqual([])
  })
})
