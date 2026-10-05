/**
 * RespawnOrchestrator 单测（崩溃上报 + 惰性恢复 join；发布判别 msg-pipeline-debloat D3）。
 *
 * [ADR-0112 退役登记] 原「5s 延迟自动恢复 + 连续失败熔断」机制（schedule 重试链 /
 * RESPAWN_DELAY_MS / RESPAWN_MAX_CONSECUTIVE_FAILURES / 熔断计数）已删除，对应用例随
 * 机制退役。现覆盖：
 * - crashExit：崩溃显式上报（fate terminal 发声）+ 守卫（isActive 防御位 / in-flight
 *   恢复让位 recovered 静默）+ crashed 登记供发布判别；
 * - join（ensureRestored）：并发调用等待同一 in-flight Promise，restore 内核只跑一次；
 * - join 失败传导：原恢复失败时 join 方得到同一失败，注册表清空后可重试；
 * - onRestoreSuccess：崩溃后恢复发布恰好一条 session.restored；无崩溃上下文静默；
 * - cancel / cancelAll：崩溃登记核销。
 *
 * mock 契约（D3）：restore 内核 = facade.restoreSession（生产装配 deps.restore = facade
 * 本尊），session.restored 的发布点 = facade 成功尾部（onRestoreSuccess）——需要发布
 * 断言的用例用 wireFacadeContract 把 restore 替身升级为同一契约，否则发布链断裂。
 *
 * 挂点/forceQuit 反向/join 等组装级行为在 session-service-respawn.test.ts（真实构造器
 * 接线 + dispatcher 链路）。本文件零 IO、零真实 pi、零真实数据目录。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { RespawnOrchestrator, onRespawnFate } from '../src/services/session/pi-respawn.js'
import type { RespawnDeps, RespawnFate, RespawnFateEvent } from '../src/services/session/pi-respawn.js'
import type { ServerMessage } from '@taiji/shared'

type RespawnTestDeps = RespawnDeps & {
  restore: ReturnType<typeof vi.fn>
  publish: ReturnType<typeof vi.fn>
  setActive: (id: string, on: boolean) => void
}

function createDeps(overrides: Partial<RespawnDeps> = {}): RespawnTestDeps {
  const active = new Set<string>()
  const restore = vi.fn<(id: string) => Promise<unknown>>().mockResolvedValue(undefined)
  const publish = vi.fn<(id: string, msg: ServerMessage) => void>()
  return {
    isActive: (id: string) => active.has(id),
    restore,
    publish,
    setActive: (id: string, on: boolean) => { if (on) active.add(id); else active.delete(id) },
    ...overrides,
  } as never
}

/**
 * [D3] 把 restore 替身升级为「真实 facade 契约」形态：内核成功 = spawn+attach 完成
 * （pm 有活 client）+ facade 尾部出口回调。生产装配 deps.restore = facade 本尊，
 * 不做此接线的替身（如纯 reject / 早期 join 用例）发布链断流属预期。
 */
function wireFacadeContract(deps: RespawnTestDeps, orchestrator: RespawnOrchestrator): void {
  deps.restore.mockImplementation(async (id: string) => {
    deps.setActive(id, true)
    orchestrator.onRestoreSuccess(id)
    return undefined
  })
}

describe('RespawnOrchestrator（崩溃上报 + 惰性恢复 join）', () => {
  // respawn 终态命运收集（notify-once D5 信号源断言面）：onRespawnFate 是模块级订阅
  //（组合根单消费方），beforeEach 挂 afterEach 退订——订阅残留会跨用例串扰。
  let fates: RespawnFateEvent[] = []
  let unsubFate: (() => void) | undefined
  beforeEach(() => {
    fates = []
    unsubFate = onRespawnFate((e) => { fates.push(e) })
  })
  afterEach(() => {
    unsubFate?.()
    unsubFate = undefined
  })
  /** 该 session 的 fate 事件序列（按序，含重复） */
  const fatesOf = (sessionId: string): RespawnFate[] =>
    fates.filter((e) => e.sessionId === sessionId).map((e) => e.fate)

  it('crashExit：崩溃显式上报（terminal 发声）+ 登记 crashed；恢复成功经 facade 尾部出口推恰好一条 session.restored', async () => {
    const deps = createDeps()
    const orchestrator = new RespawnOrchestrator(deps)
    wireFacadeContract(deps, orchestrator)
    orchestrator.crashExit('s1')
    // ADR-0112：不再自动恢复——restore 不被调用
    expect(deps.restore).not.toHaveBeenCalled()
    // 崩溃发声（显式上报）
    expect(fatesOf('s1')).toEqual(['terminal'])

    // 用户手动恢复（restore 内核 = facade 契约）：成功出口发布恰好一条
    await orchestrator.ensureRestored('s1')
    expect(deps.publish).toHaveBeenCalledTimes(1)
    const [sid, msg] = deps.publish.mock.calls[0] as [string, ServerMessage]
    expect(sid).toBe('s1')
    expect(msg.type).toBe('session.restored')
    expect(msg.payload).toMatchObject({ sessionId: 's1', attempts: 1 })
  })

  it('crashExit 时 in-flight 恢复在跑 → 静默（recovered，session 将复活）', async () => {
    const deps = createDeps()
    const orchestrator = new RespawnOrchestrator(deps)
    // 惰性恢复在途（不 resolve）
    let resolveRestore!: () => void
    deps.restore.mockImplementation(() => new Promise<void>((r) => { resolveRestore = r }))
    const restoring = orchestrator.ensureRestored('s1')
    orchestrator.crashExit('s1')
    expect(fatesOf('s1')).toEqual(['recovered'])
    resolveRestore()
    await restoring
  })

  it('crashExit 对活跃 session no-op（防御位：exit 链正常已清 processes）', () => {
    const deps = createDeps()
    deps.setActive('s1', true)
    const orchestrator = new RespawnOrchestrator(deps)
    orchestrator.crashExit('s1')
    expect(fatesOf('s1')).toEqual(['recovered'])
    // 未登记 crashed：恢复成功不发布
    orchestrator.onRestoreSuccess('s1')
    expect(deps.publish).not.toHaveBeenCalled()
  })

  it('join（ensureRestored）：并发调用等待同一 in-flight Promise，restore 内核只跑一次', async () => {
    const deps = createDeps()
    const orchestrator = new RespawnOrchestrator(deps)
    let resolveRestore!: () => void
    deps.restore.mockImplementation(() => new Promise<void>((r) => { resolveRestore = r }))

    const p1 = orchestrator.ensureRestored('s1')
    const p2 = orchestrator.ensureRestored('s1')
    expect(deps.restore).toHaveBeenCalledTimes(1)
    resolveRestore()
    await Promise.all([p1, p2])
    expect(deps.restore).toHaveBeenCalledTimes(1)
  })

  it('join 失败传导：原恢复失败时 join 方得到同一失败，注册表清空后可重试', async () => {
    const deps = createDeps()
    const orchestrator = new RespawnOrchestrator(deps)
    let rejectRestore!: (e: Error) => void
    deps.restore.mockImplementation(() => new Promise<void>((_, rej) => { rejectRestore = rej }))

    const p1 = orchestrator.ensureRestored('s1')
    const p2 = orchestrator.ensureRestored('s1')
    rejectRestore(new Error('restore boom'))
    await expect(p1).rejects.toThrow('restore boom')
    await expect(p2).rejects.toThrow('restore boom')

    // 注册表已清空：再次调用重新执行 restore
    deps.restore.mockResolvedValue(undefined)
    await orchestrator.ensureRestored('s1')
    expect(deps.restore).toHaveBeenCalledTimes(2)
  })

  it('无崩溃上下文的恢复：静默不发布（普通懒 spawn / startup-reattach 形态）', async () => {
    const deps = createDeps()
    const orchestrator = new RespawnOrchestrator(deps)
    wireFacadeContract(deps, orchestrator)
    await orchestrator.ensureRestored('s1')
    expect(deps.publish).not.toHaveBeenCalled()
  })

  it('cancel / cancelAll：核销崩溃登记，后续恢复成功不发布', () => {
    const deps = createDeps()
    const orchestrator = new RespawnOrchestrator(deps)
    orchestrator.crashExit('s1')
    orchestrator.crashExit('s2')
    orchestrator.cancel('s1')
    orchestrator.cancelAll()
    orchestrator.onRestoreSuccess('s1')
    orchestrator.onRestoreSuccess('s2')
    expect(deps.publish).not.toHaveBeenCalled()
  })

  it('crashExit 重复调用：重复登记幂等（Set 语义），恢复成功仍只发布一条', () => {
    const deps = createDeps()
    const orchestrator = new RespawnOrchestrator(deps)
    orchestrator.crashExit('s1')
    orchestrator.crashExit('s1')
    expect(fatesOf('s1')).toEqual(['terminal', 'terminal'])
    orchestrator.onRestoreSuccess('s1')
    expect(deps.publish).toHaveBeenCalledTimes(1)
  })
})
