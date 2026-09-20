/**
 * WorkspaceMessageHandler — workspace.detectBare RPC 贯穿测试（W2 wave）。
 *
 * 背景：landing 态的 isBareWorkspace 需由 pendingCwd 驱动（取代旧 gitInfo.isBare 派生），
 * 前端选定/预填目录后主动调 workspace.detectBare({cwd}) 让 runtime 检测是否处于
 * bare repo + worktree 结构（复用 WorkspaceDetector.detectBareWorkspace），reply
 * workspace.bareDetected 回灌前端 isBare ref。
 *
 * 红灯原因（实现未写，TDD 红灯合理）：
 * 1. ClientMessageType 联合类型无 'workspace.detectBare' → 构造 ClientMessage 时
 *    TS 类型不匹配（运行时仍可强转 as unknown as ClientMessage 通过，所以运行期红灯
 *    来自 handler：handles 清单无此 type + switch 无此 case → handleWorkspaceMessage
 *    走到末尾不 reply → cap.replies 为空）。
 * 2. WorkspaceService 无 detectBare 方法 → mock 时 workspaceService.detectBare 为
 *    undefined（不影响 mock 注入，但真实链路缺失）。
 *
 * 用例（DB-1/DB-2）对齐 BareWorkspaceResult → {isBare, wsRoot, barePath} 映射：
 * - detector 返 {isBareMode:true, wsRoot, barePath} → handler reply {isBare:true, wsRoot, barePath}
 * - detector 返 {isBareMode:false, wsRoot:'', barePath:''} → handler reply {isBare:false, wsRoot:'', barePath:''}
 *
 * 运行：cd packages/runtime && npx vitest run test/workspace-detect-bare-handler.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ClientMessage } from '@taiji/shared'

describe('WorkspaceMessageHandler — workspace.detectBare RPC 贯穿（W2）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('DB-1: workspace.detectBare({cwd: bare-ws}) → reply workspace.bareDetected {isBare:true, wsRoot, barePath}', async () => {
    const { WorkspaceMessageHandler } = await import('../src/transport/workspace-message-handler.js')
    const cap = {
      replies: [] as Array<{ id: string | undefined; type: string; payload: Record<string, unknown> }>,
    }
    // mock workspaceService.detectBare 返回 detector 的裸结构（isBareMode/wsRoot/barePath）
    const workspaceService = {
      list: vi.fn().mockReturnValue([]),
      record: vi.fn(),
      detectBare: vi.fn().mockResolvedValue({
        isBareMode: true,
        wsRoot: '/code/taiji-workspace',
        barePath: '/code/taiji-workspace/.bare',
      }),
    }
    const ctx = {
      send: vi.fn(),
      sendError: vi.fn(),
      reply: vi.fn((_ws: unknown, id: string | undefined, type: string, payload: Record<string, unknown>) => {
        cap.replies.push({ id, type, payload })
      }),
      workspaceService,
    }
    const handler = new WorkspaceMessageHandler(
      ctx as unknown as ConstructorParameters<typeof WorkspaceMessageHandler>[0],
    )
    const msg = {
      type: 'workspace.detectBare',
      id: 'req-db1',
      payload: { cwd: '/code/taiji-workspace/fix-new-worktree-folder' },
    } as unknown as ClientMessage
    const WS = {} as never

    await handler.handleWorkspaceMessage(msg, WS)

    // detector 被调，传入 cwd
    expect(workspaceService.detectBare).toHaveBeenCalledTimes(1)
    expect(workspaceService.detectBare).toHaveBeenCalledWith('/code/taiji-workspace/fix-new-worktree-folder')
    // reply workspace.bareDetected，payload 映射 isBareMode→isBare
    expect(cap.replies).toHaveLength(1)
    expect(cap.replies[0]).toMatchObject({
      id: 'req-db1',
      type: 'workspace.bareDetected',
      payload: {
        isBare: true,
        wsRoot: '/code/taiji-workspace',
        barePath: '/code/taiji-workspace/.bare',
      },
    })
  })

  it('DB-2: workspace.detectBare({cwd: normal-dir}) → reply {isBare:false, wsRoot:"", barePath:""}', async () => {
    const { WorkspaceMessageHandler } = await import('../src/transport/workspace-message-handler.js')
    const cap = {
      replies: [] as Array<{ id: string | undefined; type: string; payload: Record<string, unknown> }>,
    }
    const workspaceService = {
      list: vi.fn().mockReturnValue([]),
      record: vi.fn(),
      detectBare: vi.fn().mockResolvedValue({
        isBareMode: false,
        wsRoot: '',
        barePath: '',
      }),
    }
    const ctx = {
      send: vi.fn(),
      sendError: vi.fn(),
      reply: vi.fn((_ws: unknown, id: string | undefined, type: string, payload: Record<string, unknown>) => {
        cap.replies.push({ id, type, payload })
      }),
      workspaceService,
    }
    const handler = new WorkspaceMessageHandler(
      ctx as unknown as ConstructorParameters<typeof WorkspaceMessageHandler>[0],
    )
    const msg = {
      type: 'workspace.detectBare',
      id: 'req-db2',
      payload: { cwd: '/normal/dir' },
    } as unknown as ClientMessage
    const WS = {} as never

    await handler.handleWorkspaceMessage(msg, WS)

    expect(workspaceService.detectBare).toHaveBeenCalledWith('/normal/dir')
    expect(cap.replies).toHaveLength(1)
    expect(cap.replies[0]).toMatchObject({
      id: 'req-db2',
      type: 'workspace.bareDetected',
      payload: { isBare: false, wsRoot: '', barePath: '' },
    })
  })

  it('DB-3: workspace.detectBare 在 handles 清单中（路由注册）', async () => {
    const { WorkspaceMessageHandler } = await import('../src/transport/workspace-message-handler.js')
    const ctx = {
      send: vi.fn(),
      sendError: vi.fn(),
      reply: vi.fn(),
      workspaceService: { list: vi.fn(), record: vi.fn(), detectBare: vi.fn() },
    }
    const handler = new WorkspaceMessageHandler(
      ctx as unknown as ConstructorParameters<typeof WorkspaceMessageHandler>[0],
    )
    expect(handler.handles).toContain('workspace.detectBare')
  })

  it('DB-4: workspace.detectBare({cwd:""}) → 空 cwd 守卫：reply {isBare:false,...} 且 detectBare 未被调', async () => {
    const { WorkspaceMessageHandler } = await import('../src/transport/workspace-message-handler.js')
    const cap = {
      replies: [] as Array<{ id: string | undefined; type: string; payload: Record<string, unknown> }>,
    }
    const workspaceService = {
      list: vi.fn().mockReturnValue([]),
      record: vi.fn(),
      detectBare: vi.fn().mockResolvedValue({ isBareMode: true, wsRoot: '/x', barePath: '/x/.bare' }),
    }
    const ctx = {
      send: vi.fn(),
      sendError: vi.fn(),
      reply: vi.fn((_ws: unknown, id: string | undefined, type: string, payload: Record<string, unknown>) => {
        cap.replies.push({ id, type, payload })
      }),
      workspaceService,
    }
    const handler = new WorkspaceMessageHandler(
      ctx as unknown as ConstructorParameters<typeof WorkspaceMessageHandler>[0],
    )
    const msg = {
      type: 'workspace.detectBare',
      id: 'req-db4',
      payload: { cwd: '' },
    } as unknown as ClientMessage
    const WS = {} as never

    await handler.handleWorkspaceMessage(msg, WS)

    // 守卫命中：detectBare 根本没被调用
    expect(workspaceService.detectBare).not.toHaveBeenCalled()
    // 仍必须 reply，保证前端 pending Promise resolve
    expect(cap.replies).toHaveLength(1)
    expect(cap.replies[0]).toMatchObject({
      id: 'req-db4',
      type: 'workspace.bareDetected',
      payload: { isBare: false, wsRoot: '', barePath: '' },
    })
  })

  it('DB-5: workspaceService.detectBare 拋错 → handler catch 后 reply {isBare:false,...}（不破坏 RPC 契约）', async () => {
    const { WorkspaceMessageHandler } = await import('../src/transport/workspace-message-handler.js')
    const cap = {
      replies: [] as Array<{ id: string | undefined; type: string; payload: Record<string, unknown> }>,
    }
    const workspaceService = {
      list: vi.fn().mockReturnValue([]),
      record: vi.fn(),
      detectBare: vi.fn().mockRejectedValue(new Error('stat fail')),
    }
    const ctx = {
      send: vi.fn(),
      sendError: vi.fn(),
      reply: vi.fn((_ws: unknown, id: string | undefined, type: string, payload: Record<string, unknown>) => {
        cap.replies.push({ id, type, payload })
      }),
      workspaceService,
    }
    const handler = new WorkspaceMessageHandler(
      ctx as unknown as ConstructorParameters<typeof WorkspaceMessageHandler>[0],
    )
    const msg = {
      type: 'workspace.detectBare',
      id: 'req-db5',
      payload: { cwd: '/some/dir' },
    } as unknown as ClientMessage
    const WS = {} as never

    await handler.handleWorkspaceMessage(msg, WS)

    expect(workspaceService.detectBare).toHaveBeenCalledTimes(1)
    expect(workspaceService.detectBare).toHaveBeenCalledWith('/some/dir')
    // 拋错也被 catch，reply 降级为 isBare:false（RPC 契约不破）
    expect(cap.replies).toHaveLength(1)
    expect(cap.replies[0]).toMatchObject({
      id: 'req-db5',
      type: 'workspace.bareDetected',
      payload: { isBare: false, wsRoot: '', barePath: '' },
    })
  })

  it('DB-6（RT-1#2）: detector 拋错 → reply 附 degraded:true + hint，且 warn 留痕（降级不静默）', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { WorkspaceMessageHandler } = await import('../src/transport/workspace-message-handler.js')
      const cap = {
        replies: [] as Array<{ id: string | undefined; type: string; payload: Record<string, unknown> }>,
      }
      const workspaceService = {
        list: vi.fn().mockReturnValue([]),
        record: vi.fn(),
        detectBare: vi.fn().mockRejectedValue(new Error('detector crash')),
      }
      const ctx = {
        send: vi.fn(),
        sendError: vi.fn(),
        reply: vi.fn((_ws: unknown, id: string | undefined, type: string, payload: Record<string, unknown>) => {
          cap.replies.push({ id, type, payload })
        }),
        workspaceService,
      }
      const handler = new WorkspaceMessageHandler(
        ctx as unknown as ConstructorParameters<typeof WorkspaceMessageHandler>[0],
      )
      const msg = {
        type: 'workspace.detectBare',
        id: 'req-db6',
        payload: { cwd: '/some/dir' },
      } as unknown as ClientMessage

      await handler.handleWorkspaceMessage(msg, {} as never)

      // degraded 形态：isBare:false 是兜底值而非探测结果，前端可区分；hint 给恢复指引
      expect(cap.replies[0]).toMatchObject({
        type: 'workspace.bareDetected',
        payload: { isBare: false, degraded: true, hint: expect.any(String) },
      })
      // 三径全 success 形态零日志的旧缺陷已修：拋错路径必留 warn
      expect(console.warn).toHaveBeenCalledWith(
        expect.stringContaining('workspace.detectBare degraded'),
        expect.any(Error),
      )
    } finally {
      vi.mocked(console.warn).mockRestore()
    }
  })

  it('DB-7（RT-1#2）: detectBare 无效 cwd → reply 附 degraded:true + hint + warn（与拋错路径同族）', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { WorkspaceMessageHandler } = await import('../src/transport/workspace-message-handler.js')
      const cap = {
        replies: [] as Array<{ id: string | undefined; type: string; payload: Record<string, unknown> }>,
      }
      const ctx = {
        send: vi.fn(),
        sendError: vi.fn(),
        reply: vi.fn((_ws: unknown, id: string | undefined, type: string, payload: Record<string, unknown>) => {
          cap.replies.push({ id, type, payload })
        }),
        workspaceService: { list: vi.fn().mockReturnValue([]), record: vi.fn(), detectBare: vi.fn() },
      }
      const handler = new WorkspaceMessageHandler(
        ctx as unknown as ConstructorParameters<typeof WorkspaceMessageHandler>[0],
      )
      const msg = { type: 'workspace.detectBare', id: 'req-db7', payload: { cwd: '  ' } } as unknown as ClientMessage

      await handler.handleWorkspaceMessage(msg, {} as never)

      expect(cap.replies[0]).toMatchObject({
        type: 'workspace.bareDetected',
        payload: { isBare: false, degraded: true, hint: expect.any(String) },
      })
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('invalid cwd payload'))
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('DB-8（RT-1#2）: workspace.record 无效 cwd → reply recentList 附 degraded:true + warn（第三径）', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { WorkspaceMessageHandler } = await import('../src/transport/workspace-message-handler.js')
      const cap = {
        replies: [] as Array<{ id: string | undefined; type: string; payload: Record<string, unknown> }>,
      }
      const workspaceService = { list: vi.fn().mockReturnValue([{ path: '/x', lastOpenedAt: 0 }]), record: vi.fn() }
      const ctx = {
        send: vi.fn(),
        sendError: vi.fn(),
        reply: vi.fn((_ws: unknown, id: string | undefined, type: string, payload: Record<string, unknown>) => {
          cap.replies.push({ id, type, payload })
        }),
        workspaceService,
      }
      const handler = new WorkspaceMessageHandler(
        ctx as unknown as ConstructorParameters<typeof WorkspaceMessageHandler>[0],
      )
      const msg = { type: 'workspace.record', id: 'req-db8', payload: { cwd: '' } } as unknown as ClientMessage

      await handler.handleWorkspaceMessage(msg, {} as never)

      // record 未执行，仍 reply 当前列表（RPC 契约），但附 degraded 区分「记录成功」与「校验失败」
      expect(workspaceService.record).not.toHaveBeenCalled()
      expect(cap.replies[0]).toMatchObject({
        type: 'workspace.recentList',
        payload: { records: [{ path: '/x', lastOpenedAt: 0 }], degraded: true },
      })
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('workspace.record degraded'))
    } finally {
      warnSpy.mockRestore()
    }
  })
})
