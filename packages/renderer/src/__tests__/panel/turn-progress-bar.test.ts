/**
 * TurnProgressBar 警示条行为测试（remove-turn-progress-bar 设计 §2.2 / u2 验收 A1/A4/A5）。
 *
 * 三视角（TEST-STRATEGY §3）：
 * - 构建者白盒：驱动真实 pinia chatStore 事件流（setOccupancy + applyMessageEvent），
 *   断言 core useTurnProgress 派生快照（u1 收窄后 { turnElapsedMs, warn } 两字段）经组件渲染落地
 * - 使用者黑盒：每条用例至少一个用户可见 DOM 断言（testid 存在性/文本/警示色 class）
 * - 观察者形态：warn-only 渲染生命周期（常态零 DOM → warn 出现 → snooze/turn 结束消失）
 *
 * 附 i18n 文案断言（D7 文案纪律）：zh-CN/en-US sidebar.turnProgress 剩余五键文案无判断词
 * + 键集合恰为保留面（四死键 generatedChars/toolElapsed/awaitingUser/durationSec 已删，A8②）。
 *
 * warn 推进经 fake timers（core 默认时钟 Date.now 被 fake 接管，advanceTimersByTime 跨阈值），
 * 无真实等待。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/panel/turn-progress-bar.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import TurnProgressBar from '@/components/panel/TurnProgressBar.vue'
import { useChatStore } from '@/stores/chat'
import { useExtensionUIStore } from '@/stores/extension-ui'
import { TURN_PROGRESS_WARN_THRESHOLD_MS } from '@xyz-agent/core'
import zhSidebar from '@/i18n/locales/zh-CN/sidebar'
import enSidebar from '@/i18n/locales/en-US/sidebar'

const SID = 's-bar'

/** 真实 store 上构造活跃 turn（occupancy 帧 + message_start 事件，与 runtime 帧序一致）。 */
function startRealTurn(store: ReturnType<typeof useChatStore>, messageId = 'a1'): void {
  store.setOccupancy(SID, { turn: 'generating', compacting: false, bash: false })
  store.applyMessageEvent(SID, { type: 'message.message_start', payload: { sessionId: SID, messageId } })
}

function mountBar() {
  return mount(TurnProgressBar, { props: { sessionId: SID } })
}

/** 跨过警示阈值（fake 时钟推进阈值 + 1s，秒级 tick 重算快照后 warn=true）。 */
async function crossWarnThreshold() {
  vi.advanceTimersByTime(TURN_PROGRESS_WARN_THRESHOLD_MS + 1_000)
  await nextTick()
}

beforeEach(() => {
  vi.useFakeTimers()
  setActivePinia(createPinia())
})

afterEach(() => {
  vi.useRealTimers()
})

describe('TurnProgressBar warn-only 渲染（u2）', () => {
  it('无活跃 turn：不渲染（v-if 生命周期）', () => {
    const wrapper = mountBar()
    expect(wrapper.find('[data-testid="turn-progress-bar"]').exists()).toBe(false)
  })

  it('A1 常态（活跃 <10min）：零 DOM 占用——不渲染 turn-progress-bar', async () => {
    const store = useChatStore()
    const wrapper = mountBar()
    startRealTurn(store)
    await nextTick()
    // 推进到阈值前 1s：turn 活跃、快照存在但 warn=false → 常态零视觉占用
    vi.advanceTimersByTime(TURN_PROGRESS_WARN_THRESHOLD_MS - 1_000)
    await nextTick()
    expect(wrapper.find('[data-testid="turn-progress-bar"]').exists()).toBe(false)
  })

  it('A4 warn 态（≥10min）：警示色 + 本 turn 时长 + 中止/继续等待两按钮', async () => {
    const store = useChatStore()
    const wrapper = mountBar()
    startRealTurn(store)
    await nextTick()
    await crossWarnThreshold()
    // 用户可见：警示条出现（阈值 10min → 时长文案落在分钟档「10 分钟」）
    const bar = wrapper.find('[data-testid="turn-progress-bar"]')
    expect(bar.exists()).toBe(true)
    expect(bar.find('[data-testid="turn-progress-elapsed"]').text()).toContain('10 分钟')
    // 警示色（warn 边框/底色 + Clock 警示色 class——色彩由 token CSS 落地）
    expect(bar.classes()).toContain('bg-warn-soft')
    expect(bar.classes()).toContain('border-warn/35')
    expect(bar.find('svg').classes()).toContain('text-warn')
    // 两个中性操作项（D7：不预置推荐，同权重）
    expect(bar.find('[data-testid="turn-progress-abort"]').text()).toBe('中止此 turn')
    expect(bar.find('[data-testid="turn-progress-keep-waiting"]').text()).toBe('继续等待')
  })

  it('「中止此 turn」：点击 emit abort（由父组件接既有 abort 链路，组件本身不触 RPC）', async () => {
    const store = useChatStore()
    const wrapper = mountBar()
    startRealTurn(store)
    await nextTick()
    await crossWarnThreshold()
    await wrapper.find('[data-testid="turn-progress-abort"]').trigger('click')
    expect(wrapper.emitted('abort')).toHaveLength(1)
  })

  it('A5 「继续等待」：bar 消失且本 turn 内持续抑制（再推进时间也不复现）', async () => {
    const store = useChatStore()
    const wrapper = mountBar()
    startRealTurn(store)
    await nextTick()
    await crossWarnThreshold()
    expect(wrapper.find('[data-testid="turn-progress-bar"]').exists()).toBe(true)
    await wrapper.find('[data-testid="turn-progress-keep-waiting"]').trigger('click')
    // warn-only 渲染：warn 抑制 = 整条消失（非常态条收起操作项的旧形态）
    await nextTick()
    expect(wrapper.find('[data-testid="turn-progress-bar"]').exists()).toBe(false)
    // snooze 持续本 turn：继续推进时间不复现
    vi.advanceTimersByTime(5 * 60 * 1000)
    await nextTick()
    expect(wrapper.find('[data-testid="turn-progress-bar"]').exists()).toBe(false)
  })

  it('A5 ask_user pending 豁免（D6）：等待期即使超阈值警示条也不出现', async () => {
    const store = useChatStore()
    const extensionUI = useExtensionUIStore()
    const wrapper = mountBar()
    startRealTurn(store)
    await nextTick()
    extensionUI.addRequest(SID, {
      sessionId: SID, requestId: 'r1', method: 'select', askUser: true, receivedAt: Date.now(),
    })
    await nextTick()
    // 豁免是 core warn 计算输入（非渲染后隐藏）：超阈值也不渲染
    await crossWarnThreshold()
    expect(wrapper.find('[data-testid="turn-progress-bar"]').exists()).toBe(false)
  })

  it('turn 结束（occupancy idle）：警示条自动消失（观察者形态）', async () => {
    const store = useChatStore()
    const wrapper = mountBar()
    startRealTurn(store)
    await nextTick()
    await crossWarnThreshold()
    expect(wrapper.find('[data-testid="turn-progress-bar"]').exists()).toBe(true)
    store.setOccupancy(SID, { turn: 'idle', compacting: false, bash: false })
    await nextTick()
    expect(wrapper.find('[data-testid="turn-progress-bar"]').exists()).toBe(false)
  })

  it('≥1h 时长桶：formatDuration 进位到「小时+分」档（durationHourMin）', async () => {
    const store = useChatStore()
    const wrapper = mountBar()
    startRealTurn(store)
    await nextTick()
    // 65 分钟：跨过 60min 边界 → 小时+分档（不落分钟档）
    vi.advanceTimersByTime(65 * 60 * 1000)
    await nextTick()
    const text = wrapper.find('[data-testid="turn-progress-elapsed"]').text()
    expect(text).toContain('1 小时 5 分')
    expect(text).not.toContain('分钟')
  })
})

describe('i18n 文案纪律断言（D7）', () => {
  /** D7 禁判断词清单：只陈述事实，禁止「卡死/无响应/异常/建议」类措辞（双语）。 */
  const FORBIDDEN = [
    '卡死', '卡住', '无响应', '没有响应', '异常', '建议', '停滞', '可能失败', '疑似',
    'stuck', 'unresponsive', 'not responding', 'hung', 'freeze', 'error', 'abnormal', 'suggest', 'recommend',
  ]

  function collectLeafTexts(node: unknown, path: string): string[] {
    if (typeof node === 'string') return [`${path} = ${node}`]
    if (node && typeof node === 'object') {
      return Object.entries(node as Record<string, unknown>).flatMap(([k, v]) => collectLeafTexts(v, `${path}.${k}`))
    }
    return []
  }

  it.each([
    ['zh-CN', zhSidebar],
    ['en-US', enSidebar],
  ])('%s sidebar.turnProgress 全部文案无判断词', (_locale, sidebar) => {
    const section = (sidebar as { turnProgress: Record<string, unknown> }).turnProgress
    expect(section).toBeDefined()
    const leaves = collectLeafTexts(section, 'turnProgress')
    expect(leaves.length).toBeGreaterThanOrEqual(5)
    for (const leaf of leaves) {
      for (const word of FORBIDDEN) {
        expect(leaf.toLowerCase()).not.toContain(word.toLowerCase())
      }
    }
  })

  it('双语键集合一致且恰为保留五键（四死键已删，A8② 组件侧锁定）', () => {
    const expected = ['abortTurn', 'durationHourMin', 'durationMin', 'keepWaiting', 'turnElapsed'].sort()
    const zh = Object.keys((zhSidebar as { turnProgress: Record<string, unknown> }).turnProgress).sort()
    const en = Object.keys((enSidebar as { turnProgress: Record<string, unknown> }).turnProgress).sort()
    expect(zh).toEqual(expected)
    expect(en).toEqual(expected)
  })
})
