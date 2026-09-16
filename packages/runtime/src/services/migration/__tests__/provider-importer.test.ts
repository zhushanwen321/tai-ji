/**
 * provider-importer 测试（W2，cw-2026-07-26-migration-other-agents）。
 *
 * 测试框架：vitest（从 vitest 导入 describe/it/expect/vi/beforeEach）。
 * 运行命令：cd packages/runtime && npx vitest run src/services/migration/__tests__/provider-importer.test.ts
 *
 * mock 策略：
 *   - vi.mock('../provider-parser.js')：控制 parseProviders 返回 fixture（含 apiKey 明文，验证脱敏）。
 *   - vi.mock('../../../infra/pi/pi-provider-store.js')：控制 getProviderNames（冲突检测）+ upsertProvider（捕获写参）。
 *
 * 覆盖：
 *   - T3：previewImport 返回的 JSON 不含 fixture 的 apiKey 值（'sk-real-key-123'）——脱敏红线。
 *   - T4：applyImport 调 upsertProvider 时传的 config 不含 _ 开头字段（剥离元数据）。
 *   - T5：冲突 provider（existingIds 含 foo）preview 标 duplicate-id + apply 标 skipped。
 *   - T6：upsertProvider 对 'A' 抛错，selectedIds=['A','B','C'] → A failed / B,C imported / failedCount=1。
 *   - T7：parseProviders 返回 null（源未安装）→ previewImport 返回 SOURCE_NOT_INSTALLED。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── vi.mock 必须在 import 之前（vitest hoist）──────────────────────

// mock parseProviders：默认返回 null（源未安装），各 test 用 mockReturnValue 覆盖
vi.mock('../provider-parser.js', () => ({
  parseProviders: vi.fn(() => null),
}))

// mock pi-provider-store：getProviderNames 默认空数组（无冲突），upsertProvider 默认 no-op
vi.mock('../../../infra/pi/pi-provider-store.js', () => ({
  getProviderNames: vi.fn(() => []),
  upsertProvider: vi.fn(() => ({})),
  // wave3 边界1：applyImport 导入成功后调 ensureProviderInWhitelist（白名单守卫），mock 补全避免 No export 报错
  ensureProviderInWhitelist: vi.fn(),
}))


// mock provider-catalog：默认 isCatalogProvider 返回 false（保持现有自定义 provider 行为）
vi.mock('../../provider-catalog.js', () => ({
  isCatalogProvider: vi.fn(() => false),
}))

// ── import（在 mock 之后，拿到 mock 版本）──────────────────────────
import { previewImport, applyImport } from '../provider-importer.js'
import { isCatalogProvider } from '../../provider-catalog.js'
import { parseProviders } from '../provider-parser.js'
import { getProviderNames, upsertProvider } from '../../../infra/pi/pi-provider-store.js'
import { _resetCacheForTest } from '../preview-cache.js'
import type { ProviderExtras } from '../../provider-extras-store.js'
import type { ParsedProvider, ParseResult } from '../provider-parser.js'

// ── fixture helpers ──────────────────────────────────────────

/** 构造 ParsedProvider fixture。注意 apiKey 含明文（用于脱敏断言）。 */
function fp(overrides: Partial<ParsedProvider> = {}): ParsedProvider {
  return {
    _sourceName: 'p1',
    _apiKeyExtracted: true,
    _credentialType: 'plaintext',
    _warnings: [],
    api: 'anthropic-messages',
    baseUrl: 'https://example.com',
    apiKey: 'sk-real-key-123',
    models: [{ id: 'm1', name: 'M1' }],
    ...overrides,
  }
}

/** 把 ParseResult 字面量包成 mock 返回值（parseProviders mockReturnValue 需 ParseResult | null）。 */
function result(providers: ParsedProvider[]): ParseResult {
  return { providers }
}

// ── tests ────────────────────────────────────────────────────

describe('provider-importer', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    _resetCacheForTest()
    // 重置默认 mock 行为
    vi.mocked(parseProviders).mockReturnValue(null)
    vi.mocked(getProviderNames).mockReturnValue([])
    vi.mocked(upsertProvider).mockImplementation(() => ({}))
    // isCatalogProvider 默认 false（自定义 provider 行为）；显式重置避免上个用例的
    // mockReturnValue(true) 泄漏（clearAllMocks 只清调用记录，不清实现）
    vi.mocked(isCatalogProvider).mockReturnValue(false)
  })

  // ── T3：脱敏红线 —— preview 不含 apiKey 明文 ──────────────────
  it('T3: previewImport 返回的 JSON 不含 fixture 的 apiKey 值（脱敏）', async () => {
    const fixture = [fp({ _sourceName: 'leaky' })]
    vi.mocked(parseProviders).mockReturnValue(result(fixture))

    const out = previewImport('pi')

    // 必须成功（有 importId）
    expect('importId' in out).toBe(true)
    const serialized = JSON.stringify(out)
    // 红线：apiKey 明文绝不进 preview 序列化结果
    expect(serialized).not.toContain('sk-real-key-123')
    // 但 apiKeyExtracted 布尔要保留（提示前端 key 已提取）
    if ('preview' in out) {
      expect(out.preview.providers[0].apiKeyExtracted).toBe(true)
    }
  })

  // ── T4：apply 剥离 _ 前缀元数据 ──────────────────────────────
  it('T4: applyImport 调 upsertProvider 时 config 不含 _ 开头字段', async () => {
    const fixture = [
      fp({ _sourceName: 'A' }),
      fp({ _sourceName: 'B', apiKey: 'sk-B-key' }),
    ]
    vi.mocked(parseProviders).mockReturnValue(result(fixture))

    const prev = previewImport('pi')
    if (!('importId' in prev)) throw new Error('preview should succeed')
    const applyOut = await applyImport(prev.importId, ['A', 'B'])

    expect('result' in applyOut).toBe(true)
    expect(upsertProvider).toHaveBeenCalledTimes(2)

    // 捕获每次 upsertProvider 调用的 config 参数，断言无 _ 前缀字段
    for (const call of vi.mocked(upsertProvider).mock.calls) {
      const [, config] = call
      const keys = Object.keys(config)
      const underscoreKeys = keys.filter((k) => k.startsWith('_'))
      expect(underscoreKeys).toEqual([])
    }
  })

  // ── T5：冲突检测（duplicate-id → skipped）────────────────────
  it('T5: existingIds 含 foo → preview conflict=duplicate-id, apply status=skipped', async () => {
    vi.mocked(parseProviders).mockReturnValue(result([fp({ _sourceName: 'foo' })]))
    vi.mocked(getProviderNames).mockReturnValue(['foo'])

    const prev = previewImport('pi')
    if (!('preview' in prev)) throw new Error('preview should succeed')
    expect(prev.preview.providers[0].conflict).toBe('duplicate-id')

    const applyOut = await applyImport(prev.importId, ['foo'])
    if (!('result' in applyOut)) throw new Error('apply should succeed')
    expect(applyOut.result.imported).toHaveLength(1)
    expect(applyOut.result.imported[0]).toMatchObject({ id: 'foo', status: 'skipped' })
    // skipped 的 provider 不应调 upsertProvider
    expect(upsertProvider).not.toHaveBeenCalled()
  })

  // ── T6：upsertProvider 部分失败（A failed, B/C imported, failedCount=1）──
  it('T6: upsertProvider 对 A 抛错 → A failed, B/C imported, failedCount=1', async () => {
    vi.mocked(parseProviders).mockReturnValue(
      result([
        fp({ _sourceName: 'A' }),
        fp({ _sourceName: 'B' }),
        fp({ _sourceName: 'C' }),
      ]),
    )
    // upsertProvider 对 id='A' 抛错，其余成功
    vi.mocked(upsertProvider).mockImplementation((id: string) => {
      if (id === 'A') throw new Error('write failed for A')
      return {}
    })

    const prev = previewImport('pi')
    if (!('importId' in prev)) throw new Error('preview should succeed')
    const applyOut = await applyImport(prev.importId, ['A', 'B', 'C'])

    if (!('result' in applyOut)) throw new Error('apply should succeed')
    const byId = Object.fromEntries(applyOut.result.imported.map((i) => [i.id, i]))
    expect(byId.A.status).toBe('failed')
    expect(byId.A.reason).toContain('write failed for A')
    expect(byId.B.status).toBe('imported')
    expect(byId.C.status).toBe('imported')
    expect(applyOut.result.failedCount).toBe(1)
  })

  // ── T7：源未安装 → SOURCE_NOT_INSTALLED ──────────────────────
  it('T7: parseProviders 返回 null → previewImport 返回 SOURCE_NOT_INSTALLED', async () => {
    vi.mocked(parseProviders).mockReturnValue(null)

    const out = previewImport('claude')

    expect('error' in out).toBe(true)
    if ('error' in out) {
      expect(out.error.code).toBe('SOURCE_NOT_INSTALLED')
      expect(out.error.message).toContain('claude')
    }
  })

  // ── T7b：applyImport 缓存过期 → PREVIEW_EXPIRED ───────────────
  it('T7b: importId 不存在（缓存过期）→ applyImport 返回 PREVIEW_EXPIRED', async () => {
    const out = await applyImport('nonexistent-import-id', ['A'])

    expect('error' in out).toBe(true)
    if ('error' in out) {
      expect(out.error.code).toBe('PREVIEW_EXPIRED')
    }
    expect(upsertProvider).not.toHaveBeenCalled()
  })

  // ── T8：apply 后缓存删除（一次性，防 importId 复用）──────────
  it('applyImport 成功后删缓存——再次 apply 同 importId 返回 PREVIEW_EXPIRED', async () => {
    vi.mocked(parseProviders).mockReturnValue(result([fp({ _sourceName: 'A' })]))

    const prev = previewImport('pi')
    if (!('importId' in prev)) throw new Error('preview should succeed')
    const first = await applyImport(prev.importId, ['A'])
    expect('result' in first).toBe(true)

    // 第二次 apply 同 importId → 缓存已被删 → PREVIEW_EXPIRED
    const second = await applyImport(prev.importId, ['A'])
    expect('error' in second).toBe(true)
    if ('error' in second) {
      expect(second.error.code).toBe('PREVIEW_EXPIRED')
    }
  })

  // ── T9：selectedIds 过滤——未勾选的 provider 不写 ─────────────
  it('applyImport 仅处理 selectedIds 勾选的 provider（未勾选不调 upsertProvider）', async () => {
    vi.mocked(parseProviders).mockReturnValue(
      result([fp({ _sourceName: 'A' }), fp({ _sourceName: 'B' })]),
    )

    const prev = previewImport('pi')
    if (!('importId' in prev)) throw new Error('preview should succeed')
    const out = await applyImport(prev.importId, ['A']) // 只勾选 A

    if (!('result' in out)) throw new Error('apply should succeed')
    expect(upsertProvider).toHaveBeenCalledTimes(1)
    expect(vi.mocked(upsertProvider).mock.calls[0][0]).toBe('A')
    expect(out.result.imported).toHaveLength(1)
    expect(out.result.imported[0].id).toBe('A')
  })

  // ── B2：parseError 透出到 preview.parseError ───────────────────
  it('B2: parsed 含 parseError → previewImport 返回的 preview 含 parseError', async () => {
    vi.mocked(parseProviders).mockReturnValue({
      providers: [],
      parseError: 'cannot parse models.json: unexpected token',
    })

    const out = previewImport('pi')

    expect('importId' in out).toBe(true)
    if ('preview' in out) {
      expect(out.preview.parseError).toContain('cannot parse models.json')
    }
  })

  // ── B2b：parsed 含顶层 warnings → preview.warnings 透出 ─────────
  it('B2b: parsed 含顶层 warnings → previewImport 返回的 preview.warnings 透出', async () => {
    vi.mocked(parseProviders).mockReturnValue({
      providers: [fp({ _sourceName: 'A' })],
      warnings: ['provider X: protocol google-generative-ai not supported, skipped'],
    })

    const out = previewImport('pi')

    expect('importId' in out).toBe(true)
    if ('preview' in out) {
      expect(out.preview.warnings).toBeDefined()
      expect(out.preview.warnings!.some((w) => w.includes('google-generative-ai'))).toBe(true)
    }
  })

  // ── W4/W5：部分失败时缓存不被删除（failedCount > 0 仍可重试）─────
  it('W4/W5: applyImport 部分失败 → 缓存保留，再次 apply 同 importId 仍可取到', async () => {
    vi.mocked(parseProviders).mockReturnValue(
      result([fp({ _sourceName: 'A' }), fp({ _sourceName: 'B' })]),
    )
    // A 失败，B 成功
    vi.mocked(upsertProvider).mockImplementation((id: string) => {
      if (id === 'A') throw new Error('write failed for A')
      return {}
    })

    const prev = previewImport('pi')
    if (!('importId' in prev)) throw new Error('preview should succeed')

    // 第一次 apply：A 失败 → failedCount=1 → 缓存不删
    const first = await applyImport(prev.importId, ['A', 'B'])
    expect('result' in first).toBe(true)
    if ('result' in first) {
      expect(first.result.failedCount).toBe(1)
    }

    // 第二次 apply 同 importId：仍可取到（缓存未被删）→ 不应返回 PREVIEW_EXPIRED
    // 让 upsertProvider 在第二次都对 A 仍失败（保持 mock），B 现在冲突？不——
    // existingIds 此时含 B（已导入）。设为含 B，第二次 B 应 skipped，A 仍 failed。
    vi.mocked(getProviderNames).mockReturnValue(['B'])
    const second = await applyImport(prev.importId, ['A', 'B'])
    expect('result' in second).toBe(true) // 关键：不是 PREVIEW_EXPIRED，缓存仍在
  })

  // ── S6：selectedIds 含不存在 id → 返回 failed 条目 + failedCount 计数 ──
  it('S6: selectedIds 含 preview 中不存在的 id → 返回 failed 条目 reason=not found in preview', async () => {
    vi.mocked(parseProviders).mockReturnValue(result([fp({ _sourceName: 'A' })]))

    const prev = previewImport('pi')
    if (!('importId' in prev)) throw new Error('preview should succeed')

    const out = await applyImport(prev.importId, ['A', 'ghost'])
    if (!('result' in out)) throw new Error('apply should succeed')

    const byId = Object.fromEntries(out.result.imported.map((i) => [i.id, i]))
    expect(byId.A.status).toBe('imported')
    expect(byId.ghost.status).toBe('failed')
    expect(byId.ghost.reason).toContain('not found in preview')
    expect(out.result.failedCount).toBe(1)
  })

  // ── W1：applyImport 入参非法 → INVALID_REQUEST ─────────────────
  it('W1: applyImport importId 为空字符串 → INVALID_REQUEST', async () => {
    const out = await applyImport('', ['A'])
    expect('error' in out).toBe(true)
    if ('error' in out) {
      expect(out.error.code).toBe('INVALID_REQUEST')
      expect(out.error.message).toContain('importId')
    }
  })

  it('W1: applyImport importId 非字符串 → INVALID_REQUEST', async () => {
    const out = await applyImport(123 as unknown as string, ['A'])
    expect('error' in out).toBe(true)
    if ('error' in out) {
      expect(out.error.code).toBe('INVALID_REQUEST')
    }
  })

  it('W1: applyImport selectedIds 非数组 → INVALID_REQUEST', async () => {
    const out = await applyImport('some-id', 'not-an-array' as unknown as string[])
    expect('error' in out).toBe(true)
    if ('error' in out) {
      expect(out.error.code).toBe('INVALID_REQUEST')
      expect(out.error.message).toContain('selectedIds')
    }
  })

  it('W1: applyImport selectedIds 含非字符串元素 → INVALID_REQUEST', async () => {
    const out = await applyImport('some-id', ['A', 123] as unknown as string[])
    expect('error' in out).toBe(true)
    if ('error' in out) {
      expect(out.error.code).toBe('INVALID_REQUEST')
    }
  })

  // ── wave 4 import-credential-types：_credentialType/_envVarName → ProviderPreviewItem 映射（t6）──
  it('wave4-t6: previewImport 映射 _credentialType/_envVarName → ProviderPreviewItem + apiKeyExtracted computed', () => {
    vi.mocked(parseProviders).mockReturnValue(
      result([
        fp({ _sourceName: 'plain', _credentialType: 'plaintext' }),
        fp({ _sourceName: 'envp', _credentialType: 'env', _envVarName: 'MY_VAR', apiKey: '$MY_VAR' }),
        fp({ _sourceName: 'envb', _credentialType: 'env-bundle', _apiKeyExtracted: false, apiKey: undefined }),
        fp({ _sourceName: 'miss', _credentialType: 'missing', _apiKeyExtracted: false, apiKey: undefined }),
        fp({ _sourceName: 'oau', _credentialType: 'oauth', _apiKeyExtracted: false, apiKey: undefined }),
        fp({ _sourceName: 'cmd', _credentialType: 'command', apiKey: '!op read xxx' }),
      ]),
    )

    const out = previewImport('pi')
    if (!('preview' in out)) throw new Error('preview should succeed')
    const byId = Object.fromEntries(out.preview.providers.map((p) => [p.id, p]))

    // credentialType 逐态映射
    expect(byId.plain.credentialType).toBe('plaintext')
    expect(byId.envp.credentialType).toBe('env')
    expect(byId.envb.credentialType).toBe('env-bundle')
    expect(byId.miss.credentialType).toBe('missing')
    expect(byId.oau.credentialType).toBe('oauth')
    expect(byId.cmd.credentialType).toBe('command')

    // envVarName 仅 env 态有值
    expect(byId.envp.envVarName).toBe('MY_VAR')
    expect(byId.plain.envVarName).toBeUndefined()
    expect(byId.cmd.envVarName).toBeUndefined()

    // apiKeyExtracted computed（parser 已算好，importer 透传）：plaintext/env/command=true，missing/oauth/env-bundle=false
    expect(byId.plain.apiKeyExtracted).toBe(true)
    expect(byId.envp.apiKeyExtracted).toBe(true)
    expect(byId.cmd.apiKeyExtracted).toBe(true)
    expect(byId.miss.apiKeyExtracted).toBe(false)
    expect(byId.oau.apiKeyExtracted).toBe(false)
    expect(byId.envb.apiKeyExtracted).toBe(false) // 有凭据但 Phase 1 不支持落盘 → 跳过

    // 脱敏红线：apiKey 明文 / !command / $ENV 占位串都不进 preview 序列化
    const serialized = JSON.stringify(out)
    expect(serialized).not.toContain('sk-real-key-123')
    expect(serialized).not.toContain('!op read xxx')
    expect(serialized).not.toContain('$MY_VAR')
  })

  // ══ sa3 F1：孤儿凭据 → 内置模板匹配（B.3/B.4/B.6）══

  /** 构造孤儿凭据 fixture。apiKey 含明文（验证脱敏红线）。 */
  function fo(overrides: Partial<import('../provider-parser.js').ParsedOrphanCredential> = {}) {
    return {
      providerId: 'openai',
      credentialType: 'plaintext' as const,
      apiKey: 'sk-orphan-plain-456',
      warnings: [],
      ...overrides,
    }
  }

  it('sa3-i1: 孤儿凭据匹配内置模板 → preview 组 2 项（builtinTemplateMatched + modelCount + modelNames + 脱敏）', () => {
    vi.mocked(parseProviders).mockReturnValue({
      providers: [],
      orphanCredentials: [fo()],
    })

    const out = previewImport('pi')
    if (!('preview' in out)) throw new Error('preview should succeed')

    // 组 2 存在且字段完整
    expect(out.preview.orphanCredentials).toHaveLength(1)
    const item = out.preview.orphanCredentials![0]
    expect(item.providerId).toBe('openai')
    expect(item.name).toBe('OpenAI') // 内置模板 name
    expect(item.credentialType).toBe('plaintext')
    expect(item.builtinTemplateMatched).toBe(true)
    expect(item.modelCount).toBeGreaterThan(0) // 真实 builtin JSON：openai 38 个模型
    expect(item.modelNames!.length).toBeGreaterThan(0)
    expect(item.modelNames![0]).toBe('gpt-4') // 真实模板第一个 model id
    expect(item.apiKeyExtracted).toBe(true)

    // 脱敏红线（B.5）：孤儿凭据的明文 key 不进 preview 序列化
    const serialized = JSON.stringify(out)
    expect(serialized).not.toContain('sk-orphan-plain-456')
  })

  it('sa3-i2: 孤儿凭据匹配不到内置模板 → 不进组 2 + preview.warnings 含跳过提示', () => {
    vi.mocked(parseProviders).mockReturnValue({
      providers: [],
      orphanCredentials: [fo({ providerId: 'unknown-provider-foo' })],
    })

    const out = previewImport('pi')
    if (!('preview' in out)) throw new Error('preview should succeed')

    expect(out.preview.orphanCredentials).toBeUndefined() // 不进组 2
    expect(out.preview.warnings!.some((w) => w.includes('unknown-provider-foo') && w.includes('no built-in template match'))).toBe(true)
  })

  it('sa3-i3: 孤儿凭据 env 态 → 组 2 envVarName 透传 + apiKeyExtracted=true', () => {
    vi.mocked(parseProviders).mockReturnValue({
      providers: [],
      orphanCredentials: [fo({ credentialType: 'env', envVarName: 'OPENAI_API_KEY', apiKey: '$OPENAI_API_KEY' })],
    })

    const out = previewImport('pi')
    if (!('preview' in out)) throw new Error('preview should succeed')
    const item = out.preview.orphanCredentials![0]
    expect(item.credentialType).toBe('env')
    expect(item.envVarName).toBe('OPENAI_API_KEY')
    expect(item.apiKeyExtracted).toBe(true)
    // 脱敏：占位串 $OPENAI_API_KEY 不进序列化（envVarName 是去前缀的变量名）
    const serialized = JSON.stringify(out)
    expect(serialized).not.toContain('$OPENAI_API_KEY')
  })

  it('sa3-i4: 孤儿凭据 env-bundle/oauth 态 → apiKeyExtracted=false（有凭据但 Phase 1 不落盘）', async () => {
    vi.mocked(parseProviders).mockReturnValue({
      providers: [],
      orphanCredentials: [
        fo({ providerId: 'deepseek', credentialType: 'env-bundle', apiKey: undefined }),
        fo({ providerId: 'github-copilot', credentialType: 'oauth', apiKey: undefined }),
      ],
    })

    const out = previewImport('pi')
    if (!('preview' in out)) throw new Error('preview should succeed')
    const byId = Object.fromEntries(out.preview.orphanCredentials!.map((o) => [o.providerId, o]))
    expect(byId.deepseek.apiKeyExtracted).toBe(false)
    expect(byId['github-copilot'].apiKeyExtracted).toBe(false)
    expect(byId.deepseek.name).toBe('DeepSeek')
    expect(byId['github-copilot'].name).toBeDefined()
  })

  it('sa3-i5: applyImport 勾选孤儿凭据 → 用内置模板补全定义写 models.json（B4 铁律：含 name/api/baseUrl/apiKey，models 数组 undefined）', async () => {
    vi.mocked(parseProviders).mockReturnValue({
      providers: [],
      orphanCredentials: [fo({ providerId: 'openai', credentialType: 'plaintext', apiKey: 'sk-orphan-apply-789' })],
    })

    const prev = previewImport('pi')
    if (!('importId' in prev)) throw new Error('preview should succeed')
    const applyOut = await applyImport(prev.importId, ['openai'])

    expect('result' in applyOut).toBe(true)
    if (!('result' in applyOut)) return
    expect(applyOut.result.imported).toHaveLength(1)
    expect(applyOut.result.imported[0]).toMatchObject({ id: 'openai', status: 'imported' })

    // B4 铁律：只写 {name, api, baseUrl, apiKey}，不写 models 数组
    expect(upsertProvider).toHaveBeenCalledTimes(1)
    const [, config] = vi.mocked(upsertProvider).mock.calls[0]
    expect(config.name).toBe('OpenAI')
    expect(config.api).toBe('openai-responses')
    expect(config.baseUrl).toBe('https://api.openai.com/v1')
    expect(config.apiKey).toBe('sk-orphan-apply-789')
    expect(config.models).toBeUndefined() // B4：不复制 models，内置 model 由 pi catalog 自动加载
  })

  it('sa3-i6: applyImport 孤儿 env-bundle/oauth 态 → provider 定义照常导入但 apiKey 不写（与组 1 一致）', async () => {
    vi.mocked(parseProviders).mockReturnValue({
      providers: [],
      orphanCredentials: [
        fo({ providerId: 'deepseek', credentialType: 'env-bundle', apiKey: undefined }),
        fo({ providerId: 'github-copilot', credentialType: 'oauth', apiKey: undefined }),
      ],
    })

    const prev = previewImport('pi')
    if (!('importId' in prev)) throw new Error('preview should succeed')
    const applyOut = await applyImport(prev.importId, ['deepseek', 'github-copilot'])

    expect('result' in applyOut).toBe(true)
    const calls = vi.mocked(upsertProvider).mock.calls
    expect(calls).toHaveLength(2)
    const deepseekCfg = calls.find(([id]) => id === 'deepseek')![1]
    expect(deepseekCfg.name).toBe('DeepSeek')
    expect(deepseekCfg.apiKey).toBeUndefined() // env-bundle：Phase 1 不落盘 apiKey
    expect(deepseekCfg.models).toBeUndefined() // B4
    const copilotCfg = calls.find(([id]) => id === 'github-copilot')![1]
    expect(copilotCfg.apiKey).toBeUndefined() // oauth：不取 token 作 apiKey
    expect(copilotCfg.models).toBeUndefined()
  })

  it('sa3-i7: applyImport 未勾选的孤儿凭据不导入', async () => {
    vi.mocked(parseProviders).mockReturnValue({
      providers: [],
      orphanCredentials: [fo({ providerId: 'openai' }), fo({ providerId: 'anthropic' })],
    })

    const prev = previewImport('pi')
    if (!('importId' in prev)) throw new Error('preview should succeed')
    const applyOut = await applyImport(prev.importId, ['openai'])

    expect('result' in applyOut).toBe(true)
    expect(upsertProvider).toHaveBeenCalledTimes(1)
    expect(vi.mocked(upsertProvider).mock.calls[0][0]).toBe('openai')
  })

  it('sa3-i8: applyImport 孤儿凭据与 models.json 冲突（preview 后已存在）→ skipped + 不调 upsertProvider', async () => {
    vi.mocked(parseProviders).mockReturnValue({
      providers: [],
      orphanCredentials: [fo({ providerId: 'openai' })],
    })
    vi.mocked(getProviderNames).mockReturnValue(['openai'])

    const prev = previewImport('pi')
    if (!('importId' in prev)) throw new Error('preview should succeed')
    const applyOut = await applyImport(prev.importId, ['openai'])

    if (!('result' in applyOut)) throw new Error('apply should succeed')
    expect(applyOut.result.imported[0]).toMatchObject({ id: 'openai', status: 'skipped' })
    expect(upsertProvider).not.toHaveBeenCalled()
  })

  // ══ D1④ 防线载体接线：importer 主路径（applyProviderEntry 直调 upsertProvider）══
  //
  // 背景：importer 不经过 setProvider（直调 infra upsertProvider），防线必须落在写入点
  // ——两条 upsert 路径都在 upsert 前调 applyProviderWritePolicy(kind, source='import')。
  // 覆盖：catalog 源端 provider 级 api/baseUrl 剥除（不产生隐形网关）+ apiKey 不写 +
  // 空串转译生效 + 剥除后无实质字段不物化空壳。

  it('D1④-catalog: 主路径对 catalog 源端 provider 级 api/baseUrl 不落盘（source=import 剥除）+ apiKey 不写 models.json', async () => {
    vi.mocked(isCatalogProvider).mockReturnValue(true)
    vi.mocked(parseProviders).mockReturnValue(result([
      fp({
        _sourceName: 'opencode-go',
        name: 'OpenCode Go',
        api: 'anthropic-messages',
        baseUrl: 'https://frozen-artifact.example',
        apiKey: 'sk-cat-key',
        models: [{ id: 'm1', name: 'M1' }],
      }),
    ]))

    const prev = previewImport('pi')
    if (!('importId' in prev)) throw new Error('preview should succeed')
    // 不传 credentialWriter（catalog 无 auth.json 写入通道）→ 走主路径 upsert
    const applyOut = await applyImport(prev.importId, ['opencode-go'])

    if (!('result' in applyOut)) throw new Error('apply should succeed')
    expect(upsertProvider).toHaveBeenCalledTimes(1)
    const [, config] = vi.mocked(upsertProvider).mock.calls[0]
    // 源端 provider 级 api/baseUrl 是快照 artifact / 外部配置值，不是用户在 UI 设的网关
    expect(config).not.toHaveProperty('api')
    expect(config).not.toHaveProperty('baseUrl')
    // catalog 的 apiKey 只归 auth.json（无 credentialWriter 时宁丢不写错位）
    expect(config).not.toHaveProperty('apiKey')
    // 非托管字段与 override models 原样保留
    expect(config.name).toBe('OpenCode Go')
    expect(config.models).toEqual([{ id: 'm1', name: 'M1' }])
  })

  it('D1②: 主路径空串转译生效（provider 级 name/baseUrl/api + 模型级 name/api/baseUrl 不落盘）', async () => {
    vi.mocked(parseProviders).mockReturnValue(result([
      fp({
        _sourceName: 'A',
        name: '',
        api: '   ',
        baseUrl: '',
        apiKey: 'sk-A',
        models: [{ id: 'm1', name: '', api: '', baseUrl: '  ' }],
      }),
    ]))

    const prev = previewImport('pi')
    if (!('importId' in prev)) throw new Error('preview should succeed')
    const applyOut = await applyImport(prev.importId, ['A'])

    if (!('result' in applyOut)) throw new Error('apply should succeed')
    const [, config] = vi.mocked(upsertProvider).mock.calls[0]
    expect(config).not.toHaveProperty('name')
    expect(config).not.toHaveProperty('api')
    expect(config).not.toHaveProperty('baseUrl')
    // 空串（含纯空白）在落盘前被剥除——不写空串键即不会毒化整个 models.json
    expect(config.models).toEqual([{ id: 'm1' }])
    expect(JSON.stringify(config)).not.toMatch(/:\s*""/)
  })

  it('D1③: 主路径 catalog 条目剥除后无实质字段 → 不物化空壳（upsert 不被调用 + 条目 failed）', async () => {
    vi.mocked(isCatalogProvider).mockReturnValue(true)
    vi.mocked(parseProviders).mockReturnValue(result([
      fp({
        _sourceName: 'opencode-go',
        api: 'anthropic-messages',
        baseUrl: 'https://frozen-artifact.example',
        apiKey: 'sk-cat-key',
        models: undefined, // 无 override models → 剥除 provider 级字段后八字段全缺
      }),
    ]))

    const prev = previewImport('pi')
    if (!('importId' in prev)) throw new Error('preview should succeed')
    const applyOut = await applyImport(prev.importId, ['opencode-go'])

    if (!('result' in applyOut)) throw new Error('apply should succeed')
    expect(upsertProvider).not.toHaveBeenCalled()
    expect(applyOut.result.imported[0]).toMatchObject({ id: 'opencode-go', status: 'failed' })
    expect(applyOut.result.imported[0].reason).toContain('credential writer')
    expect(applyOut.result.failedCount).toBe(1)
  })

  // ══ W4 补充：分支覆盖缺口锚定 ══

  // 锚定 apply 阶段孤儿凭据 `if (!tpl)` 分支（sa3-i2 只覆盖了 preview 阶段的模板匹配失败）：
  // 匹配不到内置模板 → failed 条目 reason='no built-in template match' + failedCount 计数
  // + 不调 upsertProvider + 部分失败缓存保留（可重试）。
  it('W4-a: applyImport 勾选匹配不到内置模板的孤儿凭据 → failed reason=no built-in template match, failedCount=1', async () => {
    vi.mocked(parseProviders).mockReturnValue({
      providers: [],
      orphanCredentials: [fo({ providerId: 'unknown-provider-foo' })],
    })

    const prev = previewImport('pi')
    if (!('importId' in prev)) throw new Error('preview should succeed')
    const applyOut = await applyImport(prev.importId, ['unknown-provider-foo'])

    if (!('result' in applyOut)) throw new Error('apply should succeed')
    expect(applyOut.result.imported).toHaveLength(1)
    expect(applyOut.result.imported[0]).toMatchObject({
      id: 'unknown-provider-foo',
      status: 'failed',
      reason: 'no built-in template match',
    })
    expect(applyOut.result.failedCount).toBe(1)
    expect(upsertProvider).not.toHaveBeenCalled()

    // W4/W5：failedCount>0 → 缓存不删，同 importId 再次 apply 仍可取到（非 PREVIEW_EXPIRED）
    const second = await applyImport(prev.importId, ['unknown-provider-foo'])
    expect('result' in second).toBe(true)
  })

  // 锚定 reason 三元表达式的另一侧：upsertProvider 抛非 Error 值（如字符串）→ reason 用 String(e) 原文。
  it('W4-b: upsertProvider 抛非 Error 值 → reason 为 String(e) 原文', async () => {
    vi.mocked(parseProviders).mockReturnValue(result([fp({ _sourceName: 'A' })]))
    vi.mocked(upsertProvider).mockImplementation(() => {
      throw 'raw string failure'
    })

    const prev = previewImport('pi')
    if (!('importId' in prev)) throw new Error('preview should succeed')
    const applyOut = await applyImport(prev.importId, ['A'])

    if (!('result' in applyOut)) throw new Error('apply should succeed')
    expect(applyOut.result.imported).toHaveLength(1)
    expect(applyOut.result.imported[0]).toMatchObject({
      id: 'A',
      status: 'failed',
      reason: 'raw string failure',
    })
    expect(applyOut.result.failedCount).toBe(1)
  })
})

// ══ coding-plan 额度显示自动开启（导入即默认同意）════════════════════
// 覆盖 matchAutoEnablePreset 四条件（plaintext / preset 命中 / auth 含 api-key /
// 非 requiresWorkspace）× 组1（custom 定义）组2（孤儿凭据模板）× skipped 不动 ×
// 未注入跳过 × merge 语义 × best-effort（写失败不阻断导入）。

/** 构造 extras 写通道 fake：modify 记录 (providerId, fn)，fn 默认作用于给定 current 并返回产出。 */
function fakeExtrasStore(current: ProviderExtras | undefined = undefined) {
  const modify = vi.fn(async (
    _providerId: string,
    fn: (c: ProviderExtras | undefined) => ProviderExtras,
  ) => fn(current))
  return { modify }
}

describe('provider-importer · coding-plan 额度显示自动开启（导入即默认同意）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    _resetCacheForTest()
    vi.mocked(parseProviders).mockReturnValue(null)
    vi.mocked(getProviderNames).mockReturnValue([])
    vi.mocked(upsertProvider).mockImplementation(() => ({}))
    vi.mocked(isCatalogProvider).mockReturnValue(false)
  })

  it('组1 custom：baseUrl 命中 kimi preset（api-key 类）+ 明文 key → 写 quota { enabled:true, fetcher }', async () => {
    vi.mocked(parseProviders).mockReturnValue(result([
      fp({ _sourceName: 'kimi-main', baseUrl: 'https://api.kimi.com/coding', apiKey: 'sk-kimi-plain' }),
    ]))
    const store = fakeExtrasStore()

    const prev = previewImport('pi')
    if (!('importId' in prev)) throw new Error('preview should succeed')
    const applyOut = await applyImport(prev.importId, ['kimi-main'], undefined, store)

    if (!('result' in applyOut)) throw new Error('apply should succeed')
    expect(applyOut.result.imported[0]).toMatchObject({ id: 'kimi-main', status: 'imported' })
    expect(store.modify).toHaveBeenCalledTimes(1)
    expect(store.modify.mock.calls[0][0]).toBe('kimi-main')
    // fetcher 必须显式落盘：catalog provider 无 models.json 条目时 fetch 侧
    // baseUrl/name 自动匹配读不到定义（与手动配置路径行为一致）
    const written = store.modify.mock.calls[0][1](undefined)
    expect(written.quota).toEqual({ enabled: true, fetcher: 'kimi-coding' })
  })

  it('组1 custom：仅 name 命中（baseUrl 非标准网关）也自动开启', async () => {
    vi.mocked(parseProviders).mockReturnValue(result([
      fp({ _sourceName: 'glm-main', name: 'my glm service', baseUrl: 'https://gateway.example.com', apiKey: 'sk-plain' }),
    ]))
    const store = fakeExtrasStore()

    const prev = previewImport('pi')
    if (!('importId' in prev)) throw new Error('preview should succeed')
    await applyImport(prev.importId, ['glm-main'], undefined, store)

    expect(store.modify).toHaveBeenCalledTimes(1)
    const written = store.modify.mock.calls[0][1](undefined)
    expect(written.quota!.fetcher).toBe('zhipu')
  })

  it('组1 custom：cookie 类 preset（mimo）不自动开启——导入不提取 cookie，开了也是 no-credential', async () => {
    vi.mocked(parseProviders).mockReturnValue(result([
      fp({ _sourceName: 'mimo-main', baseUrl: 'https://api.xiaomimimo.com/v1', apiKey: 'sk-plain' }),
    ]))
    const store = fakeExtrasStore()

    const prev = previewImport('pi')
    if (!('importId' in prev)) throw new Error('preview should succeed')
    await applyImport(prev.importId, ['mimo-main'], undefined, store)

    expect(store.modify).not.toHaveBeenCalled()
  })

  it('组1 custom：preset 未命中（无 baseUrl/name 关联）不写 extras', async () => {
    vi.mocked(parseProviders).mockReturnValue(result([fp()])) // baseUrl example.com，name p1
    const store = fakeExtrasStore()

    const prev = previewImport('pi')
    if (!('importId' in prev)) throw new Error('preview should succeed')
    await applyImport(prev.importId, ['p1'], undefined, store)

    expect(store.modify).not.toHaveBeenCalled()
  })

  it.each(['env', 'command'] as const)('组1 custom：%s 占位凭证不自动开启（quota 凭证链不解占位，开了只会查询失败）', async (credentialType) => {
    vi.mocked(parseProviders).mockReturnValue(result([
      fp({
        _sourceName: 'kimi-ph',
        baseUrl: 'https://api.kimi.com/coding',
        _credentialType: credentialType,
        _apiKeyExtracted: true,
        apiKey: credentialType === 'env' ? '$KIMI_KEY' : '!op read key',
      }),
    ]))
    const store = fakeExtrasStore()

    const prev = previewImport('pi')
    if (!('importId' in prev)) throw new Error('preview should succeed')
    const applyOut = await applyImport(prev.importId, ['kimi-ph'], undefined, store)

    // provider 本身照常导入（现状不变），只是不写 quota extras
    if (!('result' in applyOut)) throw new Error('apply should succeed')
    expect(applyOut.result.imported[0]).toMatchObject({ status: 'imported' })
    expect(store.modify).not.toHaveBeenCalled()
  })

  it('skipped（duplicate）不自动开启——不覆盖用户对既存 provider 的配置', async () => {
    vi.mocked(getProviderNames).mockReturnValue(['kimi-main'])
    vi.mocked(parseProviders).mockReturnValue(result([
      fp({ _sourceName: 'kimi-main', baseUrl: 'https://api.kimi.com/coding', apiKey: 'sk-plain' }),
    ]))
    const store = fakeExtrasStore()

    const prev = previewImport('pi')
    if (!('importId' in prev)) throw new Error('preview should succeed')
    const applyOut = await applyImport(prev.importId, ['kimi-main'], undefined, store)

    if (!('result' in applyOut)) throw new Error('apply should succeed')
    expect(applyOut.result.imported[0]).toMatchObject({ status: 'skipped' })
    expect(store.modify).not.toHaveBeenCalled()
  })

  it('组2 孤儿凭据：kimi-coding / zai-coding-cn 模板命中 api-key 类 preset → 自动开启；xiaomi（cookie 类）不开启', async () => {
    vi.mocked(parseProviders).mockReturnValue({
      providers: [],
      orphanCredentials: [
        { providerId: 'kimi-coding', credentialType: 'plaintext', apiKey: 'sk-o1', warnings: [] },
        { providerId: 'zai-coding-cn', credentialType: 'plaintext', apiKey: 'sk-o2', warnings: [] },
        { providerId: 'xiaomi', credentialType: 'plaintext', apiKey: 'sk-o3', warnings: [] },
      ],
    })
    const store = fakeExtrasStore()

    const prev = previewImport('pi')
    if (!('importId' in prev)) throw new Error('preview should succeed')
    await applyImport(prev.importId, ['kimi-coding', 'zai-coding-cn', 'xiaomi'], undefined, store)

    const calls = store.modify.mock.calls
    expect(calls).toHaveLength(2)
    const byId = new Map(calls.map(([pid, fn]) => [pid, (fn as (c: unknown) => unknown)(undefined)]))
    // kimi-coding：模板 baseUrl 'api.kimi.com' 命中 kimi preset
    expect(byId.get('kimi-coding')).toEqual({ quota: { enabled: true, fetcher: 'kimi-coding' } })
    // zai-coding-cn：模板 baseUrl 'open.bigmodel.cn' 命中 zhipu preset
    expect(byId.get('zai-coding-cn')).toEqual({ quota: { enabled: true, fetcher: 'zhipu' } })
    expect(byId.has('xiaomi')).toBe(false)
  })

  it('merge 语义：保留既有 extras 字段域（authMethod）与既有 quota 字段，只写 enabled + fetcher', async () => {
    vi.mocked(parseProviders).mockReturnValue(result([
      fp({ _sourceName: 'kimi-main', baseUrl: 'https://api.kimi.com/coding', apiKey: 'sk-plain' }),
    ]))
    const store = fakeExtrasStore()

    const prev = previewImport('pi')
    if (!('importId' in prev)) throw new Error('preview should succeed')
    await applyImport(prev.importId, ['kimi-main'], undefined, store)

    expect(store.modify).toHaveBeenCalledTimes(1)
    const written = store.modify.mock.calls[0][1]({ authMethod: 'api_key', quota: { enabled: false, credentialSource: 'provider' } })
    expect(written.authMethod).toBe('api_key')
    expect(written.quota).toEqual({ enabled: true, fetcher: 'kimi-coding', credentialSource: 'provider' })
  })

  it('未注入 store（第 4 参缺省）→ 跳过写入，导入主语义不受影响', async () => {
    vi.mocked(parseProviders).mockReturnValue(result([
      fp({ _sourceName: 'kimi-main', baseUrl: 'https://api.kimi.com/coding', apiKey: 'sk-plain' }),
    ]))

    const prev = previewImport('pi')
    if (!('importId' in prev)) throw new Error('preview should succeed')
    const applyOut = await applyImport(prev.importId, ['kimi-main'])

    if (!('result' in applyOut)) throw new Error('apply should succeed')
    expect(applyOut.result.imported[0]).toMatchObject({ status: 'imported' })
  })

  it('best-effort：extras 写失败不阻断导入（provider 已落盘，额度可手动配置）', async () => {
    vi.mocked(parseProviders).mockReturnValue(result([
      fp({ _sourceName: 'kimi-main', baseUrl: 'https://api.kimi.com/coding', apiKey: 'sk-plain' }),
    ]))
    const store = { modify: vi.fn(async () => { throw new Error('disk full') }) }

    const prev = previewImport('pi')
    if (!('importId' in prev)) throw new Error('preview should succeed')
    const applyOut = await applyImport(prev.importId, ['kimi-main'], undefined, store)

    if (!('result' in applyOut)) throw new Error('apply should succeed')
    expect(applyOut.result.imported[0]).toMatchObject({ status: 'imported' })
    expect(applyOut.result.failedCount).toBe(0)
  })
})
