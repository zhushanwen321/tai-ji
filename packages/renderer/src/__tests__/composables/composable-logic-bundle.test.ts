/**
 * 合并产物（round5-f S8，簇 3-10 拆对子集）。
 *
 * 来源四文件（describe/it 原样搬运）：use-context-usage（14 例）、useAccordionGuard
 * （14 例）、useToast.limiter（3 例，原 node 环境）、session-display-status（3 例，
 * 原 node 环境）——两 node 文件为纯逻辑，并入默认环境产物（波 1 迁移先例）。
 * mock 复筛已核：use-context-usage 的深路径 session 域 mock（仅 getContext）与
 * @/api spread 门面（helpers/session-context-mock，{...actual, session} 形态）不入
 * 其余三节链（AccordionGuard 仅 vue、sessionStatus 仅 type re-export、useToast 仅
 * vue + @taiji/shared）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { defineComponent, h, ref, nextTick } from 'vue'
import { mount, type VueWrapper } from '@vue/test-utils'
import { apiFacadeWithSessionDomain } from '../helpers/session-context-mock'
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
import { useAccordionGuard } from '@/composables/features/settings/useAccordionGuard'
import { useToast, setToastLimiter } from '@/composables/useToast'
import { UI_TOAST_LIMITS } from '@taiji/shared'
import { DISPLAY_STATUS, DOT_CLASS, isSessionCompleted } from '@/composables/logic/sessionStatus'
import type { SessionStatus } from '@taiji/shared'
// ═══ 来源：use-context-usage.test.ts ═══
// ── mock 边界：getContext RPC mock 掉；门面 session 重指回 mock 的 domain ──
// vitest 注入 VITE_MOCK=true 使 '@/api' 门面默认指向 mock 门面，须重指才能与断言共用
// 同一 vi.fn（「domain mock + 门面重指」双 mock 形态；重指工厂单源在
// helpers/session-context-mock.ts，与 stores/workflow.test.ts 范式同源）。
const getContextMock = vi.hoisted(() => vi.fn())
vi.mock('@taiji/core/transport/api/domains/session', () => ({ getContext: getContextMock }))
vi.mock('@/api', () => apiFacadeWithSessionDomain())

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

/** 在途 RPC 的受控 deferred（mock 发起时登记）。frameSeqAtIssue 见属性测试 最终裁决角色 注释。 */
interface PendingRpc {
  sid: string
  frameSeqAtIssue: number
  resolve: (v: CtxReply) => void
  reject: (e: unknown) => void
}

let pendingRpcs: PendingRpc[] = []
const mountedWrappers: VueWrapper[] = []

/**
 * 属性测试 最终裁决角色 的「合法帧 recency 序号」计数器（对齐实现内 liveFrameSeqs 语义：
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
 * 检查要求组件 setup 上下文），expose 返回值（对齐 use-terminal.test.ts 形态）。
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
  // vm 属性经 test-utils 暴露为宽类型；断言前运行时类型收窄（禁裸 as）
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

    // 切到 B（B 首次拉取在途不 resolve），B 的 ok 帧合法写入 B 分区
    host.sidRef.value = 'B'
    await settle()
    dispatchOkFrame('B', 120000, 300000, 40)
    await settle()
    expect(readSnap(host)).toEqual({ status: 'ok', used: 120000, total: 300000, percent: 40 })

    // 切回 A：重新拉取 RPC 在途，分区显示缓存初值——A 的数据不被 B 的帧污染、无闪横线
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

    // B 分区不被污染：B 首次拉取在途未 resolve，应仍是 unknown
    expect(readSnap(host)).toEqual(UNKNOWN_SNAP)

    // 迟到帧合法落在 A 自己的分区（切回读取；重新拉取在途不覆盖）
    host.sidRef.value = 'A'
    await settle()
    expect(readSnap(host)).toEqual({ status: 'ok', used: 9000, total: 90000, percent: 10 })
  })

  it('U2: unknown 分区 resolve 无值 → no-value；再次切入无条件重新拉取；同视图停留不重复拉', async () => {
    const host = mountHost('A')
    await settle()
    // immediate 恢复路径已发起（在途），分区仍是 unknown 过渡态
    expect(getContextMock).toHaveBeenCalledTimes(1)
    expect(readSnap(host).status).toBe('unknown')

    resolveForSid('A', { sessionId: 'A' })
    await settle()
    expect(readSnap(host)).toEqual(noValueSnap())

    // 同视图停留（无切换无事件）不重复拉（resolve 即清条目，无新触发源）
    await settle()
    await settle()
    expect(getContextMock).toHaveBeenCalledTimes(1)

    // 再次切入同 sid 无条件重新拉取（no-value 也拉——切走期间后台 turn 可能产生新值）
    host.sidRef.value = 'B'
    await settle()
    host.sidRef.value = 'A'
    await settle()
    expect(getContextMock).toHaveBeenCalledTimes(3) // A 首次拉取 + B 首次拉取 + A 重新拉取

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

  it('分区从未有值（unknown）→ 跳过对账（首次拉取必经态，无漂移可言）', async () => {
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

/**
 * 步数预算（覆盖旋钮，非语义常量）。
 *
 * 种子固定 42 → LCG 消费序列确定，因此「步数 = N」跑出的就是「步数 = 100」那条轨迹的
 * **前 N 步**：断言集合、每步随机取值与派发顺序逐位相同，只是截断在 N。
 * N = 25 的依据（种子 42 实测首现步号）：E2@0 / E4@1 / E5@2 / E1@5 / E7@15 / E3@22 /
 * E6@24——7 类事件各至少命中 1 次，全部首现落在 25 步内。用例内置「每类事件命中次数
 * ≥1」自检：未来若消费形态变化导致某类事件在 N 步内消失，自检立刻红灯（不静默丢分支），
 * 届时上调本常量或换种子。
 *
 * 26 步以后只增加同类型样本数、不增加事件类型覆盖——单步成本约 4ms（每步 3 个 sid 的
 * 视图切换 + 全量对账 sweep），100 步即 renderer 最长纯逻辑单例（实测 439ms）。
 * 竞态窗 / 清理抑制 / RPC 失败三族另有下方「定向补强」确定性用例锁死，不依赖采样运气。
 */
const PROPERTY_STEPS = 25

describe('属性测试：E1-E7 × I1-I4（switch ≡ snapshot 层 1）', () => {
  it('25 步伪随机交错（种子 42，前缀轨迹与 100 步版逐位相同），每步全量不变量成立', async () => {
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

    // ── 最终裁决角色 状态（与实现对齐规则见文件头注释）──
    const expected = new Map<string, Snap>() // I1：每 sid 最后一次合法帧/RPC resolve 确定的期望值
    const suppressed = new Set<string>() // E6 后至重新进入视图前，写入被抑制
    const everWritten = new Set<string>() // I2 前置：该 sid 自上次清理起是否有过成功写入
    let currentView: string = 'A'

    const host = mountHost('A')
    await settle()

    /** 事件类型命中计数（覆盖自检：步数预算缩小时防某类事件静默消失） */
    const eventHits = new Map<string, number>()
    const hit = (event: string): void => {
      eventHits.set(event, (eventHits.get(event) ?? 0) + 1)
    }

    /** 派发合法帧（真实通道）并维护 最终裁决角色。raceWindow=true 模拟 E4 切换后 watch 未 flush
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

    for (let step = 0; step < PROPERTY_STEPS; step++) {
      const r = rand()
      if (r < 0.22) {
        // E1 收帧(ok 值)
        hit('E1')
        dispatchLegalFrame(pickSid(), randomOkSnap())
      } else if (r < 0.32) {
        // E2 收帧(无值占位)
        hit('E2')
        dispatchLegalFrame(pickSid(), noValueSnap())
      } else if (r < 0.4) {
        // E3 收帧(全 0)：防御纵深，最终裁决角色 no-op（I3 经 sweep 对账覆盖）
        hit('E3')
        dispatchAllZeroFrame(pickSid())
      } else if (r < 0.65) {
        // E4 切换当前视图（含快速来回：连续步构成）；30% 概率同步派发旧 sid 迟到帧
        // （竞态窗口注入点——updateFor 误写为 update 时污染新分区，I1 红灯）
        hit('E4')
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
        hit('E5')
        if (pendingRpcs.length > 0) {
          const idx = Math.floor(rand() * pendingRpcs.length)
          const entry = pendingRpcs.splice(idx, 1)[0]
          const outcome = rand()
          if (outcome < 0.15) {
            entry.reject(new Error('rpc-fail')) // 失败：分区缓存不降级 → 最终裁决角色 不变
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
        hit('E6')
        const sid = pickSid()
        triggerSessionCleanups(sid)
        expected.delete(sid) // I4：分区不存在 → 下次读取必为重新 init 的 unknown
        everWritten.delete(sid)
        suppressed.add(sid)
      } else {
        // E7 断连重连：stateSnapshot last-value 经真实通道重派（仅当前订阅 sid 可达）
        hit('E7')
        for (const sid of SIDS) {
          dispatchLegalFrame(sid, rand() < 0.7 ? randomOkSnap() : noValueSnap())
        }
      }
      await settle()

      // I2：当前视图 sid 非 unknown——前提：非抑制、无在途（恢复路径必已 resolve/收帧）、
      // 且该 sid 自上次清理起曾有过成功写入（RPC 失败路径合法保持 unknown，不属违反）
      const pendingForView = pendingRpcs.some((e) => e.sid === currentView)
      if (!suppressed.has(currentView) && !pendingForView && everWritten.has(currentView)) {
        expect(readSnap(host).status).not.toBe('unknown')
      }

      // I1/I3/I4 全量对账 sweep：视图切换读取各 sid 分区（读取触发的恢复路径只发 RPC 不写
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

    // 覆盖自检：7 类事件在预算内各至少命中 1 次（防步数缩小后静默丢分支）
    expect([...eventHits.keys()].sort()).toEqual(['E1', 'E2', 'E3', 'E4', 'E5', 'E6', 'E7'])

    warnSpy.mockRestore()
    debugSpy.mockRestore()
  })
})

// ── 定向补强：属性测试随机采样外的确定性覆盖 ────────────────────
// 与 100 步属性测试互补：随机层（固定种子 42）前 100 步的采样分布中竞态窗（E4×0.3）
// 与清理（E6）各命中 12/6 次，但 RPC 失败（E5 的 15% 分支）零命中——三族语义各留一条
// 定向用例锁死，不依赖采样运气。
describe('定向补强：竞态窗口 / 清理抑制 / RPC 失败', () => {
  it('竞态窗口风暴：连续快速切换 + 每步旧 sid 迟到帧——帧只写所属 sid 分区，新 sid 恒不被污染', async () => {
    const host = mountHost('A')
    await settle()
    resolveForSid('A', { sessionId: 'A', inputTokens: 1000, contextLimit: 100000, usagePercent: 1 })
    await settle()
    host.sidRef.value = 'B'
    await settle()
    resolveForSid('B', { sessionId: 'B', inputTokens: 2000, contextLimit: 100000, usagePercent: 2 })
    await settle()

    const expected: Record<'A' | 'B', Snap> = {
      A: { status: 'ok', used: 1000, total: 100000, percent: 1 },
      B: { status: 'ok', used: 2000, total: 100000, percent: 2 },
    }
    for (let i = 0; i < 10; i++) {
      const from: 'A' | 'B' = (host.sidRef.value === 'B' ? 'B' : 'A')
      const to: 'A' | 'B' = from === 'A' ? 'B' : 'A'
      // 竞态窗口注入：ref 已变但 watch pre-flush 未跑，from 的订阅仍活跃——此刻同步派发
      // from 的迟到帧（updateFor 误写为 update 时污染 to 分区，本用例红灯）
      host.sidRef.value = to
      const frame: Snap = { status: 'ok', used: 3000 + i, total: 90000, percent: 3 }
      dispatchOkFrame(from, frame.used, frame.total, frame.percent)
      await settle()
      // 新 sid 分区不被污染（保持自己的最近合法值）
      expect(readSnap(host)).toEqual(expected[to])
      expected[from] = frame
      // 切回读取：迟到帧落在所属 sid 自己的分区（I1 对账）
      host.sidRef.value = from
      await settle()
      expect(readSnap(host)).toEqual(frame)
    }
  })

  it('清理抑制（帧面）：deleteSession 后到达的帧被拦截不复活分区；重新进入视图恢复路径重新拉取写入', async () => {
    const host = mountHost('A')
    await settle()
    resolveForSid('A', { sessionId: 'A', inputTokens: 5000, contextLimit: 100000, usagePercent: 5 })
    await settle()

    // 清理后帧到达（当前订阅 sid）：deletedSids 拦截（D-B2-1），分区不复活僵尸值
    triggerSessionCleanups('A')
    dispatchOkFrame('A', 6000, 100000, 6)
    await settle()
    expect(readSnap(host)).toEqual(UNKNOWN_SNAP)

    // 重新进入视图 = 新生命周期：恢复路径重新拉取 → resolve 写入新值
    host.sidRef.value = 'B'
    await settle()
    host.sidRef.value = 'A'
    await settle()
    resolveForSid('A', { sessionId: 'A', inputTokens: 7000, contextLimit: 100000, usagePercent: 7 })
    await settle()
    expect(readSnap(host)).toEqual({ status: 'ok', used: 7000, total: 100000, percent: 7 })
  })

  it('RPC 失败分区不降级（I5）：已有值 sid 的恢复拉取 reject → 缓存值保持；下次切入重新拉取自愈', async () => {
    // 静音实现侧失败诊断日志（reject 路径 console.debug）
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {})
    const host = mountHost('A')
    await settle()
    resolveForSid('A', { sessionId: 'A', inputTokens: 8000, contextLimit: 100000, usagePercent: 8 })
    await settle()

    // 切走再切回产生第二次拉取，reject：分区缓存不降级（unknown 回退 = 闪横线缺陷形态）
    host.sidRef.value = 'B'
    await settle()
    host.sidRef.value = 'A'
    await settle()
    const idx = pendingRpcs.findIndex((e) => e.sid === 'A')
    if (idx < 0) throw new Error('测试编排错误：sid A 无在途 RPC')
    pendingRpcs.splice(idx, 1)[0].reject(new Error('rpc-fail'))
    await settle()
    expect(readSnap(host)).toEqual({ status: 'ok', used: 8000, total: 100000, percent: 8 })

    // 下次切入无条件重新拉取：成功 resolve 写入新值（自愈）
    host.sidRef.value = 'B'
    await settle()
    host.sidRef.value = 'A'
    await settle()
    resolveForSid('A', { sessionId: 'A', inputTokens: 9000, contextLimit: 100000, usagePercent: 9 })
    await settle()
    expect(readSnap(host)).toEqual({ status: 'ok', used: 9000, total: 100000, percent: 9 })
    debugSpy.mockRestore()
  })
})

// ═══ 来源：useToast.limiter.test.ts（原 node 环境，pragma 已去除）═══
// ═══ 来源：useAccordionGuard.test.ts ═══

const ROWS = ['p1', 'p2'] as const
const NEW_ID = '__new__'
const NEW_BODY = `body-${NEW_ID}`
const NEW_ROW = `row-${NEW_ID}`

type Guard = ReturnType<typeof useAccordionGuard>

interface Host {
  wrapper: VueWrapper
  guard: Guard
}

const wrappers: VueWrapper[] = []

/** 挂载镜像 ProviderPage 绑定形态的宿主（render 函数读 ref.value 建立响应式依赖） */
function mountGuardHost(): Host {
  const holder: { guard?: Guard } = {}
  const wrapper = mount(
    defineComponent({
      name: 'AccordionGuardHost',
      setup() {
        const g = useAccordionGuard(NEW_ID)
        holder.guard = g
        return () => {
          const rows: VNode[] = []
          for (const id of [...ROWS, NEW_ID]) {
            rows.push(
              h(
                'span',
                {
                  key: `row-${id}`,
                  'data-testid': `row-${id}`,
                  role: 'button',
                  'aria-expanded': String(g.expandedId.value === id),
                  onClick: () => g.toggleExpand(id),
                },
                id,
              ),
            )
            if (g.expandedId.value === id) {
              const body: VNode[] = []
              if (g.currentBodyDirty.value) {
                body.push(h('span', { key: 'dirty', 'data-testid': `dirty-${id}` }))
              }
              rows.push(h('div', { key: `body-${id}`, 'data-testid': `body-${id}` }, body))
            }
          }
          const dialog = g.guardDialogOpen.value
            ? h('div', { 'data-testid': 'guard-dialog' }, [
                h('div', {
                  'data-testid': 'guard-confirm',
                  role: 'button',
                  onClick: () => g.confirmDiscard(),
                }),
                h('div', {
                  'data-testid': 'guard-cancel',
                  role: 'button',
                  // ConfirmDialog 取消：emit('update:open', false) → v-model set(false)
                  onClick: () => {
                    g.guardDialogOpen.value = false
                  },
                }),
              ])
            : h('span', { 'data-testid': 'guard-dialog-absent' })
          return h('div', [
            ...rows,
            h('div', { 'data-testid': 'add-btn', role: 'button', onClick: () => g.createAndExpand() }),
            h('div', { 'data-testid': 'dirty-on', role: 'button', onClick: () => g.onBodyDirtyChange(true) }),
            h('div', { 'data-testid': 'dirty-off', role: 'button', onClick: () => g.onBodyDirtyChange(false) }),
            h('div', { 'data-testid': 'save-btn', role: 'button', onClick: () => g.onBodySaved() }),
            h('div', { 'data-testid': 'cancel-btn', role: 'button', onClick: () => g.onBodyCancel() }),
            dialog,
          ])
        }
      },
    }),
  )
  wrappers.push(wrapper)
  const guard = holder.guard
  if (!guard) throw new Error('宿主组件未暴露 guard')
  return { wrapper, guard }
}

function sel(id: string): string {
  return `[data-testid="${id}"]`
}

function visible(host: Host, id: string): boolean {
  return host.wrapper.find(sel(id)).exists()
}

async function click(host: Host, id: string): Promise<void> {
  const el = host.wrapper.find(sel(id))
  if (!el.exists()) throw new Error(`未找到可点击元素 ${id}`)
  await el.trigger('click')
}

/** 展开 p1 并上抛 dirty（collapse/switch/add 三态的前置） */
async function expandP1Dirty(host: Host): Promise<void> {
  await click(host, 'row-p1')
  await click(host, 'dirty-on')
  expect(visible(host, 'dirty-p1')).toBe(true)
}

afterEach(() => {
  for (const w of wrappers) w.unmount()
  wrappers.length = 0
})

describe('useAccordionGuard（R4 展开检查状态机）', () => {
  describe('四态矩阵', () => {
    it('collapse：点已展开行 + dirty → 检查挂起且行未收起', async () => {
      const host = mountGuardHost()
      await expandP1Dirty(host)
      expect(visible(host, 'body-p1')).toBe(true)

      await click(host, 'row-p1')

      expect(visible(host, 'guard-dialog')).toBe(true)
      expect(host.guard.guardDialogOpen.value).toBe(true)
      // 未确认前不得收起：body 仍在、aria-expanded 仍为 true
      expect(visible(host, 'body-p1')).toBe(true)
      expect(host.wrapper.get(sel('row-p1')).attributes('aria-expanded')).toBe('true')
      // confirm 后落点=null 才是 collapse（与 switch 的区分见 confirmDiscard 三态用例）
      await click(host, 'guard-confirm')
      expect(host.guard.expandedId.value).toBeNull()
      expect(visible(host, 'body-p1')).toBe(false)
    })

    it('switch：点其他行 + dirty → 检查挂起，原展开行保持未切换', async () => {
      const host = mountGuardHost()
      await expandP1Dirty(host)

      await click(host, 'row-p2')

      expect(visible(host, 'guard-dialog')).toBe(true)
      expect(visible(host, 'body-p1')).toBe(true)
      expect(visible(host, 'body-p2')).toBe(false)
      expect(host.wrapper.get(sel('row-p2')).attributes('aria-expanded')).toBe('false')
      // confirm 后落点=p2 才是 switch
      await click(host, 'guard-confirm')
      expect(host.guard.expandedId.value).toBe('p2')
      expect(visible(host, 'body-p2')).toBe(true)
    })

    it('add：createAndExpand + dirty → 检查挂起，未进入新建态', async () => {
      const host = mountGuardHost()
      await expandP1Dirty(host)

      await click(host, 'add-btn')

      expect(visible(host, 'guard-dialog')).toBe(true)
      expect(visible(host, 'body-p1')).toBe(true)
      expect(visible(host, NEW_BODY)).toBe(false)
      // confirm 后落点=newId 才是 add
      await click(host, 'guard-confirm')
      expect(host.guard.expandedId.value).toBe(NEW_ID)
      expect(visible(host, NEW_BODY)).toBe(true)
    })

    it('none：无 dirty → 展开/收起/新建/切换均直达，不弹检查', async () => {
      const host = mountGuardHost()
      expect(host.guard.guardDialogOpen.value).toBe(false)
      expect(visible(host, 'guard-dialog-absent')).toBe(true)

      // 展开
      await click(host, 'row-p1')
      expect(visible(host, 'body-p1')).toBe(true)
      expect(visible(host, 'guard-dialog')).toBe(false)
      expect(host.guard.guardDialogOpen.value).toBe(false)

      // 无 dirty 切换
      await click(host, 'row-p2')
      expect(visible(host, 'body-p2')).toBe(true)
      expect(visible(host, 'body-p1')).toBe(false)
      expect(visible(host, 'guard-dialog')).toBe(false)

      // 无 dirty 收起
      await click(host, 'row-p2')
      expect(visible(host, 'body-p2')).toBe(false)
      expect(host.wrapper.get(sel('row-p2')).attributes('aria-expanded')).toBe('false')
      expect(visible(host, 'guard-dialog')).toBe(false)

      // 无 dirty 新建
      await click(host, 'add-btn')
      expect(visible(host, NEW_BODY)).toBe(true)
      expect(visible(host, 'guard-dialog')).toBe(false)
      expect(host.guard.guardDialogOpen.value).toBe(false)

      // 新建行同样可无检查收起
      await click(host, NEW_ROW)
      expect(visible(host, NEW_BODY)).toBe(false)
      expect(host.wrapper.get(sel(NEW_ROW)).attributes('aria-expanded')).toBe('false')
      expect(visible(host, 'guard-dialog')).toBe(false)
    })
  })

  describe('检查弹窗开合', () => {
    it('guardDialogOpen 与检查在途一一对应：三态挂起均开、无检查均关', async () => {
      const host = mountGuardHost()
      expect(host.guard.guardDialogOpen.value).toBe(false)
      expect(visible(host, 'guard-dialog')).toBe(false)

      await expandP1Dirty(host)

      // collapse 态挂起 → 开；取消（update:open false）→ 关且不执行动作、不动 dirty
      await click(host, 'row-p1')
      expect(host.guard.guardDialogOpen.value).toBe(true)
      expect(visible(host, 'guard-dialog')).toBe(true)
      await click(host, 'guard-cancel')
      expect(host.guard.guardDialogOpen.value).toBe(false)
      expect(visible(host, 'guard-dialog')).toBe(false)
      expect(visible(host, 'body-p1')).toBe(true)
      expect(visible(host, 'dirty-p1')).toBe(true)

      // switch 态挂起 → 开
      await click(host, 'row-p2')
      expect(host.guard.guardDialogOpen.value).toBe(true)
      expect(visible(host, 'guard-dialog')).toBe(true)
      await click(host, 'guard-cancel')
      expect(visible(host, 'guard-dialog')).toBe(false)

      // add 态挂起 → 开
      await click(host, 'add-btn')
      expect(host.guard.guardDialogOpen.value).toBe(true)
      expect(visible(host, 'guard-dialog')).toBe(true)
      await click(host, 'guard-cancel')
      expect(host.guard.guardDialogOpen.value).toBe(false)
      expect(visible(host, 'guard-dialog')).toBe(false)
    })
  })

  describe('confirmDiscard 三态行为', () => {
    it('收起态（pendingTarget=null）→ 确认后 expandedId=null 并清 dirty', async () => {
      const host = mountGuardHost()
      await expandP1Dirty(host)
      await click(host, 'row-p1')

      await click(host, 'guard-confirm')

      expect(host.guard.expandedId.value).toBeNull()
      expect(visible(host, 'body-p1')).toBe(false)
      expect(host.wrapper.get(sel('row-p1')).attributes('aria-expanded')).toBe('false')
      expect(visible(host, 'guard-dialog')).toBe(false)
      expect(host.guard.currentBodyDirty.value).toBe(false)
    })

    it('切换态（pendingTarget=string）→ 确认后 expandedId=目标 id 并清 dirty', async () => {
      const host = mountGuardHost()
      await expandP1Dirty(host)
      await click(host, 'row-p2')

      await click(host, 'guard-confirm')

      expect(host.guard.expandedId.value).toBe('p2')
      expect(visible(host, 'body-p2')).toBe(true)
      expect(visible(host, 'body-p1')).toBe(false)
      expect(host.wrapper.get(sel('row-p2')).attributes('aria-expanded')).toBe('true')
      expect(visible(host, 'guard-dialog')).toBe(false)
      expect(host.guard.currentBodyDirty.value).toBe(false)
    })

    it('新建态（pendingTarget=newId）→ 确认后进入新建态', async () => {
      const host = mountGuardHost()
      await expandP1Dirty(host)
      await click(host, 'add-btn')

      await click(host, 'guard-confirm')

      expect(host.guard.expandedId.value).toBe(NEW_ID)
      expect(visible(host, NEW_BODY)).toBe(true)
      expect(visible(host, 'body-p1')).toBe(false)
      expect(host.guard.currentBodyDirty.value).toBe(false)
    })

    it('无检查在途时直接调用（非法路径）→ 提前返回，不改任何状态', async () => {
      const host = mountGuardHost()
      await expandP1Dirty(host)

      host.guard.confirmDiscard()

      expect(host.guard.expandedId.value).toBe('p1')
      expect(host.guard.currentBodyDirty.value).toBe(true)
      expect(visible(host, 'body-p1')).toBe(true)
      expect(visible(host, 'dirty-p1')).toBe(true)
      expect(visible(host, 'guard-dialog')).toBe(false)
    })
  })

  describe('dirty 上抛对检查判定的影响', () => {
    it('同一动作：dirty=false 直达切换，dirty=true 被拦截', async () => {
      const host = mountGuardHost()

      // dirty=false：切到 p2 直达
      await click(host, 'row-p1')
      await click(host, 'row-p2')
      expect(visible(host, 'body-p2')).toBe(true)
      expect(visible(host, 'guard-dialog')).toBe(false)

      // 切回 p1 并上抛 dirty=true：同样的「切到 p2」被拦截
      await click(host, 'row-p1')
      await click(host, 'dirty-on')
      await click(host, 'row-p2')
      expect(visible(host, 'guard-dialog')).toBe(true)
      expect(visible(host, 'body-p2')).toBe(false)
    })

    it('dirty 取消上抛（dirty-change false）后，collapse 不再被拦截', async () => {
      const host = mountGuardHost()
      await expandP1Dirty(host)
      await click(host, 'row-p1')
      expect(visible(host, 'guard-dialog')).toBe(true)

      // 放弃检查（取消不动 dirty）→ dirty 仍 true，再点仍拦截
      await click(host, 'guard-cancel')
      await click(host, 'row-p1')
      expect(visible(host, 'guard-dialog')).toBe(true)
      await click(host, 'guard-cancel')

      // body 上抛 dirty=false → 同样点击直达收起
      await click(host, 'dirty-off')
      expect(visible(host, 'dirty-p1')).toBe(false)
      await click(host, 'row-p1')
      expect(visible(host, 'guard-dialog')).toBe(false)
      expect(visible(host, 'body-p1')).toBe(false)
      expect(host.guard.currentBodyDirty.value).toBe(false)
    })

    it('expandedId=null 时 dirty 不再拦截 createAndExpand（检查前置条件=当前有展开行）', async () => {
      const host = mountGuardHost()
      // 无展开行但 dirty=true（上抛残留）→ createAndExpand 直达
      await click(host, 'dirty-on')
      await click(host, 'add-btn')
      expect(visible(host, NEW_BODY)).toBe(true)
      expect(visible(host, 'guard-dialog')).toBe(false)
      expect(host.guard.guardDialogOpen.value).toBe(false)
    })
  })

  describe('ProviderEditBody 事件接入', () => {
    it('onBodyDirtyChange 上抛驱动 dirty 徽章与 currentBodyDirty', async () => {
      const host = mountGuardHost()
      await click(host, 'row-p1')
      expect(visible(host, 'dirty-p1')).toBe(false)
      await click(host, 'dirty-on')
      expect(visible(host, 'dirty-p1')).toBe(true)
      expect(host.guard.currentBodyDirty.value).toBe(true)
      await click(host, 'dirty-off')
      expect(visible(host, 'dirty-p1')).toBe(false)
      expect(host.guard.currentBodyDirty.value).toBe(false)
    })

    it('onBodySaved / onBodyCancel 均收起并清 dirty', async () => {
      const host = mountGuardHost()
      await expandP1Dirty(host)
      await click(host, 'save-btn')
      expect(host.guard.expandedId.value).toBeNull()
      expect(visible(host, 'body-p1')).toBe(false)
      expect(host.guard.currentBodyDirty.value).toBe(false)

      await expandP1Dirty(host)
      await click(host, 'cancel-btn')
      expect(host.guard.expandedId.value).toBeNull()
      expect(visible(host, 'body-p1')).toBe(false)
      expect(host.guard.currentBodyDirty.value).toBe(false)
    })
  })
})

// ═══ 来源：useToast.limiter.test.ts（原 node 环境，pragma 已去除）═══
describe('useToast 限流（D7 S3-W4 在列上限）', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    // useToast 是模块级单例状态：跑完残留 timer 清空 toasts，避免跨用例污染
    vi.runAllTimers()
    vi.useRealTimers()
  })

  it('在列达到 MAX_IN_FLIGHT 后新 toast 被丢弃：不入列 + droppedCount 递增 + warn 留痕', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { toasts, info, droppedCount } = useToast()
      const droppedBefore = droppedCount.value

      for (let i = 0; i < UI_TOAST_LIMITS.MAX_IN_FLIGHT; i++) info(`t${i}`)
      expect(toasts.value).toHaveLength(UI_TOAST_LIMITS.MAX_IN_FLIGHT)
      expect(droppedCount.value).toBe(droppedBefore) // 未达上限：零丢弃

      info('overflow') // 超限的第 N+1 条
      expect(toasts.value).toHaveLength(UI_TOAST_LIMITS.MAX_IN_FLIGHT) // 不入列
      expect(toasts.value.some((t) => t.message === 'overflow')).toBe(false)
      expect(droppedCount.value).toBe(droppedBefore + 1)
      expect(warnSpy).toHaveBeenCalledTimes(1) // 丢弃留痕（通知风暴排查证据）
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('droppedCount 连续丢弃累加；移除一条后新 toast 可再入列（限流基于在列数，累计计数不回落）', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { toasts, info, remove, droppedCount } = useToast()
      const droppedBefore = droppedCount.value

      for (let i = 0; i < UI_TOAST_LIMITS.MAX_IN_FLIGHT; i++) info(`t${i}`)
      info('drop-1')
      info('drop-2')
      expect(droppedCount.value).toBe(droppedBefore + 2)
      expect(toasts.value).toHaveLength(UI_TOAST_LIMITS.MAX_IN_FLIGHT)

      remove(toasts.value[0].id) // 腾出 1 个在列空位
      info('fits-now')
      expect(toasts.value.some((t) => t.message === 'fits-now')).toBe(true) // 可再入列
      expect(toasts.value).toHaveLength(UI_TOAST_LIMITS.MAX_IN_FLIGHT)
      expect(droppedCount.value).toBe(droppedBefore + 2) // 累计计数不回落
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('setToastLimiter 注入恒丢弃策略同样走 droppedCount 计数；传 null 恢复默认放行', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { toasts, info, droppedCount } = useToast()
      const droppedBefore = droppedCount.value

      setToastLimiter(() => true)
      info('always-dropped')
      expect(toasts.value).toHaveLength(0)
      expect(droppedCount.value).toBe(droppedBefore + 1) // 注入策略与默认共用丢弃计数路径

      setToastLimiter(null) // 恢复默认限流
      info('passes-again')
      expect(toasts.value.some((t) => t.message === 'passes-again')).toBe(true)
    } finally {
      warnSpy.mockRestore()
    }
  })
})

// ═══ 来源：session-display-status.test.ts（原 node 环境，pragma 已去除）═══
describe('U-B: DISPLAY_STATUS / isSessionCompleted 判据 SSOT', () => {
  it('DISPLAY_STATUS 覆盖 SessionStatus 全部六态', () => {
    const statuses: SessionStatus[] = ['active', 'idle', 'done', 'error', 'stopped', 'dead']
    for (const s of statuses) {
      expect(DISPLAY_STATUS[s]).toBeDefined()
    }
    expect(Object.keys(DISPLAY_STATUS).sort()).toEqual([...statuses].sort())
  })

  it('isSessionCompleted：仅 {idle, done} 为「运行已完成」（绿点），其余四态均未完成', () => {
    // 绿点 ⟺ DISPLAY_STATUS → 'done' ⟺ DOT_CLASS = bg-success
    expect(isSessionCompleted('idle')).toBe(true)
    expect(isSessionCompleted('done')).toBe(true)
    expect(isSessionCompleted('active')).toBe(false)
    expect(isSessionCompleted('error')).toBe(false)
    expect(isSessionCompleted('stopped')).toBe(false)
    expect(isSessionCompleted('dead')).toBe(false)
  })

  it('判据与绿点色语言同源：completed 的 DISPLAY_STATUS 必落到 DOT_CLASS.success', () => {
    const statuses: SessionStatus[] = ['active', 'idle', 'done', 'error', 'stopped', 'dead']
    for (const s of statuses) {
      const isGreen = DOT_CLASS[DISPLAY_STATUS[s]] === 'bg-success'
      expect(isSessionCompleted(s)).toBe(isGreen)
    }
  })
})
