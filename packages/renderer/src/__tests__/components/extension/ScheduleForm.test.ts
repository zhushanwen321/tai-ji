// @vitest-environment happy-dom
/**
 * 组件杂簇单文件合并（round5-d 分区 4 簇 4-1）。
 *
 * 为什么单文件：vitest 按测试文件隔离模块图——本簇 7 个文件共同装载
 * lucide-vue / reka-ui-slim / vue / shared / zh-CN locale 等重模块，单文件
 * 共享一份装载；拆文件会让每个文件各付一次全树装载（每份秒级 CPU）。
 *
 * 来源文件（describe/it 块原样搬运，测试名零改动）：
 *  - extension/ScheduleForm.test.ts（ScheduleForm 表单行为保真，本文件主体）
 *  - extension/DateTimePicker.test.ts（once 时刻选择器）
 *  - FileView.test.ts（W15 过滤防抖；其 vi.mock('@/api')/('virtua/vue')/
 *    ('useSideDrawer') 提升为文件级——已静态核实其余各节组件树不触及这三个模块）
 *  - Turn.folded-notice.test.ts（收纳完成通知编排）
 *  - Turn.unconfirmed-terminal.test.ts（断连未确认终局呈现）
 *  - select-content.test.ts（SelectContent fallthrough attrs）
 *  - hover-card-content.test.ts（HoverCardContent fallthrough attrs）
 *
 * 环境注：LoadMoreErrorBar.test.ts（@vitest-environment jsdom）与本簇
 * happy-dom 环境异类，不并入（保持原文件原样）。
 *
 * 冲突处理（试点模式）：
 *  - FileView 顶层 beforeEach/afterEach（幂等重置：pinia 重建 + clearAllMocks +
 *    clearAllTimers/useRealTimers）提升为文件级公共 hook；Turn.unconfirmed 的
 *    顶层 setActivePinia 被公共 hook 覆盖（等价语义）
 *  - Turn 两文件同名的模块级 helper（makeTurn/mountTurn，签名不同构）与
 *    select/hover 两文件的模块级 wrapper 变量，各自下沉到该来源文件的
 *    describe 节内（作用域与原文件顶层等价，不泄漏到其他节）
 *  - MessageTurn 类型双来源（@taiji/core/domain/chat 与
 *    @/composables/logic/messageTurns）经核实为同一 re-export，统一取
 *    @taiji/core/domain/chat
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/components/extension/ScheduleForm.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, shallowMount, flushPromises, DOMWrapper, type VueWrapper } from '@vue/test-utils'
import { nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { SelectRoot, SelectTrigger, HoverCardRoot, HoverCardTrigger } from 'reka-ui'
import ScheduleForm from '@/components/extension/form/ScheduleForm.vue'
import DateTimePicker from '@/components/extension/form/DateTimePicker.vue'
import FileView from '@/components/sidebar/FileView.vue'
import { useFileTreeStore } from '@/stores/fileTree'
import { SelectContent, SelectItem } from '@/components/ui/select'
import { HoverCardContent } from '@/components/ui/hover-card'
import { Turn } from '@taiji/ui'
import { mockChatProvide } from '@/__tests__/helpers/chat-view-deps'
import type { ScheduleDraft, ScheduleQuestion } from '@zhushanwen/extension-protocol'
import type { MessageTurn } from '@taiji/core/domain/chat'
import type { Message, FileNode } from '@taiji/shared'

// __APP_VERSION__ 是 vite define 注入的全局常量，vitest 下不存在，stub 之（Turn 两节共用）
vi.stubGlobal('__APP_VERSION__', '0.0.0-test')

// ── FileView 节的模块级 mock fn + vi.mock 注册（原样来自 FileView.test.ts；vi.mock 为
//    文件级作用——已静态核实其余各节组件树不 import '@/api'/'virtua/vue'/'useSideDrawer'）──

// mock @/api 门面（useFileTree 经 `import { file as fileApi, git as gitApi } from '@/api'` 依赖）
const mockFileTree = vi.fn()
const mockGitStatus = vi.fn()
vi.mock('@/api', () => ({
  project: {
    load: vi.fn().mockResolvedValue({ projects: [], activeProjectId: '' }),
    save: vi.fn().mockResolvedValue(undefined),
  },
  file: {
    tree: (...args: unknown[]) => mockFileTree(...args),
    expand: (...args: unknown[]) => vi.fn()(...args),
  },
  git: { status: (...args: unknown[]) => mockGitStatus(...args) },
}))

// [W28/D-7.2] mock virtua：Virtualizer 全量渲染 slot 项（本测试关注过滤防抖 DOM 表现，
// 不关注虚拟化窗口——虚拟化 DOM 数断言在 FileView-virtua.test.ts 用真实 Virtualizer）
vi.mock('virtua/vue', async () => {
  const { defineComponent, h } = await import('vue')
  return {
    Virtualizer: defineComponent({
      name: 'MockVirtualizer',
      props: {
        data: { type: Array, default: () => [] },
        itemSize: { type: Number, default: undefined },
        itemProps: { type: Function, default: undefined },
      },
      setup(props, { slots }) {
        return () =>
          h(
            'div',
            { 'data-testid': 'mock-virtua-list' },
            (props.data as unknown[]).map((item, index) => {
              const vnode = slots.default?.({ item, index }) ?? []
              return h('div', { key: (vnode[0] as { key?: unknown } | undefined)?.key ?? index }, vnode)
            }),
          )
      },
    }),
  }
})

// [W28/D-7.2] FileView 现在持有 useSideDrawer（onSelectRow 打开 detail 抽屉），mock 掉
vi.mock('@/composables/features/drawer/useSideDrawer', () => ({
  useSideDrawer: () => ({ open: vi.fn() }),
}))

// 公共 hook（FileView 顶层幂等重置 hook 提升为文件级；Turn.unconfirmed 顶层
// setActivePinia 为其子集，等价覆盖）
beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
})

afterEach(() => {
  // 清掉模块级防抖 timer（filterText 全局单值，防跨用例泄漏），恢复真实 timers
  vi.clearAllTimers()
  vi.useRealTimers()
})

// ══════════ 主体：ScheduleForm（原 ScheduleForm.test.ts 全部） ══════════

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
 * 真实交互链（日历点选 / 双段编辑 / 步进）在下方 DateTimePicker 节覆盖，此处
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
    // 候选列表常挂（v-show），选中指示 = 行尾对勾显隐（demo R3：弹层行不进选中范式，
    // 行无底/框/字色选中态——ModelPickerPanel 选中态已收编为对勾范式）
    const selectedCheck = fallback.find('[data-testid="schedule-create-model-m-1"] svg')
    expect(selectedCheck.classes().join(' ')).toContain('opacity-100')

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

// ══════════ 来源：extension/DateTimePicker.test.ts（once 时刻选择器） ══════════

/** 固定「今天」= 2030-06-15（周六）10:00：日历今天判定 / nextFullHour 初值全部确定 */
function freezeToday(): void {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(2030, 5, 15, 10, 0, 0, 0))
}

function mountPicker(modelValue = '') {
  // attachTo document.body：happy-dom 的 getComputedStyle 只对已连接元素解析 inline style——
  // v-show 显隐断言（isVisible）依赖它（与本文件 ScheduleForm 节同款挂载惯例）。
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

// ══════════ 来源：FileView.test.ts（W15 过滤防抖；vi.mock 已提升至文件顶部） ══════════

/** 树节点 fixture：三个文件，'a' 过滤命中 a.ts，'zzz' 全无匹配 */
const TREE_NODES: FileNode[] = [
  { path: 'a.ts', name: 'a.ts', type: 'file' },
  { path: 'b.ts', name: 'b.ts', type: 'file' },
  { path: 'foo.ts', name: 'foo.ts', type: 'file' },
]

// FileTreeRow stub：透出 row.path 供 visibleRows 内容断言（data-testid 含路径）
const FileTreeRowStub = {
  props: ['row', 'selected'],
  template: '<div :data-testid="`row-${row.path}`" />',
}

/** mount FileView 并等 loadTree 完成（真实 timers 下 flushPromises） */
async function mountView(): Promise<ReturnType<typeof mount>> {
  mockFileTree.mockResolvedValueOnce(TREE_NODES)
  mockGitStatus.mockResolvedValueOnce({
    sessionId: 's1',
    isRepo: false,
    files: [],
    stagedCount: 0,
    unstagedCount: 0,
    stats: { add: 0, del: 0 },
    hasConflict: false,
  })
  const wrapper = mount(FileView, {
    props: { sessionId: 's1' },
    global: {
      stubs: {
        FileTreeRow: FileTreeRowStub,
        ScrollArea: { template: '<div><slot /></div>' },
      },
    },
  })
  await flushPromises()
  return wrapper
}

function findFilterInput(wrapper: ReturnType<typeof mount>) {
  return wrapper.find('[data-testid="file-filter-input"]')
}

describe('FileView W15 过滤防抖（A-1 竞态回归 + A-4 DOM 表现）', () => {
  it('A-1 聚焦输入中防抖 commit 到达，输入框显示值不被拉回旧提交值', async () => {
    const wrapper = await mountView()
    const input = findFilterInput(wrapper)
    vi.useFakeTimers()

    // 聚焦（filterFocused=true，store→显示 同步被跳过）
    await input.trigger('focus')

    // 击键 'a' → 本地显示 'a'，pending 提交
    await input.setValue('a')
    // commit：store.filterText 写入 'a'，但渲染 flush 排队在微任务——
    // 紧接着用户再击键（显示领先 commit 的 prop 更新）
    vi.advanceTimersByTime(200)
    await input.setValue('ab')

    // 渲染 flush：commit 的 prop 更新与击键交错。显示值须保持击键后的 'ab'
    // （旧实现：prop 直连 store.filterText='a'，passive v-model 被覆盖回 'a'）
    await nextTick()
    expect((input.element as HTMLInputElement).value).toBe('ab')

    // 第二次 commit 后 store 提交值跟上显示值
    vi.advanceTimersByTime(200)
    expect(useFileTreeStore().filterText).toBe('ab')
  })

  it('A-4 连续输入的防抖窗口内 DOM 显示旧过滤结果，200ms 后才更新（空态切换）', async () => {
    const wrapper = await mountView()
    const input = findFilterInput(wrapper)
    vi.useFakeTimers()

    // 连续击键 'z' → 'zz' → 'zzz'（无任何匹配）
    await input.setValue('z')
    await input.setValue('zz')
    await input.setValue('zzz')

    // 防抖窗口内（199ms，未到 trailing 点）：store.filterText 仍空 →
    // DOM 显示旧（无过滤）结果：三个文件行都在、无空态
    vi.advanceTimersByTime(199)
    await nextTick()
    expect(wrapper.find('[data-testid="file-empty"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="row-a.ts"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="row-b.ts"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="row-foo.ts"]').exists()).toBe(true)

    // 到点（凑满 200ms）commit → 过滤生效：无匹配 → 空态（SearchX + 无匹配文件）
    vi.advanceTimersByTime(1)
    await nextTick()
    expect(wrapper.find('[data-testid="file-empty"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="row-a.ts"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="row-foo.ts"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="file-empty"]').text()).toContain('无匹配文件')
  })

  it('A-4 补充：命中过滤的 commit 到达后，DOM 只保留命中行', async () => {
    const wrapper = await mountView()
    const input = findFilterInput(wrapper)
    vi.useFakeTimers()

    await input.setValue('a')
    vi.advanceTimersByTime(200)
    await nextTick()

    // 'a' 命中 a.ts（不含 b.ts/foo.ts）
    expect(wrapper.find('[data-testid="row-a.ts"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="row-b.ts"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="row-foo.ts"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="file-empty"]').exists()).toBe(false)
  })

  it('[W28 审查 Fix-1] error hint 行点击 → 折叠目录（collapseNode，恢复旧递归「已展开→折叠」语义而非重试）', async () => {
    // 真实 FileTreeRow（error 行带 toggle 点击），仅 stub ScrollArea；mock virtua 全量渲染行
    mockFileTree.mockResolvedValueOnce([
      { path: 'src', name: 'src', type: 'dir', children: [{ path: 'src/a.ts', name: 'a.ts', type: 'file' }] },
    ])
    mockGitStatus.mockResolvedValueOnce({
      sessionId: 's1',
      isRepo: false,
      files: [],
      stagedCount: 0,
      unstagedCount: 0,
      stats: { add: 0, del: 0 },
      hasConflict: false,
    })
    const wrapper = mount(FileView, {
      props: { sessionId: 's1' },
      global: {
        stubs: { ScrollArea: { template: '<div><slot /></div>' } },
      },
    })
    await flushPromises()

    const store = useFileTreeStore()
    store.addExpanded('s1', 'src')
    store.setNodeState('s1', 'src', { status: 'error', reason: 'timeout' })
    await nextTick()

    // error 占位行渲染（hint 行 expanded=true 由派生视图保证）
    const errorRow = wrapper.find('[data-testid="file-tree-error-src"]')
    expect(errorRow.exists()).toBe(true)
    await errorRow.trigger('click')
    await nextTick()

    // 点击 = 折叠：FileView.onToggleRow 读 row.expanded=true → collapseNode → removeExpanded
    // （回归前 expanded=false → expandNode → error 态重新发请求，语义变重试）
    expect(store.getExpanded('s1').has('src')).toBe(false)

    wrapper.unmount()
  })
})

// ══════════ 来源：Turn.folded-notice.test.ts（收纳完成通知编排；模块级 helper
//             下沉至本 describe 节内，与 Turn.unconfirmed 节同名 helper 隔离） ══════════

describe('Turn 收纳完成通知', () => {
function assistantMsg(id: string): Message {
  return { id, role: 'assistant', content: 'done', segments: [], status: 'complete', createdAt: Date.now() } as unknown as Message
}

/** background-bash 结构化完成通知（details 经 shared 解析器命中） */
function bashDoneMsg(id: string, exitCode = 0): Message {
  return {
    id,
    role: 'system',
    content: `后台命令已完成（exit ${exitCode}）`,
    status: 'complete',
    timestamp: 0,
    details: { taskId: `task-${id}`, command: `cmd-${id}`, durationMs: 1500, endReason: 'natural', exitCode },
  } as unknown as Message
}

function makeTurn(over: Partial<MessageTurn> = {}): MessageTurn {
  return {
    index: 1,
    user: null,
    assistants: [assistantMsg('a-1')],
    isStreaming: false,
    hasFoldable: true,
    ...over,
  }
}

function mountTurn(turn: MessageTurn, opts: { expanded?: boolean; isSessionActive?: boolean; isLastTurn?: boolean } = {}) {
  return shallowMount(Turn, {
    props: {
      turn,
      sessionId: 'test-session',
      isSessionActive: opts.isSessionActive ?? false,
      isLastTurn: opts.isLastTurn ?? true,
    },
    global: {
      plugins: [createPinia()],
      provide: mockChatProvide({ isExpanded: () => opts.expanded ?? true }),
    },
  })
}

  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  it('落成态展开：明细行首行起逐条渲染（类型词 / 摘要 / exit 状态 / 任务 id），到达序保持', () => {
    const wrapper = mountTurn(makeTurn({
      foldedNotices: [bashDoneMsg('b1', 0), bashDoneMsg('b2', 2)],
    }))
    const detail = wrapper.find('[data-testid="turn-folded-notices"]')
    expect(detail.exists()).toBe(true)
    const rows = wrapper.findAll('[data-testid="turn-folded-notice-bash"]')
    expect(rows).toHaveLength(2)
    // 类型词（真实 zh 文案）+ 命令摘要 + 任务 id（用户可见 DOM 断言）
    expect(rows[0].text()).toContain('后台任务')
    expect(rows[0].text()).toContain('cmd-b1')
    expect(rows[0].text()).toContain('task-b1')
    expect(rows[1].text()).toContain('cmd-b2')
    // 状态列：exit 0（成功 dim）/ exit 2（失败 warn，不依赖 hover）
    const statuses = wrapper.findAll('[data-testid="turn-folded-notice-status"]')
    expect(statuses[0].text()).toBe('exit 0')
    expect(statuses[0].classes()).not.toContain('text-warn')
    expect(statuses[1].text()).toBe('exit 2')
    expect(statuses[1].classes()).toContain('text-warn')
  })

  it('落成态 + 明细行之后才是本轮 trace 块（明细行先行的展开区次序）', () => {
    const wrapper = mountTurn(makeTurn({ foldedNotices: [bashDoneMsg('b1')] }))
    const trace = wrapper.find('.trace')
    expect(trace.exists()).toBe(true)
    const children = trace.element.children
    expect(children.length).toBeGreaterThan(1)
    // 明细行容器是 trace 首个子元素（其后才是 TraceCompactorRow / Block）
    expect(children[0].getAttribute('data-testid')).toBe('turn-folded-notices')
  })

  it('工作态：bash 行以临时外部行渲染（inline），明细行不渲染', () => {
    const wrapper = mountTurn(makeTurn({ foldedNotices: [bashDoneMsg('b1')] }), {
      isSessionActive: true,
      isLastTurn: true,
    })
    // 临时外部行（工作态现状外部形态）
    expect(wrapper.find('[data-testid="turn-folded-notice-external"]').exists()).toBe(true)
    // 明细行只在落成态展开时渲染
    expect(wrapper.find('[data-testid="turn-folded-notices"]').exists()).toBe(false)
  })

  it('trigger 起点聚合行：工作态渲染，落成态退役（数据已收进轮头行）', () => {
    const working = mountTurn(makeTurn({ trigger: 'bg-notify' }), {
      isSessionActive: true,
      isLastTurn: true,
    })
    expect(working.find('[data-testid="turn-trigger-bgnotify"]').exists()).toBe(true)

    const settled = mountTurn(makeTurn({ trigger: 'bg-notify' }), {
      isSessionActive: false,
      isLastTurn: true,
    })
    expect(settled.find('[data-testid="turn-trigger-bgnotify"]').exists()).toBe(false)
  })
})

// ══════════ 来源：Turn.unconfirmed-terminal.test.ts（断连未确认终局呈现；模块级
//             helper 下沉至本 describe 节内，与 folded-notice 节同名 helper 隔离；
//             原顶层 beforeEach setActivePinia 由文件级公共 hook 等价覆盖） ══════════

describe('断连未确认终局呈现（渲染范围）', () => {
/** runtime onPiDisconnected 显式上报文案（session-delivery-registry 帧载荷逐字形态） */
const UNCONFIRMED_TEXT = '执行结果未确认（pi 连接已断开），重发前请核对：/todos'

/** 断连终局 error 气泡（core terminalErrorEffect 产出形态：纯 error 追加形态，content 空） */
function makeTurn(): MessageTurn {
  const errMsg: Message = {
    id: 'a-err-1',
    role: 'assistant',
    content: '',
    error: UNCONFIRMED_TEXT,
    status: 'error',
    timestamp: Date.now(),
  }
  return {
    index: 0,
    user: null,
    assistants: [errMsg],
    isStreaming: false,
    hasFoldable: false,
  }
}

function mountTurn() {
  return mount(Turn, {
    props: { turn: makeTurn(), sessionId: 's-unconfirmed' },
    global: {
      plugins: [createPinia()],
      provide: mockChatProvide(),
    },
  })
}

  it('error 气泡渲染「执行结果未确认」独立 danger 行（用户可见文案节点，非静默悬挂）', () => {
    const wrapper = mountTurn()
    // 用户可见 DOM 断言 ①：独立 error danger 行节点存在（Block.vue M2 追加形态 SSOT testid）
    const errorRow = wrapper.find('[data-testid="block-text-error"]')
    expect(errorRow.exists()).toBe(true)
    // ②：「未确认」语义文案完整可见（含恢复指引「重发前请核对」）
    expect(errorRow.text()).toContain('执行结果未确认')
    expect(errorRow.text()).toContain('重发前请核对')
    // ③：danger 色（错误视觉通道），且正文区不染 danger（错误只住 error 行，M2 形态不变量）
    expect(errorRow.classes()).toContain('text-danger')
    wrapper.unmount()
  })
})

// ══════════ 来源：select-content.test.ts（SelectContent fallthrough attrs；
//             模块级 wrapper 变量与 afterEach 下沉至本 describe 节内，
//             与 hover-card 节同名 wrapper 隔离） ══════════

describe('SelectContent fallthrough attrs（MF-1-15）', () => {
let wrapper: VueWrapper | null = null

afterEach(() => {
  // 先 unmount 再留 body 给下一用例（Teleport fragment 被 Vue 持有，禁强拆 body.innerHTML）
  wrapper?.unmount()
  wrapper = null
})

  it('消费方直挂 data-testid 落到 Teleport 后的浮层 DOM', async () => {
    wrapper = mount(
      {
        components: { SelectRoot, SelectTrigger, SelectContent, SelectItem },
        template: `
          <SelectRoot :open="true">
            <SelectTrigger aria-label="pick">trigger</SelectTrigger>
            <SelectContent data-testid="select-content-under-test">
              <SelectItem value="a">Alpha</SelectItem>
            </SelectContent>
          </SelectRoot>
        `,
      },
      { attachTo: document.body },
    )
    await wrapper.vm.$nextTick()

    const floater = document.querySelector('[data-testid="select-content-under-test"]')
    expect(floater, 'data-testid must survive the Portal boundary onto the floater DOM').toBeTruthy()
    expect(new DOMWrapper(floater!).classes()).toContain('rounded-md')
  })
})

// ══════════ 来源：hover-card-content.test.ts（HoverCardContent fallthrough attrs；
//             模块级 wrapper 变量与 afterEach 下沉至本 describe 节内，
//             与 select-content 节同名 wrapper 隔离） ══════════

describe('HoverCardContent fallthrough attrs（MF-1-15）', () => {
let wrapper: VueWrapper | null = null

afterEach(() => {
  // 先 unmount 再留 body 给下一用例（Teleport fragment 被 Vue 持有，禁强拆 body.innerHTML）
  wrapper?.unmount()
  wrapper = null
})

  it('消费方直挂 data-testid 落到 Teleport 后的浮层 DOM（GenStatsTriggers ttft 回归场景）', async () => {
    wrapper = mount(
      {
        components: { HoverCardRoot, HoverCardTrigger, HoverCardContent },
        template: `
          <HoverCardRoot :open="true">
            <HoverCardTrigger>anchor</HoverCardTrigger>
            <HoverCardContent data-testid="genstats-ttft-popover">content</HoverCardContent>
          </HoverCardRoot>
        `,
      },
      { attachTo: document.body },
    )
    await wrapper.vm.$nextTick()

    const floater = document.querySelector('[data-testid="genstats-ttft-popover"]')
    expect(floater, 'data-testid must survive the Portal boundary onto the floater DOM').toBeTruthy()
    expect(new DOMWrapper(floater!).classes()).toContain('rounded-lg')
  })
})
