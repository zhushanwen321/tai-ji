/**
 * LLM 网络代理配置域 runtime 侧测试（配置 RMW 读写 + 0600 落盘 + RMW 锁协议互通 +
 * atomicWrite mode 透传默认路径回归）。
 *
 * llm-network-proxy 设计 §5 U3；数据目录经 TAIJI_AGENT_DATA_DIR 钉到 mkdtemp tmp
 * （测试禁触碰真实数据目录，fs-guard 防线白名单内）。
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  DEFAULT_NETWORK_PROXY_CONFIG,
  validateNetworkProxyConfig,
  type NetworkProxyConfig,
} from '@taiji/shared'
import {
  getNetworkProxyConfig,
  setNetworkProxyConfig,
} from '../src/services/network-proxy-config.js'
import { atomicWrite } from '../src/utils/fs-utils.js'
import { getPiAgentDir } from '../src/infra/pi/pi-paths.js'

let tmpDataDir: string
let savedEnv: string | undefined

beforeEach(() => {
  tmpDataDir = mkdtempSync(join(tmpdir(), 'network-proxy-config-test-'))
  mkdirSync(join(tmpDataDir, 'agent'), { recursive: true })
  savedEnv = process.env.TAIJI_AGENT_DATA_DIR
  process.env.TAIJI_AGENT_DATA_DIR = tmpDataDir
})

afterEach(() => {
  rmSync(tmpDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

afterAll(() => {
  if (savedEnv === undefined) delete process.env.TAIJI_AGENT_DATA_DIR
  else process.env.TAIJI_AGENT_DATA_DIR = savedEnv
})

function configPath(): string {
  return join(getPiAgentDir(), 'config', 'network-proxy-ext-config.json')
}

function validConfig(overrides: Partial<NetworkProxyConfig> = {}): NetworkProxyConfig {
  return {
    enabled: true,
    proxy: { protocol: 'http', host: '127.0.0.1', port: 7890, username: '', password: '' },
    noProxy: ['localhost'],
    rules: ['api.anthropic.com'],
    ...overrides,
  }
}

describe('getNetworkProxyConfig（读 + normalize + 缺失回默认）', () => {
  it('文件不存在 → 完整默认配置', () => {
    expect(getNetworkProxyConfig()).toEqual(DEFAULT_NETWORK_PROXY_CONFIG)
  })

  it('坏 JSON → 默认配置（读侧不抛错）', () => {
    mkdirSync(join(getPiAgentDir(), 'config'), { recursive: true })
    writeFileSync(configPath(), '{not json', 'utf-8')
    expect(getNetworkProxyConfig()).toEqual(DEFAULT_NETWORK_PROXY_CONFIG)
  })

  it('字段非法逐字段回默认（其余合法字段保留）', () => {
    mkdirSync(join(getPiAgentDir(), 'config'), { recursive: true })
    writeFileSync(configPath(), JSON.stringify({
      enabled: 'yes', // 非布尔 → 回默认 false
      proxy: { protocol: 'ftp', host: '', port: 70000, username: 'u' }, // 全非法 + 凭据单边 → 归一双清
      noProxy: 'not-array', // 非列表 → []
      rules: ['api.anthropic.com', '', 42], // 合法条目保留，空白/非字符串过滤
    }), 'utf-8')
    const config = getNetworkProxyConfig()
    expect(config.enabled).toBe(DEFAULT_NETWORK_PROXY_CONFIG.enabled)
    expect(config.proxy).toEqual({ protocol: 'http', host: '127.0.0.1', port: 7890, username: '', password: '' })
    expect(config.noProxy).toEqual([])
    expect(config.rules).toEqual(['api.anthropic.com'])
  })
})

describe('setNetworkProxyConfig（校验失败不落盘 / 成功 RMW 0600 / 序列化契约）', () => {
  it('校验失败（端口越界 + 凭据单边）返回错误清单且不落盘', () => {
    mkdirSync(join(getPiAgentDir(), 'config'), { recursive: true })
    writeFileSync(configPath(), 'ORIGINAL', 'utf-8')
    const bad = validConfig({
      proxy: { protocol: 'http', host: '127.0.0.1', port: 70000, username: 'u', password: '' },
    })
    const result = setNetworkProxyConfig(bad)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.length).toBeGreaterThan(0)
    expect(readFileSync(configPath(), 'utf-8')).toBe('ORIGINAL')
  })

  it('校验失败（文件尚不存在）不创建文件', () => {
    const result = setNetworkProxyConfig(validConfig({ noProxy: [''] })) // 空白条目非法
    expect(result.ok).toBe(false)
    expect(statSync(configPath(), { throwIfNoEntry: false })).toBeUndefined()
  })

  it('成功写入：mode 0600 + 2 空格缩进 + 尾换行（与 llm-shared saveConfig 序列化逐字一致）', () => {
    const result = setNetworkProxyConfig(validConfig())
    expect(result.ok).toBe(true)
    const stat = statSync(configPath())
    // 权限断言（POSIX 位；umask 不影响显式 mode）
    expect(stat.mode & 0o777).toBe(0o600)
    const content = readFileSync(configPath(), 'utf-8')
    expect(content.endsWith('\n')).toBe(true)
    expect(content).toBe(`${JSON.stringify(JSON.parse(content), null, 2)}\n`)
    expect(JSON.parse(content)).toEqual(validConfig())
  })

  it('RMW 保留文件内未知字段（extension 侧字段不丢）', () => {
    mkdirSync(join(getPiAgentDir(), 'config'), { recursive: true })
    const withExtra = { ...validConfig(), extensionFutureField: 'keep-me' }
    writeFileSync(configPath(), `${JSON.stringify(withExtra, null, 2)}\n`, 'utf-8')
    const result = setNetworkProxyConfig(validConfig({ rules: ['changed.example.test'] }))
    expect(result.ok).toBe(true)
    const parsed = JSON.parse(readFileSync(configPath(), 'utf-8')) as Record<string, unknown>
    expect(parsed['extensionFutureField']).toBe('keep-me')
    expect(parsed['rules']).toEqual(['changed.example.test'])
  })

  it('共享 shared 校验函数（写侧与 settings 表单同一套语义）', () => {
    // sanity：service 直接复用 validateNetworkProxyConfig——同输入同结果
    const bad = { ...validConfig(), enabled: 'yes' } as unknown as NetworkProxyConfig
    expect(setNetworkProxyConfig(bad)).toEqual(validateNetworkProxyConfig(bad))
  })
})

describe('RMW 与 extension 侧锁协议互通（写后字段不丢）', () => {
  it('extension 形态全量写与 runtime RMW 字段写交错，双方字段共存', () => {
    mkdirSync(join(getPiAgentDir(), 'config'), { recursive: true })
    // 模拟 extension llm-shared saveConfig 全量写（带自身字段）
    writeFileSync(configPath(), `${JSON.stringify({ ...validConfig(), extensionCounter: 1 }, null, 2)}\n`, 'utf-8')
    // runtime RMW 覆盖四字段
    expect(setNetworkProxyConfig(validConfig({ enabled: false })).ok).toBe(true)
    // 模拟 extension 再次全量写（读-改-写：读当前文件、改自己字段、写回——同锁协议形态）
    const current = JSON.parse(readFileSync(configPath(), 'utf-8')) as Record<string, unknown>
    current['extensionCounter'] = 2
    writeFileSync(configPath(), `${JSON.stringify(current, null, 2)}\n`, 'utf-8')
    const final = JSON.parse(readFileSync(configPath(), 'utf-8')) as Record<string, unknown>
    // runtime 的四字段与 extension 的字段共存，后写不覆盖先写字段
    expect(final['enabled']).toBe(false)
    expect(final['extensionCounter']).toBe(2)
    expect(getNetworkProxyConfig().enabled).toBe(false)
  })
})

describe('atomicWrite mode 透传（默认路径回归）', () => {
  const tmpProbe = mkdtempSync(join(tmpdir(), 'network-proxy-atomic-'))
  afterAll(() => {
    rmSync(tmpProbe, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  it('不传 mode：权限 = 默认（0o666 & ~umask），与既有调用方行为一致', () => {
    const file = join(tmpProbe, 'default-mode.json')
    atomicWrite(file, 'x')
    expect(statSync(file).mode & 0o777).toBe(0o666 & ~process.umask())
  })

  it('传 mode 0o600：创建即 0600（rename 保留 tmp 权限位）', () => {
    const file = join(tmpProbe, 'restricted-mode.json')
    atomicWrite(file, 'secret', 'probe-suffix', 0o600)
    expect(statSync(file).mode & 0o777).toBe(0o600)
  })
})
