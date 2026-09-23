/**
 * WorktreeService —— worktree 创建/列举的领域编排实现（W2 三态升级）。
 *
 * 🔒 三层架构：本类实现 services/ports/worktree-service.ts 的 IWorktreeService port。
 * 编排：(1) WorkspaceDetector 检测三态 (2) IGitExecutor 跑 git worktree/branch 命令
 * (3) IShellRunner 跑可选的 setup 脚本（项目黑盒，不存在则跳过）。
 *
 * 依赖全经构造函数注入（gitExecutor / shellRunner / gitInfoReader / configService / fs），
 * production 由 index.ts 传真实实现，测试传 mock。此模式让 WorktreeService 单测完全隔离 IO。
 *
 * 错误对象用 `Object.assign(new Error(msg), { code, detail })` 扁平模式（非 class）——
 * 测试用 toMatchObject 断言 code/detail，详见 port 注释。
 *
 * 编排顺序与测试严格对齐：
 * 1. detect → 三态判定（bare-workspace / plain-repo / not-repo）
 * 2. create: bare-workspace 模式走现有逻辑；plain-repo 模式计算专用目录布局；not-repo 抛 NOT_GIT_REPO
 * 3. listBranches: git branch --list + remote show origin + 读默认分支
 * 4. list: git worktree list --porcelain 解析输出
 *
 * 与 GitStateService 缓存失效的关系（perf 03 §5 worktree 检查点闭环，2026-08-17）：本服务自身
 * 不触发失效（编排层不感知缓存），失效由 transport/worktree-message-handler.ts 在
 * worktree.create 成功后、reply 前对 create 返回值携带的 repo 根（detect 解析结果，
 * 缓存治理 1-6）调 gitService.invalidateStatusCache({ cwd })
 * （内部即 GitStateService.invalidateByCwd，覆盖共享该 repo 上下文的全部 session）挂钩，
 * 失败路径不失效。此前「声明接受陈旧」的取舍（perf W17 审查 Fix-6）已被该闭环取代。
 */
import { join, basename } from 'node:path'
import { createHash } from 'node:crypto'
import {
  WorkspaceDetector,
  type FsLike,
  type GitRevParser,
  type WorkspaceDetectResult,
} from './workspace-detector.js'
import type { WorktreeErrorCode } from '@taiji/shared'
import { INVALID_BRANCH_REGEX } from '@taiji/shared'
import type { IShellRunner, ShellRunnerResult } from '../ports/shell-runner.js'
import { ShellRunnerError } from '../ports/shell-runner.js'
import type { IGitExecutor } from '../ports/git-executor.js'
import type { IGitInfoReader } from '../ports/git-info.js'
import { logger } from '../../infra/logger.js'
import type {
  IWorktreeService,
  WorktreeCreateParams,
  WorktreeCreateResult,
  WorktreeBranchListResult,
  WorktreeListResult,
  WorkspaceDetectResult as WorkspaceDetectResultPort,
} from '../ports/worktree-service.js'

/**
 * WorktreeService 实际消费的 config 读取子集（ISP 收窄，源码简化 T7）。
 * 方法签名与 IConfigService 对应方法逐字一致——生产装配（index.ts）传完整 ConfigService
 * 经结构化类型自动满足；测试 mock 只需 stub 这 5 个方法，不再复制 60+ 方法胖接口。
 */
export interface WorktreeConfigService {
  /** 默认基分支（create 未显式指定 baseBranch 时的 fallback），默认 'origin/main'。 */
  getDefaultBaseBranch(): string
  /** bare-workspace 初始化脚本相对路径（不存在则跳过）。 */
  getBareSetupScript(): string
  /** worktree 根目录（plain-repo dedicated-dir 布局的根），默认 '~/worktrees'。 */
  getWorktreeRootDir(): string
  /** plain-repo setup 脚本相对路径（不存在则跳过）。 */
  getSetupScript(): string
  /** worktree 创建超时（秒，setup 脚本执行上限；Service 侧 ×1000 转 ms）。 */
  getTimeout(): number
}

/** WorktreeService 依赖（全注入，可 mock）。 */
export interface WorktreeServiceDeps {
  gitExecutor: IGitExecutor
  shellRunner: IShellRunner
  gitInfoReader: IGitInfoReader
  configService: WorktreeConfigService
  /** node:fs 子集（测试用 vi.doMock 后传入） */
  fs: {
    existsSync: (path: string) => boolean
    /** statSync 用于区分文件/目录（existsSync 无法区分）。ENOENT 时应抛 Error 并设 code='ENOENT'。 */
    statSync: (path: string) => { isDirectory: () => boolean; isFile: () => boolean }
    /**
     * 读 bare 仓库主 config（探测 extensions.worktreeConfig 是否开启——config.worktree
     * 只有该扩展启用才被 git 读取，未开启时写了也是空气）。ENOENT 等读取失败由实现抛，调用方容错。
     */
    readFileSync: (path: string, encoding: 'utf8') => string
    /**
     * 写 per-worktree config.worktree（core.bare=false）：git worktree add 不生成该文件，
     * bare 仓库 .bare/config 的 core.bare=true 会被 worktree 继承，导致 worktree 内 git
     * 全废（git status 报「该操作必须在一个工作区中运行」，实测 git 2.52 复现）——
     * git-cwt 同款补齐，taiji 自建的 worktree 必须自己写。
     */
    writeFileSync: (path: string, data: string) => void
  }
}

/** 主分支 fallback（origin/main ref 不存在时用本地 main）。 */
const LOCAL_MAIN = 'main'

/** 半成品判定：worktree 目录内 .git 入口（file，指向主仓 worktrees 元数据）。 */
const WORKTREE_GIT_ENTRY = '.git'

/** '~/…' 前缀的展开：slice 起始位置跳过 '~' 后与 $HOME 拼接。 */
const HOME_PREFIX_SLICE_START = 2
/** 目录名去重后缀的短 hash 长度（md5 前 N 位 hex，足以区分同 repo 冲突）。 */
const DIR_HASH_SUFFIX_LENGTH = 6
/** 秒 → 毫秒换算系数（setup 脚本 timeout 从秒读到毫秒）。 */
const MS_PER_SECOND = 1000
/**
 * git worktree add/remove 的执行超时（ms）。git-executor 默认 8000ms 是给 status/diff 这类
 * 轻查询校准的量级；worktree add/remove 是**整树 checkout/删除**（大仓库或带 node_modules
 * 的 remove 可达数十秒），8s 会被误杀成 GIT_FAILED——按被保护对象的粒度重新校准。
 */
const WORKTREE_GIT_TIMEOUT_MS = 60_000
/**
 * 失败日志里 stderr 的落盘长度帽（保留**尾部**——错误原因在输出末尾，如 pnpm 的
 * Failure reason 块）。对齐 crash-journal detailDigest 的 2KB 帽；完整 stderr 已随
 * error envelope 进前端 error 态，日志只需可 grep 的根因尾部。
 */
const STDERR_LOG_TAIL_LENGTH = 2048

/**
 * 非法分支名规则（SSOT: @taiji/shared INVALID_BRANCH_REGEX，前端 + runtime 共用）。
 * runtime 是安全边界，前端校验只是 UX——此处必须独立校验防 Windows 路径遍历
 * （branch=`..\\..\\evil` → dirName 保留反斜杠 → join 解析到 wsRoot 外）。
 *
 * 匹配任一即非法（对齐 git refname 规则 git check-ref-format）：
 * - `^\.` / `^-`：以点 / 横杠开头（git refname 禁止以 . 开头；此处一并挡 - 开头以便目录名规整）
 * - `..`：连续两点
 * - `[~^:?*\[\]@{}]`：git refname 禁止字符（~ ^ : ? * [ ] @{ } 等；@{ 单独也挡）
 * - `\s`：空格
 * - `\\`：反斜杠（Windows 路径遍历防护，git refname 同样禁止）
 * - `\/$`：以 / 结尾（git refname 禁止）
 * - `\.lock$`：.lock 后缀（git refname 保留）
 */

/**
 * 构造 WorktreeService 扁平错误（code 类型编译时校验为 WorktreeErrorCode）。
 * 错误对象形状：`Error & { code: WorktreeErrorCode; detail?: unknown }`。
 */
function worktreeError(code: WorktreeErrorCode, message: string, detail?: unknown): Error {
  return Object.assign(new Error(message), detail !== undefined ? { code, detail } : { code })
}

/** 展开 ~ 前缀到 $HOME（路径字符串预处理，path.join 不展开 ~）。不处理 ~user/ 格式（仅支持当前用户的 ~）。 */
function expandHome(p: string): string {
  if (p === '~') return process.env['HOME'] ?? p
  if (p.startsWith('~/')) return join(process.env['HOME'] ?? '', p.slice(HOME_PREFIX_SLICE_START))
  return p
}

/** 为 plain-repo 模式计算 worktree 目录路径。 */
function computePlainRepoWorktreeDir(
  worktreeRootDir: string,
  repoRoot: string,
  branchDir: string,
  fsExists: (path: string) => boolean,
): string {
  // worktreeRootDir 默认值 '~/worktrees' 是用户友好配置，path.join 不展开 ~，必须预处理
  const expandedRoot = expandHome(worktreeRootDir)
  const repoName = basename(repoRoot)
  const baseDir = join(expandedRoot, repoName, branchDir)

  if (!fsExists(baseDir)) {
    return baseDir
  }

  // 目标已存在：检查是否属于同一 repo（.git 文件内容可比对，但简单起见检查父级 repo 目录结构）
  // 策略：追加 repo 路径短 hash 后缀避免冲突
  const hash = createHash('md5').update(repoRoot).digest('hex').slice(0, DIR_HASH_SUFFIX_LENGTH)
  return join(expandedRoot, `${repoName}-${hash}`, branchDir)
}

export class WorktreeService implements IWorktreeService {
  constructor(private deps: WorktreeServiceDeps) {}

  /**
   * 检测 cwd 所在仓库的三态模式（bare-workspace / plain-repo / not-repo）。
   * 供 WorktreeMessageHandler 的 workspace.detect 调用。
   */
  async detect(cwd: string): Promise<WorkspaceDetectResultPort> {
    const detector = this.createDetector()
    const result = await detector.detect(cwd)
    return {
      mode: result.mode,
      wsRoot: result.wsRoot,
      barePath: result.barePath,
      repoRoot: result.repoRoot,
      defaultBranch: result.defaultBranch,
    }
  }

  /**
   * 创建 worktree（全链路唯一入口）。
   *
   * 可观测性（RT-8 后续补强）：成败两侧结构化落盘——成功 info 一条（结果字段 + durationMs），
   * 失败 error 一条（code/error/exitCode/stderr 尾部/回滚结局 + durationMs）。此前成败零日志，
   * 故障（如 setup 脚本 lockfile 漂移）在所有日志文件里零痕迹，只能靠 UI 弹窗截图口口相传。
   * 落点 = runtime 主日志（~/.taiji/logs/runtime-<date>.log），未 initLogger 时自动 no-op。
   */
  async create(params: WorktreeCreateParams): Promise<WorktreeCreateResult> {
    const startedAt = Date.now()
    const { branch, baseBranch: rawBaseBranch, locationMode, workspaceHint } = params
    const baseBranch = rawBaseBranch ?? this.deps.configService.getDefaultBaseBranch()
    // 成败两条日志的共享上下文字段（请求侧事实，与结果无关）
    const logCtx = {
      branch,
      baseBranch,
      locationMode: locationMode ?? null,
      workspaceHint: workspaceHint ?? null,
    }

    try {
      // 0. 分支名校验（安全边界，防 Windows 路径遍历）。前端校验只是 UX，runtime 必须独立校验。
      if (INVALID_BRANCH_REGEX.test(branch)) {
        throw worktreeError('INVALID_BRANCH', `非法分支名: ${branch}`)
      }

      // 1. 检测三态
      const detector = this.createDetector()
      const detection = await detector.detect(workspaceHint ?? process.cwd())

      if (detection.mode === 'not-repo') {
        throw worktreeError('NOT_GIT_REPO', '当前目录既不是 .bare workspace 也不是 git 仓库，无法创建 worktree')
      }

      // 2. 按模式分支处理
      const result = detection.mode === 'bare-workspace'
        ? await this.createBareWorktree(detection, branch, baseBranch, locationMode, workspaceHint)
        : await this.createPlainRepoWorktree(detection, branch, baseBranch, locationMode, workspaceHint)

      logger.info('[worktree-service] worktree created', {
        ...logCtx,
        mode: detection.mode,
        repoRoot: result.repoRoot,
        cwd: result.cwd,
        // RT-8#8：请求 base 校验失败 fallback 时可见实际基线（与 worktree.created envelope 同源）
        usedBaseRef: result.usedBaseRef ?? null,
        durationMs: Date.now() - startedAt,
      })
      return result
    } catch (e) {
      this.logCreateFailure(logCtx, e, startedAt)
      throw e
    }
  }

  /**
   * 创建失败的错误日志载荷组装（原 create catch 内联体迁移）：原始 code 保真 +
   * detail 字段提取（exitCode / stderr 尾部 / timeout / 回滚结局 / cleanupHint）。
   * 只组装日志，不改写也不吞掉原始错误（调用方 rethrow 原值）。
   */
  private logCreateFailure(
    logCtx: { branch: string; baseBranch: string; locationMode: string | null; workspaceHint: string | null },
    e: unknown,
    startedAt: number,
  ): void {
    const err = e as { code?: string; detail?: Record<string, unknown> }
    const detail = err?.detail && typeof err.detail === 'object' ? err.detail : {}
    logger.error('[worktree-service] worktree create failed', {
      ...logCtx,
      // 原始 code 保真（GitExecutorError 的 timeout/git_unavailable 等逃逸码也落盘，
      // 不进 union 但在日志里可判别真实失败层）
      code: err?.code ?? 'worktree_failed',
      error: e instanceof Error ? e.message : String(e),
      exitCode: typeof detail['exitCode'] === 'number' ? detail['exitCode'] : null,
      // stderr 只落尾部（根因在末尾）；完整版随 error envelope 进前端 error 态
      stderr: typeof detail['stderr'] === 'string'
        ? (detail['stderr'] as string).slice(-STDERR_LOG_TAIL_LENGTH)
        : null,
      // setup 执行层失败（超时/脚本缺失）经 runSetupScript 包装成 SETUP_FAILED 后由此显形
      timeout: detail['timeout'] === true,
      // 仅 setup 失败路径发生过回滚：clean = 世界已复原；incomplete = 半成品残留（detail 带 cleanupHint）
      rollback: this.describeRollbackOutcome(err, detail),
      cleanupHint: typeof detail['cleanupHint'] === 'string' ? detail['cleanupHint'] : null,
      durationMs: Date.now() - startedAt,
    })
  }

  /** 回滚结局分类：非 SETUP_FAILED 未走到回滚（null）；rollbackIncomplete=true → incomplete（半成品残留），否则 clean。 */
  private describeRollbackOutcome(
    err: { code?: string } | undefined,
    detail: Record<string, unknown>,
  ): 'clean' | 'incomplete' | null {
    return err?.code === 'SETUP_FAILED'
      ? detail['rollbackIncomplete'] === true ? 'incomplete' : 'clean'
      : null
  }

  /**
   * 列出 cwd 所在仓库的本地/远程分支。
   * 供 WorktreeMessageHandler 的 worktree.listBranches 调用。
   */
  async listBranches(cwd: string): Promise<WorktreeBranchListResult> {
    const detector = this.createDetector()
    const detection = await detector.detect(cwd)

    if (detection.mode === 'not-repo') {
      throw worktreeError('NOT_GIT_REPO', '当前目录既不是 .bare workspace 也不是 git 仓库，无法列出分支')
    }

    const repoDir = detection.mode === 'bare-workspace' ? detection.barePath : detection.repoRoot
    const defaultBranch = detection.defaultBranch || LOCAL_MAIN

    // 获取本地分支
    const localResult = await this.deps.gitExecutor.exec(repoDir, 'branch', [
      '--list',
      '--format=%(refname:short)',
    ])
    const local = localResult.exitCode === 0
      ? localResult.stdout.split('\n').map(b => b.trim()).filter(Boolean)
      : []
    if (localResult.exitCode !== 0) {
      // RT-8#8（核实后确认的窄可达面）：exec 抛 GitExecutorError（git 缺失/超时）走异常路径
      // 传播，此分支只剩「git 命令本身失败」（健康仓库几乎不可达）——降级返 [] 保持，但留痕
      //（空列表被当「无分支」不可观测）。恢复动作：直接跑 git branch 复核。
      console.warn(
        `[worktree-service] git branch --list 失败（本地分支按空列表返回）: exit=${localResult.exitCode} ${localResult.stderr.trim()}`,
      )
    }

    // 获取远程分支
    const remoteResult = await this.deps.gitExecutor.exec(repoDir, 'branch', [
      '--list',
      '--remotes',
      '--format=%(refname:short)',
    ])
    const remote = remoteResult.exitCode === 0
      ? remoteResult.stdout.split('\n').map(b => b.trim()).filter(b => Boolean(b) && !b.endsWith('/HEAD'))
      : []
    if (remoteResult.exitCode !== 0) {
      console.warn(
        `[worktree-service] git branch --remotes 失败（远程分支按空列表返回）: exit=${remoteResult.exitCode} ${remoteResult.stderr.trim()}`,
      )
    }

    return { local, remote, defaultBranch }
  }

  /**
   * 列出 cwd 所在 workspace 的所有 worktree。
   * 供 WorktreeMessageHandler 的 worktree.list 调用。
   */
  async list(cwd: string): Promise<WorktreeListResult> {
    const detector = this.createDetector()
    const detection = await detector.detect(cwd)

    if (detection.mode === 'not-repo') {
      throw worktreeError('NOT_GIT_REPO', '当前目录既不是 .bare workspace 也不是 git 仓库，无法列出 worktree')
    }

    const repoDir = detection.mode === 'bare-workspace' ? detection.barePath : detection.repoRoot

    const result = await this.deps.gitExecutor.exec(repoDir, 'worktree', ['list', '--porcelain'])
    if (result.exitCode !== 0) {
      throw worktreeError(
        'GIT_FAILED',
        `git worktree list 失败: ${result.stderr}`,
        { exitCode: result.exitCode, stderr: result.stderr },
      )
    }

    return { items: this.parseWorktreePorcelain(result.stdout, cwd) }
  }

  // ── 私有方法 ─────────────────────────────────────────────────

  /** 创建 WorkspaceDetector 实例（注入 fs + git 适配器）。 */
  private createDetector(): WorkspaceDetector {
    const fsAdapter: FsLike = {
      statSync: (p: string) => this.deps.fs.statSync(p),
    }
    const gitAdapter: GitRevParser = {
      getRepoRoot: async (cwd: string) => {
        const r = await this.deps.gitExecutor.exec(cwd, 'rev-parse', ['--show-toplevel'])
        return r.exitCode === 0 ? r.stdout.trim() : null
      },
      getDefaultBranch: async (cwd: string) => {
        // 先尝试 symbolic-ref（最准确），失败后 fallback 读 git config
        const r = await this.deps.gitExecutor.exec(cwd, 'rev-parse', [
          '--abbrev-ref', 'origin/HEAD',
        ])
        if (r.exitCode === 0) {
          // 输出格式：origin/main → 去掉 origin/ 前缀
          const ref = r.stdout.trim()
          return ref.replace(/^origin\//, '')
        }
        // fallback: 尝试 main 或 master
        for (const candidate of ['main', 'master']) {
          const check = await this.deps.gitExecutor.exec(cwd, 'rev-parse', [
            '--verify', `refs/heads/${candidate}`,
          ])
          if (check.exitCode === 0) return candidate
        }
        return null
      },
    }
    return new WorkspaceDetector(fsAdapter, gitAdapter)
  }

  /** 目录名冲突检查：报 WORKTREE_EXISTS；半成品残留（缺 .git 入口）附手动清理指引（RT-8#6）。 */
  private assertWorktreePathFree(newWtPath: string, dirName: string, branch: string): void {
    if (!this.deps.fs.existsSync(newWtPath)) return
    // git worktree add 完成后 worktree 目录内必有 .git 入口（file，指向主仓元数据）；
    // 目录存在但入口缺失 = 非完整 worktree，疑似上次创建失败的半成品残留。此前一律报
    // WORKTREE_EXISTS 会让重试被永久挡死（setup 失败已由 rollbackCreatedWorktree 兜底，
    // 此分支覆盖其它残留来源——git add 中途被杀等），至少给出可行动的清理指引。
    const halfFinished = !this.deps.fs.existsSync(join(newWtPath, WORKTREE_GIT_ENTRY))
    throw worktreeError(
      'WORKTREE_EXISTS',
      halfFinished
        ? `目录已存在但不是完整 worktree（缺少 .git 入口，疑似上次创建失败的残留）: ${newWtPath}。` +
          `请手动清理后重试：git worktree remove --force ${newWtPath} && git branch -D ${branch}`
        : `worktree 目录已存在: ${newWtPath}`,
      { cwd: newWtPath, dirName, branch, halfFinished },
    )
  }

  /**
   * setup 失败回滚（RT-8#6 / 审计 F6-M16：成功副作用无配对回滚 → 半成品永久残留，
   * 重试被 WORKTREE_EXISTS 挡死）。按创建逆序撤销 worktree add 已产生的副作用：
   * ① git worktree remove --force（worktree 目录 + 主仓 worktrees 元数据；双重 --force
   *    容忍子模块——该 worktree 是本次 create 全新产物，无用户数据可失）
   * ② git branch -D（worktree add -b 创建的新分支；能走到 setup 说明分支必为本流量新建，
   *    不删则重试 add -b 报「分支已存在」换一种方式挡死）
   * 回滚逐步 try/catch：单步失败不掩盖/替换原始 setup 错误（调用方 rollback 后原样
   * rethrow 原始错误）。
   *
   * @returns 回滚不完整的残留描述（含手动清理命令）；null = 回滚干净（世界已恢复到
   *   create 调用前状态，无半成品）。调用方将残留写进原始错误的 detail.cleanupHint——
   *   「保留现场 + 错误带清理指引」（审计裁决）：rollback 失败的现场留给用户排查/清理，
   *   指引必须随错误进 error envelope（仅 console.warn 会丢）。
   */
  private async rollbackCreatedWorktree(repoDir: string, wtPath: string, branch: string): Promise<string | null> {
    const failures: string[] = []
    try {
      // timeoutMs 显式传：remove 是整树删除（含 node_modules 时可达数十秒），8s 默认值不够
      const rm = await this.deps.gitExecutor.exec(repoDir, 'worktree', ['remove', '--force', '--force', wtPath], { timeoutMs: WORKTREE_GIT_TIMEOUT_MS })
      if (rm.exitCode !== 0) failures.push(`worktree remove 失败: ${rm.stderr.trim()}`)
    } catch (e: unknown) {
      failures.push(`worktree remove 异常: ${e instanceof Error ? e.message : String(e)}`)
    }
    try {
      const br = await this.deps.gitExecutor.exec(repoDir, 'branch', ['-D', branch], { timeoutMs: WORKTREE_GIT_TIMEOUT_MS })
      if (br.exitCode !== 0) failures.push(`branch -D 失败: ${br.stderr.trim()}`)
    } catch (e: unknown) {
      failures.push(`branch -D 异常: ${e instanceof Error ? e.message : String(e)}`)
    }
    if (failures.length === 0) return null
    const cleanupHint =
      `git -C ${repoDir} worktree remove --force ${wtPath} && git -C ${repoDir} branch -D ${branch}`
    // 结构化留痕（原 console.warn 无 meta、不可断言）：半成品残留 + 具体清理命令 + 未完成步骤
    logger.warn('[worktree-service] setup 失败后回滚不完整，半成品残留', {
      branch,
      repoDir,
      worktreePath: wtPath,
      cleanupHint,
      failures,
    })
    return `${cleanupHint}（未完成步骤: ${failures.join('; ')}）`
  }

  /**
   * setup 失败善后（RT-8#6 裁决补）：回滚 + 把回滚残留写进原始错误的 detail——
   * - rollback 干净：世界已复原，原始错误原样 rethrow；
   * - rollback 不完整：错误 detail 追加 `rollbackIncomplete: true` + `cleanupHint`（具体
   *   手动清理命令），envelope 进前端 error 态可见。detail 为扁平对象追加（保留原
   *   SETUP_FAILED 的 exitCode/stderr），code/message 不动（不掩盖原始失败因）。
   */
  private async rollbackAndRethrow(
    repoDir: string,
    wtPath: string,
    branch: string,
    setupError: unknown,
  ): Promise<never> {
    const residue = await this.rollbackCreatedWorktree(repoDir, wtPath, branch)
    if (residue !== null) {
      const err = setupError as { detail?: Record<string, unknown> }
      if (err && typeof err === 'object') {
        err.detail = { ...(typeof err.detail === 'object' && err.detail !== null ? err.detail : {}), rollbackIncomplete: true, cleanupHint: residue }
      }
    }
    throw setupError
  }

  /** bare-workspace 模式下创建 worktree。 */
  private async createBareWorktree(
    detection: WorkspaceDetectResult,
    branch: string,
    baseBranch: string,
    _locationMode?: 'workspace' | 'repo-dir' | 'dedicated-dir',
    workspaceHint?: string,
  ): Promise<WorktreeCreateResult> {
    const { barePath, wsRoot } = detection

    // 目录名转换 + 冲突检查
    const dirName = branch.replace(/\//g, '-')
    const newWtPath = join(wsRoot, dirName)
    this.assertWorktreePathFree(newWtPath, dirName, branch)

    // base 解析（usedBaseRef 供返回——请求 ref 校验失败静默 fallback 的显形，RT-8#8）
    const usedBaseRef = await this.resolveBaseRef(barePath, branch, baseBranch, workspaceHint)

    // git worktree add。timeoutMs 显式传：add 是整树 checkout，超过 git-executor 8s
    // 轻查询默认值会被误杀成 GIT_FAILED（量级按被保护对象校准）
    const addResult = await this.deps.gitExecutor.exec(
      barePath,
      'worktree',
      ['add', '-b', branch, newWtPath, usedBaseRef],
      { timeoutMs: WORKTREE_GIT_TIMEOUT_MS },
    )
    if (addResult.exitCode !== 0) {
      throw worktreeError(
        'GIT_FAILED',
        `git worktree add 失败: ${addResult.stderr}`,
        { exitCode: addResult.exitCode, stderr: addResult.stderr },
      )
    }

    // per-worktree config 补齐（先于 setup：setup 脚本内的 git 操作同样受益）
    this.ensureWorktreeUsable(barePath, newWtPath, dirName, branch)

    // setup 脚本（可选，不存在跳过）—— 从 configService.getBareSetupScript() 读取脚本相对路径
    // 失败回滚（RT-8#6）：worktree add 已产生副作用（目录/元数据/新分支），setup 失败必须
    // 逆序撤销，否则半成品残留且重试被 WORKTREE_EXISTS 挡死；回滚残留写进错误 detail
    const bareSetupScriptRel = this.deps.configService.getBareSetupScript()
    try {
      await this.runSetupScript(barePath, newWtPath, bareSetupScriptRel)
    } catch (setupError) {
      await this.rollbackAndRethrow(barePath, newWtPath, branch, setupError)
    }

    return { cwd: newWtPath, branch, repoRoot: detection.repoRoot, usedBaseRef }
  }

  /** plain-repo 模式下创建 worktree。 */
  private async createPlainRepoWorktree(
    detection: WorkspaceDetectResult,
    branch: string,
    baseBranch: string,
    locationMode?: 'workspace' | 'repo-dir' | 'dedicated-dir',
    workspaceHint?: string,
  ): Promise<WorktreeCreateResult> {
    const { repoRoot } = detection

    // 目录名转换
    const dirName = branch.replace(/\//g, '-')

    let newWtPath: string

    // 根据 locationMode 决定创建位置
    if (locationMode === 'repo-dir') {
      // repo-dir 模式：在仓库目录下创建（传统 git worktree 行为）
      newWtPath = join(repoRoot, dirName)
      this.assertWorktreePathFree(newWtPath, dirName, branch)
    } else {
      // dedicated-dir 模式（默认）：在专用目录 ~/worktrees/<repoName>/<branchDir> 下创建
      const worktreeRootDir = this.deps.configService.getWorktreeRootDir()
      newWtPath = computePlainRepoWorktreeDir(
        worktreeRootDir,
        repoRoot,
        dirName,
        (p: string) => this.deps.fs.existsSync(p),
      )
    }

    // base 解析（usedBaseRef 供返回——请求 ref 校验失败静默 fallback 的显形，RT-8#8）
    const usedBaseRef = await this.resolveBaseRef(repoRoot, branch, baseBranch, workspaceHint)

    // git worktree add。timeoutMs 显式传：同 bare 模式（整树 checkout，8s 默认值不够）
    const addResult = await this.deps.gitExecutor.exec(
      repoRoot,
      'worktree',
      ['add', '-b', branch, newWtPath, usedBaseRef],
      { timeoutMs: WORKTREE_GIT_TIMEOUT_MS },
    )
    if (addResult.exitCode !== 0) {
      throw worktreeError(
        'GIT_FAILED',
        `git worktree add 失败: ${addResult.stderr}`,
        { exitCode: addResult.exitCode, stderr: addResult.stderr },
      )
    }

    // setup 脚本（可选，不存在跳过）—— plain-repo 模式从 configService.getSetupScript() 读取脚本相对路径
    // 相对 repoRoot 解析（plain-repo 没有 barePath，仓库结构与传统 git 一致）
    // 失败回滚（RT-8#6）：与 bare-workspace 模式同一 rollbackAndRethrow 兜底
    const setupScriptRel = this.deps.configService.getSetupScript()
    try {
      await this.runSetupScript(repoRoot, newWtPath, setupScriptRel)
    } catch (setupError) {
      await this.rollbackAndRethrow(repoRoot, newWtPath, branch, setupError)
    }

    return { cwd: newWtPath, branch, repoRoot: detection.repoRoot, usedBaseRef }
  }

  /** 运行 setup 脚本（通用逻辑）。setupScriptRel 来自 configService（相对 cwd 解析）；不存在则跳过。 */
  private async runSetupScript(cwd: string, worktreePath: string, setupScriptRel: string): Promise<void> {
    // setup 脚本路径：cwd + configService.get*SetupScript() 相对路径
    // 默认 'custom-hooks/setup-worktree.sh'（与原 bare-workspace 工作流一致）
    const setupScriptPath = join(cwd, setupScriptRel)
    if (this.deps.fs.existsSync(setupScriptPath)) {
      // 超时从 configService.getTimeout() 读（默认 300s——monorepo pnpm install +
      // 首次 Electron/pi 二进制下载是分钟级，60s 默认值会误杀冷安装；上限 3600s）
      const timeoutMs = this.deps.configService.getTimeout() * MS_PER_SECOND
      let result: ShellRunnerResult
      try {
        result = await this.deps.shellRunner.execute({
          scriptPath: setupScriptPath,
          args: [worktreePath],
          cwd: worktreePath,
          timeout: timeoutMs,
        })
      } catch (e) {
        // ShellRunnerError（timeout / not_found）是「执行层失败」而非脚本业务失败。原样逃逸有两个
        // 问题：① handler 的 GIT_ERROR_CODE_MAP 会把 code='timeout' 误映射成 GIT_FAILED——用户
        // 看到「git 失败」实际是 setup 卡住，排查方向被指错；② 前端拿不到 SETUP 语义、无法分流。
        // 统一包装成 SETUP_FAILED，detail 用 timeout/scriptMissing 区分形态；rollback 路径不变
        // （调用方 catch 到的仍是同一种 SETUP_FAILED 错误形状）。
        const isTimeout = e instanceof ShellRunnerError && e.code === 'timeout'
        const isMissing = e instanceof ShellRunnerError && e.code === 'not_found'
        const rawMessage = e instanceof Error ? e.message : String(e)
        if (isTimeout) {
          throw worktreeError('SETUP_FAILED', `setup 脚本执行超时（${timeoutMs}ms）`, { timeout: true, timeoutMs })
        }
        throw worktreeError(
          'SETUP_FAILED',
          `setup 脚本执行失败: ${rawMessage}`,
          isMissing ? { scriptMissing: true } : { executionError: rawMessage },
        )
      }
      if (result.exitCode !== 0) {
        throw worktreeError(
          'SETUP_FAILED',
          `setup 脚本失败（exitCode=${result.exitCode}）`,
          { exitCode: result.exitCode, stderr: result.stderr },
        )
      }
    }
  }

  /**
   * 解析 base ref。
   * - 'current'：用 gitInfoReader 读当前分支，读不到 fallback main
   * - 'origin/main'：用 gitExecutor rev-parse 验证远端 ref 存在，不存在 fallback 本地 main
   * - 其他字符串：作为具体分支名，用 gitExecutor rev-parse 验证存在性
   *
   * RT-8#8：fallback 不再静默——baseBranch 校验失败改用 LOCAL_MAIN 是「创建基线被偷换」，
   * 新 worktree 会落在用户没选的基线上。warn 留痕 + 调用方把返回的 usedBaseRef 带回
   * worktree.created envelope（前端可见实际用了哪个 ref）。
   */
  private async resolveBaseRef(
    repoDir: string,
    branch: string,
    baseBranch: string,
    workspaceHint?: string,
  ): Promise<string> {
    if (baseBranch === 'current') {
      const info = this.deps.gitInfoReader.readGitInfo(workspaceHint ?? process.cwd())
      if (info?.branch) return info.branch
      logger.warn('[worktree-service] base 解析 fallback：current 读不到，改用本地 main', {
        branch,
        repoDir,
        requestedBaseBranch: baseBranch,
        fallback: LOCAL_MAIN,
        reason: 'gitInfoReader 返回空',
        impact: '新 worktree 基于本地 main 而非当前分支',
      })
      return LOCAL_MAIN
    }
    // 验证 ref 存在
    const result = await this.deps.gitExecutor.exec(repoDir, 'rev-parse', ['--verify', baseBranch])
    if (result.exitCode === 0) return baseBranch
    logger.warn('[worktree-service] base 解析 fallback：请求 ref 校验失败，改用本地 main', {
      branch,
      repoDir,
      requestedBaseBranch: baseBranch,
      fallback: LOCAL_MAIN,
      revParseExit: result.exitCode,
      revParseStderr: result.stderr.trim(),
      impact: '新 worktree 基于本地 main 而非请求的 base（创建基线被偷换）',
    })
    return LOCAL_MAIN
  }

  /**
   * 补齐 per-worktree git config，让新 worktree 内的 git 可用（bare-workspace 模式专属）。
   *
   * 根因（实测 git 2.52 复现）：`git worktree add` 不生成 `config.worktree`，bare 仓库
   * `.bare/config` 的 `core.bare=true` 被 worktree 继承——worktree 内 `git status` 直接报
   * 「致命错误：该操作必须在一个工作区中运行」，`--is-bare-repository` 返回 true，后续
   * agent/UI/用户终端在该 worktree 里做任何 git 操作全部失败。git-cwt 靠写 config.worktree
   * （core.bare=false + hooksPath）绕过；taiji 自建的 worktree 必须同款补齐，否则每个 app
   * 创建的 worktree 都带这个先天缺陷。
   *
   * 两步（产物形态与 git-cwt 对齐，探针实测有效）：
   * ① `<barePath>/worktrees/<dirName>/config.worktree` 写 `[core] bare=false`；`.githooks`
   *    存在时补 `hooksPath`（bare 仓默认 hooks 目录不可用，不写则 commit 不过项目钩子）；
   * ② `extensions.worktreeConfig` 未在 `.bare/config` 出现时追加开启——config.worktree
   *    只有该扩展启用才被 git 读取（未开启时①写了也是空气）。键已存在（含 false）不覆盖。
   *
   * best-effort：任一步失败只 warn 不抛——worktree 已创建成功，让 create 失败会触发回滚、
   * 把一个「基本可用仅 git 元数据缺失」的 worktree 删掉，代价大于收益；失败现场进日志。
   */
  private ensureWorktreeUsable(barePath: string, wtPath: string, dirName: string, branch: string): void {
    // ① per-worktree config.worktree（git per-worktree 元数据目录 = <bare>/worktrees/<目标目录名>）
    try {
      const hooksPath = join(wtPath, '.githooks')
      const lines = ['[core]', '\tbare = false']
      if (this.deps.fs.existsSync(hooksPath)) {
        lines.push(`\thooksPath = ${hooksPath}`)
      }
      this.deps.fs.writeFileSync(join(barePath, 'worktrees', dirName, 'config.worktree'), `${lines.join('\n')}\n`)
    } catch (e) {
      logger.warn('[worktree-service] config.worktree 写入失败，worktree 内 git 可能不可用', {
        branch,
        barePath,
        worktreePath: wtPath,
        error: e instanceof Error ? e.message : String(e),
      })
    }
    // ② extensions.worktreeConfig 开启（config.worktree 的生效前提；git-cwt 同样会开启）
    const configPath = join(barePath, 'config')
    if (!this.deps.fs.existsSync(configPath)) return
    try {
      const current = this.deps.fs.readFileSync(configPath, 'utf8')
      // 键已存在（true/false 均算用户已有配置）→ 不覆盖，尊重用户设置
      if (!/^\s*worktreeConfig\s*=/m.test(current)) {
        this.deps.fs.writeFileSync(configPath, `${current.replace(/\s*$/, '')}\n\n[extensions]\n\tworktreeConfig = true\n`)
      }
    } catch (e) {
      logger.warn('[worktree-service] extensions.worktreeConfig 开启失败，config.worktree 可能不被 git 读取', {
        branch,
        barePath,
        error: e instanceof Error ? e.message : String(e),
      })
    }
  }

  /**
   * 解析 `git worktree list --porcelain` 输出。
   *
   * 格式（每条 worktree 之间空行分隔）：
   * worktree /path/to/worktree
   * HEAD abcdef1234567890
   * branch refs/heads/main
   *
   * worktree /path/to/bare
   * bare
   */
  private parseWorktreePorcelain(output: string, currentCwd?: string): Array<{ path: string; branch: string; HEAD: boolean; bare: boolean }> {
    const items: Array<{ path: string; branch: string; HEAD: boolean; bare: boolean }> = []
    const blocks = output.split('\n\n').filter(b => b.trim())

    for (const block of blocks) {
      const lines = block.split('\n').map(l => l.trim()).filter(Boolean)
      let path = ''
      let branch = ''
      let bare = false

      for (const line of lines) {
        if (line.startsWith('worktree ')) {
          path = line.slice('worktree '.length)
        } else if (line.startsWith('branch ')) {
          branch = line.slice('branch '.length).replace(/^refs\/heads\//, '')
        } else if (line.startsWith('HEAD ')) {
          // HEAD sha 本处不用（HEAD 标记由下方 currentCwd path 匹配决定）
        } else if (line === 'bare') {
          bare = true
        }
      }

      if (path) {
        items.push({
          path,
          branch,
          HEAD: false,
          bare,
        })
      }
    }

    // HEAD=true 标记当前 cwd 所在的 worktree（path 与 currentCwd 相同）。
    // [HISTORICAL] 旧实现标记「第一个非 bare」——但 git worktree list 输出顺序是主 worktree
    // 在前（通常 main），不是当前 cwd 所在。用户在 feat-x worktree 时 HEAD 被错标到 main，
    // 导致 Landing Git chip 显示错误的分支名（或空）。必须按 path 精确匹配当前 cwd。
    if (currentCwd) {
      // currentCwd 可能是 worktree 根或其子目录（如 .../wt/packages/renderer），
      // worktree.path 是 worktree 根。精确相等或以 path+分隔符开头都算「当前 worktree」。
      // 用 path + '/' 前缀避免 /foo 匹配 /foobar。
      const current = items.find(i =>
        i.path === currentCwd || currentCwd.startsWith(i.path + '/'),
      )
      if (current) current.HEAD = true
    }
    // currentCwd 未提供（向后兼容）：fallback 到第一个非 bare（旧逻辑，不推荐依赖）
    if (!items.some(i => i.HEAD)) {
      const firstNonBare = items.find(i => !i.bare)
      if (firstNonBare) firstNonBare.HEAD = true
    }

    return items
  }
}
