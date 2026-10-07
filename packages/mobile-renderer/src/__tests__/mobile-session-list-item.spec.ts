// SessionListItem 组件测试（u13/A5：自 MobileSessionList 内联行模板机械拆出 + 模型/思考档只读标签；
// u20/A14：状态点改派生态渲染——derivedStatus prop 经 core 谓词计算后传入）。
//
// 行为面：label/状态点配色/状态文案/时间 + A5 模型标签 + 交互契约（click/enter emit open、
// active 高亮）+ A14 派生态渲染（9 态语义色/文案 + dead 进程态红点特判——进程态权威于
// 对话派生，A3 分流视觉锚）。
//
// 纯组件测试：无 app-runtime 依赖（props 驱动，derivedStatus 直接给定——判定谓词的
// 输入收集与行为矩阵归 core session-derivations.test.ts 与列表接线测试），i18n 真实装配。
// 运行：cd packages/mobile-renderer && npx vitest run src/__tests__/mobile-session-list-item.spec.ts
import { describe, expect, it, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import type { DerivedStatus } from '@taiji/core'
import type { SessionSummary } from '@taiji/shared'
import SessionListItem from '../views/SessionListItem.vue'
import { i18n } from '../i18n'

function makeItem(overrides: Partial<SessionSummary> & Pick<SessionSummary, 'id'>): SessionSummary {
  return {
    label: `会话-${overrides.id}`,
    cwd: '/tmp/project',
    status: 'idle',
    modelId: 'test-model',
    tokenCount: 0,
    lastActiveAt: new Date(2001, 1, 3).getTime(),
    ...overrides,
  }
}

function mountItem(item: SessionSummary, active = false, derivedStatus: DerivedStatus = 'done') {
  return mount(SessionListItem, {
    props: { item, active, derivedStatus },
    global: { plugins: [i18n] },
  })
}

function itemRoot(wrapper: ReturnType<typeof mountItem>) {
  return wrapper.get('[data-testid^="mobile-session-item-"]')
}

describe('SessionListItem 会话列表行（u13/A5）', () => {
  beforeEach(() => {
    // i18n 是模块级单例：同 worker 前序测试可能把 locale 切到 en-US，此处固定中文
    i18n.global.locale.value = 'zh-CN'
  })

  it('外迁内容等价：label + 状态点配色 + 状态文案 + 时间（跨日 M/D）', () => {
    const wrapper = mountItem(makeItem({ id: 's-1' }), false, 'streaming')
    const root = itemRoot(wrapper)
    expect(root.text()).toContain('会话-s-1')
    expect(root.get('.rounded-full').classes()).toContain('bg-accent')
    expect(root.text()).toContain('生成中')
    expect(root.text()).toContain('2/3')
    wrapper.unmount()
  })

  it('A14 派生态渲染：waiting → warn 色 + 等待输入文案；done → success 色已完成（对齐桌面 DOT_CLASS 色语言）', () => {
    const waiting = mountItem(makeItem({ id: 's-w' }), false, 'waiting')
    expect(waiting.get('.rounded-full').classes()).toContain('bg-warn')
    expect(waiting.text()).toContain('等待输入')
    waiting.unmount()

    const done = mountItem(makeItem({ id: 's-d' }), false, 'done')
    expect(done.get('.rounded-full').classes()).toContain('bg-success')
    expect(done.text()).toContain('已完成')
    done.unmount()
  })

  it('dead 进程态特判：meta dead → 红点 + 已退出（进程态权威于对话派生，A3 分流视觉锚）', () => {
    const dead = mountItem(makeItem({ id: 's-dead', status: 'dead' }), false, 'done')
    expect(dead.get('.rounded-full').classes()).toContain('bg-danger')
    expect(dead.text()).toContain('已退出')
    expect(dead.text()).not.toContain('已完成')
    dead.unmount()
  })

  it('A5 模型标签：modelId 可见（行内独立 testid）', () => {
    const wrapper = mountItem(makeItem({ id: 's-1', modelId: 'claude-opus-4' }))
    expect(wrapper.get('[data-testid="mobile-session-model-line"]').text()).toBe('claude-opus-4')
    wrapper.unmount()
  })

  it('A5 思考档标签：thinkingLevel 有值时以「modelId · level」拼接；缺失时仅 modelId', () => {
    const withLevel = mountItem(makeItem({ id: 's-1', modelId: 'm-1', thinkingLevel: 'high' }))
    expect(withLevel.get('[data-testid="mobile-session-model-line"]').text()).toBe('m-1 · high')
    withLevel.unmount()

    const withoutLevel = mountItem(makeItem({ id: 's-2', modelId: 'm-2' }))
    expect(withoutLevel.get('[data-testid="mobile-session-model-line"]').text()).toBe('m-2')
    withoutLevel.unmount()
  })

  it('交互：click 与 keydown.enter 均 emit("open", item.id)', async () => {
    const wrapper = mountItem(makeItem({ id: 's-1' }))
    await itemRoot(wrapper).trigger('click')
    await itemRoot(wrapper).trigger('keydown.enter')
    expect(wrapper.emitted('open')).toEqual([['s-1'], ['s-1']])
    wrapper.unmount()
  })

  it('active 高亮：active=true 带 bg-accent-soft，false 不带', () => {
    const active = mountItem(makeItem({ id: 's-1' }), true)
    expect(itemRoot(active).classes()).toContain('bg-accent-soft')
    active.unmount()
    const inactive = mountItem(makeItem({ id: 's-2' }), false)
    expect(itemRoot(inactive).classes()).not.toContain('bg-accent-soft')
    inactive.unmount()
  })
})
