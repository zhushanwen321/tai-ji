/**
 * SettingsMessageHandler model.switch reply 生效值回传（C-pi-13 回执修型 U6）测试。
 *
 * 锁定：reply 回传 switchModel 返回的生效值（pi pattern 引擎可能把请求模型静默
 * 换成同族条目，请求 ≠ 生效——事故 A 形态），拆解 'provider/id' 复合串回填
 * provider/modelId；复合串无 '/' 的 fallback 形态按请求值回显（旧行为兜底）。
 *
 * 运行：cd packages/runtime && npx vitest run src/transport/settings-message-handler-model-switch.test.ts
 */
import { describe, it, expect, vi } from 'vitest'
import { SettingsMessageHandler, type SettingsHandlerContext } from './settings-message-handler.js'
import { errorWithCode, SESSION_NOT_ACTIVE } from '../utils/errors.js'
import type { ClientMessage, ProviderId, ServerMessage } from '@taiji/shared'

function mockCtx(effectiveModel: string) {
  const replies: ServerMessage[] = []
  const switchModel = vi.fn().mockResolvedValue(effectiveModel)
  const ctx = {
    send: vi.fn(),
    sendError: vi.fn(),
    reply: vi.fn((_ws: unknown, id: string | undefined, type: string, payload: unknown) => {
      replies.push({ type, id, payload } as unknown as ServerMessage)
    }),
    configService: {
      listProviders: vi.fn(() => []),
      getScopedModels: vi.fn(() => []),
    },
    sessionService: {},
    modelService: {
      aggregateModels: vi.fn(() => []),
      switchModel,
    },
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
    // D-21 端口化：ctx connectionTester 构造必需——本文件用例不走 mode=test，vi.fn 替身即可
    connectionTester: { supports: vi.fn(), test: vi.fn() },
  }
  return { ctx: ctx as unknown as SettingsHandlerContext, replies, switchModel }
}

function switchMsg(): ClientMessage {
  return {
    type: 'model.switch',
    payload: { sessionId: 'sess-1', provider: 'zai-coding-cn' as ProviderId, modelId: 'glm-5.3' },
    id: 'm1',
  } as unknown as ClientMessage
}

const WS = {} as never

describe('SettingsMessageHandler · model.switch reply 回传生效值（U6 / C-pi-13）', () => {
  it('pi 换模（生效 ≠ 请求）→ reply 回传生效 provider/modelId，不回显请求值', async () => {
    const { ctx, replies, switchModel } = mockCtx('zai-coding-cn/glm-5.3-air')
    const handler = new SettingsMessageHandler(ctx)

    await handler.handleSettingsMessage(switchMsg(), WS)

    expect(switchModel).toHaveBeenCalledWith('sess-1', 'zai-coding-cn', 'glm-5.3')
    expect(ctx.reply).toHaveBeenCalledTimes(1)
    const [repliedType, payload] = [replies[0].type, replies[0].payload] as const
    expect(repliedType).toBe('model.switched')
    // 生效值（复合串拆解），而非请求的 glm-5.3
    expect(payload).toEqual({ sessionId: 'sess-1', provider: 'zai-coding-cn', modelId: 'glm-5.3-air' })
  })

  it('生效值含多段斜杠的 modelId → 仅按首个 / 拆 provider，余下归 modelId', async () => {
    const { ctx, replies } = mockCtx('openai/org/team-model-v2')
    const handler = new SettingsMessageHandler(ctx)

    await handler.handleSettingsMessage(switchMsg(), WS)

    expect(replies[0].payload).toEqual({
      sessionId: 'sess-1',
      provider: 'openai',
      modelId: 'org/team-model-v2',
    })
  })

  it('返回值无 /（无活跃进程早退 fallback）→ 按请求值回显（旧行为兜底）', async () => {
    const { ctx, replies } = mockCtx('sess-1')
    const handler = new SettingsMessageHandler(ctx)

    await handler.handleSettingsMessage(switchMsg(), WS)

    expect(replies[0].payload).toEqual({ sessionId: 'sess-1', provider: 'zai-coding-cn', modelId: 'glm-5.3' })
  })

  it('返回值空串（U6 降级守卫：无 sessionService / 无活跃 session / 非法复合串）→ reply 按请求值回显，不产畸形 payload', async () => {
    // 空串是 U6 降级契约（plugin-rpc-setup setModel 守卫三分支返回 ''）——
    // indexOf('/') 为 -1 落入请求值回显兜底，reply 形态保持 { sessionId, provider, modelId } 完整，
    // 消费方（renderer）不收到空 provider/modelId 的畸形帧。
    const { ctx, replies } = mockCtx('')
    const handler = new SettingsMessageHandler(ctx)

    await handler.handleSettingsMessage(switchMsg(), WS)

    expect(ctx.reply).toHaveBeenCalledTimes(1)
    expect(replies[0].type).toBe('model.switched')
    expect(replies[0].payload).toEqual({ sessionId: 'sess-1', provider: 'zai-coding-cn', modelId: 'glm-5.3' })
  })

  it('session 未活跃（RT-4#4）→ switchModel 的 SESSION_NOT_ACTIVE rejection 原样上抛，不发 model.switched 假成功 reply', async () => {
    // 无活跃进程的失败语义在 service 层 fail-fast（errorWithCode）；handler 不吞不转译，
    // 由 server.ts handleMessage 全局 catch 统一 sendError（code 透传 + details.sessionId）。
    const { ctx, switchModel } = mockCtx('zai-coding-cn/glm-5.3')
    ;(switchModel as ReturnType<typeof vi.fn>).mockRejectedValue(
      errorWithCode('会话未活跃（sess-1 无活跃进程），重开后可重试', SESSION_NOT_ACTIVE),
    )
    const handler = new SettingsMessageHandler(ctx)

    await expect(handler.handleSettingsMessage(switchMsg(), WS)).rejects.toMatchObject({
      code: SESSION_NOT_ACTIVE,
    })
    expect(ctx.reply).not.toHaveBeenCalled()
  })
})
