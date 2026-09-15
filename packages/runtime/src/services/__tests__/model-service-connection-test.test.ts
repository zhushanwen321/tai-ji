/**
 * M3a（design catalog-provider-field-authority §3.3 D4）runtime 侧单测：
 * - planConnectionTests：协议分组 + 代表模型双过滤 + baseUrl 回落链（纯函数）
 * - ModelConnectionTester：3 协议最小请求的 URL / 鉴权头 / body（本地 stub server，不打外网）
 * - ModelService.testProviderConnections：provider 级错误分支 + 行序稳定
 *
 * P-test-req 探针实测（2026-09-10，见 infra/model-connection-tester.ts 文件头）：
 * anthropic-messages（kimi-coding 真实端点）与 openai-completions（deepseek / xiaomi 真实端点）
 * 用 `max_tokens: 1` 调通（200），错误 key → 401 且响应体可区分；网络错 → TypeError: fetch failed。
 * openai-responses 本机无可用凭据，用 stub 验证形状：max_output_tokens 取 16（协议下限，pi-ai
 * `api/openai-responses.js:16-17`）而非设计字面值 1——用 1 会对全部 responses provider 稳定误报 400。
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { ProviderInfo } from '@taiji/shared'
import { ModelConnectionTester } from '../../infra/model-connection-tester.js'
import {
  ModelService,
  planConnectionTests,
  PROVIDER_CONNECTION_TEST_ERRORS,
} from '../model-service.js'

/** 只实现 supports 的测试替身（plan 阶段不发请求）。 */
function stubTester(supported: string[] = ['anthropic-messages', 'openai-completions', 'openai-responses']) {
  return {
    supports: (api: string) => supported.includes(api),
    test: vi.fn().mockResolvedValue({ api: '', modelId: '', ok: true }),
  }
}

function makeProvider(id: string, models: ProviderInfo['models'], extra: Partial<ProviderInfo> = {}): ProviderInfo {
  // ProviderId 是品牌类型（编译期擦除），测试构造点经索引访问提升（反序列化边界同款做法）
  const base: ProviderInfo = { id: id as ProviderInfo['id'], name: id, apiKeySet: true, status: 'connected', models }
  return Object.assign(base, extra)
}

/** 计划里唯一的发包目标（断言便捷；无目标即失败，让断言错误指向根因）。 */
function onlyTarget(entries: ReturnType<typeof planConnectionTests>) {
  const targets = entries.flatMap(e => ('target' in e && e.target ? [e.target] : []))
  expect(targets).toHaveLength(1)
  return targets[0]
}

/** 计划里唯一的已定论错误行。 */
function onlySettled(entries: ReturnType<typeof planConnectionTests>) {
  const rows = entries.flatMap(e => ('settled' in e && e.settled ? [e.settled] : []))
  expect(rows).toHaveLength(1)
  return rows[0]
}

describe('planConnectionTests：代表模型双过滤', () => {
  const tester = stubTester()

  it('组内第一个模型 enabled=false → 跳过，选下一个启用的模型', () => {
    const provider = makeProvider('custom-1', [
      { id: 'm-disabled', api: 'openai-completions', baseUrl: 'https://api.example', enabled: false },
      { id: 'm-enabled', api: 'openai-completions', baseUrl: 'https://api.example' },
    ])
    const target = onlyTarget(planConnectionTests('custom-1', provider, undefined, tester))
    expect(target.modelId).toBe('m-enabled')
    expect(target.baseUrl).toBe('https://api.example')
  })

  it('组内第一个模型 baseUrl 为空（且无 provider 级回落）→ 跳过，选下一个有 baseUrl 的模型', () => {
    const provider = makeProvider('custom-1', [
      { id: 'm-no-baseurl', api: 'openai-completions' },
      { id: 'm-with-baseurl', api: 'openai-completions', baseUrl: 'https://api.example' },
    ])
    const target = onlyTarget(planConnectionTests('custom-1', provider, undefined, tester))
    expect(target.modelId).toBe('m-with-baseurl')
  })

  it('该协议组全部模型被禁用 → no_enabled_model（不发包）', () => {
    const provider = makeProvider('custom-1', [
      { id: 'm1', api: 'openai-completions', baseUrl: 'https://api.example', enabled: false },
      { id: 'm2', api: 'openai-completions', baseUrl: 'https://api.example', enabled: false },
    ])
    const entries = planConnectionTests('custom-1', provider, undefined, tester)
    expect(onlySettled(entries).error).toBe('no_enabled_model')
    expect(entries.some(e => 'target' in e)).toBe(false)
    expect(tester.test).not.toHaveBeenCalled()
  })

  it('协议不在支持集 → unsupported（优先于 baseUrl 判定）', () => {
    const provider = makeProvider('custom-1', [{ id: 'm1', api: 'google-generative-ai' }])
    const entries = planConnectionTests('custom-1', provider, undefined, tester)
    expect(onlySettled(entries)).toMatchObject({ api: 'google-generative-ai', error: 'unsupported' })
    expect(entries.some(e => 'target' in e)).toBe(false)
  })

  it('按协议分组：多协议各取各的代表（组序 = 模型首现序）', () => {
    const provider = makeProvider('opencode-go', [
      { id: 'a1', api: 'anthropic-messages', baseUrl: 'https://api.example/anthropic' },
      { id: 'o1', api: 'openai-completions', baseUrl: 'https://api.example/v1' },
      { id: 'a2', api: 'anthropic-messages', baseUrl: 'https://api.example/anthropic' },
    ])
    const entries = planConnectionTests('opencode-go', provider, undefined, tester)
    expect(entries).toHaveLength(2)
    const targets = entries.flatMap(e => ('target' in e && e.target ? [e.target] : []))
    expect(targets.map(t => `${t.api}/${t.modelId}`)).toEqual([
      'anthropic-messages/a1',
      'openai-completions/o1',
    ])
  })

  it('模型级 api 缺省 → 回落 provider 级 api 分组（pi modelFromJson `definition.api ?? providerConfig.api`）', () => {
    const provider = makeProvider(
      'custom-1',
      [
        { id: 'm1', baseUrl: 'https://api.example' },
        { id: 'm2', baseUrl: 'https://api.example' },
      ],
      { api: 'openai-completions' },
    )
    const entries = planConnectionTests('custom-1', provider, undefined, tester)
    const targets = entries.flatMap(e => ('target' in e && e.target ? [e.target] : []))
    expect(targets.map(t => `${t.api}/${t.modelId}`)).toEqual(['openai-completions/m1'])
  })
})

describe('planConnectionTests：baseUrl 四级回落链', () => {
  const tester = stubTester()
  const models: ProviderInfo['models'] = [{ id: 'm1', api: 'openai-completions', baseUrl: 'https://model.example/v1' }]

  it('第 1 级：custom 模型级 baseUrl', () => {
    const provider = makeProvider('custom-1', models)
    const target = onlyTarget(planConnectionTests('custom-1', provider, undefined, tester))
    expect(target.baseUrl).toBe('https://model.example/v1')
  })

  it('第 2 级：custom provider 级 baseUrl（模型级缺省时回落，pi `definition.baseUrl ?? providerConfig.baseUrl`）', () => {
    const provider = makeProvider('custom-1', [{ id: 'm1', api: 'openai-completions' }])
    const target = onlyTarget(planConnectionTests('custom-1', provider, 'https://provider.example', tester))
    expect(target.baseUrl).toBe('https://provider.example')
  })

  it('custom 模型级优先于 provider 级', () => {
    const provider = makeProvider('custom-1', models)
    const target = onlyTarget(planConnectionTests('custom-1', provider, 'https://provider.example', tester))
    expect(target.baseUrl).toBe('https://model.example/v1')
  })

  it('第 3 级：catalog 网关 override（覆盖生效语义，优先于模型级——pi applyModelsJson `config.baseUrl ?? model.baseUrl`）', () => {
    // 'anthropic' 在快照内（isCatalogProvider=true）；m1 自带模型级 baseUrl，网关 override 必须赢
    const provider = makeProvider('anthropic', [{ id: 'claude-fable-5', api: 'anthropic-messages', baseUrl: 'https://model.example' }])
    const target = onlyTarget(planConnectionTests('anthropic', provider, 'https://gw.corp.example/anthropic', tester))
    expect(target.baseUrl).toBe('https://gw.corp.example/anthropic')
  })

  it('第 4 级：全缺 → no_base_url（如实归类，不冒充网络错误；不发包）', () => {
    const provider = makeProvider('custom-1', [{ id: 'm1', api: 'openai-completions' }])
    const entries = planConnectionTests('custom-1', provider, undefined, tester)
    expect(onlySettled(entries)).toMatchObject({ api: 'openai-completions', error: 'no_base_url' })
    expect(entries.some(e => 'target' in e)).toBe(false)
  })

  it('空白串视同缺省（trim 后空串不当作 baseUrl）', () => {
    const provider = makeProvider('custom-1', [{ id: 'm1', api: 'openai-completions', baseUrl: '   ' }])
    const entries = planConnectionTests('custom-1', provider, '', tester)
    expect(onlySettled(entries).error).toBe('no_base_url')
  })
})

describe('ModelConnectionTester：3 协议最小请求（本地 stub server）', () => {
  let server: Server | undefined
  let captured: Array<{ url: string; headers: Record<string, string | string[] | undefined>; body: string }> = []

  /** 启动 stub：记录请求并回固定响应（默认 200）。 */
  async function startStub(status = 200, responseBody = '{}'): Promise<string> {
    server = createServer((req, res) => {
      let raw = ''
      req.on('data', (chunk) => { raw += chunk })
      req.on('end', () => {
        captured.push({ url: req.url ?? '', headers: req.headers, body: raw })
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(responseBody)
      })
    })
    await new Promise<void>(resolve => { server!.listen(0, '127.0.0.1', resolve) })
    const { port } = server.address() as AddressInfo
    return `http://127.0.0.1:${port}`
  }

  afterEach(async () => {
    captured = []
    if (server) {
      await new Promise<void>(resolve => { server!.close(() => resolve()) })
      server = undefined
    }
  })

  it('anthropic-messages → POST {baseUrl}/v1/messages，x-api-key + anthropic-version + max_tokens:1', async () => {
    const baseUrl = await startStub()
    const result = await new ModelConnectionTester().test({ api: 'anthropic-messages', modelId: 'k3', baseUrl, apiKey: 'sk-a' })
    expect(result).toEqual({ api: 'anthropic-messages', modelId: 'k3', ok: true })
    expect(captured).toHaveLength(1)
    expect(captured[0].url).toBe('/v1/messages')
    expect(captured[0].headers['x-api-key']).toBe('sk-a')
    expect(captured[0].headers['anthropic-version']).toBe('2023-06-01')
    const body = JSON.parse(captured[0].body) as Record<string, unknown>
    expect(body.model).toBe('k3')
    expect(body.max_tokens).toBe(1)
    expect(body.messages).toEqual([{ role: 'user', content: 'ping' }])
  })

  it('openai-completions → POST {baseUrl}/chat/completions，Bearer + max_tokens:1', async () => {
    const baseUrl = await startStub()
    const result = await new ModelConnectionTester().test({ api: 'openai-completions', modelId: 'deepseek-chat', baseUrl: `${baseUrl}/v1`, apiKey: 'sk-b' })
    expect(result.ok).toBe(true)
    expect(captured[0].url).toBe('/v1/chat/completions')
    expect(captured[0].headers.authorization).toBe('Bearer sk-b')
    const body = JSON.parse(captured[0].body) as Record<string, unknown>
    expect(body.model).toBe('deepseek-chat')
    expect(body.max_tokens).toBe(1)
    expect(body.messages).toEqual([{ role: 'user', content: 'ping' }])
  })

  it('openai-responses → POST {baseUrl}/responses，Bearer + max_output_tokens:16（协议下限，P-test-req）', async () => {
    const baseUrl = await startStub()
    const result = await new ModelConnectionTester().test({ api: 'openai-responses', modelId: 'gpt-5.6-luna', baseUrl: `${baseUrl}/v1`, apiKey: 'sk-c' })
    expect(result.ok).toBe(true)
    expect(captured[0].url).toBe('/v1/responses')
    expect(captured[0].headers.authorization).toBe('Bearer sk-c')
    const body = JSON.parse(captured[0].body) as Record<string, unknown>
    expect(body.model).toBe('gpt-5.6-luna')
    // 16 = OpenAI Responses 硬下限（pi-ai api/openai-responses.js:16-17）；用 1 会被 400 拒绝
    expect(body.max_output_tokens).toBe(16)
    expect(body.input).toBe('ping')
  })

  it('baseUrl 末尾斜杠不产生双斜杠（归一化）', async () => {
    const baseUrl = await startStub()
    await new ModelConnectionTester().test({ api: 'openai-completions', modelId: 'm', baseUrl: `${baseUrl}/v1///`, apiKey: 'k' })
    expect(captured[0].url).toBe('/v1/chat/completions')
  })

  it('非 2xx → http_error|<status>|<响应体截断>（如实带回状态码与真实原因）', async () => {
    const baseUrl = await startStub(401, JSON.stringify({ error: { message: 'The API Key appears to be invalid' } }))
    const result = await new ModelConnectionTester().test({ api: 'anthropic-messages', modelId: 'k3', baseUrl, apiKey: 'bad' })
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/^http_error\|401\|/)
    expect(result.error).toContain('The API Key appears to be invalid')
  })

  it('不可达端点 → network_error|<message>（不冒充 HTTP 错误）', async () => {
    const result = await new ModelConnectionTester().test({ api: 'openai-completions', modelId: 'm', baseUrl: 'http://127.0.0.1:1', apiKey: 'k' })
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/^network_error\|/)
  })

  it('未知协议 → unsupported（防御：调用方未按 supports 过滤时也不发包）', async () => {
    const result = await new ModelConnectionTester().test({ api: 'google-generative-ai', modelId: 'm', baseUrl: 'http://127.0.0.1:1' })
    expect(result).toEqual({ api: 'google-generative-ai', modelId: 'm', ok: false, error: 'unsupported' })
  })

  it('supports()：三协议 true、其他 false', () => {
    const tester = new ModelConnectionTester()
    expect(tester.supports('anthropic-messages')).toBe(true)
    expect(tester.supports('openai-completions')).toBe(true)
    expect(tester.supports('openai-responses')).toBe(true)
    expect(tester.supports('google-vertex')).toBe(false)
  })
})

describe('ModelService.testProviderConnections：provider 级错误分支与行序', () => {
  /** 装配 ModelService（configService 只需 listProviders / getProvider）。 */
  function makeService(configService: { listProviders: () => ProviderInfo[]; getProvider: (id: string) => { baseUrl?: string } | undefined }) {
    const service = new ModelService({ discoverFromApi: vi.fn() } as never)
    service.setServices({} as never, configService as never, {} as never)
    return service
  }

  it('providerId 不在聚合列表 → provider_not_found', async () => {
    const service = makeService({ listProviders: () => [], getProvider: () => undefined })
    const outcome = await service.testProviderConnections('nope', 'key', stubTester())
    expect(outcome).toEqual({ success: false, error: PROVIDER_CONNECTION_TEST_ERRORS.providerNotFound })
  })

  it('provider 无模型 → no_models', async () => {
    const service = makeService({
      listProviders: () => [makeProvider('custom-1', [])],
      getProvider: () => undefined,
    })
    const outcome = await service.testProviderConnections('custom-1', 'key', stubTester())
    expect(outcome).toEqual({ success: false, error: PROVIDER_CONNECTION_TEST_ERRORS.noModels })
  })

  it('凭据 resolver 全源 miss（apiKey undefined）→ no_api_key（不发任何请求）', async () => {
    const tester = stubTester()
    const service = makeService({
      listProviders: () => [makeProvider('custom-1', [{ id: 'm1', api: 'openai-completions', baseUrl: 'https://api.example' }])],
      getProvider: () => undefined,
    })
    const outcome = await service.testProviderConnections('custom-1', undefined, tester)
    expect(outcome).toEqual({ success: false, error: PROVIDER_CONNECTION_TEST_ERRORS.noApiKey })
    expect(tester.test).not.toHaveBeenCalled()
  })

  it('全部模型无协议信息（模型级与 provider 级 api 皆缺）→ no_models', async () => {
    const service = makeService({
      listProviders: () => [makeProvider('custom-1', [{ id: 'm1', baseUrl: 'https://api.example' }])],
      getProvider: () => undefined,
    })
    const outcome = await service.testProviderConnections('custom-1', 'key', stubTester())
    expect(outcome).toEqual({ success: false, error: PROVIDER_CONNECTION_TEST_ERRORS.noModels })
  })

  it('成功：错误行与发包行按协议组序合并，发包带回落后的 baseUrl 与凭据', async () => {
    const tester = {
      supports: (api: string) => ['anthropic-messages', 'openai-completions', 'openai-responses'].includes(api),
      test: vi.fn().mockImplementation(async (req: { api: string; modelId: string }) => ({ api: req.api, modelId: req.modelId, ok: true })),
    }
    const provider = makeProvider('opencode-go', [
      { id: 'a1', api: 'anthropic-messages', baseUrl: 'https://api.example/anthropic' },
      { id: 'g1', api: 'google-generative-ai', baseUrl: 'https://api.example/google' },
      { id: 'o1', api: 'openai-completions' },
      { id: 'd1', api: 'openai-completions', enabled: false },
    ])
    const service = makeService({
      listProviders: () => [provider],
      getProvider: () => ({ baseUrl: 'https://provider.example' }),
    })
    const outcome = await service.testProviderConnections('opencode-go', 'sk-key', tester as never)
    expect(outcome.success).toBe(true)
    if (!outcome.success) return
    expect(outcome.results).toEqual([
      { api: 'anthropic-messages', modelId: 'a1', ok: true },
      { api: 'google-generative-ai', modelId: '', ok: false, error: 'unsupported' },
      { api: 'openai-completions', modelId: 'o1', ok: true },
    ])
    // custom provider：模型级缺省时回落 provider 级 baseUrl（第 2 级）
    expect(tester.test).toHaveBeenCalledWith({
      api: 'openai-completions',
      modelId: 'o1',
      baseUrl: 'https://provider.example',
      apiKey: 'sk-key',
    })
  })
})
