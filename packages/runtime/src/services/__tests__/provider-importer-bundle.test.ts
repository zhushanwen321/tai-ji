import * as fsUtils from '../../utils/fs-utils.js';
import { ensureProviderInWhitelist, getProviderNames, upsertProvider } from '../../infra/pi/pi-provider-store.js';
import type { CredentialWriter } from '../auth/auth-storage.js';
import { ConfigService } from '../config-service.js';
import { _resetCacheForTest, createPreview } from '../migration/preview-cache.js';
import { applyImport } from '../migration/provider-importer.js';
import { ParsedOrphanCredential, type ParsedProvider } from '../migration/provider-parser.js';
import type { IConfigStore } from '../ports/config.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。

// ======================================================================
// ← config-worktree.test.ts
// ======================================================================

// mock atomicWrite 避免真实磁盘写入
vi.mock('../../utils/fs-utils.js', () => ({
  atomicWrite: vi.fn(),
}))


// mock fs 模块，控制 existsSync / readFileSync / mkdirSync
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
  return {
    ...actual,
    existsSync: vi.fn(() => false),
    readFileSync: vi.fn(() => '{}'),
    mkdirSync: vi.fn(),
    readdirSync: vi.fn(() => []),
    statSync: vi.fn(() => ({ isDirectory: () => false })),
  }
})


function createMockConfigStore(overrides: Partial<IConfigStore> = {}): IConfigStore {
  return {
    getDefaultModel: vi.fn(() => null),
    setDefaultModel: vi.fn(),
    readModels: vi.fn(() => ({ providers: {} })),
    getProviderConfig: vi.fn(() => undefined),
    upsertProvider: vi.fn(() => ({})),
    removeProvider: vi.fn(() => ({ removed: false })),
    applyTypeTranslation: vi.fn((t: string) => t),
    addSkillPath: vi.fn(),
    removeSkillPath: vi.fn(),
    setSkillPaths: vi.fn(),
    getSkillPaths: vi.fn(() => []),
    getSkillPathScopes: vi.fn(() => ({ projectPaths: [], globalPaths: [] })),
    getAgentDirs: vi.fn(() => []),
    getAgentPathScopes: vi.fn(() => ({ projectPaths: [], globalPaths: [] })),
    setAgentDirs: vi.fn(),
    getExtensionDirs: vi.fn(() => []),
    getExtensionPathScopes: vi.fn(() => ({ projectPaths: [], globalPaths: [] })),
    setExtensionDirs: vi.fn(),
    listAgentFiles: vi.fn(() => []),
    writeAgentFile: vi.fn(),
    deleteAgentFile: vi.fn(),
    migrateSettingsSkillsToDiscovery: vi.fn(),
    getPiAgentDir: vi.fn(() => '/tmp/pi-agent'),
    getConfigDir: vi.fn(() => '/tmp/test-config'),
    ...overrides,
  } as IConfigStore
}

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('config-worktree', () => {
describe('ConfigService worktree config', () => {
  let configService: ConfigService
  let mockStore: IConfigStore
  let fs: typeof import('node:fs')
  let writtenConfig: Record<string, unknown> | undefined

  beforeEach(async () => {
    vi.clearAllMocks()
    fs = await import('node:fs')
    writtenConfig = undefined
    // atomicWrite 捕获写入内容
    vi.mocked(fsUtils.atomicWrite).mockImplementation((_path, data) => {
      writtenConfig = JSON.parse(data as string)
    })
    // existsSync 默认返回 true（config.json 存在）
    vi.mocked(fs.existsSync).mockReturnValue(true)
    // readFileSync 默认返回空对象
    vi.mocked(fs.readFileSync).mockReturnValue('{}')
    mockStore = createMockConfigStore()
    configService = new ConfigService('/tmp/project', mockStore)
  })

  describe('getWorktreeRootDir', () => {
    it('返回默认值 ~/worktrees（config.json 无该字段）', () => {
      vi.mocked(fs.readFileSync).mockReturnValue('{}')
      expect(configService.getWorktreeRootDir()).toBe('~/worktrees')
    })

    it('返回 config.json 中的 worktreeRootDir 值', () => {
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ worktreeRootDir: '/custom/path' }))
      expect(configService.getWorktreeRootDir()).toBe('/custom/path')
    })

    it('worktreeRootDir 非 string 时返回默认值', () => {
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ worktreeRootDir: 123 }))
      expect(configService.getWorktreeRootDir()).toBe('~/worktrees')
    })
  })

  describe('setWorktreeRootDir', () => {
    it('写入 worktreeRootDir 到 config.json', () => {
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ toolPermissions: { bash: 'allow' } }))
      configService.setWorktreeRootDir('/new/worktree/dir')
      expect(writtenConfig).toEqual({
        toolPermissions: { bash: 'allow' },
        worktreeRootDir: '/new/worktree/dir',
      })
    })

    it('不覆盖已有的其他字段', () => {
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ worktreeRootDir: '/old', setupScript: 'my-script.sh' }))
      configService.setWorktreeRootDir('/updated')
      expect(writtenConfig).toEqual({
        worktreeRootDir: '/updated',
        setupScript: 'my-script.sh',
      })
    })
  })

  describe('getSetupScript', () => {
    it('返回默认值 custom-hooks/setup-worktree.sh（config.json 无该字段）', () => {
      vi.mocked(fs.readFileSync).mockReturnValue('{}')
      expect(configService.getSetupScript()).toBe('custom-hooks/setup-worktree.sh')
    })

    it('返回 config.json 中的 setupScript 值', () => {
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ setupScript: 'my-setup.sh' }))
      expect(configService.getSetupScript()).toBe('my-setup.sh')
    })

    it('setupScript 非 string 时返回默认值', () => {
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ setupScript: null }))
      expect(configService.getSetupScript()).toBe('custom-hooks/setup-worktree.sh')
    })
  })

  describe('setSetupScript', () => {
    it('写入 setupScript 到 config.json', () => {
      vi.mocked(fs.readFileSync).mockReturnValue('{}')
      configService.setSetupScript('custom-setup.sh')
      expect(writtenConfig).toEqual({ setupScript: 'custom-setup.sh' })
    })

    it('不覆盖已有的其他字段', () => {
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ worktreeRootDir: '/dir', toolPermissions: { bash: 'allow' } }))
      configService.setSetupScript('new-script.sh')
      expect(writtenConfig).toEqual({
        worktreeRootDir: '/dir',
        toolPermissions: { bash: 'allow' },
        setupScript: 'new-script.sh',
      })
    })
  })

  describe('setBareSetupScript', () => {
    it('写入 bareSetupScript 到 config.json（合法路径不受校验拦截）', () => {
      vi.mocked(fs.readFileSync).mockReturnValue('{}')
      configService.setBareSetupScript('custom-hooks/setup-bare.sh')
      expect(writtenConfig).toEqual({ bareSetupScript: 'custom-hooks/setup-bare.sh' })
    })

    it('含 .. 的路径拒绝写入（与 setSetupScript 同款校验，A9），且不落盘', () => {
      vi.mocked(fs.readFileSync).mockReturnValue('{}')
      expect(() => configService.setBareSetupScript('../evil/setup.sh')).toThrow('bareSetupScript path cannot contain ..')
      expect(writtenConfig).toBeUndefined()
    })
  })
})
});


// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。

// ======================================================================
// ← src/services/__tests__/provider-importer-credential-writer.test.ts
// ======================================================================

// mock pi-provider-store：importer 从此 import upsertProvider/getProviderNames/ensureProviderInWhitelist
vi.mock('../../infra/pi/pi-provider-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../infra/pi/pi-provider-store.js')>()
  return {
    ...actual,
    getProviderNames: vi.fn(() => []),
    upsertProvider: vi.fn(() => ({})),
    ensureProviderInWhitelist: vi.fn(),
  }
})


// 确保 mock 生效后 import（拿到 mocked 版本）
const mockedGetProviderNames = vi.mocked(getProviderNames)


const mockedUpsertProvider = vi.mocked(upsertProvider)


/** 构造 catalog provider 的 ParsedProvider（带可选 apiKey 明文——apply 时经 credentialWriter 落 auth.json）。 */
function makeCatalogParsed(sourceName: string, apiKey?: string): ParsedProvider {
  return {
    _sourceName: sourceName,
    _apiKeyExtracted: apiKey !== undefined && apiKey !== '',
    _credentialType: apiKey !== undefined && apiKey !== '' ? 'plaintext' : 'missing',
    _envVarName: undefined,
    _warnings: [],
    name: sourceName,
    ...(apiKey !== undefined ? { apiKey } : {}),
    models: [{ id: 'm1', name: 'M1' }],
  } as unknown as ParsedProvider
}


/** 构造孤儿凭据（auth.json 有、models.json 无定义，apply 时组 2 处理）。 */
function makeOrphan(providerId: string, apiKey: string): ParsedOrphanCredential {
  return {
    providerId,
    credentialType: 'plaintext',
    apiKey,
    warnings: [],
  }
}


/** credentialWriter stub：形态对齐 auth-storage.ts 的 CredentialWriter 接口。 */
function makeCredentialWriter(): CredentialWriter & { saveCredential: ReturnType<typeof vi.fn> } {
  return { saveCredential: vi.fn(async () => undefined) }
}


// ======================================================================
// ← src/services/__tests__/provider-importer-whitelist.test.ts
// ======================================================================

// mock pi-provider-store：importer 从此 import upsertProvider/getProviderNames/ensureProviderInWhitelist
vi.mock('../../infra/pi/pi-provider-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../infra/pi/pi-provider-store.js')>()
  return {
    ...actual,
    getProviderNames: vi.fn(() => []),
    upsertProvider: vi.fn(() => ({})),
    ensureProviderInWhitelist: vi.fn(),
  }
})


// 确保 mock 生效后 import（拿到 mocked 版本）
const mockedGetProviderNames_m2 = vi.mocked(getProviderNames)


const mockedUpsertProvider_m2 = vi.mocked(upsertProvider)


const mockedEnsure = vi.mocked(ensureProviderInWhitelist)


/** 构造最小 ParsedProvider（custom，非 catalog，无 authStorage 时走 models.json upsert 路径）。 */
function makeParsed(sourceName: string): ParsedProvider {
  return {
    _sourceName: sourceName,
    _apiKeyExtracted: false,
    _credentialType: 'missing',
    _envVarName: undefined,
    _warnings: undefined,
    name: sourceName,
    models: [{ id: 'm1', name: 'M1' }],
  } as unknown as ParsedProvider
}

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('provider-importer-bundle', () => {
// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('provider-importer-credential-writer', () => {
beforeEach(() => {
  vi.clearAllMocks()
  _resetCacheForTest()
  mockedGetProviderNames.mockReturnValue([])
  mockedUpsertProvider.mockReturnValue({})
})
afterEach(() => {
  _resetCacheForTest()
})
describe('组 1：catalog provider 的秘钥经 credentialWriter 落 auth.json（不写 models.json）', () => {
  it('catalog provider 带 apiKey → saveCredential(_sourceName, { type:"api_key", key }) + imported + 不写 models.json', async () => {
    const writer = makeCredentialWriter()
    // 'openai' 是 builtin-providers.json 真实 catalog id（isCatalogProvider 走真实判定）
    const importId = createPreview('pi', [makeCatalogParsed('openai', 'sk-openai-foo')])
    const out = await applyImport(importId, ['openai'], writer)
    if (!('result' in out)) throw new Error('apply should succeed')

    // 写凭据经窄接口，参数序 = (providerId, credential)，凭据形状 = { type:'api_key', key }
    expect(writer.saveCredential).toHaveBeenCalledTimes(1)
    expect(writer.saveCredential).toHaveBeenCalledWith('openai', { type: 'api_key', key: 'sk-openai-foo' })
    // catalog 分路不建 models.json 条目（定义归 catalog，秘钥归 auth.json）
    expect(mockedUpsertProvider).not.toHaveBeenCalled()
    expect(out.result.imported).toEqual([
      { id: 'openai', name: 'openai', status: 'imported' },
    ])
    expect(out.result.failedCount).toBe(0)
  })

  it('catalog provider 无 apiKey → 不调 saveCredential，仍 imported（catalog 定义即可用）', async () => {
    const writer = makeCredentialWriter()
    const importId = createPreview('pi', [makeCatalogParsed('anthropic', undefined)])
    const out = await applyImport(importId, ['anthropic'], writer)
    if (!('result' in out)) throw new Error('apply should succeed')

    expect(writer.saveCredential).not.toHaveBeenCalled()
    expect(mockedUpsertProvider).not.toHaveBeenCalled()
    expect(out.result.imported).toEqual([
      { id: 'anthropic', name: 'anthropic', status: 'imported' },
    ])
  })

  it('saveCredential reject → 条目 failed 透传错误消息 + failedCount=1', async () => {
    const writer = makeCredentialWriter()
    writer.saveCredential.mockRejectedValue(new Error('auth.json locked'))
    const importId = createPreview('pi', [makeCatalogParsed('openai', 'sk-openai-foo')])
    const out = await applyImport(importId, ['openai'], writer)
    if (!('result' in out)) throw new Error('apply should succeed')

    expect(out.result.imported).toEqual([
      { id: 'openai', name: 'openai', status: 'failed', reason: 'auth.json locked' },
    ])
    expect(out.result.failedCount).toBe(1)
  })
})
describe('组 2：孤儿凭据（catalog providerId）经 credentialWriter 落 auth.json', () => {
  it('孤儿凭据带 apiKey → saveCredential(providerId, { type:"api_key", key }) + imported + 不写 models.json 模板', async () => {
    const writer = makeCredentialWriter()
    const importId = createPreview('pi', [], [makeOrphan('anthropic', 'sk-ant-orphan-key')])
    const out = await applyImport(importId, ['anthropic'], writer)
    if (!('result' in out)) throw new Error('apply should succeed')

    expect(writer.saveCredential).toHaveBeenCalledTimes(1)
    expect(writer.saveCredential).toHaveBeenCalledWith('anthropic', { type: 'api_key', key: 'sk-ant-orphan-key' })
    // catalog 孤儿凭据不落 models.json 模板（B4：定义归 catalog）
    expect(mockedUpsertProvider).not.toHaveBeenCalled()
    expect(out.result.imported).toEqual([
      { id: 'anthropic', name: 'anthropic', status: 'imported' },
    ])
    expect(out.result.failedCount).toBe(0)
  })

  it('组 1 catalog provider 未注入 credentialWriter → 源端 provider 级 api/baseUrl/apiKey 不落 models.json（D1④）', async () => {
    // 设计 D1④：catalog 定义来自 pi 内置 catalog、凭据只允许落 auth.json——无写入通道时
    // 不再有「写模板进 models.json」的降级。防线载体以 source='import' + kind='catalog'
    // 剥除源端 provider 级 api/baseUrl（不产生隐形网关），apiKey 亦不写（宁丢不写错位）。
    const importId = createPreview('pi', [{
      _sourceName: 'openai',
      _apiKeyExtracted: true,
      _credentialType: 'plaintext',
      _warnings: [],
      name: 'OpenAI',
      api: 'openai-responses',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-openai-foo',
      models: [{ id: 'm1' }],
    } as unknown as ParsedProvider])
    const out = await applyImport(importId, ['openai'])
    if (!('result' in out)) throw new Error('apply should succeed')

    expect(mockedUpsertProvider).toHaveBeenCalledTimes(1)
    const [, config] = mockedUpsertProvider.mock.calls[0]
    expect(config).not.toHaveProperty('api')
    expect(config).not.toHaveProperty('baseUrl')
    expect(config).not.toHaveProperty('apiKey')
    // override models 仍原样落盘（用户侧模型覆盖是合法内容）
    expect(config.models).toEqual([{ id: 'm1' }])
    expect(out.result.imported[0]).toMatchObject({ id: 'openai', status: 'imported' })
  })

  it('catalog 孤儿凭据未注入 credentialWriter → 条目 failed，不写 models.json 模板/apiKey（D1④）', async () => {
    const importId = createPreview('pi', [], [makeOrphan('anthropic', 'sk-ant-orphan-key')])
    const out = await applyImport(importId, ['anthropic'])
    if (!('result' in out)) throw new Error('apply should succeed')

    // 不再有「写模板进 models.json」的降级：tpl.api/tpl.baseUrl（快照 artifact）与
    // config.apiKey（M5-01 同族错位写）都不落盘；imported 语义只对真实落盘成立，故报 failed
    // 并引导用户经 UI 配置凭据。
    expect(mockedUpsertProvider).not.toHaveBeenCalled()
    const item = out.result.imported[0]
    expect(item).toMatchObject({ id: 'anthropic', status: 'failed' })
    expect(item.reason).toContain('credential writer')
    expect(out.result.failedCount).toBe(1)
  })
})
});
// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('provider-importer-whitelist', () => {
beforeEach(() => {
  vi.clearAllMocks()
  _resetCacheForTest()
  mockedGetProviderNames_m2.mockReturnValue([])
  mockedUpsertProvider_m2.mockReturnValue({})
})
afterEach(() => {
  _resetCacheForTest()
})
describe('TC5: importer applyImport 新建 provider 白名单检查（边界1 / C2）', () => {
  it('导入新 provider 后 → ensureProviderInWhitelist 对每个 imported 调用', async () => {
    const importId = createPreview('pi', [makeParsed('my-custom'), makeParsed('another')])
    const out = await applyImport(importId, ['my-custom', 'another'])
    expect('result' in out).toBe(true)
    if (!('result' in out)) throw new Error('apply should succeed')
    // 两个新 provider 都 imported
    expect(out.result.imported.filter((i) => i.status === 'imported')).toHaveLength(2)
    // ensureProviderInWhitelist 对每个 imported id 调用
    expect(mockedEnsure).toHaveBeenCalledWith('my-custom')
    expect(mockedEnsure).toHaveBeenCalledWith('another')
    expect(mockedEnsure).toHaveBeenCalledTimes(2)
  })

  it('skipped（duplicate-id）的 provider 不调 ensureProviderInWhitelist', async () => {
    // models.json 已有 'existing-one' → conflict skipped
    mockedGetProviderNames_m2.mockReturnValue(['existing-one'])
    const importId = createPreview('pi', [makeParsed('existing-one'), makeParsed('new-one')])
    const out = await applyImport(importId, ['existing-one', 'new-one'])
    if (!('result' in out)) throw new Error('apply should succeed')
    // existing-one skipped，new-one imported
    expect(mockedEnsure).toHaveBeenCalledTimes(1)
    expect(mockedEnsure).toHaveBeenCalledWith('new-one')
    expect(mockedEnsure).not.toHaveBeenCalledWith('existing-one')
  })

  it('未勾选（selectedIds 不含）的 provider 不导入也不检查', async () => {
    const importId = createPreview('pi', [makeParsed('a'), makeParsed('b'), makeParsed('c')])
    const out = await applyImport(importId, ['a', 'c'])
    if (!('result' in out)) throw new Error('apply should succeed')
    expect(mockedEnsure).toHaveBeenCalledWith('a')
    expect(mockedEnsure).toHaveBeenCalledWith('c')
    expect(mockedEnsure).not.toHaveBeenCalledWith('b')
    expect(mockedEnsure).toHaveBeenCalledTimes(2)
  })

  it('ensureProviderInWhitelist 在 upsertProvider 之后调用（先建 provider 再检查）', async () => {
    const order: string[] = []
    mockedUpsertProvider_m2.mockImplementation(() => { order.push('upsert'); return {} })
    mockedEnsure.mockImplementation(() => { order.push('ensure') })
    const importId = createPreview('pi', [makeParsed('x')])
    await applyImport(importId, ['x'])
    // upsert 先（建 provider），ensure 后（加白名单）——检查依赖 provider 已建立
    expect(order).toEqual(['upsert', 'ensure'])
  })
})
/**
 * RT-5#2（code-harden 审计批次 2 ⑤ / M15）：导入路径复用 settings 侧 B-4b 模型字段白名单。
 *
 * 修复前：applyModelsWritePolicy 只做空串转译（translateModelSchemaFields），外部 models
 * 的畸形 cost 裸透传直写 models.json——pi 0.84.4 ModelConfig.load 对 schema 违规**整表拒载**
 * （node_modules dist core/model-config.js：validateModelsConfig.Check 失败 → 空 providers Map），
 * 一条畸形模型毒死全部自定义 provider。
 * 修复后：导入路径经 applyValidatedModelFields/sanitizeModelCost 同一套校验，非法值由
 * applyProviderEntry 的 per-entry catch 折叠为该条 status:'failed' + reason，不落盘。
 */
describe('RT-5#2: 导入路径模型字段白名单（非法 cost → 该条 failed，不落盘）', () => {
  /** 带模型 cost 的 ParsedProvider fixture（覆盖 makeParsed 的 models）。 */
  function parsedWithCost(sourceName: string, cost: unknown): ParsedProvider {
    return {
      ...makeParsed(sourceName),
      models: [{ id: 'm1', name: 'M1', cost }],
    } as unknown as ParsedProvider
  }

  it.each([
    ['负数分量', { input: -1, output: 2, cacheRead: 0, cacheWrite: 0 }],
    ['非数字分量', { input: '1', output: 2, cacheRead: 0, cacheWrite: 0 }],
    ['缺 cost 分量', { input: 1, output: 2 }],
    ['cost 非对象', 'not-an-object'],
  ])('非法 cost（%s）→ status:failed + reason 含 cost，upsertProvider 不落盘', async (_label, badCost) => {
    const importId = createPreview('pi', [parsedWithCost('bad-cost', badCost), makeParsed('good-entry')])
    const out = await applyImport(importId, ['bad-cost', 'good-entry'])
    expect('result' in out).toBe(true)
    if (!('result' in out)) throw new Error('apply should succeed')
    const bad = out.result.imported.find((i) => i.id === 'bad-cost')
    expect(bad?.status).toBe('failed')
    expect(bad?.reason).toContain('cost')
    // 坏条目不写盘
    expect(mockedUpsertProvider_m2).not.toHaveBeenCalledWith('bad-cost', expect.anything())
    // 同批合法条目照常导入
    const good = out.result.imported.find((i) => i.id === 'good-entry')
    expect(good?.status).toBe('imported')
    expect(mockedUpsertProvider_m2).toHaveBeenCalledWith('good-entry', expect.anything())
  })

  it('非法 reasoning（非布尔）→ status:failed + reason 含 reasoning', async () => {
    const provider = {
      ...makeParsed('bad-reasoning'),
      models: [{ id: 'm1', name: 'M1', reasoning: 'yes' }],
    } as unknown as ParsedProvider
    const importId = createPreview('pi', [provider])
    const out = await applyImport(importId, ['bad-reasoning'])
    if (!('result' in out)) throw new Error('apply should succeed')
    const item = out.result.imported.find((i) => i.id === 'bad-reasoning')
    expect(item?.status).toBe('failed')
    expect(item?.reason).toContain('reasoning')
    expect(mockedUpsertProvider_m2).not.toHaveBeenCalled()
  })

  it('合法 cost 四分量 → imported，写盘 cost 为白名单重建的四字段形态', async () => {
    const importId = createPreview('pi', [parsedWithCost('valid-cost', { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0.25 })])
    const out = await applyImport(importId, ['valid-cost'])
    if (!('result' in out)) throw new Error('apply should succeed')
    expect(out.result.imported.find((i) => i.id === 'valid-cost')?.status).toBe('imported')
    expect(mockedUpsertProvider_m2).toHaveBeenCalledTimes(1)
    const [id, config] = mockedUpsertProvider_m2.mock.calls[0] as [string, { models: Array<{ cost: Record<string, unknown> }> }]
    expect(id).toBe('valid-cost')
    expect(config.models[0].cost).toEqual({ input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0.25 })
  })

  it('缺 id 的模型条目 → 整条丢弃 + warn，不阻断同 provider 其余合法模型', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const provider = {
        ...makeParsed('mixed-models'),
        models: [{ name: 'no-id-model' }, { id: 'm2', name: 'M2' }],
      } as unknown as ParsedProvider
      const importId = createPreview('pi', [provider])
      const out = await applyImport(importId, ['mixed-models'])
      if (!('result' in out)) throw new Error('apply should succeed')
      expect(out.result.imported.find((i) => i.id === 'mixed-models')?.status).toBe('imported')
      const [, config] = mockedUpsertProvider_m2.mock.calls[0] as [string, { models: Array<{ id: string }> }]
      expect(config.models.map((m) => m.id)).toEqual(['m2'])
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('dropped model without id'))
    } finally {
      warnSpy.mockRestore()
    }
  })
})
});
});
