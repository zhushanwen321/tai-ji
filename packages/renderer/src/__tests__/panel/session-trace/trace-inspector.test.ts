/**
 * A44 drawer inspector 联动单测（trace-ui，设计 D5b 终态：trace 一级 tab）。
 *
 * 单文件多源合并（4 源同装载簇）：trace-inspector（本节，最大源）+ queue-bubble-s8 +
 * queue-bubble-edit + block-ansi——vitest 按测试文件隔离模块图，合并让全部用例共享
 * 一份组件树装载与环境初始化（4 文件各付一次装载 → 合并后一份）。
 * 未并入：mode-declaration-row.test.ts——其真实 @/stores/chat + shell-mount mock
 * useChat 形态与本文件 mock @/stores/chat + 真实 useChat 互为相反（同模块不同形态
 * 实质冲突），保持独立文件。
 * 三个小组件源（QueueBubble 纯 props / Block 经 mockChatProvide）不消费本文件 mock
 * 集任何模块，各节以裸块隔离节内 helper。
 *
 * 覆盖（trace-inspector 源）：
 * - trace 一级 tab：selectTraceEntry → openDrawerTab('trace') 自动打开并切 tab，
 *   inspector = trace tab 内容面板（详情按 kind 渲染：文本全文 / kv / 原始 JSON）
 * - 返回空态：「← 返回」清 selectedKey → inspector 卸载 → trace tab 空态 fallback
 * - 未开自动打开：drawer 关闭态点选 → 自动打开 + activeTab 切 trace
 * - 选中态保留：切其它一级 tab 不清 selectedKey，切回 trace tab 详情还在
 *   （与 detail/bashTask 选中态同语义；清单与 drawer-mode 注册表契约同源：helpers/drawer-tabs.ts）
 *
 * 两层：组件级（mount TraceInspector 断言详情内容）+ 壳路径（mount PanelContainer，
 * stub 桌面面板，对齐 panel-container-drawer-mode.test.ts harness）。
 *
 * 运行：cd packages/renderer && TAIJI_TEST_DOMAIN=subagent npx vitest run src/__tests__/panel/session-trace/trace-inspector.test.ts（本文件登记在 domain-map.json subagent 域，默认档被排除）
 */
import { describe, it, expect, beforeEach, beforeAll, vi } from 'vitest'
import { computed, defineComponent, nextTick, reactive } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { usePanelStore, ROOT_PANEL_ID } from '@/stores/panel'
import type { ServerMessageMap, ToolCall } from '@taiji/shared'
import { Block } from '@taiji/ui'
import { bindDrawerSessionId, _resetDrawerForTest } from '@taiji/core/domain/drawer'
import { mockChatProvide } from '@/__tests__/helpers/chat-view-deps'
import QueueBubble from '@/components/panel/QueueBubble.vue'
import type { QueueRow } from '@/composables/panel/useQueueRows'

// ── mock 壳层依赖（PanelContainer setup 阶段执行，避免真实 WS/session 副作用）──
vi.mock('@/composables/features/file-tree/useGitStatus', () => ({
  GIT_STATUS_KEY: Symbol('git-status'),
  provideGitStatus: () => ({ indicator: { value: undefined }, state: { value: 'clean' }, lines: { value: [] } }),
}))
vi.mock('@/composables/features/chat/useSessionDerivations', () => ({
  useSessionDerivations: () => ({ derivedStatus: () => ({ value: 'done' }) }),
}))

// ── 静态重面板 + 壳层组件 vi.mock（import 期替换：global.stubs 只在渲染期替换，import 期
// 仍加载原模块触发 PanelContainer 整图 transform；mock 集对齐 panel-container-drawer-mode.test.ts
// ——Panel/PanelHeader/ToastContainer/PlanDocsPanel/BtwPanel/BackgroundTaskDetailPanel 在本文件
// 零断言，占位只砍 transform；工厂零外部引用（普通 options 对象组件），规避 vi.mock hoisting
// 对顶层绑定的限制）。两点边界：① TraceInspector 本体不 mock——组件级用例直接 mount 本体
// （L74 静态 import），mock 会污染本体（@taiji/ui/extension-host 链经 PanelHeader 引入，
// PanelHeader 已 mock 即被切断，无需直 mock）；② 懒加载 DetailPane/TerminalView
// （PanelContainer 动态 import，不在静态图内）保留渲染期 stub。──
vi.mock('@/components/panel/GitPanel.vue', () => ({
  default: { name: 'GitPanel', template: '<div data-testid="git-panel" />' },
}))
vi.mock('@/components/panel/CommandDocPanel.vue', () => ({
  default: { name: 'CommandDocPanel', template: '<div data-testid="doc-panel" />' },
}))
vi.mock('@/components/extension/BackgroundTaskDetailPanel.vue', () => ({
  default: { name: 'BackgroundTaskDetailPanel', template: '<div data-testid="bash-task-detail-panel" />' },
}))
vi.mock('@/components/panel/plan/PlanDocsPanel.vue', () => ({
  default: { name: 'PlanDocsPanel', template: '<div data-testid="plan-docs-panel" />' },
}))
vi.mock('@/components/panel/BtwPanel.vue', () => ({
  default: { name: 'BtwPanel', template: '<div data-testid="btw-panel" />' },
}))
vi.mock('@/components/panel/Panel.vue', () => ({
  default: {
    name: 'Panel',
    props: { panelId: String, sessionId: { type: String, default: null } },
    template: '<div data-testid="panel" :data-panel-id="panelId" />',
  },
}))
vi.mock('@/components/panel/PanelHeader.vue', () => ({
  default: { name: 'PanelHeader', template: '<div />' },
}))
vi.mock('@/components/ui/ToastContainer.vue', () => ({
  default: { name: 'ToastContainer', template: '<div />' },
}))
vi.mock('@/components/panel/SubagentTab.vue', () => ({
  default: { name: 'SubagentTab', template: '<div data-testid="subagent-panel" />' },
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
//  lib/ipc；electronAPI 边界归 __tests__/lib/ipc.test.ts，两段拼接成完整链）──
const ipcMock = vi.hoisted(() => ({ revealInFolder: vi.fn() }))
vi.mock('@/lib/ipc', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ipc')>()
  return { ...actual, revealInFolder: ipcMock.revealInFolder }
})

// ── mock jumpToParentSession（onJumpParent 编排：throw 路径的用户反馈在本组件层，
//    编排内部归 __tests__/panel/session-trace/useSessionTrace.test.ts（节 2 useTraceJump）；本文件只验「组件把失败翻译成可见 toast」）──
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
import { clearToasts } from '../../helpers/toast-queue'

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

// PanelContainer 组件构造器（beforeAll 预热填充）：整图 transform 首载成本（junit 实测
// 单条 13s+）一次性移入文件级 beforeAll，不落在任何单条用例预算内（TEST-STRATEGY「新写测试判据」
// h 类处置：模块图首载预热共享；vi.mock 声明提升到文件顶部，预热 import 时 mock 已生效）
let PanelContainerCtor: (typeof import('@/components/workspace/PanelContainer.vue'))['default']

beforeAll(async () => {
  PanelContainerCtor = (await import('@/components/workspace/PanelContainer.vue')).default
})

async function mountContainer() {
  return mount(PanelContainerCtor, {
    global: {
      stubs: {
        DetailPane: DesktopStub('DetailPane', 'detail-panel'),
        TerminalView: DesktopStub('TerminalView', 'terminal-panel'),
      },
    },
  })
}

async function readyPartition() {
  ensureTraceLoaded(SID)
  // mock 回包是纯微任务链（mockResolvedValue → loadTrace 续体同步写 ready，链上无定时器）：
  // flushPromises 打一次 macrotask 边界，微任务清空是事件循环保证——构造性必达，无轮询窗口
  await flushPromises()
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

describe('A44 drawer inspector 联动（trace 一级 tab：自动打开切 tab / 返回空态 / 选中态保留）', () => {
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

  it('壳路径：未开自动打开 + activeTab 切 trace（trace tab 高亮）+ inspector 接管内容', async () => {
    await readyPartition()
    const wrapper = await mountContainer()
    await nextTick()
    // drawer 关闭态：无 drawer
    expect(wrapper.find('[data-testid="drawer-panel"]').exists()).toBe(false)

    // 选中（drawer 未开）→ 自动打开 + activeTab 切 trace + inspector 显示（git 面板不渲染）
    selectTraceEntry(SID, 'u1')
    await nextTick()
    await nextTick()
    expect(wrapper.find('[data-testid="drawer-panel"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="trace-inspector"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="git-panel"]').exists()).toBe(false)
    // trace 是正式一级 tab：按钮存在且高亮（选中态样式 bg-surface-hover）
    const traceTab = wrapper.find('[data-testid="drawer-tab-trace"]')
    expect(traceTab.exists()).toBe(true)
    expect(traceTab.classes()).toContain('bg-surface-hover')

    // 返回 → selectedKey 清除 → trace tab 空态 fallback（drawer-widget-empty）
    await wrapper.find('[data-testid="trace-inspector-back"]').trigger('click')
    await nextTick()
    await nextTick()
    expect(wrapper.find('[data-testid="trace-inspector"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="drawer-widget-empty"]').exists()).toBe(true)
    wrapper.unmount()
  })

  it('trace tab 选中态保留：切其它一级 tab 不清选中，切回 trace 详情还在（main 状态不被 drawer 改写）', async () => {
    await readyPartition()
    const wrapper = await mountContainer()
    selectTraceEntry(SID, 'u1')
    await nextTick()
    await nextTick()
    expect(wrapper.find('[data-testid="trace-inspector"]').exists()).toBe(true)

    // 用户点 git tab → git 面板接管；selectedKey 保留（与 detail/bashTask 选中态同语义）
    await wrapper.find('[data-testid="drawer-tab-git"]').trigger('click')
    await nextTick()
    expect(useSessionTrace().partition.value.selectedKey).toBe('u1')
    expect(wrapper.find('[data-testid="git-panel"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="trace-inspector"]').exists()).toBe(false)

    // 切回 trace tab → inspector 复现（详情还在）
    await wrapper.find('[data-testid="drawer-tab-trace"]').trigger('click')
    await nextTick()
    expect(wrapper.find('[data-testid="trace-inspector"]').exists()).toBe(true)
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
    // mock reject → catch → toastError 同步写 toasts（纯微任务链）：flushPromises 构造性必达
    await flushPromises()
    const errorToast = useToast().toasts.value.find((toast) => toast.type === 'error')
    expect(errorToast).toBeDefined()
    expect(errorToast?.message).toContain('trace 加载超时')
    view.unmount()
  })

  it('jumpToParentSession 返回 ok:false → toast 文案按 reason 分派（target_not_found）', async () => {
    jumpMock.jumpToParentSession.mockResolvedValue({ ok: false, reason: 'target_not_found' })
    const { view, btn } = await mountSessionInspector()
    await btn.trigger('click')
    await flushPromises()
    const errorToast = useToast().toasts.value.find((toast) => toast.type === 'error')
    expect(errorToast).toBeDefined()
    expect(errorToast?.message).toContain('未找到源 session')
    view.unmount()
  })
})

describe('safeJson 检查 + 损坏行行号未知降级（RD-2#5 / RD-2#6）', () => {
  /** 快照 a1 toolCall block（content[1]）的 arguments 替换为指定值（引用直传，core 不克隆） */
  function snapshotWithToolCallArguments(args: unknown): ServerMessageMap['session.traceEntries'] {
    const snap = buildSnapshot()
    const a1 = snap.entries[1] as { message?: { content?: Array<Record<string, unknown>> } }
    const toolCall = a1.message?.content?.[1]
    if (toolCall) toolCall.arguments = args
    return snap
  }

  async function mountBlockArguments(snapshot: ServerMessageMap['session.traceEntries']) {
    apiMock.getTraceEntries.mockResolvedValue(snapshot)
    await readyPartition()
    selectTraceEntry(SID, 'a1#block-1')
    await nextTick()
    const view = mount(TraceInspector, { props: { sessionId: SID } })
    return { view, args: view.find('[data-testid="trace-inspector-block-arguments"]') }
  }

  it('[RD-2#5] arguments 环形引用 → 降级占位文案（inspector 不空白、render 路径不抛错）', async () => {
    const circular: Record<string, unknown> = { path: 'a.ts' }
    circular.self = circular
    const { view, args } = await mountBlockArguments(snapshotWithToolCallArguments(circular))
    expect(args.exists()).toBe(true)
    expect(args.text()).toContain('无法序列化')
    view.unmount()
  })

  it('[RD-2#5] arguments 超 200KB 阈值 → 截断展示 + 「过大已截断」标记行（巨型 payload 不整段渲染）', async () => {
    // 阈值锚定 TraceInspector.vue 的 RAW_JSON_MAX_CHARS（204_800 字符）：超 1 字符即走
    // 截断分支——「阈值 +1」与「阈值 +10KB」证明的是同一条路径，不付多余序列化/渲染成本
    const RAW_JSON_MAX_CHARS = 204_800
    const { view, args } = await mountBlockArguments(snapshotWithToolCallArguments({ blob: 'x'.repeat(RAW_JSON_MAX_CHARS + 1) }))
    expect(args.exists()).toBe(true)
    expect(args.text()).toContain('过大，已截断')
    // 截断生效：DOM 文本不超阈值 + 标记行余量
    expect(args.text().length).toBeLessThanOrEqual(RAW_JSON_MAX_CHARS + 200)
    view.unmount()
  })

  it('[RD-2#5 回归锚] 正常 arguments → JSON 键值原样展示（检查不改变正常路径输出）', async () => {
    const { view, args } = await mountBlockArguments(snapshotWithToolCallArguments({ path: 'a.ts', line: 3 }))
    expect(args.text()).toContain('"path"')
    expect(args.text()).toContain('a.ts')
    expect(args.text()).not.toContain('无法序列化')
    view.unmount()
  })

  it('[RD-2#6] MALFORMED 无 lineNumber（协议/版本漂移防御）→ 「行号未知」文案 + 不渲染「打开所在目录」动作（不承诺行定位、不指「第 0 行」）', async () => {
    const snap = buildSnapshot()
    snap.malformed = [
      { raw: 'not json' } as unknown as ServerMessageMap['session.traceEntries']['malformed'][number],
    ]
    apiMock.getTraceEntries.mockResolvedValue(snap)
    await readyPartition()
    // lineNumber 缺省 → core trace-rows 行 key 模板串拼接为 malformed:undefined
    selectTraceEntry(SID, 'malformed:undefined')
    await nextTick()
    const view = mount(TraceInspector, { props: { sessionId: SID } })
    const actions = view.find('[data-testid="trace-malformed-actions"]')
    expect(actions.exists()).toBe(true)
    expect(actions.text()).toContain('行号未知')
    expect(actions.text()).not.toContain('第 0 行')
    expect(view.find('[data-testid="trace-malformed-reveal"]').exists()).toBe(false)
    view.unmount()
  })
})

// ══════════ 来源：queue-bubble-s8.test.ts ══════════
{
  /** 队列行构造（state 三态；默认 queued 投递路径行） */
  function row(clientUuid: string, preview: string, state: QueueRow['state'] = 'queued'): QueueRow {
    return { clientUuid, preview, state }
  }

  /** mount 助手：rows/hint 为必传（Composer 恒传），缺省给中性值 */
  function mountQB(overrides: { rows?: QueueRow[]; hint?: string; expanded?: boolean } = {}) {
    return mount(QueueBubble, {
      props: {
        rows: overrides.rows ?? [],
        hint: overrides.hint ?? '等待上下文压缩完成后发送',
        ...(overrides.expanded !== undefined ? { expanded: overrides.expanded } : {}),
      },
    })
  }

  describe('QueueBubble · 根门与单源行渲染', () => {
    it('rows 为空 → 不渲染（无待发条目即无队列区）', () => {
      const wrapper = mountQB()
      expect(wrapper.find('[data-testid="queue-bubble"]').exists()).toBe(false)
    })

    it('单条 queued 行 → Hourglass icon + 「排队中」chip + 预览文本（用户可见状态）', () => {
      const wrapper = mountQB({ rows: [row('u-1', '补充注册页校验', 'queued')] })
      expect(wrapper.find('[data-testid="queue-bubble"]').exists()).toBe(true)
      expect(wrapper.text()).toContain('补充注册页校验')
      expect(wrapper.text()).toContain('排队中')
      expect(wrapper.find('svg.lucide-hourglass').exists()).toBe(true)
      expect(wrapper.find('svg.lucide-zap').exists()).toBe(false)
    })

    it('in-flight 行 → Zap icon（accent）+「投递中」chip', () => {
      const wrapper = mountQB({ rows: [row('u-2', '正在投递的消息', 'in-flight')] })
      expect(wrapper.text()).toContain('正在投递的消息')
      expect(wrapper.text()).toContain('投递中')
      expect(wrapper.find('svg.lucide-zap').exists()).toBe(true)
      expect(wrapper.find('svg.lucide-hourglass').exists()).toBe(false)
    })

    it('failed 行 → AlertCircle（danger）+「发送未确认」chip（Q6 统一口径）+ 重试钮可见（§3.4 失败行）', () => {
      const wrapper = mountQB({ rows: [row('u-3', '未确认送达的文本', 'failed')] })
      expect(wrapper.text()).toContain('发送未确认')
      expect(wrapper.find('svg.lucide-circle-alert').exists()).toBe(true)
      expect(wrapper.find('[data-testid="queue-retry-u-3"]').exists()).toBe(true)
      // 状态 chip 用 danger 底/前景（红色标识）
      const chip = wrapper.find('[data-testid="queue-state-u-3"]')
      expect(chip.classes()).toContain('text-danger')
    })

    it('queued/in-flight 行不渲染重试钮（仅 failed 行有重试入口）', () => {
      const wrapper = mountQB({ rows: [row('u-4', '排队', 'queued'), row('u-5', '投递中', 'in-flight')] })
      expect(wrapper.find('[data-testid="queue-retry-u-4"]').exists()).toBe(false)
      expect(wrapper.find('[data-testid="queue-retry-u-5"]').exists()).toBe(false)
    })

    it('多条 → 显前 3 条 + 「+N」溢出计数（行序 = 帧序 = 内核 FIFO 发送序）', () => {
      const wrapper = mountQB({
        rows: [row('u-1', 'm1'), row('u-2', 'm2'), row('u-3', 'm3'), row('u-4', 'm4'), row('u-5', 'm5')],
      })
      expect(wrapper.findAll('.qb-item-text').map((w) => w.text())).toEqual(['m1', 'm2', 'm3'])
      expect(wrapper.text()).toContain('+2')
      expect(wrapper.text()).not.toContain('m4')
    })

    it('行 hover title = 传入的 hint（session 级占用分档文案）', () => {
      const wrapper = mountQB({ rows: [row('u-1', 'x')], hint: '等待命令执行结束后发送' })
      expect(wrapper.find('[data-testid="queue-item-u-1"]').attributes('title')).toBe('等待命令执行结束后发送')
    })

    it('failed 行 title 在 hint 之外附判重说明（Q6 分层：行 = 状态 + 恢复指引）', () => {
      const wrapper = mountQB({ rows: [row('u-6', '失败的', 'failed')], hint: '占用结束后发送' })
      const title = wrapper.find('[data-testid="queue-item-u-6"]').attributes('title') ?? ''
      expect(title).toContain('占用结束后发送')
      expect(title).toContain('点重试会自动判重，不会重复投递')
    })

    it('rows 变化 → 行跟随更新（响应式）；清空 → 根门关闭', async () => {
      const wrapper = mountQB({ rows: [row('u-1', 'first')] })
      expect(wrapper.text()).toContain('first')
      await wrapper.setProps({ rows: [row('u-1', 'first'), row('u-2', 'second')] })
      await nextTick()
      expect(wrapper.text()).toContain('second')
      await wrapper.setProps({ rows: [] })
      await nextTick()
      expect(wrapper.find('[data-testid="queue-bubble"]').exists()).toBe(false)
    })
  })

  describe('QueueBubble · 行操作（撤销 / 重试）', () => {
    it('× 撤销：点击 emit cancel(clientUuid)，title=撤销排队（hover 揭示载体）', async () => {
      const wrapper = mountQB({ rows: [row('u-9', '待撤销消息')] })
      const cancel = wrapper.find('[data-testid="queue-cancel-u-9"]')
      expect(cancel.exists()).toBe(true)
      expect(cancel.attributes('disabled')).toBeUndefined()
      const anchor = wrapper.find('[data-testid="queue-cancel-anchor-u-9"]')
      expect(anchor.attributes('title')).toBe('撤销排队')
      await cancel.trigger('click')
      expect(wrapper.emitted('cancel')).toEqual([['u-9']])
    })

    it('in-flight 行 × 同样可撤（V10：投递中走内核收回-重投，UI 无禁用态）', async () => {
      const wrapper = mountQB({ rows: [row('u-10', '投递中的消息', 'in-flight')] })
      const cancel = wrapper.find('[data-testid="queue-cancel-u-10"]')
      await cancel.trigger('click')
      expect(wrapper.emitted('cancel')).toEqual([['u-10']])
    })

    it('failed 行重试：点击 emit retry(clientUuid)，title=重试发送', async () => {
      const wrapper = mountQB({ rows: [row('u-11', '失败的消息', 'failed')] })
      const retry = wrapper.find('[data-testid="queue-retry-u-11"]')
      const anchor = retry.element.closest('span')
      expect(anchor?.getAttribute('title')).toBe('重试发送')
      await retry.trigger('click')
      expect(wrapper.emitted('retry')).toEqual([['u-11']])
      // 重试不等于撤销：cancel 通道未被触发
      expect(wrapper.emitted('cancel')).toBeUndefined()
    })

    it('无 chevron 折叠控件（+N 开关为纯文字 Button，无 chevron 图标形态）', () => {
      const wrapper = mountQB({ rows: [row('u-1', 'x')] })
      expect(wrapper.find('svg.lucide-chevron-right').exists()).toBe(false)
    })
  })

  describe('QueueBubble · +N 展开开关（Q2）与重试全部（Q5）', () => {
    const FIVE_ROWS = [row('u-1', 'm1'), row('u-2', 'm2'), row('u-3', 'm3'), row('u-4', 'm4'), row('u-5', 'm5')]

    it('+N 为可点开关：点击 emit toggleExpand，aria-expanded 反映展开态（用户可见展开入口）', async () => {
      const wrapper = mountQB({ rows: FIVE_ROWS })
      expect(wrapper.text()).toContain('+2')
      const expander = wrapper.find('[data-testid="queue-expand"]')
      expect(expander.exists()).toBe(true)
      expect(expander.attributes('aria-expanded')).toBe('false')
      await expander.trigger('click')
      expect(wrapper.emitted('toggleExpand')).toHaveLength(1)
    })

    it('expanded=true → 全部行渲染（被折叠行可见，行操作天然可用）+ 无 +N 溢出', async () => {
      const wrapper = mountQB({ rows: FIVE_ROWS, expanded: true })
      expect(wrapper.findAll('.qb-item-text').map((w) => w.text())).toEqual(['m1', 'm2', 'm3', 'm4', 'm5'])
      expect(wrapper.find('[data-testid="queue-expand"]').exists()).toBe(false)
      // 收起出口：收起后仍有溢出行才显示
      expect(wrapper.find('[data-testid="queue-collapse"]').exists()).toBe(true)
      await wrapper.find('[data-testid="queue-collapse"]').trigger('click')
      expect(wrapper.emitted('toggleExpand')).toHaveLength(1)
    })

    it('展开但无溢出（行数 ≤ 上限）→ 不渲染收起出口', () => {
      const wrapper = mountQB({ rows: [row('u-1', 'm1'), row('u-2', 'm2')], expanded: true })
      expect(wrapper.find('[data-testid="queue-collapse"]').exists()).toBe(false)
    })

    it('failed ≥2 → 「重试全部失败项」入口可见，点击 emit retryAll', async () => {
      const wrapper = mountQB({
        rows: [row('u-11', '失败一', 'failed'), row('u-12', '失败二', 'failed'), row('u-13', '排队', 'queued')],
      })
      const retryAll = wrapper.find('[data-testid="queue-retry-all"]')
      expect(retryAll.exists()).toBe(true)
      expect(retryAll.text()).toContain('重试全部失败项')
      await retryAll.trigger('click')
      expect(wrapper.emitted('retryAll')).toHaveLength(1)
    })

    it('failed <2 → 不渲染重试全部入口（单条走行内重试钮）', () => {
      const wrapper = mountQB({ rows: [row('u-11', '失败一', 'failed'), row('u-13', '排队', 'queued')] })
      expect(wrapper.find('[data-testid="queue-retry-all"]').exists()).toBe(false)
    })
  })
}

// ══════════ 来源：queue-bubble-edit.test.ts ══════════
{
  function row(clientUuid: string, preview: string, state: QueueRow['state'] = 'queued'): QueueRow {
    return { clientUuid, preview, state }
  }

  function mountQB(
    overrides: { rows?: QueueRow[]; hint?: string; editingClientUuid?: string | null } = {},
  ) {
    return mount(QueueBubble, {
      props: {
        rows: overrides.rows ?? [row('u-1', '排队的消息文本')],
        hint: '占用结束后发送',
        ...(overrides.editingClientUuid !== undefined ? { editingClientUuid: overrides.editingClientUuid } : {}),
      },
    })
  }

  describe('QueueBubble · ✎ 编辑入口（D6）', () => {
    it('queued 行渲染 ✎ 钮，点击 emit edit 带条目 id', async () => {
      const wrapper = mountQB({ rows: [row('u-1', '排队中的消息')] })
      const btn = wrapper.find('[data-testid="queue-edit-u-1"]')
      expect(btn.exists()).toBe(true)
      await btn.trigger('click')
      expect(wrapper.emitted('edit')).toEqual([['u-1']])
    })

    it('failed 行 ✎ 钮同样可用（E7：failed 行可编辑），与重试/撤销并存', async () => {
      const wrapper = mountQB({ rows: [row('u-f', '发送未确认的文本', 'failed')] })
      expect(wrapper.find('[data-testid="queue-edit-u-f"]').exists()).toBe(true)
      expect(wrapper.find('[data-testid="queue-retry-u-f"]').exists()).toBe(true)
      expect(wrapper.find('[data-testid="queue-cancel-u-f"]').exists()).toBe(true)
      await wrapper.find('[data-testid="queue-edit-u-f"]').trigger('click')
      expect(wrapper.emitted('edit')).toEqual([['u-f']])
    })
  })

  describe('QueueBubble · 编辑态提示条（D6）', () => {
    it('editingClientUuid 非空 → 提示条渲染（编辑态文案 + 放弃编辑入口）', () => {
      const wrapper = mountQB({ editingClientUuid: 'u-1' })
      const banner = wrapper.find('[data-testid="queue-edit-banner"]')
      expect(banner.exists()).toBe(true)
      expect(banner.text()).toContain('正在编辑排队消息')
      expect(banner.text()).toContain('放弃编辑')
      expect(wrapper.find('[data-testid="queue-edit-abandon"]').exists()).toBe(true)
    })

    it('editingClientUuid 空（缺省）→ 提示条不渲染', () => {
      const wrapper = mountQB({})
      expect(wrapper.find('[data-testid="queue-edit-banner"]').exists()).toBe(false)
    })

    it('提示条显隐跟随 prop 变化（条目离场由壳层解除锚定 → prop 翻空 → 提示条消失）', async () => {
      const wrapper = mountQB({ editingClientUuid: 'u-1' })
      expect(wrapper.find('[data-testid="queue-edit-banner"]').exists()).toBe(true)
      await wrapper.setProps({ editingClientUuid: null })
      expect(wrapper.find('[data-testid="queue-edit-banner"]').exists()).toBe(false)
    })

    it('「放弃编辑」点击 emit abandonEdit（解除锚定草稿保留——语义在壳层）', async () => {
      const wrapper = mountQB({ editingClientUuid: 'u-1' })
      await wrapper.find('[data-testid="queue-edit-abandon"]').trigger('click')
      expect(wrapper.emitted('abandonEdit')).toHaveLength(1)
    })
  })
}

// ══════════ 来源：block-ansi.test.ts ══════════
{
  function makeTool(over: Partial<ToolCall> = {}): ToolCall {
    return {
      id: 'tc-1',
      toolName: 'bash',
      input: { command: 'echo hello' },
      output: 'hello',
      status: 'completed',
      startTime: Date.now(),
      ...over,
    }
  }

  /** Tool 默认收起，需点击 header 展开。返回展开后的 wrapper。 */
  async function mountExpanded(tool: ToolCall) {
    const wrapper = mount(Block, {
      props: { type: 'tool', tool },
      // Block setup 顶部经 useChatViewDeps inject 壳依赖（ui-optimize-unified N1 起），直接 mount 必须注入 mock deps
      global: { provide: mockChatProvide() },
    })
    // tool 详情默认收起（toolCollapsed=true），点击 header 展开
    const header = wrapper.find('.cursor-pointer')
    expect(header.exists()).toBe(true)
    await header.trigger('click')
    return wrapper
  }

  describe('Block ANSI 兜底渲染', () => {
    it('E1: outputRaw 含 ANSI → 用 AnsiText 渲染（data-testid="ansi-text" 存在）', async () => {
      const tool = makeTool({
        output: 'hello',
        outputRaw: '\x1b[32mhello\x1b[0m',
      })
      const wrapper = await mountExpanded(tool)

      // AnsiText 组件渲染了 data-testid="ansi-text"
      expect(wrapper.find('[data-testid="ansi-text"]').exists()).toBe(true)
    })

    it('outputRaw 不存在 → 回退纯文本 span（无 AnsiText）', async () => {
      const tool = makeTool({
        output: 'plain result',
      })
      const wrapper = await mountExpanded(tool)

      // 无 AnsiText
      expect(wrapper.find('[data-testid="ansi-text"]').exists()).toBe(false)
      // 有纯文本 result
      expect(wrapper.text()).toContain('plain result')
    })

    it('details.__gui__ 存在 → 优先用 GuiComponentRenderer 渲染 card（data-testid="gui-card" 存在）', async () => {
      const tool = makeTool({
        toolName: 'read',
        output: 'done',
        details: {
          __gui__: {
            v: 1,
            component: {
              type: 'card',
              props: { variant: 'default', body: [] },
            },
          },
        },
      })
      const wrapper = await mountExpanded(tool)

      // GuiComponentRenderer 渲染（容器 testid 存在）
      expect(wrapper.find('[data-testid="gui-component-renderer"]').exists()).toBe(true)
      // card 已实现，GuiComponentRenderer 路由到 Card 组件（gui-card testid 存在）
      expect(wrapper.find('[data-testid="gui-card"]').exists()).toBe(true)
    })
  })
}
