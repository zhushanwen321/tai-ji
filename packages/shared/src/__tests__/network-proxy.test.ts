import { describe, it, expect } from 'vitest'
import {
  DEFAULT_NETWORK_PROXY_CONFIG,
  validateNetworkProxyConfig,
  normalizeHostname,
  matchesHostPattern,
  type NetworkProxyConfig,
} from '../network-proxy'

const valid = (): NetworkProxyConfig => ({
  enabled: true,
  proxy: { protocol: 'http', host: '127.0.0.1', port: 7890, username: '', password: '' },
  noProxy: ['localhost', '127.0.0.1'],
  ipv4Only: [],
  rules: ['api.anthropic.com'],
})

describe('validateNetworkProxyConfig', () => {
  it('合法形态通过（默认配置 / 全字段 / 条目重复不报错）', () => {
    expect(validateNetworkProxyConfig(DEFAULT_NETWORK_PROXY_CONFIG)).toEqual({ ok: true })
    expect(
      validateNetworkProxyConfig({
        enabled: true,
        proxy: { protocol: 'socks5', host: 'proxy.example.com', port: 1080, username: 'u', password: 'p' },
        noProxy: ['localhost', 'internal.test'],
        ipv4Only: [],
        rules: ['api.anthropic.com', 'api.anthropic.com'],
      }),
    ).toEqual({ ok: true })
  })

  it('协议白名单外拒绝（含大小写变体——协议词表精确匹配）', () => {
    for (const protocol of ['ftp', 'socks4', 'HTTP', '']) {
      const r = validateNetworkProxyConfig({ ...valid(), proxy: { ...valid().proxy, protocol: protocol as never } })
      expect(r.ok, `protocol=${protocol}`).toBe(false)
      if (!r.ok) expect(r.errors.join('\n')).toContain('协议')
    }
  })

  it('端口越界拒绝（0 / 70000 / 负数 / 非整数）', () => {
    for (const port of [0, 70000, -1, 65536, 7890.5, NaN]) {
      const r = validateNetworkProxyConfig({ ...valid(), proxy: { ...valid().proxy, port } })
      expect(r.ok, `port=${port}`).toBe(false)
      if (!r.ok) {
        expect(r.errors.join('\n')).toContain('端口')
        expect(r.errors.join('\n')).toContain(String(port))
      }
    }
    // 边界内通过：1 与 65535
    expect(validateNetworkProxyConfig({ ...valid(), proxy: { ...valid().proxy, port: 1 } })).toEqual({ ok: true })
    expect(validateNetworkProxyConfig({ ...valid(), proxy: { ...valid().proxy, port: 65535 } })).toEqual({ ok: true })
  })

  it('凭据单边拒绝（只填用户名 / 只填密码），成对通过', () => {
    const onlyUser = validateNetworkProxyConfig({
      ...valid(),
      proxy: { ...valid().proxy, username: 'user', password: '' },
    })
    expect(onlyUser.ok).toBe(false)
    if (!onlyUser.ok) expect(onlyUser.errors.join('\n')).toContain('成对')

    const onlyPass = validateNetworkProxyConfig({
      ...valid(),
      proxy: { ...valid().proxy, username: '', password: 'secret' },
    })
    expect(onlyPass.ok).toBe(false)
    if (!onlyPass.ok) expect(onlyPass.errors.join('\n')).toContain('成对')

    // 两者皆空 / 两者皆非空均合法
    expect(validateNetworkProxyConfig(valid())).toEqual({ ok: true })
    expect(
      validateNetworkProxyConfig({ ...valid(), proxy: { ...valid().proxy, username: 'u', password: 'p' } }),
    ).toEqual({ ok: true })
  })

  it('空主机名条目拒绝（noProxy / rules 空串或纯空白），非数组拒绝', () => {
    const r = validateNetworkProxyConfig({ ...valid(), noProxy: ['localhost', '   '], rules: [''] })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.errors.some((e) => e.includes('noProxy'))).toBe(true)
      expect(r.errors.some((e) => e.includes('rules'))).toBe(true)
    }
    const notArray = validateNetworkProxyConfig({ ...valid(), noProxy: 'localhost' as never })
    expect(notArray.ok).toBe(false)
    if (!notArray.ok) expect(notArray.errors.join('\n')).toContain('noProxy')
  })

  it('主机名条目含空白字符拒绝（首尾与内部同等拒绝——内部空白对真实主机名恒不匹配，静默不生效）', () => {
    for (const bad of ['api. anthropic.com', 'api.anthropic .com', ' localhost']) {
      const r = validateNetworkProxyConfig({ ...valid(), rules: [bad] })
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.errors.join('\n')).toContain('含空白字符')
    }
  })

  it('代理地址 host 为空拒绝', () => {
    const r = validateNetworkProxyConfig({ ...valid(), proxy: { ...valid().proxy, host: '  ' } })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors.join('\n')).toContain('地址')
  })

  it('enabled 非 boolean 拒绝', () => {
    const r = validateNetworkProxyConfig({ ...valid(), enabled: 'yes' as never })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors.join('\n')).toContain('开关')
  })

  it('config / proxy 对象性守卫（null 与数组不抛 TypeError，走错误信封）', () => {
    for (const config of [null, [], 'str', 42]) {
      const r = validateNetworkProxyConfig(config as never)
      expect(r.ok, `config=${String(config)}`).toBe(false)
    }
    for (const proxy of [null, [], 'str']) {
      const r = validateNetworkProxyConfig({ ...valid(), proxy } as never)
      expect(r.ok, `proxy=${String(proxy)}`).toBe(false)
      if (!r.ok) expect(r.errors.join('\n')).toContain('代理服务器')
    }
  })

  it('错误逐项收集不短路（一次提交多处非法，errors 含全部条目）', () => {
    const r = validateNetworkProxyConfig({
      enabled: 'x' as never,
      proxy: { protocol: 'ftp' as never, host: '', port: 70000, username: 'u', password: '' },
      noProxy: [''],
      ipv4Only: [],
      rules: [],
    })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      // enabled + 协议 + host + 端口 + 凭据单边 + noProxy 空条目，至少 6 条
      expect(r.errors.length).toBeGreaterThanOrEqual(6)
    }
  })
})

describe('normalizeHostname', () => {
  it('转小写', () => {
    expect(normalizeHostname('API.Anthropic.COM')).toBe('api.anthropic.com')
  })

  it('去末尾点（FQDN 根点形态）', () => {
    expect(normalizeHostname('api.anthropic.com.')).toBe('api.anthropic.com')
  })

  it('大写 + 末尾点组合归一', () => {
    expect(normalizeHostname('API.Anthropic.COM.')).toBe('api.anthropic.com')
  })
})

describe('matchesHostPattern（suffix 点边界真值表）', () => {
  it('等于命中', () => {
    expect(matchesHostPattern('api.anthropic.com', 'api.anthropic.com')).toBe(true)
  })

  it('子域命中（.pattern 结尾）', () => {
    expect(matchesHostPattern('eu.api.anthropic.com', 'api.anthropic.com')).toBe(true)
  })

  it('无点前缀不命中（xapi 拼接绕过防护）', () => {
    expect(matchesHostPattern('xapi.anthropic.com', 'api.anthropic.com')).toBe(false)
  })

  it('恶意后缀不命中（evil.com 拼接防护）', () => {
    expect(matchesHostPattern('api-anthropic.com.evil.com', 'api.anthropic.com')).toBe(false)
  })

  it('归一化参与匹配（大写 / 末尾点两侧等价）', () => {
    expect(matchesHostPattern('API.Anthropic.COM.', 'api.anthropic.com')).toBe(true)
    expect(matchesHostPattern('api.anthropic.com', 'API.ANTHROPIC.COM.')).toBe(true)
  })

  it('noProxy 同语义（localhost 覆盖 localhost 与 *.localhost）', () => {
    expect(matchesHostPattern('localhost', 'localhost')).toBe(true)
    expect(matchesHostPattern('a.localhost', 'localhost')).toBe(true)
    expect(matchesHostPattern('notlocalhost', 'localhost')).toBe(false)
  })

  it('空串不命中任何条目', () => {
    expect(matchesHostPattern('', 'api.anthropic.com')).toBe(false)
    expect(matchesHostPattern('api.anthropic.com', '')).toBe(false)
    expect(matchesHostPattern('', '')).toBe(false)
  })
})
