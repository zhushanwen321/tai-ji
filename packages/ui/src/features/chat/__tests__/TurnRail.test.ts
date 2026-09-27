/**
 * TurnRail 组件测试（TC-w3-1 到 TC-w3-16，w3 wave，共 15 用例，编号缺 TC-w3-6）。
 *
 * 覆盖 IF4 契约：
 * - 渲染：turns=[] 不渲染；否则每个 turn 一个 rail-node 含 dot+摘要+chev
 * - 交互：点节点文本区 emit('jump')；点 chev emit('toggle')（stopPropagation 隔离）
 * - 状态：sessionActive 时 chev 全禁用；activeTurnIndex 高亮 active 节点；dot 反映状态
 *
 * 运行：cd packages/renderer && npx vitest run src/components/panel/message-stream/__tests__/TurnRail.test.ts
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import { TurnRail } from '@taiji/ui'
import type { MessageTurn } from '@taiji/core/domain/chat'
import type { Message } from '@taiji/shared'

/**
 * 构造 rail 测试用 turn fixture。
 * 用 as MessageTurn 断言绕开完整 Message 字段需求（测试 fixture 允许，规范豁免）。
 */
function makeRailTurn(
  idx: number,
  opts: {
    userText?: string
    failed?: boolean
    userNull?: boolean
    /** assistant content（默认 '...'，置 '' 测空 content fallback 计数） */
    assistantContent?: string
    /** thinking 块数量（测 fallback 计数 N thoughts） */
    thinkingCount?: number
    /** toolCall 数量（测 fallback 计数 M tools；failed=true 时叠加 1 个失败 tool） */
    toolCount?: number
  } = {},
): MessageTurn {
  // thinking 块数组（每块 content 非空）
  const thinking = opts.thinkingCount
    ? Array.from({ length: opts.thinkingCount }, (_, i) => ({
        id: `th${idx}-${i}`,
        content: `thinking ${i}`,
        collapsed: true,
      }))
    : undefined
  // toolCalls 数组（含 failed flag 时追加一个 error tool）
  const baseTools = opts.toolCount
    ? Array.from({ length: opts.toolCount }, (_, i) => ({
        id: `tc${idx}-${i}`,
        toolName: 'read',
        input: { path: `f${i}.ts` },
        status: 'done' as const,
        startTime: 0,
      }))
    : []
  const failTool = opts.failed
    ? [{
        id: `tc${idx}-fail`,
        toolName: 'fail',
        input: {},
        status: 'error' as const,
        startTime: 0,
      }]
    : []
  const toolCalls = [...baseTools, ...failTool]
  return {
    index: idx,
    user: opts.userNull
      ? null
      : ({
          id: `u${idx}`,
          role: 'user',
          content: opts.userText ?? `turn ${idx}`,
          status: 'done',
        } as unknown as Message),
    assistants: [
      {
        id: `a${idx}`,
        role: 'assistant',
        content: opts.assistantContent ?? '...',
        status: 'done',
        thinking,
        toolCalls,
      } as unknown as Message,
    ],
    isStreaming: false,
    hasFoldable: opts.failed ?? ((toolCalls.length > 0) || (thinking !== undefined)),
  } as MessageTurn
}

/** 默认 mount props（3 turn 场景），测试用例可 override。 */
function defaultProps(overrides: Record<string, unknown> = {}) {
  return {
    turns: [makeRailTurn(0), makeRailTurn(1), makeRailTurn(2)],
    activeTurnIndex: 0,
    sessionActive: false,
    ...overrides,
  }
}

describe('TurnRail (IF4)', () => {
  it('TC-w3-1: turns 为空时不渲染 rail', () => {
    const wrapper = mount(TurnRail, { props: defaultProps({ turns: [] }) })
    expect(wrapper.find('[data-testid="turn-rail"]').exists()).toBe(false)
  })

  it('TC-w3-2: 3 turns → 渲染 3 个 rail-node，每个含 agent-icon + 摘要 + toggle', () => {
    const wrapper = mount(TurnRail, { props: defaultProps() })
    const nodes = wrapper.findAll('[data-testid="rail-node"]')
    expect(nodes).toHaveLength(3)
    for (const node of nodes) {
      expect(node.find('[data-testid="rail-agent-icon"]').exists()).toBe(true)
      expect(node.find('[data-testid="rail-toggle"]').exists()).toBe(true)
      // 摘要文本应非空（默认 fixture 用 "turn N"）
      expect(node.text().length).toBeGreaterThan(0)
    }
  })

  it('TC-w3-3: 点 rail-node[1] 文本区 → emit jump(1)，不 emit toggle', async () => {
    const wrapper = mount(TurnRail, { props: defaultProps() })
    const nodes = wrapper.findAll('[data-testid="rail-node"]')
    // 点节点本身（文本区，非 toggle）—— trigger click on the node div
    await nodes[1].trigger('click')
    expect(wrapper.emitted('jump')).toBeTruthy()
    expect(wrapper.emitted('jump')![0]).toEqual([1])
    expect(wrapper.emitted('toggle')).toBeFalsy()
  })

  it('TC-w3-4: 点 rail-node[1] 的 toggle → emit toggle(1)，不 emit jump（stopPropagation）', async () => {
    const wrapper = mount(TurnRail, { props: defaultProps() })
    const toggles = wrapper.findAll('[data-testid="rail-toggle"]')
    await toggles[1].trigger('click')
    expect(wrapper.emitted('toggle')).toBeTruthy()
    expect(wrapper.emitted('toggle')![0]).toEqual([1])
    // toggle click 用 .stop 阻断冒泡，不应触发 rail-node 的 jump
    expect(wrapper.emitted('jump')).toBeFalsy()
  })

  it('TC-w3-5: sessionActive=true → 所有 rail-toggle 禁用', () => {
    const wrapper = mount(TurnRail, { props: defaultProps({ sessionActive: true }) })
    const toggles = wrapper.findAll('[data-testid="rail-toggle"]')
    expect(toggles).toHaveLength(3)
    for (const toggle of toggles) {
      // Button disabled 渲染为 button[disabled] 或 component 属性
      const button = toggle.element as HTMLElement
      // vue test-utils + Button.vue：disabled 属性会反映到 DOM
      expect(button.hasAttribute('disabled') || (button as HTMLButtonElement).disabled).toBe(true)
    }
  })

  it('TC-w3-7: activeTurnIndex=1 → rail-node[1] 含 active 类，rail-node[0] 不含', () => {
    const wrapper = mount(TurnRail, { props: defaultProps({ activeTurnIndex: 1 }) })
    const nodes = wrapper.findAll('[data-testid="rail-node"]')
    expect(nodes[1].classes()).toContain('active')
    expect(nodes[0].classes()).not.toContain('active')
  })

  it('TC-w3-8: agent-icon 颜色反映状态（done=text-neutral-ico / failed=text-warn 常驻 / active=text-accent + loader-spin）', () => {
    // 灰阶化（W2，§13.2-C + CL5 修正）：
    // turn0: done（无失败）→ neutral-ico；turn1: failed → warn（常驻哑光金，非 hover）；
    // turn2: active（sessionActive + 当前激活）→ accent + 双环 loader-spin（span，非 Bot svg）
    const turns = [
      makeRailTurn(0, { failed: false }),
      makeRailTurn(1, { failed: true }),
      makeRailTurn(2, { failed: false }),
    ]
    const wrapper = mount(TurnRail, {
      props: defaultProps({ turns, activeTurnIndex: 2, sessionActive: true }),
    })
    const icons = wrapper.findAll('[data-testid="rail-agent-icon"]')
    // done turn → text-neutral-ico（完成态中性灰 ICON 色）
    expect(icons[0].classes()).toContain('text-neutral-ico')
    // failed turn → text-danger（agentIconClass hasFailedTool 分支，v6 视觉重构后 danger 色）
    expect(icons[1].classes()).toContain('text-danger')
    // active turn → text-accent + animate-loader-spin（双环微缩 loader，进行中信号）
    expect(icons[2].classes()).toContain('text-accent')
    expect(icons[2].classes()).toContain('animate-loader-spin')
  })

  it('TC-w3-9: toggle 默认 opacity-0（hover 浮出）；非 active 节点非 hover 时隐藏', () => {
    // 注：hover 浮出行为由 Tailwind group-hover 编译时保证，happy-dom 无法触发真实 hover。
    // 本用例只验静态 class 存在，hover 视觉转换需 E2E/视觉回归补充。
    const wrapper = mount(TurnRail, { props: defaultProps({ activeTurnIndex: 0 }) })
    const toggles = wrapper.findAll('[data-testid="rail-toggle"]')
    expect(toggles).toHaveLength(3)
    // idx=1 非 active：toggle 含 opacity-0 class（默认隐藏，hover 才浮出）
    expect(toggles[1].classes()).toContain('opacity-0')
  })

  it('TC-w3-10: active 节点的 toggle 常驻可见（!opacity-100，非 hover 也能看到）', () => {
    const wrapper = mount(TurnRail, { props: defaultProps({ activeTurnIndex: 1 }) })
    const toggles = wrapper.findAll('[data-testid="rail-toggle"]')
    // idx=1 是 active：toggle 含 !opacity-100（常驻可见，用户决策）
    expect(toggles[1].classes()).toContain('!opacity-100')
    // idx=0 非 active：仍是 opacity-0
    expect(toggles[0].classes()).toContain('opacity-0')
  })

  it('TC-w3-11: expandedTurns 含稳定 key u1 时，idx=1 的 toggle data-expanded=true，其余 false', () => {
    const wrapper = mount(TurnRail, {
      props: defaultProps({ expandedTurns: new Set(['u1']) }),
    })
    const toggles = wrapper.findAll('[data-testid="rail-toggle"]')
    // turns fixture：makeRailTurn(0/1/2) → turn.user.id = u0/u1/u2（M5 stable-key，
    // expandedTurns 集合按 turnStableId 索引，非 MessageTurn.index）
    // expandedTurns={u1} → idx=1 展开态（ChevronUp），idx=0/2 折叠态（ChevronDown）
    expect(toggles[0].attributes('data-expanded')).toBe('false')
    expect(toggles[1].attributes('data-expanded')).toBe('true')
    expect(toggles[2].attributes('data-expanded')).toBe('false')
  })

  it('TC-w3-12: 未传 expandedTurns 时，所有 toggle data-expanded=false（默认折叠态）', () => {
    const wrapper = mount(TurnRail, { props: defaultProps() })
    const toggles = wrapper.findAll('[data-testid="rail-toggle"]')
    for (const toggle of toggles) {
      expect(toggle.attributes('data-expanded')).toBe('false')
    }
  })

  it('TC-w3-13: 节点含两行——user 行（User 图标）+ agent 行（Bot 图标）', () => {
    const wrapper = mount(TurnRail, { props: defaultProps() })
    const node = wrapper.findAll('[data-testid="rail-node"]')[0]
    // 两行 div（user 行 + agent 行），flex-col 垂直排列
    const rows = node.findAll(':scope > div')
    expect(rows).toHaveLength(2)
    // user 行含 User 图标（lucide 渲染为 svg，class 含 lucide-user）
    expect(rows[0].find('svg').exists()).toBe(true)
    // agent 行含 Bot 图标 + rail-agent-icon testid
    const agentIcon = node.find('[data-testid="rail-agent-icon"]')
    expect(agentIcon.exists()).toBe(true)
    expect(agentIcon.element.tagName.toLowerCase()).toBe('svg')
  })

  it('TC-w3-14: 无 user turn（首条 assistant）→ user 行不渲染，只显 agent 行', () => {
    const turns = [makeRailTurn(0, { userNull: true, assistantContent: '这是 assistant 回复' })]
    const wrapper = mount(TurnRail, { props: defaultProps({ turns }) })
    const node = wrapper.findAll('[data-testid="rail-node"]')[0]
    const rows = node.findAll(':scope > div')
    // 只有一行（agent 行），user 行被 v-if="turn.user" 省略
    expect(rows).toHaveLength(1)
    expect(node.find('[data-testid="rail-agent-icon"]').exists()).toBe(true)
  })

  it('TC-w3-15: agent 摘要文本优先——assistant 有 content 时显示 content 截断', () => {
    const turns = [makeRailTurn(0, { assistantContent: '修复了 Block.vue 的折叠状态同步问题' })]
    const wrapper = mount(TurnRail, { props: defaultProps({ turns }) })
    const node = wrapper.findAll('[data-testid="rail-node"]')[0]
    // agent 行（第二行）文本应含 assistant content 内容
    const rows = node.findAll(':scope > div')
    const agentRowText = rows[1].text()
    expect(agentRowText).toContain('修复了 Block.vue')
  })

  it('TC-w3-16: agent 摘要 fallback 计数——空 content + thinking/tools 时显示 N thoughts · M tools', () => {
    const turns = [makeRailTurn(0, { assistantContent: '', thinkingCount: 2, toolCount: 3 })]
    const wrapper = mount(TurnRail, { props: defaultProps({ turns }) })
    const node = wrapper.findAll('[data-testid="rail-node"]')[0]
    const rows = node.findAll(':scope > div')
    const agentRowText = rows[1].text()
    // fallback 计数：2 thoughts · 3 tools
    expect(agentRowText).toContain('2 thoughts')
    expect(agentRowText).toContain('3 tools')
  })
})
