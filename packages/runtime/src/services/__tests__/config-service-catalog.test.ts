/**
 * setProvider catalog 分支测试（M5-01，P0 修复验证）。
 *
 * 测试框架：vitest（从 vitest 导入 describe/it/expect/vi，禁 node:test）。
 * 运行命令：cd packages/runtime && npx vitest run src/services/__tests__/config-service-catalog.test.ts
 *
 * 策略：**不 mock provider-catalog**——isCatalogProvider 走真实实现（builtin-providers.json
 * 判定）。补 config-service.test.ts 的测试盲区（该文件 vi.mock 把 isCatalogProvider 恒置
 * false，catalog 分支从未被真实路径覆盖，setProvider 的 apiKey 双写 bug 因此漏网）。
 *
 * A1-4 收口：catalog apiKey 写入经 credentialWriter（AuthService.saveCredential 的窄
 * 接口），不再直接持有 authStorage.set——断言对象同步切换。
 */
import { describe, it, expect, vi } from 'vitest'
import { ConfigService } from '../config-service.js'
import type { IConfigStore } from '../ports/config.js'
import type { AuthStorage, CredentialWriter } from '../auth/auth-storage.js'

type AuthPick = Pick<AuthStorage, 'remove' | 'hasOAuth' | 'hasOAuthSync' | 'hasCredentialSync' | 'listCredentialIds'>

function makeStore() {
  return {
    // 无既有 models.json 条目（catalog 定义来自 pi 内置 catalog，条目只是可选 override）——
    // 用于验证防线③「不物化**新**空壳」：apiKey 归 auth.json 后 models.json 无条目可写
    getProviderConfig: vi.fn(() => undefined),
    upsertProvider: vi.fn(() => ({})),
    // 无既有条目 → existingConfig === undefined → setProvider 末尾走白名单守卫（新建语义）
    ensureProviderInWhitelist: vi.fn(),
    removeProvider: vi.fn(() => ({ removed: true })),
    cleanEnabledModelsResidue: vi.fn(),
  } as unknown as IConfigStore & { upsertProvider: ReturnType<typeof vi.fn> }
}

function makeAuth(): AuthPick {
  return {
    listCredentialIds: vi.fn(() => []),
    hasCredentialSync: vi.fn(() => false),
    remove: vi.fn().mockResolvedValue(undefined),
    hasOAuth: vi.fn(() => false),
    hasOAuthSync: vi.fn(() => false),
  } as unknown as AuthPick
}

function makeCredentialWriter(): CredentialWriter & { saveCredential: ReturnType<typeof vi.fn> } {
  return { saveCredential: vi.fn().mockResolvedValue(undefined) }
}

describe('M5-01: setProvider catalog 分支（真实 isCatalogProvider，不 mock）', () => {
  it('catalog provider（anthropic）保存 apiKey → 只写 auth.json，不物化 models.json 条目', async () => {
    const store = makeStore()
    const auth = makeAuth()
    const writer = makeCredentialWriter()
    const svc = new ConfigService('/tmp/project', store, auth)
    svc.setCredentialWriter(writer)

    await svc.setProvider('anthropic', { apiKey: 'sk-secret' })

    // catalog 凭据归 auth.json（pi-alignment 决策 1）；A1-4 收口后经 credentialWriter
    expect(writer.saveCredential).toHaveBeenCalledWith('anthropic', { type: 'api_key', key: 'sk-secret' })
    // 防线③（不物化新空壳）：models.json 无既有条目 + apiKey 归 auth.json → 不产生条目
    // （凭据只归 auth.json 0600，不写 0644 明文 models.json；G5 迁移的安全动机）
    expect(store.upsertProvider).not.toHaveBeenCalled()
  })

  it('catalog provider 不传 apiKey（只改 baseUrl）→ 不写 auth.json，merged 无 apiKey', () => {
    const store = makeStore()
    const auth = makeAuth()
    const writer = makeCredentialWriter()
    const svc = new ConfigService('/tmp/project', store, auth)
    svc.setCredentialWriter(writer)

    svc.setProvider('anthropic', { baseUrl: 'https://proxy.example.com' })

    expect(writer.saveCredential).not.toHaveBeenCalled()
    const merged = store.upsertProvider.mock.calls[0][1] as Record<string, unknown>
    expect('apiKey' in merged).toBe(false)
  })

  it('custom provider（my-custom）保存 apiKey → merged 含 apiKey（回归：custom 分支仍写 models.json + I9 清 auth.json oauth）', () => {
    const store = makeStore()
    const auth = makeAuth()
    const writer = makeCredentialWriter()
    const svc = new ConfigService('/tmp/project', store, auth)
    svc.setCredentialWriter(writer)

    svc.setProvider('my-custom', { apiKey: 'sk-x' })

    // custom 凭据写 models.json（apiKey 字段），auth.json 反而要清（I9 清理①）
    expect(writer.saveCredential).not.toHaveBeenCalled()
    expect(auth.remove).toHaveBeenCalledWith('my-custom')
    const merged = store.upsertProvider.mock.calls[0][1] as Record<string, unknown>
    expect(merged.apiKey).toBe('sk-x')
  })

  it('catalog provider + 未注入 credentialWriter → 不抛错，不物化 models.json 条目（凭据无处安放宁丢不写错位）', () => {
    const store = makeStore()
    const svc = new ConfigService('/tmp/project', store)

    expect(() => svc.setProvider('anthropic', { apiKey: 'sk-secret' })).not.toThrow()
    expect(store.upsertProvider).not.toHaveBeenCalled()
  })

  it('MF-1：catalog provider 保存 apiKey 时 await 落盘后才 upsertProvider（防 stale 广播）', async () => {
    // 复现生产缺陷：fire-and-forget 时 setProvider 同步返回，handler 立即 broadcastProviderList
    // 裸读 auth.json——withFileLock 尚未落盘 → catalog 瞬时显示 not_configured。修复（await）后
    // 写返回时凭据已落盘。构造带延迟的写，验证 await 完成后才生效。
    let setDone = false
    const writer = {
      saveCredential: vi.fn(async (_id: string, _cred: unknown) => {
        await new Promise(r => setTimeout(r, 5))
        setDone = true
      }),
    }
    const store = makeStore()
    const svc = new ConfigService('/tmp/project', store, makeAuth())
    svc.setCredentialWriter(writer)

    await svc.setProvider('anthropic', { apiKey: 'sk-secret' })

    // await 返回时写已完成（fire-and-forget 会因 5ms 延迟未完成）
    expect(setDone).toBe(true)
    expect(writer.saveCredential).toHaveBeenCalledWith('anthropic', { type: 'api_key', key: 'sk-secret' })
  })

  it('MF-1：catalog provider 保存 apiKey 时写 auth.json 失败 → setProvider reject（不静默吞凭据丢失）', async () => {
    // 复现生产缺陷：fire-and-forget + .catch(warn) 时写失败只 warn，apiKey 既未进 auth.json
    // 又已从 models.json 删 → 用户收成功但凭据丢失无错误出口。修复（await 无 catch）后失败直接 reject。
    const writer = {
      saveCredential: vi.fn().mockRejectedValueOnce(new Error('disk full')),
    }
    const store = makeStore()
    const svc = new ConfigService('/tmp/project', store, makeAuth())
    svc.setCredentialWriter(writer)

    await expect(svc.setProvider('anthropic', { apiKey: 'sk-secret' })).rejects.toThrow('disk full')
    // 失败时 upsertProvider 不应被调用（原子失败，不残留半写入的 models.json）
    expect(store.upsertProvider).not.toHaveBeenCalled()
  })
})
