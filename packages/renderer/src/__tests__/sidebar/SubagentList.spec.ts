/**
 * SubagentList 组件测试（U8b 可见性翻转后语义重写）。
 *
 * 覆盖：
 * - 渲染 subagent 卡片列表（agent 名称 + task + turns + 状态点）
 * - 空态展示
 * - 点击卡片触发 select 事件
 * - 二级筛选接线（全部活跃 / 只看正在跑 / 已收起）：默认视图、视图切换、
 *   视图空态 + jump（active 空 → 查看已收起；running 空 → 查看全部）、
 *   loading/error/空数据不渲染筛选条、切 sessionId 分区重置
 * - U8b 三条核心用例（任务点名）：idle record 默认可见 / archived 默认隐藏 +
 *   过滤器可达 / 取消后状态流转显示
 * - GUI 快修③：取消按钮确认窗口期保留（迟到 isStreaming=false 不摘除确认态）
 * - GUI 快修⑤ GUI 侧验收：idle record（冷重启 revive 形态）turns/tokens 文本渲染非零
 *
 * 运行：cd packages/renderer && pnpm test src/__tests__/sidebar/SubagentList.spec.ts
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import SubagentList from '@/components/sidebar/SubagentList.vue'
import type { SubagentRecord } from '@xyz-agent/shared'

function makeRecord(overrides: Partial<SubagentRecord> = {}): SubagentRecord {
  return {
    subagentId: 'bg-test-1-111',
    sessionFile: '/data/sub.jsonl',
    agent: 'reviewer',
    slug: 'review-changes',
    task: 'Review the code changes',
    status: 'idle', // [U6] 两态词表（legacy done 已收窄出类型）；stopReason 由用例按形态注入
    turns: 5,
    totalTokens: 10000,
    elapsedSeconds: 60,
    ...overrides,
  }
}

/** 统一挂载入口：sessionId 必填 prop（D5 筛选分区 key，默认 'sess-1'）收敛在一处 */
function mountList(
  subagents: SubagentRecord[],
  extra: { isLoading?: boolean; loadError?: string | null; sessionId?: string } = {},
) {
  return mount(SubagentList, {
    props: { subagents, sessionId: 'sess-1', ...extra },
  })
}

type ListWrapper = ReturnType<typeof mountList>

/** 黑盒切到「正在跑」视图（占用过滤断言用） */
async function showRunning(wrapper: ListWrapper): Promise<void> {
  const btn = wrapper.find('[data-testid="subagent-filter-running"]')
  if (btn.exists()) await btn.trigger('click')
}

/** 黑盒切到「已收起」视图（场景 3 寻回路径） */
async function showArchived(wrapper: ListWrapper): Promise<void> {
  const btn = wrapper.find('[data-testid="subagent-filter-archived"]')
  if (btn.exists()) await btn.trigger('click')
}

describe('SubagentList 布局结构（滚动修复）', () => {
  // 回归防护：根 div 缺 h-full 会导致 flex 高度传递链断裂，
  // 列表超长时 ScrollArea 不出现滚动条（CW topic: fix-sidebar-subagent-workflow-scroll）
  it('根 div 含 h-full + min-h-0 + flex-col（确保撑满父容器，ScrollArea flex-1 才能正确约束高度）', () => {
    const records = [makeRecord()]
    const wrapper = mountList(records)
    const root = wrapper.find('[data-testid="subagent-list"]')
    expect(root.exists()).toBe(true)
    expect(root.classes()).toContain('h-full')
    expect(root.classes()).toContain('min-h-0')
    expect(root.classes()).toContain('flex-col')
  })
})

describe('SubagentList', () => {
  it('渲染 subagent 卡片列表（默认视图含 idle 终态——可见性翻转后不再隐藏）', () => {
    const records = [
      makeRecord({ subagentId: 'run-a-1', agent: 'reviewer', task: 'Review code', turns: 5, totalTokens: 10000, elapsedSeconds: 60 }),
      makeRecord({ subagentId: 'run-b-2', agent: 'worker', task: 'Fix bug', turns: 10, totalTokens: 20000, elapsedSeconds: 120 }),
    ]

    const wrapper = mountList(records)
    // 默认视图（active）= 全部活跃会话，无需切桶即见终态卡片
    const cards = wrapper.findAll('[data-testid="subagent-card"]')
    expect(cards).toHaveLength(2)

    // 第一张卡片含 agent 名称
    expect(cards[0].text()).toContain('reviewer')
    // 含 task 文本
    expect(cards[0].text()).toContain('Review code')
    // 含 turns 计数
    expect(cards[0].text()).toContain('5 turns')
  })

  it('空态展示提示文案', () => {
    const wrapper = mountList([])

    const empty = wrapper.find('[data-testid="subagent-list-empty"]')
    expect(empty.exists()).toBe(true)
    expect(empty.text()).toContain('暂无后台任务')
  })

  it('点击卡片触发 select 事件', async () => {
    const records = [makeRecord({ subagentId: 'run-click-1', status: 'running' })]

    const wrapper = mountList(records)

    const card = wrapper.find('[data-testid="subagent-card"]')
    await card.trigger('click')

    const emitted = wrapper.emitted('select')
    expect(emitted).toBeTruthy()
    expect(emitted![0][0]).toBe('run-click-1')
  })

  it('running 状态显示 spinner', () => {
    const records = [makeRecord({ status: 'running', subagentId: 'run-spin-1' })]

    const wrapper = mountList(records)

    const spinner = wrapper.find('[data-testid="subagent-card-spinner"]')
    expect(spinner.exists()).toBe(true)
  })

  it('idle 状态不显示 spinner（占用两态：空闲无在飞轮）', () => {
    const records = [makeRecord({ status: 'idle', stopReason: 'completed', subagentId: 'run-idle-1' })]

    const wrapper = mountList(records)

    expect(wrapper.find('[data-testid="subagent-card-spinner"]').exists()).toBe(false)
  })

  it('[U6] one-shot 完成形态（idle + chatMode:false + completed）不显示 spinner，显示绿点', () => {
    const records = [makeRecord({ status: 'idle', chatMode: false, stopReason: 'completed', subagentId: 'run-done-1' })]

    const wrapper = mountList(records)

    const spinner = wrapper.find('[data-testid="subagent-card-spinner"]')
    expect(spinner.exists()).toBe(false)

    // done 状态的圆点含 bg-success class
    const dot = wrapper.find('.bg-success')
    expect(dot.exists()).toBe(true)
  })

  it('[U6] failed 形态（idle + stopReason=failed，含归一后的 crashed）显示 danger 色点', () => {
    const records = [makeRecord({ status: 'idle', stopReason: 'failed', subagentId: 'run-crash-1' })]

    const wrapper = mountList(records)

    // crashed 不等于 running，不显示 spinner
    const spinner = wrapper.find('[data-testid="subagent-card-spinner"]')
    expect(spinner.exists()).toBe(false)

    // crashed 圆点含 bg-danger class（历史 bug：crashed 落 default 分支显示 bg-accent，与 done 视觉混淆）
    const dot = wrapper.find('.bg-danger')
    expect(dot.exists()).toBe(true)
  })

  // ── [U6] v4 closed 终态经 runtime 归一（idle + closedReason 保留 + deriveClosedDisplay
  // 派生 stopReason）→ 五行表等价显示（A4 门：与收窄前三分一致）──

  it('[U6] closed(gc+error) 归一形态（idle + closedReason + stopReason:failed）→ danger 色点', () => {
    const records = [makeRecord({ status: 'idle', closedReason: 'gc', stopReason: 'failed', error: 'Model timeout', subagentId: 'run-closed-fail' })]
    const wrapper = mountList(records)

    expect(wrapper.find('[data-testid="subagent-card-spinner"]').exists()).toBe(false)
    expect(wrapper.find('.bg-danger').exists()).toBe(true)
  })

  it('[U6] closed(cancelled) 归一形态（idle + stopReason:cancelled）→ 中性色点（不落 danger/success）', () => {
    const records = [makeRecord({ status: 'idle', closedReason: 'cancelled', stopReason: 'cancelled', subagentId: 'run-closed-cancel' })]
    const wrapper = mountList(records)

    expect(wrapper.find('.bg-danger').exists()).toBe(false)
    expect(wrapper.find('.bg-success').exists()).toBe(false)
    expect(wrapper.find('.bg-neutral-dim').exists()).toBe(true)
  })

  it('[U6] closed 自然完成（parent-new 级联关闭）归一形态（idle + completed + one-shot 形态位）→ success 色点', () => {
    const records = [makeRecord({ status: 'idle', closedReason: 'parent-new', stopReason: 'completed', chatMode: false, subagentId: 'run-closed-ok' })]
    const wrapper = mountList(records)

    expect(wrapper.find('.bg-success').exists()).toBe(true)
    // 历史 bug 回归防护：不落 accent 兜底（成功语义丢失）
    expect(wrapper.find('.bg-accent').exists()).toBe(false)
  })

  // ── cancel 两段式确认（W3 + GUI 快修③）──

  it('running 态渲染 cancel 按钮，idle 态不渲染', () => {
    const running = mountList([makeRecord({ status: 'running', subagentId: 'run-cancel-1' })])
    expect(running.findAll('[data-testid="subagent-action-cancel"]')).toHaveLength(1)

    const idle = mountList([makeRecord({ status: 'idle', stopReason: 'completed', subagentId: 'run-cancel-2' })])
    expect(idle.findAll('[data-testid="subagent-action-cancel"]')).toHaveLength(0)
  })

  it('cancel 两段式：首次点击进入确认态（不 emit），再次点击才 emit cancel', async () => {
    const records = [makeRecord({ status: 'running', subagentId: 'bg-cancel-1' })]
    const wrapper = mountList(records)

    const btn = wrapper.find('[data-testid="subagent-action-cancel"]')
    // 第一次点击：进入确认态，不 emit
    await btn.trigger('click')
    expect(wrapper.emitted('cancel')).toBeFalsy()

    // 确认态出现确认按钮
    const confirmBtn = wrapper.find('[data-testid="subagent-action-cancel-confirm"]')
    expect(confirmBtn.exists()).toBe(true)

    // 第二次点击确认 → emit cancel
    await confirmBtn.trigger('click')
    const emitted = wrapper.emitted('cancel')
    expect(emitted).toBeTruthy()
    expect(emitted![0][0]).toBe('bg-cancel-1')
  })

  it('[GUI 快修③] 确认窗口期保留按钮：第一击后 record 翻 idle（迟到广播），确认按钮仍渲染可达', async () => {
    const records = [makeRecord({ status: 'running', subagentId: 'bg-confirm-keep-1' })]
    const wrapper = mountList(records)

    await wrapper.find('[data-testid="subagent-action-cancel"]').trigger('click')
    expect(wrapper.find('[data-testid="subagent-action-cancel-confirm"]').exists()).toBe(true)

    // 模拟迟到 isStreaming=false 广播：record 翻 idle（setProps 不可变替换）
    await wrapper.setProps({
      subagents: [makeRecord({ status: 'idle', stopReason: 'interrupted', subagentId: 'bg-confirm-keep-1' })],
    })

    // 确认按钮不消失（cancellingId 在场即保留），第二击仍可达
    const confirmBtn = wrapper.find('[data-testid="subagent-action-cancel-confirm"]')
    expect(confirmBtn.exists()).toBe(true)
  })

  // ── slug 替换 hash（W3 新增）──

  it('第一行 agent 名称右侧显示 slug（可见文本，非仅 hover title）', () => {
    const records = [makeRecord({ subagentId: 'bg-abc-1-1234567890', slug: 'review-changes', agent: 'reviewer' })]
    const wrapper = mountList(records)
    const card = wrapper.find('[data-testid="subagent-card"]')
    // slug 渲染为第一行可见元素（agent 名右侧，与 WorkflowList 对齐）
    const slugEl = wrapper.find('[data-testid="subagent-card-slug"]')
    expect(slugEl.exists()).toBe(true)
    expect(slugEl.text()).toBe('review-changes')
    // title 保留 agent + slug 全称
    expect(card.attributes('title')).toBe('reviewer · review-changes')
    // 完整 hash 不显示在卡片可见区域
    expect(card.text()).not.toContain('bg-abc-1-1234567890')
  })

  it('slug 空串（旧 session 无 slug 兜底）不渲染 slug 元素', () => {
    const records = [makeRecord({ slug: '' })]
    const wrapper = mountList(records)
    expect(wrapper.find('[data-testid="subagent-card-slug"]').exists()).toBe(false)
  })
})

// ── statusDotClass 状态点映射（[two-state-convergence U6] 全表坍缩五行终态）──
//
// 展示语义（G2 + GUI 快修「列表三态」；runtime 归一层保证 renderer 永不见 legacy 值）：
//   1. running 真在跑           → spinner（Loader2 动画，无静态圆点）
//   5. running + stopReason=failed（W4 纳管态）→ bg-danger 红点
//   2. idle 失败（stopReason=failed）→ bg-danger 红点
//   3. idle 中断（stopReason=interrupted*）→ bg-neutral-dim opacity-50 中性点
//   4. idle chat 等续聊/孤儿兜底（chatMode true/缺省）→ bg-accent opacity-60 半透明点
//   6. idle 其余（one-shot completed/reopened/无停因且 chatMode=false）→ bg-success 绿点
//   其余 running 形态（无 stopReason 信号的结果残留等理论形态）→ statusDotClass 兜底
//   bg-accent 实心（防无色；生产链路由 runtime 归一层消化，不进本表）
describe('SubagentList statusDotClass 状态点映射', () => {
  /** 单卡片挂载，返回 dot 元素与 spinner 探测（隔离断言，防多卡片 class 串扰） */
  function mountDot(overrides: Partial<SubagentRecord>) {
    const wrapper = mountList([makeRecord(overrides)])
    return {
      dot: wrapper.find('span.rounded-full'),
      spinner: wrapper.find('[data-testid="subagent-card-spinner"]'),
    }
  }

  it('态1 running 真在跑（无 result）→ spinner，无静态圆点', () => {
    const { dot, spinner } = mountDot({ status: 'running', subagentId: 'dot-run-1' })
    expect(spinner.exists()).toBe(true)
    expect(dot.exists()).toBe(false)
  })

  it('态2 [two-state-convergence U4] 翻边 one-shot 轮终（idle + chatMode 显式 false）→ bg-success 绿点（非 spinner 非 accent）', () => {
    const { dot, spinner } = mountDot({
      status: 'idle',
      chatMode: false,
      stopReason: 'completed',
      subagentId: 'dot-done-proj-1',
    })
    expect(spinner.exists()).toBe(false)
    expect(dot.exists()).toBe(true)
    expect(dot.classes()).toContain('bg-success')
    expect(dot.classes()).not.toContain('bg-accent')
    // A-lite 轮终残留（running + result + completed——归一层第五归一未触发的理论形态）：
    // 五行表不命中 → statusDotClass 兜底实心 accent（生产链路该形态已被 runtime 归一为 idle）
    const legacyBridge = mountDot({
      status: 'running',
      result: '本轮产出正文',
      chatMode: false,
      stopReason: 'completed',
      subagentId: 'dot-done-proj-legacy-1',
    })
    expect(legacyBridge.spinner.exists()).toBe(false)
    expect(legacyBridge.dot.classes()).toContain('bg-accent')
    expect(legacyBridge.dot.classes()).not.toContain('bg-success')
  })

  it('态3a [two-state-convergence U4] 翻边 chat 轮终（idle + chatMode true）→ bg-accent opacity-60 半透明点（等续聊，区别于 done 绿点）', () => {
    const { dot, spinner } = mountDot({
      status: 'idle',
      result: '本轮产出正文',
      chatMode: true,
      stopReason: 'completed',
      subagentId: 'dot-wait-chat-1',
    })
    expect(spinner.exists()).toBe(false)
    expect(dot.exists()).toBe(true)
    expect(dot.classes()).toContain('bg-accent')
    expect(dot.classes()).toContain('opacity-60')
    expect(dot.classes()).not.toContain('bg-success')
    // A-lite chat 轮终残留（running + result + completed）：兜底实心 accent（无 opacity-60）
    const legacyBridge = mountDot({
      status: 'running',
      result: '本轮产出正文',
      chatMode: true,
      stopReason: 'completed',
      subagentId: 'dot-wait-chat-legacy-1',
    })
    expect(legacyBridge.dot.classes()).toContain('bg-accent')
    expect(legacyBridge.dot.classes()).not.toContain('opacity-60')
  })

  it('态3b [two-state-convergence U5] 孤儿兜底（idle + chatMode 缺省）→ accent-60 半透明点（[U5/D4] resumable 维度退役，idle 直读）；桥接 running 存量落实心 accent', () => {
    // 翻边后孤儿纠偏产物：idle + chatMode 缺省 → 保守归 chat（accent-60）
    const flipped = mountDot({ status: 'idle', subagentId: 'dot-wait-resumable-1' })
    expect(flipped.spinner.exists()).toBe(false)
    expect(flipped.dot.classes()).toContain('bg-accent')
    expect(flipped.dot.classes()).toContain('opacity-60')
    // A-lite 轮终残留（running + result + completed）：兜底实心 accent（生产链路已由
    // runtime 第五归一消化为 idle——此处仅钉兜底防无色行为）
    const legacyBridge = mountDot({ status: 'running', result: '本轮产出正文', stopReason: 'completed', subagentId: 'dot-wait-resumable-legacy-1' })
    expect(legacyBridge.spinner.exists()).toBe(false)
    expect(legacyBridge.dot.classes()).toContain('bg-accent')
    expect(legacyBridge.dot.classes()).not.toContain('opacity-60')
  })

  it('态3c [two-state-convergence U4] idle + chatMode 缺省（legacy 轮终，无法确认非 chat）→ 保守落等续聊半透明点，不宣告 done；桥接 running 存量落实心 accent', () => {
    const flipped = mountDot({ status: 'idle', result: '产出', subagentId: 'dot-wait-default-1' })
    expect(flipped.spinner.exists()).toBe(false)
    expect(flipped.dot.classes()).toContain('bg-accent')
    expect(flipped.dot.classes()).toContain('opacity-60')
    const legacyBridge = mountDot({ status: 'running', result: '产出', stopReason: 'completed', subagentId: 'dot-wait-default-legacy-1' })
    expect(legacyBridge.dot.classes()).toContain('bg-accent')
    expect(legacyBridge.dot.classes()).not.toContain('opacity-60')
  })

  it('态4 idle + stopReason=failed → bg-danger 红点（投影契约锁定：失败轮轮终落 idle + stopReason=failed，见态4b）', () => {
    const { dot } = mountDot({ status: 'idle', stopReason: 'failed', subagentId: 'dot-idle-failed-1' })
    expect(dot.classes()).toContain('bg-danger')
    expect(dot.classes()).not.toContain('bg-success')
  })

  it('态4b [U6 第五行] running + stopReason=failed（W4 纳管态）→ bg-danger 红点（spinner 判据已排除——stopReason 子句对冲生效后走静态圆点，R5 补行兜住失败信息）', () => {
    // W4 新型（无 result——[U5/D4] adoptEngineDeath：running+failed+result=∅）：
    // isRunningProjection = running && stopReason===undefined → false → 静态圆点，
    // 五行表第一行（running+failed 红）承接——失败信息不落 accent 兜底丢失
    const w4 = mountDot({
      status: 'running',
      stopReason: 'failed',
      subagentId: 'dot-rf-w4-1',
    })
    expect(w4.spinner.exists()).toBe(false)
    expect(w4.dot.exists()).toBe(true)
    expect(w4.dot.classes()).toContain('bg-danger')
    // chat 失败轮（chatMode true：等续聊形态，不再落半透明 accent 点）
    const chat = mountDot({
      status: 'running',
      result: 'round did not complete: boom',
      chatMode: true,
      stopReason: 'failed',
      subagentId: 'dot-rf-chat-1',
    })
    expect(chat.dot.classes()).toContain('bg-danger')
    expect(chat.dot.classes()).not.toContain('bg-accent')
    expect(chat.dot.classes()).not.toContain('bg-success')
    // one-shot 失败轮（chatMode false：done 投影形态不再误绿）
    const oneshot = mountDot({
      status: 'running',
      result: 'round did not complete: boom',
      chatMode: false,
      stopReason: 'failed',
      subagentId: 'dot-rf-oneshot-1',
    })
    expect(oneshot.dot.classes()).toContain('bg-danger')
    expect(oneshot.dot.classes()).not.toContain('bg-success')
  })

  it('态5 idle + stopReason=interrupted → bg-neutral-dim opacity-50 中性点（取消后状态流转显示）', () => {
    const { dot } = mountDot({ status: 'idle', stopReason: 'interrupted', subagentId: 'dot-idle-interrupted-1' })
    expect(dot.classes()).toContain('bg-neutral-dim')
    expect(dot.classes()).toContain('opacity-50')
    expect(dot.classes()).not.toContain('bg-accent')
    expect(dot.classes()).not.toContain('bg-success')
    expect(dot.classes()).not.toContain('bg-danger')
  })

  it('态5b idle + stopReason=interrupted-by-restart → 同中断中性点（宿主重启打断）', () => {
    const { dot } = mountDot({ status: 'idle', stopReason: 'interrupted-by-restart', subagentId: 'dot-idle-restart-1' })
    expect(dot.classes()).toContain('bg-neutral-dim')
    expect(dot.classes()).toContain('opacity-50')
  })

  it('态6 [two-state-convergence U4] idle one-shot 完成形态（stopReason=completed + chatMode:false / 无停因）→ bg-success 绿点；chatMode 缺省保守归 chat 落 accent-60', () => {
    // 已收口绿点 = one-shot 形态（chatMode 显式 false——翻边后等续聊/缺省形态优先落 accent-60 分支）
    const completed = mountDot({ status: 'idle', stopReason: 'completed', chatMode: false, subagentId: 'dot-idle-done-1' })
    expect(completed.dot.classes()).toContain('bg-success')
    const noReason = mountDot({ status: 'idle', chatMode: false, subagentId: 'dot-idle-noreason-1' })
    expect(noReason.dot.classes()).toContain('bg-success')
    // chatMode 缺省（legacy 存量）保守归 chat——绿点兜底被 accent-60 分支拦截（U4 最小展示子集）
    const legacyChat = mountDot({ status: 'idle', stopReason: 'completed', subagentId: 'dot-idle-legacy-chat-1' })
    expect(legacyChat.dot.classes()).toContain('bg-accent')
    expect(legacyChat.dot.classes()).toContain('opacity-60')
    expect(legacyChat.dot.classes()).not.toContain('bg-success')
  })

  it('态7 [U6] legacy 值归一后形态：done→绿 / failed→红 / cancelled→中性点（A4 门等价显示）', () => {
    // done 经归一：idle + stopReason:'completed' + one-shot 形态位（chatMode=false 合成）
    expect(mountDot({ status: 'idle', stopReason: 'completed', chatMode: false, subagentId: 'dot-legacy-done-1' }).dot.classes()).toContain('bg-success')
    // failed/crashed 经归一：idle + stopReason:'failed'
    expect(mountDot({ status: 'idle', stopReason: 'failed', error: 'boom', subagentId: 'dot-legacy-failed-1' }).dot.classes()).toContain('bg-danger')
    // cancelled 经归一：idle + stopReason:'cancelled'（interrupted 族）
    const cancelled = mountDot({ status: 'idle', stopReason: 'cancelled', subagentId: 'dot-legacy-cancel-1' })
    expect(cancelled.dot.classes()).toContain('bg-neutral-dim')
    expect(cancelled.dot.classes()).toContain('opacity-50')
  })
})

/**
 * 引擎 icon 三分支（U3 D8/D9）：record.engine → item 最左 icon。
 * 三视角：使用者 DOM 断言（icon 存在 + viewBox/形状区分三分支 + title 引擎名）。
 */
describe('SubagentList 引擎 icon（U3 D8 三分支 / D9 最左位置）', () => {
  function mountIcon(overrides: Partial<SubagentRecord> = {}) {
    const wrapper = mountList([makeRecord(overrides)])
    return wrapper.find('[data-testid="subagent-engine-icon"]')
  }

  it('分支1 engine 缺省 → pi icon（viewBox 0 0 800 800 像素几何块），title 显示 pi', () => {
    const icon = mountIcon()
    expect(icon.exists()).toBe(true)
    expect(icon.attributes('viewBox')).toBe('0 0 800 800')
    expect(icon.attributes('title')).toBe('pi')
  })

  it('分支1 engine 空串 → 同样落 pi 缺省映射', () => {
    const icon = mountIcon({ engine: '' })
    expect(icon.attributes('viewBox')).toBe('0 0 800 800')
    expect(icon.attributes('title')).toBe('pi')
  })

  it('分支2 engine=zcode → zcode icon（Z.ai 品牌标，扩边留白 viewBox -8 -8 40 40），title 显示 zcode', () => {
    const icon = mountIcon({ engine: 'zcode' })
    expect(icon.exists()).toBe(true)
    expect(icon.attributes('viewBox')).toBe('-8 -8 40 40')
    expect(icon.find('path').exists()).toBe(true)
    expect(icon.attributes('title')).toBe('zcode')
  })

  it('分支3 engine=未知 id → 中性圆点（Circle，防御分支），title 原样透出 id', () => {
    const icon = mountIcon({ engine: 'unknown-x' })
    expect(icon.exists()).toBe(true)
    expect(icon.find('circle').exists()).toBe(true)
    expect(icon.find('path').exists()).toBe(false)
    expect(icon.attributes('title')).toBe('unknown-x')
  })

  it('icon 是 item 第一元素（状态指示 spinner/statusDot 之前，D9）', () => {
    const wrapper = mountList([makeRecord({ status: 'running' })])
    const card = wrapper.find('[data-testid="subagent-card"]')
    const first = card.find('.flex.items-center > *')
    expect(first.attributes('data-testid')).toBe('subagent-engine-icon')
    // 状态指示（spinner）紧随其后
    expect(card.find('[data-testid="subagent-card-spinner"]').exists()).toBe(true)
  })
})

// ── 二级筛选接线（subagent-sidebar-filter D4/D5/D6 + §3.2.8 可见性翻转，黑盒 DOM 断言）──
describe('SubagentList 二级筛选接线', () => {
  it('默认渲染 active 视图：running + idle + legacy 终态全显 + 筛选条存在 + 计数正确', () => {
    const records = [
      makeRecord({ subagentId: 'live-1', agent: 'runner', status: 'running' }),
      makeRecord({ subagentId: 'idle-1', agent: 'researcher', status: 'idle', stopReason: 'completed' }),
      makeRecord({ subagentId: 'end-1', agent: 'reviewer', stopReason: 'completed' }),
    ]
    const wrapper = mountList(records)

    // 筛选条存在，active 默认高亮
    expect(wrapper.find('[data-testid="subagent-filter-bar"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="subagent-filter-active"]').attributes('data-active')).toBe('true')

    // 三视图计数（用户可见 DOM）：全部活跃 3 / 正在跑 1 / 已收起 0
    expect(wrapper.find('[data-testid="subagent-filter-count-active"]').text()).toBe('3')
    expect(wrapper.find('[data-testid="subagent-filter-count-running"]').text()).toBe('1')
    expect(wrapper.find('[data-testid="subagent-filter-count-archived"]').text()).toBe('0')

    // 默认视图显示全部活跃卡片（可见性翻转：idle 与 legacy 终态不再隐藏）
    const cards = wrapper.findAll('[data-testid="subagent-card"]')
    expect(cards).toHaveLength(3)
    expect(wrapper.text()).toContain('runner')
    expect(wrapper.text()).toContain('researcher')
    expect(wrapper.text()).toContain('reviewer')
  })

  it('[U8b 核心用例 1] idle record 默认可见（可见性翻转：空闲会话不丢展示位）+ turns/tokens 文本非零渲染（GUI 快修⑤ 投影面）', () => {
    const records = [
      makeRecord({ subagentId: 'revived-1', agent: 'researcher', status: 'idle', stopReason: 'completed', turns: 4, totalTokens: 88000, elapsedSeconds: 300 }),
    ]
    const wrapper = mountList(records)

    // 默认视图直接可见（不切任何过滤器）
    const cards = wrapper.findAll('[data-testid="subagent-card"]')
    expect(cards).toHaveLength(1)
    expect(cards[0].text()).toContain('researcher')
    // 冷重启 revive 形态的统计信号非零渲染（U7 hydrateReviveBaseline 恢复值 → GUI 投影）
    expect(cards[0].text()).toContain('4 turns')
    expect(cards[0].text()).toContain('88.0k tok')
  })

  it('[U8b 核心用例 2] archived 默认隐藏 + 「已收起」过滤器可达（场景 3 寻回入口）', async () => {
    const records = [
      makeRecord({ subagentId: 'live-1', agent: 'runner', status: 'running' }),
      makeRecord({ subagentId: 'arch-1', agent: 'old-researcher', status: 'idle', stopReason: 'completed', intent: 'archived' }),
    ]
    const wrapper = mountList(records)

    // 默认视图：archived 隐藏（用户可见断言——找不到该卡片文本）
    expect(wrapper.findAll('[data-testid="subagent-card"]')).toHaveLength(1)
    expect(wrapper.text()).not.toContain('old-researcher')

    // 计数可预告已收起 1 条
    expect(wrapper.find('[data-testid="subagent-filter-count-archived"]').text()).toBe('1')

    // 黑盒切「已收起」视图 → 卡片可达（寻回入口；message 续聊翻 active 由宿主侧承担）
    await showArchived(wrapper)
    expect(wrapper.find('[data-testid="subagent-filter-archived"]').attributes('data-active')).toBe('true')
    const cards = wrapper.findAll('[data-testid="subagent-card"]')
    expect(cards).toHaveLength(1)
    expect(cards[0].text()).toContain('old-researcher')
  })

  it('[U8b 核心用例 3] 取消后状态流转显示：running spinner → idle+interrupted 中性点（乐观更新形态直投）', async () => {
    // cancelSubagent 乐观更新产物形态：status=idle + stopReason=interrupted（U8b 两态化）
    const cancelled = makeRecord({ subagentId: 'cancel-flow-1', status: 'idle', stopReason: 'interrupted' })
    const wrapper = mountList([cancelled])

    // 无 spinner（在飞轮已收口）
    expect(wrapper.find('[data-testid="subagent-card-spinner"]').exists()).toBe(false)
    // 中性灰点（中断语义，非失败红/成功绿）
    const dot = wrapper.find('span.rounded-full')
    expect(dot.exists()).toBe(true)
    expect(dot.classes()).toContain('bg-neutral-dim')
    expect(dot.classes()).not.toContain('bg-danger')
    expect(dot.classes()).not.toContain('bg-success')
  })

  it('点击「正在跑」视图切换过滤（黑盒）：仅显示占用中卡片', async () => {
    const records = [
      makeRecord({ subagentId: 'live-1', agent: 'runner', status: 'running' }),
      makeRecord({ subagentId: 'idle-1', agent: 'researcher', status: 'idle', stopReason: 'completed' }),
    ]
    const wrapper = mountList(records)

    await showRunning(wrapper)

    expect(wrapper.find('[data-testid="subagent-filter-running"]').attributes('data-active')).toBe('true')
    const cards = wrapper.findAll('[data-testid="subagent-card"]')
    expect(cards).toHaveLength(1)
    expect(cards[0].text()).toContain('runner')
    expect(wrapper.text()).not.toContain('researcher')
  })

  it('active 空视图（全收起）：空态文案 + 「查看已收起（N）」jump-archived 黑盒点击后可见', async () => {
    const records = [makeRecord({ subagentId: 'arch-only-1', agent: 'old-researcher', status: 'idle', intent: 'archived' })]
    const wrapper = mountList(records)

    // 默认视图为空：空态文案 + hint + 跳转按钮（计数 = 已收起 1）
    const emptyActive = wrapper.find('[data-testid="subagent-list-empty-active"]')
    expect(emptyActive.exists()).toBe(true)
    expect(emptyActive.text()).toContain('暂无会话')

    const jumpArchived = wrapper.find('[data-testid="subagent-filter-jump-archived"]')
    expect(jumpArchived.exists()).toBe(true)
    expect(jumpArchived.text()).toContain('查看已收起（1）')

    // 黑盒点击 → 切「已收起」视图，收起卡片可见，空态消失
    await jumpArchived.trigger('click')
    expect(wrapper.find('[data-testid="subagent-filter-archived"]').attributes('data-active')).toBe('true')
    expect(wrapper.find('[data-testid="subagent-list-empty-active"]').exists()).toBe(false)
    expect(wrapper.findAll('[data-testid="subagent-card"]')).toHaveLength(1)
  })

  it('running 空视图：文案 + 「查看全部（N）」jump-all 黑盒点击回默认视图', async () => {
    const records = [makeRecord({ subagentId: 'idle-only-1', agent: 'researcher', status: 'idle', stopReason: 'completed' })]
    const wrapper = mountList(records)

    await showRunning(wrapper)

    const emptyRunning = wrapper.find('[data-testid="subagent-list-empty-running"]')
    expect(emptyRunning.exists()).toBe(true)
    expect(emptyRunning.text()).toContain('没有正在跑的会话')

    const jumpAll = wrapper.find('[data-testid="subagent-filter-jump-all"]')
    expect(jumpAll.exists()).toBe(true)
    expect(jumpAll.text()).toContain('查看全部（1）')

    await jumpAll.trigger('click')
    expect(wrapper.find('[data-testid="subagent-filter-active"]').attributes('data-active')).toBe('true')
    expect(wrapper.findAll('[data-testid="subagent-card"]')).toHaveLength(1)
  })

  it('「已收起」空视图：仅文案，无 jump 按钮', async () => {
    const records = [makeRecord({ subagentId: 'live-only-1', agent: 'runner', status: 'running' })]
    const wrapper = mountList(records)

    await showArchived(wrapper)

    const emptyArchived = wrapper.find('[data-testid="subagent-list-empty-archived"]')
    expect(emptyArchived.exists()).toBe(true)
    expect(emptyArchived.text()).toContain('没有已收起的会话')
    expect(wrapper.find('[data-testid="subagent-filter-jump-all"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="subagent-filter-jump-archived"]').exists()).toBe(false)
  })

  it('loading 态不渲染筛选条（D6）', () => {
    const wrapper = mountList([makeRecord({ status: 'running' })], { isLoading: true })

    expect(wrapper.find('[data-testid="subagent-list-loading"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="subagent-filter-bar"]').exists()).toBe(false)
  })

  it('error 态不渲染筛选条（D6）', () => {
    const wrapper = mountList([makeRecord({ status: 'running' })], { loadError: 'boom' })

    expect(wrapper.find('[data-testid="subagent-list-error"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="subagent-filter-bar"]').exists()).toBe(false)
  })

  it('空数据不渲染筛选条（D6：沿用既有空态）', () => {
    const wrapper = mountList([])

    expect(wrapper.find('[data-testid="subagent-list-empty"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="subagent-filter-bar"]').exists()).toBe(false)
  })

  it('切 sessionId prop 重置分区语义：同实例切 sid 后新分区默认 active（D5；切 tab 重置属 Sidebar 层 v-if 不在本组件测试范围）', async () => {
    // session A：默认视图，用户切到「已收起」
    const wrapper = mountList(
      [makeRecord({ agent: 'old', status: 'idle', intent: 'archived' })],
      { sessionId: 'sess-a' },
    )
    await showArchived(wrapper)
    expect(wrapper.find('[data-testid="subagent-filter-archived"]').attributes('data-active')).toBe('true')

    // 同实例切 sid（焦点 session 变化）：B 新分区默认 active，A 的「已收起」不残留
    await wrapper.setProps({ sessionId: 'sess-b' })
    expect(wrapper.find('[data-testid="subagent-filter-active"]').attributes('data-active')).toBe('true')
    expect(wrapper.find('[data-testid="subagent-filter-archived"]').attributes('data-active')).toBe('false')

    // 切回 A：挂载期内分区恢复 A 上次选择（「已收起」）
    await wrapper.setProps({ sessionId: 'sess-a' })
    expect(wrapper.find('[data-testid="subagent-filter-archived"]').attributes('data-active')).toBe('true')
  })
})
