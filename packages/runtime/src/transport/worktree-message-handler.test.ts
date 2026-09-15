/**
 * WorktreeMessageHandler 测试（W2：新增消息路由）。
 *
 * 测试框架：vitest（从 vitest 导入 describe/it/expect/vi/beforeEach）。
 * 运行命令：cd packages/runtime && npx vitest run src/services/worktree/worktree-message-handler.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { WorktreeMessageHandler, type WorktreeHandlerContext } from './worktree-message-handler.js'
import type { IGitService } from '../interfaces.js'
import type { ClientMessage } from '@taiji/shared'

// ── mock helpers ─────────────────────────────────────────────

function mockWs() {
  return { send: vi.fn(), readyState: 1 } as any
}

/**
 * 部分实现 mock（只含被测行为依赖的失效入口）：worktree handler 仅调
 * invalidateStatusCache（perf 03 §5 worktree 检查点闭环），全接口 mock 无断言价值。
 */
function mockGitService() {
  return { invalidateStatusCache: vi.fn() }
}

function mockContext(overrides?: Partial<WorktreeHandlerContext>): WorktreeHandlerContext {
  return {
    send: vi.fn(),
    sendError: vi.fn(),
    reply: vi.fn(),
    gitService: mockGitService() as unknown as IGitService,
    worktreeService: {
      create: vi.fn(async () => ({ cwd: '/project/feat-x', branch: 'feat/x' })),
      detect: vi.fn(async () => ({
        mode: 'bare-workspace' as const,
        wsRoot: '/project',
        barePath: '/project/.bare',
        repoRoot: '/project',
        defaultBranch: 'main',
      })),
      listBranches: vi.fn(async () => ({
        local: ['main', 'feat-x'],
        remote: ['origin/main', 'origin/feat-y'],
        defaultBranch: 'main',
      })),
      list: vi.fn(async () => ({
        items: [
          { path: '/project', branch: 'main', HEAD: true, bare: false },
          { path: '/project/feat-x', branch: 'feat-x', HEAD: false, bare: false },
        ],
      })),
    },
    ...overrides,
  }
}

function msg(type: string, payload: Record<string, unknown> = {}, id = 'msg-1'): ClientMessage {
  return { type, payload, id } as unknown as ClientMessage
}

// ── handles 清单 ────────────────────────────────────────────

describe('WorktreeMessageHandler.handles', () => {
  it('认领 worktree.create', () => {
    const handler = new WorktreeMessageHandler(mockContext())
    expect(handler.handles).toContain('worktree.create')
  })

  it('认领 worktree.listBranches', () => {
    const handler = new WorktreeMessageHandler(mockContext())
    expect(handler.handles).toContain('worktree.listBranches')
  })

  it('认领 worktree.list', () => {
    const handler = new WorktreeMessageHandler(mockContext())
    expect(handler.handles).toContain('worktree.list')
  })

  it('认领 workspace.detect', () => {
    const handler = new WorktreeMessageHandler(mockContext())
    expect(handler.handles).toContain('workspace.detect')
  })

  it('认领 workspace.detectBare', () => {
    const handler = new WorktreeMessageHandler(mockContext())
    expect(handler.handles).toContain('workspace.detectBare')
  })
})

// ── worktree.create ─────────────────────────────────────────

describe('WorktreeMessageHandler worktree.create', () => {
  it('成功时 reply worktree.created', async () => {
    const ctx = mockContext()
    const handler = new WorktreeMessageHandler(ctx)
    const ws = mockWs()

    await handler.handleWorktreeMessage(
      msg('worktree.create', { branch: 'feat/x', baseBranch: 'origin/main', workspaceHint: '/project' }),
      ws,
    )

    expect(ctx.worktreeService.create).toHaveBeenCalledWith({
      branch: 'feat/x',
      baseBranch: 'origin/main',
      workspaceHint: '/project',
    })
    expect(ctx.reply).toHaveBeenCalledWith(ws, 'msg-1', 'worktree.created', {
      cwd: '/project/feat-x',
      branch: 'feat/x',
    })
  })

  it('失败时 sendError 透传错误码', async () => {
    const ctx = mockContext()
    ctx.worktreeService.create = vi.fn(async () => {
      throw Object.assign(new Error('worktree 已存在'), { code: 'WORKTREE_EXISTS', detail: { cwd: '/x', dirName: 'x' } })
    })
    const handler = new WorktreeMessageHandler(ctx)
    const ws = mockWs()

    await handler.handleWorktreeMessage(
      msg('worktree.create', { branch: 'existing' }),
      ws,
    )

    expect(ctx.sendError).toHaveBeenCalledWith(
      ws,
      'WORKTREE_EXISTS',
      'worktree 已存在',
      'msg-1',
      expect.objectContaining({ detail: expect.anything() }),
    )
  })

  it('无 code 的错误归为 worktree_failed', async () => {
    const ctx = mockContext()
    ctx.worktreeService.create = vi.fn(async () => { throw new Error('unexpected') })
    const handler = new WorktreeMessageHandler(ctx)
    const ws = mockWs()

    await handler.handleWorktreeMessage(
      msg('worktree.create', { branch: 'feat/test' }),
      ws,
    )

    expect(ctx.sendError).toHaveBeenCalledWith(
      ws,
      'worktree_failed',
      'unexpected',
      'msg-1',
      undefined,
    )
  })
})

// ── worktree.create 写操作失效（perf 03 §5 检查点闭环，2026-08-17）──

describe('WorktreeMessageHandler worktree.create 写操作失效', () => {
  it('成功后按 payload.workspaceHint 调 invalidateStatusCache，且在 reply 之前', async () => {
    const gitService = mockGitService()
    // 持有 reply 原始 mock（ctx 类型里 reply 是具体签名，.mock 不可达）——「失效在 reply 前」
    // 用 vitest mock 的 invocationCallOrder 全局单调序断言失效先于 reply 发生
    const reply = vi.fn()
    const ctx = mockContext({
      gitService: gitService as unknown as IGitService,
      reply: reply as unknown as WorktreeHandlerContext['reply'],
    })
    const handler = new WorktreeMessageHandler(ctx)
    const ws = mockWs()

    await handler.handleWorktreeMessage(
      msg('worktree.create', { branch: 'feat/x', workspaceHint: '/project' }),
      ws,
    )

    // 失效调用真实发生，且目标 cwd = 发起请求的 cwd（workspaceHint）
    expect(gitService.invalidateStatusCache).toHaveBeenCalledTimes(1)
    expect(gitService.invalidateStatusCache).toHaveBeenCalledWith({ cwd: '/project' })
    expect(reply).toHaveBeenCalledWith(ws, 'msg-1', 'worktree.created', {
      cwd: '/project/feat-x',
      branch: 'feat/x',
    })
    // 语义对齐 U2 六写操作：reply 前失效（前端收到 ack 后可能立即刷新 git zone）
    const invalidateOrder = gitService.invalidateStatusCache.mock.invocationCallOrder[0]
    const replyOrder = reply.mock.invocationCallOrder[0]
    expect(invalidateOrder).toBeDefined()
    expect(replyOrder).toBeDefined()
    expect(invalidateOrder).toBeLessThan(replyOrder)
  })

  it('成功且 payload 无 workspaceHint → 按 process.cwd() 失效（与 service.detect 起点同式）', async () => {
    const gitService = mockGitService()
    const ctx = mockContext({ gitService: gitService as unknown as IGitService })
    const handler = new WorktreeMessageHandler(ctx)
    const ws = mockWs()

    await handler.handleWorktreeMessage(
      msg('worktree.create', { branch: 'feat/x' }),
      ws,
    )

    expect(gitService.invalidateStatusCache).toHaveBeenCalledWith({ cwd: process.cwd() })
  })

  it('create 失败 → 不失效（状态未变）', async () => {
    const gitService = mockGitService()
    const ctx = mockContext({ gitService: gitService as unknown as IGitService })
    ctx.worktreeService.create = vi.fn(async () => {
      throw Object.assign(new Error('git worktree add 失败'), { code: 'GIT_FAILED' })
    })
    const handler = new WorktreeMessageHandler(ctx)
    const ws = mockWs()

    await handler.handleWorktreeMessage(
      msg('worktree.create', { branch: 'feat/x', workspaceHint: '/project' }),
      ws,
    )

    expect(gitService.invalidateStatusCache).not.toHaveBeenCalled()
    expect(ctx.reply).not.toHaveBeenCalled()
    expect(ctx.sendError).toHaveBeenCalledTimes(1)
  })

  it('gitService 为 null（server 未注入，防御场景）→ 成功路径跳过失效且不抛错', async () => {
    const ctx = mockContext({ gitService: null })
    const handler = new WorktreeMessageHandler(ctx)
    const ws = mockWs()

    await expect(handler.handleWorktreeMessage(
      msg('worktree.create', { branch: 'feat/x', workspaceHint: '/project' }),
      ws,
    )).resolves.toBeUndefined()

    expect(ctx.reply).toHaveBeenCalledWith(ws, 'msg-1', 'worktree.created', {
      cwd: '/project/feat-x',
      branch: 'feat/x',
    })
  })
})

// ── worktree.listBranches ───────────────────────────────────

describe('WorktreeMessageHandler worktree.listBranches', () => {
  it('成功时 reply worktree.branches', async () => {
    const ctx = mockContext()
    const handler = new WorktreeMessageHandler(ctx)
    const ws = mockWs()

    await handler.handleWorktreeMessage(msg('worktree.listBranches', { cwd: '/project' }), ws)

    expect(ctx.worktreeService.listBranches).toHaveBeenCalledWith('/project')
    expect(ctx.reply).toHaveBeenCalledWith(ws, 'msg-1', 'worktree.branches', {
      local: ['main', 'feat-x'],
      remote: ['origin/main', 'origin/feat-y'],
      defaultBranch: 'main',
    })
  })

  it('失败时 sendError', async () => {
    const ctx = mockContext()
    ctx.worktreeService.listBranches = vi.fn(async () => {
      throw Object.assign(new Error('not repo'), { code: 'NOT_GIT_REPO' })
    })
    const handler = new WorktreeMessageHandler(ctx)
    const ws = mockWs()

    await handler.handleWorktreeMessage(msg('worktree.listBranches', { cwd: '/tmp' }), ws)

    expect(ctx.sendError).toHaveBeenCalledWith(
      ws,
      'NOT_GIT_REPO',
      'not repo',
      'msg-1',
      undefined,
    )
  })
})

// ── worktree.list ───────────────────────────────────────────

describe('WorktreeMessageHandler worktree.list', () => {
  it('成功时 reply worktree.list:result', async () => {
    const ctx = mockContext()
    const handler = new WorktreeMessageHandler(ctx)
    const ws = mockWs()

    await handler.handleWorktreeMessage(msg('worktree.list', { cwd: '/project' }), ws)

    expect(ctx.worktreeService.list).toHaveBeenCalledWith('/project')
    expect(ctx.reply).toHaveBeenCalledWith(ws, 'msg-1', 'worktree.list:result', {
      items: [
        { path: '/project', branch: 'main', HEAD: true, bare: false },
        { path: '/project/feat-x', branch: 'feat-x', HEAD: false, bare: false },
      ],
    })
  })
})

// ── workspace.detect / workspace.detectBare ─────────────────

describe('WorktreeMessageHandler workspace.detect', () => {
  it('workspace.detect reply workspace.detected', async () => {
    const ctx = mockContext()
    const handler = new WorktreeMessageHandler(ctx)
    const ws = mockWs()

    await handler.handleWorktreeMessage(msg('workspace.detect', { cwd: '/project' }), ws)

    expect(ctx.worktreeService.detect).toHaveBeenCalledWith('/project')
    expect(ctx.reply).toHaveBeenCalledWith(ws, 'msg-1', 'workspace.detected', {
      mode: 'bare-workspace',
      wsRoot: '/project',
      barePath: '/project/.bare',
      repoRoot: '/project',
      defaultBranch: 'main',
    })
  })

  it('workspace.detectBare 别名等价于 workspace.detect', async () => {
    const ctx = mockContext()
    const handler = new WorktreeMessageHandler(ctx)
    const ws = mockWs()

    await handler.handleWorktreeMessage(msg('workspace.detectBare', { cwd: '/project' }), ws)

    expect(ctx.worktreeService.detect).toHaveBeenCalledWith('/project')
    expect(ctx.reply).toHaveBeenCalledWith(ws, 'msg-1', 'workspace.detected', expect.anything())
  })

  it('detect 失败时 sendError', async () => {
    const ctx = mockContext()
    ctx.worktreeService.detect = vi.fn(async () => {
      throw Object.assign(new Error('not repo'), { code: 'NOT_GIT_REPO' })
    })
    const handler = new WorktreeMessageHandler(ctx)
    const ws = mockWs()

    await handler.handleWorktreeMessage(msg('workspace.detect', { cwd: '/tmp' }), ws)

    expect(ctx.sendError).toHaveBeenCalledWith(
      ws,
      'NOT_GIT_REPO',
      'not repo',
      'msg-1',
      undefined,
    )
  })
})
