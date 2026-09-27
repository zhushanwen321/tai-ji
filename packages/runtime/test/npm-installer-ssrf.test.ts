/**
 * NpmInstaller SSRF 防护单测。
 *
 * 覆盖信任边界安全代码（CLAUDE.md + ponytail「security measures never simplify away」）：
 * - isPrivateIp：13 条内网/特殊用途 IP 段 + 公网 IP 放行
 * - validateUrlHost：非法 URL / 非 HTTPS / IPv4 私网 / IPv6（::1·fe80:·fc00:/fd）/ 公网放行
 *
 * extension-service.test.ts 把整个模块 vi.mock，真实校验从未执行——本测试直接覆盖。
 *
 * 运行：pnpm --filter @taiji/runtime run test -- test/npm-installer-ssrf.test.ts
 */
import { describe, it, expect } from 'vitest'
import { isPrivateIp, validateUrlHost, NpmInstallError } from '../src/infra/installers/npm-installer.js'

describe('isPrivateIp — 13 条内网/特殊用途段全部拦截', () => {
  it.each([
    ['0.0.0.0', '0.0.0.0/8'],
    ['10.1.2.3', '10.0.0.0/8'],
    ['127.0.0.1', '127.0.0.0/8 loopback'],
    ['169.254.1.1', '169.254.0.0/16 link-local'],
    ['172.16.0.1', '172.16.0.0/12 起始'],
    ['172.31.255.255', '172.16.0.0/12 结束'],
    ['192.0.2.1', '192.0.2.0/24 TEST-NET-1'],
    ['192.168.1.1', '192.168.0.0/16'],
    ['198.51.100.1', '198.51.100.0/24 TEST-NET-2'],
    ['203.0.113.1', '203.0.113.0/24 TEST-NET-3'],
    ['224.0.0.1', '224.0.0.0/4 multicast'],
    ['239.255.255.255', '239.0.0.0/8 multicast'],
    ['240.0.0.1', '240.0.0.0/4 reserved'],
    ['255.255.255.255', '255.0.0.0/8 broadcast'],
  ])('blocks %s (%s)', (ip) => {
    expect(isPrivateIp(ip)).toBe(true)
  })

  it.each([
    ['8.8.8.8'],
    ['1.1.1.1'],
    ['172.32.0.1'],
    ['172.15.0.1'],
    ['192.169.1.1'],
    ['11.0.0.1'],
  ])('allows public IP %s', (ip) => {
    expect(isPrivateIp(ip)).toBe(false)
  })
})

describe('validateUrlHost', () => {
  it('非法 URL → NpmInstallError(network)', () => {
    expect(() => validateUrlHost('not-a-url')).toThrow(NpmInstallError)
    expect(() => validateUrlHost('not-a-url')).toThrow(/Invalid URL/)
    expect(() => validateUrlHost('')).toThrow(/Invalid URL/)
  })

  it('非 HTTPS → 拦截', () => {
    expect(() => validateUrlHost('http://registry.npmjs.org/pkg')).toThrow(/Blocked non-HTTPS/)
    expect(() => validateUrlHost('ftp://example.com/x')).toThrow(/Blocked non-HTTPS/)
  })

  it('私网 IPv4 → 拦截', () => {
    expect(() => validateUrlHost('https://127.0.0.1/pkg')).toThrow(/Blocked private IP/)
    expect(() => validateUrlHost('https://10.0.0.1/pkg')).toThrow(/Blocked private IP/)
    expect(() => validateUrlHost('https://192.168.1.1/pkg')).toThrow(/Blocked private IP/)
    expect(() => validateUrlHost('https://172.16.0.1/pkg')).toThrow(/Blocked private IP/)
  })

  it('IPv6 loopback / link-local / unique-local → 拦截', () => {
    expect(() => validateUrlHost('https://[::1]/pkg')).toThrow(/Blocked private IP/)
    expect(() => validateUrlHost('https://[fe80::1]/pkg')).toThrow(/Blocked private IP/)
    expect(() => validateUrlHost('https://[fc00::1]/pkg')).toThrow(/Blocked private IP/)
    expect(() => validateUrlHost('https://[fd00::1]/pkg')).toThrow(/Blocked private IP/)
  })

  it('公网 IPv4 → 放行', () => {
    expect(() => validateUrlHost('https://8.8.8.8/pkg')).not.toThrow()
    expect(() => validateUrlHost('https://1.1.1.1/path')).not.toThrow()
  })

  it('域名 → 放行（不做 IP 检查，由 DNS + HTTPS 保障）', () => {
    expect(() => validateUrlHost('https://registry.npmjs.org/pkg')).not.toThrow()
    expect(() => validateUrlHost('https://example.com/path/to/tarball')).not.toThrow()
  })

  it('拦截时抛出的是 NpmInstallError 且 code=network', () => {
    try {
      validateUrlHost('http://10.0.0.1/x')
      throw new Error('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(NpmInstallError)
      expect((e as NpmInstallError).code).toBe('network')
    }
  })
})
