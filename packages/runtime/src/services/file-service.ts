/**
 * FileService —— 文件树编排深模块（code-architecture §3，#2/#7/#16，D-008 三层+port）。
 *
 * 职责（单一变化轴「文件树编排」）：cwd 解析 / 越界统一守门 / 懒加载分层 / ignore 标记 / readFile 截断。
 *
 * 数据流（§4 功能1）：listTree → sessionService.getSummary(sid).cwd → isUnderOrEqual 守门 →
 *   executor.listDir ×N（1+M 次，F-1：顶层 1 次 + 每个顶层 dir 再 1 次拿一级子）→
 *   ignore-parser 标记（命中的节点标 ignored=true，前端按开关过滤）→ FileNode[]（path 相对 cwd，不含前导斜杠）。
 *
 * 分层：FileService 经 IFileExecutor（port）做 IO，经 ignore-parser 纯函数 kernel（本仓 infra/fs/，
 *   compileIgnoreRules/matchPath）做 ignore 计算，经 ISessionService 取 cwd。不直接 import node:fs（AC-2 grep 验证）。
 *
 * 安全（NFR-AC-S2 越界统一守门）：
 * - cwd 取自 sessionService.getSummary(sid).cwd（session.create 时确立的受信工作目录）
 * - expandDir/readFile 的 path：path.resolve(cwd, path) 后必须落在 cwd 之下（isUnderOrEqual），
 *   防 `../../etc/passwd` 路径穿越 → 越界抛 FileError('out_of_cwd')。
 *   （listTree 入口对 cwd 自身守门，恒 true，保持入口统一守门模式。）
 * - readFile / readFileFromWhitelist 守门前两侧 realpath 归一（canonicalizePath，失败退词法）：
 *   session cwd（前端/DB 词法形态）与 pi 子进程拼出的目标（物理形态）可因符号链接
 *   （macOS /tmp → /private/tmp）词法前缀不一致，词法判定误拒同一物理目录内的文件；
 *   归一后判定语义 = 物理路径包含关系。expandDir 保持词法判定不变。
 */
import { resolve as resolvePath, join, relative, isAbsolute } from 'node:path'
import type { FileNode } from '@taiji/shared'
import type { IgnoreMatcher } from '../infra/fs/ignore-parser.js'
import { compileIgnoreRules, matchPath } from '../infra/fs/ignore-parser.js'
import { isUnderOrEqual, expandHome, canonicalizePath } from '../utils/path-utils.js'
import type { IFileExecutor, FsEntry } from './ports/file-executor.js'
import type { ISessionService, IFileService } from '../interfaces.js'
import { FileError } from './file-error.js'

/** FileService 依赖（accept deps，可测性：executor + sessionService 经构造注入）。 */
export interface FileServiceOptions {
  sessionService: ISessionService
  executor: IFileExecutor
  /**
   * file.read 的白名单目录（BC-3，#7）：file.read protocol payload 只有 path 无 sessionId，
   * 无法走 cwd 守门。这些全局白名单目录（~/.agents/skills、piAgentDir/skills、piAgentDir/npm）
   * 允许无 session 读取（skill 文件预览）。装配时（index.ts）从 configService 算出传入。
   */
  allowedReadDirs?: string[]
}

/** 读取超时（ms），listDir/stat/readFile 共用（NFR ④K-2）。导出供测试 advanceTimersByTime 用。 */
export const READ_TIMEOUT_MS = 10_000
/** 文件大小截断阈值（1MB，readFile 用，AC-6.7）。导出供测试断言用。 */
export const MAX_FILE_SIZE = 1_048_576
/**
 * searchFiles 递归深度上限（根 cwd=depth 0，顶层 entry=depth 1，... 第 8 层 entry 返回但不展开子）。
 * 防深层嵌套目录树无下限耗时；导出供测试断言用。
 */
export const MAX_SEARCH_DEPTH = 8
/**
 * searchFiles DoS 防护上限（达上限停止收集，横向截断）。
 *
 * 设计定位：安全兜底，非功能限制——正常项目（通常 <5000 文件）不触发，
 * 全量返回供前端缓存 + 本地过滤（composer # 候选按 query 即时过滤 name+path）。
 * 仅防未 ignore 的超大批量目录（如 vendor / monorepo 产物）无上限耗时。
 *
 * 500→5000 调整背景：原 500 截断导致深度优先遍历中靠后位置的文件丢失
 * （如根目录的 AGENTS.md），前端在已截断子集上过滤永远筛不到。5000 覆盖
 * 正常项目全量，前端能找到任意文件；超大项目（>5000）仍截断作 DoS 兜底。
 */
export const MAX_SEARCH_RESULTS = 5000
/**
 * searchFiles 有界并发度（D7-4，05-scan-caching §3.3 定案 8~16 取 16）：
 * 限制同时在飞的 listDir 数（目录级并发）。导出供测试断言并发上限。
 * 信号量只包裹单次 listDir IO——父任务发起子任务后仅 await 不占 slot，
 * 深链目录树不会因「父持 slot 等子」产生饥饿/死锁。
 */
export const SEARCH_WALK_CONCURRENCY = 16
/**
 * searchFiles 内建 ignore 目录名（安全兜底，独立于 .gitignore，不可被 `!` 取反覆盖）。
 * 常见依赖产物/构建/缓存目录，几乎不应出现在 composer 文件候选里。
 */
export const BUILTIN_IGNORE_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'coverage', '.next', '.cache', '.turbo',
])

/**
 * 超时包装（NFR ④K-2，源码简化 T9 从 FileService 私有方法提取为可直测独立单元）：
 * promise 与定时器赛跑，超时 → reject FileError('timeout')，message 携带 label 定位操作。
 * FileService.callFs 是唯一生产消费点（READ_TIMEOUT_MS 全局统一超时）；导出供测试直测
 * 超时触发 / clearTimeout 无泄漏 / FileError 形状（此前私有不可直测，测试被迫本地复制副本）。
 *
 * 实现用单 Promise 构造器 + 手动 settle（非 Promise.race）：定时器回调直接调外层 reject，
 * 不产生被 reject 的中间 timeout promise —— 避免「落败 promise 异步 reject 触发
 * unhandledRejection」的竞态（Promise.race + setTimeout 超时模式的已知坑）。
 * promise settle 后立即 clearTimeout，无悬挂定时器。
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      reject(new FileError('timeout', `${label} timed out after ${ms}ms`))
    }, ms)
    promise.then(
      (v) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(v)
      },
      (e) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(e)
      },
    )
  })
}

/** 空 matcher 单例（无 .gitignore / 内容为空时共享，matchPath 永远 false）。 */
const EMPTY_MATCHER: IgnoreMatcher = compileIgnoreRules('')

export class FileService implements IFileService {
  constructor(private opts: FileServiceOptions) {}

  /**
   * 文件树首加载（UC-1，#2，AC-2.1/2.2/2.4，T1.1-1.6）。
   * 编排：顶层 listDir(cwd) + 对每个顶层 dir 再 listDir（1+M 次，F-1）→ ignore 标记。
   * 顶层 FileNode.path = name（相对 cwd）；dir 的一级子 children.path = name/sub（相对 cwd）。
   * 返回前按 sortNodes 排序（dir 在前、同类型内 name 降序），与 listLevel 一致。
   *
   * ignore 策略：始终返回所有节点，对 .gitignore 命中的节点标记 `ignored=true`，
   * 由前端按 showIgnored 开关做本地 computed 过滤（瞬时切换不重拉，避免闪烁）。
   * @throws FileError('session_not_found' | 'permission_denied' | 'timeout')
   */
  async listTree(sessionId: string): Promise<FileNode[]> {
    const cwd = this.requireCwd(sessionId)
    // 越界守门（NFR-AC-S2 统一守门，cwd 自身恒在子树内，守门为一致性）
    if (!isUnderOrEqual(cwd, cwd)) throw new FileError('out_of_cwd', cwd)
    const matcher = await this.loadMatcher(cwd)
    const topEntries = await this.callFs(() => this.opts.executor.listDir(cwd), 'listDir')
    const topNodes: FileNode[] = []
    for (const e of topEntries) {
      const node = this.entryToNode(e, '') // 顶层 relParent='' → path=name
      if (matchPath(matcher, node.path)) node.ignored = true // 标记 ignored，前端按开关过滤
      if (e.type === 'dir') {
        node.children = await this.listLevel(join(cwd, e.name), e.name, matcher)
      }
      topNodes.push(node)
    }
    return FileService.sortNodes(topNodes)
  }

  /**
   * 展开目录单层子（UC-3，#3，AC-2.3/2.5，T2.1/T2.10）。
   * 同 listTree 的 ignore 策略：始终返回所有节点并标记 ignored=true。
   * @throws FileError('out_of_cwd' | 'session_not_found' | 'permission_denied' | 'timeout')
   */
  async expandDir(sessionId: string, path: string): Promise<FileNode[]> {
    const cwd = this.requireCwd(sessionId)
    const resolvePath_ = resolvePath(cwd, path)
    if (!isUnderOrEqual(cwd, resolvePath_)) throw new FileError('out_of_cwd', path) // 越界统一守门
    const relParent = relative(cwd, resolvePath_) || '' // 相对 cwd 的目录路径（无前导斜杠）
    const matcher = await this.loadMatcher(cwd, resolvePath_)
    return this.listLevel(resolvePath_, relParent, matcher)
  }

  /**
   * 读文件内容（UC-6 前置，#7，AC-7.1/7.3）。越界守门 + >1MB 截断。
   * W1b 范围：cwd 越界守门 + 读取 + 截断。BC-3 白名单（~/.agents/skills 等）W2 补。
   * @throws FileError('out_of_cwd' | 'not_found' | 'permission_denied' | 'timeout' | 'read_failed')
   */
  async readFile(sessionId: string, path: string): Promise<{ content: string; truncated: boolean }> {
    const cwd = this.requireCwd(sessionId)
    // 路径识别：~ 展开 → 绝对路径直接用，相对路径基于 cwd resolve
    const expandedPath = expandHome(path)
    const resolvePath_ = isAbsolute(expandedPath) ? resolvePath(expandedPath) : resolvePath(cwd, expandedPath)
    // 安全守门（NFR-AC-S2 越界统一守门）：所有路径（含 ~ 展开后的绝对路径）必须落在 cwd 下，
    // 防 `../../etc/passwd` 相对穿越与 `~/...` / `/etc/...` 绝对路径越界 → 越界抛 FileError('out_of_cwd')。
    // cwd 外文件读取（BC-3 skill 文件预览）走 readFileFromWhitelist（自带 allowedReadDirs 白名单）。
    // 守门前两侧 realpath 归一（canonicalizePath 失败退回原词法路径）：session cwd 是前端/DB
    // 记录的词法形态（如 /tmp/x），pi 子进程 process.cwd() 拼出的目标常是解析后物理形态
    // （如 /private/tmp/x，macOS /tmp → /private/tmp）——词法前缀判定会把同一物理目录误判
    // 越界（A1 场景实测）。归一后判定语义 = 物理路径包含关系；目标不存在（realpath ENOENT）
    // 退词法路径继续判，not_found 语义由后续 stat ENOENT 保持。读取仍用原词法路径，形态不变。
    if (!isUnderOrEqual(canonicalizePath(cwd), canonicalizePath(resolvePath_))) {
      throw new FileError('out_of_cwd', path)
    }
    const statResult = await this.callFs(() => this.opts.executor.stat(resolvePath_), 'stat')
    const full = await this.callFs(() => this.opts.executor.readFile(resolvePath_), 'readFile')
    if (statResult.size > MAX_FILE_SIZE) {
      return { content: full.slice(0, MAX_FILE_SIZE), truncated: true }
    }
    return { content: full, truncated: false }
  }

  /**
   * 从白名单目录读文件（BC-3，#7，T6.11）。file.read protocol payload 只有 path 无 sessionId，
   * 无法走 cwd 守门，改走 allowedReadDirs 全局白名单（~/.agents/skills 等 skill 目录）。
   *
   * 原 server.ts handleFileRead 内联逻辑下沉至此（解三层违纪 AC-2b）。白名单目录由装配时传入。
   * @throws FileError('out_of_cwd' | 'not_found' | 'permission_denied' | 'timeout' | 'read_failed')
   */
  async readFileFromWhitelist(path: string): Promise<{ content: string; truncated: boolean }> {
    const allowed = this.opts.allowedReadDirs ?? []
    const absPath = resolvePath(path)
    // 白名单守门（与旧 server.ts handleFileRead 一致：absPath 必须在某白名单目录之下）。
    // 同 readFile：两侧 realpath 归一（失败退词法，canonicalizePath）后再判——白名单目录
    // 同样可能存在 symlink 形态不一致（如 ~ 家目录本身经 /etc/symlinks 或 macOS 重组形态），
    // 纯词法前缀判定会误拒。归一后判定语义 = 物理路径包含关系，error code 语义不变。
    if (!allowed.some((dir) => isUnderOrEqual(canonicalizePath(dir), canonicalizePath(absPath)))) {
      throw new FileError('out_of_cwd', `路径不在允许的 skill 目录内: ${path}`)
    }
    const statResult = await this.callFs(() => this.opts.executor.stat(absPath), 'stat')
    const full = await this.callFs(() => this.opts.executor.readFile(absPath), 'readFile')
    if (statResult.size > MAX_FILE_SIZE) {
      return { content: full.slice(0, MAX_FILE_SIZE), truncated: true }
    }
    return { content: full, truncated: false }
  }

  /**
   * composer `$` 文件候选（session 路）：薄包装 = requireCwd + 核心 searchFilesInCwd。
   * session 在此链路只是 cwd 的定位器（设计 §2.4：requireCwd 后全部逻辑以 cwd 为轴），
   * 与 landing cwd 路（file.search.cwd → searchFilesInCwd）共用同一扫描实现，无旁路。
   * 协议 file.search:result 不携带 truncated（仅 cwd 路 D7 补），此处丢弃截断标志只回 FileNode[]。
   * @throws FileError('session_not_found') —— session 不存在或无 cwd 抛（其余语义同核心方法）
   */
  async searchFiles(sessionId: string, showIgnored?: boolean): Promise<FileNode[]> {
    const cwd = this.requireCwd(sessionId)
    const { files } = await this.searchFilesInCwd(cwd, showIgnored)
    return files
  }

  /**
   * composer `$` 文件候选核心：全量递归给定 cwd（受 ignore + 深度上限 + 结果数上限）。
   * landing cwd 路（file.search.cwd）与 panel session 路（file.search → searchFiles 薄包装）
   * 共用本实现，扫描能力（ignore / 深度 8 / DoS 5000 / 并发 16）无旁路。
   *
   * cwd 准入边界（设计 D6）：不做目录白名单——cwd 不存在（stat ENOENT）或非目录
   * （stat type !== 'dir'）→ FileError('not_found') 结构化失败（前端降级空候选）。
   *
   * 与 listTree 的关键差异（全量递归场景的安全要求）：
   * - **全量递归**（listTree 仅 2 层），深度上限 `MAX_SEARCH_DEPTH`（根 cwd=depth 0）
   * - **per-directory try/catch 容错**：单子目录 EACCES/ENOENT 跳过继续，不中断整体
   *   （listTree 抛错即终止——对全量递归不可接受，大仓库几乎必有无权目录）
   * - **内建 ignore 独立短路**：BUILTIN_IGNORE_DIRS（node_modules 等）命中即跳过，
   *   不走 matchPath，不可被 .gitignore `!` 取反覆盖（安全兜底，与 matchPath 两道独立关卡）
   * - **matchPath 剪枝**：.gitignore 命中的目录不下钻（showIgnored=false）；showIgnored=true
   *   时标记但**仍不递归**（避免 node_modules 等爆量，composer 场景永远不传 true）
   * - **结果数上限**：收集到 MAX_SEARCH_RESULTS 即停止（横向截断，防超大批量目录耗时）
   * - **symlink 防环**：由 executor 层保证（Dirent.isDirectory() 不 follow symlink），
   *   深度上限 8 作递归硬限制兜底
   *
   * D7-3/D7-4（05-scan-caching §3.3）：
   * - **免 per-file stat**：listDir 传 { withSize:false }——size 唯一消费点是文件树路径
   *   FileTreeRow 的 untracked `~size` 降级显示，searchFiles 结果无 size 消费方（缺省无损）；
   *   坏 symlink 跳过语义由 executor 的 symlink-仍-stat 分支保持，结果集成员不变。
   * - **有界并发**：walk 串行 → SEARCH_WALK_CONCURRENCY 路并发（未超限仓库结果集与串行
   *   版完全一致；输出顺序由 sortNodes 终排序确定，不受发现顺序影响）。
   *   超限仓库（>5000 命中）截断成员随并发调度而异，为已声明的可接受范围。
   *
   * 返回扁平 FileNode[]（非嵌套树，给候选列表用）。排序同 sortNodes（dir 在前 + name 降序）。
   * truncated（D7，adversarial-review-fixes §3.4）：DoS 上限 MAX_SEARCH_RESULTS 截止时该目录
   * 层还有未收集条目 → true（硬信号：确实有文件被截掉；恰达上限且无剩余条目为 false）——
   * file.search.cwd:result 携带，前端提示「结果已截断」。
   * @throws FileError('not_found' | 'permission_denied' | 'timeout') —— cwd 不存在或非目录抛
   *   not_found；准入 stat 经 callFs，EACCES/EPERM → permission_denied、超时 → timeout；
   *   其余 fs 错误（递归期）per-dir 容错不抛
   */
  async searchFilesInCwd(cwd: string, showIgnored?: boolean): Promise<{ files: FileNode[]; truncated: boolean }> {
    // cwd 归一化（D6 #11）：~ 展开 + resolve——landing 传 `~/proj` 或带尾斜杠/./ 段的形态
    // 直接 stat 会 ENOENT 误判 not_found；归一后与 session 路（requireCwd 给出的规范绝对路径）同域
    const normalizedCwd = resolvePath(expandHome(cwd))
    // cwd 准入（设计 D6）：stat 校验目录存在性——ENOENT 经 callFs 分类为 not_found；非目录显式 not_found
    const stat = await this.callFs(() => this.opts.executor.stat(normalizedCwd), 'stat')
    if (stat == null || stat.type !== 'dir') {
      throw new FileError('not_found', `cwd 不存在或不是目录: ${normalizedCwd}`)
    }
    const matcher = await this.loadMatcher(normalizedCwd)
    const showIgn = showIgnored ?? false
    const result: FileNode[] = []
    // 截断信号（D7）：结果数上限截止时当前目录层还有未收集条目（break 而非自然扫完）
    let truncated = false

    /**
     * 有界并发信号量（D7-4）：inFlight = 当前持有 slot 的 walk 数。
     * acquire 快路径同步判定（不打乱同批子任务的发起顺序）；满则 FIFO 排队，
     * release 时 slot 直接转移给队首（inFlight 不变，唤醒即持有）。
     */
    let inFlight = 0
    const waiters: Array<() => void> = []
    const acquire = (): Promise<void> => {
      if (inFlight < SEARCH_WALK_CONCURRENCY) {
        inFlight++
        return Promise.resolve()
      }
      return new Promise<void>((resolve) => {
        waiters.push(resolve)
      })
    }
    const release = (): void => {
      const next = waiters.shift()
      if (next) next() // slot 转移给队首等待者（inFlight 保持）
      else inFlight--
    }

    /**
     * 递归单层（depth-limited + per-dir 容错 + 有界并发）。
     * @param absPath  目录绝对路径
     * @param relParent 相对 cwd 的目录路径（顶层 ''）
     * @param depth 当前深度（cwd=0，顶层 entry=1...）
     */
    const walk = async (absPath: string, relParent: string, depth: number): Promise<void> => {
      // 结果数上限：达上限即停止（横向截断；cap 已被其他并发 walk 触发，truncated 由触发方落）
      if (result.length >= MAX_SEARCH_RESULTS) return

      await acquire()
      // 截断兜底：acquire 排队期间其他并发 walk 可能已把 result 填到上限——等待后仍执行
      // 一次 listDir 是纯浪费（cap 截断后入队的 walk 不再产出任何结果），再查一次直接释放
      // slot 返回，避免无谓 IO
      if (result.length >= MAX_SEARCH_RESULTS) {
        release()
        return
      }
      let entries: FsEntry[]
      try {
        entries = await this.callFs(() => this.opts.executor.listDir(absPath, { withSize: false }), 'listDir')
      } catch {
        // per-directory 容错：单目录 EACCES/ENOENT/timeout 跳过，不中断整体递归
        return
      } finally {
        release()
      }

      // 同目录 entries 同步处理完（无 await 间隙，result.push 原子）再发起子目录并发
      const childWalks: Array<Promise<void>> = []
      for (let i = 0; i < entries.length; i++) {
        if (result.length >= MAX_SEARCH_RESULTS) {
          // D7 截断信号：cap 截止且当前目录层还有未收集条目（含未下钻子目录）——硬证据
          truncated = true
          break
        }
        const e = entries[i]!
        const node = this.entryToNode(e, relParent)

        // 关卡 1：内建 ignore 独立短路（node_modules 等，不可被 .gitignore ! 覆盖）
        if (BUILTIN_IGNORE_DIRS.has(e.name)) continue

        // 关卡 2：.gitignore matchPath 判定
        const ignored = matchPath(matcher, node.path)
        if (ignored && !showIgn) continue // 默认隐藏：跳过不下钻
        if (ignored) node.ignored = true // 显示模式：标记但下面仍不递归（防爆量）

        result.push(node)

        // 目录：深度未达上限才下钻
        if (e.type === 'dir' && depth < MAX_SEARCH_DEPTH) {
          childWalks.push(walk(join(absPath, e.name), node.path, depth + 1))
        }
      }
      // 子树遍历相互独立（walk 自身不 reject，错误已在 per-dir 容错内消化）
      await Promise.allSettled(childWalks)
    }

    await walk(normalizedCwd, '', 1)
    return { files: FileService.sortNodes(result), truncated }
  }

  // ── file.write 骨架（#14，AC-14.2/14.4，G4 实现延后）──
  // 直接抛 FileError('not_implemented')；handler（W1b-handler）catch 后转结构化响应 { implemented:false }。

  async createFile(_sessionId: string, _path: string, _content: string): Promise<never> {
    throw new FileError('not_implemented', 'file.write not implemented in this release')
  }

  async renameFile(_sessionId: string, _oldPath: string, _newPath: string): Promise<never> {
    throw new FileError('not_implemented', 'file.write not implemented in this release')
  }

  async deleteFile(_sessionId: string, _path: string): Promise<never> {
    throw new FileError('not_implemented', 'file.write not implemented in this release')
  }

  // ── 私有编排方法 ──

  /** 取 cwd；空（session 不存在）→ session_not_found。 */
  private requireCwd(sessionId: string): string {
    const summary = this.opts.sessionService.getSummary(sessionId)
    const cwd = summary?.cwd ?? ''
    if (!cwd) throw new FileError('session_not_found', `Session 不存在或无 cwd: ${sessionId}`)
    return cwd
  }

  /**
   * 列单层并映射 FileNode（ignore 标记）。
   * 始终返回所有节点，对 .gitignore 命中的节点标记 ignored=true（前端按 showIgnored 开关过滤）。
   * 返回前按 sortNodes 排序（dir 在前、同类型内 name 降序）。
   * @param absPath  目录绝对路径（executor.listDir 用）
   * @param relParent 相对 cwd 的目录路径（FileNode.path 前缀，顶层为 ''）
   */
  private async listLevel(
    absPath: string,
    relParent: string,
    matcher: IgnoreMatcher,
  ): Promise<FileNode[]> {
    const entries = await this.callFs(() => this.opts.executor.listDir(absPath), 'listDir')
    const nodes: FileNode[] = []
    for (const e of entries) {
      const node = this.entryToNode(e, relParent)
      if (matchPath(matcher, node.path)) node.ignored = true // 标记 ignored，前端按开关过滤
      nodes.push(node)
    }
    return FileService.sortNodes(nodes)
  }

  /**
   * 文件节点排序（展示偏好，单一权威源）：目录在前，同类型内按 name 字典序降序；
   * 同名 tie（跨目录扁平列表才会出现，如 searchFiles 的 a/x.ts vs b/x.ts）按 path 降序决出
   * ——D7-4 并发化后收集顺序非确定，仅靠 sort 稳定性（保持插入序）不足以保证输出序确定；
   * path 全序断 tie 显式消除对 readdir 目录序的依赖（改造前 tie 序 = readdir 序 + 稳定排序，
   * 跨目录同名节点的输出序以此为已声明修订，05 文档 D7-4 补注 + V1 验收按新全序对齐）。
   * 树场景（listTree/listLevel）同目录 name 唯一，tie 分支不可达，行为不变。
   * 用原生 < / > 比较（非 localeCompare）：跨平台/ICU 数据一致、可预测，不依赖运行环境 locale。
   * 静态方法：listTree（顶层）与 listLevel（子层）共用，确保全树一致有序。
   */
  private static sortNodes(nodes: FileNode[]): FileNode[] {
    return nodes.sort((a, b) => {
      // dir 排在 file 前（type 权重：dir=0, file=1）
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1
      // 同类型内按 name 字典序降序（b 在前 = 降序）
      if (a.name !== b.name) return a.name < b.name ? 1 : -1
      return a.path < b.path ? 1 : a.path > b.path ? -1 : 0
    })
  }

  /** FsEntry → FileNode 映射。path = relParent ? `${relParent}/${name}` : name（相对 cwd，无前导斜杠）。 */
  private entryToNode(e: FsEntry, relParent: string): FileNode {
    const node: FileNode = {
      path: relParent ? `${relParent}/${e.name}` : e.name,
      name: e.name,
      type: e.type,
    }
    if (e.size !== undefined) node.size = e.size
    return node
  }

  /**
   * 读一组目录的 .gitignore 合并编译 matcher（IO 走 port，计算走 infra 纯函数）。
   * 任一目录无 .gitignore / 读取失败 → 该目录贡献空（不影响其它）。
   *
   * 无缓存直读（缓存治理 U1 1-2 裁决）：.gitignore 是 KB 级文件、文件树/搜索是低频
   * 操作，读盘编译微秒-毫秒级；原 (mtimeMs,size) 身份戳 LRU 有「同毫秒等长写」陈旧
   * 窗口，直读后外部改动下一次读即生效。多文件合并 = rules 拼接（compileIgnoreRules
   * 逐行编译无跨行状态，按目录序拼接顺序求值语义不变）。
   */
  private async loadMatcher(...dirs: string[]): Promise<IgnoreMatcher> {
    const collected: IgnoreMatcher[] = []
    for (const d of dirs) {
      // resolvePath 归一化：cwd 带尾斜杠（'/repo/'）与不带（'/repo'）必须解析到同一
      // 文件路径——否则尾斜杠形态拼出 '/repo//.gitignore' 读不到，ignore 标记整体失效
      const m = await this.loadFileMatcher(`${resolvePath(d)}/.gitignore`)
      if (m.rules.length > 0) collected.push(m)
    }
    if (collected.length === 0) return EMPTY_MATCHER
    if (collected.length === 1) return collected[0] // 单文件：直接复用编译实例，零拷贝
    return { rules: collected.flatMap((m) => m.rules) } // 多文件：按目录序拼接（顺序求值语义不变）
  }

  /**
   * 取单个 .gitignore 文件的编译结果（直读直编译，无缓存）。
   * 文件不存在 / 读取失败 / 非 string 内容 → 空规则（readIgnoreFile 容错）。
   * debug 日志打点：strace 在 macOS 不可用，.gitignore 读取/编译次数由 debug 日志验证。
   * console 经 infra/logger.ts monkey-patch tee 到 <dataDir>/logs/（debug 级，
   * TAIJI_LOG_LEVEL=debug 时可见）。
   */
  private async loadFileMatcher(gitignorePath: string): Promise<IgnoreMatcher> {
    console.debug(`[file-service] .gitignore 读取/编译: ${gitignorePath}`)
    return compileIgnoreRules(await this.readIgnoreFile(gitignorePath))
  }

  /**
   * 读 .gitignore 文件内容，失败/不存在/非 string → ''（不抛）。
   * 非 string 兜底：对合法契约（executor.readFile 返回 string）与 `undefined` 等价；
   * 对病态返回值（非 string）比旧 `if (c)` truthy 过滤更安全——truthy 非 string
   * （数字/对象等）不再被误当作内容进编译。
   */
  private async readIgnoreFile(gitignorePath: string): Promise<string> {
    try {
      const content = await this.opts.executor.readFile(gitignorePath)
      return typeof content === 'string' ? content : ''
    } catch {
      return ''
    }
  }

  /**
   * 执行一次 executor 调用：超时包装（NFR ④K-2）+ 错误分类（EACCES/ENOENT → FileError）。
   * - 超时 → FileError('timeout')（withTimeout 已抛，label 定位是哪个 fs 操作）
   * - EACCES/EPERM → FileError('permission_denied')
   * - ENOENT → FileError('not_found')
   * - 其余（含已分类的 FileError）→ 透传
   */
  private async callFs<T>(op: () => Promise<T>, label: string): Promise<T> {
    try {
      return await withTimeout(op(), READ_TIMEOUT_MS, label)
    } catch (e) {
      const code = (e as { code?: string } | null)?.code
      if (code === 'EACCES' || code === 'EPERM') throw new FileError('permission_denied')
      if (code === 'ENOENT') throw new FileError('not_found')
      throw e // FileError('timeout') 或未知错误透传
    }
  }
}
