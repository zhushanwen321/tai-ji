/**
 * config.detectSources WS round-trip 测试（W1）。
 *
 * 测试框架：vitest（从 vitest 导入 describe/it/expect/vi/beforeEach）。
 * 运行命令：cd packages/runtime && npx vitest run src/services/__tests__/config-detect-sources.test.ts
 *
 * 测试模式参考 transport/worktree-message-handler.test.ts：
 * - mock ctx（含 reply / configService 等），构造 ClientMessage，调 handler，断言 reply 参数。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SettingsMessageHandler, type SettingsHandlerContext } from '../../transport/settings-message-handler.js'
import type { ClientMessage, SourceDetectResult } from '@taiji/shared'
import { ModelConnectionTester } from '../../infra/model-connection-tester.js'

// ── mock helpers ─────────────────────────────────────────────

function mockWs() {
  return { send: vi.fn(), readyState: 1 } as unknown as Parameters<SettingsMessageHandler['handleSettingsMessage']>[1]
}

/**
 * 构造仅满足 config.detectSources case 所需的最小 ctx。
 * 其余字段用 vi.fn() 占位以满足类型（handleSettingsMessage 只在 detectSources 分支用到 reply/configService）。
 */
function mockContext(detectSourcesResult: SourceDetectResult[]): SettingsHandlerContext {
  return {
    reply: vi.fn(),
    send: vi.fn(),
    sendError: vi.fn(),
    configService: {
      detectSources: vi.fn(() => detectSourcesResult),
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

describe('config.detectSources WS round-trip', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('reply config.sourcesDetected，payload.sources 是数组（含检测项）', async () => {
    const detected: SourceDetectResult[] = [
      { source: 'claude', installed: true, dir: '/h/.claude/skills', skillCount: 2, agentCount: 1 },
      { source: 'codex', installed: false, dir: '/h/.codex/skills' },
      { source: 'pi', installed: true, dir: '/h/.pi/agent/skills', skillCount: 0 },
      { source: 'zcode', installed: false, dir: '/h/.zcode/skills' },
    ]
    const ctx = mockContext(detected)
    const handler = new SettingsMessageHandler(ctx)

    const handled = await handler.handleSettingsMessage(msg('config.detectSources', {}), mockWs())

    expect(handled).toBe(true)
    expect(ctx.configService.detectSources).toHaveBeenCalledTimes(1)
    expect(ctx.reply).toHaveBeenCalledWith(
      mockWs() && expect.anything(),  // ws（不深比对象身份）
      'msg-1',
      'config.sourcesDetected',
      { sources: detected },
    )
  })

  it('无源安装时仍 reply 空数组（不报错）', async () => {
    const detected: SourceDetectResult[] = [
      { source: 'claude', installed: false, dir: '/h/.claude/skills' },
      { source: 'codex', installed: false, dir: '/h/.codex/skills' },
      { source: 'pi', installed: false, dir: '/h/.pi/agent/skills' },
      { source: 'zcode', installed: false, dir: '/h/.zcode/skills' },
    ]
    const ctx = mockContext(detected)
    const handler = new SettingsMessageHandler(ctx)

    await handler.handleSettingsMessage(msg('config.detectSources', {}), mockWs())

    const replyCall = vi.mocked(ctx.reply).mock.calls[0]
    expect(replyCall[2]).toBe('config.sourcesDetected')
    expect(replyCall[3]).toEqual({ sources: detected })
    expect((replyCall[3] as { sources: unknown[] }).sources).toHaveLength(4)
  })

  it('reply 的 sources 内容与 configService.detectSources 返回值一致', async () => {
    const detected: SourceDetectResult[] = [
      { source: 'claude', installed: true, dir: '/h/.claude/skills', skillCount: 5, agentCount: 3 },
    ]
    const ctx = mockContext(detected)
    const handler = new SettingsMessageHandler(ctx)

    await handler.handleSettingsMessage(msg('config.detectSources', {}, 'abc-123'), mockWs())

    // reply 第 4 参（payload）与 detectSources 返回值同构
    const payload = vi.mocked(ctx.reply).mock.calls[0][3] as { sources: SourceDetectResult[] }
    expect(payload.sources).toBe(detected)
    // id 透传正确
    expect(vi.mocked(ctx.reply).mock.calls[0][1]).toBe('abc-123')
  })
})
