/**
 * DateTimePicker 组件测试（once 时刻选择器：自绘月历 + HH/mm 双段，替代原生 datetime-local）。
 *
 * 契约：v-model = datetime-local 同形字符串 `yyyy-MM-ddTHH:mm`（空串 = 未选）；时刻有效性
 * 判定（onceTimeValid）与提交折叠（dateToOnceCron）在 ScheduleForm / extension-protocol，
 * 本组件只负责「展示 + 选择 + 发值」。
 *
 * 三视角：构建者白盒（emit 的 update:modelValue 值形状与派生规则）+ 使用者黑盒（每用例至少
 * 一个用户可见 DOM 断言：触发框文本 / 日期格选中态 / 时间段 value / 警示行）+ 观察者形态
 * （面板开合显隐 / 今天描边与跨月弱化 / 整点档高亮）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/components/extension
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import DateTimePicker from '@/components/extension/form/DateTimePicker.vue'

/** 固定「今天」= 2030-06-15（周六）10:00：日历今天判定 / nextFullHour 初值全部确定 */
function freezeToday(): void {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(2030, 5, 15, 10, 0, 0, 0))
}

function mountPicker(modelValue = '') {
  // attachTo document.body：happy-dom 的 getComputedStyle 只对已连接元素解析 inline style——
  // v-show 显隐断言（isVisible）依赖它（与 ScheduleForm.test.ts 同款挂载惯例）。
  // onUpdate 回写 props = 完整受控闭环（emit → 父 v-model → props 更新 → 选中态/时间字段联动）
  let wrapper!: ReturnType<typeof mount>
  wrapper = mount(DateTimePicker, {
    props: {
      modelValue,
      'onUpdate:modelValue': (v: string) => wrapper.setProps({ modelValue: v }),
    },
    attachTo: document.body,
  })
  return wrapper
}

/** 触发框文本（用户可见的当前值形态） */
function triggerText(wrapper: ReturnType<typeof mountPicker>): string {
  return wrapper.find('[data-testid="schedule-create-once-input"]').text()
}

/** 最近一次 update:modelValue 的值（emitted 记录 = 每次调用的参数数组，[0] 即值本身） */
function lastEmitted(wrapper: ReturnType<typeof mountPicker>): string | undefined {
  const events = wrapper.emitted('update:modelValue')
  return events?.at(-1)?.[0] as string | undefined
}

/** 展开面板并返回 wrapper（面板 v-show 常挂，展开仅翻转可见性） */
async function openPanel(wrapper: ReturnType<typeof mountPicker>) {
  await wrapper.find('[data-testid="schedule-create-once-input"]').trigger('click')
  expect(wrapper.find('[data-testid="schedule-create-once-panel"]').isVisible()).toBe(true)
  return wrapper
}

describe('DateTimePicker · 触发框（值展示）', () => {
  beforeEach(freezeToday)
  afterEach(() => vi.useRealTimers())

  it('未选时刻：触发框显示占位文案（用户可见），面板默认收起', async () => {
    const wrapper = mountPicker('')
    expect(triggerText(wrapper)).toContain('请选择执行时间')
    expect(wrapper.find('[data-testid="schedule-create-once-input"]').attributes('aria-expanded')).toBe('false')
    expect(wrapper.find('[data-testid="schedule-create-once-panel"]').isVisible()).toBe(false)
  })

  it('已选时刻：触发框显示 mono 日期时间 + 星期（Intl），aria-expanded 翻转', async () => {
    const wrapper = mountPicker('2030-06-15T09:30')
    expect(triggerText(wrapper)).toContain('2030-06-15 09:30')
    expect(triggerText(wrapper)).toContain('周六')
    expect(wrapper.find('[data-testid="schedule-create-once-input"]').attributes('aria-expanded')).toBe('false')
    await openPanel(wrapper)
    expect(wrapper.find('[data-testid="schedule-create-once-input"]').attributes('aria-expanded')).toBe('true')
  })

  it('已过时刻：触发框文字转 warn 色 + 面板警示行可见；未来时刻无警示', async () => {
    const past = mountPicker('2030-06-15T09:00') // 今天 10:00 前一小时
    expect(past.find('[data-testid="schedule-create-once-input"] .text-warn').exists()).toBe(true)
    await openPanel(past)
    expect(past.find('[data-testid="schedule-create-once-panel"]').text()).toContain('所选时间已过')

    const future = mountPicker('2030-06-16T09:00')
    expect(future.find('[data-testid="schedule-create-once-input"] .text-warn').exists()).toBe(false)
  })
})

describe('DateTimePicker · 月历（渲染与选择）', () => {
  beforeEach(freezeToday)
  afterEach(() => vi.useRealTimers())

  it('周一起始：首列星期名为「周一」族；当月 30 天 + 跨月补位成整行网格', async () => {
    const wrapper = await openPanel(mountPicker('2030-06-15T09:30'))
    const cal = wrapper.find('[data-testid="schedule-create-once-calendar"]')
    // 2030-06：6/1 周六 → 周一起始偏移 5（补 5/27..5/31 共 5 格）+ 30 天 = 35 格恰 5 整行
    const days = cal.findAll('button')
    expect(days.length).toBe(35)
    expect(days[0]!.text()).toBe('27') // 5/27 补位
    expect(days[0]!.classes().join(' ')).toContain('text-neutral-faint')
    // 今天（6/15）inset 描边；选中（6/15）accent 实色
    const today = cal.find('[data-testid="schedule-create-once-day-2030-06-15"]')
    expect(today.classes().join(' ')).toContain('bg-accent')
    // 表头第一格 = 周一（Intl 短名）
    expect(cal.text()).toContain('周一')
  })

  it('点当月日期格：emit 同月同刻（保留已选时刻），选中态跟随', async () => {
    const wrapper = await openPanel(mountPicker('2030-06-15T09:30'))
    await wrapper.find('[data-testid="schedule-create-once-day-2030-06-20"]').trigger('click')
    expect(lastEmitted(wrapper)).toBe('2030-06-20T09:30')
    expect(wrapper.find('[data-testid="schedule-create-once-day-2030-06-20"]').classes().join(' ')).toContain('bg-accent')
  })

  it('点跨月补位格：emit 对应月份日期（视图随之跳月）', async () => {
    const wrapper = await openPanel(mountPicker('2030-06-15T09:30'))
    await wrapper.find('[data-testid="schedule-create-once-day-2030-05-31"]').trigger('click')
    expect(lastEmitted(wrapper)).toBe('2030-05-31T09:30')
    expect(wrapper.find('[data-testid="schedule-create-once-day-2030-06-20"]').exists()).toBe(false)
  })

  it('无时刻基座（空值）选日期：emit 下一整点（nextFullHour 单点）', async () => {
    const wrapper = await openPanel(mountPicker(''))
    // 今天 10:00 → 下一整点 11:00
    await wrapper.find('[data-testid="schedule-create-once-day-2030-06-20"]').trigger('click')
    expect(lastEmitted(wrapper)).toBe('2030-06-20T11:00')
  })

  it('月导航：上月/下月切换月头文案与网格（观察者形态）', async () => {
    const wrapper = await openPanel(mountPicker('2030-06-15T09:30'))
    await wrapper.find('[data-testid="schedule-create-once-prev-month"]').trigger('click')
    expect(wrapper.find('[data-testid="schedule-create-once-panel"]').text()).toContain('2030年5月')
    await wrapper.find('[data-testid="schedule-create-once-next-month"]').trigger('click')
    await wrapper.find('[data-testid="schedule-create-once-next-month"]').trigger('click')
    expect(wrapper.find('[data-testid="schedule-create-once-panel"]').text()).toContain('2030年7月')
  })
})

describe('DateTimePicker · 时间双段（编辑 / 步进 / 快捷档）', () => {
  beforeEach(freezeToday)
  afterEach(() => vi.useRealTimers())

  it('时间字段回显选中值；非法输入过滤非数字（input 中间态不外发）', async () => {
    const wrapper = await openPanel(mountPicker('2030-06-15T09:30'))
    const hh = wrapper.find('[data-testid="schedule-create-once-hh"]')
    const mm = wrapper.find('[data-testid="schedule-create-once-mm"]')
    expect((hh.element as HTMLInputElement).value).toBe('09')
    expect((mm.element as HTMLInputElement).value).toBe('30')
    // 键入中间态只本地过滤（'abc' → ''），不 emit
    await hh.setValue('ab')
    expect(lastEmitted(wrapper)).toBeUndefined()
  })

  it('blur 归一并 emit：键入 8 → 08:30 回写；超界 26 → clamp 23', async () => {
    const wrapper = await openPanel(mountPicker('2030-06-15T09:30'))
    const hh = wrapper.find('[data-testid="schedule-create-once-hh"]')
    await hh.setValue('8')
    await hh.trigger('blur')
    expect(lastEmitted(wrapper)).toBe('2030-06-15T08:30')
    expect((hh.element as HTMLInputElement).value).toBe('08')

    await hh.setValue('26')
    await hh.trigger('blur')
    expect(lastEmitted(wrapper)).toBe('2030-06-15T23:30')
  })

  it('键盘步进：时 ↑↓ ±1h、分 ↑↓ ±15m，0 下界 clamp 不环绕', async () => {
    const wrapper = await openPanel(mountPicker('2030-06-15T09:30'))
    await wrapper.find('[data-testid="schedule-create-once-hh"]').trigger('keydown.up')
    expect(lastEmitted(wrapper)).toBe('2030-06-15T10:30')
    await wrapper.find('[data-testid="schedule-create-once-mm"]').trigger('keydown.down')
    expect(lastEmitted(wrapper)).toBe('2030-06-15T10:15')
    // mm 继续 ↓ 30→15→0；0 再 ↓ clamp 0（不环绕）
    await wrapper.find('[data-testid="schedule-create-once-mm"]').trigger('keydown.down')
    expect(lastEmitted(wrapper)).toBe('2030-06-15T10:00')
    await wrapper.find('[data-testid="schedule-create-once-mm"]').trigger('keydown.down')
    expect(lastEmitted(wrapper)).toBe('2030-06-15T10:00')
  })

  it('stepper 按钮作用于最近聚焦段：默认小时，聚焦分钟后切分钟', async () => {
    const wrapper = await openPanel(mountPicker('2030-06-15T09:30'))
    await wrapper.find('[data-testid="schedule-create-once-step-up"]').trigger('click')
    expect(lastEmitted(wrapper)).toBe('2030-06-15T10:30')
    await wrapper.find('[data-testid="schedule-create-once-mm"]').trigger('focus')
    await wrapper.find('[data-testid="schedule-create-once-step-down"]').trigger('click')
    // hh 已步进到 10（上一步），mm 减档 30 → 15
    expect(lastEmitted(wrapper)).toBe('2030-06-15T10:15')
  })

  it('整点快捷档：emit 选中日期 + 档位时刻；命中档高亮（aria-pressed）', async () => {
    const wrapper = await openPanel(mountPicker('2030-06-15T09:30'))
    const noon = wrapper.find('[data-testid="schedule-create-once-quick-1200"]')
    expect(noon.attributes('aria-pressed')).toBe('false')
    await noon.trigger('click')
    expect(lastEmitted(wrapper)).toBe('2030-06-15T12:00')
    expect(wrapper.find('[data-testid="schedule-create-once-quick-1200"]').attributes('aria-pressed')).toBe('true')
  })
})
