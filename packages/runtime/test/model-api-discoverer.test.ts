import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ModelApiDiscoverer } from '../src/infra/model-api-discoverer.js'

/**
 * ModelApiDiscoverer 经 HTTP 探测 LLM API。fetch 在 vitest 环境无原生实现，
 * 用 vi.stubGlobal 注入可控 mock，覆盖两套 provider / URL 构造 / 响应 shape 分支。
 */
type FetchCall = { url: string; headers: Record<string, string> }

function mockFetchJson(body: unknown, init?: { ok?: boolean; status?: number; statusText?: string }) {
  const ok = init?.ok ?? true
  const status = init?.status ?? 200
  return vi.fn(async (url: string | URL | Request, opts?: RequestInit) => {
    calls.push({ url: String(url), headers: (opts?.headers ?? {}) as Record<string, string> })
    return {
      ok,
      status,
      statusText: init?.statusText ?? '',
      json: async () => body,
      text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    } as unknown as Response
  })
}

// calls 必须在每次 mockFetchJson 重建前重置（beforeEach 里清）
let calls: FetchCall[] = []

function stubFetch(fn: ReturnType<typeof mockFetchJson>) {
  vi.stubGlobal('fetch', fn)
}

beforeEach(() => {
  calls = []
  vi.unstubAllGlobals()
})

describe('ModelApiDiscoverer.discoverFromApi', () => {
  it('openai-compatible: appends /v1/models when base lacks /v1', async () => {
    stubFetch(mockFetchJson({ data: [{ id: 'gpt-4', name: 'GPT-4' }] }))
    const models = await new ModelApiDiscoverer().discoverFromApi('https://api.openai.com', 'sk-x')
    expect(calls[0].url).toBe('https://api.openai.com/v1/models')
    expect(calls[0].headers['Authorization']).toBe('Bearer sk-x')
    expect(models).toEqual([{ id: 'gpt-4', name: 'GPT-4' }])
  })

  it('openai-compatible: uses /models when base already ends with /v1', async () => {
    stubFetch(mockFetchJson({ data: [{ id: 'm1' }] }))
    await new ModelApiDiscoverer().discoverFromApi('https://host/v1', 'sk-x')
    expect(calls[0].url).toBe('https://host/v1/models')
  })

  it('openai-compatible: strips trailing slashes before joining', async () => {
    stubFetch(mockFetchJson({ data: [] }))
    await new ModelApiDiscoverer().discoverFromApi('https://host///', undefined)
    expect(calls[0].url).toBe('https://host/v1/models')
    // no apiKey → no Authorization header
    expect(calls[0].headers['Authorization']).toBeUndefined()
  })

  it('anthropic: builds /v1/models with x-api-key + anthropic-version', async () => {
    stubFetch(mockFetchJson({ data: [{ id: 'claude-3' }] }))
    const models = await new ModelApiDiscoverer().discoverFromApi(
      'https://api.anthropic.com',
      'ant-key',
      'anthropic',
    )
    expect(calls[0].url).toBe('https://api.anthropic.com/v1/models')
    expect(calls[0].headers['x-api-key']).toBe('ant-key')
    expect(calls[0].headers['anthropic-version']).toBe('2023-06-01')
    expect(calls[0].headers['Authorization']).toBeUndefined()
    expect(models[0].id).toBe('claude-3')
  })

  it('throws when API responds non-2xx', async () => {
    stubFetch(mockFetchJson('upstream error', { ok: false, status: 503, statusText: 'Unavailable' }))
    await expect(new ModelApiDiscoverer().discoverFromApi('https://host', 'k')).rejects.toThrow(/503/)
  })

  it('parses { models: [...] } response shape', async () => {
    stubFetch(mockFetchJson({ models: [{ id: 'llama', name: 'Llama' }] }))
    const models = await new ModelApiDiscoverer().discoverFromApi('https://host/v1', 'k')
    expect(models).toEqual([{ id: 'llama', name: 'Llama' }])
  })

  it('returns [] when response has neither data nor models array', async () => {
    stubFetch(mockFetchJson({ foo: 'bar' }))
    const models = await new ModelApiDiscoverer().discoverFromApi('https://host/v1', 'k')
    expect(models).toEqual([])
  })

  it('filters out entries whose id is not a string', async () => {
    stubFetch(mockFetchJson({ data: [{ id: 'valid' }, { id: 123 }, { name: 'no-id' }] }))
    const models = await new ModelApiDiscoverer().discoverFromApi('https://host/v1', 'k')
    expect(models).toHaveLength(1)
    expect(models[0].id).toBe('valid')
  })

  it('falls back to id when name is absent', async () => {
    stubFetch(mockFetchJson({ data: [{ id: 'only-id' }] }))
    const models = await new ModelApiDiscoverer().discoverFromApi('https://host/v1', 'k')
    expect(models[0].name).toBe('only-id')
  })
})
