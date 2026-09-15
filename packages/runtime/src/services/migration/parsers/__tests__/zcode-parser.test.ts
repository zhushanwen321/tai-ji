/**
 * zcode-parser 测试（W3）。
 *
 * 测试策略：临时目录 + 真实 fixture JSON 写文件（避免 mock fs）。
 * 运行：cd packages/runtime && npx vitest run src/services/migration/parsers/__tests__/zcode-parser.test.ts
 *
 * 覆盖：
 *   - T3：正常解析（2 provider），kind 映射，明文提取+加密留空，thinkingLevelMap 推断。
 *   - T4：config.json 损坏 → parseError。
 *   - T5：源目录不存在 → null。
 *   - T6：未知 kind → 该 provider 跳过。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { parseZcodeProviders } from '../zcode-parser.js'
import zcodeConfigFixture from './fixtures/zcode-config.json' with { type: 'json' }

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
