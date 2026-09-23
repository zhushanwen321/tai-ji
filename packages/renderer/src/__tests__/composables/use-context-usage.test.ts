/**
 * useContextUsage 单测 —— context-consistency Phase 2.3 层 1
 * （用例定义：context-consistency-equivalence-test §2 层 1）。
 *
 * 分两块：
 * 1. 定向用例 U1-U5（每条一个故障模式回归锚点）+ U1b（切 sid 竞态窗口，红蓝注入口）
 *    + G4 dev 漂移检测器三例；
 * 2. 属性测试：E1-E7 伪随机事件驱动（固定种子 42，自写 LCG，不引入 fast-check 依赖）
 *    × I1-I4 不变量逐步断言；oracle 维护「每个 sid 最后一次合法帧/RPC resolve 确定的
 *    期望值」对账（I1），与实现的三条 recency/抑制规则逐一对齐：
 *    - 合法帧到达当前订阅 sid → 写分区（全 0 帧 / 非订阅 sid / 被清理抑制 → no-op）；
 *    - RPC resolve → 发起后无合法帧落地且未被清理抑制时写分区，否则 no-op；
 *    - RPC 失败 → 分区不降级（oracle 不变）。
 *
 * mock 边界：session.getContext mock 掉（transport 层不在本层职责）；事件分发走真实
 * events.dispatchSession 通道（测 composable 对真实分发形态的响应）。
 *
 * 关于 fake timers：实现内无任何 timer（恢复腿去重靠 Promise 原语，非防抖），in-flight
 * 窗口用受控 deferred + setTimeout(0) macrotask 排空微任务链驱动，确定性等价且不引入
 * vi.waitFor 的 timer 依赖。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/composables/use-context-usage.test.ts
 * 禁止 node:test / tsx --test。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { defineComponent, h, ref, nextTick } from 'vue'
import { mount, type VueWrapper } from '@vue/test-utils'
import * as events from '@taiji/core/transport/api'
import {
  triggerSessionCleanups,
  __clearSessionCleanupRegistryForTest,
} from '@/composables/useSessionScopedState'
import {
  useContextUsage,
  __clearInFlightContextFetchForTest,
} from '@/composables/features/model/useContextUsage'
import type {
  UsagePartition,
  UseContextUsageReturn,
} from '@/composables/features/model/useContextUsage'

// ── mock 边界：getContext RPC mock 掉；门面 session 重指回 mock 的 domain ──
// vitest 注入 VITE_MOCK=true 使 '@/api' 门面默认指向 mock 门面，须重指才能与断言共用
// 同一 vi.fn（对齐 stores/workflow.test.ts 的「domain mock + 门面重指」双 mock 形态）。
const getContextMock = vi.hoisted(() => vi.fn())
vi.mock('@taiji/core/transport/api/domains/session', () => ({ getContext: getContextMock }))
vi.mock('@/api', async (importActual) => {
  const actual = await importActual<typeof import('@/api')>()
  const session = await import('@taiji/core/transport/api/domains/session')
  return { ...actual, session }
})

// ── 共享测试基建 ─────────────────────────────────────────────

const SIDS = ['A', 'B'] as const

/** getContext reply / context.update 载荷形状（D1：字段缺失 = 无值）。 */
interface CtxReply {
  sessionId: string
  inputTokens?: number
  contextLimit?: number
  usagePercent?: number
}

/** 分区可比较快照（未知态也归一为 4 字段）。 */
type Snap = { status: UsagePartition['status']; used: number; total: number; percent: number }

const UNKNOWN_SNAP: Snap = { status: 'unknown', used: 0, total: 0, percent: 0 }
const noValueSnap = (): Snap => ({ status: 'no-value', used: 0, total: 0, percent: 0 })

/** 在途 RPC 的受控 deferred（mock 发起时登记）。frameSeqAtIssue 见属性测试 oracle 注释。 */
interface PendingRpc {
  sid: string
  frameSeqAtIssue: number
  resolve: (v: CtxReply) => void
  reject: (e: unknown) => void
}

let pendingRpcs: PendingRpc[] = []
const mountedWrappers: VueWrapper[] = []

/**
 * 属性测试 oracle 的「合法帧 recency 序号」计数器（对齐实现内 liveFrameSeqs 语义：
 * 仅在合法帧到达 handler 时 bump；定向用例不读取）。由 mock 发起时捕获快照，
 * 作为 resolve 时 skip-write 的判定基准。
 */
const modelFrameSeq = new Map<string, number>()

interface HostHandle {
  sidRef: ReturnType<typeof ref<string | null>>
  usage: UseContextUsageReturn
}

/**
 * 测试宿主组件：在 setup 内调 useContextUsage（useSessionEvents 的 getCurrentInstance
 * 守卫要求组件 setup 上下文），expose 返回值（对齐 use-terminal.test.ts 形态）。
 */
function mountHost(initialSid: string | null): HostHandle {
  const sidRef = ref<string | null>(initialSid)
  const wrapper = mount(
    defineComponent({
      setup() {
        const usage = useContextUsage(sidRef)
        return { usage }
      },
      render: () => h('div'),
    }),
  )
  mountedWrappers.push(wrapper)
  // vm 属性经 test-utils 暴露为宽类型；断言前运行时守卫收缩（禁裸 as）
  const candidate = (wrapper.vm as { usage?: unknown }).usage
  if (!candidate || typeof candidate !== 'object' || !('current' in candidate)) {
    throw new Error('host 组件未暴露 usage')
  }
  const usage = candidate as UseContextUsageReturn
  if (typeof usage.current.value !== 'object' || usage.current.value === null) {
    throw new Error('usage.current 形状异常')
  }
  return { sidRef, usage }
}

/**
 * 排空在途异步链。setTimeout(0) 是 macrotask：事件循环保证其回调执行前，所有已排队
 * 微任务（promise 链：resolve → applyReply 写分区，以及 Vue 调度器 flush）全部跑完，
 * 一次即覆盖整条 in-flight 窗口链路。
 */
async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0))
  await nextTick()
}

/** resolve 指定 sid 的最早已登记在途 RPC（无则测试编排错误） */
function resolveForSid(sid: string, reply: CtxReply): void {
  const idx = pendingRpcs.findIndex((e) => e.sid === sid)
  if (idx < 0) throw new Error(`测试编排错误：sid ${sid} 无在途 RPC`)
  const [entry] = pendingRpcs.splice(idx, 1)
  entry.resolve(reply)
}

/** 读当前视图分区快照（独立副本，脱离 reactive 代理便于对账比较） */
function readSnap(host: HostHandle): Snap {
  const p = host.usage.current.value
  return { status: p.status, used: p.used, total: p.total, percent: p.percent }
}

// 真实 events.dispatchSession 通道派发帧
function dispatchOkFrame(sid: string, used: number, total: number, percent: number): void {
  events.dispatchSession(sid, {
    type: 'context.update',
    payload: { sessionId: sid, inputTokens: used, contextLimit: total, usagePercent: percent },
  })
}
function dispatchNoValueFrame(sid: string): void {
  events.dispatchSession(sid, { type: 'context.update', payload: { sessionId: sid } })
}
function dispatchAllZeroFrame(sid: string): void {
  events.dispatchSession(sid, {
    type: 'context.update',
    payload: { sessionId: sid, inputTokens: 0, contextLimit: 0, usagePercent: 0 },
  })
}

beforeEach(() => {
  pendingRpcs = []
  getContextMock.mockReset()
  getContextMock.mockImplementation(
    (sid: string) =>
      new Promise<CtxReply>((resolve, reject) => {
        pendingRpcs.push({ sid, frameSeqAtIssue: modelFrameSeq.get(sid) ?? 0, resolve, reject })
      }),
  )
  __clearSessionCleanupRegistryForTest()
  __clearInFlightContextFetchForTest()
})

afterEach(() => {
  while (mountedWrappers.length) mountedWrappers.pop()?.unmount()
})

// ── 定向用例（equivalence-test 子文档 §2 层 1 表格逐条）────────────

describe('定向用例 U1-U5', () => {
  it('U1: A 有值，订阅 B 期间 B 发 ok 帧，切回 A——A 分区仍为原值（P1 不串台）', async () => {
    const host = mountHost('A')
    await settle()
    resolveForSid('A', { sessionId: 'A', inputTokens: 21000, contextLimit: 600000, usagePercent: 3.5 })
    await settle()
    expect(readSnap(host)).toEqual({ status: 'ok', used: 21000, total: 600000, percent: 3.5 })

    // 切到 B（B 首拉在途不 resolve），B 的 ok 帧合法写入 B 分区
    host.sidRef.value = 'B'
    await settle()
    dispatchOkFrame('B', 120000, 300000, 40)
    await settle()
    expect(readSnap(host)).toEqual({ status: 'ok', used: 120000, total: 300000, percent: 40 })

    // 切回 A：重拉 RPC 在途，分区显示缓存初值——A 的数据不被 B 的帧污染、无闪横线
    host.sidRef.value = 'A'
    await settle()
    expect(readSnap(host)).toEqual({ status: 'ok', used: 21000, total: 600000, percent: 3.5 })
  })

  it('U1b: 切 sid 竞态窗口（watch 未 flush、旧订阅仍活跃）的迟到帧——写入所属 sid 分区，不污染新 sid（M1/ADR-0049）', async () => {
    const host = mountHost('A')
    await settle()
    resolveForSid('A', { sessionId: 'A', inputTokens: 1000, contextLimit: 100000, usagePercent: 1 })
    await settle()

    // 切到 B：ref 已变但 watch pre-flush 未跑，A 的 events.on 订阅仍活跃——此刻 A 的迟到帧
    // 同步到达 handler（捕获 sid=A）。updateFor(A) 应写 A 分区；若误用 update()（读实时
    // sid.value=B）则污染 B 分区（本用例即红蓝验证注入口）
    host.sidRef.value = 'B'
    dispatchOkFrame('A', 9000, 90000, 10)
    await settle()

    // B 分区不被污染：B 首拉在途未 resolve，应仍是 unknown
    expect(readSnap(host)).toEqual(UNKNOWN_SNAP)

    // 迟到帧合法落在 A 自己的分区（切回读取；重拉在途不覆盖）
    host.sidRef.value = 'A'
    await settle()
    expect(readSnap(host)).toEqual({ status: 'ok', used: 9000, total: 90000, percent: 10 })
  })

  it('U2: unknown 分区 resolve 无值 → no-value；再次切入无条件重拉；同视图停留不重复拉', async () => {
    const host = mountHost('A')
    await settle()
    // immediate 恢复腿已发起（在途），分区仍是 unknown 过渡态
    expect(getContextMock).toHaveBeenCalledTimes(1)
    expect(readSnap(host).status).toBe('unknown')

    resolveForSid('A', { sessionId: 'A' })
    await settle()
    expect(readSnap(host)).toEqual(noValueSnap())

    // 同视图停留（无切换无事件）不重复拉（resolve 即清条目，无新触发源）
    await settle()
    await settle()
    expect(getContextMock).toHaveBeenCalledTimes(1)

    // 再次切入同 sid 无条件重拉（no-value 也拉——切走期间后台 turn 可能产生新值）
    host.sidRef.value = 'B'
    await settle()
    host.sidRef.value = 'A'
    await settle()
    expect(getContextMock).toHaveBeenCalledTimes(3) // A 首拉 + B 首拉 + A 重拉

    resolveForSid('A', { sessionId: 'A', inputTokens: 500, contextLimit: 100000, usagePercent: 0.5 })
    await settle()
    expect(readSnap(host)).toEqual({ status: 'ok', used: 500, total: 100000, percent: 0.5 })
  })

  it('U3: 双实例（split panel）同时 watch 同 sid——getContext 只发一次（in-flight 去重），resolve 后两实例分区都更新', async () => {
    const host1 = mountHost('A')
    await settle()
    // 第二实例 setup 的 watch immediate 时第一实例 RPC 在途 → 复用同一 Promise
    const host2 = mountHost('A')
    await settle()
    expect(getContextMock).toHaveBeenCalledTimes(1)

    resolveForSid('A', { sessionId: 'A', inputTokens: 8000, contextLimit: 200000, usagePercent: 4 })
    await settle()
    // 存 Promise 本体（非回调）的收益：两个实例各自 attach 后各写各分区
    expect(readSnap(host1)).toEqual({ status: 'ok', used: 8000, total: 200000, percent: 4 })
    expect(readSnap(host2)).toEqual({ status: 'ok', used: 8000, total: 200000, percent: 4 })
  })

  it('U4: 全 0 帧到达已有 ok 值的分区——值不变 + console.warn（P3 + D4 哨兵）', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const host = mountHost('A')
    await settle()
    resolveForSid('A', { sessionId: 'A', inputTokens: 21000, contextLimit: 600000, usagePercent: 3.5 })
    await settle()

    dispatchAllZeroFrame('A')
    expect(readSnap(host)).toEqual({ status: 'ok', used: 21000, total: 600000, percent: 3.5 })
    expect(warnSpy).toHaveBeenCalledWith('[context-usage] dropping impossible all-zero frame', 'A')
    warnSpy.mockRestore()
  })

  it('U5: deleteSession（triggerSessionCleanups）——分区清理（I4），在途 RPC 迟到 resolve 不写回', async () => {
    const host = mountHost('A')
    await settle()
    resolveForSid('A', { sessionId: 'A', inputTokens: 1000, contextLimit: 100000, usagePercent: 1 })
    await settle()
    // 构造在途素材：切走再切回产生第二次 A 拉取（不 resolve）
    host.sidRef.value = 'B'
    await settle()
    host.sidRef.value = 'A'
    await settle()

    triggerSessionCleanups('A')
    resolveForSid('A', { sessionId: 'A', inputTokens: 99000, contextLimit: 100000, usagePercent: 99 })
    await settle()

    // 分区已清理 + 迟到 resolve 被抑制（updateFor 会重建分区形成僵尸条目，故须抑制）：
    // current 重新 init 为 unknown，不被 99000 污染
    expect(readSnap(host)).toEqual(UNKNOWN_SNAP)
  })

  it('U5b: 无值占位帧（仅含 sessionId）——写 no-value 分区，数值字段清零防陈旧值漏出', async () => {
    const host = mountHost('A')
    await settle()
    resolveForSid('A', { sessionId: 'A', inputTokens: 21000, contextLimit: 600000, usagePercent: 3.5 })
    await settle()

    dispatchNoValueFrame('A')
    expect(readSnap(host)).toEqual(noValueSnap())
  })
})

// ── G4 dev 漂移检测器（D5-G4 精确化口径的回归锚点）────────────

describe('G4 dev 漂移检测器（TAIJI_AGENT_DEBUG=1）', () => {
  beforeEach(() => {
    vi.stubEnv('TAIJI_AGENT_DEBUG', '1')
  })
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('分区值 ≠ reply 值且无 live 帧覆盖 → warn 带两值与 sid，随后分区收敛到 reply（自愈）', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const host = mountHost('A')
    await settle()
    resolveForSid('A', { sessionId: 'A', inputTokens: 21000, contextLimit: 600000, usagePercent: 3.5 })
    await settle()
    host.sidRef.value = 'B'
    await settle()
    host.sidRef.value = 'A'
    await settle()

    resolveForSid('A', { sessionId: 'A', inputTokens: 30000, contextLimit: 600000, usagePercent: 5 })
    await settle()

    expect(warnSpy).toHaveBeenCalledWith(
      '[context-usage] drift detected',
      expect.objectContaining({ sid: 'A' }),
    )
    expect(readSnap(host)).toEqual({ status: 'ok', used: 30000, total: 600000, percent: 5 })
    warnSpy.mockRestore()
  })

  it('RPC 发起后分区已被更新的 live 帧覆盖 → 跳过对账与写入（帧即真相，不误报、不回滚）', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const host = mountHost('A')
    await settle()
    resolveForSid('A', { sessionId: 'A', inputTokens: 21000, contextLimit: 600000, usagePercent: 3.5 })
    await settle()
    host.sidRef.value = 'B'
    await settle()
    host.sidRef.value = 'A'
    await settle() // 第二次 A 拉取在途

    // RPC 往返期间更新的 live 帧（帧值新于即将 resolve 的旧采样）
    dispatchOkFrame('A', 45000, 600000, 7.5)
    resolveForSid('A', { sessionId: 'A', inputTokens: 30000, contextLimit: 600000, usagePercent: 5 })
    await settle()

    expect(warnSpy).not.toHaveBeenCalledWith('[context-usage] drift detected', expect.anything())
    // 分区保持帧值，不被陈旧 reply 回滚
    expect(readSnap(host)).toEqual({ status: 'ok', used: 45000, total: 600000, percent: 7.5 })
    warnSpy.mockRestore()
  })

  it('分区从未有值（unknown）→ 跳过对账（首拉必经态，无漂移可言）', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const host = mountHost('A')
    await settle()

    resolveForSid('A', { sessionId: 'A', inputTokens: 100, contextLimit: 100000, usagePercent: 0.1 })
    await settle()

    expect(warnSpy).not.toHaveBeenCalledWith('[context-usage] drift detected', expect.anything())
    expect(readSnap(host)).toEqual({ status: 'ok', used: 100, total: 100000, percent: 0.1 })
    warnSpy.mockRestore()
  })
})

// ── 属性测试：E1-E7 驱动 × I1-I4 不变量（固定种子 42）────────────

describe('属性测试：E1-E7 × I1-I4（switch ≡ snapshot 层 1）', () => {
  it('500 步伪随机交错，每步全量不变量成立', async () => {
    // 静音实现侧诊断日志（E3 落地帧/E5 失败会逐步骤输出）
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {})

    // LCG（种子 42，子文档 §3：CI 可复现，不引入 fast-check）
    let seed = 42
    const rand = (): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
      return seed / 0x1_0000_0000
    }
    const pickSid = (): (typeof SIDS)[number] => SIDS[Math.floor(rand() * SIDS.length)]

    const randomOkSnap = (): Snap => {
      const used = 1 + Math.floor(rand() * 200000)
      const total = used + 1 + Math.floor(rand() * 100000) // total > used > 0，永非全 0
      const percent = 1 + Math.floor(rand() * 99)
      return { status: 'ok', used, total, percent }
    }
    const replyFromSnap = (sid: string, snap: Snap): CtxReply =>
      snap.status === 'ok'
        ? { sessionId: sid, inputTokens: snap.used, contextLimit: snap.total, usagePercent: snap.percent }
        : { sessionId: sid }

    // ── oracle 状态（与实现对齐规则见文件头注释）──
    const expected = new Map<string, Snap>() // I1：每 sid 最后一次合法帧/RPC resolve 确定的期望值
    const suppressed = new Set<string>() // E6 后至重新进入视图前，写入被抑制
    const everWritten = new Set<string>() // I2 前置：该 sid 自上次清理起是否有过成功写入
    let currentView: string = 'A'

    const host = mountHost('A')
    await settle()

    /** 派发合法帧（真实通道）并维护 oracle。raceWindow=true 模拟 E4 切换后 watch 未 flush
     *  的竞态窗口（旧订阅仍活跃，handler 捕获旧 sid，迟到帧合法写入所属分区）。 */
    const dispatchLegalFrame = (sid: string, snap: Snap, raceWindow = false): void => {
      if (snap.status === 'ok') {
        dispatchOkFrame(sid, snap.used, snap.total, snap.percent)
      } else {
        dispatchNoValueFrame(sid)
      }
      const subscribed = raceWindow || currentView === sid
      if (subscribed && !suppressed.has(sid)) {
        modelFrameSeq.set(sid, (modelFrameSeq.get(sid) ?? 0) + 1)
        expected.set(sid, snap)
        everWritten.add(sid)
      }
    }

    for (let step = 0; step < 500; step++) {
      const r = rand()
      if (r < 0.22) {
        // E1 收帧(ok 值)
        dispatchLegalFrame(pickSid(), randomOkSnap())
      } else if (r < 0.32) {
        // E2 收帧(无值占位)
        dispatchLegalFrame(pickSid(), noValueSnap())
      } else if (r < 0.4) {
        // E3 收帧(全 0)：防御纵深，oracle no-op（I3 经 sweep 对账覆盖）
        dispatchAllZeroFrame(pickSid())
      } else if (r < 0.65) {
        // E4 切换当前视图（含快速来回：连续步构成）；30% 概率同步派发旧 sid 迟到帧
        // （竞态窗口注入点——updateFor 误写为 update 时污染新分区，I1 红灯）
        const oldView = currentView
        const next = SIDS.find((s) => s !== oldView)
        if (next) {
          currentView = next
          host.sidRef.value = next
          suppressed.delete(next) // 重新进入视图 = 新生命周期（与实现 recover 对齐）
          if (rand() < 0.3) {
            dispatchLegalFrame(oldView, rand() < 0.7 ? randomOkSnap() : noValueSnap(), true)
          }
        }
      } else if (r < 0.9) {
        // E5 getContext RPC resolve（ok | 无值 | 失败）
        if (pendingRpcs.length > 0) {
          const idx = Math.floor(rand() * pendingRpcs.length)
          const entry = pendingRpcs.splice(idx, 1)[0]
          const outcome = rand()
          if (outcome < 0.15) {
            entry.reject(new Error('rpc-fail')) // 失败：分区缓存不降级 → oracle 不变
          } else {
            const snap = outcome < 0.75 ? randomOkSnap() : noValueSnap()
            entry.resolve(replyFromSnap(entry.sid, snap))
            // skip-write 对齐：发起（frameSeqAtIssue）后有合法帧落地 → 帧新于 reply，不写；
            // 被清理抑制 → 不写（防僵尸分区）
            const coveredByFrame = (modelFrameSeq.get(entry.sid) ?? 0) !== entry.frameSeqAtIssue
            if (!coveredByFrame && !suppressed.has(entry.sid)) {
              expected.set(entry.sid, snap)
              everWritten.add(entry.sid)
            }
          }
        }
      } else if (r < 0.95) {
        // E6 session 清理（deleteSession → triggerSessionCleanups，真实编排）
        const sid = pickSid()
        triggerSessionCleanups(sid)
        expected.delete(sid) // I4：分区不存在 → 下次读取必为重新 init 的 unknown
        everWritten.delete(sid)
        suppressed.add(sid)
      } else {
        // E7 断连重连：stateSnapshot last-value 经真实通道重派（仅当前订阅 sid 可达）
        for (const sid of SIDS) {
          dispatchLegalFrame(sid, rand() < 0.7 ? randomOkSnap() : noValueSnap())
        }
      }
      await settle()

      // I2：当前视图 sid 非 unknown——前提：非抑制、无在途（恢复腿必已 resolve/收帧）、
      // 且该 sid 自上次清理起曾有过成功写入（RPC 失败路径合法保持 unknown，不属违反）
      const pendingForView = pendingRpcs.some((e) => e.sid === currentView)
      if (!suppressed.has(currentView) && !pendingForView && everWritten.has(currentView)) {
        expect(readSnap(host).status).not.toBe('unknown')
      }

      // I1/I3/I4 全量对账 sweep：视图切换读取各 sid 分区（读取触发的恢复腿只发 RPC 不写
      // 分区，不扰动对账值）。expected 缺席 = 清理后/从未写入 → 必为 unknown（I4）；
      // E3 后 sweep 对账即 I3（全 0 帧若误写会偏离 expected）
      for (const sid of SIDS) {
        if (currentView !== sid) {
          currentView = sid
          host.sidRef.value = sid
          suppressed.delete(sid)
          await settle()
        }
        const p = readSnap(host)
        const exp = expected.get(sid)
        if (exp) {
          expect(p).toEqual(exp)
        } else {
          expect(p).toEqual(UNKNOWN_SNAP)
        }
      }
    }

    warnSpy.mockRestore()
    debugSpy.mockRestore()
  })
})
