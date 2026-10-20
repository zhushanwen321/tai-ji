/**
 * DefaultBaseResolver 测试：默认远端挑选顺序 / 默认分支解析 / 幽灵 ref 不进候选。
 *
 * 运行命令：cd packages/runtime && npx vitest run src/services/worktree/default-base-resolver.test.ts
 */
import { describe, it, expect, vi } from 'vitest'
import { DefaultBaseResolver } from './default-base-resolver.js'
import type { IGitExecutor, GitExecutorResult } from '../ports/git-executor.js'
import { GitExecutorError } from '../ports/git-executor.js'

type ExecTable = Map<string, GitExecutorResult>

/** 命令表 mock：精确匹配优先，未知命令 exitCode 1（对齐 worktree-service.test.ts 形态）。 */
function mockGitExecutor(table: ExecTable) {
  return {
    exec: vi.fn(async (_cwd: string, command: string, args?: string[]): Promise<GitExecutorResult> => {
      const fullKey = `${command} ${(args ?? []).join(' ')}`.trim()
      const hit = table.get(fullKey)
      if (hit) return hit
      return { stdout: '', stderr: `unknown command: ${fullKey}`, exitCode: 1 }
    }),
  }
}

function makeResolver(table: ExecTable): DefaultBaseResolver {
  return new DefaultBaseResolver(mockGitExecutor(table) as unknown as IGitExecutor)
}

/** 远端清单 + 可选覆盖，拼基础表。 */
function baseTable(remotes: string[], overrides: ExecTable = new Map()): ExecTable {
  return new Map<string, GitExecutorResult>([
    ['remote', { stdout: remotes.length > 0 ? remotes.join('\n') + '\n' : '', stderr: '', exitCode: remotes.length > 0 ? 0 : 1 }],
    ...overrides,
  ])
}

describe('DefaultBaseResolver', () => {
  it('无远端 → defaultRemote null，defaultBaseRef 本地 main', async () => {
    const r = makeResolver(baseTable([]))
    const result = await r.resolve('/repo')
    expect(result).toEqual({ remotes: [], defaultRemote: null, remoteDefaultBranch: null, defaultBaseRef: 'main' })
  })

  it('单一远端 → 用它；<remote>/HEAD symref 给出默认分支', async () => {
    const r = makeResolver(baseTable(['github'], new Map([
      ['symbolic-ref refs/remotes/github/HEAD', { stdout: 'refs/remotes/github/main\n', stderr: '', exitCode: 0 }],
    ])))
    const result = await r.resolve('/repo')
    expect(result.defaultRemote).toBe('github')
    expect(result.remoteDefaultBranch).toBe('main')
    expect(result.defaultBaseRef).toBe('github/main')
  })

  it('无 checkout.defaultRemote 配置时 origin 优先于清单顺序', async () => {
    const r = makeResolver(baseTable(['upstream', 'origin'], new Map([
      // 显式给出「未配置」形态（git config --get 对缺失键非零退出），不依赖 mock 的未知命令兜底
      ['config --get checkout.defaultRemote', { stdout: '', stderr: '', exitCode: 1 }],
      ['symbolic-ref refs/remotes/origin/HEAD', { stdout: 'refs/remotes/origin/main\n', stderr: '', exitCode: 0 }],
    ])))
    const result = await r.resolve('/repo')
    expect(result.defaultRemote).toBe('origin')
    expect(result.defaultBaseRef).toBe('origin/main')
  })

  it('含 origin 且 checkout.defaultRemote 指向其他远端 → 取配置值（用户显式意图优先于惯例名）', async () => {
    const r = makeResolver(baseTable(['origin', 'github'], new Map([
      ['config --get checkout.defaultRemote', { stdout: 'github\n', stderr: '', exitCode: 0 }],
      ['symbolic-ref refs/remotes/github/HEAD', { stdout: 'refs/remotes/github/main\n', stderr: '', exitCode: 0 }],
      // origin 的 HEAD 同样可解析——确保结果来自配置选择而非 origin 不可用的退路
      ['symbolic-ref refs/remotes/origin/HEAD', { stdout: 'refs/remotes/origin/main\n', stderr: '', exitCode: 0 }],
    ])))
    const result = await r.resolve('/repo')
    expect(result.defaultRemote).toBe('github')
    expect(result.defaultBaseRef).toBe('github/main')
  })

  it('无 origin 时 checkout.defaultRemote 配置优先（且必须在清单内）', async () => {
    const r = makeResolver(baseTable(['github', 'mirror'], new Map([
      ['config --get checkout.defaultRemote', { stdout: 'mirror\n', stderr: '', exitCode: 0 }],
      ['symbolic-ref refs/remotes/mirror/HEAD', { stdout: 'refs/remotes/mirror/main\n', stderr: '', exitCode: 0 }],
    ])))
    const result = await r.resolve('/repo')
    expect(result.defaultRemote).toBe('mirror')
    expect(result.defaultBaseRef).toBe('mirror/main')
  })

  it('checkout.defaultRemote 不在清单内 → 忽略，取清单首个', async () => {
    const r = makeResolver(baseTable(['github', 'mirror'], new Map([
      ['config --get checkout.defaultRemote', { stdout: 'nonexistent\n', stderr: '', exitCode: 0 }],
      ['symbolic-ref refs/remotes/github/HEAD', { stdout: 'refs/remotes/github/main\n', stderr: '', exitCode: 0 }],
    ])))
    const result = await r.resolve('/repo')
    expect(result.defaultRemote).toBe('github')
  })

  it('checkout.defaultRemote 不在清单内且含 origin → 忽略配置，穿透到 origin（非清单首个）', async () => {
    const r = makeResolver(baseTable(['upstream', 'origin'], new Map([
      ['config --get checkout.defaultRemote', { stdout: 'nonexistent\n', stderr: '', exitCode: 0 }],
      ['symbolic-ref refs/remotes/origin/HEAD', { stdout: 'refs/remotes/origin/main\n', stderr: '', exitCode: 0 }],
    ])))
    const result = await r.resolve('/repo')
    expect(result.defaultRemote).toBe('origin')
  })

  it('symref 失败（幽灵直接 ref / 无 HEAD）→ rev-parse 验证 <remote>/main', async () => {
    const r = makeResolver(baseTable(['github'], new Map([
      ['rev-parse --verify github/main', { stdout: 'abc123', stderr: '', exitCode: 0 }],
    ])))
    const result = await r.resolve('/repo')
    expect(result.remoteDefaultBranch).toBe('main')
    expect(result.defaultBaseRef).toBe('github/main')
  })

  it('main 不存在 → master 候选', async () => {
    const r = makeResolver(baseTable(['legacy'], new Map([
      ['rev-parse --verify legacy/master', { stdout: 'abc123', stderr: '', exitCode: 0 }],
    ])))
    const result = await r.resolve('/repo')
    expect(result.remoteDefaultBranch).toBe('master')
    expect(result.defaultBaseRef).toBe('legacy/master')
  })

  it('远端无任何可识别默认分支 → remoteDefaultBranch null，defaultBaseRef 落本地 main', async () => {
    const r = makeResolver(baseTable(['weird']))
    const result = await r.resolve('/repo')
    expect(result.defaultRemote).toBe('weird')
    expect(result.remoteDefaultBranch).toBeNull()
    expect(result.defaultBaseRef).toBe('main')
  })

  it('git remote 命令失败 → 按无远端降级（不抛）', async () => {
    const r = makeResolver(new Map([['remote', { stdout: '', stderr: 'boom', exitCode: 128 }]]))
    const result = await r.resolve('/repo')
    expect(result.remotes).toEqual([])
    expect(result.defaultBaseRef).toBe('main')
  })

  it('safeResolve：exec 抛 GitExecutorError → 不抛、返回 null（降级契约）', async () => {
    const exec = vi.fn(async (_cwd: string, command: string): Promise<GitExecutorResult> => {
      if (command === 'remote') throw new GitExecutorError('git_unavailable', 'git gone')
      return { stdout: '', stderr: '', exitCode: 0 }
    })
    const r = new DefaultBaseResolver(exec as unknown as IGitExecutor)
    await expect(r.safeResolve('/repo')).resolves.toBeNull()
  })

  it('safeResolve：正常路径返回解析结果', async () => {
    const r = makeResolver(baseTable(['origin'], new Map([
      ['symbolic-ref refs/remotes/origin/HEAD', { stdout: 'refs/remotes/origin/main\n', stderr: '', exitCode: 0 }],
    ])))
    const result = await r.safeResolve('/repo')
    expect(result?.defaultBaseRef).toBe('origin/main')
  })
})
