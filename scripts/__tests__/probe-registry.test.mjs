import { describe, it, expect } from 'vitest'
import { parseSpec, buildUrl, parseArgs, probePackage, runProbe } from '../probe-registry.mjs'

/** 序列化假 fetch：按预设状态码序列出队，耗尽后重复最后一个。 */
function seqFetch(codes) {
  const calls = []
  const impl = async (url, timeoutMs) => {
    calls.push({ url, timeoutMs })
    const code = calls.length <= codes.length ? codes[calls.length - 1] : codes[codes.length - 1]
    return code
  }
  return { impl, calls }
}

describe('parseSpec：pkg@ver 拆分（scoped 名取最后一个 @）', () => {
  it('scoped 名 + 版本', () => {
    expect(parseSpec('@zhushanwen/extension-protocol@0.24.0')).toEqual({
      pkg: '@zhushanwen/extension-protocol',
      ver: '0.24.0',
    })
  })
  it('非 scoped 名 + 版本', () => {
    expect(parseSpec('taiji@1.2.3')).toEqual({ pkg: 'taiji', ver: '1.2.3' })
  })
  it('缺版本 / 缺名 / 空串 → 抛错', () => {
    expect(() => parseSpec('@zhushanwen/extension-protocol')).toThrow()
    expect(() => parseSpec('@0.24.0')).toThrow()
    expect(() => parseSpec('')).toThrow()
  })
})

describe('buildUrl：版本端点 URL（scoped 名斜杠编码）', () => {
  it('scoped 名的 / 编码为 %2f，与旧 inline bash 的 sed 口径一致', () => {
    expect(buildUrl('@zhushanwen/extension-protocol', '0.24.0')).toBe(
      'https://registry.npmjs.org/@zhushanwen%2fextension-protocol/0.24.0',
    )
  })
  it('非 scoped 名原样', () => {
    expect(buildUrl('taiji', '1.2.3')).toBe('https://registry.npmjs.org/taiji/1.2.3')
  })
})

describe('parseArgs：flags 与默认值', () => {
  it('缺省：retries=6 / intervalMs=60000 / timeoutMs=20000', () => {
    const a = parseArgs(['a@1.0.0'])
    expect(a.retries).toBe(6)
    expect(a.intervalMs).toBe(60000)
    expect(a.timeoutMs).toBe(20000)
    expect(a.specs).toEqual([{ pkg: 'a', ver: '1.0.0' }])
  })
  it('自定义 flags 解析', () => {
    const a = parseArgs(['--retries', '10', '--interval-ms', '5000', '--timeout-ms', '3000', 'a@1.0.0'])
    expect({ retries: a.retries, intervalMs: a.intervalMs, timeoutMs: a.timeoutMs }).toEqual({
      retries: 10,
      intervalMs: 5000,
      timeoutMs: 3000,
    })
  })
  it('零 spec / 非正整数 / 未知 flag → 抛错', () => {
    expect(() => parseArgs([])).toThrow()
    expect(() => parseArgs(['--retries', 'x', 'a@1.0.0'])).toThrow()
    expect(() => parseArgs(['--retries', '0', 'a@1.0.0'])).toThrow()
    expect(() => parseArgs(['--nope', 'a@1.0.0'])).toThrow()
  })
})

describe('probePackage：重试循环', () => {
  const base = { retries: 3, intervalMs: 1000, timeoutMs: 50 }

  it('首轮 200 → 立即通过，零 sleep', async () => {
    const f = seqFetch([200])
    const sleeps = []
    const r = await probePackage({ pkg: 'a', ver: '1' }, { ...base, fetchImpl: f.impl, sleep: (ms) => sleeps.push(ms) })
    expect(r.ok).toBe(true)
    expect(r.attempts).toBe(1)
    expect(sleeps).toEqual([])
  })
  it('传播延迟形态：404×2 后 200 → 第 3 次通过，sleep 两次且间隔 = intervalMs', async () => {
    const f = seqFetch([404, 404, 200])
    const sleeps = []
    const r = await probePackage({ pkg: 'a', ver: '1' }, { ...base, fetchImpl: f.impl, sleep: (ms) => sleeps.push(ms) })
    expect(r.ok).toBe(true)
    expect(r.attempts).toBe(3)
    expect(r.lastCode).toBe(200)
    expect(sleeps).toEqual([1000, 1000])
  })
  it('超限：全部 404 → ok=false，attempts=retries，lastCode=404', async () => {
    const f = seqFetch([404])
    const r = await probePackage({ pkg: 'a', ver: '1' }, { ...base, fetchImpl: f.impl, sleep: async () => {} })
    expect(r.ok).toBe(false)
    expect(r.attempts).toBe(3)
    expect(r.lastCode).toBe(404)
  })
  it('网络错误（fetch 抛异常归一 ERR）可重试', async () => {
    const f = { impl: async () => { throw new Error('network') } }
    const r = await probePackage({ pkg: 'a', ver: '1' }, { ...base, fetchImpl: f.impl, sleep: async () => {} })
    expect(r.ok).toBe(false)
    expect(r.lastCode).toBe('ERR')
    expect(r.attempts).toBe(3)
  })
  it('探测 URL 与超时透传给 fetchImpl', async () => {
    const f = seqFetch([200])
    await probePackage({ pkg: '@s/a', ver: '2.0.0' }, { ...base, fetchImpl: f.impl, sleep: async () => {} })
    expect(f.calls[0].url).toBe('https://registry.npmjs.org/@s%2fa/2.0.0')
    expect(f.calls[0].timeoutMs).toBe(50)
  })
})

describe('runProbe：全量串行', () => {
  it('混合结果 → ok=false 且结果保序', async () => {
    const r = await runProbe(
      [{ pkg: 'a', ver: '1' }, { pkg: 'b', ver: '1' }],
      { retries: 2, intervalMs: 1, timeoutMs: 10, fetchImpl: async () => 200, sleep: async () => {} },
    )
    expect(r.ok).toBe(true)
    const mixed = await runProbe(
      [{ pkg: 'a', ver: '1' }, { pkg: 'b', ver: '1' }],
      {
        retries: 2,
        intervalMs: 1,
        timeoutMs: 10,
        fetchImpl: async (url) => (url.includes('/a/') ? 200 : 404),
        sleep: async () => {},
      },
    )
    expect(mixed.ok).toBe(false)
    expect(mixed.results.map((x) => `${x.pkg}:${x.ok}`)).toEqual(['a:true', 'b:false'])
  })
})
