import { parseClaudeProviders } from '../claude-parser.js';
import { parseCodexProviders } from '../codex-parser.js';
import { parsePiProviders } from '../pi-parser.js';
import { parseZcodeProviders } from '../zcode-parser.js';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。

// ======================================================================
// ← src/services/migration/parsers/__tests__/claude-parser.test.ts
// ======================================================================

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
import claudeSettingsFixture from './fixtures/claude-settings.json';
import piAuthFixture from './fixtures/pi-auth.json';
import piModelsGeminiOnlyFixture from './fixtures/pi-models-gemini-only.json';
import piModelsFixture from './fixtures/pi-models.json';
import zcodeConfigFixture from './fixtures/zcode-config.json';
describe('claude-parser', () => {
describe('parseClaudeProviders', () => {
  let home: string

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'claude-parser-'))
  })
  afterEach(() => {
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  /** 把 settings.json 写到 <home>/.claude/settings.json。 */
  function writeClaudeSettings(content: string): string {
    const claudeDir = join(home, '.claude')
    mkdirSync(claudeDir, { recursive: true })
    const dest = join(claudeDir, 'settings.json')
    writeFileSync(dest, content)
    return dest
  }

  // ── T6：正常解析（1 占位 provider）─────────────────────────────────
  it('T6: 解析 1 占位 provider，api=anthropic-messages，apiKeyExtracted 恒 false', () => {
    writeClaudeSettings(JSON.stringify(claudeSettingsFixture))

    const result = parseClaudeProviders(home)

    expect(result).not.toBeNull()
    expect(result!.providers).toHaveLength(1)
    expect(result!.parseError).toBeUndefined()

    const provider = result!.providers[0]
    expect(provider.api).toBe('anthropic-messages')
    expect(provider.name).toBe('Claude Code (imported)')
    expect(provider._sourceName).toBe('claude-imported')
    // 安全红线：恒不提取 key
    expect(provider._apiKeyExtracted).toBe(false)
    expect(provider.apiKey).toBeUndefined()
    // baseUrl / model 从 settings.json 提取
    expect(provider.baseUrl).toBe('http://test.example.com')
    expect(provider.models).toHaveLength(1)
    expect(provider.models![0].id).toBe('claude-haiku')
    // warning 含 keychain 提示
    expect(provider._warnings.some((w) => w.toLowerCase().includes('keychain'))).toBe(true)
    expect(provider._warnings.some((w) => w.toLowerCase().includes('manually'))).toBe(true)
  })

  // ── T7：settings.json 损坏 → parseError ────────────────────────────
  it('T7: settings.json JSON 损坏 → parseError 含 cannot parse', () => {
    writeClaudeSettings('{ broken')

    const result = parseClaudeProviders(home)

    expect(result).not.toBeNull()
    expect(result!.providers).toHaveLength(0)
    expect(result!.parseError).toMatch(/cannot parse claude settings\.json/)
  })

  // ── T8：源目录不存在 → null ────────────────────────────────────────
  it('T8: ~/.claude/settings.json 不存在 → 返回 null', () => {
    expect(existsSync(join(home, '.claude'))).toBe(false)

    const result = parseClaudeProviders(home)

    expect(result).toBeNull()
  })

  // ── T9：安全红线——apiKeyHelper 绝不执行 ────────────────────────────
  it('T9: settings.json 含 apiKeyHelper，解析不执行它（apiKeyExtracted 恒 false，无 crash）', () => {
    // fixture 已含 apiKeyHelper 字段（指向 /Users/testuser/.claude/get-key.sh）
    writeClaudeSettings(JSON.stringify(claudeSettingsFixture))

    const result = parseClaudeProviders(home)

    expect(result).not.toBeNull()
    const provider = result!.providers[0]
    // 即使有 apiKeyHelper，也不执行，apiKeyExtracted 恒 false
    expect(provider._apiKeyExtracted).toBe(false)
    expect(provider.apiKey).toBeUndefined()
    expect(result!.parseError).toBeUndefined() // 未尝试执行脚本所以无错
  })

  // ── T10：model 缺失 → 默认 claude-default ──────────────────────────
  it('T10: settings.json 无 model 字段 → 用默认 claude-default', () => {
    writeClaudeSettings(JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://api.x.com' } }))

    const result = parseClaudeProviders(home)

    expect(result).not.toBeNull()
    const provider = result!.providers[0]
    expect(provider.models![0].id).toBe('claude-default')
    expect(provider.baseUrl).toBe('https://api.x.com')
  })

  // ── T11：env 缺失 → baseUrl undefined，不 crash ────────────────────
  it('T11: settings.json 无 env 字段 → baseUrl undefined，不 crash', () => {
    writeClaudeSettings(JSON.stringify({ model: 'claude-sonnet-4-5' }))

    const result = parseClaudeProviders(home)

    expect(result).not.toBeNull()
    const provider = result!.providers[0]
    expect(provider.baseUrl).toBeUndefined()
    expect(provider.models![0].id).toBe('claude-sonnet-4-5')
  })

  // ── B1：settings.json 内容为 null（JSON.parse('null') 成功）→ 不 crash ──
  it('B1: settings.json 内容为 null → 不 crash，仍产出 1 个占位 provider（用默认 model）', () => {
    writeClaudeSettings('null')

    const result = parseClaudeProviders(home)

    expect(result).not.toBeNull()
    expect(result!.providers).toHaveLength(1)
    const provider = result!.providers[0]
    expect(provider.models![0].id).toBe('claude-default')
    expect(provider.baseUrl).toBeUndefined()
  })
})
});

// ======================================================================
// ← src/services/migration/parsers/__tests__/codex-parser.test.ts
// ======================================================================

/**
 * codex-parser 测试（W3）。
 *
 * 测试策略：临时目录 + 真实 TOML fixture 写文件（避免 mock fs）。
 * 运行：cd packages/runtime && npx vitest run src/services/migration/parsers/__tests__/codex-parser.test.ts
 *
 * 注意：TOML fixture 内容见 ./fixtures/codex-config.toml 与 codex-config-chat.toml。
 * 因 vitest 原生只支持 JSON import（TOML 不支持），且 bundle 校验禁用 ESM 元信息 API，
 * 这里把 fixture TOML 内容内联为常量（与 fixtures/*.toml 保持一致），写入临时 .codex/config.toml。
 *
 * 覆盖：
 *   - T4：正常解析（wire_api=responses → openai-responses），env_key 从 process.env 提取，占位 model。
 *   - T5：env_key 未设环境变量 → apiKeyExtracted=false + warning 提示。
 *   - T6：wire_api=chat → openai-completions + deprecated warning。
 *   - T7：TOML 损坏 → parseError。
 *   - T8：源目录不存在 → null。
 *   - T9：auth.json 的 OPENAI_API_KEY 作为 id 含 'openai' 的 provider 的默认 key 回退。
 */


// ── fixture 内容（与 ./fixtures/*.toml 一致，假 key）──────────────
const CODEX_CONFIG_RESPONSES_TOML = `model = "gpt-5.5"
model_provider = "custom"

[model_providers.custom]
name = "Router"
base_url = "http://192.168.1.202:9981/v1"
env_key = "ROUTER_KEY"
wire_api = "responses"
`


const CODEX_CONFIG_CHAT_TOML = `model = "gpt-5.5"
model_provider = "custom"

[model_providers.custom]
name = "Router"
base_url = "http://192.168.1.202:9981/v1"
env_key = "ROUTER_KEY"
wire_api = "chat"
`

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('codex-parser', () => {
describe('parseCodexProviders', () => {
  let home: string

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'codex-parser-'))
  })
  afterEach(() => {
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    vi.unstubAllEnvs()
  })

  /** 把 content 写到 <home>/.codex/config.toml。 */
  function writeCodexConfig(content: string): string {
    const codexDir = join(home, '.codex')
    mkdirSync(codexDir, { recursive: true })
    const dest = join(codexDir, 'config.toml')
    writeFileSync(dest, content)
    return dest
  }

  // ── T4：正常解析（responses → openai-responses，env_key 提取，占位 model）──
  it('T4: wire_api=responses → openai-responses，env_key 提取到 key，占位 model', () => {
    writeCodexConfig(CODEX_CONFIG_RESPONSES_TOML)
    vi.stubEnv('ROUTER_KEY', 'sk-fake-test')

    const result = parseCodexProviders(home)

    expect(result).not.toBeNull()
    expect(result!.providers).toHaveLength(1)
    expect(result!.parseError).toBeUndefined()

    const provider = result!.providers[0]
    expect(provider._sourceName).toBe('custom')
    expect(provider.name).toBe('Router')
    expect(provider.api).toBe('openai-responses')
    expect(provider.baseUrl).toBe('http://192.168.1.202:9981/v1')
    // env_key 从 process.env 提取到值
    expect(provider.apiKey).toBe('sk-fake-test')
    expect(provider._apiKeyExtracted).toBe(true)
    // 占位 model：顶层 model 字段
    expect(provider.models).toHaveLength(1)
    expect(provider.models![0].id).toBe('gpt-5.5')
    // warning 含 model list incomplete 提示
    expect(provider._warnings.some((w) => w.includes('model list incomplete'))).toBe(true)
  })

  // ── T5：env_key 未设环境变量 → apiKeyExtracted=false + warning ──────
  it('T5: env_key=NONEXISTENT 且 process.env 无此变量 → apiKeyExtracted=false + warning', () => {
    const toml = `model = "gpt-5.5"
[model_providers.custom]
name = "Router"
base_url = "http://192.168.1.202:9981/v1"
env_key = "NONEXISTENT_CODEX_KEY"
wire_api = "responses"
`
    writeCodexConfig(toml)
    // 不 stub NONEXISTENT_CODEX_KEY（确保 process.env 无此变量）
    expect(process.env.NONEXISTENT_CODEX_KEY).toBeUndefined()

    const result = parseCodexProviders(home)

    expect(result).not.toBeNull()
    const provider = result!.providers[0]
    expect(provider.apiKey).toBeUndefined()
    expect(provider._apiKeyExtracted).toBe(false)
    // warning 含 env_key 提示
    expect(
      provider._warnings.some((w) => w.includes('env_key NONEXISTENT_CODEX_KEY not set in environment')),
    ).toBe(true)
  })

  // ── T6：wire_api=chat → openai-completions + deprecated warning ────
  it('T6: wire_api=chat → openai-completions + deprecated warning', () => {
    writeCodexConfig(CODEX_CONFIG_CHAT_TOML)
    vi.stubEnv('ROUTER_KEY', 'sk-fake-test')

    const result = parseCodexProviders(home)

    expect(result).not.toBeNull()
    const provider = result!.providers[0]
    expect(provider.api).toBe('openai-completions')
    expect(provider._warnings.some((w) => w.includes('wire_api=chat is deprecated'))).toBe(true)
  })

  // ── T7：TOML 损坏 → parseError ─────────────────────────────────────
  it('T7: config.toml TOML 损坏 → parseError 含 cannot parse', () => {
    writeCodexConfig('invalid toml {')

    const result = parseCodexProviders(home)

    expect(result).not.toBeNull()
    expect(result!.providers).toHaveLength(0)
    expect(result!.parseError).toMatch(/cannot parse config\.toml/)
  })

  // ── T8：源目录不存在 → null ────────────────────────────────────────
  it('T8: ~/.codex 不存在 → 返回 null', () => {
    expect(existsSync(join(home, '.codex'))).toBe(false)

    const result = parseCodexProviders(home)

    expect(result).toBeNull()
  })

  // ── T9：auth.json 的 OPENAI_API_KEY 作为 id 含 'openai' 的 provider 的回退 key ──
  it('T9: provider id 含 openai 且无 env_key → 用 auth.json 的 OPENAI_API_KEY 回退', () => {
    const toml = `model = "gpt-5.5"
[model_providers.openai-default]
name = "OpenAI"
base_url = "https://api.openai.com/v1"
wire_api = "responses"
`
    const configPath = writeCodexConfig(toml)
    // 写 auth.json
    writeFileSync(join(home, '.codex', 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'sk-fake-openai-from-auth' }))
    expect(existsSync(configPath)).toBe(true)

    const result = parseCodexProviders(home)

    expect(result).not.toBeNull()
    const provider = result!.providers[0]
    expect(provider._sourceName).toBe('openai-default')
    expect(provider.apiKey).toBe('sk-fake-openai-from-auth')
    expect(provider._apiKeyExtracted).toBe(true)
  })

  // ── T10：未知 wire_api → 默认 openai-completions + warning ──────────
  it('T10: wire_api=weird → openai-completions + unknown wire_api warning', () => {
    const toml = `model = "gpt-5.5"
[model_providers.custom]
name = "Router"
base_url = "http://192.168.1.202:9981/v1"
env_key = "ROUTER_KEY"
wire_api = "weird"
`
    writeCodexConfig(toml)
    vi.stubEnv('ROUTER_KEY', 'sk-fake-test')

    const result = parseCodexProviders(home)

    expect(result).not.toBeNull()
    const provider = result!.providers[0]
    expect(provider.api).toBe('openai-completions')
    expect(provider._warnings.some((w) => w.includes('unknown wire_api'))).toBe(true)
  })

  // ── B1：单个 model_providers entry 为非对象（toml 表值为非表）──
  //       无法在 TOML 表达「entry=null」（TOML 表的值只能是标量/表/数组），
  //       这里改测：TOML 损坏但能解析（如空表）—— 空表视为 mp={}，wire_api 缺失 → defaulted warning
  it('B1: model_providers.<id> 为空表（mp={}）→ 不 crash，defaulted to openai-completions', () => {
    const toml = `model = "gpt-5.5"
[model_providers.empty]
`
    writeCodexConfig(toml)

    const result = parseCodexProviders(home)

    expect(result).not.toBeNull()
    expect(result!.providers).toHaveLength(1)
    expect(result!.providers[0].api).toBe('openai-completions')
    expect(result!.providers[0]._warnings.some((w) => w.includes('unknown wire_api'))).toBe(true)
  })

  // ── W3：auth.json 损坏 → 每个 provider 的 _warnings 含 auth 解析失败提示 ──
  it('W3: auth.json 损坏 → 每个 codex provider 的 _warnings 含 auth.json parse failed 提示', () => {
    const toml = `model = "gpt-5.5"
[model_providers.openai-default]
name = "OpenAI"
base_url = "https://api.openai.com/v1"
wire_api = "responses"
[model_providers.custom]
name = "Router"
base_url = "http://x/v1"
env_key = "ROUTER_KEY"
wire_api = "responses"
`
    const configPath = writeCodexConfig(toml)
    writeFileSync(join(home, '.codex', 'auth.json'), '{ broken')
    vi.stubEnv('ROUTER_KEY', 'sk-fake-test')
    expect(existsSync(configPath)).toBe(true)

    const result = parseCodexProviders(home)

    expect(result).not.toBeNull()
    expect(result!.providers).toHaveLength(2)
    // 每个 provider 的 _warnings 含 auth.json parse failed 提示
    for (const p of result!.providers) {
      expect(p._warnings.some((w) => w.includes('auth.json parse failed') && w.includes('OPENAI key fallback unavailable'))).toBe(true)
    }
  })

  // ── B1：auth.json 内容为 null（JSON.parse('null') 成功）→ 不 crash，回退不可用 ──
  it('B1: auth.json 内容为 null → 不 crash，无 OPENAI_API_KEY 回退（authData={}）', () => {
    const toml = `model = "gpt-5.5"
[model_providers.openai-default]
name = "OpenAI"
base_url = "https://api.openai.com/v1"
wire_api = "responses"
`
    writeCodexConfig(toml)
    // auth.json 内容为字面 null（JSON.parse 成功返回 null，曾导致 authData.OPENAI_API_KEY 崩）
    writeFileSync(join(home, '.codex', 'auth.json'), 'null')

    const result = parseCodexProviders(home)

    expect(result).not.toBeNull()
    expect(result!.providers).toHaveLength(1)
    // null auth.json：未崩溃，apiKeyExtracted=false（无回退 key）
    expect(result!.providers[0]._apiKeyExtracted).toBe(false)
    expect(result!.providers[0].apiKey).toBeUndefined()
  })

  // ── W4 补充：config.toml 无 [model_providers] 表 → providers=[] 且顶层 warnings 省略 ──
  // 锚定 `config.model_providers ?? {}` 兜底分支：不产出任何 provider，也不产出 warnings 字段。
  it('W4-a: config 无 model_providers 表 → providers=[]，warnings undefined', () => {
    writeCodexConfig(`model = "gpt-5.5"
model_provider = "custom"
`)

    const result = parseCodexProviders(home)

    expect(result).not.toBeNull()
    expect(result!.providers).toHaveLength(0)
    expect(result!.parseError).toBeUndefined()
    expect(result!.warnings).toBeUndefined()
  })

  // ── W4 补充：顶层 model 缺失 → models=[] 且无 incomplete warning ──
  // 锚定 `if (topModel)` 的另一侧：无顶层 model 时不 push 占位 model、不产 model list incomplete 警告。
  it('W4-b: 顶层 model 缺失 → models=[]，_warnings 无 model list incomplete 提示', () => {
    writeCodexConfig(`
[model_providers.custom]
name = "Router"
base_url = "http://192.168.1.202:9981/v1"
wire_api = "responses"
`)

    const result = parseCodexProviders(home)

    expect(result).not.toBeNull()
    expect(result!.providers).toHaveLength(1)
    const provider = result!.providers[0]
    expect(provider.models).toHaveLength(0)
    expect(provider._warnings.some((w) => w.includes('model list incomplete'))).toBe(false)
  })

  // ── W4 补充：http_headers 透传到 ParsedProvider.headers（结构锚定）──
  it('W4-c: http_headers 表 → provider.headers 逐键透传', () => {
    writeCodexConfig(`model = "gpt-5.5"
[model_providers.custom]
name = "Router"
base_url = "http://192.168.1.202:9981/v1"
wire_api = "responses"

[model_providers.custom.http_headers]
"X-Custom-Header" = "custom-value"
"Authorization-Hint" = "placeholder"
`)

    const result = parseCodexProviders(home)

    expect(result).not.toBeNull()
    expect(result!.providers).toHaveLength(1)
    expect(result!.providers[0].headers).toEqual({
      'X-Custom-Header': 'custom-value',
      'Authorization-Hint': 'placeholder',
    })
  })

  // ── W4 补充：id 含 openai 且 env_key 提取到值 → env 优先，不走 auth.json 回退 ──
  // 锚定 `if (!apiKey && id.toLowerCase().includes('openai') && authData.OPENAI_API_KEY)` 的
  // `!apiKey` 短路另一侧：env_key 已提取时 auth.json 的 OPENAI_API_KEY 不覆盖。
  it('W4-d: id 含 openai 且 env_key 有值 → apiKey 用 env 值，auth.json 回退不生效', () => {
    const toml = `model = "gpt-5.5"
[model_providers.openai-env]
name = "OpenAI Env"
base_url = "https://api.openai.com/v1"
env_key = "ROUTER_KEY"
wire_api = "responses"
`
    writeCodexConfig(toml)
    writeFileSync(join(home, '.codex', 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'sk-fake-openai-from-auth' }))
    vi.stubEnv('ROUTER_KEY', 'sk-fake-from-env')

    const result = parseCodexProviders(home)

    expect(result).not.toBeNull()
    const provider = result!.providers[0]
    expect(provider._sourceName).toBe('openai-env')
    expect(provider.apiKey).toBe('sk-fake-from-env')
    expect(provider._apiKeyExtracted).toBe(true)
  })
})
});

// ======================================================================
// ← src/services/migration/parsers/__tests__/pi-parser.test.ts
// ======================================================================

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('pi-parser', () => {
describe('parsePiProviders', () => {
  let home: string

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'pi-parser-'))
  })
  afterEach(() => {
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  /** 把 fixture JSON 写到 <home>/.pi/agent/<target>。 */
  function writePiAgentFile(target: string, content: string): string {
    const piAgentDir = join(home, '.pi', 'agent')
    mkdirSync(piAgentDir, { recursive: true })
    const dest = join(piAgentDir, target)
    writeFileSync(dest, content)
    return dest
  }

  // ── T1：正常解析（3 provider → 2，gemini 丢弃）──────────────────────
  it('T1: 解析 3 provider → 2（gemini 丢弃），auth.json 合并，协议直传', () => {
    writePiAgentFile('models.json', JSON.stringify(piModelsFixture))
    writePiAgentFile('auth.json', JSON.stringify(piAuthFixture))

    const result = parsePiProviders(home)

    expect(result).not.toBeNull()
    expect(result!.providers).toHaveLength(2)

    // deepseek-router：auth.json 的 key 覆盖 models.json（models.json 里 deepseek 无 apiKey）
    const deepseek = result!.providers.find((p) => p._sourceName === 'deepseek-router')!
    expect(deepseek.api).toBe('anthropic-messages')
    expect(deepseek.apiKey).toBe('sk-fake-deepseek-from-auth')
    expect(deepseek._apiKeyExtracted).toBe(true)
    expect(deepseek.baseUrl).toBe('https://api.deepseek.com/v1')
    // models 数组透传
    expect(deepseek.models).toHaveLength(2)
    expect(deepseek.models![0].id).toBe('deepseek-chat')
    // compat 字段容忍（不 crash）
    expect(deepseek.models![0].compat).toBeDefined()
    // thinkingLevelMap 透传
    expect(deepseek.models![1].thinkingLevelMap).toBeDefined()

    // zhipu：auth.json 的 key 覆盖 models.json 的 apiKey
    const zhipu = result!.providers.find((p) => p._sourceName === 'zhipu')!
    expect(zhipu.api).toBe('openai-completions')
    expect(zhipu.apiKey).toBe('sk-fake-zhipu-from-auth') // auth.json 优先
    expect(zhipu._apiKeyExtracted).toBe(true)

    // gemini 被丢弃（不在结果中）
    expect(result!.providers.find((p) => p._sourceName === 'gemini')).toBeUndefined()

    // 无整体性 parseError
    expect(result!.parseError).toBeUndefined()
  })

  // ── T2：只有 google-generative-ai → providers 空 ──────────────────
  it('T2: 只有 google-generative-ai 的 fixture → providers 为空', () => {
    writePiAgentFile('models.json', JSON.stringify(piModelsGeminiOnlyFixture))
    writePiAgentFile('auth.json', JSON.stringify(piAuthFixture))

    const result = parsePiProviders(home)

    expect(result).not.toBeNull()
    expect(result!.providers).toHaveLength(0)
    // gemini 被丢弃不产生 parseError（parseError 只在整体性错误）
    expect(result!.parseError).toBeUndefined()
    // S5：丢弃的 provider 通过顶层 warnings 暴露给用户
    expect(result!.warnings).toBeDefined()
    expect(result!.warnings!.some((w) => w.includes('google-generative-ai') && w.includes('not supported'))).toBe(true)
  })

  // ── T7：models.json JSON 损坏 → parseError ─────────────────────────
  it('T7: models.json JSON 损坏 → parseError 含 cannot parse', () => {
    writePiAgentFile('models.json', '{ not valid json ///')

    const result = parsePiProviders(home)

    expect(result).not.toBeNull()
    expect(result!.providers).toHaveLength(0)
    expect(result!.parseError).toMatch(/cannot parse models\.json/)
  })

  // ── T8：源目录不存在 → null ────────────────────────────────────────
  it('T8: ~/.pi/agent 不存在 → 返回 null', () => {
    expect(existsSync(join(home, '.pi'))).toBe(false)

    const result = parsePiProviders(home)

    expect(result).toBeNull()
  })

  // ── T9：auth.json 不存在 → 回退 models.json 的 apiKey ──────────────
  it('T9: auth.json 不存在 → apiKey 从 models.json 取', () => {
    writePiAgentFile('models.json', JSON.stringify(piModelsFixture))
    // 故意不写 auth.json

    const result = parsePiProviders(home)

    expect(result).not.toBeNull()
    const zhipu = result!.providers.find((p) => p._sourceName === 'zhipu')!
    // auth.json 不存在 → 回退 models.json 里的 sk-fake-zhipu-in-models
    expect(zhipu.apiKey).toBe('sk-fake-zhipu-in-models')
    expect(zhipu._apiKeyExtracted).toBe(true)

    // deepseek 在 models.json 无 apiKey → apiKeyExtracted=false
    const deepseek = result!.providers.find((p) => p._sourceName === 'deepseek-router')!
    expect(deepseek.apiKey).toBeUndefined()
    expect(deepseek._apiKeyExtracted).toBe(false)
  })

  // ── T10：auth.json 损坏 → 不阻断，warning 提示 ─────────────────────
  it('T10: auth.json JSON 损坏 → 不阻断，每个 provider 的 _warnings 含提示', () => {
    writePiAgentFile('models.json', JSON.stringify(piModelsFixture))
    writePiAgentFile('auth.json', '{ broken')

    const result = parsePiProviders(home)

    expect(result).not.toBeNull()
    expect(result!.providers).toHaveLength(2)
    // auth 损坏不产生 parseError（非整体性，models.json 仍可解析）
    expect(result!.parseError).toBeUndefined()
    // 每个 provider 的 _warnings 含 auth.json parse failed 提示
    for (const p of result!.providers) {
      expect(p._warnings.some((w) => w.includes('auth.json parse failed'))).toBe(true)
    }
    // apiKey 回退到 models.json（auth.json 不可用）
    const zhipu = result!.providers.find((p) => p._sourceName === 'zhipu')!
    expect(zhipu.apiKey).toBe('sk-fake-zhipu-in-models')
  })

  // ── T11：models.json 缺失 → parseError ────────────────────────────
  it('T11: ~/.pi/agent 存在但无 models.json → parseError 含 not found', () => {
    // 只建 .pi/agent 目录，不写 models.json
    mkdirSync(join(home, '.pi', 'agent'), { recursive: true })

    const result = parsePiProviders(home)

    expect(result).not.toBeNull()
    expect(result!.providers).toHaveLength(0)
    expect(result!.parseError).toMatch(/models\.json not found/)
  })

  // ── B1：models.json 整体 null（JSON.parse('null')）→ 不 crash，providers=[] ──
  it('B1: models.json 内容为 null（JSON.parse 成功返回 null）→ 不 crash，providers=[]', () => {
    writePiAgentFile('models.json', 'null')

    const result = parsePiProviders(home)

    expect(result).not.toBeNull()
    expect(result!.providers).toHaveLength(0)
    // 整体 null 不进 parseError（已被 ?? {} 兜底），仅产出空 providers
    expect(result!.parseError).toBeUndefined()
  })

  // ── B1：单个 entry 为 null → 不中断，其他 provider 正常解析，坏条目进 topWarnings ──
  it('B1: providers 含 null/非对象条目 → 坏条目跳过进 warnings，其他 provider 正常解析', () => {
    const config = {
      providers: {
        bad: null,
        good: {
          name: 'Good',
          api: 'openai-completions',
          apiKey: 'sk-good',
          models: [{ id: 'm', name: 'm' }],
        },
      },
    }
    writePiAgentFile('models.json', JSON.stringify(config))

    const result = parsePiProviders(home)

    expect(result).not.toBeNull()
    expect(result!.providers).toHaveLength(1)
    expect(result!.providers[0]._sourceName).toBe('good')
    // 坏条目进 topWarnings（不在 per-provider _warnings，因为是丢弃项）
    expect(result!.warnings).toBeDefined()
    expect(result!.warnings!.some((w) => w.includes('provider bad') && w.includes('malformed'))).toBe(true)
  })

  // ── S5：未知协议 → providers=[] 且 topWarnings 含 unknown protocol ──
  it('S5: 只有未知协议 provider → providers=[]，warnings 含 unknown protocol', () => {
    const config = {
      providers: {
        weird: {
          name: 'Weird',
          api: 'some-unknown-protocol',
          models: [{ id: 'm', name: 'm' }],
        },
      },
    }
    writePiAgentFile('models.json', JSON.stringify(config))

    const result = parsePiProviders(home)

    expect(result).not.toBeNull()
    expect(result!.providers).toHaveLength(0)
    expect(result!.warnings).toBeDefined()
    expect(result!.warnings!.some((w) => w.includes('unknown protocol some-unknown-protocol'))).toBe(true)
  })

  // ══ wave 4 import-credential-types：credential 三态识别（t1-t5）══
  // 五场景覆盖 pi-parser authEntry 五态分支：plaintext / env($VAR,${VAR}) / missing(env 包) / oauth / command(!)

  it('wave4-t1: auth.json {type:api_key, key:明文} → _credentialType=plaintext', () => {
    writePiAgentFile('models.json', JSON.stringify({
      providers: { openai: { name: 'OpenAI', api: 'openai-completions', models: [{ id: 'gpt-4', name: 'GPT-4' }] } },
    }))
    writePiAgentFile('auth.json', JSON.stringify({ openai: { type: 'api_key', key: 'sk-plain-xxx' } }))

    const result = parsePiProviders(home)!
    const p = result.providers.find((x) => x._sourceName === 'openai')!
    expect(p._credentialType).toBe('plaintext')
    expect(p.apiKey).toBe('sk-plain-xxx')
    expect(p._apiKeyExtracted).toBe(true)
    expect(p._envVarName).toBeUndefined()
  })

  it('wave4-t2: auth.json key=$VAR / ${VAR} → _credentialType=env + _envVarName 去前缀', () => {
    writePiAgentFile('models.json', JSON.stringify({
      providers: {
        openai: { name: 'OpenAI', api: 'openai-completions', models: [{ id: 'gpt-4', name: 'GPT-4' }] },
        openai2: { name: 'OpenAI2', api: 'openai-completions', models: [{ id: 'gpt-4o', name: 'GPT-4o' }] },
      },
    }))
    writePiAgentFile('auth.json', JSON.stringify({
      openai: { type: 'api_key', key: '$OPENAI_API_KEY' },
      openai2: { type: 'api_key', key: '${OPENAI_API_KEY_BRACE}' },
    }))

    const result = parsePiProviders(home)!
    const p1 = result.providers.find((x) => x._sourceName === 'openai')!
    expect(p1._credentialType).toBe('env')
    expect(p1._envVarName).toBe('OPENAI_API_KEY')
    expect(p1.apiKey).toBe('$OPENAI_API_KEY') // 保留原占位串
    expect(p1._apiKeyExtracted).toBe(true)

    const p2 = result.providers.find((x) => x._sourceName === 'openai2')!
    expect(p2._credentialType).toBe('env')
    expect(p2._envVarName).toBe('OPENAI_API_KEY_BRACE') // ${VAR} → VAR
    expect(p2.apiKey).toBe('${OPENAI_API_KEY_BRACE}')
    expect(p2._apiKeyExtracted).toBe(true)
  })

  it('wave4-t3: auth.json env 包 → _credentialType=env-bundle + apiKey 不写 + warning', () => {
    writePiAgentFile('models.json', JSON.stringify({
      providers: { deepseek: { name: 'DeepSeek', api: 'openai-completions', models: [{ id: 'ds', name: 'DS' }] } },
    }))
    writePiAgentFile('auth.json', JSON.stringify({
      deepseek: { type: 'api_key', key: '$DEEPSEEK_API_KEY', env: { DEEPSEEK_API_KEY: 'sk-real-from-bundle' } },
    }))

    const result = parsePiProviders(home)!
    const p = result.providers.find((x) => x._sourceName === 'deepseek')!
    expect(p._credentialType).toBe('env-bundle') // 有凭据但 Phase 1 不支持落盘，区别于 missing（无线索）
    expect(p.apiKey).toBeUndefined() // 不落盘，避免 resolveConfigValueOrThrow 硬抛错
    expect(p._apiKeyExtracted).toBe(false)
    expect(p._warnings.some((w) => w.includes('env bundle') && w.includes('Phase 1'))).toBe(true)
  })

  it('wave4-t4: auth.json type=oauth（真实格式 access/refresh/expires）→ _credentialType=oauth + 不取 token + warning', () => {
    writePiAgentFile('models.json', JSON.stringify({
      providers: { 'github-copilot': { name: 'Copilot', api: 'openai-completions', models: [{ id: 'c', name: 'C' }] } },
    }))
    writePiAgentFile('auth.json', JSON.stringify({
      // pi-ai 0.82.1 OAuthCredential 真实字段：access/refresh/expires（auth/types.d.ts）
      'github-copilot': { type: 'oauth', access: 'acc-xxx', refresh: 'ref-yyy', expires: 1234567890 },
    }))

    const result = parsePiProviders(home)!
    const p = result.providers.find((x) => x._sourceName === 'github-copilot')!
    expect(p._credentialType).toBe('oauth')
    expect(p.apiKey).toBeUndefined() // 不取 token 作 apiKey
    expect(p._apiKeyExtracted).toBe(false)
    expect(p._warnings.some((w) => w.includes('OAuth') && w.includes('Phase 2'))).toBe(true)
  })

  it('wave4-t4b: 缺 type 的旧格式 oauth（有 access 无 key）→ 兼容判定 oauth', () => {
    writePiAgentFile('models.json', JSON.stringify({
      providers: { copilot: { name: 'Copilot', api: 'openai-completions', models: [{ id: 'c', name: 'C' }] } },
    }))
    // 旧格式无 type 字段，但有 access 字段且无 key —— 按 oauth 处理（基于旧字段名 token 的死代码已移除）
    writePiAgentFile('auth.json', JSON.stringify({
      copilot: { access: 'acc-old-format', refresh: 'ref-old-format', expires: 123 },
    }))

    const result = parsePiProviders(home)!
    const p = result.providers.find((x) => x._sourceName === 'copilot')!
    expect(p._credentialType).toBe('oauth')
    expect(p.apiKey).toBeUndefined()
  })

  it('wave4-t4c: 旧字段名 token/refreshToken 不再作为 oauth 判定依据（type 缺失且无 key 时判 missing）', () => {
    writePiAgentFile('models.json', JSON.stringify({
      providers: { copilot: { name: 'Copilot', api: 'openai-completions', models: [{ id: 'c', name: 'C' }] } },
    }))
    // 只有旧字段 token/refreshToken：pi 真实格式没有这些字段名，不应被识别为 oauth
    writePiAgentFile('auth.json', JSON.stringify({
      copilot: { token: 'tok-xxx', refreshToken: 'ref-yyy', expires: 123 },
    }))

    const result = parsePiProviders(home)!
    const p = result.providers.find((x) => x._sourceName === 'copilot')!
    expect(p._credentialType).toBe('missing')
    expect(p.apiKey).toBeUndefined()
  })

  it('wave4-t4d: auth.json key=$$OPENAI_API_KEY（字面量转义）→ _credentialType=plaintext，不剥 $', () => {
    writePiAgentFile('models.json', JSON.stringify({
      providers: { openai: { name: 'OpenAI', api: 'openai-completions', models: [{ id: 'gpt-4', name: 'GPT-4' }] } },
    }))
    // $$ 是 pi 的字面量转义（解析为字面量 $OPENAI_API_KEY），不是 env 引用
    writePiAgentFile('auth.json', JSON.stringify({ openai: { type: 'api_key', key: '$$OPENAI_API_KEY' } }))

    const result = parsePiProviders(home)!
    const p = result.providers.find((x) => x._sourceName === 'openai')!
    expect(p._credentialType).toBe('plaintext')
    expect(p.apiKey).toBe('$$OPENAI_API_KEY') // 保留原转义串，pi 运行时还原字面量
    expect(p._envVarName).toBeUndefined() // 不提取 env var 名
    expect(p._apiKeyExtracted).toBe(true)
  })

  it('wave4-t5: auth.json key=!command → _credentialType=command + apiKey 保留 + warning', () => {
    writePiAgentFile('models.json', JSON.stringify({
      providers: { openai: { name: 'OpenAI', api: 'openai-completions', models: [{ id: 'gpt-4', name: 'GPT-4' }] } },
    }))
    writePiAgentFile('auth.json', JSON.stringify({ openai: { type: 'api_key', key: '!op read xxx' } }))

    const result = parsePiProviders(home)!
    const p = result.providers.find((x) => x._sourceName === 'openai')!
    expect(p._credentialType).toBe('command')
    expect(p.apiKey).toBe('!op read xxx') // 保留原样，pi 运行时执行 shell 命令
    expect(p._apiKeyExtracted).toBe(true)
    expect(p._warnings.some((w) => w.includes('!') && w.includes('shell command'))).toBe(true)
  })

  // ══ sa3 F1：孤儿凭据扫描（B.1 缺口 4 修复）══
  // auth.json 里有、models.json 没定义的 providerId（pi 内置 provider 的凭据）→ orphanCredentials

  it('sa3-o1: auth.json 有 openai 凭据 + models.json 无 openai → orphanCredentials 输出（不进 providers）', () => {
    writePiAgentFile('models.json', JSON.stringify({
      providers: { zhipu: { name: 'Zhipu', api: 'openai-completions', models: [{ id: 'm', name: 'M' }] } },
    }))
    // openai 只在 auth.json（pi 内置 provider，models.json 无定义）
    writePiAgentFile('auth.json', JSON.stringify({ openai: { type: 'api_key', key: 'sk-orphan-openai-plain' } }))

    const result = parsePiProviders(home)!

    // 不进 providers（models.json 无定义）
    expect(result.providers.find((x) => x._sourceName === 'openai')).toBeUndefined()
    expect(result.providers).toHaveLength(1)
    // 进 orphanCredentials
    expect(result.orphanCredentials).toHaveLength(1)
    const oc = result.orphanCredentials![0]
    expect(oc.providerId).toBe('openai')
    expect(oc.credentialType).toBe('plaintext')
    // 明文 key 只活在 runtime 内存（测试直接断言对象，preview 脱敏由 provider-importer 负责）
    expect(oc.apiKey).toBe('sk-orphan-openai-plain')
    expect(oc.envVarName).toBeUndefined()
  })

  it('sa3-o2: env 包孤儿 → credentialType=env-bundle + apiKey 不写 + warning', () => {
    writePiAgentFile('models.json', JSON.stringify({
      providers: { zhipu: { name: 'Zhipu', api: 'openai-completions', models: [{ id: 'm', name: 'M' }] } },
    }))
    writePiAgentFile('auth.json', JSON.stringify({
      deepseek: { type: 'api_key', key: '$DEEPSEEK_API_KEY', env: { DEEPSEEK_API_KEY: 'sk-from-bundle' } },
    }))

    const result = parsePiProviders(home)!
    const oc = result.orphanCredentials!.find((x) => x.providerId === 'deepseek')!
    expect(oc.credentialType).toBe('env-bundle')
    expect(oc.apiKey).toBeUndefined() // Phase 1 不落盘
    expect(oc.warnings.some((w) => w.includes('env bundle') && w.includes('Phase 1'))).toBe(true)
  })

  it('sa3-o3: oauth 孤儿（access/refresh/expires）→ credentialType=oauth + apiKey 不写 + warning', () => {
    writePiAgentFile('models.json', JSON.stringify({
      providers: { zhipu: { name: 'Zhipu', api: 'openai-completions', models: [{ id: 'm', name: 'M' }] } },
    }))
    writePiAgentFile('auth.json', JSON.stringify({
      'github-copilot': { type: 'oauth', access: 'acc-orphan', refresh: 'ref-orphan', expires: 1234567890 },
    }))

    const result = parsePiProviders(home)!
    const oc = result.orphanCredentials!.find((x) => x.providerId === 'github-copilot')!
    expect(oc.credentialType).toBe('oauth')
    expect(oc.apiKey).toBeUndefined()
    expect(oc.warnings.some((w) => w.includes('OAuth') && w.includes('Phase 2'))).toBe(true)
  })

  it('sa3-o4: env 引用孤儿 → credentialType=env + envVarName 去前缀 + apiKey 保留占位串', () => {
    writePiAgentFile('models.json', JSON.stringify({
      providers: { zhipu: { name: 'Zhipu', api: 'openai-completions', models: [{ id: 'm', name: 'M' }] } },
    }))
    writePiAgentFile('auth.json', JSON.stringify({ openai: { type: 'api_key', key: '$OPENAI_API_KEY' } }))

    const result = parsePiProviders(home)!
    const oc = result.orphanCredentials!.find((x) => x.providerId === 'openai')!
    expect(oc.credentialType).toBe('env')
    expect(oc.envVarName).toBe('OPENAI_API_KEY')
    expect(oc.apiKey).toBe('$OPENAI_API_KEY') // 保留原占位串（运行时解析）
    expect(oc.warnings.some((w) => w.includes('env var reference'))).toBe(true)
  })

  it('sa3-o5: models.json 已定义的 provider 不进 orphanCredentials（六态判定仍走主流程）', () => {
    writePiAgentFile('models.json', JSON.stringify({
      providers: { deepseek: { name: 'DeepSeek', api: 'openai-completions', models: [{ id: 'm', name: 'M' }] } },
    }))
    writePiAgentFile('auth.json', JSON.stringify({ deepseek: { type: 'api_key', key: 'sk-deepseek' } }))

    const result = parsePiProviders(home)!
    expect(result.orphanCredentials).toHaveLength(0)
    // 主流程照常：credentialType=plaintext
    expect(result.providers[0]._credentialType).toBe('plaintext')
    expect(result.providers[0].apiKey).toBe('sk-deepseek')
  })

  it('sa3-o6: auth.json 非对象条目（null/字符串）→ 孤儿凭据跳过 + 顶层 warning', () => {
    writePiAgentFile('models.json', JSON.stringify({
      providers: { zhipu: { name: 'Zhipu', api: 'openai-completions', models: [{ id: 'm', name: 'M' }] } },
    }))
    writePiAgentFile('auth.json', JSON.stringify({ weird: 'sk-not-an-object', bad: null }))

    const result = parsePiProviders(home)!
    expect(result.orphanCredentials).toHaveLength(0)
    expect(result.warnings!.some((w) => w.includes('credential weird') && w.includes('malformed'))).toBe(true)
  })

  // ══ W4 补充：分支覆盖缺口锚定 ══

  // RT-5#3：api 字段缺失（undefined）与未知协议同路 skip——pi 的 createProvider 直接
  // `input.api.stream` 取流实现（pi-ai dist/models.js），无 api 的 provider 在 pi 运行时
  // TypeError，放行只会导入不可用空壳（空壳防线③只核八字段挡不住）。
  // 旧行为（保留 + api 透传 undefined）已废弃。
  it('W4-a: api 字段缺失的 provider → skip + 顶层 warning（RT-5#3）', () => {
    writePiAgentFile('models.json', JSON.stringify({
      providers: {
        noapi: { name: 'NoApi', models: [{ id: 'm', name: 'M' }] },
        normal: { name: 'Normal', api: 'openai-completions', models: [{ id: 'm2', name: 'M2' }] },
      },
    }))

    const result = parsePiProviders(home)!

    expect(result.providers).toHaveLength(1)
    expect(result.providers[0]!._sourceName).toBe('normal')
    expect(result.parseError).toBeUndefined()
    expect(result.warnings!.some((w) => w.includes('noapi') && w.includes('missing protocol (api), skipped'))).toBe(true)
  })

  // 锚定 `authEntry?.key ?? configApiKey` 的 ?? 另一侧：auth entry 存在但无 key 字段
  // → 回退 models.json 的 apiKey（区别于 T9 的「auth 文件不存在」路径）。
  it('W4-b: auth entry 存在但无 key → apiKey 回退 models.json 的值', () => {
    writePiAgentFile('models.json', JSON.stringify({
      providers: { zhipu: { name: 'Zhipu', api: 'openai-completions', apiKey: 'sk-fake-zhipu-in-models', models: [{ id: 'm', name: 'M' }] } },
    }))
    // zhipu 在 auth.json 有条目，但没有 key 字段（只有无关字段）
    writePiAgentFile('auth.json', JSON.stringify({ zhipu: { type: 'api_key' } }))

    const result = parsePiProviders(home)!
    const zhipu = result.providers.find((x) => x._sourceName === 'zhipu')!
    expect(zhipu.apiKey).toBe('sk-fake-zhipu-in-models')
    expect(zhipu._credentialType).toBe('plaintext')
    expect(zhipu._apiKeyExtracted).toBe(true)
  })

  // 锚定 hasEnvBundle 第三条件（Object.keys().length > 0）的另一侧：空 env 包 `{}` 不算
  // env-bundle，继续按 key 前缀判定（key=$VAR → env 态）。
  it('W4-c: auth entry env 为空包 {} → 不判 env-bundle，按 key 前缀判 env', () => {
    writePiAgentFile('models.json', JSON.stringify({
      providers: { zhipu: { name: 'Zhipu', api: 'openai-completions', models: [{ id: 'm', name: 'M' }] } },
    }))
    writePiAgentFile('auth.json', JSON.stringify({
      zhipu: { type: 'api_key', key: '$ZHIPU_API_KEY', env: {} },
    }))

    const result = parsePiProviders(home)!
    const zhipu = result.providers.find((x) => x._sourceName === 'zhipu')!
    expect(zhipu._credentialType).toBe('env')
    expect(zhipu._envVarName).toBe('ZHIPU_API_KEY')
    expect(zhipu.apiKey).toBe('$ZHIPU_API_KEY')
    expect(zhipu._warnings.some((w) => w.includes('env bundle'))).toBe(false)
  })
})
});

// ======================================================================
// ← src/services/migration/parsers/__tests__/zcode-parser.test.ts
// ======================================================================

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('zcode-parser', () => {
describe('parseZcodeProviders', () => {
  let home: string

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'zcode-parser-'))
  })
  afterEach(() => {
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  /** 把 config.json 写到 <home>/.zcode/v2/config.json。 */
  function writeZcodeConfig(content: string): string {
    const v2Dir = join(home, '.zcode', 'v2')
    mkdirSync(v2Dir, { recursive: true })
    const dest = join(v2Dir, 'config.json')
    writeFileSync(dest, content)
    return dest
  }

  // ── T3：正常解析（2 provider），kind 映射 ──────────────────────────
  it('T3: 解析 2 provider，kind 映射，明文提取 + 加密留空', () => {
    writeZcodeConfig(JSON.stringify(zcodeConfigFixture))

    const result = parseZcodeProviders(home)

    expect(result).not.toBeNull()
    expect(result!.providers).toHaveLength(2)
    expect(result!.parseError).toBeUndefined()

    // bigmodel：kind=anthropic → anthropic-messages，明文 apiKey 提取
    const bigmodel = result!.providers.find((p) => p._sourceName === 'bigmodel')!
    expect(bigmodel.api).toBe('anthropic-messages')
    expect(bigmodel.apiKey).toBe('sk-fake-bigmodel-plaintext')
    expect(bigmodel._apiKeyExtracted).toBe(true)
    expect(bigmodel.baseUrl).toBe('https://open.bigmodel.cn/api/paas/v4')
    expect(bigmodel.name).toBe('BigModel')
    // models 转换：contextWindow / maxTokens / reasoning / thinkingLevelMap
    expect(bigmodel.models).toHaveLength(2)
    const glm46 = bigmodel.models!.find((m) => m.id === 'glm-4.6')!
    expect(glm46.contextWindow).toBe(128000)
    expect(glm46.maxTokens).toBe(16384)
    expect(glm46.reasoning).toBe(true)
    // thinkingLevelMap 从 variants 推断
    expect(glm46.thinkingLevelMap).toEqual({ low: 'low', medium: 'medium', high: 'high' })

    // router：kind=openai-compatible → openai-completions（+ warning），无明文 apiKey
    const router = result!.providers.find((p) => p._sourceName === 'router')!
    expect(router.api).toBe('openai-completions')
    expect(router.apiKey).toBeUndefined()
    expect(router._apiKeyExtracted).toBe(false)
    expect(router.baseUrl).toBe('https://router.example.com/v1')
    // warning：openai-compatible 映射提示
    expect(router._warnings.some((w) => w.includes('mapped to openai-completions'))).toBe(true)
  })

  // ── T4：config.json 损坏 → parseError ──────────────────────────────
  it('T4: config.json JSON 损坏 → parseError 含 cannot parse', () => {
    writeZcodeConfig('{ broken json')

    const result = parseZcodeProviders(home)

    expect(result).not.toBeNull()
    expect(result!.providers).toHaveLength(0)
    expect(result!.parseError).toMatch(/cannot parse zcode config\.json/)
  })

  // ── T5：源目录不存在 → null ────────────────────────────────────────
  it('T5: ~/.zcode/v2/config.json 不存在 → 返回 null', () => {
    expect(existsSync(join(home, '.zcode'))).toBe(false)

    const result = parseZcodeProviders(home)

    expect(result).toBeNull()
  })

  // ── T6：未知 kind → 该 provider 跳过 ───────────────────────────────
  it('T6: 未知 kind 的 provider 被跳过（不进结果），warning 进顶层 warnings', () => {
    const config = {
      provider: {
        weird: {
          name: 'Weird',
          kind: 'some-unknown-protocol',
          options: { apiKey: 'sk-fake', baseURL: 'https://x.com' },
          models: { m1: { name: 'M1' } },
        },
        anthropic1: {
          name: 'AnthropicOne',
          kind: 'anthropic',
          options: { baseURL: 'https://a.com' },
          models: { m2: { name: 'M2' } },
        },
      },
    }
    writeZcodeConfig(JSON.stringify(config))

    const result = parseZcodeProviders(home)

    expect(result).not.toBeNull()
    // weird 跳过，只剩 anthropic1
    expect(result!.providers).toHaveLength(1)
    expect(result!.providers[0]._sourceName).toBe('anthropic1')
    // S5：未知 kind 的 warning 进顶层 warnings（不再被 continue 丢弃）
    expect(result!.warnings).toBeDefined()
    expect(result!.warnings!.some((w) => w.includes('provider weird') && w.includes('unknown kind'))).toBe(true)
  })

  // ── T7：kind 缺失 → 跳过 ───────────────────────────────────────────
  it('T7: kind 缺失的 provider 被跳过', () => {
    const config = {
      provider: {
        nokind: {
          name: 'NoKind',
          options: { apiKey: 'sk-fake' },
          models: { m1: { name: 'M1' } },
        },
      },
    }
    writeZcodeConfig(JSON.stringify(config))

    const result = parseZcodeProviders(home)

    expect(result).not.toBeNull()
    expect(result!.providers).toHaveLength(0)
  })

  // ── B1：单个 entry 为 null → 不中断，其他 provider 正常解析，坏条目进 topWarnings ──
  it('B1: provider 含 null/非对象条目 → 坏条目跳过进 warnings，其他 provider 正常解析', () => {
    const config = {
      provider: {
        bad: null,
        good: {
          name: 'Good',
          kind: 'anthropic',
          options: { apiKey: 'sk-good' },
          models: { m: { name: 'M' } },
        },
      },
    }
    writeZcodeConfig(JSON.stringify(config))

    const result = parseZcodeProviders(home)

    expect(result).not.toBeNull()
    expect(result!.providers).toHaveLength(1)
    expect(result!.providers[0]._sourceName).toBe('good')
    expect(result!.warnings).toBeDefined()
    expect(result!.warnings!.some((w) => w.includes('provider bad') && w.includes('malformed'))).toBe(true)
  })

  // ── B1：config.json 整体 null → 不 crash，providers=[] ─────────────
  it('B1: config.json 内容为 null → 不 crash，providers=[]', () => {
    writeZcodeConfig('null')

    const result = parseZcodeProviders(home)

    expect(result).not.toBeNull()
    expect(result!.providers).toHaveLength(0)
    expect(result!.parseError).toBeUndefined()
  })

  // ── S7：enabled 字段传播 ───────────────────────────────────────────
  it('S7: ZCode provider 的 enabled=false 传播到 ParsedProvider.enabled', () => {
    const config = {
      provider: {
        disabled: {
          name: 'Disabled',
          kind: 'anthropic',
          enabled: false,
          options: { apiKey: 'sk-fake' },
          models: { m: { name: 'M' } },
        },
      },
    }
    writeZcodeConfig(JSON.stringify(config))

    const result = parseZcodeProviders(home)

    expect(result).not.toBeNull()
    expect(result!.providers).toHaveLength(1)
    expect(result!.providers[0].enabled).toBe(false)
  })

  // ── S8：modalities.input 映射到 PiModelDefinition.input ────────────
  it('S8: model 的 modalities.input 数组直传到 PiModelDefinition.input', () => {
    const config = {
      provider: {
        bigmodel: {
          name: 'BigModel',
          kind: 'anthropic',
          options: { apiKey: 'sk-fake' },
          models: {
            'glm-4.6': {
              name: 'GLM-4.6',
              modalities: { input: ['text', 'image'], output: ['text'] },
            },
          },
        },
      },
    }
    writeZcodeConfig(JSON.stringify(config))

    const result = parseZcodeProviders(home)

    expect(result).not.toBeNull()
    const model = result!.providers[0].models![0]
    expect(model.input).toEqual(['text', 'image'])
  })

  // ── W4 补充：分支覆盖缺口锚定 ──

  // 锚定 `entry.kind && entry.kind.startsWith('openai')` 的纯 'openai' 前缀分支：
  // kind=openai（非 compatible）同样映射 openai-completions，且不产 mapped warning。
  it('W4-a: kind=openai → openai-completions，_warnings 含 mapped 提示（纯 openai 与 compatible 同样提示）', () => {
    const config = {
      provider: {
        plainopenai: {
          name: 'PlainOpenAI',
          kind: 'openai',
          options: { apiKey: 'sk-fake', baseURL: 'https://api.openai.com/v1' },
          models: { m: { name: 'M' } },
        },
      },
    }
    writeZcodeConfig(JSON.stringify(config))

    const result = parseZcodeProviders(home)

    expect(result).not.toBeNull()
    expect(result!.providers).toHaveLength(1)
    const provider = result!.providers[0]
    expect(provider.api).toBe('openai-completions')
    expect(provider._warnings.some((w) => w.includes('mapped to openai-completions'))).toBe(true)
    // 顶层也无 warnings（无丢弃条目）
    expect(result!.warnings).toBeUndefined()
  })

  // 锚定 `entry.models ?? {}` 的另一侧：provider 无 models 字段 → models=[]（不崩）。
  it('W4-b: provider 无 models 字段 → models=[]，其余字段正常解析', () => {
    const config = {
      provider: {
        nomodels: {
          name: 'NoModels',
          kind: 'anthropic',
          options: { apiKey: 'sk-fake', baseURL: 'https://a.com' },
        },
      },
    }
    writeZcodeConfig(JSON.stringify(config))

    const result = parseZcodeProviders(home)

    expect(result).not.toBeNull()
    expect(result!.providers).toHaveLength(1)
    const provider = result!.providers[0]
    expect(provider.models).toHaveLength(0)
    expect(provider.api).toBe('anthropic-messages')
    expect(provider.apiKey).toBe('sk-fake')
    expect(provider._credentialType).toBe('plaintext')
  })

  // 锚定 model 条目 null 的 `?? {}` 兜底：name 回退 modelId，其他字段 undefined，不崩。
  it('W4-c: model 条目为 null → 不崩，name 回退 modelId', () => {
    const config = {
      provider: {
        bigmodel: {
          name: 'BigModel',
          kind: 'anthropic',
          options: { apiKey: 'sk-fake' },
          models: { 'glm-null': null, 'glm-ok': { name: 'GLM OK' } },
        },
      },
    }
    writeZcodeConfig(JSON.stringify(config))

    const result = parseZcodeProviders(home)

    expect(result).not.toBeNull()
    expect(result!.providers).toHaveLength(1)
    const models = result!.providers[0].models!
    expect(models).toHaveLength(2)
    const nullModel = models.find((m) => m.id === 'glm-null')!
    expect(nullModel.name).toBe('glm-null')
    expect(nullModel.contextWindow).toBeUndefined()
    expect(nullModel.thinkingLevelMap).toBeUndefined()
    const okModel = models.find((m) => m.id === 'glm-ok')!
    expect(okModel.name).toBe('GLM OK')
  })

  // 锚定 inferThinkingLevelMap 的另一侧：reasoning 有 enabled 无 variants → thinkingLevelMap undefined。
  it('W4-d: model reasoning 无 variants → thinkingLevelMap undefined，reasoning 布尔仍透传', () => {
    const config = {
      provider: {
        bigmodel: {
          name: 'BigModel',
          kind: 'anthropic',
          options: { apiKey: 'sk-fake' },
          models: {
            'glm-novariants': { name: 'GLM NoVariants', reasoning: { enabled: true } },
          },
        },
      },
    }
    writeZcodeConfig(JSON.stringify(config))

    const result = parseZcodeProviders(home)

    expect(result).not.toBeNull()
    const model = result!.providers[0].models![0]
    expect(model.reasoning).toBe(true)
    expect(model.thinkingLevelMap).toBeUndefined()
  })
})
});
