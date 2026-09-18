/**
 * PlanDocsPanel 组件单测 —— plan 模式重设计 u1-docs-panel（设计 §3.1 步骤 3-5 / G2 后半 +
 * G3 / D4 降级 / D10 空态 / E2 占位）。
 *
 * 覆盖（impl-plan u1-docs-panel 验收条款）：
 * - L2 tab 渲染（多文档 tab 数、sourceSkill chip / version meta / ellipsis 截断）
 * - tab 切换渲染对应正文（file.read mock 参数带 sessionId 断言——cwd 守门契约）
 * - file.read 失败 → E2 占位错误态（条目不清，agent 可重新产出提示）
 * - 旧 schema 降级（D4）：无 docs 字段 → planFilePath 单文件（fileName 取路径末段、无 chip/version）
 * - docs 空 / 无 plan 状态 → 空态不渲染主体（D10 联动；isActive=false 且 docs 空同场景——
 *   isActive=false 但 docs 非空仍渲染，D5 终态矩阵「产物 tab 与 isActive 解耦」钉死）
 * - 划选评论草稿（quote 捕获后经 Popover emit → 草稿新增 / 删除；浮条细节归 plan-comment-popover.test.ts）
 * - 修订刷新（G3）：version bump / reviewState 离开 revising → 重新 file.read
 *
 * mock 形态照 plan-mode-banner.test.ts（command spread actual 保真实 events 通道）+
 * command-doc-panel.test.ts（file.read mock + MarkdownRenderer 按名 stub + useChatViewDeps
 * 装配器 mock）。状态驱动用 store.applyFrame（真实 WS 帧路径，不绕被测消费链）。
 * i18n 经 vitest-i18n-setup 全局 mock，t() 取 zh-CN 文案。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/components/plan-docs-panel.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import type { PlanDocMeta, PlanStateView } from '@taiji/shared'

// ── mock 边界：command 换 mock（spread actual 保留 events 真实通道——usePlanState 订阅用）──
const commandMock = vi.hoisted(() => vi.fn())
vi.mock('@taiji/core/transport/api', async (importActual) => {
  const actual = await importActual<typeof import('@taiji/core/transport/api')>()
  return { ...actual, command: commandMock, RPC_BACKSTOP_TIMEOUT_MS: 30_000 }
})

// file.read mock（照 command-doc-panel.test.ts：捕获调用参数，返回预设 content）
const readMock = vi.hoisted(() => vi.fn())
vi.mock('@taiji/core/transport/api/domains/file', () => ({
  read: vi.fn((path: string, sessionId?: string) => readMock(path, sessionId)),
}))

// MarkdownRenderer stub：ui 包 MarkdownRenderer 异步走 deps.renderMarkdown（shiki 在壳），
// 单测内按名 stub 成同步渲染 content；useChatViewDeps 装配器 mock 照 command-doc-panel.test.ts
vi.mock('@/composables/panel/useChatViewDeps', () => chatViewDepsModule())
import { chatViewDepsModule } from '@/__tests__/helpers/chat-stream-mount'
import PlanDocsPanel from '@/components/panel/plan/PlanDocsPanel.vue'
import { usePlanStore } from '@/stores/plan-store'

const SID = 'sess-docs'

const DOCS: PlanDocMeta[] = [
  { fileName: 'auth-token-renewal.design.md', absPath: '/data/A/.taiji-harness/auth/design.md', sourceSkill: 'tech-design', version: 1 },
  { fileName: 'auth-token-renewal.impl-plan.md', absPath: '/data/A/.taiji-harness/auth/impl-plan.md', sourceSkill: 'dev-flow', version: 1 },
  { fileName: 'design-review.report.md', absPath: '/data/A/.taiji-harness/auth/review.report.md', sourceSkill: '', version: 2 },
]

function viewOf(overrides: Partial<PlanStateView> = {}): PlanStateView {
  return {
    isActive: true,
    planFilePath: '/data/A/.taiji-harness/auth/plan.md',
    requirement: '重构 auth 模块',
    templateName: 'default',
    skills: ['tech-design', 'dev-flow'],
    docs: DOCS,
    ...overrides,
  }
}

async function flushAsync(): Promise<void> {
  await flushPromises()
  await nextTick()
}

/**
 * 挂载面板：首拉经 commandMock 返回 view（可覆写），file.read 由 readMock 承接。
 * PlanCommentPopover stub（浮条细节归 plan-comment-popover.test.ts；本文件经组件实例
 * emit submit 驱动草稿链，stub 保留实例供 findComponent）。
 */
async function mountPanel(view: PlanStateView): Promise<VueWrapper> {
  commandMock.mockResolvedValue({ sessionId: SID, planState: view })
  const wrapper = mount(PlanDocsPanel, {
    props: { sessionId: SID },
    global: {
      stubs: {
        MarkdownRenderer: { template: '<div class="md-stub">{{ content }}</div>', props: ['content'] },
        PlanCommentPopover: true,
      },
    },
  })
  await flushAsync()
  return wrapper
}

beforeEach(() => {
  setActivePinia(createPinia())
  commandMock.mockReset()
  readMock.mockReset()
  readMock.mockResolvedValue({ content: '# body', truncated: false })
})

describe('PlanDocsPanel L2 文档 tab 渲染', () => {
  it('多文档 → tab 数与 docs 一致；fileName / 来源技能 chip / version v{N} 逐 tab 断言', async () => {
    const wrapper = await mountPanel(viewOf())
    const tabs = wrapper.findAll('[data-testid="plan-docs-tab"]')
    expect(tabs).toHaveLength(3)
    expect(tabs[0]!.text()).toContain('auth-token-renewal.design.md')
    expect(tabs[1]!.text()).toContain('auth-token-renewal.impl-plan.md')
    // 来源技能 chip（非空 sourceSkill 才渲染）
    expect(tabs[0]!.find('[data-testid="plan-docs-tab-skill"]').text()).toBe('tech-design')
    expect(tabs[1]!.find('[data-testid="plan-docs-tab-skill"]').text()).toBe('dev-flow')
    // version meta「v{N}」
    expect(tabs[0]!.find('[data-testid="plan-docs-tab-version"]').text()).toBe('v1')
    expect(tabs[2]!.find('[data-testid="plan-docs-tab-version"]').text()).toBe('v2')
    // sourceSkill 为空（模板流程产出）→ 无 chip
    expect(tabs[2]!.find('[data-testid="plan-docs-tab-skill"]').exists()).toBe(false)
  })

  it('超长 fileName ellipsis 截断（demo 形态）：fileName span 带 truncate（text-ellipsis）类', async () => {
    const wrapper = await mountPanel(viewOf())
    const fn = wrapper.find('[data-testid="plan-docs-tab"] span')
    expect(fn.classes()).toContain('truncate')
    // 全名经 title 属性可达（截断不丢信息）
    expect(wrapper.find('[data-testid="plan-docs-tab"]').attributes('title')).toBe('auth-token-renewal.design.md')
  })
})

describe('PlanDocsPanel 空态与 isActive 解耦（D10 / D5）', () => {
  it('无 plan 状态（planState null）→ 空态提示，不渲染主体', async () => {
    commandMock.mockResolvedValue({ sessionId: SID, planState: null })
    const empty = mount(PlanDocsPanel, {
      props: { sessionId: SID },
      global: { stubs: { PlanCommentPopover: true } },
    })
    await flushAsync()
    expect(empty.find('[data-testid="plan-docs-empty"]').exists()).toBe(true)
    expect(empty.text()).toContain('暂无计划产物')
    expect(empty.find('[data-testid="plan-docs-panel"]').exists()).toBe(false)
    empty.unmount()
  })

  it('docs 空数组且 planFilePath 空 → 空态不渲染主体', async () => {
    const wrapper = await mountPanel(viewOf({ docs: [], planFilePath: '' }))
    expect(wrapper.find('[data-testid="plan-docs-empty"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="plan-docs-panel"]').exists()).toBe(false)
  })

  it('isActive=false 且 docs 空 → 空态不渲染主体（退出且无产物）', async () => {
    const wrapper = await mountPanel(viewOf({ isActive: false, docs: [], planFilePath: '' }))
    expect(wrapper.find('[data-testid="plan-docs-empty"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="plan-docs-panel"]').exists()).toBe(false)
  })

  it('isActive=false 且 docs 非空 → 仍渲染主体（D5：产物 tab 与 isActive 解耦，退出后可回看）', async () => {
    const wrapper = await mountPanel(viewOf({ isActive: false }))
    expect(wrapper.find('[data-testid="plan-docs-panel"]').exists()).toBe(true)
    expect(wrapper.findAll('[data-testid="plan-docs-tab"]')).toHaveLength(3)
  })

  it('首拉失败且无既有 view（C-U1）→ 空态分支呈现错误行（错误原文 + 恢复指引），非静默降级', async () => {
    commandMock.mockRejectedValue(new Error('rpc timeout'))
    const wrapper = mount(PlanDocsPanel, {
      props: { sessionId: SID },
      global: { stubs: { PlanCommentPopover: true } },
    })
    await flushAsync()

    // view=null → 横幅 isActive 门不渲染、错误不可见（C-U1 场景）；错误落本面板空态就近呈现
    const err = wrapper.find('[data-testid="plan-docs-load-error"]')
    expect(err.exists()).toBe(true)
    expect(err.text()).toContain('rpc timeout')
    expect(err.text()).toContain('稍后重试或重开会话')
    // 空态容器仍在（错误行是空态分支内的附加呈现）
    expect(wrapper.find('[data-testid="plan-docs-empty"]').exists()).toBe(true)
  })
})

describe('PlanDocsPanel 旧 schema 降级（D4）', () => {
  it('旧 entry 无 docs 字段 → planFilePath 单文件条目：fileName 取路径末段、无 chip / version', async () => {
    const wrapper = await mountPanel(viewOf({ docs: undefined }))
    const tabs = wrapper.findAll('[data-testid="plan-docs-tab"]')
    expect(tabs).toHaveLength(1)
    expect(tabs[0]!.text()).toContain('plan.md')
    // 降级条目无来源技能 chip、无 version meta
    expect(tabs[0]!.find('[data-testid="plan-docs-tab-skill"]').exists()).toBe(false)
    expect(tabs[0]!.find('[data-testid="plan-docs-tab-version"]').exists()).toBe(false)
    // 正文仍经 file.read 读取（absPath = planFilePath）
    await flushAsync()
    expect(readMock).toHaveBeenCalledWith('/data/A/.taiji-harness/auth/plan.md', SID)
  })
})

describe('PlanDocsPanel 正文加载（file.read 带 sessionId）', () => {
  it('选中首 tab 正文 = file.read(absPath, sessionId) + markdown 渲染', async () => {
    readMock.mockResolvedValue({ content: '# 设计文档正文', truncated: false })
    const wrapper = await mountPanel(viewOf())
    expect(readMock).toHaveBeenCalledTimes(1)
    // cwd 守门契约：sessionId 入参（fileApi.read(path, sid)）
    expect(readMock).toHaveBeenCalledWith('/data/A/.taiji-harness/auth/design.md', SID)
    expect(wrapper.find('.md-stub').text()).toContain('设计文档正文')
  })

  it('tab 切换 → 渲染对应文档正文（第二次 file.read 参数为新 absPath）', async () => {
    readMock.mockImplementation((path: string) =>
      Promise.resolve({ content: `body-of:${path}`, truncated: false }),
    )
    const wrapper = await mountPanel(viewOf())
    const tabs = wrapper.findAll('[data-testid="plan-docs-tab"]')
    await tabs[1]!.trigger('click')
    await flushAsync()

    expect(readMock).toHaveBeenLastCalledWith('/data/A/.taiji-harness/auth/impl-plan.md', SID)
    expect(wrapper.find('.md-stub').text()).toContain('body-of:/data/A/.taiji-harness/auth/impl-plan.md')
    // 选中态（aria-selected）随切换
    expect(tabs[1]!.attributes('aria-selected')).toBe('true')
  })

  it('file.read 失败 → E2 占位错误态（文档不存在 + agent 重新产出提示），条目不清', async () => {
    readMock.mockRejectedValue(new Error('file not found'))
    const wrapper = await mountPanel(viewOf())
    const err = wrapper.find('[data-testid="plan-docs-error"]')
    expect(err.exists()).toBe(true)
    expect(err.text()).toContain('文档不存在或已删除')
    expect(err.text()).toContain('重新产出')
    // E2 条目不清：tab 仍在、错误态不吞文档条目
    expect(wrapper.findAll('[data-testid="plan-docs-tab"]')).toHaveLength(3)
  })
})

describe('PlanDocsPanel 修订刷新（G3）', () => {
  it('docs[].version 变化（修订重登记）→ 重新 file.read 刷新正文', async () => {
    const wrapper = await mountPanel(viewOf())
    expect(readMock).toHaveBeenCalledTimes(1)

    const revised = structuredClone(viewOf())
    revised.docs = revised.docs!.map((d) => (d.fileName === 'auth-token-renewal.design.md' ? { ...d, version: 2 } : d))
    usePlanStore().applyFrame(SID, revised)
    await flushAsync()

    expect(readMock).toHaveBeenCalledTimes(2)
    expect(readMock).toHaveBeenLastCalledWith('/data/A/.taiji-harness/auth/design.md', SID)
  })

  it('reviewState 离开 revising → 重新 file.read（修订收尾刷新）', async () => {
    const wrapper = await mountPanel(viewOf({ reviewState: 'revising' }))
    expect(readMock).toHaveBeenCalledTimes(1)
    // revising 态视觉：tab 圆点 + meta 提示
    expect(wrapper.find('[data-testid="plan-docs-tab-revising"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="plan-docs-meta-revising"]').exists()).toBe(true)

    usePlanStore().applyFrame(SID, viewOf({ reviewState: 'awaiting' }))
    await flushAsync()

    expect(readMock).toHaveBeenCalledTimes(2)
    expect(wrapper.find('[data-testid="plan-docs-meta-revising"]').exists()).toBe(false)
  })
})

describe('PlanDocsPanel 划选评论草稿（D6：quote 锚定、多条、可删除）', () => {
  async function submitComment(wrapper: VueWrapper, quote: string, comment: string): Promise<void> {
    const popover = wrapper.findComponent({ name: 'PlanCommentPopover' })
    popover!.vm.$emit('submit', { quote, comment })
    await nextTick()
  }

  it('Popover submit → 草稿新增（quote + comment 成对渲染，多条累积）', async () => {
    const wrapper = await mountPanel(viewOf())
    expect(wrapper.find('[data-testid="plan-comment-drafts"]').exists()).toBe(false)

    await submitComment(wrapper, 'token 在过期前自动刷新', '零感知不可证伪，改成可检验表述')
    await submitComment(wrapper, 'refresh token 已下发但从未被使用', '补一条续期失败路径')

    const items = wrapper.findAll('[data-testid="plan-comment-draft-item"]')
    expect(items).toHaveLength(2)
    expect(items[0]!.text()).toContain('token 在过期前自动刷新')
    expect(items[0]!.text()).toContain('零感知不可证伪')
    expect(items[1]!.text()).toContain('refresh token 已下发但从未被使用')
  })

  it('草稿删除按钮 → removeDraft（按序号删，列表同步）', async () => {
    const wrapper = await mountPanel(viewOf())
    await submitComment(wrapper, 'quote-a', 'comment-a')
    await submitComment(wrapper, 'quote-b', 'comment-b')

    const items = wrapper.findAll('[data-testid="plan-comment-draft-item"]')
    await items[0]!.find('[data-testid="plan-comment-draft-delete"]').trigger('click')
    await nextTick()

    const rest = wrapper.findAll('[data-testid="plan-comment-draft-item"]')
    expect(rest).toHaveLength(1)
    expect(rest[0]!.text()).toContain('quote-b')
  })
})
