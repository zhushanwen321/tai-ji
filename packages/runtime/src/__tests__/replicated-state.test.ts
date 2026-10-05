/**
 * ReplicatedState<T> 单元测试（data-source-governance W6）。
 *
 * 验收对照（.taiji-harness/2026-08-19-data-source-governance-p1p4/acceptance/w6-acceptance.md）：
 * - 用例 1 失效不直接写值：markDirty 后防抖窗口内 get() 返回旧值
 *   → describe「失效与防抖」it 1（含设计约束断言：事件到达后立即读值为旧快照）
 * - 用例 3 空值覆盖语义（sessionName undefined 覆盖旧名，D1b 反例回归）
 *   → describe「D1b 合并规则」it 1（含设计约束断言：快照含显式空值覆盖非空旧值）
 * - 用例 4 wire 归一（key 缺失按登记语义处理）→ describe「D1b 合并规则」it 2 / it 3
 * - 用例 5 pollIntervalMs 周期兜底（配置启动、未配置不启动定时器）
 *   → describe「周期兜底」it 1 / it 2
 * - 用例 7 refetch 全量重拉语义 → describe「refetch / dispose」it 1
 * - 补充：在途失效不丢（epoch 守卫）、防抖聚合、dispose 生命周期
 *
 * 项目规范：fake timers（vi.useFakeTimers + advanceTimersByTimeAsync），禁真实 sleep。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  ReplicatedState,
  ownerSnapshotMerge,
  normalizeWireSnapshot,
  WireSnapshotSchemaError,
  type FieldsNullSemantics,
} from '../services/session/replicated-state.js'

/** 测试用标量 session 状态形态（label / thinkingLevel / modelId 三类目标实例的最小投影）。 */
interface SessionState {
  sessionName?: string
  thinkingLevel?: string
  modelId?: string
}

type FetchMock = ReturnType<typeof vi.fn<() => Promise<SessionState>>>

/** 防抖窗口（ms）。取小值缩短用例时间轴，语义与生产配置一致。 */
const DEBOUNCE_MS = 100

/**
 * 模拟 JSON wire 序列化：值为 undefined 的 key 被丢弃。
 * 真实 RPC 链路（pi get_state 等）经 JSON 序列化后「显式空值」即退化为「key 缺失」。
 */
function toWire(value: SessionState): SessionState {
  const wire: SessionState = JSON.parse(JSON.stringify(value))
  return wire
}

function createState(
  options: { fieldsNullSemantics?: FieldsNullSemantics; pollIntervalMs?: number; diagnosticLabel?: string } = {},
): { rs: ReplicatedState<SessionState>; fetch: FetchMock } {
  const fetch = vi.fn<() => Promise<SessionState>>()
  const rs = new ReplicatedState<SessionState>({
    fetchSnapshot: fetch,
    debounceMs: DEBOUNCE_MS,
    pollIntervalMs: options.pollIntervalMs,
    diagnosticLabel: options.diagnosticLabel,
    merge: ownerSnapshotMerge,
    fieldsNullSemantics: options.fieldsNullSemantics ?? { sessionName: 'explicit-null' },
  })
  return { rs, fetch }
}

/** 播种初始快照：refetch 立即拉取一次并应用（绕过防抖）。 */
async function seedSnapshot(
  rs: ReplicatedState<SessionState>,
  fetch: FetchMock,
  value: SessionState,
): Promise<void> {
  fetch.mockResolvedValue(value)
  rs.refetch()
  await vi.advanceTimersByTimeAsync(1)
}

describe('ReplicatedState', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('失效与防抖', () => {
    it('失效不直接写值：事件到达后立即读值为旧快照，防抖窗口内不拉取，窗口到点才应用新值', async () => {
      const { rs, fetch } = createState()
      await seedSnapshot(rs, fetch, { sessionName: '旧名', thinkingLevel: 'high' })
      fetch.mockResolvedValue({ sessionName: '新名', thinkingLevel: 'high' }) // 底层权威值已变更

      rs.markDirty() // 失效事件到达（唯一允许的动作：置 dirty，不写数据）
      // 设计约束断言（验收 3）：事件到达后立即读值 = 旧快照——防退化为「事件直写」
      expect(rs.get()).toEqual({ sessionName: '旧名', thinkingLevel: 'high' })
      expect(fetch).toHaveBeenCalledTimes(1) // 防抖窗口内未发起拉取
      expect(rs.isDirty()).toBe(true)

      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS - 1)
      expect(rs.get()).toEqual({ sessionName: '旧名', thinkingLevel: 'high' }) // 窗口内仍旧值
      expect(fetch).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(1)
      expect(fetch).toHaveBeenCalledTimes(2) // 防抖到点，拉取权威快照
      expect(rs.get()).toEqual({ sessionName: '新名', thinkingLevel: 'high' }) // 唯一写路径
      expect(rs.isDirty()).toBe(false)
    })

    it('防抖聚合：窗口内重复 markDirty 重置窗口，只触发一次拉取', async () => {
      const { rs, fetch } = createState()
      await seedSnapshot(rs, fetch, { sessionName: 'A' })
      fetch.mockResolvedValue({ sessionName: 'B' })

      rs.markDirty()
      await vi.advanceTimersByTimeAsync(40)
      rs.markDirty() // 第二次失效：重置防抖窗口
      await vi.advanceTimersByTimeAsync(60) // 距第二次 markDirty 仅 60ms < 100ms
      expect(fetch).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(40) // 距第二次 markDirty 满窗口
      expect(fetch).toHaveBeenCalledTimes(2)
      expect(rs.get()).toEqual({ sessionName: 'B' })
    })
  })

  describe('D1b 合并规则（空值语义）', () => {
    it('空值覆盖：wire 快照 sessionName undefined（key 缺失）覆盖非空旧名（D1b 反例回归）', async () => {
      const { rs, fetch } = createState({ fieldsNullSemantics: { sessionName: 'explicit-null' } })
      await seedSnapshot(rs, fetch, { sessionName: '旧名', thinkingLevel: 'high' })
      // 权威源 sessionName 变为 undefined（未命名 session 是合法态），JSON wire 丢 key
      fetch.mockResolvedValue(toWire({ sessionName: undefined, thinkingLevel: 'high' }))

      rs.markDirty()
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)

      // 设计约束断言（验收 3）：快照含显式空值覆盖非空旧值——若 wire 归一缺失，
      // key 缺失会被当「字段不动」，旧名永久残留 = 影子状态复活
      expect(rs.get()?.sessionName).toBeUndefined()
      expect(rs.get()).toEqual({ thinkingLevel: 'high' })
      expect(rs.isDirty()).toBe(false)
    })

    it('未登记字段 key 缺失 = 不在本快照域内，保持当前值', async () => {
      const { rs, fetch } = createState({ fieldsNullSemantics: { sessionName: 'explicit-null' } })
      await seedSnapshot(rs, fetch, { sessionName: '名', thinkingLevel: 'high', modelId: 'm-1' })

      fetch.mockResolvedValue({ sessionName: '新名' }) // thinkingLevel / modelId key 缺失且未登记
      rs.markDirty()
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
      expect(rs.get()).toEqual({ sessionName: '新名', thinkingLevel: 'high', modelId: 'm-1' })
    })
  })

  describe('周期兜底', () => {
    it('pollIntervalMs 配置后：周期定时器启动，到点无条件重拉（无失效也拉）', async () => {
      const { rs, fetch } = createState({ pollIntervalMs: 30_000 })
      expect(vi.getTimerCount()).toBe(1) // 周期定时器已启动

      fetch.mockResolvedValue({ sessionName: 'P1' })
      await vi.advanceTimersByTimeAsync(30_000)
      expect(fetch).toHaveBeenCalledTimes(1) // 无任何 markDirty 也发生了拉取
      expect(rs.get()).toEqual({ sessionName: 'P1' })

      fetch.mockResolvedValue({ sessionName: 'P2' })
      await vi.advanceTimersByTimeAsync(30_000)
      expect(fetch).toHaveBeenCalledTimes(2) // 周期持续
      expect(rs.get()).toEqual({ sessionName: 'P2' })
      expect(rs.isDirty()).toBe(false)

      rs.dispose()
      expect(vi.getTimerCount()).toBe(0)
    })

    it('pollIntervalMs 未配置：不启动周期定时器，长时段无拉取', async () => {
      const { rs, fetch } = createState()
      expect(vi.getTimerCount()).toBe(0) // 构造后零定时器（默认关闭）

      await vi.advanceTimersByTimeAsync(120_000)
      expect(fetch).not.toHaveBeenCalled()
    })
  })

  describe('refetch / dispose', () => {
    it('refetch 全量重拉：绕过防抖立即发起，应用完整快照', async () => {
      const { rs, fetch } = createState()
      await seedSnapshot(rs, fetch, { sessionName: 'A', modelId: 'm-1' })
      fetch.mockResolvedValue({ sessionName: 'B', modelId: 'm-2' })

      rs.refetch()
      expect(fetch).toHaveBeenCalledTimes(2) // 同步立即发起（不等防抖窗口）
      await vi.advanceTimersByTimeAsync(1)
      expect(rs.get()).toEqual({ sessionName: 'B', modelId: 'm-2' }) // 整快照覆盖
      expect(rs.isDirty()).toBe(false)
      expect(vi.getTimerCount()).toBe(0) // 未排任何防抖/退避定时器
    })

    it('dispose：清理全部定时器，此后失效/重连/周期均不再拉取', async () => {
      const { rs, fetch } = createState({ pollIntervalMs: 30_000 })
      fetch.mockResolvedValue({ sessionName: 'A' })
      await vi.advanceTimersByTimeAsync(30_000)
      expect(fetch).toHaveBeenCalledTimes(1)

      rs.dispose()
      expect(vi.getTimerCount()).toBe(0) // 周期定时器已清理

      rs.markDirty()
      expect(vi.getTimerCount()).toBe(0) // 失效不再挂防抖定时器
      expect(rs.isDirty()).toBe(false) // 实例已退役：markDirty 全 no-op（不置 dirty）

      rs.refetch()
      expect(fetch).toHaveBeenCalledTimes(1) // 重连兜底不再拉取
      await vi.advanceTimersByTimeAsync(120_000)
      expect(fetch).toHaveBeenCalledTimes(1)
    })

    it('dispose 后在途 fetch 的迟到失败：静默丢弃（无失败 warn、不排退避定时器）', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      try {
        const { rs, fetch } = createState({ diagnosticLabel: 'usage(sx)' })
        let rejectFetch!: (e: unknown) => void
        fetch.mockImplementationOnce(
          () =>
            new Promise<SessionState>((_, reject) => {
              rejectFetch = reject
            }),
        )

        rs.refetch() // fetch 在途（挂起未决，dispose 无法取消）
        rs.dispose()
        expect(vi.getTimerCount()).toBe(0)

        rejectFetch(new Error('late rpc down')) // dispose 之后在途 promise 才失败
        await vi.advanceTimersByTimeAsync(60_000)

        expect(warn).not.toHaveBeenCalled() // 迟到失败不落 warn（防 vitest worker 关闭窗口竞争）
        expect(vi.getTimerCount()).toBe(0) // 也不排退避重试定时器
      } finally {
        warn.mockRestore()
      }
    })
  })

  describe('在途失效不丢（epoch 守卫）', () => {
    it('fetch 在途期间 markDirty：本次成功快照不清 dirty，防抖定时器仍触发补拉', async () => {
      const { rs, fetch } = createState()
      let resolveFetch!: (value: SessionState) => void
      fetch.mockImplementationOnce(
        () =>
          new Promise<SessionState>((resolve) => {
            resolveFetch = resolve
          }),
      )

      rs.refetch() // 拉取发起（在途，未决）
      rs.markDirty() // 失效事件在在途期间到达
      resolveFetch({ sessionName: 'stale' }) // 在途快照是失效前的旧数据
      await vi.advanceTimersByTimeAsync(1)

      expect(rs.get()).toEqual({ sessionName: 'stale' }) // 在途快照仍应用（优于无快照）
      expect(rs.isDirty()).toBe(true) // 但 dirty 不被吞：在途失效仍待补拉

      fetch.mockResolvedValue({ sessionName: 'fresh' })
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS) // markDirty 挂的防抖定时器未被撤销
      expect(fetch).toHaveBeenCalledTimes(2)
      expect(rs.get()).toEqual({ sessionName: 'fresh' })
      expect(rs.isDirty()).toBe(false)
    })
  })
})

describe('normalizeWireSnapshot（纯函数）', () => {
  it('声明了字段空值语义但快照非对象 = 协议异常', () => {
    expect(() =>
      normalizeWireSnapshot<string>('scalar', { sessionName: 'explicit-null' }),
    ).toThrow(WireSnapshotSchemaError)
  })
})
