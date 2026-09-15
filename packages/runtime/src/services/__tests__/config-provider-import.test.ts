/**
 * config.previewImportProviders / config.applyImportProviders WS round-trip 测试（W2）。
 *
 * 测试框架：vitest（从 vitest 导入 describe/it/expect/vi/beforeEach）。
 * 运行命令：cd packages/runtime && npx vitest run src/services/__tests__/config-provider-import.test.ts
 *
 * 测试模式参考 config-detect-sources.test.ts（W1）：
 *   - mock ctx（含 reply / configService 等），构造 ClientMessage，调 handler，断言 reply 参数。
 *
 * 覆盖：
 *   - T8：发 config.previewImportProviders {source:'pi'} → 收到 config.providersPreviewed，
 *         payload.importId 非空，payload.preview.providers 是数组。
 *   - T9：先 preview 拿 importId → 发 config.applyImportProviders {importId, selectedIds}
 *         → 收到 config.providersImported，payload.result.imported 是数组 + broadcastProviderList 被调。
 *   - T8b：preview 返回 error（源未安装）→ reply 仍 config.providersPreviewed（含 error 字段），不报错。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SettingsMessageHandler, type SettingsHandlerContext } from '../../transport/settings-message-handler.js'
import { ModelConnectionTester } from '../../infra/model-connection-tester.js'
import { previewImport, applyImport } from '../migration/provider-importer.js'
import { _resetCacheForTest } from '../migration/preview-cache.js'
import { getModelsPath } from '../../infra/pi/pi-paths.js'
import { setModelsPath } from '../../infra/pi/pi-provider-store.js'
import { readFileSync } from 'node:fs'
import type { ClientMessage, ProviderImportPreview, ProviderImportResult } from '@taiji/shared'
// Pi fixture（真实模型/Key 形状，假 Key），用于 T10 端到端
import piModelsFixture from '../migration/parsers/__tests__/fixtures/pi-models.json' with { type: 'json' }
import piAuthFixture from '../migration/parsers/__tests__/fixtures/pi-auth.json' with { type: 'json' }

// ── mock helpers ─────────────────────────────────────────────

function mockWs() {
  return { send: vi.fn(), readyState: 1 } as unknown as Parameters<SettingsMessageHandler['handleSettingsMessage']>[1]
}

/**
 * 构造满足 preview/apply case 所需的最小 ctx。
 * previewImportProviders / applyImportProviders 是 vi.fn()，各 test 用 mockReturnValue 覆盖返回值。
 */
function mockContext(): SettingsHandlerContext {
  return {
    reply: vi.fn(),
    send: vi.fn(),
    sendError: vi.fn(),
    configService: {
      previewImportProviders: vi.fn(),
      // applyImportProviders 后 handler 调 getDefaultModel（重选 default + 广播 config.defaults），mock 补全
      getDefaultModel: vi.fn(() => null),
      applyImportProviders: vi.fn(),
      // D9：导入成功后 handler fire-and-forget 调 refreshProviderCatalogs（完成后二次广播），
      // mock 缺失会 TypeError 拖垮 handler 成功分支
      refreshProviderCatalogs: vi.fn().mockResolvedValue({ refreshed: [], failed: [] }),
    } as unknown as SettingsHandlerContext['configService'],
    sessionService: {} as SettingsHandlerContext['sessionService'],
    modelService: {} as SettingsHandlerContext['modelService'],
    skillRegistry: {} as SettingsHandlerContext['skillRegistry'],
    projectRoot: '/tmp/project',
    nextPushId: vi.fn(() => 'push-1'),
    broadcast: vi.fn(),
    broadcastProviderList: vi.fn(),
    broadcastSkillList: vi.fn(),
    broadcastSkillCacheInvalidated: vi.fn(),
    broadcastAgentList: vi.fn(),
    broadcastSkillDirs: vi.fn(),
    broadcastAgentDirs: vi.fn(),
    broadcastExtensionDirs: vi.fn(),
    connectionTester: new ModelConnectionTester(),
  } as unknown as SettingsHandlerContext
}

function msg(type: string, payload: Record<string, unknown> = {}, id = 'msg-1'): ClientMessage {
  return { type, payload, id } as unknown as ClientMessage
}

// ── tests ────────────────────────────────────────────────────

describe('config.previewImportProviders / config.applyImportProviders WS round-trip', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('T8: preview {source:pi} → reply config.providersPreviewed，importId 非空 + providers 是数组', async () => {
    const ctx = mockContext()
    const preview: ProviderImportPreview = {
      source: 'pi',
      providers: [
        {
          id: 'deepseek-router',
          name: 'deepseek-router',
          protocol: 'anthropic-messages',
          modelCount: 2,
          apiKeyExtracted: true,
          credentialType: 'plaintext',
          conflict: 'none',
          warnings: [],
        },
      ],
    }
    vi.mocked(ctx.configService.previewImportProviders).mockReturnValue({
      importId: 'import-uuid-123',
      preview,
    })
    const handler = new SettingsMessageHandler(ctx)

    const handled = await handler.handleSettingsMessage(msg('config.previewImportProviders', { source: 'pi' }), mockWs())

    expect(handled).toBe(true)
    expect(ctx.configService.previewImportProviders).toHaveBeenCalledWith('pi')
    expect(ctx.reply).toHaveBeenCalledWith(
      expect.anything(),
      'msg-1',
      'config.providersPreviewed',
      { importId: 'import-uuid-123', preview },
    )
    // payload 形状断言
    const payload = vi.mocked(ctx.reply).mock.calls[0][3] as { importId: string; preview: ProviderImportPreview }
    expect(payload.importId).toBe('import-uuid-123')
    expect(Array.isArray(payload.preview.providers)).toBe(true)
    expect(payload.preview.providers).toHaveLength(1)
  })

  it('T9: preview 拿 importId → apply → reply config.providersImported + broadcastProviderList', async () => {
    const ctx = mockContext()
    const importId = 'round-trip-import-id'
    const result: ProviderImportResult = {
      source: 'pi',
      imported: [
        { id: 'deepseek-router', name: 'deepseek-router', status: 'imported' },
        { id: 'existing-one', name: 'existing-one', status: 'skipped', reason: 'duplicate' },
      ],
      failedCount: 0,
    }
    // preview 返回 importId（apply 测试复用同一 importId）
    vi.mocked(ctx.configService.previewImportProviders).mockReturnValue({
      importId,
      preview: { source: 'pi', providers: [] },
    })
    vi.mocked(ctx.configService.applyImportProviders).mockResolvedValue({ result })
    const handler = new SettingsMessageHandler(ctx)

    // Step1 preview
    await handler.handleSettingsMessage(msg('config.previewImportProviders', { source: 'pi' }, 'preview-id'), mockWs())

    // Step2 apply —— 复用 preview reply 里的 importId
    await handler.handleSettingsMessage(
      msg('config.applyImportProviders', { importId, selectedIds: ['deepseek-router', 'existing-one'] }, 'apply-id'),
      mockWs(),
    )

    // apply reply 断言
    const applyReply = vi.mocked(ctx.reply).mock.calls.find((c) => c[2] === 'config.providersImported')
    expect(applyReply).toBeDefined()
    // vi.mocked().mock.calls.find 返回 T | undefined；tsc 不会因 expect(toBeDefined) 收窄，故用非空断言。
    expect(applyReply![1]).toBe('apply-id')
    expect(applyReply![3]).toEqual({ result })
    // apply 成功 → 广播 provider 列表（让所有 panel 同步新增的 provider）
    // D9 后共 2 次：导入同步广播 1 次 + fire-and-forget refresh 完成后广播 1 次（refresh mock
    // 已 resolve，await 恢复前其 .then 回调已入 microtask 队列先执行）
    expect(ctx.broadcastProviderList).toHaveBeenCalledTimes(2)
    // apply 传入的参数：importId + selectedIds
    expect(ctx.configService.applyImportProviders).toHaveBeenCalledWith(importId, ['deepseek-router', 'existing-one'])
  })

  it('T8b: preview 返回 error（源未安装）→ reply config.providersPreviewed 含 error 字段，不报错', async () => {
    const ctx = mockContext()
    vi.mocked(ctx.configService.previewImportProviders).mockReturnValue({
      error: { code: 'SOURCE_NOT_INSTALLED', message: 'claude not installed' },
    })
    const handler = new SettingsMessageHandler(ctx)

    const handled = await handler.handleSettingsMessage(
      msg('config.previewImportProviders', { source: 'claude' }, 'err-id'),
      mockWs(),
    )

    expect(handled).toBe(true)
    expect(ctx.reply).toHaveBeenCalledWith(
      expect.anything(),
      'err-id',
      'config.providersPreviewed',
      { error: { code: 'SOURCE_NOT_INSTALLED', message: 'claude not installed' } },
    )
    // preview 失败不广播（无副作用）
    expect(ctx.broadcastProviderList).not.toHaveBeenCalled()
  })

  it('T9b: apply 返回 error（缓存过期）→ reply config.providersImported 含 error，不广播', async () => {
    const ctx = mockContext()
    vi.mocked(ctx.configService.applyImportProviders).mockResolvedValue({
      error: { code: 'PREVIEW_EXPIRED', message: '预览已过期' },
    })
    const handler = new SettingsMessageHandler(ctx)

    await handler.handleSettingsMessage(
      msg('config.applyImportProviders', { importId: 'expired-id', selectedIds: ['A'] }, 'apply-err-id'),
      mockWs(),
    )

    expect(ctx.reply).toHaveBeenCalledWith(
      expect.anything(),
      'apply-err-id',
      'config.providersImported',
      { error: { code: 'PREVIEW_EXPIRED', message: '预览已过期' } },
    )
    // apply 失败不广播（result 不含 result 字段）
    expect(ctx.broadcastProviderList).not.toHaveBeenCalled()
  })
})

// ══════════════════════════════════════════════════════════════════
// D9（pi-evolution-consistency-and-project-switcher §3.3）：导入成功后触发
// 远程目录刷新（fire-and-forget）。锁定 handler 层接线：成功路径调
// configService.refreshProviderCatalogs 且完成后二次广播；失败路径零触发；
// refresh reject 不影响导入 reply（不阻塞、不上抛）。
// ══════════════════════════════════════════════════════════════════
describe('D9: applyImportProviders 成功路径触发 refreshProviderCatalogs（fire-and-forget）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  function applyMsg(): ClientMessage {
    return msg('config.applyImportProviders', { importId: 'd9-id', selectedIds: ['deepseek-router'] }, 'd9-apply-id')
  }

  const OK_RESULT: ProviderImportResult = {
    source: 'pi',
    imported: [{ id: 'deepseek-router', name: 'deepseek-router', status: 'imported' }],
    failedCount: 0,
  }

  it('apply 成功 → refreshProviderCatalogs 被调用 + refresh 完成后二次广播（overlay 新模型推给前端）', async () => {
    const ctx = mockContext()
    vi.mocked(ctx.configService.applyImportProviders).mockResolvedValue({ result: OK_RESULT })
    const handler = new SettingsMessageHandler(ctx)

    await handler.handleSettingsMessage(applyMsg(), mockWs())

    // 成功路径触发 refresh（经 config-service 薄包装，范围=聚合列表内 catalog provider）
    expect(ctx.configService.refreshProviderCatalogs).toHaveBeenCalledTimes(1)
    // 导入同步广播 + refresh 完成广播 = 2 次
    expect(ctx.broadcastProviderList).toHaveBeenCalledTimes(2)
    // 导入 reply 不被 refresh 阻塞：providersImported 已在 refresh 前正常回给发起端
    expect(ctx.reply).toHaveBeenCalledWith(
      expect.anything(),
      'd9-apply-id',
      'config.providersImported',
      { result: OK_RESULT },
    )
  })

  it('apply 失败（缓存过期）→ 不触发 refresh，也不广播', async () => {
    const ctx = mockContext()
    vi.mocked(ctx.configService.applyImportProviders).mockResolvedValue({
      error: { code: 'PREVIEW_EXPIRED', message: '预览已过期' },
    })
    const handler = new SettingsMessageHandler(ctx)

    await handler.handleSettingsMessage(applyMsg(), mockWs())

    expect(ctx.configService.refreshProviderCatalogs).not.toHaveBeenCalled()
    expect(ctx.broadcastProviderList).not.toHaveBeenCalled()
  })

  it('payload 校验失败（selectedIds 非字符串数组）→ sendError 短路，不触发 refresh', async () => {
    const ctx = mockContext()
    const handler = new SettingsMessageHandler(ctx)

    const handled = await handler.handleSettingsMessage(
      msg('config.applyImportProviders', { importId: 'd9-id', selectedIds: [123] }, 'bad-id'),
      mockWs(),
    )

    expect(handled).toBe(true)
    expect(ctx.sendError).toHaveBeenCalled()
    expect(ctx.configService.applyImportProviders).not.toHaveBeenCalled()
    expect(ctx.configService.refreshProviderCatalogs).not.toHaveBeenCalled()
  })

  it('refresh reject → 仅日志，导入 reply 不受影响，handler 不上抛（fire-and-forget 契约）', async () => {
    const ctx = mockContext()
    vi.mocked(ctx.configService.applyImportProviders).mockResolvedValue({ result: OK_RESULT })
    vi.mocked(ctx.configService.refreshProviderCatalogs).mockRejectedValue(new Error('disk full'))
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const handler = new SettingsMessageHandler(ctx)

    // handler 不因 refresh 失败而上抛（失败不影响导入结果）
    await expect(handler.handleSettingsMessage(applyMsg(), mockWs())).resolves.toBe(true)

    expect(ctx.reply).toHaveBeenCalledWith(
      expect.anything(),
      'd9-apply-id',
      'config.providersImported',
      { result: OK_RESULT },
    )
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[settings-handler] applyImportProviders: provider catalog refresh failed:'),
      expect.any(Error),
    )
    warnSpy.mockRestore()
  })
})

// ══════════════════════════════════════════════════════════════════
// T10 端到端：previewImport('pi') 走真实 parseProviders（不 mock）+ 真实 Pi fixture
// ══════════════════════════════════════════════════════════════════
//
// W2 的 WS round-trip 测试（上方 describe）vi.mock 了 parseProviders，验证的是 handler↔configService
// 的接线，与真实解析逻辑解耦。本测试不 mock parseProviders / provider-parser，
// 把真实 Pi fixture（pi-models.json + pi-auth.json）写到临时 HOME 的 ~/.pi/agent/，
// 调真实的 previewImport('pi')，断言 preview.providers 含真实 Pi provider 数据
// （deepseek-router + zhipu，gemini 被丢弃），而非 W2 Mock 的固定值。
//
// 安全：apiKey 明文绝不进 preview（脱敏红线）。fixture 全用假 key。

describe('T10: previewImport 端到端（真实 parseProviders + 真实 Pi fixture）', () => {
  let prevHome: string | undefined
  let fakeHome: string

  beforeEach(() => {
    vi.clearAllMocks()
    _resetCacheForTest()
    prevHome = process.env.HOME
    fakeHome = mkdtempSync(join(tmpdir(), 'pi-e2e-'))
    // 写真实 Pi fixture 到 <fakeHome>/.pi/agent/
    const piAgentDir = join(fakeHome, '.pi', 'agent')
    mkdirSync(piAgentDir, { recursive: true })
    writeFileSync(join(piAgentDir, 'models.json'), JSON.stringify(piModelsFixture))
    writeFileSync(join(piAgentDir, 'auth.json'), JSON.stringify(piAuthFixture))
    process.env.HOME = fakeHome
  })

  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME
    else process.env.HOME = prevHome
    rmSync(fakeHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  it('previewImport(pi) 返回真实 Pi provider（deepseek-router + zhipu，gemini 丢弃），非 Mock 固定值', () => {
    const out = previewImport('pi')

    // 成功（有 importId）
    expect('importId' in out).toBe(true)
    if (!('importId' in out)) throw new Error('preview should succeed')
    expect(out.importId).toBeTruthy()

    // 真实 Pi fixture：deepseek-router + zhipu（gemini 协议不支持被丢弃）
    expect(out.preview.source).toBe('pi')
    const ids = out.preview.providers.map((p) => p.id)
    expect(ids).toEqual(expect.arrayContaining(['deepseek-router', 'zhipu']))
    expect(ids).not.toContain('gemini')
    expect(out.preview.providers).toHaveLength(2)

    // deepseek-router 真实数据（非 W2 Mock 固定值）
    const deepseek = out.preview.providers.find((p) => p.id === 'deepseek-router')!
    expect(deepseek.protocol).toBe('anthropic-messages')
    expect(deepseek.modelCount).toBe(2) // deepseek-chat + deepseek-reasoner
    expect(deepseek.apiKeyExtracted).toBe(true)
    expect(deepseek.conflict).toBe('none')

    // zhipu：auth.json 提取到 key（注意：preview 只暴露 apiKeyExtracted 布尔，不暴露 key 值）
    const zhipu = out.preview.providers.find((p) => p.id === 'zhipu')!
    expect(zhipu.protocol).toBe('openai-completions')
    expect(zhipu.modelCount).toBe(2) // glm-4.6 + glm-4.5-air
    expect(zhipu.apiKeyExtracted).toBe(true)
  })

  it('previewImport 脱敏红线：preview JSON 不含 Pi fixture 的明文 key', () => {
    const out = previewImport('pi')
    const serialized = JSON.stringify(out)

    // 红线：apiKey 明文绝不进 preview 序列化结果
    expect(serialized).not.toContain('sk-fake-deepseek-from-auth')
    expect(serialized).not.toContain('sk-fake-zhipu-from-auth')
    expect(serialized).not.toContain('sk-fake-zhipu-in-models')
  })
})

// ══════════════════════════════════════════════════════════════════
// T11 端到端（sa3 F1）：孤儿凭据 preview 组 2 → apply → 真实 models.json 落盘
// ══════════════════════════════════════════════════════════════════
//
// 完整链路：真实 parsePiProviders（含孤儿凭据扫描）→ previewImport（组 2）→
// applyImport（内置模板补全）→ 真实 upsertProvider 写临时 models.json。
// 验收标准：
//   1. 孤儿凭据（auth.json 有、models.json 无的 openai）→ preview 组 2（builtinTemplateMatched）
//   2. [D1④ 契约变更] credentialWriter 未注入时 catalog 孤儿凭据**不写 models.json**——
//      旧实现用内置模板（tpl.api/tpl.baseUrl = 快照 artifact）+ oc.apiKey 落盘，是 artifact
//      捏造 + M5-01 同族 apiKey 错位写；现返回 failed 并引导用户经 UI 配置凭据
//      （imported 状态语义只对真实落盘成立）。组 1 的非 catalog provider 照常落盘（对照）。
//   3. 脱敏红线：preview 载荷无明文 key；models.json 亦无该明文 key

describe('T11: 孤儿凭据端到端（sa3 F1 · B.3/B.4/B.6）', () => {
  let prevHome: string | undefined
  let prevModelsPath: string | undefined
  let fakeHome: string
  let fakeModelsPath: string

  beforeEach(() => {
    vi.clearAllMocks()
    _resetCacheForTest()
    prevHome = process.env.HOME
    fakeHome = mkdtempSync(join(tmpdir(), 'pi-orphan-e2e-'))
    // 写真实 Pi fixture：models.json 只有 zhipu（无 openai）+ auth.json 含 openai 孤儿凭据
    const piAgentDir = join(fakeHome, '.pi', 'agent')
    mkdirSync(piAgentDir, { recursive: true })
    writeFileSync(join(piAgentDir, 'models.json'), JSON.stringify(piModelsFixture))
    writeFileSync(join(piAgentDir, 'auth.json'), JSON.stringify({
      ...piAuthFixture,
      // 孤儿凭据：models.json 未定义的 openai（内置 provider 的 key）
      openai: { type: 'api_key', key: 'sk-orphan-e2e-openai' },
    }))
    process.env.HOME = fakeHome
    // 真实 upsertProvider 写入路径指向临时 models.json（getProviderNames 同源）
    prevModelsPath = getModelsPath()
    fakeModelsPath = join(fakeHome, 'models-target.json')
    setModelsPath(fakeModelsPath)
  })

  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME
    else process.env.HOME = prevHome
    if (prevModelsPath !== undefined) setModelsPath(prevModelsPath)
    rmSync(fakeHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  it('孤儿凭据 auth.json → preview 组 2 → catalog 无 credentialWriter → failed，且不写模板 artifact/apiKey 进 models.json（D1④）', async () => {
    const out = previewImport('pi')
    if (!('importId' in out)) throw new Error('preview should succeed')

    // 组 2：孤儿凭据 openai 匹配内置模板
    expect(out.preview.orphanCredentials).toHaveLength(1)
    const item = out.preview.orphanCredentials![0]
    expect(item.providerId).toBe('openai')
    expect(item.builtinTemplateMatched).toBe(true)
    expect(item.name).toBe('OpenAI')
    expect(item.credentialType).toBe('plaintext')
    expect(item.apiKeyExtracted).toBe(true)
    // 脱敏红线：组 2 载荷不含明文 key
    expect(JSON.stringify(out)).not.toContain('sk-orphan-e2e-openai')

    // apply：组 1（zhipu/deepseek-router）+ 组 2（openai）一起导入
    const applyOut = await applyImport(out.importId, ['zhipu', 'deepseek-router', 'openai'])
    if (!('result' in applyOut)) throw new Error('apply should succeed')

    // 设计 D1④：catalog provider 定义来自 pi 内置 catalog、凭据只允许落 auth.json（0600）
    // ——credentialWriter 未注入时无处安放，宁丢不写错位：不再有「写模板进 models.json」的
    // 降级（tpl.api/tpl.baseUrl 是快照 artifact，oc.apiKey 落 models.json 是 M5-01 同族错位写），
    // 返回 failed 并给出可操作的指引（经 UI 配置凭据）。
    const openaiResult = applyOut.result.imported.find((i) => i.id === 'openai')!
    expect(openaiResult.status).toBe('failed')
    expect(openaiResult.reason).toContain('credential writer')

    // 真实 models.json 落盘验证：catalog 孤儿凭据不产生任何条目（无 artifact、无 apiKey 错位写）
    const raw = readFileSync(fakeModelsPath, 'utf8')
    const written = JSON.parse(raw)
    expect(written.providers.openai).toBeUndefined()
    // 明文 key 绝不进 models.json（与 auth.json 凭据归属一致）
    expect(raw).not.toContain('sk-orphan-e2e-openai')

    // 组 1 非 catalog provider 不受影响：照常落盘（对照，证明 failed 只针对 catalog 降级分支）
    expect(written.providers.zhipu).toBeDefined()
    expect(written.providers['deepseek-router']).toBeDefined()
  })
})
