/**
 * useTerminal composable 单元测试（Phase 3 V3.2）。
 *
 * useTerminal 内部调 useSessionEvents，后者要求组件 setup（getCurrentInstance 守卫）。
 * 故用 defineComponent + mount 包裹 useTerminal，通过组件 expose 拿到返回值。
 *
 * 覆盖：per-session 状态 + spawn/write/resize/kill + enqueueWrite 时序。
 * WS handler（terminal.data/alive/exit 路由）的竞态防护由 useSessionEvents + useSessionScopedState
 * 保证（ADR-0049 已测），本测试聚焦 useTerminal 的编排逻辑。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/terminal/use-terminal.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { defineComponent, h, ref } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { ServerMessage } from '@taiji/shared'
import type { UseTerminalReturn } from '@/composables/features/terminal/useTerminal'

// ── mock terminalApi（隔离 RPC）────────────────────────────────────────────
const terminalApiMock = vi.hoisted(() => ({
  spawn: vi.fn(() => Promise.resolve()),
  write: vi.fn(() => Promise.resolve()),
  resize: vi.fn(() => Promise.resolve()),
  kill: vi.fn(() => Promise.resolve()),
  attach: vi.fn(() => Promise.resolve()),
}))
vi.mock('@taiji/core/transport/api/domains/terminal', () => ({
  terminalApi: terminalApiMock,
}))

import { useTerminal, __resetTerminalStateForTest } from '@/composables/features/terminal/useTerminal'
import { dispatchSession } from '@taiji/core/transport/api'
import { useToast } from '@/composables/useToast'

/** 测试宿主组件：在 setup 内调 useTerminal，expose 返回值。 */
function makeHost(sessionId: string | null) {
  return defineComponent({
    setup() {
      const sidRef = ref(sessionId)
      const terminal = useTerminal(sidRef)
      return { terminal, sidRef }
    },
    render: () => h('div'),
  })
}

beforeEach(() => {
  setActivePinia(createPinia())
  __resetTerminalStateForTest()
  terminalApiMock.spawn.mockClear()
  terminalApiMock.write.mockClear()
  terminalApiMock.resize.mockClear()
  terminalApiMock.kill.mockClear()
  terminalApiMock.attach.mockClear()
  useToast().toasts.value = []
})

afterEach(() => {
  vi.restoreAllMocks()
})

/** 构造 terminal.writeFailed 帧（route-inbound 按 payload.sessionId 走 session 通道）。 */
function writeFailedMsg(sid: string, message: string): ServerMessage {
  return {
    type: 'terminal.writeFailed',
    id: `push_test_${Math.random()}`,
    payload: { sessionId: sid, message },
  } as ServerMessage
}

describe('useTerminal 编排逻辑', () => {
  it('UT-1: current 在 null sid 时返回默认实例（ptyAlive=false, buffer 为空）', () => {
    const Host = makeHost(null)
    const wrapper = mount(Host)
    const terminal = wrapper.vm.terminal as UseTerminalReturn
    expect(terminal.current.value).toBeTruthy()
    expect(terminal.current.value.ptyAlive).toBe(false)
    expect(terminal.current.value.buffer.chunks).toEqual([])
    expect(terminal.current.value.buffer.version).toBe(0)
    wrapper.unmount()
  })

  it('UT-2: spawnTerminal 在 null sid 时 no-op', async () => {
    const Host = makeHost(null)
    const wrapper = mount(Host)
    const terminal = wrapper.vm.terminal as UseTerminalReturn
    await terminal.spawnTerminal('/tmp', 80, 24)
    expect(terminalApiMock.spawn).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('UT-3: spawnTerminal 调 terminalApi.spawn（含 sessionId + cwd + cols + rows）', async () => {
    const Host = makeHost('test-sid')
    const wrapper = mount(Host)
    const terminal = wrapper.vm.terminal as UseTerminalReturn
    await terminal.spawnTerminal('/test/cwd', 100, 30)
    await flushPromises()
    expect(terminalApiMock.spawn).toHaveBeenCalledTimes(1)
    expect(terminalApiMock.spawn).toHaveBeenCalledWith({ sessionId: 'test-sid', cwd: '/test/cwd', cols: 100, rows: 30 })
    wrapper.unmount()
  })

  it('UT-4: writeToTerminal 转发 terminalApi.write', () => {
    const Host = makeHost('s1')
    const wrapper = mount(Host)
    const terminal = wrapper.vm.terminal as UseTerminalReturn
    terminal.writeToTerminal('echo hi')
    expect(terminalApiMock.write).toHaveBeenCalledWith('s1', 'echo hi')
    wrapper.unmount()
  })

  it('UT-5: resizeTerminal 转发 + 更新分区 cols/rows', () => {
    const Host = makeHost('s1')
    const wrapper = mount(Host)
    const terminal = wrapper.vm.terminal as UseTerminalReturn
    terminal.resizeTerminal(120, 40)
    expect(terminalApiMock.resize).toHaveBeenCalledWith('s1', 120, 40)
    expect(terminal.current.value.cols).toBe(120)
    expect(terminal.current.value.rows).toBe(40)
    wrapper.unmount()
  })

  it('UT-8: killTerminal null sid 时 no-op', () => {
    const Host = makeHost(null)
    const wrapper = mount(Host)
    const terminal = wrapper.vm.terminal as UseTerminalReturn
    terminal.killTerminal()
    expect(terminalApiMock.kill).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  // ── RD-5#4：void 族全接 catch（失败不再成 unhandledrejection） ──────────

  it('RD5-4-C1: writeToTerminal 的 write RPC reject 被 catch + warn（不裸奔）', async () => {
    terminalApiMock.write.mockRejectedValueOnce(new Error('rpc down'))
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const Host = makeHost('s-c1')
    const wrapper = mount(Host)
    const terminal = wrapper.vm.terminal as UseTerminalReturn
    terminal.writeToTerminal('x')
    await vi.waitFor(() => expect(warnSpy).toHaveBeenCalled())
    wrapper.unmount()
  })

  it('RD5-4-C2: resize/kill/attach 的 RPC reject 全部被 catch + warn', async () => {
    terminalApiMock.resize.mockRejectedValueOnce(new Error('resize failed'))
    terminalApiMock.kill.mockRejectedValueOnce(new Error('kill failed'))
    terminalApiMock.attach.mockRejectedValueOnce(new Error('attach failed'))
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const Host = makeHost('s-c2')
    const wrapper = mount(Host)
    const terminal = wrapper.vm.terminal as UseTerminalReturn
    terminal.resizeTerminal(100, 30)
    terminal.killTerminal()
    terminal.attachTerminal()
    await vi.waitFor(() => expect(warnSpy).toHaveBeenCalledTimes(3))
    wrapper.unmount()
  })

  // ── RT-8#10/RD-5#4：terminal.writeFailed 订阅 → toast 显示链（M2 两端接通） ──

  it('RT8-10-R1: 订阅建立后收到 terminal.writeFailed → warn + warning toast（含 runtime 报的 message）', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const Host = makeHost('s-wf')
    const wrapper = mount(Host)
    const terminal = wrapper.vm.terminal as UseTerminalReturn
    // spawnTerminal 建立订阅（ensureTerminalSubscription 先于 RPC）
    await terminal.spawnTerminal('/tmp', 80, 24)
    await flushPromises()

    dispatchSession('s-wf', writeFailedMsg('s-wf', 'EPIPE: broken pipe'))

    await vi.waitFor(() => expect(warnSpy).toHaveBeenCalled())
    const { toasts } = useToast()
    expect(toasts.value).toHaveLength(1)
    expect(toasts.value[0]!.type).toBe('warning')
    expect(toasts.value[0]!.message).toContain('EPIPE')
    wrapper.unmount()
  })

  it('RT8-10-R2: 未订阅的 sid 收到 writeFailed 不产生 toast（session 隔离）', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const Host = makeHost('s-sub')
    const wrapper = mount(Host)
    const terminal = wrapper.vm.terminal as UseTerminalReturn
    await terminal.spawnTerminal('/tmp', 80, 24)
    await flushPromises()

    dispatchSession('s-other', writeFailedMsg('s-other', 'boom'))
    await flushPromises()

    expect(useToast().toasts.value).toHaveLength(0)
    wrapper.unmount()
  })
})
