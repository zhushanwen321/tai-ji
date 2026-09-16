/**
 * ActivityStrip 组件测试（session-occupancy u6a / D7 展示统一）。
 *
 * 覆盖（三视角，用户可见 DOM 断言优先）：
 * - P1 组件黑盒·四类状态各自渲染：compacting（manual→压缩中 / threshold→自动压缩）、
 *   bash（正在执行 + mono 命令）、thinking（turn=dispatching→思考中…）、
 *   settling（turn=settling 且无 compacting/bash→行出现，R3-U1；文案复用 dispatching key，
 *   P-1 探针 V8 校准点）
 * - P1.5 组件黑盒·横线分隔行族（[2026-09-16 压缩中降级] compacting 行自通栏 accent-soft
 *   活动带降级为与 bash/thinking/settling 行同构的 spinner 分隔行：两端渐隐横线 +
 *   13px/stroke 2.2 spinner + text-sm/fg/550 主文案 +「待发 N」chip；原 band 用例改写）。
 *   chip 计数口径不变 = 只计未提交条目（mode===undefined）
 * - P1.6 行高常量强绑定 DOM（D4 连带面：COMPACTING_NOTICE_HEIGHT / EXECUTING_BASH_NOTICE_HEIGHT
 *   随降级同批重测，jsdom 无布局 → 断言「常量值 + 常量所绑定的 class 结构」双向锁）
 * - P2 组件黑盒·优先级堆叠：compacting + bash 并存 → 两行且 compacting 在上；
 *   thinking 与 compacting/bash 互斥（「无以上但有 dispatching turn」才显示）；
 *   settling 与 compacting 并存 → 仅 compacting 行（同档位幂等，不重复堆叠）；
 *   turn=generating 不渲染行（streaming 本体由 TurnMeta「工作中」承担，D6 活动条列）
 * - P3 组件黑盒·全 idle 不渲染（G3：无占用 = 无活动条）
 * - P4 MessageStream 集成·迁移收口：TurnMeta 旧 dispatching 占位不再渲染 + thinking 行接管；
 *   executingBash 瞬时行迁入（bashStart 帧驱动）；fork notice 与活动条的文档流定位顺序
 *   （活动条在前——ForkNotice 为文档流 block，按文档序自然堆叠）
 * - P5 i18n key 完整：五个文案 key（四个行文案 + 待发 chip）在 zh/en locale 均定义
 *
 * i18n：vitest 全局 setup（vitest-i18n-setup.ts）mock useI18n → t() 返回 zh-CN 文案。
 * 待发 chip 文案键（panel.message.compactingQueueChip）已在 zh/en locales 落地，本文件
 * 不做任何键注入——chip 用例按「同键同参」消费真实 locales，键缺失由 P5 断言直接判红。
 *
 * 运行：cd packages/renderer && npx vitest run src/components/panel/message-stream/__tests__/ActivityStrip.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { chatViewDepsModule } from '@/__tests__/helpers/chat-stream-mount'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import { createPinia, setActivePinia } from 'pinia'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { QueuedMessage } from '@/composables/panel/useCompactQueue'
import { COMPACTING_NOTICE_HEIGHT, EXECUTING_BASH_NOTICE_HEIGHT } from '@/composables/panel/message-stream-layout'

/** 全局 i18n mock 的 t（与组件同一消费面）：chip 文案按「同键同参」比对，不锁措辞 */
const { t } = useI18n()

const apiMock = vi.hoisted(() => ({
  send: vi.fn(() => Promise.resolve()),
  steer: vi.fn(() => Promise.resolve()),
  streamSubscribe: vi.fn(() => () => {}),
}))

/** useCompactQueue mock：band 副文案 count 口径测试需注入 mode!==undefined 条目（真实队列公开
 *  API 无法写 mode——flush 内部 setEntryMode），故 mock peek 返回可控快照；队列真实行为由
 *  use-compact-queue.test.ts 覆盖。 */
const queueMock = vi.hoisted(() => ({
  peek: vi.fn(() => [] as QueuedMessage[]),
}))

vi.mock('@/api', () => ({ project: { load: vi.fn().mockResolvedValue({ projects: [], activeProjectId: '' }), save: vi.fn().mockResolvedValue(undefined) },
  chat: { send: apiMock.send, steer: apiMock.steer, streamSubscribe: apiMock.streamSubscribe },
  session: {},
}))
vi.mock('@/composables/panel/useCompactQueue', () => ({
  useCompactQueue: () => ({ peek: queueMock.peek }),
}))
// MessageStream 挂载的重依赖 composable（对齐 MessageStream.wire.test.ts 的隔离策略）
vi.mock('@/composables/features/chat/useChat', () => ({
  useChat: () => ({ editAndResend: vi.fn(), loadMoreHistory: vi.fn(), hasMoreHistory: () => false }),
  resetChatModuleState: vi.fn(),
}))
vi.mock('@/composables/features/sidebar/useSidebar', () => ({
  useSidebar: () => ({ forkSession: vi.fn(), abortHandoff: vi.fn(), selectSession: vi.fn() }),
}))
vi.mock('@/composables/panel/useChatViewDeps', () => chatViewDepsModule())

import ActivityStrip from '../ActivityStrip.vue'
import MessageStream from '../../MessageStream.vue'
import { useChatStore } from '@/stores/chat'
import { useForkNoticeFeed, resetForkNoticeFeed } from '@/composables/effects/useForkNoticeEffect'
import type { SessionOccupancyState } from '@taiji/core'

const SID = 'sess-activity-strip'

/** 组件黑盒 mount（真实 pinia chat store 驱动 occupancy/reason，executingBash 走 props）。
 *  pinia 实例先 setActivePinia 再传入 app plugins——保证组件内外的 useChatStore() 同源
 *  （若各自 createPinia()，组件读的 store 与测试写状态的 store 是两个实例，occupancy 不传导）。 */
async function mountStrip(opts: {
  occupancy?: SessionOccupancyState
  reason?: string
  executingBash?: { command: string; startedAt: number }
} = {}) {
  const pinia = createPinia()
  setActivePinia(pinia)
  const chat = useChatStore()
  if (opts.occupancy) chat.setOccupancy(SID, opts.occupancy)
  if (opts.reason !== undefined) chat.setCompactingReason(SID, opts.reason)
  const wrapper = mount(ActivityStrip, {
    props: { sessionId: SID, executingBash: opts.executingBash },
    global: { plugins: [pinia] },
  })
  await nextTick()
  return wrapper
}

beforeEach(() => {
  setActivePinia(createPinia())
  resetForkNoticeFeed()
  queueMock.peek.mockReset()
  queueMock.peek.mockReturnValue([])
})

describe('ActivityStrip · 四类状态各自渲染（P1）', () => {
  it('compacting + reason=manual（缺省）→「压缩中」行 + spinner', async () => {
    const wrapper = await mountStrip({ occupancy: { turn: 'idle', compacting: true, bash: false } })
    const row = wrapper.find('[data-testid="activity-strip-row-compacting"]')
    expect(row.exists()).toBe(true)
    // 用户可见文案（zh-CN）+ spinner（Loader2 animate-spin）+ 两条渐隐横线（降级后与 bash 行同构，
    // 不再是无横线的通栏带——band 结构断言见下方「横线分隔行」describe）
    expect(wrapper.find('[data-testid="activity-strip-text-compacting"]').text()).toBe('压缩中')
    expect(row.find('.animate-spin').exists()).toBe(true)
    expect(row.findAll('.h-px').length).toBe(2)
    wrapper.unmount()
  })

  it('compacting + reason=threshold →「正在自动压缩上下文」行（M4 reason 文案源）', async () => {
    const wrapper = await mountStrip({
      occupancy: { turn: 'idle', compacting: true, bash: false },
      reason: 'threshold',
    })
    expect(wrapper.find('[data-testid="activity-strip-text-compacting"]').text()).toBe('正在自动压缩上下文')
    wrapper.unmount()
  })

  it('compacting + reason=overflow →「正在自动压缩上下文」行', async () => {
    const wrapper = await mountStrip({
      occupancy: { turn: 'idle', compacting: true, bash: false },
      reason: 'overflow',
    })
    expect(wrapper.find('[data-testid="activity-strip-text-compacting"]').text()).toBe('正在自动压缩上下文')
    wrapper.unmount()
  })

  it('bash →「正在执行」+ mono 命令文本（executingBash props 注入）', async () => {
    const wrapper = await mountStrip({
      occupancy: { turn: 'idle', compacting: false, bash: false },
      executingBash: { command: 'pnpm test', startedAt: Date.now() },
    })
    const row = wrapper.find('[data-testid="activity-strip-row-bash"]')
    expect(row.exists()).toBe(true)
    const text = wrapper.find('[data-testid="activity-strip-text-bash"]')
    expect(text.text()).toContain('正在执行')
    expect(text.text()).toContain('pnpm test')
    expect(row.find('svg').exists()).toBe(true)
    wrapper.unmount()
  })

  it('turn=dispatching →「思考中…」行（occupancy 权威投影，替代原 TurnMeta 占位）', async () => {
    const wrapper = await mountStrip({ occupancy: { turn: 'dispatching', compacting: false, bash: false } })
    const row = wrapper.find('[data-testid="activity-strip-row-thinking"]')
    expect(row.exists()).toBe(true)
    expect(wrapper.find('[data-testid="activity-strip-text-thinking"]').text()).toBe('思考中…')
    expect(row.find('.animate-spin').exists()).toBe(true)
    wrapper.unmount()
  })

  it('turn=settling（无 compacting/bash）→ settling 行出现（R3-U1：D6 表行 4 活动条列，收尾窗口不回到无指示）', async () => {
    const wrapper = await mountStrip({ occupancy: { turn: 'settling', compacting: false, bash: false } })
    const row = wrapper.find('[data-testid="activity-strip-row-settling"]')
    expect(row.exists()).toBe(true)
    // 文案复用 dispatching key「思考中…」（P-1 探针 V8 校准点：P95 > 2s 常态化则换「收尾中…」）
    expect(wrapper.find('[data-testid="activity-strip-text-settling"]').text()).toBe('思考中…')
    expect(row.find('.animate-spin').exists()).toBe(true)
    wrapper.unmount()
  })

  it('turn=generating → 不渲染行（streaming 本体由 TurnMeta「工作中」承担，D6 活动条列）', async () => {
    const wrapper = await mountStrip({ occupancy: { turn: 'generating', compacting: false, bash: false } })
    expect(wrapper.find('[data-testid="activity-strip"]').exists()).toBe(false)
    wrapper.unmount()
  })
})

describe('ActivityStrip · 横线分隔行族（压缩中降级 + D3 增强规格 / A4+A7）', () => {
  /** 构造待发条目（可注入提交通道 mode，模拟 flush 已提交条目——chip count 口径过滤） */
  function queued(id: string, text: string, mode?: 'send' | 'steer'): QueuedMessage {
    const entry: QueuedMessage = { id, text, segments: [{ type: 'text', text }] }
    if (mode) entry.mode = mode
    return entry
  }

  /** D3 增强规格分割线（两端渐隐：transparent → --border-strong 18% → 82% → transparent）。
   *  以 Tailwind 任意值类承载（jsdom 不加载生成的 CSS，故断言 class 声明本身）。 */
  const FADE_LINE_CLASS =
    'bg-[image:linear-gradient(to_right,transparent,var(--border-strong)_18%,var(--border-strong)_82%,transparent)]'

  it('compacting 行降级为分隔行：content-col/system-notice 保留、无通栏带痕迹、两条渐隐横线', async () => {
    const wrapper = await mountStrip({ occupancy: { turn: 'idle', compacting: true, bash: false } })
    const row = wrapper.find('[data-testid="activity-strip-row-compacting"]')
    expect(row.exists()).toBe(true)
    // 降级考核点：通栏活动带形态（-mx-5 通栏 / accent-soft 底 / border-y）全部摘除，
    // 回归 DESIGN.md §6.1 横线分隔行族的居中内容列（content-col + system-notice 保留）
    expect(row.classes()).toContain('content-col')
    expect(row.classes()).toContain('system-notice')
    expect(row.classes()).not.toContain('bg-[var(--accent-soft)]')
    expect(row.classes()).not.toContain('border-y')
    expect(row.classes()).not.toContain('-mx-5')
    // 行距 py-1.5（D3 表：py-1 → py-1.5）
    expect(row.classes()).toContain('py-1.5')
    // 两条渐隐横线（h-px + 渐隐 background-image，替代原 bg-border 纯色 / border-y）
    const lines = row.findAll('.h-px')
    expect(lines).toHaveLength(2)
    for (const line of lines) {
      expect(line.classes()).toContain('flex-1')
      expect(line.classes()).toContain(FADE_LINE_CLASS)
    }
    // spinner：13px + stroke 2.2 + neutral-mid（原通栏带的 size-3.5 text-accent 作废）
    const spinner = row.find('.animate-spin')
    expect(spinner.exists()).toBe(true)
    expect(spinner.classes()).toContain('size-[13px]')
    expect(spinner.classes()).toContain('text-neutral-mid')
    expect(spinner.attributes('stroke-width')).toBe('2.2')
    // 主文案（文本容器首个 span，模板序：主文案 → 命令 → chip）：text-sm / neutral-fg / 550
    //（D3 表：text-xs/mid/400 → text-sm/fg/550）
    const main = row.find('[data-testid="activity-strip-text-compacting"] > span')
    expect(main.classes()).toContain('text-[length:var(--text-sm)]')
    expect(main.classes()).toContain('text-neutral-fg')
    expect(main.classes()).toContain('font-[550]')
    wrapper.unmount()
  })

  it('待发 chip：只计 mode===undefined 未提交条目（已提交 steer/send 不计），文案同键同参', async () => {
    queueMock.peek.mockReturnValue([
      queued('u1', '未提交 A'),
      queued('s1', '已提交 steer', 'steer'),
      queued('s2', '已提交 send', 'send'),
      queued('u2', '未提交 B'),
    ])
    const wrapper = await mountStrip({ occupancy: { turn: 'idle', compacting: true, bash: false } })
    const chip = wrapper.find('[data-testid="activity-strip-flush-hint-compacting"]')
    expect(chip.exists()).toBe(true)
    // 文案 = 同键同参解析结果（键在 zh-CN locale 定义，完整性由 P5 断言锁死）；
    // 计数错误（如把已提交条目计入 = 4）会让两侧文案不等
    expect(chip.text()).toBe(t('panel.message.compactingQueueChip', { count: 2 }))
    // chip 形态（D3 表）：mono text-3xs + border-strong 描边（替代原副文案长句的「·」拼接）
    expect(chip.classes()).toContain('font-mono')
    expect(chip.classes()).toContain('text-[length:var(--text-3xs)]')
    expect(chip.classes()).toContain('border-border-strong')
    // 原副文案长句形态清除：不再有「·」分隔与 compactingFlushHint 长文案
    expect(wrapper.find('[data-testid="activity-strip-row-compacting"]').text()).not.toContain('·')
    expect(wrapper.find('[data-testid="activity-strip-row-compacting"]').text()).not.toContain('完成后自动发送')
    wrapper.unmount()
  })

  it('count=0：chip 不渲染，行仍在（压缩状态本身独立成立，A4）', async () => {
    queueMock.peek.mockReturnValue([])
    const wrapper = await mountStrip({ occupancy: { turn: 'idle', compacting: true, bash: false } })
    const row = wrapper.find('[data-testid="activity-strip-row-compacting"]')
    expect(row.exists()).toBe(true)
    expect(wrapper.find('[data-testid="activity-strip-flush-hint-compacting"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('bash/thinking/settling 行同步 D3 增强规格（同构分隔行：渐隐线 + 13px spinner + text-sm 主文案）', async () => {
    const wrapper = await mountStrip({
      occupancy: { turn: 'idle', compacting: false, bash: true },
      executingBash: { command: 'pnpm test', startedAt: Date.now() },
    })
    const bashRow = wrapper.find('[data-testid="activity-strip-row-bash"]')
    expect(bashRow.exists()).toBe(true)
    expect(bashRow.classes()).toContain('system-notice')
    expect(bashRow.classes()).toContain('content-col')
    expect(bashRow.classes()).toContain('py-1.5')
    expect(bashRow.classes()).not.toContain('bg-[var(--accent-soft)]')
    // 两条渐隐横线（D3：bg-border 纯色 → 两端渐隐 border-strong）
    const bashLines = bashRow.findAll('.h-px')
    expect(bashLines).toHaveLength(2)
    for (const line of bashLines) {
      expect(line.classes()).toContain(FADE_LINE_CLASS)
    }
    // spinner 13px / stroke 2.2 / neutral-mid
    const spinner = bashRow.find('.animate-spin')
    expect(spinner.classes()).toContain('size-[13px]')
    expect(spinner.attributes('stroke-width')).toBe('2.2')
    // 主文案 text-sm/fg/550；命令保持 mono text-xs
    const main = bashRow.find('[data-testid="activity-strip-text-bash"] > span')
    expect(main.classes()).toContain('text-[length:var(--text-sm)]')
    expect(main.classes()).toContain('font-[550]')
    const command = bashRow.find('[data-testid="activity-strip-text-bash"] .font-mono')
    expect(command.text()).toBe('pnpm test')
    expect(command.classes()).toContain('text-[length:var(--text-xs)]')
    wrapper.unmount()

    // thinking 行：同款结构（渐隐线 + 13px spinner + text-sm 主文案），无 chip
    const thinking = await mountStrip({ occupancy: { turn: 'dispatching', compacting: false, bash: false } })
    const thinkingRow = thinking.find('[data-testid="activity-strip-row-thinking"]')
    expect(thinkingRow.findAll('.h-px')).toHaveLength(2)
    expect(thinkingRow.find('.animate-spin').classes()).toContain('size-[13px]')
    expect(thinking.find('[data-testid="activity-strip-text-thinking"] > span').classes()).toContain(
      'text-[length:var(--text-sm)]',
    )
    expect(thinkingRow.find('[data-testid="activity-strip-flush-hint-thinking"]').exists()).toBe(false)
    thinking.unmount()

    // settling 行：同款结构
    const settling = await mountStrip({ occupancy: { turn: 'settling', compacting: false, bash: false } })
    const settlingRow = settling.find('[data-testid="activity-strip-row-settling"]')
    expect(settlingRow.findAll('.h-px')).toHaveLength(2)
    expect(settlingRow.find('.animate-spin').classes()).toContain('size-[13px]')
    settling.unmount()
  })

  it('主文案 key 分档：manual→压缩中（分隔行内）、threshold→正在自动压缩上下文（A7）', async () => {
    const manual = await mountStrip({ occupancy: { turn: 'idle', compacting: true, bash: false } })
    expect(manual.find('[data-testid="activity-strip-text-compacting"]').text()).toBe('压缩中')
    manual.unmount()
    const auto = await mountStrip({
      occupancy: { turn: 'idle', compacting: true, bash: false },
      reason: 'threshold',
    })
    expect(auto.find('[data-testid="activity-strip-text-compacting"]').text()).toBe('正在自动压缩上下文')
    auto.unmount()
  })
})

describe('ActivityStrip · 行高常量强绑定 DOM（D4 连带面）', () => {
  /** 常量与 DOM 的双向锁：jsdom 无真实布局（无法量高），故断言「常量值 = D3 规格算式结果」
   *  + 「常量所绑定的 class 结构还在」——改了 padding/字号/icon 而不同步常量时，本組报红。
   *  算式：py-1.5(6px×2) + 内容行 max(chip 10×1.8+2border=20px, 主文案 text-sm×1.5≈19.5px) = 32px
   *  （实测校准位见设计检查点 1：dev 断言 useConstantHeightAssert 以 ±1px 容差校准）。 */
  it('COMPACTING_NOTICE_HEIGHT = 32 且 compacting 行结构仍为所绑定形态', async () => {
    expect(COMPACTING_NOTICE_HEIGHT).toBe(32)
    queueMock.peek.mockReturnValue([{ id: 'q1', text: '待发', segments: [{ type: 'text', text: '待发' }] }])
    const wrapper = await mountStrip({ occupancy: { turn: 'idle', compacting: true, bash: false } })
    const row = wrapper.find('[data-testid="activity-strip-row-compacting"]')
    expect(row.classes()).toContain('py-1.5')
    expect(row.find('[data-testid="activity-strip-text-compacting"] > span').classes()).toContain(
      'text-[length:var(--text-sm)]',
    )
    expect(wrapper.find('[data-testid="activity-strip-flush-hint-compacting"]').classes()).toContain('leading-[1.8]')
    wrapper.unmount()
  })

  it('EXECUTING_BASH_NOTICE_HEIGHT = 32 且 bash 行结构仍为所绑定形态（D3 三项同时改行高）', async () => {
    expect(EXECUTING_BASH_NOTICE_HEIGHT).toBe(32)
    const wrapper = await mountStrip({
      occupancy: { turn: 'idle', compacting: false, bash: true },
      executingBash: { command: 'pnpm test', startedAt: Date.now() },
    })
    const row = wrapper.find('[data-testid="activity-strip-row-bash"]')
    expect(row.classes()).toContain('py-1.5')
    expect(row.find('[data-testid="activity-strip-text-bash"] > span').classes()).toContain(
      'text-[length:var(--text-sm)]',
    )
    expect(row.find('.animate-spin').classes()).toContain('size-[13px]')
    wrapper.unmount()
  })
})

describe('ActivityStrip · 优先级堆叠与互斥（P2）', () => {
  it('compacting + bash 并存 → 两行堆叠且 compacting 在上（DOM 顺序断言）', async () => {
    const wrapper = await mountStrip({
      occupancy: { turn: 'idle', compacting: true, bash: true },
      executingBash: { command: 'ls -la', startedAt: Date.now() },
    })
    const rows = wrapper.findAll('[data-testid^="activity-strip-row-"]')
    expect(rows).toHaveLength(2)
    expect(rows[0].attributes('data-testid')).toBe('activity-strip-row-compacting')
    expect(rows[1].attributes('data-testid')).toBe('activity-strip-row-bash')
    wrapper.unmount()
  })

  it('compacting 时 turn=dispatching → 只渲染 compacting 行（thinking 不与压缩行重复堆叠）', async () => {
    const wrapper = await mountStrip({ occupancy: { turn: 'dispatching', compacting: true, bash: false } })
    const rows = wrapper.findAll('[data-testid^="activity-strip-row-"]')
    expect(rows).toHaveLength(1)
    expect(rows[0].attributes('data-testid')).toBe('activity-strip-row-compacting')
    expect(wrapper.find('[data-testid="activity-strip-row-thinking"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('bash 时 turn=dispatching → 只渲染 bash 行', async () => {
    const wrapper = await mountStrip({
      occupancy: { turn: 'dispatching', compacting: false, bash: true },
      executingBash: { command: 'sleep 1', startedAt: Date.now() },
    })
    const rows = wrapper.findAll('[data-testid^="activity-strip-row-"]')
    expect(rows).toHaveLength(1)
    expect(rows[0].attributes('data-testid')).toBe('activity-strip-row-bash')
    wrapper.unmount()
  })

  it('settling + compacting → 仅 compacting 行（R3-U1 幂等：settling 与 compacting 并存不重复堆叠）', async () => {
    const wrapper = await mountStrip({ occupancy: { turn: 'settling', compacting: true, bash: false } })
    const rows = wrapper.findAll('[data-testid^="activity-strip-row-"]')
    expect(rows).toHaveLength(1)
    expect(rows[0].attributes('data-testid')).toBe('activity-strip-row-compacting')
    expect(wrapper.find('[data-testid="activity-strip-row-settling"]').exists()).toBe(false)
    wrapper.unmount()
  })
})

describe('ActivityStrip · 全 idle 不渲染（P3）', () => {
  it('occupancy 全 idle + 无 executingBash → 容器不存在（G3：无占用 = 无活动条）', async () => {
    const wrapper = await mountStrip({ occupancy: { turn: 'idle', compacting: false, bash: false } })
    // v-if=false 渲染注释占位节点：容器与任意行均不存在
    expect(wrapper.find('[data-testid="activity-strip"]').exists()).toBe(false)
    expect(wrapper.findAll('[data-testid^="activity-strip-row-"]')).toHaveLength(0)
    wrapper.unmount()
  })
})

describe('ActivityStrip × MessageStream 集成 · 迁移收口（P4）', () => {
  /** mount MessageStream（真实 chat store 驱动 occupancy；照既有 MessageStream 集成测试的 mountStream 模式） */
  async function mountStream(sessionId: string) {
    const wrapper = mount(MessageStream, {
      props: { sessionId },
      attachTo: document.body,
      global: { plugins: [createPinia()] },
    })
    await nextTick()
    await nextTick()
    return wrapper
  }

  it('dispatching 空窗：TurnMeta 旧占位不再渲染 + ActivityStrip thinking 行接管', async () => {
    // store 取用必须在 mountStream 之后（mount 时 app 安装新 pinia 并 setActivePinia，
    // 先取会拿到 beforeEach 的旧实例，写入不传导——同既有集成测试 P3 模式）
    const wrapper = await mountStream(SID)
    const chat = useChatStore()
    // 制造 dispatching 空窗的对话流形态：user 已入流（空 turn，assistants=[]）、message_start 未到
    chat.appendUser(SID, [{ type: 'text', text: '刚发出的消息' }])
    chat.setOccupancy(SID, { turn: 'dispatching', compacting: false, bash: false })
    await nextTick()
    await nextTick()

    // 旧渲染点清理：空 turn 不再渲染 TurnMeta 占位（原 isPendingPlaceholder「思考中」+ spinner）
    expect(wrapper.find('[data-testid^="turn-meta-"]').exists()).toBe(false)
    // 新渲染位：对话流尾部活动条 thinking 行
    expect(wrapper.find('[data-testid="activity-strip-row-thinking"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="activity-strip-text-thinking"]').text()).toBe('思考中…')
    wrapper.unmount()
  })

  it('compacting 指示迁入：occupancy compacting → 活动条压缩行（原 compacting 浮层渲染点已删除）', async () => {
    const wrapper = await mountStream(SID)
    const chat = useChatStore()
    chat.setOccupancy(SID, { turn: 'idle', compacting: true, bash: false })
    chat.setCompactingReason(SID, 'manual')
    await nextTick()
    expect(wrapper.find('[data-testid="activity-strip-row-compacting"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="activity-strip-text-compacting"]').text()).toBe('压缩中')
    wrapper.unmount()
  })

  it('executingBash 瞬时行迁入：message.bashStart 帧 → 活动条 bash 行；bashResult 后消失', async () => {
    const wrapper = await mountStream(SID)
    const chat = useChatStore()
    // ephemeral 通道（bash-effects 模块级分区）：bashStart 置 executingBash（不进 messages）
    chat.applyMessageEvent(SID, { type: 'message.bashStart', payload: { sessionId: SID, command: 'pnpm lint', excludeFromContext: false, timestamp: Date.now() } })
    await nextTick()
    const bashRow = wrapper.find('[data-testid="activity-strip-row-bash"]')
    expect(bashRow.exists()).toBe(true)
    expect(wrapper.find('[data-testid="activity-strip-text-bash"]').text()).toContain('pnpm lint')
    // 旧渲染点清理：原 executing-bash-notice testid 不应再出现（行已迁 ActivityStrip）
    expect(wrapper.find('[data-testid="executing-bash-notice"]').exists()).toBe(false)

    // bashResult 终态 → executingBash 清 → bash 行消失（全 idle 时整条活动条不渲染）
    chat.applyMessageEvent(SID, { type: 'message.bashResult', payload: { sessionId: SID, command: 'pnpm lint', output: 'ok', exitCode: 0, cancelled: false, timestamp: Date.now() } })
    await nextTick()
    expect(wrapper.find('[data-testid="activity-strip"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('fork notice 定位：活动条与 fork notice 同为文档流，活动条在前（fork notice 排对话流尾部之后）', async () => {
    const { feedRef } = useForkNoticeFeed()
    const wrapper = await mountStream(SID)
    const chat = useChatStore()
    // 压缩中 + 一条 fork notice：文档序应为 ActivityStrip → ForkNotice（fork notice 定位结论：
    // 生产路径 fork notice 是 Virtualizer 之后的文档流 block，按文档序自然堆叠在活动条之后，
    // 不依赖任何 absolute 基线——定位链已随 D6 死路径清理删除）
    chat.setOccupancy(SID, { turn: 'idle', compacting: true, bash: false })
    feedRef.value = new Map(feedRef.value).set(SID, [{ id: 1, newSessionId: 'sess-branch-1', branchName: 'fix-branch' }])
    await nextTick()
    await nextTick()

    const strip = wrapper.find('[data-testid="activity-strip"]').element
    const notice = wrapper.find('.fork-notice').element
    expect(strip).toBeDefined()
    expect(notice).toBeDefined()
    // DOCUMENT_POSITION_FOLLOWING：notice 在 strip 之后（文档序）
    expect((strip.compareDocumentPosition(notice) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0).toBe(true)
    wrapper.unmount()
  })
})

describe('ActivityStrip · i18n key 完整（P5）', () => {
  /** 五个文案 key：compacting 手动/自动 + 待发 chip、bash、thinking（ActivityStrip 唯一新增消费面） */
  const KEYS: Array<[string, string, string]> = [
    ['panel.message.compressing', "compressing: '压缩中'", "compressing: 'Compacting'"],
    ['panel.message.autoCompressing', "autoCompressing: '正在自动压缩上下文'", "autoCompressing: 'Auto-compacting context…'"],
    ['panel.message.compactingQueueChip', "compactingQueueChip: '待发 {count}'", "compactingQueueChip: '{count} queued'"],
    ['panel.message.executingBash', "executingBash: '正在执行'", "executingBash: 'Running'"],
    ['panel.message.dispatching', "dispatching: '思考中…'", "dispatching: 'Thinking…'"],
  ]

  it('compressing/autoCompressing/compactingQueueChip/executingBash/dispatching 在 zh/en locale 均定义', () => {
    const zh = readFileSync(resolve(__dirname, '../../../../i18n/locales/zh-CN/panel.ts'), 'utf8')
    const en = readFileSync(resolve(__dirname, '../../../../i18n/locales/en-US/panel.ts'), 'utf8')
    for (const [key, zhLine, enLine] of KEYS) {
      expect(zh, `${key} 缺 zh-CN 定义`).toContain(zhLine)
      expect(en, `${key} 缺 en-US 定义`).toContain(enLine)
    }
  })

  it('被迁出的 TurnMeta 占位 key（panel.message.thinking）已随占位删除同批清扫', () => {
    const zh = readFileSync(resolve(__dirname, '../../../../i18n/locales/zh-CN/panel.ts'), 'utf8')
    const en = readFileSync(resolve(__dirname, '../../../../i18n/locales/en-US/panel.ts'), 'utf8')
    expect(zh).not.toContain("thinking: '思考中'")
    expect(en).not.toContain("thinking: 'Thinking'")
  })
})
