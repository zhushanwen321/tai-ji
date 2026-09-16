/**
 * QueueBubble 组件单测 —— v6 内嵌队列气泡（投递所有权内核 u3c / D7 单源化后）。
 *
 * 组件契约（组件头注为准）：纯 props 展示——
 * - rows: QueueRow[]（调用方经 useQueueRows 从 session.delivery 帧投影过滤而来：
 *   非 direct 车道且未 delivered）
 * - hint: string（session 级占用分档 hover title）
 * - emit cancel(clientUuid)（× 撤销 → delivery.cancel）+ retry(clientUuid)（failed 行重试
 *   → delivery.resync 单条重报）
 * 行形态：状态 chip（排队中 / 投递中 / 发送失败）+ 对应 icon（Hourglass / Zap / AlertCircle）
 * + truncate 预览文本（>3 条显前 3 + 「+N」溢出）。
 *
 * 三视角覆盖：
 * - 观察者（形态）：单条/多条渲染结构、状态 icon 与 chip 文案、溢出计数、失败行红色标识
 * - 使用者（黑盒）：hover × 撤销 emit cancel；failed 行重试钮 emit retry；queued/in-flight
 *   行无重试钮；hint 落到行 title
 * - 构建者（白盒）：空 rows 不渲染根门；行增删跟随 props 变化（响应式）
 *
 * [HISTORICAL] 前身（draft-composer-states S8 → compact-defer-composer-queue u1）：数据源是
 * 「queue_update 帧 steering/followUp 快照 + useCompactQueue 未提交条目」双拼，含 Zap/Clock
 * 只读行与 defer 行 +N 富内容徽标。u3c 单源化后：pi 队列快照不再直驱 UI、本地 defer 队列
 * 整体退役，行/状态/撤销全部对齐内核条目；+N 徽标随帧无 segments 字段退役（草稿恢复改由
 * cancel reply 的 segments 快照承担，ADR-0043）。
 *
 * 运行：cd packages/renderer && pnpm test -- queue-bubble-s8
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import QueueBubble from '@/components/panel/QueueBubble.vue'
import type { QueueRow } from '@/composables/panel/useQueueRows'

/** 队列行构造（state 三态；默认 queued 车道行） */
function row(clientUuid: string, preview: string, state: QueueRow['state'] = 'queued'): QueueRow {
  return { clientUuid, preview, state }
}

/** mount 助手：rows/hint 为必传（Composer 恒传），缺省给中性值 */
function mountQB(overrides: { rows?: QueueRow[]; hint?: string } = {}) {
  return mount(QueueBubble, {
    props: {
      rows: overrides.rows ?? [],
      hint: overrides.hint ?? '等待上下文压缩完成后发送',
    },
  })
}

describe('QueueBubble · 根门与单源行渲染', () => {
  it('rows 为空 → 不渲染（无待发条目即无队列区）', () => {
    const wrapper = mountQB()
    expect(wrapper.find('[data-testid="queue-bubble"]').exists()).toBe(false)
  })

  it('单条 queued 行 → Hourglass icon + 「排队中」chip + 预览文本（用户可见状态）', () => {
    const wrapper = mountQB({ rows: [row('u-1', '补充注册页校验', 'queued')] })
    expect(wrapper.find('[data-testid="queue-bubble"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('补充注册页校验')
    expect(wrapper.text()).toContain('排队中')
    expect(wrapper.find('svg.lucide-hourglass').exists()).toBe(true)
    expect(wrapper.find('svg.lucide-zap').exists()).toBe(false)
  })

  it('in-flight 行 → Zap icon（accent）+「投递中」chip', () => {
    const wrapper = mountQB({ rows: [row('u-2', '正在投递的消息', 'in-flight')] })
    expect(wrapper.text()).toContain('正在投递的消息')
    expect(wrapper.text()).toContain('投递中')
    expect(wrapper.find('svg.lucide-zap').exists()).toBe(true)
    expect(wrapper.find('svg.lucide-hourglass').exists()).toBe(false)
  })

  it('failed 行 → AlertCircle（danger）+「发送失败」chip + 重试钮可见（§3.4 重试耗尽行）', () => {
    const wrapper = mountQB({ rows: [row('u-3', '重试耗尽的文本', 'failed')] })
    expect(wrapper.text()).toContain('发送失败')
    expect(wrapper.find('svg.lucide-circle-alert').exists()).toBe(true)
    expect(wrapper.find('[data-testid="queue-retry-u-3"]').exists()).toBe(true)
    // 状态 chip 用 danger 底/前景（红色标识）
    const chip = wrapper.find('[data-testid="queue-state-u-3"]')
    expect(chip.classes()).toContain('text-danger')
  })

  it('queued/in-flight 行不渲染重试钮（仅 failed 行有重试入口）', () => {
    const wrapper = mountQB({ rows: [row('u-4', '排队', 'queued'), row('u-5', '投递中', 'in-flight')] })
    expect(wrapper.find('[data-testid="queue-retry-u-4"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="queue-retry-u-5"]').exists()).toBe(false)
  })

  it('多条 → 显前 3 条 + 「+N」溢出计数（行序 = 帧序 = 内核 FIFO 发送序）', () => {
    const wrapper = mountQB({
      rows: [row('u-1', 'm1'), row('u-2', 'm2'), row('u-3', 'm3'), row('u-4', 'm4'), row('u-5', 'm5')],
    })
    expect(wrapper.findAll('.qb-item-text').map((w) => w.text())).toEqual(['m1', 'm2', 'm3'])
    expect(wrapper.text()).toContain('+2')
    expect(wrapper.text()).not.toContain('m4')
  })

  it('行 hover title = 传入的 hint（session 级占用分档文案）', () => {
    const wrapper = mountQB({ rows: [row('u-1', 'x')], hint: '等待命令执行结束后发送' })
    expect(wrapper.find('[data-testid="queue-item-u-1"]').attributes('title')).toBe('等待命令执行结束后发送')
  })

  it('rows 变化 → 行跟随更新（响应式）；清空 → 根门关闭', async () => {
    const wrapper = mountQB({ rows: [row('u-1', 'first')] })
    expect(wrapper.text()).toContain('first')
    await wrapper.setProps({ rows: [row('u-1', 'first'), row('u-2', 'second')] })
    await nextTick()
    expect(wrapper.text()).toContain('second')
    await wrapper.setProps({ rows: [] })
    await nextTick()
    expect(wrapper.find('[data-testid="queue-bubble"]').exists()).toBe(false)
  })
})

describe('QueueBubble · 行操作（撤销 / 重试）', () => {
  it('× 撤销：点击 emit cancel(clientUuid)，title=撤销排队（hover 揭示载体）', async () => {
    const wrapper = mountQB({ rows: [row('u-9', '待撤销消息')] })
    const cancel = wrapper.find('[data-testid="queue-cancel-u-9"]')
    expect(cancel.exists()).toBe(true)
    expect(cancel.attributes('disabled')).toBeUndefined()
    const anchor = wrapper.find('[data-testid="queue-cancel-anchor-u-9"]')
    expect(anchor.attributes('title')).toBe('撤销排队')
    await cancel.trigger('click')
    expect(wrapper.emitted('cancel')).toEqual([['u-9']])
  })

  it('in-flight 行 × 同样可撤（V10：投递中走内核收回-重投，UI 无禁用态）', async () => {
    const wrapper = mountQB({ rows: [row('u-10', '投递中的消息', 'in-flight')] })
    const cancel = wrapper.find('[data-testid="queue-cancel-u-10"]')
    await cancel.trigger('click')
    expect(wrapper.emitted('cancel')).toEqual([['u-10']])
  })

  it('failed 行重试：点击 emit retry(clientUuid)，title=重试发送', async () => {
    const wrapper = mountQB({ rows: [row('u-11', '失败的消息', 'failed')] })
    const retry = wrapper.find('[data-testid="queue-retry-u-11"]')
    const anchor = retry.element.closest('span')
    expect(anchor?.getAttribute('title')).toBe('重试发送')
    await retry.trigger('click')
    expect(wrapper.emitted('retry')).toEqual([['u-11']])
    // 重试不等于撤销：cancel 通道未被触发
    expect(wrapper.emitted('cancel')).toBeUndefined()
  })

  it('无 chevron / 无折叠控件（v6 去折叠，不支持收起）', () => {
    const wrapper = mountQB({ rows: [row('u-1', 'x')] })
    expect(wrapper.find('svg.lucide-chevron-right').exists()).toBe(false)
  })
})
