/**
 * CommandDocPanel 单测（drawer Doc tab 内容）。
 *
 * W2 改源后：skill 文档来源从 settingsStore.skills 扫描改为 command.sourceInfo.path
 * 经 file.read RPC 读取。覆盖：
 * - skill 命令（sourceInfo.path）→ file.read 读 SKILL.md content 渲染 + sourcePath 元信息
 * - /skill:xxx 格式无 sourceInfo → 兜底从 settings.skills 查 sourcePath
 * - extension 命令（非 skill）→ 退化信息卡（description + source 标签）
 * - 未选择命令 → 空态
 *
 * 运行：pnpm --filter @xyz-agent/frontend run test -- src/__tests__/command-doc-panel.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { chatViewDepsModule } from '@/__tests__/helpers/chat-stream-mount'
import { mount, flushPromises } from '@vue/test-utils'
import { defineComponent, inject } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import CommandDocPanel from '@/components/panel/CommandDocPanel.vue'
import { useCommandStore, __resetCommandStoreForTesting } from '@/composables/features/command/useCommandStore'
import { getSettingsStore } from '@xyz-agent/core'
import { useSideDrawer, resetSideDrawer } from '@/composables/features/drawer/useSideDrawer'
import type { SkillInfo } from '@xyz-agent/shared'
import { ChatViewDepsKey } from '@xyz-agent/ui'

// file.read mock：捕获调用参数，返回预设 content。两路守门（带/不带 sessionId）都走这个 mock。
const readMock = vi.fn()
vi.mock('@xyz-agent/core/transport/api/domains/file', () => ({
  read: vi.fn((path: string, sessionId?: string) => readMock(path, sessionId)),
}))

// MarkdownRenderer stub：ui 包 MarkdownRenderer 异步走 deps.renderMarkdown（shiki 在壳），
// 单测内按名 stub 成同步渲染 content（断言文档正文到达即可）。
// [w6 chat-ui-and-shell T7] CommandDocPanel 壳经 useChatViewDeps 装配 deps → mock 该装配器。
vi.mock('@/composables/panel/useChatViewDeps', () => chatViewDepsModule())
const mdStub = defineComponent({
  name: 'MarkdownRenderer',
  props: { content: { type: String, default: '' } },
  template: '<div class="md-stub">{{ content }}</div>',
})
// MarkdownRenderer inject 探针：验证 CommandDocPanel provide 了 ChatViewDepsKey。
// drawer 不在 MessageStream provide 作用域内，须自行 provide，否则 MarkdownRenderer setup 抛 inject 缺失。
const mdProbe = defineComponent({
  name: 'MarkdownRenderer',
  setup() {
    const deps = inject(ChatViewDepsKey, null)
    return { hasDeps: !!deps }
  },
  template: '<div class="md-probe">{{ hasDeps }}</div>',
})

beforeEach(() => {
  setActivePinia(createPinia())
  resetSideDrawer()
  // [w5] 壳单例跨测试共享：reset 让每个用例拿到全新实例（getPlatform 由 vitest-i18n-setup 全局 provide mock）
  __resetCommandStoreForTesting()
  readMock.mockReset()
})

const SKILLS: SkillInfo[] = [
  {
    id: 'sk-fix',
    name: 'fix',
    description: '修复 bug 的 skill',
    enabled: true,
    source: 'agents',
    triggers: ['fix', '修复'],
    sourcePath: '~/.agents/skills/fix/SKILL.md',
    content: '# Fix Skill\n\n用于修复问题。',
    effective: true,
  },
]

/**
 * 预置 commandStore + settings。
 * @param withSourceInfo true = /fix 带 sourceInfo.path（W2 主路径），false = 无 sourceInfo（兜底测试）
 */
async function setup(sessionId: string, withSourceInfo = true): Promise<void> {
  const commandStore = useCommandStore()
  commandStore.applyCommands(sessionId, [
    {
      name: '/fix',
      description: '修复问题',
      source: 'skill',
      ...(withSourceInfo
        ? { sourceInfo: { path: '/proj/.xyz-agent/skills/fix/SKILL.md', source: 'skill', scope: 'project' } }
        : {}),
    },
    { name: '/commit', description: '提交改动', source: 'extension' },
    { name: '/compact', source: 'builtin' },
  ])
  const settings = getSettingsStore()
  settings.skills.value = SKILLS as typeof settings.skills.value
}

describe('CommandDocPanel', () => {
  it('skill 命令（sourceInfo.path）→ file.read 读 SKILL.md content 渲染 + Skill 标签 + sourcePath', async () => {
    await setup('s1')
    // file.read 返回 SKILL.md content（模拟 runtime 读到）
    readMock.mockResolvedValue({ content: '# Fix Skill\n\n用于修复问题。', truncated: false })

    const drawer = useSideDrawer()
    drawer.open('doc', { commandName: '/fix' })

    const wrapper = mount(CommandDocPanel, {
      props: { sessionId: 's1' },
      global: { stubs: { MarkdownRenderer: mdStub, Button: true } },
    })
    await flushPromises()

    // header 含命令名 + Skill 标签
    expect(wrapper.text()).toContain('/fix')
    expect(wrapper.text()).toContain('Skill')
    // file.read 被调用，path 是 sourceInfo.path
    expect(readMock).toHaveBeenCalled()
    const callArgs = readMock.mock.calls[0]
    expect(callArgs[0]).toBe('/proj/.xyz-agent/skills/fix/SKILL.md')
    // skill 完整文档正文（来自 file.read 返回的 content）
    expect(wrapper.text()).toContain('用于修复问题')
    // sourcePath 元信息（来自 sourceInfo.path）
    expect(wrapper.text()).toContain('/proj/.xyz-agent/skills/fix/SKILL.md')
  })

  it('file.read 先带 sessionId（cwd 守门），失败后 fallback 不带 sessionId（白名单）', async () => {
    await setup('s1')
    // 带 sessionId 的调用 reject（模拟 out_of_cwd），不带 sessionId 的调用 resolve
    readMock.mockImplementation((_path: string, sid?: string) =>
      sid ? Promise.reject(new Error('out_of_cwd')) : Promise.resolve({ content: '# Global Skill', truncated: false }),
    )

    const drawer = useSideDrawer()
    drawer.open('doc', { commandName: '/fix' })

    const wrapper = mount(CommandDocPanel, {
      props: { sessionId: 's1' },
      global: { stubs: { MarkdownRenderer: mdStub, Button: true } },
    })
    await flushPromises()

    // 至少一次带 sessionId 的调用（cwd 守门尝试），且至少一次不带 sessionId 的调用（白名单 fallback）
    const callsWithSid = readMock.mock.calls.filter((c) => c[1] === 's1')
    const callsWithoutSid = readMock.mock.calls.filter((c) => c[1] === undefined)
    expect(callsWithSid.length).toBeGreaterThanOrEqual(1)
    expect(callsWithoutSid.length).toBeGreaterThanOrEqual(1)
    // fallback 后读到全局 skill content
    expect(wrapper.text()).toContain('Global Skill')
  })

  it('/skill:xxx 格式无 sourceInfo → 兜底从 settings.skills 查 sourcePath', async () => {
    await setup('s1')
    readMock.mockResolvedValue({ content: '# Fix Skill content', truncated: false })

    const drawer = useSideDrawer()
    drawer.open('doc', { commandName: '/skill:fix' })

    const wrapper = mount(CommandDocPanel, {
      props: { sessionId: 's1' },
      global: { stubs: { MarkdownRenderer: mdStub, Button: true } },
    })
    await flushPromises()

    // sourcePath 来自 settings.skills 的 sourcePath
    expect(wrapper.text()).toContain('~/.agents/skills/fix/SKILL.md')
    // description 来自 settings.skills 的 description
    expect(wrapper.text()).toContain('修复 bug 的 skill')
    // file.read 用 settings 兜底的 path
    expect(readMock.mock.calls[0][0]).toBe('~/.agents/skills/fix/SKILL.md')
  })

  it('extension 命令（非 skill）→ 退化信息卡（description + 无完整文档提示），不调 file.read', async () => {
    await setup('s1')
    const drawer = useSideDrawer()
    drawer.open('doc', { commandName: '/commit' })

    const wrapper = mount(CommandDocPanel, {
      props: { sessionId: 's1' },
      global: { stubs: { MarkdownRenderer: mdStub, Button: true } },
    })
    await flushPromises()

    expect(wrapper.text()).toContain('/commit')
    expect(wrapper.text()).toContain('Extension')
    expect(wrapper.text()).toContain('提交改动')
    expect(wrapper.text()).toContain('无完整文档')
    // 非 skill 命令不触发 file.read
    expect(readMock).not.toHaveBeenCalled()
  })

  it('builtin 命令无 description → 显示「无详细描述」占位', async () => {
    await setup('s1')
    const drawer = useSideDrawer()
    drawer.open('doc', { commandName: '/compact' })

    const wrapper = mount(CommandDocPanel, {
      props: { sessionId: 's1' },
      global: { stubs: { MarkdownRenderer: mdStub, Button: true } },
    })
    await flushPromises()

    expect(wrapper.text()).toContain('/compact')
    expect(wrapper.text()).toContain('内置')
    expect(wrapper.text()).toContain('无详细描述')
  })

  it('未选择命令 → 空态（点击 chip 提示）', async () => {
    await setup('s1')
    // 不调 open（selectedCommandName 仍为 null）

    const wrapper = mount(CommandDocPanel, {
      props: { sessionId: 's1' },
      global: { stubs: { MarkdownRenderer: mdStub, Button: true } },
    })
    await flushPromises()

    expect(wrapper.text()).toContain('未选择命令')
  })

  it('content 异步到达不崩（fragment 切换：无文档正文 div → content MarkdownRenderer）', async () => {
    await setup('s1')
    // file.read 延迟 resolve：模拟 content 从 null→有值，触发 fragment 内 div(无文档正文)→MarkdownRenderer(content) 切换。
    let resolveRead!: (v: { content: string; truncated: boolean }) => void
    readMock.mockReturnValue(new Promise((r) => { resolveRead = r }))

    const drawer = useSideDrawer()
    drawer.open('doc', { commandName: '/fix' })

    const wrapper = mount(CommandDocPanel, {
      props: { sessionId: 's1' },
      global: { stubs: { MarkdownRenderer: mdStub, Button: true } },
    })
    await flushPromises()

    // content 未到：description 是元信息卡片纯文本（非 md-stub），content 缺失显示「无文档正文」
    expect(wrapper.findAll('.md-stub').length).toBe(0)
    expect(wrapper.text()).toContain('修复问题')
    expect(wrapper.text()).toContain('无文档正文')

    // content 到达 → fragment 切换（卸载「无文档正文」div，挂载 content md-stub）
    resolveRead({ content: '# Fix Skill body', truncated: false })
    await flushPromises()

    // 切换后不崩：content md-stub 渲染，不再显示「无文档正文」
    expect(wrapper.findAll('.md-stub').length).toBe(1)
    expect(wrapper.text()).toContain('Fix Skill body')
    expect(wrapper.text()).not.toContain('无文档正文')
  })

  it('CommandDocPanel provide ChatViewDepsKey（drawer 不在 MessageStream 作用域，须自行 provide，子 MarkdownRenderer 才能 inject）', async () => {
    await setup('s1')
    readMock.mockResolvedValue({ content: '# body', truncated: false })

    const drawer = useSideDrawer()
    drawer.open('doc', { commandName: '/fix' })

    const wrapper = mount(CommandDocPanel, {
      props: { sessionId: 's1' },
      global: { stubs: { MarkdownRenderer: mdProbe, Button: true } },
    })
    await flushPromises()

    // content MarkdownRenderer 能 inject 到 ChatViewDeps（provide 生效，不抛 inject 缺失）
    const probes = wrapper.findAll('.md-probe')
    expect(probes.length).toBe(1)
    expect(probes[0]!.text()).toBe('true')
  })

  it('SKILL.md content 的 YAML frontmatter 被剥掉（不泄漏成分正文）', async () => {
    await setup('s1')
    readMock.mockResolvedValue({
      content: '---\nname: fix\ndescription: 修 bug\n---\n\n# Fix Skill\n\n正文内容。',
      truncated: false,
    })
    const drawer = useSideDrawer()
    drawer.open('doc', { commandName: '/fix' })
    const wrapper = mount(CommandDocPanel, {
      props: { sessionId: 's1' },
      global: { stubs: { MarkdownRenderer: mdStub, Button: true } },
    })
    await flushPromises()
    // 正文保留
    expect(wrapper.text()).toContain('正文内容')
    expect(wrapper.text()).toContain('Fix Skill')
    // frontmatter 元数据不泄漏成正文（name:/description: 不再被当段落渲染）
    expect(wrapper.text()).not.toContain('name: fix')
    expect(wrapper.text()).not.toContain('description: 修 bug')
  })
})
