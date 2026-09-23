/**
 * TerminalView spawn 失败 inline 错误条测试（RD-5#2）。
 *
 * 背景：mount / 切 session 的 `void terminal.spawnTerminal(...)` 丢弃返回 Promise，
 * 而 spawnTerminal 内 `await terminalApi.spawn` 无 catch —— PTY 起不来时既无日志也无
 * 显形，用户只看到空白终端。修复：spawnTerminal 留痕 + rethrow；TerminalView 用
 * spawnWithFeedback 接住失败 → inline 错误条（terminal-spawn-error）+ 重试按钮
 * （terminal-spawn-retry），复用 FileView error 态范式。
 *
 * mock 策略：与 terminal-view.test.ts 同（xterm/addon/session store 全替身，
 * useTerminal 替身的 spawnTerminal 可注入 reject）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/terminal/terminal-view-spawn-error.test.ts
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
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: function MockFitAddon() {
    return { fit: vi.fn(), proposeDimensions: () => ({ cols: 80, rows: 24 }) }
  },
}))
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: function () { return {} } }))
vi.mock('@xterm/addon-search', () => ({ SearchAddon: function () { return {} } }))
vi.mock('@xterm/addon-unicode11', () => ({ Unicode11Addon: function () { return {} } }))
vi.mock('@xterm/xterm/css/xterm.css', () => ({}))

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
const spawnTerminalMock = vi.fn(() => Promise.resolve())
const useTerminalMock = {
  current: currentRef,
  spawnTerminal: spawnTerminalMock,
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
  replayChunks: () => null,
  replayChunksBatched: () => null,
}))

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
  mockState.pendingWrites = []
  spawnTerminalMock.mockReset()
  spawnTerminalMock.mockResolvedValue(undefined)
  useTerminalMock.attachTerminal.mockClear()
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
})

describe('TerminalView spawn 失败 inline 错误条（RD-5#2）', () => {
  it('spawn resolve → 不显示错误条', async () => {
    wrapper = mount(TerminalView, { props: { sessionId: 'test-session' }, attachTo: document.body })
    await flushPromises()

    expect(spawnTerminalMock).toHaveBeenCalledTimes(1)
    expect(document.body.querySelector('[data-testid="terminal-spawn-error"]')).toBeNull()
  })

  it('spawn reject → inline 错误条显示（含错误信息）+ 不再静默空白', async () => {
    spawnTerminalMock.mockRejectedValue(new Error('pty limit reached'))
    wrapper = mount(TerminalView, { props: { sessionId: 'test-session' }, attachTo: document.body })
    await flushPromises()

    const bar = document.body.querySelector('[data-testid="terminal-spawn-error"]')
    expect(bar).toBeTruthy()
    expect(bar?.textContent).toContain('pty limit reached')
    // 重试按钮可见（复用 FileView error 态范式）
    expect(document.body.querySelector('[data-testid="terminal-spawn-retry"]')).toBeTruthy()
  })

  it('点重试 → 清错误条并重发 spawn；重试成功则错误条消失', async () => {
    spawnTerminalMock.mockRejectedValueOnce(new Error('transient'))
    wrapper = mount(TerminalView, { props: { sessionId: 'test-session' }, attachTo: document.body })
    await flushPromises()
    expect(document.body.querySelector('[data-testid="terminal-spawn-error"]')).toBeTruthy()
    expect(spawnTerminalMock).toHaveBeenCalledTimes(1)

    const retry = document.body.querySelector('[data-testid="terminal-spawn-retry"]') as HTMLButtonElement
    retry.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushPromises()

    expect(spawnTerminalMock).toHaveBeenCalledTimes(2)
    expect(document.body.querySelector('[data-testid="terminal-spawn-error"]')).toBeNull()
  })

  it('PTY 已活时 mount 不 spawn、不显示错误条', async () => {
    mockState.ptyAlive = true
    wrapper = mount(TerminalView, { props: { sessionId: 'test-session' }, attachTo: document.body })
    await flushPromises()

    expect(spawnTerminalMock).not.toHaveBeenCalled()
    expect(document.body.querySelector('[data-testid="terminal-spawn-error"]')).toBeNull()
  })
})
