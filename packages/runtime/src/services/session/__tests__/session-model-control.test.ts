/**
 * SessionModelControl 直测（S6 迁出批 4b + model-switch-live-provider-sync U2）：
 * 模型/思考等级控制——**激活前置**（`ensureActive` 先于 Map 查询与 set RPC）、激活上界与
 * 错误分型（既有码透传 / 无码包 SESSION_ACTIVATE_FAILED / 超时 SESSION_ACTIVATE_TIMEOUT /
 * `Model not found` 三型）、set RPC + get_state 回执普查（pattern 换模生效值）、三实例
 * markDirty 失效时序、session.modelId/thinkingLevel 直写双投影、trace 补拉、错误路径。
 *
 * 分层（G2：import 无 session-service，stub 面 = deps 方法）：client 的
 * setModel/setThinkingLevel/getState 可编程，markDirty/直写/补拉/激活经 spy 断言。
 */
import { describe, it, expect, vi } from 'vitest'
import type { ProviderId } from '@taiji/shared'
import type { IPiEngine } from '../../ports/pi-engine.js'
import type { IManagedSessionView } from '../types.js'
import type { SessionReplicatedStates } from '../session-state-projection.js'
import {
  SESSION_ACTIVATE_FAILED,
  SESSION_ACTIVATE_TIMEOUT,
  SESSION_NOT_FOUND,
  MODEL_NOT_FOUND,
  PROVIDER_CREDENTIAL_MISSING,
  ENGINE_MODEL_MISSING,
} from '../../../utils/errors.js'
import { SessionModelControl, classifyActivationError, isPiModelNotFoundError } from '../session-model-control.js'

/** 可变 session 视图（断言直写双投影）。 */
function makeSession(): { modelId: string; thinkingLevel: string } & IManagedSessionView {
  return { modelId: 'old/provider-old', thinkingLevel: 'medium' } as unknown as IManagedSessionView & { modelId: string; thinkingLevel: string }
}

interface FixtureOptions {
  getStateImpl?: () => Promise<unknown>
  /** session 视图返回（默认 makeSession()）。 */
  session?: unknown
  /** 激活后 Map 仍无条目（内部不变量破坏用例）。 */
  noSession?: boolean
  /** ensureActive 实现（默认立即返回存活 client）。 */
  ensureActiveImpl?: () => Promise<IPiEngine>
  /** 激活上界（默认不限时便于既有用例稳定）。 */
  activateTimeoutMs?: number
  isModelRegistered?: (provider: string, modelId: string) => boolean
  hasProviderCredential?: (provider: string) => boolean
}

function makeFixture(optsOrGetState: FixtureOptions | (() => Promise<unknown>) = {}) {
  // 兼容两种调用风格：对象选项 / 直接传 getState 实现（既有用例写法）
  const opts: FixtureOptions = typeof optsOrGetState === 'function'
    ? { getStateImpl: optsOrGetState }
    : optsOrGetState
  const session = opts.noSession ? undefined : (opts.session ?? makeSession())
  const markDirty = { modelId: vi.fn(), usage: vi.fn(), thinkingLevel: vi.fn() }
  const states = { modelId: { markDirty: markDirty.modelId }, usage: { markDirty: markDirty.usage }, thinkingLevel: { markDirty: markDirty.thinkingLevel } } as unknown as SessionReplicatedStates
  const client = {
    setModel: vi.fn(async () => undefined),
    setThinkingLevel: vi.fn(async () => undefined),
    getState: vi.fn(async () => ({ model: { id: 'effective-m', provider: 'p2' }, thinkingLevel: 'high' } as unknown)),
    exited: false,
  }
  if (opts.getStateImpl) client.getState.mockImplementation(opts.getStateImpl)
  const ensureActive = vi.fn(opts.ensureActiveImpl ?? (async () => client as unknown as IPiEngine))
  const syncTraceEntries = vi.fn()
  const control = new SessionModelControl({
    getSession: vi.fn(() => session as IManagedSessionView),
    getReplicatedStates: vi.fn(() => states),
    syncTraceEntries,
    ensureActive,
    isModelRegistered: opts.isModelRegistered ?? (() => true),
    hasProviderCredential: opts.hasProviderCredential ?? (() => true),
    activateTimeoutMs: opts.activateTimeoutMs ?? 0,
  })
  return { control, session: session as { modelId: string; thinkingLevel: string }, markDirty, client, syncTraceEntries, ensureActive }
}

describe('switchModel — 激活前置（U2/D5）', () => {
  it('回收态（session 不在 Map 的等价形态：getSession 先空后非空）仍先 ensureActive 再 setModel', async () => {
    const { control, client, ensureActive, session, markDirty } = makeFixture()
    const result = await control.switchModel('s1', 'p1' as ProviderId, 'requested-m')
    expect(ensureActive).toHaveBeenCalledWith('s1')
    // 顺序：激活先于 set RPC（激活是 set 的前置，不再有「无 client → 假成功」早退）
    expect(ensureActive.mock.invocationCallOrder[0]).toBeLessThan(client.setModel.mock.invocationCallOrder[0])
    expect(result).toBe('p2/effective-m')
    expect(session.modelId).toBe('p2/effective-m')
    expect(markDirty.modelId).toHaveBeenCalledTimes(1)
  })

  it('ensureActive 无码失败 → 包 SESSION_ACTIVATE_FAILED，零 set RPC 零失效', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const fixture = makeFixture({
        ensureActiveImpl: async () => { throw new Error('Restore succeeded but client not available') },
      })
      await expect(fixture.control.switchModel('s1', 'p1' as ProviderId, 'm'))
        .rejects.toMatchObject({ code: SESSION_ACTIVATE_FAILED })
      expect(fixture.client.setModel).not.toHaveBeenCalled()
      expect(fixture.markDirty.modelId).not.toHaveBeenCalled()
      expect(fixture.session.modelId).toBe('old/provider-old')
    } finally {
      errors.mockRestore()
    }
  })

  it('ensureActive 既有码（SESSION_NOT_FOUND）原样透传，不重包', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const fixture = makeFixture({
        ensureActiveImpl: async () => {
          const e = new Error('session file not found') as Error & { code: string }
          e.code = SESSION_NOT_FOUND
          throw e
        },
      })
      await expect(fixture.control.switchModel('s1', 'p1' as ProviderId, 'm'))
        .rejects.toMatchObject({ code: SESSION_NOT_FOUND, message: 'session file not found' })
    } finally {
      errors.mockRestore()
    }
  })

  it('激活超时 → SESSION_ACTIVATE_TIMEOUT，且后台恢复继续（底层 promise 后到 settle 不炸）', async () => {
    vi.useFakeTimers()
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const unhandled: unknown[] = []
      const onUnhandled = (reason: unknown): void => { unhandled.push(reason) }
      process.on('unhandledRejection', onUnhandled)
      let settle: ((v: unknown) => void) | undefined
      const pending = new Promise((resolve) => { settle = resolve as (v: unknown) => void })
      const fixture = makeFixture({
        activateTimeoutMs: 15_000,
        ensureActiveImpl: () => pending.then(() => {
          const e = new Error('后台恢复稍后失败') as Error & { code: string }
          e.code = 'RESTORE_FAILED'
          throw e
        }) as Promise<IPiEngine>,
      })
      const p = fixture.control.switchModel('s1', 'p1' as ProviderId, 'm')
      const assertion = expect(p).rejects.toMatchObject({ code: SESSION_ACTIVATE_TIMEOUT })
      await vi.advanceTimersByTimeAsync(15_000)
      await assertion
      expect(fixture.client.setModel).not.toHaveBeenCalled()
      // 超时后底层 promise 才 settle（后台恢复继续）——不应产生 unhandled rejection
      settle?.(undefined)
      await vi.advanceTimersByTimeAsync(0)
      await Promise.resolve()
      expect(unhandled).toEqual([])
      process.off('unhandledRejection', onUnhandled)
    } finally {
      errors.mockRestore()
      vi.useRealTimers()
    }
  })

  it('激活返回已死 client（exited）→ SESSION_ACTIVATE_FAILED，不把死 client 交给 set RPC', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const fixture = makeFixture()
      ;(fixture.client as { exited: boolean }).exited = true
      await expect(fixture.control.switchModel('s1', 'p1' as ProviderId, 'm'))
        .rejects.toMatchObject({ code: SESSION_ACTIVATE_FAILED })
      expect(fixture.client.setModel).not.toHaveBeenCalled()
    } finally {
      errors.mockRestore()
    }
  })

  it('激活成功但 Map 仍无条目（内部不变量破坏）→ SESSION_ACTIVATE_FAILED，不静默', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const fixture = makeFixture({ noSession: true })
      await expect(fixture.control.switchModel('s1', 'p1' as ProviderId, 'm'))
        .rejects.toMatchObject({ code: SESSION_ACTIVATE_FAILED })
      expect(fixture.client.setModel).not.toHaveBeenCalled()
    } finally {
      errors.mockRestore()
    }
  })
})

describe('switchModel — Model not found 三型分型（U2/§3.4）', () => {
  const piError = (): Error => new Error('Model not found: p1/m')

  async function expectCode(opts: FixtureOptions, code: string): Promise<void> {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const fixture = makeFixture(opts)
      ;(fixture.client.setModel as ReturnType<typeof vi.fn>).mockRejectedValue(piError())
      await expect(fixture.control.switchModel('s1', 'p1' as ProviderId, 'm')).rejects.toMatchObject({ code })
      expect(fixture.markDirty.modelId).not.toHaveBeenCalled()
    } finally {
      errors.mockRestore()
    }
  }

  it('模型不在 taiji 注册表 → MODEL_NOT_FOUND', async () => {
    await expectCode({ isModelRegistered: () => false }, MODEL_NOT_FOUND)
  })

  it('模型在注册表、provider 无凭据 → PROVIDER_CREDENTIAL_MISSING', async () => {
    await expectCode({ isModelRegistered: () => true, hasProviderCredential: () => false }, PROVIDER_CREDENTIAL_MISSING)
  })

  it('模型在注册表、凭据齐备 → ENGINE_MODEL_MISSING（快照未同步或配置坏，双因文案）', async () => {
    await expectCode({ isModelRegistered: () => true, hasProviderCredential: () => true }, ENGINE_MODEL_MISSING)
  })

  it('非 Model not found 文本错误原样透传（不吞不重包）', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const fixture = makeFixture()
      ;(fixture.client.setModel as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('rpc transport down'))
      await expect(fixture.control.switchModel('s1', 'p1' as ProviderId, 'm')).rejects.toThrow('rpc transport down')
    } finally {
      errors.mockRestore()
    }
  })

  it('判定函数单测：前缀匹配 + 激活分型（导出面，供 PS 探针与上层复用）', () => {
    expect(isPiModelNotFoundError(new Error('Model not found: a/b'))).toBe(true)
    expect(isPiModelNotFoundError(new Error('modelX not found'))).toBe(false)
    const passthrough = Object.assign(new Error('x'), { code: SESSION_NOT_FOUND })
    expect(classifyActivationError(passthrough, 's1')).toBe(passthrough)
    expect((classifyActivationError(new Error('boom'), 's1') as { code: string }).code).toBe(SESSION_ACTIVATE_FAILED)
  })
})

describe('switchModel — 回执与失效（既有语义）', () => {
  it('回执普查：pattern 换模时返回/直写 get_state 生效值（≠ 请求值）+ 三实例失效 + trace 补拉', async () => {
    const { control, session, markDirty, syncTraceEntries, client } = makeFixture()
    const result = await control.switchModel('s1', 'p1' as ProviderId, 'requested-m')
    expect(client.setModel).toHaveBeenCalledWith('p1', 'requested-m')
    expect(result).toBe('p2/effective-m')
    expect(session.modelId).toBe('p2/effective-m')
    expect(markDirty.modelId).toHaveBeenCalledTimes(1)
    expect(markDirty.usage).toHaveBeenCalledTimes(1)
    expect(markDirty.thinkingLevel).toHaveBeenCalledTimes(1)
    expect(syncTraceEntries).toHaveBeenCalledWith('s1', 'set_model')
  })

  it('get_state 读回失败：fallback 请求值（不反噬主链路），失效仍发 + 警告行（S2 断言依赖）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { control, session, markDirty } = makeFixture(async () => { throw new Error('state rpc down') })
      const result = await control.switchModel('s1', 'p1' as ProviderId, 'requested-m')
      expect(result).toBe('p1/requested-m')
      expect(session.modelId).toBe('p1/requested-m')
      expect(markDirty.modelId).toHaveBeenCalledTimes(1)
      expect(warn.mock.calls.some((c) => String(c[0]).includes('switchModel get_state read-back failed'))).toBe(true)
    } finally {
      warn.mockRestore()
    }
  })

  it('setModel 非分型 RPC 失败：不失效不直写（pi 侧未生效，实例保持旧快照）', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const fixture = makeFixture()
      ;(fixture.client.setModel as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('rpc fail'))
      await expect(fixture.control.switchModel('s1', 'p1' as ProviderId, 'm')).rejects.toThrow('rpc fail')
      expect(fixture.markDirty.modelId).not.toHaveBeenCalled()
      expect(fixture.markDirty.usage).not.toHaveBeenCalled()
      expect(fixture.markDirty.thinkingLevel).not.toHaveBeenCalled()
      expect(fixture.syncTraceEntries).not.toHaveBeenCalled()
      expect(fixture.session.modelId).toBe('old/provider-old')
    } finally {
      error.mockRestore()
    }
  })

})

describe('setThinkingLevel — 同激活语义（U2/D7）', () => {
  it('钳制读回：返回 get_state 生效值并直写 session.thinkingLevel + trace 补拉', async () => {
    const { control, session, syncTraceEntries, ensureActive } = makeFixture(async () => ({ thinkingLevel: 'high' }))
    const result = await control.setThinkingLevel('s1', 'max')
    expect(ensureActive).toHaveBeenCalledWith('s1')
    expect(result).toBe('high')
    expect(session.thinkingLevel).toBe('high')
    expect(syncTraceEntries).toHaveBeenCalledWith('s1', 'set_thinking_level')
  })

  it('get_state thinkingLevel 非 string：fallback 请求值', async () => {
    const { control, session } = makeFixture(async () => ({ thinkingLevel: undefined }))
    const result = await control.setThinkingLevel('s1', 'low')
    expect(result).toBe('low')
    expect(session.thinkingLevel).toBe('low')
  })

  it('无活跃进程不再「请求值兜底 + 直写」假成功 → 激活失败显性化', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const fixture = makeFixture({
        ensureActiveImpl: async () => { throw new Error('no client') },
      })
      await expect(fixture.control.setThinkingLevel('s1', 'medium'))
        .rejects.toMatchObject({ code: SESSION_ACTIVATE_FAILED })
      expect(fixture.session.thinkingLevel).toBe('medium') // 未被本方法改写（保持原值）
      expect(fixture.client.setThinkingLevel).not.toHaveBeenCalled()
    } finally {
      errors.mockRestore()
    }
  })

  it('激活超时同样显性化（档位路径与模型路径同一上界）', async () => {
    vi.useFakeTimers()
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const fixture = makeFixture({
        activateTimeoutMs: 15_000,
        ensureActiveImpl: () => new Promise<IPiEngine>(() => {}),
      })
      const p = fixture.control.setThinkingLevel('s1', 'high')
      const assertion = expect(p).rejects.toMatchObject({ code: SESSION_ACTIVATE_TIMEOUT })
      await vi.advanceTimersByTimeAsync(15_000)
      await assertion
    } finally {
      errors.mockRestore()
      vi.useRealTimers()
    }
  })
})
