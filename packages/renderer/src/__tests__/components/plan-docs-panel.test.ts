/**
 * PlanDocsPanel 组件单测 —— plan 模式重设计 u1-docs-panel（设计 §3.1 步骤 3-5 / G2 后半 +
 * G3 / D4 降级 / D10 空态 / E2 占位）。
 *
 * 覆盖（plan-mode-redesign impl-plan u1-docs-panel（历史项目，未入库）验收条款）：
 * - L2 tab 渲染（多文档 tab 数、version meta / ellipsis 截断；sourceSkill 只在 meta 行，
 *   D13③ 删 tab chip 重复）
 * - tab 切换渲染对应正文（file.read mock 参数带 sessionId 断言——cwd 守门契约）
 * - file.read 失败 → E2 占位错误态（条目不清，agent 可重新产出提示）
 * - 旧 schema 降级（D4，§3.2 矩阵 #3 加 !isActive 门）：!isActive 且无 docs 字段 →
 *   planFilePath 单文件（fileName 取路径末段、无 chip/version）；读失败才报「文档不存在」
 * - 态矩阵（§3.2，u-drawer-gate）：isActive && docs 空按 agent 活跃信号分态——#1 活跃
 *   pending 进行时 / #2 空闲 pending 等待态 + 恢复入口提示（无独立按钮）/ isGenerating
 *   两态切换；isActive && docs 空期间 legacy 降级条目不渲染（已接受代价）
 * - docs 空 / 无 plan 状态 → 空态不渲染主体（D10 联动；isActive=false 且 docs 空同场景——
 *   isActive=false 但 docs 非空仍渲染，D5 终态矩阵「产物 tab 与 isActive 解耦」钉死）
 * - 划选评论草稿（quote 捕获后经 Popover emit → 草稿新增 / 删除；浮条细节归 plan-comment-popover.test.ts）
 * - 修订刷新（G3）：version bump / reviewState 离开 revising → 重新 file.read
 * - 草稿回看消费（§3.5，u-review-source-ui）：审批条计数点击 → plan-store 回看请求 →
 *   本面板滚动到草稿列表（挂载补消费 + 已挂载 watch 消费 + consumed 防重滚 + 空草稿 no-op）
 * - D13 合规断言（视觉/文案合规包，S13 降级兑现——本文件锁①③④⑤⑩⑪的面板/浮层侧）：
 *   ①「评论草稿」标题无 uppercase/tracking-wider；③ sourceSkill 只留 meta chip 一份；
 *   ④ L2 tab 选中色 = bg-bg-elevated；⑤ 小字无 opacity 叠乘；⑩ 空态图标 +「输入 /plan
 *   开始规划」；⑪ 草稿列表区划选不弹评论浮条 + 浮层 Esc 可关（清单全表见
 *   plan-mode-bar.test.ts 头部 D13 索引）
 *
 * mock 形态照 plan-mode-bar.test.ts（command spread actual 保真实 events 通道）+
 * command-doc-panel.test.ts（file.read mock + MarkdownRenderer 按名 stub + useChatViewDeps
 * 装配器 mock）。状态驱动用 store.applyFrame（真实 WS 帧路径，不绕被测消费链）。
 * i18n 经 vitest-i18n-setup 全局 mock，t() 取 zh-CN 文案。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/components/plan-docs-panel.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
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

// chat store mock（isGenerating per-session 派生信号——设计 §3.2 态矩阵 #1/#2 判据）。
// useChatStore 返回窄接口照 panel-container-drawer-mode.test.ts 惯例；ref 内建照
// use-plan-drawer-sync.test.ts drawer mock 形态（工厂内建 ref，测试经 chatMock.setGenerating
// 翻转驱动组件 computed 响应式）。spread actual 保 re-export（LRU 常量等）不丢
const chatMock = vi.hoisted(() => {
  const state: { setGenerating: ((v: boolean) => void) | null } = { setGenerating: null }
  return state
})
vi.mock('@/stores/chat', async (importActual) => {
  const actual = await importActual<typeof import('@/stores/chat')>()
  const { ref } = await import('vue')
  const generating = ref(false)
  chatMock.setGenerating = (v: boolean) => {
    generating.value = v
  }
  return {
    ...actual,
    useChatStore: () => ({
      isGenerating: () => generating.value,
    }),
  }
})

// MarkdownRenderer stub：ui 包 MarkdownRenderer 异步走 deps.renderMarkdown（shiki 在壳），
// 单测内按名 stub 成同步渲染 content；useChatViewDeps 装配器 mock 照 command-doc-panel.test.ts
vi.mock('@/composables/panel/useChatViewDeps', () => chatViewDepsModule())
import { chatViewDepsModule } from '@/__tests__/helpers/chat-stream-mount'
import PlanDocsPanel from '@/components/panel/plan/PlanDocsPanel.vue'
import { usePlanStore } from '@/stores/plan-store'

const SID = 'sess-docs'

const DOCS: PlanDocMeta[] = [
  { fileName: 'auth-token-renewal.design.md', absPath: '/data/A/.tmp/plans/auth/design.md', sourceSkill: 'tech-design', version: 1 },
  { fileName: 'auth-token-renewal.impl-plan.md', absPath: '/data/A/.tmp/plans/auth/impl-plan.md', sourceSkill: 'dev-flow', version: 1 },
  { fileName: 'design-review.report.md', absPath: '/data/A/.tmp/plans/auth/review.report.md', sourceSkill: '', version: 2 },
]

function viewOf(overrides: Partial<PlanStateView> = {}): PlanStateView {
  return {
    isActive: true,
    planFilePath: '/data/A/.tmp/plans/auth/plan.md',
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
 * PlanCommentPopover 默认 stub（浮条细节归 plan-comment-popover.test.ts；本文件经组件实例
 * emit submit 驱动草稿链，stub 保留实例供 findComponent）；opts.stubCommentPopover=false
 * 时挂真实浮条（D13⑪ 划选/Esc 行为断言用）。
 */
async function mountPanel(
  view: PlanStateView,
  opts: { stubCommentPopover?: boolean } = {},
): Promise<VueWrapper> {
  commandMock.mockResolvedValue({ sessionId: SID, planState: view })
  const wrapper = mount(PlanDocsPanel, {
    props: { sessionId: SID },
    global: {
      stubs: {
        MarkdownRenderer: { template: '<div class="md-stub">{{ content }}</div>', props: ['content'] },
        PlanCommentPopover: opts.stubCommentPopover !== false,
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
  chatMock.setGenerating?.(false)
})

describe('PlanDocsPanel L2 文档 tab 渲染', () => {
  it('多文档 → tab 数与 docs 一致；fileName / version v{N} 逐 tab 断言（sourceSkill 只在 meta，D13③）', async () => {
    const wrapper = await mountPanel(viewOf())
    const tabs = wrapper.findAll('[data-testid="plan-docs-tab"]')
    expect(tabs).toHaveLength(3)
    expect(tabs[0]!.text()).toContain('auth-token-renewal.design.md')
    expect(tabs[1]!.text()).toContain('auth-token-renewal.impl-plan.md')
    // D13③ sourceSkill 只留 meta chip 一份：tab 内不再渲染技能 chip（删重复）
    expect(tabs[0]!.find('[data-testid="plan-docs-tab-skill"]').exists()).toBe(false)
    expect(tabs[1]!.find('[data-testid="plan-docs-tab-skill"]').exists()).toBe(false)
    // meta 行来源技能 chip 是唯一一份（选中首个文档，非空 sourceSkill 才渲染）
    expect(wrapper.find('[data-testid="plan-docs-meta-skill"]').text()).toContain('tech-design')
    // version meta「v{N}」
    expect(tabs[0]!.find('[data-testid="plan-docs-tab-version"]').text()).toBe('v1')
    expect(tabs[2]!.find('[data-testid="plan-docs-tab-version"]').text()).toBe('v2')
    // sourceSkill 为空（模板流程产出）→ meta chip 同样不渲染
    usePlanStore().applyFrame(SID, viewOf({ docs: [DOCS[2]!] }))
    await nextTick()
    expect(wrapper.find('[data-testid="plan-docs-meta-skill"]').exists()).toBe(false)
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

  it('isActive=false 且 docs 空 → 空态不渲染主体（退出且无产物，§3.2 矩阵 #4）', async () => {
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

    // view=null → PlanModeBar isActive 门不渲染、错误不可见（C-U1 场景）；错误落本面板空态就近呈现
    const err = wrapper.find('[data-testid="plan-docs-load-error"]')
    expect(err.exists()).toBe(true)
    expect(err.text()).toContain('rpc timeout')
    expect(err.text()).toContain('稍后重试或重开会话')
    // 空态容器仍在（错误行是空态分支内的附加呈现）
    expect(wrapper.find('[data-testid="plan-docs-empty"]').exists()).toBe(true)
  })
})

describe('PlanDocsPanel 态矩阵（plan-mode-ux-refactor §3.2：isActive && docs 空分态）', () => {
  it('#1 isActive && docs 空 && agent 活跃 → pending 进行时「正在探索与撰写计划文档…」，legacy 降级条目不渲染', async () => {
    chatMock.setGenerating?.(true)
    // planFilePath 有值（enter 恒设该字段）——pending 判据不含该维度，且 isActive && docs 空
    // 期间不渲染 legacy 降级条目（同 slug 旧产物暂不可回看，设计 §3.2 已接受代价）
    const wrapper = await mountPanel(viewOf({ docs: [] }))
    const pending = wrapper.find('[data-testid="plan-docs-pending-active"]')
    expect(pending.exists()).toBe(true)
    expect(pending.text()).toContain('正在探索与撰写计划文档…')
    expect(wrapper.find('[data-testid="plan-docs-tab"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="plan-docs-empty"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="plan-docs-panel"]').exists()).toBe(false)
  })

  it('#2 isActive && docs 空 && agent 空闲 → 「agent 暂未推进」+ 恢复入口提示（文案提示位，无独立按钮）', async () => {
    const wrapper = await mountPanel(viewOf({ docs: [] }))
    const pending = wrapper.find('[data-testid="plan-docs-pending-idle"]')
    expect(pending.exists()).toBe(true)
    expect(pending.text()).toContain('agent 暂未推进，可发消息继续')
    expect(pending.text()).toContain('在对话输入框发送任意消息')
    // 恢复入口的交互语义 = 指引用户发消息，无独立按钮（恢复入口 = 文案指引，已随 u-drawer-gate 落地，无程序动作）
    expect(pending.find('button').exists()).toBe(false)
    expect(wrapper.find('[data-testid="plan-docs-empty"]').exists()).toBe(false)
  })

  it('isGenerating 两态切换驱动 #1/#2 互切（响应式渲染）', async () => {
    chatMock.setGenerating?.(true)
    const wrapper = await mountPanel(viewOf({ docs: [], planFilePath: '' }))
    expect(wrapper.find('[data-testid="plan-docs-pending-active"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="plan-docs-pending-idle"]').exists()).toBe(false)

    chatMock.setGenerating?.(false)
    await nextTick()
    expect(wrapper.find('[data-testid="plan-docs-pending-active"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="plan-docs-pending-idle"]').exists()).toBe(true)

    chatMock.setGenerating?.(true)
    await nextTick()
    expect(wrapper.find('[data-testid="plan-docs-pending-active"]').exists()).toBe(true)
  })

  it('判据不含 planFilePath 维度：docs 空且 planFilePath 空同样落 pending（不落空态）', async () => {
    const wrapper = await mountPanel(viewOf({ docs: [], planFilePath: '' }))
    expect(wrapper.find('[data-testid="plan-docs-pending-idle"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="plan-docs-empty"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="plan-docs-panel"]').exists()).toBe(false)
  })
})

describe('PlanDocsPanel 旧 schema 降级（D4，§3.2 矩阵 #3：!isActive 门）', () => {
  it('!isActive 且旧 entry 无 docs 字段 → planFilePath 单文件条目：fileName 取路径末段、无 chip / version', async () => {
    const wrapper = await mountPanel(viewOf({ docs: undefined, isActive: false }))
    const tabs = wrapper.findAll('[data-testid="plan-docs-tab"]')
    expect(tabs).toHaveLength(1)
    expect(tabs[0]!.text()).toContain('plan.md')
    // 降级条目无来源技能 chip、无 version meta
    expect(tabs[0]!.find('[data-testid="plan-docs-tab-skill"]').exists()).toBe(false)
    expect(tabs[0]!.find('[data-testid="plan-docs-tab-version"]').exists()).toBe(false)
    // 正文仍经 file.read 读取（absPath = planFilePath）
    await flushAsync()
    expect(readMock).toHaveBeenCalledWith('/data/A/.tmp/plans/auth/plan.md', SID)
  })

  it('isActive 期间不渲染 legacy 降级条目（!isActive 门：条目可点即 E2 假错误）', async () => {
    const wrapper = await mountPanel(viewOf({ docs: undefined }))
    expect(wrapper.findAll('[data-testid="plan-docs-tab"]')).toHaveLength(0)
    expect(wrapper.find('[data-testid="plan-docs-pending-idle"]').exists()).toBe(true)
  })

  it('#3 读失败才报「文档不存在」：降级条目 file.read 失败 → E2 占位错误态，条目不清', async () => {
    readMock.mockRejectedValue(new Error('file not found'))
    const wrapper = await mountPanel(viewOf({ docs: undefined, isActive: false }))
    const err = wrapper.find('[data-testid="plan-docs-error"]')
    expect(err.exists()).toBe(true)
    expect(err.text()).toContain('文档不存在或已删除')
    // 条目不清：降级 tab 仍在（agent 可重新产出）
    expect(wrapper.findAll('[data-testid="plan-docs-tab"]')).toHaveLength(1)
  })
})

describe('PlanDocsPanel 正文加载（file.read 带 sessionId）', () => {
  it('选中首 tab 正文 = file.read(absPath, sessionId) + markdown 渲染', async () => {
    readMock.mockResolvedValue({ content: '# 设计文档正文', truncated: false })
    const wrapper = await mountPanel(viewOf())
    expect(readMock).toHaveBeenCalledTimes(1)
    // cwd 守门契约：sessionId 入参（fileApi.read(path, sid)）
    expect(readMock).toHaveBeenCalledWith('/data/A/.tmp/plans/auth/design.md', SID)
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

    expect(readMock).toHaveBeenLastCalledWith('/data/A/.tmp/plans/auth/impl-plan.md', SID)
    expect(wrapper.find('.md-stub').text()).toContain('body-of:/data/A/.tmp/plans/auth/impl-plan.md')
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

  it('[RD-2#4] tab 切换请求在途 → loading 行 + 旧正文不残留（头部已新条目，防串内容误读）', async () => {
    // 第一份文档读完；第二份挂起在途
    let resolveSecond!: (v: { content: string; truncated: boolean }) => void
    readMock.mockImplementation((path: string) => {
      if (path.endsWith('impl-plan.md')) return new Promise((r) => { resolveSecond = r })
      return Promise.resolve({ content: 'body-of-design', truncated: false })
    })
    const wrapper = await mountPanel(viewOf())
    expect(wrapper.find('.md-stub').text()).toContain('body-of-design')

    // 切到第二个 tab：新 tab/头部已是新条目，正文必须同步清空进 loading（不残留旧文档内容）
    const tabs = wrapper.findAll('[data-testid="plan-docs-tab"]')
    await tabs[1]!.trigger('click')
    await nextTick()
    expect(wrapper.find('.md-stub').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('body-of-design')
    const loading = wrapper.find('[data-testid="plan-docs-loading"]')
    expect(loading.exists()).toBe(true)
    expect(loading.text()).toContain('加载中')

    // 新文档到达 → loading 行被正文取代
    resolveSecond({ content: 'body-of-impl', truncated: false })
    await flushAsync()
    expect(wrapper.find('[data-testid="plan-docs-loading"]').exists()).toBe(false)
    expect(wrapper.find('.md-stub').text()).toContain('body-of-impl')
  })

  it('[RD-2#4] 版本 bump（修订刷新）触发重拉 → 同样先进 loading，旧版本正文不残留', async () => {
    readMock.mockResolvedValue({ content: 'v1 body', truncated: false })
    const wrapper = await mountPanel(viewOf())
    expect(wrapper.find('.md-stub').text()).toContain('v1 body')

    let resolveV2!: (v: { content: string; truncated: boolean }) => void
    readMock.mockReturnValue(new Promise((r) => { resolveV2 = r }))
    const revised = structuredClone(viewOf())
    revised.docs = revised.docs!.map((d) => (d.fileName === 'auth-token-renewal.design.md' ? { ...d, version: 2 } : d))
    usePlanStore().applyFrame(SID, revised)
    await nextTick()

    expect(wrapper.text()).not.toContain('v1 body')
    expect(wrapper.find('[data-testid="plan-docs-loading"]').exists()).toBe(true)

    resolveV2({ content: 'v2 body', truncated: false })
    await flushAsync()
    expect(wrapper.find('.md-stub').text()).toContain('v2 body')
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
    expect(readMock).toHaveBeenLastCalledWith('/data/A/.tmp/plans/auth/design.md', SID)
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

// ── §3.5 草稿回看滚动消费（u-review-source-ui）──

describe('PlanDocsPanel 草稿回看消费（§3.5：审批条计数点击 → 滚动到草稿列表）', () => {
  let scrollIntoViewMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    // jsdom 未实现 scrollIntoView：直接替换原型方法捕获调用（用例内断言调用次数）
    scrollIntoViewMock = vi.fn()
    Element.prototype.scrollIntoView = scrollIntoViewMock as unknown as typeof Element.prototype.scrollIntoView
  })

  function primeDraftsWithView(store: ReturnType<typeof usePlanStore>): void {
    // 先建立 isActive=true 旧 view 再加草稿——组件挂载首拉 resolve 后 true→true 不触发翻转清，
    // 草稿保留（同时反向覆盖「首拉不误清审阅中草稿」）
    store.applyFrame(SID, viewOf())
    store.addDraftComment({ quote: '回看引文', comment: '回看评语' })
  }

  it('挂载补消费：drawer 关闭期间到达的回看请求（pending）→ 挂载后滚动到草稿列表并标记消费', async () => {
    const store = usePlanStore()
    store.syncFocus(SID)
    primeDraftsWithView(store)
    store.requestDraftsReveal()
    expect(store.draftsRevealPending).toBe(true)

    const wrapper = await mountPanel(viewOf())
    await flushAsync()

    expect(scrollIntoViewMock).toHaveBeenCalledTimes(1)
    expect(wrapper.find('[data-testid="plan-comment-drafts"]').exists()).toBe(true)
    expect(store.draftsRevealPending).toBe(false)
    wrapper.unmount()
  })

  it('已挂载 watch 消费：mount 后新回看请求 → 立即滚动', async () => {
    const store = usePlanStore()
    store.syncFocus(SID)
    primeDraftsWithView(store)

    const wrapper = await mountPanel(viewOf())
    await flushAsync()
    expect(scrollIntoViewMock).not.toHaveBeenCalled()

    store.requestDraftsReveal()
    await flushAsync()
    expect(scrollIntoViewMock).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })

  it('consumed 防重滚：请求消费一次后，drawer 重开（重挂载）不再滚动', async () => {
    const store = usePlanStore()
    store.syncFocus(SID)
    primeDraftsWithView(store)
    store.requestDraftsReveal()

    const first = await mountPanel(viewOf())
    await flushAsync()
    expect(scrollIntoViewMock).toHaveBeenCalledTimes(1)
    first.unmount()

    const second = await mountPanel(viewOf())
    await flushAsync()
    expect(scrollIntoViewMock).toHaveBeenCalledTimes(1) // 不重复滚动
    second.unmount()
  })

  it('无草稿（drafts=0）：请求照常消费（标记 consumed）但不滚动', async () => {
    const store = usePlanStore()
    store.syncFocus(SID)
    store.applyFrame(SID, viewOf())
    store.requestDraftsReveal()

    const wrapper = await mountPanel(viewOf())
    await flushAsync()

    expect(scrollIntoViewMock).not.toHaveBeenCalled()
    expect(store.draftsRevealPending).toBe(false)
    expect(wrapper.find('[data-testid="plan-comment-drafts"]').exists()).toBe(false)
    wrapper.unmount()
  })
})

// ── D13 合规断言（drawer 面板/浮层侧①④⑤⑩⑪；清单索引见 plan-mode-bar.test.ts 头部）──

describe('D13 合规断言（drawer 面板）', () => {
  it('D13①「评论草稿」标题无 uppercase/tracking-wider（DESIGN.md 禁 AI slop）', async () => {
    const wrapper = await mountPanel(viewOf())
    wrapper.findComponent({ name: 'PlanCommentPopover' })!.vm.$emit('submit', { quote: '引文', comment: '评语' })
    await nextTick()

    const title = wrapper.find('[data-testid="plan-comment-drafts"]').find('p')
    expect(title.exists()).toBe(true)
    expect(title.text()).toContain('评论草稿')
    expect(title.classes()).not.toContain('uppercase')
    expect(title.classes()).not.toContain('tracking-wider')
    wrapper.unmount()
  })

  it('D13④ L2 tab 选中色 = bg-bg-elevated（§3.4 tab 型规则），未选中不带该类', async () => {
    const wrapper = await mountPanel(viewOf())
    const tabs = wrapper.findAll('[data-testid="plan-docs-tab"]')
    expect(tabs[0]!.classes()).toContain('bg-bg-elevated')
    expect(tabs[0]!.classes()).toContain('text-neutral-fg')
    expect(tabs[0]!.classes()).not.toContain('bg-surface-hover')
    expect(tabs[1]!.classes()).not.toContain('bg-bg-elevated')
    wrapper.unmount()
  })

  it('D13⑤ 小字无 opacity 叠乘：pending 等待提示 / 空态提示均无 opacity-* 类', async () => {
    const idle = await mountPanel(viewOf({ docs: [] }))
    for (const p of idle.find('[data-testid="plan-docs-pending-idle"]').findAll('p')) {
      expect(p.classes().some((c) => c.startsWith('opacity-'))).toBe(false)
    }
    idle.unmount()

    const empty = await mountPanel(viewOf({ isActive: false, docs: [], planFilePath: '' }))
    for (const p of empty.find('[data-testid="plan-docs-empty"]').findAll('p')) {
      expect(p.classes().some((c) => c.startsWith('opacity-'))).toBe(false)
    }
    empty.unmount()
  })

  it('D13⑩ 空态有图标与「输入 /plan 开始规划」指引', async () => {
    const wrapper = await mountPanel(viewOf({ isActive: false, docs: [], planFilePath: '' }))
    const empty = wrapper.find('[data-testid="plan-docs-empty"]')
    expect(empty.find('svg').exists()).toBe(true)
    expect(empty.text()).toContain('输入 /plan 开始规划')
    wrapper.unmount()
  })
})

describe('D13⑪ 评论浮层（草稿列表区划选不触发 + Esc 可关）', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  /** mock 划选（照 plan-comment-popover.test.ts 先例；anchorNode 指向指定元素） */
  function mockSelectionAt(anchor: Element, text: string): void {
    vi.spyOn(window, 'getSelection').mockReturnValue({
      isCollapsed: false,
      rangeCount: 1,
      anchorNode: anchor,
      anchorOffset: 0,
      focusNode: anchor,
      focusOffset: text.length,
      toString: () => text,
      removeAllRanges: vi.fn(),
      getRangeAt: () => ({
        getBoundingClientRect: () => ({ left: 100, top: 200, width: 120, height: 20 }),
      }),
    } as unknown as Selection)
  }

  /** 浮层查询（Teleport to body → document 通道） */
  function popEl(): Element | null {
    return document.querySelector('[data-testid="plan-comment-popover"]')
  }

  it('划选草稿列表引文不弹评论浮条（target = 文档内容区）；正文划选照常弹（正向对照）', async () => {
    const wrapper = await mountPanel(viewOf(), { stubCommentPopover: false })
    wrapper.findComponent({ name: 'PlanCommentPopover' })!.vm.$emit('submit', { quote: '草稿引文', comment: '评语' })
    await nextTick()

    // 正向对照：文档内容区划选 → 浮条出现（机制活着，排除项不是哑实现）
    mockSelectionAt(wrapper.find('.md-stub').element, 'token 刷新段落')
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    await nextTick()
    expect(popEl()).not.toBeNull()

    // 关闭浮条后草稿列表区划选 → 不触发（D13⑪）
    document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    await nextTick()
    expect(popEl()).toBeNull()
    mockSelectionAt(wrapper.find('[data-testid="plan-comment-draft-item"] p').element, '草稿引文')
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    await nextTick()
    expect(popEl()).toBeNull()
    wrapper.unmount()
  })

  it('浮层 Esc 可关：浮条态 / 编辑态均整体关闭（安全选择 = 不提交）', async () => {
    const wrapper = await mountPanel(viewOf(), { stubCommentPopover: false })
    mockSelectionAt(wrapper.find('.md-stub').element, 'token 刷新段落')
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    await nextTick()
    expect(popEl()).not.toBeNull()

    // 浮条态 Esc → 关闭
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await nextTick()
    expect(popEl()).toBeNull()

    // 编辑态 Esc → 同样关闭（不 emit submit）
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    await nextTick()
    document.querySelector('[data-testid="plan-comment-trigger"]')!.dispatchEvent(
      new MouseEvent('click', { bubbles: true }),
    )
    await nextTick()
    expect(document.querySelector('[data-testid="plan-comment-editor"]')).not.toBeNull()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await nextTick()
    expect(popEl()).toBeNull()
    expect(wrapper.findAll('[data-testid="plan-comment-draft-item"]')).toHaveLength(0)
    wrapper.unmount()
  })
})
