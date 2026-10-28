/**
 * 域同步器单测（connection-datasync-ssot §6.4；impl-plan u4 验收条款 1-3 的机制载体）。
 *
 * 受控 promise（gate deferred）注入 sync，确定性构造回执到达时序，覆盖：
 * - 并发合流单飞 + trailing 补拉：同域在途时再触发（边沿 / requestDomainSync）不重复
 *   发但登记 trailing 标志，回执成功落定后补拉一轮收敛（验收 1；dmg-r3-1 多窗口形态：
 *   失效信号在 load 在途窗口被跳过、在途回执为命令前旧快照且双判旧不命中 → 补拉收敛
 *   到命令后状态）
 * - 仅最新代提交：旧连接代回执丢弃 + 丢弃点补发收敛；拦截型 apply 不被旧代触达（验收 2）
 * - 命令×同步交错（project 域）：命令回执先于在途 load 回执到达 → 旧 revision 回执判旧
 *   丢弃（不回滚）+ 补发轮收敛（验收 3）
 * - 交错判旧资格基线（dmg-r2-1）：命令回执提交后 runtime revision 回退（崩溃重启形态）
 *   → 低于基线的回执不判旧直接 apply 重置水位，有限轮收敛（无无限补发死锁）；
 *   判旧丢弃点日志留痕（可观测性）
 * - 首次落定 promise：成功与失败均落定；whenSettled ensure 语义（首轮未发起时由等待方
 *   发起）；后续边沿不改变已落定 promise
 * - whenToSync 谓词门控 / 辅助刷新边沿触发与兜底 catch / 未登记 id 的 fail-fast 与 warn
 *
 * 运行：pnpm -C packages/core exec vitest run src/transport/connection-edge-sync（exec-plan u4 testCommand 过滤器按此路径圈定；与源文件同目录放置）
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  registerDataDomain,
  registerAuxiliaryRefresh,
  notifyConnectedEdge,
  requestDomainSync,
  whenSettled,
  resetConnectionEdgeSyncForTest,
} from './connection-edge-sync'

/** 受控 promise：测试手动放行，构造「命令回执先于在途 load 回执」等确定性时序。 */
function createGate<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** 排空微任务队列（sync().then 回调与补发链的就绪等待）。 */
async function flushMicrotasks(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

/** 提交簿记（拦截型 fake store）：记录每次 apply 的回执序号，可断言「旧代不提交」。 */
function createReceiptLog<T>(): { applied: T[]; apply: (receipt: T) => void } {
  const applied: T[] = []
  return { applied, apply: (receipt: T) => void applied.push(receipt) }
}

/**
 * 带重入守卫的 fake project store（集成形态，镜像 renderer stores/project.ts 的 sync
 * 接线面）：loadState 状态机 + 「loading 态 sync 重入守卫」+「残留 loading 收尾（放弃
 * 在途）」+ 判旧资格基线（syncStartRevision，dmg-r2-1：判旧只比对基线之上由命令回执
 * 推进的超前水位，低于基线 = 服务端回退形态不判旧）。无守卫的 fake 检不出死锁形态
 * （补发轮撞守卫被拒 → 在途状态永久卡 loading，F1-27 正是经此缺口全绿放行）；无基线
 * 的 fake 检不出幻影水位死锁（dmg-r2-1）——「带重入守卫的 store 集成形态」与「交错
 * 判旧资格基线」两节共用本 helper。
 */
type FakeReceipt = { revision: number; data: string }
type FakeLoadState = 'idle' | 'loading' | 'loaded'
function createGuardedProjectStore(rpc: () => Promise<FakeReceipt>) {
  const store = {
    loadState: 'idle' as FakeLoadState,
    stateBeforeLoading: 'idle' as FakeLoadState,
    revision: null as number | null,
    syncStartRevision: null as number | null,
    data: '',
    rpcPending: false,
  }
  const sync = vi.fn(async (): Promise<FakeReceipt> => {
    if (store.loadState === 'loading') {
      if (store.rpcPending) {
        throw new Error(
          '[project-store] syncLoad re-entered while loading — load attempts must go through connection-edge-sync coalescing (requestDomainSync)',
        )
      }
      // 残留 loading（上一轮回执被判旧丢弃，本 store 的 RPC 已落定）：放弃在途回滚
      // 到发起前状态再重拉——镜像 stores/project.ts syncLoad 的收尾形态
      store.loadState = store.stateBeforeLoading
    }
    store.stateBeforeLoading = store.loadState
    store.loadState = 'loading'
    store.syncStartRevision = store.revision
    store.rpcPending = true
    try {
      return await rpc()
    } finally {
      store.rpcPending = false
    }
  })
  const apply = (receipt: FakeReceipt): void => {
    store.data = receipt.data
    store.revision = receipt.revision
    store.loadState = 'loaded'
  }
  const isStaleReceipt = (receipt: FakeReceipt): boolean => {
    if (store.revision === null || store.syncStartRevision === null) return false
    return receipt.revision < store.revision && receipt.revision >= store.syncStartRevision
  }
  return { store, sync, apply, isStaleReceipt }
}

beforeEach(() => {
  resetConnectionEdgeSyncForTest()
  vi.restoreAllMocks()
})

describe('并发合流单飞（验收 1：同域在途时再触发不重复发）', () => {
  it('在途期间 requestDomainSync（changed 触发，不推进连接代）合流跳过 + 登记 trailing，回执提交后补拉一轮收敛', async () => {
    const gate = createGate<string>()
    const sync = vi.fn(() => gate.promise)
    registerDataDomain({ id: 'sessions', sync, whenToSync: () => true, failure: 'retryable' })

    notifyConnectedEdge() // gen 1：首轮发起
    requestDomainSync('sessions') // changed 触发：在途，合流跳过（登记 trailing 标志）
    requestDomainSync('sessions') // 再次触达：合并为同一次补拉（标志是集合成员资格非计数）
    await flushMicrotasks()
    expect(sync).toHaveBeenCalledTimes(1)

    gate.resolve('list')
    await flushMicrotasks()
    // 回执属最新代（触发未推进代）→ 正常提交；在途期有触达 → trailing 补拉一轮
    // （dmg-r3-1：被跳过的触达可能是失效信号，在途回执可能是信号所反应变更前的旧快照，
    // 补拉保证收敛到最新——纯跳过无补拉是该问题判定的缺口形态）
    expect(sync).toHaveBeenCalledTimes(2)
    // 补拉轮回执落定后无新触达 → 不再补发（循环收敛）
    await flushMicrotasks()
    expect(sync).toHaveBeenCalledTimes(2)
  })

  it('新边沿在途期触达同域：合流跳过（不重复发）；旧代回执到达后丢弃并补发（跨代语义见「仅最新代提交」节）', async () => {
    const gate = createGate<string>()
    const sync = vi.fn(() => gate.promise)
    registerDataDomain({ id: 'sessions', sync, whenToSync: () => true, failure: 'retryable' })

    notifyConnectedEdge() // gen 1：首轮发起
    notifyConnectedEdge() // gen 2：在途，合流跳过——不立即重复发
    expect(sync).toHaveBeenCalledTimes(1)
    // 放行在途轮（gen1 < gen2 → 判旧丢弃 + 补发，由「仅最新代提交」节详验）
    gate.resolve('list')
    await flushMicrotasks()
    expect(sync).toHaveBeenCalledTimes(2)
  })

  it('轮次落定后（无在途）再次触发正常发起新一轮', async () => {
    const sync = vi.fn(() => Promise.resolve('v1'))
    registerDataDomain({ id: 'sessions', sync, whenToSync: () => true, failure: 'retryable' })
    notifyConnectedEdge()
    await flushMicrotasks()
    notifyConnectedEdge() // gen 2：无在途，重拉
    await flushMicrotasks()
    expect(sync).toHaveBeenCalledTimes(2)
  })
})

describe('仅最新代提交（验收 2：旧连接代回执丢弃）', () => {
  it('旧代在途回执到达：拦截型 apply 不被触达（不提交）+ 丢弃点补发新一代并提交', async () => {
    const gate1 = createGate<string>()
    const gate2 = createGate<string>()
    const sync = vi
      .fn<() => Promise<string>>()
      .mockImplementationOnce(() => gate1.promise)
      .mockImplementationOnce(() => gate2.promise)
    const log = createReceiptLog<string>()
    registerDataDomain({
      id: 'workspace',
      sync,
      apply: log.apply,
      whenToSync: () => true,
      failure: 'degraded',
    })

    notifyConnectedEdge() // gen 1：尝试 A 发起（gate1 在途）
    notifyConnectedEdge() // gen 2：A 在途，合流跳过（不重复发）
    expect(sync).toHaveBeenCalledTimes(1)

    gate1.resolve('stale-snapshot') // A 回执（旧代 gen1 < gen2）
    await flushMicrotasks()
    // 旧代回执丢弃：拦截型 apply 不被调用（不提交旧数据）
    expect(log.applied).toEqual([])
    // 丢弃点补发：新一代（gen2）同步自动发起
    expect(sync).toHaveBeenCalledTimes(2)

    gate2.resolve('fresh-snapshot')
    await flushMicrotasks()
    // 补发轮回执属最新代 → 提交，断连恢复的刷新诉求收敛
    expect(log.applied).toEqual(['fresh-snapshot'])
  })

  it('一体式（apply 省略）：旧代回执同样丢弃并补发收敛，不抛不挂', async () => {
    const gate1 = createGate<string>()
    const sync = vi.fn(() => gate1.promise)
    registerDataDomain({ id: 'workspace', sync, whenToSync: () => true, failure: 'degraded' })

    notifyConnectedEdge() // gen 1
    notifyConnectedEdge() // gen 2（合流跳过）
    gate1.resolve('stale') // 旧代回执 → 丢弃 + 补发（一体式无 apply 可拦，补发轮覆盖收敛）
    await flushMicrotasks()
    expect(sync).toHaveBeenCalledTimes(2)
    await whenSettled('workspace') // 首次落定不受补发影响（首轮已 settle）
  })
})

describe('命令×同步交错（验收 3：命令回执先于在途 load 回执 → 判旧丢弃不回滚 + 补发收敛）', () => {
  it('受控 promise 构造：命令回执提交新 revision 后，在途旧 revision load 回执被丢弃，store 锚定不回滚，补发轮收敛', async () => {
    // fake project store：revision 随命令回执（本测试直接推进，等价命令通道提交）与
    // load 回执（apply）推进；isStaleReceipt 判据与 §6.6 一致（回执 revision < 已提交最新）。
    const store = { revision: 5, data: 'v5' }
    const gateLoad1 = createGate<{ revision: number; data: string }>()
    const gateLoad2 = createGate<{ revision: number; data: string }>()
    const loadGates = [gateLoad1, gateLoad2]
    const sync = vi.fn(() => loadGates.shift()?.promise ?? Promise.resolve({ revision: store.revision, data: 'x' }))
    registerDataDomain({
      id: 'project',
      sync,
      apply: (receipt) => {
        store.revision = receipt.revision
        store.data = receipt.data
      },
      whenToSync: () => true,
      failure: 'blocking',
      isStaleReceipt: (receipt) => receipt.revision < store.revision,
    })

    notifyConnectedEdge() // gen 1：首轮 load 发起（gateLoad1 在途，snapshot revision=5）
    await flushMicrotasks()

    // 重拉子形态窗口内用户编辑 → changed 触发重拉（撞在途 load，并发合流跳过）
    requestDomainSync('project')
    expect(sync).toHaveBeenCalledTimes(1)

    // 命令回执先于在途 load 回执到达：store 提交命令后状态（revision 5 → 6）
    store.revision = 6
    store.data = 'cmd-v6'

    // 在途 load 回执（revision 5，命令执行前旧快照）到达
    gateLoad1.resolve({ revision: 5, data: 'stale-snapshot' })
    await flushMicrotasks()
    // 核心：旧回执按 revision 判旧丢弃——store 锚定不回滚（仍为命令后状态）
    expect(store.revision).toBe(6)
    expect(store.data).toBe('cmd-v6')
    // 丢弃点自动补发一轮该域同步
    expect(sync).toHaveBeenCalledTimes(2)

    // 补发轮回执携带最新 revision → 提交收敛
    gateLoad2.resolve({ revision: 6, data: 'v6' })
    await flushMicrotasks()
    expect(store.data).toBe('v6')
    expect(sync).toHaveBeenCalledTimes(2) // 收敛后不再补发
  })

  it('回执 revision 不早于已提交 revision（无命令插入）→ 正常提交', async () => {
    const store = { revision: 5, data: 'v5' }
    const log = createReceiptLog<{ revision: number }>()
    registerDataDomain({
      id: 'project',
      sync: () => Promise.resolve({ revision: 5 }),
      apply: log.apply,
      whenToSync: () => true,
      failure: 'blocking',
      isStaleReceipt: (receipt) => receipt.revision < store.revision,
    })
    notifyConnectedEdge()
    await flushMicrotasks()
    expect(log.applied).toEqual([{ revision: 5 }])
  })
})

describe('带重入守卫的 store 集成形态（F1-27：命令回执先行 → load 回执判旧丢弃 → 补发轮收敛）', () => {
  it('命令回执先提交后，在途旧 revision load 回执判旧丢弃，丢弃点补发收敛且 loadState 终态正确', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const gate1 = createGate<FakeReceipt>()
      const gate2 = createGate<FakeReceipt>()
      const gate3 = createGate<FakeReceipt>()
      const loadGates = [gate1, gate2, gate3]
      const { store, sync, apply, isStaleReceipt } = createGuardedProjectStore(() => {
        const gate = loadGates.shift()
        return gate
          ? gate.promise
          : Promise.resolve({ revision: store.revision ?? 0, data: 'x' })
      })
      registerDataDomain({
        id: 'project',
        sync,
        apply,
        whenToSync: () => true,
        failure: 'blocking',
        isStaleReceipt,
      })

      notifyConnectedEdge() // gen 1：首轮 load 发起（gate1 在途）
      expect(store.loadState).toBe('loading')
      gate1.resolve({ revision: 5, data: 'v5' })
      await flushMicrotasks()
      expect(store.loadState).toBe('loaded') // 首轮回执提交
      expect(store.revision).toBe(5)

      notifyConnectedEdge() // gen 2：重连边沿重拉（重拉子形态，gate2 在途）
      expect(store.loadState).toBe('loading')

      // 重拉在途窗口内命令回执先提交（等价命令通道 commandApplied，revision 5 → 6）
      store.revision = 6
      store.data = 'cmd-v6'
      requestDomainSync('project') // changed 触发重拉：撞在途 load，并发合流跳过
      expect(sync).toHaveBeenCalledTimes(2)

      // 在途 load 回执（revision 5，命令执行前旧快照）到达 → 判旧丢弃 + 丢弃点补发
      gate2.resolve({ revision: 5, data: 'stale-snapshot' })
      await flushMicrotasks()
      // 丢弃不提交：命令结果不回滚
      expect(store.data).toBe('cmd-v6')
      // 死锁锁定点：补发轮必须可达且成功——残留 loading 未收尾时补发轮 sync 撞重入
      // 守卫被拒（error 出声、无在途、loadState 永久卡 loading）
      expect(errorSpy).not.toHaveBeenCalled()
      expect(sync).toHaveBeenCalledTimes(3)
      expect(store.loadState).toBe('loading') // 补发轮在途（gate3）

      // 补发轮回执（最新 revision）→ 提交收敛
      gate3.resolve({ revision: 6, data: 'v6' })
      await flushMicrotasks()
      expect(store.loadState).toBe('loaded')
      expect(store.data).toBe('v6')
      expect(store.revision).toBe(6)
      expect(sync).toHaveBeenCalledTimes(3) // 收敛，不再补发
      expect(errorSpy).not.toHaveBeenCalled()
    } finally {
      errorSpy.mockRestore()
    }
  })
})

describe('在途窗口失效信号 trailing 补拉（dmg-r3-1：多窗口 project.changed 被合流跳过 + 双判旧不命中）', () => {
  it('B 窗口 load 在途期间 project.changed 触达被跳过，在途回执为命令前旧快照（revision 等于发起时基线，判旧不命中）→ apply 旧快照后 trailing 补拉收敛到命令后状态', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const gate1 = createGate<FakeReceipt>()
      const gate2 = createGate<FakeReceipt>()
      const gate3 = createGate<FakeReceipt>()
      const loadGates = [gate1, gate2, gate3]
      const { store, sync, apply, isStaleReceipt } = createGuardedProjectStore(() => {
        const gate = loadGates.shift()
        return gate
          ? gate.promise
          : Promise.resolve({ revision: store.revision ?? 0, data: 'x' })
      })
      registerDataDomain({
        id: 'project',
        sync,
        apply,
        whenToSync: () => true,
        failure: 'blocking',
        isStaleReceipt,
      })

      // B 窗口先完成一轮 load（水位 5）——多窗口形态的基线前提
      notifyConnectedEdge() // gen 1：首轮 load（gate1 在途）
      gate1.resolve({ revision: 5, data: 'v5' })
      await flushMicrotasks()
      expect(store.revision).toBe(5)
      expect(store.loadState).toBe('loaded')

      // B 窗口重拉（gen 2 边沿发起，gate2 在途；本轮判旧基线 = 发起时水位 5）
      notifyConnectedEdge()
      expect(store.loadState).toBe('loading')

      // 多窗口交错（dmg-r3-1 缺口形态）：A 窗口提交命令——B 未消费其命令回执，B 的
      // store 水位不动（仍 5），服务端侧已推进到 6；project.changed 广播到达 B →
      // requestDomainSync 撞在途被合流跳过（此前为纯跳过：信号消费完毕无登记）
      requestDomainSync('project')
      expect(sync).toHaveBeenCalledTimes(2)

      // 在途回执（A 命令执行前的旧快照，revision 5 等于 B 发起基线）落定：双判旧均
      // 不命中——gen 不变 + isStaleReceipt 前半条件 5 < 5 为 false（B 水位未推进）→
      // apply 旧快照（缺口实然发生）；trailing 标志在位 → apply 后立即补拉一轮
      gate2.resolve({ revision: 5, data: 'stale-snapshot' })
      await flushMicrotasks()
      expect(store.data).toBe('stale-snapshot') // 旧快照先被提交（判旧不可见的窗口内）
      expect(store.loadState).toBe('loading') // trailing 补拉轮在途（gate3）
      expect(sync).toHaveBeenCalledTimes(3)

      // 补拉轮回执（命令后状态 revision 6）→ 提交收敛；无新触达不再补发
      gate3.resolve({ revision: 6, data: 'v6' })
      await flushMicrotasks()
      expect(store.loadState).toBe('loaded')
      expect(store.data).toBe('v6')
      expect(store.revision).toBe(6)
      expect(sync).toHaveBeenCalledTimes(3) // 收敛，不再补拉
      expect(errorSpy).not.toHaveBeenCalled()
    } finally {
      errorSpy.mockRestore()
    }
  })
})

describe('交错判旧资格基线（dmg-r2-1：命令回执提交后 runtime revision 回退的崩溃重启形态收敛）', () => {
  /**
   * 死锁形态锁定（dmg-r2-1）：runtime 崩溃重启 → write-back debounce 窗口丢失写入 →
   * 文件 revision 回退；重连 load 回执 revision 恒低于 renderer 已提交水位（幻影水位）。
   * 旧判据（receipt.revision < revision，无资格基线）下该回执恒被判旧丢弃 + 丢弃点
   * 无限补发；同时命令携带幻影 revision 被 runtime assertRevision 恒拒——双通道死锁，
   * 唯一恢复 = 刷新页面。判据加同步发起基线后：低于基线的回执 = 服务端权威回退，
   * 不判旧直接 apply（水位随回执重置，命令通道解锁），有限轮（1 轮）收敛。
   * fake store 用模块级 createGuardedProjectStore（含基线判据镜像）。
   */
  function registerBaselineProjectStore(loadGates: Array<{ promise: Promise<FakeReceipt> }>) {
    const gates = [...loadGates]
    const rpc = (): Promise<FakeReceipt> =>
      gates.length > 0
        ? (gates.shift()!.promise as Promise<FakeReceipt>)
        : Promise.resolve({ revision: 0, data: 'x' })
    return createGuardedProjectStore(rpc)
  }

  it('命令回执提交后 runtime revision 回退：跨代 load 回执低于基线不判旧，一轮 apply 重置水位收敛（无补发循环）', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const gate1 = createGate<FakeReceipt>()
      const gate2 = createGate<FakeReceipt>()
      const { store, sync, apply, isStaleReceipt } = registerBaselineProjectStore([gate1, gate2])
      registerDataDomain({
        id: 'project',
        sync,
        apply,
        whenToSync: () => true,
        failure: 'blocking',
        isStaleReceipt,
      })

      // gen1 首轮 load 提交（revision 水位 5）
      notifyConnectedEdge()
      gate1.resolve({ revision: 5, data: 'v5' })
      await flushMicrotasks()
      expect(store.revision).toBe(5)
      expect(store.loadState).toBe('loaded')

      // 命令通道提交（等价 commandApplied：水位 5 → 6）
      store.revision = 6
      store.data = 'cmd-v6'

      // runtime 崩溃重启：debounce 窗口丢失写入 → 文件 revision 回退到 4；重连边沿
      // （gen2）触发重拉，本轮判旧基线 = 6（幻影水位），服务端回执 revision 4
      notifyConnectedEdge()
      gate2.resolve({ revision: 4, data: 'rolledback-v4' })
      await flushMicrotasks()

      // 死锁锁定点：回执低于基线 = 服务端权威回退形态 → 不判旧直接 apply——水位重置
      // 为回执值（命令通道 revision 校验随之解锁），无丢弃点补发（sync 恒 2 次，
      // 无限补发循环被封死）
      expect(store.revision).toBe(4)
      expect(store.data).toBe('rolledback-v4')
      expect(store.loadState).toBe('loaded')
      expect(sync).toHaveBeenCalledTimes(2)
      // 本场景无判旧丢弃（若判据回退成恒判旧，丢弃留痕 warn 会随补发循环出现）
      expect(warnSpy).not.toHaveBeenCalled()
      expect(errorSpy).not.toHaveBeenCalled()
    } finally {
      warnSpy.mockRestore()
      errorSpy.mockRestore()
    }
  })

  it('对照（同代交错保护不回退）：基线之上的旧快照照旧判旧丢弃（命令结果不回滚）+ 丢弃留痕 + 补发轮收敛', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const gate1 = createGate<FakeReceipt>()
      const gate2 = createGate<FakeReceipt>()
      const gate3 = createGate<FakeReceipt>()
      const { store, sync, apply, isStaleReceipt } = registerBaselineProjectStore([gate1, gate2, gate3])
      registerDataDomain({
        id: 'project',
        sync,
        apply,
        whenToSync: () => true,
        failure: 'blocking',
        isStaleReceipt,
      })

      notifyConnectedEdge() // gen1 首轮 load 提交（水位 5）
      gate1.resolve({ revision: 5, data: 'v5' })
      await flushMicrotasks()
      expect(store.revision).toBe(5)

      notifyConnectedEdge() // gen2 重拉（本轮基线 = 5，gate2 在途）
      // 在途窗口内命令回执提交（等价 commandApplied：水位 5 → 6）
      store.revision = 6
      store.data = 'cmd-v6'

      // 在途 load 回执（revision 5，命令执行前旧快照；落在基线之上、水位之下）
      gate2.resolve({ revision: 5, data: 'stale-snapshot' })
      await flushMicrotasks()
      // 判旧保护保持：命令结果不回滚 + 丢弃点补发
      expect(store.revision).toBe(6)
      expect(store.data).toBe('cmd-v6')
      expect(sync).toHaveBeenCalledTimes(3)
      // 判旧丢弃留痕（可观测性：丢弃-补发循环排障入口）
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("domain 'project' receipt discarded as stale revision"),
      )

      // 补发轮回执（基线刷新为 6，回执 revision 6 不早于水位）→ 提交收敛
      gate3.resolve({ revision: 6, data: 'v6' })
      await flushMicrotasks()
      expect(store.loadState).toBe('loaded')
      expect(store.data).toBe('v6')
      expect(store.revision).toBe(6)
      expect(sync).toHaveBeenCalledTimes(3)
      expect(errorSpy).not.toHaveBeenCalled()
    } finally {
      warnSpy.mockRestore()
      errorSpy.mockRestore()
    }
  })
})

describe('首次落定 promise', () => {
  it('成功落定：whenSettled 在边沿前调用时 ensure 发起首轮（序收敛，不死等）', async () => {
    const sync = vi.fn(() => Promise.resolve('v1'))
    registerDataDomain({ id: 'project', sync, whenToSync: () => true, failure: 'blocking' })
    const settled = whenSettled('project') // 首轮未发起 → 此处发起
    expect(sync).toHaveBeenCalledTimes(1)
    await settled
    expect(sync).toHaveBeenCalledTimes(1) // 落定后不重复发起
  })

  it('边沿先于 whenSettled：等待的是在途首轮（同一 promise）', async () => {
    const gate = createGate<string>()
    registerDataDomain({ id: 'project', sync: () => gate.promise, whenToSync: () => true, failure: 'blocking' })
    notifyConnectedEdge() // gen 1：首轮发起
    const settled = whenSettled('project')
    gate.resolve('v1')
    await settled
  })

  it('失败也落定（blocking 型 error 出声后 resolve，等待方不死等）', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      registerDataDomain({
        id: 'project',
        sync: () => Promise.reject(new Error('rpc refused')),
        whenToSync: () => true,
        failure: 'blocking',
      })
      await whenSettled('project') // 不抛：失败算落定，呈现由 store 失败语义承载
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("domain 'project' sync failed (blocking)"),
        expect.any(Error),
      )
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('后续边沿的同步不改变已落定 promise', async () => {
    let value = 'v1'
    const sync = vi.fn(() => Promise.resolve(value))
    registerDataDomain({ id: 'sessions', sync, whenToSync: () => true, failure: 'retryable' })
    const first = whenSettled('sessions')
    await first
    notifyConnectedEdge() // 重连边沿重拉
    await flushMicrotasks()
    expect(sync).toHaveBeenCalledTimes(2)
    // 已落定 promise 已 resolve（再次 await 立即返回），不被第二轮重新挂起
    await first
  })

  it("未登记 id：whenSettled 抛错（装配契约 fail-fast）；requestDomainSync warn 不抛", () => {
    expect(() => whenSettled('nope')).toThrow("domain not registered")
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(() => requestDomainSync('nope')).not.toThrow()
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("'nope'"))
    } finally {
      warnSpy.mockRestore()
    }
  })
})

describe('whenToSync 门控与辅助刷新', () => {
  it('whenToSync=false 的域在边沿不触发（落定 promise 保持未落定）', async () => {
    const sync = vi.fn(() => Promise.resolve('v1'))
    registerDataDomain({
      id: 'workspace',
      sync,
      whenToSync: () => false,
      failure: 'degraded',
    })
    notifyConnectedEdge()
    await flushMicrotasks()
    expect(sync).not.toHaveBeenCalled()
    // 未落定 promise 仍可获取（不 resolve）；ensure 语义下等待方调用即发起
    const settled = whenSettled('workspace')
    expect(sync).toHaveBeenCalledTimes(1)
    await settled
  })

  it('辅助刷新随边沿触发一次；refresh 自带 catch 与模块兜底 catch 均不炸', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const refresh = vi.fn(() => Promise.reject(new Error('scan failed')))
    registerAuxiliaryRefresh({ label: 'extension-scan', refresh })
    notifyConnectedEdge()
    await flushMicrotasks()
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("'extension-scan' failed"), expect.any(Error))
    warnSpy.mockRestore()
  })

  it('同步 refresh 抛错同样被兜底 catch（不中断其余域/辅助刷新）', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const afterSync = vi.fn(() => Promise.resolve('v1'))
      registerDataDomain({ id: 'sessions', sync: afterSync, whenToSync: () => true, failure: 'retryable' })
      registerAuxiliaryRefresh({
        label: 'bad-refresh',
        refresh: () => {
          throw new Error('sync throw')
        },
      })
      expect(() => notifyConnectedEdge()).not.toThrow()
      await flushMicrotasks()
      expect(afterSync).toHaveBeenCalledTimes(1) // 辅助刷新抛错不连坐数据域
    } finally {
      warnSpy.mockRestore()
    }
  })
})

describe('代次与重复登记', () => {
  it('重连边沿推进代次：新边沿发起的轮次携带最新代（其回执可提交）', async () => {
    const log = createReceiptLog<string>()
    const gate1 = createGate<string>()
    const gate2 = createGate<string>()
    const sync = vi
      .fn<() => Promise<string>>()
      .mockImplementationOnce(() => gate1.promise)
      .mockImplementationOnce(() => gate2.promise)
    registerDataDomain({ id: 'workspace', sync, apply: log.apply, whenToSync: () => true, failure: 'degraded' })
    notifyConnectedEdge() // gen 1
    gate1.resolve('gen1-data')
    await flushMicrotasks()
    notifyConnectedEdge() // gen 2：重连重拉
    gate2.resolve('gen2-data')
    await flushMicrotasks()
    // 两轮回执均属发起时的最新代 → 均提交（无合流窗口时不丢弃）
    expect(log.applied).toEqual(['gen1-data', 'gen2-data'])
  })

  it('同 id 重复登记覆盖描述符且保留落定状态（壳层多次装配幂等）', async () => {
    const first = vi.fn(() => Promise.resolve('v1'))
    registerDataDomain({ id: 'project', sync: first, whenToSync: () => true, failure: 'blocking' })
    await whenSettled('project')
    const second = vi.fn(() => Promise.resolve('v2'))
    registerDataDomain({ id: 'project', sync: second, whenToSync: () => true, failure: 'blocking' })
    // 落定状态保留：重复登记后 whenSettled 立即返回（不重新发起首轮）
    await whenSettled('project')
    expect(second).not.toHaveBeenCalled()
    // 新描述符在下一轮同步生效
    notifyConnectedEdge()
    await flushMicrotasks()
    expect(second).toHaveBeenCalledTimes(1)
    expect(first).toHaveBeenCalledTimes(1)
  })
})
