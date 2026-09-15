/**
 * useBackgroundTasks 单测 —— 后台命令状态根（u-renderer-store 验收条款）。
 *
 * 覆盖（对照 impl-plan u-renderer-store 验收 + 探针 P6）：
 * - 拉取腿（C6）：mount 即拉、refresh 手动重拉、in-flight 去重、失败不降级；
 * - 广播腿：backgroundTask:updated → updateFor(capturedSid) 写「消息所属 sid」分区；
 * - 双 session updateFor 竞态（M1）：切 sid 后退订窗口内的旧 sid 迟到广播写旧分区，
 *   不污染新分区（结构性消除竞态的行为锚）；
 * - P6 分区：双实例双 session，publish(sid=A) 后断言 B 分区无变化；
 * - refCount：同 sid 多实例共享单条物理订阅（一实例卸载余者仍收广播）；
 * - session 销毁 cleanup：分区清空 + 迟到写入抑制（不僵尸式重建）。
 *
 * mock 边界：backgroundTask.list domain mock 掉（transport 层不在本层职责）；广播走真实
 * events.dispatchSession 通道。实现内无 timer，异步链用 setTimeout(0)+nextTick 排空
 * （不涉及 timer 语义，无需 fake timers）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/composables/use-background-tasks.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { defineComponent, h, ref, nextTick } from 'vue'
import { mount, type VueWrapper } from '@vue/test-utils'
import * as events from '@taiji/core/transport/api'
import {
  triggerSessionCleanups,
  __clearSessionCleanupRegistryForTest,
} from '@/composables/useSessionScopedState'
import {
  useBackgroundTasks,
  __resetBackgroundTasksForTest,
  __suppressedSidsForTest,
  type UseBackgroundTasksReturn,
} from '@/composables/features/sidebar/useBackgroundTasks'
import type { BackgroundTaskEntry } from '@/lib/background-task-bucket'

// ── mock 边界：list RPC mock 掉（composable 直接 import core domain 文件，偏差 #7 形态）──
const listMock = vi.hoisted(() => vi.fn())
vi.mock('@taiji/core/transport/api/domains/background-task', () => ({ list: listMock }))

// ── mock 边界：ws 连接态受控 ref（重连恢复腿驱动；默认 connected，既有用例零影响）──
const wsMock = vi.hoisted(() => ({ ref: null as null | { value: string } }))
vi.mock('@taiji/core/transport/ws-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@taiji/core/transport/ws-client')>()
  const { ref } = await import('vue')
  const stateRef = ref<string>('connected')
  wsMock.ref = stateRef
  return { ...actual, getState: () => stateRef }
})

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

// ── 拉取腿（C6 唯一真相入口）──

describe('拉取腿', () => {
  it('mount 即拉：immediate 恢复腿对当前 sid 发 list，resolve 后分区填充 + loaded', async () => {
    const host = mountHost('A')
    expect(listMock).toHaveBeenCalledWith('A')
    expect(host.tasks.current.value.loaded).toBe(false)
    resolveList('A', [task('t1', 'running')])
    await settle()
    expect(host.tasks.current.value.tasks).toHaveLength(1)
    expect(host.tasks.current.value.tasks[0].taskId).toBe('t1')
    expect(host.tasks.current.value.loaded).toBe(true)
  })

  it('切 sid 触发重拉：切到 B 后拉 B（切走期间广播已退订，缓存不可信）', async () => {
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
    await settle() // 排空 immediate 恢复腿的在途（此时 A 已有一条在途）
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
    // 切回 A：恢复腿无条件重拉（缓存过期不可信），旧缓存仍在 RPC 往返期显示
    expect(host.tasks.current.value.loaded).toBe(true)
    expect(host.tasks.current.value.tasks.map((t) => t.taskId)).toEqual(['t1'])
  })
})

// ── 广播腿 + 双 session updateFor 竞态（M1）+ P6 分区 ──

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

// ── session 销毁 cleanup + 迟到写入抑制 ──

describe('session 销毁 cleanup', () => {
  it('triggerSessionCleanups 清分区；迟到的 RPC resolve / 广播不把分区僵尸式写回', async () => {
    const host = mountHost('A')
    // 留一条在途 list（模拟销毁时 RPC 未 resolve）
    await nextTick()
    triggerSessionCleanups('A')
    await nextTick()
    expect(host.tasks.current.value.tasks).toEqual([]) // 分区已清（null/新默认实例）

    // 迟到广播：抑制表拦截，不重建分区
    dispatchUpdated('A', [task('ghost', 'running')])
    await nextTick()
    expect(host.tasks.current.value.tasks).toEqual([])

    // 迟到 RPC resolve：同样被抑制
    resolveList('A', [task('ghost-rpc', 'running')])
    await settle()
    expect(host.tasks.current.value.tasks).toEqual([])

    // 重新进入 = 新生命周期：抑制解除，恢复腿重拉
    host.sidRef.value = 'B'
    await nextTick()
    host.sidRef.value = 'A'
    await nextTick()
    expect(listMock).toHaveBeenLastCalledWith('A')
    resolveList('A', [task('fresh', 'running')])
    await settle()
    expect(host.tasks.current.value.tasks.map((t) => t.taskId)).toEqual(['fresh'])
  })

  it('BG-7（D6 #2）：抑制条目有界——物理订阅退订且在途 RPC settle 后自动移除（Set 只增不减修复）', async () => {
    const host = mountHost('A') // 挂载即在途 list（RPC 未 resolve）
    await nextTick()
    triggerSessionCleanups('A')
    await nextTick()
    expect(__suppressedSidsForTest()).toContain('A') // 销毁后抑制生效（上一用例语义）

    // 视图切走（deleteSession 编排）→ A 的物理广播订阅退订（refCount 归零）
    host.sidRef.value = 'B'
    await nextTick()
    resolveList('A', [task('late', 'running')]) // 在途 RPC settle：消费微任务内仍被抑制……
    await settle() // ……settle 的 macrotask 后抑制释放（迟到写入源全部枯竭）
    expect(__suppressedSidsForTest()).not.toContain('A')

    // 释放后无僵尸写回路径：无订阅则广播不投递，RPC 已 settle——分区保持清空
    expect(host.tasks.current.value.tasks).toEqual([])
  })

  it('BG-7 边界：订阅仍持有（实例未切走）时抑制不提前释放', async () => {
    const host = mountHost('A')
    await nextTick()
    triggerSessionCleanups('A')
    await nextTick()
    resolveList('A', [task('late', 'running')])
    await settle()
    // 实例仍聚焦 A（订阅活跃）→ 退订窗口内的迟到广播仍需抑制，条目保留
    expect(__suppressedSidsForTest()).toContain('A')
    dispatchUpdated('A', [task('ghost', 'running')])
    await nextTick()
    expect(host.tasks.current.value.tasks).toEqual([]) // 广播被抑制，无僵尸写回
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

  it('S6 重连恢复腿：ws disconnected→connected 边沿重拉当前 sid（非边沿不触发）', async () => {
    const host = mountHost('A')
    await settle()
    resolveList('A', [task('t1', 'running')])
    await settle()
    expect(listMock).toHaveBeenCalledTimes(1) // 挂载期仅拉取腿一次（watch 非 immediate）

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
