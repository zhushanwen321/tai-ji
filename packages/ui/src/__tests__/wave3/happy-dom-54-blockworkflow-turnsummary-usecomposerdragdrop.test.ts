import { makeToolCall, mountToolBlock, mockChatProvide } from '../../features/chat/__tests__/helpers';
import type { MessageTurn } from '@taiji/core/domain/chat';
import { useComposerDragDrop } from '@taiji/dom-core/composer/input';
import type { ToolCall, Message } from '@taiji/shared';
import { Block, TurnSummary, type ChatViewDeps } from '@taiji/ui';
import { mount } from '@vue/test-utils';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ref, effectScope } from 'vue';

// wave3 簇 [ui/happy-dom] 3 文件
/**
 * 合并产物（round6 Wave3 机械合并，环境/簇信息见来源横幅）。
 * 重名顶层标识符已加 _mN 后缀；相对 import 已按产物位置改写。
 * 来源文件：
 * - features/chat/__tests__/BlockWorkflow.test.ts
 * - features/chat/__tests__/TurnSummary.test.ts
 * - features/composer/__tests__/useComposerDragDrop.test.ts
 */

// ======================================================================
// ← features/chat/__tests__/BlockWorkflow.test.ts
// ======================================================================

// mock drawer 协同层：断言点击 workflow 块时 openWorkflow(name, { slug, sessionId }) 被调
//（workflow-visualization U6/D1 入口改向后 = 开 overlay；chips 反查经 lookupWorkflowRun）
const { openWorkflowMock, lookupWorkflowRunMock } = vi.hoisted(() => ({
  openWorkflowMock: vi.fn(),
  lookupWorkflowRunMock: vi.fn(),
}))
vi.mock('@taiji/core/domain/drawer', () => ({
  openWorkflow: openWorkflowMock,
  lookupWorkflowRun: lookupWorkflowRunMock,
}))

function makeWorkflow(over: Partial<ToolCall> = {}): ToolCall {
  return makeToolCall({
    id: 'tc-wf-1',
    toolName: 'workflow',
    input: {
      action: 'run',
      name: 'email-validation-refactor',
      slug: 'email-refactor',
      args: { task: '扫描 validator 并替换 regex' },
    },
    ...over,
  })
}

beforeEach(() => {
  openWorkflowMock.mockReset()
  // chips 反查缺省无数据（不渲染；chips 用例内按需覆写返回值）
  lookupWorkflowRunMock.mockReset().mockReturnValue(undefined)
})

describe('BlockWorkflow: 标题行字段（v6 §11：prefix + name · slug）', () => {
  it('run action：header 含 workflow prefix + name + · + slug', () => {
    const wrapper = mountToolBlock(makeWorkflow({ status: 'completed' }))
    const wfBlock = wrapper.find('[data-testid="workflow-block"]')
    expect(wfBlock.exists()).toBe(true)
    // workflow prefix tag
    expect(wrapper.text()).toContain('workflow')
    // name（--name 暖驼，用户裁决 2026-10-06）
    expect(wrapper.text()).toContain('email-validation-refactor')
    // slug（层级灰 --neutral-mid，用户裁决 2026-10-06；· 分隔）
    expect(wrapper.text()).toContain('email-refactor')
    // action 不展示（非 header 字段）
    expect(wrapper.text()).not.toContain('run')
    // args.task 预览不展示（v6 移除）
    expect(wrapper.text()).not.toContain('扫描 validator 并替换 regex')
  })

  it('status action：只渲染 prefix + name（无 action 动词）', () => {
    const wrapper = mountToolBlock(
      makeWorkflow({
        status: 'completed',
        input: { action: 'status', name: 'wf-check' },
      }),
    )
    expect(wrapper.text()).toContain('wf-check')
    // action 动词不展示
    expect(wrapper.text()).not.toContain('status')
  })

  it('无 name 时只渲染 prefix（slug 也没有时不显示分隔符）', () => {
    const wrapper = mountToolBlock(
      makeWorkflow({
        status: 'completed',
        input: { action: 'pause', runId: 'wf-abcd1234-efgh-5678' },
      }),
    )
    expect(wrapper.find('[data-testid="workflow-block"]').exists()).toBe(true)
    // 无 name / 无 slug → header 只剩 prefix
    expect(wrapper.text()).not.toContain('email-validation-refactor')
    // runId 不展示（非 header 字段，完整与截断都不出现）
    expect(wrapper.text()).not.toContain('wf-abcd1')
    expect(wrapper.text()).not.toContain('wf-abcd1234-efgh-5678')
  })

  it('args.task 不展示（长 task 也无截断 …）', () => {
    const longTask = '扫描'.repeat(40) // 80 字符
    const wrapper = mountToolBlock(
      makeWorkflow({
        status: 'completed',
        input: { action: 'run', name: 'wf-x', args: { task: longTask } },
      }),
    )
    // 无截断标记（task 根本不进对话流）
    expect(wrapper.text()).not.toContain('…')
    // 完整长 task 不显示
    expect(wrapper.text()).not.toContain(longTask)
  })

  it('running 态 header 含专属动效图标（workflow 连线行进，RunningBlockIcon）', () => {
    const wrapper = mountToolBlock(makeWorkflow({ status: 'running' }))
    // running 态专属动效（不再用全类型共用 loader）
    expect(wrapper.find('[data-running-icon="workflow"]').exists()).toBe(true)
    expect(wrapper.find('.animate-loader-spin').exists()).toBe(false)
    // 字段仍可见（name）
    expect(wrapper.text()).toContain('email-validation-refactor')
  })

  it('不再渲染旧的状态动词（已完成/运行中/失败）', () => {
    const wrapper = mountToolBlock(makeWorkflow({ status: 'completed' }))
    // 旧 workflowStatusText 已删除，不再出现状态动词
    expect(wrapper.text()).not.toContain('已完成')
    expect(wrapper.text()).not.toContain('运行中')
  })
})

describe('BlockWorkflow: collapsed only（§11：无内联详情展开，GUI 迁至 drawer）', () => {
  it('details.__gui__ 存在也不渲染 GuiComponentRenderer（GUI 渲染迁出 workflow 块）', async () => {
    const wrapper = mountToolBlock(
      makeWorkflow({
        output: 'workflow running',
        details: {
          __gui__: {
            v: 1,
            component: {
              type: 'list-tree',
              props: {
                items: [
                  { label: '扫描 validator', status: 'done' },
                  { label: '替换 regex', status: 'done' },
                  { label: '补充 unit test', status: 'current' },
                ],
              },
            },
          },
        },
      }),
    )
    // workflow 块挂载
    expect(wrapper.find('[data-testid="workflow-block"]').exists()).toBe(true)
    // 点击 header 后也无详情区（collapsed only，点击行为是开 drawer）
    await wrapper.find('[data-testid="tool-block-header"]').trigger('click')
    expect(wrapper.find('[data-testid="gui-renderer-stub"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="ansi-text-stub"]').exists()).toBe(false)
    // output 文本不内联展示
    expect(wrapper.text()).not.toContain('workflow running')
  })

  it('点击整行 → openWorkflow(name, { slug, sessionId })（U6/D1：开 overlay，反查在 renderer opener）', async () => {
    const wrapper = mountToolBlock(makeWorkflow({ status: 'completed' }))
    await wrapper.find('[data-testid="tool-block-header"]').trigger('click')
    expect(openWorkflowMock).toHaveBeenCalledTimes(1)
    // mountToolBlock 不传 sessionId prop → 透传 undefined（opener 回落焦点 pane）
    expect(openWorkflowMock).toHaveBeenCalledWith('email-validation-refactor', {
      slug: 'email-refactor',
      sessionId: undefined,
    })
  })

  it('全路径 name：标题行显示 basename 去 .js 短名，title 保留全路径，点击 openWorkflow 仍传全路径', async () => {
    const fullPath = '/Users/x/project/.pi/workflows/email-validation-refactor.js'
    const wrapper = mountToolBlock(
      makeWorkflow({ status: 'completed', input: { action: 'run', name: fullPath, slug: 'email-refactor' } }),
    )
    const wfBlock = wrapper.find('[data-testid="workflow-block"]')
    expect(wfBlock.exists()).toBe(true)
    // 标题行短名（无目录、无 .js 后缀）
    expect(wfBlock.text()).toContain('email-validation-refactor')
    expect(wfBlock.text()).not.toContain(fullPath)
    expect(wfBlock.text()).not.toContain('.js')
    // title 保留全路径（hover 可见完整 ref）
    const nameSpan = wfBlock.findAll('span').find((s) => s.attributes('title') === fullPath)
    expect(nameSpan).toBeDefined()
    // drawer 选中仍用全路径（行为不变；openWorkflow 两参形态随 main 侧 opener 演化）
    await wrapper.find('[data-testid="tool-block-header"]').trigger('click')
    expect(openWorkflowMock).toHaveBeenCalledWith(fullPath, { slug: 'email-refactor', sessionId: undefined })
  })

  it('无 name 时点击 → openWorkflow(空串, { slug: undefined, ... })（opener 兜底归宿）', async () => {
    const wrapper = mountToolBlock(
      makeWorkflow({
        status: 'completed',
        input: { action: 'status' },
      }),
    )
    await wrapper.find('[data-testid="tool-block-header"]').trigger('click')
    expect(openWorkflowMock).toHaveBeenCalledTimes(1)
    expect(openWorkflowMock).toHaveBeenCalledWith('', { slug: undefined, sessionId: undefined })
  })
})

describe('BlockWorkflow: 多阶段 chips（workflow-visualization U6/P5，phases 折叠快照）', () => {
  const PHASES = [
    { phase: 'gate', startedAt: 1000, settledAt: 2000 },
    { phase: 'review', startedAt: 3000 },
  ]

  function mockLookup(phases: typeof PHASES | undefined): void {
    lookupWorkflowRunMock.mockReturnValue(
      phases === undefined
        ? undefined
        : {
            runId: 'wf-run-1',
            scriptName: 'email-validation-refactor',
            status: 'running',
            startedAt: '2026-10-02T00:00:00Z',
            agentCalls: [],
            stateFilePath: '',
            ...(phases.length > 0 ? { phases } : {}),
          },
    )
  }

  it('反查命中且有 phases → 渲染 mini 管道 chips（phase 名 + 状态点两态）', () => {
    mockLookup(PHASES)
    const wrapper = mountToolBlock(makeWorkflow({ status: 'running' }), { sessionId: 's9' })
    const chips = wrapper.find('[data-testid="workflow-block-chips"]')
    expect(chips.exists()).toBe(true)
    // phase 名可见
    expect(wrapper.text()).toContain('gate')
    expect(wrapper.text()).toContain('review')
    // 两态：settledAt 有值 = settled（success 点）、缺省 = running（accent 点）
    const gate = wrapper.find('[data-testid="workflow-chip-gate"]')
    expect(gate.attributes('data-state')).toBe('settled')
    const review = wrapper.find('[data-testid="workflow-chip-review"]')
    expect(review.attributes('data-state')).toBe('running')
  })

  it('反查未命中 / 旧 run 无 phases → chips 不渲染（collapsed only 形态不变）', () => {
    mockLookup(undefined)
    const miss = mountToolBlock(makeWorkflow({ status: 'completed' }), { sessionId: 's9' })
    expect(miss.find('[data-testid="workflow-block-chips"]').exists()).toBe(false)

    mockLookup([])
    const noPhases = mountToolBlock(makeWorkflow({ status: 'completed' }), { sessionId: 's9' })
    expect(noPhases.find('[data-testid="workflow-block-chips"]').exists()).toBe(false)
  })

  it('反查请求参数 = (sessionId, name, slug)——按块归属 session 分区反查', () => {
    mockLookup(PHASES)
    mountToolBlock(makeWorkflow({ status: 'completed' }), { sessionId: 's9' })
    expect(lookupWorkflowRunMock).toHaveBeenCalledWith(
      's9',
      'email-validation-refactor',
      'email-refactor',
    )
  })
})

// ======================================================================
// ← features/chat/__tests__/TurnSummary.test.ts
// ======================================================================

// 朗读按钮 title 走 i18n（panel.message.speak*，键登记唯一写入者 = u4，locale 文件未落盘时
// 全局 setup 的 t() 返回 key 本身无法断言文案）——按 vitest.setup.ts 指引在测试内 override
// vi.mock('vue-i18n')，提供 speak* 四键测试词表，其余 key 维持「返回 key 本身」行为。
vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string, ...rest: unknown[]) => {
      const table: Record<string, string> = {
        'panel.message.speakTitle': '朗读',
        'panel.message.speakCancel': '取消',
        'panel.message.speakStop': '停止',
        'panel.message.speakStreaming': '回复生成中',
      }
      let result = table[key] ?? key
      const named = typeof rest[0] === 'object' && rest[0] !== null ? (rest[0] as Record<string, unknown>) : undefined
      if (named) {
        for (const [k, v] of Object.entries(named)) result = result.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v))
      }
      return result
    },
    locale: { value: 'zh-CN' },
  }),
}))

const NOW = Date.now()

function makeTurn(over: Partial<MessageTurn> = {}): MessageTurn {
  return {
    index: 1,
    user: { id: 'u1', role: 'user', content: 'hi', status: 'complete', timestamp: NOW },
    assistants: [{ id: 'a1', role: 'assistant', content: 'Here is the result.', status: 'complete', timestamp: NOW }],
    isStreaming: false,
    hasFoldable: false,
    ...over,
  }
}

function mountSummary(props: {
  turn?: MessageTurn
  sessionId?: string
  lastAssistant?: Message | null
  depsOverrides?: Partial<ChatViewDeps>
} = {}) {
  const turn = props.turn ?? makeTurn()
  return mount(TurnSummary, {
    props: {
      turn,
      sessionId: props.sessionId ?? 's1',
      lastAssistant: 'lastAssistant' in props ? (props.lastAssistant ?? null) : (turn.assistants[turn.assistants.length - 1] ?? null),
    },
    global: {
      provide: mockChatProvide(props.depsOverrides ?? {}),
      stubs: {
        MarkdownRenderer: true,
      },
    },
  })
}

describe('W4TC4: TurnSummary 基本渲染', () => {
  it('有 lastAssistant 时 turn-summary 操作栏存在', () => {
    const wrapper = mountSummary()
    expect(wrapper.find('.turn-summary').exists()).toBe(true)
  })

  // [block-rendering M0] 空 content（纯工具 turn）：根 v-if 从 summaryText 改 lastAssistant 后
  // 操作栏仍渲染（预期行为变更，原 summaryText 门控下不渲染）
  it('空 content（纯工具 turn）也渲染 turn-summary + 操作栏（根 v-if 改 lastAssistant）', () => {
    const wrapper = mountSummary({
      turn: makeTurn({ assistants: [{ id: 'a1', role: 'assistant', content: '', status: 'complete', timestamp: NOW }] }),
    })
    expect(wrapper.find('.turn-summary').exists()).toBe(true)
    expect(wrapper.find('[data-testid="copy-btn"]').exists()).toBe(true)
  })
})

describe('W4TC4: TurnSummary hover actions', () => {
  it('有 lastAssistant 时 hover actions 行本体存在 + 4 并列按钮渲染', () => {
    const wrapper = mountSummary()
    // [actions-anchor] 组件根 = 行本体（显隐门控与固定槽位在 Block.vue 的插槽包装层，
    // 本组件维度只验行与按钮形态）
    const actionsDiv = wrapper.find('.turn-summary')
    expect(actionsDiv.exists()).toBe(true)
    // 4 个并列按钮：复制 / 朗读 / fork / handoff（无两层 hover 变体）
    const buttons = actionsDiv.findAll('button')
    expect(buttons.length).toBe(4)
  })

  it('无 lastAssistant 时不渲染 hover actions', () => {
    const wrapper = mountSummary({ lastAssistant: null })
    expect(wrapper.find('[data-testid="fork-ask-btn"]').exists()).toBe(false)
  })

  it('copy-btn 为唯一复制按钮，载荷 = 末条 assistant 正文（仅 text，不含思考/工具分区，2026-10-15 裁决）', async () => {
    const writeText = vi.fn(async (_text: string) => {})
    vi.spyOn(navigator.clipboard, 'writeText').mockImplementation(writeText)
    const last: Message = {
      id: 'a1',
      role: 'assistant',
      status: 'complete',
      timestamp: NOW,
      content: '正文第一行\n\n正文第二行',
      thinking: [{ id: 'th-1', content: '内部推理，不应出现在复制载荷', collapsed: true }],
      toolCalls: [
        { id: 'tc-1', toolName: 'bash', input: { cmd: 'ls' }, status: 'completed', startTime: 0, output: 'file-a.txt' },
      ],
    }
    const wrapper = mountSummary({ lastAssistant: last })
    const btn = wrapper.find('[data-testid="copy-btn"]')
    expect(btn.exists()).toBe(true)
    // MD 徽标已随三分区展平退役：按钮内只有 Copy/Check 图标，无文字角标
    expect(btn.text()).toBe('')
    await btn.trigger('click')
    expect(writeText).toHaveBeenCalledTimes(1)
    const payload = writeText.mock.calls[0]?.[0] ?? ''
    expect(payload).toBe('正文第一行\n\n正文第二行')
    expect(payload).not.toContain('内部推理')
    expect(payload).not.toContain('file-a.txt')
  })

  it('fork-ask-btn 存在（fork 进 composer 模式）', () => {
    const wrapper = mountSummary()
    expect(wrapper.find('[data-testid="fork-ask-btn"]').exists()).toBe(true)
  })

  it('不再渲染 fork-background-btn（已并入 fork-ask 空提交）', () => {
    const wrapper = mountSummary()
    expect(wrapper.find('[data-testid="fork-background-btn"]').exists()).toBe(false)
  })

  it('handoff-ask-btn 存在（handoff 进 composer 模式）', () => {
    const wrapper = mountSummary()
    expect(wrapper.find('[data-testid="handoff-ask-btn"]').exists()).toBe(true)
  })

  it('不再渲染 handoff-btn（已并入 handoff-ask 空提交）', () => {
    const wrapper = mountSummary()
    expect(wrapper.find('[data-testid="handoff-btn"]').exists()).toBe(false)
  })

  it('不再渲染 ⋯ overflow（more-actions-btn）', () => {
    const wrapper = mountSummary()
    expect(wrapper.find('[data-testid="more-actions-btn"]').exists()).toBe(false)
  })

  it('fork/handoff 按钮在 subagent session 隐藏', () => {
    const wrapper = mountSummary({ sessionId: 'subagent:main1:sub1' })
    // subagent session：复制正文 + 朗读 2 按钮形态（复制 = 末条 assistant 正文 text，
    // 2026-10-15 裁决；朗读是只读消费，与复制同类可见），无 fork/handoff
    expect(wrapper.find('[data-testid="fork-ask-btn"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="handoff-ask-btn"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="speak-btn"]').exists()).toBe(true)
    const actionsDiv = wrapper.find('.turn-summary')
    expect(actionsDiv.findAll('button').length).toBe(2)
  })
})

// [block-rendering M0] TC-M0-5：TurnSummary 去内容化门控（streaming-tail 是 Turn.vue 元素，由 turn-working 覆盖）
describe('block-rendering M0: TurnSummary 去内容化', () => {
  it('TC-M0-5a: 有 content 时 .turn-summary 存在但不含 MarkdownRenderer 渲染与 .streaming-cursor', () => {
    const wrapper = mountSummary()
    expect(wrapper.find('.turn-summary').exists()).toBe(true)
    // 文字渲染已移除（MarkdownRenderer stub 不出现）
    expect(wrapper.findComponent({ name: 'MarkdownRenderer' }).exists()).toBe(false)
    // 光标已迁移到 Turn.vue streaming-tail，TurnSummary 内无光标
    expect(wrapper.find('.streaming-cursor').exists()).toBe(false)
  })

  it('TC-M0-5b: 纯工具 turn（lastAssistant 无 content）出现完整操作栏（预期行为变更）', () => {
    const wrapper = mountSummary({
      turn: makeTurn({ assistants: [{ id: 'a1', role: 'assistant', content: '', status: 'complete', timestamp: NOW }] }),
    })
    expect(wrapper.find('.turn-summary').exists()).toBe(true)
    // 4 操作按钮：复制MD / 朗读 / fork / handoff
    const actionsDiv = wrapper.find('.turn-summary')
    expect(actionsDiv.findAll('button').length).toBe(4)
  })
})

// ai-voice-tts §5.1：朗读按钮（u5）——未 provide 不渲染 / 状态机 / 生成中置灰
describe('ai-voice-tts §5.1: 朗读按钮', () => {
  it('deps 两字段未 provide 时朗读按钮不渲染（provide 后渲染）', () => {
    const absent = mountSummary({
      depsOverrides: { onSpeak: undefined, speakStateOf: undefined },
    })
    expect(absent.find('[data-testid="speak-btn"]').exists()).toBe(false)

    const present = mountSummary()
    expect(present.find('[data-testid="speak-btn"]').exists()).toBe(true)
  })

  it('idle 态：按钮可点、title=朗读、点击透传 onSpeak(sessionId, lastAssistant)', async () => {
    const onSpeak = vi.fn()
    const wrapper = mountSummary({ depsOverrides: { onSpeak } })
    const btn = wrapper.find('[data-testid="speak-btn"]')
    expect(btn.attributes('title')).toBe('朗读')
    expect(btn.attributes('disabled')).toBeUndefined()
    // loading/playing 图标形态缺席（Volume2 无 spin 类）
    expect(btn.find('svg.animate-spin').exists()).toBe(false)

    await btn.trigger('click')
    expect(onSpeak).toHaveBeenCalledTimes(1)
    expect(onSpeak).toHaveBeenCalledWith('s1', wrapper.props('lastAssistant'))
  })

  it('loading 态：Loader2 旋转形态 + title=取消；点击仍透传 onSpeak（取消动作分流在装配层）', async () => {
    const onSpeak = vi.fn()
    const wrapper = mountSummary({
      depsOverrides: { onSpeak, speakStateOf: () => 'loading' },
    })
    const btn = wrapper.find('[data-testid="speak-btn"]')
    expect(btn.attributes('title')).toBe('取消')
    expect(btn.find('svg.animate-spin').exists()).toBe(true)

    await btn.trigger('click')
    expect(onSpeak).toHaveBeenCalledTimes(1)
  })

  it('playing 态：title=停止；点击后状态回 idle（speakStateOf 变化驱动按钮回朗读态）', async () => {
    const onSpeak = vi.fn()
    // 状态源用 ref 驱动（对齐生产实现：speakStateOf 内部读全局单例 ref，computed 才可追踪）
    const state = ref<'idle' | 'loading' | 'playing'>('playing')
    const wrapper = mountSummary({
      depsOverrides: { onSpeak, speakStateOf: () => state.value },
    })
    let btn = wrapper.find('[data-testid="speak-btn"]')
    expect(btn.attributes('title')).toBe('停止')

    // playing 点击 = 停止（装配层调 stop；ui 断言点击透传 + 状态源变化后按钮回 idle 形态）
    await btn.trigger('click')
    expect(onSpeak).toHaveBeenCalledTimes(1)

    // 播完 / 停止：speakStateOf 返回 idle → 按钮回 idle 形态（title=朗读）
    state.value = 'idle'
    await wrapper.vm.$nextTick()
    btn = wrapper.find('[data-testid="speak-btn"]')
    expect(btn.attributes('title')).toBe('朗读')
  })

  it('生成中置灰：turn.isStreaming=true 时 disabled + title=回复生成中；false 恢复可点', async () => {
    const wrapper = mountSummary({ turn: makeTurn({ isStreaming: true }) })
    let btn = wrapper.find('[data-testid="speak-btn"]')
    expect(btn.attributes('disabled')).toBeDefined()
    expect(btn.attributes('title')).toBe('回复生成中')

    // 生成完成（isStreaming 翻转）→ 恢复可点 + title=朗读
    await wrapper.setProps({ turn: makeTurn({ isStreaming: false }) })
    btn = wrapper.find('[data-testid="speak-btn"]')
    expect(btn.attributes('disabled')).toBeUndefined()
    expect(btn.attributes('title')).toBe('朗读')
  })
})

// ======================================================================
// ← features/composer/__tests__/useComposerDragDrop.test.ts
// ======================================================================

/** pasteImage 可被每测试替换返回值（替代原 vi.mock useImageAttachment） */
const pasteImageMock = vi.fn()

/** sessionId ref（固定 'test-sess'） */
const sessionIdRef = ref<string | null>('test-sess')

/** inputRef mock：spy insertImageBadge */
function createInputMock() {
  return { insertImageBadge: vi.fn() }
}

/**
 * inputRef mock（DOM 感知版）：insertImageBadge 在 box 内插入真实 .image-chip span
 * （含 data-chip-path + data-chip-needs-migrate + .chip-label），模拟 useComposerChipCommands.insertImageBadge
 * 的 DOM 结构，使占位 querySelector 能定位到、验证回填走 dataset（而非重插）路径。
 */
function createDomInputMock(box: HTMLElement) {
  const calls = vi.fn()
  const insertImageBadge = (path: string, fileName: string, displayName: string, needsMigrate?: boolean) => {
    calls(path, fileName, displayName, needsMigrate)
    const chip = document.createElement('span')
    chip.className = 'mention-chip image-chip'
    chip.contentEditable = 'false'
    chip.dataset.chipType = 'image'
    chip.dataset.chipPath = path
    chip.dataset.chipFileName = fileName
    chip.dataset.chipDisplayName = displayName
    chip.dataset.chipNeedsMigrate = needsMigrate ? 'true' : 'false'
    const label = document.createElement('span')
    label.className = 'chip-label'
    label.textContent = displayName
    chip.appendChild(label)
    box.appendChild(chip)
    // 后跟 ZWSP spacer（同 contenteditable 范式，移除占位时一并清）
    box.appendChild(document.createTextNode('\u200B'))
  }
  return { insertImageBadge, __calls: calls }
}

/** 在独立 effectScope 内运行 composable */
function runWithScope<T>(fn: () => T): { result: T; dispose: () => void } {
  const scope = effectScope()
  let result!: T
  scope.run(() => {
    result = fn()
  })
  return { result, dispose: () => scope.stop() }
}

/** 构造最小 drop 事件对象。
 *  happy-dom 的 DragEvent 构造器丢弃 dataTransfer/relatedTarget 选项（实测 undefined），
 *  故用普通对象 + 类型断言直接挂载需要的字段（onDrop 读 e.dataTransfer?.files + e.preventDefault）。 */
function makeDropEvent(files: File[]): DragEvent {
  return {
    dataTransfer: { files },
    preventDefault: vi.fn(),
  } as unknown as DragEvent
}

function makeDragLeaveEvent(relatedTarget: Node | null): DragEvent {
  return { relatedTarget } as unknown as DragEvent
}

function makeDragOverEvent(): DragEvent {
  return { preventDefault: vi.fn() } as unknown as DragEvent
}

describe('useComposerDragDrop（TC5-TC8 slice5）', () => {
  let dispose: () => void

  beforeEach(() => {
    pasteImageMock.mockReset()
  })

  afterEach(() => {
    dispose?.()
  })

  it('TC5: dragover → isDragOver=true', async () => {
    const box = document.createElement('div')
    document.body.appendChild(box)
    const { result, dispose: d } = runWithScope(() =>
      useComposerDragDrop(ref(createInputMock()) as never, ref(box), vi.fn(), sessionIdRef, { pasteImage: pasteImageMock }),
    )
    dispose = d
    expect(result.isDragOver.value).toBe(false)
    result.onDragOver(makeDragOverEvent())
    expect(result.isDragOver.value).toBe(true)
  })

  it('TC6: drop 图片 → insertImageBadge 占位(needsMigrate=false) + 回填真实 path/fileName/displayName/needsMigrate（走 dataset，不重插）；isDragOver 复位', async () => {
    pasteImageMock.mockResolvedValue({ kind: 'badge', path: '/tmp/x.png', fileName: 'x-uuid.png', displayName: 'x.png', needsMigrate: true })
    const box = document.createElement('div')
    document.body.appendChild(box)
    // DOM 感知 insertImageBadge：在 box 内插真实 .image-chip，使占位 query 能定位 → 走 dataset 回填
    const inputMock = createDomInputMock(box)
    const onChanged = vi.fn()
    const { result, dispose: d } = runWithScope(() =>
      useComposerDragDrop(ref(inputMock) as never, ref(box), onChanged, sessionIdRef, { pasteImage: pasteImageMock }),
    )
    dispose = d
    // 先 dragover 置位 isDragOver
    result.onDragOver(makeDragOverEvent())
    expect(result.isDragOver.value).toBe(true)

    const png = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'drag.png', { type: 'image/png' })
    result.onDrop(makeDropEvent([png]))
    // onDrop 立即复位 isDragOver
    expect(result.isDragOver.value).toBe(false)
    // 等异步 pasteImage 完成 + 回填
    await vi.waitFor(() => expect(pasteImageMock).toHaveBeenCalled(), { interval: 1 })
    await vi.waitFor(() => expect(onChanged).toHaveBeenCalled(), { interval: 1 })
    // 占位 badge 仅插入 1 次（回填走 dataset，不重插——因占位仍在 DOM）；占位 needsMigrate=false（无迁移语义）
    expect(inputMock.__calls).toHaveBeenCalledTimes(1)
    expect(inputMock.__calls).toHaveBeenCalledWith(expect.stringMatching(/^__drag_pending_/), expect.stringMatching(/^__drag_pending_/), '拖入中…', false)
    // 回填后 chip 的 dataset.chipPath 变为真实 path，fileName/displayName/needsMigrate 变为真实值
    const chip = box.querySelector('.image-chip') as HTMLElement
    expect(chip).toBeTruthy()
    expect(chip.dataset.chipPath).toBe('/tmp/x.png')
    expect(chip.dataset.chipFileName).toBe('x-uuid.png')
    expect(chip.dataset.chipDisplayName).toBe('x.png')
    expect(chip.dataset.chipNeedsMigrate).toBe('true')
    expect(chip.querySelector('.chip-label')?.textContent).toBe('x.png')
  })

  it('TC6-variant: pasteImage 返回 text 降级 → 移除占位 + insertText', async () => {
    pasteImageMock.mockResolvedValue({ kind: 'text', text: '[图片粘贴失败]' })
    // happy-dom 无 document.execCommand（降级路径调用），直接赋值 mock
    const execCalls: unknown[][] = []
    const origExec = (document as { execCommand?: unknown }).execCommand
    ;(document as { execCommand?: unknown }).execCommand = (...args: unknown[]) => {
      execCalls.push(args)
      return true
    }
    try {
      const box = document.createElement('div')
      document.body.appendChild(box)
      const inputMock = createDomInputMock(box)
      const { result, dispose: d } = runWithScope(() =>
        useComposerDragDrop(ref(inputMock) as never, ref(box), vi.fn(), sessionIdRef, { pasteImage: pasteImageMock }),
      )
      dispose = d
      const png = new File([new Uint8Array([0x89])], 'bad.png', { type: 'image/png' })
      result.onDrop(makeDropEvent([png]))
      await vi.waitFor(() => expect(inputMock.__calls).toHaveBeenCalledTimes(1), { interval: 1 })
      // 占位回填后 execCommand insertText 被调（降级文本落地）+ 占位被移除
      await vi.waitFor(() => {
        expect(execCalls.some((c) => c[0] === 'insertText' && c[2] === '[图片粘贴失败]')).toBe(true)
      }, { interval: 1 })
      expect(box.querySelector('.image-chip')).toBeNull() // 占位已移除
    } finally {
      ;(document as { execCommand?: unknown }).execCommand = origExec
    }
  })

  it('TC7: drop 非图片文件 → insertImageBadge 未调用，isDragOver 复位', () => {
    const inputMock = createInputMock()
    const box = document.createElement('div')
    document.body.appendChild(box)
    const { result, dispose: d } = runWithScope(() =>
      useComposerDragDrop(ref(inputMock) as never, ref(box), vi.fn(), sessionIdRef, { pasteImage: pasteImageMock }),
    )
    dispose = d
    result.onDragOver(makeDragOverEvent())
    const txt = new File(['hi'], 'a.txt', { type: 'text/plain' })
    result.onDrop(makeDropEvent([txt]))
    expect(inputMock.insertImageBadge).not.toHaveBeenCalled()
    expect(result.isDragOver.value).toBe(false)
  })

  it('TC7-variant: drop 空文件列表 → insertImageBadge 未调用', () => {
    const inputMock = createInputMock()
    const box = document.createElement('div')
    document.body.appendChild(box)
    const { result, dispose: d } = runWithScope(() =>
      useComposerDragDrop(ref(inputMock) as never, ref(box), vi.fn(), sessionIdRef, { pasteImage: pasteImageMock }),
    )
    dispose = d
    result.onDrop(makeDropEvent([]))
    expect(inputMock.insertImageBadge).not.toHaveBeenCalled()
  })

  it('TC8: dragleave relatedTarget 在 box 内 → isDragOver 不复位', () => {
    const box = document.createElement('div')
    const child = document.createElement('span')
    box.appendChild(child)
    document.body.appendChild(box)
    const { result, dispose: d } = runWithScope(() =>
      useComposerDragDrop(ref(createInputMock()) as never, ref(box), vi.fn(), sessionIdRef, { pasteImage: pasteImageMock }),
    )
    dispose = d
    result.onDragOver(makeDragOverEvent())
    expect(result.isDragOver.value).toBe(true)
    // relatedTarget 是 box 内子元素 → 不复位
    result.onDragLeave(makeDragLeaveEvent(child))
    expect(result.isDragOver.value).toBe(true)
  })

  it('TC8: dragleave relatedTarget=null（拖出窗口）→ isDragOver 复位', () => {
    const box = document.createElement('div')
    document.body.appendChild(box)
    const { result, dispose: d } = runWithScope(() =>
      useComposerDragDrop(ref(createInputMock()) as never, ref(box), vi.fn(), sessionIdRef, { pasteImage: pasteImageMock }),
    )
    dispose = d
    result.onDragOver(makeDragOverEvent())
    result.onDragLeave(makeDragLeaveEvent(null))
    expect(result.isDragOver.value).toBe(false)
  })

  it('TC8: dragleave relatedTarget 在 box 外 → isDragOver 复位', () => {
    const box = document.createElement('div')
    const outside = document.createElement('div')
    document.body.append(box, outside)
    const { result, dispose: d } = runWithScope(() =>
      useComposerDragDrop(ref(createInputMock()) as never, ref(box), vi.fn(), sessionIdRef, { pasteImage: pasteImageMock }),
    )
    dispose = d
    result.onDragOver(makeDragOverEvent())
    result.onDragLeave(makeDragLeaveEvent(outside))
    expect(result.isDragOver.value).toBe(false)
  })
})
