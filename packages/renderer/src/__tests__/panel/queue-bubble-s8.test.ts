/**
 * QueueBubble S8 组件单测 —— v6 内嵌队列气泡。
 *
 * v6 §8.5 视觉重构后行为（组件注释为准）：去独立卡片/去标签/去 chevron（不支持收起）、
 * 多条显前 3 条 + 「+N」溢出计数。本文件为 v6 重构后 stale 断言的同步修复
 * （对应 commit 5d46b9234 同类工作），断言对齐组件现状。
 *
 * [compact-defer-composer-queue u1] defer 行扩展后：
 * - steer/followUp 行：仍只读（无按钮/无 emit），Zap/Clock icon + truncate 文本
 * - defer 行：Hourglass（info 色）+ 分档 chip（deferChip prop）+ truncate 文本 +
 *   富内容 +N 徽标（segments 非 text 段 >0）+ hover ×（emit removeDefer）
 * - 展平顺序 steering → followUp → defer；VISIBLE_MAX=3 与 +N 覆盖三组总和
 * - 根门基于展平列表非空（state === undefined 时 defer 行仍渲染，A1）
 * - 承接 PendingBubble.test.ts（u2 删除前）的占用分档 hover 文案用例（迁为 deferHint prop
 *   渲染断言）与 × 撤销边界用例（未提交行 × 可点 emit removeDefer；已提交条目不渲染 defer 行）
 *
 * 三视角覆盖：
 * - 观察者（形态）：单条/多条渲染结构、类型 icon（Zap=steer / Clock=followUp / Hourglass=defer）、
 *   chip / +N 徽标 / 溢出计数
 * - 使用者（黑盒）：steer/followUp 只读（无破坏性按钮、点击无副作用）；defer 行 × 撤销 emit
 * - 构建者（白盒）：state undefined + 空 defer 不渲染；state undefined + defer 非空渲染
 *
 * 运行：cd packages/renderer && pnpm test -- queue-bubble-s8
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import type { Segment } from '@xyz-agent/shared'
import QueueBubble from '@/components/panel/QueueBubble.vue'
import type { QueueState } from '@/stores/chat'
import type { QueuedMessage } from '@/composables/panel/useCompactQueue'

/** 未提交 defer 条目构造（segments 恒有 text 单段等价形态，与 useCompactQueue.enqueue 一致） */
function deferEntry(id: string, text: string, extra: Segment[] = []): QueuedMessage {
  return { id, text, segments: [{ type: 'text', text }, ...extra] }
}

/** mount 助手：三个 defer 相关 props 为必传（Composer 恒传），缺省给中性值 */
function mountQB(overrides: {
  state?: QueueState | undefined
  deferEntries?: QueuedMessage[]
  deferChip?: string
  deferHint?: string
} = {}) {
  return mount(QueueBubble, {
    props: {
      state: overrides.state,
      deferEntries: overrides.deferEntries ?? [],
      deferChip: overrides.deferChip ?? '压缩后',
      deferHint: overrides.deferHint ?? '等待上下文压缩完成后发送',
    },
  })
}

describe('QueueBubble S8 · 根门与 steer/followUp 只读契约', () => {
  it('state undefined + 无 defer → 不渲染', () => {
    const wrapper = mountQB({ state: undefined })
    expect(wrapper.find('[data-testid="queue-bubble"]').exists()).toBe(false)
  })

  it('state 空（无 steering/followUp）+ 无 defer → 不渲染', () => {
    const wrapper = mountQB({ state: {} })
    expect(wrapper.find('[data-testid="queue-bubble"]').exists()).toBe(false)
  })

  it('首屏冒烟：单条 steering → Zap icon + 内容渲染', () => {
    const state: QueueState = { steering: ['补充注册页校验'] }
    const wrapper = mountQB({ state })
    expect(wrapper.find('[data-testid="queue-bubble"]').exists()).toBe(true)
    // v6：无「待发送」标签，直接渲染内容行
    expect(wrapper.text()).not.toContain('待发送')
    expect(wrapper.text()).toContain('补充注册页校验')
    // 类型 icon：steering → Zap（lucide class 含 zap）
    expect(wrapper.find('svg.lucide-zap').exists()).toBe(true)
    expect(wrapper.find('svg.lucide-clock').exists()).toBe(false)
    expect(wrapper.find('svg.lucide-hourglass').exists()).toBe(false)
  })

  it('单条 followUp → Clock icon + 内容渲染', () => {
    const state: QueueState = { followUp: ['下轮加 refresh token'] }
    const wrapper = mountQB({ state })
    expect(wrapper.text()).toContain('下轮加 refresh token')
    expect(wrapper.find('svg.lucide-clock').exists()).toBe(true)
    expect(wrapper.find('svg.lucide-zap').exists()).toBe(false)
    expect(wrapper.find('svg.lucide-hourglass').exists()).toBe(false)
  })

  it('无 chevron（v6 去折叠，不支持收起）', () => {
    const state: QueueState = { steering: ['x'] }
    const wrapper = mountQB({ state })
    expect(wrapper.find('svg.lucide-chevron-right').exists()).toBe(false)
    expect(wrapper.find('button').exists()).toBe(false)
  })

  it('多条 steering/followUp → steering 优先（pi 消费顺序），显前 3 条 + 溢出计数', () => {
    const state: QueueState = {
      steering: ['steer1', 'steer2'],
      followUp: ['fu1'],
    }
    const wrapper = mountQB({ state })
    // 展平顺序：steering 全在前（3 条 ≤ VISIBLE_MAX，无溢出）
    expect(wrapper.text()).toContain('steer1')
    expect(wrapper.text()).toContain('steer2')
    expect(wrapper.text()).toContain('fu1')
    expect(wrapper.text()).not.toContain('+1')
  })

  it('超过 3 条（steer/followUp only）→ 只显前 3 条 + 「+N」溢出计数', () => {
    const state: QueueState = {
      steering: ['s1', 's2', 's3', 's4'],
      followUp: ['f1', 'f2'],
    }
    const wrapper = mountQB({ state })
    // 前 3 条：s1/s2/s3；f1/f2 与 s4 被截断，溢出 +3
    expect(wrapper.text()).toContain('s1')
    expect(wrapper.text()).toContain('s2')
    expect(wrapper.text()).toContain('s3')
    expect(wrapper.text()).toContain('+3')
    expect(wrapper.text()).not.toContain('s4')
  })

  it('只读契约收窄：steer/followUp 行不渲染删除/dequeue/编辑/撤回等破坏性按钮（无 emit 通道）', () => {
    const state: QueueState = { steering: ['x', 'y'], followUp: ['z'] }
    const wrapper = mountQB({ state })
    // 语义断言：不存在任何带删除/移除/撤回 title 的按钮（而非脆弱的计数）
    for (const keyword of ['删除', '移除', '撤回', 'dequeue', 'remove', 'cancel', '编辑']) {
      expect(wrapper.find(`button[title*="${keyword}"]`).exists()).toBe(false)
    }
    // steer/followUp 行无任何按钮（defer 行才渲染 ×）
    expect(wrapper.find('button').exists()).toBe(false)
  })

  it('点击 steer/followUp item 文本无副作用（只读契约，无 emit）', async () => {
    const state: QueueState = { steering: ['a', 'b'] }
    const wrapper = mountQB({ state })
    const itemTextsBefore = wrapper.findAll('.qb-item-text').map((w) => w.text())
    const item = wrapper.findAll('.qb-item-text')[0]
    if (item?.exists()) {
      await item.trigger('click')
    }
    await nextTick()
    const itemTextsAfter = wrapper.findAll('.qb-item-text').map((w) => w.text())
    expect(itemTextsAfter).toEqual(itemTextsBefore) // 内容不变 = 无副作用
    // steer/followUp 不 emit removeDefer（组件 emit 通道仅 defer 行触发）
    expect(wrapper.emitted('removeDefer')).toBeUndefined()
  })

  it('state 变化 → 列表内容跟随更新', async () => {
    const wrapper = mountQB({ state: { steering: ['a', 'b'] } })
    expect(wrapper.text()).toContain('a')
    expect(wrapper.text()).toContain('b')
    await wrapper.setProps({ state: { steering: ['c', 'd'] } })
    await nextTick()
    expect(wrapper.text()).toContain('c')
    expect(wrapper.text()).toContain('d')
    expect(wrapper.text()).not.toContain('a')
  })
})

describe('QueueBubble S8 · defer 行（compact-defer-composer-queue u1）', () => {
  it('A1 根门：state undefined（纯压缩入队）+ defer 非空 → defer 行渲染', () => {
    const wrapper = mountQB({
      state: undefined,
      deferEntries: [deferEntry('d1', '压缩中入队的消息')],
    })
    expect(wrapper.find('[data-testid="queue-bubble"]').exists()).toBe(true)
    // Hourglass icon（defer 专属）+ chip + 文本
    expect(wrapper.find('svg.lucide-hourglass').exists()).toBe(true)
    expect(wrapper.find('svg.lucide-zap').exists()).toBe(false)
    expect(wrapper.text()).toContain('压缩中入队的消息')
    expect(wrapper.text()).toContain('压缩后') // 缺省 deferChip
  })

  it('defer 行 chip 分档（deferChip prop 渲染）+ 行 title（deferHint prop）', () => {
    const wrapper = mountQB({
      state: undefined,
      deferEntries: [deferEntry('d1', '文本')],
      deferChip: '命令后',
      deferHint: '等待命令执行结束后发送',
    })
    // chip 渲染传入的 deferChip
    expect(wrapper.find('.bg-info-soft').exists()).toBe(true)
    expect(wrapper.find('.bg-info-soft').text()).toBe('命令后')
    // 行 title = 传入的 deferHint
    expect(wrapper.find('.qb-item').attributes('title')).toBe('等待命令执行结束后发送')
  })

  it('defer 行 × 撤销边界：未提交条目 × 可点 → emit removeDefer(id)，title=撤销排队', async () => {
    const wrapper = mountQB({
      state: undefined,
      deferEntries: [deferEntry('dq-1', '待撤销消息')],
      deferChip: '稍后发送',
      deferHint: '占用结束后发送',
    })
    // × 无禁用态（已提交条目不渲染 defer 行，见归一规则）
    const cancel = wrapper.find('[data-testid="defer-cancel-dq-1"]')
    expect(cancel.exists()).toBe(true)
    expect(cancel.attributes('disabled')).toBeUndefined()
    // title 挂外层 anchor span（hover 揭示载体）
    const anchor = wrapper.find('[data-testid="defer-cancel-anchor-dq-1"]')
    expect(anchor.attributes('title')).toBe('撤销排队')
    await cancel.trigger('click')
    expect(wrapper.emitted('removeDefer')).toEqual([['dq-1']])
  })

  it('+N 富内容徽标：segments 非 text 段 >0 时显示（title 复用 chipBadgeHint）', () => {
    const rich = deferEntry('dq-2', '帮我看下这个报错', [
      { type: 'image', id: 'img-1', path: '/tmp/shot.png', fileName: 'shot.png', displayName: '截图.png' },
      { type: 'skill', name: 'code-review' },
    ])
    const wrapper = mountQB({ state: undefined, deferEntries: [rich] })
    const badge = wrapper.find('[data-testid="defer-chips-dq-2"]')
    expect(badge.exists()).toBe(true)
    expect(badge.text()).toBe('+2')
    expect(badge.attributes('title')).toContain('2')
    // 纯文本条目无徽标
    const plain = deferEntry('dq-3', '纯文本')
    const wrapper2 = mountQB({ state: undefined, deferEntries: [plain] })
    expect(wrapper2.find('[data-testid="defer-chips-dq-3"]').exists()).toBe(false)
  })

  it('三组展平顺序 steering → followUp → defer；VISIBLE_MAX=3 覆盖三组总和', () => {
    const state: QueueState = { steering: ['steer1'], followUp: ['fu1'] }
    const entries = [deferEntry('d1', 'defer1'), deferEntry('d2', 'defer2')]
    const wrapper = mountQB({ state, deferEntries: entries })
    // 展平顺序：steer1 → fu1 → defer1（前 3 条可见），defer2 溢出 → +1
    expect(wrapper.findAll('.qb-item-text').map((w) => w.text())).toEqual(['steer1', 'fu1', 'defer1'])
    expect(wrapper.text()).toContain('+1')
    expect(wrapper.text()).not.toContain('defer2')
    // 溢出计数不重复计 defer 行（VISIBLE_MAX 单一口径）
    expect(wrapper.findAll('.qb-item').length).toBe(3)
  })

  it('deferEntries 变化 → defer 行跟随更新（响应式）', async () => {
    const wrapper = mountQB({ state: undefined, deferEntries: [deferEntry('d1', 'first')] })
    expect(wrapper.text()).toContain('first')
    await wrapper.setProps({ deferEntries: [deferEntry('d2', 'second')] })
    await nextTick()
    expect(wrapper.text()).toContain('second')
    expect(wrapper.text()).not.toContain('first')
  })
})
