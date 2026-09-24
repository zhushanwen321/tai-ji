/**
 * ActivityStrip 组件测试（session-occupancy u6a / D7 展示统一）。
 *
 * 覆盖（三视角，用户可见 DOM 断言优先）：
 * - P1 组件黑盒·四类状态各自渲染：compacting（manual→压缩中 / threshold→自动压缩）、
 *   bash（正在执行 + mono 命令）、thinking（turn=dispatching→思考中…）、
 *   settling（turn=settling 且无 compacting/bash→行出现，R3-U1；文案复用 dispatching key，
 *   P-1 探针 V8 校准点）
 * - P1.5 组件黑盒·通栏活动带 band（compact-defer-composer-queue §2.2 / A4+A7）：compacting 行
 *   摘除 content-col/system-notice、accent-soft 底 + border-y、副文案 count = 内核投递投影里
 *   「非 direct 且未 delivered」条目数（[u3c/D7] 单源化——原 useCompactQueue 未提交条目口径随
 *   队列退役，口径唯一定义点 = useQueueRows.deliveryQueueEntries）、count=0 隐藏副文案、
 *   bash/thinking/settling 行形态不变
 * - P2 组件黑盒·优先级堆叠：compacting + bash 并存 → 两行且 compacting 在上；
 *   thinking 与 compacting/bash 互斥（「无以上但有 dispatching turn」才显示）；
 *   settling 与 compacting 并存 → 仅 compacting 行（同档位幂等，不重复堆叠）；
 *   turn=generating 不渲染行（streaming 本体由 TurnMeta「工作中」承担，D6 活动条列）
 * - P3 组件黑盒·全 idle 不渲染（G3：无占用 = 无活动条）
 * - P4 MessageStream 集成·迁移收口：TurnMeta 旧 dispatching 占位不再渲染 + thinking 行接管；
 *   executingBash 瞬时行迁入（bashStart 帧驱动）；fork notice 与活动条的文档流定位顺序
 *   （活动条在前——ForkNotice 为文档流 block，按文档序自然堆叠）
 * - P5 i18n key 完整：四个行文案 key 在 zh/en locale 均定义
 *
 * i18n：vitest 全局 setup（vitest-i18n-setup.ts）mock useI18n → t() 返回 zh-CN 文案。
 *
 * 运行：cd packages/renderer && npx vitest run src/components/panel/message-stream/__tests__/ActivityStrip.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { chatViewDepsModule } from '@/__tests__/helpers/chat-stream-mount'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { getDeliveryProjectionRef } from '@taiji/core'
import type { DeliveryFrameEntry } from '@taiji/core'
import zhPanel from '@/i18n/locales/zh-CN/panel'
import enPanel from '@/i18n/locales/en-US/panel'

const apiMock = vi.hoisted(() => ({
  send: vi.fn(() => Promise.resolve()),
  steer: vi.fn(() => Promise.resolve()),
  streamSubscribe: vi.fn(() => () => {}),
}))

/** 投递投影注入助手：副文案 count 口径测试直接写 core 投影 ref（帧消费链路由 core useChat 的
 *  session.delivery handler 承担，本组件只读投影——单源化后已无本地队列 mock 面）。 */
function setProjection(sid: string, entries: DeliveryFrameEntry[]): void {
  const ref = getDeliveryProjectionRef()
  const next = new Map(ref.value)
  next.set(sid, entries)
  ref.value = next
}

vi.mock('@/api', () => ({ project: { load: vi.fn().mockResolvedValue({ projects: [], activeProjectId: '' }), save: vi.fn().mockResolvedValue(undefined) },
  chat: { send: apiMock.send, steer: apiMock.steer, streamSubscribe: apiMock.streamSubscribe },
  session: {},
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
  // 投影是模块级 ref（跨用例共享），逐用例显式重置（新 Map = 无条目）
  getDeliveryProjectionRef().value = new Map()
})

describe('ActivityStrip · 四类状态各自渲染（P1）', () => {
  it('compacting + reason=manual（缺省）→「压缩中」行 + spinner', async () => {
    const wrapper = await mountStrip({ occupancy: { turn: 'idle', compacting: true, bash: false } })
    const row = wrapper.find('[data-testid="activity-strip-row-compacting"]')
    expect(row.exists()).toBe(true)
    // 用户可见文案（zh-CN）+ spinner（Loader2 animate-spin）；通栏带 hairline 由 border-y 承担
    //（无 .h-px span，band 结构断言见下方「通栏活动带」describe）
    expect(wrapper.find('[data-testid="activity-strip-text-compacting"]').text()).toBe('压缩中')
    expect(row.find('.animate-spin').exists()).toBe(true)
    expect(row.findAll('.h-px').length).toBe(0)
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

  it('bash →「正在执行」+ elapsed meta（方案 A：命令不内联，悬停详情承载）', async () => {
    const wrapper = await mountStrip({
      occupancy: { turn: 'idle', compacting: false, bash: false },
      executingBash: { command: 'pnpm test', startedAt: Date.now() },
    })
    const row = wrapper.find('[data-testid="activity-strip-row-bash"]')
    expect(row.exists()).toBe(true)
    const text = wrapper.find('[data-testid="activity-strip-text-bash"]')
    expect(text.text()).toContain('正在执行')
    // elapsed mono meta（同键同参：startedAt=now → 已 0s）
    expect(text.text()).toContain(t('panel.message.executingBashElapsed', { elapsed: '0s' }))
    // 命令原文不再内联（长命令挤没横线的根因摘除）
    expect(row.text()).not.toContain('pnpm test')
    expect(row.find('svg').exists()).toBe(true)
    wrapper.unmount()
  })

  it('bash 行悬停 → 详情含完整命令（方案 A HoverCard，portal 挂 body）', async () => {
    const wrapper = await mountStrip({
      occupancy: { turn: 'idle', compacting: false, bash: false },
      executingBash: { command: 'pnpm test', startedAt: Date.now() },
    })
    await wrapper.find('[data-testid="activity-strip-text-bash"]').trigger('pointerenter')
    await new Promise((r) => setTimeout(r, 260))
    const detailBody = document.querySelector('[data-testid="activity-strip-detail-body-bash"]')
    expect(detailBody?.textContent).toBe('pnpm test')
    expect(document.querySelector('[data-testid="activity-strip-detail-bash"]')?.textContent).toContain(
      t('panel.message.bashCommandLabel'),
    )
    wrapper.unmount()
    document.querySelector('[data-testid="activity-strip-detail-bash"]')?.remove()
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

describe('ActivityStrip · 通栏活动带 band（compact-defer-composer-queue §2.2 / A4+A7）', () => {
  /** 构造投影条目（lane/state 双维决定是否计入副文案） */
  function entry(clientUuid: string, state: DeliveryFrameEntry['state'], lane: DeliveryFrameEntry['lane']): DeliveryFrameEntry {
    return { clientUuid, preview: clientUuid, state, lane }
  }

  it('compacting 行通栏带：无 content-col/system-notice、有 accent-soft 底与 border-y hairline', async () => {
    const wrapper = await mountStrip({ occupancy: { turn: 'idle', compacting: true, bash: false } })
    const row = wrapper.find('[data-testid="activity-strip-row-compacting"]')
    expect(row.exists()).toBe(true)
    // §2.2 F5：摘除 content-col（720px 封顶内容列与通栏带冲突）/ system-notice（纯语义死标记）
    expect(row.classes()).not.toContain('content-col')
    expect(row.classes()).not.toContain('system-notice')
    // accent-soft 底 + border-y（上下 hairline 由 border 整体替代，不再复用 .h-px span）
    expect(row.classes()).toContain('bg-[var(--accent-soft)]')
    expect(row.classes()).toContain('border-y')
    expect(row.classes()).toContain('border-hairline')
    expect(row.findAll('.h-px').length).toBe(0)
    // spinner 升级 size-3.5 + accent 色（原 size-3 neutral-mid）
    const spinner = row.find('.animate-spin')
    expect(spinner.exists()).toBe(true)
    expect(spinner.classes()).toContain('size-3.5')
    expect(spinner.classes()).toContain('text-accent')
    wrapper.unmount()
  })

  it('count 口径：只计内核投影里「非 direct 且未 delivered」条目（direct 待确认气泡与已送达不计数）', async () => {
    setProjection(SID, [
      entry('u1', 'queued', 'queued'),
      entry('u2', 'in-flight', 'steer'),
      // direct 车道的乐观气泡原位保留（不进队列区，D7），不计入
      entry('d1', 'in-flight', 'direct'),
      // 已送达：transcript 权威已入流，不计入
      entry('d2', 'delivered', 'steer'),
    ])
    const wrapper = await mountStrip({ occupancy: { turn: 'idle', compacting: true, bash: false } })
    const hint = wrapper.find('[data-testid="activity-strip-flush-hint-compacting"]')
    expect(hint.exists()).toBe(true)
    expect(hint.text()).toBe('完成后自动发送 2 条待发消息')
    // 主文案与副文案之间由「·」分隔
    expect(wrapper.find('[data-testid="activity-strip-row-compacting"]').text()).toContain('·')
    wrapper.unmount()
  })

  it('count=0：副文案与「·」不渲染，活动带仍在（压缩状态本身独立成立，A4）', async () => {
    setProjection(SID, [entry('d1', 'in-flight', 'direct')])
    const wrapper = await mountStrip({ occupancy: { turn: 'idle', compacting: true, bash: false } })
    const row = wrapper.find('[data-testid="activity-strip-row-compacting"]')
    expect(row.exists()).toBe(true)
    expect(wrapper.find('[data-testid="activity-strip-flush-hint-compacting"]').exists()).toBe(false)
    expect(row.text()).not.toContain('·')
    wrapper.unmount()
  })

  it('bash/thinking/settling 行维持原 system-notice + content-col 形态（band 不扩散）', async () => {
    const wrapper = await mountStrip({
      occupancy: { turn: 'idle', compacting: false, bash: true },
      executingBash: { command: 'pnpm test', startedAt: Date.now() },
    })
    const bashRow = wrapper.find('[data-testid="activity-strip-row-bash"]')
    expect(bashRow.exists()).toBe(true)
    expect(bashRow.classes()).toContain('system-notice')
    expect(bashRow.classes()).toContain('content-col')
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
    // 主文案 text-sm/fg/550；方案 A 后无内联命令（命令在悬停详情），行内仅短语 + elapsed meta
    const main = bashRow.find('[data-testid="activity-strip-text-bash"] > span')
    expect(main.classes()).toContain('text-[length:var(--text-sm)]')
    expect(main.classes()).toContain('font-[550]')
    expect(bashRow.find('[data-testid="activity-strip-text-bash"] .font-mono').exists()).toBe(true)

    wrapper.unmount()
  })

  it('主文案 key 分档：manual→压缩中（band 内）、threshold→正在自动压缩上下文（A7）', async () => {
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
    // 方案 A：命令原文不内联（悬停详情承载），行内只有「正在执行」+ elapsed
    expect(wrapper.find('[data-testid="activity-strip-text-bash"]').text()).not.toContain('pnpm lint')
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
  /** 文案 key：compacting 手动/自动 + 待发 chip、bash、thinking + 方案 A 新增两键（elapsed meta /
 *  * 悬停详情标题）在 zh/en locale 均定义 */
  const KEYS: Array<[string, string, string]> = [
    ['panel.message.compressing', "compressing: '压缩中'", "compressing: 'Compacting'"],
    ['panel.message.autoCompressing', "autoCompressing: '正在自动压缩上下文'", "autoCompressing: 'Auto-compacting context…'"],
    ['panel.message.compactingQueueChip', "compactingQueueChip: '待发 {count}'", "compactingQueueChip: '{count} queued'"],
    ['panel.message.executingBash', "executingBash: '正在执行'", "executingBash: 'Running'"],
    ['panel.message.dispatching', "dispatching: '思考中…'", "dispatching: 'Thinking…'"],
    ['panel.message.executingBashElapsed', "executingBashElapsed: '已 {elapsed}'", "executingBashElapsed: '{elapsed} elapsed'"],
    ['panel.message.bashCommandLabel', "bashCommandLabel: '完整命令'", "bashCommandLabel: 'Command'"],
  ]


  it('compressing/autoCompressing/executingBash/dispatching 在 zh/en locale 均定义', () => {
    for (const key of ['compressing', 'autoCompressing', 'executingBash', 'dispatching']) {
      expect(ZH_MESSAGE[key], `panel.message.${key} 缺 zh-CN 定义`).toEqual(expect.any(String))
      expect(EN_MESSAGE[key], `panel.message.${key} 缺 en-US 定义`).toEqual(expect.any(String))
    }
  })

  it('被迁出的 TurnMeta 占位 key（panel.message.thinking）已随占位删除同批清扫（防复活）', () => {
    expect(ZH_MESSAGE.thinking).toBeUndefined()
    expect(EN_MESSAGE.thinking).toBeUndefined()
  })
})
