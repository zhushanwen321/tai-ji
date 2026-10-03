/**
 * TerminalView spawn 失败反馈测试（RD-5#2 / 多实例 u2）。
 *
 * 背景：PTY 起不来时原实现丢弃裸 reject → 用户只看到空白终端。多实例后新建失败分两腿：
 * - 挂载自动新建腿（存量会话首开无实例）→ inline 错误条（terminal-spawn-error）+ 重试；
 * - 「+」手动新建腿（设计 §3.3「新建失败」）→ 既有全局错误通道（toast），不出现新条目。
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
    focus: vi.fn(),
    hasSelection: vi.fn(() => false),
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
}
const currentRef = ref(mockState)
const instancesRef = ref<Array<{ terminalId: string; seq: number; alive: boolean }>>([])
const activeRef = ref<string | null>(null)
const spawnTerminalMock = vi.fn(() => Promise.resolve('term:test-session:1'))
const useTerminalMock = {
  current: currentRef,
  instances: instancesRef,
  activeTerminalId: activeRef,
  spawnTerminal: spawnTerminalMock,
  selectInstance: vi.fn(),
  closeInstance: vi.fn(),
  reconcileInstances: vi.fn(async () => ({ ok: true, count: 0 })),
  writeToTerminal: vi.fn(),
  resizeTerminal: vi.fn(),
  killTerminal: vi.fn(),
  clearTerminal: vi.fn(),
  attachTerminal: vi.fn(),
  partitionOf: vi.fn(() => mockState),
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
import { useToast } from '@/composables/useToast'

let wrapper: ReturnType<typeof mount> | null = null

beforeEach(() => {
  setActivePinia(createPinia())
  mockState.buffer = { chunks: [], version: 0 }
  mockState.outputQueue = []
  mockState.rafPending = false
  mockState.ptyAlive = false
  mockState.cols = 80
  mockState.rows = 24
  instancesRef.value = []
  activeRef.value = null
  useToast().toasts.value = []
  spawnTerminalMock.mockReset()
  spawnTerminalMock.mockResolvedValue('term:test-session:1')
  useTerminalMock.reconcileInstances.mockReset()
  useTerminalMock.reconcileInstances.mockResolvedValue({ ok: true, count: 0 })
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
})

describe('TerminalView spawn 失败 inline 错误条（RD-5#2 挂载自动新建腿）', () => {
  it('spawn resolve → 不显示错误条', async () => {
    wrapper = mount(TerminalView, { props: { sessionId: 'test-session' }, attachTo: document.body })
    await flushPromises()

    expect(spawnTerminalMock).toHaveBeenCalledTimes(1)
    expect(document.body.querySelector('[data-testid="terminal-spawn-error"]')).toBeNull()
  })

  it('spawn reject → inline 错误条显示（含错误信息）+ 重试按钮', async () => {
    spawnTerminalMock.mockRejectedValue(new Error('pty limit reached'))
    wrapper = mount(TerminalView, { props: { sessionId: 'test-session' }, attachTo: document.body })
    await flushPromises()

    const bar = document.body.querySelector('[data-testid="terminal-spawn-error"]')
    expect(bar).toBeTruthy()
    expect(bar?.textContent).toContain('pty limit reached')
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

  it('对账清单非空（后台实例存活）→ 不 spawn、不显示错误条', async () => {
    instancesRef.value = [{ terminalId: 'term:test-session:1', seq: 1, alive: true }]
    activeRef.value = 'term:test-session:1'
    useTerminalMock.reconcileInstances.mockResolvedValue({ ok: true, count: 1 })
    wrapper = mount(TerminalView, { props: { sessionId: 'test-session' }, attachTo: document.body })
    await flushPromises()

    expect(spawnTerminalMock).not.toHaveBeenCalled()
    expect(document.body.querySelector('[data-testid="terminal-spawn-error"]')).toBeNull()
  })

  it('「+」手动新建失败 → 走全局错误通道（toast），不出现 inline 错误条', async () => {
    instancesRef.value = [{ terminalId: 'term:test-session:1', seq: 1, alive: true }]
    activeRef.value = 'term:test-session:1'
    useTerminalMock.reconcileInstances.mockResolvedValue({ ok: true, count: 1 })
    wrapper = mount(TerminalView, { props: { sessionId: 'test-session' }, attachTo: document.body })
    await flushPromises()
    spawnTerminalMock.mockRejectedValueOnce(new Error('spawn boom'))

    const create = document.body.querySelector('[data-testid="terminal-instance-create"]') as HTMLButtonElement
    create.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushPromises()

    expect(useToast().toasts.value).toHaveLength(1)
    expect(useToast().toasts.value[0]!.type).toBe('error')
    expect(useToast().toasts.value[0]!.message).toContain('spawn boom')
    expect(document.body.querySelector('[data-testid="terminal-spawn-error"]')).toBeNull()
  })

  it('挂载腿失败后点「+」新建成功 → 撤下 inline 错误条（错误态不跨腿泄漏）', async () => {
    spawnTerminalMock.mockRejectedValueOnce(new Error('mount boom'))
    wrapper = mount(TerminalView, { props: { sessionId: 'test-session' }, attachTo: document.body })
    await flushPromises()
    expect(document.body.querySelector('[data-testid="terminal-spawn-error"]')).toBeTruthy()

    // 「+」成功（spawnTerminalMock 默认 resolve）——错误态不得跨腿泄漏到已成功新建的场景
    const create = document.body.querySelector('[data-testid="terminal-instance-create"]') as HTMLButtonElement
    create.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushPromises()

    expect(document.body.querySelector('[data-testid="terminal-spawn-error"]')).toBeNull()
    expect(document.body.querySelector('[data-testid="terminal-spawn-retry"]')).toBeNull()
    expect(useToast().toasts.value).toHaveLength(0)
  })
})
