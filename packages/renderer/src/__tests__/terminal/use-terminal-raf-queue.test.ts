/**
 * 终端 rAF 写队列 + 版本回放测试（W14 D-6.1 + W27 D-6.2，2026-08 perf）。
 *
 * 验收锚点（plan.md W14/W27 / 09-panel-layer.md §3.3.1）：
 * - D-6.1：同一帧内 N 个 chunk 只触发一次 xterm.write（合并块）；buffer 累积语义与
 *   改造前等价（逐 chunk 粒度、总内容一致、上限裁剪）；E6-a 超限合并不丢弃
 * - D-6.2（W27）：分区生命周期上提——模块级持久分区 + 订阅跨组件生命周期存活，
 *   切走（unmount）期间输出照常累积、切回全量回放（V-P2-4，W14 已知缺口正面修复）；
 *   版本回放增量正确（指针随 buffer.version 前进，无重复无遗漏）；session 销毁 cleanup
 *   释放分区 + 退订（内存清理）；watch(scrollback.length)/watch(flushVersion) 已删除
 *
 * 两层被测：
 * - Part 1 useTerminal 层（宿主组件模式，同 use-terminal.test.ts）
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
  spawn: vi.fn(() => Promise.resolve()),
  write: vi.fn(() => Promise.resolve()),
  resize: vi.fn(() => Promise.resolve()),
  kill: vi.fn(() => Promise.resolve()),
  attach: vi.fn(() => Promise.resolve()),
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
/** 构造 terminal.data 广播消息（形状同 runtime broadcast）。 */
function makeDataMsg(sid: string, data: string): ServerMessage<'terminal.data'> {
  msgSeq += 1
  return { id: `msg-${msgSeq}`, type: 'terminal.data', payload: { sessionId: sid, data } }
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
  // W27：模块级持久分区/订阅是跨用例共享状态，必须重置（否则订阅残留跨用例串扰）
  __resetTerminalStateForTest()
  terminalApiMock.spawn.mockClear()
  terminalApiMock.write.mockClear()
  terminalApiMock.attach.mockClear()
})

afterEach(() => {
  for (const w of wrappers) w.unmount()
  wrappers = []
  vi.useRealTimers()
})

// ── Part 1：useTerminal 层（appendChunk / flushPending / E6-a）──────────────
describe('D-6.1 rAF 写队列（useTerminal 层）', () => {
  it('RQ-1: N 条 terminal.data 同帧只入 outputQueue，rAF 后逐 chunk 进 buffer（粒度+总内容等价）', async () => {
    const Host = makeHost('s1')
    const wrapper = mount(Host)
    wrappers.push(wrapper)
    const terminal = wrapper.vm.terminal as UseTerminalReturn
    // W27：订阅经 attach/spawn 建立（模块级），此后 dispatch 才会被接收
    terminal.attachTerminal()

    const chunks = ['hel', 'lo ', 'wor', 'ld\n', 'line2\n']
    for (const c of chunks) dispatchSession('s1', makeDataMsg('s1', c))

    // flush 前：buffer 未动（改造前是逐条立即可见，改造后延迟到帧边界）
    expect(terminal.current.value.buffer.chunks).toEqual([])
    expect(terminal.current.value.outputQueue).toEqual(chunks)

    advanceFrame()
    // flush 后：逐 chunk push（保持回放粒度）+ 队列清空 + 版本前进 = append 总数
    expect(terminal.current.value.buffer.chunks).toEqual(chunks)
    expect(terminal.current.value.buffer.version).toBe(chunks.length)
    expect(terminal.current.value.outputQueue).toEqual([])
    expect(terminal.current.value.rafPending).toBe(false)
  })

  it('RQ-2: 同帧 N 条 data 只调度一次 rAF（rafPending 防重入）', async () => {
    const rafSpy = vi.spyOn(globalThis, 'requestAnimationFrame')
    const Host = makeHost('s1')
    const wrapper = mount(Host)
    wrappers.push(wrapper)
    ;(wrapper.vm.terminal as UseTerminalReturn).attachTerminal()

    for (let i = 0; i < 8; i++) dispatchSession('s1', makeDataMsg('s1', `chunk-${i};`))
    expect(rafSpy).toHaveBeenCalledTimes(1)
    rafSpy.mockRestore()
  })

  it('RQ-3: E6-a —— rAF 被节流时 outputQueue 超限合并成单块（保序全量，不丢弃）', async () => {
    const Host = makeHost('s1')
    const wrapper = mount(Host)
    wrappers.push(wrapper)
    const terminal = wrapper.vm.terminal as UseTerminalReturn
    terminal.attachTerminal()

    // 不 advance（模拟窗口隐藏 rAF 停摆），喂超上限的 chunk
    const count = 1030
    for (let i = 0; i < count; i++) dispatchSession('s1', makeDataMsg('s1', `c${i};`))

    const q = terminal.current.value.outputQueue
    expect(q.length).toBeLessThan(count)
    // 合并后总内容与逐条等价（保序全量）——flush 前先取内容快照（flush 会清空队列）
    const expected = q.join('')
    expect(expected).toBe(Array.from({ length: count }, (_, i) => `c${i};`).join(''))

    // 恢复帧调度后正常 flush 进 buffer
    advanceFrame()
    expect(terminal.current.value.buffer.chunks.join('')).toBe(expected)
  })

  it('RQ-4: 跨帧累积语义 —— 各帧 flush 的 chunk 按序追加，总内容一致', async () => {
    const Host = makeHost('s1')
    const wrapper = mount(Host)
    wrappers.push(wrapper)
    const terminal = wrapper.vm.terminal as UseTerminalReturn
    terminal.attachTerminal()

    for (const c of ['a', 'b', 'c']) dispatchSession('s1', makeDataMsg('s1', c))
    advanceFrame()
    for (const c of ['d', 'e']) dispatchSession('s1', makeDataMsg('s1', c))
    advanceFrame()

    expect(terminal.current.value.buffer.chunks).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(terminal.current.value.buffer.version).toBe(5)
  })

  it('RQ-5: buffer 上限裁剪语义保持（超出 SCROLLBACK_LIMIT 保留最新，版本不减）', async () => {
    const Host = makeHost('s1')
    const wrapper = mount(Host)
    wrappers.push(wrapper)
    const terminal = wrapper.vm.terminal as UseTerminalReturn
    terminal.attachTerminal()

    // 分帧喂超上限的 chunk（E6-a 会合并单帧超限的部分，分帧喂保持 chunk 粒度直达上限）
    const total = 5030
    for (let i = 0; i < total; i++) {
      dispatchSession('s1', makeDataMsg('s1', `x${i}`))
      if (i % 100 === 99) advanceFrame()
    }
    advanceFrame()

    const buf = terminal.current.value.buffer
    expect(buf.chunks.length).toBe(5000)
    // 保留最新的 5000 项：5030 - 5000 = 30，x0..x29 被裁掉
    expect(buf.chunks[0]).toBe('x30')
    expect(buf.chunks[buf.chunks.length - 1]).toBe(`x${total - 1}`)
    // 版本 = 累计 append 总数，裁剪不减（回放锚点稳定）
    expect(buf.version).toBe(total)
  })

  it('RQ-10: Fix-4 —— deleteSession 后迟到 rAF 不复活分区（分区已释放，订阅已解除）', async () => {
    const Host = makeHost('s1')
    const wrapper = mount(Host)
    wrappers.push(wrapper)
    const terminal = wrapper.vm.terminal as UseTerminalReturn
    terminal.attachTerminal()

    // 正常一轮 flush（分区存活），确认链路工作
    dispatchSession('s1', makeDataMsg('s1', 'pre'))
    advanceFrame()
    expect(terminal.current.value.buffer.version).toBe(1)

    // session 销毁（deleteSession 编排）：cleanup 删分区 + 解除订阅
    dispatchSession('s1', makeDataMsg('s1', 'doomed'))
    triggerSessionCleanups('s1')
    expect(__terminalPartitionCountForTest()).toBe(0)
    advanceFrame()

    // 迟到回调只写孤儿分区对象（随 GC 回收），flushPending 的
    // `partitions.get(sid) !== p` 守卫不复活分区——分区数仍为 0
    expect(__terminalPartitionCountForTest()).toBe(0)

    // 订阅已解除：cleanup 后再 dispatch 无人接收，不重建分区
    dispatchSession('s1', makeDataMsg('s1', 'ghost'))
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
      dispatchSession('s1', makeDataMsg('s1', c))
    }
    // flush 前 xterm 不写（等待帧边界）
    expect(xterm.write).not.toHaveBeenCalled()

    advanceFrame()
    await flushPromises()

    // D-6.2：写由 flush 直接通知监听器完成（watch 链已删），单帧一次合并 write
    expect(xterm.write).toHaveBeenCalledTimes(1)
    expect(xterm.write).toHaveBeenCalledWith('hello raf world\n')
  })

  it('RQ-7: 跨帧各写一次（每帧一次，非每 chunk 一次）', async () => {
    const wrapper = mount(TerminalView, { props: { sessionId: 's1' } })
    wrappers.push(wrapper)
    await flushPromises()

    const xterm = xtermInstances[xtermInstances.length - 1]!
    xterm.write.mockClear()

    dispatchSession('s1', makeDataMsg('s1', 'f1a'))
    dispatchSession('s1', makeDataMsg('s1', 'f1b'))
    advanceFrame()
    await flushPromises()
    dispatchSession('s1', makeDataMsg('s1', 'f2a'))
    dispatchSession('s1', makeDataMsg('s1', 'f2b'))
    dispatchSession('s1', makeDataMsg('s1', 'f2c'))
    advanceFrame()
    await flushPromises()

    expect(xterm.write).toHaveBeenCalledTimes(2)
    expect(xterm.write).toHaveBeenNthCalledWith(1, 'f1af1b')
    expect(xterm.write).toHaveBeenNthCalledWith(2, 'f2af2bf2c')
  })

  it('RQ-8: 回放语义 —— sessionId 切走再切回，xterm 重挂后全量回放完整', async () => {
    const wrapper = mount(TerminalView, { props: { sessionId: 's1' } })
    wrappers.push(wrapper)
    await flushPromises()

    for (const c of ['out1', 'out2', 'out3']) {
      dispatchSession('s1', makeDataMsg('s1', c))
    }
    advanceFrame()
    await flushPromises()

    // 切到 s2：xterm dispose 重 init（切走 tab/切 session 的回放路径）
    await wrapper.setProps({ sessionId: 's2' })
    await flushPromises()
    // 切回 s1：分区仍在（模块级持久 Map），新 xterm 实例全量回放
    await wrapper.setProps({ sessionId: 's1' })
    await flushPromises()

    const xterm = xtermInstances[xtermInstances.length - 1]!
    // 回放为单次合并 write，内容 = s1 分区全量（完整无缺漏）
    expect(xterm.write).toHaveBeenCalledTimes(1)
    expect(xterm.write).toHaveBeenCalledWith('out1out2out3')
  })

  it('RQ-9: Fix-1 —— LIMIT 稳态下连续 flush（length 净值守恒 5000→5000）仍触发 write', async () => {
    const wrapper = mount(TerminalView, { props: { sessionId: 's1' } })
    wrappers.push(wrapper)
    await flushPromises()

    // 预填至稳态：分帧喂超上限 chunk，buffer 达 LIMIT 后每次 flush「push N + splice 回 5000」
    const total = 5030
    for (let i = 0; i < total; i++) {
      dispatchSession('s1', makeDataMsg('s1', `x${i}`))
      if (i % 100 === 99) advanceFrame()
    }
    advanceFrame()
    await flushPromises() // 让预填阶段的监听器全部对齐（指针 = buffer.version）

    const xterm = xtermInstances[xtermInstances.length - 1]!
    xterm.write.mockClear()

    // 稳态下 3 次独立 flush：每次 push 1 + splice 1，chunks.length 净值 5000→5000 不变。
    // 修复前：watch(() => scrollback.length) 不触发 → write 零调用（实时输出冻结）；
    // 修复后：版本回放指针随 buffer.version（= append 总数，裁剪不减）单调前进，稳定触发。
    for (const c of ['steady-1\n', 'steady-2\n', 'steady-3\n']) {
      dispatchSession('s1', makeDataMsg('s1', c))
      advanceFrame()
      await flushPromises()
    }

    expect(xterm.write).toHaveBeenCalledTimes(3)
    expect(xterm.write).toHaveBeenNthCalledWith(1, 'steady-1\n')
    expect(xterm.write).toHaveBeenNthCalledWith(2, 'steady-2\n')
    expect(xterm.write).toHaveBeenNthCalledWith(3, 'steady-3\n')
  })
})

// ── Part 3：W27 D-6.2 —— 分区生命周期上提 + 版本回放（V-P2-4 脚本化）──────
describe('W27 D-6.2 分区生命周期上提 + 版本回放', () => {
  it('W27-1: 切走（unmount）期间输出照常累积，切回（remount）全量回放（V-P2-4 已知缺口修复）', async () => {
    // 第一实例：累积输出并 flush
    const w1 = mount(TerminalView, { props: { sessionId: 's1' } })
    await flushPromises()
    for (const c of ['old-1', 'old-2']) {
      dispatchSession('s1', makeDataMsg('s1', c))
    }
    advanceFrame()
    await flushPromises()
    w1.unmount() // 真实 tab 切走（PanelContainer v-if）：只移除视图 flush 监听器

    // 切走 30s：30 帧输出照常进入模块级分区（订阅跨组件存活，W14 缺口修复）
    const hidden: string[] = []
    for (let i = 0; i < 30; i++) {
      const c = `hidden-${i}\n`
      hidden.push(c)
      dispatchSession('s1', makeDataMsg('s1', c))
      advanceFrame()
    }
    await flushPromises()
    // 分区持久：buffer 版本随切走期间输出前进（数据不丢）
    expect(__terminalPartitionCountForTest()).toBe(1)

    // 第二实例：v-if 切回 remount
    const w2 = mount(TerminalView, { props: { sessionId: 's1' } })
    wrappers.push(w2)
    await flushPromises()
    const xterm2 = xtermInstances[xtermInstances.length - 1]!

    // 挂载回放：全量（unmount 前 + 切走期间），单次合并 write，无缺漏
    expect(xterm2.write).toHaveBeenCalledTimes(1)
    expect(xterm2.write).toHaveBeenCalledWith('old-1old-2' + hidden.join(''))

    // remount 后增量链路完整：新输出 → 模块分区 → rAF flush → 监听器增量 write
    dispatchSession('s1', makeDataMsg('s1', 'fresh-1'))
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

    // 三帧各一批：每帧 flush 后监听器只写本批增量（指针 = 上批末版本）
    const frames = [
      ['a1', 'a2', 'a3'], // flush 后 version 3
      ['b1', 'b2'],       // flush 后 version 5
      ['c1'],             // flush 后 version 6
    ]
    for (const batch of frames) {
      for (const c of batch) dispatchSession('s1', makeDataMsg('s1', c))
      advanceFrame()
      await flushPromises()
    }

    // 3 次增量 write，各等于本批 join（无重复——旧内容不再写；无遗漏——每批都写）
    expect(xterm.write).toHaveBeenCalledTimes(3)
    expect(xterm.write).toHaveBeenNthCalledWith(1, 'a1a2a3')
    expect(xterm.write).toHaveBeenNthCalledWith(2, 'b1b2')
    expect(xterm.write).toHaveBeenNthCalledWith(3, 'c1')
  })

  it('W27-3: 切走期间数据不丢 —— 订阅上提覆盖切走窗口（publish-only 下无订阅即丢弃）', async () => {
    const Host = makeHost('s1')
    const w = mount(Host)
    wrappers.push(w)
    const terminal = w.vm.terminal as UseTerminalReturn
    terminal.attachTerminal() // 建立模块级订阅

    dispatchSession('s1', makeDataMsg('s1', 'before'))
    advanceFrame()
    w.unmount() // 组件销毁（宿主即视图）：订阅与分区必须存活

    // 组件已卸载：分区仍持 1 条
    expect(__terminalPartitionCountForTest()).toBe(1)

    // 切走窗口内的输出仍被模块级订阅接收（无组件持有，分区照常累积）
    for (const c of ['away-1', 'away-2', 'away-3']) {
      dispatchSession('s1', makeDataMsg('s1', c))
      advanceFrame()
    }

    // 新宿主读到完整历史（before + away 全部）
    const Host2 = makeHost('s1')
    const w2 = mount(Host2)
    wrappers.push(w2)
    const terminal2 = w2.vm.terminal as UseTerminalReturn
    expect(terminal2.current.value.buffer.chunks).toEqual(['before', 'away-1', 'away-2', 'away-3'])
    expect(terminal2.current.value.buffer.version).toBe(4)
  })

  it('W27-4: 内存清理 —— session 销毁后分区释放 + 订阅解除 + flush 监听清空', async () => {
    const wrapper = mount(TerminalView, { props: { sessionId: 's1' } })
    wrappers.push(wrapper)
    await flushPromises()
    dispatchSession('s1', makeDataMsg('s1', 'data'))
    advanceFrame()
    await flushPromises()
    expect(__terminalPartitionCountForTest()).toBe(1)

    // session 销毁（useSidebar.deleteSession 编排 → triggerSessionCleanups）
    triggerSessionCleanups('s1')
    // 让渲染队列推进（Fix-2）：cleanup bump mapVersion → 视图重渲染 → current computed
    // 重算。修复前 create-on-read 会在此重建已删 sid 的空分区（原测试不 flush 渲染
    // 队列，computed 惰性未重算，是假阳性——这里会暴露原 bug）
    await flushPromises()

    // ① 分区释放（渲染重算后仍为 0——不复活已删 sid 的分区）
    expect(__terminalPartitionCountForTest()).toBe(0)
    // ② 订阅解除：销毁后 dispatch 无人接收，不重建分区
    dispatchSession('s1', makeDataMsg('s1', 'ghost'))
    advanceFrame()
    await flushPromises()
    expect(__terminalPartitionCountForTest()).toBe(0)
    // ③ 视图挂载期注册的 flush 监听器随分区清理（无残留闭包）——直接断言注册表清空
    //   （Fix-2 新增测试 hook：不再依赖「无分区时 flushPending 早退」的间接路径）
    expect(__terminalFlushListenerCountForTest()).toBe(0)
  })

  it('W27-5: replayChunks 纯函数 —— 版本边界与裁剪后物理起点', () => {
    // 空 buffer：无可回放
    expect(replayChunks({ chunks: [], version: 0 }, 0)).toBeNull()

    // 未裁剪：fromVersion 之后全部；fromVersion=0 全量；指针=版本 无新增
    const b1 = { chunks: ['a', 'b', 'c'], version: 3 }
    expect(replayChunks(b1, 0)).toBe('abc')
    expect(replayChunks(b1, 1)).toBe('bc')
    expect(replayChunks(b1, 3)).toBeNull()
    expect(replayChunks(b1, 5)).toBeNull()

    // 已裁剪（version 6、物理 2 条，裁剪 4）：fromVersion=0 全量保留；
    // 指针落后裁剪线（≤4）→ 从物理 0（保留内容全在新指针后，无重复）
    const b2 = { chunks: ['e', 'f'], version: 6 }
    expect(replayChunks(b2, 0)).toBe('ef')
    expect(replayChunks(b2, 4)).toBe('ef')
    // 指针在保留区内：物理起点 = fromVersion - 裁剪量
    expect(replayChunks(b2, 5)).toBe('f')
    expect(replayChunks(b2, 6)).toBeNull()
  })

  it('W27-6: watch(scrollback.length) 与 watch(flushVersion) 已删除（D-6.2 检查点 grep 断言）', () => {
    // __dirname = src/__tests__/terminal（vite-node 注入），up 2 到 src 后拼目标路径
    // Fix-4：断言范围覆盖 useTerminal.ts + TerminalView.vue 双侧（旧 watch 链可能
    // 只从其中一侧回归——如模块侧重引入 reactive 依赖）
    const sources = [
      resolve(__dirname, '../../composables/features/terminal/useTerminal.ts'),
      resolve(__dirname, '../../components/panel/TerminalView.vue'),
    ].map((p) => readFileSync(p, 'utf8'))
    // 旧 watch 链的源引用全部消失（回放只靠 replayFrom(version)）
    for (const src of sources) {
      expect(src).not.toContain('scrollback.length')
      expect(src).not.toContain('flushVersion')
      expect(src).not.toContain('replayedUpTo')
    }
  })

  it('W27-7: clear 重置 buffer —— 切走切回历史为空（Fix-3）', async () => {
    const wrapper = mount(TerminalView, { props: { sessionId: 's1' } })
    wrappers.push(wrapper)
    await flushPromises()
    const xterm = xtermInstances[xtermInstances.length - 1]!

    // 先有历史
    dispatchSession('s1', makeDataMsg('s1', 'old-1'))
    dispatchSession('s1', makeDataMsg('s1', 'old-2'))
    advanceFrame()
    await flushPromises()
    expect(xterm.write).toHaveBeenCalledTimes(1)
    expect(xterm.write).toHaveBeenCalledWith('old-1old-2')

    // 点 clear：xterm 清屏 + 模块 buffer 重置（Fix-3 前只清 xterm，buffer 残留）
    xterm.write.mockClear()
    xterm.clear.mockClear()
    await wrapper.find('[data-testid="terminal-btn-clear"]').trigger('click')
    await flushPromises()
    expect(xterm.clear).toHaveBeenCalled()

    // clear 后新输出照常显示（buffer.version 从 0 重新计，增量链路不断）
    dispatchSession('s1', makeDataMsg('s1', 'fresh'))
    advanceFrame()
    await flushPromises()
    expect(xterm.write).toHaveBeenCalledTimes(1)
    expect(xterm.write).toHaveBeenCalledWith('fresh')

    // 切走再切回：回放仅含 clear 后的内容（旧历史不复活）
    await wrapper.setProps({ sessionId: 's2' })
    await flushPromises()
    await wrapper.setProps({ sessionId: 's1' })
    await flushPromises()
    const xterm2 = xtermInstances[xtermInstances.length - 1]!
    expect(xterm2.write).toHaveBeenCalledTimes(1)
    expect(xterm2.write).toHaveBeenCalledWith('fresh')
  })

  it('W27-8: replayChunksBatched 纯函数 —— 分批边界 + 总内容等价 + 每批上限（Fix-5）', () => {
    // 空 buffer：无可回放（同 replayChunks）
    expect(replayChunksBatched({ chunks: [], version: 0 }, 0)).toBeNull()

    // 默认批上限 500：1200 条 → 3 批（500/500/200），总内容与逐条 join 等价
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

    // 每批 chunk 数 ≤ 上限（固定 4 字符 chunk：每批 ≤ 500 × 4 字符）
    const fixedChunks = Array.from({ length: 1200 }, () => 'aaaa')
    const r2 = replayChunksBatched({ chunks: fixedChunks, version: 1200 }, 0)!
    for (const b of r2.batches) expect(b.length).toBeLessThanOrEqual(500 * 4)

    // 自定义批上限 + 增量起点（裁剪后物理起点语义同 replayChunks）
    const croppedBuf = { chunks: ['e', 'f', 'g'], version: 9 }
    const r3 = replayChunksBatched(croppedBuf, 6, 2)!
    expect(r3.batches).toEqual(['ef', 'g'])
    // 指针 = 版本 → null（无新增）
    expect(replayChunksBatched(croppedBuf, 9)).toBeNull()
  })

  it('W27-9: 大批量 flush 分帧写 —— 每帧一批、顺序保持、总内容等价（Fix-5）', async () => {
    const wrapper = mount(TerminalView, { props: { sessionId: 's1' } })
    wrappers.push(wrapper)
    await flushPromises()
    const xterm = xtermInstances[xtermInstances.length - 1]!
    xterm.write.mockClear()

    // 单帧 600 chunks（≤ MAX_OUTPUT_QUEUE 不合并）：一次 flush → 2 批（500 + 100）
    const count = 600
    for (let i = 0; i < count; i++) dispatchSession('s1', makeDataMsg('s1', `b${i};`))
    advanceFrame() // flushPending → onFlushed → 首批同步写
    await flushPromises()
    expect(xterm.write).toHaveBeenCalledTimes(1)
    expect(xterm.write).toHaveBeenNthCalledWith(
      1,
      Array.from({ length: 500 }, (_, i) => `b${i};`).join(''),
    )

    advanceFrame() // rAF 链：第二批
    await flushPromises()
    expect(xterm.write).toHaveBeenCalledTimes(2)
    expect(xterm.write).toHaveBeenNthCalledWith(
      2,
      Array.from({ length: 100 }, (_, i) => `b${i + 500};`).join(''),
    )

    // 总内容等价（分批不丢不重不乱序）
    expect(xterm.write.mock.calls.map((c) => c[0]).join('')).toBe(
      Array.from({ length: count }, (_, i) => `b${i};`).join(''),
    )

    // 链完成后增量 flush 照常（单批同步写）
    dispatchSession('s1', makeDataMsg('s1', 'tail'))
    advanceFrame()
    await flushPromises()
    expect(xterm.write).toHaveBeenCalledTimes(3)
    expect(xterm.write).toHaveBeenNthCalledWith(3, 'tail')
  })
})

// ── Part 4：S-15 全量重放清屏信号（PR #175 R1）──────────────────────────
// 契约：回放指针落后裁剪线（physicalStart 钳 0 全量重放）时，replayChunksBatched
// 返回 clamped=true，视图先 xterm.clear() 再写——xterm.write 追加语义下，屏上旧内容
// 与全量重放区间重叠会重复显示。指针同步的常规增量路径 clamped=false，不触发清屏。
describe('S-15 全量重放清屏信号', () => {
  it('S15-1: replayChunksBatched clamped 信号真值表 —— 仅指针落后裁剪线时置位', () => {
    // 未裁剪（cropped=0）：任何指针都不触发（含 mount 全量 fromVersion=0）
    const uncropped = { chunks: ['a', 'b', 'c'], version: 3 }
    expect(replayChunksBatched(uncropped, 0)!.clamped).toBe(false)
    expect(replayChunksBatched(uncropped, 2)!.clamped).toBe(false)

    // 已裁剪（version 6、物理 2 条、裁剪量 4）：指针落后裁剪线（fromVersion < 4）→ 钳 0
    const croppedBuf = { chunks: ['e', 'f'], version: 6 }
    expect(replayChunksBatched(croppedBuf, 0)!.clamped).toBe(true)
    expect(replayChunksBatched(croppedBuf, 3)!.clamped).toBe(true)
    // 指针恰在裁剪线上（fromVersion=4=裁剪量）：物理起点 0 是自然对齐（保留区起点即指针），非钳制
    expect(replayChunksBatched(croppedBuf, 4)!.clamped).toBe(false)
    // 指针在保留区内：正常增量
    expect(replayChunksBatched(croppedBuf, 5)!.clamped).toBe(false)
    // 指针 = 版本：无新增
    expect(replayChunksBatched(croppedBuf, 6)).toBeNull()
  })

  it('S15-2: 指针落后裁剪线（视图 mount 前已 >5000 裁剪）→ 全量重放前 xterm 先 clear，内容恰为保留区全量', async () => {
    // 无视图期间累积 5050 chunk（裁剪 50）：host 建立模块订阅，flush 无监听器（纯累积）
    const Host = makeHost('s1')
    const w = mount(Host)
    ;(w.vm.terminal as UseTerminalReturn).attachTerminal()
    const total = 5050
    for (let i = 0; i < total; i++) {
      dispatchSession('s1', makeDataMsg('s1', `x${i};`))
      if (i % 100 === 99) advanceFrame()
    }
    advanceFrame()
    await flushPromises()
    w.unmount() // 移除 host（模块订阅保留），视图尚未挂载 → 无 flush 监听

    // mount 视图：replayFrom(0) 落后裁剪线 50 → clamped=true → 清屏 + 保留区全量重放
    const wrapper = mount(TerminalView, { props: { sessionId: 's1' } })
    wrappers.push(wrapper)
    await flushPromises()
    const xterm = xtermInstances[xtermInstances.length - 1]!

    // 清屏信号生效：clear 恰一次，且先于首个 write（invocationCallOrder 全局单调序）
    expect(xterm.clear).toHaveBeenCalledTimes(1)
    const clearOrder = xterm.clear.mock.invocationCallOrder[0]
    const firstWriteOrder = xterm.write.mock.invocationCallOrder[0]
    expect(clearOrder).toBeDefined()
    expect(firstWriteOrder).toBeDefined()
    expect(clearOrder).toBeLessThan(firstWriteOrder)

    // 排空 10 批（5000 chunks / 500 每批）：总内容 = 保留区全量 x50..x5049，
    // join 严格相等 ⇒ 无重复（每 chunk 恰出现一次）、无缺漏（被裁的 x0..x49 不出现）
    for (let i = 0; i < 12; i++) advanceFrame()
    await flushPromises()
    const written = xterm.write.mock.calls.map((c) => c[0]).join('')
    expect(written).toBe(Array.from({ length: 5000 }, (_, i) => `x${i + 50};`).join(''))

    // 后续增量 flush 指针已同步 → clamped=false → 不再清屏，只追加增量
    dispatchSession('s1', makeDataMsg('s1', 'tail'))
    advanceFrame()
    await flushPromises()
    expect(xterm.clear).toHaveBeenCalledTimes(1)
    expect(xterm.write).toHaveBeenLastCalledWith('tail')
  })

  it('S15-3: 未裁剪 buffer 的 mount 全量回放 → clamped=false，不触发 clear（信号只在指针落后裁剪线时置位）', async () => {
    const Host = makeHost('s1')
    const w = mount(Host)
    ;(w.vm.terminal as UseTerminalReturn).attachTerminal()
    for (const c of ['a1', 'a2', 'a3']) dispatchSession('s1', makeDataMsg('s1', c))
    advanceFrame()
    await flushPromises()
    w.unmount()

    const wrapper = mount(TerminalView, { props: { sessionId: 's1' } })
    wrappers.push(wrapper)
    await flushPromises()
    const xterm = xtermInstances[xtermInstances.length - 1]!

    // cropped=0：mount 全量回放是自然对齐，无需清屏（防止「每次回放都 clear」回归——
    // 增量/常规路径误清会丢失屏上可见历史）
    expect(xterm.clear).not.toHaveBeenCalled()
    expect(xterm.write).toHaveBeenCalledWith('a1a2a3')
  })
})
