/**
 * ResourcesMessageHandler.setSkillDirs 失效编排测试（缓存治理 1-5）。
 *
 * 被测缺口：rebuildGlobal 失败分支此前只 broadcast 不清 projectCache——失效广播与缓存
 * 实际状态不一致，前端重拉仍命中旧值。修复后失败分支同样 invalidateAllProjects。
 *
 * 分层说明：「invalidate 清缓存 → 下次 getProjectSkills 重扫」的缓存语义本体归
 * skill-registry 自身测试域；本文件在 handler 编排层证明——失效动作在失败分支真实发生，
 * 且以「失效前读旧值 / 失效后读新值」的序列 mock 表达「下次读为新值」的端到端编排语义。
 *
 * 运行：cd packages/runtime && npx vitest run src/transport/resources-message-handler.test.ts
 */
import { describe, it, expect, vi } from 'vitest'
import type { WebSocket as WsType } from 'ws'
import { ResourcesMessageHandler } from './resources-message-handler.js'
import type { SettingsHandlerContext } from './settings-message-handler.js'
import type { ClientMessage } from '@taiji/shared'

function mockWs(): WsType {
  return { send: vi.fn(), readyState: 1 } as unknown as WsType
}

function mockContext() {
  const skillRegistry = {
    rebuildGlobal: vi.fn(),
    invalidateAllProjects: vi.fn(),
    getProjectSkills: vi.fn(async () => [] as Array<{ id: string }>),
  }
  const ctx = {
    projectRoot: '/project',
    configService: { setSkillDirs: vi.fn() },
    skillRegistry,
    reply: vi.fn(),
    broadcastSkillList: vi.fn(),
    broadcastSkillDirs: vi.fn(),
    broadcastSkillCacheInvalidated: vi.fn(),
    broadcastAgentList: vi.fn(),
  }
  return { ctx: ctx as unknown as SettingsHandlerContext, skillRegistry }
}

function msg(type: string, payload: Record<string, unknown> = {}, id = 'msg-1'): ClientMessage {
  return { type, payload, id } as unknown as ClientMessage
}

describe('ResourcesMessageHandler config.setSkillDirs 失效编排（缓存治理 1-5）', () => {
  it('操作后缓存失效：rebuildGlobal 失败分支同样调 invalidateAllProjects + 广播失效', async () => {
    const { ctx, skillRegistry } = mockContext()
    skillRegistry.rebuildGlobal.mockRejectedValue(new Error('rebuild failed'))
    const handler = new ResourcesMessageHandler(ctx)
    const ws = mockWs()

    await expect(handler.handle(msg('config.setSkillDirs', { dirs: ['/project/.agents/skills'] }), ws))
      .resolves.toBe(true)

    await vi.waitFor(() => expect(skillRegistry.invalidateAllProjects).toHaveBeenCalledTimes(1))
    expect(ctx.broadcastSkillCacheInvalidated).toHaveBeenCalledWith('project')
    // 失败不阻塞 WS 消息处理：reply 正常发出
    expect(ctx.reply).toHaveBeenCalled()
  })

  it('下次读为新值：失败失效后 getProjectSkills 读到重扫值（旧值 → 失效 → 新值）', async () => {
    const { ctx, skillRegistry } = mockContext()
    skillRegistry.rebuildGlobal.mockRejectedValue(new Error('rebuild failed'))
    skillRegistry.getProjectSkills
      .mockResolvedValueOnce([{ id: 'old-skill' }]) // 失效前读：旧缓存
      .mockResolvedValueOnce([{ id: 'new-skill' }]) // 失效后读：重扫新值
    const handler = new ResourcesMessageHandler(ctx)
    const ws = mockWs()

    // 操作前：projectCache 持旧值
    await handler.handle(msg('config.getProjectSkills', { cwd: '/project' }), ws)
    expect(ctx.reply).toHaveBeenCalledWith(
      ws,
      'msg-1',
      'config.projectSkills',
      { skills: [{ id: 'old-skill' }] },
    )

    // 操作（目录管道写入，rebuild 失败）：失败分支清 projectCache
    await handler.handle(msg('config.setSkillDirs', { dirs: ['/project/.agents/skills'] }), ws)
    await vi.waitFor(() => expect(skillRegistry.invalidateAllProjects).toHaveBeenCalledTimes(1))

    // 操作后：下次读为新值（invalidate 清缓存 → getProjectSkills 重扫）
    await handler.handle(msg('config.getProjectSkills', { cwd: '/project' }), ws)
    expect(ctx.reply).toHaveBeenLastCalledWith(
      ws,
      'msg-1',
      'config.projectSkills',
      { skills: [{ id: 'new-skill' }] },
    )
  })

  it('成功路径不回归：invalidate + broadcast 照旧', async () => {
    const { ctx, skillRegistry } = mockContext()
    skillRegistry.rebuildGlobal.mockResolvedValue(undefined)
    const handler = new ResourcesMessageHandler(ctx)
    const ws = mockWs()

    await handler.handle(msg('config.setSkillDirs', { dirs: ['/project/.agents/skills'] }), ws)

    await vi.waitFor(() => expect(skillRegistry.invalidateAllProjects).toHaveBeenCalledTimes(1))
    expect(ctx.broadcastSkillCacheInvalidated).toHaveBeenCalledWith('project')
    expect(ctx.broadcastSkillDirs).toHaveBeenCalled()
    expect(ctx.broadcastSkillList).toHaveBeenCalled()
  })
})
