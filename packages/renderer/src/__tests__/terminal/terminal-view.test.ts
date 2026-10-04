/**
 * TerminalView 组件级测试（多实例 u2）。
 *
 * mock 策略：
 * - vi.mock('@xterm/xterm' / addon-*) —— happy-dom 无 canvas，xterm.open() 会抛错，必须 mock
 * - vi.mock('@/composables/features/terminal/useTerminal') —— 隔离实例域/PTY 逻辑
 * - vi.mock('@/stores/session') —— getSessionCwd 依赖
 *
 * 三视角（规则 5-8）：
 * - 观察者：DOM 渲染（terminal-view / terminal-xterm / toolbar / 实例切换条）
 * - 使用者：交互（clear / kill / 切换实例 / 关闭实例）
 * - 构建者：mount 后对账 + 自动新建（首挂载不夺焦）；切换实例后焦点落当前实例输入区
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/terminal/terminal-view.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { ref } from 'vue'

// happy-dom 无 ResizeObserver，TerminalView 依赖它（fit addon），需 polyfill
class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
;(globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver

// ── mock xterm（happy-dom 无 canvas，Terminal.open() 会抛）────────────────
const xtermInstances = vi.hoisted(() => [] as Array<Record<string, ReturnType<typeof vi.fn>>>)
function createMockTerminal() {
  const instance = {
    onData: vi.fn(),
    onResize: vi.fn(),
    onSelectionChange: vi.fn(),
    loadAddon: vi.fn(),
    open: vi.fn(),
    write: vi.fn(),
    clear: vi.fn(),
    dispose: vi.fn(),
    focus: vi.fn(),
    hasSelection: vi.fn(() => false),
    getSelection: vi.fn(() => ''),
    getSelectionPosition: vi.fn(() => ({ start: { x: 0, y: 0 }, end: { x: 5, y: 0 } })),
    unicode: { activeVersion: '6' },
  }
  xtermInstances.push(instance)
  return instance
}
vi.mock('@xterm/xterm', () => ({
  Terminal: function MockTerminal() { return createMockTerminal() },
}))
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: function MockFitAddon() {
    return { fit: vi.fn(), proposeDimensions: () => ({ cols: 80, rows: 24 }) }
  },
}))
vi.mock('@xterm/addon-web-links', () => ({
  WebLinksAddon: function MockWebLinksAddon() { return {} },
}))
vi.mock('@xterm/addon-search', () => ({
  SearchAddon: function MockSearchAddon() { return {} },
}))
vi.mock('@xterm/addon-unicode11', () => ({
  Unicode11Addon: function MockUnicode11Addon() { return {} },
}))
vi.mock('@xterm/xterm/css/xterm.css', () => ({}))

// ── mock useTerminal（隔离实例域/PTY 逻辑）──────────────────────────────
// TerminalView 用 terminal.current（ComputedRef）访问状态，模板自动 unwrap，需用真 ref。
const mockState = {
  buffer: { chunks: [] as string[], version: 0 },
  outputQueue: [] as string[],
  rafPending: false,
  ptyAlive: false,
  cols: 80,
  rows: 24,
}
const currentRef = ref(mockState)
const instancesRef = ref<Array<{ terminalId: string; seq: number; alive: boolean }>>([])
const activeRef = ref<string | null>(null)
const useTerminalMock = {
  current: currentRef,
  instances: instancesRef,
  activeTerminalId: activeRef,
  // 类型契约：spawnTerminal 返回 Promise<string>（spawn-feedback 链 .catch）
  spawnTerminal: vi.fn(async () => 'term:test-session:1'),
  selectInstance: vi.fn((terminalId: string) => {
    activeRef.value = terminalId
  }),
  closeInstance: vi.fn(),
  reconcileInstances: vi.fn(async () => ({ ok: true, count: 0 })),
  writeToTerminal: vi.fn(),
  resizeTerminal: vi.fn(),
  killTerminal: vi.fn(),
  attachTerminal: vi.fn(),
  partitionOf: vi.fn(() => mockState),
  registerFlushListener: vi.fn(() => () => {}),
}
vi.mock('@/composables/features/terminal/useTerminal', () => ({
  useTerminal: () => useTerminalMock,
  // 回放纯函数：mock 返回 null（无可回放；回放内容由 raf-queue 测试覆盖）
  replayChunks: () => null,
  replayChunksBatched: () => null,
}))

// ── mock session store（getSessionCwd 依赖）────────────────────────────────
vi.mock('@/stores/session', () => ({
  useSessionStore: () => ({
    list: [{ id: 'test-session', cwd: '/tmp/test-cwd' }],
  }),
}))

import TerminalView from '@/components/panel/TerminalView.vue'

let wrapper: ReturnType<typeof mount> | null = null

beforeEach(() => {
  setActivePinia(createPinia())
  mockState.buffer = { chunks: [], version: 0 }
  mockState.outputQueue = []
  mockState.rafPending = false
  mockState.ptyAlive = false
  mockState.cols = 80
  mockState.rows = 24
  xtermInstances.length = 0
  instancesRef.value = []
  activeRef.value = null
  useTerminalMock.spawnTerminal.mockClear()
  useTerminalMock.spawnTerminal.mockResolvedValue('term:test-session:1')
  useTerminalMock.attachTerminal.mockClear()
  useTerminalMock.killTerminal.mockClear()
  useTerminalMock.selectInstance.mockClear()
  useTerminalMock.closeInstance.mockClear()
  useTerminalMock.reconcileInstances.mockClear()
  useTerminalMock.reconcileInstances.mockResolvedValue({ ok: true, count: 0 })
  useTerminalMock.registerFlushListener.mockClear()
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
})

describe('TerminalView 渲染 gate（观察者视角）', () => {
  it('TV-1: mount 后 DOM 含 terminal-view + terminal-xterm + head 一行（实例切换条含收起按钮，无独立工具栏行）', async () => {
    wrapper = mount(TerminalView, { props: { sessionId: 'test-session' }, attachTo: document.body })
    await flushPromises()

    expect(document.body.querySelector('[data-testid="terminal-view"]')).toBeTruthy()
    expect(document.body.querySelector('[data-testid="terminal-xterm"]')).toBeTruthy()
    expect(document.body.querySelector('[data-testid="terminal-instance-bar"]')).toBeTruthy()
    // head 一行（三卡化 2026-10-04）：收起按钮在位、独立工具栏行不复存在
    expect(document.body.querySelector('[data-testid="terminal-collapse"]')).toBeTruthy()
    expect(document.body.querySelector('[data-testid="terminal-toolbar"]')).toBeNull()
  })

  it('TV-2: 空态下收起按钮可用；原工具栏（clear/kill）随 head 一行化不复存在', async () => {
    wrapper = mount(TerminalView, { props: { sessionId: 'test-session' }, attachTo: document.body })
    await flushPromises()

    const collapse = document.body.querySelector('[data-testid="terminal-collapse"]') as HTMLButtonElement
    expect(collapse).toBeTruthy()
    expect(collapse.disabled).toBe(false)
    expect(document.body.querySelector('[data-testid="terminal-btn-clear"]')).toBeNull()
    expect(document.body.querySelector('[data-testid="terminal-btn-kill"]')).toBeNull()
  })
})

describe('TerminalView 实例激活（构建者视角）', () => {
  it('TV-3: mount → 对账；成功空清单 → 自动新建默认实例（存量会话无感）', async () => {
    wrapper = mount(TerminalView, { props: { sessionId: 'test-session' }, attachTo: document.body })
    await flushPromises()

    expect(useTerminalMock.reconcileInstances).toHaveBeenCalledTimes(1)
    expect(useTerminalMock.spawnTerminal).toHaveBeenCalledTimes(1)
    expect(useTerminalMock.spawnTerminal.mock.calls[0]![0]).toBe('/tmp/test-cwd')
  })

  it('TV-13: 首挂载自动新建（ack 异步建档落位）不夺焦（设计目标 5：开面板体感不变）', async () => {
    // 生产时序：spawn RPC 异步往返，ack 建档晚于挂载轮——用受控 deferred 复现该时序
    const deferred: { resolve?: (terminalId: string) => void } = {}
    useTerminalMock.spawnTerminal.mockImplementation(
      () => new Promise<string>((resolve) => { deferred.resolve = resolve }),
    )
    wrapper = mount(TerminalView, { props: { sessionId: 'test-session' }, attachTo: document.body })
    await flushPromises() // 挂载轮（对账 → 发起自动新建）完成

    activeRef.value = 'term:test-session:1' // ack 建档：active 落位
    deferred.resolve?.('term:test-session:1')
    await flushPromises()

    // 实例 xterm 已建立，但首挂载建档沿不落焦（非用户手势）
    expect(xtermInstances.length).toBeGreaterThan(0)
    for (const inst of xtermInstances) expect(inst.focus).not.toHaveBeenCalled()
  })

  it('TV-14: 面板先以 sessionId=null 挂载、后经 loadSession 绑上会话 → 绑定轮不夺焦，绑定完成后切换实例按焦点规则落新实例输入区', async () => {
    // 真实路径：stores/panel.ts initialLeaf.sessionId=null → loadSession(null)（面板先挂载）
    // → 后续 loadSession(sid) 绑上会话（prop 变化）。
    const w = mount(TerminalView, { props: { sessionId: null }, attachTo: document.body })
    wrapper = w
    await flushPromises()
    expect(useTerminalMock.reconcileInstances).not.toHaveBeenCalled()

    // 受控 deferred 复现 ack 异步建档落位（spawn RPC 往返晚于绑定轮）
    const deferred: { resolve?: (terminalId: string) => void } = {}
    useTerminalMock.spawnTerminal.mockImplementation(
      () => new Promise<string>((resolve) => { deferred.resolve = resolve }),
    )

    // 绑上会话（loadSession → sessionId prop 变化）：对账 → 自动新建（ack 挂起）
    await w.setProps({ sessionId: 'test-session' })
    await flushPromises()
    expect(useTerminalMock.reconcileInstances).toHaveBeenCalledTimes(1)

    // ack 建档落位：实例清单 + active 落位
    instancesRef.value = [{ terminalId: 'term:test-session:1', seq: 1, alive: true }]
    activeRef.value = 'term:test-session:1'
    deferred.resolve?.('term:test-session:1')
    await flushPromises()

    // 绑定轮内不夺焦（首挂载语义，设计目标 5）
    expect(xtermInstances.length).toBeGreaterThan(0)
    for (const inst of xtermInstances) expect(inst.focus).not.toHaveBeenCalled()

    // 绑定完成（ack 建档、可写）→ 交互门置位：用户手势切换实例 → 焦点落新显示实例
    // （未置位时本条必红：watcher 因 interactive=false 不调 focus）
    instancesRef.value = [
      { terminalId: 'term:test-session:1', seq: 1, alive: true },
      { terminalId: 'term:test-session:2', seq: 2, alive: true },
    ]
    await flushPromises()
    const items = document.body.querySelectorAll('[data-testid="terminal-instance-item"]')
    expect(items).toHaveLength(2)
    ;(items[1] as HTMLButtonElement).dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushPromises()

    expect(useTerminalMock.selectInstance).toHaveBeenCalledWith('term:test-session:2')
    const xterm = xtermInstances[xtermInstances.length - 1]!
    expect(xterm.focus).toHaveBeenCalled()
  })

  it('TV-4: 对账清单非空 → 不自动新建（复用后台存活实例）', async () => {
    instancesRef.value = [{ terminalId: 'term:test-session:1', seq: 1, alive: true }]
    activeRef.value = 'term:test-session:1'
    useTerminalMock.reconcileInstances.mockResolvedValue({ ok: true, count: 1 })
    wrapper = mount(TerminalView, { props: { sessionId: 'test-session' }, attachTo: document.body })
    await flushPromises()

    expect(useTerminalMock.reconcileInstances).toHaveBeenCalledTimes(1)
    expect(useTerminalMock.spawnTerminal).not.toHaveBeenCalled()
    expect(useTerminalMock.attachTerminal).toHaveBeenCalled()
  })

  it('TV-5: 对账拉取失败 → 不自动新建（不与后台存活实例撞号并存）', async () => {
    useTerminalMock.reconcileInstances.mockResolvedValue({ ok: false, count: -1 })
    wrapper = mount(TerminalView, { props: { sessionId: 'test-session' }, attachTo: document.body })
    await flushPromises()

    expect(useTerminalMock.spawnTerminal).not.toHaveBeenCalled()
  })

  it('TV-6: sessionId 为 null 时不渲染 xterm、不对账、不 spawn', async () => {
    wrapper = mount(TerminalView, { props: { sessionId: null }, attachTo: document.body })
    await flushPromises()

    expect(document.body.querySelector('[data-testid="terminal-view"]')).toBeTruthy()
    expect(useTerminalMock.reconcileInstances).not.toHaveBeenCalled()
    expect(useTerminalMock.spawnTerminal).not.toHaveBeenCalled()
  })
})

describe('TerminalView 交互（使用者视角）', () => {
  it('TV-8: 切换条条目点击 → selectInstance（焦点随 active 变化落当前实例输入区）', async () => {
    instancesRef.value = [
      { terminalId: 'term:test-session:1', seq: 1, alive: true },
      { terminalId: 'term:test-session:2', seq: 2, alive: true },
    ]
    activeRef.value = 'term:test-session:1'
    useTerminalMock.reconcileInstances.mockResolvedValue({ ok: true, count: 2 })
    wrapper = mount(TerminalView, { props: { sessionId: 'test-session' }, attachTo: document.body })
    await flushPromises()

    const items = document.body.querySelectorAll('[data-testid="terminal-instance-item"]')
    expect(items).toHaveLength(2)
    ;(items[1] as HTMLButtonElement).dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushPromises()

    expect(useTerminalMock.selectInstance).toHaveBeenCalledWith('term:test-session:2')
    // 切换实例 → 新 xterm 重建并落焦点
    const xterm = xtermInstances[xtermInstances.length - 1]!
    expect(xterm.focus).toHaveBeenCalled()
  })

  it('TV-9: 关闭实例按钮在当前实例非最后时可用 → closeInstance', async () => {
    instancesRef.value = [
      { terminalId: 'term:test-session:1', seq: 1, alive: true },
      { terminalId: 'term:test-session:2', seq: 2, alive: true },
    ]
    activeRef.value = 'term:test-session:1'
    useTerminalMock.reconcileInstances.mockResolvedValue({ ok: true, count: 2 })
    wrapper = mount(TerminalView, { props: { sessionId: 'test-session' }, attachTo: document.body })
    await flushPromises()

    const closeBtns = document.body.querySelectorAll('[data-testid="terminal-instance-close"]')
    expect(closeBtns).toHaveLength(2)
    ;(closeBtns[1] as HTMLButtonElement).dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushPromises()
    expect(useTerminalMock.closeInstance).toHaveBeenCalledWith('term:test-session:2')
  })

  it('TV-10: 最后实例关闭按钮禁用态沿用 u3-bar 组件行为（不 emit close）', async () => {
    instancesRef.value = [{ terminalId: 'term:test-session:1', seq: 1, alive: true }]
    activeRef.value = 'term:test-session:1'
    useTerminalMock.reconcileInstances.mockResolvedValue({ ok: true, count: 1 })
    wrapper = mount(TerminalView, { props: { sessionId: 'test-session' }, attachTo: document.body })
    await flushPromises()

    const closeBtn = document.body.querySelector('[data-testid="terminal-instance-close"]') as HTMLButtonElement
    expect(closeBtn.disabled).toBe(true)
    closeBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushPromises()
    expect(useTerminalMock.closeInstance).not.toHaveBeenCalled()
  })

  it('TV-11: 「+」点击 → spawnTerminal 新建 + 自动切到新实例并聚焦其输入区', async () => {
    instancesRef.value = [{ terminalId: 'term:test-session:1', seq: 1, alive: true }]
    activeRef.value = 'term:test-session:1'
    useTerminalMock.reconcileInstances.mockResolvedValue({ ok: true, count: 1 })
    wrapper = mount(TerminalView, { props: { sessionId: 'test-session' }, attachTo: document.body })
    await flushPromises()
    useTerminalMock.spawnTerminal.mockClear()
    useTerminalMock.selectInstance.mockClear()

    // ack 回传新实例编号（终端 2）——不再停留在终端 1
    useTerminalMock.spawnTerminal.mockResolvedValue('term:test-session:2')
    const create = document.body.querySelector('[data-testid="terminal-instance-create"]') as HTMLButtonElement
    create.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushPromises()

    expect(useTerminalMock.spawnTerminal).toHaveBeenCalledTimes(1)
    // 2026-10-04 产品裁决：点「+」自动切到新实例
    expect(useTerminalMock.selectInstance).toHaveBeenCalledWith('term:test-session:2')
    expect(activeRef.value).toBe('term:test-session:2')
    // 视图重建到新实例并聚焦其输入区
    const xterm = xtermInstances[xtermInstances.length - 1]!
    expect(xterm.focus).toHaveBeenCalled()
  })

  it('TV-15: 空态点「+」→ 自动激活新实例并聚焦（active 原为 null 也不落空）', async () => {
    instancesRef.value = []
    activeRef.value = null
    useTerminalMock.reconcileInstances.mockResolvedValue({ ok: true, count: 0 })
    // 挂载轮空清单自动新建（mock 的 spawn 不建条目、不置 active）→ 空态、不夺焦
    useTerminalMock.spawnTerminal.mockResolvedValueOnce('term:test-session:1')
    wrapper = mount(TerminalView, { props: { sessionId: 'test-session' }, attachTo: document.body })
    await flushPromises()
    useTerminalMock.spawnTerminal.mockClear()
    useTerminalMock.selectInstance.mockClear()
    xtermInstances.length = 0

    // 空态下点「+」新建得终端 2（序号不回落由 runtime 保证，此处只断自动激活+聚焦）
    useTerminalMock.spawnTerminal.mockResolvedValueOnce('term:test-session:2')
    const create = document.body.querySelector('[data-testid="terminal-instance-create"]') as HTMLButtonElement
    create.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushPromises()

    expect(useTerminalMock.selectInstance).toHaveBeenCalledWith('term:test-session:2')
    expect(activeRef.value).toBe('term:test-session:2')
    const xterm = xtermInstances[xtermInstances.length - 1]!
    expect(xterm.focus).toHaveBeenCalled()
  })

  it('TV-12: 无选区时浮动按钮不显示', async () => {
    wrapper = mount(TerminalView, { props: { sessionId: 'test-session' }, attachTo: document.body })
    await flushPromises()
    expect(document.body.querySelector('[data-testid="terminal-send-to-ai"]')).toBeNull()
  })
})
