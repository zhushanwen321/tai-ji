/**
 * WorktreeService 测试（W2：三态检测 + plain-repo 模式 + listBranches + list）。
 *
 * 测试框架：vitest（从 vitest 导入 describe/it/expect/vi/beforeEach）。
 * 运行命令：cd packages/runtime && npx vitest run src/services/worktree/worktree-service.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { WorktreeService, type WorktreeServiceDeps } from './worktree-service.js'
import { ShellRunnerError } from '../ports/shell-runner.js'
import { logger } from '../../infra/logger.js'

// mock logger：断言结构化打点（成败/回滚/base fallback），且避免测试写真实日志文件
vi.mock('../../infra/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

// ── mock helpers ─────────────────────────────────────────────

/** 创建 mock IGitExecutor。 */
function mockGitExecutor(overrides?: {
  execResults?: Map<string, { stdout: string; stderr: string; exitCode: number }>
}) {
  const defaultResults = new Map<string, { stdout: string; stderr: string; exitCode: number }>([
    ['rev-parse --verify origin/main', { stdout: 'abc123', stderr: '', exitCode: 0 }],
    ['rev-parse --verify main', { stdout: 'abc123', stderr: '', exitCode: 0 }],
    ['worktree add', { stdout: '', stderr: '', exitCode: 0 }],
    ['branch --list --format=%(refname:short)', { stdout: 'main\nfeat-x\n', stderr: '', exitCode: 0 }],
    ['branch --list --remotes --format=%(refname:short)', { stdout: 'origin/main\norigin/HEAD\norigin/feat-y\n', stderr: '', exitCode: 0 }],
    ['worktree list --porcelain', {
      stdout: 'worktree /project\nHEAD abc123\nbranch refs/heads/main\n\nworktree /project/feat-x\nHEAD def456\nbranch refs/heads/feat-x\n',
      stderr: '',
      exitCode: 0,
    }],
    ['rev-parse --show-toplevel', { stdout: '/project', stderr: '', exitCode: 0 }],
    ['rev-parse --abbrev-ref origin/HEAD', { stdout: 'origin/main', stderr: '', exitCode: 0 }],
    ['rev-parse --verify refs/heads/main', { stdout: 'abc123', stderr: '', exitCode: 0 }],
    ['rev-parse --verify refs/heads/master', { stdout: '', stderr: 'not found', exitCode: 128 }],
  ])

  const allResults = new Map([...defaultResults, ...(overrides?.execResults ?? [])])

  return {
    // 第 4 参 opts（timeoutMs）：RT-8 后续 worktree add/remove 显式传 60s 超时，mock 需收得住
    exec: vi.fn(async (_cwd: string, command: string, args?: string[], _opts?: { timeoutMs?: number }) => {
      const fullKey = `${command} ${(args ?? []).join(' ')}`.trim()
      // 精确匹配优先
      const exact = allResults.get(fullKey)
      if (exact) return exact
      // 前缀匹配（worktree add 等命令的 args 不固定）
      for (const [key, val] of allResults) {
        if (fullKey.startsWith(key)) return val
      }
      return { stdout: '', stderr: `unknown command: ${fullKey}`, exitCode: 1 }
    }),
  }
}

/** 创建 mock IShellRunner。 */
function mockShellRunner() {
  return {
    execute: vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' })),
  }
}

/** 创建 mock IGitInfoReader。 */
function mockGitInfoReader(branch?: string) {
  return {
    readGitInfo: vi.fn(() => (branch ? { branch, isWorktree: false } : undefined)),
    pruneStaleCache: vi.fn(),
  }
}

/**
 * 创建 mock config（WorktreeConfigService 5 方法子集，ISP 收窄 T7——
 * SUT 只消费这 5 个读取方法，无需再 stub IConfigService 胖接口的其余 60+ 方法）。
 */
function mockConfigService(worktreeRootDir = '/home/user/worktrees') {
  return {
    getDefaultBaseBranch: vi.fn(() => 'origin/main'),
    getBareSetupScript: vi.fn(() => 'custom-hooks/setup-worktree.sh'),
    getWorktreeRootDir: vi.fn(() => worktreeRootDir),
    getSetupScript: vi.fn(() => 'custom-hooks/setup-worktree.sh'),
    getTimeout: vi.fn(() => 60),
  }
}

/**
 * 创建 mock fs。files = 内存盘（readFileSync/writeFileSync 的后备存储，config.worktree
 * 补齐路径的写入断言用；测试里传入同一 Map 即可读回写入内容）。
 */
function mockFs(existingPaths = new Set<string>(), files?: Map<string, string>) {
  const disk = files ?? new Map<string, string>()
  return {
    existsSync: vi.fn((p: string) => existingPaths.has(p)),
    statSync: vi.fn((p: string) => {
      if (!existingPaths.has(p)) {
        const e = new Error(`ENOENT: ${p}`) as NodeJS.ErrnoException
        e.code = 'ENOENT'
        throw e
      }
      // 测试中 existingPaths 里的路径默认当目录处理（.bare 等）
      return { isDirectory: () => true, isFile: () => false }
    }),
    readFileSync: vi.fn((p: string, _encoding: 'utf8') => {
      const content = disk.get(p)
      if (content === undefined) {
        const e = new Error(`ENOENT: ${p}`) as NodeJS.ErrnoException
        e.code = 'ENOENT'
        throw e
      }
      return content
    }),
    writeFileSync: vi.fn((p: string, data: string) => {
      disk.set(p, data)
    }),
  }
}

/** 创建完整的 WorktreeServiceDeps。 */
function createDeps(options?: {
  mode?: 'bare-workspace' | 'plain-repo' | 'not-repo'
  existingPaths?: Set<string>
  gitOverrides?: Parameters<typeof mockGitExecutor>[0]
  worktreeRootDir?: string
  /** config.worktree 补齐路径的内存盘（传入同一 Map 可读回写入内容） */
  files?: Map<string, string>
}) {
  const mode = options?.mode ?? 'bare-workspace'
  const existingPaths = options?.existingPaths ?? new Set<string>()

  // 根据 mode 设置 git mock 结果
  const gitOverrides = options?.gitOverrides ?? {}
  if (mode === 'bare-workspace') {
    // bare-workspace 检测：.bare 存在 → fs.existsSync 返回 true
    // 不需要 rev-parse --show-toplevel（阶段 1 就命中了）
  } else if (mode === 'plain-repo') {
    // plain-repo 检测：.bare 不存在，但 rev-parse --show-toplevel 成功
    gitOverrides.execResults = new Map([
      ['rev-parse --show-toplevel', { stdout: '/home/user/my-repo', stderr: '', exitCode: 0 }],
      ['rev-parse --abbrev-ref origin/HEAD', { stdout: 'origin/main', stderr: '', exitCode: 0 }],
      ['rev-parse --verify refs/heads/main', { stdout: 'abc', stderr: '', exitCode: 0 }],
      ['rev-parse --verify origin/main', { stdout: 'abc', stderr: '', exitCode: 0 }],
      ['rev-parse --verify main', { stdout: 'abc', stderr: '', exitCode: 0 }],
      ...(gitOverrides.execResults ?? new Map()),
    ])
  }

  return {
    gitExecutor: mockGitExecutor(gitOverrides),
    shellRunner: mockShellRunner(),
    gitInfoReader: mockGitInfoReader(),
    configService: mockConfigService(options?.worktreeRootDir),
    fs: mockFs(existingPaths, options?.files),
  } satisfies WorktreeServiceDeps
}

// ── detect() 测试 ──────────────────────────────────────────

describe('WorktreeService.detect()', () => {
  it('bare-workspace：cwd 在 .bare workspace 下', async () => {
    const deps = createDeps({ existingPaths: new Set(['/project/.bare']) })
    const service = new WorktreeService(deps)

    const result = await service.detect('/project')
    expect(result.mode).toBe('bare-workspace')
    expect(result.wsRoot).toBe('/project')
    expect(result.barePath).toBe('/project/.bare')
  })

  it('plain-repo：cwd 在普通 git 仓库下', async () => {
    const deps = createDeps({ mode: 'plain-repo' })
    const service = new WorktreeService(deps)

    const result = await service.detect('/home/user/my-repo/src')
    expect(result.mode).toBe('plain-repo')
    expect(result.repoRoot).toBe('/home/user/my-repo')
  })

  it('not-repo：cwd 既不是 bare workspace 也不是 git 仓库', async () => {
    const deps = createDeps({
      mode: 'not-repo',
      gitOverrides: {
        execResults: new Map([
          ['rev-parse --show-toplevel', { stdout: '', stderr: 'not a git repo', exitCode: 128 }],
        ]),
      },
    })
    const service = new WorktreeService(deps)

    const result = await service.detect('/tmp/random')
    expect(result.mode).toBe('not-repo')
  })
})

// ── create() bare-workspace 模式测试 ───────────────────────

describe('WorktreeService.create() bare-workspace', () => {
  it('成功创建 worktree（bare-workspace 模式）', async () => {
    const deps = createDeps({
      mode: 'bare-workspace',
      existingPaths: new Set(['/project/.bare']),
    })
    const service = new WorktreeService(deps)

    const result = await service.create({ branch: 'feat/new-feature', workspaceHint: '/project' })
    // repoRoot（缓存治理 1-6）：bare-workspace 模式 = workspace 根，供 transport 层失效键使用；
    // usedBaseRef（RT-8#8）：请求的 baseBranch 校验通过，原样返回
    expect(result).toEqual({ cwd: '/project/feat-new-feature', branch: 'feat/new-feature', repoRoot: '/project', usedBaseRef: 'origin/main' })
    expect(deps.gitExecutor.exec).toHaveBeenCalledWith(
      '/project/.bare',
      'worktree',
      ['add', '-b', 'feat/new-feature', '/project/feat-new-feature', 'origin/main'],
      // RT-8 后续：add 是整树 checkout，显式传 60s（不用 git-executor 8s 轻查询默认值）
      { timeoutMs: 60_000 },
    )
  })

  it('worktree 目录已存在时抛 WORKTREE_EXISTS', async () => {
    const deps = createDeps({
      mode: 'bare-workspace',
      existingPaths: new Set(['/project/.bare', '/project/feat-existing']),
    })
    const service = new WorktreeService(deps)

    await expect(
      service.create({ branch: 'feat-existing', workspaceHint: '/project' }),
    ).rejects.toMatchObject({
      code: 'WORKTREE_EXISTS',
    })
  })

  it('非法分支名抛 INVALID_BRANCH', async () => {
    const deps = createDeps()
    const service = new WorktreeService(deps)

    await expect(
      service.create({ branch: '../evil', workspaceHint: '/project' }),
    ).rejects.toMatchObject({ code: 'INVALID_BRANCH' })
  })
})

// ── create() plain-repo 模式测试 ───────────────────────────

describe('WorktreeService.create() plain-repo', () => {
  it('成功创建 worktree（plain-repo 模式，worktreeRootDir 布局）', async () => {
    const deps = createDeps({
      mode: 'plain-repo',
      existingPaths: new Set(), // worktree 目录不存在
      worktreeRootDir: '/home/user/worktrees',
    })
    const service = new WorktreeService(deps)

    const result = await service.create({ branch: 'feat/new-feature', workspaceHint: '/home/user/my-repo/src' })
    expect(result.cwd).toBe('/home/user/worktrees/my-repo/feat-new-feature')
    expect(result.branch).toBe('feat/new-feature')
    // repoRoot（缓存治理 1-6）：plain-repo 模式 = 仓库根（hint 为子目录时与 hint 原值不同）
    expect(result.repoRoot).toBe('/home/user/my-repo')
    expect(deps.configService.getWorktreeRootDir).toHaveBeenCalled()
  })

  it('同名 repo 冲突时追加短 hash 后缀', async () => {
    // 工作原理：computePlainRepoWorktreeDir 检查目标是否存在
    // 如果 /home/user/worktrees/my-repo/feat-x 已存在，追加 repo 路径 hash
    const existingPath = '/home/user/worktrees/my-repo/feat-x'
    const deps = createDeps({
      mode: 'plain-repo',
      existingPaths: new Set([existingPath]),
      worktreeRootDir: '/home/user/worktrees',
    })
    const service = new WorktreeService(deps)

    const result = await service.create({ branch: 'feat/x', workspaceHint: '/home/user/my-repo/src' })
    // 目标已存在 → 追加 hash 后缀（hash 是 my-repo 路径的 md5 前 6 位）
    expect(result.cwd).toMatch(/^\/home\/user\/worktrees\/my-repo-[a-f0-9]{6}\/feat-x$/)
  })

  it('not-repo 模式抛 NOT_GIT_REPO', async () => {
    const deps = createDeps({
      mode: 'not-repo',
      gitOverrides: {
        execResults: new Map([
          ['rev-parse --show-toplevel', { stdout: '', stderr: 'not a git repo', exitCode: 128 }],
        ]),
      },
    })
    const service = new WorktreeService(deps)

    await expect(
      service.create({ branch: 'feat/test', workspaceHint: '/tmp/random' }),
    ).rejects.toMatchObject({ code: 'NOT_GIT_REPO' })
  })
})

// ── listBranches() 测试 ────────────────────────────────────

describe('WorktreeService.listBranches()', () => {
  it('列出本地和远程分支（bare-workspace 模式）', async () => {
    const deps = createDeps({
      mode: 'bare-workspace',
      existingPaths: new Set(['/project/.bare']),
      gitOverrides: {
        execResults: new Map([
          ['branch --list --format=%(refname:short)', { stdout: 'main\nfeat-x\n', stderr: '', exitCode: 0 }],
          ['branch --list --remotes --format=%(refname:short)', {
            stdout: 'origin/main\norigin/HEAD\norigin/feat-y\n',
            stderr: '',
            exitCode: 0,
          }],
        ]),
      },
    })
    const service = new WorktreeService(deps)

    const result = await service.listBranches('/project')
    expect(result.local).toEqual(['main', 'feat-x'])
    expect(result.remote).toEqual(['origin/main', 'origin/feat-y'])
    expect(result.defaultBranch).toBeDefined()
  })

  it('plain-repo 模式下用 repoRoot 而非 barePath', async () => {
    const deps = createDeps({ mode: 'plain-repo' })
    const service = new WorktreeService(deps)

    await service.listBranches('/home/user/my-repo/src')
    // 应该用 repoRoot（/home/user/my-repo）而非 barePath
    expect(deps.gitExecutor.exec).toHaveBeenCalledWith(
      '/home/user/my-repo',
      'branch',
      expect.arrayContaining(['--list']),
    )
  })

  it('not-repo 模式抛 NOT_GIT_REPO', async () => {
    const deps = createDeps({
      mode: 'not-repo',
      gitOverrides: {
        execResults: new Map([
          ['rev-parse --show-toplevel', { stdout: '', stderr: 'not a git repo', exitCode: 128 }],
        ]),
      },
    })
    const service = new WorktreeService(deps)

    await expect(service.listBranches('/tmp')).rejects.toMatchObject({ code: 'NOT_GIT_REPO' })
  })

  it('git 命令失败时返回空列表', async () => {
    const deps = createDeps({
      mode: 'bare-workspace',
      existingPaths: new Set(['/project/.bare']),
      gitOverrides: {
        execResults: new Map([
          ['branch --list --format=%(refname:short)', { stdout: '', stderr: 'error', exitCode: 1 }],
          ['branch --list --remotes --format=%(refname:short)', { stdout: '', stderr: 'error', exitCode: 1 }],
        ]),
      },
    })
    const service = new WorktreeService(deps)

    const result = await service.listBranches('/project')
    expect(result.local).toEqual([])
    expect(result.remote).toEqual([])
  })
})

// ── list() 测试 ────────────────────────────────────────────

describe('WorktreeService.list()', () => {
  it('解析 worktree list --porcelain 输出', async () => {
    const porcelain = [
      'worktree /project',
      'HEAD abc123',
      'branch refs/heads/main',
      '',
      'worktree /project/feat-x',
      'HEAD def456',
      'branch refs/heads/feat-x',
      '',
    ].join('\n')

    const deps = createDeps({
      mode: 'bare-workspace',
      existingPaths: new Set(['/project/.bare']),
      gitOverrides: {
        execResults: new Map([
          ['worktree list --porcelain', { stdout: porcelain, stderr: '', exitCode: 0 }],
        ]),
      },
    })
    const service = new WorktreeService(deps)

    const result = await service.list('/project')
    expect(result.items).toHaveLength(2)
    expect(result.items[0]).toMatchObject({
      path: '/project',
      branch: 'main',
      HEAD: true,
      bare: false,
    })
    expect(result.items[1]).toMatchObject({
      path: '/project/feat-x',
      branch: 'feat-x',
      HEAD: false,
      bare: false,
    })
  })

  it('bare repo 条目标记 bare=true', async () => {
    const porcelain = [
      'worktree /project/.bare',
      'bare',
      '',
      'worktree /project/feat-x',
      'HEAD def456',
      'branch refs/heads/feat-x',
      '',
    ].join('\n')

    const deps = createDeps({
      mode: 'bare-workspace',
      existingPaths: new Set(['/project/.bare']),
      gitOverrides: {
        execResults: new Map([
          ['worktree list --porcelain', { stdout: porcelain, stderr: '', exitCode: 0 }],
        ]),
      },
    })
    const service = new WorktreeService(deps)

    const result = await service.list('/project')
    expect(result.items[0]).toMatchObject({ bare: true, branch: '' })
    expect(result.items[1]).toMatchObject({ bare: false, branch: 'feat-x', HEAD: true })
  })

  it('HEAD 标记匹配 currentCwd 所在 worktree（子目录场景），不依赖输出顺序', async () => {
    // [HISTORICAL] 旧实现标记「第一个非 bare」，但 git worktree list 输出顺序是主 worktree
    // 在前，用户在 feat-x 时 HEAD 被错标到 main。必须按 path 匹配 currentCwd（含子目录）。
    const porcelain = [
      'worktree /project/main',
      'HEAD abc123',
      'branch refs/heads/main',
      '',
      'worktree /project/feat-x',
      'HEAD def456',
      'branch refs/heads/feat-x',
      '',
    ].join('\n')

    const deps = createDeps({
      mode: 'bare-workspace',
      existingPaths: new Set(['/project/.bare']),
      gitOverrides: {
        execResults: new Map([
          ['worktree list --porcelain', { stdout: porcelain, stderr: '', exitCode: 0 }],
        ]),
      },
    })
    const service = new WorktreeService(deps)

    // currentCwd 是 feat-x worktree 的子目录（packages/renderer）
    const result = await service.list('/project/feat-x/packages/renderer')
    expect(result.items[0]).toMatchObject({ path: '/project/main', HEAD: false })
    expect(result.items[1]).toMatchObject({ path: '/project/feat-x', branch: 'feat-x', HEAD: true })
  })

  it('not-repo 模式抛 NOT_GIT_REPO', async () => {
    const deps = createDeps({
      mode: 'not-repo',
      gitOverrides: {
        execResults: new Map([
          ['rev-parse --show-toplevel', { stdout: '', stderr: 'not a git repo', exitCode: 128 }],
        ]),
      },
    })
    const service = new WorktreeService(deps)

    await expect(service.list('/tmp')).rejects.toMatchObject({ code: 'NOT_GIT_REPO' })
  })

  it('git 命令失败时抛 GIT_FAILED', async () => {
    const deps = createDeps({
      mode: 'bare-workspace',
      existingPaths: new Set(['/project/.bare']),
      gitOverrides: {
        execResults: new Map([
          ['worktree list --porcelain', { stdout: '', stderr: 'fatal: not a git repo', exitCode: 128 }],
        ]),
      },
    })
    const service = new WorktreeService(deps)

    await expect(service.list('/project')).rejects.toMatchObject({ code: 'GIT_FAILED' })
  })
})

// ── setup 脚本测试 ─────────────────────────────────────────

describe('WorktreeService setup 脚本', () => {
  it('setup 脚本存在时执行', async () => {
    const setupScriptPath = '/project/.bare/custom-hooks/setup-worktree.sh'
    const deps = createDeps({
      mode: 'bare-workspace',
      existingPaths: new Set(['/project/.bare', setupScriptPath]),
    })
    const service = new WorktreeService(deps)

    await service.create({ branch: 'feat/test', workspaceHint: '/project' })
    expect(deps.shellRunner.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        scriptPath: setupScriptPath,
        args: ['/project/feat-test'],
        cwd: '/project/feat-test',
        // timeout 必传后（D4）：断言用户配置值（getTimeout()=60s → 60_000ms）显式透传
        timeout: 60_000,
      }),
    )
  })

  it('setup 脚本不存在时跳过', async () => {
    const deps = createDeps({
      mode: 'bare-workspace',
      existingPaths: new Set(['/project/.bare']), // setup 脚本不在 existingPaths 中
    })
    const service = new WorktreeService(deps)

    await service.create({ branch: 'feat/test', workspaceHint: '/project' })
    expect(deps.shellRunner.execute).not.toHaveBeenCalled()
  })

  it('setup 脚本失败时抛 SETUP_FAILED', async () => {
    const setupScriptPath = '/project/.bare/custom-hooks/setup-worktree.sh'
    const deps = createDeps({
      mode: 'bare-workspace',
      existingPaths: new Set(['/project/.bare', setupScriptPath]),
      // RT-8#6 起 setup 失败会触发回滚（worktree remove + branch -D）——补成功回滚结果，
      // 保持本用例聚焦「SETUP_FAILED 抛出」原意，回滚细节由 RT-8#6 专属 describe 覆盖
      gitOverrides: {
        execResults: new Map([
          ['worktree remove', { stdout: '', stderr: '', exitCode: 0 }],
          ['branch -D', { stdout: '', stderr: '', exitCode: 0 }],
        ]),
      },
    })
    deps.shellRunner.execute = vi.fn(async () => ({ exitCode: 1, stdout: '', stderr: 'install failed' }))
    const service = new WorktreeService(deps)

    await expect(
      service.create({ branch: 'feat/test', workspaceHint: '/project' }),
    ).rejects.toMatchObject({ code: 'SETUP_FAILED' })
  })
})

// ── setup 失败回滚（RT-8#6 / 审计 F6-M16：半成品残留 + 重试被 WORKTREE_EXISTS 挡死）──

describe('WorktreeService setup 失败回滚（RT-8#6）', () => {
  it('setup 失败后按创建逆序回滚：worktree remove --force + branch -D，原始 SETUP_FAILED 保留', async () => {
    const setupScriptPath = '/project/.bare/custom-hooks/setup-worktree.sh'
    const deps = createDeps({
      mode: 'bare-workspace',
      existingPaths: new Set(['/project/.bare', setupScriptPath]),
      gitOverrides: {
        execResults: new Map([
          ['worktree remove', { stdout: '', stderr: '', exitCode: 0 }],
          ['branch -D', { stdout: '', stderr: '', exitCode: 0 }],
        ]),
      },
    })
    deps.shellRunner.execute = vi.fn(async () => ({ exitCode: 1, stdout: '', stderr: 'install failed' }))
    const service = new WorktreeService(deps)

    await expect(
      service.create({ branch: 'feat/test', workspaceHint: '/project' }),
    ).rejects.toMatchObject({ code: 'SETUP_FAILED' }) // 原始错误不被掩盖
    // 逆序 ①：移除 worktree 目录 + 主仓元数据（双重 --force 容忍子模块）
    expect(deps.gitExecutor.exec).toHaveBeenCalledWith(
      '/project/.bare',
      'worktree',
      ['remove', '--force', '--force', '/project/feat-test'],
      // RT-8 后续：remove 是整树删除，同 add 显式传 60s
      { timeoutMs: 60_000 },
    )
    // 逆序 ②：删除本次 add -b 新建的分支（不删则重试报「分支已存在」）
    expect(deps.gitExecutor.exec).toHaveBeenCalledWith(
      '/project/.bare',
      'branch',
      ['-D', 'feat/test'],
      { timeoutMs: 60_000 },
    )
  })

  it('plain-repo 模式同一回滚（rollback 以 repoRoot 为 git 执行目录）', async () => {
    const setupScriptPath = '/home/user/my-repo/custom-hooks/setup-worktree.sh'
    const deps = createDeps({
      mode: 'plain-repo',
      existingPaths: new Set([setupScriptPath]),
      gitOverrides: {
        execResults: new Map([
          ['worktree remove', { stdout: '', stderr: '', exitCode: 0 }],
          ['branch -D', { stdout: '', stderr: '', exitCode: 0 }],
        ]),
      },
    })
    deps.shellRunner.execute = vi.fn(async () => ({ exitCode: 1, stdout: '', stderr: 'boom' }))
    const service = new WorktreeService(deps)

    await expect(
      service.create({ branch: 'feat/test', locationMode: 'repo-dir', workspaceHint: '/home/user/my-repo/src' }),
    ).rejects.toMatchObject({ code: 'SETUP_FAILED' })
    expect(deps.gitExecutor.exec).toHaveBeenCalledWith(
      '/home/user/my-repo',
      'worktree',
      ['remove', '--force', '--force', '/home/user/my-repo/feat-test'],
      { timeoutMs: 60_000 },
    )
    expect(deps.gitExecutor.exec).toHaveBeenCalledWith(
      '/home/user/my-repo',
      'branch',
      ['-D', 'feat/test'],
      { timeoutMs: 60_000 },
    )
  })

  it('回滚自身失败不掩盖原始错误：仍抛 SETUP_FAILED + warn 附手动清理指引', async () => {
    const setupScriptPath = '/project/.bare/custom-hooks/setup-worktree.sh'
    const deps = createDeps({
      mode: 'bare-workspace',
      existingPaths: new Set(['/project/.bare', setupScriptPath]),
      gitOverrides: {
        execResults: new Map([
          // worktree remove 失败（如元数据不完整时 git 拒删）→ 回滚不完整
          ['worktree remove', { stdout: '', stderr: 'fatal: not a working tree', exitCode: 1 }],
          ['branch -D', { stdout: '', stderr: '', exitCode: 0 }],
        ]),
      },
    })
    deps.shellRunner.execute = vi.fn(async () => ({ exitCode: 1, stdout: '', stderr: 'install failed' }))
    const service = new WorktreeService(deps)

    await expect(
      service.create({ branch: 'feat/test', workspaceHint: '/project' }),
    ).rejects.toMatchObject({ code: 'SETUP_FAILED', message: expect.stringContaining('setup 脚本失败') })

    // 留痕已升级为结构化 logger.warn（RT-8 后续：原 console.warn 无 meta、不可断言、
    // 「仅 console.warn 会丢」正是当年把它请进 error detail 的动因）
    expect(logger.warn).toHaveBeenCalledWith(
      '[worktree-service] setup 失败后回滚不完整，半成品残留',
      expect.objectContaining({
        branch: 'feat/test',
        worktreePath: '/project/feat-test',
        cleanupHint: expect.stringContaining('git -C /project/.bare worktree remove --force /project/feat-test'),
        failures: expect.arrayContaining([expect.stringContaining('worktree remove 失败')]),
      }),
    )
  })

  it('回滚不完整 → 原始 SETUP_FAILED 的 detail 带 cleanupHint + rollbackIncomplete（裁决 #10：清理指引随错误进 envelope，不停在 console）', async () => {
    const setupScriptPath = '/project/.bare/custom-hooks/setup-worktree.sh'
    const deps = createDeps({
      mode: 'bare-workspace',
      existingPaths: new Set(['/project/.bare', setupScriptPath]),
      gitOverrides: {
        execResults: new Map([
          ['worktree remove', { stdout: '', stderr: 'fatal: not a working tree', exitCode: 1 }],
          ['branch -D', { stdout: '', stderr: '', exitCode: 0 }],
        ]),
      },
    })
    deps.shellRunner.execute = vi.fn(async () => ({ exitCode: 1, stdout: '', stderr: 'install failed' }))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const service = new WorktreeService(deps)

    // 现场保留（不自动清理到干净态时）：清理指引必须随错误 detail 到达 transport 层
    // （worktree-message-handler 把 detail 透到 error envelope 的 details 字段 → 前端可见）
    const err = await service.create({ branch: 'feat/test', workspaceHint: '/project' }).then(
      () => { throw new Error('expected reject') },
      (e: unknown) => e as { code?: string; detail?: Record<string, unknown> },
    )
    expect(err.code).toBe('SETUP_FAILED')
    expect(err.detail?.rollbackIncomplete).toBe(true)
    expect(String(err.detail?.cleanupHint)).toContain('git -C /project/.bare worktree remove --force /project/feat-test')
    // 原始失败因（exitCode/stderr）不被回滚信息覆盖
    expect(err.detail?.exitCode).toBe(1)
    expect(String(err.detail?.stderr)).toContain('install failed')
    vi.restoreAllMocks()
  })

  it('回滚后重试不被 WORKTREE_EXISTS 挡死', async () => {
    const bare = '/project/.bare'
    const setupScriptPath = `${bare}/custom-hooks/setup-worktree.sh`
    const wtPath = '/project/feat-test'
    const gitEntry = `${wtPath}/.git`
    // 状态化 mock：worktree add 把目录 + .git 入口写上「磁盘」，remove 撤销——
    // 重试路径上 existsSync 结果随回滚真实变化，验证不再被早退检查挡死
    const disk = new Set([bare, setupScriptPath])
    const fs = {
      existsSync: vi.fn((p: string) => disk.has(p)),
      statSync: vi.fn((p: string) => {
        if (!disk.has(p)) {
          const e = new Error(`ENOENT: ${p}`) as NodeJS.ErrnoException
          e.code = 'ENOENT'
          throw e
        }
        return { isDirectory: () => true, isFile: () => false }
      }),
      // config.worktree 补齐路径（ensureWorktreeUsable）：本用例不关注其内容，no-op 记录即可
      readFileSync: vi.fn((_p: string, _encoding: 'utf8') => {
        const e = new Error(`ENOENT: ${_p}`) as NodeJS.ErrnoException
        e.code = 'ENOENT'
        throw e
      }),
      writeFileSync: vi.fn(),
    }
    const gitExec = vi.fn(async (_cwd: string, command: string, args?: string[]) => {
      const key = `${command} ${(args ?? []).join(' ')}`.trim()
      if (key.startsWith('worktree add')) {
        disk.add(wtPath)
        disk.add(gitEntry)
        return { stdout: '', stderr: '', exitCode: 0 }
      }
      if (key.startsWith('worktree remove')) {
        disk.delete(wtPath)
        disk.delete(gitEntry)
        return { stdout: '', stderr: '', exitCode: 0 }
      }
      if (key.startsWith('branch -D')) return { stdout: '', stderr: '', exitCode: 0 }
      if (key.startsWith('rev-parse --verify')) return { stdout: 'abc', stderr: '', exitCode: 0 }
      if (key.startsWith('rev-parse --abbrev-ref')) return { stdout: 'origin/main', stderr: '', exitCode: 0 }
      return { stdout: '', stderr: `unknown: ${key}`, exitCode: 1 }
    })
    let setupAttempts = 0
    const deps: WorktreeServiceDeps = {
      gitExecutor: { exec: gitExec },
      shellRunner: {
        execute: vi.fn(async () => {
          setupAttempts += 1
          return setupAttempts === 1
            ? { exitCode: 1, stdout: '', stderr: 'install failed' }
            : { exitCode: 0, stdout: '', stderr: '' }
        }),
      },
      gitInfoReader: mockGitInfoReader(),
      configService: mockConfigService(),
      fs,
    }
    const service = new WorktreeService(deps)

    // 第一次：setup 失败 → 回滚（remove + branch -D 撤销磁盘副作用）
    await expect(
      service.create({ branch: 'feat/test', workspaceHint: '/project' }),
    ).rejects.toMatchObject({ code: 'SETUP_FAILED' })
    expect(fs.existsSync(wtPath)).toBe(false) // 副作用已回滚

    // 重试：不再 WORKTREE_EXISTS，setup 第二次成功 → 创建成功
    const result = await service.create({ branch: 'feat/test', workspaceHint: '/project' })
    expect(result).toEqual({ cwd: wtPath, branch: 'feat/test', repoRoot: '/project', usedBaseRef: 'origin/main' })
  })
})

// ── WORKTREE_EXISTS 半成品识别（RT-8#6）──

describe('WorktreeService WORKTREE_EXISTS 半成品识别（RT-8#6）', () => {
  it('目录存在但缺 .git 入口（半成品残留）→ 附手动清理指引', async () => {
    const deps = createDeps({
      mode: 'bare-workspace',
      existingPaths: new Set(['/project/.bare', '/project/feat-x']), // 无 feat-x/.git
    })
    const service = new WorktreeService(deps)

    await expect(
      service.create({ branch: 'feat-x', workspaceHint: '/project' }),
    ).rejects.toMatchObject({
      code: 'WORKTREE_EXISTS',
      message: expect.stringContaining('疑似上次创建失败的残留'),
      detail: { halfFinished: true },
    })
  })

  it('完整 worktree（.git 入口存在）→ 原有冲突语义不变', async () => {
    const deps = createDeps({
      mode: 'bare-workspace',
      existingPaths: new Set(['/project/.bare', '/project/feat-x', '/project/feat-x/.git']),
    })
    const service = new WorktreeService(deps)

    await expect(
      service.create({ branch: 'feat-x', workspaceHint: '/project' }),
    ).rejects.toMatchObject({
      code: 'WORKTREE_EXISTS',
      message: expect.not.stringContaining('残留'),
      detail: { halfFinished: false },
    })
  })
})

// ── git worktree add 失败（此前零覆盖：mock 恒定 exitCode 0）──

describe('WorktreeService git worktree add 失败 → GIT_FAILED', () => {
  it('bare-workspace 模式：add 非 0 → GIT_FAILED，detail 带 exitCode/stderr，不回滚（无已产生副作用）', async () => {
    const deps = createDeps({
      mode: 'bare-workspace',
      existingPaths: new Set(['/project/.bare']),
      gitOverrides: {
        execResults: new Map([
          ['worktree add', { stdout: '', stderr: "fatal: a branch named 'feat-x' already exists", exitCode: 1 }],
        ]),
      },
    })
    const service = new WorktreeService(deps)

    await expect(
      service.create({ branch: 'feat-x', workspaceHint: '/project' }),
    ).rejects.toMatchObject({
      code: 'GIT_FAILED',
      message: expect.stringContaining('git worktree add 失败'),
      detail: { exitCode: 1, stderr: expect.stringContaining('already exists') },
    })
    // add 失败发生在副作用产生前：不应出现回滚命令
    const removeCalls = deps.gitExecutor.exec.mock.calls.filter(
      (c) => c[1] === 'worktree' && (c[2] as string[])?.includes('remove'),
    )
    expect(removeCalls).toHaveLength(0)
  })

  it('plain-repo 模式：add 非 0 → GIT_FAILED', async () => {
    const deps = createDeps({
      mode: 'plain-repo',
      gitOverrides: {
        execResults: new Map([
          ['worktree add', { stdout: '', stderr: 'fatal: invalid reference', exitCode: 128 }],
        ]),
      },
    })
    const service = new WorktreeService(deps)

    await expect(
      service.create({ branch: 'feat-x', workspaceHint: '/home/user/my-repo' }),
    ).rejects.toMatchObject({
      code: 'GIT_FAILED',
      detail: { exitCode: 128 },
    })
  })
})

// ── setup 执行层失败包装（RT-8 后续：timeout 不再被误映射成 GIT_FAILED）──

describe('WorktreeService setup 执行层失败包装', () => {
  /** 让回滚命令在 mock 里返回成功（默认 map 无 worktree remove/branch -D 条目 → 未知命令 exit 1） */
  const rollbackOk = new Map([
    ['worktree remove', { stdout: '', stderr: '', exitCode: 0 }],
    ['branch -D', { stdout: '', stderr: '', exitCode: 0 }],
  ])

  it('setup 超时 → SETUP_FAILED（detail.timeout=true + timeoutMs），并照常回滚', async () => {
    const deps = createDeps({
      mode: 'bare-workspace',
      existingPaths: new Set(['/project/.bare', '/project/.bare/custom-hooks/setup-worktree.sh']),
      gitOverrides: { execResults: rollbackOk },
    })
    deps.shellRunner.execute = vi.fn(async () => {
      throw new ShellRunnerError('timeout', '脚本执行超时（60000ms）')
    })
    const service = new WorktreeService(deps)

    await expect(
      service.create({ branch: 'feat-x', workspaceHint: '/project' }),
    ).rejects.toMatchObject({
      code: 'SETUP_FAILED',
      message: expect.stringContaining('超时'),
      detail: { timeout: true, timeoutMs: 60_000 },
    })
    // 超时同样走回滚（worktree remove + branch -D），世界复原
    expect(deps.gitExecutor.exec.mock.calls.some(
      (c) => c[1] === 'worktree' && (c[2] as string[])?.includes('remove'),
    )).toBe(true)
  })

  it('setup 脚本 ENOENT → SETUP_FAILED（detail.scriptMissing=true）', async () => {
    const deps = createDeps({
      mode: 'bare-workspace',
      existingPaths: new Set(['/project/.bare', '/project/.bare/custom-hooks/setup-worktree.sh']),
      gitOverrides: { execResults: rollbackOk },
    })
    deps.shellRunner.execute = vi.fn(async () => {
      throw new ShellRunnerError('not_found', '脚本不存在或不可执行: /x/setup.sh')
    })
    const service = new WorktreeService(deps)

    await expect(
      service.create({ branch: 'feat-x', workspaceHint: '/project' }),
    ).rejects.toMatchObject({
      code: 'SETUP_FAILED',
      message: expect.stringContaining('setup 脚本执行失败'),
      detail: { scriptMissing: true },
    })
  })
})

// ── per-worktree config 补齐（RT-8 后续：git worktree add 不生成 config.worktree）──

describe('WorktreeService per-worktree config 补齐（bare 模式）', () => {
  it('创建成功后写 config.worktree：core.bare=false；.githooks 存在时带 hooksPath', async () => {
    const files = new Map<string, string>()
    const deps = createDeps({
      mode: 'bare-workspace',
      existingPaths: new Set(['/project/.bare', '/project/feat-x/.githooks']),
      files,
    })
    const service = new WorktreeService(deps)

    await service.create({ branch: 'feat-x', workspaceHint: '/project' })

    expect(files.get('/project/.bare/worktrees/feat-x/config.worktree')).toBe(
      '[core]\n\tbare = false\n\thooksPath = /project/feat-x/.githooks\n',
    )
  })

  it('.githooks 不存在 → 只写 core.bare=false（不写 hooksPath）', async () => {
    const files = new Map<string, string>()
    const deps = createDeps({
      mode: 'bare-workspace',
      existingPaths: new Set(['/project/.bare']),
      files,
    })
    const service = new WorktreeService(deps)

    await service.create({ branch: 'feat-x', workspaceHint: '/project' })

    expect(files.get('/project/.bare/worktrees/feat-x/config.worktree')).toBe('[core]\n\tbare = false\n')
  })

  it('extensions.worktreeConfig 未开启 → 往 .bare/config 追加开启', async () => {
    const files = new Map<string, string>([
      ['/project/.bare/config', '[core]\n\tbare = true\n'],
    ])
    const deps = createDeps({
      mode: 'bare-workspace',
      existingPaths: new Set(['/project/.bare', '/project/.bare/config']),
      files,
    })
    const service = new WorktreeService(deps)

    await service.create({ branch: 'feat-x', workspaceHint: '/project' })

    const config = files.get('/project/.bare/config') ?? ''
    expect(config).toContain('[extensions]')
    expect(config).toContain('worktreeConfig = true')
  })

  it('extensions.worktreeConfig 已开启 → 不追加（尊重用户配置）', async () => {
    const original = '[core]\n\tbare = true\n\n[extensions]\n\tworktreeConfig = true\n'
    const files = new Map<string, string>([['/project/.bare/config', original]])
    const deps = createDeps({
      mode: 'bare-workspace',
      existingPaths: new Set(['/project/.bare', '/project/.bare/config']),
      files,
    })
    const service = new WorktreeService(deps)

    await service.create({ branch: 'feat-x', workspaceHint: '/project' })

    expect(files.get('/project/.bare/config')).toBe(original)
  })
})

// ── 成败结构化日志（RT-8 后续：成败两侧落盘，失败带 code/exitCode/stderr 尾部/回滚结局）──

describe('WorktreeService 成败结构化日志', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('创建成功 → logger.info 一条（结果字段 + durationMs），无 error', async () => {
    const deps = createDeps({
      mode: 'bare-workspace',
      existingPaths: new Set(['/project/.bare']),
    })
    const service = new WorktreeService(deps)

    await service.create({ branch: 'feat-x', baseBranch: 'origin/main', workspaceHint: '/project' })

    expect(logger.info).toHaveBeenCalledTimes(1)
    const [message, meta] = vi.mocked(logger.info).mock.calls[0] ?? []
    expect(message).toBe('[worktree-service] worktree created')
    expect(meta).toMatchObject({
      branch: 'feat-x',
      baseBranch: 'origin/main',
      mode: 'bare-workspace',
      repoRoot: '/project',
      cwd: '/project/feat-x',
      usedBaseRef: 'origin/main',
    })
    expect(typeof meta?.['durationMs']).toBe('number')
    expect(logger.error).not.toHaveBeenCalled()
  })

  it('git add 失败 → logger.error 一条（code/exitCode/stderr；rollback=null——未到回滚路径）', async () => {
    const deps = createDeps({
      mode: 'bare-workspace',
      existingPaths: new Set(['/project/.bare']),
      gitOverrides: {
        execResults: new Map([
          ['worktree add', { stdout: '', stderr: 'fatal: branch exists', exitCode: 1 }],
        ]),
      },
    })
    const service = new WorktreeService(deps)

    await expect(
      service.create({ branch: 'feat-x', workspaceHint: '/project' }),
    ).rejects.toMatchObject({ code: 'GIT_FAILED' })

    expect(logger.error).toHaveBeenCalledTimes(1)
    const [message, meta] = vi.mocked(logger.error).mock.calls[0] ?? []
    expect(message).toBe('[worktree-service] worktree create failed')
    expect(meta).toMatchObject({
      branch: 'feat-x',
      code: 'GIT_FAILED',
      error: expect.stringContaining('git worktree add 失败'),
      exitCode: 1,
      stderr: 'fatal: branch exists',
      timeout: false,
      rollback: null,
      cleanupHint: null,
    })
    expect(typeof meta?.['durationMs']).toBe('number')
    expect(logger.info).not.toHaveBeenCalled()
  })

  it('setup 失败且回滚干净 → logger.error 一条（rollback=clean）', async () => {
    const deps = createDeps({
      mode: 'bare-workspace',
      existingPaths: new Set(['/project/.bare', '/project/.bare/custom-hooks/setup-worktree.sh']),
      gitOverrides: {
        execResults: new Map([
          ['worktree remove', { stdout: '', stderr: '', exitCode: 0 }],
          ['branch -D', { stdout: '', stderr: '', exitCode: 0 }],
        ]),
      },
    })
    deps.shellRunner.execute = vi.fn(async () => ({
      exitCode: 1,
      stdout: '',
      stderr: 'ERR_PNPM_OUTDATED_LOCKFILE',
    }))
    const service = new WorktreeService(deps)

    await expect(
      service.create({ branch: 'feat-x', workspaceHint: '/project' }),
    ).rejects.toMatchObject({ code: 'SETUP_FAILED' })

    const [, meta] = vi.mocked(logger.error).mock.calls[0] ?? []
    expect(meta).toMatchObject({
      code: 'SETUP_FAILED',
      exitCode: 1,
      stderr: 'ERR_PNPM_OUTDATED_LOCKFILE',
      rollback: 'clean',
    })
  })
})

// ── git 命令超时校准（RT-8 后续：add/remove 是整树操作，8s 轻查询默认值不够）──

describe('WorktreeService git 命令超时校准', () => {
  it('worktree add 与回滚 remove/branch -D 显式传 60s timeoutMs', async () => {
    const deps = createDeps({
      mode: 'bare-workspace',
      existingPaths: new Set(['/project/.bare']),
    })
    const service = new WorktreeService(deps)

    await service.create({ branch: 'feat-x', workspaceHint: '/project' })

    const calls = deps.gitExecutor.exec.mock.calls
    const addCall = calls.find((c) => c[1] === 'worktree' && (c[2] as string[])?.includes('add'))
    expect(addCall?.[3]).toEqual({ timeoutMs: 60_000 })
  })
})

// ── base 解析 fallback（RT-8#8 留痕升级为结构化 warn）──

describe('WorktreeService base 解析 fallback', () => {
  it('请求 ref 不存在 → fallback 本地 main + usedBaseRef 显形 + 结构化 warn', async () => {
    const deps = createDeps({
      mode: 'bare-workspace',
      existingPaths: new Set(['/project/.bare']),
      gitOverrides: {
        execResults: new Map([
          ['rev-parse --verify origin/gone', { stdout: '', stderr: 'unknown revision', exitCode: 128 }],
        ]),
      },
    })
    const service = new WorktreeService(deps)

    const result = await service.create({ branch: 'feat-x', baseBranch: 'origin/gone', workspaceHint: '/project' })

    expect(result.usedBaseRef).toBe('main')
    expect(logger.warn).toHaveBeenCalledWith(
      '[worktree-service] base 解析 fallback：请求 ref 校验失败，改用本地 main',
      expect.objectContaining({
        branch: 'feat-x',
        requestedBaseBranch: 'origin/gone',
        fallback: 'main',
      }),
    )
  })
})
