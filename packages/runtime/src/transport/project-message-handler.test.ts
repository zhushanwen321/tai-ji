/**
 * ProjectMessageHandler 测试（PR #175 R1 S-12：D14 handler 补直接测试；
 * 命令通道 connection-datasync-ssot §6.6/u6a 扩展）。
 *
 * 对齐 sibling 惯例（worktree-message-handler.test.ts 模式）：mock Context + 部分实现
 * ProjectStore（transport 零业务，只 ctx.reply / sendError / 广播，业务在 ProjectStore——
 * 见被测文件头注释）。命令通道的串行队列/归一化/revision 真行为在
 * services/project/project-store.test.ts（真 store + tmp 目录）；本文件锚定 handler 编排
 * 契约：回执形态 / 拒绝转 error envelope / project.changed 广播时机 / 并发到达端到端保序。
 *
 * 核心契约锚点：「失败不悬挂」——命令拒绝走 error envelope（pending reject），与 load
 * 恒 reply 同属 RPC 契约：任何请求不得静默吞掉（前端 Promise 永不 resolve / 永不 reject）。
 * legacy 整表写端点已随命令化拆除（§6.6③），本文件不再覆盖其校验分支。
 *
 * 测试框架：vitest（从 vitest 导入 describe/it/expect/vi）。
 * 运行命令：cd packages/runtime && npx vitest run src/transport/project-message-handler.test.ts
 */
import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { WebSocket as WsType } from 'ws'
import { ProjectMessageHandler, type ProjectHandlerContext } from './project-message-handler.js'
import { ProjectStore, ProjectCommandError } from '../services/project/project-store.js'
import type { ProjectStore as ProjectStoreType } from '../services/project/project-store.js'
import type { ClientMessage, ProjectCommandReply, ProjectStoreState } from '@taiji/shared'

// ── mock helpers ─────────────────────────────────────────────

function mockWs(): WsType {
  return { send: vi.fn(), readyState: 1 } as unknown as WsType
}

/** store.load() 返回的全量状态（模拟磁盘现状；命令 mock 不改返回值）。 */
const diskState: ProjectStoreState = {
  projects: [{ id: 'proj-1', name: 'demo', lastUsedAt: 100 }],
  activeProjectId: 'proj-1',
}

/**
 * 部分实现 mock：handler 只调 load/getRevision 与四命令入口，全接口 mock 无断言价值
 * （与 worktree-message-handler.test.ts 的 mockGitService 同策略）。
 */
function mockProjectStore() {
  return {
    load: vi.fn((): ProjectStoreState => diskState),
    getRevision: vi.fn((): number => 0),
  }
}

function mockContext(overrides?: Partial<ProjectHandlerContext>): ProjectHandlerContext {
  return {
    send: vi.fn(),
    sendError: vi.fn(),
    reply: vi.fn(),
    projectStore: mockProjectStore() as unknown as ProjectStoreType,
    broadcastProjectChanged: vi.fn(),
    ...overrides,
  }
}

/**
 * 构造 ClientMessage（payload 用 unknown：校验失败分支需传入不合法结构，
 * 经 as unknown 收窄绕过 protocol payload 类型，被测的正是运行时结构校验）。
 */
function msg(
  type:
    | 'project.load'
    | 'project.createProject'
    | 'project.renameProject'
    | 'project.removeProject'
    | 'project.setActiveProject',
  payload: unknown,
  id = 'msg-1',
): ClientMessage {
  return { type, payload, id } as unknown as ClientMessage
}

/** 真 store + tmp 目录（命令通道并发/端到端用例；fs-guard 白名单 = tmpdir 自建自删）。 */
function realStore(): { store: ProjectStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'u6a-handler-'))
  return { store: new ProjectStore(dir), dir }
}

// ── handles 清单 ────────────────────────────────────────────

describe('ProjectMessageHandler.handles', () => {
  it('认领 load 与四写命令（§6.6；legacy 整表写端点已拆除）', () => {
    const handler = new ProjectMessageHandler(mockContext())
    expect(handler.handles).toEqual([
      'project.load',
      'project.createProject',
      'project.renameProject',
      'project.removeProject',
      'project.setActiveProject',
    ])
  })
})

// ── project.load ────────────────────────────────────────────

describe('ProjectMessageHandler project.load', () => {
  it('reply project.loaded 携带 store.load() 全量 + revision，不触发 sendError / 广播', async () => {
    const ctx = mockContext()
    const handler = new ProjectMessageHandler(ctx)
    const ws = mockWs()

    await handler.handleProjectMessage(msg('project.load', {}), ws)

    expect(ctx.projectStore.load).toHaveBeenCalledTimes(1)
    expect(ctx.reply).toHaveBeenCalledWith(ws, 'msg-1', 'project.loaded', { ...diskState, revision: 0 })
    expect(ctx.sendError).not.toHaveBeenCalled()
    expect(ctx.broadcastProjectChanged).not.toHaveBeenCalled()
  })

  it('reply 携带请求原 id（多请求并发时不串线）', async () => {
    const ctx = mockContext()
    const handler = new ProjectMessageHandler(ctx)
    const ws = mockWs()

    await handler.handleProjectMessage(msg('project.load', {}, 'msg-42'), ws)

    expect(ctx.reply).toHaveBeenCalledWith(ws, 'msg-42', 'project.loaded', { ...diskState, revision: 0 })
  })
})

// ── 命令通道（§6.6/u6a）：回执 / 拒绝 / project.changed 广播 ──────────

describe('ProjectMessageHandler 命令通道成功路径（mock store）', () => {
  const commandReply: ProjectCommandReply = {
    state: {
      projects: [
        { id: 'proj-default', name: '', lastUsedAt: 0 },
        { id: 'proj-1', name: 'demo', lastUsedAt: 100 },
      ],
      activeProjectId: 'proj-1',
    },
    revision: 1,
  }

  function commandContext(method: keyof ProjectStore) {
    const store = mockProjectStore()
    Object.assign(store, {
      [method]: vi.fn(() => Promise.resolve(commandReply)),
    })
    const ctx = mockContext({ projectStore: store as unknown as ProjectStoreType })
    return { ctx, store }
  }

  it.each([
    ['project.createProject', 'createProject', { name: 'demo', revision: 0 }, ['demo', 0]] as const,
    [
      'project.renameProject',
      'renameProject',
      { projectId: 'proj-1', name: 'renamed', revision: 0 },
      ['proj-1', 'renamed', 0],
    ] as const,
    ['project.removeProject', 'removeProject', { projectId: 'proj-1', revision: 0 }, ['proj-1', 0]] as const,
    [
      'project.setActiveProject',
      'setActiveProject',
      { projectId: 'proj-1', revision: 0 },
      ['proj-1', 0],
    ] as const,
  ])('%s：回执同名 type + 完整新状态与 revision 新值，并广播 project.changed', async (type, method, payload, args) => {
    const { ctx, store } = commandContext(method as keyof ProjectStore)
    const handler = new ProjectMessageHandler(ctx)
    const ws = mockWs()

    await handler.handleProjectMessage(msg(type, payload), ws)

    expect(store[method as keyof typeof store]).toHaveBeenCalledWith(...args)
    // reply type 与 request 同名（payload 消费型同名模式），payload = ProjectCommandReply 原样
    expect(ctx.reply).toHaveBeenCalledTimes(1)
    expect(ctx.reply).toHaveBeenCalledWith(ws, 'msg-1', type, commandReply)
    // 失效信号：revision = 执行后新值
    expect(ctx.broadcastProjectChanged).toHaveBeenCalledTimes(1)
    expect(ctx.broadcastProjectChanged).toHaveBeenCalledWith(commandReply.revision)
    expect(ctx.sendError).not.toHaveBeenCalled()
  })
})

describe('ProjectMessageHandler 命令通道拒绝（ProjectCommandError → error envelope）', () => {
  it('revision 失配：sendError 携带 code + 请求 id，不 reply、不广播（pending reject，不悬挂）', async () => {
    const store = mockProjectStore()
    Object.assign(store, {
      setActiveProject: vi.fn(() =>
        Promise.reject(
          new ProjectCommandError(
            'project_revision_mismatch',
            'revision 失配：当前 1，命令携带 0——重新 project.load 取最新状态与 revision 后重试',
          ),
        ),
      ),
    })
    const ctx = mockContext({ projectStore: store as unknown as ProjectStoreType })
    const handler = new ProjectMessageHandler(ctx)
    const ws = mockWs()

    await handler.handleProjectMessage(msg('project.setActiveProject', { projectId: 'x', revision: 0 }, 'cmd-9'), ws)

    expect(ctx.sendError).toHaveBeenCalledTimes(1)
    expect(ctx.sendError).toHaveBeenCalledWith(
      ws,
      'project_revision_mismatch',
      expect.stringContaining('revision 失配'),
      'cmd-9',
    )
    expect(ctx.reply).not.toHaveBeenCalled()
    expect(ctx.broadcastProjectChanged).not.toHaveBeenCalled()
  })

  it('语义拒绝（默认项保护/不存在/空名）同样走 error envelope，code 透传', async () => {
    const store = mockProjectStore()
    Object.assign(store, {
      removeProject: vi.fn(() =>
        Promise.reject(new ProjectCommandError('project_default_protected', '默认项目不可删除（未归类会话的兜底聚合）')),
      ),
    })
    const ctx = mockContext({ projectStore: store as unknown as ProjectStoreType })
    const handler = new ProjectMessageHandler(ctx)
    const ws = mockWs()

    await handler.handleProjectMessage(
      msg('project.removeProject', { projectId: 'proj-default', revision: 0 }),
      ws,
    )

    expect(ctx.sendError).toHaveBeenCalledWith(
      ws,
      'project_default_protected',
      expect.any(String),
      'msg-1',
    )
    expect(ctx.broadcastProjectChanged).not.toHaveBeenCalled()
  })

  it('非 ProjectCommandError 的意外异常向上抛（上层 handler_error 兜底，不伪装成命令拒绝）', async () => {
    const store = mockProjectStore()
    Object.assign(store, {
      createProject: vi.fn(() => Promise.reject(new Error('unexpected disk failure'))),
    })
    const ctx = mockContext({ projectStore: store as unknown as ProjectStoreType })
    const handler = new ProjectMessageHandler(ctx)
    const ws = mockWs()

    await expect(
      handler.handleProjectMessage(msg('project.createProject', { name: 'x', revision: 0 }), ws),
    ).rejects.toThrow('unexpected disk failure')
    expect(ctx.sendError).not.toHaveBeenCalled()
    expect(ctx.reply).not.toHaveBeenCalled()
    expect(ctx.broadcastProjectChanged).not.toHaveBeenCalled()
  })
})

describe('ProjectMessageHandler 命令通道并发到达（真 store + 串行队列端到端）', () => {
  it('两条命令并发 fire（不依序 await）→ 依到达顺序串行执行，回执 revision 连续递增', async () => {
    const { store } = realStore()
    const ctx = mockContext({ projectStore: store })
    const handler = new ProjectMessageHandler(ctx)
    const ws = mockWs()

    // 受控 promise 构造：Promise.all 并发派发（第一条未 await 即发第二条——模拟消息
    // 异步 fire-and-forget 到达）；第二条携带 revision=1（= 第一条执行后的值），只有
    // 第一条已完整执行它才可能通过校验——成功即证明串行时序。
    const first = handler.handleProjectMessage(msg('project.createProject', { name: 'A', revision: 0 }, 'cmd-a'), ws)
    const second = handler.handleProjectMessage(msg('project.createProject', { name: 'B', revision: 1 }, 'cmd-b'), ws)
    await Promise.all([first, second])

    const replies = (ctx.reply as ReturnType<typeof vi.fn>).mock.calls
    expect(replies).toHaveLength(2)
    // reply 顺序 = 到达顺序（cmd-a 先于 cmd-b），revision 依次 1、2
    expect(replies[0][2]).toBe('project.createProject')
    expect(replies[1][2]).toBe('project.createProject')
    const replyA = replies[0][3] as ProjectCommandReply
    const replyB = replies[1][3] as ProjectCommandReply
    expect(replyA.revision).toBe(1)
    expect(replyB.revision).toBe(2)
    // 第二条看到第一条的完整效果（A、B 均在，B 为活跃）
    expect(replyB.state.projects.map((p) => p.name)).toContain('A')
    expect(replyB.state.projects.map((p) => p.name)).toContain('B')
    expect(replyB.state.activeProjectId).toBe(replyB.state.projects.find((p) => p.name === 'B')?.id)
    // 广播与命令一一对应（失效信号每条命令一次）
    expect(ctx.broadcastProjectChanged).toHaveBeenCalledTimes(2)
    store.flushAll()
  })

  it('并发到达时第二条 revision 基于旧水位 → 第一条执行后按新水位拒绝（过时窗口保护端到端）', async () => {
    const { store } = realStore()
    const ctx = mockContext({ projectStore: store })
    const handler = new ProjectMessageHandler(ctx)
    const ws = mockWs()

    const first = handler.handleProjectMessage(msg('project.createProject', { name: 'A', revision: 0 }, 'cmd-a'), ws)
    // 第二条携带过时 revision=0（窗口内并发双写形态）→ 排队执行时校验失败
    const second = handler.handleProjectMessage(msg('project.createProject', { name: 'B', revision: 0 }, 'cmd-b'), ws)
    await Promise.all([first, second])

    expect(ctx.reply).toHaveBeenCalledTimes(1)
    expect(ctx.sendError).toHaveBeenCalledWith(
      ws,
      'project_revision_mismatch',
      expect.stringContaining('revision 失配'),
      'cmd-b',
    )
    // 拒绝不广播失效信号
    expect(ctx.broadcastProjectChanged).toHaveBeenCalledTimes(1)
    store.flushAll()
  })
})
