/**
 * auth.json 凭据存储单测（tmp 目录真实文件）。
 *
 * 覆盖：set 后 get / merge 不丢其他 provider / 并发 set 多个 provider 最终全在
 * （proper-lockfile 跨进程锁串行化 RMW）/ 0600 权限位 / remove 幂等 /
 * 文件不存在 get 返回 undefined / 损坏 JSON 抛错 / hasOAuth。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AuthStorage, type OAuthCredential, type Credential, type ApiKeyCredential } from '../auth-storage.js'

let dir: string
let file: string
let storage: AuthStorage

function oauthCred(access: string, expires = 1_000): OAuthCredential {
  return { type: 'oauth', access, expires }
}

function apiKeyCred(key: string, env?: Record<string, string>): ApiKeyCredential {
  return env ? { type: 'api_key', key, env } : { type: 'api_key', key }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'auth-storage-'))
  file = join(dir, 'auth.json')
  storage = new AuthStorage(file)
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

describe('AuthStorage', () => {
  it('set 后 get 返回完整 credential', async () => {
    await storage.set('provider-a', oauthCred('token-1'))
    expect(await storage.get('provider-a')).toMatchObject({ type: 'oauth', access: 'token-1', expires: 1_000 })
  })

  it('set 不同 provider 不互相覆盖（RMW merge）', async () => {
    await storage.set('a', oauthCred('t1'))
    await storage.set('b', oauthCred('t2'))
    expect(await storage.get('a')).toMatchObject({ access: 't1' })
    expect(await storage.get('b')).toMatchObject({ access: 't2' })
    expect(await storage.hasOAuth('a')).toBe(true)
    expect(await storage.hasOAuth('missing')).toBe(false)
  })

  it('同 provider 重复 set 覆盖旧值', async () => {
    await storage.set('a', oauthCred('old'))
    await storage.set('a', oauthCred('new'))
    expect(await storage.get('a')).toMatchObject({ access: 'new' })
  })

  it('并发 set 多个 provider：全部保留（mutex 串行化 RMW）', async () => {
    await Promise.all(
      Array.from({ length: 10 }, (_, i) => storage.set(`p${i}`, oauthCred(`t${i}`))),
    )
    const all = await storage.getAll()
    expect(Object.keys(all)).toHaveLength(10)
    for (let i = 0; i < 10; i++) {
      expect(all[`p${i}`]).toMatchObject({ access: `t${i}` })
    }
  })

  it('写入后文件权限为 0600', async () => {
    await storage.set('a', oauthCred('t1'))
    const stat = statSync(file)
    expect(stat.mode & 0o777).toBe(0o600)
  })

  it('remove 幂等：不存在时再次 remove 不抛错', async () => {
    await storage.set('a', oauthCred('t1'))
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
    await expect(storage.set('a', oauthCred('t1'))).rejects.toThrow()
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
    await storage.set('oauth-prov', oauthCred('t2'))
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
    await storage.set('anthropic', oauthCred('tok'))
    expect(storage.hasCredentialSync('anthropic')).toBe(true)
  })

  it('TC5: 同 provider api_key 覆盖已有 oauth', async () => {
    await storage.set('x', oauthCred('old-oauth'))
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
