/**
 * UserBubble.vue 组件测试（W4TC3）。
 *
 * 覆盖：
 * - W4TC3: UserBubble 拆分后渲染一致（展示态/编辑态 + badge + hover actions）
 * - [pin-identity U2] D2 turnKey 负载断言 + D3 卸载清理（编辑态 unmount → emit {editing:false, turnKey}）
 * - [MF-1] slash 段按归位序渲染为 `/name` 纯文本；**段序仅含 slash/text 段**时气泡文本
 *   === segmentsToText(同段)（含 badge 段时不等价的两条并存原因——边界空格不显式渲染 +
 *   展示投影 ≠ 序列化——见本文件下方 [MF-1] 组注释，文件头不复述原因以免口径分叉）
 * - [MF-2] submitEdit 编辑含命令的消息后 prompt 中命令只出现一次
 * - [chat-flow-timestamp U2] turn.user.timestamp 行尾时刻（设计 §3 A4）：展示态 user-timestamp 槽显本地时刻；
 *   编辑态不渲染该槽
 *
 * 运行：cd packages/ui && npx vitest run src/features/chat/__tests__/UserBubble.test.ts
 */
import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { UserBubble, ChatViewDepsKey } from '@xyz-agent/ui'
import type { MessageTurn } from '@xyz-agent/core/domain/chat'
import type { Message, Segment } from '@xyz-agent/shared'
import { buildSkillMarker, segmentsToPrompt, segmentsToText } from '@xyz-agent/shared'
import { createMockDeps, mockChatProvide } from './helpers'

const NOW = Date.now()

function makeTurn(over: Partial<MessageTurn> = {}): MessageTurn {
  return {
    index: 1,
    user: { id: 'u1', role: 'user', content: 'hello world', status: 'complete', timestamp: NOW },
    assistants: [],
    isStreaming: false,
    hasFoldable: false,
    ...over,
  }
}

function mountBubble(props: {
  turn?: MessageTurn
  sessionId?: string
  canEdit?: boolean
  isSessionEditable?: boolean
} = {}) {
  return mount(UserBubble, {
    props: {
      turn: props.turn ?? makeTurn(),
      sessionId: props.sessionId ?? 's1',
      canEdit: props.canEdit ?? false,
      isSessionEditable: props.isSessionEditable ?? false,
    },
    global: {
      provide: mockChatProvide(),
      stubs: { MarkdownRenderer: true, ImageThumb: true },
    },
  })
}

describe('W4TC3: UserBubble 展示态', () => {
  it('user 气泡存在且含 content 文本', () => {
    const wrapper = mountBubble()
    // 气泡容器：rounded + border + bg-surface-hover
    const bubble = wrapper.find('.rounded-\\[14px_14px_4px_14px\\]')
    expect(bubble.exists()).toBe(true)
    expect(bubble.classes()).toContain('bg-\[var\(--bubble-bg\)\]')
  })

  it('展示态 hover actions 容器存在（group-hover 可见）', () => {
    const wrapper = mountBubble()
    // hover actions 容器：opacity-0 group-hover:opacity-100
    const actions = wrapper.find('.group\\/user .opacity-0')
    expect(actions.exists()).toBe(true)
    // 容器内至少有 1 个 button（复制）
    expect(actions.findAll('button').length).toBeGreaterThanOrEqual(1)
  })

  it('canEdit=true + 非 sessionEditable → 编辑按钮存在', () => {
    const wrapper = mountBubble({ canEdit: true, isSessionEditable: false })
    // hover actions 容器内有 2 个 button（复制 + 编辑）
    const actions = wrapper.find('.group\\/user .opacity-0')
    expect(actions.findAll('button').length).toBe(2)
  })

  it('canEdit=false → 只有复制按钮', () => {
    const wrapper = mountBubble({ canEdit: false })
    const actions = wrapper.find('.group\\/user .opacity-0')
    expect(actions.findAll('button').length).toBe(1)
  })

  it('isSessionEditable=true → 只有复制按钮（活跃态禁止编辑）', () => {
    const wrapper = mountBubble({ canEdit: true, isSessionEditable: true })
    const actions = wrapper.find('.group\\/user .opacity-0')
    expect(actions.findAll('button').length).toBe(1)
  })
})

describe('W4TC3: UserBubble skill badge', () => {
  it('Segment[] content 含 skill segment → 渲染紫色 badge', () => {
    const segments: Segment[] = [
      { type: 'skill', name: 'code-review' } as Segment,
      { type: 'text', text: 'please review' } as Segment,
    ]
    const wrapper = mountBubble({
      turn: makeTurn({
        user: { id: 'u1', role: 'user', content: segments, status: 'complete', timestamp: NOW } as Message,
      }),
    })
    // skill badge 存在（text-reasoning class）
    const badge = wrapper.find('.text-reasoning')
    expect(badge.exists()).toBe(true)
    expect(badge.text()).toContain('code-review')
  })

  it('Segment[] content 含 file segment → 渲染绿色 file badge', () => {
    const segments: Segment[] = [
      { type: 'file', path: '/tmp/foo.ts', lineRange: [1, 10] } as Segment,
    ]
    const wrapper = mountBubble({
      turn: makeTurn({
        user: { id: 'u1', role: 'user', content: segments, status: 'complete', timestamp: NOW } as Message,
      }),
    })
    // file badge 存在（text-success class）
    const badge = wrapper.find('.text-success')
    expect(badge.exists()).toBe(true)
    expect(badge.text()).toContain('foo.ts')
  })

  // ── U2b：session / subagent 段徽标（四符号 # / @）──

  it('Segment[] content 含 session segment → 渲染 # label 徽标（warn 色，title 悬浮 sessionId）', () => {
    const segments: Segment[] = [
      { type: 'text', text: '参考 ' },
      { type: 'session', sessionId: '019e-abc', label: '设计讨论' } as Segment,
    ]
    const wrapper = mountBubble({
      turn: makeTurn({
        user: { id: 'u1', role: 'user', content: segments, status: 'complete', timestamp: NOW } as Message,
      }),
    })
    const badge = wrapper.find('[data-testid="msg-session-badge-1"]')
    expect(badge.exists()).toBe(true)
    // 徽标显示 # + label（人可读标题，非 uuid）
    expect(badge.text()).toContain('#')
    expect(badge.text()).toContain('设计讨论')
    expect(badge.classes()).toContain('text-warn')
    expect(badge.attributes('title')).toBe('019e-abc')
  })

  it('Segment[] content 含 subagent segment → 渲染 @slug 去向徽标（accent 色，序列化空串仅作标记）', () => {
    const segments: Segment[] = [
      { type: 'subagent', subagentId: 'rec-1', slug: 'build-api' } as Segment,
      { type: 'text', text: '汇报进度' },
    ]
    const wrapper = mountBubble({
      turn: makeTurn({
        user: { id: 'u1', role: 'user', content: segments, status: 'complete', timestamp: NOW } as Message,
      }),
    })
    const badge = wrapper.find('[data-testid="msg-subagent-badge-0"]')
    expect(badge.exists()).toBe(true)
    expect(badge.text()).toContain('@build-api')
    expect(badge.classes()).toContain('text-accent')
  })
})

// ── [MF-1] slash 段渲染：命令文本不消失 + live ≡ reload ──
// live content 段序是 DOM 序（命令 chip 就地插，D4-a），reload 侧是 textToSegments(归位文本)
// 的单 text 段（apply-entry-convert）；气泡只有按归位序渲染 slash 段为 `/name` 纯文本，
// 两侧可见文本才逐字一致（AGENTS.md 关键规则 9）。默认 MarkdownRenderer stub 不渲染
// content，无法断言气泡可见文本，故本组改用渲染 content 的 stub。
//
// **等价锁的范围（轮 3-4 收窄）**：`text() === segmentsToText(段)` 只在**段序仅含 slash/text
// 段**（无 badge 类型段）时成立——`UserBubble.boundarySpaceBefore` 只对 prev 为 slash 时渲染
// 边界空格、且只有 slash 段按纯文本渲染；一旦含 badge 段就不等价：file 显示
// `fileBasename(path)`、session 显示 `label`（序列化为 `#sessionId`）、skill/subagent 显示
// name/slug、image 显示缩略图，均 ≠ 序列化形态；且 `segmentsToText` 经 `needsBoundarySpace`
// 对 chip→text 边界补空格，气泡只对 prev 为 slash 时渲染空格、其余 badge 走自身 `mr-1` 间距
// ——两条原因并存。该展示投影与序列化的差异是本分支之前既有（登记于
// docs/design/composer-multi-skill-injection.md §3.5-⑤ 的「normalizeContent 纯文本投影面」），
// 不在本组用例锁定范围。
//
// **等价锁的层次（轮 3-5 复审 N-3a）**：本锁在下方 `MarkdownContentStub`（显式注册、只回显
// content prop）下成立——锁定的是**段/序列化层**等价（归位序 + 边界空格 + 命令文本不消失），
// **不是产线 DOM 层等价**：产线 `MarkdownRenderer` 会把正文作为独立 markdown 文档块级渲染，
// 与 reload 侧把「命令 + 正文」作为单文档渲染的块级边界可能不同（段落/换行归属不同）。
// 该产线 markdown 块级渲染边界不在本锁范围（真实 MarkdownRenderer 在本测试环境渲染为空，
// 无法在此证伪或证实）。
describe('[MF-1] UserBubble slash 段（归位序渲染 + live ≡ reload）', () => {
  /** 渲染 content prop 的 MarkdownRenderer stub（默认 stub 不输出文本） */
  const MarkdownContentStub = {
    name: 'MarkdownRenderer',
    props: { content: { type: String, default: '' }, sessionId: { type: String, default: '' } },
    template: '<span>{{ content }}</span>',
  }

  function mountWithSlash(content: Segment[]) {
    return mount(UserBubble, {
      props: {
        turn: makeTurn({
          user: { id: 'u1', role: 'user', content, status: 'complete', timestamp: NOW } as Message,
        }),
        sessionId: 's1',
        canEdit: false,
        isSessionEditable: false,
      },
      global: {
        provide: mockChatProvide(),
        stubs: { MarkdownRenderer: MarkdownContentStub, ImageThumb: true },
      },
    })
  }

  function bubbleText(wrapper: ReturnType<typeof mount>): string {
    return wrapper.find('.rounded-\\[14px_14px_4px_14px\\]').text()
  }

  it('含 slash 段 → 气泡渲染 `/name`（此前无分支，命令文本静默消失）', () => {
    const segments: Segment[] = [
      { type: 'text', text: '总结' },
      { type: 'slash', name: 'compact' },
    ]
    expect(bubbleText(mountWithSlash(segments))).toContain('/compact')
  })

  it('slash 段后接 text 段（段序无 badge 段）渲染文本 === segmentsToText(同段)：命令在前 + 边界空格', () => {
    const segments: Segment[] = [
      { type: 'text', text: '总结' },
      { type: 'slash', name: 'compact' },
    ]
    // 该字符串即 reload 侧 textToSegments(deliveryText) 的渲染文本
    expect(bubbleText(mountWithSlash(segments))).toBe(segmentsToText(segments))
    // 归位序（命令在前）；按 DOM 序渲染会得到 `总结/compact`
    expect(bubbleText(mountWithSlash(segments))).toBe('/compact 总结')
  })

  it('slash-only content（landing `/tasks` 首发）渲染 `/tasks`，与 segmentsToText 一致（单 slash 段退化情形）', () => {
    const segments: Segment[] = [{ type: 'slash', name: 'tasks' }]
    expect(bubbleText(mountWithSlash(segments))).toBe(segmentsToText(segments))
    expect(bubbleText(mountWithSlash(segments))).toBe('/tasks')
  })

  // 对照：badge 段（file）的显示形态 ≠ 序列化文本，故上面的等价锁不覆盖这类边界
  // （file badge 显示 basename，序列化是完整 path；见组注释的登记指向）。
  it('对照 · slash + file + text：slash 仍纯文本，但 file badge 显示 basename ⇒ 与 segmentsToText 不等', () => {
    const segments: Segment[] = [
      { type: 'slash', name: 'compact' },
      { type: 'file', path: 'src/a.ts' },
      { type: 'text', text: '正文' },
    ]
    // 序列化形态：完整路径
    expect(segmentsToText(segments)).toBe('/compact src/a.ts 正文')
    // 气泡文本：slash 纯文本 + file badge（basename）+ text；不等价是既有展示投影差异
    const text = bubbleText(mountWithSlash(segments))
    expect(text).toContain('/compact')
    expect(text).toContain('a.ts')
    expect(text).not.toBe(segmentsToText(segments))
  })
})

describe('W4TC3: UserBubble 编辑态', () => {
  it('canEdit=true 点编辑按钮 → 进入编辑态 + emit edit-state-change', async () => {
    const wrapper = mountBubble({ canEdit: true, isSessionEditable: false })
    // hover actions 容器的第 2 个 button 是编辑
    const actions = wrapper.find('.group\\/user .opacity-0')
    const buttons = actions.findAll('button')
    expect(buttons.length).toBe(2)
    // 点编辑按钮
    await buttons[1].trigger('click')
    // emit edit-state-change（D2：负载携带 turnKey = turnStableId(turn) = 'u1'）
    expect(wrapper.emitted('edit-state-change')).toBeTruthy()
    expect(wrapper.emitted('edit-state-change')![0]).toEqual([{ editing: true, turnKey: 'u1' }])
  })

  it('编辑态渲染 textarea', async () => {
    const wrapper = mountBubble({ canEdit: true, isSessionEditable: false })
    const actions = wrapper.find('.group\\/user .opacity-0')
    const buttons = actions.findAll('button')
    await buttons[1].trigger('click')
    // 编辑态有 textarea
    expect(wrapper.find('textarea').exists()).toBe(true)
  })

  it('编辑态取消 → emit edit-state-change false', async () => {
    const wrapper = mountBubble({ canEdit: true, isSessionEditable: false })
    const actions = wrapper.find('.group\\/user .opacity-0')
    const buttons = actions.findAll('button')
    await buttons[1].trigger('click')
    // 编辑态内有取消按钮（variant="ghost"）
    const editButtons = wrapper.findAll('button')
    const cancelBtn = editButtons.find(b => b.text().includes('panel.message.cancel'))
    expect(cancelBtn).toBeDefined()
    await cancelBtn!.trigger('click')
    // 最后一次 emit 是 false（D2：负载携带 turnKey）
    const events = wrapper.emitted('edit-state-change')!
    expect(events[events.length - 1]).toEqual([{ editing: false, turnKey: 'u1' }])
  })

  // D3 卸载清理（C2 检查点）：编辑态中组件卸载时必须补发解除信号——切 session 等
  // 路径卸载本组件时 watch 随作用域失效、显式清理动作不会执行，父组件钉扎状态
  // 只能靠这条 emit 复位。C2 实测：onUnmounted 内 emit 父监听器可达。
  it('编辑态中卸载 → 父组件收到 { editing: false, turnKey }（D3 卸载清理）', async () => {
    const wrapper = mountBubble({ canEdit: true, isSessionEditable: false })
    const actions = wrapper.find('.group\\/user .opacity-0')
    const buttons = actions.findAll('button')
    await buttons[1].trigger('click')
    expect(wrapper.emitted('edit-state-change')!.length).toBe(1)
    // 不退出编辑直接卸载（模拟切 session 时 UserBubble 被连根卸载）
    wrapper.unmount()
    // test-utils 的 wrapper.unmount() 会先 removeEventHistory 清掉卸载前的 emit 记录，
    // 故数组里只剩卸载流程中钩子补发的那一条——恰好证明它来自卸载清理而非先前操作
    expect(wrapper.emitted('edit-state-change')).toEqual([[{ editing: false, turnKey: 'u1' }]])
  })
})

// ── [D3] submitEdit 双发锁（isPendingSend 互斥，adversarial-review-fixes u3）──
// 防 send 与 editAndResend 并发覆盖 useChat 的 pendingDirectSends（per-sid 单条 Map）：
// 提交在途（pendingSend 瞬时态）时 submitEdit 直接 return——编辑态保持、草稿不丢。

describe('[D3] submitEdit 双发锁', () => {
  /** 进入编辑态并输入草稿；返回 wrapper + editAndResend spy */
  async function enterEditAndType(provideOverrides: Parameters<typeof mockChatProvide>[0], draft: string) {
    const editAndResend = vi.fn()
    const wrapper = mount(UserBubble, {
      props: { turn: makeTurn(), sessionId: 's1', canEdit: true, isSessionEditable: false },
      global: {
        provide: mockChatProvide({ editAndResend, ...provideOverrides }),
        stubs: { MarkdownRenderer: true, ImageThumb: true },
      },
    })
    const actions = wrapper.find('.group\\/user .opacity-0')
    await actions.findAll('button')[1]!.trigger('click')
    await wrapper.find('textarea').setValue(draft)
    return { wrapper, editAndResend }
  }

  /** 编辑态里的发送按钮（文本 = t key panel.composer.send） */
  function findSendButton(wrapper: ReturnType<typeof mount>) {
    const btn = wrapper.findAll('button').find(b => b.text().includes('panel.composer.send'))
    expect(btn).toBeDefined()
    return btn!
  }

  it('isPendingSend=true（提交在途）→ submitEdit 早退：不提交 + 编辑态保持 + 草稿不丢', async () => {
    const { wrapper, editAndResend } = await enterEditAndType({ isPendingSend: () => true }, '编辑后的内容')
    await findSendButton(wrapper).trigger('click')
    expect(editAndResend).not.toHaveBeenCalled()
    // 早退置于 editingUserId=null 之前：编辑态保持、draftText 保留（提交收口后可重试）
    expect(wrapper.find('textarea').exists()).toBe(true)
    expect((wrapper.find('textarea').element as HTMLTextAreaElement).value).toBe('编辑后的内容')
  })

  it('isPendingSend=false → 正常提交（segments 重建 + editAndResend）+ 编辑态收口', async () => {
    const { wrapper, editAndResend } = await enterEditAndType({ isPendingSend: () => false }, '编辑后的内容')
    await findSendButton(wrapper).trigger('click')
    expect(editAndResend).toHaveBeenCalledTimes(1)
    expect(editAndResend).toHaveBeenCalledWith('s1', 'u1', [{ type: 'text', text: '编辑后的内容' }])
    expect(wrapper.find('textarea').exists()).toBe(false)
  })

  it('未 provide isPendingSend（旧壳层兼容降级）→ 不互斥照常提交', async () => {
    const editAndResend = vi.fn()
    const deps = createMockDeps({ editAndResend })
    delete (deps as { isPendingSend?: unknown }).isPendingSend
    const wrapper = mount(UserBubble, {
      props: { turn: makeTurn(), sessionId: 's1', canEdit: true, isSessionEditable: false },
      global: {
        provide: { [ChatViewDepsKey as symbol]: deps },
        stubs: { MarkdownRenderer: true, ImageThumb: true },
      },
    })
    const actions = wrapper.find('.group\\/user .opacity-0')
    await actions.findAll('button')[1]!.trigger('click')
    await wrapper.find('textarea').setValue('降级提交')
    await findSendButton(wrapper).trigger('click')
    expect(editAndResend).toHaveBeenCalledTimes(1)
  })
})

// ── [MF-2] submitEdit 编辑含命令的消息：prompt 中命令只出现一次 ──
// 草稿展示归位全文（命令可见、可改）；提交时 rebuildSegmentsWithEditedText 剥离与 slash 段
// 重复的前缀命令并保留 slash 段，避免序列化归位后命令翻倍（`/compact /compact …`）。
describe('[MF-2] submitEdit 编辑重发 slash 段不翻倍', () => {
  /** 挂载含 live content = [text('总结'), slash('compact')] 的气泡（DOM 序，命令 chip 就地插） */
  function mountCommandMessage(prompts: string[]) {
    const editAndResend = vi.fn((_sid: string, _uid: string, segs: Segment[]) => {
      prompts.push(segmentsToPrompt(segs))
    })
    const segments: Segment[] = [
      { type: 'text', text: '总结' },
      { type: 'slash', name: 'compact' },
    ]
    const wrapper = mount(UserBubble, {
      props: {
        turn: makeTurn({
          user: { id: 'u1', role: 'user', content: segments, status: 'complete', timestamp: NOW } as Message,
        }),
        sessionId: 's1',
        canEdit: true,
        isSessionEditable: false,
      },
      global: {
        provide: mockChatProvide({ editAndResend }),
        stubs: { MarkdownRenderer: true, ImageThumb: true },
      },
    })
    return wrapper
  }

  it('草稿展示归位全文（命令可见可改）→ 直接发送：prompt = `/compact 总结`（命令仅一次）', async () => {
    const prompts: string[] = []
    const wrapper = mountCommandMessage(prompts)
    await wrapper.find('.group\\/user .opacity-0').findAll('button')[1]!.trigger('click')
    expect((wrapper.find('textarea').element as HTMLTextAreaElement).value).toBe('/compact 总结')
    const sendBtn = wrapper.findAll('button').find((b) => b.text().includes('panel.composer.send'))
    expect(sendBtn).toBeDefined()
    await sendBtn!.trigger('click')
    // 修复前为 `/compact /compact 总结`（命令翻倍）；现在命令只由 slash 段承担一次
    expect(prompts).toEqual(['/compact 总结'])
    expect(prompts[0]!.split('/compact').length - 1).toBe(1)
  })

  it('用户改了正文后发送：prompt 命令仍仅一次且与命令名一致', async () => {
    const prompts: string[] = []
    const wrapper = mountCommandMessage(prompts)
    await wrapper.find('.group\\/user .opacity-0').findAll('button')[1]!.trigger('click')
    await wrapper.find('textarea').setValue('/compact 总结一下')
    const sendBtn = wrapper.findAll('button').find((b) => b.text().includes('panel.composer.send'))
    await sendBtn!.trigger('click')
    expect(prompts).toEqual(['/compact 总结一下'])
    expect(prompts[0]!.split('/compact').length - 1).toBe(1)
  })

  it('用户改命令名（/compact → /goal）：prompt 只含新命令，旧命令不残留', async () => {
    const prompts: string[] = []
    const wrapper = mountCommandMessage(prompts)
    await wrapper.find('.group\\/user .opacity-0').findAll('button')[1]!.trigger('click')
    await wrapper.find('textarea').setValue('/goal 总结')
    const sendBtn = wrapper.findAll('button').find((b) => b.text().includes('panel.composer.send'))
    await sendBtn!.trigger('click')
    expect(prompts).toEqual(['/goal 总结'])
  })
})

// ── [轮 3 收口] submitEdit 编辑含 skill 段的消息：prompt 中标记只出现一次 ──
// 草稿由 normalizeContent 回填标记文本（视觉退化，已登记 §3.5-⑤②）；提交时
// rebuildSegmentsWithEditedText 剥离编辑稿中与该段重复的标记并保留段——修复前标记翻倍，
// runtime 注入器按标记逐个展开 ⇒ 同一 SKILL.md 注入两遍。
describe('[轮 3] submitEdit 编辑重发 skill 段标记不翻倍', () => {
  const SKILL: Segment = { type: 'skill', name: 'review', location: '/skills/review/SKILL.md' }
  const MARKER = buildSkillMarker('review', '/skills/review/SKILL.md')

  /** 挂载含 live content = [text('正文'), skill] 的气泡（D4-a：chip 就地插在正文之后） */
  function mountSkillMessage(prompts: string[]) {
    const editAndResend = vi.fn((_sid: string, _uid: string, segs: Segment[]) => {
      prompts.push(segmentsToPrompt(segs))
    })
    const segments: Segment[] = [{ type: 'text', text: '正文' }, SKILL]
    return mount(UserBubble, {
      props: {
        turn: makeTurn({
          user: { id: 'u1', role: 'user', content: segments, status: 'complete', timestamp: NOW } as Message,
        }),
        sessionId: 's1',
        canEdit: true,
        isSessionEditable: false,
      },
      global: {
        provide: mockChatProvide({ editAndResend }),
        stubs: { MarkdownRenderer: true, ImageThumb: true },
      },
    })
  }

  async function submitDraft(wrapper: ReturnType<typeof mount>, draft?: string) {
    await wrapper.find('.group\\/user .opacity-0').findAll('button')[1]!.trigger('click')
    if (draft !== undefined) await wrapper.find('textarea').setValue(draft)
    const sendBtn = wrapper.findAll('button').find((b) => b.text().includes('panel.composer.send'))
    expect(sendBtn).toBeDefined()
    await sendBtn!.trigger('click')
  }

  it('草稿回填标记文本 → 直接提交：prompt 标记仅一次（修复前为两次）', async () => {
    const prompts: string[] = []
    const wrapper = mountSkillMessage(prompts)
    await wrapper.find('.group\\/user .opacity-0').findAll('button')[1]!.trigger('click')
    expect((wrapper.find('textarea').element as HTMLTextAreaElement).value).toBe(`正文${MARKER}`)
    const sendBtn = wrapper.findAll('button').find((b) => b.text().includes('panel.composer.send'))
    await sendBtn!.trigger('click')
    expect(prompts).toEqual([`正文${MARKER}`])
    expect(prompts[0]!.split('<xyz-skill').length - 1).toBe(1)
  })

  it('用户只改正文后提交：prompt 标记仍仅一次且正文更新', async () => {
    const prompts: string[] = []
    const wrapper = mountSkillMessage(prompts)
    await submitDraft(wrapper, `改后的正文${MARKER}`)
    expect(prompts).toEqual([`改后的正文${MARKER}`])
    expect(prompts[0]!.split('<xyz-skill').length - 1).toBe(1)
  })

  it('用户删掉标记只留正文：prompt 无标记（段不被复活）', async () => {
    const prompts: string[] = []
    const wrapper = mountSkillMessage(prompts)
    await submitDraft(wrapper, '改后的正文')
    expect(prompts).toEqual(['改后的正文'])
    expect(prompts[0]!.split('<xyz-skill').length - 1).toBe(0)
  })
})

/* ── [chat-flow-timestamp U2] UserBubble 行尾时刻（设计 §3 A4）──
 * turn.user.timestamp 有值 → 气泡左侧 user-timestamp 槽显本地时刻；编辑态（textarea 分支）
 * 与展示态是 v-if / v-else 互斥分支，编辑态下整个展示分支（含时间槽）被替换。
 * 期望时刻用本地 Date getter 构造（clockOf，与 formatClock 同口径；禁硬编码时区串）。 */
function clockOf(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

describe('chat-flow-timestamp U2: UserBubble 行尾时刻（A4）', () => {
  // 固定 epoch（非 Date.now()）：失败时可复现的确定值
  const USER_TS = 1700000000000

  function makeTurnWithTs(): MessageTurn {
    return makeTurn({
      user: { id: 'u1', role: 'user', content: 'hello world', status: 'complete', timestamp: USER_TS },
    })
  }

  it('turn.user.timestamp 有值 → user-timestamp 槽文本 = formatClock(该值)（本地时刻）', () => {
    const wrapper = mountBubble({ turn: makeTurnWithTs() })
    const slot = wrapper.find('[data-testid="user-timestamp"]')
    expect(slot.exists()).toBe(true)
    expect(slot.text().replace(/\s+/g, '')).toBe(clockOf(USER_TS))
  })

  it('编辑态不渲染 user-timestamp 槽（v-if/v-else 互斥：编辑分支替换含时间槽的展示分支）', async () => {
    // 编辑态触发与上方编辑态组同款：canEdit=true + 非 sessionEditable + hover actions 第 2 个按钮
    // （该触发在本测试环境轻量可行，故直测而非仅靠 v-if 语义说明）
    const wrapper = mountBubble({ turn: makeTurnWithTs(), canEdit: true, isSessionEditable: false })
    const actions = wrapper.find('.group\\/user .opacity-0')
    await actions.findAll('button')[1]!.trigger('click')
    // 已进入编辑态（textarea 渲染）
    expect(wrapper.find('textarea').exists()).toBe(true)
    expect(wrapper.find('[data-testid="user-timestamp"]').exists()).toBe(false)
  })
})
