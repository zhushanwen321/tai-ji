// @vitest-environment jsdom
import { chatViewDepsModule } from '@/__tests__/helpers/chat-stream-mount';
import { mockChatProvide } from '@/__tests__/helpers/chat-view-deps';
import CommandDocPanel from '@/components/panel/CommandDocPanel.vue';
import { useSessionEvents } from '@/composables/features/chat/useSessionEvents';
import { useCommandStore, __testing } from '@/composables/features/command/useCommandStore';
import { useSideDrawer, resetSideDrawer } from '@/composables/features/drawer/useSideDrawer';
import { getSettingsStore } from '@taiji/core';
import * as events from '@taiji/core/transport/api';
import type { SkillInfo, ServerMessage } from '@taiji/shared';
import { ChatViewDepsKey, MarkdownRenderer } from '@taiji/ui';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { describe, it, expect, beforeEach, vi, beforeAll, afterAll, afterEach } from 'vitest';
import { defineComponent, inject, nextTick, h, ref } from 'vue';

// wave3 簇 [renderer/jsdom] 3 文件
/**
 * 合并产物（round6 Wave3 机械合并，环境/簇信息见来源横幅）。
 * 重名顶层标识符已加 _mN 后缀；相对 import 已按产物位置改写。
 * 来源文件：
 * - __tests__/command-doc-panel.test.ts
 * - __tests__/markdown-renderer-fallback.test.ts
 * - composables/features/chat/__tests__/useSessionEvents.test.ts
 */

// ======================================================================
// ← __tests__/command-doc-panel.test.ts
// ======================================================================

// file.read mock：捕获调用参数，返回预设 content。两路守门（带/不带 sessionId）都走这个 mock。
const readMock = vi.fn()
vi.mock('@taiji/core/transport/api/domains/file', () => ({
  read: vi.fn((path: string, sessionId?: string) => readMock(path, sessionId)),
}))

// [RD-2#3] revealInFolder mock（失败态「打开所在目录」动作）：IPC 边界归
// ipc-reveal-in-folder.test.ts，本文件只验组件层接线（调用参数 + ~ 路径不出动作）
const revealMock = vi.hoisted(() => vi.fn())
vi.mock('@/lib/ipc', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ipc')>()
  return { ...actual, revealInFolder: revealMock }
})

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
  __testing.__resetCommandStoreForTesting()
  readMock.mockReset()
  revealMock.mockReset()
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
        ? { sourceInfo: { path: '/proj/.taiji/skills/fix/SKILL.md', source: 'skill', scope: 'project' } }
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
    expect(callArgs[0]).toBe('/proj/.taiji/skills/fix/SKILL.md')
    // skill 完整文档正文（来自 file.read 返回的 content）
    expect(wrapper.text()).toContain('用于修复问题')
    // sourcePath 元信息（来自 sourceInfo.path）
    expect(wrapper.text()).toContain('/proj/.taiji/skills/fix/SKILL.md')
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

  it('content 异步到达不崩（fragment 切换：loading 行 → content MarkdownRenderer）', async () => {
    await setup('s1')
    // file.read 延迟 resolve：模拟 content 在途，触发 fragment 内 div(loading)→MarkdownRenderer(content) 切换。
    // [RD-2#4] 在途态从「无文档正文」空态改为 loading 行（失败/空态与在途态区分）。
    let resolveRead!: (v: { content: string; truncated: boolean }) => void
    readMock.mockReturnValue(new Promise((r) => { resolveRead = r }))

    const drawer = useSideDrawer()
    drawer.open('doc', { commandName: '/fix' })

    const wrapper = mount(CommandDocPanel, {
      props: { sessionId: 's1' },
      global: { stubs: { MarkdownRenderer: mdStub, Button: true } },
    })
    await flushPromises()

    // content 未到：description 是元信息卡片纯文本（非 md-stub），在途显 loading 行
    expect(wrapper.findAll('.md-stub').length).toBe(0)
    expect(wrapper.text()).toContain('修复问题')
    expect(wrapper.text()).toContain('加载中')

    // content 到达 → fragment 切换（卸载 loading 行，挂载 content md-stub）
    resolveRead({ content: '# Fix Skill body', truncated: false })
    await flushPromises()

    // 切换后不崩：content md-stub 渲染，不再显示 loading
    expect(wrapper.findAll('.md-stub').length).toBe(1)
    expect(wrapper.text()).toContain('Fix Skill body')
    expect(wrapper.text()).not.toContain('加载中')
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
    wrapper.unmount()
  })
})

describe('CommandDocPanel 加载三态（RD-2#3/#4：failed 显式失败 / loading 不残留旧正文）', () => {
  it('[RD-2#3] 两路守门均拒绝 → 显式失败文案（含绝对路径），与「无文档正文」空态互斥，catch 留 warn 日志', async () => {
    await setup('s1')
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    readMock.mockRejectedValue(new Error('out_of_cwd'))

    const drawer = useSideDrawer()
    drawer.open('doc', { commandName: '/fix' })
    const wrapper = mount(CommandDocPanel, {
      props: { sessionId: 's1' },
      global: { stubs: { MarkdownRenderer: mdStub, Button: true } },
    })
    await flushPromises()

    // 失败态：文案 + 绝对路径（用户可区分「文档坏了」与「没写文档」）
    const failed = wrapper.find('[data-testid="command-doc-load-failed"]')
    expect(failed.exists()).toBe(true)
    expect(failed.text()).toContain('SKILL.md 读取失败')
    expect(failed.text()).toContain('/proj/.taiji/skills/fix/SKILL.md')
    // 与空态互斥：不再吞进「该 skill 无文档正文」
    expect(wrapper.text()).not.toContain('无文档正文')
    // 零日志红线：catch 必留 warn（含 path）
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('/proj/.taiji/skills/fix/SKILL.md'), expect.anything())
    warnSpy.mockRestore()
    wrapper.unmount()
  })

  it('[RD-2#3] 失败态「打开所在目录」：绝对路径可点 → revealInFolder(path)；~ 前缀路径只显路径不出动作', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    readMock.mockRejectedValue(new Error('out_of_cwd'))
    await setup('s1')
    revealMock.mockResolvedValue(true)

    // 绝对路径（sourceInfo.path）→ 动作在且可点
    const drawer = useSideDrawer()
    drawer.open('doc', { commandName: '/fix' })
    const wrapper = mount(CommandDocPanel, {
      props: { sessionId: 's1' },
      global: { stubs: { MarkdownRenderer: mdStub } }, // Button 真渲染（点击链）
    })
    await flushPromises()
    const openDir = wrapper.find('[data-testid="command-doc-open-dir"]')
    expect(openDir.exists()).toBe(true)
    await openDir.trigger('click')
    expect(revealMock).toHaveBeenCalledTimes(1)
    expect(revealMock).toHaveBeenCalledWith('/proj/.taiji/skills/fix/SKILL.md')
    wrapper.unmount()

    // ~ 前缀路径（settings.skills 兜底）→ 无 homedir 不展开，不出动作只显路径
    drawer.open('doc', { commandName: '/skill:fix' })
    const wrapper2 = mount(CommandDocPanel, {
      props: { sessionId: 's1' },
      global: { stubs: { MarkdownRenderer: mdStub } },
    })
    await flushPromises()
    const failed2 = wrapper2.find('[data-testid="command-doc-load-failed"]')
    expect(failed2.exists()).toBe(true)
    expect(failed2.text()).toContain('~/.agents/skills/fix/SKILL.md')
    expect(wrapper2.find('[data-testid="command-doc-open-dir"]').exists()).toBe(false)
    warnSpy.mockRestore()
    wrapper2.unmount()
  })

  it('[RD-2#4] 切换 skill 命令：新请求在途 → loading 行 + 旧正文不残留（切换即清，防串内容误读）', async () => {
    const commandStore = useCommandStore()
    commandStore.applyCommands('s1', [
      {
        name: '/fix', description: '修复问题', source: 'skill',
        sourceInfo: { path: '/proj/.taiji/skills/fix/SKILL.md', source: 'skill', scope: 'project' },
      },
      {
        name: '/deploy', description: '部署', source: 'skill',
        sourceInfo: { path: '/proj/.taiji/skills/deploy/SKILL.md', source: 'skill', scope: 'project' },
      },
    ])
    const settings = getSettingsStore()
    settings.skills.value = [] as typeof settings.skills.value
    readMock.mockResolvedValue({ content: '# Fix body', truncated: false })

    const drawer = useSideDrawer()
    drawer.open('doc', { commandName: '/fix' })
    const wrapper = mount(CommandDocPanel, {
      props: { sessionId: 's1' },
      global: { stubs: { MarkdownRenderer: mdStub, Button: true } },
    })
    await flushPromises()
    expect(wrapper.find('.md-stub').text()).toContain('Fix body')

    // 切到 /deploy：file.read 挂起在途
    let resolveDeploy!: (v: { content: string; truncated: boolean }) => void
    readMock.mockImplementation((path: string) =>
      path.endsWith('deploy/SKILL.md')
        ? new Promise((r) => { resolveDeploy = r })
        : Promise.resolve({ content: '# Fix body', truncated: false }),
    )
    drawer.open('doc', { commandName: '/deploy' })
    await nextTick()

    // 头部已是 /deploy，正文不残留 Fix body + loading 行可见
    expect(wrapper.text()).toContain('/deploy')
    expect(wrapper.find('.md-stub').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('Fix body')
    expect(wrapper.find('[data-testid="command-doc-loading"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('加载中')

    resolveDeploy({ content: '# Deploy body', truncated: false })
    await flushPromises()
    expect(wrapper.find('.md-stub').text()).toContain('Deploy body')
    wrapper.unmount()
  })

  it('[RD-2#3] 读取成功但正文为空（frontmatter 后无 body）→ 仍显「无文档正文」空态（不误报失败）', async () => {
    await setup('s1')
    readMock.mockResolvedValue({ content: '---\nname: fix\n---\n', truncated: false })
    const drawer = useSideDrawer()
    drawer.open('doc', { commandName: '/fix' })
    const wrapper = mount(CommandDocPanel, {
      props: { sessionId: 's1' },
      global: { stubs: { MarkdownRenderer: mdStub, Button: true } },
    })
    await flushPromises()
    expect(wrapper.find('[data-testid="command-doc-load-failed"]').exists()).toBe(false)
    expect(wrapper.text()).toContain('无文档正文')
    wrapper.unmount()
  })
})

// ======================================================================
// ← __tests__/markdown-renderer-fallback.test.ts
// ======================================================================

// deps.renderMarkdownIncremental stub：reject 模拟渲染失败（shiki/markdown-it 异常）
const mockRenderMarkdown = vi.fn()
const mockRenderMarkdownIncremental = vi.fn()

function mountMd(props: Record<string, unknown>) {
  return mount(MarkdownRenderer, {
    props: props as never,
    global: {
      provide: mockChatProvide({ renderMarkdown: mockRenderMarkdown, renderMarkdownIncremental: mockRenderMarkdownIncremental }),
      // AmbiguousFilePopover stub 返回注释 vnode（不占 .md-render 直接子节点，避免空内容计数断言受影响）
      stubs: {
        MermaidRenderer: true,
        AmbiguousFilePopover: { name: 'AmbiguousFilePopover', render: () => null },
      },
    },
  })
}

// H2 后 MarkdownRenderer watch 改用 rAF 调度渲染。此降级用例不验证节流时序，
// 只需 rAF 回调同步执行（mount 后 nextTick 即渲染完成）。
const _originalRAF = globalThis.requestAnimationFrame
const _originalCAF = globalThis.cancelAnimationFrame
beforeAll(() => {
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
    cb(0)
    return 0
  }) as typeof requestAnimationFrame
  globalThis.cancelAnimationFrame = (() => {}) as typeof cancelAnimationFrame
})
afterAll(() => {
  globalThis.requestAnimationFrame = _originalRAF
  globalThis.cancelAnimationFrame = _originalCAF
})

describe('MarkdownRenderer 渲染失败降级为纯文本（W1）', () => {
  beforeEach(() => {
    mockRenderMarkdown.mockReset()
    mockRenderMarkdownIncremental.mockReset()
  })

  it('renderMarkdown reject 时 → 降级为纯文本 segment，内容可见', async () => {
    // 模拟渲染失败（shiki 加载异常等）
    mockRenderMarkdownIncremental.mockRejectedValue(new Error('shiki load failed'))
    const content = '这是一条普通消息内容'

    const wrapper = mountMd({ content })
    // watch 是 async（await renderMarkdown），多 tick 等 reject 落定
    await nextTick()
    await nextTick()
    await nextTick()

    // 关键断言：降级后消息内容应在 DOM 中可见（当前 reject 后 segments=[]，DOM 空白，红灯）
    expect(wrapper.text()).toContain('这是一条普通消息内容')
  })

  it('降级 segment 是 text 类型（非 mermaid），走 v-html 安全渲染', async () => {
    mockRenderMarkdownIncremental.mockRejectedValue(new Error('parse error'))
    const content = 'hello world'

    const wrapper = mountMd({ content })
    await nextTick()
    await nextTick()
    await nextTick()

    // 关键断言：降级应产出 text segment（非 mermaid），无 MermaidRenderer 渲染节点
    expect(wrapper.find('.stub-mermaid').exists()).toBe(false)
    // 内容可见（当前空白，红灯）
    expect(wrapper.text()).toContain('hello world')
  })

  it('降级时 HTML 特殊字符被转义（XSS 安全 + 可读）', async () => {
    mockRenderMarkdownIncremental.mockRejectedValue(new Error('boom'))
    // 内容含 HTML 特殊字符（模拟恶意 / 含代码尖括号的内容）
    const content = '<script>alert(1)</script> & <b>bold</b>'

    const wrapper = mountMd({ content })
    await nextTick()
    await nextTick()
    await nextTick()

    // 关键断言 1：原文文本可见（转义后仍是这些字符，只是不再被当 HTML 执行）
    expect(wrapper.text()).toContain('<script>alert(1)</script>')
    expect(wrapper.text()).toContain('<b>bold</b>')
    // 关键断言 2：降级 segment 走 v-html 但内容已转义，不会真的注入 <script> 元素
    // （若未转义，DOM 里会有一个真的 <script> 节点）
    expect(wrapper.find('script').exists()).toBe(false)
  })

  it('空内容不触发降级（空内容 segments=[] 是正常行为，非渲染失败）', async () => {
    // 空内容走早期 return（segments=[]），不应进入 catch 降级
    mockRenderMarkdownIncremental.mockRejectedValue(new Error('should not reach'))
    const wrapper = mountMd({ content: '' })
    await nextTick()
    await nextTick()

    // 空内容 → segments 空，DOM 无内容（正常行为，非降级路径，应通过）
    expect(wrapper.findAll('.md-render > *')).toHaveLength(0)
  })
})

// ======================================================================
// ← composables/features/chat/__tests__/useSessionEvents.test.ts
// ======================================================================

function sessionMsg(type: string): ServerMessage {
  return { type, payload: { sessionId: 'sess-rd15' } } as unknown as ServerMessage
}

/** 挂一个注册了指定 handler 集的宿主组件（useSessionEvents 必须在组件 setup 内调用） */
function mountHost(sid: string, register: (onMessage: ReturnType<typeof useSessionEvents>) => void) {
  const sidRef = ref(sid)
  const Host = defineComponent({
    setup() {
      register(useSessionEvents(sidRef))
      return () => h('div')
    },
  })
  return mount(Host)
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('useSessionEvents — 逐 handler 隔离（RD-1#5）', () => {
  it('首个 handler 抛错：同帧后续 handler 仍执行 + console.warn 记录', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const first = vi.fn(() => { throw new Error('handler boom') })
    const second = vi.fn()
    const wrapper = mountHost('sess-rd15-a', (onMessage) => {
      onMessage('session.commands', first)
      onMessage('session.commands', second)
    })
    events.dispatchSession('sess-rd15-a', sessionMsg('session.commands'))
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(1)
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy.mock.calls[0]?.[0]).toContain('session.commands')
    wrapper.unmount()
  })

  it('异常帧后订阅保持活跃：下一帧各 handler 照常分发', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const first = vi.fn(() => { throw new Error('handler boom') })
    const second = vi.fn()
    const wrapper = mountHost('sess-rd15-b', (onMessage) => {
      onMessage('session.commands', first)
      onMessage('session.commands', second)
    })
    events.dispatchSession('sess-rd15-b', sessionMsg('session.commands'))
    events.dispatchSession('sess-rd15-b', sessionMsg('session.commands'))
    expect(first).toHaveBeenCalledTimes(2)
    expect(second).toHaveBeenCalledTimes(2)
    wrapper.unmount()
  })

  it('未命中白名单的 type 不分发（回归锚：隔离改造不放宽 type 过滤）', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const handler = vi.fn()
    const wrapper = mountHost('sess-rd15-c', (onMessage) => {
      onMessage('session.commands', handler)
    })
    events.dispatchSession('sess-rd15-c', sessionMsg('session.state_changed'))
    expect(handler).not.toHaveBeenCalled()
    wrapper.unmount()
  })
})
