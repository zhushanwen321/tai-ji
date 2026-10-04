/**
 * worktree 域薄封装单测 —— 验证 RPC type / payload 形状 + RPC_BACKSTOP_TIMEOUT_MS 超时取值。
 * mock 链路同 domains.test.ts（vi.mock '../request'，模块 ID 与 domains/worktree.ts 内部 import 一致）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockCommand = vi.fn<(type: string, payload: unknown, timeoutMs?: number) => Promise<Record<string, unknown>>>()
vi.mock('../request', () => ({
  command: (type: string, payload: unknown, timeoutMs?: number) => mockCommand(type, payload, timeoutMs),
}))

import { worktreeApi } from '../domains/worktree'
import { RPC_BACKSTOP_TIMEOUT_MS } from '../pending'

beforeEach(() => {
  vi.clearAllMocks()
  mockCommand.mockImplementation(async () => ({}))
})

describe('worktree 域 RPC 封装', () => {
  it('create 透传 WorktreeCreateParams 并原样返回 reply', async () => {
    const reply = { cwd: '/ws/root/wt/feat-x', branch: 'feat-x' }
    mockCommand.mockResolvedValue(reply)
    const params = { branch: 'feat-x', baseBranch: 'main', workspaceHint: 'dev' }
    const r = await worktreeApi.create(params)
    // create 是长任务（git add + setup 脚本 + 失败回滚），显式传长任务校准超时 600s
    // 而非控制面 65s 兜底——详见 domains/worktree.ts 的 WORKTREE_CREATE_RPC_TIMEOUT_MS 注释
    expect(mockCommand).toHaveBeenCalledWith('worktree.create', params, 600_000)
    expect(r).toEqual(reply)
  })

  it('listBranches 携带 cwd', async () => {
    const reply = { branches: [], defaultBranch: 'main' }
    mockCommand.mockResolvedValue(reply)
    const r = await worktreeApi.listBranches('/ws/root')
    expect(mockCommand).toHaveBeenCalledWith('worktree.listBranches', { cwd: '/ws/root' }, RPC_BACKSTOP_TIMEOUT_MS)
    expect(r).toEqual(reply)
  })

  it('list 携带 cwd', async () => {
    const reply = { worktrees: [] }
    mockCommand.mockResolvedValue(reply)
    const r = await worktreeApi.list('/ws/root')
    expect(mockCommand).toHaveBeenCalledWith('worktree.list', { cwd: '/ws/root' }, RPC_BACKSTOP_TIMEOUT_MS)
    expect(r).toEqual(reply)
  })
})
