/**
 * ProjectMessageHandler 测试（PR #175 R1 S-12：D14 handler 补直接测试）。
 *
 * 对齐 sibling 惯例（worktree-message-handler.test.ts 模式）：mock Context + 部分实现
 * ProjectStore（transport 零业务，只 ctx.reply，业务在 ProjectStore——见被测文件头注释）。
 *
 * 核心契约锚定：「校验失败仍必须 reply（防前端 pending 悬挂）」——project.save 的
 * payload 结构不合法时不能静默吞掉请求（reply 契约破坏 = 前端 Promise 永不 resolve）。
 *
 * 测试框架：vitest（从 vitest 导入 describe/it/expect/vi）。
 * 运行命令：cd packages/runtime && npx vitest run src/transport/project-message-handler.test.ts
 */
import { describe, it, expect, vi } from 'vitest'
import type { WebSocket as WsType } from 'ws'
import { ProjectMessageHandler, type ProjectHandlerContext } from './project-message-handler.js'
import type { ProjectStore } from '../services/project/project-store.js'
import type { ClientMessage, ProjectStoreState } from '@taiji/shared'

// ── mock helpers ─────────────────────────────────────────────

function mockWs(): WsType {
  return { send: vi.fn(), readyState: 1 } as unknown as WsType
}

/** store.load() 返回的全量状态（模拟磁盘现状；save mock 不改返回值）。 */
const diskState: ProjectStoreState = {
  projects: [{ id: 'proj-1', name: 'demo', lastUsedAt: 100 }],
  activeProjectId: 'proj-1',
}

/**
 * 部分实现 mock：handler 只调 load/save 两个入口，全接口 mock 无断言价值
 * （与 worktree-message-handler.test.ts 的 mockGitService 同策略）。
 */
function mockProjectStore() {
  return {
    load: vi.fn((): ProjectStoreState => diskState),
    save: vi.fn(),
  }
}

function mockContext(overrides?: Partial<ProjectHandlerContext>): ProjectHandlerContext {
  return {
    send: vi.fn(),
    sendError: vi.fn(),
    reply: vi.fn(),
    projectStore: mockProjectStore() as unknown as ProjectStore,
    ...overrides,
  }
}

/**
 * 构造 ClientMessage（payload 用 unknown：校验失败分支需传入不合法结构，
 * 经 as unknown 收窄绕过 protocol payload 类型，被测的正是运行时结构校验）。
 */
function msg(type: 'project.load' | 'project.save', payload: unknown, id = 'msg-1'): ClientMessage {
  return { type, payload, id } as unknown as ClientMessage
}

// ── handles 清单 ────────────────────────────────────────────

describe('ProjectMessageHandler.handles', () => {
  it('认领 project.load 与 project.save（且仅这两个类型）', () => {
    const handler = new ProjectMessageHandler(mockContext())
    expect(handler.handles).toEqual(['project.load', 'project.save'])
  })
})

// ── project.load ────────────────────────────────────────────

describe('ProjectMessageHandler project.load', () => {
  it('reply project.loaded 携带 store.load() 全量，不触发 save / sendError', async () => {
    const ctx = mockContext()
    const handler = new ProjectMessageHandler(ctx)
    const ws = mockWs()

    await handler.handleProjectMessage(msg('project.load', {}), ws)

    expect(ctx.projectStore.load).toHaveBeenCalledTimes(1)
    expect(ctx.reply).toHaveBeenCalledWith(ws, 'msg-1', 'project.loaded', diskState)
    expect(ctx.projectStore.save).not.toHaveBeenCalled()
    expect(ctx.sendError).not.toHaveBeenCalled()
  })

  it('reply 携带请求原 id（多请求并发时不串线）', async () => {
    const ctx = mockContext()
    const handler = new ProjectMessageHandler(ctx)
    const ws = mockWs()

    await handler.handleProjectMessage(msg('project.load', {}, 'msg-42'), ws)

    expect(ctx.reply).toHaveBeenCalledWith(ws, 'msg-42', 'project.loaded', diskState)
  })
})

// ── project.save 成功路径 ────────────────────────────────────

describe('ProjectMessageHandler project.save 成功路径', () => {
  it('合法 payload → save(state) 后 reply project.loaded 携带 store.load() 最新值', async () => {
    const ctx = mockContext()
    const handler = new ProjectMessageHandler(ctx)
    const ws = mockWs()
    const incoming: ProjectStoreState = {
      projects: [{ id: 'p2', name: 'new', lastUsedAt: 1 }],
      activeProjectId: 'p2',
    }

    await handler.handleProjectMessage(msg('project.save', incoming), ws)

    expect(ctx.projectStore.save).toHaveBeenCalledWith(incoming)
    expect(ctx.reply).toHaveBeenCalledWith(ws, 'msg-1', 'project.loaded', diskState)
    expect(ctx.sendError).not.toHaveBeenCalled()
  })

  it('reply 的 payload 取自 save 之后的 load()（save → load → reply 顺序）', async () => {
    const store = mockProjectStore()
    // 持有原始 mock（ctx 类型里 load/save 是具体签名，.mock 不可达）——用
    // invocationCallOrder 全局单调序断言 reply 反映的是保存后的 store 状态
    const reply = vi.fn()
    const ctx = mockContext({
      projectStore: store as unknown as ProjectStore,
      reply: reply as unknown as ProjectHandlerContext['reply'],
    })
    const handler = new ProjectMessageHandler(ctx)
    const ws = mockWs()

    await handler.handleProjectMessage(
      msg('project.save', { projects: [], activeProjectId: '' }),
      ws,
    )

    const saveOrder = store.save.mock.invocationCallOrder[0]
    const loadOrder = store.load.mock.invocationCallOrder[0]
    const replyOrder = reply.mock.invocationCallOrder[0]
    expect(saveOrder).toBeDefined()
    expect(loadOrder).toBeDefined()
    expect(replyOrder).toBeDefined()
    expect(saveOrder).toBeLessThan(loadOrder)
    expect(loadOrder).toBeLessThan(replyOrder)
  })

  it('空 projects 数组是合法 payload（清空所有 project 的语义走 save，不被结构校验拦截）', async () => {
    const ctx = mockContext()
    const handler = new ProjectMessageHandler(ctx)
    const ws = mockWs()

    await handler.handleProjectMessage(msg('project.save', { projects: [], activeProjectId: '' }), ws)

    expect(ctx.projectStore.save).toHaveBeenCalledTimes(1)
    expect(ctx.reply).toHaveBeenCalledTimes(1)
  })
})

// ── 校验失败仍必须 reply（防前端 pending 悬挂，核心契约）─────────

describe('ProjectMessageHandler project.save 校验失败仍必须 reply', () => {
  it('payload 为 null → 不 save，但 reply project.loaded 兜底当前 store 状态（不走 sendError）', async () => {
    const ctx = mockContext()
    const handler = new ProjectMessageHandler(ctx)
    const ws = mockWs()

    await handler.handleProjectMessage(msg('project.save', null), ws)

    // 契约：校验失败不能静默——不 reply 则前端 pending Promise 永不 resolve
    expect(ctx.projectStore.save).not.toHaveBeenCalled()
    expect(ctx.reply).toHaveBeenCalledTimes(1)
    expect(ctx.reply).toHaveBeenCalledWith(ws, 'msg-1', 'project.loaded', diskState)
    expect(ctx.sendError).not.toHaveBeenCalled()
  })

  it('payload.projects 非数组（对象）→ 不 save，reply 兜底（结构校验拒绝非数组形态）', async () => {
    const ctx = mockContext()
    const handler = new ProjectMessageHandler(ctx)
    const ws = mockWs()

    await handler.handleProjectMessage(
      msg('project.save', { projects: { 'proj-1': {} }, activeProjectId: 'proj-1' }),
      ws,
    )

    expect(ctx.projectStore.save).not.toHaveBeenCalled()
    expect(ctx.reply).toHaveBeenCalledWith(ws, 'msg-1', 'project.loaded', diskState)
  })

  it('payload.projects 为字符串 → 不 save，reply 兜底', async () => {
    const ctx = mockContext()
    const handler = new ProjectMessageHandler(ctx)
    const ws = mockWs()

    await handler.handleProjectMessage(msg('project.save', { projects: 'proj-1' }), ws)

    expect(ctx.projectStore.save).not.toHaveBeenCalled()
    expect(ctx.reply).toHaveBeenCalledTimes(1)
  })

  it('payload 缺 projects 字段 → 不 save，reply 兜底', async () => {
    const ctx = mockContext()
    const handler = new ProjectMessageHandler(ctx)
    const ws = mockWs()

    await handler.handleProjectMessage(msg('project.save', { activeProjectId: 'x' }), ws)

    expect(ctx.projectStore.save).not.toHaveBeenCalled()
    expect(ctx.reply).toHaveBeenCalledTimes(1)
  })
})
