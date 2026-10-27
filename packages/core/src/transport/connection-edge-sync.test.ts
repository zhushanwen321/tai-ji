/**
 * 域同步器单测（connection-datasync-ssot §6.4；impl-plan u4 验收条款 1-3 的机制载体）。
 *
 * 受控 promise（gate deferred）注入 sync，确定性构造回执到达时序，覆盖：
 * - 并发合流单飞：同域在途时再触发（边沿 / requestDomainSync）不重复发（验收 1）
 * - 仅最新代提交：旧连接代回执丢弃 + 丢弃点补发收敛；拦截型 apply 不被旧代触达（验收 2）
 * - 命令×同步交错（project 域）：命令回执先于在途 load 回执到达 → 旧 revision 回执判旧
 *   丢弃（不回滚）+ 补发轮收敛（验收 3）
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

beforeEach(() => {
  resetConnectionEdgeSyncForTest()
  vi.restoreAllMocks()
})

describe('并发合流单飞（验收 1：同域在途时再触发不重复发）', () => {
  it('在途期间 requestDomainSync（changed 触发，不推进连接代）合流跳过，回执正常提交', async () => {
    const gate = createGate<string>()
    const sync = vi.fn(() => gate.promise)
    registerDataDomain({ id: 'sessions', sync, whenToSync: () => true, failure: 'retryable' })

    notifyConnectedEdge() // gen 1：首轮发起
    requestDomainSync('sessions') // changed 触发：在途，合流跳过
    requestDomainSync('sessions')
    await flushMicrotasks()
    expect(sync).toHaveBeenCalledTimes(1)

    gate.resolve('list')
    await flushMicrotasks()
    // 回执属最新代（触发未推进代）→ 正常提交，不补发
    expect(sync).toHaveBeenCalledTimes(1)
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
  /**
   * 带重入守卫的 fake project store（集成形态，镜像 renderer stores/project.ts 的 sync
   * 接线面）：loadState 状态机 + 「loading 态 sync 重入守卫」+「残留 loading 收尾（放弃
   * 在途）」。无守卫的 fake 检不出死锁形态（补发轮撞守卫被拒 → 在途状态永久卡 loading，
   * F1-27 正是经此缺口全绿放行）——本节用例锁定丢弃点补发在守卫 store 下可达且收敛。
   */
  type FakeReceipt = { revision: number; data: string }
  type FakeLoadState = 'idle' | 'loading' | 'loaded'
  function createGuardedProjectStore(rpc: () => Promise<FakeReceipt>) {
    const store = {
      loadState: 'idle' as FakeLoadState,
      stateBeforeLoading: 'idle' as FakeLoadState,
      revision: null as number | null,
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
    const isStaleReceipt = (receipt: FakeReceipt): boolean =>
      store.revision !== null && receipt.revision < store.revision
    return { store, sync, apply, isStaleReceipt }
  }

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
