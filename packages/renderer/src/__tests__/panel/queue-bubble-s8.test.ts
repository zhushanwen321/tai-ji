/**
 * QueueBubble 组件单测 —— v6 内嵌队列气泡（投递所有权内核 u3c / D7 单源化后）。
 *
 * 组件契约（组件头注为准）：纯 props 展示——
 * - rows: QueueRow[]（调用方经 useQueueRows 从 session.delivery 帧派生视图过滤而来：
 *   非 direct 投递路径且未 delivered）
 * - hint: string（session 级占用分档 hover title）+ expanded?: boolean（+N 展开开关
 *   展开态，Q2——持有在 useQueueRows per-session 分区，Composer 传入）
 * - emit cancel(clientUuid)（× 撤销 → delivery.cancel）+ retry(clientUuid)（failed 行
 *   重试 → delivery.resync 单条重报）+ retryAll()（failed ≥2 批量重报，Q5）+
 *   toggleExpand()（+N 开关，Q2）
 * 行形态：状态 chip（排队中 / 投递中 / 发送未确认——Q6 三口径统一，行=状态、错误气泡=
 * 事件详情分层）+ 对应 icon（Hourglass / Zap / AlertCircle）+ truncate 预览文本
 * （>3 条显前 3 + 「+N」可点展开开关，Q2）。
 *
 * 三视角覆盖：
 * - 观察者（形态）：单条/多条渲染结构、状态 icon 与 chip 文案、溢出计数、失败行红色标识
 * - 使用者（黑盒）：hover × 撤销 emit cancel；failed 行重试钮 emit retry；failed ≥2 重试
 *   全部 emit retryAll；+N / 收起 emit toggleExpand；failed 行 title 附判重说明（Q6）
 * - 构建者（白盒）：空 rows 不渲染根门；行增删跟随 props 变化（响应式）
 *
 * [HISTORICAL] 前身（draft-composer-states S8 → compact-defer-composer-queue u1）：数据源是
 * 「queue_update 帧 steering/followUp 快照 + useCompactQueue 未提交条目」双拼，含 Zap/Clock
 * 只读行与 defer 行 +N 富内容徽标。u3c 单源化后：pi 队列快照不再直驱 UI、本地 defer 队列
 * 整体退役，行/状态/撤销全部对齐内核条目；+N 徽标随帧无 segments 字段退役（草稿恢复改由
 * cancel reply 的 segments 快照承担，ADR-0043）；+N 静态文本升级为可点展开开关（Q2）。
 *
 * 运行：cd packages/renderer && pnpm test -- queue-bubble-s8
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import QueueBubble from '@/components/panel/QueueBubble.vue'
import type { QueueRow } from '@/composables/panel/useQueueRows'

/** 队列行构造（state 三态；默认 queued 投递路径行） */
function row(clientUuid: string, preview: string, state: QueueRow['state'] = 'queued'): QueueRow {
  return { clientUuid, preview, state }
}

/** mount 助手：rows/hint 为必传（Composer 恒传），缺省给中性值 */
function mountQB(overrides: { rows?: QueueRow[]; hint?: string; expanded?: boolean } = {}) {
  return mount(QueueBubble, {
    props: {
      rows: overrides.rows ?? [],
      hint: overrides.hint ?? '等待上下文压缩完成后发送',
      ...(overrides.expanded !== undefined ? { expanded: overrides.expanded } : {}),
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

  it('failed 行 → AlertCircle（danger）+「发送未确认」chip（Q6 统一口径）+ 重试钮可见（§3.4 失败行）', () => {
    const wrapper = mountQB({ rows: [row('u-3', '未确认送达的文本', 'failed')] })
    expect(wrapper.text()).toContain('发送未确认')
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

  it('failed 行 title 在 hint 之外附判重说明（Q6 分层：行 = 状态 + 恢复指引）', () => {
    const wrapper = mountQB({ rows: [row('u-6', '失败的', 'failed')], hint: '占用结束后发送' })
    const title = wrapper.find('[data-testid="queue-item-u-6"]').attributes('title') ?? ''
    expect(title).toContain('占用结束后发送')
    expect(title).toContain('点重试会自动判重，不会重复投递')
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

  it('无 chevron 折叠控件（+N 开关为纯文字 Button，无 chevron 图标形态）', () => {
    const wrapper = mountQB({ rows: [row('u-1', 'x')] })
    expect(wrapper.find('svg.lucide-chevron-right').exists()).toBe(false)
  })
})

describe('QueueBubble · +N 展开开关（Q2）与重试全部（Q5）', () => {
  const FIVE_ROWS = [row('u-1', 'm1'), row('u-2', 'm2'), row('u-3', 'm3'), row('u-4', 'm4'), row('u-5', 'm5')]

  it('+N 为可点开关：点击 emit toggleExpand，aria-expanded 反映展开态（用户可见展开入口）', async () => {
    const wrapper = mountQB({ rows: FIVE_ROWS })
    expect(wrapper.text()).toContain('+2')
    const expander = wrapper.find('[data-testid="queue-expand"]')
    expect(expander.exists()).toBe(true)
    expect(expander.attributes('aria-expanded')).toBe('false')
    await expander.trigger('click')
    expect(wrapper.emitted('toggleExpand')).toHaveLength(1)
  })

  it('expanded=true → 全部行渲染（被折叠行可见，行操作天然可用）+ 无 +N 溢出', async () => {
    const wrapper = mountQB({ rows: FIVE_ROWS, expanded: true })
    expect(wrapper.findAll('.qb-item-text').map((w) => w.text())).toEqual(['m1', 'm2', 'm3', 'm4', 'm5'])
    expect(wrapper.find('[data-testid="queue-expand"]').exists()).toBe(false)
    // 收起出口：收起后仍有溢出行才显示
    expect(wrapper.find('[data-testid="queue-collapse"]').exists()).toBe(true)
    await wrapper.find('[data-testid="queue-collapse"]').trigger('click')
    expect(wrapper.emitted('toggleExpand')).toHaveLength(1)
  })

  it('展开但无溢出（行数 ≤ 上限）→ 不渲染收起出口', () => {
    const wrapper = mountQB({ rows: [row('u-1', 'm1'), row('u-2', 'm2')], expanded: true })
    expect(wrapper.find('[data-testid="queue-collapse"]').exists()).toBe(false)
  })

  it('failed ≥2 → 「重试全部失败项」入口可见，点击 emit retryAll', async () => {
    const wrapper = mountQB({
      rows: [row('u-11', '失败一', 'failed'), row('u-12', '失败二', 'failed'), row('u-13', '排队', 'queued')],
    })
    const retryAll = wrapper.find('[data-testid="queue-retry-all"]')
    expect(retryAll.exists()).toBe(true)
    expect(retryAll.text()).toContain('重试全部失败项')
    await retryAll.trigger('click')
    expect(wrapper.emitted('retryAll')).toHaveLength(1)
  })

  it('failed <2 → 不渲染重试全部入口（单条走行内重试钮）', () => {
    const wrapper = mountQB({ rows: [row('u-11', '失败一', 'failed'), row('u-13', '排队', 'queued')] })
    expect(wrapper.find('[data-testid="queue-retry-all"]').exists()).toBe(false)
  })
})
