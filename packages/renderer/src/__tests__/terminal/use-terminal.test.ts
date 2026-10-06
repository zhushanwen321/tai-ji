/**
 * useTerminal composable 单元测试（多实例 u2）。
 *
 * 主键迁移后：三表（输出分区 / 广播订阅 / flush 监听）与写队列全部按 **terminalId**
 * `term:<sid>:<n>` 分键；spawn 走「新建形态」由 ack 回传编号建档（四件事）。
 *
 * 覆盖：实例建档 / 实例与 PTY 控制 / 帧路由（按 terminalId 过滤）/ 关闭沿三腿 /
 * `terminal.list` 对账 / 世代变更失效重置 / `unknown_terminal_id` 平行守卫 / 会话销毁扇出。
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
  spawn: vi.fn(() => Promise.resolve({})),
  write: vi.fn(() => Promise.resolve()),
  resize: vi.fn(() => Promise.resolve()),
  kill: vi.fn(() => Promise.resolve()),
  attach: vi.fn(() => Promise.resolve()),
  list: vi.fn(() => Promise.resolve([])),
}))
vi.mock('@taiji/core/transport/api/domains/terminal', () => ({
  terminalApi: terminalApiMock,
}))

import {
  useTerminal,
  __resetTerminalStateForTest,
  __terminalPartitionCountForTest,
  __terminalSubscriptionCountForTest,
  __handleConnectionEstablishedForTest,
} from '@/composables/features/terminal/useTerminal'
import { hasInstance, setActiveTerminalId, unregisterInstance } from '@/composables/features/terminal/terminal-instance-registry'
import { dispatchSession } from '@taiji/core/transport/api'
import { triggerSessionCleanups } from '@/composables/useSessionScopedState'
import { useToast } from '@/composables/useToast'
import { useTerminalWriteQueueStore } from '@/stores/terminal-write-queue'

const T1 = 'term:s1:1'
const T2 = 'term:s1:2'

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

function host(sessionId: string | null): { wrapper: ReturnType<typeof mount>; terminal: UseTerminalReturn } {
  const wrapper = mount(makeHost(sessionId))
  return { wrapper, terminal: wrapper.vm.terminal as UseTerminalReturn }
}

/** 构造 terminal.* 广播帧（route-inbound 按 payload.sessionId 走 session 通道）。 */
function frame<T extends 'terminal.data' | 'terminal.alive' | 'terminal.exit' | 'terminal.writeFailed'>(
  type: T,
  sid: string,
  terminalId: string,
  extra: Record<string, unknown> = {},
): ServerMessage {
  return {
    type,
    id: `push_${Math.random()}`,
    payload: { sessionId: sid, terminalId, ...extra },
  } as ServerMessage
}

/** 带 code 的 RPC 错误（envelope 展开后 reject 的 Error）。 */
function rpcError(code: string): Error {
  return Object.assign(new Error(code), { code })
}

beforeEach(() => {
  setActivePinia(createPinia())
  __resetTerminalStateForTest()
  for (const key of Object.keys(terminalApiMock) as (keyof typeof terminalApiMock)[]) {
    terminalApiMock[key].mockClear()
  }
  terminalApiMock.spawn.mockResolvedValue({})
  terminalApiMock.list.mockResolvedValue([])
  useToast().toasts.value = []
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('useTerminal 实例域（多实例）', () => {
  it('UT-1: null sid → 默认分区（ptyAlive=false / 空 buffer）+ 空实例清单', () => {
    const { wrapper, terminal } = host(null)
    expect(terminal.current.value.ptyAlive).toBe(false)
    expect(terminal.current.value.buffer.chunks).toEqual([])
    expect(terminal.instances.value).toEqual([])
    expect(terminal.activeTerminalId.value).toBeNull()
    wrapper.unmount()
  })

  it('UT-2: spawnTerminal null sid → 拒绝且不发 RPC', async () => {
    const { wrapper, terminal } = host(null)
    await expect(terminal.spawnTerminal('/tmp', 80, 24)).rejects.toThrow()
    expect(terminalApiMock.spawn).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('UT-3: spawn 新建形态（不带 terminalId）→ ack 建档四件事', async () => {
    terminalApiMock.spawn.mockResolvedValue({ terminalId: T1 })
    const { wrapper, terminal } = host('s1')
    await terminal.spawnTerminal('/test/cwd', 100, 30)
    await flushPromises()

    // 新建形态：请求不带 terminalId（编号由 runtime 分配经 ack 回传）
    expect(terminalApiMock.spawn).toHaveBeenCalledWith({ sessionId: 's1', cwd: '/test/cwd', cols: 100, rows: 30 })
    // ①条目（含 seq/alive）②分区 ③订阅 ④存活镜像
    expect(terminal.instances.value).toEqual([{ terminalId: T1, seq: 1, alive: true }])
    expect(terminal.activeTerminalId.value).toBe(T1)
    expect(terminal.current.value.ptyAlive).toBe(true)
    expect(terminal.current.value.cols).toBe(100)
    expect(terminal.current.value.rows).toBe(30)
    expect(__terminalPartitionCountForTest()).toBe(1)
    expect(__terminalSubscriptionCountForTest()).toBe(1)
    expect(useTerminalWriteQueueStore().isPtyAlive(T1)).toBe(true)
    wrapper.unmount()
  })

  it('UT-4: ack 缺 terminalId → 拒绝（不建档）', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    terminalApiMock.spawn.mockResolvedValue({})
    const { wrapper, terminal } = host('s1')
    await expect(terminal.spawnTerminal('/tmp', 80, 24)).rejects.toThrow('missing terminalId')
    expect(warnSpy).toHaveBeenCalled()
    expect(terminal.instances.value).toEqual([])
    wrapper.unmount()
  })

  it('UT-5: spawn RPC reject → 留痕 + rethrow', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    terminalApiMock.spawn.mockRejectedValue(new Error('pty limit reached'))
    const { wrapper, terminal } = host('s1')
    await expect(terminal.spawnTerminal('/tmp', 80, 24)).rejects.toThrow('pty limit reached')
    expect(warnSpy).toHaveBeenCalled()
    expect(terminal.instances.value).toEqual([])
    wrapper.unmount()
  })

  it('UT-6: write/resize/kill/attach 带当前实例编号转发', async () => {
    terminalApiMock.spawn.mockResolvedValue({ terminalId: T1 })
    const { wrapper, terminal } = host('s1')
    await terminal.spawnTerminal('/tmp', 80, 24)
    terminal.writeToTerminal('echo hi')
    expect(terminalApiMock.write).toHaveBeenCalledWith('s1', T1, 'echo hi')
    terminal.resizeTerminal(120, 40)
    expect(terminalApiMock.resize).toHaveBeenCalledWith('s1', T1, 120, 40)
    expect(terminal.current.value.cols).toBe(120)
    terminal.killTerminal()
    expect(terminalApiMock.kill).toHaveBeenCalledWith('s1', T1)
    terminal.attachTerminal()
    expect(terminalApiMock.attach).toHaveBeenCalledWith('s1', T1)
    wrapper.unmount()
  })

  it('UT-7: 空态（无实例）下 write/kill 为 no-op', () => {
    const { wrapper, terminal } = host('s1')
    terminal.writeToTerminal('x')
    terminal.killTerminal()
    expect(terminalApiMock.write).not.toHaveBeenCalled()
    expect(terminalApiMock.kill).not.toHaveBeenCalled()
    wrapper.unmount()
  })
})

describe('帧路由与实例隔离（按 terminalId 过滤）', () => {
  async function seedTwo(sid: string): Promise<{ wrapper: ReturnType<typeof mount>; terminal: UseTerminalReturn }> {
    terminalApiMock.spawn.mockResolvedValueOnce({ terminalId: T1 }).mockResolvedValueOnce({ terminalId: T2 })
    const h = host(sid)
    await h.terminal.spawnTerminal('/tmp', 80, 24)
    await h.terminal.spawnTerminal('/tmp', 80, 24)
    return h
  }

  it('RT-1: 同会话两实例各自分区——data 帧按 terminalId 落入对应分区', async () => {
    const { wrapper, terminal } = await seedTwo('s1')
    expect(terminal.instances.value.map((i) => i.terminalId)).toEqual([T1, T2])
    // 当前显示 T1：T1 的 data 进 T1 分区
    dispatchSession('s1', frame('terminal.data', 's1', T1, { data: 'from-t1' }))
    expect(terminal.current.value.outputQueue).toEqual(['from-t1'])
    // 切到 T2：T1 的历史不串（T2 分区空），T2 的 data 进 T2
    terminal.selectInstance(T2)
    expect(terminal.current.value.outputQueue).toEqual([])
    dispatchSession('s1', frame('terminal.data', 's1', T2, { data: 'from-t2' }))
    expect(terminal.current.value.outputQueue).toEqual(['from-t2'])
    // 切回 T1：历史仍在
    terminal.selectInstance(T1)
    expect(terminal.current.value.outputQueue).toEqual(['from-t1'])
    wrapper.unmount()
  })

  it('RT-2: 未建档编号的帧被丢弃（不建分区）', () => {
    const { wrapper, terminal } = host('s1')
    dispatchSession('s1', frame('terminal.data', 's1', 'term:s1:9', { data: 'ghost' }))
    expect(terminal.instances.value).toEqual([])
    expect(__terminalPartitionCountForTest()).toBe(0)
    wrapper.unmount()
  })

  it('RT-3: writeFailed 帧按 terminalId 过滤 → 仅本实例 toast', async () => {
    const { wrapper, terminal } = await seedTwo('s1')
    dispatchSession('s1', frame('terminal.writeFailed', 's1', T2, { message: 'EPIPE: broken pipe' }))
    // 订阅按 terminalId 过滤：T1 的 handler 不消费 T2 的帧，T2 的 handler 消费一次
    expect(useToast().toasts.value).toHaveLength(1)
    expect(useToast().toasts.value[0]!.message).toContain('EPIPE')
    void terminal
    wrapper.unmount()
  })

  it('RT-4: exit 帧 = 关闭沿三腿（分区/订阅/写队列实例态释放 + 滞留命令提示）', async () => {
    const { wrapper, terminal } = await seedTwo('s1')
    const store = useTerminalWriteQueueStore()
    // 造滞留命令：markExited 后入队（已建档未 alive 仍进 pendingWrites）
    store.markExited(T1)
    store.enqueueWrite(T1, 'pending-cmd')
    expect(store.pendingCountOf(T1)).toBe(1)

    dispatchSession('s1', frame('terminal.exit', 's1', T1, { exitCode: 0 }))
    await flushPromises()

    expect(terminal.instances.value.map((i) => i.terminalId)).toEqual([T2])
    expect(hasInstance(T1)).toBe(false)
    expect(__terminalPartitionCountForTest()).toBe(1) // 仅 T2 分区存活
    expect(__terminalSubscriptionCountForTest()).toBe(1)
    expect(store.pendingCountOf(T1)).toBe(0)
    // 死亡沿滞留命令丢弃 → 「输入可能丢失」提示
    expect(useToast().toasts.value.some((x) => x.message.includes('终端 1'))).toBe(true)
    wrapper.unmount()
  })
})

describe('关闭沿与焦点落位', () => {
  it('CL-1: closeInstance → kill RPC + 三腿清理 + active 落当前实例右邻（无右取左）', async () => {
    terminalApiMock.spawn.mockResolvedValueOnce({ terminalId: T1 }).mockResolvedValueOnce({ terminalId: T2 })
    const { wrapper, terminal } = host('s1')
    await terminal.spawnTerminal('/tmp', 80, 24)
    await terminal.spawnTerminal('/tmp', 80, 24)
    terminal.selectInstance(T2)
    expect(terminal.activeTerminalId.value).toBe(T2)

    terminal.closeInstance(T2)
    await flushPromises()

    expect(terminalApiMock.kill).toHaveBeenCalledWith('s1', T2)
    expect(terminal.instances.value.map((i) => i.terminalId)).toEqual([T1])
    expect(terminal.activeTerminalId.value).toBe(T1) // 无右取左
    expect(__terminalPartitionCountForTest()).toBe(1)
    expect(__terminalSubscriptionCountForTest()).toBe(1)
    wrapper.unmount()
  })

  it('CL-2: 关闭左实例时 active 落右邻', async () => {
    terminalApiMock.spawn.mockResolvedValueOnce({ terminalId: T1 }).mockResolvedValueOnce({ terminalId: T2 })
    const { wrapper, terminal } = host('s1')
    await terminal.spawnTerminal('/tmp', 80, 24)
    await terminal.spawnTerminal('/tmp', 80, 24)
    terminal.selectInstance(T1)
    terminal.closeInstance(T1)
    await flushPromises()
    expect(terminal.activeTerminalId.value).toBe(T2)
    wrapper.unmount()
  })
})

describe('自动新建腿同会话互斥（dmg-r1-3）', () => {
  it('MU-1: 同会话并发激活轮复用同一 spawn promise（只发一次 RPC），settle 后摘除', async () => {
    let resolveSpawn!: (v: { terminalId: string }) => void
    terminalApiMock.spawn.mockImplementationOnce(
      () => new Promise<{ terminalId: string }>((res) => { resolveSpawn = res }),
    )
    const { wrapper, terminal } = host('s1')
    // 模拟 terminal.list 往返窗口内两轮激活各见空清单：后到轮必须复用先到轮的 promise
    const p1 = terminal.spawnTerminalAuto('/tmp', 80, 24)
    const p2 = terminal.spawnTerminalAuto('/tmp', 80, 24)
    expect(p2).toBe(p1)
    expect(terminalApiMock.spawn).toHaveBeenCalledTimes(1)
    resolveSpawn({ terminalId: T1 })
    await expect(p1).resolves.toBe(T1)
    await expect(p2).resolves.toBe(T1)

    // settle 摘除：下一激活轮不再复用旧 promise（发新 RPC）
    const p3 = terminal.spawnTerminalAuto('/tmp', 80, 24)
    expect(terminalApiMock.spawn).toHaveBeenCalledTimes(2)
    p3.catch(() => {}) // ack 缺编号 reject（本用例只断言互斥行为）
    wrapper.unmount()
  })

  it('MU-2: 失败 settle 摘除 → 重试腿不复用失败 promise', async () => {
    terminalApiMock.spawn.mockRejectedValueOnce(new Error('pty limit reached'))
    const { wrapper, terminal } = host('s1')
    await expect(terminal.spawnTerminalAuto('/tmp', 80, 24)).rejects.toThrow('pty limit reached')

    terminalApiMock.spawn.mockResolvedValueOnce({ terminalId: T1 })
    await expect(terminal.spawnTerminalAuto('/tmp', 80, 24)).resolves.toBe(T1)
    expect(terminalApiMock.spawn).toHaveBeenCalledTimes(2)
    wrapper.unmount()
  })

  it('MU-3: 「+」显式新建不受互斥限制（同会话在途自动新建时仍发新 RPC）', async () => {
    let resolveSpawn!: (v: { terminalId: string }) => void
    terminalApiMock.spawn.mockImplementationOnce(
      () => new Promise<{ terminalId: string }>((res) => { resolveSpawn = res }),
    )
    const { wrapper, terminal } = host('s1')
    void terminal.spawnTerminalAuto('/tmp', 80, 24) // 自动腿在途
    // 显式腿（createWithToast → spawnTerminal）是用户显式意图，不受互斥限制
    terminalApiMock.spawn.mockResolvedValueOnce({ terminalId: T2 })
    await expect(terminal.spawnTerminal('/tmp', 80, 24)).resolves.toBe(T2)
    expect(terminalApiMock.spawn).toHaveBeenCalledTimes(2)
    resolveSpawn({ terminalId: T1 })
    await flushPromises()
    wrapper.unmount()
  })
})

describe('terminal.list 对账', () => {
  it('RC-1: 清单外条目按关闭沿三腿清理（含幽灵条目）', async () => {
    terminalApiMock.spawn.mockResolvedValueOnce({ terminalId: T1 }).mockResolvedValueOnce({ terminalId: T2 })
    const { wrapper, terminal } = host('s1')
    await terminal.spawnTerminal('/tmp', 80, 24)
    await terminal.spawnTerminal('/tmp', 80, 24)
    // runtime 只承认 T1（T2 是 ack 窗口内死亡的假阳幽灵）
    terminalApiMock.list.mockResolvedValue([{ terminalId: T1, alive: true }])
    const result = await terminal.reconcileInstances()
    expect(result).toEqual({ ok: true, count: 1 })
    expect(terminal.instances.value.map((i) => i.terminalId)).toEqual([T1])
    expect(hasInstance(T2)).toBe(false)
    expect(__terminalPartitionCountForTest()).toBe(1)
    expect(__terminalSubscriptionCountForTest()).toBe(1)
    wrapper.unmount()
  })

  it('RC-2: 清单内条目按 ack 同口径建档（订阅幂等）+ 不触达他会话键', async () => {
    // 会话 s1 一个实例；会话 s2 一个实例（他会话键，对账不得触达）
    terminalApiMock.spawn.mockResolvedValueOnce({ terminalId: T1 }).mockResolvedValueOnce({ terminalId: 'term:s2:1' })
    const h1 = host('s1')
    await h1.terminal.spawnTerminal('/tmp', 80, 24)
    const h2 = host('s2')
    await h2.terminal.spawnTerminal('/tmp', 80, 24)
    const subsBefore = __terminalSubscriptionCountForTest()
    const partitionsBefore = __terminalPartitionCountForTest()

    // s1 的清单含一个此前 renderer 不知道的实例（重连/刷新后重建场景）
    terminalApiMock.list.mockResolvedValue([
      { terminalId: T1, alive: true },
      { terminalId: 'term:s1:7', alive: true },
    ])
    const r1 = await h1.terminal.reconcileInstances()
    const r2 = await h1.terminal.reconcileInstances() // 幂等：订阅不重复建立
    expect(r1.ok).toBe(true)
    expect(r2.ok).toBe(true)
    expect(h1.terminal.instances.value.map((i) => i.terminalId)).toEqual([T1, 'term:s1:7'])
    expect(__terminalSubscriptionCountForTest()).toBe(subsBefore + 1)
    expect(__terminalPartitionCountForTest()).toBe(partitionsBefore + 1)
    // 他会话（s2）条目、分区、订阅原样
    expect(h2.terminal.instances.value.map((i) => i.terminalId)).toEqual(['term:s2:1'])
    expect(hasInstance('term:s2:1')).toBe(true)
    h1.wrapper.unmount()
    h2.wrapper.unmount()
  })

  it('RC-3: 清单内 pendingWrites 保持（alive=false 条目不 flush 不丢弃）', async () => {
    terminalApiMock.spawn.mockResolvedValue({ terminalId: T1 })
    const { wrapper, terminal } = host('s1')
    await terminal.spawnTerminal('/tmp', 80, 24)
    const store = useTerminalWriteQueueStore()
    store.markExited(T1)
    store.enqueueWrite(T1, 'keep-me')
    expect(store.pendingCountOf(T1)).toBe(1)

    terminalApiMock.list.mockResolvedValue([{ terminalId: T1, alive: false }])
    await terminal.reconcileInstances()
    expect(store.pendingCountOf(T1)).toBe(1)
    expect(terminalApiMock.write).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('RC-4: 拉取失败 → ok=false、保留既有条目、不清空（下次触发重试）', async () => {
    terminalApiMock.spawn.mockResolvedValue({ terminalId: T1 })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { wrapper, terminal } = host('s1')
    await terminal.spawnTerminal('/tmp', 80, 24)
    terminalApiMock.list.mockRejectedValue(new Error('transport down'))
    const result = await terminal.reconcileInstances()
    expect(result).toEqual({ ok: false, count: -1 })
    expect(terminal.instances.value.map((i) => i.terminalId)).toEqual([T1])
    expect(__terminalPartitionCountForTest()).toBe(1)
    expect(warnSpy).toHaveBeenCalled()
    wrapper.unmount()
  })

  it('RC-5: 对账批量建档多个新实例不改 active（刷新/世代重建不跳到最后一个条目）', async () => {
    terminalApiMock.spawn.mockResolvedValue({ terminalId: T1 })
    const { wrapper, terminal } = host('s1')
    await terminal.spawnTerminal('/tmp', 80, 24)
    expect(terminal.activeTerminalId.value).toBe(T1)

    // 刷新/重连恢复：runtime 清单含两个 renderer 尚不知道的实例，按注册顺序批量建档
    terminalApiMock.list.mockResolvedValue([
      { terminalId: T1, alive: true },
      { terminalId: 'term:s1:7', alive: true },
      { terminalId: 'term:s1:8', alive: true },
    ])
    const result = await terminal.reconcileInstances()
    expect(result).toEqual({ ok: true, count: 3 })
    expect(terminal.instances.value.map((i) => i.terminalId)).toEqual([T1, 'term:s1:7', 'term:s1:8'])
    // 对账路径不抢 active：仍停在此前选中的 T1（不跳到末条 term:s1:8）
    expect(terminal.activeTerminalId.value).toBe(T1)
    wrapper.unmount()
  })
})

describe('世代变更失效重置（auth token 判据）', () => {
  async function seedAlive(sid: string): Promise<{ wrapper: ReturnType<typeof mount>; terminal: UseTerminalReturn }> {
    terminalApiMock.spawn.mockResolvedValue({ terminalId: T1 })
    const h = host(sid)
    await h.terminal.spawnTerminal('/tmp', 80, 24)
    return h
  }

  it('GEN-1: token 变化 → 重置（分区/订阅/写队列/条目全清）+ 按 list 重建（空态）', async () => {
    const { wrapper, terminal } = await seedAlive('s1')
    __handleConnectionEstablishedForTest('token-A') // 首次连接：空态重置（无对象）
    await flushPromises()
    expect(terminal.instances.value).toEqual([])
    await terminal.spawnTerminal('/tmp', 80, 24)
    expect(hasInstance(T1)).toBe(true)

    terminalApiMock.list.mockResolvedValue([])
    __handleConnectionEstablishedForTest('token-B') // 世代变更
    await flushPromises()

    expect(terminal.instances.value).toEqual([])
    expect(__terminalPartitionCountForTest()).toBe(0)
    expect(__terminalSubscriptionCountForTest()).toBe(0)
    expect(hasInstance(T1)).toBe(false)
    expect(terminalApiMock.list).toHaveBeenCalledWith('s1')
    // 订阅表「先退订再清空」：旧世代同形键的 handler 已摘——重置后再发同号帧无人接收、
    // 不重建分区（若只清 Set 不退订，handler 残留会命中幂等守卫并静默 no-op 新世代）
    dispatchSession('s1', frame('terminal.data', 's1', T1, { data: 'stale' }))
    expect(__terminalPartitionCountForTest()).toBe(0)
    wrapper.unmount()
  })

  it('GEN-2: 同世代（token 未变）→ 不重置（分区/订阅/历史输出保持）', async () => {
    const { wrapper, terminal } = await seedAlive('s1')
    __handleConnectionEstablishedForTest('token-A')
    await flushPromises()
    await terminal.spawnTerminal('/tmp', 80, 24)
    dispatchSession('s1', frame('terminal.data', 's1', T1, { data: 'history' }))
    const historyText = (): string =>
      [...terminal.current.value.buffer.chunks, ...terminal.current.value.outputQueue].join('')
    expect(historyText()).toBe('history')

    __handleConnectionEstablishedForTest('token-A') // 同世代闪断重连
    await flushPromises()

    expect(terminal.instances.value.map((i) => i.terminalId)).toEqual([T1])
    expect(__terminalPartitionCountForTest()).toBe(1)
    expect(__terminalSubscriptionCountForTest()).toBe(1)
    expect(historyText()).toBe('history')
    wrapper.unmount()
  })

  it('GEN-3: 旧 token 不可得 → 保守判为世代变更；提示仅在确有滞留命令时发出', async () => {
    const { wrapper, terminal } = await seedAlive('s1')
    const store = useTerminalWriteQueueStore()
    store.markExited(T1)
    store.enqueueWrite(T1, 'stranded')
    expect(store.pendingCountOf(T1)).toBe(1)

    // 首次连接（旧 token 不可得）→ 重置 + 确有滞留命令 → 提示一次
    __handleConnectionEstablishedForTest('token-A')
    await flushPromises()
    expect(useToast().toasts.value.filter((x) => x.type === 'warning')).toHaveLength(1)
    expect(store.pendingCountOf(T1)).toBe(0)
    expect(terminal.instances.value).toEqual([])

    // 无滞留命令的世代变更 → 不提示
    useToast().toasts.value = []
    await terminal.spawnTerminal('/tmp', 80, 24)
    store.markAlive(T1)
    __handleConnectionEstablishedForTest('token-B')
    await flushPromises()
    expect(useToast().toasts.value).toHaveLength(0)
    wrapper.unmount()
  })
})

describe('unknown_terminal_id 平行守卫（提示与焦点按触发面分档）', () => {
  async function seedAlive(): Promise<{ wrapper: ReturnType<typeof mount>; terminal: UseTerminalReturn }> {
    terminalApiMock.spawn.mockResolvedValue({ terminalId: T1 })
    const h = host('s1')
    await h.terminal.spawnTerminal('/tmp', 80, 24)
    return h
  }

  it('UG-1: write 命中 → 三腿回收 + 「输入可能丢失」提示', async () => {
    const { wrapper, terminal } = await seedAlive()
    terminalApiMock.write.mockRejectedValueOnce(rpcError('unknown_terminal_id'))
    terminal.writeToTerminal('lost-input')
    await vi.waitFor(() => expect(hasInstance(T1)).toBe(false))

    expect(terminal.instances.value).toEqual([])
    expect(__terminalPartitionCountForTest()).toBe(0)
    expect(__terminalSubscriptionCountForTest()).toBe(0)
    expect(useToast().toasts.value.some((x) => x.type === 'warning' && x.message.includes('终端 1'))).toBe(true)
    wrapper.unmount()
  })

  it('UG-2: attach 命中 → 静默回收（不提示）', async () => {
    const { wrapper, terminal } = await seedAlive()
    terminalApiMock.attach.mockRejectedValueOnce(rpcError('unknown_terminal_id'))
    terminal.attachTerminal()
    await vi.waitFor(() => expect(hasInstance(T1)).toBe(false))
    expect(terminal.instances.value).toEqual([])
    expect(useToast().toasts.value).toHaveLength(0)
    wrapper.unmount()
  })

  it('UG-3: kill 命中 → 静默回收（不提示）', async () => {
    const { wrapper, terminal } = await seedAlive()
    terminalApiMock.kill.mockRejectedValueOnce(rpcError('unknown_terminal_id'))
    terminal.killTerminal()
    await vi.waitFor(() => expect(hasInstance(T1)).toBe(false))
    expect(useToast().toasts.value).toHaveLength(0)
    wrapper.unmount()
  })

  it('UG-4: 重复打击静默收敛（回收后再次命中不弹提示、状态不变）', async () => {
    const { wrapper, terminal } = await seedAlive()
    terminalApiMock.write.mockRejectedValueOnce(rpcError('unknown_terminal_id'))
    terminal.writeToTerminal('first')
    await vi.waitFor(() => expect(hasInstance(T1)).toBe(false))
    const toastCount = useToast().toasts.value.length

    terminalApiMock.attach.mockRejectedValueOnce(rpcError('unknown_terminal_id'))
    terminal.attachTerminal()
    await flushPromises()
    expect(useToast().toasts.value).toHaveLength(toastCount)
    expect(terminal.instances.value).toEqual([])
    wrapper.unmount()
  })

  it('UG-5: 交叉校验拒绝码不触发回收（实例仍活 + kill 失败有可见反馈）', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { wrapper, terminal } = await seedAlive()
    terminalApiMock.kill.mockRejectedValueOnce(rpcError('terminal_id_session_mismatch'))
    terminal.killTerminal()
    await vi.waitFor(() => expect(warnSpy).toHaveBeenCalled())
    expect(hasInstance(T1)).toBe(true)
    expect(terminal.instances.value.map((i) => i.terminalId)).toEqual([T1])
    // dmg-r1-4：kill 失败 = 终止动作未生效（PTY 仍存活），须给用户可见反馈
    expect(useToast().toasts.value).toHaveLength(1)
    wrapper.unmount()
  })

  it('UG-6: 注册表条目已删但分区/订阅在场时，unknown_terminal_id 仍回收（三腿判据不早退）', async () => {
    const { wrapper, terminal } = await seedAlive()
    // 模拟「关闭沿已删注册表条目、但分区与订阅仍在场」的竞态残留形态（设计 §3.3 守卫覆盖面）
    unregisterInstance(T1)
    setActiveTerminalId('s1', T1) // active 仍指向该编号（模拟竞态残留，使 attach 腿可达）
    expect(hasInstance(T1)).toBe(false)
    expect(__terminalPartitionCountForTest()).toBe(1)
    expect(__terminalSubscriptionCountForTest()).toBe(1)

    terminalApiMock.attach.mockRejectedValueOnce(rpcError('unknown_terminal_id'))
    terminal.attachTerminal()
    await vi.waitFor(() => expect(__terminalPartitionCountForTest()).toBe(0))

    expect(__terminalSubscriptionCountForTest()).toBe(0)
    expect(useToast().toasts.value).toHaveLength(0)
    wrapper.unmount()
  })

  it('UG-7: kill 通道类失败（closeInstance 腿）→ toast 反馈 + 镜像条目重建（不等对账复活）', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    terminalApiMock.spawn.mockResolvedValueOnce({ terminalId: T1 }).mockResolvedValueOnce({ terminalId: T2 })
    const { wrapper, terminal } = host('s1')
    await terminal.spawnTerminal('/tmp', 80, 24)
    await terminal.spawnTerminal('/tmp', 80, 24)
    terminal.selectInstance(T2)
    terminalApiMock.kill.mockRejectedValueOnce(new Error('transport down'))

    terminal.closeInstance(T2)
    await vi.waitFor(() => expect(useToast().toasts.value.length).toBeGreaterThan(0))

    // C-proc-21：关闭失败须有可见反馈；UI 与 runtime 实况即时一致（条目复活，PTY 未死）
    expect(useToast().toasts.value.some((x) => x.type === 'warning')).toBe(true)
    expect(hasInstance(T2)).toBe(true)
    expect(terminal.instances.value.map((i) => i.terminalId)).toEqual([T1, T2])
    // 关闭沿已落的 active（T1）不被重建抢占
    expect(terminal.activeTerminalId.value).toBe(T1)
    expect(warnSpy).toHaveBeenCalled()
    wrapper.unmount()
  })
})

describe('会话销毁扇出（精确前缀）', () => {
  it('DEL-1: triggerSessionCleanups 清该会话全部实例键 + 他会话不受影响', async () => {
    terminalApiMock.spawn
      .mockResolvedValueOnce({ terminalId: T1 })
      .mockResolvedValueOnce({ terminalId: T2 })
      .mockResolvedValueOnce({ terminalId: 'term:s2:1' })
    const h1 = host('s1')
    await h1.terminal.spawnTerminal('/tmp', 80, 24)
    await h1.terminal.spawnTerminal('/tmp', 80, 24)
    const h2 = host('s2')
    await h2.terminal.spawnTerminal('/tmp', 80, 24)
    // 竞态重建的幽灵条目（订阅已先建立、注册表无）：cleanupSession 前缀兜底也须清掉
    const store = useTerminalWriteQueueStore()
    store.markAlive('term:s1:9')
    expect(__terminalSubscriptionCountForTest()).toBe(3)

    triggerSessionCleanups('s1')
    await flushPromises()

    expect(h1.terminal.instances.value).toEqual([])
    expect(__terminalPartitionCountForTest()).toBe(1) // 仅 s2 分区
    expect(__terminalSubscriptionCountForTest()).toBe(1)
    expect(hasInstance('term:s2:1')).toBe(true)
    expect(store.isPtyAlive('term:s2:1')).toBe(true)
    expect(store.isPtyAlive('term:s1:9')).toBe(false)
    h1.wrapper.unmount()
    h2.wrapper.unmount()
  })

  it('DEL-2: 扇出覆盖竞态重建的幽灵条目（关闭沿后经过期 list 重新建档，前缀遍历兜底）', async () => {
    terminalApiMock.spawn.mockResolvedValueOnce({ terminalId: T1 }).mockResolvedValueOnce({ terminalId: T2 })
    const { wrapper, terminal } = host('s1')
    await terminal.spawnTerminal('/tmp', 80, 24)
    await terminal.spawnTerminal('/tmp', 80, 24)

    // 关闭沿释放 T2（分区/订阅/条目三腿）——但 runtime 的过期 list 仍报 T2 存活：
    // 对账重建 T2 的分区与模块级订阅（键永不复用、永无后续关闭沿触达的幽灵条目）
    terminal.closeInstance(T2)
    await flushPromises()
    terminalApiMock.list.mockResolvedValue([
      { terminalId: T1, alive: true },
      { terminalId: T2, alive: true },
    ])
    await terminal.reconcileInstances()
    expect(terminal.instances.value.map((i) => i.terminalId)).toEqual([T1, T2])
    expect(__terminalPartitionCountForTest()).toBe(2)
    expect(__terminalSubscriptionCountForTest()).toBe(2)

    // 会话删除：前缀扇出遍历分区/订阅表（不依赖实例注册表遍历）→ 幽灵条目一并回收
    triggerSessionCleanups('s1')
    await flushPromises()
    expect(terminal.instances.value).toEqual([])
    expect(__terminalPartitionCountForTest()).toBe(0)
    expect(__terminalSubscriptionCountForTest()).toBe(0)
    // 订阅已退：销毁后再发同号帧无人接收、不重建分区
    dispatchSession('s1', frame('terminal.data', 's1', T1, { data: 'ghost' }))
    expect(__terminalPartitionCountForTest()).toBe(0)
    wrapper.unmount()
  })
})
