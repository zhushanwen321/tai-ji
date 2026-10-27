import { PiConfigStore } from '../../../infra/pi/pi-config-store.js';
import { setModelsPath } from '../../../infra/pi/pi-provider-store.js';
import { ConfigService } from '../../config-service.js';
import type { ConfigModelsConfig, ConfigProviderConfig } from '../../ports/config.js';
import { AuthService, type AuthServiceDeps } from '../auth-service.js';
import { AuthStorage, setAuthLockMinRetryTimeoutForTest, type ApiKeyCredential, type Credential, type OAuthCredential } from '../auth-storage.js';
import { startCallbackServer } from '../callback-server.js';
import { type DeviceCodeInfo, runOAuthLogin } from '../oauth-flow.js';
import { generateChallenge, generateVerifier } from '../pkce.js';
import { ProviderCredentialResolver } from '../provider-credential-resolver.js';
import type { ServerMessage } from '@taiji/shared';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。

// ======================================================================
// ← src/services/auth/__tests__/auth-credential-gateway.test.ts
// ======================================================================

import type { ProviderCredentialResolverDeps } from '../provider-credential-resolver.js';
import type { BuiltinOAuthConfig } from '@taiji/shared';
let dir: string

let authPath: string

let authStorage: AuthStorage

let authService: AuthService


function makeAuthService(): AuthService {
  return new AuthService({
    authStorage,
    getOAuthConfig: () => undefined,
    broadcast: vi.fn(),
    nextPushId: vi.fn(() => 'evt-test'),
    clearApiKey: vi.fn(),
  })
}


function readAuthRaw(): Record<string, unknown> {
  if (!existsSync(authPath)) return {}
  return JSON.parse(readFileSync(authPath, 'utf-8'))
}

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('auth-credential-gateway', () => {
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'auth-credential-gateway-'))
  authPath = join(dir, 'auth.json')
  mkdirSync(dir, { recursive: true })
  authStorage = new AuthStorage(authPath)
  authService = makeAuthService()
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})
describe('A1-4 验收 4：getCredential 读通道（真实 auth.json）', () => {
  it('api_key 形态：返回 { type, key }', async () => {
    writeFileSync(authPath, JSON.stringify({
      'zai-coding-cn': { type: 'api_key', key: 'sk-taiji' },
    }), 'utf-8')

    const cred = await authService.getCredential('zai-coding-cn')

    expect(cred).toEqual({ type: 'api_key', key: 'sk-taiji' })
  })

  it('oauth 形态：返回 { type, access, ... }', async () => {
    writeFileSync(authPath, JSON.stringify({
      'kimi-coding': { type: 'oauth', access: 'at-token', refresh: 'rt', expires: 123 },
    }), 'utf-8')

    const cred = await authService.getCredential('kimi-coding')

    expect(cred).toMatchObject({ type: 'oauth', access: 'at-token' })
  })

  it('文件不存在 → undefined（不物化 auth.json）', async () => {
    await expect(authService.getCredential('anyone')).resolves.toBeUndefined()
    expect(existsSync(authPath)).toBe(false)
  })

  it('provider 无条目 → undefined', async () => {
    writeFileSync(authPath, JSON.stringify({ other: { type: 'api_key', key: 'k' } }), 'utf-8')
    await expect(authService.getCredential('missing')).resolves.toBeUndefined()
  })

  it('直读不缓存：外部写回新值后立即读到（pi refresh 写回语义，D6）', async () => {
    writeFileSync(authPath, JSON.stringify({
      xai: { type: 'oauth', access: 'old', expires: 1 },
    }), 'utf-8')
    expect((await authService.getCredential('xai'))?.type).toBe('oauth')

    // 模拟 pi 侧 resolveStoredOAuth 持锁刷新写回
    await authStorage.set('xai', { type: 'oauth', access: 'rotated', expires: 2 })

    const cred = await authService.getCredential('xai') as { access: string }
    expect(cred.access).toBe('rotated')
  })
})
describe('A1-4 验收 3：saveCredential 写通道（唯一写入口）', () => {
  it('经 AuthService.saveCredential 写入 auth.json（0600 + JSON 落盘）', async () => {
    await authService.saveCredential('zai-coding-cn', { type: 'api_key', key: 'sk-write' })

    expect(readAuthRaw()['zai-coding-cn']).toEqual({ type: 'api_key', key: 'sk-write' })
  })

  it('写入后 getCredential 立即可读（读写同通道闭环）', async () => {
    await authService.saveCredential('deepseek', { type: 'api_key', key: 'sk-loop' })
    await expect(authService.getCredential('deepseek')).resolves.toEqual({ type: 'api_key', key: 'sk-loop' })
  })
})
describe('A1-4 验收 3（全链路）：setProvider catalog apiKey → AuthService → auth.json 落盘', () => {
  it('catalog provider 保存 apiKey 经 credentialWriter（AuthService）写 auth.json，models.json 不物化条目', async () => {
    // models.json 指向临时目录（隔离本机真实配置）；anthropic 是 builtin catalog provider
    setModelsPath(join(dir, 'models.json'))
    writeFileSync(join(dir, 'models.json'), JSON.stringify({ providers: {} }), 'utf-8')
    const configStore = new PiConfigStore()
    const svc = new ConfigService('/tmp/project', configStore, authStorage)
    // 组合根模式：AuthService 构造后经 setter 回填（index.ts 同款）
    svc.setCredentialWriter(authService)

    await svc.setProvider('anthropic', { apiKey: 'sk-secret' })

    // 物理读 auth.json：凭据经 AuthService 唯一写入口落盘
    expect(readAuthRaw()['anthropic']).toEqual({ type: 'api_key', key: 'sk-secret' })
    // models.json 不物化空壳条目（防线③：catalog apiKey 只归 auth.json；无既有条目 → 不落盘）
    const models = JSON.parse(readFileSync(join(dir, 'models.json'), 'utf-8')).providers as Record<string, Record<string, unknown>>
    expect(models.anthropic).toBeUndefined()
  })
})
});

// ======================================================================
// ← src/services/auth/__tests__/auth-service.test.ts
// ======================================================================

// mock oauth-flow：让测试聚焦 AuthService 编排，不触发真实网络
vi.mock('../oauth-flow.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../oauth-flow.js')>()
  return { ...actual, runOAuthLogin: vi.fn(), }
})


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

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('auth-service', () => {
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
    }, { interval: 1 })

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
    }, { interval: 1 })

    expect(deps.events.find((e) => e.type === 'auth.error')?.payload).toEqual({
      providerId: 'xai', message: 'OAuth device code expired',
    })
    expect(deps.authStorage.set).not.toHaveBeenCalled()
    expect(deps.clearApiKey).not.toHaveBeenCalled()
  })

  it('onAuthenticated：flow 成功写盘 + auth.success 后恰调用一次（凭据域变更事件，MF-2）', async () => {
    const deps = makeDeps()
    const svc = new AuthService(deps)
    vi.mocked(runOAuthLogin).mockImplementation(async () => oauthCred())
    const onAuthenticated = vi.fn()

    svc.login('xai', onAuthenticated)
    await vi.waitFor(() => expect(onAuthenticated).toHaveBeenCalledTimes(1), { interval: 1 })
    // 回调时点 = 凭据已落盘 + 成功事件已广播（消费方按 auth.json 现状重跑）
    expect(deps.authStorage.set).toHaveBeenCalled()
    expect(deps.events.some((e) => e.type === 'auth.success')).toBe(true)
    expect(deps.events[deps.events.length - 1]?.type).toBe('auth.success')
  })

  it('onAuthenticated：flow 失败 / 用户取消 → 不调用', async () => {
    const failedDeps = makeDeps()
    const failed = new AuthService(failedDeps)
    vi.mocked(runOAuthLogin).mockRejectedValue(new Error('OAuth device code expired'))
    const onAuthenticated = vi.fn()

    failed.login('xai', onAuthenticated)
    await vi.waitFor(() => {
      expect(failedDeps.events.some((e) => e.type === 'auth.error')).toBe(true)
    }, { interval: 1 })
    expect(onAuthenticated).not.toHaveBeenCalled()
  })

  it('onAuthenticated 抛错不污染 flow 终态（不广播 auth.error，凭据已落盘）', async () => {
    const deps = makeDeps()
    const svc = new AuthService(deps)
    vi.mocked(runOAuthLogin).mockImplementation(async () => oauthCred())
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    svc.login('xai', () => { throw new Error('consumer boom') })
    await vi.waitFor(() => {
      expect(deps.events.some((e) => e.type === 'auth.success')).toBe(true)
    }, { interval: 1 })
    expect(deps.events.some((e) => e.type === 'auth.error')).toBe(false)
    expect(warn).toHaveBeenCalledWith('[auth-service] onAuthenticated callback failed for xai:', expect.any(Error))
    warn.mockRestore()
  })

  it('token 永不出现在事件 payload（成功/错误都不含 access/refresh）', async () => {
    const deps = makeDeps()
    const svc = new AuthService(deps)
    vi.mocked(runOAuthLogin).mockImplementation(async () => oauthCred('SUPER-SECRET-TOKEN'))

    svc.login('xai')
    await vi.waitFor(() => {
      expect(deps.events.some((e) => e.type === 'auth.success')).toBe(true)
    }, { interval: 1 })
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
    }, { interval: 1 })
    expect(svc.cancel('xai')).toEqual({ cancelled: true })

    // flow 因 abort 结束：没有 auth.error 事件
    await vi.waitFor(() => {
      expect(deps.events.some((e) => e.type === 'auth.error')).toBe(false)
    }, { interval: 1 })
    // 结束后 activeFlows 已清空：再次 cancel 幂等返回 false
    await vi.waitFor(() => {
      expect(svc.cancel('xai')).toEqual({ cancelled: false })
    }, { interval: 1 })
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
    await vi.waitFor(() => expect(signal).toBeDefined(), { interval: 1 })
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
    await vi.waitFor(() => expect(signal).toBeDefined(), { interval: 1 })
    expect(svc.cancel('xai')).toEqual({ cancelled: true })
    // cancel 同步清条目后立即 re-login：新 controller 入 Map（ABA 的 B 状态）
    expect(svc.login('xai')).toEqual({ started: true })

    // 等旧 flow 的 abort 传播完成、finally 已执行（旧条目已被 cancel 同步删除，
    // 此处 finally 执行的是对 Map 的第二次访问）
    await new Promise((resolve) => setTimeout(resolve, 30))

    // 关键断言：旧 finally 不得删除新 flow 条目——新 flow 必须仍可取消。
    // 无身份检查时旧 finally 会把新条目一并删除，此处返回 cancelled:false，测试失败。
    expect(svc.cancel('xai')).toEqual({ cancelled: true })
    // 清理：确认两个 flow 均已收尾（无 auth.error——abort 是用户主动取消非错误）
    await vi.waitFor(() => {
      expect(deps.events.some((e) => e.type === 'auth.error')).toBe(false)
    }, { interval: 1 })
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
    await vi.waitFor(() => expect(signal).toBeDefined(), { interval: 1 })
    expect(svc.cancel('xai')).toEqual({ cancelled: true })

    // flow 在 abort 后带着已获取的 token 返回：不得写 auth.json / 清 apiKey / 广播 success
    await vi.waitFor(() => {
      expect(deps.authStorage.set).not.toHaveBeenCalled()
      expect(deps.clearApiKey).not.toHaveBeenCalled()
      expect(deps.events.some((e) => e.type === 'auth.success')).toBe(false)
    }, { interval: 1 })
    // 结束后 activeFlows 已清空：再次 cancel 幂等返回 false
    await vi.waitFor(() => {
      expect(svc.cancel('xai')).toEqual({ cancelled: false })
    }, { interval: 1 })
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
    }, { interval: 1 })
    expect(svc.cancel('xai')).toEqual({ cancelled: true })
    // 释放锁：set() 返回后必须复查 abort——不得清 apiKey / 广播 success，且移除刚写入的凭据
    releaseSet?.()
    await vi.waitFor(() => {
      expect(deps.authStorage.remove).toHaveBeenCalledWith('xai')
      expect(deps.clearApiKey).not.toHaveBeenCalled()
      expect(deps.events.some((e) => e.type === 'auth.success')).toBe(false)
    }, { interval: 1 })
    // 结束后 activeFlows 已清空：再次 cancel 幂等返回 false
    await vi.waitFor(() => {
      expect(svc.cancel('xai')).toEqual({ cancelled: false })
    }, { interval: 1 })
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
    await vi.waitFor(() => expect(signal).toBeDefined(), { interval: 1 })

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
});

// ======================================================================
// ← src/services/auth/__tests__/auth-storage.test.ts
// ======================================================================

let dir_m2: string

let file: string

let storage: AuthStorage


function oauthCred_m2(access: string, expires = 1_000): OAuthCredential {
  return { type: 'oauth', access, expires }
}


function apiKeyCred(key: string, env?: Record<string, string>): ApiKeyCredential {
  return env ? { type: 'api_key', key, env } : { type: 'api_key', key }
}

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('auth-storage', () => {
beforeEach(() => {
  dir_m2 = mkdtempSync(join(tmpdir(), 'auth-storage-'))
  file = join(dir_m2, 'auth.json')
  storage = new AuthStorage(file)
})
afterEach(() => {
  // 退避下限注入只服务并发用例：逐例复位，避免压缩退避泄漏到后续用例
  setAuthLockMinRetryTimeoutForTest(undefined)
  rmSync(dir_m2, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})
describe('AuthStorage', () => {
  it('set 后 get 返回完整 credential', async () => {
    await storage.set('provider-a', oauthCred_m2('token-1'))
    expect(await storage.get('provider-a')).toMatchObject({ type: 'oauth', access: 'token-1', expires: 1_000 })
  })

  it('set 不同 provider 不互相覆盖（RMW merge）', async () => {
    await storage.set('a', oauthCred_m2('t1'))
    await storage.set('b', oauthCred_m2('t2'))
    expect(await storage.get('a')).toMatchObject({ access: 't1' })
    expect(await storage.get('b')).toMatchObject({ access: 't2' })
    expect(await storage.hasOAuth('a')).toBe(true)
    expect(await storage.hasOAuth('missing')).toBe(false)
  })

  it('同 provider 重复 set 覆盖旧值', async () => {
    await storage.set('a', oauthCred_m2('old'))
    await storage.set('a', oauthCred_m2('new'))
    expect(await storage.get('a')).toMatchObject({ access: 'new' })
  })

  it('并发 set 多个 provider：全部保留（mutex 串行化 RMW）', async () => {
    // 压缩等锁退避（下限 5ms，默认 100ms）：断言对象是「并发写全部保留」，
    // 退避时长不是被测契约（默认值由 utils/file-lock.ts 常量与 pi 侧对齐测试保护）
    setAuthLockMinRetryTimeoutForTest(5)
    await Promise.all(
      Array.from({ length: 10 }, (_, i) => storage.set(`p${i}`, oauthCred_m2(`t${i}`))),
    )
    const all = await storage.getAll()
    expect(Object.keys(all)).toHaveLength(10)
    for (let i = 0; i < 10; i++) {
      expect(all[`p${i}`]).toMatchObject({ access: `t${i}` })
    }
  })

  it('写入后文件权限为 0600', async () => {
    await storage.set('a', oauthCred_m2('t1'))
    const stat = statSync(file)
    expect(stat.mode & 0o777).toBe(0o600)
  })

  it('remove 幂等：不存在时再次 remove 不抛错', async () => {
    await storage.set('a', oauthCred_m2('t1'))
    await storage.remove('a')
    expect(await storage.get('a')).toBeUndefined()
    await storage.remove('a')
    await storage.remove('never-existed')
    expect(await storage.get('a')).toBeUndefined()
  })

  it('remove 在文件不存在时不物化 auth.json（从未使用 OAuth 不产生文件）', async () => {
    await storage.remove('never-existed')
    expect(existsSync(file)).toBe(false)
  })

  it('文件不存在时 get 返回 undefined、getAll 返回空对象', async () => {
    expect(await storage.get('nope')).toBeUndefined()
    expect(await storage.getAll()).toEqual({})
  })

  it('M4-02: 损坏 JSON 读路径降级——get/hasCredentialSync/listCredentialIds 全部不抛（pi 原地写/撕裂读容忍）', async () => {
    writeFileSync(file, '{ not valid json')
    // 读路径全部降级：不抛错，按空凭据处理
    expect(await storage.get('a')).toBeUndefined()
    expect(await storage.getAll()).toEqual({})
    expect(storage.hasCredentialSync('a')).toBe(false)
    expect(storage.hasOAuthSync('a')).toBe(false)
    expect(storage.listCredentialIds()).toEqual([])
  })

  it('损坏 JSON：写路径保留抛错（RMW 重读时发现损坏，静默覆盖会丢数据）', async () => {
    writeFileSync(file, '{ not valid json')
    await expect(storage.set('a', oauthCred_m2('t1'))).rejects.toThrow()
    await expect(storage.remove('a')).rejects.toThrow()
  })

  it('空文件内容按空对象处理', async () => {
    writeFileSync(file, '')
    expect(await storage.getAll()).toEqual({})
  })

  // ---- ApiKeyCredential 类型扩展 (TC1-TC7) ----

  it('TC1: set ApiKeyCredential 后 get 返回完整 credential', async () => {
    await storage.set('zai', apiKeyCred('a275...'))
    const result = await storage.get('zai')
    expect(result).toMatchObject({ type: 'api_key', key: 'a275...' })
  })

  it('TC2: api_key + oauth 不同 provider 不互相覆盖（RMW merge）', async () => {
    await storage.set('catalog-prov', apiKeyCred('k1'))
    await storage.set('oauth-prov', oauthCred_m2('t2'))
    const all = await storage.getAll()
    expect(Object.keys(all)).toHaveLength(2)
    expect(all['catalog-prov']).toMatchObject({ type: 'api_key', key: 'k1' })
    expect(all['oauth-prov']).toMatchObject({ type: 'oauth', access: 't2' })
  })

  it('TC3: hasCredentialSync 对 api_key 返回 true，缺失返回 false', async () => {
    await storage.set('zai', apiKeyCred('sk-xxx'))
    expect(storage.hasCredentialSync('zai')).toBe(true)
    expect(storage.hasCredentialSync('missing')).toBe(false)
  })

  it('TC4: hasCredentialSync 对 oauth 返回 true（向后兼容）', async () => {
    await storage.set('anthropic', oauthCred_m2('tok'))
    expect(storage.hasCredentialSync('anthropic')).toBe(true)
  })

  it('TC5: 同 provider api_key 覆盖已有 oauth', async () => {
    await storage.set('x', oauthCred_m2('old-oauth'))
    await storage.set('x', apiKeyCred('new-apikey'))
    const result = await storage.get('x')
    expect(result).toMatchObject({ type: 'api_key', key: 'new-apikey' })
  })

  it('TC6: api_key 写入后文件权限为 0600', async () => {
    await storage.set('zai', apiKeyCred('secret'))
    const stat = statSync(file)
    expect(stat.mode & 0o777).toBe(0o600)
  })

  it('TC7: api_key key 字段保留原形态（$ENV / !cmd）', async () => {
    await storage.set('zai', apiKeyCred('$ENV:ZAI_API_KEY'))
    const result = await storage.get('zai')
    expect(result).toMatchObject({ type: 'api_key', key: '$ENV:ZAI_API_KEY' })
  })

  it('TC7b: api_key env 字段保留', async () => {
    await storage.set('zai', apiKeyCred('k1', { FOO: 'bar' }))
    const result = await storage.get('zai')
    expect(result).toMatchObject({ type: 'api_key', key: 'k1', env: { FOO: 'bar' } })
  })
})
});

// ======================================================================
// ← src/services/auth/__tests__/callback-server.test.ts
// ======================================================================

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('callback-server', () => {
describe('startCallbackServer', () => {
  it('完整成功路径：200 + resolve { code, state }', async () => {
    const server = await startCallbackServer({ port: 0, path: '/callback', expectedState: 's1' })
    try {
      const p = server.waitForCallback()
      const res = await fetch(`${server.url}?code=AUTH_CODE&state=s1`)
      expect(res.status).toBe(200)
      await expect(p).resolves.toEqual({ code: 'AUTH_CODE', state: 's1' })
    } finally {
      server.close()
    }
  })

  it('state 不匹配：400 + reject state_mismatch，不 resolve', async () => {
    const server = await startCallbackServer({ port: 0, path: '/callback', expectedState: 's1' })
    try {
      const p = server.waitForCallback()
      const res = await fetch(`${server.url}?code=AUTH_CODE&state=wrong`)
      expect(res.status).toBe(400)
      await expect(p).rejects.toMatchObject({ code: 'state_mismatch' })
    } finally {
      server.close()
    }
  })

  it('error query：400 + reject provider_error', async () => {
    const server = await startCallbackServer({ port: 0, path: '/callback' })
    try {
      const p = server.waitForCallback()
      const res = await fetch(`${server.url}?error=access_denied`)
      expect(res.status).toBe(400)
      await expect(p).rejects.toMatchObject({ code: 'provider_error' })
    } finally {
      server.close()
    }
  })

  it('缺 code：400 + reject', async () => {
    const server = await startCallbackServer({ port: 0, path: '/callback' })
    try {
      const p = server.waitForCallback()
      const res = await fetch(`${server.url}?state=s1`)
      expect(res.status).toBe(400)
      await expect(p).rejects.toMatchObject({ code: 'missing_params' })
    } finally {
      server.close()
    }
  })

  it('expectedState 未传：code-only 回调（无 state）放行 200（openrouter 场景）', async () => {
    const server = await startCallbackServer({ port: 0, path: '/callback' })
    try {
      const p = server.waitForCallback()
      const res = await fetch(`${server.url}?code=ONLY_CODE`)
      expect(res.status).toBe(200)
      await expect(p).resolves.toEqual({ code: 'ONLY_CODE', state: undefined })
    } finally {
      server.close()
    }
  })

  it('非回调路径：404，不影响 waitForCallback 继续等待', async () => {
    const server = await startCallbackServer({ port: 0, path: '/callback', expectedState: 's1' })
    try {
      const p = server.waitForCallback()
      const res = await fetch(`${server.url.replace('/callback', '/other')}?code=X&state=s1`)
      expect(res.status).toBe(404)

      // 路径错误不消费回调，正确路径仍可成功
      const res2 = await fetch(`${server.url}?code=OK&state=s1`)
      expect(res2.status).toBe(200)
      await expect(p).resolves.toEqual({ code: 'OK', state: 's1' })
    } finally {
      server.close()
    }
  })

  it('超时：timeoutMs 到期 reject { code: timeout }', async () => {
    const server = await startCallbackServer({ port: 0, path: '/callback', timeoutMs: 80 })
    try {
      const p = server.waitForCallback()
      await expect(p).rejects.toMatchObject({ code: 'timeout' })
    } finally {
      server.close()
    }
  })

  it('abort：signal 中断 reject { code: aborted }', async () => {
    const ac = new AbortController()
    const server = await startCallbackServer({ port: 0, path: '/callback', signal: ac.signal })
    try {
      const p = server.waitForCallback()
      ac.abort()
      await expect(p).rejects.toMatchObject({ code: 'aborted' })
    } finally {
      server.close()
    }
  })

  it('单次消费：第二个请求返回 409 claimed', async () => {
    const server = await startCallbackServer({ port: 0, path: '/callback', expectedState: 's1' })
    try {
      const p = server.waitForCallback()
      const res1 = await fetch(`${server.url}?code=FIRST&state=s1`)
      expect(res1.status).toBe(200)
      await expect(p).resolves.toEqual({ code: 'FIRST', state: 's1' })

      const res2 = await fetch(`${server.url}?code=SECOND&state=s1`)
      expect(res2.status).toBe(409)
    } finally {
      server.close()
    }
  })

  it('close() 幂等，可重复调用', async () => {
    const server = await startCallbackServer({ port: 0, path: '/callback' })
    server.close()
    expect(() => server.close()).not.toThrow()
  })

  it('M4-03: listen EADDRINUSE → reject listen_failed + 可操作文案（端口被占提示）', async () => {
    // 先占住一个端口，再同端口 listen 必然 EADDRINUSE
    const blocker = await startCallbackServer({ port: 0, path: '/block' })
    const ac = new AbortController()
    try {
      await expect(startCallbackServer({ port: blocker.port, path: '/callback', signal: ac.signal }))
        .rejects.toMatchObject({
          code: 'listen_failed',
          message: expect.stringMatching(/端口 \d+ 被占用，请关闭另一个 TaiJi 实例后重试/),
        })
      // reject 后 abort 不抛（监听已摘除）；timer 已清不留悬挂
      ac.abort()
    } finally {
      blocker.close()
    }
  })
})
});

// ======================================================================
// ← src/services/auth/__tests__/pkce.test.ts
// ======================================================================

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('pkce', () => {
describe('pkce', () => {
  it('verifier 是 32 字节 base64url 无 padding（43 字符，字符集受限）', () => {
    const verifier = generateVerifier()
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })

  it('challenge 与手工 SHA-256 base64url 一致', async () => {
    const verifier = 'test-verifier-0123456789abcdefghijklmnopqrstuvw'
    const expected = createHash('sha256').update(verifier).digest('base64url')
    expect(await generateChallenge(verifier)).toBe(expected)
  })

  it('两次生成的 verifier 随机不同', () => {
    expect(generateVerifier()).not.toBe(generateVerifier())
  })

  it('challenge 无 padding（不以 = 结尾）', async () => {
    const challenge = await generateChallenge(generateVerifier())
    expect(challenge.endsWith('=')).toBe(false)
  })
})
});

// ======================================================================
// ← src/services/auth/__tests__/provider-credential-resolver.test.ts
// ======================================================================

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('provider-credential-resolver', () => {
describe('provider-credential-resolver', () => {
/**
 * Provider 凭据解析唯一通道单测（tmp 目录真实文件，全程不碰真实数据目录）。
 *
 * 覆盖：双源优先级（auth.json 命中优先于 models.json）/ 单源命中 / 双源皆无 /
 * 同步存在性判定 / 批量并集且单次读（spy 计数，非 N+1）/ oauth 取 access 且 kind='oauth'
 * （短时 token 形态判别，MF-2）/ P-cred 探针（`$ENV_VAR` 配置值形态的实测输出与采取分支）。
 *
 * ── P-cred 探针结论（设计 §3.6 实施期门，实测 2026-09-10）──
 * ① taiji 侧「不展开」：AuthStorage.get 原样返回 auth.json 的 JSON 解析结果，无任何配置值
 *    解析（packages/runtime/src/services/auth/auth-storage_m2.ts:126-128；既有用例
 *    auth-storage_m2.test.ts:155-159「api_key key 字段保留原形态」是同事实的旁证）。
 *    models.json 侧同理（IConfigStore.getProviderConfig 直接返回落盘值）。
 * ② pi 侧「展开」：pi 读 auth.json api_key 时经 resolveConfigValue 解析
 *    （node_modules/@earendil-works/pi-coding-agent/dist/core/auth-storage_m2.js:213-216 调用，
 *    实现在 dist/core/resolve-config-value.js:123-129）——`$ENV`/`${ENV}` 模板展开、
 *    `!` 前缀当 shell 命令执行、`$$`/`$!` 转义；任一 env 引用缺失则整值 undefined。
 * ③ 采取分支（降级路径）：resolver 对 `$ENV_VAR` / `${ENV_VAR}` 自行用 process.env 展开
 *    （credential.env 优先，与 pi resolve-config-value.js:71-73 同语义）；command（`!` 前缀）
 *    首版不支持且**不执行 shell**，与「env 引用缺失」一起返回 { unsupported } 判别结构
 *    （RT-7#4），由消费方报「该凭据形态暂不支持」且禁止把形态标记当 key 下发外部请求。
 *    下方 "P-cred" 用例组即该分支的回归断言。
 */
let dir_m3: string
let authPath_m2: string
let modelsPath: string
let storage_m2: AuthStorage

function writeAuthFile(credentials: Record<string, Credential>): void {
  writeFileSync(authPath_m2, JSON.stringify(credentials, null, 2))
}

function writeModelsFile(providers: Record<string, { apiKey?: string }>): void {
  writeFileSync(modelsPath, JSON.stringify({ providers }, null, 2))
}

function readModelsFile(): ConfigModelsConfig {
  return JSON.parse(readFileSync(modelsPath, 'utf-8')) as ConfigModelsConfig
}

/** deps 工厂：auth.json 走真实 AuthStorage（async 经 AuthService 收敛通道 + sync 同步原语），
 * models.json 走计数 fake（断言批量形态单次读）。 */
function makeDeps_m2(): ProviderCredentialResolverDeps & { readModels: ReturnType<typeof vi.fn> } {
  const readModels = vi.fn((): ConfigModelsConfig => readModelsFile())
  return {
    authService: { getCredential: (providerId: string) => storage_m2.get(providerId) },
    authStorage: storage_m2,
    configStore: {
      readModels,
      getProviderConfig: (providerId: string) => readModelsFile().providers[providerId],
    },
    readModels,
  }
}

beforeEach(() => {
  dir_m3 = mkdtempSync(join(tmpdir(), 'provider-credential-resolver-'))
  authPath_m2 = join(dir_m3, 'auth.json')
  modelsPath = join(dir_m3, 'models.json')
  storage_m2 = new AuthStorage(authPath_m2)
  writeAuthFile({})
  writeModelsFile({})
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  rmSync(dir_m3, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

describe('ProviderCredentialResolver 双源优先级', () => {
  it('两源同时存在：返回 auth.json 的 key 且 source === "auth.json"（优先级断言）', async () => {
    writeAuthFile({ 'catalog-prov': { type: 'api_key', key: 'sk-from-auth' } })
    writeModelsFile({ 'catalog-prov': { apiKey: 'sk-from-models' } })
    const resolver = new ProviderCredentialResolver(makeDeps_m2())

    expect(await resolver.resolveProviderCredential('catalog-prov')).toEqual({
      key: 'sk-from-auth',
      source: 'auth.json',
      kind: 'api_key',
    })
  })

  it('仅 models.json 有：source === "models.json"（custom 凭据源）', async () => {
    writeModelsFile({ 'custom-prov': { apiKey: 'sk-custom' } })
    const resolver = new ProviderCredentialResolver(makeDeps_m2())

    expect(await resolver.resolveProviderCredential('custom-prov')).toEqual({
      key: 'sk-custom',
      source: 'models.json',
      kind: 'api_key',
    })
  })

  it('两源皆无：resolve 返回 undefined、hasProviderCredential 返回 false', async () => {
    const resolver = new ProviderCredentialResolver(makeDeps_m2())

    expect(await resolver.resolveProviderCredential('nowhere')).toBeUndefined()
    expect(resolver.hasProviderCredential('nowhere')).toBe(false)
  })

  it('hasProviderCredential：两源任一命中即 true（存在性判定，含 oauth 条目）', async () => {
    writeAuthFile({ 'oauth-prov': { type: 'oauth', access: 'tok', expires: 1_000 } })
    writeModelsFile({ 'custom-prov': { apiKey: 'sk-custom' }, 'empty-prov': { apiKey: '' } })
    const resolver = new ProviderCredentialResolver(makeDeps_m2())

    expect(resolver.hasProviderCredential('oauth-prov')).toBe(true)
    expect(resolver.hasProviderCredential('custom-prov')).toBe(true)
    // 空串是 pi schema 违规值（等同无凭据），不计入
    expect(resolver.hasProviderCredential('empty-prov')).toBe(false)
  })

  it('oauth 凭据取 access 明文 + kind="oauth"（不带配置值解析，与 pi 对 oauth 的处置一致）', async () => {
    writeAuthFile({ 'oauth-prov': { type: 'oauth', access: '$NOT_AN_ENV_REF', expires: 1_000 } })
    const resolver = new ProviderCredentialResolver(makeDeps_m2())

    expect(await resolver.resolveProviderCredential('oauth-prov')).toEqual({
      key: '$NOT_AN_ENV_REF',
      source: 'auth.json',
      kind: 'oauth',
    })
  })
})

describe('ProviderCredentialResolver 回显原值（resolveProviderApiKeyRaw）', () => {
  it('auth.json api_key：返回所存原值，$ENV 引用不展开（回显语义 = 用户所存值）', async () => {
    vi.stubEnv('REVEAL_KEY_ENV', 'sk-resolved-from-env')
    writeAuthFile({ 'auth-prov': { type: 'api_key', key: '$REVEAL_KEY_ENV' } })
    const resolver = new ProviderCredentialResolver(makeDeps_m2())

    expect(await resolver.resolveProviderApiKeyRaw('auth-prov')).toEqual({
      apiKey: '$REVEAL_KEY_ENV',
      source: 'auth.json',
    })
  })

  it('两源同时有 api_key：auth.json 优先（与 resolveProviderCredential 同一优先级）', async () => {
    writeAuthFile({ both: { type: 'api_key', key: 'sk-auth' } })
    writeModelsFile({ both: { apiKey: 'sk-models' } })
    const resolver = new ProviderCredentialResolver(makeDeps_m2())

    expect(await resolver.resolveProviderApiKeyRaw('both')).toEqual({ apiKey: 'sk-auth', source: 'auth.json' })
  })

  it('auth.json 是 oauth + models.json 有 apiKey：不回落（不显示低优先源的历史残留值）', async () => {
    writeAuthFile({ mixed: { type: 'oauth', access: 'oauth-access-token', expires: 1_000 } })
    writeModelsFile({ mixed: { apiKey: 'sk-stale-models' } })
    const resolver = new ProviderCredentialResolver(makeDeps_m2())

    // resolveProviderCredential 会返回 oauth 的 access（另一消费面），回显面结构性排除
    expect(await resolver.resolveProviderCredential('mixed')).toEqual({
      key: 'oauth-access-token',
      kind: 'oauth',
      source: 'auth.json',
    })
    expect(await resolver.resolveProviderApiKeyRaw('mixed')).toBeUndefined()
  })

  it('oauth-only / 两源皆无：undefined（available:false 的判定锚）', async () => {
    writeAuthFile({ 'oauth-only': { type: 'oauth', access: 'tok', expires: 1_000 } })
    const resolver = new ProviderCredentialResolver(makeDeps_m2())

    expect(await resolver.resolveProviderApiKeyRaw('oauth-only')).toBeUndefined()
    expect(await resolver.resolveProviderApiKeyRaw('nowhere')).toBeUndefined()
  })

  it('models.json apiKey：原值透传（custom 定义权威，不展开 $ENV）', async () => {
    writeModelsFile({ custom: { apiKey: '${CUSTOM_KEY}' } })
    const resolver = new ProviderCredentialResolver(makeDeps_m2())

    expect(await resolver.resolveProviderApiKeyRaw('custom')).toEqual({
      apiKey: '${CUSTOM_KEY}',
      source: 'models.json',
    })
  })

  it('`!cmd` 形态：回显返回原串（不执行 shell），常规解析返回 unsupported=command（SG-9）', async () => {
    writeAuthFile({ cmd: { type: 'api_key', key: '!printf sk-auth' } })
    writeModelsFile({ 'cmd-models': { apiKey: '!echo sk-models' } })
    const resolver = new ProviderCredentialResolver(makeDeps_m2())

    // 回显面 = 用户所存配置串，原样展示；常规解析面拒绝执行并报形态不支持
    expect(await resolver.resolveProviderApiKeyRaw('cmd')).toEqual({
      apiKey: '!printf sk-auth',
      source: 'auth.json',
    })
    expect(await resolver.resolveProviderCredential('cmd')).toEqual({ unsupported: 'command' })
    expect(await resolver.resolveProviderApiKeyRaw('cmd-models')).toEqual({
      apiKey: '!echo sk-models',
      source: 'models.json',
    })
    expect(await resolver.resolveProviderCredential('cmd-models')).toEqual({ unsupported: 'command' })
  })
})

describe('ProviderCredentialResolver 批量 sync 形态', () => {
  it('listCredentialBackedProviderIds 返回两源并集且各自只读一次（非 N+1 读盘）', () => {
    writeAuthFile({
      catalogA: { type: 'api_key', key: 'k1' },
      oauthB: { type: 'oauth', access: 'tok', expires: 1_000 },
    })
    writeModelsFile({ customC: { apiKey: 'k2' }, customD: { apiKey: '' }, customE: {} })
    const listIdsSpy = vi.spyOn(storage_m2, 'listCredentialIds')
    const deps = makeDeps_m2()
    const resolver = new ProviderCredentialResolver(deps)

    const ids = resolver.listCredentialBackedProviderIds()

    expect(ids).toEqual(new Set(['catalogA', 'oauthB', 'customC']))
    // 单次读断言：auth.json 一次 listCredentialIds、models.json 一次 readModels
    expect(listIdsSpy).toHaveBeenCalledTimes(1)
    expect(deps.readModels).toHaveBeenCalledTimes(1)
  })
})

describe('P-cred 探针：$ENV_VAR / command 配置值形态的解析行为', () => {
  it('auth.json 内 $ENV_VAR 原样保留（taiji 侧不展开，探针①），resolver 用 process.env 展开（采取分支）', async () => {
    vi.stubEnv('TAIJI_CRED_PROBE_KEY', 'sk-probe-123')
    writeAuthFile({ 'env-prov': { type: 'api_key', key: '$TAIJI_CRED_PROBE_KEY' } })
    const resolver = new ProviderCredentialResolver(makeDeps_m2())

    // 探针①复现：AuthStorage 通道读到的是未展开的原文
    expect(await storage_m2.get('env-prov')).toMatchObject({ key: '$TAIJI_CRED_PROBE_KEY' })
    // 降级路径实测输出：resolver 展开为明文
    expect(await resolver.resolveProviderCredential('env-prov')).toEqual({
      key: 'sk-probe-123',
      source: 'auth.json',
      kind: 'api_key',
    })
  })

  it('${ENV_VAR} 形态同样展开，且 credential.env 优先于 process.env（pi 同语义）', async () => {
    vi.stubEnv('TAIJI_CRED_PROBE_KEY', 'sk-from-process')
    writeAuthFile({
      'env-prov': { type: 'api_key', key: '${TAIJI_CRED_PROBE_KEY}-suffix', env: { TAIJI_CRED_PROBE_KEY: 'sk-from-cred' } },
    })
    const resolver = new ProviderCredentialResolver(makeDeps_m2())

    expect(await resolver.resolveProviderCredential('env-prov')).toEqual({
      key: 'sk-from-cred-suffix',
      source: 'auth.json',
      kind: 'api_key',
    })
  })

  it('env 引用缺失 → { unsupported: "unresolved-env" }（RT-7#4：不再与「无凭据」的 undefined 混同）', async () => {
    writeAuthFile({ 'env-prov': { type: 'api_key', key: '$TAIJI_CRED_PROBE_MISSING' } })
    const resolver = new ProviderCredentialResolver(makeDeps_m2())

    expect(await resolver.resolveProviderCredential('env-prov')).toEqual({ unsupported: 'unresolved-env' })
  })

  it('非变量的字面 $ 不作展开（如 $1abc 保持字面）', async () => {
    writeAuthFile({ literal: { type: 'api_key', key: '$1abc' } })
    const resolver = new ProviderCredentialResolver(makeDeps_m2())

    expect(await resolver.resolveProviderCredential('literal')).toEqual({ key: '$1abc', source: 'auth.json', kind: 'api_key' })
  })

  it('command 形态（! 前缀）不执行 shell，返回 { unsupported: "command" } 判别结构', async () => {
    writeAuthFile({ 'cmd-prov': { type: 'api_key', key: '!echo sk-from-command' } })
    const resolver = new ProviderCredentialResolver(makeDeps_m2())

    expect(await resolver.resolveProviderCredential('cmd-prov')).toEqual({ unsupported: 'command' })
  })

  it('command 形态命中即不降级 models.json（高优先源显式配置错误不被低优先源静默接住，RT-7#4）', async () => {
    writeAuthFile({ 'cmd-prov': { type: 'api_key', key: '!echo sk' } })
    writeModelsFile({ 'cmd-prov': { apiKey: 'sk-plaintext-in-models' } })
    const resolver = new ProviderCredentialResolver(makeDeps_m2())

    expect(await resolver.resolveProviderCredential('cmd-prov')).toEqual({ unsupported: 'command' })
  })

  it('unresolved-env 同样不降级 models.json', async () => {
    writeAuthFile({ 'env-prov': { type: 'api_key', key: '$TAIJI_CRED_PROBE_MISSING' } })
    writeModelsFile({ 'env-prov': { apiKey: 'sk-plaintext-in-models' } })
    const resolver = new ProviderCredentialResolver(makeDeps_m2())

    expect(await resolver.resolveProviderCredential('env-prov')).toEqual({ unsupported: 'unresolved-env' })
  })

  it('models.json 侧 apiKey 的 command 形态同样返回 unsupported（两源共享同一份配置值解析）', async () => {
    writeModelsFile({ 'custom-cmd': { apiKey: '!cat /run/secrets/key' } })
    const resolver = new ProviderCredentialResolver(makeDeps_m2())

    expect(await resolver.resolveProviderCredential('custom-cmd')).toEqual({ unsupported: 'command' })
  })

  it('models.json 侧 apiKey 的 $ENV_VAR 同样展开（两源共享同一份配置值解析）', async () => {
    vi.stubEnv('TAIJI_CRED_PROBE_KEY', 'sk-probe-models')
    writeModelsFile({ 'custom-prov': { apiKey: '$TAIJI_CRED_PROBE_KEY' } })
    const resolver = new ProviderCredentialResolver(makeDeps_m2())

    expect(await resolver.resolveProviderCredential('custom-prov')).toEqual({
      key: 'sk-probe-models',
      source: 'models.json',
      kind: 'api_key',
    })
  })

  // resolveTemplate 的 ${} 深边界分支（Gate-1.6 补口）：apiKey 含 $ 字面量的 provider
  // 若被错误展开 → 鉴权失败；三例断言均与实装逐行核对（provider-credential-resolver.ts
  // resolveTemplate 转义对 / `${` 缺结束花括号 / ENV_VAR_NAME_RE 拒绝分支）。
  it('转义对：$$ → 字面 $，$! → 字面 !（各只消费 $ 后 1 字符，! 前缀形态标记不受影响）', async () => {
    writeAuthFile({
      esc: { type: 'api_key', key: 'sk-$$-literal' },
      'esc-bang': { type: 'api_key', key: '$!cmd-rest' },
    })
    const resolver = new ProviderCredentialResolver(makeDeps_m2())

    expect(await resolver.resolveProviderCredential('esc')).toEqual({ key: 'sk-$-literal', source: 'auth.json', kind: 'api_key' })
    expect(await resolver.resolveProviderCredential('esc-bang')).toEqual({ key: '!cmd-rest', source: 'auth.json', kind: 'api_key' })
  })

  it('`${` 缺结束花括号：$ 按字面输出 + 后续原样追加（不查 env、不判 undefined、不抛）', async () => {
    writeAuthFile({ unclosed: { type: 'api_key', key: '${UNCLOSED' } })
    const resolver = new ProviderCredentialResolver(makeDeps_m2())

    expect(await resolver.resolveProviderCredential('unclosed')).toEqual({
      key: '${UNCLOSED',
      source: 'auth.json',
      kind: 'api_key',
    })
  })

  it('${非法名} 原样保留（ENV_VAR_NAME_RE 拒绝分支，含首字符数字形态）', async () => {
    writeAuthFile({ 'bad-name': { type: 'api_key', key: 'pre-${1BAD}-post' } })
    const resolver = new ProviderCredentialResolver(makeDeps_m2())

    expect(await resolver.resolveProviderCredential('bad-name')).toEqual({
      key: 'pre-${1BAD}-post',
      source: 'auth.json',
      kind: 'api_key',
    })
  })
})
})
describe('provider-credential-resolver-base-url', () => {
/**
 * resolveProviderBaseUrl 两级数据源单测（ai-voice-tts D4「baseUrl 读取通道」的 port 扩展）。
 *
 * 既有 port 测试在 services/auth/__tests__/provider-credential-resolver.test.ts（本单元
 * 领地外），按任务书处置规则另立本文件；本方法不走 auth.json 凭据源链（auth.json 无
 * baseUrl 概念），deps 的凭据通道给恒空 stub 即可，用例聚焦两级 baseUrl 语义：
 *
 * ① models.json providers[id].baseUrl（provider 级网关值）——pi-provider-store 启动归一化
 *    （stripCatalogProviderLevelKeys）后仅在用户显式配网关（extras.gatewayBaseUrl 标记）时
 *    保留，此级读到的必是用户网关实际值，优先级最高；
 * ② 第一级无值时回退内置 catalog（generated/builtin-providers.json）该 provider 的
 *    provider 级 baseUrl——未配网关的内置 provider，此值即 pi 实际生效值（pi 行为锚点：
 *    @earendil-works/pi-coding-agent@0.84.4 dist/core/provider-composer.js:98
 *    `config.baseUrl ?? model.baseUrl` 覆盖式网关语义）；
 * ③ 两级皆无值 → undefined。
 */
/** deps 工厂：models.json 走内存 fake（本方法唯一走真实数据的通道）；凭据通道恒空 stub。 */
function makeResolver(providers: Record<string, ConfigProviderConfig>): ProviderCredentialResolver {
  const models: ConfigModelsConfig = { providers }
  const deps: ProviderCredentialResolverDeps = {
    authService: { getCredential: async () => undefined },
    authStorage: { hasCredentialSync: () => false, listCredentialIds: () => [] },
    configStore: {
      readModels: () => models,
      getProviderConfig: (providerId: string) => providers[providerId],
    },
  }
  return new ProviderCredentialResolver(deps)
}

describe('resolveProviderBaseUrl 两级数据源', () => {
  it('第一级命中：models.json provider 级 baseUrl（用户网关值）优先返回', () => {
    const resolver = makeResolver({
      'xiaomi-token-plan-cn': { baseUrl: 'https://my-gateway.example.com/v1' },
    })

    expect(resolver.resolveProviderBaseUrl('xiaomi-token-plan-cn')).toBe('https://my-gateway.example.com/v1')
  })

  it('第一级无值回退第二级：models.json 条目无 baseUrl 时返回内置 catalog 的 provider 级 baseUrl', () => {
    // 未配网关的内置 provider 主力形态：models.json 只有 apiKey（联动只带 Key 的场景此级无 baseUrl）
    const resolver = makeResolver({
      'xiaomi-token-plan-cn': { apiKey: 'sk-plan-key' },
      minimax: {},
    })

    expect(resolver.resolveProviderBaseUrl('xiaomi-token-plan-cn')).toBe('https://token-plan-cn.xiaomimimo.com/v1')
    expect(resolver.resolveProviderBaseUrl('minimax')).toBe('https://api.minimax.io/anthropic')
  })

  it('两级皆无值返回 undefined：models.json 无条目且 catalog 无此 id（自定义 provider 无 baseUrl）', () => {
    const resolver = makeResolver({})

    expect(resolver.resolveProviderBaseUrl('my-custom-provider')).toBeUndefined()
  })

  it('models.json baseUrl 为空白串同视未设置（对齐 resolveCatalogDisplayFields 口径），回退 catalog', () => {
    const resolver = makeResolver({
      xiaomi: { baseUrl: '  ' },
    })

    expect(resolver.resolveProviderBaseUrl('xiaomi')).toBe('https://api.xiaomimimo.com/v1')
  })

  it('catalog 该 provider 的 provider 级 baseUrl 为空串（ambient 类）不当生效值，返回 undefined', () => {
    // amazon-bedrock 快照 provider.baseUrl === ""（ambient 鉴权，无单一端点）
    const resolver = makeResolver({ 'amazon-bedrock': {} })

    expect(resolver.resolveProviderBaseUrl('amazon-bedrock')).toBeUndefined()
  })
})
})
});
