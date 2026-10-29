import type { IGitService } from '../interfaces.js';
import { McpServersService } from '../services/mcp-servers-service.js';
import { attachSupportedLevels } from '../services/model-capability.js';
import type { IMcpServers } from '../services/ports/mcp-servers.js';
import type { ITerminalService } from '../services/ports/terminal-service.js';
import type { UsageStatsService } from '../services/usage/usage-stats-service.js';
import { SESSION_NOT_ACTIVE, errorWithCode } from '../utils/errors.js';
import { TEST_WS as WS_z2, sendConfigGet } from './__tests__/helpers/settings-handler-send.js';
import { ConnectionManager } from './connection-manager.js';
import { ClientPool, ServerMessageBroker, type BrokerServices } from './message-broker.js';
import { ResourcesMessageHandler } from './resources-message-handler.js';
import { SettingsMessageHandler, type SettingsHandlerContext } from './settings-message-handler.js';
import { TerminalMessageHandler, type TerminalHandlerContext } from './terminal-message-handler.js';
import { UsageMessageHandler, type UsageHandlerContext } from './usage-message-handler.js';
import { WorkspaceMessageHandler, type WorkspaceHandlerContext } from './workspace-message-handler.js';
import { WorktreeMessageHandler, type WorktreeHandlerContext } from './worktree-message-handler.js';
import { LlmRetryConfig, ProviderId, ProviderInfo, RenameMode, type ServerMessage, type ClientMessage, type McpServerEntry } from '@taiji/shared';
import { request as httpRequest, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket, type WebSocket as WsType } from 'ws';

// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。


// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。

// ======================================================================
// ← handler-misc-bundle-2.test.ts
// ======================================================================

// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。


// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。


// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。

// ======================================================================
// ← src/transport/terminal-message-handler.test.ts
// ======================================================================

function mockWs() {
  return { send: vi.fn(), readyState: 1 } as never
}


function mockService(overrides?: Partial<ITerminalService>): ITerminalService {
  const base: ITerminalService = {
    spawn: async (_sid: string, _cwd: string | undefined, _cols: number, _rows: number, terminalId?: string) =>
      terminalId ?? 'term:s1:1',
    write: () => {},
    resize: () => {},
    kill: () => {},
    attach: () => {},
    listInstances: () => [],
    destroySessionPties: () => {},
    destroyAllPties: () => {},
    ...overrides,
  }
  // 包一层 vi.fn 便于断言（保留 ITerminalService 类型的形参/返回）
  return {
    ...base,
    spawn: vi.fn(base.spawn),
    write: vi.fn(base.write),
    resize: vi.fn(base.resize),
    kill: vi.fn(base.kill),
    attach: vi.fn(base.attach),
    listInstances: vi.fn(base.listInstances),
  }
}


function mockContext(terminalService: ITerminalService): TerminalHandlerContext {
  return {
    send: vi.fn(),
    sendError: vi.fn(),
    reply: vi.fn(),
    terminalService,
  }
}


function msg(type: string, payload: Record<string, unknown> = {}, id = 'msg-1'): ClientMessage {
  return { type, payload, id } as unknown as ClientMessage
}


// ======================================================================
// ← src/transport/usage-message-handler.test.ts
// ======================================================================

function mockContext_m2(usageStatsService: Partial<UsageStatsService>): UsageHandlerContext {
  return {
    send: vi.fn(),
    sendError: vi.fn(),
    reply: vi.fn(),
    usageStatsService: usageStatsService as UsageStatsService,
  }
}


function msg_m2_m2_z2(type: string, id = 'm1'): ClientMessage {
  return { type, payload: {}, id } as unknown as ClientMessage
}


const WS = {} as never


// ======================================================================
// ← src/transport/workspace-message-handler.test.ts
// ======================================================================

function mockCtx(worktreeService?: WorkspaceHandlerContext['worktreeService']): WorkspaceHandlerContext {
  return {
    send: vi.fn(),
    sendError: vi.fn(),
    reply: vi.fn(),
    workspaceService: { record: vi.fn(), list: vi.fn(() => []), setPinned: vi.fn(() => true), defaultSessionDir: vi.fn(() => '/ds') },
    worktreeService,
  } as unknown as WorkspaceHandlerContext
}


function msg_m2_m2_z3(type: string, payload: Record<string, unknown> = {}, id = 'msg-1'): ClientMessage {
  return { type, payload, id } as unknown as ClientMessage
}


// ======================================================================
// ← src/transport/worktree-message-handler.test.ts
// ======================================================================

// ── mock helpers ─────────────────────────────────────────────

function mockWs_m2() {
  return { send: vi.fn(), readyState: 1 } as any
}


/**
 * 部分实现 mock（只含被测行为依赖的失效入口）：worktree handler 仅调
 * invalidateStatusCache（perf 03 §5 worktree 检查点闭环），全接口 mock 无断言价值。
 */
function mockGitService() {
  return { invalidateStatusCache: vi.fn() }
}


function mockContext_m2_z2(overrides?: Partial<WorktreeHandlerContext>): WorktreeHandlerContext {
  return {
    send: vi.fn(),
    sendError: vi.fn(),
    reply: vi.fn(),
    gitService: mockGitService() as unknown as IGitService,
    worktreeService: {
      create: vi.fn(async () => ({ cwd: '/project/feat-x', branch: 'feat/x', repoRoot: '/project', usedBaseRef: 'origin/main' })),
      detect: vi.fn(async () => ({
        mode: 'bare-workspace' as const,
        wsRoot: '/project',
        barePath: '/project/.bare',
        repoRoot: '/project',
        defaultBranch: 'main',
        defaultBaseRef: 'origin/main',
      })),
      listBranches: vi.fn(async () => ({
        local: ['main', 'feat-x'],
        remote: ['origin/main', 'origin/feat-y'],
        defaultBranch: 'main',
        defaultBaseRef: 'origin/main',
      })),
      list: vi.fn(async () => ({
        items: [
          { path: '/project', branch: 'main', HEAD: true, bare: false },
          { path: '/project/feat-x', branch: 'feat-x', HEAD: false, bare: false },
        ],
      })),
      prefetchDefaultRemote: vi.fn(async () => undefined),
    },
    ...overrides,
  }
}


function msg_m2(type: string, payload: Record<string, unknown> = {}, id = 'msg-1'): ClientMessage {
  return { type, payload, id } as unknown as ClientMessage
}

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('handler-misc-bundle-2', () => {
// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('terminal-message-handler', () => {
describe('TerminalMessageHandler.handles', () => {
  it('认领 terminal.list（新增查询帧）与五个既有请求帧', () => {
    const handler = new TerminalMessageHandler(mockContext(mockService()))
    expect(handler.handles).toEqual([
      'terminal.spawn',
      'terminal.write',
      'terminal.resize',
      'terminal.kill',
      'terminal.attach',
      'terminal.list',
    ])
  })
})
describe('TerminalMessageHandler 缺编号防御（write/resize/kill/attach 逐帧拒）', () => {
  const missingFrames: Array<{ type: string; payload: Record<string, unknown> }> = [
    { type: 'terminal.write', payload: { sessionId: 's1', data: 'x' } },
    { type: 'terminal.resize', payload: { sessionId: 's1', cols: 80, rows: 24 } },
    { type: 'terminal.kill', payload: { sessionId: 's1' } },
    { type: 'terminal.attach', payload: { sessionId: 's1' } },
  ]

  for (const { type, payload } of missingFrames) {
    it(`${type} 缺 terminalId → sendError（terminal_id_required，独立于否定回执），不调 service`, async () => {
      const service = mockService()
      const ctx = mockContext(service)
      const handler = new TerminalMessageHandler(ctx)
      const ws = mockWs()

      await handler.handleTerminalMessage(msg(type, payload), ws)

      expect(ctx.sendError).toHaveBeenCalledTimes(1)
      expect(ctx.sendError).toHaveBeenCalledWith(
        ws,
        'terminal_id_required',
        expect.stringContaining('缺少 terminalId'),
        'msg-1',
      )
      // 缺编号不是「注册成员资格的否定回执」——不得复用 unknown_terminal_id（后者是 renderer
      // 关闭沿三路径回收的唯一判据，设计 §3.3）
      expect(ctx.sendError).not.toHaveBeenCalledWith(ws, 'unknown_terminal_id', expect.any(String), 'msg-1')
      expect(ctx.reply).not.toHaveBeenCalled()
    })
  }

  it('空串 terminalId 同样被拒（非 undefined 但无归属）', async () => {
    const ctx = mockContext(mockService())
    const handler = new TerminalMessageHandler(ctx)
    const ws = mockWs()

    await handler.handleTerminalMessage(msg('terminal.write', { sessionId: 's1', terminalId: '', data: 'x' }), ws)

    expect(ctx.sendError).toHaveBeenCalledWith(
      ws,
      'terminal_id_required',
      expect.any(String),
      'msg-1',
    )
    expect(ctx.sendError).not.toHaveBeenCalledWith(ws, 'unknown_terminal_id', expect.any(String), 'msg-1')
  })

  it('带 terminalId 的四帧正常转发', async () => {
    const service = mockService()
    const ctx = mockContext(service)
    const handler = new TerminalMessageHandler(ctx)
    const ws = mockWs()

    await handler.handleTerminalMessage(msg('terminal.write', { sessionId: 's1', terminalId: 'term:s1:1', data: 'ls' }, 'w'), ws)
    await handler.handleTerminalMessage(msg('terminal.resize', { sessionId: 's1', terminalId: 'term:s1:1', cols: 1, rows: 2 }, 'r'), ws)
    await handler.handleTerminalMessage(msg('terminal.kill', { sessionId: 's1', terminalId: 'term:s1:1' }, 'k'), ws)
    await handler.handleTerminalMessage(msg('terminal.attach', { sessionId: 's1', terminalId: 'term:s1:1' }, 'a'), ws)

    expect(service.write).toHaveBeenCalledWith('s1', 'term:s1:1', 'ls')
    expect(service.resize).toHaveBeenCalledWith('s1', 'term:s1:1', 1, 2)
    expect(service.kill).toHaveBeenCalledWith('s1', 'term:s1:1')
    expect(service.attach).toHaveBeenCalledWith('s1', 'term:s1:1')
    expect(ctx.sendError).not.toHaveBeenCalled()
  })
})
describe('TerminalMessageHandler terminal.spawn 双形态', () => {
  it('缺 terminalId = 合法新建：ack 回传分配的编号', async () => {
    const service = mockService({ spawn: vi.fn(async () => 'term:s1:1') })
    const ctx = mockContext(service)
    const handler = new TerminalMessageHandler(ctx)
    const ws = mockWs()

    await handler.handleTerminalMessage(msg('terminal.spawn', { sessionId: 's1', cols: 80, rows: 24 }), ws)

    expect(service.spawn).toHaveBeenCalledWith('s1', undefined, 80, 24, undefined)
    expect(ctx.reply).toHaveBeenCalledWith(ws, 'msg-1', 'terminal.ack', { terminalId: 'term:s1:1' })
    expect(ctx.sendError).not.toHaveBeenCalled()
  })

  it('带 terminalId = 指定形态：透传并 ack 原编号', async () => {
    const service = mockService({ spawn: vi.fn(async (_sid, _cwd, _cols, _rows, id?: string) => id ?? 'x') })
    const ctx = mockContext(service)
    const handler = new TerminalMessageHandler(ctx)
    const ws = mockWs()

    await handler.handleTerminalMessage(
      msg('terminal.spawn', { sessionId: 's1', terminalId: 'term:s1:2', cwd: '/tmp', cols: 80, rows: 24 }),
      ws,
    )

    expect(service.spawn).toHaveBeenCalledWith('s1', '/tmp', 80, 24, 'term:s1:2')
    expect(ctx.reply).toHaveBeenCalledWith(ws, 'msg-1', 'terminal.ack', { terminalId: 'term:s1:2' })
  })

  it('空串 terminalId 视同缺编号：归一为新建形态（不判会话段不一致）', async () => {
    const service = mockService({ spawn: vi.fn(async () => 'term:s1:1') })
    const ctx = mockContext(service)
    const handler = new TerminalMessageHandler(ctx)
    const ws = mockWs()

    await handler.handleTerminalMessage(
      msg('terminal.spawn', { sessionId: 's1', terminalId: '', cols: 80, rows: 24 }),
      ws,
    )

    expect(service.spawn).toHaveBeenCalledWith('s1', undefined, 80, 24, undefined)
    expect(ctx.reply).toHaveBeenCalledWith(ws, 'msg-1', 'terminal.ack', { terminalId: 'term:s1:1' })
    expect(ctx.sendError).not.toHaveBeenCalled()
  })

  // F2-6/F2-9：非字符串 terminalId 是畸形帧（设计 §3.3「卫生默认」= 对畸形输入 fail-fast）。
  // 旧写法 `typeof id === 'string' && id !== '' ? id : undefined` 把非字符串一并归一为「新建」，
  // 会静默 spawn 真实 PTY 且无错误回执；收窄后非字符串走 terminal_id_required 拒绝。
  const malformedIds: Array<{ label: string; value: unknown }> = [
    { label: '数字', value: 123 },
    { label: 'null', value: null },
    { label: '对象', value: {} },
    { label: '布尔', value: true },
  ]

  for (const { label, value } of malformedIds) {
    it(`非字符串 terminalId（${label}）不静默新建：terminal_id_required 且不调 service.spawn`, async () => {
      const service = mockService()
      const ctx = mockContext(service)
      const handler = new TerminalMessageHandler(ctx)
      const ws = mockWs()

      await handler.handleTerminalMessage(
        msg('terminal.spawn', { sessionId: 's1', terminalId: value, cols: 80, rows: 24 }),
        ws,
      )

      expect(service.spawn).not.toHaveBeenCalled()
      expect(ctx.reply).not.toHaveBeenCalled()
      expect(ctx.sendError).toHaveBeenCalledWith(
        ws,
        'terminal_id_required',
        expect.stringContaining('类型非法'),
        'msg-1',
      )
    })
  }

  it('spawn 失败透传 spawn_failed', async () => {
    const service = mockService({
      spawn: vi.fn(async () => {
        throw Object.assign(new Error('shell missing'), { code: 'spawn_failed' })
      }),
    })
    const ctx = mockContext(service)
    const handler = new TerminalMessageHandler(ctx)
    const ws = mockWs()

    await handler.handleTerminalMessage(msg('terminal.spawn', { sessionId: 's1', cols: 80, rows: 24 }), ws)

    expect(ctx.sendError).toHaveBeenCalledWith(ws, 'spawn_failed', 'shell missing', 'msg-1')
  })
})
describe('TerminalMessageHandler 错误码透传（交叉校验独立码不被改写）', () => {
  it('service 抛 terminal_id_session_mismatch → 原码透传', async () => {
    const service = mockService({
      write: vi.fn(() => {
        throw Object.assign(new Error('terminalId session segment mismatch'), { code: 'terminal_id_session_mismatch' })
      }),
    })
    const ctx = mockContext(service)
    const handler = new TerminalMessageHandler(ctx)
    const ws = mockWs()

    await handler.handleTerminalMessage(
      msg('terminal.write', { sessionId: 's1', terminalId: 'term:s2:1', data: 'x' }),
      ws,
    )

    expect(ctx.sendError).toHaveBeenCalledWith(ws, 'terminal_id_session_mismatch', expect.any(String), 'msg-1')
  })

  it('service 抛 unknown_terminal_id → 原码透传', async () => {
    const service = mockService({
      kill: vi.fn(() => {
        throw Object.assign(new Error('no such instance'), { code: 'unknown_terminal_id' })
      }),
    })
    const ctx = mockContext(service)
    const handler = new TerminalMessageHandler(ctx)
    const ws = mockWs()

    await handler.handleTerminalMessage(
      msg('terminal.kill', { sessionId: 's1', terminalId: 'term:s1:9' }),
      ws,
    )

    expect(ctx.sendError).toHaveBeenCalledWith(ws, 'unknown_terminal_id', 'no such instance', 'msg-1')
  })
})
describe('TerminalMessageHandler terminal.list', () => {
  it('ack 携被查询会话实例清单', async () => {
    const instances = [
      { terminalId: 'term:s1:1', alive: true },
      { terminalId: 'term:s1:2', alive: true },
    ]
    const service = mockService({ listInstances: vi.fn(() => instances) })
    const ctx = mockContext(service)
    const handler = new TerminalMessageHandler(ctx)
    const ws = mockWs()

    await handler.handleTerminalMessage(msg('terminal.list', { sessionId: 's1' }), ws)

    expect(service.listInstances).toHaveBeenCalledWith('s1')
    expect(ctx.reply).toHaveBeenCalledWith(ws, 'msg-1', 'terminal.ack', { instances })
  })
})
});
// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('usage-message-handler', () => {
describe('UsageMessageHandler · usage.getStats', () => {
  it('正常 payload → reply 带 UsageStatsResult 形状', async () => {
    const mockResult = {
      rows: [
        { date: '2026-08-25', provider: 'kimi-coding', model: 'k3-256k', project: 'test', input: 1000, output: 200, cacheRead: 50, cacheWrite: 10, costUSD: 0.005, messages: 1 },
      ],
      scannedAt: Date.now(),
      sessionCount: 1,
      skippedLines: 0,
    }
    const ctx = mockContext_m2({ getStats: vi.fn().mockResolvedValue(mockResult) })
    const handler = new UsageMessageHandler(ctx)

    await handler.handleUsageMessage(msg_m2_m2_z2('usage.getStats'), WS)

    expect(ctx.reply).toHaveBeenCalledTimes(1)
    expect(ctx.reply).toHaveBeenCalledWith(WS, 'm1', 'usage.getStats:result', mockResult)
    expect(ctx.sendError).not.toHaveBeenCalled()
  })

  it('service 抛错 → sendError usage_scan_failed 带 id 和 hint', async () => {
    const ctx = mockContext_m2({
      getStats: vi.fn().mockRejectedValue(new Error('ENOENT: directory not found')),
    })
    const handler = new UsageMessageHandler(ctx)

    await handler.handleUsageMessage(msg_m2_m2_z2('usage.getStats'), WS)

    expect(ctx.sendError).toHaveBeenCalledTimes(1)
    expect(ctx.sendError).toHaveBeenCalledWith(
      WS,
      'usage_scan_failed',
      'ENOENT: directory not found',
      'm1',
      { hint: '扫描失败，可重试；详情见 runtime 日志' },
    )
    expect(ctx.reply).not.toHaveBeenCalled()
  })

  it('service 抛非 Error 对象 → sendError 用 String(e)', async () => {
    const ctx = mockContext_m2({
      getStats: vi.fn().mockRejectedValue('string error'),
    })
    const handler = new UsageMessageHandler(ctx)

    await handler.handleUsageMessage(msg_m2_m2_z2('usage.getStats', 'req-99'), WS)

    expect(ctx.sendError).toHaveBeenCalledWith(
      WS,
      'usage_scan_failed',
      'string error',
      'req-99',
      { hint: '扫描失败，可重试；详情见 runtime 日志' },
    )
  })

  it('正常结果带空 rows → reply 正常发出', async () => {
    const emptyResult = { rows: [], scannedAt: Date.now(), sessionCount: 0, skippedLines: 0 }
    const ctx = mockContext_m2({ getStats: vi.fn().mockResolvedValue(emptyResult) })
    const handler = new UsageMessageHandler(ctx)

    await handler.handleUsageMessage(msg_m2_m2_z2('usage.getStats'), WS)

    expect(ctx.reply).toHaveBeenCalledWith(WS, 'm1', 'usage.getStats:result', emptyResult)
    expect(ctx.sendError).not.toHaveBeenCalled()
  })
})
});
// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('workspace-message-handler', () => {
describe('WorkspaceMessageHandler workspace.record → prefetch', () => {
  it('record 有效 cwd → fire-and-forget 触发 prefetchDefaultRemote(cwd) + reply 正常', async () => {
    const prefetch = vi.fn(async () => undefined)
    const ctx = mockCtx({ prefetchDefaultRemote: prefetch } as unknown as WorkspaceHandlerContext['worktreeService'])
    const handler = new WorkspaceMessageHandler(ctx)

    await handler.handleWorkspaceMessage(msg_m2_m2_z3('workspace.record', { cwd: '/project' }), {} as never)

    expect(ctx.workspaceService.record).toHaveBeenCalledWith('/project')
    expect(prefetch).toHaveBeenCalledWith('/project')
    expect(ctx.reply).toHaveBeenCalledTimes(1)
  })

  it('worktreeService 未注入（null）→ 跳过 prefetch，reply 不受影响', async () => {
    const ctx = mockCtx(null)
    const handler = new WorkspaceMessageHandler(ctx)

    await handler.handleWorkspaceMessage(msg_m2_m2_z3('workspace.record', { cwd: '/project' }), {} as never)

    expect(ctx.workspaceService.record).toHaveBeenCalledWith('/project')
    expect(ctx.reply).toHaveBeenCalledTimes(1)
  })

  it('非法 cwd（空串）→ degraded reply，不 record 不 prefetch', async () => {
    const prefetch = vi.fn(async () => undefined)
    const ctx = mockCtx({ prefetchDefaultRemote: prefetch } as unknown as WorkspaceHandlerContext['worktreeService'])
    const handler = new WorkspaceMessageHandler(ctx)

    await handler.handleWorkspaceMessage(msg_m2_m2_z3('workspace.record', { cwd: '' }), {} as never)

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

    await handler.handleWorkspaceMessage(msg_m2_m2_z3('workspace.setPinned', { cwd: '/project', pinned: true }), {} as never)

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

    await handler.handleWorkspaceMessage(msg_m2_m2_z3('workspace.setPinned', { cwd: '/project', pinned: true }), {} as never)

    expect(ctx.reply).toHaveBeenCalledWith(
      expect.anything(), 'msg-1', 'workspace.recentList',
      expect.objectContaining({ degraded: true }),
    )
  })

  it('setPinned 非法 payload → degraded reply，不调 service', async () => {
    const ctx = mockCtx()
    const handler = new WorkspaceMessageHandler(ctx)

    await handler.handleWorkspaceMessage(msg_m2_m2_z3('workspace.setPinned', { cwd: '', pinned: 'yes' }), {} as never)

    expect(ctx.workspaceService.setPinned).not.toHaveBeenCalled()
    expect(ctx.reply).toHaveBeenCalledWith(
      expect.anything(), 'msg-1', 'workspace.recentList',
      expect.objectContaining({ degraded: true }),
    )
  })

  it('defaultSessionDir → reply dir（service 返回值直传）', async () => {
    const ctx = mockCtx()
    const handler = new WorkspaceMessageHandler(ctx)

    await handler.handleWorkspaceMessage(msg_m2_m2_z3('workspace.defaultSessionDir'), {} as never)

    expect(ctx.workspaceService.defaultSessionDir).toHaveBeenCalled()
    expect(ctx.reply).toHaveBeenCalledWith(
      expect.anything(), 'msg-1', 'workspace.defaultSessionDir:result', { dir: '/ds' },
    )
  })
})
});
// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('worktree-message-handler', () => {
// ── handles 清单 ────────────────────────────────────────────

describe('WorktreeMessageHandler.handles', () => {
  it('认领 worktree.create', () => {
    const handler = new WorktreeMessageHandler(mockContext_m2_z2())
    expect(handler.handles).toContain('worktree.create')
  })

  it('认领 worktree.listBranches', () => {
    const handler = new WorktreeMessageHandler(mockContext_m2_z2())
    expect(handler.handles).toContain('worktree.listBranches')
  })

  it('认领 worktree.list', () => {
    const handler = new WorktreeMessageHandler(mockContext_m2_z2())
    expect(handler.handles).toContain('worktree.list')
  })

  it('认领 workspace.detect', () => {
    const handler = new WorktreeMessageHandler(mockContext_m2_z2())
    expect(handler.handles).toContain('workspace.detect')
  })
})
// ── worktree.create ─────────────────────────────────────────

describe('WorktreeMessageHandler worktree.create', () => {
  it('成功时 reply worktree.created', async () => {
    const ctx = mockContext_m2_z2()
    const handler = new WorktreeMessageHandler(ctx)
    const ws = mockWs_m2()

    await handler.handleWorktreeMessage(
      msg_m2('worktree.create', { branch: 'feat/x', baseBranch: 'origin/main', workspaceHint: '/project' }),
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
      // RT-8#8：create 返回 usedBaseRef → 透传给前端（请求 ref 校验失败 fallback 时可见）
      usedBaseRef: 'origin/main',
    })
  })

  it('失败时 sendError 透传错误码', async () => {
    const ctx = mockContext_m2_z2()
    ctx.worktreeService.create = vi.fn(async () => {
      throw Object.assign(new Error('worktree 已存在'), { code: 'WORKTREE_EXISTS', detail: { cwd: '/x', dirName: 'x' } })
    })
    const handler = new WorktreeMessageHandler(ctx)
    const ws = mockWs_m2()

    await handler.handleWorktreeMessage(
      msg_m2('worktree.create', { branch: 'existing' }),
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
    const ctx = mockContext_m2_z2()
    ctx.worktreeService.create = vi.fn(async () => { throw new Error('unexpected') })
    const handler = new WorktreeMessageHandler(ctx)
    const ws = mockWs_m2()

    await handler.handleWorktreeMessage(
      msg_m2('worktree.create', { branch: 'feat/test' }),
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

  it('git 层错误码（git_unavailable）映射为 GIT_FAILED，原始码进 details.originalCode', async () => {
    const ctx = mockContext_m2_z2()
    ctx.worktreeService.create = vi.fn(async () => {
      throw Object.assign(new Error('git 不可用'), { code: 'git_unavailable' })
    })
    const handler = new WorktreeMessageHandler(ctx)
    const ws = mockWs_m2()

    await handler.handleWorktreeMessage(
      msg_m2('worktree.create', { branch: 'feat/test' }),
      ws,
    )

    expect(ctx.sendError).toHaveBeenCalledWith(
      ws,
      'GIT_FAILED',
      'git 不可用',
      'msg-1',
      { originalCode: 'git_unavailable' },
    )
  })

  it('git 层错误码（timeout）映射为 GIT_FAILED 且保留原有 detail', async () => {
    const ctx = mockContext_m2_z2()
    ctx.worktreeService.create = vi.fn(async () => {
      throw Object.assign(new Error('git 超时'), { code: 'timeout', detail: { cwd: '/x' } })
    })
    const handler = new WorktreeMessageHandler(ctx)
    const ws = mockWs_m2()

    await handler.handleWorktreeMessage(
      msg_m2('worktree.create', { branch: 'feat/test' }),
      ws,
    )

    expect(ctx.sendError).toHaveBeenCalledWith(
      ws,
      'GIT_FAILED',
      'git 超时',
      'msg-1',
      { originalCode: 'timeout', detail: { cwd: '/x' } },
    )
  })

  it('union 外未知错误码归 worktree_failed，原始码进 details.code（不逃出 union）', async () => {
    const ctx = mockContext_m2_z2()
    ctx.worktreeService.create = vi.fn(async () => {
      throw Object.assign(new Error('某种新错'), { code: 'SOME_FUTURE_CODE' })
    })
    const handler = new WorktreeMessageHandler(ctx)
    const ws = mockWs_m2()

    await handler.handleWorktreeMessage(
      msg_m2('worktree.create', { branch: 'feat/test' }),
      ws,
    )

    expect(ctx.sendError).toHaveBeenCalledWith(
      ws,
      'worktree_failed',
      '某种新错',
      'msg-1',
      { code: 'SOME_FUTURE_CODE' },
    )
  })
})
// ── worktree.create 写操作失效（perf 03 §5 检查点闭环，2026-08-17；失效键改 repo 根：缓存治理 1-6）──

describe('WorktreeMessageHandler worktree.create 写操作失效', () => {
  it('操作后缓存失效：成功后按 create 返回的 repo 根失效——hint 为深层子目录时不与缓存键错位（下次 getStatus 按 repo 根重读为新值）', async () => {
    const gitService = mockGitService()
    // 持有 reply 原始 mock（ctx 类型里 reply 是具体签名，.mock 不可达）——「失效在 reply 前」
    // 用 vitest mock 的 invocationCallOrder 全局单调序断言失效先于 reply 发生
    const reply = vi.fn()
    const ctx = mockContext_m2_z2({
      gitService: gitService as unknown as IGitService,
      reply: reply as unknown as WorktreeHandlerContext['reply'],
      worktreeService: {
        ...mockContext_m2_z2().worktreeService,
        // hint 指向深层子目录：create 内部 detect 解析出的 repo 根是 /project（≠ hint 原值）
        create: vi.fn(async () => ({ cwd: '/project/feat-x', branch: 'feat/x', repoRoot: '/project', usedBaseRef: 'origin/main' })),
      },
    })
    const handler = new WorktreeMessageHandler(ctx)
    const ws = mockWs_m2()

    await handler.handleWorktreeMessage(
      msg_m2('worktree.create', { branch: 'feat/x', workspaceHint: '/project/deep/sub' }),
      ws,
    )

    // 失效键 = create 内部 detect 实际解析出的 repo 根（session statusCache 键所在的 cwd 形态），
    // 不是 hint 原值——修复前这里失效 { cwd: '/project/deep/sub' }，与缓存键错位、失效落空。
    expect(gitService.invalidateStatusCache).toHaveBeenCalledTimes(1)
    expect(gitService.invalidateStatusCache).toHaveBeenCalledWith({ cwd: '/project' })
    expect(reply).toHaveBeenCalledWith(ws, 'msg-1', 'worktree.created', {
      cwd: '/project/feat-x',
      branch: 'feat/x',
      usedBaseRef: 'origin/main',
    })
    // 语义对齐 U2 六写操作：reply 前失效（前端收到 ack 后可能立即刷新 git zone）
    const invalidateOrder = gitService.invalidateStatusCache.mock.invocationCallOrder[0]
    const replyOrder = reply.mock.invocationCallOrder[0]
    expect(invalidateOrder).toBeDefined()
    expect(replyOrder).toBeDefined()
    expect(invalidateOrder).toBeLessThan(replyOrder)
  })

  it('WS 契约：repoRoot 仅供 runtime 内部失效，worktree.created payload 不携带（usedBaseRef 除外，RT-8#8）', async () => {
    const ctx = mockContext_m2_z2()
    const handler = new WorktreeMessageHandler(ctx)
    const ws = mockWs_m2()

    await handler.handleWorktreeMessage(
      msg_m2('worktree.create', { branch: 'feat/x', workspaceHint: '/project' }),
      ws,
    )

    // toHaveBeenCalledWith 深比较：payload 恰为 { cwd, branch, usedBaseRef }，
    // 多出 repoRoot（runtime 内部失效键）即失败
    expect(ctx.reply).toHaveBeenCalledWith(ws, 'msg-1', 'worktree.created', {
      cwd: '/project/feat-x',
      branch: 'feat/x',
      usedBaseRef: 'origin/main',
    })
    const payload = (ctx.reply as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]?.[3] as Record<string, unknown>
    expect(Object.keys(payload ?? {}).sort()).toEqual(['branch', 'cwd', 'usedBaseRef'])
  })

  it('create 无 usedBaseRef（旧 service 形态）→ payload 不带该可选字段', async () => {
    const ctx = mockContext_m2_z2({
      worktreeService: {
        ...mockContext_m2_z2().worktreeService,
        create: vi.fn(async () => ({ cwd: '/project/feat-x', branch: 'feat/x', repoRoot: '/project' })),
      },
    })
    const handler = new WorktreeMessageHandler(ctx)
    const ws = mockWs_m2()

    await handler.handleWorktreeMessage(
      msg_m2('worktree.create', { branch: 'feat/x', workspaceHint: '/project' }),
      ws,
    )

    expect(ctx.reply).toHaveBeenCalledWith(ws, 'msg-1', 'worktree.created', {
      cwd: '/project/feat-x',
      branch: 'feat/x',
    })
  })

  it('成功且 payload 无 workspaceHint → 失效键仍为 create 返回的 repo 根（起点缺省由 service 内部决定）', async () => {
    const gitService = mockGitService()
    const ctx = mockContext_m2_z2({ gitService: gitService as unknown as IGitService })
    const handler = new WorktreeMessageHandler(ctx)
    const ws = mockWs_m2()

    await handler.handleWorktreeMessage(
      msg_m2('worktree.create', { branch: 'feat/x' }),
      ws,
    )

    expect(gitService.invalidateStatusCache).toHaveBeenCalledWith({ cwd: '/project' })
  })

  it('create 失败 → 不失效（状态未变）', async () => {
    const gitService = mockGitService()
    const ctx = mockContext_m2_z2({ gitService: gitService as unknown as IGitService })
    ctx.worktreeService.create = vi.fn(async () => {
      throw Object.assign(new Error('git worktree add 失败'), { code: 'GIT_FAILED' })
    })
    const handler = new WorktreeMessageHandler(ctx)
    const ws = mockWs_m2()

    await handler.handleWorktreeMessage(
      msg_m2('worktree.create', { branch: 'feat/x', workspaceHint: '/project' }),
      ws,
    )

    expect(gitService.invalidateStatusCache).not.toHaveBeenCalled()
    expect(ctx.reply).not.toHaveBeenCalled()
    expect(ctx.sendError).toHaveBeenCalledTimes(1)
  })

  it('gitService 为 null（server 未注入，防御场景）→ 成功路径跳过失效且不抛错', async () => {
    const ctx = mockContext_m2_z2({ gitService: null })
    const handler = new WorktreeMessageHandler(ctx)
    const ws = mockWs_m2()

    await expect(handler.handleWorktreeMessage(
      msg_m2('worktree.create', { branch: 'feat/x', workspaceHint: '/project' }),
      ws,
    )).resolves.toBeUndefined()

    expect(ctx.reply).toHaveBeenCalledWith(ws, 'msg-1', 'worktree.created', {
      cwd: '/project/feat-x',
      branch: 'feat/x',
      usedBaseRef: 'origin/main',
    })
  })
})
// ── worktree.listBranches ───────────────────────────────────

describe('WorktreeMessageHandler worktree.listBranches', () => {
  it('成功时 reply worktree.branches', async () => {
    const ctx = mockContext_m2_z2()
    const handler = new WorktreeMessageHandler(ctx)
    const ws = mockWs_m2()

    await handler.handleWorktreeMessage(msg_m2('worktree.listBranches', { cwd: '/project' }), ws)

    expect(ctx.worktreeService.listBranches).toHaveBeenCalledWith('/project')
    expect(ctx.reply).toHaveBeenCalledWith(ws, 'msg-1', 'worktree.branches', {
      local: ['main', 'feat-x'],
      remote: ['origin/main', 'origin/feat-y'],
      defaultBranch: 'main',
      defaultBaseRef: 'origin/main',
    })
  })

  it('失败时 sendError', async () => {
    const ctx = mockContext_m2_z2()
    ctx.worktreeService.listBranches = vi.fn(async () => {
      throw Object.assign(new Error('not repo'), { code: 'NOT_GIT_REPO' })
    })
    const handler = new WorktreeMessageHandler(ctx)
    const ws = mockWs_m2()

    await handler.handleWorktreeMessage(msg_m2('worktree.listBranches', { cwd: '/tmp' }), ws)

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
    const ctx = mockContext_m2_z2()
    const handler = new WorktreeMessageHandler(ctx)
    const ws = mockWs_m2()

    await handler.handleWorktreeMessage(msg_m2('worktree.list', { cwd: '/project' }), ws)

    expect(ctx.worktreeService.list).toHaveBeenCalledWith('/project')
    expect(ctx.reply).toHaveBeenCalledWith(ws, 'msg-1', 'worktree.list:result', {
      items: [
        { path: '/project', branch: 'main', HEAD: true, bare: false },
        { path: '/project/feat-x', branch: 'feat-x', HEAD: false, bare: false },
      ],
    })
  })
})
// ── workspace.detect ─────────────────

describe('WorktreeMessageHandler workspace.detect', () => {
  it('workspace.detect reply workspace.detected', async () => {
    const ctx = mockContext_m2_z2()
    const handler = new WorktreeMessageHandler(ctx)
    const ws = mockWs_m2()

    await handler.handleWorktreeMessage(msg_m2('workspace.detect', { cwd: '/project' }), ws)

    expect(ctx.worktreeService.detect).toHaveBeenCalledWith('/project')
    expect(ctx.reply).toHaveBeenCalledWith(ws, 'msg-1', 'workspace.detected', {
      mode: 'bare-workspace',
      wsRoot: '/project',
      barePath: '/project/.bare',
      repoRoot: '/project',
      defaultBranch: 'main',
      defaultBaseRef: 'origin/main',
    })
  })

  it('detect 失败时 sendError', async () => {
    const ctx = mockContext_m2_z2()
    ctx.worktreeService.detect = vi.fn(async () => {
      throw Object.assign(new Error('not repo'), { code: 'NOT_GIT_REPO' })
    })
    const handler = new WorktreeMessageHandler(ctx)
    const ws = mockWs_m2()

    await handler.handleWorktreeMessage(msg_m2('workspace.detect', { cwd: '/tmp' }), ws)

    expect(ctx.sendError).toHaveBeenCalledWith(
      ws,
      'NOT_GIT_REPO',
      'not repo',
      'msg-1',
      undefined,
    )
  })
})
});
});

// ======================================================================
// ← settings-message-handler-bundle.test.ts
// ======================================================================

const SNAPSHOT = {
  config: { enabled: true, maxRetries: 2, baseDelayMs: 3000, provider: { maxRetries: 0, maxRetryDelayMs: 60000 } } as LlmRetryConfig,
  configured: true,
}


function mockCtx_m2_m2() {
  const replies: ServerMessage[] = []
  const broadcasts: ServerMessage[] = []
  const configService = {
    getRetryConfig: vi.fn(() => SNAPSHOT),
    setRetryConfig: vi.fn(() => ({ ok: true })),
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
    broadcast: vi.fn((m: ServerMessage) => broadcasts.push(m)),
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
  return { ctx: ctx as unknown as SettingsHandlerContext, replies, broadcasts, configService }
}


// ======================================================================
// ← src/transport/settings-message-handler-mcp.test.ts
// ======================================================================

const ENTRY: McpServerEntry = {
  name: 'filesystem',
  value: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '.'] },
}


/** fake IMcpServers（fake store/probe，u2a mcp-message-handler.test 同款形态）。 */
function makeFakePort(overrides: Partial<IMcpServers> = {}): IMcpServers {
  return {
    list: vi.fn(() => ({ servers: [ENTRY], corruption: null, agentDir: '/data/agent' })),
    add: vi.fn(() => ({ ok: true, entry: ENTRY }) as const),
    update: vi.fn(() => ({ ok: true, entry: ENTRY }) as const),
    setEnabled: vi.fn((_name: string, _enabled: boolean) => ({ ok: true, entry: ENTRY }) as const),
    remove: vi.fn(() => ({ ok: true, entry: ENTRY }) as const),
    test: vi.fn((_name: string) => ({ testId: 'test-1' })),
    testCancel: vi.fn((_testId: string) => true),
    ...overrides,
  }
}


function mockCtx_m2_m2_d1(portOverrides: Partial<IMcpServers> = {}) {
  const replies: ServerMessage[] = []
  const mcpServersService = new McpServersService(makeFakePort(portOverrides))
  const ctx = {
    send: vi.fn(),
    sendError: vi.fn(),
    reply: vi.fn((_ws: unknown, id: string | undefined, type: string, payload: unknown) => {
      replies.push({ type, id, payload } as unknown as ServerMessage)
    }),
    configService: {},
    sessionService: {},
    modelService: {},
    authService: {},
    skillRegistry: {},
    mcpServersService,
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
  }
  return { ctx: ctx as unknown as SettingsHandlerContext, replies, mcpServersService }
}


const WS_m2_m2 = {} as never


// ======================================================================
// ← src/transport/settings-message-handler-model-switch.test.ts
// ======================================================================

function mockCtx_m3(effectiveModel: string) {
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


const WS_m2_m2_d1 = {} as never


// ======================================================================
// ← src/transport/settings-message-handler-rename-mode.test.ts
// ======================================================================

function mockCtx_m4() {
  const replies: ServerMessage[] = []
  // 闭包模拟存储：setRenameMode 记值、getRenameMode 读回——让 reply「读回生效值」可见
  let stored: RenameMode = 'first-stop'
  const configService = {
    getRenameMode: vi.fn(() => stored),
    setRenameMode: vi.fn((mode: RenameMode) => { stored = mode }),
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
  }
  return { ctx: ctx as unknown as SettingsHandlerContext, replies, configService }
}


// ======================================================================
// ← src/transport/settings-message-handler-reveal-apikey.test.ts
// ======================================================================

function mockCtx_m5(opts: {
  revealed?: { apiKey: string; source: 'auth.json' | 'models.json' }
} = {}) {
  const replies: ServerMessage[] = []
  const resolveProviderApiKeyRaw = vi.fn(async () => opts.revealed)
  const ctx = {
    send: vi.fn(),
    sendError: vi.fn(),
    reply: vi.fn((_ws: unknown, id: string | undefined, type: string, payload: unknown) => {
      replies.push({ type, id, payload } as unknown as ServerMessage)
    }),
    configService: {},
    sessionService: {},
    modelService: {},
    authService: {},
    providerCredentialResolver: { resolveProviderApiKeyRaw },
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
  }
  return { ctx: ctx as unknown as SettingsHandlerContext, replies, resolveProviderApiKeyRaw }
}


/** 单次 RPC 打点：发请求 → 断言 handled + 恰好一条 reply → 返回该 reply */
async function sendReveal(
  ctx: SettingsHandlerContext,
  replies: ServerMessage[],
  providerId = 'p1',
): Promise<ServerMessage> {
  const handler = new SettingsMessageHandler(ctx)
  const handled = await handler.handleSettingsMessage(
    { type: 'config.revealProviderApiKey', payload: { providerId }, id: 'm1' } as unknown as ClientMessage,
    WS_m2_m2,
  )
  expect(handled).toBe(true)
  expect(replies).toHaveLength(1)
  return replies[0]!
}


// ======================================================================
// ← src/transport/settings-message-handler-supported-levels.test.ts
// ======================================================================

const PROVIDERS: ProviderInfo[] = [
  {
    id: 'kimi-coding' as ProviderId,
    name: 'Kimi Coding',
    apiKeySet: true,
    status: 'connected',
    models: [
      { id: 'k3', name: 'K3', reasoning: true },
      { id: 'k2', name: 'K2' },
    ],
  },
]


/** 真实纯函数小 fixture：attachSupportedLevels 走 pi-ai 同源 computeSupportedLevels。 */
function makeRegistryBackedModelService() {
  return {
    aggregateModels: vi.fn(() => []),
    attachSupportedLevels: vi.fn((providers: ProviderInfo[], _piVersion?: string) =>
      attachSupportedLevels(providers),
    ),
  }
}


function mockCtx_m6(modelService: unknown) {
  const replies: ServerMessage[] = []
  const ctx = {
    send: vi.fn(),
    sendError: vi.fn(),
    reply: vi.fn((_ws: unknown, id: string | undefined, type: string, payload: unknown) => {
      replies.push({ type, id, payload } as unknown as ServerMessage)
    }),
    configService: {
      listProviders: vi.fn(() => PROVIDERS),
      getScopedModels: vi.fn(() => []),
      // M4/RT-3#4：config.getProviders reply 携带 models.json 降级态标志
      isModelsStoreCorrupted: vi.fn(() => false),
    },
    sessionService: {},
    modelService,
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
  return { ctx: ctx as unknown as SettingsHandlerContext, replies }
}


function getProvidersMsg(): ClientMessage {
  return { type: 'config.getProviders', payload: {}, id: 'm1' } as unknown as ClientMessage
}


const WS_m3 = {} as never

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('settings-message-handler-bundle', () => {
// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('settings-message-handler-llm-retry', () => {
describe('SettingsMessageHandler · config.getRetryConfig', () => {
  it('reply config.retryConfig 透传 { config, configured } 形状', async () => {
    const { ctx, replies } = mockCtx_m2_m2()
    const reply = await sendConfigGet(ctx, replies, 'config.getRetryConfig')
    expect(reply).toMatchObject({ type: 'config.retryConfig', id: 'm1' })
    expect(reply.payload).toEqual(SNAPSHOT)
  })
})
describe('SettingsMessageHandler · config.setRetryConfig', () => {
  it('成功：reply + broadcast config.retryConfig（configured=true），不 sendError', async () => {
    const { ctx, replies, broadcasts } = mockCtx_m2_m2()
    const handler = new SettingsMessageHandler(ctx)
    const config = SNAPSHOT.config
    const handled = await handler.handleSettingsMessage(
      { type: 'config.setRetryConfig', payload: { config }, id: 'm2' } as unknown as ClientMessage,
      WS_m2_m2,
    )
    expect(handled).toBe(true)
    expect(ctx.sendError).not.toHaveBeenCalled()
    expect(replies[0]).toMatchObject({ type: 'config.retryConfig', id: 'm2' })
    expect(replies[0].payload).toEqual({ config, configured: true })
    expect(broadcasts).toHaveLength(1)
    expect(broadcasts[0]).toMatchObject({ type: 'config.retryConfig' })
    expect(broadcasts[0].payload).toEqual({ config, configured: true })
  })

  it('校验失败：sendError set_retry_config_failed（含校验 error），不广播', async () => {
    const { ctx, broadcasts, configService } = mockCtx_m2_m2()
    configService.setRetryConfig = vi.fn(() => ({ ok: false, error: 'baseDelayMs 超出范围(整数 0-600000): 99999000' }))
    const handler = new SettingsMessageHandler(ctx)
    const config = { ...SNAPSHOT.config, baseDelayMs: 99999000 }
    const handled = await handler.handleSettingsMessage(
      { type: 'config.setRetryConfig', payload: { config }, id: 'm3' } as unknown as ClientMessage,
      WS_m2_m2,
    )
    expect(handled).toBe(true)
    expect(ctx.sendError).toHaveBeenCalledWith(WS_m2_m2, 'set_retry_config_failed', 'baseDelayMs 超出范围(整数 0-600000): 99999000', 'm3')
    expect(broadcasts).toHaveLength(0)
  })
})
});
// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('settings-message-handler-mcp', () => {
describe('SettingsMessageHandler · mcp.* 七命令路由（pi-mcp-management）', () => {
  const CASES = [
    { type: 'mcp.list', payload: {}, replyType: 'mcp.list:result', spy: 'list' },
    { type: 'mcp.add', payload: { name: 'fs', entry: ENTRY.value }, replyType: 'mcp.add:result', spy: 'add' },
    { type: 'mcp.update', payload: { name: 'fs', entry: ENTRY.value }, replyType: 'mcp.update:result', spy: 'update' },
    { type: 'mcp.setEnabled', payload: { name: 'fs', enabled: false }, replyType: 'mcp.setEnabled:result', spy: 'setEnabled' },
    { type: 'mcp.remove', payload: { name: 'fs' }, replyType: 'mcp.remove:result', spy: 'remove' },
    { type: 'mcp.test', payload: { name: 'fs' }, replyType: 'mcp.test:result', spy: 'test' },
    { type: 'mcp.testCancel', payload: { testId: 'test-1' }, replyType: 'mcp.testCancel:result', spy: 'testCancel' },
  ] as const

  for (const c of CASES) {
    it(`${c.type}：查表命中 → 委托 McpServersService.${c.spy} + reply ${c.replyType}`, async () => {
      const { ctx, replies, mcpServersService } = mockCtx_m2_m2_d1()
      const handler = new SettingsMessageHandler(ctx)
      const spy = vi.spyOn(mcpServersService, c.spy)
      const handled = await handler.handleSettingsMessage(
        { type: c.type, payload: c.payload, id: 'm1' } as unknown as ClientMessage,
        WS_m2_m2,
      )
      expect(handled).toBe(true)
      expect(spy).toHaveBeenCalledOnce()
      expect(replies).toHaveLength(1)
      expect(replies[0]).toMatchObject({ type: c.replyType, id: 'm1' })
      expect(ctx.sendError).not.toHaveBeenCalled()
    })
  }

  it('mcp.list reply payload = 清单 + 损坏错误态两态形状（透传 service 结果）', async () => {
    const { ctx, replies } = mockCtx_m2_m2_d1({
      list: vi.fn(() => ({ servers: [], corruption: { filePath: '/data/agent/mcp.json', corruptCopyPath: null }, agentDir: '/data/agent' })),
    })
    const handler = new SettingsMessageHandler(ctx)
    await handler.handleSettingsMessage({ type: 'mcp.list', payload: {}, id: 'm2' } as unknown as ClientMessage, WS_m2_m2)
    expect(replies[0].payload).toEqual({
      servers: [],
      corruption: { filePath: '/data/agent/mcp.json', corruptCopyPath: null },
      agentDir: '/data/agent',
    })
  })

  it('mcpServersService 缺省（退化测试装配）：mcp.* 落 unknown_type（handled=false）', async () => {
    const { ctx: full } = mockCtx_m2_m2()
    // 摘除 mcpServersService 模拟存量测试/缺省装配侧（optional 通道未注入）
    const ctxWithoutMcp = full as unknown as Record<string, unknown>
    delete ctxWithoutMcp.mcpServersService
    const handler = new SettingsMessageHandler(full)
    const handled = await handler.handleSettingsMessage(
      { type: 'mcp.list', payload: {}, id: 'm3' } as unknown as ClientMessage,
      WS_m2_m2,
    )
    expect(handled).toBe(false)
  })

  it('未知 mcp type → false（unknown_type 兜底不变）', async () => {
    const { ctx } = mockCtx_m2_m2()
    const handler = new SettingsMessageHandler(ctx)
    const handled = await handler.handleSettingsMessage(
      { type: 'mcp.reload', payload: {}, id: 'm4' } as unknown as ClientMessage,
      WS_m2_m2,
    )
    expect(handled).toBe(false)
  })
})
});
// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('settings-message-handler-model-switch', () => {
describe('SettingsMessageHandler · model.switch reply 回传生效值（U6 / C-pi-13）', () => {
  it('pi 换模（生效 ≠ 请求）→ reply 回传生效 provider/modelId，不回显请求值', async () => {
    const { ctx, replies, switchModel } = mockCtx_m3('zai-coding-cn/glm-5.3-air')
    const handler = new SettingsMessageHandler(ctx)

    await handler.handleSettingsMessage(switchMsg(), WS_m2_m2)

    expect(switchModel).toHaveBeenCalledWith('sess-1', 'zai-coding-cn', 'glm-5.3')
    expect(ctx.reply).toHaveBeenCalledTimes(1)
    const [repliedType, payload] = [replies[0].type, replies[0].payload] as const
    expect(repliedType).toBe('model.switched')
    // 生效值（复合串拆解），而非请求的 glm-5.3
    expect(payload).toEqual({ sessionId: 'sess-1', provider: 'zai-coding-cn', modelId: 'glm-5.3-air' })
  })

  it('生效值含多段斜杠的 modelId → 仅按首个 / 拆 provider，余下归 modelId', async () => {
    const { ctx, replies } = mockCtx_m3('openai/org/team-model-v2')
    const handler = new SettingsMessageHandler(ctx)

    await handler.handleSettingsMessage(switchMsg(), WS_m2_m2)

    expect(replies[0].payload).toEqual({
      sessionId: 'sess-1',
      provider: 'openai',
      modelId: 'org/team-model-v2',
    })
  })

  it('返回值无 /（无活跃进程早退 fallback）→ 按请求值回显（旧行为兜底）', async () => {
    const { ctx, replies } = mockCtx_m3('sess-1')
    const handler = new SettingsMessageHandler(ctx)

    await handler.handleSettingsMessage(switchMsg(), WS_m2_m2)

    expect(replies[0].payload).toEqual({ sessionId: 'sess-1', provider: 'zai-coding-cn', modelId: 'glm-5.3' })
  })

  it('返回值空串（U6 降级检查：无 sessionService / 无活跃 session / 非法复合串）→ reply 按请求值回显，不产畸形 payload', async () => {
    // 空串是 U6 降级契约（plugin-rpc-setup setModel 检查三分支返回 ''）——
    // indexOf('/') 为 -1 落入请求值回显兜底，reply 形态保持 { sessionId, provider, modelId } 完整，
    // 消费方（renderer）不收到空 provider/modelId 的畸形帧。
    const { ctx, replies } = mockCtx_m3('')
    const handler = new SettingsMessageHandler(ctx)

    await handler.handleSettingsMessage(switchMsg(), WS_m2_m2)

    expect(ctx.reply).toHaveBeenCalledTimes(1)
    expect(replies[0].type).toBe('model.switched')
    expect(replies[0].payload).toEqual({ sessionId: 'sess-1', provider: 'zai-coding-cn', modelId: 'glm-5.3' })
  })

  it('session 未活跃（RT-4#4）→ switchModel 的 SESSION_NOT_ACTIVE rejection 原样上抛，不发 model.switched 假成功 reply', async () => {
    // 无活跃进程的失败语义在 service 层 fail-fast（errorWithCode）；handler 不吞不转译，
    // 由 server.ts handleMessage 全局 catch 统一 sendError（code 透传 + details.sessionId）。
    const { ctx, switchModel } = mockCtx_m3('zai-coding-cn/glm-5.3')
    ;(switchModel as ReturnType<typeof vi.fn>).mockRejectedValue(
      errorWithCode('会话未活跃（sess-1 无活跃进程），重开后可重试', SESSION_NOT_ACTIVE),
    )
    const handler = new SettingsMessageHandler(ctx)

    await expect(handler.handleSettingsMessage(switchMsg(), WS_m2_m2)).rejects.toMatchObject({
      code: SESSION_NOT_ACTIVE,
    })
    expect(ctx.reply).not.toHaveBeenCalled()
  })
})
});
// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('settings-message-handler-rename-mode', () => {
describe('SettingsMessageHandler · config.getRenameMode', () => {
  it('reply config.renameMode 透传 { mode }（默认 first-stop）', async () => {
    const { ctx, replies } = mockCtx_m4()
    const reply = await sendConfigGet(ctx, replies, 'config.getRenameMode')
    expect(reply).toMatchObject({ type: 'config.renameMode', id: 'm1' })
    expect(reply.payload).toEqual({ mode: 'first-stop' })
    expect(ctx.sendError).not.toHaveBeenCalled()
  })
})
describe('SettingsMessageHandler · config.setRenameMode', () => {
  it('成功：调 setRenameMode(payload.mode) + reply 读回生效值', async () => {
    const { ctx, replies, configService } = mockCtx_m4()
    const handler = new SettingsMessageHandler(ctx)
    const handled = await handler.handleSettingsMessage(
      { type: 'config.setRenameMode', payload: { mode: 'agent-tool' }, id: 'm2' } as unknown as ClientMessage,
      WS_m2_m2,
    )
    expect(handled).toBe(true)
    expect(configService.setRenameMode).toHaveBeenCalledWith('agent-tool')
    expect(replies).toHaveLength(1)
    expect(replies[0]).toMatchObject({ type: 'config.renameMode', id: 'm2' })
    expect(replies[0].payload).toEqual({ mode: 'agent-tool' })
    expect(ctx.sendError).not.toHaveBeenCalled()
  })

  it('set 后 get：reply 反映新值（读回生效值语义）', async () => {
    const { ctx, replies } = mockCtx_m4()
    const handler = new SettingsMessageHandler(ctx)
    await handler.handleSettingsMessage(
      { type: 'config.setRenameMode', payload: { mode: 'first-prompt' }, id: 'm3' } as unknown as ClientMessage,
      WS_m2_m2,
    )
    await handler.handleSettingsMessage(
      { type: 'config.getRenameMode', payload: {}, id: 'm4' } as unknown as ClientMessage,
      WS_m2_m2,
    )
    expect(replies).toHaveLength(2)
    expect(replies[0].payload).toEqual({ mode: 'first-prompt' })
    expect(replies[1].payload).toEqual({ mode: 'first-prompt' })
  })
})
// ── config.get/setRenamePrompt（rename-prompt-config 设计）──

describe('SettingsMessageHandler · config.getRenamePrompt', () => {
  it('reply config.renamePrompt 透传快照（style/instruction/corrupted）', async () => {
    const { ctx, replies, configService } = mockCtx_m4()
    ;(configService as Record<string, unknown>)['getRenamePrompt'] = vi.fn(() => ({
      style: 'custom',
      instruction: '自定义指令',
      corrupted: false,
    }))
    const reply = await sendConfigGet(ctx, replies, 'config.getRenamePrompt')
    expect(reply).toMatchObject({ type: 'config.renamePrompt', id: 'm1' })
    expect(reply.payload).toEqual({ style: 'custom', instruction: '自定义指令', corrupted: false })
    expect(ctx.sendError).not.toHaveBeenCalled()
  })
})
describe('SettingsMessageHandler · config.setRenamePrompt', () => {
  it('成功：调 setRenamePrompt(style, instruction) + reply 透传归一生效值', async () => {
    const { ctx, replies, configService } = mockCtx_m4()
    ;(configService as Record<string, unknown>)['setRenamePrompt'] = vi.fn(() => ({
      style: 'slug',
      instruction: '',
      corrupted: false,
    }))
    const handler = new SettingsMessageHandler(ctx)
    const handled = await handler.handleSettingsMessage(
      { type: 'config.setRenamePrompt', payload: { style: 'sentence', instruction: '短句指令' }, id: 'm2' } as unknown as ClientMessage,
      WS_m2_m2,
    )
    expect(handled).toBe(true)
    expect((configService as unknown as Record<string, ReturnType<typeof vi.fn>>)['setRenamePrompt']).toHaveBeenCalledWith('sentence', '短句指令')
    expect(replies).toHaveLength(1)
    expect(replies[0]).toMatchObject({ type: 'config.renamePrompt', id: 'm2' })
    expect(ctx.sendError).not.toHaveBeenCalled()
  })
})
describe('SettingsMessageHandler · config.get/setRenameMaxLength', () => {
  it('get：reply config.renameMaxLength 透传 { maxLength }', async () => {
    const { ctx, replies, configService } = mockCtx_m4()
    ;(configService as Record<string, unknown>)['getRenameMaxLength'] = vi.fn(() => 24)
    const reply = await sendConfigGet(ctx, replies, 'config.getRenameMaxLength')
    expect(reply).toMatchObject({ type: 'config.renameMaxLength', id: 'm1' })
    expect(reply.payload).toEqual({ maxLength: 24 })
    expect(ctx.sendError).not.toHaveBeenCalled()
  })

  it('set：调 setRenameMaxLength(payload.maxLength) + reply 读回生效值', async () => {
    const { ctx, replies, configService } = mockCtx_m4()
    let stored = 50
    ;(configService as Record<string, unknown>)['getRenameMaxLength'] = vi.fn(() => stored)
    ;(configService as Record<string, unknown>)['setRenameMaxLength'] = vi.fn((n: number) => { stored = n })
    const handler = new SettingsMessageHandler(ctx)
    const handled = await handler.handleSettingsMessage(
      { type: 'config.setRenameMaxLength', payload: { maxLength: 80 }, id: 'm2' } as unknown as ClientMessage,
      WS_m2_m2,
    )
    expect(handled).toBe(true)
    expect((configService as unknown as Record<string, ReturnType<typeof vi.fn>>)['setRenameMaxLength']).toHaveBeenCalledWith(80)
    expect(replies[0]).toMatchObject({ type: 'config.renameMaxLength', id: 'm2' })
    expect(replies[0].payload).toEqual({ maxLength: 80 })
    expect(ctx.sendError).not.toHaveBeenCalled()
  })
})
});
// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('settings-message-handler-reveal-apikey', () => {
describe('SettingsMessageHandler · config.revealProviderApiKey', () => {
  it('resolver 命中 api_key 原值 → 回显明文 + source（按 providerId 查询）', async () => {
    const m = mockCtx_m5({ revealed: { apiKey: 'sk-from-auth', source: 'auth.json' } })
    const reply = await sendReveal(m.ctx, m.replies, 'p-catalog')

    expect(reply).toMatchObject({ type: 'config.providerApiKeyRevealed', id: 'm1' })
    expect(reply.payload).toEqual({ available: true, apiKey: 'sk-from-auth', source: 'auth.json' })
    expect(m.resolveProviderApiKeyRaw).toHaveBeenCalledWith('p-catalog')
  })

  it('resolver 未命中（无凭据 / oauth-only / 不可回显形态）→ available:false，不报错', async () => {
    const m = mockCtx_m5({})
    const reply = await sendReveal(m.ctx, m.replies)

    expect(reply.payload).toEqual({ available: false })
    expect(m.ctx.sendError).not.toHaveBeenCalled()
  })

  it('非法 / 缺失 payload（providerId 非字符串 / 空串 / payload 缺失）→ invalid_payload，不调 resolver、无 reply', async () => {
    for (const payload of [{ providerId: 42 }, { providerId: '' }, {}, undefined, null] as unknown as Array<{ providerId?: unknown }>) {
      const m = mockCtx_m5({})
      const handler = new SettingsMessageHandler(m.ctx)
      const handled = await handler.handleSettingsMessage(
        { type: 'config.revealProviderApiKey', payload, id: 'm1' } as unknown as ClientMessage,
        WS_m2_m2,
      )
      expect(handled).toBe(true)
      expect(m.ctx.sendError).toHaveBeenCalledWith(WS_m2_m2, 'invalid_payload', expect.any(String), 'm1')
      expect(m.resolveProviderApiKeyRaw).not.toHaveBeenCalled()
      expect(m.replies).toHaveLength(0)
    }
  })
})
});
// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('settings-message-handler-supported-levels', () => {
describe('SettingsMessageHandler · config.getProviders supportedLevels 接线（U5）', () => {
  it('reply 的 providers 逐模型带 pi-ai 同源 supportedLevels（与广播链路同标）', async () => {
    const modelService = makeRegistryBackedModelService()
    const { ctx, replies } = mockCtx_m6(modelService)
    const handler = new SettingsMessageHandler(ctx)

    await handler.handleSettingsMessage(getProvidersMsg(), WS_m3)

    expect(ctx.reply).toHaveBeenCalledTimes(1)
    const { providers } = replies[0].payload as { providers: ProviderInfo[] }
    // pi 两级门控：reasoning:true 无 thinkingLevelMap → 全档位；缺省 → ['off']
    expect(providers[0].models[0].supportedLevels).toEqual(['off', 'minimal', 'low', 'medium', 'high'])
    expect(providers[0].models[1].supportedLevels).toEqual(['off'])
  })

  it('modelService 缺 attachSupportedLevels（调用抛 TypeError）→ providers 原样 reply 不抛（降级兜底）', async () => {
    const { ctx, replies } = mockCtx_m6({ aggregateModels: vi.fn(() => []) })
    const handler = new SettingsMessageHandler(ctx)

    await expect(handler.handleSettingsMessage(getProvidersMsg(), WS_m3)).resolves.toBe(true)

    const { providers } = replies[0].payload as { providers: ProviderInfo[] }
    expect(providers).toEqual(PROVIDERS)
    expect(providers[0].models[0].supportedLevels).toBeUndefined()
  })
})
});
});

// ======================================================================
// ← connection-broker-bundle.test.ts
// ======================================================================

const TOKEN = 'test-token'


/** stop() 必须在该上界内 resolve：正常路径毫秒级；修复前该用例挂死（无上界可满足）。 */
const STOP_DEADLINE_MS = 5_000


interface Harness {
  port: number
  conn: ConnectionManager
  httpServer: HttpServer
}


async function startHarness(): Promise<Harness> {
  // ConnectionManager 自建 httpServer + wss（同生产构造路径），port 0 = 随机空闲端口。
  const conn = new ConnectionManager(0, {
    onConnect: () => {},
    onMessage: async () => {},
    sendError: () => {},
  }, TOKEN)
  await conn.start()
  // httpServer 是 private（生产 API 不暴露），测试经类型透视取真实端口与连接计数断言范围。
  const httpServer = (conn as unknown as { httpServer: HttpServer }).httpServer
  const addr = httpServer.address() as AddressInfo | null
  if (!addr) throw new Error('httpServer has no address after start()')
  return { port: addr.port, conn, httpServer }
}


/** 建立并完成 auth 握手的客户端连接（模拟 renderer）。 */
async function connectAndAuth(port: number): Promise<WsType> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`)
  await new Promise<void>((resolve, reject) => {
    ws.on('open', resolve)
    ws.on('error', reject)
  })
  const authResult = new Promise<boolean>((resolve, reject) => {
    ws.once('message', (data) => {
      try {
        const msg_m2 = JSON.parse(String(data)) as {
          type: string
          payload?: { ok?: boolean; runtimeId?: string | null }
        }
        if (msg_m2.type !== 'auth.result') {
          reject(new Error(`expected auth.result, got ${msg_m2.type}`))
          return
        }
        // auth 应答实例标识回传（connection-datasync-ssot §6.1）：本 harness 未注入
        // runtimeId → 缺省 null 形态（缺失容忍，不 fail-closed——对照 token）。
        expect(msg_m2.payload).toMatchObject({ ok: true, runtimeId: null })
        resolve(msg_m2.payload?.ok === true)
      } catch (e) { reject(e) }
    })
  })
  ws.send(JSON.stringify({ type: 'auth', payload: { token: TOKEN } }))
  expect(await authResult).toBe(true)
  return ws
}


function withDeadline<T>(promise: Promise<T>, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`${label} did not resolve within ${STOP_DEADLINE_MS}ms (hang regression)`)), STOP_DEADLINE_MS).unref()
    }),
  ])
}


// ======================================================================
// ← src/transport/message-broker-appinfo.test.ts
// ======================================================================

function makeBroker(appInfo: { appVersion: string; piVersion: string }) {
  const sent: string[] = []
  const fakeWs = {
    readyState: 1,
    send: (payload: string) => { sent.push(payload) },
  }
  const pool = { clients: new Set([fakeWs]) } as unknown as ClientPool
  const services = {
    sessionService: { listPersistedSessions: vi.fn(() => []) },
    configService: {
      listProviders: vi.fn(() => []),
      // M4/RT-3#4：buildProviderListMsgs 读降级态标志（config.providers 帧新增字段）
      isModelsStoreCorrupted: vi.fn(() => false),
      loadSkills: vi.fn(() => []),
      loadAgents: vi.fn(() => []),
      getSkillPathScopes: vi.fn(() => ({ projectPaths: [], globalPaths: [] })),
      getAgentPathScopes: vi.fn(() => ({ projectPaths: [], globalPaths: [] })),
      getExtensionPathScopes: vi.fn(() => ({ projectPaths: [], globalPaths: [] })),
      getDefaultModel: vi.fn(() => null),
      getSystemPromptConfig: vi.fn(() => ({ config: null, corrupted: false })),
      getTerminalConfig: vi.fn(() => ({ config: null, corrupted: false })),
    },
    modelService: { aggregateModels: vi.fn(() => []) },
    pluginService: undefined,
    extensionService: undefined,
    projectRoot: '/test',
    appInfo,
  } as unknown as BrokerServices
  const broker = new ServerMessageBroker(pool, services)
  return { broker, sent, fakeWs }
}


// ======================================================================
// ← src/transport/message-broker-supported-levels.test.ts
// ======================================================================

const PROVIDERS_m2: ProviderInfo[] = [
  {
    id: 'kimi-coding' as ProviderId,
    name: 'Kimi Coding',
    apiKeySet: true,
    status: 'connected',
    models: [
      { id: 'k3', name: 'K3', reasoning: true },
      { id: 'k2', name: 'K2' },
    ],
  },
]


/** 模拟 attachSupportedLevels（model-capability.js）的 view-ready 标注（逐模型加数组字段）。 */
function makeAnnotatingModelService(levelsByModel: Record<string, string[]>) {
  return {
    aggregateModelsWithScoped: vi.fn((providers: ProviderInfo[]) =>
      providers.flatMap(p => p.models.map(m => ({ id: m.id, providerId: p.id }))),
    ),
    attachSupportedLevels: vi.fn((providers: ProviderInfo[]) =>
      providers.map(p => ({
        ...p,
        models: p.models.map(m => ({ ...m, supportedLevels: levelsByModel[m.id] })),
      })),
    ),
  }
}


function makeBroker_m2(modelService: unknown, appInfo = { appVersion: '1.2.3', piVersion: '9.9.9' }) {
  const sent: string[] = []
  const fakeWs = {
    readyState: 1,
    send: (payload: string) => { sent.push(payload) },
  }
  const pool = { clients: new Set([fakeWs]) } as unknown as ClientPool
  const services = {
    sessionService: { listPersistedSessions: vi.fn(() => []) },
    configService: {
      listProviders: vi.fn(() => PROVIDERS_m2),
      // M4/RT-3#4：buildProviderListMsgs 读降级态标志（config.providers 帧新增字段）
      isModelsStoreCorrupted: vi.fn(() => false),
      getScopedModels: vi.fn(() => []),
      loadSkills: vi.fn(() => []),
      loadAgents: vi.fn(() => []),
      getSkillPathScopes: vi.fn(() => ({ projectPaths: [], globalPaths: [] })),
      getAgentPathScopes: vi.fn(() => ({ projectPaths: [], globalPaths: [] })),
      getExtensionPathScopes: vi.fn(() => ({ projectPaths: [], globalPaths: [] })),
      getDefaultModel: vi.fn(() => null),
      getSystemPromptConfig: vi.fn(() => ({ config: null, corrupted: false })),
      getTerminalConfig: vi.fn(() => ({ config: null, corrupted: false })),
    },
    modelService,
    pluginService: undefined,
    extensionService: undefined,
    projectRoot: '/test',
    appInfo,
  } as unknown as BrokerServices
  return { broker: new ServerMessageBroker(pool, services), sent, fakeWs }
}


function parseSent(sent: string[]): ServerMessage[] {
  return sent.map((s) => JSON.parse(s) as ServerMessage)
}


// ======================================================================
// ← src/transport/resources-message-handler.test.ts
// ======================================================================

function mockWs_m2_d1(): WsType {
  return { send: vi.fn(), readyState: 1 } as unknown as WsType
}


function mockContext_m2_d1() {
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


function msg_m2_d1(type: string, payload: Record<string, unknown> = {}, id = 'msg-1'): ClientMessage {
  return { type, payload, id } as unknown as ClientMessage
}

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('connection-broker-bundle', () => {
// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('connection-manager.stop', () => {
describe('ConnectionManager.stop() — A4 rolling-restart hang regression', () => {
  let harness: Harness
  const openedClients: WsType[] = []

  beforeEach(async () => {
    harness = await startHarness()
  })

  afterEach(() => {
    // 测试内建 stop 断言服务端已关；客户端 socket 兜底 terminate（已死则 no-op）。
    for (const ws of openedClients.reverse()) ws.terminate()
    openedClients.length = 0
  })

  it('resolves while an authed WS client is still connected (the hang scenario)', async () => {
    // 修复前：authed 连接保持 → httpServer.close 回调永不触发 → stop 永不 resolve。
    const ws = await connectAndAuth(harness.port)
    openedClients.push(ws)
    expect(harness.conn.clients.size).toBe(1)
    await withDeadline(harness.conn.stop(), 'stop() with authed client')
    // stop 后服务端连接池清空（客户端被服务端关闭触发 handleClose）。
    await vi.waitFor(() => { expect(harness.conn.clients.size).toBe(0) }, { interval: 1 })
  })

  it('resolves while an idle keep-alive HTTP connection is open', async () => {
    // 模拟 main 侧 liveness 探针：/health 响应完成后连接保持（node:http 默认 agent 带 keep-alive 头）。
    const done = new Promise<void>((resolve, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port: harness.port, path: '/health' }, (res) => {
        res.resume()
        res.on('end', resolve)
      })
      req.on('error', reject)
      req.end()
    })
    await withDeadline(done, '/health request')
    await withDeadline(harness.conn.stop(), 'stop() with keep-alive connection')
  })
})
});
// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('message-broker-appinfo', () => {
describe('ServerMessageBroker.broadcastAppInfo（D8-2）', () => {
  it('补发：broadcastAppInfo 广播当前 appInfo（含 mutate 后的 piVersion）', () => {
    const appInfo = { appVersion: '1.2.3', piVersion: 'unknown' }
    const { broker, sent } = makeBroker(appInfo)
    // 模拟 D8-2 流程：getPiVersion 完成后 mutate 同对象 + 补发
    appInfo.piVersion = '9.9.9'
    broker.broadcastAppInfo()
    expect(sent).toHaveLength(1)
    const msg_m2_d1 = JSON.parse(sent[0]) as ServerMessage<'app.info'>
    expect(msg_m2_d1.type).toBe('app.info')
    expect(msg_m2_d1.payload).toEqual({ appVersion: '1.2.3', piVersion: '9.9.9' })
  })

  it('订阅者收到第二次 app.info 广播（sendInitialState 首推 unknown → mutate → 补发新值）', () => {
    const appInfo = { appVersion: '1.2.3', piVersion: 'unknown' }
    const { broker, sent, fakeWs } = makeBroker(appInfo)
    // 首推：连接时 app.info 为 unknown（listen 后立即连接，探测未完成）
    broker.sendInitialState(fakeWs as unknown as import('ws').WebSocket)
    const first = sent.map((s) => JSON.parse(s) as ServerMessage).find((m) => m.type === 'app.info')
    expect(first?.payload).toEqual({ appVersion: '1.2.3', piVersion: 'unknown' })

    // 探测完成：mutate 同对象 + 补发 → 订阅者收到第二次 app.info，piVersion 已更新
    appInfo.piVersion = '9.9.9'
    broker.broadcastAppInfo()
    const appInfoMsgs = sent.map((s) => JSON.parse(s) as ServerMessage).filter((m) => m.type === 'app.info')
    expect(appInfoMsgs).toHaveLength(2)
    expect(appInfoMsgs[1].payload).toEqual({ appVersion: '1.2.3', piVersion: '9.9.9' })
  })
})
});
// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('message-broker-supported-levels', () => {
describe('ServerMessageBroker supportedLevels 接线（U5）', () => {
  it('broadcastProviderList：config.providers 的 models 带 supportedLevels 数组，pi 版本取 appInfo.piVersion', () => {
    const modelService = makeAnnotatingModelService({ k3: ['off', 'low', 'high'], k2: ['off'] })
    const { broker, sent } = makeBroker_m2(modelService)

    broker.broadcastProviderList()

    const providersMsg = parseSent(sent).find((m) => m.type === 'config.providers')
    expect(providersMsg).toBeDefined()
    const { providers } = providersMsg!.payload as { providers: ProviderInfo[] }
    expect(providers[0].models[0].supportedLevels).toEqual(['off', 'low', 'high'])
    expect(providers[0].models[1].supportedLevels).toEqual(['off'])
    // pi 版本同源 app.info（D8-2 组合根 mutate services.appInfo 后此处读到当前值）
    expect(modelService.attachSupportedLevels).toHaveBeenCalledWith(PROVIDERS_m2, '9.9.9')
  })

  it('sendInitialState：初始推送的 config.providers 同样标注（buildProviderListMsgs 共享）', () => {
    const modelService = makeAnnotatingModelService({ k3: ['off'], k2: ['off'] })
    const { broker, sent, fakeWs } = makeBroker_m2(modelService)

    broker.sendInitialState(fakeWs as unknown as import('ws').WebSocket)

    const providersMsg = parseSent(sent).find((m) => m.type === 'config.providers')
    const { providers } = providersMsg!.payload as { providers: ProviderInfo[] }
    expect(providers[0].models[0].supportedLevels).toEqual(['off'])
  })

  it('model.list 帧：ModelInfo 映射白名单不透传 supportedLevels（model.list 形状不变）', () => {
    const modelService = makeAnnotatingModelService({ k3: ['off'], k2: ['off'] })
    const { broker, sent } = makeBroker_m2(modelService)

    broker.broadcastProviderList()

    const modelListMsg = parseSent(sent).find((m) => m.type === 'model.list')
    const { models } = modelListMsg!.payload as { models: Array<{ id: string; supportedLevels?: string[] }> }
    expect(models).toHaveLength(2)
    for (const m of models) expect(m.supportedLevels).toBeUndefined()
  })

  it('降级 A：modelService 缺 attachSupportedLevels（调用抛 TypeError）→ providers 原样下发不抛', () => {
    const { broker, sent } = makeBroker_m2({ aggregateModelsWithScoped: vi.fn(() => []) })

    expect(() => broker.broadcastProviderList()).not.toThrow()
    const providersMsg = parseSent(sent).find((m) => m.type === 'config.providers')
    const { providers } = providersMsg!.payload as { providers: ProviderInfo[] }
    expect(providers).toEqual(PROVIDERS_m2)
    expect(providers[0].models[0].supportedLevels).toBeUndefined()
  })

  it('降级 B：标注抛错 → warn 不阻断，config.providers 与 model.list 两帧照常下发', () => {
    const modelService = {
      aggregateModelsWithScoped: vi.fn(() => [{ id: 'k3', providerId: 'kimi-coding' }]),
      attachSupportedLevels: vi.fn(() => { throw new Error('builtin mtime unreadable') }),
    }
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { broker, sent } = makeBroker_m2(modelService)

      expect(() => broker.broadcastProviderList()).not.toThrow()
      const types = parseSent(sent).map((m) => m.type)
      expect(types).toContain('config.providers')
      expect(types).toContain('model.list')
      const providersMsg = parseSent(sent).find((m) => m.type === 'config.providers')
      const { providers } = providersMsg!.payload as { providers: ProviderInfo[] }
      expect(providers[0].models[0].supportedLevels).toBeUndefined()
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('attachSupportedLevels failed'), expect.any(Error))
    } finally {
      warnSpy.mockRestore()
    }
  })
})
});
// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('resources-message-handler', () => {
describe('ResourcesMessageHandler config.setSkillDirs 失效编排（缓存治理 1-5）', () => {
  it('操作后缓存失效：rebuildGlobal 失败分支同样调 invalidateAllProjects + 广播失效', async () => {
    const { ctx, skillRegistry } = mockContext_m2_d1()
    skillRegistry.rebuildGlobal.mockRejectedValue(new Error('rebuild failed'))
    const handler = new ResourcesMessageHandler(ctx)
    const ws = mockWs_m2_d1()

    await expect(handler.handle(msg_m2_d1('config.setSkillDirs', { dirs: ['/project/.agents/skills'] }), ws))
      .resolves.toBe(true)

    await vi.waitFor(() => expect(skillRegistry.invalidateAllProjects).toHaveBeenCalledTimes(1), { interval: 1 })
    expect(ctx.broadcastSkillCacheInvalidated).toHaveBeenCalledWith('project')
    // 失败不阻塞 WS 消息处理：reply 正常发出
    expect(ctx.reply).toHaveBeenCalled()
  })

  it('下次读为新值：失败失效后 getProjectSkills 读到重扫值（旧值 → 失效 → 新值）', async () => {
    const { ctx, skillRegistry } = mockContext_m2_d1()
    skillRegistry.rebuildGlobal.mockRejectedValue(new Error('rebuild failed'))
    skillRegistry.getProjectSkills
      .mockResolvedValueOnce([{ id: 'old-skill' }]) // 失效前读：旧缓存
      .mockResolvedValueOnce([{ id: 'new-skill' }]) // 失效后读：重扫新值
    const handler = new ResourcesMessageHandler(ctx)
    const ws = mockWs_m2_d1()

    // 操作前：projectCache 持旧值
    await handler.handle(msg_m2_d1('config.getProjectSkills', { cwd: '/project' }), ws)
    expect(ctx.reply).toHaveBeenCalledWith(
      ws,
      'msg-1',
      'config.projectSkills',
      { skills: [{ id: 'old-skill' }] },
    )

    // 操作（目录管道写入，rebuild 失败）：失败分支清 projectCache
    await handler.handle(msg_m2_d1('config.setSkillDirs', { dirs: ['/project/.agents/skills'] }), ws)
    await vi.waitFor(() => expect(skillRegistry.invalidateAllProjects).toHaveBeenCalledTimes(1), { interval: 1 })

    // 操作后：下次读为新值（invalidate 清缓存 → getProjectSkills 重扫）
    await handler.handle(msg_m2_d1('config.getProjectSkills', { cwd: '/project' }), ws)
    expect(ctx.reply).toHaveBeenLastCalledWith(
      ws,
      'msg-1',
      'config.projectSkills',
      { skills: [{ id: 'new-skill' }] },
    )
  })

  it('成功路径不回归：invalidate + broadcast 照旧', async () => {
    const { ctx, skillRegistry } = mockContext_m2_d1()
    skillRegistry.rebuildGlobal.mockResolvedValue(undefined)
    const handler = new ResourcesMessageHandler(ctx)
    const ws = mockWs_m2_d1()

    await handler.handle(msg_m2_d1('config.setSkillDirs', { dirs: ['/project/.agents/skills'] }), ws)

    await vi.waitFor(() => expect(skillRegistry.invalidateAllProjects).toHaveBeenCalledTimes(1), { interval: 1 })
    expect(ctx.broadcastSkillCacheInvalidated).toHaveBeenCalledWith('project')
    expect(ctx.broadcastSkillDirs).toHaveBeenCalled()
    expect(ctx.broadcastSkillList).toHaveBeenCalled()
  })
})
});
});
