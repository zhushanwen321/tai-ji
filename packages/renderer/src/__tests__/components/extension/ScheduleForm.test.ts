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

  it('② once 初值折叠/还原：还原时刻进 datetime 控件，提交 dateToOnceCron 折叠回同一 cron', async () => {
    // 迁移保真注记：原 ScheduleCreateOverlay 对「还原成功」分支不切换 kind——初值视图仍
    // recurring，还原时刻在后台进 onceLocal，用户切 once 后直接呈现（非默认下一整点）。
    // 本用例按原行为断言（探针核验原组件同表现）；kind 初值切留属行为变更，不在迁移范围。
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2030, 0, 1, 9, 0, 0, 0))
    try {
      const wrapper = mountForm({ ...baseDraft, kind: 'once', schedule: '30 9 15 6 *' })

      // 原行为：还原成功不切 kind，初值视图仍 recurring（默认 chip 选中）
      expect(wrapper.find('[data-testid="schedule-create-cron-chip-0 9 * * *"]').exists()).toBe(true)

      // 切到 once：还原时刻直接进 datetime 控件（onceCronToDate 单点还原）
      await wrapper.find('[data-testid="schedule-create-kind-once"]').trigger('click')
      const input = wrapper.find('[data-testid="schedule-create-once-input"]')
      expect((input.element as HTMLInputElement).value).toBe('2030-06-15T09:30')

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
    expect((wrapper.vm as unknown as { canSubmit: boolean }).canSubmit).toBe(true)

    // datetime-local 手输过去值：预览区已过警示 + 提交门关闭
    await wrapper.find('[data-testid="schedule-create-once-input"]').setValue('2020-01-01T09:00')
    await nextTick()
    expect(wrapper.find('[data-testid="schedule-create-preview"]').text()).toContain('所选时间已过')
    expect((wrapper.vm as unknown as { canSubmit: boolean }).canSubmit).toBe(false)
    expect(submitAndParse(wrapper)).toBeNull()

    // 重选未来时刻 → 恢复可提交
    await wrapper.find('[data-testid="schedule-create-once-input"]').setValue('2030-01-01T09:00')
    await nextTick()
    expect((wrapper.vm as unknown as { canSubmit: boolean }).canSubmit).toBe(true)
  })

  it('⑤ once 未选时刻 = 未补全（区别于预览失败）：仍拦提交', async () => {
    const wrapper = mountForm({ ...baseDraft, kind: 'once', schedule: '0 9 * * MON' })
    expect((wrapper.vm as unknown as { canSubmit: boolean }).canSubmit).toBe(true)

    await wrapper.find('[data-testid="schedule-create-once-input"]').setValue('')
    await nextTick()
    expect(wrapper.find('[data-testid="schedule-create-preview"]').text()).toContain('请选择执行时间')
    expect((wrapper.vm as unknown as { canSubmit: boolean }).canSubmit).toBe(false)
  })

  it('⑤-迁移: once 时刻停留至过期后提交 → 提交瞬间复核拦截（nowMs 表单时钟，8e2a1b06f）', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2030, 0, 1, 9, 0, 0, 0))
    try {
      const wrapper = mountForm({ ...baseDraft, kind: 'once', schedule: '0 9 * * MON' })
      await wrapper.find('[data-testid="schedule-create-once-input"]').setValue('2030-01-01T09:05')
      await nextTick()
      expect((wrapper.vm as unknown as { canSubmit: boolean }).canSubmit).toBe(true)

      // 时间流逝到 09:06（时刻已过）：无交互 → canSubmit 缓存仍 true，
      // submit() 的提交瞬间复核（刷新表单时钟）拦截——无回包
      vi.setSystemTime(new Date(2030, 0, 1, 9, 6, 0, 0))
      expect(submitAndParse(wrapper)).toBeNull()
      expect(wrapper.emitted('submit')).toBeUndefined()

      // 复核刷新驱动重算：canSubmit 转 false、预览区已过警示
      await nextTick()
      expect((wrapper.vm as unknown as { canSubmit: boolean }).canSubmit).toBe(false)
      expect(wrapper.find('[data-testid="schedule-create-preview"]').text()).toContain('所选时间已过')
    } finally {
      vi.useRealTimers()
    }
  })

  it('⑥ 模型三态：draft.model 优先 / 回退 currentModel / 再回退列表首项；空列表 hint + 当前会话标记', () => {
    // draft.model 优先
    const byModel = mountForm({ ...baseDraft, model: 'm-2' })
    expect(byModel.find('[data-testid="schedule-create-model-m-2"]').attributes('aria-checked')).toBe('true')

    // 回退 currentModel
    const byCurrent = mountForm({ ...baseDraft, currentModel: 'm-2' })
    expect(byCurrent.find('[data-testid="schedule-create-model-m-2"]').attributes('aria-checked')).toBe('true')

    // model 不在候选列表 → 回退列表首项
    const fallback = mountForm({ ...baseDraft, model: 'm-x' })
    expect(fallback.find('[data-testid="schedule-create-model-m-1"]').attributes('aria-checked')).toBe('true')

    // 「当前会话」标记跟随 draft.currentModel
    expect(fallback.find('[data-testid="schedule-create-model-m-1"]').text()).toContain('当前会话')

    // 空候选列表 → hint（跟随会话当前模型），提交不携带 model
    const noModels = mountForm({ ...baseDraft, models: [], currentModel: undefined })
    expect(noModels.find('[data-testid="schedule-create-model-m-1"]').exists()).toBe(false)
    expect(noModels.text()).toContain('跟随会话当前模型')
    expect((noModels.vm as unknown as { canSubmit: boolean }).canSubmit).toBe(true)
    const result = submitAndParse(noModels)
    expect(result).toMatchObject({ kind: 'recurring' })
    expect(result!.model).toBeUndefined()
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

  it('⑩ Esc 键 = cancelled（渲染器级键位，emit cancel；按钮取消由壳承担）', async () => {
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
    // 摘要行给出可确认反馈（用户可见）
    expect(wrapper.find('[data-testid="schedule-create-foot-note"]').text()).toContain('每天 09:00')
  })
})
