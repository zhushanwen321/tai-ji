/**
 * WorkspaceMessageHandler 测试：workspace.record 触发默认远端 prefetch 的接线
 *（打开仓库预热，fire-and-forget 不阻塞 reply）。
 *
 * 运行命令：cd packages/runtime && npx vitest run src/transport/workspace-message-handler.test.ts
 */
import { describe, it, expect, vi } from 'vitest'
import { WorkspaceMessageHandler, type WorkspaceHandlerContext } from './workspace-message-handler.js'
import type { ClientMessage } from '@taiji/shared'

function mockCtx(worktreeService?: WorkspaceHandlerContext['worktreeService']): WorkspaceHandlerContext {
  return {
    send: vi.fn(),
    sendError: vi.fn(),
    reply: vi.fn(),
    workspaceService: { record: vi.fn(), list: vi.fn(() => []), setPinned: vi.fn(() => true), defaultSessionDir: vi.fn(() => '/ds') },
    worktreeService,
  } as unknown as WorkspaceHandlerContext
}

function msg(type: string, payload: Record<string, unknown> = {}, id = 'msg-1'): ClientMessage {
  return { type, payload, id } as unknown as ClientMessage
}

describe('WorkspaceMessageHandler workspace.record → prefetch', () => {
  it('record 有效 cwd → fire-and-forget 触发 prefetchDefaultRemote(cwd) + reply 正常', async () => {
    const prefetch = vi.fn(async () => undefined)
    const ctx = mockCtx({ prefetchDefaultRemote: prefetch } as unknown as WorkspaceHandlerContext['worktreeService'])
    const handler = new WorkspaceMessageHandler(ctx)

    await handler.handleWorkspaceMessage(msg('workspace.record', { cwd: '/project' }), {} as never)

    expect(ctx.workspaceService.record).toHaveBeenCalledWith('/project')
    expect(prefetch).toHaveBeenCalledWith('/project')
    expect(ctx.reply).toHaveBeenCalledTimes(1)
  })

  it('worktreeService 未注入（null）→ 跳过 prefetch，reply 不受影响', async () => {
    const ctx = mockCtx(null)
    const handler = new WorkspaceMessageHandler(ctx)

    await handler.handleWorkspaceMessage(msg('workspace.record', { cwd: '/project' }), {} as never)

    expect(ctx.workspaceService.record).toHaveBeenCalledWith('/project')
    expect(ctx.reply).toHaveBeenCalledTimes(1)
  })

  it('非法 cwd（空串）→ degraded reply，不 record 不 prefetch', async () => {
    const prefetch = vi.fn(async () => undefined)
    const ctx = mockCtx({ prefetchDefaultRemote: prefetch } as unknown as WorkspaceHandlerContext['worktreeService'])
    const handler = new WorkspaceMessageHandler(ctx)

    await handler.handleWorkspaceMessage(msg('workspace.record', { cwd: '' }), {} as never)

    expect(ctx.workspaceService.record).not.toHaveBeenCalled()
    expect(prefetch).not.toHaveBeenCalled()
    expect(ctx.reply).toHaveBeenCalledWith(
      expect.anything(), 'msg-1', 'workspace.recentList',
      expect.objectContaining({ degraded: true }),
    )
  })
})

describe('WorkspaceMessageHandler pin / defaultSessionDir', () => {
  it('setPinned 生效 → reply 最新列表（无 degraded）', async () => {
    const ctx = mockCtx()
    const handler = new WorkspaceMessageHandler(ctx)

    await handler.handleWorkspaceMessage(msg('workspace.setPinned', { cwd: '/project', pinned: true }), {} as never)

    expect(ctx.workspaceService.setPinned).toHaveBeenCalledWith('/project', true)
    expect(ctx.reply).toHaveBeenCalledWith(
      expect.anything(), 'msg-1', 'workspace.recentList',
      expect.objectContaining({ degraded: false }),
    )
  })

  it('setPinned 被拒（超 pin 上限）→ degraded reply', async () => {
    const ctx = mockCtx()
    ;(ctx.workspaceService.setPinned as ReturnType<typeof vi.fn>).mockReturnValue(false)
    const handler = new WorkspaceMessageHandler(ctx)

    await handler.handleWorkspaceMessage(msg('workspace.setPinned', { cwd: '/project', pinned: true }), {} as never)

    expect(ctx.reply).toHaveBeenCalledWith(
      expect.anything(), 'msg-1', 'workspace.recentList',
      expect.objectContaining({ degraded: true }),
    )
  })

  it('setPinned 非法 payload → degraded reply，不调 service', async () => {
    const ctx = mockCtx()
    const handler = new WorkspaceMessageHandler(ctx)

    await handler.handleWorkspaceMessage(msg('workspace.setPinned', { cwd: '', pinned: 'yes' }), {} as never)

    expect(ctx.workspaceService.setPinned).not.toHaveBeenCalled()
    expect(ctx.reply).toHaveBeenCalledWith(
      expect.anything(), 'msg-1', 'workspace.recentList',
      expect.objectContaining({ degraded: true }),
    )
  })

  it('defaultSessionDir → reply dir（service 返回值直传）', async () => {
    const ctx = mockCtx()
    const handler = new WorkspaceMessageHandler(ctx)

    await handler.handleWorkspaceMessage(msg('workspace.defaultSessionDir'), {} as never)

    expect(ctx.workspaceService.defaultSessionDir).toHaveBeenCalled()
    expect(ctx.reply).toHaveBeenCalledWith(
      expect.anything(), 'msg-1', 'workspace.defaultSessionDir:result', { dir: '/ds' },
    )
  })
})
