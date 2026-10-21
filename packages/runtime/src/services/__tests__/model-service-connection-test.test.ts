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

/** 装配 ModelService（configService 只需 listProviders / getProvider）。 */
function makeService(configService: { listProviders: () => ProviderInfo[]; getProvider: (id: string) => { baseUrl?: string } | undefined }) {
  const service = new ModelService({ discoverFromApi: vi.fn() } as never)
  service.setServices({} as never, configService as never, {} as never)
  return service
}

/** 凭据 miss 断言共用装配：带 openai-completions 模型 m1 的 custom-1（原始 provider 定义缺省）。 */
function makeServiceWithM1() {
  return makeService({
    listProviders: () => [makeProvider('custom-1', [{ id: 'm1', api: 'openai-completions', baseUrl: 'https://api.example' }])],
    getProvider: () => undefined,
  })
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
    vi.unstubAllGlobals()
    if (server) {
      await new Promise<void>(resolve => { server!.close(() => resolve()) })
      server = undefined
    }
  })

  it('anthropic-messages → POST {baseUrl}/v1/messages，x-api-key + anthropic-version + max_tokens:1', async () => {
    const baseUrl = await startStub()
    const result = await new ModelConnectionTester().test({ api: 'anthropic-messages', modelId: 'k3', baseUrl, apiKey: 'sk-a' })
    expect(result.api).toBe('anthropic-messages')
    expect(result.modelId).toBe('k3')
    expect(result.ok).toBe(true)
    expect(result.durationMs).toBeTypeOf('number')
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

  // ── x-opencode-session / x-opencode-client 注入（2026-10-21，与 pi 真实聊天请求同源）──
  // 判定口径与 pi getSessionHeaders 同源（@earendil-works/pi-coding-agent@1.0.0
  // provider-attribution.js:50-59）：provider id ∈ {opencode, opencode-go} 或 hostname
  // 严格 = opencode.ai，双分支。fetch 经 vi.stubGlobal 拦截（不真发外网），断言
  // init.headers 的注入行为。

  /** fetch stub：捕获 (url, init) 后回 200 空体，不产生真实网络请求。 */
  function stubFetch(): Array<{ url: string; headers: Record<string, string> }> {
    const calls: Array<{ url: string; headers: Record<string, string> }> = []
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: { headers?: Record<string, string> }) => {
      calls.push({ url: String(_url), headers: init?.headers ?? {} })
      return new Response('{}', { status: 200 })
    }))
    return calls
  }

  it('opencode 端点（hostname=opencode.ai）→ 注入一次性 x-opencode-session（test- 前缀，两次调用值不同）+ x-opencode-client=pi', async () => {
    const calls = stubFetch()
    const tester = new ModelConnectionTester()
    const req = { api: 'openai-completions' as const, modelId: 'deepseek-v4-flash', apiKey: 'k' }
    await tester.test({ ...req, baseUrl: 'https://opencode.ai/zen/go/v1' })
    await tester.test({ ...req, baseUrl: 'https://opencode.ai/zen/go/v1/' })
    expect(calls).toHaveLength(2)
    const first = calls[0]!.headers['x-opencode-session']
    expect(first).toMatch(/^test-/)
    expect(calls[1]!.headers['x-opencode-session']).toMatch(/^test-/)
    expect(calls[1]!.headers['x-opencode-session']).not.toBe(first)
    // client 头与 pi attribution 层同构（真实聊天同批注入，测试请求等价）
    expect(calls[0]!.headers['x-opencode-client']).toBe('pi')
    expect(calls[0]!.url).toBe('https://opencode.ai/zen/go/v1/chat/completions')
  })

  it('provider-id 命中分支（opencode / opencode-go + 自定义网关 baseUrl）→ 同样注入（与 pi 双分支判定一致）', async () => {
    // 内置 opencode provider 配自定义网关/镜像的形态：真实聊天按 provider id 注入，
    // 测试请求只判 baseUrl 会漏注入 → 测试 400 而聊天可用（脱节）
    const calls = stubFetch()
    const tester = new ModelConnectionTester()
    const req = { api: 'openai-completions' as const, modelId: 'm1', apiKey: 'k', baseUrl: 'https://gw.internal.example.com/v1' }
    await tester.test({ ...req, providerId: 'opencode' })
    await tester.test({ ...req, providerId: 'opencode-go' })
    expect(calls).toHaveLength(2)
    expect(calls[0]!.headers['x-opencode-session']).toMatch(/^test-/)
    expect(calls[0]!.headers['x-opencode-client']).toBe('pi')
    expect(calls[1]!.headers['x-opencode-session']).toMatch(/^test-/)
  })

  it('非 opencode 端点 / 子域（api.opencode.ai）/ 非 opencode 系 providerId → 不注入', async () => {
    const calls = stubFetch()
    const tester = new ModelConnectionTester()
    await tester.test({ api: 'openai-completions', modelId: 'm1', baseUrl: 'https://api.deepseek.com', apiKey: 'k', providerId: 'deepseek' })
    await tester.test({ api: 'openai-completions', modelId: 'm2', baseUrl: 'https://api.opencode.ai/v1', apiKey: 'k' })
    expect(calls).toHaveLength(2)
    expect(calls[0]!.headers['x-opencode-session']).toBeUndefined()
    expect(calls[0]!.headers['x-opencode-client']).toBeUndefined()
    expect(calls[1]!.headers['x-opencode-session']).toBeUndefined()
    vi.unstubAllGlobals()
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
    const outcome = await makeServiceWithM1().testProviderConnections('custom-1', undefined, tester)
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
      providerId: 'opencode-go',
    })
  })
})

describe('ModelService.testProviderModel：单模型测试（per-model 行内入口）', () => {
  it('模型不在 provider.models → 行级 model_not_found（顶层仍 success:true，与已定论行同形）', async () => {
    const service = makeService({
      listProviders: () => [makeProvider('custom-1', [{ id: 'm1', api: 'openai-completions', baseUrl: 'https://api.example' }])],
      getProvider: () => undefined,
    })
    const outcome = await service.testProviderModel('custom-1', 'ghost', 'key', stubTester())
    expect(outcome.success).toBe(true)
    if (outcome.success) {
      expect(outcome.results).toEqual([{ api: '', modelId: 'ghost', ok: false, error: 'model_not_found' }])
    }
  })

  it('凭据 miss → 顶层 no_api_key（与 provider 级测试同一硬停语义，不发请求）', async () => {
    const tester = stubTester()
    const outcome = await makeServiceWithM1().testProviderModel('custom-1', 'm1', undefined, tester)
    expect(outcome).toEqual({ success: false, error: PROVIDER_CONNECTION_TEST_ERRORS.noApiKey })
    expect(tester.test).not.toHaveBeenCalled()
  })

  it('协议缺省回落 provider 级；不支持协议 → unsupported 行；全缺端点 → no_base_url 行', async () => {
    const service = makeService({
      listProviders: () => [
        makeProvider('custom-1', [
          { id: 'm-noapi', baseUrl: 'https://api.example' },
          { id: 'm-badapi', api: 'google-generative-ai', baseUrl: 'https://api.example' },
          { id: 'm-nourl', api: 'openai-completions' },
        ]),
      ],
      getProvider: () => ({ baseUrl: 'https://provider.example' }),
    })
    // m-noapi：模型级 api 缺省 → 回落 provider 级（本 provider 未声明 api）→ unsupported
    const noApi = await service.testProviderModel('custom-1', 'm-noapi', 'key', stubTester())
    if (noApi.success) expect(noApi.results[0]).toMatchObject({ modelId: 'm-noapi', ok: false, error: 'unsupported' })
    // m-badapi：协议不在支持集 → unsupported
    const badApi = await service.testProviderModel('custom-1', 'm-badapi', 'key', stubTester())
    if (badApi.success) expect(badApi.results[0]).toMatchObject({ modelId: 'm-badapi', ok: false, error: 'unsupported' })
    // m-nourl：custom 模型级缺省 → 回落 provider 级 https://provider.example（有值）→ 正常发包。
    // 此处 provider 级有值，故改走「全缺」：用空 provider baseUrl 的独立 service。
    const noUrlService = makeService({
      listProviders: () => [makeProvider('custom-1', [{ id: 'm-nourl', api: 'openai-completions' }])],
      getProvider: () => undefined,
    })
    const noUrl = await noUrlService.testProviderModel('custom-1', 'm-nourl', 'key', stubTester())
    if (noUrl.success) expect(noUrl.results[0]).toMatchObject({ modelId: 'm-nourl', ok: false, error: 'no_base_url' })
  })

  it('正常路径：catalog 网关 override 优先于模型级 baseUrl（与 provider 级测试同一回落链），tester 收到凭据', async () => {
    const tester = {
      supports: (api: string) => api === 'anthropic-messages',
      test: vi.fn().mockImplementation(async (req: { api: string; modelId: string }) => ({ api: req.api, modelId: req.modelId, ok: true, durationMs: 5 })),
    }
    const service = makeService({
      // 'anthropic' 在快照内（isCatalogProvider=true），网关 override 必须赢过模型级 baseUrl
      listProviders: () => [makeProvider('anthropic', [{ id: 'claude-fable-5', api: 'anthropic-messages', baseUrl: 'https://model.example' }])],
      getProvider: () => ({ baseUrl: 'https://gw.corp.example' }),
    })
    const outcome = await service.testProviderModel('anthropic', 'claude-fable-5', 'sk-key', tester as never)
    expect(outcome.success).toBe(true)
    expect(tester.test).toHaveBeenCalledWith({
      api: 'anthropic-messages',
      modelId: 'claude-fable-5',
      baseUrl: 'https://gw.corp.example',
      apiKey: 'sk-key',
      providerId: 'anthropic',
    })
  })

  it('禁用态模型照样可测（per-model 显式指定即测，不做 enabled 过滤——测试不改配置）', async () => {
    const tester = {
      supports: (api: string) => api === 'openai-completions',
      test: vi.fn().mockResolvedValue({ api: 'openai-completions', modelId: 'm-off', ok: true }),
    }
    const service = makeService({
      listProviders: () => [makeProvider('custom-1', [{ id: 'm-off', api: 'openai-completions', baseUrl: 'https://api.example', enabled: false }])],
      getProvider: () => undefined,
    })
    const outcome = await service.testProviderModel('custom-1', 'm-off', 'key', tester as never)
    expect(outcome.success).toBe(true)
    expect(tester.test).toHaveBeenCalledTimes(1)
  })
})
