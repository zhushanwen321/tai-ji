/**
 * TerminalView 组件级测试（Phase 3 V3.1）。
 *
 * mock 策略：
 * - vi.mock('@xterm/xterm' / addon-*) —— happy-dom 无 canvas，xterm.open() 会抛错，必须 mock
 * - vi.mock('@/composables/features/terminal/useTerminal') —— 隔离 PTY 逻辑（useTerminal 的 WS 订阅已在 use-terminal.test.ts 覆盖）
 * - vi.mock('@/stores/session') —— getSessionCwd 依赖
 *
 * 三视角（规则 5-8）：
 * - 观察者：DOM 渲染（terminal-view / terminal-xterm / toolbar / clear+kill 按钮存在）
 * - 使用者：交互（clear / kill 点击）
 * - 构建者：mount 后 spawn 被调
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
// 每次 new Terminal() 返回新实例，避免多 mount/unmount 复用同一 mock 导致状态错乱
function createMockTerminal() {
  return {
    onData: vi.fn(),
    onResize: vi.fn(),
    onSelectionChange: vi.fn(),
    loadAddon: vi.fn(),
    open: vi.fn(),
    write: vi.fn(),
    clear: vi.fn(),
    dispose: vi.fn(),
    getSelection: vi.fn(() => ''),
    getSelectionPosition: vi.fn(() => ({ start: { x: 0, y: 0 }, end: { x: 5, y: 0 } })),
    unicode: { activeVersion: '6' },
  }
}
vi.mock('@xterm/xterm', () => ({
  Terminal: function MockTerminal() { return createMockTerminal() },
}))
// addon 用普通函数（可 new 调用），vi.fn 箭头函数不能 new
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
// xterm CSS import 在 vitest 无需真实加载
vi.mock('@xterm/xterm/css/xterm.css', () => ({}))

// ── mock useTerminal（隔离 PTY 逻辑）──────────────────────────────────────
// TerminalView 用 terminal.current（ComputedRef）访问状态，模板自动 unwrap，需用真 ref。
const mockState = {
  buffer: { chunks: [] as string[], version: 0 },
  outputQueue: [] as string[],
  rafPending: false,
  ptyAlive: false,
  cols: 80,
  rows: 24,
  pendingWrites: [] as string[],
}
const currentRef = ref(mockState)
const useTerminalMock = {
  current: currentRef,
  spawnTerminal: vi.fn(),
  writeToTerminal: vi.fn(),
  resizeTerminal: vi.fn(),
  killTerminal: vi.fn(),
  clearTerminal: vi.fn(),
  attachTerminal: vi.fn(),
  enqueueWrite: vi.fn(),
  registerFlushListener: vi.fn(() => () => {}),
}
vi.mock('@/composables/features/terminal/useTerminal', () => ({
  useTerminal: () => useTerminalMock,
  // D-6.2：TerminalView 挂载回放调用 replayChunks（分批版 replayChunksBatched）——
  // mock 返回 null（无可回放，本文件聚焦渲染/交互视角，回放内容由 raf-queue 测试覆盖）
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
  // 重置 mock 状态（每例隔离）
  mockState.buffer = { chunks: [], version: 0 }
  mockState.outputQueue = []
  mockState.rafPending = false
  mockState.ptyAlive = false
  mockState.cols = 80
  mockState.rows = 24
  mockState.pendingWrites = []
  useTerminalMock.spawnTerminal.mockClear()
  useTerminalMock.attachTerminal.mockClear()
  useTerminalMock.killTerminal.mockClear()
  useTerminalMock.writeToTerminal.mockClear()
  useTerminalMock.registerFlushListener.mockClear()
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
})

describe('TerminalView 渲染 gate（观察者视角，规则 8）', () => {
  it('TV-1: mount 后 DOM 含 terminal-view + terminal-xterm + toolbar', async () => {
    wrapper = mount(TerminalView, {
      props: { sessionId: 'test-session' },
      attachTo: document.body,
    })
    await flushPromises()

    expect(document.body.querySelector('[data-testid="terminal-view"]')).toBeTruthy()
    expect(document.body.querySelector('[data-testid="terminal-xterm"]')).toBeTruthy()
    expect(document.body.querySelector('[data-testid="terminal-toolbar"]')).toBeTruthy()
  })

  it('TV-2: 工具栏含 clear + kill 按钮', async () => {
    wrapper = mount(TerminalView, {
      props: { sessionId: 'test-session' },
      attachTo: document.body,
    })
    await flushPromises()

    expect(document.body.querySelector('[data-testid="terminal-btn-clear"]')).toBeTruthy()
    expect(document.body.querySelector('[data-testid="terminal-btn-kill"]')).toBeTruthy()
  })
})

describe('TerminalView spawn 编排（构建者视角）', () => {
  it('TV-3: mount 且 PTY 未活时调用 spawnTerminal（含 session cwd）', async () => {
    wrapper = mount(TerminalView, {
      props: { sessionId: 'test-session' },
      attachTo: document.body,
    })
    await flushPromises()

    expect(useTerminalMock.spawnTerminal).toHaveBeenCalledTimes(1)
    const args = useTerminalMock.spawnTerminal.mock.calls[0]!
    // 第一个参数是 cwd（取 session.cwd = /tmp/test-cwd）
    expect(args[0]).toBe('/tmp/test-cwd')
  })

  it('TV-4: PTY 已活时 mount 不重复 spawn', async () => {
    mockState.ptyAlive = true
    wrapper = mount(TerminalView, {
      props: { sessionId: 'test-session' },
      attachTo: document.body,
    })
    await flushPromises()

    expect(useTerminalMock.spawnTerminal).not.toHaveBeenCalled()
  })
})

describe('TerminalView 交互（使用者视角，规则 5）', () => {
  it('TV-5: 点击 kill 按钮调用 killTerminal', async () => {
    mockState.ptyAlive = true
    wrapper = mount(TerminalView, {
      props: { sessionId: 'test-session' },
      attachTo: document.body,
    })
    await flushPromises()

    const killBtn = document.body.querySelector('[data-testid="terminal-btn-kill"]') as HTMLButtonElement
    expect(killBtn).toBeTruthy()
    killBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushPromises()

    expect(useTerminalMock.killTerminal).toHaveBeenCalledTimes(1)
  })

  it('TV-6: sessionId 为 null 时不渲染 xterm（无活跃 session）', async () => {
    wrapper = mount(TerminalView, {
      props: { sessionId: null },
      attachTo: document.body,
    })
    await flushPromises()

    // terminal-view 容器存在，但 xterm 不初始化（onMounted 早退）
    expect(document.body.querySelector('[data-testid="terminal-view"]')).toBeTruthy()
    // spawn 不应被调用
    expect(useTerminalMock.spawnTerminal).not.toHaveBeenCalled()
  })
})

describe('TerminalView 选区浮动按钮（Phase 4 联动 1）', () => {
  it('TV-7: 无选区时浮动按钮不显示', async () => {
    wrapper = mount(TerminalView, {
      props: { sessionId: 'test-session' },
      attachTo: document.body,
    })
    await flushPromises()

    expect(document.body.querySelector('[data-testid="terminal-send-to-ai"]')).toBeNull()
  })

  // （TV-8 已删：「mount 不因选区逻辑报错」是恒真倾向弱断言，且「浮动按钮初始不显示」
  //  与 TV-7 重复；完整选区→按钮→注入链路归 UI E2E 验收 G5。）
})
