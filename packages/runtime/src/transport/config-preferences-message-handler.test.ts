/**
 * ConfigPreferencesMessageHandler 路由 + reply 塑形测试。
 *
 * 覆盖：
 *  - 偏好组（worktreeRootDir / defaultBaseBranch）转发：读取/写入 reply 塑形 + 原值透传
 *  - 兜底与不串扰：未知 case 子 handler false 零副作用；主入口委托可达；未知 type 兜底 false
 *
 * 历史：本文件曾覆盖 config.get/setStreamingIdleTimeout 配置链，该功能废弃后用例随之移除。
 *
 * mock 范式对齐同目录 settings-message-handler-llm-retry.test.ts（mockCtx 收集 replies）。
 *
 * 运行：cd packages/runtime && npx vitest run src/transport/config-preferences-message-handler.test.ts
 */
import { describe, it, expect, vi } from 'vitest'
import { ConfigPreferencesMessageHandler } from './config-preferences-message-handler.js'
import { SettingsMessageHandler, type SettingsHandlerContext } from './settings-message-handler.js'
import type { ClientMessage, ServerMessage } from '@taiji/shared'

const WS = {} as never

function mockCtx() {
  const replies: ServerMessage[] = []
  const configService = {
    // ④b 用例：非偏好组消息经主 switch 命中未迁移的既有 case（getAutoRenameEnabled）所需 stub
    getAutoRenameEnabled: vi.fn(() => false),
    // 偏好组 10 case 转发所需 stub（worktree 目录 / setup 脚本 / 裸仓脚本 / 超时 / 默认基分支）
    getWorktreeRootDir: vi.fn(() => '/wt'),
    setWorktreeRootDir: vi.fn(),
    getSetupScript: vi.fn(() => 'custom-hooks/setup-worktree.sh'),
    setSetupScript: vi.fn(),
    getBareSetupScript: vi.fn(() => 'custom-hooks/bare-setup.sh'),
    setBareSetupScript: vi.fn(),
    getTimeout: vi.fn(() => 90),
    setTimeout: vi.fn(),
    getDefaultBaseBranch: vi.fn(() => 'main'),
    setDefaultBaseBranch: vi.fn(),
  }
  const ctx = {
    send: vi.fn(),
    sendError: vi.fn(),
    reply: vi.fn((_ws: unknown, id: string | undefined, type: string, payload: unknown) => {
      replies.push({ type, id, payload } as unknown as ServerMessage)
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
    // D-21 端口化：ctx connectionTester 构造必需——本文件用例不走 mode=test，vi.fn 替身即可
    connectionTester: { supports: vi.fn(), test: vi.fn() },
  }
  return { ctx: ctx as unknown as SettingsHandlerContext, replies, configService }
}

describe('ConfigPreferencesMessageHandler · 偏好组转发参数化（S15：12 条转发 case 零断言补测）', () => {
  it.each([
    {
      name: '⑤ config.getWorktreeRootDir 读取转发',
      msg: { type: 'config.getWorktreeRootDir', payload: {} },
      replyType: 'config.worktreeRootDir',
      payload: { dir: '/wt' },
      setter: undefined,
    },
    {
      name: '⑥ config.setWorktreeRootDir 写转发（原值透传 + 生效值 reply）',
      msg: { type: 'config.setWorktreeRootDir', payload: { dir: '/new-wt' } },
      replyType: 'config.worktreeRootDir',
      payload: { dir: '/wt' },
      setter: { fn: 'setWorktreeRootDir', arg: '/new-wt' },
    },
    {
      name: '⑦ config.getDefaultBaseBranch 读取转发',
      msg: { type: 'config.getDefaultBaseBranch', payload: {} },
      replyType: 'config.defaultBaseBranch',
      payload: { baseBranch: 'main' },
      setter: undefined,
    },
    {
      name: '⑧ config.setDefaultBaseBranch 写转发（原值透传 + 生效值 reply）',
      msg: { type: 'config.setDefaultBaseBranch', payload: { baseBranch: 'develop' } },
      replyType: 'config.defaultBaseBranch',
      payload: { baseBranch: 'main' },
      setter: { fn: 'setDefaultBaseBranch', arg: 'develop' },
    },
    {
      name: '⑨ config.setSetupScript 写转发（原值透传 + 生效值 reply）',
      msg: { type: 'config.setSetupScript', payload: { script: 'hooks/init.sh' } },
      replyType: 'config.setupScript',
      payload: { script: 'custom-hooks/setup-worktree.sh' },
      setter: { fn: 'setSetupScript', arg: 'hooks/init.sh' },
    },
    {
      name: '⑩ config.getSetupScript 读取转发',
      msg: { type: 'config.getSetupScript', payload: {} },
      replyType: 'config.setupScript',
      payload: { script: 'custom-hooks/setup-worktree.sh' },
      setter: undefined,
    },
    {
      name: '⑪ config.setBareSetupScript 写转发（原值透传 + 生效值 reply）',
      msg: { type: 'config.setBareSetupScript', payload: { script: 'hooks/bare.sh' } },
      replyType: 'config.bareSetupScript',
      payload: { script: 'custom-hooks/bare-setup.sh' },
      setter: { fn: 'setBareSetupScript', arg: 'hooks/bare.sh' },
    },
    {
      name: '⑫ config.getBareSetupScript 读取转发',
      msg: { type: 'config.getBareSetupScript', payload: {} },
      replyType: 'config.bareSetupScript',
      payload: { script: 'custom-hooks/bare-setup.sh' },
      setter: undefined,
    },
    {
      name: '⑬ config.setTimeout 写转发（原值透传 + 生效值 reply）',
      msg: { type: 'config.setTimeout', payload: { timeout: 120 } },
      replyType: 'config.worktreeTimeout',
      payload: { timeout: 90 },
      setter: { fn: 'setTimeout', arg: 120 },
    },
    {
      name: '⑭ config.getTimeout 读取转发',
      msg: { type: 'config.getTimeout', payload: {} },
      replyType: 'config.worktreeTimeout',
      payload: { timeout: 90 },
      setter: undefined,
    },
  ])('$name', async ({ msg, replyType, payload, setter }) => {
    const { ctx, replies, configService } = mockCtx()
    const handler = new ConfigPreferencesMessageHandler(ctx)
    const handled = await handler.handle({ ...msg, id: 's1' } as unknown as ClientMessage, WS)
    expect(handled).toBe(true)
    expect(ctx.sendError).not.toHaveBeenCalled()
    expect(replies).toHaveLength(1)
    expect(replies[0]).toMatchObject({ type: replyType, id: 's1' })
    expect(replies[0].payload).toEqual(payload)
    if (setter) {
      // it.each 表格字面量推宽 fn 为 string；收窄回 mock 对象键集合（TS7053，无 any 断言）
      expect(configService[setter.fn as keyof typeof configService]).toHaveBeenCalledWith(setter.arg)
    }
  })
})

describe('ConfigPreferencesMessageHandler · 兜底与不串扰', () => {
  it('④ 子 handler 对未知 type 返回 false 且零 reply/零 ConfigService 调用', async () => {
    const { ctx, replies, configService } = mockCtx()
    const handler = new ConfigPreferencesMessageHandler(ctx)
    const handled = await handler.handle(
      { type: 'config.setRetryConfig', payload: {}, id: 'm5' } as unknown as ClientMessage,
      WS,
    )
    expect(handled).toBe(false)
    expect(replies).toHaveLength(0)
    expect(ctx.sendError).not.toHaveBeenCalled()
    expect(configService.getAutoRenameEnabled).not.toHaveBeenCalled()
  })

  it('④b 非偏好组消息经主入口仍由既有 case 消化（偏好组前置委托不吞消息）', async () => {
    const { ctx, replies } = mockCtx()
    const handler = new SettingsMessageHandler(ctx)
    // config.getAutoRenameEnabled 仍在主 switch（未迁移），子 handler 返回 false 后主 switch 命中
    const handled = await handler.handleSettingsMessage(
      { type: 'config.getAutoRenameEnabled', payload: {}, id: 'm6' } as unknown as ClientMessage,
      WS,
    )
    expect(handled).toBe(true)
    expect(replies[0]).toMatchObject({ type: 'config.autoRenameEnabled', id: 'm6' })
  })

  it('④c 未知 type 经主入口走 default 兜底 false（unknown_type 由 server 层处理）', async () => {
    const { ctx, replies } = mockCtx()
    const handler = new SettingsMessageHandler(ctx)
    const handled = await handler.handleSettingsMessage(
      { type: 'config.nonExistent', payload: {}, id: 'm7' } as unknown as ClientMessage,
      WS,
    )
    expect(handled).toBe(false)
    expect(replies).toHaveLength(0)
  })
})

describe('ConfigPreferencesMessageHandler · setter 校验拒绝路径（config.setTimeout）', () => {
  it('config.setTimeout 非法值：校验异常上抛（不吞、零 reply、零 sendError）——sendError 由 server.handleMessage catch 层统一负责', async () => {
    const { ctx, replies, configService } = mockCtx()
    // 校验本体在 ConfigService.setTimeout（worktree-config-helper：正数且 ≤3600，非法 throw）。
    // handler 单测以 mock 抛错模拟该拒绝，锚定 handler 层契约：异常原样上抛、不 reply、
    // 不越层 sendError（错误回包形态由 server.handleMessage 的 catch 统一塑形）。
    configService.setTimeout.mockImplementation(() => {
      throw new Error('timeout must be a positive number in (0, 3600], got -1')
    })
    const handler = new ConfigPreferencesMessageHandler(ctx)
    await expect(
      handler.handle(
        { type: 'config.setTimeout', payload: { timeout: -1 }, id: 'm8' } as unknown as ClientMessage,
        WS,
      ),
    ).rejects.toThrow(/timeout must be a positive number/)
    expect(replies).toHaveLength(0)
    expect(ctx.sendError).not.toHaveBeenCalled()
    // 抛错即止：生效值回读（getTimeout）不达，无「半写」reply
    expect(configService.getTimeout).not.toHaveBeenCalled()
  })
})
