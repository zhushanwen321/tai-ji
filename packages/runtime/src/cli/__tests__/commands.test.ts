import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArgs, formatProviders, formatDefaultModel, executeCommand } from '../commands.js'
import { rpc } from '../ws-client.js'

// executeCommand 经 ws-client.rpc 与 runtime 通信——测试 mock 掉 WS 层，
// 特征锚定「参数解析 → rpc payload → 响应格式化」链路与错误文案。
vi.mock('../ws-client.js', () => ({
  rpc: vi.fn(),
}))

describe('parseArgs', () => {
  it('parses --provider and --model flags', () => {
    const args = parseArgs(['set-default-model', '--provider', 'openai', '--model', 'gpt-4o'])
    expect(args.command).toBe('set-default-model')
    expect(args.flags.provider).toBe('openai')
    expect(args.flags.model).toBe('gpt-4o')
  })

  it('returns list-providers for no args', () => {
    const args = parseArgs(['list-providers'])
    expect(args.command).toBe('list-providers')
  })

  it('detects --json flag', () => {
    const args = parseArgs(['list-providers', '--json'])
    expect(args.flags.json).toBe(true)
  })
})

describe('formatProviders', () => {
  it('formats provider list as human-readable table', () => {
    const providers = [
      { id: 'openai', name: 'OpenAI', apiKeySet: true, models: [{ id: 'gpt-4o' }] }
    ]
    const output = formatProviders(providers)
    expect(output).toContain('openai')
    expect(output).toContain('gpt-4o')
    expect(output).not.toContain('apiKey') // must not expose key
  })

  it('outputs JSON when --json flag', () => {
    const providers = [{ id: 'openai', apiKeySet: true }]
    const output = formatProviders(providers, { json: true })
    expect(JSON.parse(output)).toEqual(providers)
  })
})

describe('formatDefaultModel', () => {
  it('formats as provider/modelId', () => {
    expect(formatDefaultModel('openai', 'gpt-4o')).toBe('openai/gpt-4o')
  })
})

// ── executeCommand（W2 复杂度重构特征锚定：文案逐字节 + rpc payload + 调用时序）──

describe('executeCommand: unknown command', () => {
  it('throws usage text listing all commands (error copy anchored byte-for-byte)', async () => {
    await expect(executeCommand({ command: 'no-such-cmd', flags: {} })).rejects.toThrow(
      'Unknown command: no-such-cmd\n\n' +
      'Available commands:\n' +
      '  list-providers\n  get-default-model\n  set-default-model\n' +
      '  switch-session-model\n  set-thinking\n' +
      '  set-provider\n  set-skill-dirs\n  set-agent-dirs\n' +
      '  delete-provider\n  discover-models\n' +
      '\ndiscover-models requires --base-url; see --help for details',
    )
  })
})

describe('executeCommand: set-default-model', () => {
  it('missing flags → Usage error (copy anchored)', async () => {
    await expect(executeCommand({ command: 'set-default-model', flags: {} })).rejects.toThrow(
      'Usage: taiji-settings set-default-model --provider <p> --model <m>',
    )
    await expect(executeCommand({ command: 'set-default-model', flags: { provider: 'openai' } })).rejects.toThrow(
      'Usage: taiji-settings set-default-model --provider <p> --model <m>',
    )
  })

  it('success → rpc payload {provider, modelId} + formatted output', async () => {
    vi.mocked(rpc).mockResolvedValueOnce({} as never)
    const out = await executeCommand({ command: 'set-default-model', flags: { provider: 'openai', model: 'gpt-4o' } })
    expect(rpc).toHaveBeenCalledWith('config.setDefaultModel', { provider: 'openai', modelId: 'gpt-4o' })
    expect(out).toBe('default_model = openai/gpt-4o')
  })
})

describe('executeCommand: switch-session-model', () => {
  it('missing flags → Usage error (copy anchored)', async () => {
    await expect(executeCommand({ command: 'switch-session-model', flags: {} })).rejects.toThrow(
      'Usage: taiji-settings switch-session-model --session <id> --provider <p> --model <m>',
    )
  })

  it('success → rpc payload + 8-char truncated session echo', async () => {
    vi.mocked(rpc).mockResolvedValueOnce({} as never)
    const out = await executeCommand({ command: 'switch-session-model', flags: { session: 'abcdefgh-qrs', provider: 'openai', model: 'gpt-4o' } })
    expect(rpc).toHaveBeenCalledWith('model.switch', { sessionId: 'abcdefgh-qrs', provider: 'openai', modelId: 'gpt-4o' })
    expect(out).toBe('session abcdefgh... model = openai/gpt-4o')
  })
})

describe('executeCommand: set-thinking', () => {
  it('missing flags → Usage error (copy anchored)', async () => {
    await expect(executeCommand({ command: 'set-thinking', flags: {} })).rejects.toThrow(
      'Usage: taiji-settings set-thinking --session <id> --level <off|minimal|low|medium|high|xhigh>',
    )
  })

  it('success → rpc payload + output', async () => {
    vi.mocked(rpc).mockResolvedValueOnce({} as never)
    const out = await executeCommand({ command: 'set-thinking', flags: { session: 'sess-123456789', level: 'high' } })
    expect(rpc).toHaveBeenCalledWith('session.setThinkingLevel', { sessionId: 'sess-123456789', level: 'high' })
    expect(out).toBe('session sess-123... thinking = high')
  })
})

describe('executeCommand: set-provider', () => {
  const envKey = process.env.TAIJI_AGENT_API_KEY

  afterEach(() => {
    if (envKey === undefined) delete process.env.TAIJI_AGENT_API_KEY
    else process.env.TAIJI_AGENT_API_KEY = envKey
  })

  it('missing flags → Usage error (copy anchored)', async () => {
    await expect(executeCommand({ command: 'set-provider', flags: {} })).rejects.toThrow(
      'Usage: taiji-settings set-provider --name <id> --provider <openai|anthropic|google|openrouter>',
    )
  })

  it('env api key set → payload carries apiKey + [apiKey:set] suffix', async () => {
    process.env.TAIJI_AGENT_API_KEY = 'sk-env-1'
    vi.mocked(rpc).mockResolvedValueOnce({} as never)
    const out = await executeCommand({ command: 'set-provider', flags: { name: 'my-id', provider: 'openai' } })
    expect(rpc).toHaveBeenCalledWith('config.setProvider', { providerId: 'my-id', type: 'openai', apiKey: 'sk-env-1' })
    expect(out).toBe('provider my-id (openai) configured [apiKey:set]')
  })

  it('no api key → payload without apiKey + [apiKey:unchanged] suffix', async () => {
    delete process.env.TAIJI_AGENT_API_KEY
    vi.mocked(rpc).mockResolvedValueOnce({} as never)
    const out = await executeCommand({ command: 'set-provider', flags: { name: 'my-id', provider: 'anthropic' } })
    expect(rpc).toHaveBeenCalledWith('config.setProvider', { providerId: 'my-id', type: 'anthropic' })
    expect(out).toBe('provider my-id (anthropic) configured [apiKey:unchanged]')
  })
})

describe('executeCommand: set-skill-dirs / set-agent-dirs', () => {
  it('set-skill-dirs missing flag → Usage error (copy anchored)', async () => {
    await expect(executeCommand({ command: 'set-skill-dirs', flags: {} })).rejects.toThrow(
      'Usage: taiji-settings set-skill-dirs --skill-dirs <path1,path2,...>',
    )
  })

  it('set-skill-dirs success → split+trim payload', async () => {
    vi.mocked(rpc).mockResolvedValueOnce({} as never)
    const out = await executeCommand({ command: 'set-skill-dirs', flags: { 'skill-dirs': ' /a , /b ,' } })
    // 锚定为存量 quirk（非契约）：尾随逗号 split 后产生空段 '' 原样透传，未做过滤。
    // 若未来有意修此行为，需同步评审下游对空串路径的容忍度，而非静默改断言。
    expect(rpc).toHaveBeenCalledWith('config.setSkillDirs', { dirs: ['/a', '/b', ''] })
    expect(out).toBe('skill_dirs =  /a , /b ,')
  })

  it('set-agent-dirs missing flag → Usage error (copy anchored)', async () => {
    await expect(executeCommand({ command: 'set-agent-dirs', flags: {} })).rejects.toThrow(
      'Usage: taiji-settings set-agent-dirs --agent-dirs <path1,path2,...>',
    )
  })

  it('set-agent-dirs success → split+trim payload', async () => {
    vi.mocked(rpc).mockResolvedValueOnce({} as never)
    const out = await executeCommand({ command: 'set-agent-dirs', flags: { 'agent-dirs': '/x,/y' } })
    expect(rpc).toHaveBeenCalledWith('config.setAgentDirs', { dirs: ['/x', '/y'] })
    expect(out).toBe('agent_dirs = /x,/y')
  })
})

describe('executeCommand: delete-provider', () => {
  it('missing name → Usage error (copy anchored)', async () => {
    await expect(executeCommand({ command: 'delete-provider', flags: {} })).rejects.toThrow(
      'Usage: taiji-settings delete-provider --name <id>',
    )
  })

  it('success → rpc payload + output', async () => {
    vi.mocked(rpc).mockResolvedValueOnce({} as never)
    const out = await executeCommand({ command: 'delete-provider', flags: { name: 'my-id' } })
    expect(rpc).toHaveBeenCalledWith('config.deleteProvider', { providerId: 'my-id' })
    expect(out).toBe('provider my-id deleted')
  })
})

describe('executeCommand: discover-models', () => {
  const envKey = process.env.TAIJI_AGENT_API_KEY

  afterEach(() => {
    if (envKey === undefined) delete process.env.TAIJI_AGENT_API_KEY
    else process.env.TAIJI_AGENT_API_KEY = envKey
  })

  it('missing --base-url → multi-line Usage error (copy anchored)', async () => {
    await expect(executeCommand({ command: 'discover-models', flags: {} })).rejects.toThrow(
      'Usage: taiji-settings discover-models --base-url <url> [--name <provider-id>] [--provider <type>] [--api-key-stdin]',
    )
  })

  it('optional flags only added to payload when present', async () => {
    delete process.env.TAIJI_AGENT_API_KEY
    vi.mocked(rpc).mockResolvedValueOnce({ models: [{ id: 'm-1' }, { id: 'm-2' }], success: true } as never)
    const out = await executeCommand({ command: 'discover-models', flags: { 'base-url': 'https://api.x' } })
    expect(rpc).toHaveBeenCalledWith('config.discoverModels', { baseUrl: 'https://api.x' })
    expect(out).toBe('  m-1\n  m-2')
  })

  it('success:false → throws reply.error (copy anchored)', async () => {
    vi.mocked(rpc).mockResolvedValueOnce({ success: false, error: 'bad upstream' } as never)
    await expect(executeCommand({ command: 'discover-models', flags: { 'base-url': 'https://api.x' } })).rejects.toThrow('bad upstream')
  })

  it('success:false without error field → "discover failed" fallback', async () => {
    vi.mocked(rpc).mockResolvedValueOnce({ success: false } as never)
    await expect(executeCommand({ command: 'discover-models', flags: { 'base-url': 'https://api.x' } })).rejects.toThrow('discover failed')
  })

  it('--json → JSON.stringify(models, null, 2)', async () => {
    const models = [{ id: 'm-1' }]
    vi.mocked(rpc).mockResolvedValueOnce({ models, success: true } as never)
    const out = await executeCommand({ command: 'discover-models', flags: { 'base-url': 'https://api.x', json: true } })
    expect(out).toBe(JSON.stringify(models, null, 2))
  })

  // ── M3a：--mode test（per-协议真实最小请求，排障入口）；不带 mode 时仍走 discover（向后兼容）──
  it('不带 --mode → payload 无 mode 键（旧调用方行为零改动）', async () => {
    delete process.env.TAIJI_AGENT_API_KEY
    vi.mocked(rpc).mockResolvedValueOnce({ models: [{ id: 'm-1' }], success: true } as never)
    await executeCommand({ command: 'discover-models', flags: { 'base-url': 'https://api.x' } })
    expect(rpc).toHaveBeenCalledWith('config.discoverModels', { baseUrl: 'https://api.x' })
  })

  it('--mode test 缺 --name → Usage error（copy anchored）', async () => {
    await expect(executeCommand({ command: 'discover-models', flags: { mode: 'test' } })).rejects.toThrow(
      'Usage: taiji-settings discover-models --mode test --name <provider-id> [--json]',
    )
  })

  it('--mode test → payload {baseUrl:"", providerId, mode:"test"}（baseUrl 被 runtime 忽略）+ 逐协议结果输出', async () => {
    vi.mocked(rpc).mockResolvedValueOnce({
      success: true,
      results: [
        { api: 'anthropic-messages', modelId: 'k3', ok: true },
        { api: 'openai-completions', modelId: 'qwen3.8-flash', ok: false, error: 'http_error|401|invalid api key' },
      ],
    } as never)
    const out = await executeCommand({ command: 'discover-models', flags: { mode: 'test', name: 'opencode-go' } })
    expect(rpc).toHaveBeenCalledWith('config.discoverModels', { baseUrl: '', providerId: 'opencode-go', mode: 'test' })
    expect(out).toBe(
      '  ok   anthropic-messages/k3\n' +
      '  FAIL openai-completions/qwen3.8-flash  http_error|401|invalid api key',
    )
  })

  it('--mode test --json → JSON.stringify(results, null, 2)', async () => {
    const results = [{ api: 'anthropic-messages', modelId: 'k3', ok: true }]
    vi.mocked(rpc).mockResolvedValueOnce({ success: true, results } as never)
    const out = await executeCommand({ command: 'discover-models', flags: { mode: 'test', name: 'p1', json: true } })
    expect(out).toBe(JSON.stringify(results, null, 2))
  })

  it('--mode test provider 级失败（success:false）→ throws error code（copy anchored）', async () => {
    vi.mocked(rpc).mockResolvedValueOnce({ success: false, error: 'no_api_key' } as never)
    await expect(
      executeCommand({ command: 'discover-models', flags: { mode: 'test', name: 'p1' } }),
    ).rejects.toThrow('no_api_key')
  })
})

describe('executeCommand: list-providers', () => {
  it('human readable by default, --json passes through providers JSON', async () => {
    const providers = [{ id: 'openai', apiKeySet: true, models: [{ id: 'gpt-4o' }] }]
    vi.mocked(rpc).mockResolvedValueOnce({ providers } as never)
    expect(await executeCommand({ command: 'list-providers', flags: {} })).toBe(formatProviders(providers))
    vi.mocked(rpc).mockResolvedValueOnce({ providers } as never)
    expect(await executeCommand({ command: 'list-providers', flags: { json: true } })).toBe(JSON.stringify(providers, null, 2))
  })
})

describe('executeCommand: get-default-model (reads settings.json via TAIJI_AGENT_DATA_DIR)', () => {
  let dir: string
  let prevDataDir: string | undefined

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cli-get-default-model-'))
    prevDataDir = process.env.TAIJI_AGENT_DATA_DIR
    process.env.TAIJI_AGENT_DATA_DIR = dir
  })

  afterEach(() => {
    if (prevDataDir === undefined) delete process.env.TAIJI_AGENT_DATA_DIR
    else process.env.TAIJI_AGENT_DATA_DIR = prevDataDir
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  it('settings.json with both fields → "provider/model"', async () => {
    const agentDir = join(dir, 'agent')
    mkdirSync(agentDir, { recursive: true })
    writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ defaultProvider: 'openai', defaultModel: 'gpt-4o' }))
    expect(await executeCommand({ command: 'get-default-model', flags: {} })).toBe('openai/gpt-4o')
  })

  it('missing settings.json → "not set"', async () => {
    expect(await executeCommand({ command: 'get-default-model', flags: {} })).toBe('not set')
  })

  it('partial fields (only defaultProvider) → "not set"', async () => {
    const agentDir = join(dir, 'agent')
    mkdirSync(agentDir, { recursive: true })
    writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ defaultProvider: 'openai' }))
    expect(await executeCommand({ command: 'get-default-model', flags: {} })).toBe('not set')
  })
})
