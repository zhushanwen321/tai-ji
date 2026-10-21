/**
 * LLM 网络代理配置域 message handler 测试（五条路由 + reply/broadcast + 校验失败错误信封
 * 不落盘——service 层真实 fs 断言）。
 *
 * 经 SettingsMessageHandler 全链路分发（路由表登记 + 域子 handler 委托同时锁定，dispatch
 * 特征锚定测试同款 makeHandler 形态）。
 */
import { describe, expect, it, vi } from 'vitest'
import { SettingsMessageHandler, type SettingsHandlerContext } from '../src/transport/settings-message-handler.js'
import type { ClientMessage, NetworkProxyConfig, ServerMessage } from '@taiji/shared'

function makeConfigService() {
  return {
    getNetworkProxyConfig: vi.fn().mockReturnValue({ enabled: false, proxy: {}, noProxy: [], rules: [] }),
    setNetworkProxyConfig: vi.fn().mockReturnValue({ ok: true }),
    testNetworkProxyConnection: vi.fn().mockResolvedValue({ ok: true, stage: 'done', message: 'ok', elapsedMs: 3 }),
    getNetworkProxyStats: vi.fn().mockReturnValue({ stats: [{ host: 'a.test', proxied: 1, direct: 2 }] }),
    resetNetworkProxyStats: vi.fn(),
  }
}

function makeHandler(configService = makeConfigService()) {
  const broadcasts: ServerMessage[] = []
  const replies: { id: string | undefined; type: string; payload: unknown }[] = []
  const sendErrorCalls: { id: string | undefined; code: string; message: string }[] = []
  const ctx = {
    send: vi.fn(),
    reply: vi.fn((_ws: unknown, id: string | undefined, type: string, payload: unknown) => {
      replies.push({ id, type, payload })
    }),
    sendError: vi.fn((_ws: unknown, code: string, message: string, id?: string) => {
      sendErrorCalls.push({ id, code, message })
    }),
    configService,
    sessionService: {},
    modelService: {},
    authService: {},
    skillRegistry: {},
    projectRoot: '/proj',
    nextPushId: vi.fn().mockReturnValue('push-1'),
    broadcast: vi.fn((m: ServerMessage) => broadcasts.push(m)),
    broadcastProviderList: vi.fn(),
    broadcastSkillList: vi.fn(),
    broadcastSkillCacheInvalidated: vi.fn(),
    broadcastAgentList: vi.fn(),
    broadcastSkillDirs: vi.fn(),
    broadcastAgentDirs: vi.fn(),
    broadcastExtensionDirs: vi.fn(),
    connectionTester: {},
    mcpServersService: undefined,
  }
  const handler = new SettingsMessageHandler(ctx as unknown as SettingsHandlerContext)
  return { handler, broadcasts, replies, sendErrorCalls, configService }
}

function msg(type: string, payload: Record<string, unknown>, id = 'm1'): ClientMessage {
  return { type, id, payload } as unknown as ClientMessage
}

const config: NetworkProxyConfig = {
  enabled: true,
  proxy: { protocol: 'http', host: '127.0.0.1', port: 7890, username: '', password: '' },
  noProxy: ['localhost'],
  rules: ['api.anthropic.com'],
  ipv4Only: [],
}

describe('network-proxy 五条路由（经 SettingsMessageHandler 全链路）', () => {
  it('config.getNetworkProxy → reply config.networkProxy {config}', async () => {
    const { handler, replies, configService } = makeHandler()
    const handled = await handler.handleSettingsMessage(msg('config.getNetworkProxy', {}), {} as never)
    expect(handled).toBe(true)
    expect(configService.getNetworkProxyConfig).toHaveBeenCalledOnce()
    expect(replies).toEqual([
      { id: 'm1', type: 'config.networkProxy', payload: { config: { enabled: false, proxy: {}, noProxy: [], rules: [] } } },
    ])
  })

  it('config.setNetworkProxy 成功 → reply + broadcast config.networkProxy = 落盘终态（读回生效值）', async () => {
    const { handler, replies, broadcasts, configService } = makeHandler()
    const handled = await handler.handleSettingsMessage(msg('config.setNetworkProxy', { config }), {} as never)
    expect(handled).toBe(true)
    expect(configService.setNetworkProxyConfig).toHaveBeenCalledWith(config)
    // 写侧 dedupeHostList 是确定性变换（请求值 ≠ 生效值）：reply/broadcast 读回落盘终态，
    // 消费侧（ADR-0065 分支一）以服务端终态校准，禁乐观写请求值
    expect(configService.getNetworkProxyConfig).toHaveBeenCalledOnce()
    const effective = { enabled: false, proxy: {}, noProxy: [], rules: [] }
    expect(replies).toEqual([{ id: 'm1', type: 'config.networkProxy', payload: { config: effective } }])
    expect(broadcasts).toEqual([
      { type: 'config.networkProxy', id: 'push-1', payload: { config: effective } },
    ])
  })

  it('config.setNetworkProxy 校验失败 → 错误信封（不 reply 不 broadcast），service 返回错误清单', async () => {
    const failing = makeConfigService()
    failing.setNetworkProxyConfig.mockReturnValue({ ok: false, errors: ['代理端口必须是 1-65535 的整数: 70000，请填写正确的端口'] })
    const { handler, replies, broadcasts, sendErrorCalls } = makeHandler(failing)
    const handled = await handler.handleSettingsMessage(
      msg('config.setNetworkProxy', { config: { ...config, proxy: { ...config.proxy, port: 70000 } } }),
      {} as never,
    )
    expect(handled).toBe(true)
    expect(sendErrorCalls).toEqual([
      {
        id: 'm1',
        code: 'set_network_proxy_failed',
        message: '代理端口必须是 1-65535 的整数: 70000，请填写正确的端口',
      },
    ])
    expect(replies).toEqual([])
    expect(broadcasts).toEqual([])
  })

  it('config.testNetworkProxy → reply config.networkProxyTest（探测结果信封）', async () => {
    const { handler, replies, configService } = makeHandler()
    const handled = await handler.handleSettingsMessage(msg('config.testNetworkProxy', { config }), {} as never)
    expect(handled).toBe(true)
    expect(configService.testNetworkProxyConnection).toHaveBeenCalledWith(config)
    expect(replies).toEqual([
      { id: 'm1', type: 'config.networkProxyTest', payload: { ok: true, stage: 'done', message: 'ok', elapsedMs: 3 } },
    ])
  })

  it('config.getNetworkProxyStats → reply config.networkProxyStats {stats, truncatedNote?}', async () => {
    const { handler, replies, configService } = makeHandler()
    const handled = await handler.handleSettingsMessage(msg('config.getNetworkProxyStats', { range: '7d' }), {} as never)
    expect(handled).toBe(true)
    expect(configService.getNetworkProxyStats).toHaveBeenCalledWith('7d')
    expect(replies[0]?.type).toBe('config.networkProxyStats')
    expect(replies[0]?.payload).toEqual({ stats: [{ host: 'a.test', proxied: 1, direct: 2 }] })
  })

  it('config.resetNetworkProxyStats → 追加水位 + reply 清零后的统计（all 档）', async () => {
    const { handler, replies, configService } = makeHandler()
    const handled = await handler.handleSettingsMessage(msg('config.resetNetworkProxyStats', {}), {} as never)
    expect(handled).toBe(true)
    expect(configService.resetNetworkProxyStats).toHaveBeenCalledOnce()
    // reset 回清零后的统计（all 档，消费侧直接刷新视图——协议注释契约）
    expect(configService.getNetworkProxyStats).toHaveBeenCalledWith('all')
    expect(replies[0]?.type).toBe('config.networkProxyStats')
  })
})

describe('set 校验失败不落盘（service 层真实 fs）', () => {
  it('非法配置（端口越界）service 校验失败后文件不被创建', async () => {
    const { mkdtempSync, mkdirSync, rmSync, statSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const tmpDataDir = mkdtempSync(join(tmpdir(), 'network-proxy-handler-'))
    const savedEnv = process.env.TAIJI_AGENT_DATA_DIR
    process.env.TAIJI_AGENT_DATA_DIR = tmpDataDir
    mkdirSync(join(tmpDataDir, 'agent'), { recursive: true })
    try {
      const { setNetworkProxyConfig } = await import('../src/services/network-proxy-config.js')
      const { getPiAgentDir } = await import('../src/infra/pi/pi-paths.js')
      const configPath = join(getPiAgentDir(), 'config', 'network-proxy-ext-config.json')
      const bad: NetworkProxyConfig = { ...config, proxy: { ...config.proxy, port: 70000 } }
      expect(setNetworkProxyConfig(bad).ok).toBe(false)
      expect(statSync(configPath, { throwIfNoEntry: false })).toBeUndefined()
    } finally {
      if (savedEnv === undefined) delete process.env.TAIJI_AGENT_DATA_DIR
      else process.env.TAIJI_AGENT_DATA_DIR = savedEnv
      rmSync(tmpDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })
})
