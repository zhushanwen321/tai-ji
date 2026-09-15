/**
 * AuthService 单测（mock flow/storage/broadcast）。
 *
 * 覆盖：login 无 oauthConfig → started:false / 已有 flow 幂等拒绝 / 正常启动 →
 * 事件序列（deviceCode → success）+ clearApiKey（I9 both 清理②）/ 失败 → auth.error /
 * cancel（无 flow 幂等 + 有 flow abort 且不发 error）/ hasOAuth 委托 /
 * logout（委托 authStorage.remove + 先中止进行中 flow，B-1 场景 C）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ServerMessage } from '@taiji/shared'
import type { BuiltinOAuthConfig } from '@taiji/shared'
import { AuthService, type AuthServiceDeps } from '../auth-service.js'
import { AuthStorage, type OAuthCredential } from '../auth-storage.js'
import type { DeviceCodeInfo } from '../oauth-flow.js'

// mock oauth-flow：让测试聚焦 AuthService 编排，不触发真实网络
vi.mock('../oauth-flow.js', () => ({
  runOAuthLogin: vi.fn(),
}))

import { runOAuthLogin } from '../oauth-flow.js'

const OAUTH_CONFIG: BuiltinOAuthConfig = {
  clientId: 'client-x',
  flow: 'device',
  endpoints: { token: 'https://x/token', deviceCode: 'https://x/device' },
  scopes: [],
}

function makeDeps(overrides?: Partial<AuthServiceDeps>): AuthServiceDeps & { events: ServerMessage[] } {
  const events: ServerMessage[] = []
  const authStorage: Pick<AuthServiceDeps['authStorage'], 'get' | 'getAll' | 'set' | 'remove' | 'hasOAuth'> = {
    get: vi.fn(async () => undefined),
    getAll: vi.fn(async () => ({})),
    set: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined),
    hasOAuth: vi.fn(async () => false),
  }
  return {
    authStorage,
    getOAuthConfig: vi.fn((id: string) => (id === 'xai' ? OAUTH_CONFIG : undefined)),
    broadcast: vi.fn((msg: ServerMessage) => events.push(msg)),
    nextPushId: vi.fn(() => 'evt-1'),
    clearApiKey: vi.fn(),
    events,
    ...overrides,
  }
}

function oauthCred(access = 'at'): OAuthCredential {
  return { type: 'oauth', access, refresh: 'rt', expires: Date.now() + 3_600_000 }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(runOAuthLogin).mockReset()
})

describe('AuthService.login', () => {
  it('provider 无 oauthConfig → started:false + error，不启动 flow', () => {
    const deps = makeDeps()
    const svc = new AuthService(deps)
    const result = svc.login('openai')
    expect(result).toEqual({ started: false, error: 'provider "openai" 不支持 OAuth' })
    expect(runOAuthLogin).not.toHaveBeenCalled()
  })

  it('正常启动 → started:true，flow 成功推 deviceCode + success，且清 models.json apiKey（I9）', async () => {
    const deps = makeDeps()
    const svc = new AuthService(deps)
    vi.mocked(runOAuthLogin).mockImplementation(async (_id, _cfg, hooks) => {
      hooks.onDeviceCode?.({ userCode: 'ABCD-EFGH', verificationUri: 'https://x/activate' } as DeviceCodeInfo)
      return oauthCred()
    })

    const result = svc.login('xai')
    expect(result).toEqual({ started: true })

    // 等异步 flow 完成
    await vi.waitFor(() => {
      expect(deps.events.some((e) => e.type === 'auth.success')).toBe(true)
    })

    expect(runOAuthLogin).toHaveBeenCalledWith('xai', OAUTH_CONFIG, expect.any(Object), expect.any(AbortSignal))
    expect(deps.authStorage.set).toHaveBeenCalledWith('xai', expect.objectContaining({ type: 'oauth', access: 'at' }))
    // I9 both 清理②：OAuth 成功 → 清 models.json apiKey
    expect(deps.clearApiKey).toHaveBeenCalledWith('xai')
    // 事件顺序：deviceCode → success
    const types = deps.events.map((e) => e.type)
    expect(types.indexOf('auth.deviceCode')).toBeLessThan(types.indexOf('auth.success'))
    expect(deps.events.find((e) => e.type === 'auth.deviceCode')?.payload).toMatchObject({
      providerId: 'xai', userCode: 'ABCD-EFGH',
    })
    expect(deps.events.find((e) => e.type === 'auth.success')?.payload).toEqual({ providerId: 'xai' })
  })

  it('已有进行中 flow → started:false + error（幂等拒绝）', () => {
    const deps = makeDeps()
    const svc = new AuthService(deps)
    // flow 永不完成：挂起，模拟进行中
    vi.mocked(runOAuthLogin).mockImplementation(() => new Promise(() => {}))
    expect(svc.login('xai')).toEqual({ started: true })
    expect(svc.login('xai').started).toBe(false)
  })

  it('flow 失败 → 推 auth.error，不写 auth.json，不清 apiKey', async () => {
    const deps = makeDeps()
    const svc = new AuthService(deps)
    vi.mocked(runOAuthLogin).mockRejectedValue(new Error('OAuth device code expired'))

    svc.login('xai')
    await vi.waitFor(() => {
      expect(deps.events.some((e) => e.type === 'auth.error')).toBe(true)
    })

    expect(deps.events.find((e) => e.type === 'auth.error')?.payload).toEqual({
      providerId: 'xai', message: 'OAuth device code expired',
    })
    expect(deps.authStorage.set).not.toHaveBeenCalled()
    expect(deps.clearApiKey).not.toHaveBeenCalled()
  })

  it('token 永不出现在事件 payload（成功/错误都不含 access/refresh）', async () => {
    const deps = makeDeps()
    const svc = new AuthService(deps)
    vi.mocked(runOAuthLogin).mockImplementation(async () => oauthCred('SUPER-SECRET-TOKEN'))

    svc.login('xai')
    await vi.waitFor(() => {
      expect(deps.events.some((e) => e.type === 'auth.success')).toBe(true)
    })
    const serialized = JSON.stringify(deps.events)
    expect(serialized).not.toContain('SUPER-SECRET-TOKEN')
  })
})

describe('AuthService.cancel', () => {
  it('无进行中 flow → cancelled:false（幂等）', () => {
    const svc = new AuthService(makeDeps())
    expect(svc.cancel('xai')).toEqual({ cancelled: false })
  })

  it('有进行中 flow → cancelled:true + abort 触发，且不发 auth.error（用户主动取消非错误）', async () => {
    const deps = makeDeps()
    const svc = new AuthService(deps)
    let signal: AbortSignal | undefined
    vi.mocked(runOAuthLogin).mockImplementation(async (_id, _cfg, _hooks, sig) => {
      signal = sig
      return new Promise<OAuthCredential>((_resolve, reject) => {
        sig?.addEventListener('abort', () => reject(new Error('Login cancelled')))
      })
    })

    svc.login('xai')
    await vi.waitFor(() => {
      expect(signal).toBeDefined()
    })
    expect(svc.cancel('xai')).toEqual({ cancelled: true })

    // flow 因 abort 结束：没有 auth.error 事件
    await vi.waitFor(() => {
      expect(deps.events.some((e) => e.type === 'auth.error')).toBe(false)
    })
    // 结束后 activeFlows 已清空：再次 cancel 幂等返回 false
    await vi.waitFor(() => {
      expect(svc.cancel('xai')).toEqual({ cancelled: false })
    })
  })

  it('cancel 后立即重新 login 不被拒（activeFlows 同步清理，exec-review must-fix #1 回归）', async () => {
    const deps = makeDeps()
    const svc = new AuthService(deps)
    let signal: AbortSignal | undefined
    vi.mocked(runOAuthLogin).mockImplementation(async (_id, _cfg, _hooks, sig) => {
      signal = sig
      return new Promise<OAuthCredential>(() => {
        sig?.addEventListener('abort', () => {
          // 挂起模拟：abort 后 runFlow 的 finally 尚未执行（真实场景 abort 沿异步链传播有延迟）
        })
      })
    })

    svc.login('xai')
    await vi.waitFor(() => expect(signal).toBeDefined())
    expect(svc.cancel('xai')).toEqual({ cancelled: true })
    // 立即重新 login：必须成功（cancel 已同步清理 activeFlows）
    expect(svc.login('xai')).toEqual({ started: true })
    expect(svc.cancel('xai')).toEqual({ cancelled: true })
  })

  it('M4-01 ABA 防护：旧 flow finally 在 re-login 后执行，不得删除新 flow 条目', async () => {
    const deps = makeDeps()
    const svc = new AuthService(deps)
    let signal: AbortSignal | undefined
    vi.mocked(runOAuthLogin).mockImplementation(async (_id, _cfg, _hooks, sig) => {
      signal = sig
      return new Promise<OAuthCredential>((_resolve, reject) => {
        sig?.addEventListener('abort', () => {
          // 模拟 abort 沿异步链延迟传播（真实场景 cancel 落在 set() 的 proper-lockfile
          // 锁等待期，旧 flow 的 finally 要等锁释放后才执行）
          setTimeout(() => reject(new Error('Login cancelled')), 5)
        })
      })
    })

    svc.login('xai')
    await vi.waitFor(() => expect(signal).toBeDefined())
    expect(svc.cancel('xai')).toEqual({ cancelled: true })
    // cancel 同步清条目后立即 re-login：新 controller 入 Map（ABA 的 B 状态）
    expect(svc.login('xai')).toEqual({ started: true })

    // 等旧 flow 的 abort 传播完成、finally 已执行（旧条目已被 cancel 同步删除，
    // 此处 finally 执行的是对 Map 的第二次访问）
    await new Promise((resolve) => setTimeout(resolve, 30))

    // 关键断言：旧 finally 不得删除新 flow 条目——新 flow 必须仍可取消。
    // 无身份守卫时旧 finally 会把新条目一并删除，此处返回 cancelled:false，测试失败。
    expect(svc.cancel('xai')).toEqual({ cancelled: true })
    // 清理：确认两个 flow 均已收尾（无 auth.error——abort 是用户主动取消非错误）
    await vi.waitFor(() => {
      expect(deps.events.some((e) => e.type === 'auth.error')).toBe(false)
    })
  })

  it('S-7: cancel 落在「token 获取完成 → 写盘」窗口时不落盘、不发 auth.success', async () => {
    const deps = makeDeps()
    const svc = new AuthService(deps)
    let signal: AbortSignal | undefined
    vi.mocked(runOAuthLogin).mockImplementation(async (_id, _cfg, _hooks, sig) => {
      signal = sig
      // 挂起模拟：token exchange 已完成（拿到 credential），但 cancel 的 abort 信号先到
      return new Promise<OAuthCredential>((resolve) => {
        sig?.addEventListener('abort', () => resolve(oauthCred()))
      })
    })

    svc.login('xai')
    await vi.waitFor(() => expect(signal).toBeDefined())
    expect(svc.cancel('xai')).toEqual({ cancelled: true })

    // flow 在 abort 后带着已获取的 token 返回：不得写 auth.json / 清 apiKey / 广播 success
    await vi.waitFor(() => {
      expect(deps.authStorage.set).not.toHaveBeenCalled()
      expect(deps.clearApiKey).not.toHaveBeenCalled()
      expect(deps.events.some((e) => e.type === 'auth.success')).toBe(false)
    })
    // 结束后 activeFlows 已清空：再次 cancel 幂等返回 false
    await vi.waitFor(() => {
      expect(svc.cancel('xai')).toEqual({ cancelled: false })
    })
  })

  it('S-8: cancel 落在 set() 锁等待期间（凭据已写盘）时不广播 auth.success，且移除刚写入的凭据', async () => {
    const deps = makeDeps()
    const svc = new AuthService(deps)
    // 模拟 proper-lockfile 锁等待：set() 挂起直到测试主动释放（cancel 期间凭据已写盘）
    let releaseSet: (() => void) | undefined
    vi.mocked(deps.authStorage.set as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      await new Promise<void>((resolve) => {
        releaseSet = resolve
      })
    })
    vi.mocked(runOAuthLogin).mockImplementation(async () => oauthCred())

    svc.login('xai')
    // flow 已进入 set() 锁等待（凭据已写盘，broadcast 前）
    await vi.waitFor(() => {
      expect(deps.authStorage.set).toHaveBeenCalledWith('xai', expect.objectContaining({ type: 'oauth' }))
    })
    expect(svc.cancel('xai')).toEqual({ cancelled: true })
    // 释放锁：set() 返回后必须复查 abort——不得清 apiKey / 广播 success，且移除刚写入的凭据
    releaseSet?.()
    await vi.waitFor(() => {
      expect(deps.authStorage.remove).toHaveBeenCalledWith('xai')
      expect(deps.clearApiKey).not.toHaveBeenCalled()
      expect(deps.events.some((e) => e.type === 'auth.success')).toBe(false)
    })
    // 结束后 activeFlows 已清空：再次 cancel 幂等返回 false
    await vi.waitFor(() => {
      expect(svc.cancel('xai')).toEqual({ cancelled: false })
    })
  })
  it('委托 authStorage.hasOAuth', async () => {
    const deps = makeDeps()
    const svc = new AuthService(deps)
    vi.mocked(deps.authStorage.hasOAuth as ReturnType<typeof vi.fn>).mockResolvedValue(true)
    expect(await svc.hasOAuth('anthropic')).toBe(true)
    expect(deps.authStorage.hasOAuth).toHaveBeenCalledWith('anthropic')
  })
})

describe('AuthService.logout', () => {
  it('有进行中 flow → 先 cancel（abort 已生效）再 remove：调用序 cancel < authStorage.remove', async () => {
    const deps = makeDeps()
    const svc = new AuthService(deps)
    let signal: AbortSignal | undefined
    vi.mocked(runOAuthLogin).mockImplementation((_id, _cfg, _hooks, sig) => {
      signal = sig
      return new Promise(() => {}) // 挂起模拟进行中 flow
    })
    svc.login('xai')
    await vi.waitFor(() => expect(signal).toBeDefined())

    // remove 执行瞬间记录 abort 状态——「先 cancel 再 remove」的行为证据
    //（logout 的核心语义：防 remove 后 flow 完成把新凭证写回，见方法头注释 B-1 场景 C）
    let abortedAtRemove: boolean | undefined
    vi.mocked(deps.authStorage.remove).mockImplementation(async () => {
      abortedAtRemove = signal?.aborted
    })

    const cancelSpy = vi.spyOn(svc, 'cancel')
    await svc.logout('xai')

    expect(deps.authStorage.remove).toHaveBeenCalledTimes(1)
    expect(deps.authStorage.remove).toHaveBeenCalledWith('xai')
    expect(signal?.aborted).toBe(true)
    // 顺序断言（invocationCallOrder）：cancel 必须先于 authStorage.remove
    expect(cancelSpy.mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(deps.authStorage.remove).mock.invocationCallOrder[0])
    // remove 被调用时 abort 已生效（真正挡住「remove 后 flow 完成写回新凭证」的时序）
    expect(abortedAtRemove).toBe(true)
  })

  it('无 flow 无凭证 → 幂等委托：cancel 不报错（cancelled:false）+ remove 照调一次', async () => {
    const deps = makeDeps()
    const svc = new AuthService(deps)
    const cancelSpy = vi.spyOn(svc, 'cancel')
    await svc.logout('xai')
    expect(cancelSpy).toHaveBeenCalledTimes(1)
    expect(deps.authStorage.remove).toHaveBeenCalledTimes(1)
    expect(deps.authStorage.remove).toHaveBeenCalledWith('xai')
  })

  it('真实 AuthStorage：无凭证 logout 幂等且不物化空 auth.json；预置凭证后 logout 移除', async () => {
    // 用真实 AuthStorage（tmp 目录）断言 remove 自身 no-op 形态：auth.json 不存在时
    // 直接返回，不经 withFileLock 的 ensureFileExists 物化空文件（auth-storage.ts remove 注释）
    const dir = mkdtempSync(join(tmpdir(), 'auth-service-logout-'))
    try {
      const storage = new AuthStorage(join(dir, 'auth.json'))
      const deps = makeDeps({ authStorage: storage })
      const svc = new AuthService(deps)

      // 无凭证（auth.json 从未存在）：logout 不上抛、不物化文件，重复调用仍幂等
      await svc.logout('xai')
      await svc.logout('xai')
      expect(existsSync(join(dir, 'auth.json'))).toBe(false)

      // 预置凭证 → logout 后真被移除（get 回 undefined），其余 provider 不受影响
      await storage.set('xai', oauthCred())
      await storage.set('other', oauthCred())
      await svc.logout('xai')
      expect(await storage.get('xai')).toBeUndefined()
      expect(await storage.get('other')).toMatchObject({ type: 'oauth', access: 'at' })
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })
})
