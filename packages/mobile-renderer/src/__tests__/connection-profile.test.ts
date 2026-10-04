// connection-profile D4 三分支测试（remote-use U1.3）。
//
// 纯函数（resolveCredential / readQueryToken / wsUrlFromHost）+ 端口集成（resolve /
// handleAuthSuccess / handleAuthFailure / adoptManualToken）两段。锁定 D4 三分支闭合：
// - 分支①：query token 验身成功覆盖 storage + 抹地址栏（轮换重扫恢复路径）
// - 分支②：query 坏 token 验身失败**不动**好 storage（坏链接不毁好凭据；地址栏 query 保留）
// - 分支③：storage 来源失效清空 + 落 token 输入视图（E11）
// - 皆无：resolve 不带凭据（E2 通路——连接被拒后经 handleAuthFailure 落 token 输入视图）
//
// 运行：cd packages/mobile-renderer && npx vitest run src/__tests__/connection-profile.test.ts
import { describe, it, expect, vi } from 'vitest'
import {
  REMOTE_TOKEN_STORAGE_KEY,
  createConnectionProfilePort,
  readQueryToken,
  resolveCredential,
  wsUrlFromHost,
} from '../platform/connection-profile'
import type { KVStorage } from '@taiji/core'

function makeStore(initial?: string): { storage: KVStorage; map: Map<string, string> } {
  const map = new Map<string, string>()
  if (initial !== undefined) map.set(REMOTE_TOKEN_STORAGE_KEY, initial)
  const storage: KVStorage = {
    get: async (key) => map.get(key) ?? null,
    set: async (key, value) => {
      map.set(key, value)
    },
    remove: async (key) => {
      map.delete(key)
    },
  }
  return { storage, map }
}

function makePort(opts: { search?: string; stored?: string; protocol?: string } = {}) {
  const { storage, map } = makeStore(opts.stored)
  const stripQuery = vi.fn()
  const onTokenInputRequired = vi.fn()
  const port = createConnectionProfilePort({
    storage,
    host: '192.168.1.5:3210',
    protocol: opts.protocol ?? 'http:',
    search: opts.search ?? '',
    stripQuery,
    onTokenInputRequired,
  })
  return { port, map, stripQuery, onTokenInputRequired }
}

describe('resolveCredential 纯裁决（D4）', () => {
  it('query 优先于 storage（轮换重扫：新凭据压过旧持久凭据）', () => {
    expect(resolveCredential('tok-new', 'tok-old')).toEqual({
      action: 'adopt',
      credential: { token: 'tok-new', source: 'query' },
    })
  })

  it('storage 兜底（无 query 时）', () => {
    expect(resolveCredential(null, 'tok-stored')).toEqual({
      action: 'adopt',
      credential: { token: 'tok-stored', source: 'storage' },
    })
  })

  it('皆无 → need-input', () => {
    expect(resolveCredential(null, null)).toEqual({ action: 'need-input' })
  })

  it('空串等同缺失（URLSearchParams 有 key 无值形态）', () => {
    expect(resolveCredential('', '')).toEqual({ action: 'need-input' })
  })
})

describe('readQueryToken / wsUrlFromHost', () => {
  it('?token= 提取；无 token 参数 / 空 search 返回 null', () => {
    expect(readQueryToken('?token=abc&x=1')).toBe('abc')
    expect(readQueryToken('?x=1')).toBeNull()
    expect(readQueryToken('')).toBeNull()
  })

  it('WS URL scheme 按页面协议派生：http: → ws://，https: → wss://，未知协议安全侧缺省 wss://', () => {
    expect(wsUrlFromHost('192.168.1.5:3210', 'http:')).toBe('ws://192.168.1.5:3210')
    expect(wsUrlFromHost('remote.example.com', 'https:')).toBe('wss://remote.example.com')
    expect(wsUrlFromHost('remote.example.com', 'file:')).toBe('wss://remote.example.com')
  })

  it('resolve 的连接目标随注入协议派生（https 托管形态 → wss://）', async () => {
    const { port } = makePort({ stored: 'tok-stored', protocol: 'https:' })
    const resolved = await port.resolve()
    expect(resolved.url).toBe('wss://192.168.1.5:3210')
  })
})

describe('D4 三分支闭合（端口集成）', () => {
  it('分支①：query 验身成功覆盖 storage + 抹地址栏（轮换重扫恢复路径）', async () => {
    const { port, map, stripQuery } = makePort({ search: '?token=tok-new', stored: 'tok-old' })
    const resolved = await port.resolve()
    expect(resolved).toEqual({ url: 'ws://192.168.1.5:3210', token: 'tok-new' })
    await port.handleAuthSuccess()
    expect(map.get(REMOTE_TOKEN_STORAGE_KEY)).toBe('tok-new') // 覆盖写
    expect(stripQuery).toHaveBeenCalledTimes(1) // replaceState 抹地址栏
  })

  it('分支②：query 坏 token 验身失败不动好 storage + 落 token 输入视图（地址栏 query 保留）', async () => {
    const { port, map, stripQuery, onTokenInputRequired } = makePort({
      search: '?token=tok-bad',
      stored: 'tok-good',
    })
    await port.resolve()
    await port.handleAuthFailure()
    expect(map.get(REMOTE_TOKEN_STORAGE_KEY)).toBe('tok-good') // 好凭据无损
    expect(stripQuery).not.toHaveBeenCalled() // 刷新重试入口保留（D4 显式判定）
    expect(onTokenInputRequired).toHaveBeenCalledTimes(1)
  })

  it('分支③：storage 来源失效 → 清空 storage + 落 token 输入视图（E11）', async () => {
    const { port, map, onTokenInputRequired } = makePort({ stored: 'tok-stale' })
    const resolved = await port.resolve()
    expect(resolved).toEqual({ url: 'ws://192.168.1.5:3210', token: 'tok-stale' })
    await port.handleAuthFailure()
    expect(map.has(REMOTE_TOKEN_STORAGE_KEY)).toBe(false)
    expect(onTokenInputRequired).toHaveBeenCalledTimes(1)
  })

  it('皆无：resolve 不带凭据（E2 通路，连接发起面无异常路径）；验身失败通知落输入视图', async () => {
    const { port, map, onTokenInputRequired } = makePort({})
    const resolved = await port.resolve()
    expect(resolved).toEqual({ url: 'ws://192.168.1.5:3210' })
    expect('token' in resolved).toBe(false)
    await port.handleAuthFailure()
    expect(map.has(REMOTE_TOKEN_STORAGE_KEY)).toBe(false)
    expect(onTokenInputRequired).toHaveBeenCalledTimes(1)
  })

  it('手输采纳：resolve 优先采纳（压过 query/storage）；验身成功落 storage（语义同 query）', async () => {
    const { port, map, stripQuery } = makePort({ search: '?token=tok-query', stored: 'tok-old' })
    port.adoptManualToken('tok-manual')
    const resolved = await port.resolve()
    expect(resolved).toEqual({ url: 'ws://192.168.1.5:3210', token: 'tok-manual' })
    await port.handleAuthSuccess()
    expect(map.get(REMOTE_TOKEN_STORAGE_KEY)).toBe('tok-manual')
    expect(stripQuery).not.toHaveBeenCalled() // manual 无 query 可抹
  })

  it('storage 来源验身成功幂等（不重写、不抹地址栏）；普通重连（待定凭据已清）auth 成功 no-op', async () => {
    const { port, map, stripQuery } = makePort({ stored: 'tok-stored' })
    await port.resolve()
    await port.handleAuthSuccess()
    expect(map.get(REMOTE_TOKEN_STORAGE_KEY)).toBe('tok-stored')
    expect(stripQuery).not.toHaveBeenCalled()
    // pending 已清：重连成功的 auth 处置 no-op 不抛
    await port.handleAuthSuccess()
  })
})
