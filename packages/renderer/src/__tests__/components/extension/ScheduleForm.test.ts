/**
 * ScheduleForm 组件测试（ui-presentation-protocol u3；ScheduleCreateOverlay 整表单
 * 迁移的行为保真验收 = 设计 §4-附 11 条逐项断言 + schedule-create-inline.test.ts
 * 「cron 预览与提交解耦」用例的组件级等价迁移，含 8e2a1b06f once 过期拦截 + 提交复核）。
 *
 * 挂载形态：组件级直挂（mount ScheduleForm，question.initial 携 draft）——与旧用例
 * 经 Panel 挂载等价（Panel 分流挂载断言仍在 schedule-create-inline.test.ts，归 u4 接线）。
 *
 * 三视角：构建者白盒（exposed canSubmit/submit 返回值与回包形状）+ 使用者黑盒（每用例
 * 至少一个用户可见 DOM 断言：testid 存在性/文本/value/disabled 形态）+ 观察者形态
 * （kind 切换显隐 / chips 选中态 / 高级折叠显隐）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/components/extension
 */
import { describe, it, expect, vi } from 'vitest'
import { nextTick } from 'vue'
import { mount } from '@vue/test-utils'
import ScheduleForm from '@/components/extension/form/ScheduleForm.vue'
import DateTimePicker from '@/components/extension/form/DateTimePicker.vue'
import type { ScheduleDraft, ScheduleQuestion } from '@zhushanwen/extension-protocol'

const baseDraft: ScheduleDraft = {
  kind: 'recurring',
  schedule: '0 9 * * *',
  prompt: '总结昨天的工作进展',
  models: ['m-1', 'm-2'],
  currentModel: 'm-1',
}

function mountForm(initial: ScheduleDraft) {
  const question: ScheduleQuestion = {
    type: 'schedule',
    question: '确认创建定时任务',
    initial,
  }
  return mount(ScheduleForm, { props: { question }, attachTo: document.body })
}

/** exposed submit() 调用并断言回包形状（扁平 ScheduleFormResult JSON，§4-附 ⑪） */
function submitAndParse(wrapper: ReturnType<typeof mountForm>): Record<string, unknown> | null {
  const json = (wrapper.vm as unknown as { submit: () => string | null }).submit()
  return json === null ? null : (JSON.parse(json) as Record<string, unknown>)
}

/** exposed canSubmit（壳 Submit 门委托的同一 computed） */
function canSubmit(wrapper: ReturnType<typeof mountForm>): boolean {
  return (wrapper.vm as unknown as { canSubmit: boolean }).canSubmit
}

/**
 * 经 DateTimePicker 组件边界发 v-model 值（onceLocal 单一数据源）。picker 内部的
 * 真实交互链（日历点选 / 双段编辑 / 步进）在 DateTimePicker.test.ts 覆盖，此处
 * 只测 ScheduleForm 对值的消费（预览 / 提交门 / 回包折叠）。
 */
function setOnce(wrapper: ReturnType<typeof mountForm>, value: string): void {
  wrapper.findComponent(DateTimePicker).vm.$emit('update:modelValue', value)
}

describe('ScheduleForm · §4-附 行为保真清单', () => {
  it('① kind once/recurring 切换：控件显隐互换', async () => {
    const wrapper = mountForm(baseDraft)

    // 初始 recurring：cron chips 可见、once 控件不存在
    expect(wrapper.find('[data-testid="schedule-create-cron-chip-0 9 * * *"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="schedule-create-once-input"]').exists()).toBe(false)

    // 切 once：datetime 控件出现、chips 消失
    await wrapper.find('[data-testid="schedule-create-kind-once"]').trigger('click')
    expect(wrapper.find('[data-testid="schedule-create-once-input"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="schedule-create-cron-chip-0 9 * * *"]').exists()).toBe(false)

    // 切回 recurring
    await wrapper.find('[data-testid="schedule-create-kind-recurring"]').trigger('click')
    expect(wrapper.find('[data-testid="schedule-create-cron-chip-0 9 * * *"]').exists()).toBe(true)
  })

  it('② once 初值折叠/还原：once 草稿直接呈现 once 视图，提交 dateToOnceCron 折叠回同一 cron', async () => {
    // 行为变更（默认单次裁决）：还原成功的 once 草稿不再藏于 recurring 视图——kind 跟随
    // draft.kind 直接呈现 once 视图（原迁移保真口径「还原成功不切 kind」随默认单次退役）。
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2030, 0, 1, 9, 0, 0, 0))
    try {
      const wrapper = mountForm({ ...baseDraft, kind: 'once', schedule: '30 9 15 6 *' })

      // once 视图直接呈现：触发框显示还原时刻（onceCronToDate 单点还原），cron chips 不存在
      expect(wrapper.find('[data-testid="schedule-create-once-input"]').exists()).toBe(true)
      expect(wrapper.find('[data-testid="schedule-create-cron-chip-0 9 * * *"]').exists()).toBe(false)
      expect(wrapper.find('[data-testid="schedule-create-once-input"]').text()).toContain('2030-06-15 09:30')

      // 提交折叠回同一 once cron（dateToOnceCron 单点）
      const result = submitAndParse(wrapper)
      expect(result).toMatchObject({ kind: 'once', schedule: '30 9 15 6 *' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('③ recurring：五枚预设 chips / 自定义 cron / duration 形态', async () => {
    const wrapper = mountForm(baseDraft)

    // 五枚预设 chips 全渲染，draft cron 命中 daily9 chip 选中态
    const chips = wrapper.findAll('[data-testid^="schedule-create-cron-chip-"]')
    expect(chips).toHaveLength(5)
    expect(wrapper.find('[data-testid="schedule-create-cron-chip-0 9 * * *"]').attributes('aria-pressed')).toBe('true')

    // 自定义：切自定义 → cron 输入框可见并聚焦，改表达式后回传原文
    await wrapper.find('[data-testid="schedule-create-cron-custom"]').trigger('click')
    expect(wrapper.find('[data-testid="schedule-create-cron-input"]').isVisible()).toBe(true)
    await wrapper.find('[data-testid="schedule-create-cron-input"]').setValue('0 10 * * *')
    expect(submitAndParse(wrapper)).toMatchObject({ schedule: '0 10 * * *' })

    // duration 形态：非预设 cron 进自定义输入框，原样回传
    const durWrapper = mountForm({ ...baseDraft, schedule: '5m' })
    expect((durWrapper.find('[data-testid="schedule-create-cron-input"]').element as HTMLInputElement).value).toBe('5m')
    expect(submitAndParse(durWrapper)).toMatchObject({ schedule: '5m' })
  })

  it('④ 下次运行预览实时联动：合法 cron 出预览列表，非法出非阻塞警示但不拦提交', async () => {
    const wrapper = mountForm(baseDraft)

    expect(wrapper.find('[data-testid="schedule-create-preview"]').text()).toContain('下次运行')

    // 真非法表达式 → 非阻塞警示（后端权威验证），canSubmit 仍真、表达式原样回传
    await wrapper.find('[data-testid="schedule-create-cron-custom"]').trigger('click')
    await wrapper.find('[data-testid="schedule-create-cron-input"]').setValue('nonsense expr here')
    expect(wrapper.find('[data-testid="schedule-create-preview"]').text()).toContain('无法预览：表达式将由创建端验证')
    expect((wrapper.vm as unknown as { canSubmit: boolean }).canSubmit).toBe(true)
    expect(submitAndParse(wrapper)).toMatchObject({ schedule: 'nonsense expr here' })
  })

  it('④-迁移: 周域英文名 / 6 段含秒 draft → 预览命中且表达式原样回传', () => {
    const dowWrapper = mountForm({ ...baseDraft, schedule: '0 9 * * MON' })
    const dowPreview = dowWrapper.find('[data-testid="schedule-create-preview"]').text()
    expect(dowPreview).toContain('下次运行')
    expect(dowPreview).not.toContain('无法预览')
    expect(submitAndParse(dowWrapper)).toMatchObject({ schedule: '0 9 * * MON' })

    const sixWrapper = mountForm({ ...baseDraft, schedule: '0 0 9 * * *' })
    expect(sixWrapper.find('[data-testid="schedule-create-preview"]').text()).toContain('下次运行')
    expect(submitAndParse(sixWrapper)).toMatchObject({ schedule: '0 0 9 * * *' })
  })

  it('⑤ once 已过时刻拦截：预览提示已过 + 提交门关闭，重选未来恢复（8e2a1b06f）', async () => {
    const wrapper = mountForm({ ...baseDraft, kind: 'once', schedule: '0 9 * * MON' })
    // onceCronToDate 还原失败（周域非 *）→ 默认下一整点，可提交（预填草稿可直接确认）
    expect(canSubmit(wrapper)).toBe(true)

    // picker 发过去值：预览区已过警示 + 提交门关闭
    setOnce(wrapper, '2020-01-01T09:00')
    await nextTick()
    expect(wrapper.find('[data-testid="schedule-create-preview"]').text()).toContain('所选时间已过')
    expect(canSubmit(wrapper)).toBe(false)
    expect(submitAndParse(wrapper)).toBeNull()

    // 重选未来时刻 → 恢复可提交
    setOnce(wrapper, '2030-01-01T09:00')
    await nextTick()
    expect(canSubmit(wrapper)).toBe(true)
  })

  it('⑤ once 未选时刻 = 未补全（区别于预览失败）：仍拦提交', async () => {
    const wrapper = mountForm({ ...baseDraft, kind: 'once', schedule: '0 9 * * MON' })
    expect(canSubmit(wrapper)).toBe(true)

    setOnce(wrapper, '')
    await nextTick()
    expect(wrapper.find('[data-testid="schedule-create-preview"]').text()).toContain('请选择执行时间')
    expect(canSubmit(wrapper)).toBe(false)
  })

  it('⑤-迁移: once 时刻停留至过期后提交 → 提交瞬间复核拦截（nowMs 表单时钟，8e2a1b06f）', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2030, 0, 1, 9, 0, 0, 0))
    try {
      const wrapper = mountForm({ ...baseDraft, kind: 'once', schedule: '0 9 * * MON' })
      setOnce(wrapper, '2030-01-01T09:05')
      await nextTick()
      expect(canSubmit(wrapper)).toBe(true)

      // 时间流逝到 09:06（时刻已过）：无交互 → canSubmit 缓存仍 true，
      // submit() 的提交瞬间复核（刷新表单时钟）拦截——无回包
      vi.setSystemTime(new Date(2030, 0, 1, 9, 6, 0, 0))
      expect(submitAndParse(wrapper)).toBeNull()
      expect(wrapper.emitted('submit')).toBeUndefined()

      // 复核刷新驱动重算：canSubmit 转 false、预览区已过警示
      await nextTick()
      expect(canSubmit(wrapper)).toBe(false)
      expect(wrapper.find('[data-testid="schedule-create-preview"]').text()).toContain('所选时间已过')
    } finally {
      vi.useRealTimers()
    }
  })

  it('⑥ 模型三态：draft.model 优先 / 回退 currentModel / 再回退列表首项；空列表 hint + 当前会话标记', () => {
    // 三态经单行选框（D4）呈现：触发器显示选中 id
    const byModel = mountForm({ ...baseDraft, model: 'm-2' })
    expect(byModel.find('[data-testid="schedule-create-model-trigger"]').text()).toContain('m-2')

    // 回退 currentModel
    const byCurrent = mountForm({ ...baseDraft, currentModel: 'm-2' })
    expect(byCurrent.find('[data-testid="schedule-create-model-trigger"]').text()).toContain('m-2')

    // model 不在候选列表 → 回退列表首项
    const fallback = mountForm({ ...baseDraft, model: 'm-x' })
    expect(fallback.find('[data-testid="schedule-create-model-trigger"]').text()).toContain('m-1')

    // 「当前会话」标记跟随 draft.currentModel（触发器内）
    expect(fallback.find('[data-testid="schedule-create-model-trigger"]').text()).toContain('当前会话')
    // 候选列表常挂（v-show），选中项高亮（ModelPickerPanel 选中态）
    expect(fallback.find('[data-testid="schedule-create-model-m-1"]').classes().join(' ')).toContain('bg-accent-soft')

    // 空候选列表 → hint（跟随会话当前模型），提交不携带 model
    const noModels = mountForm({ ...baseDraft, models: [], currentModel: undefined })
    expect(noModels.find('[data-testid="schedule-create-model-m-1"]').exists()).toBe(false)
    expect(noModels.find('[data-testid="schedule-create-model-trigger"]').exists()).toBe(false)
    expect(noModels.text()).toContain('跟随会话当前模型')
    expect((noModels.vm as unknown as { canSubmit: boolean }).canSubmit).toBe(true)
    const result = submitAndParse(noModels)
    expect(result).toMatchObject({ kind: 'recurring' })
    expect(result!.model).toBeUndefined()
  })

  it('⑥-选框展开：点击触发器展开候选列表，点选切换选中并回包（用户可见 DOM）', async () => {
    const wrapper = mountForm(baseDraft)
    const trigger = () => wrapper.find('[data-testid="schedule-create-model-trigger"]')
    expect(trigger().text()).toContain('m-1')

    // 收起时列表常挂（v-show）不可见
    expect(wrapper.find('[data-testid="schedule-create-model-m-2"]').isVisible()).toBe(false)
    await trigger().trigger('click')
    expect(trigger().attributes('aria-expanded')).toBe('true')
    expect(wrapper.find('[data-testid="schedule-create-model-m-2"]').isVisible()).toBe(true)

    // 点选另一模型 → 触发器文案跟随 + 回包携带新模型
    await wrapper.find('[data-testid="schedule-create-model-m-2"]').trigger('click')
    expect(trigger().text()).toContain('m-2')
    expect(submitAndParse(wrapper)).toMatchObject({ model: 'm-2' })
  })

  it('⑦ prompt 预填 + name 留空可选：留空回包不含 name，填写则携带', async () => {
    const wrapper = mountForm(baseDraft)

    // prompt 预填进 textarea（用户可见）
    expect((wrapper.find('[data-testid="schedule-create-prompt"]').element as HTMLTextAreaElement).value).toBe('总结昨天的工作进展')

    // name 留空 → 回包无 name 键
    expect(submitAndParse(wrapper)).not.toHaveProperty('name')

    // 高级区填任务名 → 回包携带
    await wrapper.find('[data-testid="schedule-create-advanced-toggle"]').trigger('click')
    await wrapper.find('[data-testid="schedule-create-name"]').setValue('周报任务')
    expect(submitAndParse(wrapper)).toMatchObject({ name: '周报任务' })
  })

  it('⑧ expires 枚举三选 × 仅 recurring 回包携带（once 不含 expires）', async () => {
    const wrapper = mountForm(baseDraft)

    await wrapper.find('[data-testid="schedule-create-advanced-toggle"]').trigger('click')
    // 三枚枚举按钮全渲染，默认 7d 选中
    expect(wrapper.findAll('[data-testid^="schedule-create-expires-"]')).toHaveLength(3)
    expect(wrapper.find('[data-testid="schedule-create-expires-7d"]').attributes('aria-pressed')).toBe('true')
    expect(submitAndParse(wrapper)).toMatchObject({ expires: '7d' })

    // 切 30d → 回包携带 30d
    await wrapper.find('[data-testid="schedule-create-expires-30d"]').trigger('click')
    expect(submitAndParse(wrapper)).toMatchObject({ expires: '30d' })

    // once 回包不含 expires
    const onceWrapper = mountForm({ ...baseDraft, kind: 'once', schedule: '0 9 * * MON' })
    expect(submitAndParse(onceWrapper)).not.toHaveProperty('expires')
  })

  it('⑨ 高级选项折叠区：默认收起，展开后任务名/过期策略可见', async () => {
    const wrapper = mountForm(baseDraft)

    expect(wrapper.find('[data-testid="schedule-create-name"]').isVisible()).toBe(false)
    await wrapper.find('[data-testid="schedule-create-advanced-toggle"]').trigger('click')
    expect(wrapper.find('[data-testid="schedule-create-name"]').isVisible()).toBe(true)
    expect(wrapper.find('[data-testid="schedule-create-expires-never"]').isVisible()).toBe(true)
  })

  it('⑩ Esc 键 = cancelled（document 级 capture：焦点在 body 也能取消）', async () => {
    const wrapper = mountForm(baseDraft)

    // 真实焦点路径：打开后不点击任何控件（焦点在 body）直接 Esc
    ;(document.activeElement as HTMLElement | null)?.blur()
    expect(document.activeElement).toBe(document.body)
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await nextTick()
    expect(wrapper.emitted('cancel')).toHaveLength(1)
  })

  it('⑩-补充：焦点在表单内时 Esc 同样取消（document capture 不丢子节点路径）', async () => {
    const wrapper = mountForm(baseDraft)

    await wrapper.find('[data-testid="schedule-create-preview"]').trigger('keydown', { key: 'Escape' })
    expect(wrapper.emitted('cancel')).toHaveLength(1)
  })

  it('⑪ 确认回包 = 扁平 ScheduleFormResult JSON（submit() 返回值与 emit 同源）', () => {
    const wrapper = mountForm({ ...baseDraft, model: 'm-1' })

    const json = (wrapper.vm as unknown as { submit: () => string | null }).submit()
    expect(json).not.toBeNull()
    expect(wrapper.emitted('submit')).toHaveLength(1)
    expect(wrapper.emitted('submit')![0][0]).toBe(json)
    expect(JSON.parse(json!)).toEqual({
      action: 'create',
      kind: 'recurring',
      schedule: '0 9 * * *',
      model: 'm-1',
      prompt: '总结昨天的工作进展',
      expires: '7d',
    })
  })

  it('预填草稿一键确认：recurring + cron + prompt + 模型预选 → 打开即可提交（G1）', () => {
    const wrapper = mountForm(baseDraft)

    expect((wrapper.vm as unknown as { canSubmit: boolean }).canSubmit).toBe(true)
    // Esc 提示（用户可见；foot 摘要行已退役，D5）
    expect(wrapper.find('[data-testid="schedule-create-esc-hint"]').text()).toBe('Esc 取消')
  })

  it('提示词计数：非空时显示「将作为消息注入 · N 字」（D5 新文案）', () => {
    const wrapper = mountForm(baseDraft)

    expect(wrapper.find('[data-testid="schedule-create-prompt"]').element).toBeInstanceOf(HTMLTextAreaElement)
    expect(wrapper.text()).toContain('将作为消息注入 · 9 字')
  })
})

describe('ScheduleForm · 默认模式（默认单次裁决）', () => {
  it('无 draft（initial 缺省）→ once 视图 + 下一整点初值；补 prompt 后可提交', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2030, 0, 1, 9, 0, 0, 0))
    try {
      const wrapper = mount(ScheduleForm, {
        props: { question: { type: 'schedule', question: '确认创建定时任务' } },
        attachTo: document.body,
      })

      // once 视图 + 下一整点初值（nextFullHour 单点），cron chips 不存在
      expect(wrapper.find('[data-testid="schedule-create-once-input"]').exists()).toBe(true)
      expect(wrapper.find('[data-testid="schedule-create-cron-chip-0 9 * * *"]').exists()).toBe(false)
      expect(wrapper.find('[data-testid="schedule-create-once-input"]').text()).toContain('2030-01-01 10:00')
      // prompt 未填 = 未补全（提交门正确拦截）；补齐后可提交
      expect(canSubmit(wrapper)).toBe(false)
      await wrapper.find('[data-testid="schedule-create-prompt"]').setValue('跑日报')
      await nextTick()
      expect(canSubmit(wrapper)).toBe(true)
      // 提交折叠为一次性 cron（5 段 分 时 日 月 *）
      expect(submitAndParse(wrapper)).toMatchObject({ kind: 'once', schedule: '0 10 1 1 *' })
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('ScheduleForm · once 预设与预览降级分支', () => {
  it('once 预设按钮：+1h / 明天 9 点 / 明天 20 点写入时刻（picker 触发框联动）且均未来可提交', async () => {
    const wrapper = mountForm({ ...baseDraft, kind: 'once', schedule: '0 9 * * MON' })
    await nextTick()
    // 默认单次：once 视图直接呈现（kind-once 按钮点击幂等，预设按钮不看模式态）
    for (const tid of ['schedule-create-once-plus-1h', 'schedule-create-once-tomorrow-9', 'schedule-create-once-tomorrow-20']) {
      await wrapper.find(`[data-testid="${tid}"]`).trigger('click')
      await nextTick()
      // picker 触发框文本跟随 onceLocal（用户可见联动；值形状由 DateTimePicker.test 覆盖）
      const text = wrapper.find('[data-testid="schedule-create-once-input"]').text()
      expect(text).not.toContain('请选择执行时间')
      expect(wrapper.findComponent(DateTimePicker).props('modelValue')).not.toBe('')
    }
    // 预设时刻均在未来（onceTimeValid true 分支）→ 表单可提交
    expect(submitAndParse(wrapper)).not.toBeNull()
  })

  it('非法 cron：预览降级为非阻塞提示（预览与提交门解耦，表单仍可提交）', async () => {
    const wrapper = mountForm({ ...baseDraft, kind: 'recurring', schedule: '99 99 * * *' })
    await nextTick()

    const preview = wrapper.find('[data-testid="schedule-create-preview"]')
    expect(preview.exists()).toBe(true)
    // 无可预览运行（v-else 降级分支渲染提示文案，非日期行）
    expect(preview.text()).not.toContain('1.')
    // 预览失败不禁止提交（canSubmit 与预览解耦——模块头注释契约）
    expect(submitAndParse(wrapper)).not.toBeNull()
  })
})

describe('ScheduleForm · 自定义 cron chip 分支', () => {
  it('点击「自定义」chip：进入自定义输入态（pickCronChip(null) 分支），cron 输入框获焦可编辑', async () => {
    const wrapper = mountForm(baseDraft)
    await nextTick()
    expect(wrapper.find('[data-testid="schedule-create-cron-custom"]').exists()).toBe(true)
    await wrapper.find('[data-testid="schedule-create-cron-custom"]').trigger('click')
    await nextTick()
    // 自定义态：cron 输入框出现（aria-pressed 翻转 + input 渲染）
    expect(wrapper.find('[data-testid="schedule-create-cron-custom"]').attributes('aria-pressed')).toBe('true')
    expect(wrapper.find('[data-testid="schedule-create-cron-input"]').exists()).toBe(true)
  })
})

describe('ScheduleForm · 预设 chip 切换与空模型提示分支', () => {
  it('点击预设 chip：退出自定义态（pickCronChip 非 null 分支），自定义输入框隐藏', async () => {
    const wrapper = mountForm(baseDraft)
    await nextTick()
    // 先进入自定义态，再点击预设 chip 退出
    await wrapper.find('[data-testid="schedule-create-cron-custom"]').trigger('click')
    await nextTick()
    expect(wrapper.find('[data-testid="schedule-create-cron-input"]').isVisible()).toBe(true)
    await wrapper.find('[data-testid="schedule-create-cron-chip-0 9 * * *"]').trigger('click')
    await nextTick()
    expect(wrapper.find('[data-testid="schedule-create-cron-input"]').isVisible()).toBe(false)
    expect(wrapper.find('[data-testid="schedule-create-cron-custom"]').attributes('aria-pressed')).toBe('false')
  })

  it('models 空：渲染无模型提示（v-else 分支），无模型选项行', async () => {
    const wrapper = mountForm({ ...baseDraft, models: [], currentModel: '' })
    await nextTick()
    expect(wrapper.find('[data-testid="schedule-create-model-m-1"]').exists()).toBe(false)
    expect(wrapper.text()).toContain('无候选模型列表')
  })
})
