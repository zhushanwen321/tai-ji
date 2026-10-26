/**
 * 后台命令 + 键盘编排器单测族合并文件（簇 3-4 A 组，6 源合一，DOM 环境）：
 * - use-background-tasks.test.ts —— 后台命令状态根（拉取/广播/竞态/分区/refCount/cleanup）
 * - key-orchestrator/overlay-modal-stack.test.ts —— 浮层×模态叠开 Tab 属主与 Esc 递进
 * - key-orchestrator/esc-stack-order.test.ts —— Esc 键序矩阵（固定层级序）
 * - useCloseShortcut.test.ts —— 容器快捷键 IPC 桥 → 编排器
 * - key-orchestrator/modal-yield-event-order.test.ts —— 模态共存让位与聚合让位真实事件序
 * - key-orchestrator/overlay-focus-trap.test.ts —— 浮层 Tab 焦点陷阱随迁保位
 *
 * 三组 mock 经核实互不入对方消费图：background-task domain 窄 mock（list）只被
 * useBackgroundTasks 图消费；ws-client 为 spread-actual 部分 mock（只重写 getState）；
 * @/lib/ipc 窄 mock（onShortcut/windowClose）覆盖图内全部消费名（orchestrator.ts 仅
 * windowClose）。各节 beforeEach/afterEach 与 helper 下沉节内。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { defineComponent, h, ref, nextTick, onBeforeUnmount, effectScope } from 'vue'
import { mount, type VueWrapper } from '@vue/test-utils'
import { wsStateModuleWithControlledRef } from '../helpers/ws-state-ref-mock'
import * as events from '@taiji/core/transport/api'
import {
  triggerSessionCleanups,
  __clearSessionCleanupRegistryForTest,
} from '@/composables/useSessionScopedState'
import {
  useBackgroundTasks,
  __resetBackgroundTasksForTest,
  type UseBackgroundTasksReturn,
} from '@/composables/features/sidebar/useBackgroundTasks'
import type { BackgroundTaskEntry } from '@/lib/background-task-bucket'
import { registerModalSurface } from '@/composables/features/app/modal-surface-registry'
import {
  registerOverlayFocusTrapPanel,
  getOverlayFocusTrapPanel,
} from '@/composables/features/app/key-orchestrator'
import { useCloseShortcut } from '@/composables/features/app/useCloseShortcut'
import {
  bindTestSession,
  containerStates,
  keyEvent,
  openBottom,
  openRight,
  openWorkflowOverlay,
  resetOrchestratorFixtures,
  startOrchestrator,
} from './key-orchestrator/helpers'

// ── use-background-tasks 节 mock：list RPC mock 掉 + ws 连接态受控 ref（默认 connected）──
const listMock = vi.hoisted(() => vi.fn())
vi.mock('@taiji/core/transport/api/domains/background-task', () => ({ list: listMock }))

const wsMock = vi.hoisted(() => ({ ref: null as null | { value: string } }))
vi.mock('@taiji/core/transport/ws-client', () =>
  wsStateModuleWithControlledRef('@taiji/core/transport/ws-client', wsMock, 'connected'),
)

// ── useCloseShortcut 节 mock：捕获 onShortcut callback + windowClose spy（文件作用域闭包）──
const windowClose = vi.fn(() => Promise.resolve())
let shortcutCallback: ((type: string) => void) | null = null
let unsubscribeCalled = false
const mockOnShortcut = vi.fn((cb: (type: string) => void) => {
  shortcutCallback = cb
  return () => {
    unsubscribeCalled = true
    shortcutCallback = null
  }
})

vi.mock('@/lib/ipc', () => ({
  onShortcut: (cb: (type: string) => void) => mockOnShortcut(cb),
  windowClose: () => windowClose(),
}))

// ═══ 来源节：use-background-tasks.test.ts —— 后台命令状态根（拉取/广播/竞态/分区/refCount/cleanup） ═══
describe('use-background-tasks', () => {
  // ── 共享测试基建 ─────────────────────────────────────────────

  /** list reply 协议形态（shared protocol.ts 'backgroundTask.tasks' 契约；corrupted 缺省 = 正常拍）。 */
  interface ListReplyShape {
    sessionId: string
    tasks: BackgroundTaskEntry[]
    corrupted?: boolean
  }

  interface Deferred {
    sid: string
    resolve: (reply: ListReplyShape) => void
    reject: (err: unknown) => void
  }

  let pendingLists: Deferred[] = []
  const wrappers: VueWrapper[] = []

  /** registry 条目构造（测试只关心 state/taskId/command，其余字段取合法默认）。 */
  function task(taskId: string, state: BackgroundTaskEntry['state'], overrides: Partial<BackgroundTaskEntry> = {}): BackgroundTaskEntry {
    return {
      taskId,
      pid: 100 + taskId.length,
      command: `cmd-${taskId}`,
      outputFile: `/tmp/${taskId}.log`,
      startedAt: 1_000,
      ownerPiPid: 9,
      sessionId: 'sess-owner',
      ...overrides,
    }
  }

  interface HostHandle {
    sidRef: ReturnType<typeof ref<string | null>>
    tasks: UseBackgroundTasksReturn
  }

  /** 测试宿主：setup 内调 useBackgroundTasks 并 expose（composable 依赖组件 scope）。 */
  function mountHost(initialSid: string | null): HostHandle {
    const sidRef = ref<string | null>(initialSid)
    const wrapper = mount(
      defineComponent({
        setup() {
          const tasks = useBackgroundTasks(sidRef)
          return { tasks }
        },
        render: () => h('div'),
      }),
    )
    wrappers.push(wrapper)
    const candidate = (wrapper.vm as { tasks?: unknown }).tasks
    if (!candidate || typeof candidate !== 'object' || !('current' in candidate)) {
      throw new Error('host 组件未暴露 tasks')
    }
    return { sidRef, tasks: candidate as UseBackgroundTasksReturn }
  }

  /** 排空异步链：setTimeout(0) 前所有已排队微任务（promise 链 + Vue 调度器 flush）跑完。 */
  async function settle(): Promise<void> {
    await new Promise((r) => setTimeout(r, 0))
    await nextTick()
  }

  /** listMock 发起时登记 deferred（手动控制 resolve/reject 时序）。 */
  listMock.mockImplementation((sid: string) => {
    return new Promise<ListReplyShape>((resolve, reject) => {
      pendingLists.push({ sid, resolve, reject })
    })
  })

  /** resolve 指定 sid 的最早已登记在途 list（协议对象形态，对齐 backgroundTask.tasks 契约）。 */
  function resolveList(sid: string, tasks: BackgroundTaskEntry[]): void {
    const idx = pendingLists.findIndex((e) => e.sid === sid)
    if (idx < 0) throw new Error(`测试编排错误：sid ${sid} 无在途 list`)
    const [entry] = pendingLists.splice(idx, 1)
    entry.resolve({ sessionId: sid, tasks })
  }

  /** 广播 backgroundTask:updated（真实 session 通道分发）；corrupted 缺省 = 协议 optional 缺省拍。 */
  function dispatchUpdated(sid: string, tasks: BackgroundTaskEntry[], corrupted?: boolean): void {
    events.dispatchSession(sid, {
      type: 'backgroundTask:updated',
      payload: corrupted === undefined ? { sessionId: sid, tasks } : { sessionId: sid, tasks, corrupted },
    })
  }

  beforeEach(() => {
    pendingLists = []
    listMock.mockClear()
    if (wsMock.ref) wsMock.ref.value = 'connected'
  })

  afterEach(() => {
    for (const w of wrappers) w.unmount()
    wrappers.length = 0
    __resetBackgroundTasksForTest()
    __clearSessionCleanupRegistryForTest()
  })

  // ── 拉取路径（C6 唯一真相入口）──

  describe('拉取路径', () => {
    it('mount 即拉：immediate 恢复路径对当前 sid 发 list，resolve 后分区填充 + loaded', async () => {
      const host = mountHost('A')
      expect(listMock).toHaveBeenCalledWith('A')
      expect(host.tasks.current.value.loaded).toBe(false)
      resolveList('A', [task('t1', 'running')])
      await settle()
      expect(host.tasks.current.value.tasks).toHaveLength(1)
      expect(host.tasks.current.value.tasks[0].taskId).toBe('t1')
      expect(host.tasks.current.value.loaded).toBe(true)
    })

    it('切 sid 触发重新拉取：切到 B 后拉 B（切走期间广播已退订，缓存不可信）', async () => {
      const host = mountHost('A')
      resolveList('A', [task('t1', 'running')])
      await settle()
      host.sidRef.value = 'B'
      await nextTick()
      expect(listMock).toHaveBeenCalledWith('B')
      resolveList('B', [task('t2', 'exited', { exitCode: 0, reason: 'natural', endedAt: 2_000 })])
      await settle()
      expect(host.tasks.current.value.tasks.map((t) => t.taskId)).toEqual(['t2'])
    })

    it('in-flight 去重：同 sid 并发 refresh 复用同一 Promise，list 只发一次', async () => {
      const host = mountHost('A')
      await settle() // 排空 immediate 恢复路径的在途（此时 A 已有一条在途）
      expect(listMock).toHaveBeenCalledTimes(1)
      const p1 = host.tasks.refresh()
      const p2 = host.tasks.refresh('A')
      expect(listMock).toHaveBeenCalledTimes(1) // 并发去重，不重发
      resolveList('A', [task('t1', 'running')])
      await Promise.all([p1, p2])
      await settle()
      expect(host.tasks.current.value.tasks.map((t) => t.taskId)).toEqual(['t1'])
      // settle 后条目已清：再次 refresh 重新发起
      void host.tasks.refresh()
      expect(listMock).toHaveBeenCalledTimes(2)
      resolveList('A', [])
    })

    it('list 失败不降级：分区缓存保留、loaded 不虚置、refresh 不 reject（无 unhandled）', async () => {
      const host = mountHost('A')
      resolveList('A', [task('t1', 'running')])
      await settle()
      host.sidRef.value = 'B'
      await nextTick()
      const idx = pendingLists.findIndex((e) => e.sid === 'B')
      const [entry] = pendingLists.splice(idx, 1)
      entry.reject(new Error('ws closed'))
      await settle() // 若实现 produce unhandled rejection，vitest 会以未处理拒绝报告
      expect(host.tasks.current.value.loaded).toBe(false) // B 从未成功拉取
      host.sidRef.value = 'A'
      await nextTick()
      await settle()
      // 切回 A：恢复路径无条件重新拉取（缓存过期不可信），旧缓存仍在 RPC 往返期显示
      expect(host.tasks.current.value.loaded).toBe(true)
      expect(host.tasks.current.value.tasks.map((t) => t.taskId)).toEqual(['t1'])
    })
  })

  // ── 广播路径 + 双 session updateFor 竞态（M1）+ P6 分区 ──

  describe('广播写入与双 session 竞态', () => {
    it('广播 → updateFor(capturedSid) 写「消息所属 sid」分区', async () => {
      const host = mountHost('A')
      resolveList('A', [])
      await settle()
      dispatchUpdated('A', [task('t1', 'killing')])
      await nextTick()
      expect(host.tasks.current.value.tasks.map((t) => t.taskId)).toEqual(['t1'])
      expect(host.tasks.current.value.loaded).toBe(true)
    })

    it('双 session updateFor 竞态（M1）：切 sid 后退订窗口内的旧 sid 迟到广播写旧分区，不污染新分区', async () => {
      // 双实例形态：hostA 恒绑 A；host2 从 A 切 B（复现切 session 时序）
      mountHost('A')
      const host2 = mountHost('A')
      resolveList('A', [])
      await settle()
      expect(listMock).toHaveBeenCalledTimes(1) // 同 sid 双实例拉取去重

      dispatchUpdated('A', [task('t1', 'running')])
      await nextTick()
      expect(host2.tasks.current.value.tasks.map((t) => t.taskId)).toEqual(['t1'])

      // 切 B（watch flush:pre 尚未执行，物理订阅仍是 A）→ 旧 sid 迟到广播
      host2.sidRef.value = 'B'
      dispatchUpdated('A', [task('t1-late', 'killing')])
      await nextTick()
      // 迟到帧落 A 分区：hostA（仍绑 A）可见 t1-late；host2 已绑 B，视图是 B 分区（未被污染）
      const hostA = wrappers[0]
      const tasksA = (hostA.vm as { tasks?: UseBackgroundTasksReturn }).tasks
      expect(tasksA?.current.value.tasks.map((t) => t.taskId)).toEqual(['t1-late'])
      expect(host2.tasks.current.value.tasks).toEqual([]) // B 分区从未写入，无 A 残留
    })

    it('P6 分区：双实例双 session，publish(sid=A) 后 B 分区无变化', async () => {
      const hostA = mountHost('A')
      const hostB = mountHost('B')
      resolveList('A', [task('a1', 'running')])
      resolveList('B', [task('b1', 'exited', { exitCode: 0, reason: 'natural', endedAt: 2_000 })])
      await settle()
      const beforeB = [...hostB.tasks.current.value.tasks]

      dispatchUpdated('A', [task('a1', 'exited', { exitCode: 0, reason: 'natural', endedAt: 5_000 }), task('a2', 'running')])
      await nextTick()

      // A 分区已被 A 广播更新；B 分区保持拉取值原样（引用与值均未变）
      expect(hostA.tasks.current.value.tasks.map((t) => t.taskId)).toEqual(['a1', 'a2'])
      expect(hostB.tasks.current.value.tasks).toEqual(beforeB)
      expect(hostB.tasks.current.value.tasks.map((t) => t.taskId)).toEqual(['b1'])

      // 反向同样成立：B 广播不进 A 分区
      dispatchUpdated('B', [task('b2', 'running')])
      await nextTick()
      expect(hostB.tasks.current.value.tasks.map((t) => t.taskId)).toEqual(['b2'])
      expect(hostA.tasks.current.value.tasks.map((t) => t.taskId)).toEqual(['a1', 'a2'])
    })
  })

  // ── 模块级 refCount 单 listener ──

  describe('refCount 订阅收敛', () => {
    it('同 sid 多实例共享物理订阅：一实例卸载后余者仍收广播', async () => {
      const host1 = mountHost('A')
      const host2 = mountHost('A')
      resolveList('A', [])
      await settle()

      host1.sidRef.value = null // 实例1 退订 A 分区键（watch flush 释放订阅引用，refCount 2→1）
      await nextTick()
      const w1 = wrappers[0]
      w1.unmount()
      wrappers.splice(wrappers.indexOf(w1), 1)

      // 实例2 仍持有订阅（refCount 1）：广播照常写入
      dispatchUpdated('A', [task('t9', 'running')])
      await nextTick()
      expect(host2.tasks.current.value.tasks.map((t) => t.taskId)).toEqual(['t9'])
    })

    it('实例卸载释放订阅引用：全部卸载后广播无人消费（无异常）', async () => {
      mountHost('A')
      resolveList('A', [])
      await settle()
      for (const w of [...wrappers]) {
        w.unmount()
        wrappers.splice(wrappers.indexOf(w), 1)
      }
      expect(() => dispatchUpdated('A', [task('t9', 'running')])).not.toThrow()
    })
  })

  // ── session 销毁 cleanup + 迟到写入拦截（D-B2-1 工厂单点形态）──
  // 拦截簿记 = useSessionScopedState 的 deletedSids（本模块无自有抑制表，原 BG-7 簿记
  // 生命周期用例随其退役，防回归锚在 use-session-scoped-state.test.ts）。出列点 = 分区
  // 重建点（current 读取）——真实时序中销毁后视图必然切走（current 不再读该 sid），
  // 拦截成立；切回 = 新生命周期，拉取路径重新拉取。

  describe('session 销毁 cleanup', () => {
    it('triggerSessionCleanups 后：切走期间迟到的广播 / RPC resolve 不僵尸式写回；切回 = 新生命周期重新拉取', async () => {
      const host = mountHost('A')
      // 留一条在途 list（模拟销毁时 RPC 未 resolve）
      await nextTick()
      triggerSessionCleanups('A') // 分区清 + deletedSids 记入（工厂自动注册承载）

      // 真实时序：销毁后视图切走——期间迟到的广播与 RPC resolve 均被 deletedSids 拦截
      host.sidRef.value = 'B'
      await nextTick()
      dispatchUpdated('A', [task('ghost', 'running')])
      resolveList('A', [task('ghost-rpc', 'running')])
      await settle()

      // 切回 = 新生命周期：渲染读取分区即重建出列（先于 reply 落地的真实时序）+ 拉取路径重新拉取
      host.sidRef.value = 'A'
      await nextTick()
      expect(listMock).toHaveBeenLastCalledWith('A')
      void host.tasks.current.value
      resolveList('A', [task('fresh', 'running')])
      await settle()
      expect(host.tasks.current.value.tasks.map((t) => t.taskId)).toEqual(['fresh'])
    })
  })

  // ── 损坏拍与断连恢复（S7/S6，一致性审查修复批次）──

  /** resolve 指定 sid 的在途 list 为任意形状（前向兼容 corrupted 透传的对象形态探测）。 */
  function resolveListRaw(sid: string, raw: unknown): void {
    const idx = pendingLists.findIndex((e) => e.sid === sid)
    if (idx < 0) throw new Error(`测试编排错误：sid ${sid} 无在途 list`)
    const [entry] = pendingLists.splice(idx, 1)
    ;(entry.resolve as (v: unknown) => void)(raw)
  }

  describe('损坏拍与断连恢复（S7/S6）', () => {
    it('S7 sticky：corrupted===true 置位；损坏后一拍的 corrupted:false 空表广播不清位（防闪断）', async () => {
      const host = mountHost('A')
      await settle()
      resolveList('A', [])
      await settle()
      expect(host.tasks.current.value.corrupted).toBe(false)

      // 损坏检测拍：corrupted===true（runtime 安全降级空表）
      dispatchUpdated('A', [], true)
      await settle()
      expect(host.tasks.current.value.corrupted).toBe(true)

      // 损坏后自然拍（.corrupt rename → stat=undefined → D1 空表重建）：corrupted:false 空表
      // ——sticky 不清位，错误条不闪断
      dispatchUpdated('A', [], false)
      await settle()
      expect(host.tasks.current.value.corrupted).toBe(true)

      // 协议 optional 缺省拍（等价 false）同样不清位
      dispatchUpdated('A', [])
      await settle()
      expect(host.tasks.current.value.corrupted).toBe(true)

      // 自愈拍（extension 自愈空表重建，条目出现）→ 清位
      dispatchUpdated('A', [task('t9', 'running')])
      await settle()
      expect(host.tasks.current.value.corrupted).toBe(false)
    })

    it('S7 拉取路同型消费：list reply 前向兼容对象形状（tasks + corrupted）置位分区', async () => {
      const host = mountHost('A')
      await settle()
      // 协议落地后 api domain 透传 reply 对象（当前返回数组——运行时结构探测两形态）
      resolveListRaw('A', { tasks: [], corrupted: true })
      await settle()
      expect(host.tasks.current.value.corrupted).toBe(true)
      expect(host.tasks.current.value.loaded).toBe(true)
      expect(host.tasks.current.value.tasks).toHaveLength(0)

      // 自愈：重发拉取（首次 RPC settle 后 in-flight 已清），对象形状 corrupted:false + 条目非空 → 清位
      void host.tasks.refresh('A')
      resolveListRaw('A', { tasks: [task('t-recover', 'running')], corrupted: false })
      await settle()
      expect(host.tasks.current.value.corrupted).toBe(false)
    })

    it('S6 拉取失败：分区 fetchFailed 置位（缓存保留）；成功拍翻回 false', async () => {
      const host = mountHost('A')
      await settle()
      const idx = pendingLists.findIndex((e) => e.sid === 'A')
      const [entry] = pendingLists.splice(idx, 1)
      entry.reject(new Error('ws closed'))
      await settle()
      expect(host.tasks.current.value.fetchFailed).toBe(true)
      expect(host.tasks.current.value.loaded).toBe(false)

      // 成功拍：refresh 重发（首次已 settle 清 in-flight），翻回 false
      void host.tasks.refresh('A')
      resolveList('A', [task('t1', 'running')])
      await settle()
      expect(host.tasks.current.value.fetchFailed).toBe(false)
      expect(host.tasks.current.value.loaded).toBe(true)
    })

    it('S7 坏形状 reply（契约外值）：按失败拍处理——fetchFailed 置位 + 分区缓存保留，不空表降级', async () => {
      const host = mountHost('A')
      await settle()
      resolveList('A', [task('t1', 'running')])
      await settle()
      expect(host.tasks.current.value.tasks.map((t) => t.taskId)).toEqual(['t1'])

      // 垃圾对象（无 tasks 数组）→ 契约外形状：fetchFailed 置位，缓存/loaded/corrupted 原样保留
      void host.tasks.refresh('A')
      resolveListRaw('A', { garbage: true })
      await settle()
      expect(host.tasks.current.value.fetchFailed).toBe(true)
      expect(host.tasks.current.value.tasks.map((t) => t.taskId)).toEqual(['t1'])
      expect(host.tasks.current.value.loaded).toBe(true)
      expect(host.tasks.current.value.corrupted).toBe(false)

      // undefined（契约外值）同款：缓存保留不清空
      void host.tasks.refresh('A')
      resolveListRaw('A', undefined)
      await settle()
      expect(host.tasks.current.value.fetchFailed).toBe(true)
      expect(host.tasks.current.value.tasks.map((t) => t.taskId)).toEqual(['t1'])
    })

    it('S6 重连恢复路径：ws disconnected→connected 边沿重新拉取当前 sid（非边沿不触发）', async () => {
      const host = mountHost('A')
      await settle()
      resolveList('A', [task('t1', 'running')])
      await settle()
      expect(listMock).toHaveBeenCalledTimes(1) // 挂载期仅拉取路径一次（watch 非 immediate）

      if (!wsMock.ref) throw new Error('ws mock 未初始化')
      wsMock.ref.value = 'disconnected'
      await nextTick()
      wsMock.ref.value = 'connected'
      await settle()
      expect(listMock).toHaveBeenCalledTimes(2) // connected 边沿触发 refresh
      expect(listMock).toHaveBeenLastCalledWith('A')
      resolveList('A', [task('t1', 'running')])
      await settle()
      expect(host.tasks.current.value.loaded).toBe(true)
    })

    it('fetchInto 共享 RPC 时各实例分区独立写入（复用者分区不丢写）', async () => {
      const h1 = mountHost('A')
      const h2 = mountHost('A')
      await settle()
      expect(listMock).toHaveBeenCalledTimes(1) // in-flight 去重：两实例共享同一 RPC

      resolveList('A', [task('t-shared', 'running')])
      await settle()
      expect(h1.tasks.current.value.loaded).toBe(true)
      expect(h1.tasks.current.value.tasks.map((t) => t.taskId)).toEqual(['t-shared'])
      expect(h2.tasks.current.value.loaded).toBe(true)
      expect(h2.tasks.current.value.tasks.map((t) => t.taskId)).toEqual(['t-shared'])
    })
  })
})

// ═══ 来源节：key-orchestrator/overlay-modal-stack.test.ts —— 浮层×模态叠开 Tab 属主与 Esc 递进 ═══
describe('key-orchestrator/overlay-modal-stack', () => {
  function makePanel(buttonCount: number): { panel: HTMLElement; buttons: HTMLElement[] } {
    const panel = document.createElement('div')
    panel.tabIndex = -1
    const buttons = Array.from({ length: buttonCount }, () => document.createElement('button'))
    panel.append(...buttons)
    document.body.appendChild(panel)
    return { panel, buttons }
  }

  /** 跨用例存活的挂载 wrapper（afterEach 统一卸载——卸载才摘 window 监听与聚合注册） */
  const mountedWrappers: VueWrapper[] = []

  /**
   * 模态形态（⌘K 搜索族同构）：挂载⇔开（注册随挂载、注销随卸载）+ Esc 消费方随开态活/死
   * （真实模态关即卸载、监听随之消失——关态检查是其等价形态）+ 面板内可聚焦元素
   * （Tab 属主判定的焦点锚）。
   */
  function mountSearchModalLike(): { input: HTMLElement } {
    const modalOpen = ref(true)
    const SearchModalLike = defineComponent({
      setup() {
        const dispose = registerModalSurface({
          surface: 'search-modal',
          key: 'stack-search-modal',
          isOpen: () => modalOpen.value,
        })
        onBeforeUnmount(dispose)
        const onEsc = (e: KeyboardEvent): void => {
          if (!modalOpen.value) return // 关态无 Esc 消费方（挂载⇔开）
          if (e.key !== 'Escape' || e.defaultPrevented) return
          e.preventDefault()
          modalOpen.value = false
        }
        window.addEventListener('keydown', onEsc)
        onBeforeUnmount(() => window.removeEventListener('keydown', onEsc))
        return () =>
          h('div', { 'data-testid': 'stack-search-modal-like' }, [
            h('input', { 'data-testid': 'stack-search-input' }),
          ])
      },
    })
    const wrapper = mount(SearchModalLike, { attachTo: document.body })
    mountedWrappers.push(wrapper)
    const input = wrapper.find('[data-testid="stack-search-input"]').element as HTMLElement
    return { input }
  }

  beforeEach(() => {
    resetOrchestratorFixtures()
    bindTestSession()
  })

  afterEach(() => {
    for (const wrapper of mountedWrappers.splice(0)) wrapper.unmount()
    resetOrchestratorFixtures()
    document.body.innerHTML = ''
  })

  describe('叠开组合：Tab 属主 = 最上层表面（2026-10-03 用户裁决）', () => {
    it('浮层 + 模态同开：Tab 不被浮层陷阱捕获（焦点留在模态内、不 preventDefault）', () => {
      const { panel } = makePanel(2)
      registerOverlayFocusTrapPanel(panel)
      openWorkflowOverlay()
      const { stop } = startOrchestrator()
      const { input } = mountSearchModalLike()

      input.focus()
      const e = keyEvent('Tab')
      window.dispatchEvent(e)

      expect(document.activeElement, '焦点留在模态输入框（陷阱未把焦点拉回浮层面板）').toBe(input)
      expect(e.defaultPrevented, '编排器让位不消费——模态焦点域自行处理 Tab').toBe(false)
      stop()
    })

    it('对照半边（判别态）：同装配仅无模态叠加 → Tab 被陷阱拉回首元素', () => {
      const { panel, buttons } = makePanel(2)
      registerOverlayFocusTrapPanel(panel)
      openWorkflowOverlay()
      const { stop } = startOrchestrator()

      document.body.focus()
      window.dispatchEvent(keyEvent('Tab'))
      expect(document.activeElement, '无模态叠加时陷阱照常生效（防逃逸语义不回退）').toBe(buttons[0])
      stop()
    })

    it('让位解除：模态 Esc 关闭 + flush 翻新后 → Tab 陷阱恢复（属主动作时刻直读）', async () => {
      const { panel, buttons } = makePanel(2)
      registerOverlayFocusTrapPanel(panel)
      openWorkflowOverlay()
      const { stop } = startOrchestrator()
      const { input } = mountSearchModalLike()

      input.focus()
      window.dispatchEvent(keyEvent('Escape'))
      await nextTick()
      await nextTick()
      expect(containerStates().overlay, 'Esc#1 只关模态（编排器让位），浮层原样').toBe(true)

      input.focus()
      window.dispatchEvent(keyEvent('Tab'))
      expect(document.activeElement, '模态关后 Tab 陷阱恢复——拉回浮层面板首元素').toBe(buttons[0])
      stop()
    })
  })

  describe('叠开组合：Esc 递进（每次只关最上面一层）', () => {
    it('浮层 + 模态同开：Esc#1 关模态（浮层原样）→ Esc#2 关浮层', async () => {
      openWorkflowOverlay()
      const { stop } = startOrchestrator()
      mountSearchModalLike()

      window.dispatchEvent(keyEvent('Escape'))
      await nextTick()
      expect(containerStates(), 'Esc#1 编排器让位——模态自消费，浮层/抽屉原样')
        .toEqual({ overlay: true, bottom: false, right: false })

      window.dispatchEvent(keyEvent('Escape'))
      await nextTick()
      expect(containerStates(), 'Esc#2 模态已关——层级序剥浮层')
        .toEqual({ overlay: false, bottom: false, right: false })

      stop()
    })
  })
})

// ═══ 来源节：key-orchestrator/esc-stack-order.test.ts —— Esc 键序矩阵（固定层级序） ═══
describe('key-orchestrator/esc-stack-order', () => {
  beforeEach(() => {
    resetOrchestratorFixtures()
    bindTestSession()
  })

  afterEach(() => {
    resetOrchestratorFixtures()
    document.body.innerHTML = ''
  })

  function pressEsc(): KeyboardEvent {
    const e = keyEvent('Escape')
    window.dispatchEvent(e)
    return e
  }

  describe('Esc 键序矩阵（固定层级序：浮层 → 底抽屉 → 右抽屉）', () => {
    it('三容器全开：Esc 按 浮层 → 底抽屉 → 右抽屉 逐层剥（可证伪开序——与逆开序实现判别）', () => {
      // 开序刻意 ≠ 层级序：底抽屉 → 右抽屉 → 浮层（S3 判别态开序）
      openBottom()
      openRight()
      openWorkflowOverlay()
      const { stop } = startOrchestrator()

      expect(containerStates()).toEqual({ overlay: true, bottom: true, right: true })

      pressEsc()
      expect(containerStates(), '第一次 Esc 只关浮层').toEqual({ overlay: false, bottom: true, right: true })

      pressEsc()
      expect(containerStates(), '第二次 Esc 必须关底抽屉（层级序）而非右抽屉（逆开序）')
        .toEqual({ overlay: false, bottom: false, right: true })

      pressEsc()
      expect(containerStates(), '第三次 Esc 关右抽屉').toEqual({ overlay: false, bottom: false, right: false })
      stop()
    })

    it('浮层关态：Esc 先剥底抽屉再剥右抽屉（层级序不看开序——右抽屉先开也后关）', () => {
      openRight()
      openBottom()
      const { stop } = startOrchestrator()

      pressEsc()
      expect(containerStates(), '第一次 Esc 关底抽屉（层级序第二层）').toEqual({ overlay: false, bottom: false, right: true })
      pressEsc()
      expect(containerStates()).toEqual({ overlay: false, bottom: false, right: false })
      stop()
    })

    it('仅一层开：Esc 关该层 + preventDefault（消费即约定，下游可判 Esc 已被消费）', () => {
      openRight()
      const { stop } = startOrchestrator()

      const e = pressEsc()
      expect(e.defaultPrevented).toBe(true)
      expect(containerStates().right).toBe(false)
      stop()
    })

    it('全关态 Esc：不动作、不 preventDefault（无层可剥——不吞掉其它消费方的 Esc）', () => {
      const { stop } = startOrchestrator()
      const e = pressEsc()
      expect(e.defaultPrevented).toBe(false)
      expect(containerStates()).toEqual({ overlay: false, bottom: false, right: false })
      stop()
    })

    it('焦点契约（§6.7）：任一容器关闭后焦点回 composer', () => {
      // composer-box 真实 DOM（Composer.vue 同款 class + testid 双锚；内层 contenteditable 为聚焦目标）
      const box = document.createElement('div')
      box.className = 'composer-box'
      box.setAttribute('data-testid', 'composer-box')
      const input = document.createElement('div')
      input.setAttribute('contenteditable', 'true')
      box.appendChild(input)
      document.body.appendChild(box)

      openBottom()
      const { stop } = startOrchestrator()
      pressEsc()
      expect(containerStates().bottom).toBe(false)
      expect(document.activeElement, '关闭后焦点回 composer').toBe(input)
      stop()
    })
  })
})

// ═══ 来源节：useCloseShortcut.test.ts —— 容器快捷键 IPC 桥 → 编排器 ═══
describe('useCloseShortcut', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    unsubscribeCalled = false
    shortcutCallback = null
    resetOrchestratorFixtures()
    bindTestSession()
  })

  afterEach(() => {
    resetOrchestratorFixtures()
  })

  /** 在 effectScope 内调 composable（onScopeDispose 跟随 scope 退订） */
  function setupCloseShortcut(): { stop: () => void } {
    const scope = effectScope()
    scope.run(() => {
      useCloseShortcut()
    })
    return { stop: () => scope.stop() }
  }

  describe('useCloseShortcut（容器快捷键 IPC 桥 → 编排器）', () => {
    it('type=close（⌘W）：三容器全开 → 沿层级序逐层关，全关后才 windowClose', () => {
      openBottom()
      openRight()
      openWorkflowOverlay()
      const { stop } = setupCloseShortcut()

      shortcutCallback?.('close')
      expect(containerStates()).toEqual({ overlay: false, bottom: true, right: true })
      shortcutCallback?.('close')
      shortcutCallback?.('close')
      expect(containerStates()).toEqual({ overlay: false, bottom: false, right: false })
      expect(windowClose, '全关前不关窗').not.toHaveBeenCalled()

      shortcutCallback?.('close')
      expect(windowClose, '全关后再 close 才关窗').toHaveBeenCalledTimes(1)
      stop()
    })

    it('type=toggle-bottom-drawer（⌃`）：底抽屉开合切换（浮层开着照常切换）', () => {
      openWorkflowOverlay()
      const { stop } = setupCloseShortcut()

      shortcutCallback?.('toggle-bottom-drawer')
      expect(containerStates().bottom, '⌃` 开底抽屉（浮层开着也切）').toBe(true)
      shortcutCallback?.('toggle-bottom-drawer')
      expect(containerStates().bottom, '再按 ⌃` 收回').toBe(false)
      expect(windowClose).not.toHaveBeenCalled()
      stop()
    })

    it('type 非 close/toggle-bottom-drawer（globalShortcut 族）→ 不响应', () => {
      openRight()
      const { stop } = setupCloseShortcut()

      shortcutCallback?.('standard')
      shortcutCallback?.('focus')
      expect(containerStates().right, '其它 type 不动容器').toBe(true)
      expect(windowClose).not.toHaveBeenCalled()
      stop()
    })

    it('onScopeDispose 退订：scope 停止后再发 type 不响应', () => {
      openRight()
      const { stop } = setupCloseShortcut()
      stop()

      expect(unsubscribeCalled, '退订函数被调用').toBe(true)
      shortcutCallback?.('close')
      expect(containerStates().right, '退订后不再响应').toBe(true)
      expect(windowClose).not.toHaveBeenCalled()
    })
  })
})

// ═══ 来源节：key-orchestrator/modal-yield-event-order.test.ts —— 模态共存让位与聚合让位真实事件序 ═══
describe('key-orchestrator/modal-yield-event-order', () => {
  beforeEach(() => {
    resetOrchestratorFixtures()
    bindTestSession()
  })

  afterEach(() => {
    resetOrchestratorFixtures()
    document.body.innerHTML = ''
  })

  function pressEsc(): KeyboardEvent {
    const e = keyEvent('Escape')
    window.dispatchEvent(e)
    return e
  }

  describe('S8 模态共存（Esc 让位 + 让位递进）', () => {
    it('设置页开着：第一次 Esc 只关设置页（两抽屉原样）→ 第二次 Esc 才关底抽屉', async () => {
      // 设置页形态：挂载⇔开（注册随挂载）+ 自带 window 级 Esc 消费方（后行注册，SettingsModal
      // 同款：先检 defaultPrevented 再 preventDefault）
      const modalOpen = ref(true)
      const dismisses = ref(0)
      const SettingsLike = defineComponent({
        setup() {
          const dispose = registerModalSurface({
            surface: 'settings-modal',
            key: 's8-settings',
            isOpen: () => modalOpen.value,
          })
          onBeforeUnmount(dispose)
          const onEsc = (e: KeyboardEvent): void => {
            if (e.key !== 'Escape' || e.defaultPrevented) return
            e.preventDefault()
            dismisses.value += 1
            modalOpen.value = false
          }
          window.addEventListener('keydown', onEsc)
          onBeforeUnmount(() => window.removeEventListener('keydown', onEsc))
          return () => h('div', { 'data-testid': 's8-settings-like' }, 'settings')
        },
      })

      openBottom()
      openRight()
      const { stop } = startOrchestrator()
      const wrapper = mount(SettingsLike, { attachTo: document.body })
      await nextTick()

      pressEsc()
      await nextTick()
      expect(dismisses.value, '设置页自己的 Esc 消费方动作（视觉最外层）').toBe(1)
      expect(containerStates(), '两个抽屉原样不变（编排器让位检查）')
        .toEqual({ overlay: false, bottom: true, right: true })

      pressEsc()
      await nextTick()
      expect(containerStates(), '让位递进：设置关后第二次 Esc 按层级序关底抽屉')
        .toEqual({ overlay: false, bottom: false, right: true })

      wrapper.unmount()
      stop()
    })

    it('Toast 显示期（yieldsEsc ✗）：Esc 照常走层级序关容器（Toast 不消费 Esc）', () => {
      const dispose = registerModalSurface({
        surface: 'toast-container',
        key: 's8-toast',
        isOpen: () => true,
      })
      openRight()
      const { stop } = startOrchestrator()

      pressEsc()
      expect(containerStates().right, 'Toast 显示期 Esc 关右抽屉').toBe(false)
      stop()
      dispose()
    })

    it('defaultPrevented 先检：先行档消费方已消费的 Esc 不触发层级序', () => {
      openBottom()
      const { stop } = startOrchestrator()
      // 先行档（window capture，CommandPopover/AmbiguousFilePopover 形态）：消费即 preventDefault
      const firstTier = (e: KeyboardEvent): void => {
        if (e.key === 'Escape') e.preventDefault()
      }
      window.addEventListener('keydown', firstTier, true)

      pressEsc()
      expect(containerStates().bottom, '已消费的 Esc 不再剥层').toBe(true)

      window.removeEventListener('keydown', firstTier, true)
      stop()
    })
  })

  describe('S8/R4 聚合让位真实事件序（reka 弹出层族形态）', () => {
    it('第一次 Esc 让位（弹层还开着）→ dismiss + flush 注销 → 第二次 Esc 才走层级序', async () => {
      // 弹层成员：挂载⇔开（注册随挂载、注销随卸载——开合态翻新走 flush 的实装形态）；
      // 自带 dismiss 监听（后行注册，reka DismissableLayer 同款：只关自己、不 preventDefault）
      const surfaceOpen = ref(true)
      const dismisses = ref(0)
      const PopoverLike = defineComponent({
        setup() {
          const dispose = registerModalSurface({
            surface: 'popover-content',
            key: 'r4-popover',
            isOpen: () => true,
          })
          onBeforeUnmount(dispose)
          const onDismiss = (e: KeyboardEvent): void => {
            if (e.key !== 'Escape') return
            dismisses.value += 1
            surfaceOpen.value = false
          }
          window.addEventListener('keydown', onDismiss)
          onBeforeUnmount(() => window.removeEventListener('keydown', onDismiss))
          return () => h('div', { 'data-testid': 'r4-popover-like' }, 'popover')
        },
      })
      const PopoverHost = defineComponent({
        setup: () => () => (surfaceOpen.value ? h(PopoverLike) : null),
      })

      openBottom()
      // 编排器先注册（AppShell 根 setup 位次），FIFO 同相位先于弹层挂载后的任何监听
      const { stop } = startOrchestrator()
      const wrapper = mount(PopoverHost, { attachTo: document.body })
      await nextTick()

      pressEsc()
      await nextTick()
      expect(dismisses.value, '第一次 Esc 由弹层 dismiss 消费（视觉最外层有递进）').toBe(1)
      expect(containerStates().bottom, '编排器让位——底抽屉原样').toBe(true)

      // flush 翻新：弹层卸载 → 注册注销 → 聚合已是「弹层已关」的正确态
      await nextTick()
      await nextTick()

      pressEsc()
      await nextTick()
      expect(containerStates().bottom, '第二次 Esc 走层级序关底抽屉').toBe(false)

      wrapper.unmount()
      stop()
    })
  })
})

// ═══ 来源节：key-orchestrator/overlay-focus-trap.test.ts —— 浮层 Tab 焦点陷阱随迁保位 ═══
describe('key-orchestrator/overlay-focus-trap', () => {
  function makePanel(buttonCount: number): { panel: HTMLElement; buttons: HTMLElement[] } {
    const panel = document.createElement('div')
    panel.tabIndex = -1
    const buttons = Array.from({ length: buttonCount }, () => document.createElement('button'))
    panel.append(...buttons)
    document.body.appendChild(panel)
    return { panel, buttons }
  }

  beforeEach(() => {
    resetOrchestratorFixtures()
    bindTestSession()
  })

  afterEach(() => {
    resetOrchestratorFixtures()
    document.body.innerHTML = ''
  })

  describe('浮层 Tab 焦点陷阱（编排器浮层分支，§7.5 随迁保位）', () => {
    it('末元素 Tab 回首元素、首元素 Shift+Tab 到末元素（不逃逸到遮罩后背景 UI）', () => {
      const { panel, buttons } = makePanel(3)
      const [first, , last] = buttons
      openWorkflowOverlay()
      registerOverlayFocusTrapPanel(panel)
      const { stop } = startOrchestrator()

      last.focus()
      window.dispatchEvent(keyEvent('Tab'))
      expect(document.activeElement, '末元素 Tab 拉回首元素').toBe(first)

      window.dispatchEvent(keyEvent('Tab', { shiftKey: true }))
      expect(document.activeElement, '首元素 Shift+Tab 跳到末元素').toBe(last)
      stop()
    })

    it('焦点在面板外（Tab 进入）：拉回首元素；Shift+Tab 拉到末元素', () => {
      const { panel, buttons } = makePanel(2)
      const [first, last] = buttons
      openWorkflowOverlay()
      registerOverlayFocusTrapPanel(panel)
      const { stop } = startOrchestrator()

      document.body.focus()
      window.dispatchEvent(keyEvent('Tab'))
      expect(document.activeElement, '面板外 Tab 拉入面板首元素').toBe(first)

      document.body.focus()
      window.dispatchEvent(keyEvent('Tab', { shiftKey: true }))
      expect(document.activeElement, '面板外 Shift+Tab 拉入面板末元素').toBe(last)
      stop()
    })

    it('面板无可聚焦元素：preventDefault + 面板自身聚焦（安全默认焦点）', () => {
      const { panel } = makePanel(0)
      openWorkflowOverlay()
      registerOverlayFocusTrapPanel(panel)
      const { stop } = startOrchestrator()

      const e = keyEvent('Tab')
      window.dispatchEvent(e)
      expect(e.defaultPrevented, '无可聚焦候选时吞掉 Tab（防逃逸）').toBe(true)
      expect(document.activeElement).toBe(panel)
      stop()
    })

    it('浮层关态：Tab 零动作（不吞浏览器默认 Tab 行为）——编排器浮层分支门控', () => {
      const { panel } = makePanel(2)
      // 残留注册（面板未随关闭注销的防御场景）也因浮层关态不触发陷阱
      registerOverlayFocusTrapPanel(panel)
      const { stop } = startOrchestrator()

      const e = keyEvent('Tab')
      window.dispatchEvent(e)
      expect(e.defaultPrevented, '浮层关态 Tab 不被陷阱消费').toBe(false)
      stop()
    })

    it('面板注册/注销读点（overlay 宿主注入契约）：注册可读、注销回 null', () => {
      const { panel } = makePanel(1)
      registerOverlayFocusTrapPanel(panel)
      expect(getOverlayFocusTrapPanel()).toBe(panel)
      registerOverlayFocusTrapPanel(null)
      expect(getOverlayFocusTrapPanel()).toBe(null)
    })
  })
})
