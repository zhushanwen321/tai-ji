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
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { defineComponent, h, ref } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
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

import { useTerminal } from '@/composables/features/terminal/useTerminal'

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
  terminalApiMock.spawn.mockClear()
  terminalApiMock.write.mockClear()
  terminalApiMock.resize.mockClear()
  terminalApiMock.kill.mockClear()
  terminalApiMock.attach.mockClear()
})

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
})
