/**
 * AskUserOverlay 测试（W3: U9-U13 + D1 编码契约）。
 *
 * 验证 ask-user 富交互组件的渲染和交互：
 * - U9: 首屏渲染（问题文本 + 选项列表存在于 DOM）
 * - U10: 单选交互（点击 → Submit → answers 包含 label）
 * - U11: 多选交互（点击多个 → Submit → answers 含 JSON.stringify(label[])）
 * - U12: 纯自由文本（无 options → Textarea → 答案写 `${key}__other`）
 * - U13: Cancel 取消
 * - D1 编码契约 5 形态：单选 label / 多选 JSON / Other+selected / 纯自由文本仅 __other / 全部未答 {}
 *
 * answers 编码契约（对齐 @xyz-agent/extension-protocol types.ts + AskUserOverlay.vue onSubmit）：
 * - 单选：value = 选中项 label（proto 无独立 value 字段，D1 后 label 即选中值）
 * - 多选：value = JSON.stringify(label[])
 * - Other 自由文本：独立 key `${key}__other`（不混进选中值数组）
 * - 无选项纯自由文本：只写 `${key}__other`，不写主 key
 * - 未答的问题：不写 key；全部未答（空表单）→ `{}`
 * - comment 已随 D2 删除：无 `${key}__comment`，无 comment UI
 *
 * 运行：pnpm --filter @xyz-agent/frontend run test -- src/__tests__/components/AskUserOverlay.test.ts
 */
import { describe, it, expect } from 'vitest'
import { nextTick } from 'vue'
import { mount } from '@vue/test-utils'
import AskUserOverlay from '@/components/extension/ask-user/AskUserOverlay.vue'
import type { AskUserQuestion } from '@xyz-agent/extension-protocol'

// 带描述的选项（验证 opt-desc 字号）
const optWithDescQ: AskUserQuestion = {
  header: 'db',
  question: '使用哪种数据库?',
  options: [
    { label: 'PostgreSQL', description: '生产环境主流' },
    { label: 'MySQL', description: '兼容性广' },
  ],
}

// ── 测试数据 ──
const singleSelectQ: AskUserQuestion = {
  header: 'db',
  question: '选哪个数据库?',
  options: [
    { label: 'Postgres' },
    { label: 'MySQL' },
  ],
}

const multiSelectQ: AskUserQuestion = {
  header: 'lang',
  question: '选哪些语言?',
  multiSelect: true,
  options: [
    { label: 'TypeScript' },
    { label: 'Python' },
    { label: 'Rust' },
  ],
}

const freeTextQ: AskUserQuestion = {
  header: 'note',
  question: '补充说明',
}

function mountOverlay(questions: AskUserQuestion[], allowCancel = true) {
  return mount(AskUserOverlay, {
    props: { questions, allowCancel },
    attachTo: document.body,
  })
}

describe('AskUserOverlay', () => {
  it('U9: 首屏渲染——DOM 含问题文本 + 选项列表', () => {
    const wrapper = mountOverlay([singleSelectQ])

    // 问题文本存在
    expect(wrapper.find('[data-testid="ask-user-question-text"]').text()).toContain('选哪个数据库?')
    // 选项存在（testid 由 label 派生，proto 无独立 value 字段）
    expect(wrapper.find('[data-testid="ask-user-option-Postgres"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="ask-user-option-MySQL"]').exists()).toBe(true)
    // Submit 按钮存在
    expect(wrapper.find('[data-testid="ask-user-submit"]').exists()).toBe(true)
  })

  it('U13: Cancel → emit cancel 事件', async () => {
    const wrapper = mountOverlay([singleSelectQ], true)

    await wrapper.find('[data-testid="ask-user-cancel"]').trigger('click')
    expect(wrapper.emitted('cancel')).toHaveLength(1)
  })

  it('U9 补充: 多问题 tab 切换', async () => {
    const wrapper = mountOverlay([singleSelectQ, multiSelectQ])

    // 初始显示第一个问题（多问题用 question-text-multi）
    expect(wrapper.find('[data-testid="ask-user-question-text-multi"]').text()).toContain('选哪个数据库?')
    // tab 存在
    expect(wrapper.find('[data-testid="ask-user-tab-1"]').exists()).toBe(true)
    // 切换到第二个
    await wrapper.find('[data-testid="ask-user-tab-1"]').trigger('click')
    expect(wrapper.find('[data-testid="ask-user-question-text-multi"]').text()).toContain('选哪些语言?')
  })

  it('U14: 单选自动前进——选完第一题后 activeIdx 前进到第二题', async () => {
    const wrapper = mountOverlay([singleSelectQ, multiSelectQ])

    // 初始显示第一题
    expect(wrapper.find('[data-testid="ask-user-question-text-multi"]').text()).toContain('选哪个数据库?')
    // 选中第一题的 Postgres（单选）
    await wrapper.find('[data-testid="ask-user-option-Postgres"]').trigger('click')
    // 应自动前进到第二题
    expect(wrapper.find('[data-testid="ask-user-question-text-multi"]').text()).toContain('选哪些语言?')
  })

  it('U15: 单选最后一题不自动前进（Submit 常驻 action bar）', async () => {
    const wrapper = mountOverlay([singleSelectQ])

    // 只有一题，选中后不应前进（无处可去）
    await wrapper.find('[data-testid="ask-user-option-Postgres"]').trigger('click')
    // 仍然显示同一题
    expect(wrapper.find('[data-testid="ask-user-question-text"]').text()).toContain('选哪个数据库?')
  })

  it('U16: 非最后一题显示"下一题"按钮，最后一题显示"提交"', async () => {
    const wrapper = mountOverlay([singleSelectQ, multiSelectQ])

    // 初始在第一题（非最后）→ 显示"下一题"，当前题未答 → disabled
    const nextBtn = wrapper.find('[data-testid="ask-user-next"]')
    expect(nextBtn.exists()).toBe(true)
    expect(nextBtn.attributes('disabled')).toBeDefined()
    expect(wrapper.find('[data-testid="ask-user-submit"]').exists()).toBe(false)

    // 答第一题后 auto-advance 到第二题（最后一题）→ 显示"提交"
    await wrapper.find('[data-testid="ask-user-option-Postgres"]').trigger('click')
    const submit = wrapper.find('[data-testid="ask-user-submit"]')
    expect(submit.exists()).toBe(true)
    // 第二题还没答 → 提交 disabled
    expect(submit.attributes('disabled')).toBeDefined()
    expect(submit.attributes('title')).toContain('1 题未答')
  })

  it('U17: 全答后提交 enabled', async () => {
    const wrapper = mountOverlay([singleSelectQ, multiSelectQ])

    // 答第一题（单选，auto-advance 到第二题）
    await wrapper.find('[data-testid="ask-user-option-Postgres"]').trigger('click')
    // 答第二题（多选）
    await wrapper.find('[data-testid="ask-user-option-TypeScript"]').trigger('click')

    const submit = wrapper.find('[data-testid="ask-user-submit"]')
    expect(submit.attributes('disabled')).toBeUndefined()
  })

  it('U18: 已答 tab 绿点——作答后 tab 显示 answered 标记', async () => {
    const wrapper = mountOverlay([singleSelectQ, multiSelectQ])

    // 初始无绿点
    expect(wrapper.find('[data-testid="ask-user-tab-answered"]').exists()).toBe(false)
    // 答第一题（单选 auto-advance）
    await wrapper.find('[data-testid="ask-user-option-Postgres"]').trigger('click')
    // tab-0 应有已答绿点
    const tab0 = wrapper.find('[data-testid="ask-user-tab-0"]')
    expect(tab0.find('[data-testid="ask-user-tab-answered"]').exists()).toBe(true)
  })

  it('U19: Other 卡片化——点选 Other 展开输入框，输入文本', async () => {
    const wrapper = mountOverlay([singleSelectQ])

    // 初始 Other input 不显示（未选中）
    expect(wrapper.find('[data-testid="ask-user-other-db"]').exists()).toBe(false)
    // 点选 Other 卡片
    await wrapper.find('[data-testid="ask-user-option-__other__"]').trigger('click')
    // Other input 展开
    const otherInput = wrapper.find('[data-testid="ask-user-other-db"]')
    expect(otherInput.exists()).toBe(true)
    // 输入文本
    await otherInput.setValue('自定义数据库')
    // 提交
    await wrapper.find('[data-testid="ask-user-submit"]').trigger('click')
    const answers = JSON.parse(wrapper.emitted('submit')![0][0] as string)
    // Other 文本写独立 key `${key}__other`，不写主 key
    expect(answers['db__other']).toBe('自定义数据库')
    expect(answers.db).toBeUndefined()
  })

  it('U20: Other/选项互斥——选普通选项取消 Other 选中', async () => {
    const wrapper = mountOverlay([singleSelectQ])

    // 先选 Other 卡片
    await wrapper.find('[data-testid="ask-user-option-__other__"]').trigger('click')
    // 输入文本
    await wrapper.find('[data-testid="ask-user-other-db"]').setValue('自定义')
    // Other input 存在
    expect(wrapper.find('[data-testid="ask-user-other-db"]').exists()).toBe(true)
    // 选 Postgres（单选互斥）→ Other 取消选中，input 消失
    await wrapper.find('[data-testid="ask-user-option-Postgres"]').trigger('click')
    expect(wrapper.find('[data-testid="ask-user-other-db"]').exists()).toBe(false)
  })

  it('U21: Other 选中后自动聚焦 input', async () => {
    const wrapper = mountOverlay([singleSelectQ])

    // 点选 Other 卡片
    await wrapper.find('[data-testid="ask-user-option-__other__"]').trigger('click')
    await nextTick()

    // input 应存在
    const otherInput = wrapper.find('[data-testid="ask-user-other-db"]')
    expect(otherInput.exists()).toBe(true)
    // ref focus 生效：input 获得焦点
    expect(otherInput.element).toBe(document.activeElement)
  })

  it('U22: Other input 内 enter/space 不冒泡取消选中', async () => {
    const wrapper = mountOverlay([singleSelectQ])

    // 点选 Other + 输入文本
    await wrapper.find('[data-testid="ask-user-option-__other__"]').trigger('click')
    const otherInput = wrapper.find('[data-testid="ask-user-other-db"]')
    await otherInput.setValue('自定义答案')
    // input 内按 enter
    await otherInput.trigger('keydown', { key: 'Enter' })
    // Other 仍选中、input 仍存在、文本不丢
    expect(wrapper.find('[data-testid="ask-user-other-db"]').exists()).toBe(true)
    expect(otherInput.element.value).toBe('自定义答案')
  })

  it('U23: Other input Enter 前进到下一题（多问题场景）', async () => {
    const wrapper = mountOverlay([singleSelectQ, multiSelectQ])

    // 选第一题的 Other
    await wrapper.find('[data-testid="ask-user-option-__other__"]').trigger('click')
    const otherInput = wrapper.find('[data-testid="ask-user-other-db"]')
    await otherInput.setValue('自定义数据库')
    // Enter 前进到第二题
    await otherInput.trigger('keydown', { key: 'Enter' })
    // 切到了第二题
    expect(wrapper.find('[data-testid="ask-user-question-text-multi"]').text()).toContain('选哪些语言?')
  })

  it('U24: "下一题"按钮点击前进到下一题', async () => {
    const wrapper = mountOverlay([singleSelectQ, multiSelectQ])

    // 答第一题（单选 auto-advance 到第二题），但手动测"下一题"按钮——先回到第一题
    await wrapper.find('[data-testid="ask-user-option-Postgres"]').trigger('click')
    // auto-advance 到第二题了，手动切回第一题
    await wrapper.find('[data-testid="ask-user-tab-0"]').trigger('click')
    // 此时在第一题（已答），显示"下一题"按钮
    const nextBtn = wrapper.find('[data-testid="ask-user-next"]')
    expect(nextBtn.exists()).toBe(true)
    expect(nextBtn.attributes('disabled')).toBeUndefined() // 第一题已答 → enabled
    // 点击前进
    await nextBtn.trigger('click')
    expect(wrapper.find('[data-testid="ask-user-question-text-multi"]').text()).toContain('选哪些语言?')
  })

  it('U25: 最后一题 Other Enter 直接提交', async () => {
    const wrapper = mountOverlay([singleSelectQ])

    // 选 Other + 输入文本
    await wrapper.find('[data-testid="ask-user-option-__other__"]').trigger('click')
    const otherInput = wrapper.find('[data-testid="ask-user-other-db"]')
    await otherInput.setValue('自定义数据库')
    // Enter 直接提交（最后一题 + allAnswered）
    await otherInput.trigger('keydown', { key: 'Enter' })
    const answers = JSON.parse(wrapper.emitted('submit')![0][0] as string)
    expect(answers['db__other']).toBe('自定义数据库')
  })

  it('U26: IME 组合输入中的 Enter 不提交也不前进（中文输入法拼音未确认）', async () => {
    // 复现：中文输入法打拼音还没确认候选词时按 Enter，应交给浏览器确认候选词，
    // 而不是触发 onOtherEnter 的提交/前进。对应 Composer.vue:369 的 isComposing 守护。
    const wrapper = mountOverlay([singleSelectQ])

    await wrapper.find('[data-testid="ask-user-option-__other__"]').trigger('click')
    const otherInput = wrapper.find('[data-testid="ask-user-other-db"]')
    await otherInput.setValue('自定义数据库')
    // 模拟 IME composition 中按 Enter（isComposing: true）
    await otherInput.trigger('keydown', { key: 'Enter', isComposing: true })
    // 不应触发 submit、不应前进
    expect(wrapper.emitted('submit')).toBeUndefined()
    expect(wrapper.find('[data-testid="ask-user-other-db"]').exists()).toBe(true)
  })

  it('U28: 空 questions 数组不崩溃，显示容器但无选项', () => {
    // 边界：questions=[] 时组件不抛异常，head 容器存在但无选项可渲染
    // questions.length=0 满足 <=1 条件，ask-user-question-text 仍渲染（空文本）
    // 但 activeQuestion 为 undefined，v-if="activeQuestion" 阻止选项渲染
    const wrapper = mountOverlay([])
    // 不抛异常即通过（mount 成功）
    expect(wrapper.exists()).toBe(true)
    // head 容器存在
    expect(wrapper.find('[data-testid="ask-user-head"]').exists()).toBe(true)
    // question-text 存在但内容为空（activeQuestion 为 undefined）
    const qText = wrapper.find('[data-testid="ask-user-question-text"]')
    expect(qText.exists()).toBe(true)
    expect(qText.text()).toBe('')
    // 无选项（activeQuestion 为 undefined，v-if 阻止渲染）
    expect(wrapper.find('[data-testid="ask-user-option-Postgres"]').exists()).toBe(false)
    // 无 Other 输入框
    expect(wrapper.find('[data-testid="ask-user-free-text"]').exists()).toBe(false)
  })

  it('U29: composition 结束后 Enter 正常提交（compositionend 恢复）', async () => {
    // U26 只测了守卫生效（composition 中不提交），本用例测解除后恢复正常。
    // 流程：compositionstart → Enter（不提交）→ compositionend → Enter（应提交）
    const wrapper = mountOverlay([singleSelectQ])

    await wrapper.find('[data-testid="ask-user-option-__other__"]').trigger('click')
    const otherInput = wrapper.find('[data-testid="ask-user-other-db"]')
    await otherInput.setValue('自定义答案')

    // composition 中 Enter → 不提交
    await otherInput.trigger('keydown', { key: 'Enter', isComposing: true })
    expect(wrapper.emitted('submit')).toBeUndefined()

    // composition 结束后 Enter → 正常提交
    await otherInput.trigger('keydown', { key: 'Enter', isComposing: false })
    const submitEvents = wrapper.emitted('submit')
    expect(submitEvents).toHaveLength(1)
    const answers = JSON.parse(submitEvents![0][0] as string)
    expect(answers['db__other']).toBe('自定义答案')
  })

  it('U27: IME 组合输入中的 Enter 不前进到下一题（多问题场景）', async () => {
    const wrapper = mountOverlay([singleSelectQ, multiSelectQ])

    await wrapper.find('[data-testid="ask-user-option-__other__"]').trigger('click')
    const otherInput = wrapper.find('[data-testid="ask-user-other-db"]')
    await otherInput.setValue('自定义数据库')
    // composition 中 Enter —— 不前进
    await otherInput.trigger('keydown', { key: 'Enter', isComposing: true })
    // 仍在第一题（第二题的 Other 输入框 testid 是 lang，不应出现）
    expect(wrapper.find('[data-testid="ask-user-other-db"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="ask-user-other-lang"]').exists()).toBe(false)
  })
})

describe('AskUserOverlay · D1 编码契约——submit payload 5 形态', () => {
  it('形态 1: 单选——answers[key] = 选中项 label', async () => {
    const wrapper = mountOverlay([singleSelectQ])

    await wrapper.find('[data-testid="ask-user-option-Postgres"]').trigger('click')
    await wrapper.find('[data-testid="ask-user-submit"]').trigger('click')

    const answers = JSON.parse(wrapper.emitted('submit')![0][0] as string)
    expect(answers.db).toBe('Postgres')
    // Other 未输入 → 无 __other key
    expect(answers['db__other']).toBeUndefined()
  })

  it('形态 2: 多选——answers[key] = JSON.stringify(label[])', async () => {
    const wrapper = mountOverlay([multiSelectQ])

    await wrapper.find('[data-testid="ask-user-option-TypeScript"]').trigger('click')
    await wrapper.find('[data-testid="ask-user-option-Python"]').trigger('click')
    await wrapper.find('[data-testid="ask-user-submit"]').trigger('click')

    const answers = JSON.parse(wrapper.emitted('submit')![0][0] as string)
    expect(answers.lang).toBe('["TypeScript","Python"]')
    expect(JSON.parse(answers.lang)).toEqual(['TypeScript', 'Python'])
  })

  it('形态 3: Other + 已选选项（多选组合）——主 key 写选中项，`${key}__other` 写自由文本', async () => {
    const wrapper = mountOverlay([multiSelectQ])

    // 选 TypeScript + Other，填自由文本
    await wrapper.find('[data-testid="ask-user-option-TypeScript"]').trigger('click')
    await wrapper.find('[data-testid="ask-user-option-__other__"]').trigger('click')
    await wrapper.find('[data-testid="ask-user-other-lang"]').setValue('自定义语言')
    await wrapper.find('[data-testid="ask-user-submit"]').trigger('click')

    const answers = JSON.parse(wrapper.emitted('submit')![0][0] as string)
    // 主 key 只含真实选项 label（过滤 __other__ 占位符）
    expect(JSON.parse(answers.lang)).toEqual(['TypeScript'])
    // Other 文本独立 key
    expect(answers['lang__other']).toBe('自定义语言')
  })

  it('形态 4: 纯自由文本（无 options）——只写 `${key}__other`，不写主 key', async () => {
    const wrapper = mountOverlay([freeTextQ])

    await wrapper.find('[data-testid="ask-user-free-text"]').setValue('需要加索引')
    await wrapper.find('[data-testid="ask-user-submit"]').trigger('click')

    const answers = JSON.parse(wrapper.emitted('submit')![0][0] as string)
    expect(answers['note__other']).toBe('需要加索引')
    expect(answers.note).toBeUndefined()
  })

  it('形态 5: 全部未答（空表单）——payload 为 {}', async () => {
    const wrapper = mountOverlay([])

    // 空 questions：allAnswered 恒真 → Submit enabled
    const submit = wrapper.find('[data-testid="ask-user-submit"]')
    expect(submit.attributes('disabled')).toBeUndefined()
    await submit.trigger('click')

    // 无问题可答 → 空 answers 对象
    expect(wrapper.emitted('submit')).toHaveLength(1)
    const answers = JSON.parse(wrapper.emitted('submit')![0][0] as string)
    expect(answers).toEqual({})
  })
})
