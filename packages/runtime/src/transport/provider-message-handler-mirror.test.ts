/**
 * ProviderMessageHandler mirrorAfterMutation write-through 触发链测试（ADR-0142 镜像架构）。
 *
 * 覆盖：
 *  - mutation 类 config.* 消息（setProvider/deleteProvider/toggleProviderEnabled/removeProviderByKind/
 *    refreshProviderCatalogs）处理成功后 `ctx.providersMutatedSync` 恰被调用一次；
 *  - config.applyImportProviders 成功分支：同步触发 + 导入后目录刷新 .then 回调再触发（共两次）；
 *  - 注：镜像运行串行化（ADR-0122 顺序契约，latest-wins + re-run）收敛在组合根触发面
 *    （zcode-provider-sync-wiring.createZcodeProviderMirrorSync），不在本 handler；
 *    串行化契约测试见 src/__tests__/services/zcode-provider-sync-wiring.test.ts。
 *  - 镜像同步 reject → catch 只 console.warn（fire-and-forget，不阻断 handler、不上抛）；
 *  - ctx 未注入（undefined，存量测试装配形态）→ 不调用、不炸，配置写入语义照常。
 *
 * mock 范式对齐同目录 config-preferences-message-handler.test.ts（mockCtx 收集 replies；
 * ProviderMessageHandler 由 SettingsMessageHandler 构造器无条件装配，本文件直构同款 ctx）。
 *
 * 运行：cd packages/runtime && npx vitest run src/transport/provider-message-handler-mirror.test.ts
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import type { ClientMessage } from '@taiji/shared'
import { ProviderMessageHandler } from './provider-message-handler.js'
import type { SettingsHandlerContext } from './settings-message-handler.js'

const WS = {} as never

function mockCtx(options: { providersMutatedSync?: () => Promise<void> } = {}) {
  const replies: Array<{ type: string; id?: string; payload: unknown }> = []
  const configService = {
    listProviders: vi.fn(() => []),
    getScopedModels: vi.fn(() => []),
    isModelsStoreCorrupted: vi.fn(() => false),
    getDefaultModel: vi.fn(() => null),
    refreshProviderCatalogs: vi.fn(async () => ({ updated: 0, failed: [] as string[] })),
    setProvider: vi.fn(async () => ({ newDefault: undefined, quotaAutoEnabled: false })),
    deleteProvider: vi.fn(async () => ({ removed: true, newDefault: undefined })),
    toggleProviderEnabled: vi.fn(() => ({ newDefault: undefined })),
    removeProviderByKind: vi.fn(async () => ({ removed: true, newDefault: undefined })),
    applyImportProviders: vi.fn(async () => ({
      result: { imported: 1, skipped: 0 } satisfies { imported: number; skipped: number },
    })),
  }
  const providersMutatedSync = options.providersMutatedSync ?? vi.fn(async () => {})
  const ctx = {
    send: vi.fn(),
    sendError: vi.fn(),
    reply: vi.fn((_ws: unknown, id: string | undefined, type: string, payload: unknown) => {
      replies.push({ type, id, payload })
    }),
    configService,
    sessionService: {},
    modelService: {},
    authService: {},
    skillRegistry: {},
    projectRoot: '/test',
    nextPushId: vi.fn(() => 'push_1'),
    broadcast: vi.fn(),
    broadcastProviderList: vi.fn(),
    broadcastSkillList: vi.fn(),
    broadcastSkillCacheInvalidated: vi.fn(),
    broadcastAgentList: vi.fn(),
    broadcastSkillDirs: vi.fn(),
    broadcastAgentDirs: vi.fn(),
    broadcastExtensionDirs: vi.fn(),
    connectionTester: { supports: vi.fn(), test: vi.fn() },
    providersMutatedSync,
  }
  return { ctx: ctx as unknown as SettingsHandlerContext, replies, configService, providersMutatedSync }
}

function msg(type: string, payload: Record<string, unknown>): ClientMessage {
  return { type, id: 'm1', payload } as unknown as ClientMessage
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('ProviderMessageHandler · mirrorAfterMutation write-through 触发链（ADR-0142）', () => {
  it.each([
    {
      name: 'config.setProvider',
      message: msg('config.setProvider', { providerId: 'stepfun', name: 'StepFun' }),
      serviceFn: 'setProvider' as const,
    },
    {
      name: 'config.deleteProvider',
      message: msg('config.deleteProvider', { providerId: 'stepfun' }),
      serviceFn: 'deleteProvider' as const,
    },
    {
      name: 'config.toggleProviderEnabled',
      message: msg('config.toggleProviderEnabled', { providerId: 'stepfun', enabled: false }),
      serviceFn: 'toggleProviderEnabled' as const,
    },
    {
      name: 'config.removeProviderByKind',
      message: msg('config.removeProviderByKind', { providerId: 'stepfun', kind: 'custom' }),
      serviceFn: 'removeProviderByKind' as const,
    },
    {
      name: 'config.refreshProviderCatalogs',
      message: msg('config.refreshProviderCatalogs', {}),
      serviceFn: 'refreshProviderCatalogs' as const,
    },
  ])('$name 处理成功 → providersMutatedSync 恰被调用一次', async ({ message, serviceFn }) => {
    const { ctx, providersMutatedSync, configService } = mockCtx()
    const handler = new ProviderMessageHandler(ctx)

    const handled = await handler.handle(message, WS)

    expect(handled).toBe(true)
    expect(configService[serviceFn]).toHaveBeenCalled()
    expect(providersMutatedSync).toHaveBeenCalledTimes(1)
  })

  it('config.applyImportProviders 成功分支：同步触发 + 目录刷新 .then 回调再触发（共两次）', async () => {
    const { ctx, providersMutatedSync, configService, replies } = mockCtx()
    const handler = new ProviderMessageHandler(ctx)

    const handled = await handler.handle(
      msg('config.applyImportProviders', { importId: 'imp-1', selectedIds: ['stepfun'] }),
      WS,
    )

    expect(handled).toBe(true)
    expect(replies.some(r => r.type === 'config.providersImported')).toBe(true)
    // 同步一次（mutation 落盘后）+ refreshProviderCatalogs resolve 后 .then 一次
    await vi.waitFor(() => expect(providersMutatedSync).toHaveBeenCalledTimes(2))
    expect(configService.applyImportProviders).toHaveBeenCalledWith('imp-1', ['stepfun'])
  })

  it('镜像同步 reject → catch 只 warn，不上抛不阻断 handler（fire-and-forget 语义）', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { ctx, providersMutatedSync } = mockCtx({
      providersMutatedSync: vi.fn(async () => {
        throw new Error('mirror write failed')
      }),
    })
    const handler = new ProviderMessageHandler(ctx)

    const handled = await handler.handle(msg('config.setProvider', { providerId: 'stepfun' }), WS)

    expect(handled).toBe(true)
    await vi.waitFor(() => expect(warnSpy).toHaveBeenCalled())
    const warnText = warnSpy.mock.calls.map(args => args.map(String).join(' ')).join('\n')
    expect(warnText).toContain('[provider-message-handler] zcode provider mirror sync failed')
    expect(warnText).toContain('mirror write failed')
  })

  it('镜像同步 throw（同步异常形态）→ handler 正常返回、配置写入应答照常（S-8 同族）', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { ctx, replies } = mockCtx({
      // 同步 throw 而非 rejected promise：触发点均在 reply 之后，未防护时会冒泡到
      // server 层对同一 msg.id 补发 error envelope（成功 + 失败双回复）
      providersMutatedSync: vi.fn((): Promise<void> => { throw new Error('sync throw') }),
    })
    const handler = new ProviderMessageHandler(ctx)

    const handled = await handler.handle(msg('config.setProvider', { providerId: 'stepfun' }), WS)

    expect(handled).toBe(true)
    expect(replies.filter(r => r.type === 'config.providerUpdated')).toHaveLength(1)
    expect(warnSpy).toHaveBeenCalledWith(
      '[provider-message-handler] zcode provider mirror sync failed:',
      'sync throw',
    )
  })

  it('ctx 未注入（undefined，存量测试装配形态）→ 不调用不炸，配置写入照常应答', async () => {
    const { ctx, replies } = mockCtx()
    delete (ctx as { providersMutatedSync?: unknown }).providersMutatedSync
    const handler = new ProviderMessageHandler(ctx)

    const handled = await handler.handle(msg('config.setProvider', { providerId: 'stepfun' }), WS)

    expect(handled).toBe(true)
    expect(replies.some(r => r.type === 'config.providerUpdated')).toBe(true)
  })
})
