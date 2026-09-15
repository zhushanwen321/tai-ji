/**
 * pi-parser 测试（W3）。
 *
 * 测试策略：用临时目录写真实 fixture 文件，传临时 homeDir 给解析器（避免 mock fs，更真实）。
 * fixture 通过 JSON import 加载（vitest 原生支持），写入临时目录的 .pi/agent/ 下。
 *
 * 注意：禁止 meta.url（validate-runtime-bundle §3 禁用），用 JSON import 取代路径解析。
 *
 * 运行：cd packages/runtime && npx vitest run src/services/migration/parsers/__tests__/pi-parser.test.ts
 *
 * 覆盖：
 *   - T1：正常解析（3 provider → 2，gemini 丢弃，auth.json 合并，协议直传）。
 *   - T2：只有 google-generative-ai → providers 空。
 *   - T7：models.json JSON 损坏 → parseError。
 *   - T8：源目录不存在 → 返回 null。
 *   - T9：auth.json 不存在 → 回退 models.json 的 apiKey。
 *   - T10：auth.json 损坏 → 不阻断，warning 提示，仍从 models.json 取 key。
 *   - T11：~/.pi/agent 存在但无 models.json → parseError。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { parsePiProviders } from '../pi-parser.js'
// fixture 通过 JSON import 加载（vitest resolveJSON 模块，避免 meta.url）
import piModelsFixture from './fixtures/pi-models.json' with { type: 'json' }
import piModelsGeminiOnlyFixture from './fixtures/pi-models-gemini-only.json' with { type: 'json' }
import piAuthFixture from './fixtures/pi-auth.json' with { type: 'json' }

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

  // 锚定 `if (config.api && !PI_SUPPORTED_PROTOCOLS.has(config.api))` 的另一侧：
  // api 字段缺失（undefined）时 provider 保留（不 skip），api 原样 undefined 透传。
  it('W4-a: api 字段缺失的 provider → 保留进结果（不 skip），api 为 undefined', () => {
    writePiAgentFile('models.json', JSON.stringify({
      providers: {
        noapi: { name: 'NoApi', models: [{ id: 'm', name: 'M' }] },
        normal: { name: 'Normal', api: 'openai-completions', models: [{ id: 'm2', name: 'M2' }] },
      },
    }))

    const result = parsePiProviders(home)!

    expect(result.providers).toHaveLength(2)
    const noapi = result.providers.find((x) => x._sourceName === 'noapi')!
    expect(noapi.api).toBeUndefined()
    expect(noapi.name).toBe('NoApi')
    expect(result.parseError).toBeUndefined()
    // api 缺失不产生顶层 warnings（不属于丢弃场景）
    expect(result.warnings).toBeUndefined()
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
