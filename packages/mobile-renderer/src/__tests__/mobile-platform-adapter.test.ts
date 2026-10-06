// MobilePlatformAdapter LocalStorageKV 读写降级测试。
//
// 背景：「阻止所有 Cookie」等受限环境访问 localStorage 即抛 SecurityError——get 无降级时
// 直抛会沿 resolveCredential → bootstrap 炸成全屏「应用启动失败」页，正确去向是 token 输入
// 视图（get 返回 null 等价无凭据 → resolve 三分支 need-input）；set/remove 写降级为既有
// 行为，一并列回归锚。
//
// 运行：cd packages/mobile-renderer && npx vitest run src/__tests__/mobile-platform-adapter.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMobilePlatformAdapter } from '../platform/mobile-platform-adapter'

describe('LocalStorageKV 读降级（受限环境 localStorage.getItem 抛错）', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('正常路径：get 返回已存值 / 缺失 key 返回 null（happy-dom 真实 localStorage）', async () => {
    const { storage } = createMobilePlatformAdapter()
    await storage.set('taiji.remote-access.token', 'tok-a')
    expect(await storage.get('taiji.remote-access.token')).toBe('tok-a')
    expect(await storage.get('missing-key')).toBeNull()
  })

  it('getItem 抛错（SecurityError 形态）→ get 返回 null 不 reject，warn 留排障依据', async () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('SecurityError: The document is sandboxed and lacks the allow-same-origin flag.')
      },
      setItem: () => {},
      removeItem: () => {},
    })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { storage } = createMobilePlatformAdapter()
    await expect(storage.get('taiji.remote-access.token')).resolves.toBeNull()
    expect(warnSpy).toHaveBeenCalledTimes(1)
  })

  it('写降级回归锚：setItem / removeItem 抛错 → set / remove 正常完成不 reject', async () => {
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceededError (Safari private mode form)')
      },
      removeItem: () => {
        throw new Error('QuotaExceededError (Safari private mode form)')
      },
    })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { storage } = createMobilePlatformAdapter()
    await expect(storage.set('k', 'v')).resolves.toBeUndefined()
    await expect(storage.remove('k')).resolves.toBeUndefined()
    expect(warnSpy).toHaveBeenCalledTimes(2)
  })
})
