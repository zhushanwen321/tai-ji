/**
 * 终端 rAF 写队列 + 版本回放测试（W14 D-6.1 + W27 D-6.2 + 多实例 u2）。
 *
 * 验收锚点（W14/W27）：
 * - D-6.1：同一帧内 N 个 chunk 只触发一次 xterm.write（合并块）；buffer 累积语义与改造前
 *   等价（逐 chunk 粒度、总内容一致、上限裁剪）；E6-a 超限合并不丢弃
 * - D-6.2（W27）：分区生命周期上提——模块级持久分区 + 订阅跨组件生命周期存活，
 *   切走（unmount）期间输出照常累积、切回全量回放（V-P2-4）；版本回放增量正确；
 *   session 销毁 cleanup 释放分区 + 退订
 *
 * 多实例（u2）：分区/订阅/flush 监听全部按 terminalId `term:<sid>:<n>` 分键；建档经
 * spawn ack（新建形态）或 `terminal.list` 对账。
 *
 * 两层被测：
 * - Part 1 useTerminal 层（宿主组件模式）
 * - Part 2 TerminalView 组件级（真 useTerminal + mock xterm，端到端 data→rAF→flush→write）
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/terminal/use-terminal-raf-queue.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineComponent, h, ref, type Ref } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { ServerMessage } from '@taiji/shared'
import type { UseTerminalReturn } from '@/composables/features/terminal/useTerminal'
import {
  replayChunks,
  replayChunksBatched,
  __resetTerminalStateForTest,
  __terminalPartitionCountForTest,
  __terminalFlushListenerCountForTest,
} from '@/composables/features/terminal/useTerminal'

// ── mock terminalApi（隔离 RPC；Part 2 的 TerminalView spawn 也会调）────────
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

// ── mock xterm + addons（happy-dom 无 canvas；记录每次 new 的实例供断言）────
const xtermInstances = vi.hoisted(() => [] as Array<{ write: ReturnType<typeof vi.fn> }>)
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
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: function M() { return {} } }))
vi.mock('@xterm/addon-search', () => ({ SearchAddon: function M() { return {} } }))
vi.mock('@xterm/addon-unicode11', () => ({ Unicode11Addon: function M() { return {} } }))
vi.mock('@xterm/xterm/css/xterm.css', () => ({}))
vi.mock('@/stores/session', () => ({
  useSessionStore: () => ({
    list: [{ id: 's1', cwd: '/tmp/s1' }, { id: 's2', cwd: '/tmp/s2' }],
  }),
}))

import { useTerminal } from '@/composables/features/terminal/useTerminal'
import { listInstances } from '@/composables/features/terminal/terminal-instance-registry'
import TerminalView from '@/components/panel/TerminalView.vue'
import { dispatchSession } from '@taiji/core/transport/api'
import { triggerSessionCleanups } from '@/composables/useSessionScopedState'

// happy-dom 无 ResizeObserver（TerminalView 依赖），polyfill
class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
;(globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver =
  MockResizeObserver as unknown as typeof ResizeObserver

// ── 工具 ───────────────────────────────────────────────────────────────────
let msgSeq = 0
/** 构造 terminal.data 广播消息（形状同 runtime broadcast，多实例带 terminalId）。 */
function makeDataMsg(sid: string, terminalId: string, data: string): ServerMessage<'terminal.data'> {
  msgSeq += 1
  return { id: `msg-${msgSeq}`, type: 'terminal.data', payload: { sessionId: sid, terminalId, data } }
}

/** 测试宿主组件：在 setup 内调 useTerminal（仍走组件壳以兼容模板依赖），expose 返回值。 */
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

/** 经 ack 建档一个实例（新建形态 spawn）。 */
async function establish(terminal: UseTerminalReturn, terminalId: string, cwd = '/tmp'): Promise<void> {
  terminalApiMock.spawn.mockResolvedValueOnce({ terminalId })
  await terminal.spawnTerminal(cwd, 80, 24)
  await flushPromises()
}

/** 推进一帧（16ms）触发 pending 的 rAF 回调。 */
function advanceFrame(): void {
  vi.advanceTimersByTime(16)
}

let wrappers: Array<ReturnType<typeof mount>> = []

beforeEach(() => {
  setActivePinia(createPinia())
  // 只 fake rAF：Vue 的响应式调度（microtask）保持真实，watch 触发走 flushPromises
  vi.useFakeTimers({ toFake: ['requestAnimationFrame'] })
  msgSeq = 0
  xtermInstances.length = 0
  // 模块级持久分区/订阅/注册表是跨用例共享状态，必须重置
  __resetTerminalStateForTest()
  for (const key of Object.keys(terminalApiMock) as (keyof typeof terminalApiMock)[]) {
    terminalApiMock[key].mockClear()
  }
  // 新建形态 ack：按会话返回稳定编号（Part 2 的 TerminalView 自动新建也命中）
  terminalApiMock.spawn.mockImplementation((params: { sessionId?: string }) =>
    Promise.resolve({ terminalId: `term:${params.sessionId ?? 's'}:1` }),
  )
  // terminal.list 动态镜像注册表（忠实模拟 runtime 存活全集）：已建档实例不会被对账误回收，
  // 空会话返回空清单（走首开自动新建腿）。「清单外清理」路径在 use-terminal.test.ts RC-* 覆盖。
  terminalApiMock.list.mockImplementation((sid: string) =>
    Promise.resolve(
      listInstances(sid)
        .filter((e) => e.alive)
        .map((e) => ({ terminalId: e.terminalId, alive: true })),
    ),
  )
})

afterEach(() => {
  for (const w of wrappers) w.unmount()
  wrappers = []
  vi.useRealTimers()
})

const T1 = 'term:s1:1'

// ── Part 1：useTerminal 层（appendChunk / flushPending / E6-a）──────────────
describe('D-6.1 rAF 写队列（useTerminal 层）', () => {
  it('RQ-1: N 条 terminal.data 同帧只入 outputQueue，rAF 后逐 chunk 进 buffer（粒度+总内容等价）', async () => {
    const wrapper = mount(makeHost('s1'))
    wrappers.push(wrapper)
    const terminal = wrapper.vm.terminal as UseTerminalReturn
    await establish(terminal, T1)

    const chunks = ['hel', 'lo ', 'wor', 'ld\n', 'line2\n']
    for (const c of chunks) dispatchSession('s1', makeDataMsg('s1', T1, c))

    expect(terminal.current.value.buffer.chunks).toEqual([])
    expect(terminal.current.value.outputQueue).toEqual(chunks)

    advanceFrame()
    expect(terminal.current.value.buffer.chunks).toEqual(chunks)
    expect(terminal.current.value.buffer.version).toBe(chunks.length)
    expect(terminal.current.value.outputQueue).toEqual([])
    expect(terminal.current.value.rafPending).toBe(false)
  })

  it('RQ-2: 同帧 N 条 data 只调度一次 rAF（rafPending 防重入）', async () => {
    const rafSpy = vi.spyOn(globalThis, 'requestAnimationFrame')
    const wrapper = mount(makeHost('s1'))
    wrappers.push(wrapper)
    const terminal = wrapper.vm.terminal as UseTerminalReturn
    await establish(terminal, T1)

    for (let i = 0; i < 8; i++) dispatchSession('s1', makeDataMsg('s1', T1, `chunk-${i};`))
    expect(rafSpy).toHaveBeenCalledTimes(1)
    rafSpy.mockRestore()
  })

  it('RQ-3: E6-a —— rAF 被节流时 outputQueue 超限合并成单块（保序全量，不丢弃）', async () => {
    const wrapper = mount(makeHost('s1'))
    wrappers.push(wrapper)
    const terminal = wrapper.vm.terminal as UseTerminalReturn
    await establish(terminal, T1)

    const count = 1030
    for (let i = 0; i < count; i++) dispatchSession('s1', makeDataMsg('s1', T1, `c${i};`))

    const q = terminal.current.value.outputQueue
    expect(q.length).toBeLessThan(count)
    const expected = q.join('')
    expect(expected).toBe(Array.from({ length: count }, (_, i) => `c${i};`).join(''))

    advanceFrame()
    expect(terminal.current.value.buffer.chunks.join('')).toBe(expected)
  })

  it('RQ-4: 跨帧累积语义 —— 各帧 flush 的 chunk 按序追加，总内容一致', async () => {
    const wrapper = mount(makeHost('s1'))
    wrappers.push(wrapper)
    const terminal = wrapper.vm.terminal as UseTerminalReturn
    await establish(terminal, T1)

    for (const c of ['a', 'b', 'c']) dispatchSession('s1', makeDataMsg('s1', T1, c))
    advanceFrame()
    for (const c of ['d', 'e']) dispatchSession('s1', makeDataMsg('s1', T1, c))
    advanceFrame()

    expect(terminal.current.value.buffer.chunks).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(terminal.current.value.buffer.version).toBe(5)
  })

  it('RQ-5: buffer 上限裁剪语义保持（超出 SCROLLBACK_LIMIT 保留最新，版本不减）', async () => {
    const wrapper = mount(makeHost('s1'))
    wrappers.push(wrapper)
    const terminal = wrapper.vm.terminal as UseTerminalReturn
    await establish(terminal, T1)

    const total = 5030
    for (let i = 0; i < total; i++) {
      dispatchSession('s1', makeDataMsg('s1', T1, `x${i}`))
      if (i % 100 === 99) advanceFrame()
    }
    advanceFrame()

    const buf = terminal.current.value.buffer
    expect(buf.chunks.length).toBe(5000)
    expect(buf.chunks[0]).toBe('x30')
    expect(buf.chunks[buf.chunks.length - 1]).toBe(`x${total - 1}`)
    expect(buf.version).toBe(total)
  })

  it('RQ-10: Fix-4 —— deleteSession 后迟到 rAF 不复活分区（分区已释放，订阅已解除）', async () => {
    const wrapper = mount(makeHost('s1'))
    wrappers.push(wrapper)
    const terminal = wrapper.vm.terminal as UseTerminalReturn
    await establish(terminal, T1)

    dispatchSession('s1', makeDataMsg('s1', T1, 'pre'))
    advanceFrame()
    expect(terminal.current.value.buffer.version).toBe(1)

    dispatchSession('s1', makeDataMsg('s1', T1, 'doomed'))
    triggerSessionCleanups('s1')
    expect(__terminalPartitionCountForTest()).toBe(0)
    advanceFrame()

    expect(__terminalPartitionCountForTest()).toBe(0)
    dispatchSession('s1', makeDataMsg('s1', T1, 'ghost'))
    advanceFrame()
    expect(__terminalPartitionCountForTest()).toBe(0)
  })
})

// ── Part 2：TerminalView 组件级（data → rAF → flush → xterm.write 端到端）──
describe('D-6.1 rAF 写队列（TerminalView 端到端）', () => {
  it('RQ-6: 同帧 N chunk 只触发一次 xterm.write，内容为合并块', async () => {
    const wrapper = mount(TerminalView, { props: { sessionId: 's1' } })
    wrappers.push(wrapper)
    await flushPromises()

    const xterm = xtermInstances[xtermInstances.length - 1]!
    xterm.write.mockClear()

    for (const c of ['hel', 'lo ', 'raf', ' wor', 'ld\n']) {
      dispatchSession('s1', makeDataMsg('s1', T1, c))
    }
    expect(xterm.write).not.toHaveBeenCalled()

    advanceFrame()
    await flushPromises()

    expect(xterm.write).toHaveBeenCalledTimes(1)
    expect(xterm.write).toHaveBeenCalledWith('hello raf world\n')
  })

  it('RQ-7: 跨帧各写一次（每帧一次，非每 chunk 一次）', async () => {
    const wrapper = mount(TerminalView, { props: { sessionId: 's1' } })
    wrappers.push(wrapper)
    await flushPromises()

    const xterm = xtermInstances[xtermInstances.length - 1]!
    xterm.write.mockClear()

    dispatchSession('s1', makeDataMsg('s1', T1, 'f1a'))
    dispatchSession('s1', makeDataMsg('s1', T1, 'f1b'))
    advanceFrame()
    await flushPromises()
    dispatchSession('s1', makeDataMsg('s1', T1, 'f2a'))
    dispatchSession('s1', makeDataMsg('s1', T1, 'f2b'))
    dispatchSession('s1', makeDataMsg('s1', T1, 'f2c'))
    advanceFrame()
    await flushPromises()

    expect(xterm.write).toHaveBeenCalledTimes(2)
    expect(xterm.write).toHaveBeenNthCalledWith(1, 'f1af1b')
    expect(xterm.write).toHaveBeenNthCalledWith(2, 'f2af2bf2c')
  })

  it('RQ-8: 回放语义 —— 切 session 再切回，xterm 重挂后全量回放完整', async () => {
    const wrapper = mount(TerminalView, { props: { sessionId: 's1' } })
    wrappers.push(wrapper)
    await flushPromises()

    for (const c of ['out1', 'out2', 'out3']) dispatchSession('s1', makeDataMsg('s1', T1, c))
    advanceFrame()
    await flushPromises()

    await wrapper.setProps({ sessionId: 's2' })
    await flushPromises()
    await wrapper.setProps({ sessionId: 's1' })
    await flushPromises()

    const xterm = xtermInstances[xtermInstances.length - 1]!
    expect(xterm.write).toHaveBeenCalledTimes(1)
    expect(xterm.write).toHaveBeenCalledWith('out1out2out3')
  })

  it('RQ-9: Fix-1 —— LIMIT 稳态下连续 flush（length 净值守恒 5000→5000）仍触发 write', async () => {
    const wrapper = mount(TerminalView, { props: { sessionId: 's1' } })
    wrappers.push(wrapper)
    await flushPromises()

    const total = 5030
    for (let i = 0; i < total; i++) {
      dispatchSession('s1', makeDataMsg('s1', T1, `x${i}`))
      if (i % 100 === 99) advanceFrame()
    }
    advanceFrame()
    await flushPromises()

    const xterm = xtermInstances[xtermInstances.length - 1]!
    xterm.write.mockClear()

    for (const c of ['steady-1\n', 'steady-2\n', 'steady-3\n']) {
      dispatchSession('s1', makeDataMsg('s1', T1, c))
      advanceFrame()
      await flushPromises()
    }

    expect(xterm.write).toHaveBeenCalledTimes(3)
    expect(xterm.write).toHaveBeenNthCalledWith(1, 'steady-1\n')
    expect(xterm.write).toHaveBeenNthCalledWith(2, 'steady-2\n')
    expect(xterm.write).toHaveBeenNthCalledWith(3, 'steady-3\n')
  })
})

// ── Part 3：W27 D-6.2 —— 分区生命周期上提 + 版本回放 ──────────────────────
describe('W27 D-6.2 分区生命周期上提 + 版本回放', () => {
  it('W27-1: 切走（unmount）期间输出照常累积，切回（remount）全量回放', async () => {
    const w1 = mount(TerminalView, { props: { sessionId: 's1' } })
    await flushPromises()
    for (const c of ['old-1', 'old-2']) dispatchSession('s1', makeDataMsg('s1', T1, c))
    advanceFrame()
    await flushPromises()
    w1.unmount()

    const hidden: string[] = []
    for (let i = 0; i < 30; i++) {
      const c = `hidden-${i}\n`
      hidden.push(c)
      dispatchSession('s1', makeDataMsg('s1', T1, c))
      advanceFrame()
    }
    await flushPromises()
    expect(__terminalPartitionCountForTest()).toBe(1)

    const w2 = mount(TerminalView, { props: { sessionId: 's1' } })
    wrappers.push(w2)
    await flushPromises()
    const xterm2 = xtermInstances[xtermInstances.length - 1]!

    expect(xterm2.write).toHaveBeenCalledTimes(1)
    expect(xterm2.write).toHaveBeenCalledWith('old-1old-2' + hidden.join(''))

    dispatchSession('s1', makeDataMsg('s1', T1, 'fresh-1'))
    advanceFrame()
    await flushPromises()
    expect(xterm2.write).toHaveBeenCalledTimes(2)
    expect(xterm2.write).toHaveBeenNthCalledWith(2, 'fresh-1')
  })

  it('W27-2: 版本回放增量正确 —— 指针随 buffer.version 前进，无重复无遗漏', async () => {
    const wrapper = mount(TerminalView, { props: { sessionId: 's1' } })
    wrappers.push(wrapper)
    await flushPromises()
    const xterm = xtermInstances[xtermInstances.length - 1]!
    xterm.write.mockClear()

    const frames = [
      ['a1', 'a2', 'a3'],
      ['b1', 'b2'],
      ['c1'],
    ]
    for (const batch of frames) {
      for (const c of batch) dispatchSession('s1', makeDataMsg('s1', T1, c))
      advanceFrame()
      await flushPromises()
    }

    expect(xterm.write).toHaveBeenCalledTimes(3)
    expect(xterm.write).toHaveBeenNthCalledWith(1, 'a1a2a3')
    expect(xterm.write).toHaveBeenNthCalledWith(2, 'b1b2')
    expect(xterm.write).toHaveBeenNthCalledWith(3, 'c1')
  })

  it('W27-3: 切走期间数据不丢 —— 订阅上提覆盖切走窗口（publish-only 下无订阅即丢弃）', async () => {
    const w = mount(makeHost('s1'))
    wrappers.push(w)
    const terminal = w.vm.terminal as UseTerminalReturn
    await establish(terminal, T1)

    dispatchSession('s1', makeDataMsg('s1', T1, 'before'))
    advanceFrame()
    w.unmount()

    expect(__terminalPartitionCountForTest()).toBe(1)

    for (const c of ['away-1', 'away-2', 'away-3']) {
      dispatchSession('s1', makeDataMsg('s1', T1, c))
      advanceFrame()
    }

    const w2 = mount(makeHost('s1'))
    wrappers.push(w2)
    const terminal2 = w2.vm.terminal as UseTerminalReturn
    expect(terminal2.current.value.buffer.chunks).toEqual(['before', 'away-1', 'away-2', 'away-3'])
    expect(terminal2.current.value.buffer.version).toBe(4)
  })

  it('W27-4: 内存清理 —— session 销毁后分区释放 + 订阅解除 + flush 监听清空', async () => {
    const wrapper = mount(TerminalView, { props: { sessionId: 's1' } })
    wrappers.push(wrapper)
    await flushPromises()
    dispatchSession('s1', makeDataMsg('s1', T1, 'data'))
    advanceFrame()
    await flushPromises()
    expect(__terminalPartitionCountForTest()).toBe(1)

    triggerSessionCleanups('s1')
    await flushPromises()

    expect(__terminalPartitionCountForTest()).toBe(0)
    dispatchSession('s1', makeDataMsg('s1', T1, 'ghost'))
    advanceFrame()
    await flushPromises()
    expect(__terminalPartitionCountForTest()).toBe(0)
    expect(__terminalFlushListenerCountForTest()).toBe(0)
  })

  it('W27-5: replayChunks 纯函数 —— 版本边界与裁剪后物理起点', () => {
    expect(replayChunks({ chunks: [], version: 0 }, 0)).toBeNull()

    const b1 = { chunks: ['a', 'b', 'c'], version: 3 }
    expect(replayChunks(b1, 0)).toBe('abc')
    expect(replayChunks(b1, 1)).toBe('bc')
    expect(replayChunks(b1, 3)).toBeNull()
    expect(replayChunks(b1, 5)).toBeNull()

    const b2 = { chunks: ['e', 'f'], version: 6 }
    expect(replayChunks(b2, 0)).toBe('ef')
    expect(replayChunks(b2, 4)).toBe('ef')
    expect(replayChunks(b2, 5)).toBe('f')
    expect(replayChunks(b2, 6)).toBeNull()
  })

  it('W27-6: watch(scrollback.length) 与 watch(flushVersion) 已删除（D-6.2 检查点 grep 断言）', () => {
    const sources = [
      resolve(__dirname, '../../composables/features/terminal/useTerminal.ts'),
      resolve(__dirname, '../../composables/features/terminal/useTerminalXterm.ts'),
      resolve(__dirname, '../../components/panel/TerminalView.vue'),
    ].map((p) => readFileSync(p, 'utf8'))
    for (const src of sources) {
      expect(src).not.toContain('scrollback.length')
      expect(src).not.toContain('flushVersion')
      expect(src).not.toContain('replayedUpTo')
    }
  })

  it('W27-8: replayChunksBatched 纯函数 —— 分批边界 + 总内容等价 + 每批上限（Fix-5）', () => {
    expect(replayChunksBatched({ chunks: [], version: 0 }, 0)).toBeNull()

    const chunks = Array.from({ length: 1200 }, (_, i) => `c${i};`)
    const buf = { chunks, version: chunks.length }
    const r = replayChunksBatched(buf, 0)
    expect(r).not.toBeNull()
    const { batches, targetVersion } = r!
    expect(batches.length).toBe(3)
    expect(batches[0]).toBe(chunks.slice(0, 500).join(''))
    expect(batches[1]).toBe(chunks.slice(500, 1000).join(''))
    expect(batches[2]).toBe(chunks.slice(1000).join(''))
    expect(batches.join('')).toBe(chunks.join(''))
    expect(targetVersion).toBe(chunks.length)

    const fixedChunks = Array.from({ length: 1200 }, () => 'aaaa')
    const r2 = replayChunksBatched({ chunks: fixedChunks, version: 1200 }, 0)!
    for (const b of r2.batches) expect(b.length).toBeLessThanOrEqual(500 * 4)

    const croppedBuf = { chunks: ['e', 'f', 'g'], version: 9 }
    const r3 = replayChunksBatched(croppedBuf, 6, 2)!
    expect(r3.batches).toEqual(['ef', 'g'])
    expect(replayChunksBatched(croppedBuf, 9)).toBeNull()
  })

  it('W27-9: 大批量 flush 分帧写 —— 每帧一批、顺序保持、总内容等价（Fix-5）', async () => {
    const wrapper = mount(TerminalView, { props: { sessionId: 's1' } })
    wrappers.push(wrapper)
    await flushPromises()
    const xterm = xtermInstances[xtermInstances.length - 1]!
    xterm.write.mockClear()

    const count = 600
    for (let i = 0; i < count; i++) dispatchSession('s1', makeDataMsg('s1', T1, `b${i};`))
    advanceFrame()
    await flushPromises()
    expect(xterm.write).toHaveBeenCalledTimes(1)
    expect(xterm.write).toHaveBeenNthCalledWith(
      1,
      Array.from({ length: 500 }, (_, i) => `b${i};`).join(''),
    )

    advanceFrame()
    await flushPromises()
    expect(xterm.write).toHaveBeenCalledTimes(2)
    expect(xterm.write).toHaveBeenNthCalledWith(
      2,
      Array.from({ length: 100 }, (_, i) => `b${i + 500};`).join(''),
    )

    expect(xterm.write.mock.calls.map((c) => c[0]).join('')).toBe(
      Array.from({ length: count }, (_, i) => `b${i};`).join(''),
    )

    dispatchSession('s1', makeDataMsg('s1', T1, 'tail'))
    advanceFrame()
    await flushPromises()
    expect(xterm.write).toHaveBeenCalledTimes(3)
    expect(xterm.write).toHaveBeenNthCalledWith(3, 'tail')
  })
})

// ── Part 4：S-15 全量重放清屏信号（PR #175 R1）──────────────────────────
describe('S-15 全量重放清屏信号', () => {
  it('S15-1: replayChunksBatched clamped 信号真值表 —— 仅指针落后裁剪线时置位', () => {
    const uncropped = { chunks: ['a', 'b', 'c'], version: 3 }
    expect(replayChunksBatched(uncropped, 0)!.clamped).toBe(false)
    expect(replayChunksBatched(uncropped, 2)!.clamped).toBe(false)

    const croppedBuf = { chunks: ['e', 'f'], version: 6 }
    expect(replayChunksBatched(croppedBuf, 0)!.clamped).toBe(true)
    expect(replayChunksBatched(croppedBuf, 3)!.clamped).toBe(true)
    expect(replayChunksBatched(croppedBuf, 4)!.clamped).toBe(false)
    expect(replayChunksBatched(croppedBuf, 5)!.clamped).toBe(false)
    expect(replayChunksBatched(croppedBuf, 6)).toBeNull()
  })

  it('S15-2: 指针落后裁剪线（视图 mount 前已 >5000 裁剪）→ 全量重放前 xterm 先 clear，内容恰为保留区全量', async () => {
    const w = mount(makeHost('s1'))
    wrappers.push(w)
    const terminal = w.vm.terminal as UseTerminalReturn
    await establish(terminal, T1)
    const total = 5050
    for (let i = 0; i < total; i++) {
      dispatchSession('s1', makeDataMsg('s1', T1, `x${i};`))
      if (i % 100 === 99) advanceFrame()
    }
    advanceFrame()
    await flushPromises()
    w.unmount()

    const wrapper = mount(TerminalView, { props: { sessionId: 's1' } })
    wrappers.push(wrapper)
    await flushPromises()
    const xterm = xtermInstances[xtermInstances.length - 1]!

    expect(xterm.clear).toHaveBeenCalledTimes(1)
    const clearOrder = xterm.clear.mock.invocationCallOrder[0]
    const firstWriteOrder = xterm.write.mock.invocationCallOrder[0]
    expect(clearOrder).toBeDefined()
    expect(firstWriteOrder).toBeDefined()
    expect(clearOrder).toBeLessThan(firstWriteOrder)

    for (let i = 0; i < 12; i++) advanceFrame()
    await flushPromises()
    const written = xterm.write.mock.calls.map((c) => c[0]).join('')
    expect(written).toBe(Array.from({ length: 5000 }, (_, i) => `x${i + 50};`).join(''))

    dispatchSession('s1', makeDataMsg('s1', T1, 'tail'))
    advanceFrame()
    await flushPromises()
    expect(xterm.clear).toHaveBeenCalledTimes(1)
    expect(xterm.write).toHaveBeenLastCalledWith('tail')
  })

  it('S15-3: 未裁剪 buffer 的 mount 全量回放 → clamped=false，不触发 clear', async () => {
    const w = mount(makeHost('s1'))
    wrappers.push(w)
    const terminal = w.vm.terminal as UseTerminalReturn
    await establish(terminal, T1)
    for (const c of ['a1', 'a2', 'a3']) dispatchSession('s1', makeDataMsg('s1', T1, c))
    advanceFrame()
    await flushPromises()
    w.unmount()

    const wrapper = mount(TerminalView, { props: { sessionId: 's1' } })
    wrappers.push(wrapper)
    await flushPromises()
    const xterm = xtermInstances[xtermInstances.length - 1]!

    expect(xterm.clear).not.toHaveBeenCalled()
    expect(xterm.write).toHaveBeenCalledWith('a1a2a3')
  })
})
