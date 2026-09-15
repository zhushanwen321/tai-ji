/**
 * A1-4 AuthService 收口测试：auth.json 凭证读/写通道 + catalog apiKey 保存全链路。
 *
 * 测试框架：vitest（从 vitest 导入 describe/it/expect，禁 node:test）。
 * 运行命令：cd packages/runtime && npx vitest run src/services/auth/__tests__/auth-credential-gateway.test.ts
 *
 * 策略：真实文件系统（临时目录 auth.json fixture）+ 真实 AuthStorage + 真实 AuthService
 * （OAuth flow 之外的依赖 broadcast/nextPushId/clearApiKey 用 spy 注入——本测试不触发
 * login，不会走网络）。物理读 auth.json 断言落盘终态。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AuthService } from '../auth-service.js'
import { AuthStorage } from '../auth-storage.js'
import { ConfigService } from '../../config-service.js'
import { setModelsPath } from '../../../infra/pi/pi-provider-store.js'
import { PiConfigStore } from '../../../infra/pi/pi-config-store.js'

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
