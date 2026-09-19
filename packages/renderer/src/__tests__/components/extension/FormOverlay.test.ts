/**
 * FormOverlay 测试（ui-presentation-protocol u3；AskUserOverlay.test.ts 等价迁移 +
 * choice/text/schedule 三渲染器与双挂载源集成）。
 *
 * 迁移来源：src/__tests__/components/AskUserOverlay.test.ts（U9-U29 + D1 编码契约 5 形态，
 * testid 正名 ask-user-* → form-*，AskUserQuestion → FormQuestion：multiSelect → multi、
 * 无 options 题改用 type:'text'）。
 *
 * 新增覆盖：
 * - schedule 渲染器集成（单问/多问、Submit 门 = 渲染器 canSubmit 委托、envelope 编码）
 * - legacy draft 直挂（扁平 ScheduleFormResult JSON 应答 + Esc/取消）
 * - schedule 提交瞬间复核（时间越界后点击提交整表中止）
 *
 * 三视角（TEST-STRATEGY §3）：构建者白盒（状态机/编码契约断言）+ 使用者黑盒（每用例
 * 至少一个用户可见 DOM 断言：testid 存在性/文本/disabled）+ 观察者形态（按钮切换/
 * 绿点/互斥挂载形态）。
 *
 * answers 编码契约（@zhushanwen/extension-protocol ui-form/types.ts + D2）：
 * - choice 单选：value = 选中项 label；多选：value = JSON.stringify(label[])
 * - Other 自由文本：独立 key `${key}__other`（不混进选中值数组）
 * - text：只写 `${key}__other`，不写主 key
 * - schedule：value = JSON.stringify(ScheduleFormResult)（单问表单下 answers 恰一键）
 * - 未答的问题：不写 key；全部未答（空表单）→ `{}`
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/components/extension
 */
import { describe, it, expect, vi } from 'vitest'
import { nextTick } from 'vue'
import { mount } from '@vue/test-utils'
import FormOverlay from '@/components/extension/form/FormOverlay.vue'
import type {
  ChoiceQuestion,
  TextQuestion,
  ScheduleQuestion,
  ScheduleDraft,
} from '@zhushanwen/extension-protocol'

// ── 测试数据（FormQuestion 形态）──
const singleSelectQ: ChoiceQuestion = {
  type: 'choice',
  header: 'db',
  question: '选哪个数据库?',
  options: [
    { label: 'Postgres' },
    { label: 'MySQL' },
  ],
}

const multiSelectQ: ChoiceQuestion = {
  type: 'choice',
  header: 'lang',
  question: '选哪些语言?',
  multi: true,
  options: [
    { label: 'TypeScript' },
    { label: 'Python' },
    { label: 'Rust' },
  ],
}

const freeTextQ: TextQuestion = {
  type: 'text',
  header: 'note',
  question: '补充说明',
}

const scheduleDraft: ScheduleDraft = {
  kind: 'recurring',
  schedule: '0 9 * * *',
  prompt: '总结昨天的工作进展',
  models: ['m-1', 'm-2'],
  currentModel: 'm-1',
}

const scheduleQ: ScheduleQuestion = {
  type: 'schedule',
  header: 'task',
  question: '确认创建定时任务',
  initial: scheduleDraft,
}

function mountOverlay(props: {
  questions?: ChoiceQuestion[] | TextQuestion[] | ScheduleQuestion[]
  allowCancel?: boolean
  draft?: ScheduleDraft
}) {
  return mount(FormOverlay, {
    props,
    attachTo: document.body,
  })
}

describe('FormOverlay · choice/text 渲染（AskUserOverlay 等价迁移）', () => {
  it('U9: 首屏渲染——DOM 含问题文本 + 选项列表', () => {
    const wrapper = mountOverlay({ questions: [singleSelectQ] })

    // 问题文本存在（单问标题在 head 行）
    expect(wrapper.find('[data-testid="form-question-text"]').text()).toContain('选哪个数据库?')
    // 选项存在（testid 由 label 派生）
    expect(wrapper.find('[data-testid="form-option-Postgres"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="form-option-MySQL"]').exists()).toBe(true)
    // Submit 按钮存在
    expect(wrapper.find('[data-testid="form-submit"]').exists()).toBe(true)
  })

  it('U13: Cancel → emit cancel 事件', async () => {
    const wrapper = mountOverlay({ questions: [singleSelectQ], allowCancel: true })

    await wrapper.find('[data-testid="form-cancel"]').trigger('click')
    expect(wrapper.emitted('cancel')).toHaveLength(1)
  })

  it('U9 补充: 多问题 tab 切换', async () => {
    const wrapper = mountOverlay({ questions: [singleSelectQ, multiSelectQ] })

    // 初始显示第一个问题（多问题用 question-text-multi）
    expect(wrapper.find('[data-testid="form-question-text-multi"]').text()).toContain('选哪个数据库?')
    // tab 存在
    expect(wrapper.find('[data-testid="form-tab-1"]').exists()).toBe(true)
    // 切换到第二个
    await wrapper.find('[data-testid="form-tab-1"]').trigger('click')
    expect(wrapper.find('[data-testid="form-question-text-multi"]').text()).toContain('选哪些语言?')
  })

  it('U14: 单选自动前进——选完第一题后 activeIdx 前进到第二题', async () => {
    const wrapper = mountOverlay({ questions: [singleSelectQ, multiSelectQ] })

    expect(wrapper.find('[data-testid="form-question-text-multi"]').text()).toContain('选哪个数据库?')
    await wrapper.find('[data-testid="form-option-Postgres"]').trigger('click')
    // 应自动前进到第二题
    expect(wrapper.find('[data-testid="form-question-text-multi"]').text()).toContain('选哪些语言?')
  })

  it('U15: 单选最后一题不自动前进（末题显示 Submit，见 U16 互斥分支）', async () => {
    const wrapper = mountOverlay({ questions: [singleSelectQ] })

    await wrapper.find('[data-testid="form-option-Postgres"]').trigger('click')
    // 仍然显示同一题
    expect(wrapper.find('[data-testid="form-question-text"]').text()).toContain('选哪个数据库?')
  })

  it('U16: 非最后一题显示"下一题"按钮，最后一题显示"提交"', async () => {
    const wrapper = mountOverlay({ questions: [singleSelectQ, multiSelectQ] })

    // 初始在第一题（非最后）→ 显示"下一题"，当前题未答 → disabled
    const nextBtn = wrapper.find('[data-testid="form-next"]')
    expect(nextBtn.exists()).toBe(true)
    expect(nextBtn.attributes('disabled')).toBeDefined()
    expect(wrapper.find('[data-testid="form-submit"]').exists()).toBe(false)

    // 答第一题后 auto-advance 到第二题（最后一题）→ 显示"提交"
    await wrapper.find('[data-testid="form-option-Postgres"]').trigger('click')
    const submit = wrapper.find('[data-testid="form-submit"]')
    expect(submit.exists()).toBe(true)
    // 第二题还没答 → 提交 disabled
    expect(submit.attributes('disabled')).toBeDefined()
    expect(submit.attributes('title')).toContain('1 题未答')
  })

  it('U17: 全答后提交 enabled', async () => {
    const wrapper = mountOverlay({ questions: [singleSelectQ, multiSelectQ] })

    await wrapper.find('[data-testid="form-option-Postgres"]').trigger('click')
    await wrapper.find('[data-testid="form-option-TypeScript"]').trigger('click')

    const submit = wrapper.find('[data-testid="form-submit"]')
    expect(submit.attributes('disabled')).toBeUndefined()
  })

  it('U18: 已答 tab 绿点——作答后 tab 显示 answered 标记', async () => {
    const wrapper = mountOverlay({ questions: [singleSelectQ, multiSelectQ] })

    expect(wrapper.find('[data-testid="form-tab-answered"]').exists()).toBe(false)
    await wrapper.find('[data-testid="form-option-Postgres"]').trigger('click')
    const tab0 = wrapper.find('[data-testid="form-tab-0"]')
    expect(tab0.find('[data-testid="form-tab-answered"]').exists()).toBe(true)
  })

  it('U19: Other 卡片化——点选 Other 展开输入框，输入文本', async () => {
    const wrapper = mountOverlay({ questions: [singleSelectQ] })

    expect(wrapper.find('[data-testid="form-other-db"]').exists()).toBe(false)
    await wrapper.find('[data-testid="form-option-__other__"]').trigger('click')
    const otherInput = wrapper.find('[data-testid="form-other-db"]')
    expect(otherInput.exists()).toBe(true)
    await otherInput.setValue('自定义数据库')
    await wrapper.find('[data-testid="form-submit"]').trigger('click')
    const answers = JSON.parse(wrapper.emitted('submit')![0][0] as string)
    // Other 文本写独立 key `${key}__other`，不写主 key
    expect(answers['db__other']).toBe('自定义数据库')
    expect(answers.db).toBeUndefined()
  })

  it('U20: Other/选项互斥——选普通选项取消 Other 选中', async () => {
    const wrapper = mountOverlay({ questions: [singleSelectQ] })

    await wrapper.find('[data-testid="form-option-__other__"]').trigger('click')
    await wrapper.find('[data-testid="form-other-db"]').setValue('自定义')
    expect(wrapper.find('[data-testid="form-other-db"]').exists()).toBe(true)
    // 选 Postgres（单选互斥）→ Other 取消选中，input 消失
    await wrapper.find('[data-testid="form-option-Postgres"]').trigger('click')
    expect(wrapper.find('[data-testid="form-other-db"]').exists()).toBe(false)
  })

  it('U21: Other 选中后自动聚焦 input', async () => {
    const wrapper = mountOverlay({ questions: [singleSelectQ] })

    await wrapper.find('[data-testid="form-option-__other__"]').trigger('click')
    await nextTick()

    const otherInput = wrapper.find('[data-testid="form-other-db"]')
    expect(otherInput.exists()).toBe(true)
    // ref focus 生效：input 获得焦点
    expect(otherInput.element).toBe(document.activeElement)
  })

  it('U22: Other input 内 enter/space 不冒泡取消选中', async () => {
    const wrapper = mountOverlay({ questions: [singleSelectQ] })

    await wrapper.find('[data-testid="form-option-__other__"]').trigger('click')
    const otherInput = wrapper.find('[data-testid="form-other-db"]')
    await otherInput.setValue('自定义答案')
    await otherInput.trigger('keydown', { key: 'Enter' })
    // Other 仍选中、input 仍存在、文本不丢
    expect(wrapper.find('[data-testid="form-other-db"]').exists()).toBe(true)
    expect(otherInput.element).toBeInstanceOf(HTMLInputElement)
    expect((otherInput.element as HTMLInputElement).value).toBe('自定义答案')
  })

  it('U23: Other input Enter 前进到下一题（多问题场景）', async () => {
    const wrapper = mountOverlay({ questions: [singleSelectQ, multiSelectQ] })

    await wrapper.find('[data-testid="form-option-__other__"]').trigger('click')
    const otherInput = wrapper.find('[data-testid="form-other-db"]')
    await otherInput.setValue('自定义数据库')
    await otherInput.trigger('keydown', { key: 'Enter' })
    expect(wrapper.find('[data-testid="form-question-text-multi"]').text()).toContain('选哪些语言?')
  })

  it('U24: "下一题"按钮点击前进到下一题', async () => {
    const wrapper = mountOverlay({ questions: [singleSelectQ, multiSelectQ] })

    await wrapper.find('[data-testid="form-option-Postgres"]').trigger('click')
    // auto-advance 到第二题了，手动切回第一题
    await wrapper.find('[data-testid="form-tab-0"]').trigger('click')
    const nextBtn = wrapper.find('[data-testid="form-next"]')
    expect(nextBtn.exists()).toBe(true)
    expect(nextBtn.attributes('disabled')).toBeUndefined() // 第一题已答 → enabled
    await nextBtn.trigger('click')
    expect(wrapper.find('[data-testid="form-question-text-multi"]').text()).toContain('选哪些语言?')
  })

  it('U25: 最后一题 Other Enter 直接提交', async () => {
    const wrapper = mountOverlay({ questions: [singleSelectQ] })

    await wrapper.find('[data-testid="form-option-__other__"]').trigger('click')
    const otherInput = wrapper.find('[data-testid="form-other-db"]')
    await otherInput.setValue('自定义数据库')
    await otherInput.trigger('keydown', { key: 'Enter' })
    const answers = JSON.parse(wrapper.emitted('submit')![0][0] as string)
    expect(answers['db__other']).toBe('自定义数据库')
  })

  it('U26: IME 组合输入中的 Enter 不提交也不前进（中文输入法拼音未确认）', async () => {
    const wrapper = mountOverlay({ questions: [singleSelectQ] })

    await wrapper.find('[data-testid="form-option-__other__"]').trigger('click')
    const otherInput = wrapper.find('[data-testid="form-other-db"]')
    await otherInput.setValue('自定义数据库')
    await otherInput.trigger('keydown', { key: 'Enter', isComposing: true })
    // 不应触发 submit、不应前进
    expect(wrapper.emitted('submit')).toBeUndefined()
    expect(wrapper.find('[data-testid="form-other-db"]').exists()).toBe(true)
  })

  it('U27: IME 组合输入中的 Enter 不前进到下一题（多问题场景）', async () => {
    const wrapper = mountOverlay({ questions: [singleSelectQ, multiSelectQ] })

    await wrapper.find('[data-testid="form-option-__other__"]').trigger('click')
    const otherInput = wrapper.find('[data-testid="form-other-db"]')
    await otherInput.setValue('自定义数据库')
    await otherInput.trigger('keydown', { key: 'Enter', isComposing: true })
    // 仍在第一题（第二题的 Other 输入框 testid 是 lang，不应出现）
    expect(wrapper.find('[data-testid="form-other-db"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="form-other-lang"]').exists()).toBe(false)
  })

  it('U28: 空 questions 数组不崩溃，显示容器但无选项', () => {
    const wrapper = mountOverlay({ questions: [] })

    expect(wrapper.exists()).toBe(true)
    expect(wrapper.find('[data-testid="form-head"]').exists()).toBe(true)
    // question-text 存在但内容为空（activeQuestion 为 undefined）
    const qText = wrapper.find('[data-testid="form-question-text"]')
    expect(qText.exists()).toBe(true)
    expect(qText.text()).toBe('')
    // 无选项（activeQuestion 为 undefined，v-if 阻止渲染）
    expect(wrapper.find('[data-testid="form-option-Postgres"]').exists()).toBe(false)
    // 无自由文本输入
    expect(wrapper.find('[data-testid="form-free-text"]').exists()).toBe(false)
  })

  it('U29: composition 结束后 Enter 正常提交（compositionend 恢复）', async () => {
    const wrapper = mountOverlay({ questions: [singleSelectQ] })

    await wrapper.find('[data-testid="form-option-__other__"]').trigger('click')
    const otherInput = wrapper.find('[data-testid="form-other-db"]')
    await otherInput.setValue('自定义答案')

    await otherInput.trigger('keydown', { key: 'Enter', isComposing: true })
    expect(wrapper.emitted('submit')).toBeUndefined()

    await otherInput.trigger('keydown', { key: 'Enter', isComposing: false })
    const submitEvents = wrapper.emitted('submit')
    expect(submitEvents).toHaveLength(1)
    const answers = JSON.parse(submitEvents![0][0] as string)
    expect(answers['db__other']).toBe('自定义答案')
  })
})

describe('FormOverlay · D1 编码契约——submit payload 5 形态（choice/text）', () => {
  it('形态 1: 单选——answers[key] = 选中项 label', async () => {
    const wrapper = mountOverlay({ questions: [singleSelectQ] })

    await wrapper.find('[data-testid="form-option-Postgres"]').trigger('click')
    await wrapper.find('[data-testid="form-submit"]').trigger('click')

    const answers = JSON.parse(wrapper.emitted('submit')![0][0] as string)
    expect(answers.db).toBe('Postgres')
    expect(answers['db__other']).toBeUndefined()
  })

  it('形态 2: 多选——answers[key] = JSON.stringify(label[])', async () => {
    const wrapper = mountOverlay({ questions: [multiSelectQ] })

    await wrapper.find('[data-testid="form-option-TypeScript"]').trigger('click')
    await wrapper.find('[data-testid="form-option-Python"]').trigger('click')
    await wrapper.find('[data-testid="form-submit"]').trigger('click')

    const answers = JSON.parse(wrapper.emitted('submit')![0][0] as string)
    expect(answers.lang).toBe('["TypeScript","Python"]')
    expect(JSON.parse(answers.lang)).toEqual(['TypeScript', 'Python'])
  })

  it('形态 3: Other + 已选选项（多选组合）——主 key 写选中项，`${key}__other` 写自由文本', async () => {
    const wrapper = mountOverlay({ questions: [multiSelectQ] })

    await wrapper.find('[data-testid="form-option-TypeScript"]').trigger('click')
    await wrapper.find('[data-testid="form-option-__other__"]').trigger('click')
    await wrapper.find('[data-testid="form-other-lang"]').setValue('自定义语言')
    await wrapper.find('[data-testid="form-submit"]').trigger('click')

    const answers = JSON.parse(wrapper.emitted('submit')![0][0] as string)
    expect(JSON.parse(answers.lang)).toEqual(['TypeScript'])
    expect(answers['lang__other']).toBe('自定义语言')
  })

  it('形态 4: text 题（无 options）——只写 `${key}__other`，不写主 key', async () => {
    const wrapper = mountOverlay({ questions: [freeTextQ] })

    await wrapper.find('[data-testid="form-free-text"]').setValue('需要加索引')
    await wrapper.find('[data-testid="form-submit"]').trigger('click')

    const answers = JSON.parse(wrapper.emitted('submit')![0][0] as string)
    expect(answers['note__other']).toBe('需要加索引')
    expect(answers.note).toBeUndefined()
  })

  it('形态 5: 全部未答（空表单）——payload 为 {}', async () => {
    const wrapper = mountOverlay({ questions: [] })

    // 空 questions：allAnswered 恒真 → Submit enabled
    const submit = wrapper.find('[data-testid="form-submit"]')
    expect(submit.attributes('disabled')).toBeUndefined()
    await submit.trigger('click')

    expect(wrapper.emitted('submit')).toHaveLength(1)
    const answers = JSON.parse(wrapper.emitted('submit')![0][0] as string)
    expect(answers).toEqual({})
  })
})

describe('FormOverlay · schedule 渲染器与 Submit 门委托', () => {
  it('schedule 单问：渲染整表单体，预填草稿打开即可一键确认（Submit 立即可点）', async () => {
    const wrapper = mountOverlay({ questions: [scheduleQ] })
    // canSubmit 委托链（渲染器挂载 → shallowReactive map 登记）需一个 microtask flush
    await nextTick()

    // 表单体渲染（schedule 渲染器整表单：prompt 预填 + 模型候选）
    expect(wrapper.find('[data-testid="schedule-create-prompt"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="schedule-create-model-m-1"]').exists()).toBe(true)
    // 单问无 tab 条
    expect(wrapper.find('[data-testid="form-tab-0"]').exists()).toBe(false)
    // Submit 门 = 渲染器 canSubmit 委托：预填草稿有效 → 立即 enabled（一键确认路径）
    const submit = wrapper.find('[data-testid="form-submit"]')
    expect(submit.attributes('disabled')).toBeUndefined()

    await submit.trigger('click')
    // envelope：恰一键，value = JSON.stringify(ScheduleFormResult)（D2）
    const payload = JSON.parse(wrapper.emitted('submit')![0][0] as string)
    const keys = Object.keys(payload)
    expect(keys).toEqual(['task'])
    expect(JSON.parse(payload.task)).toMatchObject({
      action: 'create',
      kind: 'recurring',
      schedule: '0 9 * * *',
      prompt: '总结昨天的工作进展',
      model: 'm-1',
    })
  })

  it('schedule 缺 prompt 的草稿 → Submit 门关闭，补全后开启', async () => {
    const wrapper = mountOverlay({
      questions: [{ type: 'schedule', question: '确认创建定时任务', initial: { ...scheduleDraft, prompt: '' } }],
    })
    await nextTick()

    const submit = wrapper.find('[data-testid="form-submit"]')
    expect(submit.attributes('disabled')).toBeDefined()
    // 表单体摘要行提示未补全（用户可见反馈）
    expect(wrapper.find('[data-testid="schedule-create-foot-note"]').text()).toContain('请补全时间与提示词')

    await wrapper.find('[data-testid="schedule-create-prompt"]').setValue('手动补全提示词')
    expect(submit.attributes('disabled')).toBeUndefined()
  })

  it('choice + schedule 混合表单：Submit 门 = allAnswered(choice) ∧ canSubmit(schedule)', async () => {
    const wrapper = mountOverlay({ questions: [singleSelectQ, scheduleQ] })

    // 初始在第一题（choice 未答）→ 下一题 disabled
    expect(wrapper.find('[data-testid="form-next"]').attributes('disabled')).toBeDefined()
    await wrapper.find('[data-testid="form-option-Postgres"]').trigger('click')
    // auto-advance 到 schedule 题 → Submit enabled（choice 已答 + schedule 预填有效）
    const submit = wrapper.find('[data-testid="form-submit"]')
    expect(submit.attributes('disabled')).toBeUndefined()

    await submit.trigger('click')
    const payload = JSON.parse(wrapper.emitted('submit')![0][0] as string)
    expect(payload.db).toBe('Postgres')
    expect(JSON.parse(payload.task)).toMatchObject({ action: 'create', kind: 'recurring' })
  })

  it('schedule 切 tab 状态不丢（渲染器常挂 v-show，choice 答后切回仍可提交）', async () => {
    const wrapper = mountOverlay({ questions: [singleSelectQ, scheduleQ] })

    // 先到 schedule 题，改 prompt（用户编辑）
    await wrapper.find('[data-testid="form-option-Postgres"]').trigger('click') // auto-advance → schedule
    await wrapper.find('[data-testid="schedule-create-prompt"]').setValue('编辑后的提示词')
    // 切回第一题再切回 schedule 题
    await wrapper.find('[data-testid="form-tab-0"]').trigger('click')
    expect(wrapper.find('[data-testid="schedule-create-prompt"]').isVisible()).toBe(false)
    await wrapper.find('[data-testid="form-tab-1"]').trigger('click')
    // 编辑内容保留（v-show 常挂不重置）
    expect((wrapper.find('[data-testid="schedule-create-prompt"]').element as HTMLTextAreaElement).value).toBe('编辑后的提示词')
    // 提交取编辑后的值
    await wrapper.find('[data-testid="form-submit"]').trigger('click')
    const payload = JSON.parse(wrapper.emitted('submit')![0][0] as string)
    expect(JSON.parse(payload.task).prompt).toBe('编辑后的提示词')
  })

  it('schedule once 时刻停留至过期后点击提交 → 提交瞬间复核拦截（整表中止，无 emit）', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2030, 0, 1, 9, 0, 0, 0))
    try {
      const onceQ: ScheduleQuestion = {
        type: 'schedule',
        header: 'task',
        question: '确认创建定时任务',
        // 周域非 * → onceCronToDate 还原失败 → 默认下一整点（10:00），再手输 09:05
        initial: { ...scheduleDraft, kind: 'once', schedule: '0 9 * * MON' },
      }
      const wrapper = mountOverlay({ questions: [onceQ] })
      await wrapper.find('[data-testid="schedule-create-kind-once"]').trigger('click')
      await wrapper.find('[data-testid="schedule-create-once-input"]').setValue('2030-01-01T09:05')
      await nextTick()
      expect(wrapper.find('[data-testid="form-submit"]').attributes('disabled')).toBeUndefined()

      // 时间流逝到 09:06（时刻已过）：无交互 → canSubmit 缓存仍 true（按钮亮），
      // 点击后由 submit() 的提交瞬间复核（刷新表单时钟）拦截——整表中止
      vi.setSystemTime(new Date(2030, 0, 1, 9, 6, 0, 0))
      await wrapper.find('[data-testid="form-submit"]').trigger('click')
      expect(wrapper.emitted('submit')).toBeUndefined()

      // 复核刷新驱动重渲染：按钮转禁用、预览区已过警示
      await nextTick()
      expect(wrapper.find('[data-testid="form-submit"]').attributes('disabled')).toBeDefined()
      expect(wrapper.find('[data-testid="schedule-create-preview"]').text()).toContain('所选时间已过')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('FormOverlay · legacy draft 直挂（D7 上三角窗口挂载源分流）', () => {
  it('draft 直挂：无 tab 无标题，Submit 立即可点，应答 = 扁平 ScheduleFormResult JSON', async () => {
    const wrapper = mountOverlay({ draft: scheduleDraft })
    await nextTick()

    // 壳根 testid 统一（schedule-create-overlay → form-overlay 正名）
    expect(wrapper.find('[data-testid="form-overlay"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="form-tab-0"]').exists()).toBe(false)
    // 表单体渲染 + 预填（模型候选来自 draft）
    expect(wrapper.find('[data-testid="schedule-create-model-m-2"]').exists()).toBe(true)

    const submit = wrapper.find('[data-testid="form-submit"]')
    expect(submit.attributes('disabled')).toBeUndefined()
    await submit.trigger('click')

    // 扁平回包（非 envelope——今日 Panel onScheduleCreateSubmit 路径等价）
    expect(wrapper.emitted('submit')).toHaveLength(1)
    const parsed = JSON.parse(wrapper.emitted('submit')![0][0] as string)
    expect(parsed).toMatchObject({ action: 'create', kind: 'recurring', schedule: '0 9 * * *', prompt: '总结昨天的工作进展' })
    expect(parsed.task).toBeUndefined()
  })

  it('draft 直挂：取消按钮与渲染器级 Esc 均 emit cancel', async () => {
    const wrapper = mountOverlay({ draft: scheduleDraft })

    await wrapper.find('[data-testid="form-cancel"]').trigger('click')
    expect(wrapper.emitted('cancel')).toHaveLength(1)

    // Esc = 渲染器级键位（D5 壳层裁决保留）：事件冒泡到 ScheduleForm 根
    await wrapper.find('[data-testid="schedule-create-preview"]').trigger('keydown', { key: 'Escape' })
    expect(wrapper.emitted('cancel')).toHaveLength(2)
  })

  it('draft 直挂：once 已过时刻 → Submit 门关闭（canSubmit 委托）', async () => {
    const wrapper = mountOverlay({
      draft: { ...scheduleDraft, kind: 'once', schedule: '0 9 * * MON' },
    })
    await nextTick()

    // 还原失败退默认下一整点 → 可提交；手输过去时刻 → 门关
    const submit = wrapper.find('[data-testid="form-submit"]')
    expect(submit.attributes('disabled')).toBeUndefined()
    await wrapper.find('[data-testid="schedule-create-kind-once"]').trigger('click')
    await wrapper.find('[data-testid="schedule-create-once-input"]').setValue('2020-01-01T09:00')
    await nextTick()
    expect(submit.attributes('disabled')).toBeDefined()
    expect(wrapper.find('[data-testid="schedule-create-preview"]').text()).toContain('所选时间已过')
  })
})
