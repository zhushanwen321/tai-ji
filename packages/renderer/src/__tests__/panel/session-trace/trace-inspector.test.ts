/**
 * A44 drawer inspector 联动单测（trace-ui，设计 D5b/D5c）。
 *
 * 覆盖：
 * - 选中切入临时页：selectTraceEntry 后 drawer default slot 最前注入 TraceInspector
 *   （优先于 activeTab 面板），详情按 kind 渲染（文本全文 / kv / 原始 JSON）
 * - 返回复原前 tab：「← 返回」清 selectedKey → inspector 卸载 → activeTab 内容复原
 * - 未开自动打开：drawer 关闭态点选 → openDrawerTab 自动打开（保持当前 tab）
 * - 单向 main→drawer + SideDrawerTab 体系不变（7 个一级 tab icon 仍在，无新 tab 位）
 *
 * 两层：组件级（mount TraceInspector 断言详情内容）+ 壳路径（mount PanelContainer，
 * stub 桌面面板，对齐 panel-container-drawer-mode.test.ts harness）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/panel/session-trace/trace-inspector.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { computed, defineComponent, nextTick, reactive } from 'vue'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { usePanelStore, ROOT_PANEL_ID } from '@/stores/panel'
import type { ServerMessageMap } from '@taiji/shared'
import { bindDrawerSessionId, _resetDrawerForTest } from '@taiji/core/domain/drawer'

// ── mock 壳层依赖（PanelContainer setup 阶段执行，避免真实 WS/session 副作用）──
vi.mock('@/composables/features/file-tree/useGitStatus', () => ({
  GIT_STATUS_KEY: Symbol('git-status'),
  provideGitStatus: () => ({ indicator: { value: undefined }, state: { value: 'clean' }, lines: { value: [] } }),
}))
vi.mock('@/composables/features/chat/useSessionDerivations', () => ({
  useSessionDerivations: () => ({ derivedStatus: () => ({ value: 'done' }) }),
}))

// ── mock chatStore（unread badge 计数读 getMessages）──
const chatMock = vi.hoisted(() => {
  let readFn: ((sid: string) => unknown[]) | null = null
  return {
    registerReader(fn: (sid: string) => unknown[]): void {
      readFn = fn
    },
    read(sid: string): unknown[] {
      return readFn ? readFn(sid) : []
    },
  }
})
const reactiveMessages = reactive(new Map<string, unknown[]>())
vi.mock('@/stores/chat', () => ({
  useChatStore: () => ({ getMessages: (sid: string) => chatMock.read(sid) }),
}))
chatMock.registerReader((sid) => reactiveMessages.get(sid) ?? [])

// ── mock '@/api' 门面：仅覆写 session.getTraceEntries（其余域保留真实导出——
// PanelContainer 依赖链上的 useChat 需要 chat.send/steer 等真存在，整体替换会解构 undefined）──
const apiMock = vi.hoisted(() => ({ getTraceEntries: vi.fn() }))
vi.mock('@/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api')>()
  return { ...actual, session: { ...actual.session, getTraceEntries: apiMock.getTraceEntries } }
})

// ── mock '@/lib/ipc' revealInFolder（reveal 调用链组件层段落：TraceInspector →
//  lib/ipc；electronAPI 边界归 ipc-reveal-in-folder.test.ts，两段拼接成完整链）──
const ipcMock = vi.hoisted(() => ({ revealInFolder: vi.fn() }))
vi.mock('@/lib/ipc', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ipc')>()
  return { ...actual, revealInFolder: ipcMock.revealInFolder }
})

// ── mock jumpToParentSession（onJumpParent 编排：throw 路径的用户反馈在本组件层，
//    编排内部归 useTraceJump.test.ts；本文件只验「组件把失败翻译成可见 toast」）──
const jumpMock = vi.hoisted(() => ({ jumpToParentSession: vi.fn() }))
vi.mock('@/composables/features/trace/useTraceJump', () => ({
  jumpToParentSession: jumpMock.jumpToParentSession,
}))

import TraceInspector from '@/components/panel/trace/TraceInspector.vue'
import {
  _resetTraceStoreForTest,
  bindTraceSessionId,
  ensureTraceLoaded,
  selectTraceEntry,
  useSessionTrace,
} from '@/composables/features/trace/useSessionTrace'
import { useToast } from '@/composables/useToast'

const SID = 'sid-inspector-1'

function buildSnapshot(): ServerMessageMap['session.traceEntries'] {
  return {
    sessionId: SID,
    source: 'file',
    filePath: `/data/agent/sessions/${SID}.jsonl`,
    header: { type: 'session', version: 1, id: 'h0', cwd: '/w/demo' },
    entries: [
      { type: 'message', id: 'u1', parentId: 'h0', message: { role: 'user', content: '帮我修一下重试逻辑' } },
      {
        type: 'message', id: 'a1', parentId: 'u1',
        message: {
          role: 'assistant', provider: 'p', model: 'm-pro',
          usage: { input: 21318, output: 160, cacheRead: 192, cost: { total: 0 } },
          stopReason: 'toolUse',
          content: [
            { type: 'thinking', thinking: '先定位问题\n再改代码' },
            { type: 'toolCall', id: 'call_1', name: 'read', arguments: { path: 'a.ts' } },
            { type: 'text', text: '读取完成' },
          ],
        },
      },
      {
        type: 'message', id: 'tr1', parentId: 'a1',
        message: {
          role: 'toolResult', toolCallId: 'call_1', toolName: 'read', isError: false,
          content: [
            { type: 'text', text: 'file body line1\nfile body line2' },
            { type: 'image', data: 'base64', mimeType: 'image/png' },
          ],
        },
      },
      { type: 'message', id: 'b1', parentId: 'tr1', message: { role: 'bashExecution', command: 'npm test', output: 'FAIL 1', exitCode: 1, excludeFromContext: true } },
      { type: 'compaction', id: 'c1', parentId: 'b1', summary: '## 压缩摘要正文', firstKeptEntryId: 'b1', tokensBefore: 152311 },
      { type: 'message', id: 'u2', parentId: 'c1', message: { role: 'user', content: '压缩后的消息' } },
      {
        type: 'message', id: 'a2', parentId: 'u2',
        message: { role: 'assistant', provider: 'p', model: 'm-pro', content: [{ type: 'thinking', thinking: '', redacted: true }] },
      },
    ],
    malformed: [{ lineNumber: 5, raw: 'not json' }],
    leafId: 'u2',
  }
}

const DesktopStub = (name: string, testid: string) =>
  defineComponent({ name, template: `<div data-testid="${testid}" />` })

const PanelStub = defineComponent({
  name: 'Panel',
  props: { panelId: String, sessionId: { type: String, default: null } },
  template: '<div data-testid="panel" :data-panel-id="panelId" />',
})

async function mountContainer() {
  const PanelContainer = (await import('@/components/workspace/PanelContainer.vue')).default
  return mount(PanelContainer, {
    global: {
      stubs: {
        Panel: PanelStub,
        GitPanel: DesktopStub('GitPanel', 'git-panel'),
        CommandDocPanel: DesktopStub('CommandDocPanel', 'doc-panel'),
        DetailPane: DesktopStub('DetailPane', 'detail-panel'),
        TerminalView: DesktopStub('TerminalView', 'terminal-panel'),
        SubagentTab: DesktopStub('SubagentTab', 'subagent-panel'),
        WorkflowTab: DesktopStub('WorkflowTab', 'workflow-panel'),
      },
    },
  })
}

async function readyPartition() {
  ensureTraceLoaded(SID)
  await vi.waitFor(() => expect(useSessionTrace().partition.value.status).toBe('ready'))
}

beforeEach(() => {
  vi.clearAllMocks()
  apiMock.getTraceEntries.mockReset()
  apiMock.getTraceEntries.mockResolvedValue(buildSnapshot())
  _resetTraceStoreForTest()
  _resetDrawerForTest()
  setActivePinia(createPinia())
  bindTraceSessionId(computed(() => usePanelStore().focusedSessionId))
  usePanelStore().loadSession(ROOT_PANEL_ID, SID)
})

describe('A44 drawer inspector 联动（选中切入临时页 / 返回复原 / 未开自动打开 / SideDrawerTab 不变）', () => {
  it('组件级：选中 USER 行渲染详情（全文 / kv / 原始 JSON），返回清除选中', async () => {
    await readyPartition()
    selectTraceEntry(SID, 'u1')
    await nextTick()
    const view = mount(TraceInspector, { props: { sessionId: SID } })
    expect(view.find('[data-testid="trace-inspector"]').exists()).toBe(true)
    const body = view.find('[data-testid="trace-inspector-body"]')
    // 文本全文 + 关键 kv + 原始 JSON 兜底
    expect(body.text()).toContain('帮我修一下重试逻辑')
    expect(body.text()).toContain('u1')
    expect(body.text()).toContain('role')
    // 返回 → selectedKey 清除（inspector 数据源为空）
    await view.find('[data-testid="trace-inspector-back"]').trigger('click')
    expect(useSessionTrace().partition.value.selectedKey).toBeNull()
    view.unmount()
  })

  it('组件级：COMPACTED 行 summary 全文 + tokensBefore；BASH 行 command/exitCode/excludeFromContext', async () => {
    await readyPartition()
    selectTraceEntry(SID, 'c1')
    await nextTick()
    const compacted = mount(TraceInspector, { props: { sessionId: SID } })
    const cBody = compacted.find('[data-testid="trace-inspector-body"]')
    expect(cBody.text()).toContain('压缩摘要正文')
    expect(cBody.text()).toContain('152311')
    expect(cBody.text()).toContain('firstKeptEntryId')
    compacted.unmount()

    selectTraceEntry(SID, 'b1')
    await nextTick()
    const bash = mount(TraceInspector, { props: { sessionId: SID } })
    const bBody = bash.find('[data-testid="trace-inspector-body"]')
    expect(bBody.text()).toContain('npm test')
    expect(bBody.text()).toContain('exitCode')
    expect(bBody.text()).toContain('excludeFromContext')
    bash.unmount()
  })

  it('壳路径：未开自动打开 + 选中切入临时页（取代 activeTab 内容）+ 一级 tab 体系不变', async () => {
    await readyPartition()
    const wrapper = await mountContainer()
    await nextTick()
    // drawer 关闭态：无 drawer
    expect(wrapper.find('[data-testid="drawer-panel"]').exists()).toBe(false)

    // 选中（drawer 未开）→ 自动打开 + inspector 切入 default slot 最前
    selectTraceEntry(SID, 'u1')
    await nextTick()
    await nextTick()
    expect(wrapper.find('[data-testid="drawer-panel"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="trace-inspector"]').exists()).toBe(true)
    // inspector 优先于 activeTab 面板（默认 terminal tab 内容被临时页取代）
    expect(wrapper.find('[data-testid="terminal-panel"]').exists()).toBe(false)

    // SideDrawerTab 体系不变：7 个一级 tab icon 仍在（inspector 不占 tab 位）
    for (const tab of ['terminal', 'browser', 'git', 'doc', 'detail', 'subagent', 'workflow']) {
      expect(wrapper.find(`[data-testid="drawer-tab-${tab}"]`).exists(), `drawer-tab-${tab} 应存在`).toBe(true)
    }

    // 返回 → inspector 卸载 + 复原前 tab 内容（activeTab 未被改过，默认 terminal）
    await wrapper.find('[data-testid="trace-inspector-back"]').trigger('click')
    await nextTick()
    await nextTick()
    expect(wrapper.find('[data-testid="trace-inspector"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="terminal-panel"]').exists()).toBe(true)
    wrapper.unmount()
  })

  it('单向 main→drawer：inspector 期间点其它一级 tab = 显式离开（清选中，切 tab 内容），drawer 不反向写 main 状态', async () => {
    await readyPartition()
    const wrapper = await mountContainer()
    selectTraceEntry(SID, 'u1')
    await nextTick()
    await nextTick()
    expect(wrapper.find('[data-testid="trace-inspector"]').exists()).toBe(true)

    // 用户点 git tab（明确意图离开临时页）→ 清 selectedKey + git 面板接管
    await wrapper.find('[data-testid="drawer-tab-git"]').trigger('click')
    await nextTick()
    expect(useSessionTrace().partition.value.selectedKey).toBeNull()
    expect(wrapper.find('[data-testid="git-panel"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="trace-inspector"]').exists()).toBe(false)
    // main 侧过滤/视图状态不被 drawer 操作改写
    expect(useSessionTrace().partition.value.view).toBe('chat')
    expect(useSessionTrace().partition.value.searchText).toBe('')
    wrapper.unmount()
  })
})

describe('C2 MALFORMED 行「打开所在目录」（reveal-in-folder IPC 接线，§3.1 损坏行恢复指引）', () => {
  it('选中损坏行 + 快照带 filePath → 按钮可点，点击调 lib/ipc.revealInFolder(filePath)', async () => {
    await readyPartition()
    selectTraceEntry(SID, 'malformed:5')
    await nextTick()
    const view = mount(TraceInspector, { props: { sessionId: SID } })
    const actions = view.find('[data-testid="trace-malformed-actions"]')
    expect(actions.exists()).toBe(true)
    const revealBtn = view.find('[data-testid="trace-malformed-reveal"]')
    expect(revealBtn.exists()).toBe(true)
    expect(revealBtn.attributes('disabled')).toBeUndefined()

    ipcMock.revealInFolder.mockResolvedValueOnce(true)
    await revealBtn.trigger('click')
    expect(ipcMock.revealInFolder).toHaveBeenCalledTimes(1)
    expect(ipcMock.revealInFolder).toHaveBeenCalledWith(`/data/agent/sessions/${SID}.jsonl`)
    view.unmount()
  })

  it('快照无 filePath（未落盘/路径未知）→ 按钮置灰且点击不触发 IPC', async () => {
    const snap = buildSnapshot()
    delete snap.filePath
    apiMock.getTraceEntries.mockResolvedValue(snap)
    await readyPartition()
    selectTraceEntry(SID, 'malformed:5')
    await nextTick()
    const view = mount(TraceInspector, { props: { sessionId: SID } })
    const revealBtn = view.find('[data-testid="trace-malformed-reveal"]')
    expect(revealBtn.attributes('disabled')).toBeDefined()
    await revealBtn.trigger('click')
    expect(ipcMock.revealInFolder).not.toHaveBeenCalled()
    view.unmount()
  })
})

describe('assistant 子 block 详情（聚合态清单 + block 态全文 + TOOL 输出 + 框选）', () => {
  async function mountInspector(key: string) {
    await readyPartition()
    selectTraceEntry(SID, key)
    await nextTick()
    return mount(TraceInspector, { props: { sessionId: SID } })
  }

  it('聚合态：blocks 清单逐块展示（toolCall 预览含 name+arguments——真实字段口径回归）+ usage kv', async () => {
    const view = await mountInspector('a1')
    const body = view.find('[data-testid="trace-inspector-body"]')
    const list = view.find('[data-testid="trace-inspector-blocks"]')
    expect(list.exists()).toBe(true)
    const items = list.findAll('[data-testid^="trace-inspector-block-"]')
    expect(items).toHaveLength(3)
    expect(items[0]!.text()).toContain('先定位问题')
    expect(items[1]!.text()).toContain('read')
    expect(items[1]!.text()).toContain('a.ts')
    expect(items[2]!.text()).toContain('读取完成')
    // usage 标量进 kv（meta SSOT）+ 行尾右侧弱标注（互斥桶语义解释）
    expect(body.text()).toContain('inputTokens')
    expect(body.text()).toContain('21318')
    expect(body.text()).toContain('192')
    expect(body.text()).toContain('未缓存')
    expect(body.text()).toContain('缓存命中')
    // 输入侧合计行：21318 + 192
    expect(body.text()).toContain('inputTotal')
    expect(body.text()).toContain('21510')
    view.unmount()
  })

  it('点击清单项进入 block 态：toolCall 显示 name/callId/arguments，可跳到配对 TOOL 行', async () => {
    const view = await mountInspector('a1')
    await view.find('[data-testid="trace-inspector-block-1"]').trigger('click')
    expect(useSessionTrace().partition.value.selectedKey).toBe('a1#block-1')
    await nextTick()

    const body = view.find('[data-testid="trace-inspector-body"]')
    expect(body.text()).toContain('read')
    expect(body.text()).toContain('call_1')
    const args = view.find('[data-testid="trace-inspector-block-arguments"]')
    expect(args.exists()).toBe(true)
    expect(args.text()).toContain('"path"')
    expect(args.text()).toContain('a.ts')

    // toolCallId 配对 tr1 → 跳转按钮可点，点击选中并定位 TOOL 行
    const jump = view.find('[data-testid="trace-inspector-jump-tool-result"]')
    expect(jump.exists()).toBe(true)
    expect(jump.attributes('disabled')).toBeUndefined()
    await jump.trigger('click')
    expect(useSessionTrace().partition.value.selectedKey).toBe('tr1')
    view.unmount()
  })

  it('block 态：thinking 全文展示（多行不截断）；「← 返回」回父聚合态，再返回才清除', async () => {
    const view = await mountInspector('a1#block-0')
    const content = view.find('[data-testid="trace-inspector-block-content"]')
    expect(content.exists()).toBe(true)
    expect(content.text()).toContain('先定位问题')
    expect(content.text()).toContain('再改代码')

    await view.find('[data-testid="trace-inspector-back"]').trigger('click')
    expect(useSessionTrace().partition.value.selectedKey).toBe('a1')
    expect(view.find('[data-testid="trace-inspector-blocks"]').exists()).toBe(true)

    await view.find('[data-testid="trace-inspector-back"]').trigger('click')
    expect(useSessionTrace().partition.value.selectedKey).toBeNull()
    view.unmount()
  })

  it('redacted thinking：block 态显示脱敏占位文案', async () => {
    const view = await mountInspector('a2#block-0')
    const content = view.find('[data-testid="trace-inspector-block-content"]')
    expect(content.text()).toContain('已脱敏')
    view.unmount()
  })

  it('TOOL 行 content 层：text block 全文 + image 占位计数（不再只能翻 raw JSON）', async () => {
    const view = await mountInspector('tr1')
    const body = view.find('[data-testid="trace-inspector-body"]')
    expect(body.text()).toContain('file body line1')
    expect(body.text()).toContain('file body line2')
    expect(body.text()).toContain('[image ×1]')
    view.unmount()
  })

  it('框选：inspector body 容器恢复 select-text（全局 user-select:none 的内容区恢复点）', async () => {
    const view = await mountInspector('a1')
    const body = view.find('[data-testid="trace-inspector-body"]')
    expect(body.classes()).toContain('select-text')
    view.unmount()
  })
})

describe('SESSION 行溯源跳转失败的用户反馈（onJumpParent catch+toast）', () => {
  /** header 带 parentSession/forkEntryId 的快照（SESSION 行渲染 jump-parent 按钮）。 */
  function buildSnapshotWithParent(): ServerMessageMap['session.traceEntries'] {
    const snap = buildSnapshot()
    snap.header = {
      ...snap.header,
      parentSession: 'sid-fork-src',
      forkEntryId: 'u1',
    } as typeof snap.header
    return snap
  }

  function clearToasts(): void {
    const { toasts, remove } = useToast()
    for (const toast of [...toasts.value]) remove(toast.id)
  }

  async function mountSessionInspector() {
    apiMock.getTraceEntries.mockResolvedValue(buildSnapshotWithParent())
    await readyPartition()
    selectTraceEntry(SID, 'h0') // header 行 = SESSION kind
    await nextTick()
    const view = mount(TraceInspector, { props: { sessionId: SID } })
    const btn = view.find('[data-testid="trace-inspector-jump-parent"]')
    expect(btn.exists()).toBe(true)
    return { view, btn }
  }

  beforeEach(() => {
    clearToasts()
  })

  it('jumpToParentSession throw（selectSession 失败）→ error toast 可见，不 unhandled', async () => {
    jumpMock.jumpToParentSession.mockRejectedValue(new Error('selectSession boom'))
    const { view, btn } = await mountSessionInspector()
    await btn.trigger('click')
    await vi.waitFor(() => {
      const errorToast = useToast().toasts.value.find((toast) => toast.type === 'error')
      expect(errorToast).toBeDefined()
      expect(errorToast?.message).toContain('trace 加载超时')
    })
    view.unmount()
  })

  it('jumpToParentSession 返回 ok:false → toast 文案按 reason 分派（target_not_found）', async () => {
    jumpMock.jumpToParentSession.mockResolvedValue({ ok: false, reason: 'target_not_found' })
    const { view, btn } = await mountSessionInspector()
    await btn.trigger('click')
    await vi.waitFor(() => {
      const errorToast = useToast().toasts.value.find((toast) => toast.type === 'error')
      expect(errorToast).toBeDefined()
      expect(errorToast?.message).toContain('未找到源 session')
    })
    view.unmount()
  })
})
